import { Marked } from 'marked';

const markdown = new Marked({ renderer: { html: () => '' } });
const elements = [
	'p',
	'br',
	'hr',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'ul',
	'ol',
	'li',
	'blockquote',
	'pre',
	'code',
	'em',
	'strong',
	'del',
	'a',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td'
];
const attributes = ['href', 'title', 'start'];

// Raw HTML is disabled at the Markdown parser, then the result is sanitized at insertion.
export async function renderMarkdown(
	element: HTMLElement,
	source: string
): Promise<void> {
	const html = await markdown.parse(source);
	if ('setHTML' in element) {
		(
			element as HTMLElement & { setHTML(html: string, options: unknown): void }
		).setHTML(html, {
			sanitizer: { elements, attributes }
		});
	} else {
		const { default: DOMPurify } = await import('dompurify');
		element.innerHTML = DOMPurify.sanitize(html, {
			ALLOWED_TAGS: [...elements, '#text'],
			ALLOWED_ATTR: attributes,
			ALLOW_ARIA_ATTR: false,
			ALLOW_DATA_ATTR: false,
			KEEP_CONTENT: false
		});
	}
}
