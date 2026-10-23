// `moonx`, as in moon's crates/moon/src/cli/moonx.rs and mooncake's
// registry/{executable,path,client}.rs: registry package coordinates resolve to a
// verified prebuilt wasm, which replaces the moonx child (interpreter style).
import type { ResolvedCommand } from 'moonrun-js/browser';
import { downloadPath, mirrorPrefix } from '../downloads';
import { browserCache, verifiedWasm, type VerifiedCache } from '../integrity';

export const modulesEndpoint = 'https://mooncakes.io/api/v0/modules';

export interface Coordinate {
	owner: string;
	/** The module name after the owner, including a /vN suffix (`kbbi`, `b/v2`). */
	module: string;
	/** Package path inside the module; empty for the module root package. */
	package: string;
	/** An exact version, or undefined for the latest one. */
	version?: string;
}

/** A failure printed moon-style: `Error: <message>`, then its causes. */
export class MoonxError extends Error {
	constructor(
		message: string,
		readonly causes: string[] = [],
		readonly status = 255
	) {
		super(message);
	}
	get text(): string {
		return [
			`Error: ${this.message}`,
			...(this.causes.length
				? ['', 'Caused by:', ...this.causes.map((cause) => `    ${cause}`)]
				: [])
		].join('\n');
	}
}
class Cause extends Error {}

const semver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
// A canonical major-version suffix (v2, v10; not v0, v1 or v02) belongs to the module.
const majorSuffix = (module: string) =>
	Number(/^[^/]+\/v([2-9]|[1-9]\d+)$/.exec(module)?.[1] ?? 0) || undefined;
const moduleName = (c: Pick<Coordinate, 'owner' | 'module'>) =>
	`${c.owner}/${c.module}`;

