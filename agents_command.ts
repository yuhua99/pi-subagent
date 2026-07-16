/**
 * /agents command: inline list of running subagents with a popup transcript viewer.
 */

import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SelectItem, SelectList, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatElapsed, formatUsage, transcriptLines, truncate, type ThemeFg } from "./render.js";
import { getRun, listCompletedRuns, listRuns, type CompletedRun, type SubagentRun } from "./registry.js";
import { isResultError, type SingleResult } from "./types.js";

const REFRESH_MS = 1000;
const MAX_VISIBLE = 10;
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_LEFT = "\x1b[D";
const KEY_RIGHT = "\x1b[C";
const KEY_ESCAPE = "\x1b";

interface DetailEntry {
	id: string;
	agent: string;
	task: string;
	startedAt: number;
	finishedAt?: number;
	result: SingleResult;
	onStatus?: (fn: () => void) => () => void;
	onStream?: (fn: () => void) => () => void;
}

function paneView(
	lines: string[],
	offset: number,
	height: number,
	theme: { fg: ThemeFg },
): string[] {
	const total = lines.length;
	if (total === 0 || height <= 0) return [];
	const view = lines.slice(offset, offset + height).slice();
	const hiddenAbove = offset;
	const hiddenBelow = Math.max(0, total - (offset + height));
	if (hiddenAbove > 0 && view.length > 0) {
		view[0] = theme.fg("dim", `\u2191 ${hiddenAbove + 1} more`);
	}
	if (hiddenBelow > 0 && view.length > 0) {
		view[view.length - 1] = theme.fg("dim", `\u2193 ${hiddenBelow + 1} more`);
	}
	return view;
}

function runningLabel(e: SubagentRun, now: number): string {
	return `⏳ [${e.id}] ${e.agent} — ${formatElapsed(now - e.startedAt)}`;
}

function completedLabel(e: CompletedRun): string {
	const duration = formatElapsed(e.finishedAt - e.startedAt);
	const icon = isResultError(e.result) ? "✗" : "✓";
	const abortedSuffix = e.result.stopReason === "aborted" ? " · aborted" : "";
	return `${icon} [${e.id}] ${e.agent} — ${duration}${abortedSuffix}`;
}

function toItems(running: SubagentRun[], completed: CompletedRun[], now: number): SelectItem[] {
	const runningLabels = running.map((e) => ({ entry: e, base: runningLabel(e, now) }));
	const completedLabels = completed.map((e) => ({ entry: e, base: completedLabel(e) }));
	const baseWidth = Math.max(
		0,
		...runningLabels.map((e) => visibleWidth(e.base)),
		...completedLabels.map((e) => visibleWidth(e.base)),
	);
	const padBase = (base: string) => base + " ".repeat(baseWidth - visibleWidth(base));

	return [
		...runningLabels.map(({ entry, base }) => ({
			value: entry.id,
			label: padBase(base),
			description: truncate(entry.task, 80),
		})),
		...completedLabels.map(({ entry, base }) => ({
			value: entry.id,
			label: `${padBase(base)}${entry.result.usage.cost > 0 ? `  $${entry.result.usage.cost.toFixed(3)}` : ""}`,
			description: truncate(entry.task, 80),
		})),
	];
}

