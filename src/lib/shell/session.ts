import type { RunOutcome } from 'moonrun-js/browser';
import type { ShellRequest, ShellReply } from './protocol';
export function startSession(
	wasm: Uint8Array,
	resolveCommand: (name: string) => Promise<Uint8Array | undefined>,
	output: (bytes: Uint8Array) => void
) {
	const worker = new Worker(new URL('./shell.worker.ts', import.meta.url), {
		type: 'module'
	});
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
		if (data.type === 'output') output(data.bytes);
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
			void resolveCommand(data.name).then(
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
	send({ type: 'start', wasm });
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
