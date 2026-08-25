import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type OverlayOptions } from "@earendil-works/pi-tui";
import { type DetailEntry, showAgentsDetail } from "./detail.ts";
import { showAgentsList } from "./list.ts";
import { getRun, listCompletedRuns } from "../execution/registry.ts";
import { type SubagentToggle } from "../types.ts";

const AGENTS_OVERLAY_OPTIONS: OverlayOptions = { width: "90%" };
const AGENT_TOGGLE_ARGUMENTS = ["on", "off", "enable", "disable"];

function resolveDetailEntry(id: string): DetailEntry | undefined {
  const run = getRun(id);
  if (run) {
    return {
      id: run.id,
      agent: run.agent,
      task: run.task,
      startedAt: run.startedAt,
      result: run.result,
      onStatus: (fn) => run.onStatus(fn),
      onStream: (fn) => run.onStream(fn),
    };
  }
  const completed = listCompletedRuns().find((entry) => entry.id === id);
  if (!completed) return undefined;
  return {
    id: completed.id,
    agent: completed.agent,
    task: completed.task,
    startedAt: completed.startedAt,
    finishedAt: completed.finishedAt,
    result: completed.result,
  };
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

      while (true) {
        const selectedId = await showAgentsList(ctx, killedIds, killRun, AGENTS_OVERLAY_OPTIONS);
        if (!selectedId) return;

        const entry = resolveDetailEntry(selectedId);
        if (!entry) continue;
        await showAgentsDetail(ctx, entry, AGENTS_OVERLAY_OPTIONS);
      }
    },
  });
}