export function registerAgentsCommand(pi: ExtensionAPI) {
	pi.registerCommand("agents", {
		description: "Manage running subagents",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const killedIds = new Set<string>();

			while (true) {
				const selectedId = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					let runningEntries: SubagentRun[] = [];
					let completedEntries: CompletedRun[] = [];
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
						const nextRunning = listRuns().filter((e) => !killedIds.has(e.id));
						const nextCompleted = listCompletedRuns();
						const prevId = selectList?.getSelectedItem()?.value;
						runningEntries = nextRunning;
						completedEntries = nextCompleted;
						const allIds = [...nextRunning.map((e) => e.id), ...nextCompleted.map((e) => e.id)];
						if (allIds.length === 0) {
							selectList = null;
						} else {
							const items = toItems(nextRunning, nextCompleted, Date.now());
							const maxPrimaryColumnWidth = Math.max(0, ...items.map((item) => visibleWidth(item.label))) + 2;
							selectList = new SelectList(
								items,
								Math.min(allIds.length, MAX_VISIBLE),
								listTheme,
								{ maxPrimaryColumnWidth },
							);
							selectList.onCancel = () => finish(null);
							selectList.onSelect = (item) => finish(item.value);
							const idx = allIds.findIndex((id) => id === prevId);
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
							lines.push(
								theme.fg(
									"muted",
									`Subagents — ${runningEntries.length} running · ${completedEntries.length} completed`,
								),
							);
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
								if (selected && getRun(selected.value)) {
									getRun(selected.value)?.kill();
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

				const run = getRun(selectedId);
				const completed = run ? undefined : listCompletedRuns().find((e) => e.id === selectedId);
				if (!run && !completed) continue;

				const entry: DetailEntry = run
					? {
							id: run.id,
							agent: run.agent,
							task: run.task,
							startedAt: run.startedAt,
							result: run.result,
							onStatus: (fn) => run.onStatus(fn),
							onStream: (fn) => run.onStream(fn),
						}
					: {
							id: completed!.id,
							agent: completed!.agent,
							task: completed!.task,
							startedAt: completed!.startedAt,
							finishedAt: completed!.finishedAt,
							result: completed!.result,
						};

				await ctx.ui.custom<null>(
					(tui, theme, _kb, done) => {
						let timer: NodeJS.Timeout | undefined;
						const unsubStatus = entry.onStatus?.(() => tui.requestRender());
						const unsubStream = entry.onStream?.(() => tui.requestRender());

						let activePane: "task" | "transcript" = "transcript";
						let taskScroll = 0;
						let transcriptScroll: number | null = null;
						let lastTaskMax = 0;
						let lastTranscriptMax = 0;

						const finish = () => {
							unsubStatus?.();
							unsubStream?.();
							if (timer) clearInterval(timer);
							done(null);
						};

						if (entry.onStatus || entry.onStream) {
							timer = setInterval(() => tui.requestRender(), REFRESH_MS);
							timer.unref?.();
						}

						return {
							render: (width: number) => {
								const live = getRun(entry.id);
								const done = live ? undefined : listCompletedRuns().find((e) => e.id === entry.id);
								const result = live?.result ?? done?.result ?? entry.result;
								const finishedAt = done?.finishedAt ?? entry.finishedAt;
								if (result.exitCode !== -1 && timer) {
									clearInterval(timer);
									timer = undefined;
								}
								const innerWidth = Math.max(10, width - 4);
								const box = (line: string) =>
									theme.fg("border", "│ ") +
									line +
									" ".repeat(Math.max(0, innerWidth - visibleWidth(line))) +
									theme.fg("border", " │");
								const running = result.exitCode === -1;
								const icon = running
									? theme.fg("warning", "⏳")
									: isResultError(result)
										? theme.fg("error", "✗")
										: theme.fg("success", "✓");
								const startedAt = live?.startedAt ?? entry.startedAt;
								const status = running
									? formatElapsed(Date.now() - startedAt)
									: finishedAt !== undefined
										? formatElapsed(finishedAt - startedAt)
										: "finished";

								const bodyRows = Math.max(3, Math.floor(tui.terminal.rows * 0.8) - 6);
								const taskWidth = Math.max(5, Math.floor(innerWidth * 0.3));
								const transcriptWidth = Math.max(1, innerWidth - taskWidth - 3);

								const taskWrapped = wrapTextWithAnsi(theme.fg("dim", entry.task), taskWidth);
								lastTaskMax = Math.max(0, taskWrapped.length - bodyRows);
								taskScroll = Math.min(Math.max(0, taskScroll), lastTaskMax);
								const taskCol = paneView(taskWrapped, taskScroll, bodyRows, theme);

								const transcript: string[] = [];
								for (const line of transcriptLines(result, theme)) {
									transcript.push(...wrapTextWithAnsi(line, transcriptWidth));
								}
								lastTranscriptMax = Math.max(0, transcript.length - bodyRows);
								if (transcriptScroll !== null) {
									transcriptScroll = Math.min(Math.max(0, transcriptScroll), lastTranscriptMax);
								}
								const transcriptOffset = transcriptScroll ?? lastTranscriptMax;
								let transcriptCol = paneView(transcript, transcriptOffset, bodyRows, theme);
								if (transcriptCol.length === 0) {
									transcriptCol = [theme.fg("muted", "(no output yet)")];
								}

								const pad = (line: string, w: number) =>
									line + " ".repeat(Math.max(0, w - visibleWidth(line)));
								const sep = ` ${theme.fg("border", "│")} `;
								const rows = bodyRows;

								const usage = formatUsage(result.usage, result.model);
								const escText = "tab pane \u00b7 \u2191\u2193 scroll \u00b7 esc back";
								const footerGap = Math.max(1, innerWidth - visibleWidth(escText) - visibleWidth(usage));
								const footer = usage
									? theme.fg("dim", escText) + " ".repeat(footerGap) + theme.fg("dim", usage)
									: theme.fg("dim", escText);

								const hbar = "─".repeat(Math.max(1, width - 2));
								const lines: string[] = [];
								lines.push(theme.fg("border", `╭${hbar}╮`));
								const paneBadge =
									" " + theme.fg("dim", "[") + theme.fg("accent", activePane) + theme.fg("dim", "]");
								lines.push(box(`${icon} ${theme.fg("accent", theme.bold(`[${entry.id}] ${entry.agent}`))} ${theme.fg("muted", `— ${status}`)}${paneBadge}`));
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
								if (data === KEY_ESCAPE) {
									finish();
									return;
								}
								if (data === "\t" || data === KEY_LEFT || data === KEY_RIGHT) {
									activePane = activePane === "task" ? "transcript" : "task";
									tui.requestRender();
									return;
								}
								if (data === KEY_UP || data === "k") {
									if (activePane === "task") {
										taskScroll = Math.max(0, taskScroll - 1);
									} else {
										const effective = transcriptScroll ?? lastTranscriptMax;
										transcriptScroll = Math.max(0, effective - 1);
									}
									tui.requestRender();
									return;
								}
								if (data === KEY_DOWN || data === "j") {
									if (activePane === "task") {
										taskScroll = Math.min(lastTaskMax, taskScroll + 1);
									} else {
										const effective = transcriptScroll ?? lastTranscriptMax;
										const next = effective + 1;
										transcriptScroll = next >= lastTranscriptMax ? null : next;
									}
									tui.requestRender();
									return;
								}
								if (data === "g") {
									if (activePane === "task") taskScroll = 0;
									else transcriptScroll = 0;
									tui.requestRender();
									return;
								}
								if (data === "G") {
									if (activePane === "task") taskScroll = lastTaskMax;
									else transcriptScroll = null;
									tui.requestRender();
								}
							},
						};
					},
					{ overlay: true, overlayOptions: { width: "90%" } },
				);
			}
		},
	});
}
