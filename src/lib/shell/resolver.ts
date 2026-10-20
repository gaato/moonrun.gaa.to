import type { Skill } from '../skills';
import { skillPath } from '../skills';
import { parseModulePath, wasmUrl } from '../paths';
import { browserCache, verifiedWasm } from '../integrity';
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
	fetcher?: typeof fetch;
	signal?: AbortSignal;
	onResolved?: (name: string, path: string) => void;
}

// The fallback after moonrun-js's filesystem PATH search (/work/bin, then /bin)
// misses: published skills by name or alias. One resolver belongs to one session,
// including concurrent and negative lookups.
export function createResolver(
	skills: readonly Skill[],
	{ fetcher = fetch, signal, onResolved }: ResolverOptions = {}
) {
	const entries = skillCommands(skills);
	const memo = new Map<string, Promise<Uint8Array | undefined>>();
	async function resolve(name: string): Promise<Uint8Array | undefined> {
		for (const entry of entries) {
			if (entry.name !== name && !entry.aliases.includes(name)) continue;
			const bytes = await verifiedWasm(
				wasmUrl(parseModulePath(entry.path)!),
				await browserCache(),
				fetcher,
				signal
			);
			if (bytes) {
				onResolved?.(name, entry.path);
				return bytes;
			}
		}
		return undefined;
	}
	return (name: string): Promise<Uint8Array | undefined> => {
		if (name.includes('/')) return Promise.resolve(undefined);
		let pending = memo.get(name);
		if (!pending) {
			pending = resolve(name);
			memo.set(name, pending);
		}
		return pending;
	};
}
