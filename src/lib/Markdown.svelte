<script lang="ts">
	import { renderMarkdown } from './markdown';
	let { source }: { source: string } = $props();
	function content(node: HTMLElement, text: string) {
		void renderMarkdown(node, text);
		return {
			update(text: string) {
				void renderMarkdown(node, text);
			}
		};
	}
</script>

<div class="markdown" use:content={source}></div>
