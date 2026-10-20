import { mountServer } from './mount-bridge';
import type { MountProvider, RunOutcome } from 'moonrun-js/browser';
import type { ShellRequest, ShellReply } from './protocol';
export function startSession(
	wasm: Uint8Array,
	resolveCommand: (
		name: string,
		cwd?: string
	) => Promise<Uint8Array | undefined>,
	output: (bytes: Uint8Array, prompt?: '$ ' | '> ') => void,
	mount?: MountProvider
) {
	const worker = new Worker(new URL('./shell.worker.ts', import.meta.url), {
		type: 'module'
	});
	const server = mount ? mountServer(mount) : undefined;
	let id = 0;
	let closing = false;
	const writes = new Map<
		number,
		{ resolve(): void; reject(error: Error): void }
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
		server?.close();
		for (const pending of writes.values())
			pending.reject(new Error('Shell session ended.'));
		writes.clear();
	}
	worker.onmessage = ({ data }: MessageEvent<ShellReply>) => {
		if (data.type === 'stopped') {
			cleanup();
			finish(undefined);
			return;
		}
		if (closing) return;
		if (data.type === 'mount') {
			void (
				server?.call(data.request) ??
				Promise.resolve({ ok: false as const, error: { code: 'EIO' as const } })
			).then((result) => {
				if (!closing) send({ type: 'mounted', id: data.id, result });
			});
		} else if (data.type === 'output') output(data.bytes, data.prompt);
		else if (data.type === 'written') {
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
			void resolveCommand(data.name, data.cwd).then(
				(bytes) => {
					if (!closing) send({ type: 'resolved', id: data.id, wasm: bytes });
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
	send({ type: 'start', wasm, ...(mount ? { mount: true } : {}) });
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
		stop() {
			if (!closing) {
				closing = true;
				send({ type: 'stop' });
			}
		}
	};
}
