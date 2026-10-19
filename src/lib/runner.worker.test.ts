import { afterEach, expect, it, vi } from 'vitest';
import type { WorkerReply } from './execution';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('moonrun-js/browser');
	vi.resetModules();
});
it('supervises runInWorker output and forcibly terminates a pending guest on Stop', async () => {
	const children: { terminated: boolean }[] = [];
	class FakeWorker {
		terminated = false;
		constructor() {
			children.push(this);
		}
		terminate() {
			this.terminated = true;
		}
	}
	const messages: WorkerReply[] = [];
	const scope = {
		postMessage: (message: WorkerReply) => messages.push(message),
		close: vi.fn(),
		onmessage: undefined as unknown as (event: {
			data: unknown;
		}) => Promise<void>
	};
	vi.stubGlobal('self', scope);
	vi.stubGlobal('Worker', FakeWorker);
	const runInWorker = vi.fn(
		(options: {
			stdout(bytes: Uint8Array): void;
			stderr(bytes: Uint8Array): void;
		}) => {
			new globalThis.Worker('guest.js');
			options.stdout(new TextEncoder().encode('hello'));
			options.stderr(new TextEncoder().encode('error'));
			return new Promise(() => {}); // A guest that never yields or finishes.
		}
	);
	vi.doMock('moonrun-js/browser', () => ({ runInWorker }));
	await import('./runner.worker');
	void scope.onmessage({
		data: { type: 'run', request: { wasm: new Uint8Array(), args: [] } }
	});
	expect(runInWorker).toHaveBeenCalledOnce();
	expect(messages.map((message) => message.type)).toEqual(['stdout', 'stderr']);
	await scope.onmessage({ data: { type: 'stop' } });
	expect(children[0].terminated).toBe(true);
	expect(messages.at(-1)).toEqual({ type: 'stopped' });
	expect(scope.close).toHaveBeenCalledOnce();
});
