import type { MountCall, MountReply } from './mount-bridge';
import type { RunOutcome } from 'moonrun-js/browser';
export type ShellRequest =
	| { type: 'start'; wasm: Uint8Array; mount?: boolean }
	| { type: 'write'; id: number; bytes: Uint8Array }
	| { type: 'end' | 'stop' }
	| { type: 'signal'; number: number }
	| { type: 'mounted'; id: number; result: MountReply }
	| { type: 'resolved'; id: number; wasm?: Uint8Array; failed?: boolean };
export type ShellReply =
	| { type: 'mount'; id: number; request: MountCall }
	| { type: 'output'; bytes: Uint8Array; prompt?: '$ ' | '> ' }
	| { type: 'resolve'; id: number; name: string; cwd?: string }
	| { type: 'written'; id: number; error?: string }
	| { type: 'outcome'; outcome: RunOutcome }
	| { type: 'error'; message: string }
	| { type: 'stopped' };
