import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
	MoonxError,
	artifactName,
	artifactUrl,
	createMoonx,
	messageWasm,
	parseCoordinate,
	parseInvocation
} from './moonx';

beforeEach(() => vi.stubGlobal('location', new URL('https://moonrun.test')));
afterEach(() => vi.unstubAllGlobals());

it.each([
	['gaato/kbbi/cmd/kbbi', 'gaato', 'kbbi', 'cmd/kbbi', undefined],
	['gaato/kbbi/cmd/kbbi@0.1.6', 'gaato', 'kbbi', 'cmd/kbbi', '0.1.6'],
	['gaato/kbbi@0.1.6/cmd/kbbi', 'gaato', 'kbbi', 'cmd/kbbi', '0.1.6'],
	['gaato/kbbi/cmd/kbbi@latest', 'gaato', 'kbbi', 'cmd/kbbi', undefined],
	['gaato/kbbi@latest/cmd/kbbi', 'gaato', 'kbbi', 'cmd/kbbi', undefined],
	['Yoorkin/cowsay', 'Yoorkin', 'cowsay', '', undefined],
	['Yoorkin/cowsay@0.1.6', 'Yoorkin', 'cowsay', '', '0.1.6'],
	[
		'moonbitlang/parser/cmd/moonfmt@0.3.3',
		'moonbitlang',
		'parser',
		'cmd/moonfmt',
		'0.3.3'
	],
	['a/b/v2@2.1.0/tool', 'a', 'b/v2', 'tool', '2.1.0'],
	['a/b/v2/tool@2.1.0', 'a', 'b/v2', 'tool', '2.1.0'],
	['a/b/v2/tool', 'a', 'b/v2', 'tool', undefined],
	['a/b/v2', 'a', 'b/v2', '', undefined],
	// v0, v1 and v02 are ordinary package components.
	['a/b/v1/tool', 'a', 'b', 'v1/tool', undefined],
	['a/b/v02', 'a', 'b', 'v02', undefined],
	['a/b@2.0.0/v2/tool', 'a', 'b', 'v2/tool', '2.0.0'],
	['a/b/c@1.0.0-rc.1+build.5', 'a', 'b', 'c', '1.0.0-rc.1+build.5']
])('parses %s like moon', (input, owner, module, pkg, version) => {
	expect(parseCoordinate(input)).toEqual({
		owner,
		module,
		package: pkg,
		...(version ? { version } : {})
	});
});
it.each([
	['gaato/kbbi/...', 'wildcard package paths are not supported', []],
	[
		'gaato',
		'Invalid package coordinate `gaato`',
		['must be in format `user/module/package`']
	],
	[
		'gaato/kbbi@1@2',
		'Invalid package coordinate `gaato/kbbi@1@2`',
		['must contain a single version marker']
	],
	[
		'gaato/kbbi@',
		'Invalid package coordinate `gaato/kbbi@`',
		['version must not be empty or contain path separators']
	],
	[
		'gaato//kbbi',
		'Invalid package coordinate `gaato//kbbi`',
		['path contains an invalid component']
	],
	[
		'gaato/../kbbi',
		'Invalid package coordinate `gaato/../kbbi`',
		['path contains an invalid component']
	],
	[
		'gaato/kb bi',
		'Invalid package coordinate `gaato/kb bi`',
		['path contains an invalid component']
	],
	[
		'gaato/kbbi%2fx',
		'Invalid package coordinate `gaato/kbbi%2fx`',
		['path contains an invalid component']
	],
	[
		'gaato/kbbi/cmd@0.1.6/x',
		'Invalid package coordinate `gaato/kbbi/cmd@0.1.6/x`',
		['module name must be in format `user/module[/vN]`']
	],
	[
		'gaato/kbbi@bad/cmd/kbbi',
		'Invalid version in package coordinate `gaato/kbbi@bad/cmd/kbbi`',
		['invalid semantic version `bad`']
	],
	[
		'gaato/kbbi/cmd@1.0',
		'Invalid version in package coordinate `gaato/kbbi/cmd@1.0`',
		['invalid semantic version `1.0`']
	],
	[
		'a/b/v2@1.5.0',
		'Invalid package coordinate `a/b/v2@1.5.0`',
		['module `a/b/v2` requires major version 2, but got 1.5.0']
	],
	[
		'a/b/v2/tool@1.5.0',
		'Invalid package coordinate `a/b/v2/tool@1.5.0`',
		['module `a/b/v2` requires major version 2, but got 1.5.0']
	]
])('rejects %s', (input, message, causes) => {
	try {
		parseCoordinate(input);
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(MoonxError);
		expect((error as MoonxError).message).toContain(message);
		expect((error as MoonxError).causes).toEqual(causes);
	}
});
it('names artifacts and URLs like wasm_asset, through the mirror', () => {
	for (const [input, url] of [
		[
			'moonbitlang/parser/cmd/moonfmt',
			'/_mooncakes/prebuild/moonbitlang/parser@0.3.3/cmd/moonfmt/moonfmt.wasm'
		],
		[
			'moonbitlang/parser',
			'/_mooncakes/prebuild/moonbitlang/parser@0.3.3/parser.wasm'
		],
		['a/b/v2', '/_mooncakes/prebuild/a/b/v2@0.3.3/v2.wasm'],
		['a/b/v2/tool', '/_mooncakes/prebuild/a/b/v2@0.3.3/tool/tool.wasm'],
		['a/b@2.0.0/v2/tool', '/_mooncakes/prebuild/a/b@0.3.3/v2/tool/tool.wasm']
	])
		expect(artifactUrl(parseCoordinate(input), '0.3.3')).toBe(url);
	expect(artifactName(parseCoordinate('gaato/kbbi/cmd/kbbi'))).toBe(
		'kbbi.wasm'
	);
});
it.each([
	[
		['gaato/kbbi/cmd/kbbi', 'rumah'],
		{ input: 'gaato/kbbi/cmd/kbbi', args: ['rumah'], verbose: false }
	],
	[
		['gaato/kbbi/cmd/kbbi', '--', '--help'],
		{ input: 'gaato/kbbi/cmd/kbbi', args: ['--help'], verbose: false }
	],
	[
		['gaato/kbbi/cmd/kbbi', '--help', '--', 'x'],
		{
			input: 'gaato/kbbi/cmd/kbbi',
			args: ['--help', '--', 'x'],
			verbose: false
		}
	],
	[
		['-v', '--target', 'wasm', 'a/b', '-v'],
		{ input: 'a/b', args: ['-v'], verbose: true }
	],
	[
		['--verbose', '--target=wasm', '--', 'a/b'],
		{ input: 'a/b', args: [], verbose: true }
	]
])('parses invocation %j like moonx', (args, expected) => {
	expect(parseInvocation(args)).toEqual({ kind: 'run', ...expected });
});
it.each([
	[[], 2, true, 'Usage: moonx'],
	[['--help'], 0, false, 'Usage: moonx'],
	[['-V'], 0, false, 'moonx'],
	[
		['--experimental-policy', 'p', 'a/b'],
		2,
		true,
		'moonx: --experimental-policy is not supported in the browser'
	],
	[['--target', 'native', 'a/b'], 2, true, 'not supported in the browser'],
	[['--target'], 2, true, "a value is required for '--target <TARGET>'"],
	[['--target', 'js', 'a/b'], 2, true, "invalid value 'js'"],
	[['-q', 'a/b'], 2, true, "error: unexpected argument '-q' found"]
])('prints for %j', (args, status, stderr, text) => {
	const invocation = parseInvocation(args);
	expect(invocation).toMatchObject({ kind: 'print', status, stderr });
	expect(invocation.kind === 'print' && invocation.text).toContain(text);
});
it('builds a valid WASI message program', () => {
	for (const text of ['', 'Error: x', 'é'.repeat(70_000)])
		expect(WebAssembly.validate(messageWasm(text, 255) as BufferSource)).toBe(
			true
		);
});

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
function registry() {
	const digest = createHash('sha256').update(wasm).digest('hex');
	const routes = new Map<string, () => Response>([
		[
			'https://mooncakes.io/api-new/v0/modules/gaato/kbbi',
			() => Response.json({ latest_version: '0.1.6' })
		],
		[
			'https://mooncakes.io/api-new/v0/modules/a/b/v2',
			() => Response.json({ latest_version: '1.5.0' })
		],
		[
			'/_mooncakes/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm.sha256',
			() => new Response(digest)
		],
		[
			'/_mooncakes/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm',
			() => new Response(new Uint8Array(wasm))
		]
	]);
	const fetcher = vi.fn<typeof fetch>(
		async (input) =>
			routes.get(String(input))?.() ?? new Response('', { status: 404 })
	);
	return { routes, fetcher, moonx: createMoonx({ fetcher }) };
}
function message(command: unknown) {
	expect(command).toMatchObject({ argv0: 'moonx', args: [] });
	const bytes = (command as { wasm: Uint8Array }).wasm;
	return { bytes, text: new TextDecoder().decode(bytes) };
}
const contains = (bytes: Uint8Array, part: number[]) =>
	bytes.some((_, i) => part.every((byte, j) => bytes[i + j] === byte));
