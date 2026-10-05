import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem } from "@earendil-works/pi-tui";
import { closeTab, createTab, focusTab, startPi } from "../execution/herdr.ts";
import { getRun, listCompletedRuns, listRuns } from "../execution/registry.ts";
import { formatElapsed } from "../tool/render.ts";
import { isResultError, type SubagentToggle } from "../types.ts";

const AGENT_TOGGLE_ARGUMENTS = ["on", "off", "enable", "disable"];

// The built-in selector cannot scroll, so keep the list within a short terminal.
const MAX_LISTED_COMPLETED = 15;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 60);

/** Pick a run, one line each, newest completed after running; resolves to its id. */
async function pickRun(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const now = Date.now();
  const running = listRuns();
  const completed = listCompletedRuns().slice(0, MAX_LISTED_COMPLETED);
  const rows = [
    ...running.map((run) => ({
      id: run.id,
      label: `○ [${run.id}] ${run.agent} — ${formatElapsed(now - run.startedAt)} — ${run.result.taskSummary ?? oneLine(run.task)}`,
    })),
    ...completed.map((run) => {
      const { status, usage, taskSummary } = run.result;
      const icon = status === "killed" ? "■" : isResultError(run.result) ? "✗" : "✓";
      const aborted = status === "aborted" ? " · aborted" : "";
      const cost = usage.cost > 0 ? ` · $${usage.cost.toFixed(3)}` : "";
      const duration = formatElapsed(run.finishedAt - run.startedAt);
      return {
        id: run.id,
        label: `${icon} [${run.id}] ${run.agent} — ${duration}${aborted}${cost} — ${taskSummary ?? oneLine(run.task)}`,
      };
    }),
  ];
  if (rows.length === 0) {
    ctx.ui.notify("No subagent runs.", "info");
    return undefined;
  }
  const choice = await ctx.ui.select(
    `Subagents — ${running.length} running · ${completed.length} completed`,
    rows.map((row) => row.label),
  );
  return rows.find((row) => row.label === choice)?.id;
}

/** Focus a live run's tab, or reopen a finished run's session in a new tab. */
async function openRun(id: string): Promise<string | undefined> {
  const run = getRun(id);
  if (run) {
    if (!run.tabId) return `Subagent [${id}] is still starting.`;
    await focusTab(run.tabId);
    return undefined;
  }
  const completed = listCompletedRuns().find((entry) => entry.id === id);
  if (!completed?.sessionPath) return `Subagent [${id}] has no session to open.`;
  // A resume of this lineage is writing the same session file; show it instead of a second writer.
  const resuming = listRuns().find((entry) => entry.sessionPath === completed.sessionPath);
  if (resuming) return openRun(resuming.id);
  const tab = await createTab({
    cwd: completed.workingDirectory ?? process.cwd(),
    label: `${completed.agent} ${id}`,
    focus: true,
  });
  try {
    await startPi(`subagent-${id}-${Date.now().toString(36)}`, tab.paneId, [
      "--session",
      completed.sessionPath,
    ]);
  } catch (error) {
    await closeTab(tab.tabId).catch(() => {});
    throw error;
  }
  return undefined;
}

export function registerAgentsCommand(pi: ExtensionAPI, toggle: SubagentToggle) {
  pi.registerCommand("agents", {
    description:
      "Manage subagent runs; '/agents on|off' (aliases: enable|disable) toggles delegation",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = AGENT_TOGGLE_ARGUMENTS.filter((v) => v.startsWith(prefix)).map((v) => ({
        value: v,
        label: v,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;

      const argument = (args ?? "").trim();
      if (argument) {
        if (!AGENT_TOGGLE_ARGUMENTS.includes(argument)) {
          ctx.ui.notify("/agents [on|off|enable|disable]", "info");
          return;
        }

        const conversationStarted = ctx.sessionManager
          .getBranch()
          .some((entry) => entry.type === "message" && entry.message.role === "user");
        if (conversationStarted) {
          ctx.ui.notify(
            "Cannot toggle subagent delegation after the conversation has started",
            "info",
          );
          return;
        }

        const enabled = argument === "on" || argument === "enable";
        if (enabled === toggle.isEnabled()) {
          ctx.ui.notify(`Subagent delegation already ${enabled ? "enabled" : "disabled"}`, "info");
          return;
        }
        toggle.setEnabled(enabled);
        ctx.ui.notify(`Subagent delegation ${enabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      const selectedId = await pickRun(ctx);
      if (!selectedId) return;
      try {
        const notice = await openRun(selectedId);
        if (notice) ctx.ui.notify(notice, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
