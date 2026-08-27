import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents.ts";
import {
  failedPlaceholderResult,
  makeRunningPlaceholder,
  reserveRunPlaceholders,
} from "./delegation.ts";
import { cleanupManagedSessions, hasManagedSessionPath } from "./session_files.ts";
import {
  answerRunPendingQuestion,
  clearSessionState,
  completeRun,
  getRun,
  setRunPhase,
  bindToolCallRowInvalidate,
  listCompletedRuns,
  listRuns,
  reserveResumeRun,
  setRunTaskSummary,
  type SubagentRun,
} from "./registry.ts";
import { runAgent, type RunAgentOptions } from "./runner.ts";
import { summarizeTask } from "../tool/task_summary.ts";
import { executeControl as executeControlAction } from "./control.ts";
import {
  getResultSummaryText,
  isResultError,
  isResultSuccess,
  type SingleResult,
  type SubagentDetails,
  type SubagentCtlDetails,
  type SubagentInspectDetails,
  type SubagentListDetails,
  type TaskSpec,
} from "../types.ts";
import {
  MAX_PARALLEL_TASKS,
  type SubagentCtlInvocation,
  type SubagentInvocation,
} from "../tool/schema.ts";

export interface SubagentExecutionContext extends Pick<ExtensionContext, "modelRegistry"> {
  cwd: string;
  sessionManager: {
    getSessionId: () => string;
  };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails | SubagentListDetails | SubagentInspectDetails | SubagentCtlDetails;
}

