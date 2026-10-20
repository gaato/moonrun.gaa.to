// Every shell restart gets these files and a fresh writable /work.
export const shellFiles = {
	'/work': null,
	'/work/bin': null,
	'/work/README.txt': `moonrun.gaa.to: moonrun-js runs MoonBit wasm in your browser. This shell is
cli/sh with the cli/* commands from moonbit-community/cmd. Everything runs
locally; programs have no network access.

/work       HOME and working directory; it lasts for this shell session
/work/bin   your own wasm commands; searched first in PATH
/bin        the cli/* commands (ls /bin)
/mooncakes  published modules at their latest version, read-only:
            /mooncakes/gaato/kbbi/cmd/kbbi/kbbi.wasm is moonx's gaato/kbbi/cmd/kbbi;
            cat /mooncakes/<owner>/<module>/moon.mod.json shows the version
/mnt/local  a folder you open with "Open folder" (read-write)

"Add files" (or dropping files on the terminal) copies them into /work.
Run an added wasm file with ./prog.wasm. Your files stay in this browser.
Try: ls /bin; jq .a[] sample.json; cowsay hello
`,
	'/work/sample.json': '{"a":[1,2,3]}\n'
} as const;
export const shellHint =
	'moonrun-js running cli/sh from moonbit-community/cmd. Try: ls /bin · cat README.txt · jq .a[] sample.json';
// Mount points. Added files wait in a hidden read-only mount until sh copies them.
export const binMount = '/bin';
export const mooncakesMount = '/mooncakes';
export const folderPath = '/mnt/local';
export const addedPath = '/mnt/.added';
export const shellPath = '/work/bin:/bin';
