import { expect, it, vi } from 'vitest';
import {
	bundleIndexPath,
	bundledPath,
	cliProgramPath,
	fetchCommandIndex,
	filterCliIndex,
	parseBundleIndex
} from './cli-index';

it('keeps only valid non-yanked versioned CLI coordinates, stripping other fields', () => {
	expect(
		filterCliIndex([
			{ name: 'cli/sh', version: '1.0.0', description: 'irrelevant' },
			{ name: 'cli/core', version: '0.2.1' },
			{ name: 'other/cmd', version: '1.0.0' },
			{ name: 'cli/old', version: '1.0.0', yanked: true },
			{ name: 'cli/mutable', version: 'latest' },
			{ name: 'cli/nested/path', version: '1.0.0' },
			{ name: 'cli/bad', version: '../1.0.0' },
			{ name: 'cli/missing' },
			{ name: 123 },
			null
		])
	).toEqual([
		{ name: 'cli/core', version: '0.2.1' },
		{ name: 'cli/sh', version: '1.0.0' }
	]);
	expect(cliProgramPath({ name: 'cli/sh', version: '1.0.0' })).toBe(
		'/cli/sh@1.0.0/sh.wasm'
	);
});
const sha256 = 'a'.repeat(64);
it('keeps bundled entries with a digest and size, stripping the source URL', () => {
	expect(
		parseBundleIndex([
			{ name: 'cli/sh', version: '0.2.1', sha256, size: 10, source: 'x' },
			{ name: 'cli/cat', version: '0.2.1', sha256: 'bad', size: 10 },
			{ name: 'cli/ls', version: '0.2.2', sha256, size: 0 },
			{ name: 'cli/mutable', version: 'latest', sha256, size: 1 }
		])
	).toEqual([{ name: 'cli/sh', version: '0.2.1', sha256, size: 10 }]);
	expect(bundledPath({ name: 'cli/sh', version: '0.2.1' })).toBe(
		'/_commands/sh.wasm'
	);
});
it('reads the static bundle index, without a Worker request', async () => {
	const fetcher = vi.fn<typeof fetch>(async () =>
		Response.json([{ name: 'cli/sh', version: '0.2.1', sha256, size: 10 }])
	);
	expect(await fetchCommandIndex(undefined, fetcher)).toEqual([
		{ name: 'cli/sh', version: '0.2.1', sha256, size: 10 }
	]);
	expect(fetcher.mock.calls.map(([url]) => url)).toEqual([bundleIndexPath]);
});
it.each([
	['missing', () => new Response('', { status: 404 })],
	['the SPA fallback', () => new Response('<!doctype html>')],
	['empty', () => Response.json([])]
])('reports a %s bundle clearly', async (_, bundle) => {
	await expect(
		fetchCommandIndex(undefined, async () => bundle())
	).rejects.toThrow('command bundle');
});
