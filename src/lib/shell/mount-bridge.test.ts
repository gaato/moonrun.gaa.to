import { expect, it, vi } from 'vitest';
import type { MountProvider } from 'moonrun-js/browser';
import { mountProxy, mountServer } from './mount-bridge';
function provider() {
	const close = vi.fn();
	const mount: MountProvider = {
		stat: async () => ({ ok: true, value: { kind: 'file', size: 3 } }),
		readdir: async () => ({
			ok: true,
			value: [{ name: 'file', kind: 'file' }]
		}),
		readlink: async () => ({ ok: true, value: 'file' }),
		open: async () => ({
			ok: true,
			value: {
				size: 3,
				close,
				read: async (offset, length) => ({
					ok: true,
					value: new Uint8Array([1, 2, 3]).slice(offset, offset + length)
				})
			}
		})
	};
	return { mount, close };
}
it('bridges metadata, symlinks and private ranged readers, with no write capability', async () => {
	const r = provider();
	const server = mountServer(r.mount);
	const proxy = mountProxy((id, request) => {
		void server.call(request).then((value) => proxy.accept(id, value));
	});
	expect(await proxy.provider.stat('/file')).toEqual({
		ok: true,
		value: { kind: 'file', size: 3 }
	});
	expect(await proxy.provider.readdir('/')).toEqual({
		ok: true,
		value: [{ name: 'file', kind: 'file' }]
	});
	expect(await proxy.provider.readlink!('/alias')).toEqual({
		ok: true,
		value: 'file'
	});
	const opened = await proxy.provider.open('/file');
	expect(opened.ok).toBe(true);
	if (!opened.ok) return;
	expect(await opened.value.read(1, 2)).toEqual({
		ok: true,
		value: new Uint8Array([2, 3])
	});
	opened.value.close?.();
	await vi.waitFor(() => expect(r.close).toHaveBeenCalledOnce());
	expect(proxy.provider.write).toBeUndefined();
	expect(
		await server.call({ op: 'read', handle: 1, offset: 0, length: 1 })
	).toMatchObject({ ok: false, error: { code: 'EBADF' } });
});
it('releases outstanding and late readers at session end', async () => {
	const r = provider();
	const server = mountServer(r.mount);
	await server.call({ op: 'open', path: '/file' });
	server.close();
	expect(r.close).toHaveBeenCalledOnce();
	expect(await server.call({ op: 'stat', path: '/file' })).toMatchObject({
		ok: false,
		error: { code: 'EIO' }
	});
	const late = mountServer(r.mount);
	const opening = late.call({ op: 'open', path: '/file' });
	late.close();
	expect(await opening).toMatchObject({ ok: false, error: { code: 'EIO' } });
	expect(r.close).toHaveBeenCalledTimes(2);
});
