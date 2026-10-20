import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import type * as Browser from 'moonrun-js/browser';
import type { MountProvider } from 'moonrun-js/browser';
import { verifySha256 } from '../integrity';
import { userAgent } from '../downloads';
import { createMoonx } from './moonx';
import { createHash } from 'node:crypto';
import { mountProxy, mountServer } from './mount-bridge';
import { folderPath, shellFiles, shellPath } from './work';
import { interruptCommand, ShellActivity } from './interrupt';
import { createBinMount } from './bin-mount';
import { folderMount } from './folder-mount';
import { archiveTree } from './work-archive';
import { FakeFolder } from './fixtures/directory-handle';
import { strFromU8, unzipSync } from 'fflate';

const nativeFetch = globalThis.fetch;
const cache = resolve('.cache/shell-fixtures');
let browser: typeof Browser;
// Stable execution fixtures, not the runtime's command/version catalog.
const version = '0.2.1';
const names = ['sh', 'echo', 'tr', 'false', 'cat', 'ls', 'cp', 'mkdir', 'wc'];
const fixtures = new Map<string, Uint8Array>();
const checksums = new Map<string, string>();
beforeAll(async () => {
	await mkdir(cache, { recursive: true });
	for (const name of names) {
		const path = `/cli/${name}@${version}/${name}.wasm`;
		const file = resolve(cache, `${name}@${version}.wasm`);
		const get = async (suffix: string) => {
			try {
				return await readFile(file + suffix);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				const response = await nativeFetch(
					'https://download.mooncakes.io/prebuild' + path + suffix,
					{ headers: { 'User-Agent': userAgent } }
				);
				if (!response.ok)
					throw new Error(`Cannot fetch fixture ${path}: ${response.status}`);
				const bytes = Buffer.from(await response.arrayBuffer());
				await writeFile(file + suffix, bytes);
				return bytes;
			}
		};
		const [bytes, checksum] = await Promise.all([get(''), get('.sha256')]);
		await verifySha256(bytes, checksum.toString());
		fixtures.set(path, new Uint8Array(bytes));
		checksums.set(path, checksum.toString());
	}
	const require = createRequire(import.meta.url);
	const entry = require.resolve('moonrun-js/browser');
	// Load the actual published browser entry without Vite's public-asset rewrite.
	browser = await import(/* @vite-ignore */ pathToFileURL(entry).href);
	const directory = dirname(entry);
	vi.stubGlobal('location', new URL('https://moonrun.test'));
	vi.stubGlobal('fetch', async (input: URL | RequestInfo) => {
		const url =
			input instanceof Request ? new URL(input.url) : new URL(input.toString());
		if (url.protocol !== 'file:' || dirname(fileURLToPath(url)) !== directory)
			throw new Error('Unexpected browser component URL.');
		return new Response(await readFile(url));
	});
}, 60000);
afterAll(() => vi.unstubAllGlobals());
const sh = () => fixtures.get(`/cli/sh@${version}/sh.wasm`)!;
const program = (name: string) =>
	fixtures.get(`/cli/${name}@${version}/${name}.wasm`)!;
