import { describe, expect, it } from 'vitest';
import {
	modulePath,
	openPath,
	parseModulePath,
	queryArgs,
	withArgs,
	parseArgs,
	wasmUrl
} from './paths';

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
			'https://download.mooncakes.io/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'
		);
	});
	it('accepts a root package, latest, missing versions and encoded @', () => {
		expect(parseModulePath('/cli/sh@0.2.1/sh.wasm')?.packagePath).toEqual([]);
		expect(parseModulePath('/cli/sh@latest/sh.wasm')?.version).toBe('latest');
		expect(openPath(' cli/sh/sh.wasm ')).toBe('/cli/sh@latest/sh.wasm');
		expect(openPath('/cli/sh%400.2.1/sh.wasm')).toBe('/cli/sh@0.2.1/sh.wasm');
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
	it.each([
		'https://example.com/a/b@1/b.wasm',
		'//a/b@1/b.wasm',
		'a/b@1/b.wasm?arg=x',
		'shell'
	])('rejects non-path form input %s', (path) => {
		expect(() => openPath(path)).toThrow();
	});
});
it('preserves repeated query arguments including empty and Unicode values', () => {
	const args = ['', 'a b', '+', '日本語', 'a', 'a', '\n'];
	const next = withArgs(
		new URL('https://example.com/a/b@1/b.wasm?x=1&arg=old#note'),
		args
	);
	expect(queryArgs(next.search)).toEqual(args);
	expect(next.searchParams.get('x')).toBe('1');
	expect(next.hash).toBe('#note');
	expect(parseArgs(JSON.stringify(args))).toEqual(args);
	expect(queryArgs('?arg=a&ignore=b&arg=b')).toEqual(['a', 'b']);
	expect(queryArgs('')).toEqual([]);
});
it.each(['"hello"', '[1]', '{}', 'null', 'broken'])(
	'rejects invalid argument JSON %s',
	(value) => {
		expect(() => parseArgs(value)).toThrow();
	}
);
