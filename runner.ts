/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FORK_ENV } from "./delegation.ts";
import { stripCwdTail } from "./prompt_injection.ts";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine } from "./runner-events.js";
import { getRun, notifyStatus, notifyStream, registerRun, updateRun } from "./registry.ts";
import {
  type DelegationMode,
  type SingleResult,
  emptyUsage,
  normalizeCompletedResult,
} from "./types.ts";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const PI_OFFLINE_ENV = "PI_OFFLINE";
const managedSessionDirs = new Set<string>();
const managedSessionPaths = new Set<string>();

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Derive the spawn command from the current process context so child invocations
 * work on Unix and Windows without going through a shell wrapper.
 */
function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writePromptToTempFile(
  agentName: string,
  prompt: string,
  filePrefix: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `${filePrefix}-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function createManagedSessionFile(
  agentName: string,
  sessionJsonl?: string,
): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `session-${safeName}.jsonl`);
  managedSessionDirs.add(dir);
  managedSessionPaths.add(filePath);
  if (sessionJsonl !== undefined) {
    fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  }
  return { dir, filePath };
}

export function createManagedResumeSessionFile(agentName: string, sessionPath: string): string {
  const sessionJsonl = fs.readFileSync(sessionPath, "utf-8");
  return createManagedSessionFile(agentName, sessionJsonl).filePath;
}

export function hasSessionPath(sessionPath: string): boolean {
  return fs.existsSync(sessionPath);
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function cleanupManagedSessions(retainedSessionPaths: Iterable<string> = []): void {
  const retained = new Set(retainedSessionPaths);
  for (const dir of managedSessionDirs) {
    const keep = [...managedSessionPaths].some(
      (sessionPath) => path.dirname(sessionPath) === dir && retained.has(sessionPath),
    );
    if (!keep) cleanupTempDir(dir);
  }
  for (const sessionPath of managedSessionPaths) {
    if (!retained.has(sessionPath)) managedSessionPaths.delete(sessionPath);
  }
  for (const dir of managedSessionDirs) {
    if (![...managedSessionPaths].some((sessionPath) => path.dirname(sessionPath) === dir)) {
      managedSessionDirs.delete(dir);
    }
  }
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

export interface BuildPiArgsOptions {
  agent: AgentConfig;
  personaPromptPath: string | null;
  task: string;
  delegationMode: DelegationMode;
  forkSessionPath: string | null;
  sessionPath?: string | null;
  parentSystemPromptPath: string | null;
  inherited: ReturnType<typeof parseInheritedCliArgs>;
}

export function buildPiArgs(opts: BuildPiArgsOptions): string[] {
  const {
    agent,
    personaPromptPath,
    task,
    delegationMode,
    forkSessionPath,
    sessionPath,
    parentSystemPromptPath,
    inherited,
  } = opts;
  const fork = delegationMode === "fork";

  // Fork children must keep the parent's request prefix for cache alignment,
  // so agent-level overrides that would change it are ignored.
  if (fork && agent.thinking !== undefined) {
    console.warn(
      'pi-subagent: fork mode ignores agent "thinking" override (must match parent for cache alignment)',
    );
  }
  if (fork && agent.tools !== undefined) {
    console.warn(
      'pi-subagent: fork mode ignores agent "tools" override (must match parent for cache alignment)',
    );
  }
  const agentThinking = fork ? undefined : agent.thinking;
  const agentTools = fork ? undefined : agent.tools;

  const stripInheritedSystemPrompt = fork && parentSystemPromptPath !== null;
  const alwaysProxy: string[] = [];
  for (let i = 0; i < inherited.alwaysProxy.length; i++) {
    if (stripInheritedSystemPrompt && inherited.alwaysProxy[i] === "--system-prompt") {
      i++;
      continue;
    }
    alwaysProxy.push(inherited.alwaysProxy[i]);
  }

  const args: string[] = [
    "--mode",
    "json",
    ...inherited.extensionArgs,
    ...alwaysProxy,
    "-p",
  ];

  const selectedSessionPath = sessionPath ?? forkSessionPath;
  if (selectedSessionPath) args.push("--session", selectedSessionPath);

  const model = agent.model ?? inherited.fallbackModel;
  if (model) args.push("--model", model);

  const thinking = agentThinking ?? inherited.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  if (agentTools && agentTools.length > 0) {
    args.push("--tools", agentTools.join(","));
  } else if (agentTools === undefined) {
    if (inherited.fallbackTools !== undefined) {
      args.push("--tools", inherited.fallbackTools);
    } else if (inherited.fallbackNoTools) {
      args.push("--no-tools");
    }
  }

  if (!fork) {
    if (personaPromptPath) args.push("--append-system-prompt", personaPromptPath);
  } else if (parentSystemPromptPath) {
    args.push("--system-prompt", parentSystemPromptPath, "--no-context-files", "--no-skills");
  }

  const message = fork && agent.systemPrompt.trim()
    ? `Task instructions:\n\n${agent.systemPrompt.trim()}\n\nTask: ${task}`
    : `Task: ${task}`;
  args.push(message);
  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Fallback working directory when the task doesn't specify one. */
  cwd: string;
  /** All available agent configs. */
  agents: AgentConfig[];
  /** Name of the agent to run. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Optional override working directory. */
  taskCwd?: string;
  /** Context mode: spawn (fresh) or fork (session snapshot + task). */
  delegationMode: DelegationMode;
  /** Serialized parent session snapshot used when delegationMode is "fork". */
  forkSessionSnapshotJsonl?: string;
  sessionPath?: string;
  parentSessionId?: string;
  workingDirectory?: string;
  sourceRunId?: string;
  lineageId?: string;
  /** Parent's effective system prompt, forwarded to fork children for cache alignment. */
  parentSystemPrompt?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Called with the registry id once the child process is spawned. */
  onSpawn?: (registryId: string) => void;
  /** Pre-reserved registry id; when set, runner updates that entry instead of registering a new one. */
  reservedRegistryId?: string;
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agents,
    agentName,
    task,
    taskCwd,
    delegationMode,
    forkSessionSnapshotJsonl,
    sessionPath,
    parentSessionId,
    workingDirectory,
    sourceRunId,
    lineageId,
    parentSystemPrompt,
    signal,
    onSpawn,
    reservedRegistryId,
  } = opts;

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      registryId: reservedRegistryId,
    };
  }

  if (
    delegationMode === "fork" &&
    !sessionPath &&
    (!forkSessionSnapshotJsonl || !forkSessionSnapshotJsonl.trim())
  ) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr:
        "Cannot run in fork mode: missing parent session snapshot context.",
      usage: emptyUsage(),
      model: agent.model,
      stopReason: "error",
      errorMessage:
        "Cannot run in fork mode: missing parent session snapshot context.",
      registryId: reservedRegistryId,
    };
  }

  const result: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: agent.model,
  };

  // Write system prompt to temp file if needed
  let promptTmpDir: string | null = null;
  let promptTmpPath: string | null = null;
  if (delegationMode === "spawn" && agent.systemPrompt.trim()) {
    const tmp = writePromptToTempFile(agent.name, agent.systemPrompt, "prompt");
    promptTmpDir = tmp.dir;
    promptTmpPath = tmp.filePath;
  }

  let parentPromptTmpDir: string | null = null;
  let parentPromptTmpPath: string | null = null;
  if (delegationMode === "fork" && parentSystemPrompt?.trim()) {
    const tmp = writePromptToTempFile(
      agent.name,
      stripCwdTail(parentSystemPrompt),
      "parent-prompt",
    );
    parentPromptTmpDir = tmp.dir;
    parentPromptTmpPath = tmp.filePath;
  }

  let sessionTmpPath: string | null;
  if (sessionPath) {
    sessionTmpPath = createManagedResumeSessionFile(agent.name, sessionPath);
  } else {
    const tmp = createManagedSessionFile(
      agent.name,
      delegationMode === "fork" ? forkSessionSnapshotJsonl : undefined,
    );
    sessionTmpPath = tmp.filePath;
  }

  try {
    const piArgs = buildPiArgs({
      agent,
      personaPromptPath: promptTmpPath,
      task,
      delegationMode,
      forkSessionPath: null,
      sessionPath: sessionTmpPath,
      parentSystemPromptPath: parentPromptTmpPath,
      inherited: inheritedCliArgs,
    });
    let wasAborted = false;
    let wasKilled = false;

    const exitCode = await new Promise<number>((resolve) => {
      const { command, prefixArgs } = resolvePiSpawn();
      const proc = spawn(command, [...prefixArgs, ...piArgs], {
        cwd: taskCwd ?? cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [SUBAGENT_CHILD_ENV]: "1",
          ...(delegationMode === "fork" ? { [SUBAGENT_FORK_ENV]: "1" } : {}),
          [PI_OFFLINE_ENV]: "1",
        },
      });

      proc.stdin.on("error", () => {
        /* ignore broken pipe on fast exits */
      });
      proc.stdin.end();

      let buffer = "";
      let didClose = false;
      let settled = false;
      let abortHandler: (() => void) | undefined;
      let semanticCompletionTimer: NodeJS.Timeout | undefined;

      const clearSemanticCompletionTimer = () => {
        if (semanticCompletionTimer) {
          clearTimeout(semanticCompletionTimer);
          semanticCompletionTimer = undefined;
        }
      };

      const terminateChild = () => {
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.unref();
          }
          return;
        }

        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!didClose) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };

      const killFn = () => {
        if (didClose || settled) return;
        wasKilled = true;
        terminateChild();
      };
      let registryId: string;
      if (reservedRegistryId) {
        registryId = reservedRegistryId;
        updateRun(reservedRegistryId, {
          pid: proc.pid,
          startedAt: Date.now(),
          kill: killFn,
          result,
          sessionPath: sessionTmpPath ?? undefined,
          workingDirectory: taskCwd ?? workingDirectory ?? cwd,
          parentSessionId,
          delegationMode,
          sourceRunId,
          lineageId,
        });
        if (!getRun(reservedRegistryId)) {
          wasKilled = true;
          terminateChild();
        }
      } else {
        registryId = registerRun({
          agent: agentName,
          task,
          pid: proc.pid,
          startedAt: Date.now(),
          kill: killFn,
          result,
          parentSessionId,
          delegationMode,
          sessionPath: sessionTmpPath ?? undefined,
          workingDirectory: taskCwd ?? workingDirectory ?? cwd,
          sourceRunId,
          lineageId,
        }).id;
      }
      result.registryId = registryId;
      onSpawn?.(registryId);

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearSemanticCompletionTimer();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve(code);
      };

      const flushLine = (line: string) => {
        const kind = processPiJsonLine(line, result);
        if (kind && result.registryId) {
          if (kind === "status") notifyStatus(result.registryId);
          else if (kind === "stream") notifyStream(result.registryId);
        }
        maybeFinishFromAgentEnd();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const maybeFinishFromAgentEnd = () => {
        if (!result.sawAgentEnd || didClose || settled) return;
        clearSemanticCompletionTimer();
        semanticCompletionTimer = setTimeout(() => {
          if (didClose || settled || !result.sawAgentEnd) return;
          if (buffer.trim()) {
            flushBufferedLines(buffer);
            buffer = "";
          }
          proc.stdout.removeListener("data", onStdoutData);
          proc.stderr.removeListener("data", onStderrData);
          finish(0);
          terminateChild();
        }, AGENT_END_GRACE_MS);
        semanticCompletionTimer.unref();
      };

      const onStdoutData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
      };

      const onStderrData = (chunk: Buffer) => {
        result.stderr += chunk.toString();
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);

      proc.on("close", (code) => {
        didClose = true;
        if (buffer.trim()) flushBufferedLines(buffer);
        finish(code ?? 0);
      });

      proc.on("error", (err) => {
        if (!result.stderr.trim()) result.stderr = err.message;
        finish(1);
      });

      // Abort handling
      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    const normalized = normalizeCompletedResult(result, wasAborted || wasKilled);
    if (wasKilled && normalized.stopReason === "aborted") {
      normalized.stopReason = "killed";
      normalized.errorMessage = "Subagent was killed.";
      if (normalized.stderr === "Subagent was aborted.") normalized.stderr = "Subagent was killed.";
    }
    return normalized;
  } finally {
    cleanupTempDir(promptTmpDir);
    cleanupTempDir(parentPromptTmpDir);
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 */
export async function mapConcurrent<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = Array.from({ length: items.length });
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
