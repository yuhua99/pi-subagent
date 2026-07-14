/**
 * /agents command: inline list of running subagents with a popup transcript viewer.
 */

import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SelectItem, SelectList, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatElapsed, formatUsage, transcriptLines } from "./render.js";
import { getSubagent, listSubagents, type TrackedSubagent } from "./registry.js";
import { isResultError } from "./types.js";

const REFRESH_MS = 1000;
const MAX_VISIBLE = 10;
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

					const topBorder = new DynamicBorder((s: string) => theme.fg("border", s));
					const bottomBorder = new DynamicBorder((s: string) => theme.fg("border", s));

					return {
						render: (width: number) => {
							const lines: string[] = [];
							lines.push(...topBorder.render(width));
							lines.push("");
							lines.push(theme.fg("muted", `Running subagents (${entries.length})`));
							lines.push("");
							if (selectList) {
								lines.push(...selectList.render(width));
							} else {
								lines.push(theme.fg("muted", "  No subagents running."));
							}
							lines.push("");
							lines.push(theme.fg("dim", "enter view · x kill · esc close"));
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
						let timer: NodeJS.Timeout | undefined;

						const finish = () => {
							if (timer) clearInterval(timer);
							done(null);
						};

						timer = setInterval(() => tui.requestRender(), REFRESH_MS);
						timer.unref?.();

						return {
							render: (width: number) => {
								const innerWidth = Math.max(10, width - 4);
								const box = (line: string) =>
									theme.fg("border", "│ ") +
									line +
									" ".repeat(Math.max(0, innerWidth - visibleWidth(line))) +
									theme.fg("border", " │");
								const result = entry.peek();
								const running = result.exitCode === -1;
								const icon = running
									? theme.fg("warning", "⏳")
									: isResultError(result)
										? theme.fg("error", "✗")
										: theme.fg("success", "✓");
								const status = running ? formatElapsed(Date.now() - entry.startedAt) : "finished";

								const bodyRows = Math.max(3, Math.floor(tui.terminal.rows * 0.8) - 6);
								const taskWidth = Math.max(5, Math.floor(innerWidth * 0.3));
								const transcriptWidth = Math.max(1, innerWidth - taskWidth - 3);

								const taskWrapped = wrapTextWithAnsi(theme.fg("dim", entry.task), taskWidth);
								const taskCol = taskWrapped.slice(0, bodyRows);
								const taskOverflow = taskWrapped.length - taskCol.length;
								if (taskOverflow > 0) {
									taskCol[taskCol.length - 1] = theme.fg("dim", `... ${taskOverflow + 1} more lines`);
								}

								const transcript: string[] = [];
								for (const line of transcriptLines(result.messages, theme)) {
									transcript.push(...wrapTextWithAnsi(line, transcriptWidth));
								}

								const start = Math.max(0, transcript.length - bodyRows);
								const transcriptCol = transcript.slice(start + (start > 0 ? 1 : 0));
								if (transcriptCol.length === 0) {
									transcriptCol.push(theme.fg("muted", "(no output yet)"));
								} else if (start > 0) {
									transcriptCol.unshift(theme.fg("dim", `... ${start + 1} earlier lines`));
								}

								const pad = (line: string, w: number) =>
									line + " ".repeat(Math.max(0, w - visibleWidth(line)));
								const sep = ` ${theme.fg("border", "│")} `;
								const rows = bodyRows;

								const usage = formatUsage(result.usage, result.model);
								const escText = "esc back";
								const footerGap = Math.max(1, innerWidth - escText.length - usage.length);
								const footer = usage
									? theme.fg("dim", escText) + " ".repeat(footerGap) + theme.fg("dim", usage)
									: theme.fg("dim", escText);

								const hbar = "─".repeat(Math.max(1, width - 2));
								const lines: string[] = [];
								lines.push(theme.fg("border", `╭${hbar}╮`));
								lines.push(box(`${icon} ${theme.fg("accent", theme.bold(`[${entry.id}] ${entry.agent}`))} ${theme.fg("muted", `— ${status}`)}`));
								lines.push(theme.fg("border", `├${hbar}┤`));
								for (let i = 0; i < rows; i++) {
									lines.push(box(pad(taskCol[i] ?? "", taskWidth) + sep + (transcriptCol[i] ?? "")));
								}
								lines.push(theme.fg("border", `├${hbar}┤`));
								lines.push(box(footer));
								lines.push(theme.fg("border", `╰${hbar}╯`));
								return lines;
							},
							invalidate: () => {},
							handleInput: (data: string) => {
								if (data === KEY_ESCAPE) finish();
							},
						};
					},
					{ overlay: true, overlayOptions: { width: "90%" } },
				);
			}
		},
	});
}
