/**
 * Persists subagent runs as custom entries in the parent session so `/agents`
 * and resume survive `/reload` and `/resume`. A run writes one entry when it
 * starts and one when it settles; on restore the latest entry per id wins.
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { restoreCompletedRuns, type CompletedRun, type SubagentRun } from "./registry.ts";
import type { RunStatus, SingleResult } from "../types.ts";

const RUN_ENTRY_TYPE = "subagent-run";

interface RunRecord {
  id: string;
  agent: string;
  agentSource: SingleResult["agentSource"];
  task: string;
  taskSummary?: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  cost: number;
  model?: string;
  errorMessage?: string;
  parentSessionId?: string;
  sessionPath?: string;
  workingDirectory?: string;
  sourceRunId?: string;
  lineageId?: string;
}

export function recordRun(
  pi: Pick<ExtensionAPI, "appendEntry">,
  run: SubagentRun | CompletedRun,
): void {
  const { result } = run;
  pi.appendEntry<RunRecord>(RUN_ENTRY_TYPE, {
    id: run.id,
    agent: run.agent,
    agentSource: result.agentSource,
    task: run.task,
    taskSummary: result.taskSummary,
    status: result.status,
    startedAt: run.startedAt,
    finishedAt: "finishedAt" in run ? run.finishedAt : undefined,
    cost: result.cost,
    model: result.model,
    errorMessage: result.errorMessage,
    parentSessionId: run.parentSessionId,
    sessionPath: run.sessionPath,
    workingDirectory: run.workingDirectory,
    sourceRunId: run.sourceRunId,
    lineageId: run.lineageId,
  });
}

function runRecords(entries: SessionEntry[]): RunRecord[] {
  return entries.flatMap((entry) =>
    entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE ? [entry.data as RunRecord] : [],
  );
}

/**
 * Restore runs started on the active `branch`. A run's end entry lands on
 * whichever branch was active when it settled, so outcomes come from `all`
 * entries: completion is a fact about the child, not an alternative history.
 */
export function restoreRuns(branch: SessionEntry[], all: SessionEntry[]): void {
  const onBranch = new Set(runRecords(branch).map((record) => record.id));
  const records = new Map<string, RunRecord>();
  for (const record of runRecords(all)) {
    if (!onBranch.has(record.id)) continue;
    records.delete(record.id);
    records.set(record.id, record);
  }
  restoreCompletedRuns([...records.values()].map(toCompletedRun));
}

function toCompletedRun(record: RunRecord): CompletedRun {
  // Only a start entry means the run was still going when its parent session ended.
  const killed = record.status === "running";
  return {
    id: record.id,
    agent: record.agent,
    task: record.task,
    steers: [],
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? record.startedAt,
    parentSessionId: record.parentSessionId,
    sessionPath: record.sessionPath,
    workingDirectory: record.workingDirectory,
    sourceRunId: record.sourceRunId,
    lineageId: record.lineageId,
    result: {
      agent: record.agent,
      agentSource: record.agentSource,
      task: record.task,
      taskSummary: record.taskSummary,
      status: killed ? "killed" : record.status,
      messages: [],
      stderr: "",
      cost: record.cost,
      model: record.model,
      errorMessage: killed
        ? "Subagent was killed when its parent session ended."
        : record.errorMessage,
      registryId: record.id,
    },
  };
}
