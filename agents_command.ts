/**
 * /agents command: inline list of running subagents with a popup transcript viewer.
 */

import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SelectItem, SelectList, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatElapsed, transcriptLines } from "./render.js";
import { getSubagent, listSubagents, type TrackedSubagent } from "./registry.js";
import { isResultError } from "./types.js";

const REFRESH_MS = 1000;
const MAX_VISIBLE = 10;
const DETAIL_VIEWPORT_LINES = 20;
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ESCAPE = "\x1b";

function toItems(entries: TrackedSubagent[], now: number): SelectItem[] {
	return entries.map((e) => ({
		value: e.id,
		label: `[${e.id}] ${e.agent} — ${formatElapsed(now - e.startedAt)}${e.pid !== undefined ? ` (pid ${e.pid})` : ""}`,
		description: e.task,
	}));
}

export function registerAgentsCommand(pi: ExtensionAPI) {
	pi.registerCommand("agents", {
		description: "Manage running subagents",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const killedIds = new Set<string>();

			while (true) {
				const selectedId = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					let entries: TrackedSubagent[] = [];
					let selectList: SelectList | null = null;
					let timer: NodeJS.Timeout | undefined;

					const finish = (value: string | null) => {
						if (timer) clearInterval(timer);
						done(value);
					};

					const listTheme = {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					};

					const refresh = () => {
						const next = listSubagents().filter((e) => !killedIds.has(e.id));
						const prevId = selectList?.getSelectedItem()?.value;
						entries = next;
						if (next.length === 0) {
							selectList = null;
						} else {
							selectList = new SelectList(toItems(next, Date.now()), Math.min(next.length, MAX_VISIBLE), listTheme);
							selectList.onCancel = () => finish(null);
							selectList.onSelect = (item) => finish(item.value);
							const idx = next.findIndex((e) => e.id === prevId);
							if (idx >= 0) selectList.setSelectedIndex(idx);
						}
						tui.requestRender();
					};

					refresh();
					timer = setInterval(refresh, REFRESH_MS);
					timer.unref?.();

					const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
					const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

					return {
						render: (width: number) => {
							const lines: string[] = [];
							lines.push(...topBorder.render(width));
							lines.push(` ${theme.fg("accent", theme.bold(`Running subagents (${entries.length})`))}`);
							if (selectList) {
								lines.push(...selectList.render(width));
							} else {
								lines.push(` ${theme.fg("muted", "No subagents running.")}`);
							}
							lines.push(` ${theme.fg("dim", "j/k or ↑↓ navigate · enter view · x kill · esc close")}`);
							lines.push(...bottomBorder.render(width));
							return lines;
						},
						invalidate: () => selectList?.invalidate(),
						handleInput: (data: string) => {
							if (data === KEY_ESCAPE) {
								finish(null);
								return;
							}
							if (!selectList) return;
							if (data === "x") {
								const selected = selectList.getSelectedItem();
								if (selected) {
									getSubagent(selected.value)?.kill();
									killedIds.add(selected.value);
									refresh();
								}
								return;
							}
							const mapped = data === "j" ? KEY_DOWN : data === "k" ? KEY_UP : data;
							selectList.handleInput(mapped);
							tui.requestRender();
						},
					};
				});

				if (!selectedId) return;
				const entry = getSubagent(selectedId);
				if (!entry) continue;

				await ctx.ui.custom<null>(
					(tui, theme, _kb, done) => {
						let scrollFromBottom = 0;
						let timer: NodeJS.Timeout | undefined;

						const finish = () => {
							if (timer) clearInterval(timer);
							done(null);
						};

						timer = setInterval(() => tui.requestRender(), REFRESH_MS);
						timer.unref?.();

						return {
							render: (width: number) => {
								const border = theme.fg("accent", "─".repeat(Math.max(1, width)));
								const result = entry.peek();
								const running = result.exitCode === -1;
								const icon = running
									? theme.fg("warning", "⏳")
									: isResultError(result)
										? theme.fg("error", "✗")
										: theme.fg("success", "✓");
								const status = running ? formatElapsed(Date.now() - entry.startedAt) : "finished";

								const transcript: string[] = [];
								for (const line of transcriptLines(result.messages, theme)) {
									transcript.push(...wrapTextWithAnsi(line, Math.max(10, width - 2)));
								}

								const maxScroll = Math.max(0, transcript.length - DETAIL_VIEWPORT_LINES);
								if (scrollFromBottom > maxScroll) scrollFromBottom = maxScroll;
								const end = transcript.length - scrollFromBottom;
								const start = Math.max(0, end - DETAIL_VIEWPORT_LINES);
								const window = transcript.slice(start, end);

								const lines: string[] = [];
								lines.push(border);
								lines.push(` ${icon} ${theme.fg("accent", theme.bold(`[${entry.id}] ${entry.agent}`))} ${theme.fg("muted", `— ${status}`)}`);
								lines.push(` ${theme.fg("dim", `task: ${entry.task}`)}`);
								lines.push(theme.fg("muted", "─".repeat(Math.max(1, width))));
								if (window.length === 0) {
									lines.push(` ${theme.fg("muted", "(no output yet)")}`);
								} else {
									if (start > 0) lines.push(theme.fg("dim", ` ... ${start} earlier lines`));
									for (const line of window) lines.push(` ${line}`);
									if (scrollFromBottom > 0) lines.push(theme.fg("dim", ` ... ${scrollFromBottom} more lines below`));
								}
								lines.push(` ${theme.fg("dim", "j/k or ↑↓ scroll · G tail · x kill · esc back")}`);
								lines.push(border);
								return lines;
							},
							invalidate: () => {},
							handleInput: (data: string) => {
								if (data === KEY_ESCAPE) {
									finish();
									return;
								}
								if (data === "k" || data === KEY_UP) scrollFromBottom += 1;
								else if (data === "j" || data === KEY_DOWN) scrollFromBottom = Math.max(0, scrollFromBottom - 1);
								else if (data === "G") scrollFromBottom = 0;
								else if (data === "x") {
									entry.kill();
									killedIds.add(entry.id);
									finish();
									return;
								}
								tui.requestRender();
							},
						};
					},
					{ overlay: true, overlayOptions: { width: "80%" } },
				);
			}
		},
	});
}
