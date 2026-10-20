import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createCommandLoader } from './commands';
import type { VerifiedCache } from '../integrity';
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const bundled = {
	name: 'cli/cat',
	version: '0.2.1',
	sha256,
	size: bytes.length
};
const mirror = '/_mooncakes/prebuild/cli/cat@0.2.1/cat.wasm';
beforeEach(() => vi.stubGlobal('location', new URL('https://moonrun.test')));
afterEach(() => vi.unstubAllGlobals());
function routes(entries: Record<string, () => Response>) {
	return vi.fn<typeof fetch>(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		return entries[url]?.() ?? new Response('', { status: 404 });
	});
}
const memoryCache = (): VerifiedCache & { keys(): string[] } => {
	const entries = new Map<string, Response>();
	return {
		match: async (key) => entries.get(key)?.clone(),
		put: async (key, response) => {
			entries.set(key, response);
		},
		delete: async (key) => entries.delete(key),
		keys: () => [...entries.keys()]
	};
};
it('loads a bundled command from static assets only, verified against the bundle digest', async () => {
	const fetcher = routes({
		'/_commands/cat.wasm': () => new Response(new Uint8Array(bytes))
	});
	const cache = memoryCache();
	const load = createCommandLoader({ fetcher, cache });
	expect(await load(bundled)).toEqual(bytes);
	expect(load(bundled)).toBe(load(bundled));
	expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
		'/_commands/cat.wasm'
	]);
	// A fresh session uses the digest-keyed Cache API entry without any request.
	expect(await createCommandLoader({ fetcher, cache })(bundled)).toEqual(bytes);
	expect(fetcher).toHaveBeenCalledOnce();
	expect(cache.keys()[0]).toContain(sha256);
});
it.each(['missing', 'stale'])(
	'falls back to the verified mirror when the static file is %s',
	async (problem) => {
		const fetcher = routes({
			'/_commands/cat.wasm': () =>
				problem === 'missing'
					? new Response('<!doctype html>')
					: new Response(new Uint8Array([0, 97, 115, 109, 9])),
			[mirror + '.sha256']: () => new Response(sha256),
			[mirror]: () => new Response(new Uint8Array(bytes))
		});
		expect(await createCommandLoader({ fetcher })(bundled)).toEqual(bytes);
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			'/_commands/cat.wasm',
			mirror + '.sha256',
			mirror
		]);
	}
);
it('loads unbundled entries from the mirror, remembers missing prebuilds and retries failures', async () => {
	let fail = true;
	const fetcher = routes({
		'/_mooncakes/prebuild/cli/core@0.6.0/core.wasm.sha256': () =>
			new Response('', { status: 404 }),
		[mirror + '.sha256']: () =>
			fail ? new Response('', { status: 503 }) : new Response(sha256),
		[mirror]: () => new Response(new Uint8Array(bytes))
	});
	const load = createCommandLoader({ fetcher });
	const core = { name: 'cli/core', version: '0.6.0' };
	expect(await load(core)).toBeUndefined();
	expect(await load(core)).toBeUndefined();
	const cat = { name: 'cli/cat', version: '0.2.1' };
	await expect(load(cat)).rejects.toThrow('503');
	fail = false;
	expect(await load(cat)).toEqual(bytes);
	expect(
		fetcher.mock.calls.filter(([url]) => String(url).includes('core'))
	).toHaveLength(1);
	expect(
		fetcher.mock.calls.some(([url]) => String(url).startsWith('/_commands'))
	).toBe(false);
});
it('does not fall back after cancellation', async () => {
	const controller = new AbortController();
	const fetcher = vi.fn<typeof fetch>(async () => {
		controller.abort();
		throw controller.signal.reason;
	});
	await expect(
		createCommandLoader({ fetcher, signal: controller.signal })(bundled)
	).rejects.toThrow();
	expect(fetcher).toHaveBeenCalledOnce();
});
