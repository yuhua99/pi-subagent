/**
 * Shared type definitions for the subagent extension.
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

/** Context mode for delegated runs. */
export type DelegationMode = "spawn" | "fork";

/** Default context mode for delegated runs. */
export const DEFAULT_DELEGATION_MODE: DelegationMode = "spawn";

/** Aggregated token usage from a subagent run. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Result of a single subagent invocation. */
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAgentEnd?: boolean;
	registryId?: string;
	partialMessage?: AssistantMessage;
}

/** Task specification for a parallel delegation run. */
export interface TaskSpec {
	agent: string;
	task: string;
	cwd?: string;
}

function isTaskSpec(value: unknown): value is TaskSpec {
	if (typeof value !== "object" || value === null) return false;
	const t = value as Record<string, unknown>;
	return typeof t.agent === "string" && typeof t.task === "string" && (t.cwd === undefined || typeof t.cwd === "string");
}

/** Normalize the `tasks` tool parameter, tolerating JSON-encoded array strings emitted by some models. */
export function parseTasksParam(raw: unknown): { tasks: TaskSpec[] } | { error: string } | undefined {
	if (raw === undefined) return undefined;
	let value: unknown = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return { error: "Invalid `tasks`: received a string that is not valid JSON. Provide a raw JSON array of { agent, task } objects, not a JSON-encoded string." };
		}
	}
	if (!Array.isArray(value) || value.length === 0 || !value.every(isTaskSpec)) {
		return { error: "Invalid `tasks`: expected a non-empty array of { agent, task, cwd? } objects." };
	}
	return { tasks: value };
}

/** Metadata attached to every tool result for rendering. */
export interface SubagentDetails {
	mode: "single" | "parallel";
	delegationMode: DelegationMode;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** Metadata attached to subagent_ctl list results for rendering. */
export interface SubagentListDetails {
	action: "list";
	runs: Array<{
		id: string;
		agent: string;
		taskSummary?: string;
		startedAt: number;
	}>;
}

/** Metadata attached to subagent_ctl kill and steer results for rendering. */
export type SubagentCtlDetails =
	| { action: "kill" | "steer"; id: string; agent: string }
	| { action: "kill" | "steer"; id: string };

/** Create an empty UsageStats object. */
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Return the final assistant message in a transcript. */
export function getFinalAssistantMessage(messages: Message[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

/** Extract the last assistant text from a message history. */
export function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) return part.text;
		}
	}
	return "";
}

/** Whether the final assistant message emitted text. */
export function hasFinalAssistantOutput(r: Pick<SingleResult, "messages">): boolean {
	const message = getFinalAssistantMessage(r.messages);
	return Boolean(message?.content.some((part) => part.type === "text" && part.text.trim().length > 0));
}

/** Whether the child semantically completed the run. */
export function hasSemanticCompletion(r: Pick<SingleResult, "messages" | "sawAgentEnd">): boolean {
	return Boolean(r.sawAgentEnd) && hasFinalAssistantOutput(r);
}

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isResultSuccess(r: SingleResult): boolean {
	if (r.exitCode === -1 || r.stopReason === "error" || r.stopReason === "aborted" || r.stopReason === "killed") return false;
	if (hasSemanticCompletion(r)) return true;
	return r.exitCode === 0;
}

/** Whether a result represents an error. */
export function isResultError(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	return !isResultSuccess(r);
}

/** Reconcile execution status with semantic completion observed from Pi's event stream. */
export function normalizeCompletedResult(result: SingleResult, wasAborted: boolean): SingleResult {
	result.partialMessage = undefined;
	const hasSemanticSuccess = hasSemanticCompletion(result);

	if (wasAborted) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.stopReason === "aborted") result.stopReason = undefined;
			if (result.errorMessage === "Subagent was aborted.") {
				result.errorMessage = undefined;
			}
		} else {
			result.exitCode = 130;
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted.";
			if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
		}
		return result;
	}

	const finalFailure = result.stopReason === "error" ||
		(result.stopReason === "length" && !hasFinalAssistantOutput(result));
	if (finalFailure) {
		result.exitCode = 1;
		if (!result.errorMessage) {
			result.errorMessage = result.stopReason === "length"
				? "Subagent reached the output token limit before producing text."
				: result.stderr.trim() || "Subagent provider error.";
		}
		if (!result.stderr.trim()) result.stderr = result.errorMessage;
		return result;
	}

	if (result.exitCode > 0) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.errorMessage === result.stderr.trim()) result.errorMessage = undefined;
		} else {
			if (!result.stopReason) result.stopReason = "error";
			if (!result.errorMessage && result.stderr.trim()) result.errorMessage = result.stderr.trim();
		}
	}

	return result;
}

/** Summarize a result for a tool response. */
export function getResultSummaryText(result: SingleResult): string {
	const finalText = getFinalAssistantText(result.messages);
	if (finalText) return finalText;
	if (result.errorMessage?.trim()) return result.errorMessage.trim();
	if ((result.exitCode > 0 || result.stopReason === "error" || result.stopReason === "aborted") && result.stderr.trim()) {
		return result.stderr.trim();
	}
	return "(no output)";
}

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: Message[]): string {
	return getFinalAssistantText(messages);
}
