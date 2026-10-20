import { expect, it, vi } from 'vitest';
import { interruptCommand, ShellActivity } from './interrupt';
import { LineDiscipline } from './line-discipline';
it('clears and echoes Ctrl+C locally while idle without signaling sh', async () => {
	const handle = { signal: vi.fn() };
	const activity = new ShellActivity('test');
	const echo = vi.fn();
	const write = vi.fn(async (_bytes: Uint8Array) => {});
	const input = new LineDiscipline({
		echo,
		clear() {},
		write,
		signal: () => interruptCommand(handle, activity.running),
		end() {},
		error() {}
	});
	input.input('unfinished\x03');
	await input.flush();
	expect(input.line).toBe('');
	expect(echo).toHaveBeenLastCalledWith('^C\r\n');
	expect(write).not.toHaveBeenCalled();
	expect(handle.signal).not.toHaveBeenCalled();
});
it('signals a running command through the isolated compatibility function, then stops signaling at a prompt', () => {
	const handle = { signal: vi.fn() };
	const activity = new ShellActivity('test');
	activity.commandStarted();
	interruptCommand(handle, activity.running);
	expect(handle.signal).toHaveBeenCalledExactlyOnceWith(2);
	const bytes = new TextEncoder().encode(activity.environment.PS1);
	const visible = [
		...activity.stderr(bytes.subarray(0, 8)),
		...activity.stderr(bytes.subarray(8))
	];
	expect(new TextDecoder().decode(new Uint8Array(visible))).toBe('$ ');
	expect(activity.running).toBe(false);
	expect(activity.prompt).toBe('$ ');
	interruptCommand(handle, activity.running);
	expect(handle.signal).toHaveBeenCalledTimes(1);
});
it('does not confuse guest prompt-looking output with the session prompt and preserves UTF-8', () => {
	const activity = new ShellActivity('test');
	activity.commandStarted();
	const ordinary = new TextEncoder().encode('$ 日本語 > ');
	expect(activity.stderr(ordinary)).toEqual(ordinary);
	expect(activity.prompt).toBe('$ ');
	expect(activity.running).toBe(true);
	expect(
		new TextDecoder().decode(
			activity.stderr(new TextEncoder().encode(activity.environment.PS2))
		)
	).toBe('> ');
	expect(activity.running).toBe(false);
	expect(activity.prompt).toBe('> ');
	activity.stderr(new TextEncoder().encode('$ '));
	expect(activity.prompt).toBe('> ');
	const partial = new TextEncoder().encode('\x1b]shel');
	expect(activity.stderr(partial)).toHaveLength(0);
	expect(activity.finish()).toEqual(partial);
});

it('tracks primary and continuation prompts even when the marker is split byte by byte', () => {
	const activity = new ShellActivity('prompt');
	for (const key of ['PS2', 'PS1'] as const) {
		const visible: number[] = [];
		for (const byte of new TextEncoder().encode(activity.environment[key]))
			visible.push(...activity.stderr(new Uint8Array([byte])));
		const expected = key === 'PS2' ? '> ' : '$ ';
		expect(activity.prompt).toBe(expected);
		expect(new TextDecoder().decode(new Uint8Array(visible))).toBe(expected);
	}
});
