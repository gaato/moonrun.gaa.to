import { describe, expect, it, vi } from 'vitest';
import worker from './worker';
import { handleRequest, maxResponseBytes, type EdgeCache } from './mirror';
import { userAgent } from './lib/downloads';

const origin = 'https://moonrun.example';
const wasm = '/_mooncakes/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm';
const checksum = wasm + '.sha256';
class FakeCache implements EdgeCache {
	entries = new Map<string, Response>();
	keys: Request[] = [];
	async match(key: Request) {
		this.keys.push(key);
		return this.entries.get(key.url)?.clone();
	}
	async put(key: Request, response: Response) {
		// Match the edge cache's atomic write: a failed body never creates an entry.
		const bytes = await response.arrayBuffer();
		this.entries.set(key.url, new Response(bytes, response));
	}
}
function setup(
	fetcher = vi.fn<typeof fetch>(async () => new Response('wasm'))
) {
	const cache = new FakeCache();
	const tasks: Promise<unknown>[] = [];
	const context = {
		waitUntil(promise: Promise<unknown>) {
			tasks.push(promise);
		}
	};
	const assets = {
		fetch: vi.fn(async (_request: Request) => new Response('SPA'))
	};
	return {
		cache,
		tasks,
		fetcher,
		assets,
		run(path = wasm, init?: RequestInit) {
			return handleRequest(
				new Request(origin + path, init),
				{ ASSETS: assets },
				context,
				{ fetcher, cache }
			);
		}
	};
}

describe('mirror allowlist', () => {
	it.each([
		[wasm, 'application/wasm'],
		[checksum, 'text/plain; charset=utf-8'],
		['/_mooncakes/prebuild/a/b/v2@2.0.0/tool/tool.wasm', 'application/wasm'],
		['/_mooncakes/prebuild/cli/sh@0.2.1/sh.wasm', 'application/wasm'],
		['/_mooncakes/prebuild/a/b@1.2.3-rc.1%2Bbuild.2/b.wasm', 'application/wasm']
	])('serves %s with a controlled content type', async (path, contentType) => {
		const s = setup();
		const response = await s.run(path);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe(contentType);
		expect(await response.text()).toBe('wasm');
		expect(s.fetcher.mock.calls[0][0]).toBeInstanceOf(Request);
		const upstream = s.fetcher.mock.calls[0][0] as Request;
		expect(upstream.url).toBe(
			'https://download.mooncakes.io' + path.slice('/_mooncakes'.length)
		);
		expect(upstream.redirect).toBe('follow');
		await Promise.all(s.tasks);
	});
	it.each([
		'/_mooncakes/other/a/b@1.0.0/b.wasm',
		'/_mooncakes/user/gaato/kbbi/0.1.6.zip',
		'/_mooncakes/cli-index',
		'/_mooncakes/prebuild/a/b/b.wasm',
		'/_mooncakes/prebuild/a/b@latest/b.wasm',
		'/_mooncakes/prebuild/a/b@LATEST/b.wasm',
		'/_mooncakes/prebuild/a/b@1/b.wasm',
		'/_mooncakes/prebuild/a/b@^1.0.0/b.wasm',
		'/_mooncakes/prebuild/a/b@1.0.0/',
		'/_mooncakes/prebuild/a/b@1.0.0/b.js',
		'/_mooncakes/prebuild/a/b@1.0.0/skills.zip',
		'/_mooncakes/skills/a/b@1.0.0/b.wasm',
		'/_mooncakes/skills/a/b@1.0.0/skills.zip',
		'/_mooncakes/prebuild/a/b@1.0.0//b.wasm',
		'/_mooncakes/prebuild/a/b@1.0.0/%2fetc.wasm',
		'/_mooncakes/prebuild/a/b@1.0.0/a%5Cb.wasm',
		'/_mooncakes/prebuild/a/b@1.0.0/%252fetc.wasm',
		'/_mooncakes/prebuild/a/b@1.0.0/%ZZ.wasm',
		'/_mooncakes/prebuild/a/b@1.0.0/b..wasm',
		'/_mooncakes/prebuild/a/b@1.0.0/b.wasm?url=https://evil.example',
		'/_mooncakes/prebuild/a/b@1.0.0/b.wasm#fragment'
	])('rejects %s before cache or network access', async (path) => {
		const s = setup();
		const response = await s.run(path);
		expect(response.status).toBe(404);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(s.fetcher).not.toHaveBeenCalled();
		expect(s.cache.keys).toHaveLength(0);
		expect(s.assets.fetch).not.toHaveBeenCalled();
	});
	it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
		'rejects method %s with 404',
		async (method) => {
			const s = setup();
			expect((await s.run(wasm, { method })).status).toBe(404);
			expect(s.fetcher).not.toHaveBeenCalled();
		}
	);
	it.each(['../', '%2e%2e/', '.%2e/', '%2E./', '%252e%252e/'])(
		'rejects raw traversal %s before URL normalization',
		async (traversal) => {
			const s = setup();
			// Request constructors normalize literal/encoded dot segments. Pass the raw
			// wire spelling to exercise the handler's pre-normalization validation too.
			const request = {
				url: origin + wasm.replace('/kbbi.wasm', '/' + traversal + 'kbbi.wasm'),
				method: 'GET'
			} as Request;
			const response = await handleRequest(
				request,
				{ ASSETS: s.assets },
				{ waitUntil: () => {} },
				{ fetcher: s.fetcher, cache: s.cache }
			);
			expect(response.status).toBe(404);
			expect(s.fetcher).not.toHaveBeenCalled();
		}
	);
});

