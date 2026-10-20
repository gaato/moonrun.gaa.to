import type { MountCall, MountReply } from './mount-bridge';
import type { BrowserDirectoryHandle, RunOutcome } from 'moonrun-js/browser';
export interface AddedFile {
	name: string;
	bytes: Uint8Array;
}
export type ShellRequest =
	| {
			type: 'start';
			wasm: Uint8Array;
			/** Mount points served by page-thread providers through the bridge. */
			mounts: string[];
			/** Files added before the session started go straight into /work. */
			files?: AddedFile[];
			folder?: BrowserDirectoryHandle;
	  }
	| { type: 'write'; id: number; bytes: Uint8Array }
	| { type: 'end' | 'stop' }
	| { type: 'signal'; number: number }
	| { type: 'add'; files: AddedFile[] }
	| { type: 'folder'; handle: BrowserDirectoryHandle }
	| { type: 'mounted'; id: number; result: MountReply }
	| { type: 'resolved'; id: number; wasm?: Uint8Array; failed?: boolean };
export type ShellReply =
	| { type: 'mount'; id: number; mount: string; request: MountCall }
	| { type: 'output'; bytes: Uint8Array; prompt?: '$ ' | '> ' }
	| { type: 'resolve'; id: number; name: string }
	| { type: 'added'; names: string[] }
	| { type: 'written'; id: number; error?: string }
	| { type: 'outcome'; outcome: RunOutcome }
	| { type: 'error'; message: string }
	| { type: 'stopped' };
