<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<div class="mx-auto flex min-h-screen max-w-6xl flex-col px-5 sm:px-8">
	<main id="main" class="flex-1 py-8">{@render children()}</main>
	<footer class="border-base-300 text-base-content/75 border-t py-5 text-sm">
		<p>
			Unofficial; not affiliated with the MoonBit team. Programs and modules
			come from <a class="link" href="https://mooncakes.io">mooncakes.io</a>.
			<a class="link" href="/THIRD_PARTY_NOTICES.txt" data-sveltekit-reload
				>Third-party software notices</a
			>
		</p>
	</footer>
</div>
