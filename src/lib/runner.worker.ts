/// <reference lib="webworker" />
import { runInWorker } from 'moonrun-js/browser';
import type { RunRequest, WorkerReply } from './execution';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const children = new Set<Worker>();
// The current browser API has no terminate handle. Track its dedicated Worker only
// in this supervisor's global scope, so Stop can kill even a non-yielding guest.
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
const reply = (message: WorkerReply) => scope.postMessage(message);
let started = false;
scope.onmessage = async ({
	data
}: MessageEvent<{ type: 'run'; request: RunRequest } | { type: 'stop' }>) => {
	if (data.type === 'stop') {
		for (const child of children) child.terminate();
		reply({ type: 'stopped' });
		scope.close();
		return;
	}
	if (started) return;
	started = true;
	try {
		const outcome = await runInWorker({
			...data.request,
			cwd: '/work',
			env: {},
			stdout: (bytes) => reply({ type: 'stdout', bytes }),
			stderr: (bytes) => reply({ type: 'stderr', bytes })
		});
		reply({ type: 'outcome', outcome });
	} catch (error) {
		reply({
			type: 'error',
			message: error instanceof Error ? error.message : String(error)
		});
	}
};
