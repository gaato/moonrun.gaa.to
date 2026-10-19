<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<div class="mx-auto flex min-h-screen max-w-6xl flex-col px-5 sm:px-8">
	<header
		data-sveltekit-reload
		class="border-base-300 mb-8 flex flex-wrap items-center justify-between gap-4 border-b py-5"
	>
		<a class="text-lg font-bold tracking-tight" href="/">mooncakes-playground</a
		>
		<nav aria-label="Main navigation" class="flex gap-5 text-sm">
			<a href="/">Skills</a><a href="/shell">Shell</a>
		</nav>
	</header>
	<main id="main" class="flex-1 pb-10">{@render children()}</main>
	<footer class="border-base-300 text-base-content/75 border-t py-5 text-sm">
		<p>
			Unofficial. Uses public files from <a
				class="link"
				href="https://mooncakes.io">mooncakes.io</a
			>; not affiliated with the MoonBit team.
		</p>
		<p class="mt-2">
			Powered by moonrun-js · <a
				class="link"
				href="/THIRD_PARTY_NOTICES.txt"
				data-sveltekit-reload>Third-party software notices</a
			>
		</p>
	</footer>
</div>
