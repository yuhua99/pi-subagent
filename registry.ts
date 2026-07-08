/**
 * In-memory registry of running subagent processes, cached completed
 * results, and per-subagent render invalidators used to notify the TUI
 * when live state changes.
 */

import { randomBytes } from "node:crypto";
import type { SingleResult } from "./types.js";

export interface TrackedSubagent {
	id: string;
	agent: string;
	task: string;
	pid: number | undefined;
	startedAt: number;
	kill: () => void;
	peek: () => SingleResult;
}

const TASK_PREVIEW_LENGTH = 80;
const MAX_COMPLETED = 50;

const running = new Map<string, TrackedSubagent>();
const invalidators = new Map<string, () => void>();
const completed = new Map<string, SingleResult>();

function generateId(): string {
	let id: string;
	do {
		id = randomBytes(2).toString("hex");
	} while (running.has(id) || completed.has(id) || invalidators.has(id));
	return id;
}

export function registerSubagent(entry: Omit<TrackedSubagent, "id">): string {
	const id = generateId();
	const task =
		entry.task.length > TASK_PREVIEW_LENGTH
			? `${entry.task.slice(0, TASK_PREVIEW_LENGTH)}...`
			: entry.task;
	running.set(id, { ...entry, task, id });
	return id;
}

export function updateSubagent(
	id: string,
	patch: Partial<Pick<TrackedSubagent, "pid" | "startedAt" | "kill" | "peek">>,
): void {
	const entry = running.get(id);
	if (entry) Object.assign(entry, patch);
}

export function unregisterSubagent(id: string): void {
	running.delete(id);
}

export function getSubagent(id: string): TrackedSubagent | undefined {
	return running.get(id);
}

export function listSubagents(): TrackedSubagent[] {
	return [...running.values()];
}

export function registerInvalidator(id: string, fn: () => void): void {
	invalidators.set(id, fn);
}

export function notifyProgress(id: string): void {
	invalidators.get(id)?.();
}

export function markCompleted(id: string, result: SingleResult): void {
	completed.set(id, result);
	while (completed.size > MAX_COMPLETED) {
		completed.delete(completed.keys().next().value!);
	}
	const fn = invalidators.get(id);
	invalidators.delete(id);
	fn?.();
}

export function getLiveStatus(
	id: string,
):
	| { kind: "completed"; result: SingleResult }
	| { kind: "running"; result: SingleResult }
	| { kind: "stale" } {
	const done = completed.get(id);
	if (done) return { kind: "completed", result: done };
	const entry = running.get(id);
	if (entry) return { kind: "running", result: entry.peek() };
	return { kind: "stale" };
}

export interface ResolvedResult {
	result: SingleResult;
	stale: boolean;
}

/**
 * Resolves a placeholder result to its live/completed state.
 *
 * Side effect: while the subagent is still running, also registers
 * `invalidate` under the placeholder's `registryId` so the TUI is
 * notified on progress and completion.
 */
export function resolveLiveResult(
	r: SingleResult,
	invalidate?: () => void,
): ResolvedResult {
	if (r.exitCode !== -1 || !r.registryId) return { result: r, stale: false };
	const status = getLiveStatus(r.registryId);
	if (status.kind === "stale") return { result: r, stale: true };
	if (status.kind === "running" && invalidate) registerInvalidator(r.registryId, invalidate);
	return { result: status.result, stale: false };
}