function components(path: string): string[] {
	const parts = path.split('/');
	if (
		parts.some(
			(part) =>
				!part ||
				part === '.' ||
				part === '..' ||
				/[:\\#?%\s\p{Cc}؜‎‏‪-‮⁦-⁯]/u.test(part)
		)
	)
		throw new Cause('path contains an invalid component');
	return parts;
}
function splitVersion(input: string): [string, string | undefined] {
	const at = input.indexOf('@');
	if (at < 0) return [input, undefined];
	const version = input.slice(at + 1);
	if (version.includes('@'))
		throw new Cause('must contain a single version marker');
	return [input.slice(0, at), version];
}
function installStyle(path: string): Coordinate {
	const parts = components(path);
	if (parts.length < 2)
		throw new Cause('must be in format `user/module/package`');
	const suffixed = parts.length > 2 && majorSuffix(`${parts[1]}/${parts[2]}`);
	const length = suffixed ? 3 : 2;
	return {
		owner: parts[0],
		module: parts.slice(1, length).join('/'),
		package: parts.slice(length).join('/')
	};
}
function exact(coordinate: Coordinate, version: string): string {
	if (!semver.test(version))
		throw new Cause(`invalid semantic version \`${version}\``);
	const major = majorSuffix(coordinate.module);
	if (major !== undefined && Number(version.split('.')[0]) !== major)
		throw new Cause(
			`module \`${moduleName(coordinate)}\` requires major version ${major}, but got ${version}`
		);
	return version;
}
function withVersion(coordinate: Coordinate, version: string): Coordinate {
	if (!version || version.includes('/'))
		throw new Cause('version must not be empty or contain path separators');
	// A /vN path fixes the major version even before the version is selected.
	if (majorSuffix(coordinate.module) && version !== 'latest')
		exact(coordinate, version);
	return { ...coordinate, version };
}

/** Executable Package Coordinates, as `parse_executable_package_coordinate`. */
export function parseCoordinate(input: string): Coordinate {
	if (input.endsWith('...'))
		throw new MoonxError(
			`Invalid package coordinate \`${input}\`: wildcard package paths are not supported`
		);
	let parsed: Coordinate;
	try {
		const at = input.indexOf('@');
		if (at < 0) return installStyle(input);
		if (input.slice(at + 1).includes('/')) {
			// owner/module[/vN]@version[/package]
			const [path, tail] = splitVersion(input);
			const slash = tail!.indexOf('/');
			const version = slash < 0 ? tail! : tail!.slice(0, slash);
			const pkg = slash < 0 ? '' : tail!.slice(slash + 1);
			if (pkg) components(pkg);
			const module = installStyle(path);
			if (module.package)
				throw new Cause('module name must be in format `user/module[/vN]`');
			parsed = withVersion({ ...module, package: pkg }, version);
		} else {
			// owner/module[/vN][/package]@version
			const [path, version] = splitVersion(input);
			parsed = withVersion(installStyle(path), version!);
		}
	} catch (error) {
		if (error instanceof Cause)
			throw new MoonxError(`Invalid package coordinate \`${input}\``, [
				error.message
			]);
		throw error;
	}
	if (parsed.version === 'latest') return { ...parsed, version: undefined };
	try {
		exact(parsed, parsed.version!);
	} catch (error) {
		throw new MoonxError(`Invalid version in package coordinate \`${input}\``, [
			(error as Error).message
		]);
	}
	return parsed;
}

/** `wasm_artifact_name`: the last package segment, or the module's for the root. */
export function artifactName(coordinate: Coordinate): string {
	return `${(coordinate.package || coordinate.module).split('/').at(-1)}.wasm`;
}
/** `wasm_asset` on download.mooncakes.io, reached through this site's mirror. */
export function artifactUrl(coordinate: Coordinate, version: string): string {
	const path = downloadPath(
		`/prebuild/${moduleName(coordinate)}@${version}/${coordinate.package ? coordinate.package + '/' : ''}${artifactName(coordinate)}`
	);
	if (!path)
		throw new MoonxError(
			`\`${moduleName(coordinate)}@${version}\` cannot be downloaded through this site's mirror`
		);
	return mirrorPrefix + path;
}

export type Invocation =
	| { kind: 'run'; input: string; args: string[]; verbose: boolean }
	| { kind: 'print'; text: string; status: number; stderr: boolean };
const usage = 'Usage: moonx [OPTIONS] <PACKAGE> [PROGRAM_ARGS]...';
export const helpText = `Run a package from the Mooncakes registry

${usage}

Accepted input forms:
  moonx user/module/package
  moonx user/module/package@1.2.3
  moonx user/module@1.2.3/package
  moonx user/module/package@latest

Options:
      --target <TARGET>             [default: wasm] [possible values: wasm]
      --experimental-policy <PATH>  Not supported in the browser
  -v, --verbose                     Accepted; no extra output in the browser
  -h, --help                        Print help
  -V, --version                     Print version

In this browser shell, programs have no network access.`;
const usageError = (message: string): Invocation => ({
	kind: 'print',
	text: `error: ${message}\n\n${usage}\n\nFor more information, try '--help'.`,
	status: 2,
	stderr: true
});

/** moonx's clap grammar: options, then the input; one leading `--` before args is dropped. */
export function parseInvocation(args: readonly string[]): Invocation {
	let verbose = false;
	let i = 0;
	for (; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--') {
			i++;
			break;
		}
		if (arg === '-h' || arg === '--help')
			return { kind: 'print', text: helpText, status: 0, stderr: false };
		if (arg === '-V' || arg === '--version')
			return {
				kind: 'print',
				text: 'moonx (moonrun.gaa.to, browser)',
				status: 0,
				stderr: false
			};
		if (arg === '-v' || arg === '--verbose') verbose = true;
		else if (
			arg === '--experimental-policy' ||
			arg.startsWith('--experimental-policy=')
		)
			return {
				kind: 'print',
				text: 'moonx: --experimental-policy is not supported in the browser',
				status: 2,
				stderr: true
			};
		else if (arg === '--target' || arg.startsWith('--target=')) {
			const value = arg === '--target' ? args[++i] : arg.slice(9);
			if (value === undefined)
				return usageError(
					"a value is required for '--target <TARGET>' but none was supplied"
				);
			if (value === 'native')
				return {
					kind: 'print',
					text: 'moonx: --target native is not supported in the browser',
					status: 2,
					stderr: true
				};
			if (value !== 'wasm')
				return usageError(
					`invalid value '${value}' for '--target <TARGET>'\n  [possible values: wasm]`
				);
		} else if (arg.startsWith('-') && arg !== '-')
			return usageError(`unexpected argument '${arg}' found`);
		else break;
	}
	if (i >= args.length)
		return { kind: 'print', text: helpText, status: 2, stderr: true };
	const rest = args.slice(i + 1);
	return {
		kind: 'run',
		input: args[i],
		args: rest[0] === '--' ? rest.slice(1) : rest,
		verbose
	};
}

const unsigned = (value: number): number[] => {
	const bytes: number[] = [];
	do {
		let byte = value & 0x7f;
		value >>>= 7;
		if (value) byte |= 0x80;
		bytes.push(byte);
	} while (value);
	return bytes;
};
const signed = (value: number): number[] => {
	const bytes: number[] = [];
	for (;;) {
		const byte = value & 0x7f;
		value >>= 7;
		if ((value === 0 && !(byte & 0x40)) || (value === -1 && byte & 0x40))
			return [...bytes, byte];
		bytes.push(byte | 0x80);
	}
};
const vector = (items: number[][]) => [
	...unsigned(items.length),
	...items.flat()
];
const name = (text: string) =>
	vector([...new TextEncoder().encode(text)].map((b) => [b]));
const section = (id: number, body: number[]) => [
	id,
	...unsigned(body.length),
	...body
];
/**
 * A minimal WASI program that writes `text` and a newline to stdout or stderr and
 * exits with `status`, so moonx messages behave like a real moonx process.
 */
