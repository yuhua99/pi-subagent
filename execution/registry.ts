/**
 * In-memory registry of subagent runs, keyed by short id. Each run exposes
 * a canonical live `result` object plus status subscribers used to notify
 * observers of state changes.
 *
 * Completed runs are cached briefly so late lookups still resolve, and are
 * restored from the parent session on start (see run_history.ts).
 */

import { randomBytes } from "node:crypto";
import type { SingleResult } from "../types.ts";
import { emptyUsage, isResultSuccess } from "../types.ts";

export interface RunMetadata {
  parentSessionId?: string;
  sessionPath?: string;
  workingDirectory?: string;
  sourceRunId?: string;
  lineageId?: string;
  /** Herdr tab hosting the live child pi. */
  tabId?: string;
}

export interface CompletedRun extends RunMetadata {
  id: string;
  agent: string;
  task: string;
  steers: readonly { text: string; at: number }[];
  startedAt: number;
  finishedAt: number;
  result: SingleResult;
}

export interface SubagentRun extends RunMetadata {
  id: string;
  agent: string;
  task: string;
  startedAt: number;
  result: SingleResult;
  kill: () => void;
  steer(text: string): void;
  steers: readonly { text: string; at: number }[];
  onStatus(fn: () => void): () => void;
}

interface RunState extends SubagentRun {
  pendingSteers: string[];
  steerCallback?: (text: string) => void;
  statusSubs: Set<() => void>;
}


const MAX_COMPLETED = 50;

const running = new Map<string, RunState>();
const completed = new Map<string, CompletedRun>();
const resumeLocks = new Set<string>();

function generateId(): string {
  let id: string;
  do {
    id = randomBytes(2).toString("hex");
  } while (running.has(id) || completed.has(id));
  return id;
}

export function registerRun(
  init: Omit<SubagentRun, "id" | "steer" | "steers" | "onStatus">,
): SubagentRun {
  const id = generateId();
  init.result.registryId = id;
  const statusSubs = new Set<() => void>();
  const steers: { text: string; at: number }[] = [];
  const pendingSteers: string[] = [];
  const state: RunState = {
    ...init,
    id,
    lineageId: init.lineageId ?? id,
    steers,
    pendingSteers,
    steer(text) {
      steers.push({ text, at: Date.now() });
      if (state.steerCallback) state.steerCallback(text);
      else pendingSteers.push(text);
    },
    statusSubs,
    onStatus(fn) {
      statusSubs.add(fn);
      return () => statusSubs.delete(fn);
    },
  };
  running.set(id, state);
  return state;
}

export function updateRun(
  id: string,
  patch: Partial<
    Pick<
      SubagentRun,
      | "startedAt"
      | "kill"
      | "sessionPath"
      | "workingDirectory"
      | "parentSessionId"
      | "sourceRunId"
      | "lineageId"
      | "tabId"
    >
  >,
): void {
  const entry = running.get(id);
  if (!entry) return;
  Object.assign(entry, patch);
}

export function getRun(id: string): SubagentRun | undefined {
  return running.get(id);
}

export function attachRunSteer(id: string, steer: (text: string) => void): void {
  const entry = running.get(id);
  if (!entry) return;
  entry.steerCallback = steer;
  for (const text of entry.pendingSteers.splice(0)) steer(text);
}

export function setRunTaskSummary(id: string, task: string, taskSummary: string): void {
  const entry = running.get(id) ?? completed.get(id);
  if (!entry || entry.task !== task) return;
  entry.result.taskSummary = taskSummary;
  notifyStatus(id);
}

export function listRuns(): SubagentRun[] {
  return [...running.values()];
}

export function notifyStatus(id: string): void {
  const entry = running.get(id);
  if (entry) for (const fn of entry.statusSubs) fn();
}

export function completeRun(id: string, result: SingleResult): CompletedRun {
  const entry = running.get(id);
  const finishedAt = Date.now();
  result.taskSummary ??= entry?.result.taskSummary;
  const done: CompletedRun = {
    id,
    agent: entry?.agent ?? result.agent,
    task: entry?.task ?? result.task,
    steers: entry?.steers ?? [],
    startedAt: entry?.startedAt ?? finishedAt,
    finishedAt,
    parentSessionId: entry?.parentSessionId,
    sessionPath: entry?.sessionPath,
    workingDirectory: entry?.workingDirectory,
    sourceRunId: entry?.sourceRunId,
    lineageId: entry?.lineageId ?? id,
    result,
  };
  completed.set(id, done);
  if (entry?.sourceRunId && entry.lineageId) resumeLocks.delete(entry.lineageId);
  while (completed.size > MAX_COMPLETED) {
    const removed = completed.keys().next().value;
    if (removed) completed.delete(removed);
  }
  if (entry) {
    entry.pendingSteers.length = 0;
    for (const fn of entry.statusSubs) fn();
    running.delete(id);
  }
  return done;
}

/** Seed completed runs restored from the parent session, oldest first. */
export function restoreCompletedRuns(runs: CompletedRun[]): void {
  for (const run of runs.slice(-MAX_COMPLETED)) completed.set(run.id, run);
}

export function listCompletedRuns(): CompletedRun[] {
  return [...completed.values()].reverse();
}

export function clearSessionState(): void {
  running.clear();
  completed.clear();
  resumeLocks.clear();
}

export interface ResumeReservation {
  run: SubagentRun;
  source: CompletedRun;
}

export function reserveResumeRun(
  id: string,
  task: string,
  parentSessionId: string,
  hasSessionPath: (sessionPath: string) => boolean,
  onKill: (id: string) => void,
): ResumeReservation | { error: string } {
  const source = completed.get(id);
  if (!source)
    return {
      error: `Cannot resume subagent [${id}]: no such completed run; only the last ${MAX_COMPLETED} are retained.`,
    };
  if (source.parentSessionId !== parentSessionId) {
    return {
      error: `Cannot resume subagent [${id}]: run belongs to a different parent Pi session.`,
    };
  }
  if (!source.sessionPath || !hasSessionPath(source.sessionPath)) {
    return { error: `Cannot resume subagent [${id}]: completed run did not retain a session.` };
  }
  if (!isResultSuccess(source.result)) {
    return {
      error: `Cannot resume subagent [${id}]: only successfully completed runs can be resumed.`,
    };
  }
  const lineageId = source.lineageId ?? source.id;
  if (resumeLocks.has(lineageId)) {
    return {
      error: `Cannot resume subagent [${id}]: another resume is already running in this session lineage.`,
    };
  }
  resumeLocks.add(lineageId);
  const result: SingleResult = {
    agent: source.agent,
    agentSource: source.result.agentSource,
    task,
    status: "running",
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: source.result.model,
  };
  const run = registerRun({
    agent: source.agent,
    task,
    startedAt: Date.now(),
    kill: () => onKill(result.registryId!),
    result,
    parentSessionId,
    sessionPath: source.sessionPath,
    workingDirectory: source.workingDirectory,
    sourceRunId: source.id,
    lineageId,
  });
  return { run, source };
}

export function cancelResumeReservation(id: string): boolean {
  const entry = running.get(id);
  if (!entry?.sourceRunId || !entry.lineageId) return false;
  running.delete(id);
  resumeLocks.delete(entry.lineageId);
  return true;
}
