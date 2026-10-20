import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const cacheDirectory = join(root, 'node_modules/.cache');
await mkdir(cacheDirectory, { recursive: true });
const directory = await mkdtemp(join(cacheDirectory, 'worker-smoke-'));

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
	return address.port;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const require = createRequire(import.meta.url);
const child = spawn(
	process.execPath,
	[
		resolve(
			dirname(require.resolve('wrangler/package.json')),
			'bin/wrangler.js'
		),
		'dev',
		'--local',
		'--ip',
		'127.0.0.1',
		'--port',
		String(port),
		'--inspector-port',
		'0',
		'--persist-to',
		join(directory, 'state')
	],
	{
		cwd: root,
		detached: process.platform !== 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			WRANGLER_SEND_METRICS: 'false',
			WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
			XDG_CONFIG_HOME: join(directory, 'config'),
			XDG_CACHE_HOME: join(directory, 'cache')
		}
	}
);
let log = '';
child.stdout.on('data', (chunk: Buffer) => {
	log = (log + chunk.toString()).slice(-20_000);
});
child.stderr.on('data', (chunk: Buffer) => {
	log = (log + chunk.toString()).slice(-20_000);
});
let startupError: Error | undefined;
child.on('error', (error) => {
	startupError = error;
});
const closed = new Promise<void>((resolve) =>
	child.once('close', () => resolve())
);
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
	return (stopping ??= (async () => {
		const signal = (name: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				if (process.platform === 'win32') child.kill(name);
				else process.kill(-child.pid, name);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
			}
		};
		signal('SIGTERM');
		await Promise.race([closed, delay(3000)]);
		signal('SIGKILL');
		await Promise.race([closed, delay(2000)]);
		await writeFile(join(directory, 'process.log'), log);
	})());
}
process.once('SIGINT', () => {
	void stop().finally(() => process.exit(130));
});
process.once('SIGTERM', () => {
	void stop().finally(() => process.exit(143));
});

async function curl(name: string, path: string, timeout = 45) {
	const bodyPath = join(directory, name + '.body');
	const { stdout } = await exec(
		'curl',
		[
			'--silent',
			'--show-error',
			'--noproxy',
			'*',
			'--path-as-is',
			'--max-time',
			String(timeout),
			'--dump-header',
			join(directory, name + '.headers'),
			'--output',
			bodyPath,
			'--write-out',
			'%{http_code}\n%{content_type}',
			base + path
		],
		{ timeout: (timeout + 2) * 1000, maxBuffer: 64 * 1024 }
	);
	const [status, contentType] = stdout.trim().split('\n');
	return {
		status: Number(status),
		contentType,
		body: await readFile(bodyPath)
	};
}

try {
	console.log(`Starting local Worker smoke on ${base}`);
	const deadline = Date.now() + 30_000;
	let ready = false;
	while (Date.now() < deadline) {
		if (startupError) throw startupError;
		if (child.exitCode !== null || child.signalCode !== null)
			throw new Error('Wrangler exited before becoming ready.');
		try {
			ready = (await curl('ready', '/', 2)).status === 200;
		} catch {
			/* Wait for startup. */
		}
		if (ready) break;
		await delay(250);
	}
	assert.ok(ready, 'Wrangler did not become ready within 30 seconds.');
	const program = '/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm';
	const html = await readFile(join(root, 'build/index.html'));
	for (const path of ['/', '/some/other/path', '/?cmd=ls%20%2Fbin']) {
		const name = 'spa-' + path.replace(/[^a-z]+/g, '-');
		const spa = await curl(name, path);
		assert.equal(spa.status, 200, `${path} must serve the shell.`);
		assert.match(spa.contentType, /^text\/html\b/);
		assert.deepEqual(spa.body, html);
		const headers = await readFile(join(directory, name + '.headers'), 'utf8');
		assert.match(headers, /style-src 'self' 'unsafe-inline';/);
		assert.match(headers, /connect-src 'self' https:\/\/mooncakes.io;/);
		assert.doesNotMatch(headers, /script-src[^;]*'unsafe-inline'/);
		console.log(
			`PASS ${path}: 200 shell, xterm styles permitted, script CSP retained`
		);
	}
	const shell = await curl('shell', '/shell');
	assert.equal(shell.status, 301);
	assert.match(
		await readFile(join(directory, 'shell.headers'), 'utf8'),
		/^location: \/\r?$/im
	);
	console.log('PASS /shell: 301 to /');

	const bundle = await curl('bundle-index', '/_commands/index.json');
	assert.equal(bundle.status, 200, 'Bundle index failed.');
	const bundled = JSON.parse(bundle.body.toString()) as {
		name: string;
		sha256: string;
		size: number;
	}[];
	const sh = bundled.find((entry) => entry.name === 'cli/sh');
	assert.ok(sh, 'cli/sh is not bundled.');
	const shWasm = await curl('bundle-sh', '/_commands/sh.wasm');
	assert.equal(shWasm.status, 200);
	assert.equal(shWasm.body.length, sh.size);
	assert.equal(
		createHash('sha256').update(shWasm.body).digest('hex'),
		sh.sha256
	);
	console.log(
		`PASS bundle: ${bundled.length} static commands, /_commands/sh.wasm matches its digest`
	);

	const mirror = '/_mooncakes/prebuild' + program;
	const wasm = await curl('wasm', mirror);
	assert.equal(wasm.status, 200, 'Wasm mirror failed.');
	assert.equal(wasm.contentType, 'application/wasm');
	const checksum = await curl('checksum', mirror + '.sha256');
	assert.equal(checksum.status, 200, 'Checksum mirror failed.');
	const expected = /^([a-f0-9]{64})(?:\s+\*?kbbi\.wasm)?$/i.exec(
		checksum.body.toString().trim()
	);
	assert.ok(expected, 'Unexpected checksum file format.');
	const digest = createHash('sha256').update(wasm.body).digest('hex');
	assert.equal(
		digest,
		expected[1].toLowerCase(),
		'Mirrored wasm SHA-256 differs from its checksum.'
	);
	console.log(`PASS mirror: 200 application/wasm, SHA-256 ${digest}`);

	for (const path of [
		'/_mooncakes/cli-index',
		'/_mooncakes/user/gaato/kbbi/0.1.6.zip',
		'/_mooncakes/skills/gaato/kbbi@0.1.6/cmd/kbbi/skills.zip'
	])
		assert.equal((await curl('removed', path)).status, 404, path);
	console.log('PASS removed routes (cli-index, source zip, skills.zip): 404');

	assert.equal(
		(await curl('latest', mirror.replace('@0.1.6', '@latest'))).status,
		404,
		'@latest must be rejected.'
	);
	console.log('PASS @latest: 404');
	assert.equal(
		(
			await curl(
				'traversal',
				'/_mooncakes/prebuild/gaato/kbbi@0.1.6/../kbbi.wasm'
			)
		).status,
		404,
		'Traversal must be rejected.'
	);
	console.log('PASS traversal (--path-as-is): 404');
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	await stop();
	if (process.exitCode) console.error(log.slice(-6000));
	console.log(`Worker stopped. Smoke evidence: ${directory}`);
}
