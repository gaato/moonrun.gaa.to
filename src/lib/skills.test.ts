import { expect, it } from 'vitest';
import { mirroredDownload } from './downloads';
import { zipSync, strToU8 } from 'fflate';
import { extractSkill, filterSkills, skillPath, type Skill } from './skills';
const zip = (files: Record<string, string>) =>
	zipSync(
		Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))
	);
it('extracts exactly one root or nested SKILL.md, ignoring other files', () => {
	expect(
		extractSkill(zip({ 'SKILL.md': '# Hello', 'extra.txt': 'ignore' }))
	).toBe('# Hello');
	expect(extractSkill(zip({ 'kbbi/SKILL.md': '日本語' }))).toBe('日本語');
	expect(() => extractSkill(zip({ 'README.md': 'no' }))).toThrow('exactly one');
	expect(() =>
		extractSkill(zip({ 'a/SKILL.md': 'a', 'b/SKILL.md': 'b' }))
	).toThrow('exactly one');
	expect(() => extractSkill(zip({ '../SKILL.md': 'bad' }))).toThrow();
	expect(() =>
		extractSkill(zip({ 'SKILL.md': 'x'.repeat(1024 * 1024 + 1) }))
	).toThrow('1 MiB');
	expect(() => extractSkill(new Uint8Array([1, 2, 3]))).toThrow();
});
const skill = {
	module: 'gaato/kbbi',
	version: '0.1.6',
	name: 'gaato/kbbi/cmd/kbbi',
	package: 'cmd/kbbi',
	yanked: false,
	metadata: { name: 'kbbi', description: 'Indonesian dictionary' },
	wasm_url:
		'https://download.mooncakes.io/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'
} as Skill;
it('filters name, description, author and version and excludes yanked skills', () => {
	const values = [skill, { ...skill, yanked: true }];
	expect(filterSkills(values, 'DICTIONARY', 'Gaa', '0.1')).toEqual([skill]);
	expect(filterSkills(values, 'kbbi', '', '')).toEqual([skill]);
	expect(filterSkills(values, '', 'other', '')).toEqual([]);
	expect(filterSkills(values, '', '', '2')).toEqual([]);
	expect(skillPath(skill)).toBe('/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm');
	expect(
		skillPath({
			...skill,
			wasm_url: 'https://download.mooncakes.io/prebuild/cli/sh@0.2.1/sh.wasm'
		})
	).toBe('/cli/sh@0.2.1/sh.wasm');
	expect(() => mirroredDownload('https://evil.example/a.zip')).toThrow();
});
