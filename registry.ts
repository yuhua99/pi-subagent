/**
 * In-memory registry of subagent runs, keyed by short id. Each run exposes
 * a canonical live `result` object plus status/stream subscribers used to
 * notify observers (TUI, popup, transcript views) of state changes.
 *
 * Completed runs are cached briefly so late lookups still resolve.
 */

import { randomBytes } from "node:crypto";
import type { DelegationMode, SingleResult } from "./types.ts";
import { emptyUsage, isResultSuccess } from "./types.ts";

export interface RunMetadata {
	parentSessionId?: string;
	delegationMode?: DelegationMode;
	sessionPath?: string;
	workingDirectory?: string;
	sourceRunId?: string;
	lineageId?: string;
}

export interface CompletedRun extends RunMetadata {
	id: string;
	agent: string;
	task: string;
	startedAt: number;
	finishedAt: number;
	result: SingleResult;
}

export type RunPhase = "foreground" | "background";

export interface SubagentRun extends RunMetadata {
	id: string;
	agent: string;
	task: string;
	pid: number | undefined;
	startedAt: number;
	phase: RunPhase;
	result: SingleResult;
	kill: () => void;
	onStatus(fn: () => void): () => void;
	onStream(fn: () => void): () => void;
}

interface ToolCallInvalidation {
	fn: () => void;
	runIds: Set<string>;
}

interface RunState extends SubagentRun {
	statusSubs: Set<() => void>;
	streamSubs: Set<() => void>;
	rowInvalidate?: () => void;
	streamTimer?: ReturnType<typeof setTimeout>;
}

const MAX_COMPLETED = 50;
const STREAM_COALESCE_MS = 16;

const running = new Map<string, RunState>();
const completed = new Map<string, CompletedRun>();
const resumeLocks = new Set<string>();
const toolCallInvalidators = new Map<string, ToolCallInvalidation>();
const pendingToolCallRuns = new Map<string, Set<string>>();

function generateId(): string {
	let id: string;
	do {
		id = randomBytes(2).toString("hex");
	} while (running.has(id) || completed.has(id));
	return id;
}

export function registerRun(init: Omit<SubagentRun, "id" | "phase" | "onStatus" | "onStream">): SubagentRun {
	const id = generateId();
	const statusSubs = new Set<() => void>();
	const streamSubs = new Set<() => void>();
	const state: RunState = {
		...init,
		id,
		phase: "foreground",
		lineageId: init.lineageId ?? id,
		statusSubs,
		streamSubs,
		onStatus(fn) {
			statusSubs.add(fn);
			return () => statusSubs.delete(fn);
		},
		onStream(fn) {
			streamSubs.add(fn);
			return () => streamSubs.delete(fn);
		},
	};
	running.set(id, state);
	return state;
}

export function updateRun(
	id: string,
	patch: Partial<Pick<SubagentRun, "pid" | "startedAt" | "kill" | "result" | "sessionPath" | "workingDirectory" | "parentSessionId" | "delegationMode" | "sourceRunId" | "lineageId">>,
): void {
	const entry = running.get(id);
	if (entry) Object.assign(entry, patch);
}

export function getRun(id: string): SubagentRun | undefined {
	return running.get(id);
}

export function listRuns(): SubagentRun[] {
	return [...running.values()];
}

function bindRowInvalidate(id: string, fn: () => void): void {
	const entry = running.get(id);
	if (entry) entry.rowInvalidate = fn;
}

export function setRunPhase(id: string, phase: RunPhase): void {
	const entry = running.get(id);
	if (entry) entry.phase = phase;
}

export function registerToolCallInvalidator(toolCallId: string, fn: () => void): void {
	if (toolCallInvalidators.has(toolCallId)) return;
	const invalidation: ToolCallInvalidation = { fn, runIds: new Set() };
	toolCallInvalidators.set(toolCallId, invalidation);
	for (const id of pendingToolCallRuns.get(toolCallId) ?? []) {
		bindRowInvalidate(id, fn);
		invalidation.runIds.add(id);
	}
	pendingToolCallRuns.delete(toolCallId);
}

export function bindToolCallRowInvalidate(toolCallId: string, id: string): void {
	const invalidation = toolCallInvalidators.get(toolCallId);
	if (invalidation) {
		bindRowInvalidate(id, invalidation.fn);
		invalidation.runIds.add(id);
		return;
	}
	let ids = pendingToolCallRuns.get(toolCallId);
	if (!ids) {
		ids = new Set();
		pendingToolCallRuns.set(toolCallId, ids);
	}
	ids.add(id);
}

