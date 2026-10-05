/**
 * Herdr-backed subagent runner: each run is an interactive pi in its own herdr tab.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents.ts";
import { attachRunSteer, getRun, notifyStatus, updateRun } from "./registry.ts";
import {
  agentExists,
  closeTab,
  createTab,
  promptAgent,
  startPi,
  tabExists,
  waitAgent,
} from "./herdr.ts";
import { findSessionFile, readTranscript } from "./transcript.ts";
import {
  type SingleResult,
  emptyUsage,
  getFinalAssistantMessage,
  normalizeCompletedResult,
} from "../types.ts";

/** When set, this extension registers nothing; children get it for single-level delegation. */
export const DISABLED_ENV = "PI_SUBAGENT_DISABLED";

const SESSION_ROOT = path.join(os.tmpdir(), "subagent-sessions");

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

async function resolveThinking(agent: AgentConfig): Promise<ThinkingLevel | undefined> {
  const modelName = agent.model!;
  const modelRuntime = await ModelRuntime.create();
  const resolution = resolveCliModel({ cliModel: modelName, modelRuntime });
  if (resolution.error || !resolution.model) {
    throw new Error(resolution.error ?? `Could not resolve model "${modelName}".`);
  }
  return (agent.thinking as ThinkingLevel | undefined) ?? resolution.thinkingLevel;
}

export interface RunAgentOptions {
  cwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  taskCwd?: string;
  sessionPath?: string;
  parentSessionId?: string;
  workingDirectory?: string;
  sourceRunId?: string;
  lineageId?: string;
  signal?: AbortSignal;
  reservedRegistryId: string;
}

