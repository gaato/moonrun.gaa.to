<script lang="ts">
	import { onMount } from 'svelte';
	import type { Terminal } from '@xterm/xterm';
	import '@xterm/xterm/css/xterm.css';
	import { createResolver, skillCommands } from './resolver';
	import { cliProgramPath, fetchCliIndex, type CliModule } from '../cli-index';
	import { LineDiscipline } from './line-discipline';
	import { createMooncakesMount } from './mooncakes-mount';
	import { shellHint } from './work';
	import { startSession } from './session';
	import { fetchSkills, type Skill } from '../skills';
	import { exitStatus } from '../execution';

	let container: HTMLDivElement;
	let terminal: Terminal | undefined;
	let session: ReturnType<typeof startSession> | undefined;
	let discipline: LineDiscipline | undefined;
	let alive = true;
	let controller: AbortController | undefined;
	let skills = $state<Skill[]>([]);
	const availableSkills = $derived(skillCommands(skills));
	let status = $state('Starting shell…');
	let active = $state(false);
	let loading = $state(true);
	let warning = $state('');
	let command = $state('');
	let commandList: HTMLDetailsElement;
	let indexPromise: Promise<CliModule[]> | undefined;
	const pageController = new AbortController();
	let cliIndex = $state<CliModule[]>([]);
	let preloadIssues = $state<Record<string, string>>({});
	let resolved = $state<{ name: string; path: string }[]>([]);

	function loadIndex() {
		return (indexPromise ??= fetchCliIndex(pageController.signal).catch(
			(error) => {
				indexPromise = undefined;
				throw error;
			}
		));
	}
	onMount(() => {
		let dispose = () => {};
		void (async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([
				import('@xterm/xterm'),
				import('@xterm/addon-fit')
			]);
			if (!alive) return;
			const term = (terminal = new Terminal({
				convertEol: true,
				cursorBlink: true,
				screenReaderMode: true,
				scrollback: 3000,
				fontSize: 15,
				theme: { background: '#101318', foreground: '#e5e7eb' }
			}));
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(container);
			fit.fit();
			term.textarea?.setAttribute('aria-label', 'Shell terminal');
			term.attachCustomKeyEventHandler(
				(event) =>
					!(
						event.key === 'Enter' &&
						(event.isComposing || event.keyCode === 229)
					)
			);
			const input = term.onData((data) => {
				if (active) discipline?.input(data);
			});
			const observer = new ResizeObserver(() => fit.fit());
			observer.observe(container);
			dispose = () => {
				observer.disconnect();
				input.dispose();
				term.dispose();
			};
			await start();
		})().catch((error) => {
			if (alive) {
				status = String(error);
				loading = false;
			}
		});
		return () => {
			alive = false;
			controller?.abort();
			pageController.abort();
			session?.stop();
			dispose();
		};
	});
	async function start() {
		controller?.abort();
		session?.stop();
		const abort = (controller = new AbortController());
		active = false;
		loading = true;
		warning = '';
		resolved = [];
		preloadIssues = {};
		cliIndex = [];
		status = 'Loading command index and verified shell…';
		terminal?.reset();
		terminal?.write(status);
		try {
			const [index, registry] = await Promise.all([
				loadIndex(),
				fetchSkills(abort.signal).catch(() => {
					if (!abort.signal.aborted)
						warning =
							'Skills could not be loaded. CLI commands are still available.';
					return [] as Skill[];
				})
			]);
			if (!alive || abort.signal.aborted) return;
			skills = registry;
			const mount = createMooncakesMount({ signal: abort.signal });
			const resolver = createResolver(skills, {
				mount,
				index,
				signal: abort.signal,
				onResolved: (name, path) => {
					if (alive && !abort.signal.aborted)
						resolved = [...resolved, { name, path }];
				}
			});
			const wasm = await resolver('sh');
			if (!wasm)
				throw new Error('No prebuilt cli/sh or sh skill is available.');
			if (!alive || abort.signal.aborted) return;
			const commands = await resolver.preload({
				onProgress: ({ completed, total, bytes }) => {
					if (!alive || abort.signal.aborted) return;
					status = `Downloading commands ${completed}/${total} (${(bytes / 1024 / 1024).toFixed(1)} MiB ready)`;
					terminal?.write('\r\x1b[2K' + status);
				},
				onFailure: (entry, error) => {
					if (!alive || abort.signal.aborted) return;
					preloadIssues = { ...preloadIssues, [entry.name]: String(error) };
					terminal?.write(
						`\r\x1b[2K${entry.name}: unavailable; will retry when used.\r\n`
					);
				}
			});
			if (!alive || abort.signal.aborted) return;
			cliIndex = commands;
			terminal?.write('\r\n' + shellHint + '\r\n');
			const running = (session = startSession(
				wasm,
				async (name, cwd) => {
					try {
						return await resolver(name, cwd);
					} catch (error) {
						if (!abort.signal.aborted)
							status = `Could not resolve ${name}: ${String(error)}`;
						throw error;
					}
				},
				(bytes) => terminal?.write(bytes),
				mount
			));
			discipline = new LineDiscipline({
				echo: (text) => terminal?.write(text),
				write: (bytes) => running.write(bytes),
				signal: (number) => running.signal(number),
				end: () => running.end(),
				error: (error) => {
					if (!abort.signal.aborted) status = String(error);
				}
			});
			active = true;
			loading = false;
			status = `${resolved.find((item) => item.name === 'sh')!.path} · /work`;
			terminal?.focus();
			const outcome = await running.finished;
			if (!alive || abort.signal.aborted) return;
			active = false;
			status = outcome
				? `Shell exited: ${exitStatus(outcome)} (${outcome.kind}). Restart for a fresh /work.`
				: 'Shell stopped.';
		} catch (error) {
			if (alive && !abort.signal.aborted) {
				active = false;
				loading = false;
				status = String(error);
				terminal?.write(
					'\r\x1b[2KShell could not start. See status below.\r\n'
				);
			}
		}
	}
	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!active || !discipline) return;
		discipline.input(command + '\r');
		command = '';
		terminal?.focus();
	}
