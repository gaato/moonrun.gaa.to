import { describe, it, expect, vi } from 'vitest';
import {
	cacheKey,
	digestHex,
	verifiedBytes,
	verifiedWasm,
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

it('keys relative mirror paths by their actual same-origin URL and digest', async () => {
	vi.stubGlobal('location', {
		href: 'https://playground.example/a/b@1.0.0/b.wasm'
	});
	try {
		const path = '/_mooncakes/prebuild/a/b@1.0.0/b.wasm';
		const cache = new FakeCache();
		const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes));
		expect(await verifiedBytes(path, digest, cache, fetcher)).toEqual(bytes);
		expect(await verifiedBytes(path, digest, cache, fetcher)).toEqual(bytes);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(new URL(cacheKey(path, digest)).origin).toBe(
			'https://playground.example'
		);
	} finally {
		vi.unstubAllGlobals();
	}
});

describe('immutable wasm cache', () => {
	const url =
		'https://playground.test/_mooncakes/prebuild/cli/sh@1.0.0/sh.wasm';
	function downloader() {
		return vi.fn<typeof fetch>(async (input) =>
			String(input).endsWith('.sha256')
				? new Response(digest)
				: new Response(bytes)
		);
	}
	it('stores the digest with URL-keyed bytes and hits without fetching checksum or wasm', async () => {
		const cache = new FakeCache();
		const fetcher = downloader();
		expect(await verifiedWasm(url, cache, fetcher)).toEqual(bytes);
		expect(cache.entries.size).toBe(1);
		expect(cache.entries.get(url)?.headers.get('X-Mooncakes-SHA256')).toBe(
			digest
		);
		expect(await verifiedWasm(url, cache, fetcher)).toEqual(bytes);
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			url + '.sha256',
			url
		]);
	});
	it.each(['corrupt bytes', 'missing digest'])(
		'evicts %s and verifies a fresh download',
		async (fault) => {
			const cache = new FakeCache();
			await cache.put(
				url,
				fault === 'corrupt bytes'
					? new Response('bad', { headers: { 'X-Mooncakes-SHA256': digest } })
					: new Response(bytes)
			);
			const fetcher = downloader();
			expect(await verifiedWasm(url, cache, fetcher)).toEqual(bytes);
			expect(fetcher).toHaveBeenCalledTimes(2);
		}
	);
	it('does not store mismatches, missing executables or failed checksum downloads', async () => {
		const cache = new FakeCache();
		await expect(
			verifiedWasm(url, cache, async (input) =>
				String(input).endsWith('.sha256')
					? new Response(digest)
					: new Response('bad')
			)
		).rejects.toThrow('mismatch');
		expect(
			await verifiedWasm(
				url,
				cache,
				async () => new Response('', { status: 404 })
			)
		).toBeUndefined();
		await expect(
			verifiedWasm(url, cache, async () => new Response('', { status: 500 }))
		).rejects.toThrow('500');
		expect(cache.entries.size).toBe(0);
	});
	it('rejects mutable versions and archives before touching cache or network', async () => {
		const fetcher = downloader();
		for (const input of [
			url.replace('@1.0.0', '@latest'),
			url.replace('sh.wasm', 'skills.zip'),
			url + '?v=1'
		])
			await expect(verifiedWasm(input, undefined, fetcher)).rejects.toThrow(
				'immutable'
			);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
