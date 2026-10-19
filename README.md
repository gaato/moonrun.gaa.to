# mooncakes-playground

An unofficial browser playground for public MoonBit programs on [mooncakes.io](https://mooncakes.io), powered by [moonrun-js](https://github.com/gaato/moonrun-js). Not affiliated with the MoonBit team.

Browse skills or open `/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm`. Root packages work too: `/cli/sh@0.2.1/sh.wasm`. `@latest` and omitted versions resolve through the module API and replace the URL with a pinned version. Repeated `?arg=a&arg=b` parameters preserve argument order; the JSON-array editor also preserves whitespace and empty strings. Copy link includes edited arguments; stdin and files stay on the page.

## Local development

Requires Node 24 and pnpm 12.3.4. moonrun-js is installed from npm; no sibling checkout or dependency build is needed.

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

`pnpm dev` and `pnpm preview` serve the frontend only. Use Wrangler locally when running programs, because downloads need the mirror Worker. `pnpm smoke` starts a temporary Wrangler on a free loopback port, checks the SPA fallback (following the static asset service's `@` to `%40` canonical redirect) and a real wasm/checksum download plus rejected paths with curl, then stops it. It requires network access to the public download host. Browser verification is performed separately by the coordinator.

## Downloads and execution

The download host sends CORS headers on its 302 response, but the final CloudFront/S3 response does not. The site's Cloudflare Worker therefore mirrors public files under `/_mooncakes/prebuild/…` and `/_mooncakes/skills/…`, fetching from the fixed `https://download.mooncakes.io` origin server-side and following its redirect.

The mirror accepts only GET/HEAD for concrete SemVer coordinates and the matching `.wasm`, `.wasm.sha256` or `skills.zip` files. It rejects queries, traversal, consecutive dots and encoded slashes/backslashes. Client headers and cookies are never forwarded; upstream requests use a fixed User-Agent because CloudFront rejects an empty one. Upstream cookies and other headers are discarded. Successful downloads are cached at the edge for one year as immutable content; errors are not cached. The 64 MiB limit checks both Content-Length and actual streamed bytes. An oversized stream without a trustworthy length is aborted, and its partial body is not cached. HEAD misses use an upstream GET because the public host does not support HEAD.

The browser still verifies wasm against its sibling `.sha256` and skill archives against `archive_digest` before use. Verified browser-cache entries are keyed by URL and digest and rechecked on read. `SKILL.md` extraction permits one document up to 1 MiB; raw HTML/images are omitted and Markdown is sanitized. Checksums establish consistency with registry files, not independent publisher authentication.

Each run gets a fresh Worker, finite UTF-8 stdin and an in-memory VFS under `/work`. Uploaded files have plain, unique filenames and a 64 MiB limit per file. Output display is limited to 1 MiB per stream. An app supervisor forcibly terminates the guest on Stop, because moonrun-js's current handle exposes signals but no termination method.

The mirror only retrieves published program files: guest programs still have **no network relay**, native processes or persistent files. WebAssembly GC, exception handling and JSPI are required.

## Structure and build

- `src/routes/`: skills catalog, runner catch-all and shell placeholder.
- `src/lib/`: URL/argument parsing, integrity/cache, archives, Markdown and browser Worker execution.
- `src/worker.ts`: default Cloudflare handler; `src/mirror.ts`: download allowlist, cache and static-assets fallback.
- `scripts/`: copies npm browser assets, generates CSP headers and checks emitted runtime references.
- `static/THIRD_PARTY_NOTICES.txt`: bundled software licenses and notices.

Only `moonrun-js/browser` is imported. Its complete prebuilt browser distribution is copied into ignored static assets at `/_moonrun/` to preserve relative Worker, JS and four wasm URLs. Vite excludes it from dependency prebundling. Build checks verify those references and the app Worker import.

Wrangler runs the Worker first only for the two mirror path prefixes. Other paths use static assets with the SPA fallback and status 200. CSP permits connections only to this origin and mooncakes.io's JSON API. CI installs from the frozen npm lockfile, checks, lints, tests, builds and validates the Cloudflare bundle without deploying. No bootstrap variables or deploy job are needed; workers.dev is disabled.

## License

Apache-2.0, copyright 2026 Gakuto Furuya. Public programs, skills, metadata and dependencies retain their respective rights; see [NOTICE](NOTICE) and [software notices](static/THIRD_PARTY_NOTICES.txt).
