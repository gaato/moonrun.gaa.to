<script lang="ts">
	// Every path shows the shell; there are no per-module pages.
	import Shell from '$lib/shell/Shell.svelte';
</script>

<svelte:head
	><title>moonrun.gaa.to</title><meta
		name="description"
		content="moonrun-js runs MoonBit wasm in your browser: cli/sh with the cli/* commands from moonbit-community/cmd, running locally."
	/></svelte:head
>
<Shell />