// The site's /bin provider, reached through the same page-thread bridge as the app.
function mounts(extra: Record<string, MountProvider> = {}) {
	const bin = createBinMount(
		names.map((name) => ({ name: `cli/${name}`, version })),
		async ({ name }) => program(name.slice(4))
	);
	const server = mountServer({ '/bin': bin, ...extra });
	const bridge = mountProxy((id, mount, request) => {
		void server.call(mount, request).then((value) => bridge.accept(id, value));
	});
	return Object.fromEntries(
		['/bin', ...Object.keys(extra)].map((mount) => [
			mount,
			bridge.provider(mount)
		])
	);
}
const env = { HOME: '/work', PATH: shellPath };
// A fake registry for moonx: one module whose cmd/hello package is really cli/echo.
const registryFetch = vi.fn<typeof fetch>(async (input) => {
	const url = String(input);
	if (url === 'https://mooncakes.io/api-new/v0/modules/test/tool')
		return Response.json({ latest_version: '1.0.0' });
	const hello = '/_mooncakes/prebuild/test/tool@1.0.0/cmd/hello/hello.wasm';
	if (url === hello) return new Response(new Uint8Array(program('echo')));
	if (url === hello + '.sha256')
		return new Response(
			createHash('sha256').update(program('echo')).digest('hex')
		);
	return new Response('', { status: 404 });
});
// One moonx per "session", as in the app (it memoizes versions and bytes).
let session: ReturnType<typeof createMoonx> | undefined;
const moonx = vi.fn((args: readonly string[]) =>
	(session ??= createMoonx({ fetcher: registryFetch }))(args)
);
async function run(
	script: string,
	files: Browser.BrowserFiles = shellFiles,
	extra?: Record<string, MountProvider>,
	// Providers that live next to the run in the supervisor (no bridge).
	local: Record<string, MountProvider> = {}
) {
	let stdout = '';
	let stderr = '';
	const decoder = new TextDecoder();
	const host = await browser.createBrowserHost({
		cwd: '/work',
		files,
		env,
		mounts: { ...mounts(extra), ...local },
		resolveCommand: (name, args) =>
			name === 'moonx' ? moonx(args) : Promise.resolve(undefined),
		stdout: (bytes) => {
			stdout += decoder.decode(bytes);
		},
		stderr: (bytes) => {
			stderr += decoder.decode(bytes);
		}
	});
	const outcome = await host.run(sh(), { name: 'sh', args: ['-c', script] });
	return { stdout, stderr, outcome };
}
it('runs the real sh/echo/tr wasm pipeline from /bin on PATH', async () => {
	const result = await run('echo hello | tr a-z A-Z');
	expect(result.stdout).toBe('HELLO\n');
	expect(result.outcome).toEqual({ kind: 'completed' });
	expect(moonx).not.toHaveBeenCalled();
}, 30000);
it('lists /bin, prefers /work/bin, runs ./prog.wasm and has no /mooncakes', async () => {
	const result = await run(
		'ls /bin; cat hi.txt; ./prog.wasm direct; cat path; ls /',
		{
			...shellFiles,
			'/work/hi.txt': 'from work\n',
			'/work/prog.wasm': program('echo'),
			// /work/bin comes first in PATH, so this "cat" is really echo.
			'/work/bin/cat': program('echo')
		}
	);
	expect(result.outcome, result.stderr).toEqual({ kind: 'completed' });
	expect(result.stdout).toBe(
		names.slice().sort().join('\n') + '\nhi.txt\ndirect\npath\nbin\nwork\n'
	);
}, 30000);
it('runs a registry package through moonx with its own arguments, in a pipeline', async () => {
	const result = await run(
		'moonx test/tool/cmd/hello -- one two; moonx test/tool@1.0.0/cmd/hello a | wc -l; moonx --verbose test/tool/cmd/hello@latest b'
	);
	expect(result.outcome, result.stderr).toEqual({ kind: 'completed' });
	expect(result.stdout.split('\n').map((line) => line.trim())).toEqual([
		'one two',
		'1',
		'b',
		''
	]);
	// The latest version and verified bytes are fetched once for the session.
	expect(
		registryFetch.mock.calls.filter(([url]) => String(url).includes('api-new'))
	).toHaveLength(1);
	expect(
		registryFetch.mock.calls.filter(([url]) => String(url).endsWith('.wasm'))
	).toHaveLength(1);
}, 30000);
it.each([
	['no/such/pkg', 'Error: Module `no/such` not found in registry', 255],
	['test/tool/cmd/missing', 'Error: Prebuilt wasm asset does not exist', 255],
	[
		"'test/tool/...'",
		'Error: Invalid package coordinate `test/tool/...`: wildcard package paths are not supported',
		255
	],
	['script.mbtx', '.mbtx scripts need the MoonBit compiler', 255],
	[
		'--experimental-policy p.json test/tool/cmd/hello',
		'moonx: --experimental-policy is not supported in the browser',
		2
	],
	['--bogus', "error: unexpected argument '--bogus' found", 2]
])(
	'reports moonx %s on stderr with a status',
	async (args, message, status) => {
		const result = await run(`moonx ${args}; echo "status=$?"`);
		expect(result.outcome).toEqual({ kind: 'completed' });
		expect(result.stderr).toContain(message);
		expect(result.stdout).toBe(`status=${status}\n`);
	},
	30000
);
it('preserves command exit status in false; echo $?', async () => {
	expect((await run('false; echo $?')).stdout).toBe('1\n');
}, 30000);
it('returns the normal command-not-found diagnostic and 127', async () => {
	const result = await run('moonrun-command-that-does-not-exist');
	expect(result.outcome).toEqual({ kind: 'exited', code: 127 });
	expect(result.stderr).toContain('No such file or directory');
}, 30000);
it('writes added files into the live /work of a running shell and zips /work', async () => {
	let stdout = '';
	let stderr = '';
	const stdin = new browser.BrowserStdin();
	const host = await browser.createBrowserHost({
		stdin,
		cwd: '/work',
		files: shellFiles,
		env,
		mounts: mounts(),
		stdout: (bytes) => {
			stdout += new TextDecoder().decode(bytes);
		},
		stderr: (bytes) => {
			stderr += new TextDecoder().decode(bytes);
		}
	});
	const running = host.run(sh(), { name: 'sh', args: ['-i'] });
	// As the supervisor does with handle.fs; an existing file is replaced.
	await host.memoryFs.writeFile('/work/sample.json', '{"b":true}\n');
	await host.memoryFs.writeFile("/work/it's a file.txt", 'added\n');
	await host.memoryFs.writeFile('/work/tool.wasm', program('echo'));
	await stdin.write(
		new TextEncoder().encode(
			'cat "it\'s a file.txt" sample.json; ./tool.wasm ran; echo made > made.txt\n'
		)
	);
	const deadline = Date.now() + 5000;
	while (!stdout.includes('ran\n') && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 5));
	const files = unzipSync(await archiveTree(host.memoryFs));
	stdin.end();
	expect(await running, stderr).toEqual({ kind: 'completed' });
	expect(stdout).toBe('added\n{"b":true}\nran\n');
	expect(Object.keys(files).sort()).toEqual([
		'work/README.txt',
		'work/bin/',
		"work/it's a file.txt",
		'work/made.txt',
		'work/sample.json',
		'work/tool.wasm'
	]);
	expect(strFromU8(files['work/made.txt'])).toBe('made\n');
	await expect(
		host.memoryFs.writeFile('/work/late', 'x')
	).rejects.toMatchObject({
		code: 'EBADF'
	});
}, 30000);
it('copies between an opened folder at /mnt/local and /work with real cp', async () => {
	const picked = new FakeFolder('picked');
	picked.files.set('in.txt', new TextEncoder().encode('from folder\n'));
	const folder = folderMount();
	folder.attach(browser.directoryHandleProvider(picked));
	const result = await run(
		// cli/cp 0.2.1 needs --no-preserve=mode here (it cannot read source modes).
		`cp --no-preserve=mode ${folderPath}/in.txt /work/in.txt; cat /work/in.txt; echo from work > out.txt; cp --no-preserve=mode out.txt ${folderPath}/out.txt; mkdir ${folderPath}/made; ls ${folderPath}`,
		shellFiles,
		{},
		{ [folderPath]: folder.provider }
	);
	expect(result.outcome, result.stderr).toEqual({ kind: 'completed' });
	expect(result.stdout, result.stderr).toBe(
		'from folder\nin.txt\nmade\nout.txt\n'
	);
	expect(strFromU8(picked.files.get('out.txt')!)).toBe('from work\n');
	expect(picked.folders.has('made')).toBe(true);
}, 30000);
it('shares /work across commands in an interactive session with streaming input', async () => {
	let stdout = '';
	const stdin = new browser.BrowserStdin();
	const host = await browser.createBrowserHost({
		stdin,
		cwd: '/work',
		files: shellFiles,
		env,
		mounts: mounts(),
		stdout: (bytes) => {
			stdout += new TextDecoder().decode(bytes);
		}
	});
	const running = host.run(sh(), { name: 'sh', args: ['-i'] });
	await stdin.write(new TextEncoder().encode('echo hi > a\ncat a\nexit\n'));
	stdin.end();
	expect(await running).toEqual({ kind: 'completed' });
	expect(stdout).toContain('hi\n');
}, 30000);

