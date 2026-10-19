import { expect, it, vi, afterEach } from 'vitest';
import { pinVersion } from './modules';
import { parseModulePath, modulePath } from './paths';
afterEach(() => vi.unstubAllGlobals());
it('pins latest and missing versions using latest_version without changing the executable path', async () => {
	const fetcher = vi.fn(async () =>
		Response.json({ latest_version: '1.2.3', versions: [{ version: '9.0.0' }] })
	);
	vi.stubGlobal('fetch', fetcher);
	for (const value of [
		'/gaato/kbbi@latest/cmd/kbbi/kbbi.wasm',
		'/gaato/kbbi/cmd/kbbi/kbbi.wasm'
	]) {
		expect(modulePath(await pinVersion(parseModulePath(value)!))).toBe(
			'/gaato/kbbi@1.2.3/cmd/kbbi/kbbi.wasm'
		);
	}
	expect(fetcher).toHaveBeenCalledWith(
		'https://mooncakes.io/api-new/v0/modules/gaato/kbbi',
		{ signal: undefined }
	);
	const pinned = parseModulePath('/cli/sh@0.2.1/sh.wasm')!;
	expect(await pinVersion(pinned)).toBe(pinned);
	expect(fetcher).toHaveBeenCalledTimes(2);
});
it('refuses missing or invalid latest versions and failed requests', async () => {
	const path = parseModulePath('/cli/sh@latest/sh.wasm')!;
	vi.stubGlobal('fetch', async () => Response.json({}));
	await expect(pinVersion(path)).rejects.toThrow('no latest');
	vi.stubGlobal('fetch', async () => Response.json({ latest_version: '@bad' }));
	await expect(pinVersion(path)).rejects.toThrow();
	vi.stubGlobal('fetch', async () =>
		Response.json({ latest_version: '1/other.wasm' })
	);
	await expect(pinVersion(path)).rejects.toThrow('Invalid latest');
	vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
	await expect(pinVersion(path)).rejects.toThrow('404');
});
