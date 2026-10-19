export const mirrorPrefix = '/_mooncakes';
export const downloadOrigin = 'https://download.mooncakes.io';
const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const number = '(?:0|[1-9][0-9]*)';
const concreteVersion = new RegExp(
	`^${number}\\.${number}\\.${number}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
);

// Shared by the browser URL mapper and server allowlist. Decode once, then
// re-encode canonically; never let URL normalization hide traversal from this check.
export function downloadPath(pathname: string): string | null {
	if (
		!pathname.startsWith('/') ||
		/[?#\\]/.test(pathname) ||
		/%2f|%5c/i.test(pathname)
	)
		return null;
	let parts: string[];
	try {
		parts = pathname.slice(1).split('/').map(decodeURIComponent);
	} catch {
		return null;
	}
	if (parts.some((part) => part.includes('..'))) return null;
	const [kind, owner, coordinate, ...tail] = parts;
	if (!owner || !segment.test(owner) || !coordinate) return null;
	if (kind === 'user') {
		if (
			!segment.test(coordinate) ||
			tail.length !== 1 ||
			!tail[0].endsWith('.zip') ||
			!concreteVersion.test(tail[0].slice(0, -4))
		)
			return null;
		return '/' + parts.map(encodeURIComponent).join('/');
	}
	if (kind !== 'prebuild' && kind !== 'skills') return null;
	const [module, version, ...extra] = coordinate.split('@');
	if (
		!segment.test(module) ||
		!version ||
		!concreteVersion.test(version) ||
		extra.length ||
		!tail.length ||
		!tail.every((part) => segment.test(part))
	)
		return null;
	const filename = tail.at(-1)!;
	if (
		kind === 'skills'
			? filename !== 'skills.zip'
			: !/^.+\.wasm(?:\.sha256)?$/.test(filename)
	)
		return null;
	return (
		'/' +
		parts
			.map((part) => encodeURIComponent(part).replaceAll('%40', '@'))
			.join('/')
	);
}

export function mirroredDownload(input: string): string {
	const url = new URL(input);
	if (
		url.origin !== downloadOrigin ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error('Unexpected public download URL.');
	// Check the original spelling as well, before URL's dot-segment normalization.
	const rawPath = input.slice(input.indexOf('/', input.indexOf('://') + 3));
	const path = downloadPath(rawPath);
	if (!path)
		throw new Error('Expected a concrete versioned public download path.');
	return mirrorPrefix + path;
}
