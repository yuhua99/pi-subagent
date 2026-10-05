import { formatElapsed, type SubagentCtlDetails, type SubagentListDetails } from "../types.ts";
import type { SubagentCtlInvocation } from "../tool/schema.ts";
import { listRuns, type SubagentRun } from "./registry.ts";

export interface ControlResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentCtlDetails | SubagentListDetails;
}

/** Turn-scoped state and run control owned by the execution facade, not the registry. */
export interface ControlDeps {
  hasSpawned: () => boolean;
  kill: (id: string) => SubagentRun | undefined;
  steer: (id: string, text: string) => SubagentRun | { error: string };
}

function formatSubagentList(entries: SubagentRun[], now = Date.now()): string {
  if (entries.length === 0) return "No subagents currently running.";
  const lines: string[] = [`${entries.length} running subagent(s):`];
  for (const e of entries) {
    lines.push(
      `[${e.id}] ${e.agent}${e.result.taskSummary ? ` — ${e.result.taskSummary}` : ""} — running ${formatElapsed(now - e.startedAt)}`,
    );
  }
  return lines.join("\n");
}

export function executeControl(
  invocation: SubagentCtlInvocation,
  deps: ControlDeps,
): ControlResult {
  if (deps.hasSpawned() && invocation.action === "list") {
    return {
      content: [
        {
          type: "text",
          text: "Results arrive automatically. Never poll subagent_ctl; end your turn immediately.",
        },
      ],
      details: { action: "list", results: [] },
    };
  }
  if (invocation.action === "list") {
    const runs = listRuns();
    const details: SubagentListDetails = { action: "list", results: runs.map((run) => run.result) };
    return {
      content: [
        {
          type: "text",
          text: formatSubagentList(runs),
        },
      ],
      details,
    };
  }
  if (invocation.action === "kill") {
    const entry = deps.kill(invocation.id);
    if (!entry) {
      const details: SubagentCtlDetails = {
        action: "kill",
        id: invocation.id,
      };
      return {
        content: [
          {
            type: "text",
            text: `No running subagent with id '${invocation.id}' (it may have already finished).`,
          },
        ],
        details,
      };
    }
    const details: SubagentCtlDetails = {
      action: "kill",
      id: entry.id,
      agent: entry.agent,
    };
    return {
      content: [
        {
          type: "text",
          text: `Killed subagent [${entry.id}] (${entry.agent}).`,
        },
      ],
      details,
    };
  }
  const entry = deps.steer(invocation.id, invocation.text);
  if ("error" in entry) {
    const details: SubagentCtlDetails = {
      action: "steer",
      id: invocation.id,
    };
    return { content: [{ type: "text", text: entry.error }], details };
  }
  const details: SubagentCtlDetails = {
    action: "steer",
    id: entry.id,
    agent: entry.agent,
  };
  return {
    content: [
      {
        type: "text",
        text: `Steered subagent [${entry.id}] (${entry.agent}).`,
      },
    ],
    details,
  };
}
