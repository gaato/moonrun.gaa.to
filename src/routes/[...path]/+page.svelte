<script lang="ts">
	import { page } from '$app/state';
	import Runner from '$lib/Runner.svelte';
</script>

{#key page.params.path}
	<Runner pathname={page.url.pathname} search={page.url.search} />
{/key}
