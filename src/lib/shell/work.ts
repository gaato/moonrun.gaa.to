// Every shell restart gets these files and a fresh writable /work.
export const shellFiles = {
	'/work': null,
	'/work/README.txt': `Welcome to mooncakes-playground, an unofficial MoonBit playground.
Browse published module sources and verified executables under /mooncakes (read-only).
Your working directory and HOME are /work. Files here last only for this shell session.
Try: ls /mooncakes/gaato; cowsay hello; jq .a[] sample.json
`,
	'/work/sample.json': '{"a":[1,2,3]}\n'
} as const;
export const shellHint =
	'Try: ls /mooncakes/gaato · cowsay hello · jq .a[] sample.json';