it('resolves the latest version once per session and replaces the moonx child', async () => {
	const r = registry();
	for (const args of [
		['gaato/kbbi/cmd/kbbi', 'rumah'],
		['gaato/kbbi@latest/cmd/kbbi', 'rumah']
	])
		expect(await r.moonx(args)).toEqual({
			wasm,
			args: ['rumah'],
			argv0: 'kbbi'
		});
	expect(await r.moonx(['gaato/kbbi/cmd/kbbi@0.1.6'])).toEqual({
		wasm,
		args: [],
		argv0: 'kbbi'
	});
	expect(r.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
		'https://mooncakes.io/api-new/v0/modules/gaato/kbbi',
		'/_mooncakes/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm.sha256',
		'/_mooncakes/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm'
	]);
	expect(r.fetcher.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
});
it.each([
	[['no/such/pkg'], 'Error: Module `no/such` not found in registry'],
	[['gaato/kbbi/nopkg'], 'Error: Prebuilt wasm asset does not exist'],
	[
		['a/b/v2/tool'],
		'Error: module `a/b/v2` requires major version 2, but got 1.5.0'
	],
	[['x.mbtx'], '.mbtx scripts need the MoonBit compiler']
])(
	'turns %j into a moonx error program with status 255',
	async (args, text) => {
		const r = registry();
		const { bytes, text: printed } = message(await r.moonx(args));
		expect(printed).toContain(text);
		expect(contains(bytes, [0x41, 0xff, 0x01, 0x10, 0x01])).toBe(true); // proc_exit(255)
	}
);
it('reports a checksum mismatch and retries transient failures in the same session', async () => {
	const r = registry();
	r.routes.set(
		'/_mooncakes/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm.sha256',
		() => new Response('0'.repeat(64))
	);
	const mismatch = await r.moonx(['gaato/kbbi/cmd/kbbi']);
	expect(message(mismatch).text).toContain('SHA-256 mismatch');
	r.routes.delete(
		'/_mooncakes/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm.sha256'
	);
	r.routes.set(
		'https://mooncakes.io/api-new/v0/modules/gaato/kbbi',
		() => new Response('', { status: 503 })
	);
	const fresh = createMoonx({ fetcher: r.fetcher });
	const failed = await fresh(['gaato/kbbi/cmd/kbbi']);
	expect(message(failed).text).toContain('HTTP 503');
	r.routes.set('https://mooncakes.io/api-new/v0/modules/gaato/kbbi', () =>
		Response.json({ latest_version: '0.1.6' })
	);
	r.routes.set(
		'/_mooncakes/prebuild/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm.sha256',
		() => new Response(createHash('sha256').update(wasm).digest('hex'))
	);
	expect(await fresh(['gaato/kbbi/cmd/kbbi'])).toMatchObject({
		wasm,
		argv0: 'kbbi'
	});
});
