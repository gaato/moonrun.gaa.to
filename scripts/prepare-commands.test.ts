import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	cliModules,
	modulesEndpoint,
	prepareCommands,
	userAgent
} from './prepare-commands';

const wasm = (byte: number) => new Uint8Array([0, 97, 115, 109, byte]);
const hex = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');
const prebuild = 'https://download.mooncakes.io/prebuild';
let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commands-'));
});
afterEach(() => rm(directory, { recursive: true, force: true }));
function registry(files: Record<string, Uint8Array>) {
	const routes = new Map<string, () => Response>([
		[
			modulesEndpoint,
			() =>
				Response.json([
					{ name: 'cli/sh', version: '0.2.1' },
					{ name: 'cli/cat', version: '0.2.1' },
					{ name: 'cli/core', version: '0.6.0' },
					{ name: 'cli/old', version: '1.0.0', yanked: true },
					{ name: 'gaato/kbbi', version: '0.1.6' },
					{ name: 'cli/bad', version: 'latest' }
				])
		]
	]);
	for (const [path, bytes] of Object.entries(files)) {
		routes.set(prebuild + path, () => new Response(new Uint8Array(bytes)));
		routes.set(
			prebuild + path + '.sha256',
			() => new Response(`${hex(bytes)}  ${path.split('/').at(-1)}\n`)
		);
	}
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		return routes.get(String(input))?.() ?? new Response('', { status: 404 });
	});
	return { routes, fetcher };
}
const files = {
	'/cli/sh@0.2.1/sh.wasm': wasm(1),
	'/cli/cat@0.2.1/cat.wasm': wasm(2)
};

it('keeps non-yanked, concretely versioned cli/* modules only', () => {
	expect(
		cliModules([
			{ name: 'cli/sh', version: '0.2.1' },
			{ name: 'cli/sh', version: '0.1.0' },
			{ name: 'cli/old', version: '1.0.0', yanked: true },
			{ name: 'cli/x/y', version: '1.0.0' },
			{ name: 'other/sh', version: '1.0.0' },
			{ name: 'cli/bad', version: '^1.0.0' }
		])
	).toEqual([{ name: 'cli/sh', version: '0.2.1' }]);
	expect(() => cliModules({})).toThrow();
});
it('downloads verified executables, skips libraries and writes the index', async () => {
	const r = registry(files);
	const index = await prepareCommands({ directory, fetcher: r.fetcher });
	expect(index).toEqual([
		{
			name: 'cli/cat',
			version: '0.2.1',
			sha256: hex(files['/cli/cat@0.2.1/cat.wasm']),
			size: 5,
			source: prebuild + '/cli/cat@0.2.1/cat.wasm'
		},
		{
			name: 'cli/sh',
			version: '0.2.1',
			sha256: hex(files['/cli/sh@0.2.1/sh.wasm']),
			size: 5,
			source: prebuild + '/cli/sh@0.2.1/sh.wasm'
		}
	]);
	expect(
		JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
	).toEqual(index);
	expect((await readdir(directory)).sort()).toEqual([
		'cat.wasm',
		'index.json',
		'sh.wasm'
	]);
	expect(new Uint8Array(await readFile(join(directory, 'sh.wasm')))).toEqual(
		wasm(1)
	);
	for (const [, init] of r.fetcher.mock.calls)
		expect(new Headers(init?.headers).get('User-Agent')).toBe(userAgent);
	expect(
		r.fetcher.mock.calls.some(([url]) => String(url).includes('/cli/old@'))
	).toBe(false);
});
it('reuses verified files, replaces corrupt ones and removes stale commands', async () => {
	await writeFile(join(directory, 'sh.wasm'), wasm(1));
	await writeFile(join(directory, 'cat.wasm'), wasm(9));
	await writeFile(join(directory, 'gone.wasm'), wasm(3));
	const r = registry(files);
	await prepareCommands({ directory, fetcher: r.fetcher });
	const downloads = r.fetcher.mock.calls
		.map(([url]) => String(url))
		.filter((url) => url.endsWith('.wasm'));
	expect(downloads).toEqual([prebuild + '/cli/cat@0.2.1/cat.wasm']);
	expect(new Uint8Array(await readFile(join(directory, 'cat.wasm')))).toEqual(
		wasm(2)
	);
	expect(await readdir(directory)).not.toContain('gone.wasm');
});
it.each([
	['a checksum mismatch', 'SHA-256 mismatch'],
	['a server error', 'HTTP 503'],
	['a non-wasm file', 'not a wasm']
])('fails the build on %s', async (problem, message) => {
	const r = registry(files);
	const url = prebuild + '/cli/cat@0.2.1/cat.wasm';
	if (problem === 'a checksum mismatch')
		r.routes.set(url + '.sha256', () => new Response('0'.repeat(64)));
	else if (problem === 'a server error')
		r.routes.set(url, () => new Response('', { status: 503 }));
	else {
		const text = new TextEncoder().encode('<html>');
		r.routes.set(url, () => new Response(text));
		r.routes.set(url + '.sha256', () => new Response(hex(text)));
	}
	await expect(
		prepareCommands({ directory, fetcher: r.fetcher })
	).rejects.toThrow(message);
	await expect(readFile(join(directory, 'index.json'))).rejects.toThrow();
});
