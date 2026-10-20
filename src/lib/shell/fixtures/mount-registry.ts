import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { vi } from 'vitest';
import { modulesEndpoint } from '../../cli-index';

export const wasmFixture = new Uint8Array([0, 97, 115, 109]);
export const packageFixture = (name: string) =>
	readFileSync(`src/lib/shell/fixtures/packages/${name}`, 'utf8');
export function mountRegistry() {
	const modules = [
		{ name: 'gaato/kbbi', version: '0.1.6' },
		{ name: 'cli/sh', version: '0.2.1' },
		{ name: 'Yoorkin/cowsay', version: '0.1.0' },
		{ name: 'nobody/yanked', version: '1.0.0', yanked: true },
		{ name: 'bad/name/nested', version: '1.0.0' }
	];
	const routes = new Map<string, () => Response | Promise<Response>>();
	routes.set(modulesEndpoint, () => Response.json(modules));
	function zip(
		owner: string,
		name: string,
		version: string,
		files: Record<string, string>
	) {
		const bytes = zipSync(
			Object.fromEntries(
				Object.entries(files).map(([name, text]) => [name, strToU8(text)])
			)
		);
		routes.set(
			`/_mooncakes/user/${owner}/${name}/${version}.zip`,
			() => new Response(new Uint8Array(bytes))
		);
	}
	function wasm(path: string, bytes: Uint8Array = wasmFixture) {
		const digest = createHash('sha256').update(bytes).digest('hex');
		routes.set(
			'/_mooncakes/prebuild' + path + '.sha256',
			() => new Response(digest)
		);
		routes.set(
			'/_mooncakes/prebuild' + path,
			() => new Response(new Uint8Array(bytes))
		);
	}
	zip('gaato', 'kbbi', '0.1.6', {
		'README.md': 'Fixture module\n',
		'cmd/kbbi/moon.pkg': packageFixture('nested.moon.pkg'),
		'moon.pkg': 'import { "moonbitlang/core" }',
		'src/lib.mbt': 'let answer = 42\n'
	});
	zip('cli', 'sh', '0.2.1', { 'moon.pkg': packageFixture('root.moon.pkg') });
	zip('Yoorkin', 'cowsay', '0.1.0', {
		'moon.pkg': packageFixture('options.moon.pkg')
	});
	wasm('/gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm');
	wasm('/cli/sh@0.2.1/sh.wasm');
	const fetcher = vi.fn<typeof fetch>(
		async (input) =>
			routes.get(input instanceof Request ? input.url : String(input))?.() ??
			new Response('', { status: 404 })
	);
	const zipCalls = () =>
		fetcher.mock.calls.filter(([url]) => String(url).endsWith('.zip'));
	return { modules, routes, zip, wasm, fetcher, zipCalls };
}
