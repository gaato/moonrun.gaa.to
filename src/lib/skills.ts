import { mirroredDownload, mirrorPrefix } from './downloads';
import { unzipSync, strFromU8 } from 'fflate';
import { browserCache, verifiedBytes } from './integrity';
import { parseModulePath, modulePath } from './paths';

export interface Skill {
	module: string;
	author?: string;
	version: string;
	package: string;
	name: string;
	metadata: { name?: string; description?: string };
	wasm_url: string;
	checksum_url: string;
	archive_url: string;
	archive_digest: string;
	repository?: string;
	yanked: boolean;
}

export const skillsEndpoint = 'https://mooncakes.io/api-new/v0/skills';

export function skillPath(skill: Skill): string {
	const url = new URL(
		mirroredDownload(skill.wasm_url).slice(mirrorPrefix.length),
		'https://download.mooncakes.io'
	);
	if (!url.pathname.startsWith('/prebuild/'))
		throw new Error('Unexpected prebuild path.');
	const parsed = parseModulePath(url.pathname.slice('/prebuild'.length));
	if (!parsed) throw new Error('Invalid skill program path.');
	return modulePath(parsed);
}

export async function fetchSkills(signal?: AbortSignal): Promise<Skill[]> {
	const response = await fetch(skillsEndpoint, { signal });
	if (!response.ok)
		throw new Error(`Could not load skills (${response.status}).`);
	const value: unknown = await response.json();
	if (!Array.isArray(value)) throw new Error('Unexpected skills response.');
	return value as Skill[];
}

export function filterSkills(
	skills: Skill[],
	search: string,
	author: string,
	version: string
): Skill[] {
	const query = search.toLowerCase();
	return skills.filter(
		(s) =>
			!s.yanked &&
			`${s.name} ${s.metadata.name ?? ''} ${s.metadata.description ?? ''}`
				.toLowerCase()
				.includes(query) &&
			(s.author ?? s.module.split('/')[0])
				.toLowerCase()
				.includes(author.toLowerCase()) &&
			s.version.toLowerCase().includes(version.toLowerCase())
	);
}

export function extractSkill(bytes: Uint8Array): string {
	// Inflate only SKILL.md; reject ambiguous archives and bound decompression.
	const files = unzipSync(bytes, {
		filter: (entry) => {
			if (entry.name.split('/').at(-1) !== 'SKILL.md') return false;
			if (entry.originalSize > 1024 * 1024)
				throw new Error('SKILL.md exceeds 1 MiB.');
			return true;
		}
	});
	const names = Object.keys(files).filter(
		(name) =>
			!name.startsWith('/') &&
			!name.split('/').some((part) => part === '..' || part === '.')
	);
	if (names.length !== 1)
		throw new Error('Archive must contain exactly one SKILL.md.');
	return strFromU8(files[names[0]]);
}

export async function loadSkill(
	skill: Skill,
	signal?: AbortSignal
): Promise<string> {
	const bytes = await verifiedBytes(
		mirroredDownload(skill.archive_url),
		skill.archive_digest,
		await browserCache(),
		fetch,
		signal
	);
	return extractSkill(bytes);
}
