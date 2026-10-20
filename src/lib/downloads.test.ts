import { expect, it } from 'vitest';
import { downloadPath } from './downloads';
it.each([
	['/prebuild/cli/sh@0.2.1/sh.wasm', '/prebuild/cli/sh@0.2.1/sh.wasm'],
	[
		'/prebuild/cli/sh@0.2.1/sh.wasm.sha256',
		'/prebuild/cli/sh@0.2.1/sh.wasm.sha256'
	],
	['/prebuild/cli/sh%400.2.1/sh.wasm', '/prebuild/cli/sh@0.2.1/sh.wasm'],
	[
		'/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm',
		'/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'
	],
	['/prebuild/a/b/v2@2.0.0/v2.wasm', '/prebuild/a/b/v2@2.0.0/v2.wasm'],
	[
		'/prebuild/a/b/v2@2.0.0/tool/tool.wasm',
		'/prebuild/a/b/v2@2.0.0/tool/tool.wasm'
	]
])('accepts prebuild path %s', (path, canonical) => {
	expect(downloadPath(path)).toBe(canonical);
});
it.each([
	'/user/gaato/kbbi/0.1.6.zip',
	'/skills/cli/sh@0.2.1/skills.zip',
	'/prebuild/a/b@latest/b.wasm',
	'/prebuild/a/b/b.wasm',
	'/prebuild/a/b/v1@1.0.0/v1.wasm',
	'/prebuild/a/b/v02@2.0.0/v02.wasm',
	'/prebuild/a/b@1.0.0/../b@1.0.0/b.wasm',
	'/prebuild/a/b@1.0.0/b.wasm?token=private',
	'/prebuild/a/b@1.0.0/b.js',
	'/prebuild/a/b@1.0.0/%2fetc.wasm'
])('rejects %s', (path) => expect(downloadPath(path)).toBeNull());
