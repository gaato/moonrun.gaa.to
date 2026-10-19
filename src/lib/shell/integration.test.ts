import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import type * as Browser from 'moonrun-js/browser';
import { createResolver } from './resolver';
import { verifySha256 } from '../integrity';
import { createMooncakesMount } from './mooncakes-mount';
import { mountRegistry } from './fixtures/mount-registry';
import { mountProxy, mountServer } from './mount-bridge';
import { shellFiles } from './work';
import { interruptCommand, ShellActivity } from './interrupt';

const nativeFetch = globalThis.fetch;
const cache = resolve('.cache/shell-fixtures');
let browser: typeof Browser;
// Stable execution fixtures, not the runtime's command/version catalog.
const version = '0.2.1';
const fixtures = new Map<string, Uint8Array>();
const checksums = new Map<string, string>();
beforeAll(async () => {
	await mkdir(cache, { recursive: true });
	for (const name of ['sh', 'echo', 'tr', 'false', 'cat', 'ls']) {
		const path = `/cli/${name}@${version}/${name}.wasm`;
		const file = resolve(cache, `${name}@${version}.wasm`);
		const get = async (suffix: string) => {
			try {
				return await readFile(file + suffix);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				const response = await nativeFetch(
					'https://download.mooncakes.io/prebuild' + path + suffix,
					{ headers: { 'User-Agent': 'mooncakes-playground/0.1' } }
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
	vi.stubGlobal('location', new URL('https://playground.test'));
	vi.stubGlobal('fetch', async (input: URL | RequestInfo) => {
		const url =
			input instanceof Request ? new URL(input.url) : new URL(input.toString());
		if (url.protocol !== 'file:' || dirname(fileURLToPath(url)) !== directory)
			throw new Error('Unexpected browser component URL.');
		return new Response(await readFile(url));
	});
}, 60000);
afterAll(() => vi.unstubAllGlobals());
function resolver() {
	return createResolver([], {
		fetcher: async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			const name = url.match(
				/^https:\/\/mooncakes\.io\/api-new\/v0\/modules\/cli\/([^/]+)$/
			)?.[1];
			if (name)
				return fixtures.has(`/cli/${name}@${version}/${name}.wasm`)
					? Response.json({ latest_version: version })
					: new Response('', { status: 404 });
			const path = url.replace(/^\/_mooncakes\/prebuild/, '');
			if (path.endsWith('.sha256')) {
				const checksum = checksums.get(path.slice(0, -'.sha256'.length));
				if (checksum) return new Response(checksum);
			} else {
				const bytes = fixtures.get(path);
				if (bytes) return new Response(new Uint8Array(bytes));
			}
			throw new Error('Unprovided fixture: ' + url);
		}
	});
}
function browserResolver(resolve = resolver()): Browser.ResolveCommand {
	return (name, _args, context) => resolve(name, context.cwd);
}
async function run(script: string) {
	let stdout = '';
	let stderr = '';
	const decoder = new TextDecoder();
	const host = await browser.createBrowserHost({
		cwd: '/work',
		files: { '/work': null },
		resolveCommand: browserResolver(),
		stdout: (bytes) => {
			stdout += decoder.decode(bytes);
		},
		stderr: (bytes) => {
			stderr += decoder.decode(bytes);
		}
	});
	const outcome = await host.run(fixtures.get('/cli/sh@0.2.1/sh.wasm')!, {
		name: 'sh',
		args: ['-c', script]
	});
	return { stdout, stderr, outcome };
}
it('runs the real sh/echo/tr wasm pipeline with the site resolver', async () => {
	const result = await run('echo hello | tr a-z A-Z');
	expect(result.stdout).toBe('HELLO\n');
	expect(result.outcome).toEqual({ kind: 'completed' });
}, 30000);
it('preserves command exit status in false; echo $?', async () => {
	expect((await run('false; echo $?')).stdout).toBe('1\n');
}, 30000);
it('returns the normal command-not-found diagnostic and 127', async () => {
	const result = await run('playground-command-that-does-not-exist');
	expect(result.outcome).toEqual({ kind: 'exited', code: 127 });
	expect(result.stderr).toContain('No such file or directory');
}, 30000);
it('shares /work across commands in an interactive session with streaming input', async () => {
	let stdout = '';
	const stdin = new browser.BrowserStdin();
	const host = await browser.createBrowserHost({
		stdin,
		cwd: '/work',
		files: { '/work': null },
		resolveCommand: browserResolver(),
		stdout: (bytes) => {
			stdout += new TextDecoder().decode(bytes);
		}
	});
	const running = host.run(fixtures.get('/cli/sh@0.2.1/sh.wasm')!, {
		name: 'sh',
		args: ['-i']
	});
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
	const resolve = resolver();
	const host = await browser.createBrowserHost({
		stdin,
		cwd: '/work',
		files: { '/work': null },
		env: activity.environment,
		resolveCommand: async (name) => {
			activity.commandStarted();
			return resolve(name);
		},
		stderr: (bytes) => {
			stderr += new TextDecoder().decode(activity.stderr(bytes));
		},
		stdout: (bytes) => {
			stdout += new TextDecoder().decode(bytes);
		}
	});
	const running = host.run(fixtures.get('/cli/sh@0.2.1/sh.wasm')!, {
		name: 'sh',
		args: ['-i']
	});
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
	async function line(source: string) {
		const before = stderr.length;
		await stdin.write(new TextEncoder().encode(source + '\n'));
		await until(() => stderr.length > before && !activity.running);
	}
	try {
		await until(() => stderr.endsWith('$ '));
		interruptCommand(host, activity.running);
		await line('echo keep > saved');
		interruptCommand(host, activity.running);
		await line('cat saved');
		expect(stdout).toBe('keep\n');
		expect(finished).toBe(false);
		expect(stderr).not.toContain('playground-prompt');
		await stdin.write(new TextEncoder().encode('cat\n'));
		await until(() => activity.running);
		interruptCommand(host, activity.running);
		expect(await result).toEqual({ kind: 'signaled', signal: 2 });
	} finally {
		stdin.end();
		if (!finished) host.signal(9);
	}
}, 30000);

it('runs real ls/cat against the lazy read-only provider through its supervisor bridge and executes a relative mounted wasm', async () => {
	const r = mountRegistry();
	const echo = fixtures.get('/cli/echo@0.2.1/echo.wasm')!;
	r.wasm('/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm', echo);
	const mount = createMooncakesMount({ fetcher: r.fetcher });
	const server = mountServer(mount);
	const proxy = mountProxy((id, request) => {
		void server.call(request).then((value) => proxy.accept(id, value));
	});
	const local = resolver();
	const mounted = createResolver([], { mount, fetcher: r.fetcher });
	let stdout = '';
	let stderr = '';
	const listing = await browser.createBrowserHost({
		cwd: '/work',
		files: shellFiles,
		mounts: { '/mooncakes': proxy.provider },
		stdout: (bytes) => {
			stdout += new TextDecoder().decode(bytes);
		},
		stderr: (bytes) => {
			stderr += new TextDecoder().decode(bytes);
		}
	});
	expect(
		await listing.run(fixtures.get('/cli/ls@0.2.1/ls.wasm')!, {
			name: 'ls',
			args: ['-F', '/mooncakes/gaato']
		}),
		stderr
	).toEqual({ kind: 'completed' });
	expect(r.zipCalls()).toHaveLength(0);
	expect(stdout).toContain('kbbi@latest@');
	const host = await browser.createBrowserHost({
		cwd: '/work',
		files: shellFiles,
		env: { HOME: '/work' },
		mounts: { '/mooncakes': proxy.provider },
		resolveCommand: (name, _args, context) =>
			name.includes('/')
				? mounted(name, context.cwd)
				: local(name, context.cwd),
		stdout: (bytes) => {
			stdout += new TextDecoder().decode(bytes);
		},
		stderr: (bytes) => {
			stderr += new TextDecoder().decode(bytes);
		}
	});
	try {
		const outcome = await host.run(fixtures.get('/cli/sh@0.2.1/sh.wasm')!, {
			name: 'sh',
			args: [
				'-c',
				'cat sample.json; ls /mooncakes/gaato; cat /mooncakes/gaato/kbbi@latest/README.md; cd /mooncakes/gaato/kbbi@0.1.6; ./cmd/kbbi/kbbi.wasm mounted; echo nope > README.md; cat README.md'
			]
		});
		expect(outcome).toEqual({ kind: 'completed' });
		expect(stdout).toContain('kbbi@0.1.6');
		expect(stdout).toContain('kbbi@latest');
		expect(stdout).toContain('mounted\n');
		expect(stdout).toContain('{"a":[1,2,3]}');
		expect(stdout.match(/Fixture module/g)).toHaveLength(2);
		expect(stderr).toContain('Read-only file system');
		expect(r.zipCalls()).toHaveLength(1);
	} finally {
		server.close();
	}
}, 30000);
