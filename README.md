# moonrun.gaa.to

[moonrun-js](https://github.com/gaato/moonrun-js) runs MoonBit wasm in your browser. This site is its demo: a shell that is cli/sh with the cli/\* commands from [moonbit-community/cmd](https://github.com/moonbit-community/cmd), compiled to wasm and published on [mooncakes.io](https://mooncakes.io). `moonx <owner>/<module>/<package>[@version] [args]` runs other published packages, as the official moonx does (`moonx Yoorkin/cowsay hello`, `moonx gaato/kbbi/cmd/kbbi --help`). Everything runs locally; programs that need network access fail. Unofficial; not affiliated with the MoonBit team.

## Local development

Requires Node 24 and pnpm 12.3.4 (both through mise).

```fish
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm build
mise exec -- pnpm exec wrangler dev --local
```

```fish
mise exec -- pnpm verify
mise exec -- pnpm smoke
mise exec -- pnpm exec wrangler deploy --dry-run
```

`pnpm build` copies the prebuilt moonrun-js browser assets, bundles the cli/\* commands (`pnpm prepare:commands`, see below), builds the site, writes the CSP `_headers` and checks the output. `pnpm dev` also bundles the commands; `pnpm dev` and `pnpm preview` serve the frontend only, and moonx downloads need the mirror Worker, so use Wrangler locally. `pnpm smoke` starts a temporary Wrangler on a free loopback port and checks with curl: the shell at `/`, any other path and `/?cmd=`, the `/shell` redirect, the static bundle, a real mirrored wasm/checksum, removed routes and rejected paths. It then stops Wrangler. It needs network access to the public download host. Browser verification is done separately.

## The shell

Every path serves the shell; `/shell` redirects to `/` (static `_redirects`). It runs the bundled `cli/sh -i` with streaming stdin and wasm child processes in a supervisor Worker. xterm.js provides the terminal, with local echo, grapheme backspace, Ctrl+L, a local `clear`, Ctrl+C and Ctrl+D. At an idle prompt Ctrl+C only clears the input line. After a line is sent and until sh prompts again, Ctrl+C sends SIGINT to sh, which cli/sh 0.2.1 does not catch, so it can end the shell; restart when it does. The page sets PS1/PS2 with a per-session marker to recognize prompts; leave those variables intact.

The filesystem is moonrun-js's memory VFS plus mounts:

- `/work`: HOME and cwd, seeded with `README.txt`, `sample.json` and an empty `bin/`, fresh on every restart.
- `/bin`: a read-only mount listing every bundled command as `/bin/<name>` (`ls /bin`). `PATH=/work/bin:/bin`. moonrun-js searches PATH in the filesystem first (execvp order), so cli/\* commands run from `/bin`, and wasm files placed in `/work/bin` take precedence.
- `/mnt/local`: "Open folder" (shown only where `showDirectoryPicker` exists) mounts the picked folder read-write with moonrun-js's `directoryHandleProvider`. Until then it is an empty read-only directory. The handle is reused after a restart.

Names containing `/` run wasm files from the filesystem relative to the spawn cwd, for example `./prog.wasm`. The only command outside the filesystem is `moonx` (below); other unknown commands return 127.

"Add files" and dropping files on the terminal add any files (plain names, at most 64 MiB each) to `/work`, so an added `prog.wasm` runs as `./prog.wasm`. The supervisor writes them into the running shell's memory VFS with moonrun-js's `handle.fs.writeFile`, replacing an existing file, and the page prints one line without disturbing the input line. Files added while no shell runs are seeded into `/work` at the next start. "Download /work" (enabled while a shell runs) reads the live tree with `handle.fs`, zips it with fflate in the supervisor (regular files and directories; symlinks are skipped; at most 256 MiB) and saves `work.zip`. Added files, downloads and opened folders stay in the browser.

`/?cmd=<url-encoded command line>` fills the input after the first prompt without running it; control characters become spaces. "Copy link" copies such a link for the command field, or else the current terminal line.

On load the page reads `/_commands/index.json`, loads sh, then preloads every command with at most six concurrent downloads, showing progress and verified MiB before the first prompt. Bundled files are verified against the index SHA-256 and cached in the Cache API by URL and digest; a missing or mismatched static file falls back to the verified mirror download at the same version. Every build bundles cli/\*; a missing bundle index is reported as a startup error. Libraries without prebuilds are skipped; failed downloads are reported in one line and retried on first use (they surface as EIO from `/bin`, which stops the PATH search).

## Command bundle

`scripts/prepare-commands.ts` reads the modules list (`https://mooncakes.io/api-new/v0/modules`), keeps non-yanked, concretely versioned `cli/*` entries, and for each fetches `https://download.mooncakes.io/prebuild/cli/<name>@<version>/<name>.wasm.sha256`. A 404 means no prebuild (for example cli/core) and is skipped. Otherwise it downloads the wasm with a fixed User-Agent, verifies SHA-256, the wasm magic and the 25 MiB Cloudflare asset limit, and writes `static/_commands/<name>.wasm` plus `index.json` (name, version, sha256, size, source URL). Files already present with the right digest are reused; stale ones are removed. Any other failure fails the build. `static/_commands/` is a gitignored build output. `pnpm build` runs the script and `scripts/check-artifacts.ts` rechecks every bundled file.

## Downloads and the Worker

Only `/_mooncakes/*` runs the Worker; everything else, including `/_commands/`, is served as static assets with the SPA fallback. The download host sends CORS headers on its 302 but not on the final CloudFront/S3 response, so the Worker mirrors `/_mooncakes/prebuild/…` (`.wasm` and `.wasm.sha256`) from the fixed `https://download.mooncakes.io` origin, including `/vN` major-version modules. That is the only Worker route; it serves moonx downloads and the fallback for bundled commands.

The mirror accepts only GET/HEAD for concrete SemVer coordinates and rejects queries, traversal, consecutive dots and encoded slashes/backslashes. Client headers and cookies are never forwarded; upstream requests use the fixed User-Agent `moonrun.gaa.to/0.1 (+https://moonrun.gaa.to)` because CloudFront rejects an empty one. Successful downloads are cached at the edge for one year as immutable content; errors are not cached. A 64 MiB limit checks Content-Length and streamed bytes. HEAD misses use an upstream GET.

The browser verifies mirrored wasm against its sibling `.sha256`; cache hits recheck stored bytes against the stored digest. Checksums establish consistency with registry files, not independent publisher authentication. CSP permits connections only to this origin and mooncakes.io's JSON API; styles allow `'unsafe-inline'` because every page is the xterm.js shell.

## moonx

`moonx` follows the official moonx (moon's `crates/moon/src/cli/moonx.rs` and mooncake's `registry/{executable,path,client}.rs`). The page's `resolveCommand` handles it and returns moonrun-js's `{ wasm, args, argv0 }`, so the package's wasm replaces the moonx child with only the program arguments and argv0 set to the artifact stem.

- Options before the input: `-v`/`--verbose` (accepted, no extra output), `--target wasm`, `-h`, `-V`. `--experimental-policy` and `--target native` print that they are not supported in the browser and exit 2; unknown options give a clap-style usage error (2). One leading `--` after the input is dropped.
- Coordinates parse as moon does: `owner/module/pkg/path[@version]`, `owner/module@version/pkg/path`, `@latest`, no version (latest), a module root package `owner/module[@version]`, and `/vN` major-version modules. Wildcards (`...`) are rejected, and `.mbtx` scripts are not supported because there is no compiler in the browser.
- The latest version comes from `https://mooncakes.io/api-new/v0/modules/<owner>/<module>` (`latest_version`), once per shell session.
- The artifact is `prebuild/<module>@<version>/[<package>/]<stem>.wasm` (stem: the last package segment, or of the module name for the root package), fetched with its `.sha256` through the mirror, verified and cached by URL and digest.
- Errors print moon-style (`Error: Module \`no/such\` not found in registry`, `Error: Prebuilt wasm asset does not exist`, `Error: Invalid package coordinate …`with`Caused by:`) and exit 255, like moonx. They come from a tiny WASI program generated in the page (`messageWasm`) that writes the message and calls `proc_exit`, because cli/sh 0.2.1 cannot redirect to stderr (`>&2` is parsed as background execution).

## Tests

Unit tests cover the mirror, indexes, integrity, moonx (coordinates, invocation, artifact URLs, latest resolution, errors), the `/bin` and folder providers, the work.zip archiver, the bridge, the session protocol, the line discipline, share links and the bundle script (with fake fetch). Integration tests run the real published cli/sh, echo, tr, false, cat, ls, cp, mkdir and wc 0.2.1 through the moonrun-js browser host: pipelines from `/bin` on PATH, `ls /bin`, `/work/bin` precedence, `./prog.wasm`, no `/mooncakes`, `moonx` with a fake registry (arguments, `--`, pipelines into `wc -l`, memoized latest/bytes, error messages and statuses), files written into a running shell's `/work` and zipped back, `cp` both ways between `/work` and a fake picked folder at `/mnt/local`, Ctrl+C. They download missing fixtures into ignored `.cache/shell-fixtures/` and verify SHA-256 on every use.

## Deploy

`.github/workflows/ci.yml` runs on pull requests (verify only), pushes to main, manual dispatch and a daily schedule. Verify installs from the frozen lockfile, then runs check, lint, test, build (which bundles the latest cli/\*), smoke and `wrangler deploy --dry-run`. On main (push, schedule or dispatch) verify uploads its exact `build/` as an artifact, and the deploy job downloads it without rebuilding (so the deployed cli/\* are the ones verified and smoke-tested) and runs `pnpm run deploy` (`wrangler deploy` of the Worker `moonrun-gaa-to`) in the `production` environment, then checks `vars.PRODUCTION_URL` when set. It needs the `CLOUDFLARE_API_TOKEN` secret. workers.dev is disabled; the custom domain is configured outside this repository.

## Structure

- `src/routes/`: the catch-all page showing the shell.
- `src/lib/shell/`: terminal UI, session/supervisor Worker, line discipline, mounts, command loading and moonx.
- `src/lib/`: the command bundle index, integrity/cache and download paths.
- `src/worker.ts`, `src/mirror.ts`: the Cloudflare Worker (prebuild download allowlist and cache).
- `scripts/`: moonrun-js asset copy, command bundle, CSP headers, artifact checks and the Worker smoke test.
- `static/THIRD_PARTY_NOTICES.txt`: bundled software licenses and notices.

Only `moonrun-js/browser` is imported. Its prebuilt browser distribution is copied into ignored static assets at `/_moonrun/` to preserve its relative Worker, JS and wasm URLs; Vite excludes it from prebundling.

## License

Apache-2.0, copyright 2026 Gakuto Furuya. The bundled cli/\* commands (moonbit-community/cmd) are Apache-2.0. Packages run with moonx, metadata and dependencies retain their respective rights; see [NOTICE](NOTICE) and [software notices](static/THIRD_PARTY_NOTICES.txt).
