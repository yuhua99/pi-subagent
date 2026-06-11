/**
 * In-memory registry of running subagent processes.
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

const running = new Map<string, TrackedSubagent>();

function generateId(): string {
	let id: string;
	do {
		id = randomBytes(2).toString("hex");
	} while (running.has(id));
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

export function unregisterSubagent(id: string): void {
	running.delete(id);
}

export function getSubagent(id: string): TrackedSubagent | undefined {
	return running.get(id);
}

export function listSubagents(): TrackedSubagent[] {
	return [...running.values()];
}
