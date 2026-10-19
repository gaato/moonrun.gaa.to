import type { BrowserRunHandle } from 'moonrun-js/browser';
export function interruptCommand(
	handle: Pick<BrowserRunHandle, 'signal'>,
	commandRunning: boolean
): void {
	// Replace this call with the child-only signal API once moonrun-js ships it.
	if (commandRunning) handle.signal(2);
}

// cli/sh writes PS1/PS2 to stderr when returning to read_line. A per-session
// marker distinguishes those prompts from ordinary guest output such as "$ ".
export class ShellActivity {
	running = false;
	readonly environment: { PS1: string; PS2: string };
	private marker: string;
	private pending = '';
	constructor(token: string) {
		this.marker = `\x1b]playground-prompt;${token}\x07`;
		this.environment = { PS1: this.marker + '$ ', PS2: this.marker + '> ' };
	}
	commandStarted(): void {
		this.running = true;
	}
	stderr(bytes: Uint8Array): Uint8Array {
		const output: number[] = [];
		for (const byte of bytes) {
			this.pending += String.fromCharCode(byte);
			while (this.pending && !this.marker.startsWith(this.pending)) {
				output.push(this.pending.charCodeAt(0));
				this.pending = this.pending.slice(1);
			}
			if (this.pending === this.marker) {
				this.pending = '';
				this.running = false;
			}
		}
		return new Uint8Array(output);
	}
	finish(): Uint8Array {
		const tail = Uint8Array.from(this.pending, (char) => char.charCodeAt(0));
		this.pending = '';
		return tail;
	}
}
