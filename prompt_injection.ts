/**
 * Stable system prompt injection.
 */

export const CWD_MARKER = "\nCurrent working directory: ";

export function injectIntoSystemPrompt(basePrompt: string, block: string): string {
	const idx = basePrompt.lastIndexOf(CWD_MARKER);
	if (idx === -1) return `${basePrompt}\n\n${block}`;
	return basePrompt.slice(0, idx) + "\n\n" + block + basePrompt.slice(idx);
}
