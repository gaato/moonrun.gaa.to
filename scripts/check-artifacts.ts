import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = resolve('build');
const visited = new Set<string>();
async function visit(file: string): Promise<void> {
	if (visited.has(file)) return;
	visited.add(file);
	assert.ok(file.startsWith(root + '/'), `Asset escapes build: ${file}`);
	assert.ok((await stat(file)).size > 0, `Empty asset: ${file}`);
	if (file.endsWith('.wasm')) {
		assert.deepEqual(
			(await readFile(file)).subarray(0, 4),
			Buffer.from([0, 97, 115, 109]),
			`Invalid wasm asset: ${file}`
		);
	}
	if (!file.endsWith('.js')) return;
	const source = await readFile(file, 'utf8');
	// Traverse the preserved module graph, including its Worker and wasm URLs.
	const clean = source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	const refs = [
		...clean.matchAll(/(?:from\s*|import\s*\(|new URL\(\s*)["']([^"']+)["']/g)
	];
	for (const [, ref] of refs) {
		assert.ok(
			ref.startsWith('.') || ref.startsWith('/'),
			`Bare/remote runtime import: ${ref}`
		);
		await visit(
			ref.startsWith('/')
				? resolve(root, '.' + ref)
				: resolve(dirname(file), ref)
		);
	}
}
await visit(resolve(root, '_moonrun/index.js'));
for (const name of [
	'worker.js',
	'moonrun-diag.wasm',
	'moonrun-policy.wasm',
	'tls-engine.wasm',
	'sqlite-engine.wasm'
]) {
	assert.ok(
		visited.has(resolve(root, '_moonrun', name)),
		`Unreachable moonrun asset: ${name}`
	);
}
const assets = await readdir(resolve(root, '_app/immutable/workers'));
const shellWorker = assets.find(
	(name) => name.startsWith('shell.worker-') && name.endsWith('.js')
);
assert.ok(shellWorker, 'Missing shell supervisor Worker');
const entry = await readFile(
	resolve(root, '_app/immutable/workers', shellWorker),
	'utf8'
);
assert.match(entry, /["']\/_moonrun\/index\.js["']/);
await visit(resolve(root, '_app/immutable/workers', shellWorker));
assert.ok(
	(await readFile(resolve(root, 'index.html'), 'utf8')).includes('/_app/')
);
const headers = await readFile(resolve(root, '_headers'), 'utf8');
assert.match(headers, /wasm-unsafe-eval/);
assert.match(headers, /worker-src 'self'/);
assert.match(headers, /connect-src 'self' https:\/\/mooncakes\.io;/);
assert.match(headers, /style-src 'self' 'unsafe-inline';/);
assert.match(headers, /style-src-attr 'unsafe-inline';/);
assert.match(
	await readFile(resolve(root, '_redirects'), 'utf8'),
	/^\/shell \/ 301$/m
);

// Bundled commands: every indexed file exists with its size and digest.
const commands = JSON.parse(
	await readFile(resolve(root, '_commands/index.json'), 'utf8')
) as { name: string; version: string; sha256: string; size: number }[];
assert.ok(commands.some((command) => command.name === 'cli/sh'));
for (const command of commands) {
	const bytes = await readFile(
		resolve(root, '_commands', command.name.slice(4) + '.wasm')
	);
	assert.equal(bytes.length, command.size, `Size mismatch: ${command.name}`);
	assert.equal(
		createHash('sha256').update(bytes).digest('hex'),
		command.sha256,
		`SHA-256 mismatch: ${command.name}`
	);
	assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0, 97, 115, 109]));
}

const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
assert.equal(config.main, 'src/worker.ts');
assert.equal(config.assets.binding, 'ASSETS');
assert.equal(config.assets.not_found_handling, 'single-page-application');
assert.equal(config.name, 'moonrun-gaa-to');
assert.equal(config.workers_dev, false);
assert.deepEqual(config.assets.run_worker_first, ['/_mooncakes/*']);

console.log(
	`Verified ${visited.size} runtime assets, the shell supervisor import, ${commands.length} bundled commands, SPA entry and security headers.`
);
