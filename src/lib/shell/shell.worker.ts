/// <reference lib="webworker" />
import {
	directoryHandleProvider,
	runInWorker,
	type BrowserRunHandle
} from 'moonrun-js/browser';
import type { AddedFile, ShellRequest, ShellReply } from './protocol';
import { mountProxy } from './mount-bridge';
import { folderPath, shellFiles, shellPath } from './work';
import { interruptCommand, ShellActivity } from './interrupt';
import { folderMount } from './folder-mount';
import { archiveTree } from './work-archive';
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
// The folder provider lives here, next to the run.
const folder = folderMount();
// Added files go straight into the live memory /work; an existing file is replaced.
async function addFiles(files: AddedFile[]) {
	const names: string[] = [];
	const failures: string[] = [];
	for (const file of files) {
		try {
			if (!running) throw new Error('Shell is not running.');
			await running.fs.writeFile(`/work/${file.name}`, file.bytes);
			names.push(file.name);
		} catch (error) {
			failures.push(
				`${file.name}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	reply({ type: 'added', names, failures });
}
async function download(id: number) {
	try {
		if (!running) throw new Error('Shell is not running.');
		const bytes = await archiveTree(running.fs);
		scope.postMessage({ type: 'archive', id, bytes } satisfies ShellReply, [
			bytes.buffer
		]);
	} catch (error) {
		reply({
			type: 'archive',
			id,
			error: error instanceof Error ? error.message : String(error)
		});
	}
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
	else if (data.type === 'add') void addFiles(data.files);
	else if (data.type === 'download') void download(data.id);
	else if (data.type === 'folder') {
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
					[folderPath]: folder.provider
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
