import * as fs from "node:fs";
import type { AgentConfig } from "./agents.ts";
import { registerRun } from "./registry.ts";
import { emptyUsage, type DelegationMode, type SingleResult, type SubagentDetails } from "./types.ts";

export function resolveForkSource(sessionManager: {
  getSessionFile: () => string | undefined;
  getLeafId: () => string | null;
}): { sourceSessionPath: string; leafId: string } | { error: string } {
  const sourceSessionPath = sessionManager.getSessionFile();
  if (!sourceSessionPath) {
    return { error: "Cannot use mode=\"fork\": fork requires a persisted parent session; the parent is running without a session file (--no-session). Restart without --no-session to use fork mode." };
  }
  if (!fs.existsSync(sourceSessionPath)) {
    return { error: `Cannot use mode="fork": parent session file does not exist: ${sourceSessionPath}. Wait for it to persist before forking.` };
  }
  const leafId = sessionManager.getLeafId();
  if (!leafId) {
    return { error: "Cannot use mode=\"fork\": parent session has no entries to fork from. Add a session entry before forking." };
  }
  return { sourceSessionPath, leafId };
}

// ---------------------------------------------------------------------------
// Helpers used in tool execute
// ---------------------------------------------------------------------------

export function makeDetailsFactory(projectAgentsDir: string | null, delegationMode: DelegationMode) {
  return (mode: "single" | "parallel") =>
    (results: SingleResult[]): SubagentDetails => ({
      mode,
      delegationMode,
      projectAgentsDir,
      results,
    });
}

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
