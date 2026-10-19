import type {
	MountEntry,
	MountFile,
	MountProvider,
	MountStat
} from 'moonrun-js/browser';
type Failure = Extract<
	Awaited<ReturnType<MountProvider['stat']>>,
	{ ok: false }
>;
type Result<T> = { ok: true; value: T } | Failure;
export type MountCall =
	| { op: 'stat' | 'readdir' | 'open' | 'readlink'; path: string }
	| { op: 'read'; handle: number; offset: number; length: number }
	| { op: 'close'; handle: number };
export type MountValue =
	| MountStat
	| readonly MountEntry[]
	| Uint8Array
	| string
	| undefined
	| { handle: number; size: number };
export type MountReply = Result<MountValue>;
const error = (code: 'EIO' | 'EBADF' | 'EINVAL'): Failure => ({
	ok: false,
	error: { code }
});

// Functions stay on the page thread; only operation data and owned byte ranges cross.
export function mountServer(provider: MountProvider) {
	let next = 0;
	let closed = false;
	const files = new Map<number, MountFile>();
	return {
		async call(request: MountCall): Promise<MountReply> {
			if (closed) return error('EIO');
			try {
				if (request.op === 'stat') return await provider.stat(request.path);
				if (request.op === 'readdir')
					return await provider.readdir(request.path);
				if (request.op === 'readlink')
					return provider.readlink
						? await provider.readlink(request.path)
						: error('EINVAL');
				if (request.op === 'open') {
					const result = await provider.open(request.path);
					if (!result.ok) return result;
					if (closed) {
						result.value.close?.();
						return error('EIO');
					}
					const handle = ++next;
					files.set(handle, result.value);
					return { ok: true, value: { handle, size: result.value.size } };
				}
				if (!('handle' in request)) return error('EINVAL');
				const file = files.get(request.handle);
				if (!file) return error('EBADF');
				if (request.op === 'read')
					return await file.read(request.offset, request.length);
				files.delete(request.handle);
				file.close?.();
				return { ok: true, value: undefined };
			} catch {
				return error('EIO');
			}
		},
		close() {
			closed = true;
			for (const file of files.values()) {
				try {
					file.close?.();
				} catch {
					/* Continue releasing readers. */
				}
			}
			files.clear();
		}
	};
}
export function mountProxy(send: (id: number, request: MountCall) => void) {
	let next = 0;
	const pending = new Map<number, (result: MountReply) => void>();
	function call<T>(request: MountCall): Promise<Result<T>> {
		return new Promise((resolve) => {
			const id = ++next;
			pending.set(id, (value) => resolve(value as Result<T>));
			send(id, request);
		});
	}
	const provider: MountProvider = {
		cache: true,
		stat: (path) => call<MountStat>({ op: 'stat', path }),
		readdir: (path) => call<readonly MountEntry[]>({ op: 'readdir', path }),
		readlink: (path) => call<string>({ op: 'readlink', path }),
		open: async (path) => {
			const result = await call<{ handle: number; size: number }>({
				op: 'open',
				path
			});
			if (!result.ok) return result;
			const { handle, size } = result.value;
			return {
				ok: true,
				value: {
					size,
					read: (offset, length) =>
						call<Uint8Array>({ op: 'read', handle, offset, length }),
					close: () => {
						void call<undefined>({ op: 'close', handle });
					}
				}
			};
		}
	};
	return {
		provider,
		accept(id: number, value: MountReply) {
			pending.get(id)?.(value);
			pending.delete(id);
		}
	};
}
