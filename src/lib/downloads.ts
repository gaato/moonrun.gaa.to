export const mirrorPrefix = '/_mooncakes';
export const downloadOrigin = 'https://download.mooncakes.io';
// CloudFront rejects requests without a User-Agent; never forward the browser's.
export const userAgent = 'moonrun.gaa.to/0.1 (+https://moonrun.gaa.to)';
const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const number = '(?:0|[1-9][0-9]*)';
const concreteVersion = new RegExp(
	`^${number}\\.${number}\\.${number}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
);

// Shared by the browser URL mapper and server allowlist: prebuilt wasm and its
// checksum, /prebuild/<owner>/<module>[/vN]@<version>/[<package>/]<name>.wasm[.sha256].
// Decode once, then re-encode canonically; never let URL normalization hide traversal.
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
	const [kind, owner, ...rest] = parts;
	if (kind !== 'prebuild' || !owner || !segment.test(owner)) return null;
	// A major-version suffix (v2, v10, ...) is part of the module name.
	const suffixed = /^v(?:[2-9]|[1-9][0-9]+)@/.test(rest[1] ?? '');
	const module = suffixed ? rest[0] : undefined;
	const [name, version, ...extra] = (
		suffixed ? rest[1] : (rest[0] ?? '')
	).split('@');
	const tail = rest.slice(suffixed ? 2 : 1);
	if (
		(module !== undefined && !segment.test(module)) ||
		!segment.test(name) ||
		!version ||
		!concreteVersion.test(version) ||
		extra.length ||
		!tail.length ||
		!tail.every((part) => segment.test(part)) ||
		!/^.+\.wasm(?:\.sha256)?$/.test(tail.at(-1)!)
	)
		return null;
	return (
		'/' +
		parts
			.map((part) => encodeURIComponent(part).replaceAll('%40', '@'))
			.join('/')
	);
}
