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
const supervisor = assets.find(
	(name) => name.startsWith('runner.worker-') && name.endsWith('.js')
);
assert.ok(supervisor, 'Missing app supervisor Worker');
const entry = await readFile(
	resolve(root, '_app/immutable/workers', supervisor),
	'utf8'
);
assert.match(entry, /["']\/_moonrun\/index\.js["']/);
await visit(resolve(root, '_app/immutable/workers', supervisor));
assert.ok(
	(await readFile(resolve(root, 'index.html'), 'utf8')).includes('/_app/')
);
const headers = await readFile(resolve(root, '_headers'), 'utf8');
assert.match(headers, /wasm-unsafe-eval/);
assert.match(headers, /worker-src 'self'/);
assert.match(
	headers,
	/connect-src 'self' https:\/\/mooncakes.io https:\/\/download.mooncakes.io https:\/\/d15l9c1mnzh3r.cloudfront.net/
);
console.log(
	`Verified ${visited.size} runtime assets, supervisor import, SPA entry and security headers.`
);

for (const source of [
	await readFile(resolve(root, 'index.html'), 'utf8'),
	await readFile('.svelte-kit/generated/root.svelte', 'utf8')
]) {
	for (const [, style] of source.matchAll(/\bstyle="([^"]*)"/g)) {
		const hash = createHash('sha256').update(style).digest('base64');
		assert.ok(
			headers.includes(`'sha256-${hash}'`),
			'Inline/runtime style missing from CSP'
		);
	}
}
