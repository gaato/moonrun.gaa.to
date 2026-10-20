import { expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { archiveTree } from './work-archive';
type Entry = { name: string; kind: 'file' | 'dir' | 'symlink' | 'other' };
function fakeFs(tree: Record<string, string | null>) {
	const files = new Map(
		Object.entries(tree).filter(
			(entry): entry is [string, string] => entry[1] !== null
		)
	);
	const dirs = new Set(Object.keys(tree).filter((path) => tree[path] === null));
	return {
		async readdir(path: string): Promise<Entry[]> {
			const prefix = path + '/';
			const names = new Map<string, Entry['kind']>();
			for (const key of Object.keys(tree)) {
				if (!key.startsWith(prefix)) continue;
				const [name, ...rest] = key.slice(prefix.length).split('/');
				names.set(
					name,
					rest.length || dirs.has(prefix + name)
						? 'dir'
						: name.startsWith('link')
							? 'symlink'
							: 'file'
				);
			}
			return [...names].map(([name, kind]) => ({ name, kind }));
		},
		async stat(path: string) {
			return {
				kind: 'file' as const,
				size: files.get(path)!.length,
				mtimeMs: 0
			};
		},
		async readFile(path: string) {
			return new TextEncoder().encode(files.get(path)!);
		}
	};
}
it('zips /work under work/, keeping empty directories and skipping symlinks', async () => {
	const zip = await archiveTree(
		fakeFs({
			'/work/a.txt': 'A',
			'/work/bin': null,
			'/work/deep/b.txt': 'B',
			'/work/link': 'x'
		})
	);
	const files = unzipSync(zip);
	expect(Object.keys(files).sort()).toEqual([
		'work/a.txt',
		'work/bin/',
		'work/deep/b.txt'
	]);
	expect(strFromU8(files['work/deep/b.txt'])).toBe('B');
});
it('refuses trees above the size limit with a clear message', async () => {
	await expect(
		archiveTree(fakeFs({ '/work/a': 'xxxx', '/work/b': 'yyyy' }), '/work', 6)
	).rejects.toThrow('/work is larger than');
});
