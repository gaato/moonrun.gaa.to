import type { CliModule } from '../cli-index';

export interface PreloadProgress {
	completed: number;
	total: number;
	bytes: number;
}
export interface PreloadOptions {
	signal?: AbortSignal;
	onProgress?: (progress: PreloadProgress) => void;
	onFailure?: (entry: CliModule, error: unknown) => void;
}

// Resolves only after every job settles; callers must await this before starting sh.
export async function preloadCommands(
	index: readonly CliModule[],
	load: (entry: CliModule) => Promise<Uint8Array | undefined>,
	{ signal, onProgress, onFailure }: PreloadOptions = {}
): Promise<CliModule[]> {
	let next = 0;
	let completed = 0;
	let bytes = 0;
	const notCommands = new Set<CliModule>();
	const report = () =>
		onProgress?.({ completed, total: index.length - notCommands.size, bytes });
	report();
	async function worker() {
		while (next < index.length) {
			signal?.throwIfAborted();
			const entry = index[next++];
			try {
				const wasm = await load(entry);
				signal?.throwIfAborted();
				if (!wasm) {
					notCommands.add(entry);
					report();
					continue;
				}
				bytes += wasm.byteLength;
			} catch (error) {
				signal?.throwIfAborted();
				onFailure?.(entry, error);
			}
			completed++;
			report();
		}
	}
	await Promise.all(Array.from({ length: Math.min(6, index.length) }, worker));
	signal?.throwIfAborted();
	return index.filter((entry) => !notCommands.has(entry));
}
