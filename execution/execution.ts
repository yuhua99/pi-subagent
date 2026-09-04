import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents.ts";
import { failPlaceholder, reserveRunPlaceholders } from "./delegation.ts";
import { cleanupManagedSessions, hasManagedSessionPath } from "./session_files.ts";
import {
  clearSessionState,
  cancelResumeReservation,
  completeRun,
  getRun,
  bindToolCallRowInvalidate,
  listCompletedRuns,
  listRuns,
  reserveResumeRun,
  setRunTaskSummary,
  type ResumeReservation,
  type SubagentRun,
} from "./registry.ts";
import { runAgent, type RunAgentOptions } from "./runner.ts";
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
} from "../types.ts";
import {
  type SubagentCtlInvocation,
  type SubagentInvocation,
  type SubagentRequest,
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

interface PreparedRequest {
  placeholder: SingleResult;
  title: string;
  runOptions: Omit<RunAgentOptions, "onQuestion" | "signal" | "reservedRegistryId"> & {
    reservedRegistryId: string;
  };
}

type PreparedBatch = { requests: PreparedRequest[] } | { error: string };

const TASK_SUMMARY_TITLE_LIMIT = 60;

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
  const setTaskSummary = (id: string, task: string, title: string) => {
    const summary = title.replace(/\s+/g, " ").trim();
    if (!summary) return;
    setRunTaskSummary(id, task, summary.slice(0, TASK_SUMMARY_TITLE_LIMIT));
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
    completeRun(id, result);
    cleanupManagedSessions(retainedSessionPaths());
  };

  const onResumeKill = (id: string) => {
    const entry = getRun(id);
    if (!entry) return;
    completeSubagentRun(
      id,
      failPlaceholder(entry.result, "killed", "Subagent was killed before it started."),
    );
  };

  const releaseResumeReservations = (reservations: ResumeReservation[]) => {
    for (const reservation of reservations) cancelResumeReservation(reservation.run.id);
  };

  const prepareBatch = (
    requests: SubagentRequest[],
    agents: AgentConfig[],
    defaultCwd: string,
    parentSessionId: string,
  ): PreparedBatch => {
    const unknownAgentError = (agentName: string) => {
      const available = agents.map((agent) => `"${agent.name}"`).join(", ") || "none";
      return `Unknown agent: "${agentName}". Available agents: ${available}.`;
    };
    const missingRunAgent = requests.find(
      (request) =>
        request.action === "run" && !agents.some((agent) => agent.name === request.agent),
    );
    if (missingRunAgent?.action === "run") {
      return { error: unknownAgentError(missingRunAgent.agent) };
    }

    const reservations = new Map<number, ResumeReservation>();
    for (const [index, request] of requests.entries()) {
      if (request.action !== "resume") continue;
      const reservation = reserveResumeRun(
        request.resume_id,
        request.task,
        parentSessionId,
        hasManagedSessionPath,
        onResumeKill,
      );
      if ("error" in reservation) {
        releaseResumeReservations([...reservations.values()]);
        return { error: reservation.error };
      }
      reservations.set(index, reservation);
    }

    const unavailableResume = [...reservations.values()].find(
      ({ source }) => !agents.some((agent) => agent.name === source.agent),
    );
    if (unavailableResume) {
      releaseResumeReservations([...reservations.values()]);
      return { error: unknownAgentError(unavailableResume.source.agent) };
    }

    const runRequests = requests.filter(
      (request): request is Extract<SubagentRequest, { action: "run" }> => request.action === "run",
    );
    const runPlaceholders = reserveRunPlaceholders(runRequests, agents, completeSubagentRun);
    let runIndex = 0;
    return {
      requests: requests.map((request, index) => {
        if (request.action === "run") {
          const placeholder = runPlaceholders[runIndex++]!;
          return {
            placeholder,
            title: request.title,
            runOptions: {
              cwd: defaultCwd,
              agents,
              agentName: request.agent,
              task: request.task,
              taskCwd: request.cwd,
              parentSessionId,
              workingDirectory: request.cwd ?? defaultCwd,
              reservedRegistryId: placeholder.registryId!,
            },
          };
        }

        const reservation = reservations.get(index)!;
        const source = reservation.source;
        return {
          placeholder: reservation.run.result,
          title: request.title,
          runOptions: {
            cwd: source.workingDirectory ?? defaultCwd,
            agents,
            agentName: source.agent,
            task: request.task,
            sessionPath: source.sessionPath,
            parentSessionId,
            sourceRunId: source.id,
            lineageId: source.lineageId,
            reservedRegistryId: reservation.run.id,
          },
        };
      }),
    };
  };

  const startBatch = (
    requests: PreparedRequest[],
    toolCallId: string,
    signal?: AbortSignal,
  ): ToolResult => {
    const placeholders = requests.map((request) => request.placeholder);
    for (const request of requests) {
      const { registryId, task } = request.placeholder;
      bindToolCallRowInvalidate(toolCallId, registryId!);
      setTaskSummary(registryId!, task, request.title);
    }

    hasSpawned = true;

    const batchPromise = Promise.all(
      requests.map(async (request) => {
        const { placeholder, runOptions } = request;
        try {
          const result = await runAgent({ ...runOptions, signal, onQuestion: sendQuestion });
          completeSubagentRun(runOptions.reservedRegistryId, result);
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const result = failPlaceholder(placeholder, "failed", message);
          completeSubagentRun(runOptions.reservedRegistryId, result);
          return result;
        }
      }),
    );

    batchPromise.then(
      (results) => {
        const successCount = results.filter((result) => isResultSuccess(result)).length;
        const summaries = results.map(
          (result) =>
            `[${result.registryId ?? "?"}] [${result.agent}] ${isResultError(result) ? "failed" : "completed"}: ${getResultSummaryText(result)}`,
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
        for (const placeholder of placeholders) {
          if (placeholder.registryId && getRun(placeholder.registryId)) {
            completeSubagentRun(
              placeholder.registryId,
              failPlaceholder(placeholder, "failed", message),
            );
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

    return {
      content: [
        {
          type: "text",
          text: `Started ${requests.length} subagent(s): ${placeholders.map((placeholder) => `[${placeholder.registryId}] (${placeholder.agent})`).join(", ")}. Combined result arrives automatically when all finish. Never poll subagent_ctl or sleep; end your turn immediately.`,
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
    const prepared = prepareBatch(
      invocation.requests,
      getAgents(),
      ctx.cwd,
      ctx.sessionManager.getSessionId(),
    );
    if ("error" in prepared) {
      return {
        content: [{ type: "text", text: prepared.error }],
        details: makeDetails([]),
      };
    }
    return startBatch(prepared.requests, toolCallId, signal);
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
        error: `Subagent [${id}] already finished. Use the subagent tool with { requests: [{ action: "resume", resume_id: "${id}", task }] } instead.`,
      };
    }
    return {
      error: `No running subagent with id '${id}' (it may have already finished).`,
    };
  };

  return {
    execute,
    async executeControl(invocation, ctx, signal) {
      return executeControlAction(invocation, ctx, signal, {
        hasSpawned: () => hasSpawned,
        kill,
        steer,
      });
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
