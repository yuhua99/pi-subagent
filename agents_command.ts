/**
 * /agents command: interactive overlay to view and kill running subagents.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { formatElapsed } from "./render.js";
import { getSubagent, listSubagents, type TrackedSubagent } from "./registry.js";

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

			await ctx.ui.custom<null>((tui, theme, _kb, done) => {
				const killedIds = new Set<string>();
				let entries: TrackedSubagent[] = [];
				let selectList: SelectList | null = null;
				let timer: NodeJS.Timeout | undefined;

				const finish = () => {
					if (timer) clearInterval(timer);
					done(null);
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
						selectList.onCancel = finish;
						const idx = next.findIndex((e) => e.id === prevId);
						if (idx > 0) selectList.setSelectedIndex(idx);
					}
					tui.requestRender();
				};

				refresh();
				timer = setInterval(refresh, REFRESH_MS);
				timer.unref?.();

				return {
					render: (width: number) => {
						const lines: string[] = [];
						const border = theme.fg("accent", "─".repeat(Math.max(1, width)));
						lines.push(border);
						lines.push(` ${theme.fg("accent", theme.bold(`Running subagents (${entries.length})`))}`);
						if (selectList) {
							lines.push(...selectList.render(width));
						} else {
							lines.push(` ${theme.fg("muted", "No subagents running.")}`);
						}
						lines.push(` ${theme.fg("dim", "j/k or ↑↓ navigate · x kill · esc close")}`);
						lines.push(border);
						return lines;
					},
					invalidate: () => selectList?.invalidate(),
					handleInput: (data: string) => {
						if (data === KEY_ESCAPE) {
							finish();
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
		},
	});
}
