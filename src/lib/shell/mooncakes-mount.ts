import type {
	MountEntry,
	MountFile,
	MountProvider,
	MountStat
} from 'moonrun-js/browser';
import { strFromU8, unzipSync } from 'fflate';
import { downloadPath, mirrorPrefix } from '../downloads';
import {
	browserCache,
	digestHex,
	verifiedWasm,
	type VerifiedCache
} from '../integrity';
import { parseModulePath, wasmUrl, type ModulePath } from '../paths';
import { modulesEndpoint } from '../cli-index';

type ErrorCode = 'ENOENT' | 'EIO' | 'ENOTDIR' | 'EISDIR' | 'EINVAL' | 'EROFS';
export type MountResult<T> =
	{ ok: true; value: T } | { ok: false; error: { code: ErrorCode } };
class FsError extends Error {
	constructor(readonly code: ErrorCode) {
		super(code);
	}
}
const ok = <T>(value: T): MountResult<T> => ({ ok: true, value });
const fail = (code: ErrorCode): MountResult<never> => ({
	ok: false,
	error: { code }
});
async function result<T>(work: () => Promise<T>): Promise<MountResult<T>> {
	try {
		return ok(await work());
	} catch (error) {
		return fail(error instanceof FsError ? error.code : 'EIO');
	}
}
const component = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
function split(path: string): string[] {
	if (path === '/') return [];
	const parts = path.slice(1).split('/');
	if (
		!path.startsWith('/') ||
		parts.some((p) => !p || p === '.' || p === '..' || /[\\\0]/.test(p))
	)
		throw new FsError('EINVAL');
	return parts;
}

// Recognize executable declarations, ignoring comments and preserving quoted strings.
export function executablePackage(source: string, json = false): boolean {
	if (json) {
		try {
			return JSON.parse(source)['is-main'] === true;
		} catch {
			return false;
		}
	}
	const clean = source.replace(
		/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
		(token) => (token.startsWith('//') || token.startsWith('/*') ? ' ' : token)
	);
	return (
		/\bpkgtype\s*\(\s*kind\s*:\s*"executable"\s*,?\s*\)/.test(clean) ||
		/\boptions\s*\([^)]*"is-main"\s*:\s*true\b/.test(clean)
	);
}

type Node =
	| { kind: 'dir' }
	| { kind: 'file'; bytes: Uint8Array }
	| { kind: 'wasm'; coordinate: ModulePath; bytes?: Promise<Uint8Array> };
