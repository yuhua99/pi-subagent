import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type OverlayOptions,
  type SelectItem,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { agentsOverlayBodyRows, renderAgentsOverlay } from "./shell.ts";
import { formatElapsed } from "../tool/render.ts";
import {
  listCompletedRuns,
  listRuns,
  type CompletedRun,
  type SubagentRun,
} from "../execution/registry.ts";
import { isResultError } from "../types.ts";

const REFRESH_MS = 1000;
const ABORTED_SUFFIX = " · aborted";

type StatusColor = "warning" | "success" | "error" | "muted";

const GLYPH_COLORS: Record<string, StatusColor> = {
  "○": "warning",
  "■": "muted",
  "✗": "error",
  "✓": "success",
};

function runningLabel(entry: SubagentRun, now: number): string {
  return `○ [${entry.id}] ${entry.agent} — ${formatElapsed(now - entry.startedAt)}`;
}

function completedLabel(entry: CompletedRun): string {
  const duration = formatElapsed(entry.finishedAt - entry.startedAt);
  const icon = entry.result.stopReason === "killed" ? "■" : isResultError(entry.result) ? "✗" : "✓";
  const abortedSuffix = entry.result.stopReason === "aborted" ? ABORTED_SUFFIX : "";
  return `${icon} [${entry.id}] ${entry.agent} — ${duration}${abortedSuffix}`;
}

function toItems(running: SubagentRun[], completed: CompletedRun[], now: number): SelectItem[] {
  const runningLabels = running.map((entry) => ({ entry, base: runningLabel(entry, now) }));
  const completedLabels = completed.map((entry) => ({ entry, base: completedLabel(entry) }));
  const baseWidth = Math.max(
    0,
    ...runningLabels.map((entry) => visibleWidth(entry.base)),
    ...completedLabels.map((entry) => visibleWidth(entry.base)),
  );
  const padBase = (base: string) => base + " ".repeat(baseWidth - visibleWidth(base));

  return [
    ...runningLabels.map(({ entry, base }) => ({
      value: entry.id,
      label: padBase(base),
      description: entry.taskSummary ?? entry.task,
    })),
    ...completedLabels.map(({ entry, base }) => ({
      value: entry.id,
      label: `${padBase(base)}${entry.result.usage.cost > 0 ? `  $${entry.result.usage.cost.toFixed(3)}` : ""}`,
      description: entry.taskSummary ?? entry.task,
    })),
  ];
}

export function showAgentsList(
  ctx: ExtensionCommandContext,
  killedIds: Set<string>,
  killRun: (id: string) => void,
  overlayOptions: OverlayOptions,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      let runningEntries: SubagentRun[] = [];
      let completedEntries: CompletedRun[] = [];
      let selectList: SelectList | null = null;
      let timer: NodeJS.Timeout | undefined;

      const finish = (value: string | null) => {
        if (timer) clearInterval(timer);
        done(value);
      };

      const listTheme = {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
      };

      const refresh = () => {
        const nextRunning = listRuns().filter((entry) => !killedIds.has(entry.id));
        const nextCompleted = listCompletedRuns();
        const previousId = selectList?.getSelectedItem()?.value;
        runningEntries = nextRunning;
        completedEntries = nextCompleted;
        const allIds = [
          ...nextRunning.map((entry) => entry.id),
          ...nextCompleted.map((entry) => entry.id),
        ];
        if (allIds.length === 0) {
          selectList = null;
        } else {
          const items = toItems(nextRunning, nextCompleted, Date.now());
          const maxPrimaryColumnWidth =
            Math.max(0, ...items.map((item) => visibleWidth(item.label))) + 2;
          selectList = new SelectList(
            items,
            Math.min(allIds.length, agentsOverlayBodyRows(tui.terminal.rows) - 1),
            listTheme,
            {
              maxPrimaryColumnWidth,
              truncatePrimary: ({ text, maxWidth, isSelected }) => {
                const truncated = truncateToWidth(text, maxWidth, "");
                if (isSelected) return truncated;

                const color = GLYPH_COLORS[truncated[0]];
                if (!color) return truncated;

                const coloredGlyph = theme.fg(color, truncated[0]);
                const abortedIndex = text.lastIndexOf(ABORTED_SUFFIX);
                if (abortedIndex < 0 || truncated.length <= abortedIndex) {
                  return `${coloredGlyph}${truncated.slice(1)}`;
                }
                const abortedEnd = Math.min(truncated.length, abortedIndex + ABORTED_SUFFIX.length);
                return (
                  `${coloredGlyph}${truncated.slice(1, abortedIndex)}` +
                  theme.fg("dim", truncated.slice(abortedIndex, abortedEnd)) +
                  truncated.slice(abortedEnd)
                );
              },
            },
          );
          selectList.onCancel = () => finish(null);
          selectList.onSelect = (item) => finish(item.value);
          const index = allIds.findIndex((id) => id === previousId);
          if (index >= 0) selectList.setSelectedIndex(index);
        }
        tui.requestRender();
      };

      refresh();
      timer = setInterval(refresh, REFRESH_MS);
      timer.unref?.();

      return {
        render: (width: number) =>
          renderAgentsOverlay({
            width,
            terminalRows: tui.terminal.rows,
            theme,
            header: theme.fg(
              "muted",
              `Subagents — ${runningEntries.length} running · ${completedEntries.length} completed`,
            ),
            body: (contentWidth) =>
              selectList
                ? selectList.render(contentWidth)
                : [theme.fg("muted", "  No subagents running.")],
            footer: theme.fg("dim", "enter view · x kill · c-u/d · esc close"),
          }),
        invalidate: () => selectList?.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) {
            finish(null);
            return;
          }
          if (!selectList) return;
          if (data === "x") {
            const selected = selectList.getSelectedItem();
            if (selected && listRuns().some((entry) => entry.id === selected.value)) {
              killRun(selected.value);
              refresh();
            }
            return;
          }
          if (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d")) {
            const ids = [
              ...runningEntries.map((entry) => entry.id),
              ...completedEntries.map((entry) => entry.id),
            ];
            const index = ids.findIndex((id) => id === selectList?.getSelectedItem()?.value);
            const visible = Math.min(ids.length, agentsOverlayBodyRows(tui.terminal.rows) - 1);
            const step = Math.max(1, Math.floor(visible / 2));
            selectList.setSelectedIndex(
              Math.max(0, index) + (matchesKey(data, "ctrl+d") ? step : -step),
            );
            tui.requestRender();
            return;
          }
          const mapped = matchesKey(data, "j") ? "\x1b[B" : matchesKey(data, "k") ? "\x1b[A" : data;
          selectList.handleInput(mapped);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions },
  );
}
