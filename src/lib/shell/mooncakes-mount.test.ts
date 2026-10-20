import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMooncakesMount, executablePackage } from './mooncakes-mount';
import { modulesEndpoint } from '../cli-index';
import {
	mountRegistry,
	packageFixture,
	wasmFixture
} from './fixtures/mount-registry';
beforeEach(() => vi.stubGlobal('location', new URL('https://moonrun.test')));
afterEach(() => vi.unstubAllGlobals());
const root = '/gaato/kbbi';
function setup() {
	const r = mountRegistry();
	return { ...r, mount: createMooncakesMount({ fetcher: r.fetcher }) };
}
it('lists non-yanked owners and their modules at the latest version, without any source zip', async () => {
	const r = setup();
	expect(await r.mount.stat('/')).toEqual({
		ok: true,
		value: { kind: 'dir', mode: 0o555 }
	});
	expect(r.fetcher).not.toHaveBeenCalled();
	expect(await r.mount.readdir('/')).toEqual({
		ok: true,
		value: [
			{ name: 'Yoorkin', kind: 'dir' },
			{ name: 'cli', kind: 'dir' },
			{ name: 'gaato', kind: 'dir' }
		]
	});
	expect(await r.mount.readdir('/gaato')).toEqual({
		ok: true,
		value: [{ name: 'kbbi', kind: 'dir' }]
	});
	expect(await r.mount.stat(root)).toEqual({
		ok: true,
		value: { kind: 'dir', mode: 0o555 }
	});
	expect(r.mount.readlink).toBeUndefined();
	expect(r.fetcher).toHaveBeenCalledTimes(1);
	expect(r.zipCalls()).toHaveLength(0);
});
it('has no versioned or @latest entries and keeps the session version fixed', async () => {
	const r = setup();
	for (const path of [
		'/gaato/kbbi@0.1.6',
		'/gaato/kbbi@0.1.5',
		'/gaato/kbbi@latest',
		'/gaato/missing',
		'/nobody/yanked'
	])
		expect(await r.mount.stat(path)).toEqual({
			ok: false,
			error: { code: 'ENOENT' }
		});
	r.modules[0].version = '0.2.0';
	expect(await r.mount.readdir(root)).toMatchObject({ ok: true });
	expect(r.zipCalls().map(([url]) => url)).toEqual([
		'/_mooncakes/user/gaato/kbbi/0.1.6.zip'
	]);
	expect(
		r.fetcher.mock.calls.some(([url]) =>
			String(url).startsWith(modulesEndpoint + '/')
		)
	).toBe(false);
});
it.each(['list module', 'list below', 'open file', 'stat below'])(
	'fetches the zip only when looking inside: %s',
	async (op) => {
		const r = setup();
		const result =
			op === 'list module'
				? await r.mount.readdir(root)
				: op === 'list below'
					? await r.mount.readdir(root + '/cmd')
					: op === 'open file'
						? await r.mount.open(root + '/README.md')
						: await r.mount.stat(root + '/src/lib.mbt');
		expect(result.ok).toBe(true);
		expect(r.zipCalls()).toHaveLength(1);
		await r.mount.readdir(root);
		await r.mount.stat(root + '/README.md');
		expect(r.zipCalls()).toHaveLength(1);
	}
);
it('memoizes concurrent source fetches, including failures, for the session', async () => {
	const r = setup();
	r.routes.set(
		'/_mooncakes/user/gaato/kbbi/0.1.6.zip',
		() => new Response('', { status: 503 })
	);
	for (const result of await Promise.all([
		r.mount.readdir(root),
		r.mount.open(root + '/README.md'),
		r.mount.stat(root + '/missing')
	]))
		expect(result).toEqual({ ok: false, error: { code: 'EIO' } });
	expect(r.zipCalls()).toHaveLength(1);
	await r.mount.readdir(root);
	expect(r.zipCalls()).toHaveLength(1);
});
it('limits concurrent archive jobs to four, globally across all modules', async () => {
	const r = setup();
	r.modules.splice(
		0,
		r.modules.length,
		...Array.from({ length: 9 }, (_, i) => ({
			name: `owner/m${i}`,
			version: '1.0.0'
		}))
	);
	const releases: (() => void)[] = [];
	for (let i = 0; i < 9; i++)
		r.routes.set(
			`/_mooncakes/user/owner/m${i}/1.0.0.zip`,
			() =>
				new Promise((resolve) =>
					releases.push(() => resolve(new Response('', { status: 503 })))
				)
		);
	const done = Promise.all(
		Array.from({ length: 9 }, (_, i) => r.mount.readdir(`/owner/m${i}`))
	);
	await vi.waitFor(() => expect(releases).toHaveLength(4));
	for (let i = 0; i < 9; i++) {
		releases[i]();
		await vi.waitFor(() => expect(releases.length).toBe(Math.min(9, i + 5)));
		expect(releases.length - i - 1).toBeLessThanOrEqual(4);
	}
	expect((await done).every((r) => !r.ok)).toBe(true);
});
it.each([
	'root.moon.pkg',
	'nested.moon.pkg',
	'options.moon.pkg',
	'legacy.moon.pkg.json'
])('detects executable fixture %s', (name) =>
	expect(executablePackage(packageFixture(name), name.endsWith('.json'))).toBe(
		true
	)
);
it('ignores commented declarations, strings and false legacy declarations', () => {
	for (const source of [
		'// pkgtype(kind: "executable")',
		'/* options("is-main": true) */',
		'pkgtype(kind: "library")',
		'description = "pkgtype(kind: \\"executable\\")"'
	])
		expect(executablePackage(source)).toBe(false);
	expect(executablePackage('{"is-main": false}', true)).toBe(false);
});
it('synthesizes checksum-backed executables in nested and root packages, not libraries or missing prebuilds', async () => {
	const r = setup();
	expect(await r.mount.readdir(root + '/cmd/kbbi')).toEqual({
		ok: true,
		value: [
			{ name: 'kbbi.wasm', kind: 'file' },
			{ name: 'moon.pkg', kind: 'file' }
		]
	});
	expect(await r.mount.readdir(root)).toMatchObject({ ok: true });
	expect(
		r.fetcher.mock.calls.some(
			([url]) =>
				String(url).endsWith('/kbbi.wasm.sha256') &&
				!String(url).includes('/cmd/')
		)
	).toBe(false);
	expect(await r.mount.readdir('/cli/sh')).toMatchObject({
		ok: true,
		value: expect.arrayContaining([{ name: 'sh.wasm', kind: 'file' }])
	});
	expect(await r.mount.readdir('/Yoorkin/cowsay')).toEqual({
		ok: true,
		value: [{ name: 'moon.pkg', kind: 'file' }]
	});
	expect(
		r.fetcher.mock.calls.some(([url]) => String(url).endsWith('.wasm'))
	).toBe(false);
	const file = await r.mount.open(root + '/cmd/kbbi/kbbi.wasm');
	expect(file.ok).toBe(true);
	if (!file.ok) return;
	expect(file.value.size).toBe(wasmFixture.length);
	expect(await file.value.read(1, 2)).toEqual({
		ok: true,
		value: wasmFixture.slice(1, 3)
	});
	expect(await file.value.read(99, 1)).toEqual({
		ok: true,
		value: new Uint8Array()
	});
});
it('provides read-only modes and returns EROFS for every write capability without fetching', async () => {
	const r = setup();
	const expected = { ok: false, error: { code: 'EROFS' } };
	expect(await r.mount.create!('/new')).toEqual(expected);
	expect(await r.mount.write!('/file', 0, new Uint8Array())).toEqual(expected);
	expect(await r.mount.truncate!('/file', 0)).toEqual(expected);
	expect(await r.mount.mkdir!('/dir')).toEqual(expected);
	expect(await r.mount.remove!('/file')).toEqual(expected);
	expect(await r.mount.rename!('/file', '/new')).toEqual(expected);
	expect(r.fetcher).not.toHaveBeenCalled();
});
it('rejects unsafe archive paths and memoizes the extraction failure', async () => {
	const r = setup();
	r.zip('gaato', 'kbbi', '0.1.6', { '../escape.txt': 'no' });
	expect(await r.mount.readdir(root)).toMatchObject({ ok: false });
	expect(await r.mount.readdir(root)).toMatchObject({ ok: false });
	expect(r.zipCalls()).toHaveLength(1);
});
it('reports directory/file mismatches and missing files without treating directory opens as zip reads', async () => {
	const r = setup();
	expect(await r.mount.open(root)).toEqual({
		ok: false,
		error: { code: 'EISDIR' }
	});
	expect(await r.mount.open('/missing')).toEqual({
		ok: false,
		error: { code: 'ENOENT' }
	});
	expect(r.zipCalls()).toHaveLength(0);
	expect(await r.mount.open(root + '/missing')).toEqual({
		ok: false,
		error: { code: 'ENOENT' }
	});
	expect(await r.mount.readdir(root + '/README.md')).toEqual({
		ok: false,
		error: { code: 'ENOTDIR' }
	});
	expect(await r.mount.stat(root + '/README.md/child')).toEqual({
		ok: false,
		error: { code: 'ENOTDIR' }
	});
});
