import {
	cliIndexEndpoint,
	filterCliIndex,
	modulesEndpoint
} from './lib/cli-index';
import {
	downloadOrigin,
	downloadPath,
	mirrorPrefix,
	userAgent
} from './lib/downloads';

export const maxResponseBytes = 64 * 1024 * 1024;
interface Assets {
	fetch(request: Request): Promise<Response>;
}
export interface Env {
	ASSETS: Assets;
}
export interface EdgeCache {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
}
export interface Context {
	waitUntil(promise: Promise<unknown>): void;
}
interface Dependencies {
	fetcher: typeof fetch;
	cache: EdgeCache;
}

function failure(status: number): Response {
	return new Response(
		status === 404 ? 'Not found' : 'Public download unavailable',
		{
			status,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff'
			}
		}
	);
}

function limitedBody(
	body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let total = 0;
	return new ReadableStream({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}
				total += value.byteLength;
				if (total > maxResponseBytes) {
					void reader.cancel().catch(() => {});
					throw new Error('Public download exceeds 64 MiB.');
				}
				controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}

async function cliIndex(
	request: Request,
	context: Context,
	{ cache, fetcher }: Dependencies
): Promise<Response> {
	const url = new URL(request.url);
	if (
		url.search ||
		url.hash ||
		(request.method !== 'GET' && request.method !== 'HEAD')
	)
		return failure(404);
	const key = new Request(url.origin + cliIndexEndpoint);
	let response: Response | undefined;
	try {
		response = await cache.match(key);
	} catch {
		/* Fetch on cache outages. */
	}
	if (!response) {
		try {
			const upstream = await fetcher(
				new Request(modulesEndpoint, {
					credentials: 'omit',
					redirect: 'follow',
					headers: {
						'Accept-Encoding': 'identity',
						'User-Agent': userAgent
					}
				})
			);
			if (upstream.status !== 200 || !upstream.body) return failure(502);
			const entries = filterCliIndex(
				await new Response(limitedBody(upstream.body)).json()
			);
			response = Response.json(entries, {
				headers: {
					'Cache-Control': 'public, max-age=600',
					'X-Content-Type-Options': 'nosniff',
					'Cross-Origin-Resource-Policy': 'same-origin'
				}
			});
			context.waitUntil(cache.put(key, response.clone()).catch(() => {}));
		} catch {
			return failure(502);
		}
	}
	if (request.method === 'GET') return response;
	void response.body?.cancel().catch(() => {});
	return new Response(null, { headers: response.headers });
}

export async function handleRequest(
	request: Request,
	env: Env,
	context: Context,
	dependencies: Dependencies
): Promise<Response> {
	// Read the raw path before constructing a URL, which normalizes dot segments.
	const rawPath = request.url.match(/^https?:\/\/[^/]+(\/[^?#]*)/)?.[1] ?? '/';
	if (!rawPath.startsWith(mirrorPrefix + '/')) return env.ASSETS.fetch(request);
	const url = new URL(request.url);
	if (rawPath === cliIndexEndpoint)
		return cliIndex(request, context, dependencies);
	const path = downloadPath(rawPath.slice(mirrorPrefix.length));
	if (
		!path ||
		url.search ||
		url.hash ||
		(request.method !== 'GET' && request.method !== 'HEAD')
	)
		return failure(404);
	const key = new Request(url.origin + mirrorPrefix + path); // GET, no client headers/query.
	const { cache, fetcher } = dependencies;
	try {
		const cached = await cache.match(key);
		if (cached) {
			if (request.method === 'GET') return cached;
			void cached.body?.cancel().catch(() => {});
			return new Response(null, {
				status: cached.status,
				headers: cached.headers
			});
		}
	} catch {
		/* Cache outages do not prevent public downloads. */
	}

	try {
		// GET also serves HEAD misses: the public download host does not support HEAD.
		// Construct from a fixed origin and validated path, never from the client Request.
		const upstream = await fetcher(
			new Request(downloadOrigin + path, {
				method: 'GET',
				redirect: 'follow',
				credentials: 'omit',
				// CloudFront rejects requests without a User-Agent. Use our own fixed
				// identifier, never the incoming browser's headers.
				headers: { 'Accept-Encoding': 'identity', 'User-Agent': userAgent }
			})
		);
		const length = upstream.headers.get('Content-Length');
		if (
			upstream.status !== 200 ||
			(length !== null &&
				(!/^\d+$/.test(length) || Number(length) > maxResponseBytes))
		) {
			void upstream.body?.cancel().catch(() => {});
			return failure(upstream.status === 404 ? 404 : 502);
		}
		if (!upstream.body) return failure(502);
		// Only our own response headers survive. No Set-Cookie, redirects, CORS or Vary.
		const headers = new Headers({
			'Content-Type': path.endsWith('.sha256')
				? 'text/plain; charset=utf-8'
				: path.endsWith('.wasm')
					? 'application/wasm'
					: 'application/zip',
			'Cache-Control': 'public, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff',
			'Cross-Origin-Resource-Policy': 'same-origin'
		});
		const response = new Response(limitedBody(upstream.body), { headers });
		const copy = response.clone();
		// Cache.put consumes the bounded stream atomically. A read/size error prevents
		// a cache entry; quota errors remain recoverable. Keep it alive after HEAD too.
		context.waitUntil(
			cache.put(key, copy).catch(async () => {
				try {
					await copy.body?.cancel();
				} catch {
					/* Already consumed/locked. */
				}
			})
		);
		if (request.method === 'HEAD') {
			void response.body?.cancel().catch(() => {});
			return new Response(null, { headers });
		}
		return response;
	} catch {
		return failure(502);
	}
}