it('keeps sh and /work alive on idle Ctrl+C and retains SIGINT compatibility while a child is running', async () => {
	const activity = new ShellActivity('integration-prompt');
	const stdin = new browser.BrowserStdin();
	let stderr = '';
	let stdout = '';
	const host = await browser.createBrowserHost({
		stdin,
		cwd: '/work',
		files: shellFiles,
		env: { ...env, ...activity.environment },
		mounts: mounts(),
		stderr: (bytes) => {
			stderr += new TextDecoder().decode(activity.stderr(bytes));
		},
		stdout: (bytes) => {
			stdout += new TextDecoder().decode(bytes);
		}
	});
	const running = host.run(sh(), { name: 'sh', args: ['-i'] });
	let finished = false;
	const result = running.then((outcome) => {
		finished = true;
		return outcome;
	});
	async function until(predicate: () => boolean) {
		const deadline = Date.now() + 5000;
		while (!predicate()) {
			if (Date.now() > deadline || finished)
				throw new Error('Shell did not reach the expected activity state.');
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	// As in the supervisor: input marks sh busy until it prompts again.
	async function send(source: string) {
		activity.commandStarted();
		await stdin.write(new TextEncoder().encode(source + '\n'));
	}
	try {
		await until(() => stderr.endsWith('$ ') && !activity.running);
		interruptCommand(host, activity.running);
		await send('echo keep > saved');
		await until(() => stderr.endsWith('$ ') && !activity.running);
		interruptCommand(host, activity.running);
		await send('cat saved');
		await until(() => stderr.endsWith('$ ') && !activity.running);
		expect(stdout).toBe('keep\n');
		expect(finished).toBe(false);
		expect(stderr).not.toContain('shell-prompt');
		await send('cat');
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(activity.running).toBe(true);
		interruptCommand(host, activity.running);
		expect(await result).toEqual({ kind: 'signaled', signal: 2 });
	} finally {
		stdin.end();
		if (!finished) host.signal(9);
	}
}, 30000);
