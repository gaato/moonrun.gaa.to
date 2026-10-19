import { expect, it, vi } from 'vitest';
import {
	cliIndexEndpoint,
	cliProgramPath,
	fetchCliIndex,
	filterCliIndex
} from './cli-index';

it('keeps only valid non-yanked versioned CLI coordinates, stripping registry metadata', () => {
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
it('loads the small same-origin index, bypassing the browser HTTP cache', async () => {
	const fetcher = vi.fn<typeof fetch>(async () =>
		Response.json([{ name: 'cli/sh', version: '1.0.0' }])
	);
	expect(await fetchCliIndex(undefined, fetcher)).toEqual([
		{ name: 'cli/sh', version: '1.0.0' }
	]);
	expect(fetcher).toHaveBeenCalledWith(cliIndexEndpoint, {
		signal: undefined,
		cache: 'no-store'
	});
});
it('reports failed or malformed index responses', async () => {
	await expect(
		fetchCliIndex(undefined, async () => new Response('', { status: 503 }))
	).rejects.toThrow('503');
	await expect(
		fetchCliIndex(undefined, async () => Response.json({}))
	).rejects.toThrow('Invalid CLI index');
});