interface SubagentExecution {
  execute(
    toolCallId: string,
    invocation: SubagentInvocation,
    ctx: SubagentExecutionContext,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  executeControl(
    invocation: SubagentCtlInvocation,
    ctx: Pick<ExtensionContext, "modelRegistry">,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  kill(id: string): SubagentRun | undefined;
  steer(id: string, text: string): SubagentRun | { error: string };
  onAgentStart(): void;
  markSpawned(): void;
  shutdown(): Promise<void>;
}

export function createSubagentExecution(
  pi: Pick<ExtensionAPI, "sendMessage">,
  getAgents: () => AgentConfig[],
): SubagentExecution {
  let hasSpawned = false;
  const makeDetails = (results: SingleResult[]): SubagentDetails => ({
    results,
  });
  const sendQuestion = (id: string, agent: string, question: string) => {
    pi.sendMessage(
      {
        customType: "subagent_question",
        content: `Subagent [${id}] (${agent}) needs an answer:\n\n${question}\n\nAnswer via subagent_ctl action "answer" with run id "${id}".`,
        display: false,
        details: { id, agent, question },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  };
  const startTaskSummary = (id: string, task: string, ctx: SubagentExecutionContext) => {
    void summarizeTask(task, ctx)
      .then((summary) => {
        if (summary) setRunTaskSummary(id, task, summary);
      })
      .catch(() => {});
  };

  const retainedSessionPaths = () => {
    const paths = new Set<string>();
    for (const entry of listRuns()) {
      if (entry.sessionPath) paths.add(entry.sessionPath);
    }
    for (const entry of listCompletedRuns()) {
      if (isResultSuccess(entry.result) && entry.sessionPath) {
        paths.add(entry.sessionPath);
      }
    }
    return paths;
  };

  const completeSubagentRun = (id: string, result: SingleResult) => {
    if (!getRun(id)) return;
    result.registryId = id;
    completeRun(id, result);
    cleanupManagedSessions(retainedSessionPaths());
  };

  const onResumeKill = (id: string) => {
    const entry = getRun(id);
    if (!entry) return;
    completeSubagentRun(
      id,
      failedPlaceholderResult(entry.result, "killed", "Subagent was killed before it started."),
    );
  };

  const executeSingle = async ({
    ctx,
    toolCallId,
    reservedRegistryId,
    ...runOptions
  }: Omit<RunAgentOptions, "onSpawn" | "onQuestion" | "reservedRegistryId"> & {
    ctx: SubagentExecutionContext;
    toolCallId?: string;
    reservedRegistryId: string;
  }): Promise<ToolResult> => {
    const { agentName, task, agents, cwd } = runOptions;
    startTaskSummary(reservedRegistryId, task, ctx);
    if (toolCallId) bindToolCallRowInvalidate(toolCallId, reservedRegistryId);

    const runPromise = runAgent({
      ...runOptions,
      reservedRegistryId,
      workingDirectory: cwd,
      onQuestion: sendQuestion,
    });

    runPromise.then(
      (result) => {
        const id = result.registryId ?? reservedRegistryId;
        const status = isResultError(result) ? result.stopReason || "failed" : "completed";
        completeSubagentRun(id, result);
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: `Background subagent [${id}] (${result.agent}) ${status}.\n\n${getResultSummaryText(result)}`,
            display: false,
            details: makeDetails([result]),
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const r = failedPlaceholderResult(
          makeRunningPlaceholder(agentName, task, agents, reservedRegistryId),
          "error",
          message,
        );
        completeSubagentRun(reservedRegistryId, r);
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: `Background subagent [${reservedRegistryId}] (${agentName}) failed: ${message}`,
            display: false,
            details: makeDetails([r]),
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      },
    );

    setRunPhase(reservedRegistryId, "background");
    hasSpawned = true;
    return {
      content: [
        {
          type: "text",
          text: `Started subagent [${reservedRegistryId}] (${agentName}). Result arrives automatically as a new message. Never poll subagent_ctl or sleep; end your turn immediately.`,
        },
      ],
      details: makeDetails([makeRunningPlaceholder(agentName, task, agents, reservedRegistryId)]),
    };
  };

  const executeRun = async (
    tasks: TaskSpec[],
    agents: AgentConfig[],
    defaultCwd: string,
    ctx: SubagentExecutionContext,
    parentSessionId: string,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> => {
    if (tasks.length > MAX_PARALLEL_TASKS) {
      return {
        content: [
          {
            type: "text",
            text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
          },
        ],
        details: makeDetails([]),
      };
    }

    const placeholders = reserveRunPlaceholders(tasks, agents, completeSubagentRun);
    for (const p of placeholders) {
      bindToolCallRowInvalidate(toolCallId, p.registryId!);
      startTaskSummary(p.registryId!, p.task, ctx);
    }
    const batchPromise = mapConcurrent(tasks, MAX_PARALLEL_TASKS, async (t, i) => {
      try {
        const r = await runAgent({
          cwd: defaultCwd,
          agents,
          agentName: t.agent,
          task: t.task,
          taskCwd: t.cwd,
          parentSessionId,
          workingDirectory: t.cwd ?? defaultCwd,
          signal,
          reservedRegistryId: placeholders[i].registryId,
          onQuestion: sendQuestion,
        });
        completeSubagentRun(r.registryId ?? placeholders[i].registryId!, r);
        return r;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const r = failedPlaceholderResult(placeholders[i], "error", message);
        completeSubagentRun(placeholders[i].registryId!, r);
        return r;
      }
    });

    batchPromise.then(
      (results) => {
        const successCount = results.filter((r) => isResultSuccess(r)).length;
        const summaries = results.map(
          (r) =>
            `[${r.registryId ?? "?"}] [${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r)}`,
        );
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: `Subagent batch finished: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
            display: false,
            details: makeDetails(results),
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        for (const p of placeholders) {
          if (p.registryId && getRun(p.registryId)) {
            completeSubagentRun(p.registryId, failedPlaceholderResult(p, "error", message));
          }
        }
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: `Subagent batch failed: ${message}`,
            display: false,
            details: makeDetails(placeholders),
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      },
    );

    for (const placeholder of placeholders) setRunPhase(placeholder.registryId!, "background");
    hasSpawned = true;
    return {
      content: [
        {
          type: "text",
          text: `Started ${tasks.length} subagent(s). Combined result arrives automatically when all finish. Never poll subagent_ctl or sleep; end your turn immediately.`,
        },
      ],
      details: makeDetails(placeholders),
    };
  };

  const execute = async (
    toolCallId: string,
    invocation: SubagentInvocation,
    ctx: SubagentExecutionContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> => {
    const agents = getAgents();
    const parentSessionId = ctx.sessionManager.getSessionId();

    if (invocation.action === "resume") {
      const reservation = reserveResumeRun(
        invocation.resume_id,
        invocation.task,
        parentSessionId,
        hasManagedSessionPath,
        onResumeKill,
      );
      if ("error" in reservation) {
        return {
          content: [{ type: "text", text: reservation.error }],
          details: makeDetails([]),
        };
      }
      const source = reservation.source;
      return executeSingle({
        cwd: source.workingDirectory ?? ctx.cwd,
        agents,
        agentName: source.agent,
        task: invocation.task,
        ctx,
        reservedRegistryId: reservation.run.id,
        sessionPath: source.sessionPath,
        parentSessionId,
        sourceRunId: source.id,
        lineageId: source.lineageId,
        toolCallId,
        signal,
      });
    }

    return executeRun(invocation.tasks, agents, ctx.cwd, ctx, parentSessionId, toolCallId, signal);
  };

  const kill = (id: string) => {
    const entry = getRun(id);
    entry?.kill();
    return entry;
  };
  const steer = (id: string, text: string) => {
    const entry = getRun(id);
    if (entry) {
      entry.steer(text);
      return entry;
    }
    if (listCompletedRuns().some((run) => run.id === id)) {
      return {
        error: `Subagent [${id}] already finished. Use the subagent tool with { action: "resume", resume_id: "${id}", task } instead.`,
      };
    }
    return {
      error: `No running subagent with id '${id}' (it may have already finished).`,
    };
  };

  return {
    execute,
    async executeControl(invocation, ctx, signal) {
      return executeControlAction(
        invocation,
        ctx,
        signal,
        () => hasSpawned,
        kill,
        steer,
        listRuns,
        getRun,
        listCompletedRuns,
        answerRunPendingQuestion,
      );
    },
    kill,
    steer,
    onAgentStart() {
      hasSpawned = false;
    },
    markSpawned() {
      hasSpawned = true;
    },
    async shutdown() {
      const entries = listRuns();
      const completions = entries.map(
        (entry) =>
          new Promise<void>((resolve) => {
            let finished = false;
            let unsubscribe: (() => void) | undefined;
            const finish = () => {
              if (finished) return;
              finished = true;
              unsubscribe?.();
              resolve();
            };
            unsubscribe = entry.onStatus(() => {
              queueMicrotask(() => {
                if (!getRun(entry.id)) finish();
              });
            });
            if (!getRun(entry.id)) finish();
          }),
      );
      for (const entry of entries) entry.kill();
      await Promise.all(completions);
      cleanupManagedSessions();
      clearSessionState();
    },
  };
}

async function mapConcurrent<TIn, TOut>(
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
