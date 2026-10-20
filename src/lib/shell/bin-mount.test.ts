import { expect, it, vi } from 'vitest';
import { createBinMount } from './bin-mount';
const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const commands = [
	{ name: 'cli/sh', version: '0.2.1' },
	{ name: 'cli/cat', version: '0.2.1' },
	{ name: 'cli/flaky', version: '1.0.0' }
];
it('lists the commands as /bin/<name> and serves their verified bytes in ranges', async () => {
	let flaky = 0;
	const load = vi.fn(async ({ name }: { name: string }) => {
		if (name === 'cli/flaky' && flaky++ === 0) throw new Error('offline');
		return wasm;
	});
	const bin = createBinMount(commands, load);
	expect(await bin.readdir('/')).toEqual({
		ok: true,
		value: [
			{ name: 'cat', kind: 'file' },
			{ name: 'flaky', kind: 'file' },
			{ name: 'sh', kind: 'file' }
		]
	});
	expect(load).not.toHaveBeenCalled();
	expect(await bin.stat('/')).toEqual({
		ok: true,
		value: { kind: 'dir', mode: 0o555 }
	});
	expect(await bin.stat('/sh')).toEqual({
		ok: true,
		value: { kind: 'file', size: wasm.length, mode: 0o555 }
	});
	const opened = await bin.open('/cat');
	expect(opened.ok).toBe(true);
	if (!opened.ok) return;
	expect(await opened.value.read(4, 100)).toEqual({
		ok: true,
		value: wasm.slice(4)
	});
	expect(await opened.value.read(-1, 1)).toMatchObject({ ok: false });
	// A failed download is EIO (stopping PATH search) and retries on the next use.
	expect(await bin.stat('/flaky')).toEqual({
		ok: false,
		error: { code: 'EIO' }
	});
	expect((await bin.stat('/flaky')).ok).toBe(true);
	expect(load).toHaveBeenCalledWith(commands[1]);
});
it('reports missing names, nested paths and libraries as absent', async () => {
	const bin = createBinMount(commands, async () => undefined);
	for (const path of ['/sh', '/missing'])
		expect(await bin.stat(path)).toEqual({
			ok: false,
			error: { code: 'ENOENT' }
		});
	expect(await bin.stat('/sh/x')).toEqual({
		ok: false,
		error: { code: 'ENOTDIR' }
	});
	expect(await bin.readdir('/sh')).toEqual({
		ok: false,
		error: { code: 'ENOTDIR' }
	});
	expect(await bin.open('/')).toEqual({ ok: false, error: { code: 'EISDIR' } });
	expect(bin.write).toBeUndefined();
	expect(bin.cache).toBe(true);
});
