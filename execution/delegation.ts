import type { AgentConfig } from "../agents.ts";
import { registerRun } from "./registry.ts";
import { emptyUsage, type SingleResult } from "../types.ts";

// ---------------------------------------------------------------------------
// Placeholder lifecycle
// ---------------------------------------------------------------------------

export function makeRunningPlaceholder(
  agentName: string,
  task: string,
  agents: AgentConfig[],
): SingleResult {
  return {
    agent: agentName,
    agentSource: agents.find((a) => a.name === agentName)?.source ?? "unknown",
    task,
    status: "running",
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };
}

/** Settle a run in place so the registry, the tool row, and `/agents` stay one object. */
export function failPlaceholder(
  result: SingleResult,
  status: "killed" | "failed",
  message: string,
): SingleResult {
  result.status = status;
  result.errorMessage = message;
  result.stderr = message;
  return result;
}

export function reserveRunPlaceholders(
  requests: Array<{ agent: string; task: string }>,
  agents: AgentConfig[],
  onComplete: (id: string, result: SingleResult) => void,
): SingleResult[] {
  return requests.map((request) => {
    const placeholder = makeRunningPlaceholder(request.agent, request.task, agents);
    registerRun({
      agent: placeholder.agent,
      task: placeholder.task,
      startedAt: Date.now(),
      kill: () =>
        onComplete(
          placeholder.registryId!,
          failPlaceholder(placeholder, "killed", "Subagent was killed before it started."),
        ),
      result: placeholder,
    });
    return placeholder;
  });
}
