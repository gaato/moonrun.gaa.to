import { handleRequest, type Env, type Context } from './mirror';

export default {
	fetch(request: Request, env: Env, context: Context): Promise<Response> {
		return handleRequest(request, env, context, {
			fetcher: fetch,
			cache: (caches as CacheStorage & { default: Cache }).default
		});
	}
};
