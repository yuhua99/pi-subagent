import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubagentToggle } from "../types.ts";

export function createSubagentToggle(
  pi: ExtensionAPI,
): SubagentToggle & { restoreFromBranch(entries: SessionEntry[]): void } {
  let enabled = true;
  const subagentToolNames = ["subagent", "subagent_ctl"];

  const setActiveTools = (value: boolean) => {
    const activeTools = pi.getActiveTools().filter((name) => !subagentToolNames.includes(name));
    if (value) activeTools.push(...subagentToolNames);
    pi.setActiveTools(activeTools);
  };

  const setEnabled = (value: boolean) => {
    enabled = value;
    setActiveTools(value);
    pi.appendEntry("subagent-enabled", { enabled: value });
  };

  return {
    isEnabled: () => enabled,
    setEnabled,
    restoreFromBranch(entries) {
      let restoredEnabled: boolean | undefined;
      for (const entry of entries) {
        if (entry.type !== "custom" || entry.customType !== "subagent-enabled") continue;
        const data = entry.data as { enabled?: unknown } | undefined;
        restoredEnabled = typeof data?.enabled === "boolean" ? data.enabled : undefined;
      }
      if (restoredEnabled !== undefined) enabled = restoredEnabled;
      if (restoredEnabled === false) setActiveTools(false);
    },
  };
}
