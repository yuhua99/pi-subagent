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
  registryId?: string,
): SingleResult {
  return {
    agent: agentName,
    agentSource: agents.find((a) => a.name === agentName)?.source ?? "unknown",
    task,
    status: "running",
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    registryId,
  };
}

export function failedPlaceholderResult(
  placeholder: SingleResult,
  status: "killed" | "failed",
  message: string,
): SingleResult {
  return {
    ...placeholder,
    status,
    errorMessage: message,
    stderr: message,
  };
}

export function reserveRunPlaceholders(
  requests: Array<{ agent: string; task: string }>,
  agents: AgentConfig[],
  onComplete: (id: string, result: SingleResult) => void,
): SingleResult[] {
  const placeholders = requests.map((request) =>
    makeRunningPlaceholder(request.agent, request.task, agents),
  );
  placeholders.forEach((p) => {
    p.registryId = registerRun({
      agent: p.agent,
      task: p.task,
      startedAt: Date.now(),
      kill: () => {
        const r = failedPlaceholderResult(p, "killed", "Subagent was killed before it started.");
        onComplete(p.registryId!, r);
      },
      result: p,
    }).id;
  });
  return placeholders;
}
