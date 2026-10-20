import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import type * as Browser from 'moonrun-js/browser';
import type { MountProvider } from 'moonrun-js/browser';
import { verifySha256 } from '../integrity';
import { userAgent } from '../downloads';
import { createMooncakesMount } from './mooncakes-mount';
import { mountRegistry } from './fixtures/mount-registry';
import { mountProxy, mountServer } from './mount-bridge';
import { addedPath, shellFiles, shellPath } from './work';
import { interruptCommand, ShellActivity } from './interrupt';
import { createBinMount } from './bin-mount';
import { addedFilesProvider, copyCommand } from './local-mounts';

const nativeFetch = globalThis.fetch;
const cache = resolve('.cache/shell-fixtures');
let browser: typeof Browser;
// Stable execution fixtures, not the runtime's command/version catalog.
const version = '0.2.1';
const names = ['sh', 'echo', 'tr', 'false', 'cat', 'ls', 'cp'];
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
const skills = vi.fn(async (name: string) =>
	name === 'skill-echo' ? program('echo') : undefined
);
async function run(
	script: string,
	files: Browser.BrowserFiles = shellFiles,
	extra?: Record<string, MountProvider>
) {
	let stdout = '';
	let stderr = '';
	const decoder = new TextDecoder();
	const host = await browser.createBrowserHost({
		cwd: '/work',
		files,
		env,
		mounts: mounts(extra),
		resolveCommand: (name) => skills(name),
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
	expect(skills).not.toHaveBeenCalledWith('echo');
}, 30000);
it('lists /bin, prefers /work/bin, runs ./prog.wasm and falls back to skills by name', async () => {
	const result = await run(
		'ls /bin; cat hi.txt; ./prog.wasm direct; cat path; skill-echo fallback',
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
		names.slice().sort().join('\n') + '\nhi.txt\ndirect\npath\nfallback\n'
	);
	expect(skills).toHaveBeenCalledWith('skill-echo');
}, 30000);
it('preserves command exit status in false; echo $?', async () => {
	expect((await run('false; echo $?')).stdout).toBe('1\n');
}, 30000);
it('returns the normal command-not-found diagnostic and 127', async () => {
	const result = await run('moonrun-command-that-does-not-exist');
	expect(result.outcome).toEqual({ kind: 'exited', code: 127 });
	expect(result.stderr).toContain('No such file or directory');
}, 30000);
it('copies staged added files into /work with the generated cp line', async () => {
	const staged = new Map([
		["it's a file.txt", new TextEncoder().encode('added\n')],
		['tool.wasm', program('echo')]
	]);
	const result = await run(
		copyCommand([...staged.keys()], addedPath).trim() +
			'; cat "/work/it\'s a file.txt"; ./tool.wasm ran',
		shellFiles,
		{ [addedPath]: addedFilesProvider(staged) }
	);
	expect(result.outcome, result.stderr).toEqual({ kind: 'completed' });
	expect(result.stdout).toBe('added\nran\n');
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
		await until(() => activity.idle);
		interruptCommand(host, activity.running);
		await send('echo keep > saved');
		await until(() => activity.idle);
		interruptCommand(host, activity.running);
		await send('cat saved');
		await until(() => activity.idle);
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

it('runs real ls/cat against the lazy read-only /mooncakes provider and executes a relative mounted wasm by path', async () => {
	const r = mountRegistry();
	r.wasm('/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm', program('echo'));
	const mooncakes = createMooncakesMount({ fetcher: r.fetcher });
	const listing = await run('ls -F /mooncakes/gaato', shellFiles, {
		'/mooncakes': mooncakes
	});
	expect(listing.outcome, listing.stderr).toEqual({ kind: 'completed' });
	expect(r.zipCalls()).toHaveLength(0);
	expect(listing.stdout).toBe('kbbi/\n');
	const result = await run(
		'cat sample.json; ls /mooncakes/gaato; /mooncakes/gaato/kbbi/cmd/kbbi/kbbi.wasm absolute; cd /mooncakes/gaato/kbbi; ./cmd/kbbi/kbbi.wasm mounted; echo nope > README.md; cat README.md',
		shellFiles,
		{ '/mooncakes': mooncakes }
	);
	expect(result.outcome).toEqual({ kind: 'completed' });
	expect(result.stdout).toContain('kbbi\nabsolute\nmounted\n');
	expect(result.stdout).toContain('{"a":[1,2,3]}');
	expect(result.stdout.match(/Fixture module/g)).toHaveLength(1);
	expect(result.stderr).toContain('Read-only file system');
	expect(r.zipCalls()).toHaveLength(1);
}, 30000);
