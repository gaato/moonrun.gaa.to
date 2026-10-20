import type { BrowserDirectoryHandle } from 'moonrun-js/browser';

// A small in-memory stand-in for a picked FileSystemDirectoryHandle.
const fail = (name: 'NotFoundError' | 'TypeMismatchError') => {
	throw new DOMException(name, name);
};
export class FakeFolder implements BrowserDirectoryHandle {
	readonly kind = 'directory';
	readonly files = new Map<string, Uint8Array>();
	readonly folders = new Map<string, FakeFolder>();
	constructor(readonly name: string) {}
	async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
		let folder = this.folders.get(name);
		if (this.files.has(name)) fail('TypeMismatchError');
		if (!folder) {
			if (!options.create) fail('NotFoundError');
			this.folders.set(name, (folder = new FakeFolder(name)));
		}
		return folder!;
	}
	async getFileHandle(name: string, options: { create?: boolean } = {}) {
		if (this.folders.has(name)) fail('TypeMismatchError');
		if (!this.files.has(name)) {
			if (!options.create) fail('NotFoundError');
			this.files.set(name, new Uint8Array());
		}
		const files = this.files;
		return {
			kind: 'file' as const,
			name,
			getFile: async () => {
				const bytes = files.get(name)!;
				return {
					size: bytes.length,
					lastModified: 0,
					slice: (start: number, end: number) => ({
						arrayBuffer: async () => bytes.slice(start, end).buffer
					})
				};
			},
			createWritable: async ({
				keepExistingData
			}: {
				keepExistingData: boolean;
			}) => {
				let data = keepExistingData
					? files.get(name)!.slice()
					: new Uint8Array();
				let offset = 0;
				const resize = (size: number) => {
					const next = new Uint8Array(size);
					next.set(data.subarray(0, size));
					data = next;
				};
				return {
					seek: async (position: number) => {
						offset = position;
					},
					write: async (bytes: Uint8Array) => {
						if (offset + bytes.length > data.length)
							resize(offset + bytes.length);
						data.set(bytes, offset);
						offset += bytes.length;
					},
					truncate: async (size: number) => resize(size),
					close: async () => {
						files.set(name, data);
					},
					abort: async () => {}
				};
			}
		};
	}
	async *entries(): AsyncGenerator<
		[string, { name: string; kind: 'file' | 'directory' }]
	> {
		for (const name of this.folders.keys())
			yield [name, { name, kind: 'directory' }];
		for (const name of this.files.keys()) yield [name, { name, kind: 'file' }];
	}
	async removeEntry(name: string) {
		if (!this.files.delete(name) && !this.folders.delete(name))
			fail('NotFoundError');
	}
}
