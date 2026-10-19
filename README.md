# mooncakes-playground

An unofficial browser playground for public MoonBit programs on [mooncakes.io](https://mooncakes.io), powered by [moonrun-js](https://github.com/gaato/moonrun-js). Not affiliated with the MoonBit team.

Browse published skills or open a path such as `/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm`. Root packages work too: `/cli/sh@0.2.1/sh.wasm`. `@latest` and omitted versions resolve through the module API and replace the current URL with a pinned version. Repeated `?arg=a&arg=b` parameters are ordered arguments; the editor uses a JSON array to preserve whitespace and empty strings. Run updates the query. Copy link includes edited arguments; stdin and uploaded files are not shared.

## Local development

Requires Node 24, pnpm 12.3.4, and an existing `../moonrun-js` checkout with built `dist/browser/`. This project never builds that dependency. Only `moonrun-js/browser` is imported; changing its dependency to `^0.1.0` later needs no import changes.

```fish
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm dev
```

```fish
mise exec -- pnpm check
mise exec -- pnpm lint
mise exec -- pnpm test
mise exec -- pnpm build
mise exec -- pnpm preview
```

## Behavior and layout

- `src/routes/`: skills catalog, runner catch-all, and shell placeholder.
- `src/lib/`: URL/argument parsing, integrity and verified cache, skill archives, sanitized Markdown, and Worker execution.
- `scripts/`: copies the dependency's existing browser distribution, writes security headers, and checks the emitted runtime asset graph.
- `static/THIRD_PARTY_NOTICES.txt`: bundled software licenses and notices.

Wasm is verified against its sibling `.sha256` before use. Skill archives are verified against `archive_digest` before extracting a single `SKILL.md` (up to 1 MiB). Cache entries are keyed by download URL and digest and reverified on read; unavailable storage falls back to verified downloads. Checksums establish consistency with public registry files, not independent publisher authentication. Raw HTML and images in Markdown are omitted, dangerous links are removed, and no skill instructions are executed by the site.

Each run gets finite UTF-8 stdin and a fresh VFS under `/work`. Uploaded files have plain filenames (duplicates rejected), with a 64 MiB limit per file. Displayed output is limited to 1 MiB per stream. Stop forcibly terminates the guest Worker through an app supervisor, because the current moonrun-js handle exposes signals but no termination method. The supervisor's Worker tracking is confined to its own global scope.

Programs have **no network relay**, native processes, or persistent files. Network-related failures show an explanation. WebAssembly GC, exception handling and JSPI are required; Chrome verification is performed separately by the coordinator. Unit tests and builds do not claim browser execution coverage.

Vite keeps moonrun-js external at `/_moonrun/index.js`; dev/build copy its complete prebuilt browser distribution verbatim into ignored static assets. This preserves its Worker, shared chunks and four wasm component URLs. `optimizeDeps.exclude` prevents dependency prebundling. Build checks traverse those references and check the app Worker import. Cloudflare static assets serve the SPA fallback with status 200; `wrangler.jsonc` disables workers.dev. There is no deploy workflow. CSP allows the observed download redirect destination, `https://d15l9c1mnzh3r.cloudfront.net`, in addition to the two mooncakes.io origins.

**Upstream delivery blocker (2026-10-20):** an Origin-bearing GET for the kbbi checksum and skill archive redirects to CloudFront. The initial 302 has CORS headers, but the final 200 response did not include `Access-Control-Allow-Origin`. Browser downloads need CORS on that final response as well. This must be fixed by the public file host before direct browser execution can work; the app does not proxy around it.

## CI bootstrap

Until moonrun-js is published on npm, hosted CI needs two repository variables: `MOONRUN_JS_ARCHIVE_URL` (HTTPS URL of a prebuilt npm-layout package tarball with one top-level directory, including `package.json`, `dist/`, and any `bin/` files declared by the package) and `MOONRUN_JS_ARCHIVE_SHA256` (64 hex characters). The workflow verifies and extracts it as `../moonrun-js`, then installs, checks, lints, tests and builds. **CI intentionally fails at bootstrap until those variables are supplied.** It does not build moonrun-js. Remove that restore step when switching to the npm dependency.

## License

Apache-2.0, copyright 2026 Gakuto Furuya. Public programs, skills, metadata and third-party dependencies retain their respective rights; see [NOTICE](NOTICE) and [software notices](static/THIRD_PARTY_NOTICES.txt).