type Catalog = Map<string, Map<string, string>>;
interface Coordinate {
	owner: string;
	module: string;
	version: string;
	tail: string[];
}
export interface MooncakesMountOptions {
	fetcher?: typeof fetch;
	signal?: AbortSignal;
	cache?: VerifiedCache;
}
export function createMooncakesMount({
	fetcher = fetch,
	signal,
	cache
}: MooncakesMountOptions = {}) {
	let catalogPromise: Promise<Catalog> | undefined;
	const archives = new Map<string, Promise<Map<string, Node>>>();
	let active = 0;
	const queued: (() => void)[] = [];
	async function limited<T>(work: () => Promise<T>): Promise<T> {
		if (active >= 4) await new Promise<void>((resolve) => queued.push(resolve));
		else active++;
		try {
			signal?.throwIfAborted();
			return await work();
		} finally {
			const next = queued.shift();
			if (next) next();
			else active--;
		}
	}
	async function json(url: string) {
		const response = await fetcher(url, { signal, cache: 'no-store' });
		if (!response.ok)
			throw new FsError(response.status === 404 ? 'ENOENT' : 'EIO');
		return response.json() as Promise<unknown>;
	}
	function catalog() {
		return (catalogPromise ??= (async () => {
			const value = await json(modulesEndpoint);
			if (!Array.isArray(value)) throw new FsError('EIO');
			const owners: Catalog = new Map();
			for (const entry of value) {
				if (
					typeof entry?.name !== 'string' ||
					typeof entry.version !== 'string' ||
					entry.yanked
				)
					continue;
				const [owner, name, ...extra] = entry.name.split('/');
				if (
					extra.length ||
					!downloadPath(`/user/${owner}/${name}/${entry.version}.zip`)
				)
					continue;
				let modules = owners.get(owner);
				if (!modules) owners.set(owner, (modules = new Map()));
				modules.set(name, entry.version);
			}
			return owners;
		})());
	}
	// /<owner>/<module> is the module's latest non-yanked version, decided once per
	// session by the modules list, matching moonx coordinates such as gaato/kbbi/cmd/kbbi.
	async function coordinate(parts: string[]): Promise<Coordinate> {
		const [owner, module, ...tail] = parts;
		if (!owner || !module) throw new FsError('EINVAL');
		const version = (await catalog()).get(owner)?.get(module);
		if (!version || !component.test(module)) throw new FsError('ENOENT');
		return { owner, module, version, tail };
	}
	function archive(c: Coordinate) {
		const key = `${c.owner}/${c.module}@${c.version}`;
		let pending = archives.get(key);
		if (!pending) {
			pending = limited(async () => {
				const path = downloadPath(
					`/user/${c.owner}/${c.module}/${c.version}.zip`
				)!;
				const response = await fetcher(mirrorPrefix + path, { signal });
				if (!response.ok)
					throw new FsError(response.status === 404 ? 'ENOENT' : 'EIO');
				let total = 0;
				let count = 0;
				const files = unzipSync(new Uint8Array(await response.arrayBuffer()), {
					filter: (entry) => {
						total += entry.originalSize;
						if (total > 64 * 1024 * 1024 || ++count > 20000)
							throw new FsError('EIO');
						return true;
					}
				});
				const nodes = new Map<string, Node>([['', { kind: 'dir' }]]);
				for (const [name, bytes] of Object.entries(files)) {
					const path = name.endsWith('/') ? name.slice(0, -1) : name;
					const parts = split('/' + path);
					for (let i = 1; i < parts.length; i++) {
						const parent = parts.slice(0, i).join('/');
						if (nodes.get(parent)?.kind === 'file') throw new FsError('EIO');
						nodes.set(parent, { kind: 'dir' });
					}
					if (nodes.get(path)?.kind === 'dir' && !name.endsWith('/'))
						throw new FsError('EIO');
					nodes.set(
						path,
						name.endsWith('/') ? { kind: 'dir' } : { kind: 'file', bytes }
					);
				}
				for (const [path, node] of [...nodes]) {
					const filename = path.split('/').at(-1);
					if (
						node.kind !== 'file' ||
						(filename !== 'moon.pkg' && filename !== 'moon.pkg.json') ||
						!executablePackage(
							strFromU8(node.bytes),
							filename.endsWith('.json')
						)
					)
						continue;
					const packagePath = path.split('/').slice(0, -1);
					const stem = packagePath.at(-1) ?? c.module;
					let executable: ModulePath;
					try {
						executable = parseModulePath(
							`/${key}/${[...packagePath, stem + '.wasm'].join('/')}`
						)!;
						wasmUrl(executable);
					} catch {
						continue;
					}
					const checksum = await fetcher(wasmUrl(executable) + '.sha256', {
						signal,
						cache: 'no-store'
					});
					if (checksum.status === 404) continue;
					if (!checksum.ok) throw new FsError('EIO');
					digestHex(await checksum.text());
					nodes.set([...packagePath, stem + '.wasm'].join('/'), {
						kind: 'wasm',
						coordinate: executable
					});
				}
				return nodes;
			});
			archives.set(key, pending);
		}
		return pending;
	}
	async function nodeBytes(
		node: Exclude<Node, { kind: 'dir' }>
	): Promise<Uint8Array> {
		if (node.kind === 'file') return node.bytes;
		return (node.bytes ??= (async () => {
			const bytes = await verifiedWasm(
				wasmUrl(node.coordinate),
				cache ?? (await browserCache()),
				fetcher,
				signal
			);
			if (!bytes) throw new FsError('ENOENT');
			return bytes;
		})());
	}
	async function lookup(c: Coordinate) {
		const nodes = await archive(c);
		for (let i = 1; i < c.tail.length; i++) {
			const parent = nodes.get(c.tail.slice(0, i).join('/'));
			if (parent && parent.kind !== 'dir') throw new FsError('ENOTDIR');
		}
		const node = nodes.get(c.tail.join('/'));
		if (!node) throw new FsError('ENOENT');
		return node;
	}
	const provider: MountProvider = {
		cache: true,
		stat: (path) =>
			result<MountStat>(async () => {
				const parts = split(path);
				if (!parts.length) return { kind: 'dir', mode: 0o555 };
				if (parts.length === 1) {
					if (!(await catalog()).has(parts[0])) throw new FsError('ENOENT');
					return { kind: 'dir', mode: 0o555 };
				}
				const c = await coordinate(parts);
				if (!c.tail.length) return { kind: 'dir', mode: 0o555 };
				const node = await lookup(c);
				return node.kind === 'dir'
					? { kind: 'dir', mode: 0o555 }
					: { kind: 'file', size: (await nodeBytes(node)).length, mode: 0o444 };
			}),
		readdir: (path) =>
			result<readonly MountEntry[]>(async () => {
				const parts = split(path);
				if (!parts.length)
					return [...(await catalog()).keys()]
						.sort()
						.map((name) => ({ name, kind: 'dir' }));
				if (parts.length === 1) {
					const modules = (await catalog()).get(parts[0]);
					if (!modules) throw new FsError('ENOENT');
					return [...modules.keys()]
						.sort()
						.map((name) => ({ name, kind: 'dir' as const }));
				}
				const c = await coordinate(parts);
				const nodes = await archive(c);
				const key = c.tail.join('/');
				const parent = nodes.get(key);
				if (!parent) throw new FsError('ENOENT');
				if (parent.kind !== 'dir') throw new FsError('ENOTDIR');
				const prefix = key ? key + '/' : '';
				return [...nodes]
					.filter(
						([name]) =>
							name.startsWith(prefix) &&
							name !== key &&
							!name.slice(prefix.length).includes('/')
					)
					.map(([name, node]) => ({
						name: name.slice(prefix.length),
						kind: node.kind === 'dir' ? ('dir' as const) : ('file' as const)
					}))
					.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			}),
		open: (path) =>
			result<MountFile>(async () => {
				const parts = split(path);
				if (parts.length < 3) {
					const meta = await provider.stat(path);
					if (!meta.ok)
						throw new FsError(meta.error.code === 'ENOENT' ? 'ENOENT' : 'EIO');
					throw new FsError('EISDIR');
				}
				const node = await lookup(await coordinate(parts));
				if (node.kind === 'dir') throw new FsError('EISDIR');
				const bytes = await nodeBytes(node);
				return {
					size: bytes.length,
					read: async (offset, length) => {
						if (
							!Number.isSafeInteger(offset) ||
							offset < 0 ||
							!Number.isSafeInteger(length) ||
							length < 0
						)
							return fail('EINVAL');
						return ok(bytes.slice(offset, offset + length));
					}
				};
			}),
		create: async () => fail('EROFS'),
		write: async () => fail('EROFS'),
		truncate: async () => fail('EROFS'),
		mkdir: async () => fail('EROFS'),
		remove: async () => fail('EROFS'),
		rename: async () => fail('EROFS')
	};
	return provider;
}
