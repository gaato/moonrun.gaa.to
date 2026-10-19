<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { openPath } from '$lib/paths';
	import {
		fetchSkills,
		filterSkills,
		skillPath,
		type Skill
	} from '$lib/skills';
	let skills = $state<Skill[]>([]);
	let loading = $state(true);
	let error = $state('');
	let search = $state('');
	let author = $state('');
	let version = $state('');
	let input = $state('');
	let inputError = $state('');
	const filtered = $derived(filterSkills(skills, search, author, version));
	onMount(() => {
		const controller = new AbortController();
		fetchSkills(controller.signal)
			.then((value) => {
				skills = value;
			})
			.catch((cause) => {
				if (!controller.signal.aborted) error = String(cause);
			})
			.finally(() => {
				loading = false;
			});
		return () => controller.abort();
	});
	function open() {
		try {
			inputError = '';
			void goto(openPath(input));
		} catch (cause) {
			inputError = cause instanceof Error ? cause.message : String(cause);
		}
	}
</script>

<svelte:head
	><title>mooncakes-playground · Run MoonBit in your browser</title><meta
		name="description"
		content="An unofficial playground for running public MoonBit programs from mooncakes.io in your browser."
	/></svelte:head
>
<h1>MoonBit programs, in your browser.</h1>
<p class="max-w-3xl leading-relaxed">
	Explore skills published on mooncakes.io, or open any prebuilt MoonBit
	program. Downloads are verified with SHA-256 before running in a Worker. Files
	stay in memory, and programs have no network access.
</p>
<section
	class="border-base-300 bg-base-200 my-8 rounded-xl border p-5"
	aria-labelledby="open-heading"
>
	<h2 id="open-heading">Open a program</h2>
	<form
		class="flex flex-col gap-3 sm:flex-row"
		onsubmit={(event) => {
			event.preventDefault();
			open();
		}}
	>
		<label class="sr-only" for="module-path">Module path</label>
		<input
			id="module-path"
			class="input w-full flex-1 font-mono"
			bind:value={input}
			required
			placeholder="gaato/kbbi@0.1.6/cmd/kbbi/kbbi.wasm"
		/>
		<button type="submit" class="btn btn-primary">Open</button>
	</form>
	<p class="mt-3 text-sm">
		Use @latest or omit the version to resolve and pin the latest release.
	</p>
	{#if inputError}<p role="alert" class="text-error mt-3">{inputError}</p>{/if}
</section>
<h2>Published skills</h2>
<div class="my-4 grid gap-3 sm:grid-cols-3">
	<label class="grid gap-1" for="search"
		>Name or description<input
			id="search"
			class="input w-full"
			type="search"
			bind:value={search}
		/></label
	>
	<label class="grid gap-1" for="author"
		>Author<input
			id="author"
			class="input w-full"
			type="search"
			bind:value={author}
		/></label
	>
	<label class="grid gap-1" for="version"
		>Version<input
			id="version"
			class="input w-full"
			type="search"
			bind:value={version}
		/></label
	>
</div>
{#if loading}<p role="status">Loading skills…</p>
{:else if error}<p role="alert" class="alert alert-error">{error}</p>
{:else}
	<p role="status" class="my-4 text-sm">
		{filtered.length} skills · yanked versions are hidden
	</p>
	<ul class="grid gap-4 md:grid-cols-2">
		{#each filtered as skill}
			<li class="border-base-300 rounded-xl border p-5">
				<h3 class="font-semibold">
					<a class="link link-hover" href={skillPath(skill)}
						>{skill.metadata.name ?? skill.name}</a
					>
				</h3>
				<p class="text-base-content/70 my-2 text-sm">
					{skill.module} · {skill.version}
				</p>
				<p class="text-sm leading-relaxed">
					{skill.metadata.description ?? 'No description provided.'}
				</p>
			</li>
		{/each}
	</ul>
	{#if !filtered.length}<p>No skills match these filters.</p>{/if}
{/if}