function pruneToolCallRun(id: string): void {
	for (const [toolCallId, invalidation] of toolCallInvalidators) {
		if (invalidation.runIds.delete(id) && invalidation.runIds.size === 0) toolCallInvalidators.delete(toolCallId);
	}
	for (const [toolCallId, ids] of pendingToolCallRuns) {
		ids.delete(id);
		if (ids.size === 0) pendingToolCallRuns.delete(toolCallId);
	}
}

export function notifyStatus(id: string): void {
	const entry = running.get(id);
	if (!entry) return;
	entry.rowInvalidate?.();
	for (const fn of entry.statusSubs) fn();
}

export function notifyStream(id: string): void {
	const entry = running.get(id);
	if (!entry) return;
	if (entry.streamTimer) return;
	const timer = setTimeout(() => {
		const cur = running.get(id);
		if (!cur) return;
		cur.streamTimer = undefined;
		for (const fn of cur.streamSubs) fn();
	}, STREAM_COALESCE_MS);
	timer.unref?.();
	entry.streamTimer = timer;
}

export function completeRun(id: string, result: SingleResult): void {
	const entry = running.get(id);
	const finishedAt = Date.now();
	completed.set(id, {
		id,
		agent: entry?.agent ?? result.agent,
		task: entry?.task ?? result.task,
		startedAt: entry?.startedAt ?? finishedAt,
		finishedAt,
		parentSessionId: entry?.parentSessionId,
		delegationMode: entry?.delegationMode,
		sessionPath: entry?.sessionPath,
		workingDirectory: entry?.workingDirectory,
		sourceRunId: entry?.sourceRunId,
		lineageId: entry?.lineageId ?? id,
		result,
	});
	if (entry?.sourceRunId && entry.lineageId) resumeLocks.delete(entry.lineageId);
	while (completed.size > MAX_COMPLETED) {
		const removed = completed.keys().next().value;
		if (removed) {
			completed.delete(removed);
			pruneToolCallRun(removed);
		}
	}
	if (entry) {
		if (entry.streamTimer) {
			clearTimeout(entry.streamTimer);
			entry.streamTimer = undefined;
		}
		if (entry.phase === "background") entry.rowInvalidate?.();
		for (const fn of entry.statusSubs) fn();
		entry.statusSubs.clear();
		entry.streamSubs.clear();
		entry.rowInvalidate = undefined;
		running.delete(id);
	}
}

export function listCompletedRuns(): CompletedRun[] {
	return [...completed.values()].reverse();
}

export function clearSessionState(): void {
	running.clear();
	completed.clear();
	resumeLocks.clear();
	toolCallInvalidators.clear();
	pendingToolCallRuns.clear();
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
	if (!source) return { error: `Cannot resume subagent [${id}]: run is not completed in this parent session.` };
	if (source.parentSessionId !== parentSessionId) {
		return { error: `Cannot resume subagent [${id}]: run belongs to a different parent Pi session.` };
	}
	if (!source.delegationMode || !source.sessionPath || !hasSessionPath(source.sessionPath)) {
		return { error: `Cannot resume subagent [${id}]: completed run did not retain a session.` };
	}
	if (!isResultSuccess(source.result)) {
		return { error: `Cannot resume subagent [${id}]: only successfully completed runs can be resumed.` };
	}
	const lineageId = source.lineageId ?? source.id;
	if (resumeLocks.has(lineageId)) {
		return { error: `Cannot resume subagent [${id}]: another resume is already running in this session lineage.` };
	}
	resumeLocks.add(lineageId);
	const result: SingleResult = {
		agent: source.agent,
		agentSource: source.result.agentSource,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: source.result.model,
	};
	let runId = "";
	const run = registerRun({
		agent: source.agent,
		task,
		pid: undefined,
		startedAt: Date.now(),
		kill: () => onKill(runId),
		result,
		parentSessionId,
		delegationMode: source.delegationMode,
		sessionPath: source.sessionPath,
		workingDirectory: source.workingDirectory,
		sourceRunId: source.id,
		lineageId,
	});
	runId = run.id;
	result.registryId = run.id;
	return { run, source };
}

export function getLiveStatus(
	id: string,
):
	| { kind: "completed"; result: SingleResult }
	| { kind: "running"; result: SingleResult }
	| { kind: "stale" } {
	const done = completed.get(id);
	if (done) return { kind: "completed", result: done.result };
	const entry = running.get(id);
	if (entry) return { kind: "running", result: entry.result };
	return { kind: "stale" };
}

export interface ResolvedResult {
	result: SingleResult;
	stale: boolean;
}

/**
 * Resolves a placeholder result to its live/completed state. Pure — has no
 * side effects on the registry.
 */
export function resolveLiveResult(r: SingleResult): ResolvedResult {
	if (r.exitCode !== -1 || !r.registryId) return { result: r, stale: false };
	const status = getLiveStatus(r.registryId);
	if (status.kind === "stale") return { result: r, stale: true };
	return { result: status.result, stale: false };
}