export function messageWasm(
	text: string,
	status: number,
	stderr = true
): Uint8Array {
	const data = new TextEncoder().encode(text + '\n');
	const wasi = name('wasi_snapshot_preview1');
	const i32 = 0x7f;
	const body = [
		0x00, // no locals
		...[0x41, ...signed(0), 0x41, ...signed(16), 0x36, 0x02, 0x00], // iov.base
		...[0x41, ...signed(4), 0x41, ...signed(data.length), 0x36, 0x02, 0x00], // iov.len
		...[0x41, ...signed(stderr ? 2 : 1), 0x41, 0x00, 0x41, 0x01, 0x41, 0x08],
		...[0x10, 0x00, 0x1a], // fd_write(fd, iovs, 1, nwritten); drop
		...[0x41, ...signed(status), 0x10, 0x01, 0x0b] // proc_exit(status)
	];
	return new Uint8Array([
		...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
		...section(
			1,
			vector([
				[0x60, ...vector([[i32], [i32], [i32], [i32]]), ...vector([[i32]])],
				[0x60, ...vector([[i32]]), 0x00],
				[0x60, 0x00, 0x00]
			])
		),
		...section(
			2,
			vector([
				[...wasi, ...name('fd_write'), 0x00, 0x00],
				[...wasi, ...name('proc_exit'), 0x00, 0x01]
			])
		),
		...section(3, vector([[0x02]])),
		...section(
			5,
			vector([[0x00, ...unsigned(Math.ceil((16 + data.length) / 65536))]])
		),
		...section(
			7,
			vector([
				[...name('memory'), 0x02, 0x00],
				[...name('_start'), 0x00, 0x02]
			])
		),
		...section(10, vector([[...unsigned(body.length), ...body]])),
		...section(
			11,
			vector([
				[0x00, 0x41, ...signed(16), 0x0b, ...unsigned(data.length), ...data]
			])
		)
	]);
}
/** A moonx message and exit status, as the moonx child process. */
export function printCommand(
	text: string,
	status: number,
	stderr = true
): ResolvedCommand {
	return { wasm: messageWasm(text, status, stderr), args: [], argv0: 'moonx' };
}

export interface MoonxOptions {
	fetcher?: typeof fetch;
	signal?: AbortSignal;
	cache?: VerifiedCache;
}
// One per shell session: latest versions and verified bytes are memoized.
export function createMoonx({
	fetcher = fetch,
	signal,
	cache
}: MoonxOptions = {}) {
	const latest = new Map<string, Promise<string>>();
	const programs = new Map<string, Promise<Uint8Array | undefined>>();
	function memo<T>(
		map: Map<string, Promise<T>>,
		key: string,
		work: () => Promise<T>
	) {
		let pending = map.get(key);
		if (!pending) {
			pending = work();
			map.set(key, pending);
			// Definite answers stay for the session; transient failures retry.
			void pending.catch((error) => {
				if (!(error instanceof MoonxError)) map.delete(key);
			});
		}
		return pending;
	}
	const latestVersion = (coordinate: Coordinate) =>
		memo(latest, moduleName(coordinate), async () => {
			const url = `${modulesEndpoint}/${moduleName(coordinate).split('/').map(encodeURIComponent).join('/')}`;
			const response = await fetcher(url, { signal, cache: 'no-store' });
			if (response.status === 404)
				throw new MoonxError(
					`Module \`${moduleName(coordinate)}\` not found in registry`
				);
			if (!response.ok)
				throw new Error(
					`Could not resolve the latest version (HTTP ${response.status}).`
				);
			const { latest_version: version } = (await response.json()) as {
				latest_version?: unknown;
			};
			if (typeof version !== 'string')
				throw new MoonxError(
					`Module \`${moduleName(coordinate)}\` has no version information`
				);
			try {
				return exact(coordinate, version);
			} catch (error) {
				throw new MoonxError((error as Error).message);
			}
		});
	async function resolve(args: readonly string[]): Promise<ResolvedCommand> {
		const invocation = parseInvocation(args);
		if (invocation.kind === 'print')
			return printCommand(
				invocation.text,
				invocation.status,
				invocation.stderr
			);
		try {
			if (invocation.input.endsWith('.mbtx'))
				throw new MoonxError(
					`Cannot run \`${invocation.input}\`: .mbtx scripts need the MoonBit compiler, which is not available in the browser`
				);
			const coordinate = parseCoordinate(invocation.input);
			const version = coordinate.version ?? (await latestVersion(coordinate));
			const url = artifactUrl(coordinate, version);
			const wasm = await memo(programs, url, async () =>
				verifiedWasm(url, cache ?? (await browserCache()), fetcher, signal)
			);
			if (!wasm) throw new MoonxError('Prebuilt wasm asset does not exist');
			return {
				wasm,
				args: invocation.args,
				argv0: artifactName(coordinate).slice(0, -'.wasm'.length)
			};
		} catch (error) {
			signal?.throwIfAborted();
			const failure =
				error instanceof MoonxError
					? error
					: new MoonxError(`Failed to run \`${invocation.input}\``, [
							error instanceof Error ? error.message : String(error)
						]);
			return printCommand(failure.text, failure.status);
		}
	}
	return resolve;
}
