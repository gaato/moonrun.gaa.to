import { parseModulePath, wasmUrl } from './paths';

export const cliIndexEndpoint = '/_mooncakes/cli-index';
export const modulesEndpoint = 'https://mooncakes.io/api-new/v0/modules';
export interface CliModule {
	name: string;
	version: string;
}
export function cliProgramPath(entry: CliModule): string {
	return `/${entry.name}@${entry.version}/${entry.name.slice(4)}.wasm`;
}

// The registry list includes libraries. A valid coordinate need not be executable.
export function filterCliIndex(value: unknown): CliModule[] {
	if (!Array.isArray(value)) throw new Error('Invalid CLI index.');
	const entries = new Map<string, CliModule>();
	for (const entry of value) {
		if (
			typeof entry?.name !== 'string' ||
			entry.yanked ||
			!/^cli\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(entry.name) ||
			typeof entry.version !== 'string'
		)
			continue;
		try {
			wasmUrl(parseModulePath(cliProgramPath(entry))!);
			if (!entries.has(entry.name))
				entries.set(entry.name, { name: entry.name, version: entry.version });
		} catch {
			/* Ignore invalid or mutable coordinates. */
		}
	}
	return [...entries.values()].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0
	);
}
export async function fetchCliIndex(
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch
): Promise<CliModule[]> {
	const response = await fetcher(cliIndexEndpoint, {
		signal,
		cache: 'no-store'
	});
	if (!response.ok)
		throw new Error(`Could not load CLI index (${response.status}).`);
	return filterCliIndex(await response.json());
}
