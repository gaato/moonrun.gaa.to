import type { MountEntry, MountProvider, MountStat } from 'moonrun-js/browser';

type Code = 'ENOENT' | 'EISDIR' | 'EROFS';
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: Code } };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: Code): Result<never> => ({ ok: false, error: { code } });

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
