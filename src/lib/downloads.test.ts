import { expect, it } from 'vitest';
import { downloadPath, mirroredDownload } from './downloads';
it('maps public program, checksum and archive URLs to the same-origin mirror', () => {
	for (const path of [
		'/prebuild/cli/sh@0.2.1/sh.wasm',
		'/prebuild/cli/sh@0.2.1/sh.wasm.sha256',
		'/skills/cli/sh@0.2.1/skills.zip'
	]) {
		expect(mirroredDownload('https://download.mooncakes.io' + path)).toBe(
			'/_mooncakes' + path
		);
	}
	expect(downloadPath('/prebuild/cli/sh%400.2.1/sh.wasm')).toBe(
		'/prebuild/cli/sh@0.2.1/sh.wasm'
	);
});
it.each([
	'https://evil.example/prebuild/a/b@1.0.0/b.wasm',
	'https://user:secret@download.mooncakes.io/prebuild/a/b@1.0.0/b.wasm',
	'https://download.mooncakes.io/prebuild/a/b@latest/b.wasm',
	'https://download.mooncakes.io/prebuild/a/b@1.0.0/../b@1.0.0/b.wasm',
	'https://download.mooncakes.io/prebuild/a/b@1.0.0/b.wasm?token=private',
	'https://download.mooncakes.io/skills/a/b@1.0.0/skills.zip#fragment'
])('rejects unsafe registry URL %s', (url) => {
	expect(() => mirroredDownload(url)).toThrow();
});
