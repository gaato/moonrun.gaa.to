<script lang="ts">
	import { onMount } from 'svelte';
	import type { Terminal } from '@xterm/xterm';
	import type { BrowserDirectoryHandle } from 'moonrun-js/browser';
	import '@xterm/xterm/css/xterm.css';
	import { createResolver } from './resolver';
	import { fetchCommandIndex, type CliModule } from '../cli-index';
	import { LineDiscipline } from './line-discipline';
	import { createMooncakesMount } from './mooncakes-mount';
	import { createBinMount } from './bin-mount';
	import { createCommandLoader } from './commands';
	import { preloadCommands } from './preload';
	import { binMount, mooncakesMount, shellHint, shellPath } from './work';
	import { startSession } from './session';
	import { shareLink, sharedCommand } from './share';
	import type { AddedFile } from './protocol';
	import { fetchSkills, type Skill } from '../skills';
	import { exitStatus, workFilename } from '../execution';

	const maxFileBytes = 64 * 1024 * 1024;
	let container: HTMLDivElement;
	let filePicker: HTMLInputElement;
	let terminal: Terminal | undefined;
	let session: ReturnType<typeof startSession> | undefined;
	let discipline: LineDiscipline | undefined;
	let alive = true;
	let controller: AbortController | undefined;
	let status = $state('Starting shell…');
	let active = $state(false);
	let loading = $state(true);
	let warning = $state('');
	let command = $state('');
	let copied = $state('');
	let dragging = $state(false);
	let downloading = $state(false);
	let canOpenFolder = $state(false);
	let indexPromise: Promise<CliModule[]> | undefined;
	const pageController = new AbortController();
	// Survive restarts: files added while no shell runs, and the opened folder.
	let pendingFiles: AddedFile[] = [];
	let folder: BrowserDirectoryHandle | undefined;
	let prefill = '';
	// Terminal bookkeeping for lines the page prints between sh prompts.
	let prompt = '$ ';
	let atPrompt = false;

	function loadIndex() {
		return (indexPromise ??= fetchCommandIndex(pageController.signal).catch(
			(error) => {
				indexPromise = undefined;
				throw error;
			}
		));
	}
	onMount(() => {
		prefill = sharedCommand(location.search);
		canOpenFolder = 'showDirectoryPicker' in window;
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
	// One line between prompts; at an idle prompt, redraw the prompt and input.
	function notice(text: string) {
		terminal?.write(
			atPrompt
				? `\r\x1b[2K${text}\r\n${prompt}${discipline?.line ?? ''}`
				: `\r\n${text}\r\n`
		);
	}
	async function start() {
		controller?.abort();
		session?.stop();
		const abort = (controller = new AbortController());
		active = false;
		loading = true;
		warning = '';
		atPrompt = false;
		status = 'Loading commands…';
		terminal?.reset();
		terminal?.write(status);
		try {
			const [index, skills] = await Promise.all([
				loadIndex(),
				fetchSkills(abort.signal).catch(() => {
					if (!abort.signal.aborted)
						warning =
							'Skills could not be loaded. The cli/* commands are still available.';
					return [] as Skill[];
				})
			]);
			if (!alive || abort.signal.aborted) return;
			const load = createCommandLoader({ signal: abort.signal });
			const sh = index.find((entry) => entry.name === 'cli/sh');
			const wasm = sh && (await load(sh));
			if (!sh || !wasm) throw new Error('No prebuilt cli/sh is available.');
			if (!alive || abort.signal.aborted) return;
			const commands = await preloadCommands(index, load, {
				signal: abort.signal,
				onProgress: ({ completed, total, bytes }) => {
					if (!alive || abort.signal.aborted) return;
					status = `Loading commands ${completed}/${total} (${(bytes / 1024 / 1024).toFixed(1)} MiB ready)`;
					terminal?.write('\r\x1b[2K' + status);
				},
				onFailure: (entry) => {
					if (!alive || abort.signal.aborted) return;
					terminal?.write(
						`\r\x1b[2K${entry.name}: unavailable; will retry when used.\r\n`
					);
				}
			});
			if (!alive || abort.signal.aborted) return;
			const resolver = createResolver(skills, { signal: abort.signal });
			const files = pendingFiles;
			pendingFiles = [];
			terminal?.write('\r\x1b[2K' + shellHint + '\r\n');
			if (files.length)
				terminal?.write(
					`Added ${files.map((file) => file.name).join(', ')} to /work.\r\n`
				);
			if (folder)
				terminal?.write(`Mounted folder "${folder.name}" at /mnt/local.\r\n`);
			const running = (session = startSession({
				wasm,
				resolveCommand: async (name) => {
					try {
						return await resolver(name);
					} catch (error) {
						if (!abort.signal.aborted)
							status = `Could not load ${name}: ${String(error)}`;
						throw error;
					}
				},
				output: (bytes, currentPrompt) => {
					terminal?.write(bytes);
					if (!currentPrompt) return;
					prompt = currentPrompt;
					atPrompt = true;
					if (prefill && currentPrompt === '$ ') {
						discipline?.input(prefill);
						prefill = '';
					}
				},
				added: (names, failures) => {
					if (names.length) notice(`Added ${names.join(', ')} to /work.`);
					for (const failure of failures) notice(`Could not add ${failure}`);
				},
				mounts: {
					[binMount]: createBinMount(commands, load),
					[mooncakesMount]: createMooncakesMount({ signal: abort.signal })
				},
				files,
				folder
			}));
			discipline = new LineDiscipline({
				echo: (text) => terminal?.write(text),
				clear: (line) =>
					terminal?.write(
						'\x1b[2J\x1b[H' + (line === undefined ? '' : prompt + line)
					),
				write: (bytes) => {
					atPrompt = false;
					return running.write(bytes);
				},
				signal: (number) => running.signal(number),
				end: () => running.end(),
				error: (error) => {
					if (!abort.signal.aborted) status = String(error);
				}
			});
			active = true;
			loading = false;
			status = `cli/sh@${sh.version} · PATH=${shellPath}`;
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
	async function addFiles(list: Iterable<File>) {
		const files: AddedFile[] = [];
		for (const file of list) {
			try {
				workFilename(file.name);
				if (file.size > maxFileBytes)
					throw new Error(`${file.name} is larger than 64 MiB.`);
				files.push({
					name: file.name,
					bytes: new Uint8Array(await file.arrayBuffer())
				});
			} catch (error) {
				notice(error instanceof Error ? error.message : String(error));
			}
		}
		if (!files.length) return;
		if (active && session) session.addFiles(files);
		else {
			pendingFiles.push(...files);
			notice(
				`${files.map((file) => file.name).join(', ')} will be in /work when the shell starts.`
			);
		}
		terminal?.focus();
	}
	async function openFolder() {
		try {
			const picker = window as unknown as {
				showDirectoryPicker(options: {
					mode: 'readwrite';
				}): Promise<BrowserDirectoryHandle>;
			};
			const handle = await picker.showDirectoryPicker({ mode: 'readwrite' });
			folder = handle;
			if (active) session?.mountFolder(handle);
			notice(
				`Mounted folder "${handle.name}" at /mnt/local (read-write). It stays on this device.`
			);
			terminal?.focus();
		} catch (error) {
			if ((error as { name?: string })?.name !== 'AbortError')
				status = String(error);
		}
	}
	async function downloadWork() {
		if (!session) return;
		downloading = true;
		try {
			const bytes = await session.download();
			const url = URL.createObjectURL(
				new Blob([new Uint8Array(bytes)], { type: 'application/zip' })
			);
			const link = document.createElement('a');
			link.href = url;
			link.download = 'work.zip';
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch (error) {
			status = `Could not download /work: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			downloading = false;
		}
	}
	async function copyLink() {
		const link = shareLink(location.origin, command || discipline?.line || '');
		try {
			await navigator.clipboard.writeText(link);
			copied = 'Link copied.';
		} catch {
			copied = link;
		}
	}
</script>

<h1>moonrun.gaa.to</h1>
<p class="mb-3 max-w-3xl leading-relaxed">
	<a class="link" href="https://github.com/gaato/moonrun-js">moonrun-js</a>
	runs MoonBit wasm in your browser. This shell is cli/sh with the cli/* commands
	from
	<a class="link" href="https://github.com/moonbit-community/cmd"
		>moonbit-community/cmd</a
	>, compiled to wasm and published on mooncakes.io. Everything runs locally,
	without network access; /mooncakes has the published modules, read-only.
	Unofficial, not affiliated with the MoonBit team.
</p>
<p class="mb-4 text-sm">
	Add files or drop them on the terminal to put them in /work, download /work as
	work.zip{#if canOpenFolder}, or open a folder at /mnt/local{/if}. Your files
	stay in this browser. Enter sends a line · Ctrl+L redraws · Ctrl+C interrupts
	(may exit sh) · Ctrl+D on an empty line ends input.
</p>
<div
	role="region"
	aria-label="Terminal; drop files here to add them to /work"
	class="shell-terminal rounded-lg bg-[#101318] p-3"
	class:outline-dashed={dragging}
	class:outline-2={dragging}
	class:outline-primary={dragging}
	bind:this={container}
	ondragover={(event) => {
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		dragging = true;
	}}
	ondragleave={() => {
		dragging = false;
	}}
	ondrop={(event) => {
		dragging = false;
		if (!event.dataTransfer?.files.length) return;
		event.preventDefault();
		void addFiles(event.dataTransfer.files);
	}}
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
	<button class="btn" type="button" onclick={() => void copyLink()}
		>Copy link</button
	>
</form>
<div class="my-3 flex flex-wrap items-center gap-2">
	<input
		type="file"
		multiple
		class="hidden"
		bind:this={filePicker}
		onchange={() => {
			if (filePicker.files) void addFiles([...filePicker.files]);
			filePicker.value = '';
		}}
	/>
	<button type="button" class="btn" onclick={() => filePicker.click()}
		>Add files</button
	>
	<button
		type="button"
		class="btn"
		disabled={!active || downloading}
		onclick={() => void downloadWork()}>Download /work</button
	>
	{#if canOpenFolder}<button
			type="button"
			class="btn"
			onclick={() => void openFolder()}>Open folder</button
		>{/if}
	<button
		type="button"
		class="btn"
		disabled={loading}
		onclick={() => void start()}>Restart shell</button
	>
	{#if copied}<span role="status" class="text-sm break-all">{copied}</span>{/if}
</div>
<p role="status" class="my-3 text-sm">{status}</p>
{#if warning}<p role="note" class="my-3">{warning}</p>{/if}

<style>
	.shell-terminal {
		height: 26rem;
	}
</style>
