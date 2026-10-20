import { afterEach, expect, it, vi } from 'vitest';
import { createMooncakesMount } from './mooncakes-mount';
import { mountRegistry } from './fixtures/mount-registry';
import { startSession } from './session';
import { createBinMount } from './bin-mount';
import type { BrowserDirectoryHandle } from 'moonrun-js/browser';
import type { ShellReply, ShellRequest } from './protocol';
class FakeWorker {
	static current: FakeWorker;
	sent: ShellRequest[] = [];
	terminated = false;
	onmessage?: (event: { data: ShellReply }) => void;
	onerror?: (event: { message: string }) => void;
	constructor() {
		FakeWorker.current = this;
	}
	postMessage(request: ShellRequest) {
		this.sent.push(request);
	}
	terminate() {
		this.terminated = true;
	}
	emit(data: ShellReply) {
		this.onmessage?.({ data });
	}
}
afterEach(() => vi.unstubAllGlobals());
it('bridges byte input/output, command resolution, signal and EOF to runInWorker supervisor', async () => {
	vi.stubGlobal('Worker', FakeWorker);
	const resolver = vi.fn(async (_name: string) => new Uint8Array([2]));
	const output = vi.fn();
	const added = vi.fn();
	const session = startSession({
		wasm: new Uint8Array([1]),
		resolveCommand: resolver,
		output,
		added
	});
	const worker = FakeWorker.current;
	expect(worker.sent[0]).toEqual({
		type: 'start',
		wasm: new Uint8Array([1]),
		mounts: []
	});
	const writing = session.write(new Uint8Array([3]));
	worker.emit({ type: 'written', id: 1 });
	await writing;
	worker.emit({ type: 'output', bytes: new Uint8Array([4]) });
	expect(output).toHaveBeenCalledWith(new Uint8Array([4]), undefined);
	worker.emit({
		type: 'output',
		bytes: new Uint8Array([62, 32]),
		prompt: '> '
	});
	expect(output).toHaveBeenLastCalledWith(new Uint8Array([62, 32]), '> ');
	worker.emit({ type: 'resolve', id: 2, name: 'cat' });
	await Promise.resolve();
	expect(worker.sent).toContainEqual({
		type: 'resolved',
		id: 2,
		wasm: new Uint8Array([2])
	});
	session.signal(2);
	session.end();
	expect(worker.sent).toContainEqual({ type: 'signal', number: 2 });
	expect(worker.sent).toContainEqual({ type: 'end' });
	const files = [{ name: 'a.txt', bytes: new Uint8Array([5]) }];
	session.addFiles(files);
	expect(worker.sent).toContainEqual({ type: 'add', files });
	worker.emit({ type: 'added', names: ['a.txt'] });
	expect(added).toHaveBeenCalledWith(['a.txt']);
	worker.emit({ type: 'outcome', outcome: { kind: 'completed' } });
	expect(await session.finished).toEqual({ kind: 'completed' });
	expect(worker.terminated).toBe(true);
});
it('stops the supervisor and rejects pending writes when navigation ends the session', async () => {
	vi.stubGlobal('Worker', FakeWorker);
	const session = startSession({
		wasm: new Uint8Array(),
		resolveCommand: async () => undefined,
		output: () => {}
	});
	const writing = session.write(new Uint8Array([1]));
	const rejected = expect(writing).rejects.toThrow('ended');
	session.stop();
	expect(FakeWorker.current.sent.at(-1)).toEqual({ type: 'stop' });
	FakeWorker.current.emit({ type: 'stopped' });
	expect(await session.finished).toBeUndefined();
	await rejected;
	expect(FakeWorker.current.terminated).toBe(true);
});

it('keeps providers on the page thread per mount point and forwards files and the folder handle', async () => {
	vi.stubGlobal('Worker', FakeWorker);
	const r = mountRegistry();
	const mount = createMooncakesMount({ fetcher: r.fetcher });
	const bin = createBinMount(
		[{ name: 'cli/sh', version: '0.2.1' }],
		async () => new Uint8Array([0, 97, 115, 109])
	);
	const resolve = vi.fn(async (_name: string) => undefined);
	const folder = {
		kind: 'directory',
		name: 'picked'
	} as BrowserDirectoryHandle;
	const files = [{ name: 'prog.wasm', bytes: new Uint8Array([0, 97]) }];
	const session = startSession({
		wasm: new Uint8Array(),
		resolveCommand: resolve,
		output: () => {},
		mounts: { '/bin': bin, '/mooncakes': mount },
		files,
		folder
	});
	const worker = FakeWorker.current;
	expect(worker.sent[0]).toEqual({
		type: 'start',
		wasm: new Uint8Array(),
		mounts: ['/bin', '/mooncakes'],
		files,
		folder
	});
	worker.emit({
		type: 'mount',
		id: 10,
		mount: '/mooncakes',
		request: { op: 'readdir', path: '/' }
	});
	worker.emit({
		type: 'mount',
		id: 11,
		mount: '/bin',
		request: { op: 'readdir', path: '/' }
	});
	await vi.waitFor(() => {
		expect(worker.sent).toContainEqual({
			type: 'mounted',
			id: 10,
			result: {
				ok: true,
				value: [
					{ name: 'Yoorkin', kind: 'dir' },
					{ name: 'cli', kind: 'dir' },
					{ name: 'gaato', kind: 'dir' }
				]
			}
		});
		expect(worker.sent).toContainEqual({
			type: 'mounted',
			id: 11,
			result: { ok: true, value: [{ name: 'sh', kind: 'file' }] }
		});
	});
	worker.emit({ type: 'resolve', id: 12, name: 'cowsay' });
	expect(resolve).toHaveBeenCalledWith('cowsay');
	const handle = { kind: 'directory', name: 'other' } as BrowserDirectoryHandle;
	session.mountFolder(handle);
	expect(worker.sent.at(-1)).toEqual({ type: 'folder', handle });
	worker.emit({ type: 'outcome', outcome: { kind: 'completed' } });
	await session.finished;
	expect(session.running).toBe(false);
});
