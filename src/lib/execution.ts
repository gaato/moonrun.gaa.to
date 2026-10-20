import type { RunOutcome } from 'moonrun-js/browser';

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
// Added files keep their own name in /work; it must be one plain, printable component.
export function workFilename(name: string): string {
	if (!name || /[\\/\0-\x1f\x7f]/.test(name) || name === '.' || name === '..') {
		throw new Error(`${JSON.stringify(name)} is not a plain filename.`);
	}
	return `/work/${name}`;
}
