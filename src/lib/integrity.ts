import { downloadPath, mirrorPrefix } from './downloads';

export function digestHex(text: string): string {
	// Digests may be bare or sha256:hex; checksum files may use sha256sum format.
	const match = /^(?:sha256:)?([a-f0-9]{64})(?:\s+\*?[^\r\n]+)?$/i.exec(
		text.trim()
	);
	if (!match) throw new Error('Invalid SHA-256 checksum.');
	return match[1].toLowerCase();
}

export async function verifySha256(
	bytes: Uint8Array,
	expected: string
): Promise<string> {
	const hex = digestHex(expected);
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	const actual = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, '0')
	).join('');
	if (actual !== hex)
		throw new Error('SHA-256 mismatch. Refusing to use these bytes.');
	return hex;
}

export interface VerifiedCache {
	match(key: string): Promise<Response | undefined>;
	put(key: string, response: Response): Promise<void>;
	delete(key: string): Promise<boolean>;
}

export function cacheKey(url: string, digest: string): string {
	const key = new URL(url, globalThis.location?.href);
	key.searchParams.set('__mooncakes_sha256', digestHex(digest));
	return key.href;
}

export async function verifiedBytes(
	url: string,
	digest: string,
	cache?: VerifiedCache,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<Uint8Array> {
	const key = cacheKey(url, digest);
	// Cache storage is an optimization; private browsing and quota errors are recoverable.
	let cached: Response | undefined;
	try {
		cached = await cache?.match(key);
	} catch {
		/* Use the network. */
	}
	if (cached) {
		const bytes = new Uint8Array(await cached.arrayBuffer());
		try {
			await verifySha256(bytes, digest);
			return bytes;
		} catch {
			try {
				await cache?.delete(key);
			} catch {
				/* Use the network. */
			}
		}
	}
	const response = await fetcher(url, { signal });
	if (!response.ok) throw new Error(`Download failed (${response.status}).`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	await verifySha256(bytes, digest);
	try {
		await cache?.put(key, new Response(new Uint8Array(bytes)));
	} catch {
		/* Verified bytes still work. */
	}
	return bytes;
}

export async function browserCache(): Promise<Cache | undefined> {
	try {
		return await caches.open('mooncakes-verified-v1');
	} catch {
		return undefined;
	}
}

// Immutable prebuilds use their exact URL as identity, with the verified digest
// stored alongside the bytes. Bundled commands use URL+digest identity above.
export async function verifiedWasm(
	url: string,
	cache?: VerifiedCache,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<Uint8Array | undefined> {
	const key = new URL(url, globalThis.location?.href);
	if (
		key.search ||
		key.hash ||
		!key.pathname.startsWith(mirrorPrefix + '/') ||
		!key.pathname.endsWith('.wasm') ||
		!downloadPath(key.pathname.slice(mirrorPrefix.length))
	)
		throw new Error('Expected an immutable versioned wasm URL.');
	let cached: Response | undefined;
	try {
		cached = await cache?.match(key.href);
	} catch {
		/* Use the network. */
	}
	if (cached) {
		try {
			const bytes = new Uint8Array(await cached.arrayBuffer());
			await verifySha256(bytes, cached.headers.get('X-Mooncakes-SHA256') ?? '');
			return bytes;
		} catch {
			try {
				await cache?.delete(key.href);
			} catch {
				/* Use the network. */
			}
		}
	}
	const checksum = await fetcher(url + '.sha256', {
		signal,
		cache: 'no-store'
	});
	if (checksum.status === 404) return undefined;
	if (!checksum.ok)
		throw new Error(`Could not fetch checksum (${checksum.status}).`);
	const digest = digestHex(await checksum.text());
	const bytes = await verifiedBytes(url, digest, undefined, fetcher, signal);
	try {
		await cache?.put(
			key.href,
			new Response(new Uint8Array(bytes), {
				headers: { 'X-Mooncakes-SHA256': digest }
			})
		);
	} catch {
		/* Verified bytes still work if caching fails. */
	}
	return bytes;
}
