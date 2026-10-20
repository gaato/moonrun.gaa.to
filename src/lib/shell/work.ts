// Every shell restart gets these files and a fresh writable /work.
export const shellFiles = {
	'/work': null,
	'/work/bin': null,
	'/work/README.txt': `moonrun.gaa.to: moonrun-js runs MoonBit wasm in your browser. This shell is
cli/sh with the cli/* commands from moonbit-community/cmd. Everything runs
locally; programs that need network access fail.

/work       HOME and working directory; it lasts for this shell session
/work/bin   your own wasm commands; searched first in PATH
/bin        the cli/* commands (ls /bin)
/mnt/local  a folder you open with "Open folder" (read-write)

moonx <owner>/<module>/<package>[@version] [args] runs a published package's
prebuilt wasm, like the official moonx: moonx Yoorkin/cowsay hello,
moonx gaato/kbbi/cmd/kbbi --help.

"Add files" (or dropping files on the terminal) writes them into /work, and
"Download /work" saves it as work.zip. Run an added wasm file with ./prog.wasm.
Your files stay in this browser.
Try: ls /bin; jq .a[] sample.json; moonx Yoorkin/cowsay hello
`,
	'/work/sample.json': '{"a":[1,2,3]}\n'
} as const;
export const shellHint =
	'moonrun-js running cli/sh from moonbit-community/cmd. Try: ls /bin · cat README.txt · moonx Yoorkin/cowsay hello';
export const binMount = '/bin';
export const folderPath = '/mnt/local';
export const shellPath = '/work/bin:/bin';
