/**
 * Stable system prompt injection.
 */

export const CWD_MARKER = "\nCurrent working directory: ";

export function stripCwdTail(prompt: string): string {
	const idx = prompt.lastIndexOf(CWD_MARKER);
	if (idx === -1) return prompt;
	if (prompt.slice(idx + CWD_MARKER.length).includes("\n")) return prompt;
	return prompt.slice(0, idx);
}

export function injectIntoSystemPrompt(basePrompt: string, block: string): string {
	const idx = basePrompt.lastIndexOf(CWD_MARKER);
	if (idx === -1) return `${basePrompt}\n\n${block}`;
	return basePrompt.slice(0, idx) + "\n\n" + block + basePrompt.slice(idx);
}
