import { expect, it } from 'vitest';
import { exitStatus, needsNetwork, workFilename } from './execution';
it('labels run outcomes and network limitations without treating all failures as network errors', () => {
	expect(exitStatus({ kind: 'completed' })).toBe('0');
	expect(exitStatus({ kind: 'exited', code: 257 })).toBe('1');
	expect(exitStatus({ kind: 'panicked', message: 'panic' })).toBe('101');
	expect(exitStatus({ kind: 'signaled', signal: 2 })).toBe('signal 2');
	expect(needsNetwork('@net.tcp.connect(): Function not implemented')).toBe(
		true
	);
	expect(needsNetwork('ENOSYS')).toBe(true);
	expect(needsNetwork('division by zero')).toBe(false);
	expect(workFilename('hello.txt')).toBe('/work/hello.txt');
	expect(() => workFilename('../secret')).toThrow();
});
