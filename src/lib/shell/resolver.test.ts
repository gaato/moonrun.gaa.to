import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createResolver, skillCommands } from './resolver';
import type { Skill } from '../skills';
import fixtures from './fixtures/skills.json';
const skills: Skill[] = fixtures;
const kbbi = skills.find((s) => s.module === 'gaato/kbbi')!;
const api = 'https://mooncakes.io/api-new/v0/modules/';
const mirror = '/_mooncakes/prebuild';
const bytes = new Uint8Array([0, 97, 115, 109]);
const digest = createHash('sha256').update(bytes).digest('hex');
beforeEach(() => vi.stubGlobal('location', new URL('https://playground.test')));
afterEach(() => vi.unstubAllGlobals());
function registry(entries: Skill[] = skills) {
	const routes = new Map<string, () => Response>();
	function prebuild(path: string) {
		routes.set(mirror + path + '.sha256', () => new Response(digest));
		routes.set(mirror + path, () => new Response(new Uint8Array(bytes)));
	}
	for (const entry of skillCommands(entries)) prebuild(entry.path);
	function module(name: string, version: string) {
		routes.set(api + name, () => Response.json({ latest_version: version }));
	}
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		return routes.get(url)?.() ?? new Response('', { status: 404 });
	});
	const onResolved = vi.fn();
	const options = { fetcher, onResolved };
	const resolve = createResolver(entries, options);
	return { routes, prebuild, module, fetcher, onResolved, resolve, options };
}
it.each([
	['cowsay', '/Yoorkin/cowsay@0.1.6/cowsay.wasm'],
	['toml-cli', '/conglinyizhi/toml-cli@0.3.3/toml-cli.wasm'],
	['office', '/moonbitlang/office@0.3.0/office.wasm'],
	['office-cli', '/moonbitlang/office@0.3.0/office.wasm'],
	['kbbi', '/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'],
	['jq', '/bobzhang/jq@0.2.0/jq.wasm']
])(
	'falls through CLI 404 to real API skill name or alias %s',
	async (name, path) => {
		const r = registry();
		expect(await r.resolve(name)).toEqual(bytes);
		expect(r.fetcher.mock.calls.map(([url]) => url)).toEqual([
			api + 'cli/' + name,
			mirror + path + '.sha256',
			mirror + path
		]);
		expect(r.onResolved).toHaveBeenCalledWith(name, path);
	}
);
it('prefers the latest CLI executable, while a full skill path bypasses CLI', async () => {
	const r = registry();
	r.module('cli/jq', '3.2.1');
	r.prebuild('/cli/jq@3.2.1/jq.wasm');
	await r.resolve('jq');
	expect(r.onResolved).toHaveBeenLastCalledWith('jq', '/cli/jq@3.2.1/jq.wasm');
	expect(r.fetcher.mock.calls.map(([url]) => url)).toEqual([
		api + 'cli/jq',
		mirror + '/cli/jq@3.2.1/jq.wasm.sha256',
		mirror + '/cli/jq@3.2.1/jq.wasm'
	]);
	await r.resolve('bobzhang/jq@0.2.0/jq.wasm');
	expect(r.onResolved).toHaveBeenLastCalledWith(
		'bobzhang/jq@0.2.0/jq.wasm',
		'/bobzhang/jq@0.2.0/jq.wasm'
	);
});
it('skips a CLI module with no prebuilt checksum, falling through to skills', async () => {
	const r = registry();
	r.module('cli/jq', '1.0.0');
	await r.resolve('jq');
	expect(r.fetcher.mock.calls.map(([url]) => url)).toEqual([
		api + 'cli/jq',
		mirror + '/cli/jq@1.0.0/jq.wasm.sha256',
		mirror + '/bobzhang/jq@0.2.0/jq.wasm.sha256',
		mirror + '/bobzhang/jq@0.2.0/jq.wasm'
	]);
});
it('rejects a library without an executable as command-not-found', async () => {
	const r = registry();
	r.module('cli/core', '0.2.1');
	expect(await r.resolve('core')).toBeUndefined();
	expect(r.fetcher.mock.calls.map(([url]) => url)).toEqual([
		api + 'cli/core',
		mirror + '/cli/core@0.2.1/core.wasm.sha256'
	]);
	expect(r.onResolved).not.toHaveBeenCalled();
});
it('memoizes concurrent, positive and negative lookups, but resolves again in a fresh session', async () => {
	const r = registry();
	r.module('cli/jq', '1.0.0');
	r.prebuild('/cli/jq@1.0.0/jq.wasm');
	const first = r.resolve('jq');
	expect(r.resolve('jq')).toBe(first);
	await first;
	await r.resolve('missing');
	const count = r.fetcher.mock.calls.length;
	r.module('cli/jq', '2.0.0');
	r.prebuild('/cli/jq@2.0.0/jq.wasm');
	r.module('cli/missing', '1.0.0');
	r.prebuild('/cli/missing@1.0.0/missing.wasm');
	await r.resolve('jq');
	expect(await r.resolve('missing')).toBeUndefined();
	expect(r.fetcher).toHaveBeenCalledTimes(count);
	const fresh = createResolver(skills, r.options);
	await fresh('jq');
	expect(r.onResolved).toHaveBeenLastCalledWith('jq', '/cli/jq@2.0.0/jq.wasm');
	expect(await fresh('missing')).toEqual(bytes);
	for (const [url, init] of r.fetcher.mock.calls) {
		if (String(url).startsWith(api)) expect(init?.cache).toBe('no-store');
	}
});
it.each(['a/tool@latest/cmd/exec.wasm', '/a/tool/cmd/exec.wasm'])(
	'pins a full path %s without changing its package or executable name',
	async (name) => {
		const r = registry();
		r.module('a/tool', '1.2.3');
		r.prebuild('/a/tool@1.2.3/cmd/exec.wasm');
		await r.resolve(name);
		expect(r.onResolved).toHaveBeenCalledWith(
			name,
			'/a/tool@1.2.3/cmd/exec.wasm'
		);
		expect(r.fetcher).toHaveBeenCalledWith(api + 'a/tool', {
			signal: undefined,
			cache: 'no-store'
		});
	}
);
it('keeps fully qualified metadata out of aliases and rejects invalid paths', async () => {
	const r = registry();
	const names = skillCommands(skills).flatMap((s) => [s.name, ...s.aliases]);
	expect(names).toContain('cowsay');
	expect(names).not.toContain('Yoorkin/cowsay');
	expect(names).not.toContain('conglinyizhi/toml-cli');
	for (const name of [
		'Yoorkin/cowsay',
		'/work/script',
		'a/b@invalid/b.wasm',
		'https://evil.example/a.wasm',
		'../bad',
		'a%2fb'
	])
		expect(await r.resolve(name)).toBeUndefined();
	expect(r.fetcher).not.toHaveBeenCalled();
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
	'reports %s instead of falling through to another executable',
	async (failure) => {
		const r = registry();
		r.module('cli/jq', '1.0.0');
		r.prebuild('/cli/jq@1.0.0/jq.wasm');
		r.routes.set(mirror + '/cli/jq@1.0.0/jq.wasm.sha256', () =>
			failure === 'server error'
				? new Response('', { status: 500 })
				: new Response('0'.repeat(64))
		);
		await expect(r.resolve('jq')).rejects.toThrow(
			failure === 'server error' ? '500' : 'SHA-256 mismatch'
		);
		expect(
			r.fetcher.mock.calls.some(([url]) => String(url).includes('/bobzhang/'))
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

it('uses the page index, preloads CLI only, and keeps bytes ready even without Cache API storage', async () => {
	const r = registry();
	const index = [
		{ name: 'cli/sh', version: '1.0.0' },
		{ name: 'cli/jq', version: '2.0.0' }
	];
	r.prebuild('/cli/sh@1.0.0/sh.wasm');
	r.prebuild('/cli/jq@2.0.0/jq.wasm');
	const resolve = createResolver(skills, { ...r.options, index });
	await resolve('sh');
	await resolve.preload();
	const calls = r.fetcher.mock.calls.length;
	expect(calls).toBe(4);
	expect(
		r.fetcher.mock.calls.every(([url]) =>
			String(url).startsWith(mirror + '/cli/')
		)
	).toBe(true);
	// Preloading does not mark a command as run, or fetch skill wasm.
	expect(r.onResolved).toHaveBeenCalledTimes(1);
	expect(await resolve('jq')).toEqual(bytes);
	expect(await resolve('cli/jq@latest/jq.wasm')).toEqual(bytes);
	expect(r.fetcher).toHaveBeenCalledTimes(calls);
	expect(r.onResolved).toHaveBeenCalledWith('jq', '/cli/jq@2.0.0/jq.wasm');
	await resolve('cowsay');
	expect(r.fetcher).toHaveBeenCalledWith(api + 'cli/cowsay', {
		signal: undefined,
		cache: 'no-store'
	});
});
it.each([500])(
	'does not block preload on a %s failure and retries that indexed version on use',
	async (status) => {
		const r = registry();
		const index = [
			{ name: 'cli/jq', version: '2.0.0' },
			{ name: 'cli/sh', version: '1.0.0' }
		];
		r.prebuild('/cli/sh@1.0.0/sh.wasm');
		r.routes.set(
			mirror + '/cli/jq@2.0.0/jq.wasm.sha256',
			() => new Response('', { status })
		);
		const resolve = createResolver(skills, { ...r.options, index });
		const onFailure = vi.fn();
		await resolve.preload({ onFailure });
		expect(onFailure).toHaveBeenCalledTimes(1);
		r.prebuild('/cli/jq@2.0.0/jq.wasm');
		expect(await resolve('jq')).toEqual(bytes);
		expect(r.onResolved).toHaveBeenCalledWith('jq', '/cli/jq@2.0.0/jq.wasm');
		expect(
			r.fetcher.mock.calls.filter(
				([url]) => url === mirror + '/cli/jq@2.0.0/jq.wasm.sha256'
			)
		).toHaveLength(2);
		expect(
			r.fetcher.mock.calls.some(([url]) => String(url).startsWith(api))
		).toBe(false);
	}
);

it('silently removes a library from preload commands and counts, remembering it until the next session', async () => {
	const r = registry();
	const index = [
		{ name: 'cli/core', version: '1.0.0' },
		{ name: 'cli/sh', version: '1.0.0' }
	];
	r.prebuild('/cli/sh@1.0.0/sh.wasm');
	const resolve = createResolver(skills, { ...r.options, index });
	const onFailure = vi.fn();
	const onProgress = vi.fn();
	expect(await resolve.preload({ onFailure, onProgress })).toEqual([index[1]]);
	expect(onFailure).not.toHaveBeenCalled();
	expect(onProgress).toHaveBeenLastCalledWith({
		completed: 1,
		total: 1,
		bytes: bytes.byteLength
	});
	const calls = r.fetcher.mock.calls.length;
	// Even if availability changes, no name or path retries a known library this session.
	r.prebuild('/cli/core@1.0.0/core.wasm');
	for (const name of [
		'core',
		'core',
		'cli/core@latest/core.wasm',
		'/cli/core@1.0.0/core.wasm'
	])
		expect(await resolve(name)).toBeUndefined();
	expect(await resolve.preload({ onFailure })).toEqual([index[1]]);
	expect(onFailure).not.toHaveBeenCalled();
	expect(r.fetcher).toHaveBeenCalledTimes(calls);
	expect(r.onResolved).not.toHaveBeenCalled();
	expect(await createResolver(skills, { ...r.options, index })('core')).toEqual(
		bytes
	);
});
it('retains on-demand skill fallback for a CLI coordinate skipped during preload', async () => {
	const r = registry();
	const resolve = createResolver(skills, {
		...r.options,
		index: [{ name: 'cli/jq', version: '1.0.0' }]
	});
	expect(await resolve.preload()).toEqual([]);
	const calls = r.fetcher.mock.calls.length;
	expect(await resolve('jq')).toEqual(bytes);
	expect(r.fetcher).toHaveBeenCalledTimes(calls + 2);
	expect(r.onResolved).toHaveBeenCalledWith('jq', '/bobzhang/jq@0.2.0/jq.wasm');
});
