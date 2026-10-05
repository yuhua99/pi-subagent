import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type OverlayOptions } from "@earendil-works/pi-tui";
import { showAgentsList } from "./list.ts";
import { closeTab, createTab, focusTab, startPi } from "../execution/herdr.ts";
import { getRun, listCompletedRuns, listRuns } from "../execution/registry.ts";
import { type SubagentToggle } from "../types.ts";

const AGENTS_OVERLAY_OPTIONS: OverlayOptions = { width: "90%" };
const AGENT_TOGGLE_ARGUMENTS = ["on", "off", "enable", "disable"];

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

      const killedIds = new Set<string>();
      const killRun = (id: string) => {
        const run = getRun(id);
        if (!run) return;
        run.kill();
        killedIds.add(id);
      };

      const selectedId = await showAgentsList(ctx, killedIds, killRun, AGENTS_OVERLAY_OPTIONS);
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
