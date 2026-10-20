import { zipSync } from 'fflate';
import type { BrowserMemoryFs } from 'moonrun-js/browser';

export const maxArchiveBytes = 256 * 1024 * 1024;

// Zips a memory-VFS tree under a top-level folder named after it (work/...).
// Regular files and directories are included; symlinks and other kinds are skipped.
export async function archiveTree(
	fs: Pick<BrowserMemoryFs, 'readdir' | 'readFile' | 'stat'>,
	root = '/work',
	limit = maxArchiveBytes
): Promise<Uint8Array> {
	const top = root.split('/').filter(Boolean).at(-1) ?? 'root';
	const files: Record<string, Uint8Array> = {};
	let total = 0;
	async function visit(path: string, name: string): Promise<void> {
		const entries = await fs.readdir(path);
		if (!entries.length) files[name + '/'] = new Uint8Array();
		for (const entry of entries) {
			const child = `${path}/${entry.name}`;
			const childName = `${name}/${entry.name}`;
			if (entry.kind === 'dir') await visit(child, childName);
			else if (entry.kind === 'file') {
				total += (await fs.stat(child)).size;
				if (total > limit)
					throw new Error(
						`${root} is larger than ${limit / 1024 / 1024} MiB; remove some files and try again.`
					);
				files[childName] = await fs.readFile(child);
			}
		}
	}
	await visit(root, top);
	return zipSync(files);
}
