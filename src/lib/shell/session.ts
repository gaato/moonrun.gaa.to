import { mountServer } from './mount-bridge';
import type {
	BrowserDirectoryHandle,
	MountProvider,
	ResolvedCommand,
	RunOutcome
} from 'moonrun-js/browser';
import type { AddedFile, ShellRequest, ShellReply } from './protocol';
export interface SessionOptions {
	wasm: Uint8Array;
	/** Fallback for names the filesystem PATH search does not find (moonx). */
	resolveCommand: (
		name: string,
		args: readonly string[]
	) => Promise<ResolvedCommand | undefined>;
	output: (bytes: Uint8Array, prompt?: '$ ' | '> ') => void;
	/** Called after added files were written into /work (or failed). */
	added?: (names: string[], failures: string[]) => void;
	/** Page-thread providers, bridged into the supervisor Worker. */
	mounts?: Readonly<Record<string, MountProvider>>;
	files?: AddedFile[];
	folder?: BrowserDirectoryHandle;
}
export function startSession({
	wasm,
	resolveCommand,
	output,
	added,
	mounts = {},
	files,
	folder
}: SessionOptions) {
	const worker = new Worker(new URL('./shell.worker.ts', import.meta.url), {
		type: 'module'
	});
	const server = mountServer(mounts);
	let id = 0;
	let closing = false;
	const writes = new Map<
		number,
		{ resolve(): void; reject(error: Error): void }
	>();
	const archives = new Map<
		number,
		{ resolve(bytes: Uint8Array): void; reject(error: Error): void }
	>();
	let finish: (outcome: RunOutcome | undefined) => void;
	let fail: (error: Error) => void;
	const finished = new Promise<RunOutcome | undefined>((resolve, reject) => {
		finish = resolve;
		fail = reject;
	});
	const send = (request: ShellRequest) => worker.postMessage(request);
	function cleanup() {
		closing = true;
		worker.terminate();
		server.close();
		for (const pending of [...writes.values(), ...archives.values()])
			pending.reject(new Error('Shell session ended.'));
		writes.clear();
		archives.clear();
	}
	worker.onmessage = ({ data }: MessageEvent<ShellReply>) => {
		if (data.type === 'stopped') {
			cleanup();
			finish(undefined);
			return;
		}
		if (closing) return;
		if (data.type === 'mount') {
			void server.call(data.mount, data.request).then((result) => {
				if (!closing) send({ type: 'mounted', id: data.id, result });
			});
		} else if (data.type === 'output') output(data.bytes, data.prompt);
		else if (data.type === 'added') added?.(data.names, data.failures);
		else if (data.type === 'archive') {
			const pending = archives.get(data.id);
			archives.delete(data.id);
			if (data.bytes) pending?.resolve(data.bytes);
			else pending?.reject(new Error(data.error ?? 'Download failed.'));
		} else if (data.type === 'written') {
			const pending = writes.get(data.id);
			writes.delete(data.id);
			if (data.error) pending?.reject(new Error(data.error));
			else pending?.resolve();
		} else if (data.type === 'outcome') {
			cleanup();
			finish(data.outcome);
		} else if (data.type === 'error') {
			cleanup();
			fail(new Error(data.message));
		} else if (data.type === 'resolve') {
			void resolveCommand(data.name, data.args).then(
				(command) => {
					if (!closing) send({ type: 'resolved', id: data.id, command });
				},
				() => {
					if (!closing) send({ type: 'resolved', id: data.id, failed: true });
				}
			);
		}
	};
	worker.onerror = (event) => {
		cleanup();
		fail(new Error(event.message || 'Shell Worker failed.'));
	};
	send({
		type: 'start',
		wasm,
		mounts: Object.keys(mounts),
		...(files?.length ? { files } : {}),
		...(folder ? { folder } : {})
	});
	return {
		finished,
		write(bytes: Uint8Array): Promise<void> {
			if (closing) return Promise.reject(new Error('Shell session ended.'));
			const key = ++id;
			return new Promise((resolve, reject) => {
				writes.set(key, { resolve, reject });
				send({ type: 'write', id: key, bytes });
			});
		},
		end() {
			if (!closing) send({ type: 'end' });
		},
		signal(number: number) {
			if (!closing) send({ type: 'signal', number });
		},
		addFiles(files: AddedFile[]) {
			if (!closing) send({ type: 'add', files });
		},
		/** work.zip of the live /work tree. */
		download(): Promise<Uint8Array> {
			if (closing) return Promise.reject(new Error('Shell session ended.'));
			const key = ++id;
			return new Promise((resolve, reject) => {
				archives.set(key, { resolve, reject });
				send({ type: 'download', id: key });
			});
		},
		mountFolder(handle: BrowserDirectoryHandle) {
			if (!closing) send({ type: 'folder', handle });
		},
		get running() {
			return !closing;
		},
		stop() {
			if (!closing) {
				closing = true;
				send({ type: 'stop' });
			}
		}
	};
}
