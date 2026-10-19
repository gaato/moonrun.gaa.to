import { downloadPath, mirrorPrefix } from './downloads';

export interface ModulePath {
	owner: string;
	module: string;
	version: string;
	packagePath: string[];
	filename: string;
}

const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

// Unknown site paths stay site paths. Missing versions are accepted only for wasm URLs.
export function parseModulePath(pathname: string): ModulePath | null {
	const raw = pathname.replace(/^\//, '').split('/');
	const parts = raw.map((part) => {
		try {
			return decodeURIComponent(part);
		} catch {
			throw new Error('Invalid URL encoding.');
		}
	});
	const [owner, moduleVersion, ...tail] = parts;
	if (!owner || !moduleVersion) return null;
	const explicit = moduleVersion.includes('@');
	if (!explicit && !tail.at(-1)?.endsWith('.wasm')) return null;
	const [module, version = 'latest', ...extra] = moduleVersion.split('@');
	const filename = tail.at(-1);
	if (
		!segment.test(owner) ||
		!segment.test(module) ||
		!versionPattern.test(version) ||
		extra.length ||
		!filename?.endsWith('.wasm') ||
		filename === '.wasm' ||
		!tail.every((p) => segment.test(p))
	) {
		throw new Error('Expected owner/module@version/path/name.wasm.');
	}
	return { owner, module, version, packagePath: tail.slice(0, -1), filename };
}

export function modulePath(value: ModulePath): string {
	return (
		'/' +
		[
			value.owner,
			`${value.module}@${value.version}`,
			...value.packagePath,
			value.filename
		]
			.map((p) => encodeURIComponent(p).replaceAll('%40', '@'))
			.join('/')
	);
}

export function wasmUrl(value: ModulePath): string {
	const path = downloadPath(`/prebuild${modulePath(value)}`);
	if (!path) throw new Error('Program download requires a concrete version.');
	return mirrorPrefix + path;
}

export function openPath(input: string): string {
	const value = input.trim();
	if (/^[a-z]+:/i.test(value) || value.startsWith('//') || /[?#]/.test(value)) {
		throw new Error('Enter a module path without a host, query or fragment.');
	}
	const parsed = parseModulePath(value);
	if (!parsed) throw new Error('Expected owner/module@version/path/name.wasm.');
	return modulePath(parsed);
}

export function queryArgs(search: string): string[] {
	return new URLSearchParams(search).getAll('arg');
}

export function withArgs(url: URL, args: string[]): URL {
	const next = new URL(url);
	next.searchParams.delete('arg');
	for (const arg of args) next.searchParams.append('arg', arg);
	return next;
}

export function parseArgs(json: string): string[] {
	const value: unknown = JSON.parse(json);
	if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
		throw new Error('Arguments must be a JSON array of strings.');
	}
	return value;
}
