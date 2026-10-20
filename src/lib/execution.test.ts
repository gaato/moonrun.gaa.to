import { expect, it } from 'vitest';
import { exitStatus, workFilename } from './execution';
it('labels run outcomes', () => {
	expect(exitStatus({ kind: 'completed' })).toBe('0');
	expect(exitStatus({ kind: 'exited', code: 257 })).toBe('1');
	expect(exitStatus({ kind: 'panicked', message: 'panic' })).toBe('101');
	expect(exitStatus({ kind: 'signaled', signal: 2 })).toBe('signal 2');
});
it.each(['../secret', 'a/b', 'a\\b', '.', '..', '', 'line\nbreak', 'tab\t'])(
	'rejects added filename %j',
	(name) => {
		expect(() => workFilename(name)).toThrow('plain filename');
	}
);
it('keeps plain names, including spaces, quotes and Unicode', () => {
	expect(workFilename("it's a 日本語.txt")).toBe("/work/it's a 日本語.txt");
});
