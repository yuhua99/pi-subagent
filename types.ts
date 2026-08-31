/**
 * Shared type definitions for the subagent extension.
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export interface SubagentToggle {
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
}

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

/** Outcome of a subagent run. `running` until the run settles. */
export type RunStatus = "running" | "ok" | "failed" | "aborted" | "killed";

/** Result of a single subagent invocation. */
export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  taskSummary?: string;
  status: RunStatus;
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

/** Metadata attached to every tool result for rendering. */
export interface SubagentDetails {
  results: SingleResult[];
}

/** Metadata attached to subagent_ctl list results for rendering. */
export interface SubagentListDetails {
  action: "list";
  results: SingleResult[];
}

/** Inspectable state of a subagent run. */
export interface SubagentInspectResult {
  id: string;
  agent: string;
  task: string;
  taskSummary?: string;
  activitySummary?: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "waiting_for_answer" | "completed";
  result: SingleResult;
}

/** Metadata attached to subagent_ctl inspect results for rendering. */
export interface SubagentInspectDetails {
  action: "inspect";
  id: string;
  result?: SubagentInspectResult;
}

/** Metadata attached to subagent_ctl kill, steer, and answer results for rendering. */
export interface SubagentCtlDetails {
  action: "kill" | "steer" | "answer";
  id: string;
  agent?: string;
}

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
      if (part.type === "text" && typeof part.text === "string" && part.text.length > 0)
        return part.text;
    }
  }
  return "";
}

/** Whether the final assistant message emitted text. */
export function hasFinalAssistantOutput(r: Pick<SingleResult, "messages">): boolean {
  const message = getFinalAssistantMessage(r.messages);
  return Boolean(
    message?.content.some((part) => part.type === "text" && part.text.trim().length > 0),
  );
}

/** Whether the child semantically completed the run. */
export function hasSemanticCompletion(r: Pick<SingleResult, "messages" | "sawAgentEnd">): boolean {
  return Boolean(r.sawAgentEnd) && hasFinalAssistantOutput(r);
}

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isResultSuccess(r: Pick<SingleResult, "status">): boolean {
  return r.status === "ok";
}

/** Whether a result settled badly. A still-running result is neither success nor error. */
export function isResultError(r: Pick<SingleResult, "status">): boolean {
  return r.status === "failed" || r.status === "aborted" || r.status === "killed";
}

/** Settle a run's status, reconciling interrupts with semantic completion from Pi's event stream. */
export function normalizeCompletedResult(
  result: SingleResult,
  interrupt?: "aborted" | "killed",
): SingleResult {
  result.partialMessage = undefined;

  if (interrupt) {
    if (hasSemanticCompletion(result)) {
      result.status = "ok";
      if (result.stopReason === "aborted") result.stopReason = undefined;
      return result;
    }
    const message = interrupt === "killed" ? "Subagent was killed." : "Subagent was aborted.";
    result.status = interrupt;
    result.errorMessage = message;
    if (!result.stderr.trim()) result.stderr = message;
    return result;
  }

  if (
    result.stopReason === "error" ||
    (result.stopReason === "length" && !hasFinalAssistantOutput(result))
  ) {
    result.status = "failed";
    if (!result.errorMessage) {
      result.errorMessage =
        result.stopReason === "length"
          ? "Subagent reached the output token limit before producing text."
          : result.stderr.trim() || "Subagent provider error.";
    }
    if (!result.stderr.trim()) result.stderr = result.errorMessage;
    return result;
  }

  result.status = "ok";
  return result;
}

/** Summarize a result for a tool response. */
export function getResultSummaryText(result: SingleResult): string {
  const finalText = getFinalAssistantText(result.messages);
  if (finalText) return finalText;
  if (result.errorMessage?.trim()) return result.errorMessage.trim();
  if (isResultError(result) && result.stderr.trim()) return result.stderr.trim();
  return "(no output)";
}
