// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderMarkdown } from './markdown';
it('renders Markdown through the fallback sanitizer and removes raw HTML and dangerous links', async () => {
	const el = document.createElement('div');
	await renderMarkdown(
		el,
		'# Hello\n\n**World** [safe](https://example.com) [bad](javascript:alert%281%29)\n\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>'
	);
	expect(el.querySelector('h1')?.textContent).toBe('Hello');
	expect(el.querySelector('strong')?.textContent).toBe('World');
	expect(el.querySelector('a')?.getAttribute('href')).toBe(
		'https://example.com'
	);
	expect(
		el.querySelector('script, img, [onerror], a[href^="javascript:"]')
	).toBeNull();
});
it('uses native safe insertion when available', async () => {
	const el = document.createElement('div');
	let received = '';
	Object.assign(el, {
		setHTML(html: string) {
			received = html;
		}
	});
	await renderMarkdown(el, '**safe**\n\n<div onclick="bad()">raw</div>');
	expect(received).toContain('<strong>safe</strong>');
	expect(received).not.toContain('onclick');
});
