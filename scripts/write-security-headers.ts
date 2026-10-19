import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, posix, resolve } from 'node:path';

const outputDirectory = resolve('build');
const runtimeRoot = await readFile('.svelte-kit/generated/root.svelte', 'utf8');

async function walk(directory: string, prefix = ''): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = posix.join(prefix, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walk(resolve(directory, entry.name), relative)));
		} else if (entry.isFile()) {
			files.push(relative);
		}
	}
	return files;
}

function sourceHash(source: string): string {
	return `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
}

function inlineBlocks(html: string, element: 'script' | 'style'): string[] {
	return [
		...html.matchAll(
			new RegExp(`<${element}\\b([^>]*)>([\\s\\S]*?)<\\/${element}>`, 'giu')
		)
	]
		.filter((match) => element === 'style' || !/\bsrc\s*=/iu.test(match[1]))
		.map((match) => match[2]);
}

const htmlFiles = (await walk(outputDirectory))
	.filter((file) => extname(file) === '.html')
	.sort();
const scriptHashes = new Set<string>();
const styleHashes = new Set<string>();
const styleAttributeHashes = new Set<string>();
function collectStyleAttributes(source: string): void {
	for (const [, style] of source.matchAll(/\bstyle="([^"]*)"/g)) {
		styleAttributeHashes.add(sourceHash(style));
	}
}
collectStyleAttributes(runtimeRoot);

for (const file of htmlFiles) {
	const html = await readFile(resolve(outputDirectory, file), 'utf8');
	collectStyleAttributes(html);
	for (const source of inlineBlocks(html, 'script')) {
		scriptHashes.add(sourceHash(source));
	}
	for (const source of inlineBlocks(html, 'style')) {
		styleHashes.add(sourceHash(source));
	}
}

const directives = [
	"default-src 'self'",
	"base-uri 'none'",
	"connect-src 'self' https://mooncakes.io",
	"font-src 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"frame-src 'none'",
	"img-src 'self' data: blob:",
	"manifest-src 'self'",
	"media-src 'self' blob:",
	"object-src 'none'",
	["script-src 'self' 'wasm-unsafe-eval'", ...[...scriptHashes].sort()].join(
		' '
	),
	"script-src-attr 'none'",
	["style-src 'self'", ...[...styleHashes].sort()].join(' '),
	["style-src-attr 'unsafe-hashes'", ...[...styleAttributeHashes].sort()].join(
		' '
	),
	"worker-src 'self'"
];
const contentSecurityPolicy = directives.join('; ');
const headers = [
	'/*',
	`  Content-Security-Policy: ${contentSecurityPolicy}`,
	'  Referrer-Policy: strict-origin-when-cross-origin',
	'  X-Content-Type-Options: nosniff',
	''
].join('\n');

for (const line of headers.split('\n')) {
	if (line.length > 2_000) {
		throw new Error(
			`Generated _headers line exceeds 2,000 characters: ${line.length}`
		);
	}
}

await writeFile(resolve(outputDirectory, '_headers'), headers, 'utf8');
console.log(
	`Generated CSP for ${htmlFiles.length} HTML files (${scriptHashes.size} script and ${styleHashes.size} style hashes)`
);
