import type { MooncakesMount } from './mooncakes-mount';
import type { Skill } from '../skills';
import { skillPath } from '../skills';
import {
	modulePath,
	parseModulePath,
	wasmUrl,
	type ModulePath
} from '../paths';
import { browserCache, verifiedWasm } from '../integrity';
import { ModuleNotFoundError, pinVersion } from '../modules';
import type { CliModule } from '../cli-index';
import { preloadCommands, type PreloadOptions } from './preload';
export interface SkillCommand {
	name: string;
	aliases: string[];
	path: string;
}
export function skillCommands(skills: readonly Skill[]): SkillCommand[] {
	const entries: SkillCommand[] = [];
	for (const skill of skills) {
		if (skill.yanked) continue;
		try {
			const path = skillPath(skill);
			const name = parseModulePath(path)!.filename.slice(0, -'.wasm'.length);
			const alias = skill.metadata.name;
			const aliases =
				alias && alias !== name && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(alias)
					? [alias]
					: [];
			entries.push({ name, aliases, path });
		} catch {
			/* Ignore invalid registry coordinates. */
		}
	}
	// Code-unit order is stable across locales and independent of API ordering.
	return entries.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0
	);
}
export interface ResolverOptions {
	mount?: MooncakesMount;
	index?: readonly CliModule[];
	fetcher?: typeof fetch;
	signal?: AbortSignal;
	onResolved?: (name: string, path: string) => void;
}

// One resolver belongs to one shell session, including concurrent/negative lookups.
export function createResolver(
	skills: readonly Skill[],
	{
		index = [],
		fetcher = fetch,
		signal,
		onResolved,
		mount
	}: ResolverOptions = {}
) {
	const entries = skillCommands(skills);
	const memo = new Map<string, Promise<Uint8Array | undefined>>();
	const versions = new Map(index.map((entry) => [entry.name, entry.version]));
	const programs = new Map<string, Promise<Uint8Array | undefined>>();
	function load(path: string): Promise<Uint8Array | undefined> {
		let pending = programs.get(path);
		if (!pending) {
			pending = (async () =>
				verifiedWasm(
					wasmUrl(parseModulePath(path)!),
					await browserCache(),
					fetcher,
					signal
				))();
			programs.set(path, pending);
			// Keep checksum 404s as not-a-command for the session. Other failures retry.
			void pending.catch(() => {
				programs.delete(path);
			});
		}
		return pending;
	}
	async function program(coordinate: ModulePath) {
		let pinned: ModulePath;
		try {
			const indexed = versions.get(`${coordinate.owner}/${coordinate.module}`);
			pinned =
				coordinate.version === 'latest' && indexed
					? { ...coordinate, version: indexed }
					: await pinVersion(coordinate, signal, fetcher);
		} catch (error) {
			if (error instanceof ModuleNotFoundError) return undefined;
			throw error;
		}
		const path = modulePath(pinned);
		const bytes = await load(path);
		return bytes ? { bytes, path } : undefined;
	}

	async function resolve(
		name: string,
		cwd: string
	): Promise<Uint8Array | undefined> {
		const candidates: ModulePath[] = [];
		if (name.includes('/')) {
			const parts: string[] = [];
			for (const part of (name.startsWith('/') ? name : cwd + '/' + name).split(
				'/'
			)) {
				if (part === '..') parts.pop();
				else if (part && part !== '.') parts.push(part);
			}
			const absolute = '/' + parts.join('/');
			if (absolute.startsWith('/mooncakes/')) {
				if (!absolute.endsWith('.wasm')) return undefined;
				const result = await mount?.readProgram(
					absolute.slice('/mooncakes'.length)
				);
				if (result) onResolved?.(name, result.path);
				return result?.bytes;
			}

			try {
				const coordinate = parseModulePath(name);
				if (!coordinate) return undefined;
				// Validate explicit versions before making any requests.
				if (coordinate.version !== 'latest') wasmUrl(coordinate);
				candidates.push(coordinate);
			} catch {
				return undefined;
			}
		} else {
			if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) || name.includes('..'))
				return undefined;
			candidates.push(parseModulePath(`/cli/${name}@latest/${name}.wasm`)!);
			for (const entry of entries) {
				if (entry.name === name || entry.aliases.includes(name))
					candidates.push(parseModulePath(entry.path)!);
			}
		}
		for (const candidate of candidates) {
			const result = await program(candidate);
			if (result) {
				onResolved?.(name, result.path);
				return result.bytes;
			}
		}
		return undefined;
	}
	const resolveName = (
		name: string,
		cwd = '/work'
	): Promise<Uint8Array | undefined> => {
		const key = name.includes('/') ? cwd + '\0' + name : name;
		let pending = memo.get(key);
		if (!pending) {
			pending = resolve(name, cwd);
			memo.set(key, pending);
		}
		return pending;
	};
	return Object.assign(resolveName, {
		preload: (options: Omit<PreloadOptions, 'signal'> = {}) =>
			preloadCommands(index, load, { ...options, signal })
	});
}