function failedResult(result: SingleResult, message: string): SingleResult {
  result.status = "failed";
  result.stopReason = "error";
  result.errorMessage = message;
  result.stderr = message;
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The run's canonical result object. A reserved run already owns one in the
 * registry; mutating it keeps `/agents` and the registry in sync.
 */
function acquireResult(
  opts: RunAgentOptions,
  agentSource: SingleResult["agentSource"],
): SingleResult {
  const reserved = getRun(opts.reservedRegistryId)?.result;
  if (reserved) return reserved;
  return {
    agent: opts.agentName,
    agentSource,
    task: opts.task,
    status: "running",
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    registryId: opts.reservedRegistryId,
  };
}

/** Validate the agent config and build the child pi's CLI arguments. */
async function buildPiArgs(
  opts: RunAgentOptions,
  agent: AgentConfig,
  sessionDir: string,
): Promise<string[] | { error: string }> {
  const args: string[] = [];
  if (agent.systemPrompt.trim()) {
    const promptFile = path.join(sessionDir, "system-prompt.md");
    fs.writeFileSync(promptFile, agent.systemPrompt);
    args.push("--append-system-prompt", promptFile);
  }
  // Resume continues the lineage's session file in place.
  if (opts.sessionPath) return [...args, "--session", opts.sessionPath];
  // A fixed session id lets the run find its own file even if the user starts others in the tab.
  args.push("--session-dir", sessionDir, "--session-id", opts.reservedRegistryId);

  if (agent.model === undefined) {
    return { error: `Agent "${agent.name}" config must specify a model for fresh runs.` };
  }
  if (agent.thinking !== undefined && !THINKING_LEVELS.includes(agent.thinking as ThinkingLevel)) {
    return {
      error: `Invalid thinking level "${agent.thinking}" for agent "${agent.name}". Expected one of: ${THINKING_LEVELS.join(", ")}.`,
    };
  }
  let thinking: ThinkingLevel | undefined;
  try {
    thinking = await resolveThinking(agent);
  } catch (error) {
    return { error: errorMessage(error) };
  }
  if (thinking === undefined) {
    return { error: `Agent "${agent.name}" config must specify a thinking level for fresh runs.` };
  }
  args.push("--model", agent.model, "--thinking", thinking);
  if (agent.tools) args.push("--tools", agent.tools.join(","));
  return args;
}

/**
 * Run one subagent as an interactive pi in a new herdr tab. Completes when herdr
 * sees the first prompt settle (idle), then closes the tab and reads the
 * transcript from the session file. Closing the tab early kills the run.
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const registryId = opts.reservedRegistryId;
  const agent = opts.agents.find((entry) => entry.name === opts.agentName);
  const result = acquireResult(opts, agent?.source ?? "unknown");
  if (!agent) {
    const available = opts.agents.map((entry) => `"${entry.name}"`).join(", ") || "none";
    return failedResult(
      result,
      `Unknown agent: "${opts.agentName}". Available agents: ${available}.`,
    );
  }
  fs.mkdirSync(SESSION_ROOT, { recursive: true });
  const sessionDir = fs.mkdtempSync(
    path.join(SESSION_ROOT, `${agent.name.replace(/[^\w.-]+/g, "_")}-`),
  );
  const piArgs = await buildPiArgs(opts, agent, sessionDir);
  if ("error" in piArgs) return failedResult(result, piArgs.error);

  const startedAt = Date.now();
  const agentName = `${agent.name}-${registryId}`;
  let tabId: string | undefined;
  let paneId: string | undefined;
  let tabClosed: Promise<void> | undefined;
  let interrupt: "aborted" | "killed" | undefined;
  let failure: string | undefined;
  let finished = false;
  let interrupted!: () => void;
  const whenInterrupted = new Promise<void>((resolve) => (interrupted = resolve));
  const closeOwnTab = () => {
    if (tabId && !tabClosed) tabClosed = closeTab(tabId);
  };
  const stop = (outcome: "aborted" | "killed") => {
    if (finished) return;
    interrupt ??= outcome;
    interrupted();
    closeOwnTab();
  };
  /** Await a herdr call unless the run is interrupted first. */
  const untilInterrupted = (step: Promise<void>) => {
    step.catch(() => {});
    return Promise.race([step, whenInterrupted]);
  };
  const steer = (text: string) => {
    promptAgent(paneId!, text).catch((error: unknown) => {
      result.stderr = [result.stderr, `Steer failed: ${errorMessage(error)}`]
        .filter(Boolean)
        .join("\n");
      notifyStatus(registryId);
    });
  };

  updateRun(registryId, {
    workingDirectory: opts.taskCwd ?? opts.workingDirectory ?? opts.cwd,
    parentSessionId: opts.parentSessionId,
    sourceRunId: opts.sourceRunId,
    lineageId: opts.lineageId,
    startedAt,
    kill: () => stop("killed"),
  });
  if (!getRun(registryId)) stop("killed");
  const abortHandler = () => stop("aborted");
  if (opts.signal?.aborted) abortHandler();
  else opts.signal?.addEventListener("abort", abortHandler, { once: true });

  let started = false;
  try {
    if (!interrupt) {
      const tab = await createTab({
        cwd: opts.taskCwd ?? opts.cwd,
        label: "[sub]",
        focus: false,
        env: { [DISABLED_ENV]: "1" },
      });
      tabId = tab.tabId;
      paneId = tab.paneId;
      updateRun(registryId, { tabId });
      if (interrupt) closeOwnTab();
      else await untilInterrupted(startPi(agentName, paneId, piArgs));
    }
    if (!interrupt) {
      started = true;
      // Steers queued during startup must land after the task prompt.
      await untilInterrupted(promptAgent(paneId!, `Task: ${opts.task}`, ["working", "blocked"]));
    }
    if (!interrupt) {
      attachRunSteer(registryId, steer);
      await untilInterrupted(waitAgent(paneId!, ["idle", "done"]));
    }
  } catch (error) {
    // A closed tab, or a pi the user quit after it started, is a kill rather than a failure.
    if (tabId && !(await tabExists(tabId))) interrupt = "killed";
    else if (started && !(await agentExists(paneId!))) interrupt = "killed";
    else failure = errorMessage(error);
  }

  finished = true;
  opts.signal?.removeEventListener("abort", abortHandler);
  closeOwnTab();
  const closeError = await tabClosed?.then(
    () => undefined,
    (error: unknown) => errorMessage(error),
  );

  const sessionFile = opts.sessionPath ?? findSessionFile(sessionDir, registryId);
  updateRun(registryId, { sessionPath: sessionFile });
  if (sessionFile) readTranscript(result, sessionFile, startedAt);

  const finalAssistant = getFinalAssistantMessage(result.messages);
  // Esc in the child's tab settles the agent with an aborted final message.
  if (!interrupt && finalAssistant?.stopReason === "aborted") interrupt = "aborted";
  if (failure !== undefined) failedResult(result, failure);
  else if (!interrupt) {
    if (!finalAssistant) {
      failedResult(result, "Subagent completed without an assistant response.");
    } else {
      result.model = finalAssistant.model;
      result.stopReason = finalAssistant.stopReason;
      result.errorMessage = finalAssistant.errorMessage;
    }
  }
  if (closeError) result.stderr = [result.stderr, closeError].filter(Boolean).join("\n");
  const normalized = normalizeCompletedResult(result, interrupt);
  notifyStatus(registryId);
  return normalized;
}
