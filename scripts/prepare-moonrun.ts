import { createRequire } from 'node:module';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
// A locally built runner can be verified before its npm release. The default
// stays the installed package, so production builds use the lockfile.
const source = process.env.MOONRUN_JS_BROWSER_DIR
	? resolve(process.env.MOONRUN_JS_BROWSER_DIR)
	: dirname(require.resolve('moonrun-js/browser'));
const destination = resolve('static/_moonrun');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log('Copied prebuilt moonrun-js browser assets (no dependency build).');
