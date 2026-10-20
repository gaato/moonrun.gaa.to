/// <reference lib="webworker" />
import {
	directoryHandleProvider,
	runInWorker,
	type BrowserRunHandle
} from 'moonrun-js/browser';
import type { ShellRequest, ShellReply } from './protocol';
import { mountProxy } from './mount-bridge';
import { addedPath, folderPath, shellFiles, shellPath } from './work';
import { interruptCommand, ShellActivity } from './interrupt';
import { addedFilesProvider, copyCommand, folderMount } from './local-mounts';
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
const bridge = mountProxy((id, mount, request) =>
	reply({ type: 'mount', id, mount, request })
);
// The folder and added-file providers live here, next to the run.
const folder = folderMount();
const added = new Map<string, Uint8Array>();
let waiting: string[] = [];
let copying: string[] = [];
// Added files are copied by sh itself (cp from the staging mount) at the next idle
// primary prompt, so they land in the memory /work like files sh writes.
function copyAdded() {
	if (!running || !activity.idle) return;
	// The previous copy has finished once sh prompts again.
	for (const name of copying) if (!waiting.includes(name)) added.delete(name);
	copying = [];
	if (!waiting.length) return;
	copying = [...new Set(waiting)];
	waiting = [];
	reply({ type: 'added', names: copying });
	activity.commandStarted();
	void running
		.write(new TextEncoder().encode(copyCommand(copying, addedPath)))
		.catch(() => {});
}
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
		bridge.accept(data.id, data.result);
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
	else if (data.type === 'add') {
		for (const file of data.files) {
			added.set(file.name, file.bytes);
			waiting.push(file.name);
		}
		copyAdded();
	} else if (data.type === 'folder') {
		folder.attach(directoryHandleProvider(data.handle));
	} else if (data.type === 'write') {
		try {
			if (!running) throw new Error('Shell is not running.');
			activity.commandStarted();
			await running.write(data.bytes);
			reply({ type: 'written', id: data.id });
		} catch (error) {
			reply({ type: 'written', id: data.id, error: String(error) });
		}
	} else if (data.type === 'start' && !running) {
		if (data.folder) folder.attach(directoryHandleProvider(data.folder));
		try {
			running = runInWorker({
				wasm: data.wasm,
				name: 'sh',
				args: ['-i'],
				stdin: 'stream',
				cwd: '/work',
				files: {
					...shellFiles,
					...Object.fromEntries(
						(data.files ?? []).map((file) => [`/work/${file.name}`, file.bytes])
					)
				},
				mounts: {
					...Object.fromEntries(
						data.mounts.map((mount) => [mount, bridge.provider(mount)])
					),
					[folderPath]: folder.provider,
					[addedPath]: addedFilesProvider(added)
				},
				env: {
					HOME: '/work',
					PATH: shellPath,
					TERM: 'xterm-256color',
					...activity.environment
				},
				stdout: (bytes) => reply({ type: 'output', bytes }),
				stderr: (bytes) => {
					const visible = activity.stderr(bytes);
					if (visible.length)
						reply({ type: 'output', bytes: visible, prompt: activity.prompt });
					copyAdded();
				},
				// Only names missing from the filesystem PATH reach the page resolver.
				resolveCommand: (name) =>
					new Promise((resolve, reject) => {
						const id = ++next;
						resolutions.set(id, { resolve, reject });
						reply({ type: 'resolve', id, name });
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
