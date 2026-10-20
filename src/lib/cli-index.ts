import { parseModulePath, wasmUrl } from './paths';

// Written at build time by scripts/prepare-commands.ts, next to the bundled wasm files.
export const bundleIndexPath = '/_commands/index.json';
export interface CliModule {
	name: string;
	version: string;
	/** Bundled commands are served from /_commands/ and verified against this. */
	sha256?: string;
	size?: number;
}
export function commandName(entry: CliModule): string {
	return entry.name.slice('cli/'.length);
}
export function cliProgramPath(entry: CliModule): string {
	return `/${entry.name}@${entry.version}/${commandName(entry)}.wasm`;
}
export function bundledPath(entry: CliModule): string {
	return `/_commands/${commandName(entry)}.wasm`;
}

// Valid, non-yanked, concretely versioned cli/* coordinates.
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

// Bundled entries are executables with a known digest and size.
export function parseBundleIndex(value: unknown): CliModule[] {
	if (!Array.isArray(value)) throw new Error('Invalid command bundle index.');
	const details = new Map<string, { sha256: string; size: number }>();
	for (const entry of value) {
		if (
			typeof entry?.name === 'string' &&
			typeof entry.sha256 === 'string' &&
			/^[a-f0-9]{64}$/.test(entry.sha256) &&
			Number.isSafeInteger(entry.size) &&
			entry.size > 0
		)
			details.set(entry.name, { sha256: entry.sha256, size: entry.size });
	}
	return filterCliIndex(value).flatMap((entry) => {
		const detail = details.get(entry.name);
		return detail ? [{ ...entry, ...detail }] : [];
	});
}

// Static assets only: they cost no Worker requests. Every build bundles cli/*.
export async function fetchCommandIndex(
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch
): Promise<CliModule[]> {
	const response = await fetcher(bundleIndexPath, { signal });
	let entries: CliModule[] = [];
	try {
		if (response.ok) entries = parseBundleIndex(await response.json());
	} catch {
		signal?.throwIfAborted();
	}
	if (!entries.length)
		throw new Error(
			`The command bundle (${bundleIndexPath}) is missing; build with \`pnpm build\` or run \`pnpm prepare:commands\`.`
		);
	return entries;
}
