import type {
	MountEntry,
	MountFile,
	MountProvider,
	MountStat
} from 'moonrun-js/browser';
import { commandName, type CliModule } from '../cli-index';
import type { CommandLoader } from './commands';

type Code = 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EIO' | 'EINVAL';
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: Code } };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: Code): Result<never> => ({ ok: false, error: { code } });

// /bin lists one executable per command; bytes load (and retry) on first use.
export function createBinMount(
	commands: readonly CliModule[],
	load: CommandLoader
): MountProvider {
	const entries = new Map(commands.map((entry) => [commandName(entry), entry]));
	const listing: MountEntry[] = [...entries.keys()]
		.sort()
		.map((name) => ({ name, kind: 'file' }));
	async function bytes(path: string): Promise<Result<Uint8Array>> {
		const entry = entries.get(path.slice(1));
		if (!entry) return fail(path.indexOf('/', 1) > 0 ? 'ENOTDIR' : 'ENOENT');
		try {
			const wasm = await load(entry);
			return wasm ? ok(wasm) : fail('ENOENT');
		} catch {
			return fail('EIO');
		}
	}
	return {
		cache: true,
		async stat(path) {
			if (path === '/') return ok<MountStat>({ kind: 'dir', mode: 0o555 });
			const wasm = await bytes(path);
			return wasm.ok
				? ok<MountStat>({ kind: 'file', size: wasm.value.length, mode: 0o555 })
				: wasm;
		},
		async readdir(path) {
			if (path === '/') return ok(listing);
			return fail(entries.has(path.slice(1)) ? 'ENOTDIR' : 'ENOENT');
		},
		async open(path) {
			if (path === '/') return fail('EISDIR');
			const wasm = await bytes(path);
			if (!wasm.ok) return wasm;
			return ok<MountFile>({
				size: wasm.value.length,
				read: async (offset, length) =>
					Number.isSafeInteger(offset) &&
					offset >= 0 &&
					Number.isSafeInteger(length) &&
					length >= 0
						? ok(wasm.value.slice(offset, offset + length))
						: fail('EINVAL')
			});
		}
	};
}
