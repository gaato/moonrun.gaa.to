export function interruptCommand(
	handle: { signal(number: number): void },
	commandRunning: boolean
): void {
	// Replace this call with the child-only signal API once moonrun-js ships it.
	if (commandRunning) handle.signal(2);
}

// cli/sh writes PS1/PS2 to stderr when returning to read_line. A per-session
// marker distinguishes those prompts from ordinary guest output such as "$ ".
export class ShellActivity {
	// Set when input reaches sh; cleared when sh prompts again. Filesystem PATH
	// lookups no longer pass through the resolver, so input is the observable start.
	running = false;
	readonly environment: { PS1: string; PS2: string };
	prompt: '$ ' | '> ' = '$ ';
	private markers: Map<string, '$ ' | '> '>;
	private pending = '';
	constructor(token: string) {
		const primary = `\x1b]shell-prompt;${token};1\x07`;
		const continuation = `\x1b]shell-prompt;${token};2\x07`;
		this.markers = new Map([
			[primary, '$ '],
			[continuation, '> ']
		]);
		this.environment = { PS1: primary + '$ ', PS2: continuation + '> ' };
	}
	commandStarted(): void {
		this.running = true;
	}
	stderr(bytes: Uint8Array): Uint8Array {
		const output: number[] = [];
		for (const byte of bytes) {
			this.pending += String.fromCharCode(byte);
			while (
				this.pending &&
				![...this.markers.keys()].some((marker) =>
					marker.startsWith(this.pending)
				)
			) {
				output.push(this.pending.charCodeAt(0));
				this.pending = this.pending.slice(1);
			}
			const prompt = this.markers.get(this.pending);
			if (prompt) {
				this.prompt = prompt;
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
