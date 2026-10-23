// Bundles the latest prebuilt cli/* commands as static assets (static/_commands/).
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const modulesEndpoint = 'https://mooncakes.io/api/v0/modules';
export const downloadOrigin = 'https://download.mooncakes.io';
// CloudFront rejects requests without a User-Agent.
export const userAgent = 'moonrun.gaa.to/0.1 (+https://moonrun.gaa.to)';
// Cloudflare Workers static assets are limited to 25 MiB per file.
export const maxAssetBytes = 25 * 1024 * 1024;

export interface BundledCommand {
	name: string;
	version: string;
	sha256: string;
	size: number;
	source: string;
}
export interface PrepareOptions {
	directory: string;
	fetcher?: typeof fetch;
	concurrency?: number;
	log?: (message: string) => void;
}

const moduleName = /^cli\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const number = '(?:0|[1-9][0-9]*)';
const concreteVersion = new RegExp(
	`^${number}\\.${number}\\.${number}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
);

// The registry list includes libraries and other owners; keep non-yanked cli/* coordinates.
export function cliModules(
	value: unknown
): { name: string; version: string }[] {
	if (!Array.isArray(value)) throw new Error('Invalid modules list.');
	const entries = new Map<string, string>();
	for (const entry of value) {
		if (
			typeof entry?.name !== 'string' ||
			typeof entry.version !== 'string' ||
			entry.yanked ||
			!moduleName.test(entry.name) ||
			!concreteVersion.test(entry.version) ||
			entries.has(entry.name)
		)
			continue;
		entries.set(entry.name, entry.version);
	}
	return [...entries]
		.map(([name, version]) => ({ name, version }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function checksumDigest(text: string): string {
	const match = /^([a-f0-9]{64})(?:\s+\*?[^\r\n]+)?$/i.exec(text.trim());
	if (!match) throw new Error('Invalid SHA-256 checksum.');
	return match[1].toLowerCase();
}

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

export async function prepareCommands({
	directory,
	fetcher = fetch,
	concurrency = 6,
	log = () => {}
}: PrepareOptions): Promise<BundledCommand[]> {
	const get = async (url: string) => {
		const response = await fetcher(url, {
			headers: { 'User-Agent': userAgent }
		});
		if (response.status !== 404 && !response.ok)
			throw new Error(`${url}: HTTP ${response.status}`);
		return response;
	};
	const list = await get(modulesEndpoint);
	if (!list.ok) throw new Error(`${modulesEndpoint}: HTTP ${list.status}`);
	const modules = cliModules(await list.json());
	if (!modules.length) throw new Error('No cli/* modules listed.');
	await mkdir(directory, { recursive: true });
	const bundled: BundledCommand[] = [];
	let next = 0;
	async function worker() {
		while (next < modules.length) {
			const { name, version } = modules[next++];
			const command = name.slice('cli/'.length);
			const source = `${downloadOrigin}/prebuild/${name}@${version}/${command}.wasm`;
			const checksum = await get(source + '.sha256');
			if (checksum.status === 404) {
				log(`skip ${name}@${version}: no prebuilt executable`);
				continue;
			}
			const digest = checksumDigest(await checksum.text());
			const file = join(directory, command + '.wasm');
			let bytes: Uint8Array | undefined;
			try {
				const existing = new Uint8Array(await readFile(file));
				if (sha256(existing) === digest) bytes = existing;
			} catch {
				/* Download below. */
			}
			if (!bytes) {
				const response = await get(source);
				if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
				bytes = new Uint8Array(await response.arrayBuffer());
				if (sha256(bytes) !== digest)
					throw new Error(`${source}: SHA-256 mismatch`);
				if (![0, 97, 115, 109].every((byte, i) => bytes![i] === byte))
					throw new Error(`${source}: not a wasm module`);
				if (bytes.byteLength > maxAssetBytes)
					throw new Error(`${source}: exceeds the 25 MiB asset limit`);
				await writeFile(file, bytes);
				log(`downloaded ${name}@${version} (${bytes.byteLength} bytes)`);
			}
			bundled.push({
				name,
				version,
				sha256: digest,
				size: bytes.byteLength,
				source
			});
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, modules.length) }, worker)
	);
	bundled.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const keep = new Set(bundled.map((entry) => entry.name.slice(4) + '.wasm'));
	for (const file of await readdir(directory))
		if (file.endsWith('.wasm') && !keep.has(file))
			await rm(join(directory, file));
	await writeFile(
		join(directory, 'index.json'),
		JSON.stringify(bundled, null, '\t') + '\n'
	);
	return bundled;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const directory = resolve('static/_commands');
	const commands = await prepareCommands({ directory, log: console.log });
	const total = commands.reduce((sum, entry) => sum + entry.size, 0);
	console.log(
		`Bundled ${commands.length} verified cli/* commands (${(total / 1024 / 1024).toFixed(1)} MiB) in ${directory}.`
	);
}
