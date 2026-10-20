# moonrun.gaa.to

[moonrun-js](https://github.com/gaato/moonrun-js) runs MoonBit wasm in your browser. This site is its demo: a shell that is cli/sh with the cli/\* commands from [moonbit-community/cmd](https://github.com/moonbit-community/cmd), compiled to wasm and published on [mooncakes.io](https://mooncakes.io). Everything runs locally and programs have no network access. Unofficial; not affiliated with the MoonBit team.

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

`pnpm build` copies the prebuilt moonrun-js browser assets, bundles the cli/\* commands (`pnpm prepare:commands`, see below), builds the site, writes the CSP `_headers` and checks the output. `pnpm dev` and `pnpm preview` serve the frontend only; without a bundle, the page falls back to the Worker's live index and mirror, so use Wrangler locally. `pnpm smoke` starts a temporary Wrangler on a free loopback port and checks with curl: the shell at `/`, any other path and `/?cmd=`, the `/shell` redirect, the static bundle, the CLI index, a real mirrored wasm/checksum, a source ZIP and rejected paths. It then stops Wrangler. It needs network access to the public download host. Browser verification is done separately.

## The shell

Every path serves the shell; `/shell` redirects to `/` (static `_redirects`). It runs the bundled `cli/sh -i` with streaming stdin and wasm child processes in a supervisor Worker. xterm.js provides the terminal, with local echo, grapheme backspace, Ctrl+L, a local `clear`, Ctrl+C and Ctrl+D. At an idle prompt Ctrl+C only clears the input line. After a line is sent and until sh prompts again, Ctrl+C sends SIGINT to sh, which cli/sh 0.2.1 does not catch, so it can end the shell; restart when it does. The page sets PS1/PS2 with a per-session marker to recognize prompts; leave those variables intact.

The filesystem is moonrun-js's memory VFS plus mounts:

- `/work`: HOME and cwd, seeded with `README.txt`, `sample.json` and an empty `bin/`, fresh on every restart.
- `/bin`: a read-only mount listing every bundled command as `/bin/<name>` (`ls /bin`). `PATH=/work/bin:/bin`. moonrun-js searches PATH in the filesystem first (execvp order), so cli/\* commands run from `/bin`, and wasm files placed in `/work/bin` take precedence.
- `/mooncakes`: published modules at their latest version, read-only (below).
- `/mnt/local`: "Open folder" (shown only where `showDirectoryPicker` exists) mounts the picked folder read-write with moonrun-js's `directoryHandleProvider`. Until then it is an empty read-only directory. The handle is reused after a restart.

Names that the PATH search does not find fall back to published skills by name or alias (lexicographic full-path order; the first with a prebuilt checksum wins). A skill named like a cli/\* command is shadowed by `/bin`. Names containing `/` run wasm files from the filesystem relative to the spawn cwd, for example `./prog.wasm` or `/mooncakes/gaato/kbbi/cmd/kbbi/kbbi.wasm rumah`. Unknown commands return 127.

"Add files" and dropping files on the terminal add any files (plain names, at most 64 MiB each) to `/work`, so an added `prog.wasm` runs as `./prog.wasm`. moonrun-js cannot write into a running VFS from outside, so the supervisor stages the files in a hidden read-only mount (`/mnt/.added`) and, at the next idle primary prompt, sends sh one line of `cp --no-preserve=mode` commands. The page prints one line for it and redraws the input. Files added while no shell runs are seeded into `/work` at the next start. Added files and opened folders stay in the browser.

`/?cmd=<url-encoded command line>` fills the input after the first prompt without running it; control characters become spaces. "Copy link" copies such a link for the command field, or else the current terminal line.

On load the page reads `/_commands/index.json`, loads sh, then preloads every command with at most six concurrent downloads, showing progress and verified MiB before the first prompt. Bundled files are verified against the index SHA-256 and cached in the Cache API by URL and digest; a missing or mismatched static file falls back to the verified mirror download at the same version. Without a bundle index, the page uses the Worker's live `/_mooncakes/cli-index` and the mirror. Libraries without prebuilds are skipped; failed downloads are reported in one line and retried on first use (they surface as EIO from `/bin`, which stops the PATH search).

## Command bundle

`scripts/prepare-commands.ts` reads the modules list (`https://mooncakes.io/api-new/v0/modules`), keeps non-yanked, concretely versioned `cli/*` entries, and for each fetches `https://download.mooncakes.io/prebuild/cli/<name>@<version>/<name>.wasm.sha256`. A 404 means no prebuild (for example cli/core) and is skipped. Otherwise it downloads the wasm with a fixed User-Agent, verifies SHA-256, the wasm magic and the 25 MiB Cloudflare asset limit, and writes `static/_commands/<name>.wasm` plus `index.json` (name, version, sha256, size, source URL). Files already present with the right digest are reused; stale ones are removed. Any other failure fails the build. `static/_commands/` is a gitignored build output. `pnpm build` runs the script and `scripts/check-artifacts.ts` rechecks every bundled file.

## Downloads and the Worker

Only `/_mooncakes/*` runs the Worker; everything else, including `/_commands/`, is served as static assets with the SPA fallback. The download host sends CORS headers on its 302 but not on the final CloudFront/S3 response, so the Worker mirrors `/_mooncakes/prebuild/…` (`.wasm` and `.wasm.sha256`) and `/_mooncakes/user/<owner>/<module>/<version>.zip` from the fixed `https://download.mooncakes.io` origin, and serves `/_mooncakes/cli-index` (non-yanked cli/\* names and versions, edge-cached for 10 minutes).

The mirror accepts only GET/HEAD for concrete SemVer coordinates and rejects queries, traversal, consecutive dots and encoded slashes/backslashes. Client headers and cookies are never forwarded; upstream requests use the fixed User-Agent `moonrun.gaa.to/0.1 (+https://moonrun.gaa.to)` because CloudFront rejects an empty one. Successful downloads are cached at the edge for one year as immutable content; errors are not cached. A 64 MiB limit checks Content-Length and streamed bytes. HEAD misses use an upstream GET.

The browser verifies mirrored wasm against its sibling `.sha256`; cache hits recheck stored bytes against the stored digest. Checksums establish consistency with registry files, not independent publisher authentication. CSP permits connections only to this origin and mooncakes.io's JSON API; styles allow `'unsafe-inline'` because every page is the xterm.js shell.

## /mooncakes

`/mooncakes/<owner>/<module>` is the module's latest non-yanked version, taken from the modules list once per shell session; paths carry no versions, so `/mooncakes/gaato/kbbi/cmd/kbbi/kbbi.wasm` matches the moonx coordinate `gaato/kbbi/cmd/kbbi`, and `cat /mooncakes/<owner>/<module>/moon.mod.json` (or `moon.mod`) shows the version. A module-directory stat, `cd` or statting an owner's entries does not fetch source. Looking inside a module, opening a file or statting below it fetches and extracts its source ZIP once per session (at most four jobs at once, 64 MiB and 20,000 entries, traversal rejected). Source ZIPs have no published checksum. Executable declarations in `moon.pkg` and legacy `moon.pkg.json` synthesize `<package-stem>.wasm` when the matching prebuild checksum exists; opening it loads the verified prebuild. Wasm files that happen to be inside a source archive are ordinary files and can also be run by path. Writes return EROFS. These providers run on the page thread, reached from the supervisor through a small bridge; no network relay is exposed to guests.

## Tests

Unit tests cover the mirror, indexes, integrity, the `/bin`, `/mooncakes`, staging and folder providers, the bridge, the session protocol, the line discipline, share links and the bundle script (with fake fetch). Integration tests run the real published cli/sh, echo, tr, false, cat, ls and cp 0.2.1 through the moonrun-js browser host: pipelines from `/bin` on PATH, `ls /bin`, `/work/bin` precedence, `./prog.wasm`, skill fallback, the generated copy line for added files, Ctrl+C, `/mooncakes` listings and mounted executables by absolute and relative path. They download missing fixtures into ignored `.cache/shell-fixtures/` and verify SHA-256 on every use.

## Deploy

`.github/workflows/ci.yml` runs on pull requests (verify only), pushes to main, manual dispatch and a daily schedule. Verify installs from the frozen lockfile, then runs check, lint, test, build (which bundles the latest cli/\*), smoke and `wrangler deploy --dry-run`. On main (push, schedule or dispatch) verify uploads its exact `build/` as an artifact, and the deploy job downloads it without rebuilding (so the deployed cli/\* are the ones verified and smoke-tested) and runs `pnpm run deploy` (`wrangler deploy` of the Worker `moonrun-gaa-to`) in the `production` environment, then checks `vars.PRODUCTION_URL` when set. It needs the `CLOUDFLARE_API_TOKEN` secret. workers.dev is disabled; the custom domain is configured outside this repository.

## Structure

- `src/routes/`: the catch-all page showing the shell.
- `src/lib/shell/`: terminal UI, session/supervisor Worker, line discipline, mounts, command loading and the skill resolver.
- `src/lib/`: indexes, integrity/cache, registry paths and skills.
- `src/worker.ts`, `src/mirror.ts`: the Cloudflare Worker (download allowlist, cache, CLI index).
- `scripts/`: moonrun-js asset copy, command bundle, CSP headers, artifact checks and the Worker smoke test.
- `static/THIRD_PARTY_NOTICES.txt`: bundled software licenses and notices.

Only `moonrun-js/browser` is imported. Its prebuilt browser distribution is copied into ignored static assets at `/_moonrun/` to preserve its relative Worker, JS and wasm URLs; Vite excludes it from prebundling.

## License

Apache-2.0, copyright 2026 Gakuto Furuya. The bundled cli/\* commands (moonbit-community/cmd) are Apache-2.0. Module sources, skills, metadata and dependencies retain their respective rights; see [NOTICE](NOTICE) and [software notices](static/THIRD_PARTY_NOTICES.txt).
