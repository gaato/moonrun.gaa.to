import { mirroredDownload, mirrorPrefix } from './downloads';
import { parseModulePath, modulePath } from './paths';

export interface Skill {
	module: string;
	version: string;
	name: string;
	metadata: { name?: string; description?: string };
	wasm_url: string;
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
