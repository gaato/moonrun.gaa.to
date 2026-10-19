import type { RunOutcome } from 'moonrun-js/browser';
export type ShellRequest =
	| { type: 'start'; wasm: Uint8Array }
	| { type: 'write'; id: number; bytes: Uint8Array }
	| { type: 'end' | 'stop' }
	| { type: 'signal'; number: number }
	| { type: 'resolved'; id: number; wasm?: Uint8Array; failed?: boolean };
export type ShellReply =
	| { type: 'output'; bytes: Uint8Array }
	| { type: 'resolve'; id: number; name: string }
	| { type: 'written'; id: number; error?: string }
	| { type: 'outcome'; outcome: RunOutcome }
	| { type: 'error'; message: string }
	| { type: 'stopped' };
