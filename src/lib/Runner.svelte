<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { replaceState } from '$app/navigation';
	import type { RunOutcome } from 'moonrun-js/browser';
	import {
		parseModulePath,
		modulePath,
		wasmUrl,
		queryArgs,
		parseArgs,
		withArgs,
		type ModulePath
	} from './paths';
	import { pinVersion } from './modules';
	import { browserCache, verifiedWasm } from './integrity';
	import { fetchSkills, skillPath, loadSkill, type Skill } from './skills';
	import {
		exitStatus,
		needsNetwork,
		workFilename,
		type WorkerReply
	} from './execution';
	import Markdown from './Markdown.svelte';

	let { pathname, search }: { pathname: string; search: string } = $props();
	let argsText = $state(
		untrack(() => JSON.stringify(queryArgs(search), null, 2))
	);
	let stdin = $state('');
	let uploads = $state<File[]>([]);
	let path = $state<ModulePath>();
	let wasm: Uint8Array | undefined;
	let ready = $state(false);
	let loading = $state(true);
	let error = $state('');
	let skill = $state<Skill>();
	let documentation = $state('');
	let documentationError = $state('');
	let documentationLoading = $state(false);
	let running = $state(false);
	let stopping = $state(false);
	let status = $state('Not run');
	let outcome = $state<RunOutcome>();
	let stdout = $state('');
	let stderr = $state('');
	let copied = $state('');
	let worker: Worker | undefined;
	let alive = true;
	let generation = 0;
	const controller = new AbortController();
	const outputLimit = 1024 * 1024;
	let truncated = $state(false);
	let networkFailure = $derived(
		!running &&
			(!!error || (outcome !== undefined && exitStatus(outcome) !== '0')) &&
			needsNetwork(stdout + stderr + error + JSON.stringify(outcome ?? ''))
	);

	function cleanup() {
		generation++;
		const current = worker;
		if (!current) return;
		current.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
			if (
				data.type === 'stopped' ||
				data.type === 'outcome' ||
				data.type === 'error'
			)
				current.terminate();
		};
		current.onerror = () => current.terminate();
		current.postMessage({ type: 'stop' });
	}

	onMount(() => {
		void initialize();
		return () => {
			alive = false;
			controller.abort();
			cleanup();
		};
	});

	async function initialize() {
		try {
			const parsed = parseModulePath(pathname);
			if (!parsed)
				throw new Error('Page not found. Open a module path ending in .wasm.');
			const pinned = await pinVersion(parsed, controller.signal);
			if (!alive) return;
			path = pinned;
			if (parsed.version === 'latest') {
				const current = new URL(location.href);
				current.pathname = modulePath(pinned);
				replaceState(current, {});
			}
			const url = wasmUrl(pinned);
			void findDocumentation(modulePath(pinned));
			wasm = await verifiedWasm(
				url,
				await browserCache(),
				fetch,
				controller.signal
			);
			if (!wasm)
				throw new Error('No prebuilt executable (checksum not found).');
			if (alive) {
				ready = true;
				status = 'SHA-256 verified · ready';
			}
		} catch (cause) {
			if (alive) error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (alive) loading = false;
		}
	}

	async function findDocumentation(pinnedPath: string) {
		documentationLoading = true;
		try {
			const skills = await fetchSkills(controller.signal);
			skill = skills.find((s) => {
				try {
					return skillPath(s) === pinnedPath;
				} catch {
					return false;
				}
			});
			if (skill) documentation = await loadSkill(skill, controller.signal);
		} catch (cause) {
			if (alive)
				documentationError = `Skill documentation unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
		} finally {
			if (alive) documentationLoading = false;
		}
	}

	function append(channel: 'stdout' | 'stderr', chunk: string) {
		const current = channel === 'stdout' ? stdout : stderr;
		if (current.length + chunk.length > outputLimit) truncated = true;
		const next = (current + chunk).slice(0, outputLimit);
		if (channel === 'stdout') stdout = next;
		else stderr = next;
	}

	async function run() {
		if (!wasm || !path || running) return;
		const token = ++generation;
		error = '';
		copied = '';
		outcome = undefined;
		stdout = '';
		stderr = '';
		truncated = false;
		try {
			const args = parseArgs(argsText);
			replaceState(withArgs(new URL(location.href), args), {});
			running = true;
			status = 'Preparing files';
			const files: Record<string, Uint8Array | null> = { '/work': null };
			for (const file of uploads) {
				const name = workFilename(file.name);
				if (name in files) throw new Error(`Duplicate filename: ${file.name}`);
				if (file.size > 64 * 1024 * 1024)
					throw new Error(`${file.name} exceeds the 64 MiB file limit.`);
				files[name] = new Uint8Array(await file.arrayBuffer());
			}
			if (!alive || token !== generation) return;
			running = true;
			status = 'Running';
			worker = new Worker(new URL('./runner.worker.ts', import.meta.url), {
				type: 'module'
			});
			const currentWorker = worker;
			const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
			const finish = () => {
				append('stdout', decoders.stdout.decode());
				append('stderr', decoders.stderr.decode());
				currentWorker.terminate();
				if (worker === currentWorker) worker = undefined;
				running = false;
				stopping = false;
			};
			currentWorker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
				if (!alive || token !== generation) return;
				if (data.type === 'stdout' || data.type === 'stderr') {
					append(
						data.type,
						decoders[data.type].decode(data.bytes, { stream: true })
					);
				} else if (data.type === 'outcome') {
					outcome = data.outcome;
					status = `Exit status: ${exitStatus(data.outcome)}`;
					finish();
				} else if (data.type === 'error') {
					error = data.message;
					status = 'Run failed';
					finish();
				} else if (data.type === 'stopped') {
					status = 'Stopped · Worker terminated';
					finish();
				}
			};
			currentWorker.onerror = (event) => {
				if (!alive || token !== generation) return;
				error = event.message || 'Worker failed to load.';
				status = 'Run failed';
				finish();
			};
			currentWorker.postMessage({
				type: 'run',
				request: {
					wasm,
					args,
					name: path.filename.slice(0, -5),
					stdin: new TextEncoder().encode(stdin),
					files
				}
			});
		} catch (cause) {
			if (!alive || token !== generation) return;
			worker?.terminate();
			worker = undefined;
			running = false;
			error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	function stop() {
		if (worker) {
			stopping = true;
			worker.postMessage({ type: 'stop' });
		} else {
			generation++;
			running = false;
			status = 'Stopped';
		}
	}
	async function copyLink() {
		try {
			const url = withArgs(new URL(location.href), parseArgs(argsText));
			await navigator.clipboard.writeText(url.href);
			copied =
				'Link copied. It includes arguments only; stdin and files stay on this page.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	}
</script>

<svelte:head
	><title>{path ? `${path.filename} · ` : ''}mooncakes-playground</title
	></svelte:head
>
<h1>Run a MoonBit program</h1>
<p class="font-mono text-sm break-all">{path ? modulePath(path) : pathname}</p>
<p class="my-4 text-sm">
	Programs run in a Worker with a fresh, in-memory filesystem. Network access is
	unavailable; this playground has no relay. Requires a browser with WebAssembly
	GC and JSPI support.
</p>
{#if loading}<p role="status">Downloading and verifying the program…</p>{/if}
{#if error}<p class="alert alert-error my-4" role="alert">{error}</p>{/if}
<form
	onsubmit={(event) => {
		event.preventDefault();
		void run();
	}}
	class="my-6 grid gap-4"
>
	<label class="grid gap-2" for="args"
		>Arguments (JSON array of strings)
		<textarea
			id="args"
			class="textarea w-full font-mono"
			rows="3"
			bind:value={argsText}
			disabled={running}></textarea>
	</label>
	<label class="grid gap-2" for="stdin"
		>Standard input (UTF-8, followed by EOF)
		<textarea
			id="stdin"
			class="textarea w-full font-mono"
			rows="5"
			bind:value={stdin}
			disabled={running}></textarea>
	</label>
	<label class="grid gap-2" for="files"
		>Extra files (available under /work; maximum 64 MiB each)
		<input
			id="files"
			class="file-input w-full"
			type="file"
			multiple
			disabled={running}
			onchange={(event) => {
				uploads = Array.from(event.currentTarget.files ?? []);
			}}
		/>
	</label>
	{#if uploads.length}<ul class="text-sm">
			{#each uploads as file}<li>
					/work/{file.name} ({file.size} bytes)
				</li>{/each}
		</ul>{/if}
	<div class="flex flex-wrap gap-2">
		<button class="btn btn-primary" type="submit" disabled={!ready || running}
			>Run</button
		>
		<button
			class="btn"
			type="button"
			onclick={stop}
			disabled={!running || stopping}>{stopping ? 'Stopping…' : 'Stop'}</button
		>
		<button class="btn" type="button" onclick={copyLink} disabled={!ready}
			>Copy link</button
		>
	</div>
</form>
{#if copied}<p role="status" class="my-3 text-sm">{copied}</p>{/if}
<p role="status" class="font-semibold">{status}</p>
{#if networkFailure}<p role="note" class="alert my-4">
		This program may need network access. The browser cannot provide it
		directly, and this playground has no network relay.
	</p>{/if}
<div class="my-4 grid gap-4 lg:grid-cols-2">
	<section>
		<h2>stdout</h2>
		<pre class="terminal" aria-label="Standard output">{stdout || ' '}</pre>
	</section>
	<section>
		<h2>stderr</h2>
		<pre class="terminal" aria-label="Standard error">{stderr || ' '}</pre>
	</section>
</div>
{#if truncated}<p>Output display truncated at 1 MiB per stream.</p>{/if}
{#if outcome}<details class="my-4" open>
		<summary>RunOutcome: {outcome.kind}</summary>
		<pre class="terminal">{JSON.stringify(outcome, null, 2)}</pre>
	</details>{/if}
{#if documentationLoading}<p role="status">
		Checking skill documentation…
	</p>{/if}
{#if documentationError}<p role="note" class="my-4 text-sm">
		{documentationError}
	</p>{/if}
{#if skill}<section class="border-base-300 mt-8 border-t pt-6">
		<h2>{skill.metadata.name ?? skill.name} · SKILL.md</h2>
		{#if skill.yanked}<p class="alert my-3">
				This skill version is yanked.
			</p>{/if}
		<p class="my-3 text-sm">
			Third-party content from mooncakes.io.{documentation
				? ' Archive verified with SHA-256.'
				: ''}
		</p>
		{#if documentation}<Markdown source={documentation} />{/if}
	</section>{/if}
