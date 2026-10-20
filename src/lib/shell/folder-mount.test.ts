import { expect, it, vi } from 'vitest';
import type { MountProvider } from 'moonrun-js/browser';
import { folderMount } from './folder-mount';
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
