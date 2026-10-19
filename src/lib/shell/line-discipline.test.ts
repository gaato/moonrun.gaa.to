import { expect, it, vi } from 'vitest';
import { LineDiscipline } from './line-discipline';
function setup() {
	const sink = {
		echo: vi.fn(),
		write: vi.fn(async (_bytes: Uint8Array) => {}),
		signal: vi.fn(),
		end: vi.fn(),
		error: vi.fn()
	};
	return { sink, input: new LineDiscipline(sink) };
}
it('echoes locally, edits with backspace and sends a UTF-8 line only on Enter', async () => {
	const { sink, input } = setup();
	input.input('catx\x7f');
	expect(input.line).toBe('cat');
	expect(sink.write).not.toHaveBeenCalled();
	input.input('\r');
	await input.flush();
	expect(sink.echo.mock.calls.map(([s]) => s).join('')).toBe('catx\b \b\r\n');
	expect(new TextDecoder().decode(sink.write.mock.calls[0][0])).toBe('cat\n');
});
it('preserves multibyte input and erases whole graphemes using display columns', async () => {
	const { sink, input } = setup();
	input.input('é日本😀\x7f\x7f');
	expect(input.line).toBe('é日');
	input.input('e\u0301\x7f\r');
	await input.flush();
	expect(sink.write.mock.calls[0][0]).toEqual(
		new TextEncoder().encode('é日\n')
	);
	expect(sink.echo.mock.calls.filter(([s]) => s === '\b \b\b \b')).toHaveLength(
		2
	);
});
it('signals SIGINT, clears the line, and does not submit it', async () => {
	const { sink, input } = setup();
	input.input('unfinished\x03');
	expect(input.line).toBe('');
	expect(sink.signal).toHaveBeenCalledWith(2);
	expect(sink.echo).toHaveBeenLastCalledWith('^C\r\n');
	await input.flush();
	expect(sink.write).not.toHaveBeenCalled();
});
it('ends stdin only for Ctrl+D on an empty line, after queued writes', async () => {
	const { sink, input } = setup();
	input.input('a\x04');
	expect(sink.end).not.toHaveBeenCalled();
	input.input('\r\x04ignored');
	await input.flush();
	expect(input.ended).toBe(true);
	expect(sink.write).toHaveBeenCalledOnce();
	expect(sink.end).toHaveBeenCalledOnce();
	expect(sink.write.mock.invocationCallOrder[0]).toBeLessThan(
		sink.end.mock.invocationCallOrder[0]
	);
});
it('handles multiline paste, CRLF and split escape sequences without inserting cursor codes', async () => {
	const { sink, input } = setup();
	input.input('\x1b[');
	input.input('Aone\r\ntwo\n');
	await input.flush();
	expect(
		sink.write.mock.calls.map(([b]) => new TextDecoder().decode(b))
	).toEqual(['one\n', 'two\n']);
});
