import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// Preserve moonrun's prebuilt module graph, Worker and relative wasm URLs verbatim.
const moonrun = {
	name: 'moonrun-browser-assets',
	enforce: 'pre' as const,
	resolveId(id: string) {
		if (id === 'moonrun-js/browser')
			return { id: '/_moonrun/index.js', external: true };
	}
};
export default defineConfig({
	plugins: [
		moonrun,
		tailwindcss(),
		sveltekit({ adapter: adapter({ fallback: 'index.html' }) })
	],
	optimizeDeps: { exclude: ['moonrun-js'] },
	worker: { format: 'es', plugins: () => [moonrun] },
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
		expect: { requireAssertions: true }
	}
});