it('strips all client headers and controls response headers independently of upstream', async () => {
	const s = setup(
		vi.fn(
			async () =>
				new Response('data', {
					headers: {
						'Set-Cookie': 'session=private',
						Vary: '*',
						Location: 'https://evil.example',
						'Access-Control-Allow-Origin': '*',
						'Content-Type': 'text/html'
					}
				})
		)
	);
	const response = await s.run(wasm, {
		headers: {
			Cookie: 'secret=x',
			Authorization: 'Bearer secret',
			Range: 'bytes=0-1',
			'If-None-Match': 'tag',
			Origin: 'https://evil.example',
			'X-User': 'private',
			'User-Agent': 'private-client-agent'
		}
	});
	const upstream = s.fetcher.mock.calls[0][0] as Request;
	expect([...upstream.headers]).toEqual([
		['accept-encoding', 'identity'],
		['user-agent', userAgent]
	]);
	expect(upstream.method).toBe('GET');
	expect(upstream.credentials).toBe('omit');
	expect([...s.cache.keys[0].headers]).toEqual([]);
	expect(response.headers.get('Set-Cookie')).toBeNull();
	expect(response.headers.get('Vary')).toBeNull();
	expect(response.headers.get('Location')).toBeNull();
	expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
	expect(response.headers.get('Content-Type')).toBe('application/wasm');
	expect(response.headers.get('Cache-Control')).toBe(
		'public, max-age=31536000, immutable'
	);
	expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe(
		'same-origin'
	);
	expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	await response.text();
	await Promise.all(s.tasks);
});
it('caches a GET miss and serves GET/HEAD hits without fetching or forwarding headers', async () => {
	const s = setup();
	expect(await (await s.run()).text()).toBe('wasm');
	await Promise.all(s.tasks);
	expect(s.cache.entries.size).toBe(1);
	expect(
		await (await s.run(wasm, { headers: { Range: 'bytes=0-1' } })).text()
	).toBe('wasm');
	const head = await s.run(wasm, { method: 'HEAD' });
	expect(head.body).toBeNull();
	expect(head.status).toBe(200);
	expect(s.fetcher).toHaveBeenCalledOnce();
});
it('serves HEAD misses with a header-free upstream GET and warms the cache', async () => {
	const s = setup();
	const head = await s.run(wasm, { method: 'HEAD' });
	expect(head.body).toBeNull();
	await Promise.all(s.tasks);
	expect(s.cache.entries.size).toBe(1);
	expect((s.fetcher.mock.calls[0][0] as Request).method).toBe('GET');
	expect(await (await s.run()).text()).toBe('wasm');
	expect(s.fetcher).toHaveBeenCalledOnce();
});
it.each([404, 403, 500, 206, 302])(
	'does not cache upstream status %s or expose its body',
	async (status) => {
		const s = setup(
			vi.fn(async () => new Response('private upstream diagnostic', { status }))
		);
		const response = await s.run();
		expect(response.status).toBe(status === 404 ? 404 : 502);
		expect(await response.text()).not.toContain('private');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(s.cache.entries.size).toBe(0);
		expect(s.tasks).toHaveLength(0);
	}
);
it('does not cache fetch failures', async () => {
	const s = setup(
		vi.fn(async () => {
			throw new Error('upstream failure');
		})
	);
	expect((await s.run()).status).toBe(502);
	expect(s.cache.entries.size).toBe(0);
});
it('rejects known oversized responses before sending or caching their body', async () => {
	const s = setup(
		vi.fn(
			async () =>
				new Response('data', {
					headers: { 'Content-Length': String(maxResponseBytes + 1) }
				})
		)
	);
	expect((await s.run()).status).toBe(502);
	expect(s.cache.entries.size).toBe(0);
	expect(s.tasks).toHaveLength(0);
});
it('enforces the stream limit with absent or underreported Content-Length and never stores a partial entry', async () => {
	const big = new Uint8Array(maxResponseBytes + 1);
	for (const headers of [
		new Headers(),
		new Headers({ 'Content-Length': '1' })
	]) {
		const s = setup(
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(big);
								c.close();
							}
						}),
						{ headers }
					)
			)
		);
		const response = await s.run();
		await expect(response.arrayBuffer()).rejects.toThrow('64 MiB');
		await Promise.all(s.tasks);
		expect(s.cache.entries.size).toBe(0);
	}
});
it('passes through static paths and their SPA fallback without upstream access', async () => {
	const s = setup();
	expect(await (await s.run('/shell')).text()).toBe('SPA');
	expect(s.assets.fetch).toHaveBeenCalledOnce();
	expect(s.fetcher).not.toHaveBeenCalled();
});
it('uses caches.default in the Cloudflare entrypoint', async () => {
	const s = setup();
	vi.stubGlobal('caches', { default: s.cache });
	vi.stubGlobal('fetch', s.fetcher);
	try {
		const response = await worker.fetch(
			new Request(origin + wasm),
			{ ASSETS: s.assets },
			{ waitUntil: (task) => s.tasks.push(task) }
		);
		expect(await response.text()).toBe('wasm');
		await Promise.all(s.tasks);
		expect(s.cache.entries.size).toBe(1);
	} finally {
		vi.unstubAllGlobals();
	}
});

