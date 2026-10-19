import { type ModulePath, parseModulePath } from './paths';

export class ModuleNotFoundError extends Error {
	constructor() {
		super('Module not found (404).');
	}
}

export async function pinVersion(
	path: ModulePath,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch
): Promise<ModulePath> {
	if (path.version !== 'latest') return path;
	const response = await fetcher(
		`https://mooncakes.io/api-new/v0/modules/${encodeURIComponent(path.owner)}/${encodeURIComponent(path.module)}`,
		{ signal, cache: 'no-store' }
	);
	if (response.status === 404) throw new ModuleNotFoundError();
	if (!response.ok)
		throw new Error(`Could not resolve latest version (${response.status}).`);
	const detail = (await response.json()) as { latest_version?: unknown };
	if (
		typeof detail.latest_version !== 'string' ||
		detail.latest_version === 'latest'
	) {
		throw new Error('Module has no latest version.');
	}
	const validated = parseModulePath(
		`/${path.owner}/${path.module}@${detail.latest_version}/${[...path.packagePath, path.filename].join('/')}`
	);
	if (!validated || validated.version !== detail.latest_version)
		throw new Error('Invalid latest version.');
	return validated;
}
