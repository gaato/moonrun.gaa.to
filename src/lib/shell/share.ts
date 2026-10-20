// /?cmd=<command line> prefills the input after the first prompt; it never runs it.
// Control characters (including newlines, which would submit) become spaces.
export function sharedCommand(search: string): string {
	return (new URLSearchParams(search).get('cmd') ?? '').replace(
		/[\0-\x1f\x7f]+/g,
		' '
	);
}
export function shareLink(origin: string, line: string): string {
	return line ? `${origin}/?cmd=${encodeURIComponent(line)}` : `${origin}/`;
}
