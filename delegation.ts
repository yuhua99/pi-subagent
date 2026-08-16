import type { AgentConfig } from "./agents.ts";
import { registerRun } from "./registry.ts";
import { emptyUsage, type SingleResult } from "./types.ts";

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
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    registryId,
  };
}

export function failedPlaceholderResult(
  placeholder: SingleResult,
  stopReason: "killed" | "error",
  message: string,
): SingleResult {
  return {
    ...placeholder,
    exitCode: 1,
    stopReason,
    errorMessage: message,
    stderr: message,
  };
}

export function reserveParallelPlaceholders(
  tasks: Array<{ agent: string; task: string }>,
  agents: AgentConfig[],
  onComplete: (id: string, result: SingleResult) => void,
): { placeholders: SingleResult[]; killedResults: Array<SingleResult | undefined> } {
  const placeholders = tasks.map((t) => makeRunningPlaceholder(t.agent, t.task, agents));
  const killedResults: Array<SingleResult | undefined> = tasks.map(() => undefined);
  placeholders.forEach((p, i) => {
    p.registryId = registerRun({
      agent: p.agent,
      task: p.task,
      pid: undefined,
      startedAt: Date.now(),
      kill: () => {
        const r = failedPlaceholderResult(p, "killed", "Subagent was killed before it started.");
        killedResults[i] = r;
        onComplete(p.registryId!, r);
      },
      result: p,
    }).id;
  });
  return { placeholders, killedResults };
}
