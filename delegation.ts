import type { AgentConfig } from "./agents.js";
import { markCompleted, registerSubagent, unregisterSubagent } from "./registry.js";
import { DEFAULT_DELEGATION_MODE, emptyUsage, type DelegationMode, type SingleResult, type SubagentDetails } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT";

/** Whether this process is itself a subagent child (single-level delegation). */
export function isSubagentChild(): boolean {
  return process.env[SUBAGENT_CHILD_ENV] === "1";
}

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

// ---------------------------------------------------------------------------
// Delegation mode
// ---------------------------------------------------------------------------

export function parseDelegationMode(raw: unknown): DelegationMode | null {
  if (raw === undefined) return DEFAULT_DELEGATION_MODE;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "spawn" || normalized === "fork") return normalized;
  return null;
}

// ---------------------------------------------------------------------------
// Session snapshot (fork mode)
// ---------------------------------------------------------------------------

export function buildForkSessionSnapshotJsonl(sessionManager: SessionSnapshotSource): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;
  const branchEntries = sessionManager.getBranch();
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
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

export function formatAgentNames(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
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
): { placeholders: SingleResult[]; killedResults: Array<SingleResult | undefined> } {
  const placeholders = tasks.map((t) => makeRunningPlaceholder(t.agent, t.task, agents));
  const killedResults: Array<SingleResult | undefined> = tasks.map(() => undefined);
  placeholders.forEach((p, i) => {
    p.registryId = registerSubagent({
      agent: p.agent,
      task: p.task,
      pid: undefined,
      startedAt: Date.now(),
      kill: () => {
        const r = failedPlaceholderResult(p, "killed", "Subagent was killed before it started.");
        killedResults[i] = r;
        unregisterSubagent(p.registryId!);
        markCompleted(p.registryId!, r);
      },
      peek: () => p,
    });
  });
  return { placeholders, killedResults };
}