it('does not cache a failed upstream body stream', async () => {
	const s = setup(
		vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error('interrupted download'));
						}
					})
				)
		)
	);
	const response = await s.run();
	await expect(response.text()).rejects.toThrow('interrupted download');
	await Promise.all(s.tasks);
	expect(s.cache.entries.size).toBe(0);
});
it('serves downloads when cache reads or writes fail', async () => {
	const fetcher = vi.fn<typeof fetch>(async () => new Response('data'));
	const cache: EdgeCache = {
		async match() {
			throw new Error('cache unavailable');
		},
		async put() {
			throw new Error('quota');
		}
	};
	const tasks: Promise<unknown>[] = [];
	const assets = {
		fetch: vi.fn(async (_request: Request) => new Response('SPA'))
	};
	const response = await handleRequest(
		new Request(origin + wasm),
		{ ASSETS: assets },
		{
			waitUntil(task) {
				tasks.push(task);
			}
		},
		{ fetcher, cache }
	);
	expect(await response.text()).toBe('data');
	await Promise.all(tasks);
	expect(fetcher).toHaveBeenCalledOnce();
});

it.each(['/', '/shell', '/cli/sh@0.2.1/sh.wasm', '/_commands/sh.wasm'])(
	'passes %s to static assets unchanged',
	async (path) => {
		const s = setup();
		expect(await (await s.run(path)).text()).toBe('SPA');
		const request = s.assets.fetch.mock.calls[0][0] as Request;
		expect(request.url).toBe(origin + path);
		expect(s.fetcher).not.toHaveBeenCalled();
	}
);
