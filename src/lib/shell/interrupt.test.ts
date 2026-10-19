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
	interruptCommand(handle, activity.running);
	expect(handle.signal).toHaveBeenCalledTimes(1);
});
it('does not confuse guest prompt-looking output with the session prompt and preserves UTF-8', () => {
	const activity = new ShellActivity('test');
	activity.commandStarted();
	const ordinary = new TextEncoder().encode('$ 日本語 > ');
	expect(activity.stderr(ordinary)).toEqual(ordinary);
	expect(activity.running).toBe(true);
	expect(
		new TextDecoder().decode(
			activity.stderr(new TextEncoder().encode(activity.environment.PS2))
		)
	).toBe('> ');
	expect(activity.running).toBe(false);
	const partial = new TextEncoder().encode('\x1b]play');
	expect(activity.stderr(partial)).toHaveLength(0);
	expect(activity.finish()).toEqual(partial);
});
