import { createRequire } from 'node:module';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const source = dirname(require.resolve('moonrun-js/browser'));
const destination = resolve('static/_moonrun');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log('Copied prebuilt moonrun-js browser assets (no dependency build).');
