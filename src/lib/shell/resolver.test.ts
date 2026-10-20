import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createResolver, skillCommands } from './resolver';
import type { Skill } from '../skills';
import fixtures from './fixtures/skills.json';
const skills: Skill[] = fixtures;
const kbbi = skills.find((s) => s.module === 'gaato/kbbi')!;
const mirror = '/_mooncakes/prebuild';
const bytes = new Uint8Array([0, 97, 115, 109]);
const digest = createHash('sha256').update(bytes).digest('hex');
beforeEach(() => vi.stubGlobal('location', new URL('https://moonrun.test')));
afterEach(() => vi.unstubAllGlobals());
function registry(entries: Skill[] = skills) {
	const routes = new Map<string, () => Response>();
	function prebuild(path: string) {
		routes.set(mirror + path + '.sha256', () => new Response(digest));
		routes.set(mirror + path, () => new Response(new Uint8Array(bytes)));
	}
	for (const entry of skillCommands(entries)) prebuild(entry.path);
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		return routes.get(url)?.() ?? new Response('', { status: 404 });
	});
	const onResolved = vi.fn();
	const options = { fetcher, onResolved };
	const resolve = createResolver(entries, options);
	return { routes, prebuild, fetcher, onResolved, resolve, options };
}
it.each([
	['cowsay', '/Yoorkin/cowsay@0.1.6/cowsay.wasm'],
	['toml-cli', '/conglinyizhi/toml-cli@0.3.3/toml-cli.wasm'],
	['office', '/moonbitlang/office@0.3.0/office.wasm'],
	['office-cli', '/moonbitlang/office@0.3.0/office.wasm'],
	['kbbi', '/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'],
	['jq', '/bobzhang/jq@0.2.0/jq.wasm']
])('resolves the published skill name or alias %s', async (name, path) => {
	const r = registry();
	expect(await r.resolve(name)).toEqual(bytes);
	expect(r.fetcher.mock.calls.map(([url]) => url)).toEqual([
		mirror + path + '.sha256',
		mirror + path
	]);
	expect(r.onResolved).toHaveBeenCalledWith(name, path);
});
it('leaves paths and unknown names to the filesystem, without requests', async () => {
	const r = registry();
	for (const name of [
		'Yoorkin/cowsay',
		'./cowsay',
		'/bin/cowsay',
		'bobzhang/jq@0.2.0/jq.wasm',
		'missing',
		'../bad'
	])
		expect(await r.resolve(name)).toBeUndefined();
	expect(r.fetcher).not.toHaveBeenCalled();
	const names = skillCommands(skills).flatMap((s) => [s.name, ...s.aliases]);
	expect(names).toContain('cowsay');
	expect(names).not.toContain('Yoorkin/cowsay');
	expect(names).not.toContain('conglinyizhi/toml-cli');
});
it('memoizes concurrent, positive and negative lookups, but resolves again in a fresh session', async () => {
	const r = registry();
	const first = r.resolve('jq');
	expect(r.resolve('jq')).toBe(first);
	await first;
	r.routes.delete(mirror + '/Yoorkin/cowsay@0.1.6/cowsay.wasm.sha256');
	expect(await r.resolve('cowsay')).toBeUndefined();
	const count = r.fetcher.mock.calls.length;
	r.prebuild('/Yoorkin/cowsay@0.1.6/cowsay.wasm');
	expect(await r.resolve('cowsay')).toBeUndefined();
	await r.resolve('jq');
	expect(r.fetcher).toHaveBeenCalledTimes(count);
	expect(await createResolver(skills, r.options)('cowsay')).toEqual(bytes);
});
it('tries skill collisions in full-path order, independent of API order, skipping missing prebuilds', async () => {
	const other = {
		...kbbi,
		wasm_url: kbbi.wasm_url.replace('/gaato/', '/other/')
	};
	for (const entries of [
		[other, kbbi],
		[kbbi, other]
	]) {
		const r = registry(entries);
		await r.resolve('kbbi');
		expect(r.onResolved).toHaveBeenLastCalledWith(
			'kbbi',
			'/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'
		);
		expect(skillCommands(entries).map((e) => e.path)).toEqual([
			'/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm',
			'/other/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'
		]);
		r.routes.delete(mirror + '/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm.sha256');
		await createResolver(entries, r.options)('kbbi');
		expect(r.onResolved).toHaveBeenLastCalledWith(
			'kbbi',
			'/other/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'
		);
	}
	expect(skillCommands([{ ...kbbi, yanked: true }])).toEqual([]);
});
it.each(['server error', 'integrity mismatch'])(
	'reports %s instead of falling through to another skill',
	async (failure) => {
		const other = {
			...kbbi,
			wasm_url: kbbi.wasm_url.replace('/gaato/', '/other/')
		};
		const r = registry([kbbi, other]);
		r.routes.set(mirror + '/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm.sha256', () =>
			failure === 'server error'
				? new Response('', { status: 500 })
				: new Response('0'.repeat(64))
		);
		await expect(r.resolve('kbbi')).rejects.toThrow(
			failure === 'server error' ? '500' : 'SHA-256 mismatch'
		);
		expect(
			r.fetcher.mock.calls.some(([url]) => String(url).includes('/other/'))
		).toBe(false);
	}
);
it('uses the artifact filename even if the module and package names differ', () => {
	expect(
		skillCommands([
			{
				...kbbi,
				metadata: { name: 'docs/fancy' },
				wasm_url:
					'https://download.mooncakes.io/prebuild/a/module@1.0.0/cmd/tool/artifact.wasm'
			}
		])
	).toEqual([
		{
			name: 'artifact',
			aliases: [],
			path: '/a/module@1.0.0/cmd/tool/artifact.wasm'
		}
	]);
});
