/**
 * In-memory registry of subagent runs, keyed by short id. Each run exposes
 * a canonical live `result` object plus status/stream subscribers used to
 * notify observers (TUI, popup, transcript views) of state changes.
 *
 * Completed runs are cached briefly so late lookups still resolve.
 */

import { randomBytes } from "node:crypto";
import type { SingleResult } from "./types.js";

export interface SubagentRun {
	id: string;
	agent: string;
	task: string;
	pid: number | undefined;
	startedAt: number;
	result: SingleResult;
	kill: () => void;
	onStatus(fn: () => void): () => void;
	onStream(fn: () => void): () => void;
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
const completed = new Map<string, SingleResult>();

function generateId(): string {
	let id: string;
	do {
		id = randomBytes(2).toString("hex");
	} while (running.has(id) || completed.has(id));
	return id;
}

export function registerRun(
	init: Omit<SubagentRun, "id" | "onStatus" | "onStream">,
): SubagentRun {
	const id = generateId();
	const statusSubs = new Set<() => void>();
	const streamSubs = new Set<() => void>();
	const state: RunState = {
		...init,
		id,
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
	patch: Partial<Pick<SubagentRun, "pid" | "startedAt" | "kill" | "result">>,
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

export function bindRowInvalidator(id: string, fn: () => void): void {
	const entry = running.get(id);
	if (entry) entry.rowInvalidate = fn;
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
	completed.set(id, result);
	while (completed.size > MAX_COMPLETED) {
		completed.delete(completed.keys().next().value!);
	}
	const entry = running.get(id);
	if (entry) {
		if (entry.streamTimer) {
			clearTimeout(entry.streamTimer);
			entry.streamTimer = undefined;
		}
		entry.rowInvalidate?.();
		for (const fn of entry.statusSubs) fn();
		entry.statusSubs.clear();
		entry.streamSubs.clear();
		entry.rowInvalidate = undefined;
		running.delete(id);
	}
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
