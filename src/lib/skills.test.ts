import { expect, it } from 'vitest';
import { mirroredDownload } from './downloads';
import { skillPath, type Skill } from './skills';
const skill = {
	module: 'gaato/kbbi',
	version: '0.1.6',
	name: 'gaato/kbbi/cmd/kbbi',
	yanked: false,
	metadata: { name: 'kbbi', description: 'Indonesian dictionary' },
	wasm_url:
		'https://download.mooncakes.io/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'
} satisfies Skill;
it('maps a skill to its pinned prebuild path', () => {
	expect(skillPath(skill)).toBe('/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm');
	expect(
		skillPath({
			...skill,
			wasm_url: 'https://download.mooncakes.io/prebuild/cli/sh@0.2.1/sh.wasm'
		})
	).toBe('/cli/sh@0.2.1/sh.wasm');
	expect(() => mirroredDownload('https://evil.example/a.zip')).toThrow();
	expect(() =>
		skillPath({
			...skill,
			wasm_url: 'https://download.mooncakes.io/prebuild/a/b@latest/b.wasm'
		})
	).toThrow();
});
