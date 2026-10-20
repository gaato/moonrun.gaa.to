interface InputSink {
	echo(text: string): void;
	clear(line?: string): void;
	write(bytes: Uint8Array): Promise<void>;
	signal(number: number): void;
	end(): void;
	error(error: unknown): void;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function columns(text: string): number {
	const cp = text.codePointAt(0)!;
	if (
		/\p{Extended_Pictographic}/u.test(text) ||
		(cp >= 0x1100 &&
			(cp <= 0x115f ||
				cp === 0x2329 ||
				cp === 0x232a ||
				(cp >= 0x2e80 && cp <= 0xa4cf) ||
				(cp >= 0xac00 && cp <= 0xd7a3) ||
				(cp >= 0xf900 && cp <= 0xfaff) ||
				(cp >= 0xfe10 && cp <= 0xfe6f) ||
				(cp >= 0xff01 && cp <= 0xff60) ||
				(cp >= 0xffe0 && cp <= 0xffe6) ||
				cp >= 0x20000))
	)
		return 2;
	return /^\p{Mark}+$/u.test(text) ? 0 : 1;
}
export class LineDiscipline {
	line = '';
	ended = false;
	private tail = Promise.resolve();
	private escape = '';
	private carriage = false;
	constructor(private sink: InputSink) {}
	flush(): Promise<void> {
		return this.tail;
	}
	input(data: string): void {
		for (const char of data) {
			if (this.ended) return;
			if (this.escape) {
				if (this.escape === '\x1b' && (char === '[' || char === 'O'))
					this.escape += char;
				else if (this.escape === '\x1b' || /[@-~]/.test(char)) this.escape = '';
				continue;
			}
			if (char === '\x1b') {
				this.escape = char;
				continue;
			}
			if (char === '\n' && this.carriage) {
				this.carriage = false;
				continue;
			}
			this.carriage = char === '\r';
			if (char === '\r' || char === '\n') {
				const clear = this.line.trim() === 'clear';
				const bytes = new TextEncoder().encode((clear ? '' : this.line) + '\n');
				this.line = '';
				if (clear) this.sink.clear();
				else this.sink.echo('\r\n');
				this.tail = this.tail
					.then(() => this.sink.write(bytes))
					.catch((error) => {
						this.ended = true;
						this.sink.error(error);
					});
			} else if (char === '\x0c') {
				this.sink.clear(this.line);
			} else if (char === '\x03') {
				this.line = '';
				this.sink.echo('^C\r\n');
				this.sink.signal(2);
			} else if (char === '\x04') {
				if (!this.line) {
					this.ended = true;
					this.tail = this.tail.then(() => this.sink.end());
				}
			} else if (char === '\x7f' || char === '\b') {
				const last = [...graphemes.segment(this.line)].at(-1);
				if (last) {
					this.line = this.line.slice(0, last.index);
					this.sink.echo('\b \b'.repeat(columns(last.segment)));
				}
			} else if (char >= ' ') {
				this.line += char;
				this.sink.echo(char);
			}
		}
	}
}