</script>

<h1>Shell</h1>
<p class="mb-3 text-sm">
	Run <a
		class="link"
		href="#commands"
		onclick={() => {
			commandList.open = true;
		}}>CLI commands and published skills</a
	> locally in your browser. Network access is unavailable.
</p>
<p class="mb-4 text-sm">
	Enter sends a line · Backspace edits · Ctrl+C interrupts (may exit sh) ·
	Ctrl+D on an empty line ends input. Files in /work last for this session.
</p>
<div
	class="shell-terminal rounded-lg bg-[#101318] p-3"
	bind:this={container}
></div>
<form onsubmit={submit} class="my-3 flex flex-wrap items-center gap-2">
	<label for="shell-command">Command</label>
	<input
		id="shell-command"
		class="input min-w-0 flex-1 font-mono"
		bind:value={command}
		disabled={!active}
		autocomplete="off"
		spellcheck="false"
	/>
	<button class="btn" type="submit" disabled={!active}>Send</button>
</form>
<div class="my-4 flex flex-wrap items-center gap-3">
	<p role="status">{status}</p>
	<button
		type="button"
		class="btn"
		disabled={loading}
		onclick={() => void start()}>Restart shell</button
	>
</div>
{#if warning}<p role="note" class="my-3">{warning}</p>{/if}
<details id="commands" class="mt-8" bind:this={commandList}>
	<summary class="cursor-pointer font-semibold">Available commands</summary>
	<p class="my-3 text-sm">
		CLI modules are downloaded before the prompt appears, using this page’s
		version index. Missing names try the module API, then skills in full-path
		order. Skills download on demand; results stay fixed until restart. Use
		owner/module@version/path/name.wasm for an explicit version, or @latest.
		Unknown names return command-not-found. All skill alternatives work by full
		path.
	</p>
	{#if resolved.length}
		<h2>Resolved this session</h2>
		<ul class="my-3 text-xs">
			{#each resolved as item}<li class="break-all">
					<code
						>{item.name} →
						<a class="link" href={item.path}>{item.path}</a></code
					>
				</li>{/each}
		</ul>
	{/if}
	<h2>CLI commands</h2>
	<p class="my-3 text-sm">
		Modules without prebuilt executables are skipped. Failed downloads retry on
		use. Reload this page to refresh the version index (cached at the edge for
		10 minutes).
	</p>
	<ul class="my-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
		{#each cliIndex as entry}<li>
				<a class="link font-mono text-sm" href={cliProgramPath(entry)}
					>{entry.name.slice(4)}</a
				>
				<span class="text-xs">{entry.version}</span>
				{#if preloadIssues[entry.name]}<span class="block text-xs"
						>Unavailable during preload</span
					>{/if}
			</li>{/each}
	</ul>
	{#if skills.length}<h2>Skills</h2>
		<ul>
			{#each availableSkills as entry}<li>
					<a class="link" href={entry.path}>{entry.name}</a>
					{#if entry.aliases.length}<span class="text-sm">
							(alias: {entry.aliases.join(', ')})</span
						>{/if}
					<code class="block font-mono text-xs break-all">{entry.path}</code>
				</li>{/each}
		</ul>{/if}
</details>

<style>
	.shell-terminal {
		height: 26rem;
	}
</style>
