import { describe, expect, it } from 'vitest';
import { modulePath, parseModulePath, wasmUrl } from './paths';

describe('module paths', () => {
	it.each(['/', '/shell', '/gaato/shell', '/shell/help'])(
		'keeps site path %s separate',
		(path) => {
			expect(parseModulePath(path)).toBeNull();
		}
	);
	it('round trips a nested executable', () => {
		const path = parseModulePath('/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm')!;
		expect(path).toEqual({
			owner: 'gaato',
			module: 'kbbi',
			version: '0.1.6',
			packagePath: ['cmd', 'kbbi'],
			filename: 'kbbi.wasm'
		});
		expect(modulePath(path)).toBe('/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm');
		expect(wasmUrl(path)).toBe(
			'/_mooncakes/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'
		);
	});
	it('accepts a root package, latest, missing versions and encoded @', () => {
		expect(parseModulePath('/cli/sh@0.2.1/sh.wasm')?.packagePath).toEqual([]);
		expect(parseModulePath('/cli/sh@latest/sh.wasm')?.version).toBe('latest');
		expect(modulePath(parseModulePath('cli/sh/sh.wasm')!)).toBe(
			'/cli/sh@latest/sh.wasm'
		);
		expect(modulePath(parseModulePath('/cli/sh%400.2.1/sh.wasm')!)).toBe(
			'/cli/sh@0.2.1/sh.wasm'
		);
	});
	it.each([
		'/a/b@/b.wasm',
		'/a/b@@1/b.wasm',
		'/a/b@1',
		'/a/b@1/../b.wasm',
		'/a/b@1/%2f.wasm',
		'/a/b@1/%zz.wasm',
		'/a/b@1/.wasm',
		'/a/b@1//b.wasm',
		'/a/b@1/b.wasm/'
	])('rejects malformed module path %s', (path) => {
		expect(() => parseModulePath(path)).toThrow();
	});
});
