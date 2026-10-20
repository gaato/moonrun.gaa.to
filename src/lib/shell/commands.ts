import { bundledPath, cliProgramPath, type CliModule } from '../cli-index';
import {
	browserCache,
	verifiedBytes,
	verifiedWasm,
	type VerifiedCache
} from '../integrity';
import { parseModulePath, wasmUrl } from '../paths';

export type CommandLoader = (
	entry: CliModule
) => Promise<Uint8Array | undefined>;
export interface CommandLoaderOptions {
	fetcher?: typeof fetch;
	signal?: AbortSignal;
	cache?: VerifiedCache;
}

// Bundled static files first, checked against the bundle index digest; the verified
// mirror download covers missing or stale static files and unbundled entries.
// Verified bytes stay in memory for the session. A missing prebuild (undefined) is
// remembered; other failures retry on the next use.
export function createCommandLoader({
	fetcher = fetch,
	signal,
	cache
}: CommandLoaderOptions = {}): CommandLoader {
	const loaded = new Map<string, Promise<Uint8Array | undefined>>();
	async function load(entry: CliModule) {
		const store = cache ?? (await browserCache());
		if (entry.sha256) {
			try {
				return await verifiedBytes(
					bundledPath(entry),
					entry.sha256,
					store,
					fetcher,
					signal
				);
			} catch {
				signal?.throwIfAborted();
			}
		}
		return verifiedWasm(
			wasmUrl(parseModulePath(cliProgramPath(entry))!),
			store,
			fetcher,
			signal
		);
	}
	return (entry) => {
		const key = `${entry.name}@${entry.version}`;
		let pending = loaded.get(key);
		if (!pending) {
			pending = load(entry);
			loaded.set(key, pending);
			void pending.catch(() => loaded.delete(key));
		}
		return pending;
	};
}
