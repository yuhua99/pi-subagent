import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSubagentList } from "../tool/render.ts";
import { fallbackActivitySummary, summarizeActivity } from "../tool/task_summary.ts";
import type {
  SubagentCtlDetails,
  SubagentInspectDetails,
  SubagentListDetails,
} from "../types.ts";
import type { SubagentCtlInvocation } from "../tool/schema.ts";
import type { CompletedRun, SubagentRun } from "./registry.ts";

export interface ControlResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentCtlDetails | SubagentListDetails | SubagentInspectDetails;
}

export async function executeControl(
  invocation: SubagentCtlInvocation,
  ctx: Pick<ExtensionContext, "modelRegistry">,
  signal: AbortSignal | undefined,
  hasSpawned: () => boolean,
  kill: (id: string) => SubagentRun | undefined,
  steer: (id: string, text: string) => SubagentRun | { error: string },
  listRuns: () => SubagentRun[],
  getRun: (id: string) => SubagentRun | undefined,
  listCompletedRuns: () => CompletedRun[],
  answerRunPendingQuestion: (id: string, text: string) => boolean,
): Promise<ControlResult> {
  if (
    hasSpawned() &&
    invocation.action === "list" &&
    !listRuns().some((run) => run.pendingQuestion)
  ) {
    return {
      content: [
        {
          type: "text",
          text: "Results arrive automatically. Never poll subagent_ctl; end your turn immediately.",
        },
      ],
      details: { action: "list", results: [] },
    };
  }
  if (
    hasSpawned() &&
    invocation.action === "inspect" &&
    !getRun(invocation.id)?.pendingQuestion
  ) {
    return {
      content: [
        {
          type: "text",
          text: "Results arrive automatically. Never poll subagent_ctl; end your turn immediately.",
        },
      ],
      details: { action: "inspect", id: invocation.id },
    };
  }
  if (invocation.action === "list") {
    const runs = listRuns();
    const details: SubagentListDetails = {
      action: "list",
      results: runs.map((run) => ({
        ...run.result,
        registryId: run.id,
      })),
    };
    return {
      content: [
        {
          type: "text",
          text: [
            formatSubagentList(runs),
            ...runs
              .filter((run) => run.pendingQuestion)
              .map(
                (run) =>
                  `waiting_for_answer: [${run.id}] ${run.agent}: ${run.pendingQuestion!.question}`,
              ),
          ].join("\n"),
        },
      ],
      details,
    };
  }
  if (invocation.action === "inspect") {
    const live = getRun(invocation.id);
    const completed = live
      ? undefined
      : listCompletedRuns().find((run) => run.id === invocation.id);
    const entry = live ?? completed;
    if (!entry) {
      const details: SubagentInspectDetails = {
        action: "inspect",
        id: invocation.id,
      };
      return {
        content: [
          {
            type: "text",
            text: `No subagent with id '${invocation.id}' found.`,
          },
        ],
        details,
      };
    }
    const activitySummary =
      (await summarizeActivity(entry.task, entry.result.messages, ctx, signal)) ??
      fallbackActivitySummary(entry.result);
    const status = live?.pendingQuestion
      ? "waiting_for_answer"
      : live
        ? "running"
        : "completed";
    const details: SubagentInspectDetails = {
      action: "inspect",
      id: invocation.id,
      result: {
        id: entry.id,
        agent: entry.agent,
        task: entry.task,
        ...(entry.result.taskSummary ? { taskSummary: entry.result.taskSummary } : {}),
        activitySummary,
        startedAt: entry.startedAt,
        ...(completed ? { finishedAt: completed.finishedAt } : {}),
        status,
        result: entry.result,
      },
    };
    return {
      content: [
        {
          type: "text",
          text: `Subagent [${entry.id}] (${entry.agent}) is ${status}.${live?.pendingQuestion ? `\n\nQuestion: ${live.pendingQuestion.question}` : ""}\n\nActivity: ${activitySummary}`,
        },
      ],
      details,
    };
  }
  if (invocation.action === "answer") {
    const answerResult = (text: string, id: string, agent?: string): ControlResult => ({
      content: [{ type: "text", text }],
      details: {
        action: "answer",
        id,
        ...(agent === undefined ? {} : { agent }),
      },
    });
    const entry = getRun(invocation.id);
    if (!entry) {
      return answerResult(
        `No running subagent with id '${invocation.id}' (it may have already finished).`,
        invocation.id,
      );
    }
    if (!answerRunPendingQuestion(invocation.id, invocation.text)) {
      return answerResult(
        `Subagent [${entry.id}] (${entry.agent}) has no pending question.`,
        invocation.id,
      );
    }
    return answerResult(
      `Answered subagent [${entry.id}] (${entry.agent}).`,
      entry.id,
      entry.agent,
    );
  }
  if (invocation.action === "kill") {
    const entry = kill(invocation.id);
    if (!entry) {
      const details: SubagentCtlDetails = {
        action: "kill",
        id: invocation.id,
      };
      return {
        content: [
          {
            type: "text",
            text: `No running subagent with id '${invocation.id}' (it may have already finished).`,
          },
        ],
        details,
      };
    }
    const details: SubagentCtlDetails = {
      action: "kill",
      id: entry.id,
      agent: entry.agent,
    };
    return {
      content: [
        {
          type: "text",
          text: `Killed subagent [${entry.id}] (${entry.agent}).`,
        },
      ],
      details,
    };
  }
  const entry = steer(invocation.id, invocation.text);
  if ("error" in entry) {
    const details: SubagentCtlDetails = {
      action: "steer",
      id: invocation.id,
    };
    return { content: [{ type: "text", text: entry.error }], details };
  }
  const details: SubagentCtlDetails = {
    action: "steer",
    id: entry.id,
    agent: entry.agent,
  };
  return {
    content: [
      {
        type: "text",
        text: `Steered subagent [${entry.id}] (${entry.agent}).`,
      },
    ],
    details,
  };
}
