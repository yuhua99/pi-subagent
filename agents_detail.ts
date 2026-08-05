import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type OverlayOptions, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentsOverlay } from "./agents_overlay.ts";
import { formatElapsed, formatUsage, transcriptLines, type ThemeFg } from "./render.ts";
import { getRun, listCompletedRuns } from "./registry.ts";
import { isResultError, type SingleResult } from "./types.ts";

const REFRESH_MS = 1000;
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_LEFT = "\x1b[D";
const KEY_RIGHT = "\x1b[C";
const KEY_ESCAPE = "\x1b";

export interface DetailEntry {
	id: string;
	agent: string;
	task: string;
	taskSummary?: string;
	startedAt: number;
	finishedAt?: number;
	result: SingleResult;
	onStatus?: (fn: () => void) => () => void;
	onStream?: (fn: () => void) => () => void;
}

function paneView(lines: string[], offset: number, height: number, theme: { fg: ThemeFg }): string[] {
	const total = lines.length;
	if (total === 0 || height <= 0) return [];
	const view = lines.slice(offset, offset + height).slice();
	const hiddenAbove = offset;
	const hiddenBelow = Math.max(0, total - (offset + height));
	if (hiddenAbove > 0 && view.length > 0) {
		view[0] = theme.fg("dim", `↑ ${hiddenAbove + 1} more`);
	}
	if (hiddenBelow > 0 && view.length > 0) {
		view[view.length - 1] = theme.fg("dim", `↓ ${hiddenBelow + 1} more`);
	}
	return view;
}

export function showAgentsDetail(ctx: ExtensionCommandContext, entry: DetailEntry, overlayOptions: OverlayOptions): Promise<null> {
	return ctx.ui.custom<null>((tui, theme, _kb, done) => {
		let timer: NodeJS.Timeout | undefined;
		const unsubscribeStatus = entry.onStatus?.(() => tui.requestRender());
		const unsubscribeStream = entry.onStream?.(() => tui.requestRender());

		let activePane: "task" | "transcript" = "transcript";
		let taskScroll = 0;
		let transcriptScroll: number | null = null;
		let lastTaskMax = 0;
		let lastTranscriptMax = 0;

		const finish = () => {
			unsubscribeStatus?.();
			unsubscribeStream?.();
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
				const completed = live ? undefined : listCompletedRuns().find((run) => run.id === entry.id);
				const result = live?.result ?? completed?.result ?? entry.result;
				const finishedAt = completed?.finishedAt ?? entry.finishedAt;
				const taskSummary = live?.taskSummary ?? completed?.taskSummary ?? entry.taskSummary;
				if (result.exitCode !== -1 && timer) {
					clearInterval(timer);
					timer = undefined;
				}
				const contentWidth = width - 4;
				const running = result.exitCode === -1;
				const icon = running
					? theme.fg("warning", "○")
					: isResultError(result)
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const startedAt = live?.startedAt ?? entry.startedAt;
				const status = running
					? formatElapsed(Date.now() - startedAt)
					: finishedAt !== undefined
						? formatElapsed(finishedAt - startedAt)
						: "finished";

				const usage = formatUsage(result.usage, result.model);
				const escapeText = "tab pane · ↑↓ scroll · esc back";
				const footerGap = Math.max(1, contentWidth - visibleWidth(escapeText) - visibleWidth(usage));
				const footer = usage
					? theme.fg("dim", escapeText) + " ".repeat(footerGap) + theme.fg("dim", usage)
					: theme.fg("dim", escapeText);
				const paneBadge = " " + theme.fg("dim", "[") + theme.fg("accent", activePane) + theme.fg("dim", "]");

				return renderAgentsOverlay({
					width,
					terminalRows: tui.terminal.rows,
					theme,
					header: `${icon} ${theme.fg("accent", theme.bold(`[${entry.id}] ${entry.agent}`))}${taskSummary ? theme.fg("dim", ` — ${taskSummary}`) : ""} ${theme.fg("muted", `— ${status}`)}${paneBadge}`,
					body: (bodyWidth, bodyRows) => {
						const taskWidth = Math.max(5, Math.floor(bodyWidth * 0.3));
						const transcriptWidth = Math.max(1, bodyWidth - taskWidth - 3);
						const taskWrapped = wrapTextWithAnsi(theme.fg("dim", entry.task), taskWidth);
						lastTaskMax = Math.max(0, taskWrapped.length - bodyRows);
						taskScroll = Math.min(Math.max(0, taskScroll), lastTaskMax);
						const taskColumn = paneView(taskWrapped, taskScroll, bodyRows, theme);
						const transcript: string[] = [];
						for (const line of transcriptLines(result, theme)) {
							transcript.push(...wrapTextWithAnsi(line, transcriptWidth));
						}
						lastTranscriptMax = Math.max(0, transcript.length - bodyRows);
						if (transcriptScroll !== null) {
							transcriptScroll = Math.min(Math.max(0, transcriptScroll), lastTranscriptMax);
						}
						const transcriptOffset = transcriptScroll ?? lastTranscriptMax;
						let transcriptColumn = paneView(transcript, transcriptOffset, bodyRows, theme);
						if (transcriptColumn.length === 0) transcriptColumn = [theme.fg("muted", "(no output yet)")];
						const pad = (line: string, columnWidth: number) =>
							line + " ".repeat(Math.max(0, columnWidth - visibleWidth(line)));
						const separator = ` ${theme.fg("border", "│")} `;
						return Array.from(
							{ length: bodyRows },
							(_, index) => pad(taskColumn[index] ?? "", taskWidth) + separator + (transcriptColumn[index] ?? ""),
						);
					},
					footer,
				});
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
	}, { overlay: true, overlayOptions });
}
