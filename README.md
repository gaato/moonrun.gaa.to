# mooncakes-playground

An unofficial browser playground for public MoonBit programs on [mooncakes.io](https://mooncakes.io), powered by [moonrun-js](https://github.com/gaato/moonrun-js). Not affiliated with the MoonBit team.

Browse skills or open `/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm`. Root packages work too: `/cli/sh@0.2.1/sh.wasm`. `@latest` and omitted versions resolve through the module API and replace the URL with a pinned version. Repeated `?arg=a&arg=b` parameters preserve argument order; the JSON-array editor also preserves whitespace and empty strings. Copy link includes edited arguments; stdin and files stay on the page.

## Local development

Requires Node 24 and pnpm 12.3.4. moonrun-js is temporarily linked with `link:../moonrun-js` for its unreleased browser mounts. A coordinator-built sibling checkout with an existing `dist/browser/` is required; this project copies those assets and never builds the dependency. Switch the dependency back to `^0.1.1` after release. CI also needs that prebuilt sibling until then.

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

`pnpm dev` and `pnpm preview` serve the frontend only. Use Wrangler locally when running programs, because downloads need the mirror Worker. `pnpm smoke` starts a temporary Wrangler on a free loopback port, checks module, @latest and nested-package SPA paths return 200 without redirects, verifies the small CLI index and a real wasm/checksum download plus rejected paths with curl, then stops it. It requires network access to the public download host. Browser verification is performed separately by the coordinator.

## Downloads and execution

The download host sends CORS headers on its 302 response, but the final CloudFront/S3 response does not. The site's Cloudflare Worker therefore mirrors public files under `/_mooncakes/prebuild/…`, `/_mooncakes/skills/…` and `/_mooncakes/user/<owner>/<module>/<version>.zip`, fetching from the fixed `https://download.mooncakes.io` origin server-side and following its redirect.

The mirror accepts only GET/HEAD for concrete SemVer coordinates and the matching `.wasm`, `.wasm.sha256`, `skills.zip` or versioned module source ZIP files. It rejects queries, traversal, consecutive dots and encoded slashes/backslashes. Client headers and cookies are never forwarded; upstream requests use a fixed User-Agent because CloudFront rejects an empty one. Upstream cookies and other headers are discarded. Successful downloads are cached at the edge for one year as immutable content; errors are not cached. The 64 MiB limit checks both Content-Length and actual streamed bytes. An oversized stream without a trustworthy length is aborted, and its partial body is not cached. HEAD misses use an upstream GET because the public host does not support HEAD.

The browser still verifies wasm against its sibling `.sha256` and skill archives against `archive_digest` before use. Exact-version wasm is cached by URL with its verified digest stored alongside the bytes. Cache hits recheck the bytes against that digest without fetching `.sha256` again; missing or corrupt entries fetch and verify both files. Skill archives remain keyed by URL and `archive_digest`. Cache storage is optional. `SKILL.md` extraction permits one document up to 1 MiB; raw HTML/images are omitted and Markdown is sanitized. Checksums establish consistency with registry files, not independent publisher authentication.

Each run gets a fresh Worker, finite UTF-8 stdin and an in-memory VFS under `/work`. Uploaded files have plain, unique filenames and a 64 MiB limit per file. Output display is limited to 1 MiB per stream. An app supervisor forcibly terminates the guest on Stop, because moonrun-js's current handle exposes signals but no termination method.

The mirror only retrieves published program files: guest programs still have **no network relay**, native processes or persistent files. WebAssembly GC, exception handling and JSPI are required.

## Browser shell

`/shell` runs the latest prebuilt `cli/sh -i` with streaming stdin and wasm child processes. Commands and redirections share `/work` for the session; restarting creates a fresh filesystem. xterm.js provides the terminal, with local echo, grapheme backspace, Enter, Ctrl+C (SIGINT), and Ctrl+D (EOF on an empty line). Ctrl+L clears the screen and redraws the current prompt/input locally without writing to sh. A line whose trimmed value is exactly `clear` clears locally and submits an empty line for a fresh prompt; arguments and shell syntax pass through unchanged. At an idle prompt, Ctrl+C clears the local input without signaling sh or discarding /work. While a command is running, it still uses SIGINT on sh and can exit the shell; restart when it does. The signal call is isolated in `src/lib/shell/interrupt.ts` for the forthcoming child-only runtime option. The page manages PS1/PS2 with a per-session marker to recognize idle prompts; leave those variables intact until that option ships. The labelled command field and Send button offer another input path. Upload/download is not implemented.

On page load, `/shell` fetches `/_mooncakes/cli-index` once, loads sh, then preloads the indexed CLI programs with at most six concurrent downloads. The terminal displays command progress and verified MiB (including cache hits); checksum 404s are removed from both the count and command list as they are discovered. sh starts and displays its prompt only after every download settles. The index and sh are required for startup; failures loading either leave the prompt hidden and allow a restart to retry. Libraries without prebuilt checksums are skipped silently and remembered as not commands for the session; other failed downloads are reported in one line and retry on first use at the same indexed version. Verified bytes stay in memory for the session even when Cache API storage is unavailable. Skills download on demand.

The index Worker fetches the mooncakes modules list and returns only non-yanked `cli/*` names and concrete versions, including libraries. It caches successful JSON at the edge for 10 minutes; errors are not cached. The client reuses the index across shell restarts; reload the page to request an updated index, subject to that edge TTL. No version snapshot is bundled.

Bare names use the indexed CLI version first, then try published skills. Names absent from the index use the module API's `latest_version` as a fallback. The first candidate with a prebuilt `.wasm.sha256` wins. A 404 means absent; other download or integrity failures are reported without falling through. Each name is resolved once per session, including missing names; restart to refresh fallback resolutions or retry failures. Single-module latest-version answers use `cache: no-store` and never enter the browser Cache API.

Skill command names come from the prebuild wasm filename stem, with a plain `metadata.name` accepted as an alias (names containing `/` are not aliases). After CLI, matching skills are tried in lexicographic canonical full-path order (case-sensitive code-unit order, independent of API order). Unknown commands return command-not-found (127). Full `owner/module@version/path/name.wasm` coordinates work with explicit versions, `@latest`, or an omitted version; latest uses the page index for indexed CLI modules and the single-module API for other modules. Available commands lists the indexed commands after preloading (excluding checksum 404s), preload failures, every skill's full path, and a log of resolved coordinates. Guest networking remains unavailable.

The shell also mounts a read-only `/mooncakes` beside `/work`. Owners come from the non-yanked modules list; each owner lists its latest pinned modules and real `@latest` symlinks. Older non-yanked versions work by explicit path, checked against the module detail API. Module names are `owner/name`; nested paths belong to packages.

A module-directory stat, `cd`, or statting an owner’s entries does not fetch source. cli/ls 0.2.1 has no `-l` option; `ls -F /mooncakes/gaato` displays directory/symlink types without fetching ZIPs. Looking inside a module, opening a file, or statting below it fetches and extracts its source ZIP once per session, including memoized failures. At most four archive jobs run concurrently, and extraction is capped at 64 MiB and 20,000 entries with traversal rejected. Source ZIPs have no supplied checksum; they are read from the fixed HTTPS mirror. Sources and manifests remain third-party content.

Executable declarations in `moon.pkg` (`pkgtype` or `options("is-main": true)`) and legacy `moon.pkg.json` (`"is-main": true`) synthesize `<package-stem>.wasm` only when the matching prebuild checksum exists. Root packages use the module name as stem. Opening a synthesized wasm, or statting it to obtain its size, loads the verified prebuild; other source-file reads stay in the extracted ZIP. Absolute and relative mounted wasm paths execute using the child command's cwd, for example `/mooncakes/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm rumah`. Unverified wasm files included in source archives are not executable through the resolver. Mount writes return EROFS.

Every restart seeds `/work/README.txt` and `/work/sample.json`, sets `HOME=/work`, and prints a short command hint. Source-provider fetches and caches stay on the page thread through a small supervisor bridge; no network relay is exposed to guests. Providers and `/work` are fresh for each session.

Node integration tests use fixed sh/echo/tr/false/cat/ls fixtures, independent of current registry versions. They download missing fixtures into ignored `.cache/shell-fixtures/`, verify SHA-256 on every use, and execute the published browser host with the site's resolver and fake latest-version responses. Fake source ZIPs exercise real cli/ls and cli/cat, `@latest` symlinks, mounted executable paths and EROFS through the provider bridge. Only first-run wasm fixture downloads require network access.

## Structure and build

- `src/routes/`: skills catalog, runner catch-all and interactive shell.
- `src/lib/`: URL/argument parsing, integrity/cache, archives, Markdown and browser Worker execution.
- `src/worker.ts`: default Cloudflare handler; `src/mirror.ts`: download allowlist, cache and static-assets fallback.
- `scripts/`: copies npm browser assets, generates CSP headers and checks emitted runtime references.
- `static/THIRD_PARTY_NOTICES.txt`: bundled software licenses and notices.

Only `moonrun-js/browser` is imported. Its complete prebuilt browser distribution is copied into ignored static assets at `/_moonrun/` to preserve relative Worker, JS and four wasm URLs. Vite excludes it from dependency prebundling. Build checks verify those references and the app Worker import.

Wrangler runs the Worker first for the CLI index, mirror paths, paths containing `@` (also encoded `%40`), and `/shell`. Module paths serve `/index.html` through the assets binding without redirecting or rewriting the requested URL. Other paths use static assets with the SPA fallback and status 200. CSP permits connections only to this origin and mooncakes.io's JSON API. Only `/shell` permits the dynamic styles generated by xterm; main navigation reloads the document to apply that policy. CI installs from the frozen npm lockfile, checks, lints, tests, builds and validates the Cloudflare bundle without deploying. No bootstrap variables or deploy job are needed; workers.dev is disabled.

## License

Apache-2.0, copyright 2026 Gakuto Furuya. Public programs, skills, metadata and dependencies retain their respective rights; see [NOTICE](NOTICE) and [software notices](static/THIRD_PARTY_NOTICES.txt).
