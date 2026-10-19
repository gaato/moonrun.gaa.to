import type { RunOutcome, BrowserFiles } from 'moonrun-js/browser';
export interface RunRequest {
	wasm: Uint8Array;
	name: string;
	args: string[];
	stdin: Uint8Array;
	files: BrowserFiles;
}
export type WorkerReply =
	| { type: 'stdout' | 'stderr'; bytes: Uint8Array }
	| { type: 'outcome'; outcome: RunOutcome }
	| { type: 'error'; message: string }
	| { type: 'stopped' };

export function exitStatus(outcome: RunOutcome): string {
	switch (outcome.kind) {
		case 'completed':
			return '0';
		case 'exited':
			return String(outcome.code & 255);
		case 'signaled':
			return `signal ${outcome.signal}`;
		case 'panicked':
			return '101';
		default:
			return '1';
	}
}
export function needsNetwork(diagnostic: string): boolean {
	return /network|socket|\b(?:tcp|udp|dns|ENOSYS|ENETUNREACH|EHOSTUNREACH)\b|Function not implemented|@(?:http|net)[./]/i.test(
		diagnostic
	);
}
export function workFilename(name: string): string {
	if (!name || /[\\/\0]/.test(name) || name === '.' || name === '..') {
		throw new Error('Files must have plain filenames.');
	}
	return `/work/${name}`;
}
