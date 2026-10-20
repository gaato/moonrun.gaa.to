import { expect, it } from 'vitest';
import { shareLink, sharedCommand } from './share';
import { LineDiscipline } from './line-discipline';
it('round trips a command line through a share link', () => {
	const line = "echo 'a b' | tr a-z A-Z && ls /bin # 100% 日本語+";
	const link = shareLink('https://moonrun.gaa.to', line);
	expect(link).toMatch(/^https:\/\/moonrun\.gaa\.to\/\?cmd=/);
	expect(sharedCommand(new URL(link).search)).toBe(line);
	expect(shareLink('https://moonrun.gaa.to', '')).toBe(
		'https://moonrun.gaa.to/'
	);
	expect(sharedCommand('?cmd=echo+hi')).toBe('echo hi');
	expect(sharedCommand('?other=1')).toBe('');
});
it('prefills the line discipline without submitting, even with newlines in the link', async () => {
	const write = async (_bytes: Uint8Array) => {
		throw new Error('must not submit');
	};
	const echo: string[] = [];
	const input = new LineDiscipline({
		echo: (text) => echo.push(text),
		clear() {},
		write,
		signal() {},
		end() {},
		error() {}
	});
	input.input(sharedCommand('?cmd=' + encodeURIComponent('ls\r\n/bin\x03')));
	await input.flush();
	expect(input.line).toBe('ls /bin ');
	expect(echo.join('')).toBe('ls /bin ');
});
