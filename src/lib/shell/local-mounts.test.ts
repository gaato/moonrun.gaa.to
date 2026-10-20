import { expect, it, vi } from 'vitest';
import type { MountProvider } from 'moonrun-js/browser';
import { addedFilesProvider, copyCommand, folderMount } from './local-mounts';
it('stages added files read-only and uncached, reflecting later additions', async () => {
	const files = new Map([['a.txt', new Uint8Array([1, 2, 3])]]);
	const staged = addedFilesProvider(files);
	expect(staged.cache).toBe(false);
	expect(await staged.readdir('/')).toEqual({
		ok: true,
		value: [{ name: 'a.txt', kind: 'file' }]
	});
	files.set('b.wasm', new Uint8Array([0]));
	expect(await staged.stat('/b.wasm')).toEqual({
		ok: true,
		value: { kind: 'file', size: 1, mode: 0o444 }
	});
	const opened = await staged.open('/a.txt');
	expect(opened.ok && (await opened.value.read(1, 5))).toEqual({
		ok: true,
		value: new Uint8Array([2, 3])
	});
	expect(await staged.stat('/a.txt/x')).toMatchObject({ ok: false });
	expect(staged.write).toBeUndefined();
});
it('is an empty read-only directory until a folder is attached, then delegates everything', async () => {
	const folder = folderMount();
	expect(folder.provider.cache).toBe(false);
	expect(await folder.provider.readdir('/')).toEqual({ ok: true, value: [] });
	expect(await folder.provider.stat('/x')).toEqual({
		ok: false,
		error: { code: 'ENOENT' }
	});
	expect(await folder.provider.create!('/x')).toEqual({
		ok: false,
		error: { code: 'EROFS' }
	});
	const write = vi.fn(async () => ({ ok: true as const, value: 2 }));
	const target: MountProvider = {
		stat: async () => ({ ok: true, value: { kind: 'file', size: 2 } }),
		readdir: async () => ({ ok: true, value: [{ name: 'x', kind: 'file' }] }),
		open: async () => ({ ok: false, error: { code: 'EACCES' } }),
		write
	};
	folder.attach(target);
	expect(await folder.provider.readdir('/')).toEqual({
		ok: true,
		value: [{ name: 'x', kind: 'file' }]
	});
	expect(await folder.provider.write!('/x', 0, new Uint8Array(2))).toEqual({
		ok: true,
		value: 2
	});
	expect(write).toHaveBeenCalledWith('/x', 0, new Uint8Array(2));
	expect(await folder.provider.mkdir!('/d')).toEqual({
		ok: false,
		error: { code: 'EROFS' }
	});
});
it('quotes added names for one cli/sh input line', () => {
	expect(copyCommand(['a b.txt', "it's"], '/mnt/.added')).toBe(
		"cp --no-preserve=mode '/mnt/.added/a b.txt' '/work/a b.txt'; cp --no-preserve=mode '/mnt/.added/it'\\''s' '/work/it'\\''s'\n"
	);
});
