/// <reference lib="webworker" />
import { runInWorker, type BrowserRunHandle } from 'moonrun-js/browser';
import type { ShellRequest, ShellReply } from './protocol';
import { mountProxy } from './mount-bridge';
import { shellFiles } from './work';
import { interruptCommand, ShellActivity } from './interrupt';
const scope = self as unknown as DedicatedWorkerGlobalScope;
const children = new Set<Worker>();
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
	constructor(url: string | URL, options?: WorkerOptions) {
		super(url, options);
		children.add(this);
	}
	override terminate() {
		children.delete(this);
		super.terminate();
	}
};
const reply = (data: ShellReply) => scope.postMessage(data);
let running: BrowserRunHandle | undefined;
const activity = new ShellActivity(crypto.randomUUID());
const mount = mountProxy((id, request) =>
	reply({ type: 'mount', id, request })
);
let next = 0;
const resolutions = new Map<
	number,
	{ resolve(value: Uint8Array | undefined): void; reject(error: Error): void }
>();
scope.onmessage = async ({ data }: MessageEvent<ShellRequest>) => {
	if (data.type === 'stop') {
		for (const child of children) child.terminate();
		reply({ type: 'stopped' });
		scope.close();
	} else if (data.type === 'mounted') {
		mount.accept(data.id, data.result);
	} else if (data.type === 'resolved') {
		const pending = resolutions.get(data.id);
		resolutions.delete(data.id);
		if (data.failed) pending?.reject(new Error('Command download failed.'));
		else pending?.resolve(data.wasm);
	} else if (data.type === 'signal') {
		if (running && data.number === 2)
			interruptCommand(running, activity.running);
		else running?.signal(data.number);
	} else if (data.type === 'end') running?.end();
	else if (data.type === 'write') {
		try {
			if (!running) throw new Error('Shell is not running.');
			await running.write(data.bytes);
			reply({ type: 'written', id: data.id });
		} catch (error) {
			reply({ type: 'written', id: data.id, error: String(error) });
		}
	} else if (data.type === 'start' && !running) {
		try {
			running = runInWorker({
				wasm: data.wasm,
				name: 'sh',
				args: ['-i'],
				stdin: 'stream',
				cwd: '/work',
				files: shellFiles,
				mounts: data.mount ? { '/mooncakes': mount.provider } : {},
				env: { HOME: '/work', TERM: 'xterm-256color', ...activity.environment },
				stdout: (bytes) => reply({ type: 'output', bytes }),
				stderr: (bytes) => {
					const visible = activity.stderr(bytes);
					if (visible.length)
						reply({ type: 'output', bytes: visible, prompt: activity.prompt });
				},
				resolveCommand: (name, _args, context) =>
					new Promise((resolve, reject) => {
						activity.commandStarted();
						const id = ++next;
						resolutions.set(id, { resolve, reject });
						reply({ type: 'resolve', id, name, cwd: context.cwd });
					})
			});
			const outcome = await running;
			const tail = activity.finish();
			if (tail.length) reply({ type: 'output', bytes: tail });
			reply({ type: 'outcome', outcome });
		} catch (error) {
			reply({ type: 'error', message: String(error) });
		}
	}
};
