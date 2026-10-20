import type {
	MountEntry,
	MountFile,
	MountProvider,
	MountStat
} from 'moonrun-js/browser';

type Code = 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EROFS' | 'EINVAL';
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: Code } };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: Code): Result<never> => ({ ok: false, error: { code } });

// Read-only staging for added files until the shell copies them into /work.
// Its contents change during the run, so the VFS must not cache it.
export function addedFilesProvider(
	files: ReadonlyMap<string, Uint8Array>
): MountProvider {
	const file = (path: string) =>
		path.indexOf('/', 1) < 0 ? files.get(path.slice(1)) : undefined;
	return {
		cache: false,
		async stat(path) {
			if (path === '/') return ok<MountStat>({ kind: 'dir', mode: 0o555 });
			const bytes = file(path);
			return bytes
				? ok<MountStat>({ kind: 'file', size: bytes.length, mode: 0o444 })
				: fail('ENOENT');
		},
		async readdir(path) {
			if (path !== '/') return fail(file(path) ? 'ENOTDIR' : 'ENOENT');
			return ok<readonly MountEntry[]>(
				[...files.keys()].sort().map((name) => ({ name, kind: 'file' }))
			);
		},
		async open(path) {
			if (path === '/') return fail('EISDIR');
			const bytes = file(path);
			if (!bytes) return fail('ENOENT');
			return ok<MountFile>({
				size: bytes.length,
				read: async (offset, length) =>
					offset >= 0 && length >= 0
						? ok(bytes.slice(offset, offset + length))
						: fail('EINVAL')
			});
		}
	};
}

// Mounts are fixed when a run starts; the folder is picked later. Until then the
// mount point is an empty read-only directory.
export function folderMount() {
	let target: MountProvider | undefined;
	const write = <K extends keyof MountProvider>(name: K) =>
		(async (...args: unknown[]) => {
			const method = target?.[name] as
				((...args: unknown[]) => Promise<unknown>) | undefined;
			return method ? method.apply(target, args) : fail('EROFS');
		}) as NonNullable<MountProvider[K]>;
	const provider: MountProvider = {
		cache: false,
		stat: async (path) =>
			target
				? target.stat(path)
				: path === '/'
					? ok<MountStat>({ kind: 'dir', mode: 0o555 })
					: fail('ENOENT'),
		readdir: async (path) =>
			target
				? target.readdir(path)
				: path === '/'
					? ok<readonly MountEntry[]>([])
					: fail('ENOENT'),
		open: async (path) =>
			target ? target.open(path) : fail(path === '/' ? 'EISDIR' : 'ENOENT'),
		create: write('create'),
		write: write('write'),
		truncate: write('truncate'),
		mkdir: write('mkdir'),
		remove: write('remove'),
		rename: write('rename')
	};
	return {
		provider,
		attach(next: MountProvider) {
			target = next;
		}
	};
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
// One input line for cli/sh; names are plain filenames (see workFilename).
export function copyCommand(names: readonly string[], from: string): string {
	return (
		names
			.map(
				(name) =>
					`cp --no-preserve=mode ${quote(`${from}/${name}`)} ${quote(`/work/${name}`)}`
			)
			.join('; ') + '\n'
	);
}
