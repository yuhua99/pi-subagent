/**
 * In-process subagent runner.
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents.ts";
import {
  attachRunSteer,
  getRun,
  notifyStatus,
  rejectRunPendingQuestion,
  setRunPendingQuestion,
  notifyStream,
  registerRun,
  updateRun,
  type RunMetadata,
} from "./registry.ts";
import { allocateManagedSessionDir, registerManagedSessionPath } from "./session_files.ts";
import {
  type SingleResult,
  emptyUsage,
  getFinalAssistantMessage,
  hasFinalAssistantOutput,
  normalizeCompletedResult,
} from "../types.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function updateAssistantMetadata(result: SingleResult, message: AssistantMessage): void {
  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function isInitialTaskPrompt(result: SingleResult, key: string): boolean {
  const state = result as SingleResult & { initialTaskPromptKey?: string };
  if (state.initialTaskPromptKey !== undefined) return state.initialTaskPromptKey === key;
  Object.defineProperty(state, "initialTaskPromptKey", { value: key });
  return true;
}

function addTranscriptMessage(result: SingleResult, message: Message | undefined): boolean {
  if (
    !message ||
    (message.role !== "assistant" && message.role !== "toolResult" && message.role !== "user")
  )
    return false;

  if (message.role === "toolResult") {
    const indexes = getToolResultIndexes(result);
    const index = indexes.get(message.toolCallId);
    if (index !== undefined) {
      result.messages[index] = message;
      return false;
    }
    indexes.set(message.toolCallId, result.messages.length);
    result.messages.push(message);
    return true;
  }

  if (message.role === "assistant") updateAssistantMetadata(result, message);
  const key = `${message.role}:${message.timestamp}`;
  const seen = getSeenMessageKeys(result);
  if (message.role === "user" && isInitialTaskPrompt(result, key)) {
    seen.add(key);
    return false;
  }

  if (seen.has(key)) return false;
  seen.add(key);
  result.messages.push(message);

  if (message.role === "assistant") {
    result.usage.turns++;
    const usage = message.usage;
    if (usage) {
      result.usage.input += usage.input || 0;
      result.usage.output += usage.output || 0;
      result.usage.cacheRead += usage.cacheRead || 0;
      result.usage.cacheWrite += usage.cacheWrite || 0;
      result.usage.cost += usage.cost?.total || 0;
      result.usage.contextTokens = usage.totalTokens || 0;
    }
  }

  return true;
}

function getSeenMessageKeys(result: SingleResult): Set<string> {
  const state = result as SingleResult & { seenMessageKeys?: Set<string> };
  const existing = state.seenMessageKeys;
  if (existing) return existing;

  const created = new Set<string>();
  Object.defineProperty(state, "seenMessageKeys", { value: created });
  return created;
}

function getToolResultIndexes(result: SingleResult): Map<string, number> {
  const state = result as SingleResult & { toolResultIndexes?: Map<string, number> };
  const existing = state.toolResultIndexes;
  if (existing) return existing;

  const created = new Map<string, number>();
  Object.defineProperty(state, "toolResultIndexes", { value: created });
  return created;
}

function addToolExecutionResult(
  result: SingleResult,
  event: {
    toolCallId?: string;
    toolName?: string;
    result?: { content?: unknown; details?: unknown; usage?: unknown; addedToolNames?: unknown };
    isError?: boolean;
  },
): boolean {
  if (!event.result || !event.toolCallId || !event.toolName) return false;
  return addTranscriptMessage(result, {
    role: "toolResult",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    content: event.result.content ?? [],
    details: event.result.details,
    usage: event.result.usage,
    addedToolNames: event.result.addedToolNames,
    isError: event.isError,
    timestamp: Date.now(),
  } as Message);
}

export function processSessionEvent(
  result: SingleResult,
  event: unknown,
): "status" | "stream" | false {
  const sessionEvent = event as {
    type?: string;
    message?: Message;
    messages?: Message[];
    toolResults?: Message[];
    toolCallId?: string;
    toolName?: string;
    result?: { content?: unknown; details?: unknown; usage?: unknown; addedToolNames?: unknown };
    isError?: boolean;
  };

  switch (sessionEvent.type) {
    case "message_update":
      result.partialMessage = sessionEvent.message as AssistantMessage;
      return "stream";
    case "message_end":
      addTranscriptMessage(result, sessionEvent.message);
      result.partialMessage = undefined;
      return "status";
    case "tool_execution_end":
      addToolExecutionResult(result, sessionEvent);
      return "status";
    case "turn_end":
      addTranscriptMessage(result, sessionEvent.message);
      for (const message of sessionEvent.toolResults ?? []) addTranscriptMessage(result, message);
      result.partialMessage = undefined;
      return "status";
    case "agent_end":
      result.sawAgentEnd = true;
      for (const message of sessionEvent.messages ?? []) addTranscriptMessage(result, message);
      result.partialMessage = undefined;
      return "status";
    default:
      return false;
  }
}

export function excludeSubagentExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
  return { ...base, extensions: base.extensions.filter((ext) => !ext.tools.has("subagent")) };
}

async function createResourceLoader(
  cwd: string,
  agent: AgentConfig,
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    extensionsOverride: excludeSubagentExtensions,
    appendSystemPromptOverride: (base) =>
      agent.systemPrompt.trim() ? [...base, agent.systemPrompt] : base,
  });
  await loader.reload();
  return loader;
}

async function resolveSpawnModel(agent: AgentConfig): Promise<{
  modelRuntime?: ModelRuntime;
  model?: ReturnType<typeof resolveCliModel>["model"];
  thinkingLevel?: ThinkingLevel;
}> {
  if (!agent.model) return {};
  const modelName = agent.model;
  const modelRuntime = await ModelRuntime.create();
  const resolution = resolveCliModel({ cliModel: modelName, modelRuntime });
  if (resolution.error || !resolution.model) {
    throw new Error(resolution.error ?? `Could not resolve model "${modelName}".`);
  }
  return { modelRuntime, model: resolution.model, thinkingLevel: resolution.thinkingLevel };
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
  onQuestion: (registryId: string, agentName: string, question: string) => void;
  reservedRegistryId?: string;
}

function failedResult(result: SingleResult, message: string): SingleResult {
  result.exitCode = 1;
  result.stopReason = "error";
  result.errorMessage = message;
  result.stderr = message;
  return result;
}

function createEarlyFailure(
  opts: RunAgentOptions,
  agentSource: SingleResult["agentSource"],
  message: string,
  model?: string,
): SingleResult {
  return {
    agent: opts.agentName,
    agentSource,
    task: opts.task,
    exitCode: 1,
    messages: [],
    stderr: message,
    usage: emptyUsage(),
    ...(model !== undefined ? { model } : {}),
    stopReason: "error",
    errorMessage: message,
    registryId: opts.reservedRegistryId,
  };
}

function createRunningResult(opts: RunAgentOptions, agent: AgentConfig): SingleResult {
  return {
    agent: opts.agentName,
    agentSource: agent.source,
    task: opts.task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };
}

interface PreparedRunSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  managedSessionPath: string;
  setRegistryId(registryId: string): void;
}

function createAskMainAgentTool(
  agentName: string,
  getRegistryId: () => string | undefined,
  onQuestion: RunAgentOptions["onQuestion"],
) {
  return defineTool({
    name: "ask_main_agent",
    label: "Ask main agent",
    description: "Ask the main agent a question only when the subagent cannot decide itself.",
    parameters: Type.Object(
      { question: Type.String({ description: "Question for the main agent." }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      const registryId = getRegistryId();
      if (!registryId) throw new Error("Subagent run is no longer active.");
      const answer = await new Promise<string>((resolve, reject) => {
        if (!setRunPendingQuestion(registryId, { question: params.question, resolve, reject })) {
          reject(
            new Error(
              getRun(registryId)?.pendingQuestion
                ? "A question is already pending for this run."
                : "Subagent run is no longer active.",
            ),
          );
          return;
        }
        try {
          onQuestion(registryId, agentName, params.question);
        } catch (error) {
          rejectRunPendingQuestion(
            registryId,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      return { content: [{ type: "text", text: answer }], details: {} };
    },
  });
}

async function createRunSession(
  opts: RunAgentOptions,
  agent: AgentConfig,
  result: SingleResult,
): Promise<PreparedRunSession | undefined> {
  const isFreshRun = !opts.sessionPath;
  if (isFreshRun && agent.model === undefined) {
    failedResult(result, `Agent "${agent.name}" config must specify a model for fresh runs.`);
    return undefined;
  }
  if (
    isFreshRun &&
    agent.thinking !== undefined &&
    !THINKING_LEVELS.includes(agent.thinking as ThinkingLevel)
  ) {
    failedResult(
      result,
      `Invalid thinking level "${agent.thinking}" for agent "${agent.name}". Expected one of: ${THINKING_LEVELS.join(", ")}.`,
    );
    return undefined;
  }

  const effectiveCwd = opts.taskCwd ?? opts.cwd;
  const loaderPromise = createResourceLoader(effectiveCwd, agent);
  void loaderPromise.catch(() => {});

  let resolved: Awaited<ReturnType<typeof resolveSpawnModel>> = {};
  if (isFreshRun) {
    try {
      resolved = await resolveSpawnModel(agent);
    } catch (error) {
      failedResult(result, error instanceof Error ? error.message : String(error));
      return undefined;
    }
    if (agent.thinking === undefined && resolved.thinkingLevel === undefined) {
      failedResult(
        result,
        `Agent "${agent.name}" config must specify a thinking level for fresh runs.`,
      );
      return undefined;
    }
  }

  let createdSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const run = { registryId: opts.reservedRegistryId };
  try {
    const managedDir = allocateManagedSessionDir(agent.name);
    let manager: SessionManager;
    if (opts.sessionPath) {
      manager = SessionManager.forkFrom(opts.sessionPath, effectiveCwd, managedDir);
    } else {
      manager = SessionManager.create(effectiveCwd, managedDir);
    }
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      failedResult(result, "Cannot create a managed session file for the subagent.");
      return undefined;
    }
    const managedSessionPath = registerManagedSessionPath(sessionFile);
    const loader = await loaderPromise;
    const thinkingLevel = isFreshRun
      ? ((agent.thinking as ThinkingLevel | undefined) ?? resolved.thinkingLevel)
      : undefined;
    const tools =
      isFreshRun && agent.tools
        ? agent.tools.includes("ask_main_agent")
          ? agent.tools
          : [...agent.tools, "ask_main_agent"]
        : undefined;
    const created = await createAgentSession({
      cwd: effectiveCwd,
      agentDir: getAgentDir(),
      resourceLoader: loader,
      sessionManager: manager,
      ...(tools !== undefined ? { tools } : {}),
      customTools: [createAskMainAgentTool(agent.name, () => run.registryId, opts.onQuestion)],
      ...("modelRuntime" in resolved && resolved.modelRuntime
        ? { modelRuntime: resolved.modelRuntime }
        : {}),
      ...("model" in resolved && resolved.model ? { model: resolved.model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    createdSession = created.session;
    await createdSession.bindExtensions({
      mode: "print",
      onError: (err) => {
        console.error(`Subagent extension error (${err.extensionPath}): ${err.error}`);
      },
    });
    return {
      session: createdSession,
      managedSessionPath,
      setRegistryId(registryId) {
        run.registryId = registryId;
      },
    };
  } catch (error) {
    try {
      createdSession?.dispose();
    } catch {}
    failedResult(result, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

interface RunControl {
  state: { wasAborted: boolean; wasKilled: boolean };
  abortSession(killed: boolean): void;
  steer(text: string): void;
}

function createRunControl(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
): RunControl {
  const state = { wasAborted: false, wasKilled: false };
  return {
    state,
    abortSession(killed) {
      if (killed) state.wasKilled = true;
      else state.wasAborted = true;
      void session.abort().catch(() => {});
    },
    steer(text) {
      void session.steer(text).catch(() => {});
    },
  };
}

function attachRun(
  opts: RunAgentOptions,
  agent: AgentConfig,
  result: SingleResult,
  managedSessionPath: string,
  control: RunControl,
): string {
  const runMetadata: RunMetadata = {
    sessionPath: managedSessionPath,
    workingDirectory: opts.taskCwd ?? opts.workingDirectory ?? opts.cwd,
    parentSessionId: opts.parentSessionId,
    sourceRunId: opts.sourceRunId,
    lineageId: opts.lineageId,
  };
  let registryId = "";
  const kill = () => {
    rejectRunPendingQuestion(registryId, new Error("run killed"));
    control.abortSession(true);
  };
  const steer = (text: string) => control.steer(text);
  if (opts.reservedRegistryId) {
    registryId = opts.reservedRegistryId;
    updateRun(registryId, {
      ...runMetadata,
      startedAt: Date.now(),
      kill,
      result,
    });
    if (!getRun(registryId)) control.abortSession(true);
  } else {
    registryId = registerRun({
      agent: agent.name,
      task: opts.task,
      startedAt: Date.now(),
      kill,
      result,
      ...runMetadata,
    }).id;
  }
  attachRunSteer(registryId, steer);
  result.registryId = registryId;
  return registryId;
}

async function runSessionPrompt(
  opts: RunAgentOptions,
  agent: AgentConfig,
  result: SingleResult,
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  registryId: string,
  control: RunControl,
): Promise<SingleResult> {
  const unsubscribe = session.subscribe((event) => {
    const kind = processSessionEvent(result, event);
    if (kind === "stream") notifyStream(registryId);
    else if (kind === "status") notifyStatus(registryId);
  });
  let abortHandler: (() => void) | undefined;
  if (opts.signal) {
    abortHandler = () => control.abortSession(false);
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    if (control.state.wasKilled || control.state.wasAborted) {
      result.exitCode = 130;
    } else {
      try {
        await session.prompt(`Task: ${opts.task}`);
        const finalAssistant = getFinalAssistantMessage(result.messages);
        if (!finalAssistant) {
          failedResult(result, "Subagent completed without an assistant response.");
        } else {
          result.model = finalAssistant.model;
          result.stopReason = finalAssistant.stopReason;
          result.errorMessage = finalAssistant.errorMessage;
          result.exitCode =
            result.stopReason === "error" ||
            (result.stopReason === "length" && !hasFinalAssistantOutput(result))
              ? 1
              : 0;
        }
      } catch (error) {
        failedResult(result, error instanceof Error ? error.message : String(error));
      }
    }

    const normalized = normalizeCompletedResult(
      result,
      control.state.wasAborted || control.state.wasKilled,
    );
    if (control.state.wasKilled && normalized.stopReason === "aborted") {
      normalized.stopReason = "killed";
      normalized.errorMessage = "Subagent was killed.";
      if (normalized.stderr === "Subagent was aborted.") normalized.stderr = "Subagent was killed.";
    }
    notifyStatus(registryId);
    return normalized;
  } finally {
    if (opts.signal && abortHandler) opts.signal.removeEventListener("abort", abortHandler);
    unsubscribe();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}

/** Run one subagent in an isolated in-process SDK session. */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const agent = opts.agents.find((entry) => entry.name === opts.agentName);
  if (!agent) {
    const available = opts.agents.map((entry) => `"${entry.name}"`).join(", ") || "none";
    return createEarlyFailure(
      opts,
      "unknown",
      `Unknown agent: "${opts.agentName}". Available agents: ${available}.`,
    );
  }
  const result = createRunningResult(opts, agent);
  const prepared = await createRunSession(opts, agent, result);
  if (!prepared) return result;
  const control = createRunControl(prepared.session);
  const registryId = attachRun(opts, agent, result, prepared.managedSessionPath, control);
  prepared.setRegistryId(registryId);
  return runSessionPrompt(opts, agent, result, prepared.session, registryId, control);
}
