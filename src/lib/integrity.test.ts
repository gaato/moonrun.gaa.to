import { describe, it, expect, vi } from 'vitest';
import {
	cacheKey,
	digestHex,
	verifiedBytes,
	verifySha256,
	type VerifiedCache
} from './integrity';
const bytes = new TextEncoder().encode('hello');
const digest =
	'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const url = 'https://download.mooncakes.io/prebuild/a/b@1/b.wasm';
class FakeCache implements VerifiedCache {
	entries = new Map<string, Response>();
	async match(key: string) {
		return this.entries.get(key)?.clone();
	}
	async put(key: string, response: Response) {
		this.entries.set(key, response.clone());
	}
	async delete(key: string) {
		return this.entries.delete(key);
	}
}
it('verifies SHA-256 and supported public digest formats', async () => {
	expect(await verifySha256(bytes, digest)).toBe(digest);
	expect(digestHex(`sha256:${digest.toUpperCase()}`)).toBe(digest);
	expect(digestHex(`${digest}  b.wasm\n`)).toBe(digest);
	await expect(verifySha256(bytes, '0'.repeat(64))).rejects.toThrow('mismatch');
	expect(() => digestHex('not a hash')).toThrow();
});
describe('verified Cache API wrapper', () => {
	it('uses URL and digest as identity and verifies cached bytes again', async () => {
		const cache = new FakeCache();
		const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes));
		expect(await verifiedBytes(url, digest, cache, fetcher)).toEqual(bytes);
		expect(await verifiedBytes(url, digest, cache, fetcher)).toEqual(bytes);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(cache.entries.has(cacheKey(url, digest))).toBe(true);
		expect(cacheKey(url, digest)).not.toBe(cacheKey(url, '0'.repeat(64)));
		expect(cacheKey(url, digest)).not.toBe(cacheKey(url + '?v=2', digest));
		await cache.put(cacheKey(url, digest), new Response('corrupted'));
		expect(await verifiedBytes(url, digest, cache, fetcher)).toEqual(bytes);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('never caches a mismatch and refuses failed HTTP responses', async () => {
		const cache = new FakeCache();
		await expect(
			verifiedBytes(url, digest, cache, async () => new Response('wrong'))
		).rejects.toThrow('mismatch');
		expect(cache.entries.size).toBe(0);
		await expect(
			verifiedBytes(
				url,
				digest,
				cache,
				async () => new Response('', { status: 404 })
			)
		).rejects.toThrow('404');
	});
	it('tolerates unavailable cache and write quota failures', async () => {
		const broken: VerifiedCache = {
			match: async () => {
				throw new Error('disabled');
			},
			put: async () => {
				throw new Error('quota');
			},
			delete: async () => false
		};
		expect(
			await verifiedBytes(url, digest, broken, async () => new Response(bytes))
		).toEqual(bytes);
		expect(
			await verifiedBytes(
				url,
				digest,
				undefined,
				async () => new Response(bytes)
			)
		).toEqual(bytes);
	});
});
