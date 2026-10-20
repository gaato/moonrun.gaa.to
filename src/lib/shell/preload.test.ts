import { expect, it, vi } from 'vitest';
import { preloadCommands, type PreloadProgress } from './preload';
const index = Array.from({ length: 9 }, (_, i) => ({
	name: `cli/cmd${i}`,
	version: '1.0.0'
}));

it('limits concurrency to six, reports verified byte progress, and waits for every completion', async () => {
	const pending: (() => void)[] = [];
	const load = vi.fn(
		(_entry: { name: string }) =>
			new Promise<Uint8Array>((resolve) =>
				pending.push(() => resolve(new Uint8Array(10)))
			)
	);
	const progress: PreloadProgress[] = [];
	let ready = false;
	const preparing = preloadCommands(index, load, {
		onProgress: (p) => progress.push(p)
	}).then(() => {
		ready = true;
	});
	expect(load).toHaveBeenCalledTimes(6);
	expect(progress).toEqual([{ completed: 0, total: 9, bytes: 0 }]);
	for (let i = 0; i < index.length; i++) {
		expect(ready).toBe(false);
		pending[i]();
		await vi.waitFor(() => expect(progress.at(-1)?.completed).toBe(i + 1));
		expect(load.mock.calls.length - i - 1).toBeLessThanOrEqual(6);
	}
	await preparing;
	expect(ready).toBe(true);
	expect(progress.map((p) => p.completed)).toEqual([
		0, 1, 2, 3, 4, 5, 6, 7, 8, 9
	]);
	expect(progress.at(-1)).toEqual({ completed: 9, total: 9, bytes: 90 });
});
it('silently excludes absent executables from commands and progress while reporting other failures', async () => {
	const onFailure = vi.fn();
	const onProgress = vi.fn();
	const commands = await preloadCommands(
		index.slice(0, 3),
		async ({ name }) => {
			if (name === 'cli/cmd0') throw new Error('offline');
			return name === 'cli/cmd1' ? undefined : new Uint8Array(12);
		},
		{ onFailure, onProgress }
	);
	expect(onFailure).toHaveBeenCalledTimes(1);
	expect(onFailure.mock.calls.map(([entry]) => entry.name).sort()).toEqual([
		'cli/cmd0'
	]);
	expect(onProgress).toHaveBeenLastCalledWith({
		completed: 2,
		total: 2,
		bytes: 12
	});
	expect(commands).toEqual([index[0], index[2]]);
});
it('aborts startup without reporting cancellation as individual download failures', async () => {
	const controller = new AbortController();
	const onFailure = vi.fn();
	const onProgress = vi.fn();
	const load = vi.fn(async () => {
		controller.abort();
		throw controller.signal.reason;
	});
	await expect(
		preloadCommands(index, load, {
			signal: controller.signal,
			onFailure,
			onProgress
		})
	).rejects.toThrow();
	expect(onFailure).not.toHaveBeenCalled();
	expect(onProgress).toHaveBeenCalledOnce();
});

it('finishes an index of libraries silently with zero commands', async () => {
	const onFailure = vi.fn();
	const onProgress = vi.fn();
	expect(
		await preloadCommands(index, async () => undefined, {
			onFailure,
			onProgress
		})
	).toEqual([]);
	expect(onFailure).not.toHaveBeenCalled();
	expect(onProgress).toHaveBeenLastCalledWith({
		completed: 0,
		total: 0,
		bytes: 0
	});
});
