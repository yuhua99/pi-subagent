/**
 * Shared type definitions for the subagent extension.
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export interface SubagentToggle {
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
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
  /** Total cost of the run's assistant messages. */
  cost: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  registryId?: string;
}

/** Metadata attached to every tool result. */
export interface SubagentDetails {
  results: SingleResult[];
}

/** Metadata attached to subagent_ctl list results. */
export interface SubagentListDetails {
  action: "list";
  results: SingleResult[];
}

/** Metadata attached to subagent_ctl kill and steer results. */
export interface SubagentCtlDetails {
  action: "kill" | "steer";
  id: string;
  agent?: string;
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

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isResultSuccess(r: Pick<SingleResult, "status">): boolean {
  return r.status === "ok";
}

/** Whether a result settled badly. A still-running result is neither success nor error. */
export function isResultError(r: Pick<SingleResult, "status">): boolean {
  return r.status === "failed" || r.status === "aborted" || r.status === "killed";
}

/** Settle a run's status, reconciling interrupts with semantic completion read from the child's session. */
export function normalizeCompletedResult(
  result: SingleResult,
  interrupt?: "aborted" | "killed",
): SingleResult {
  if (interrupt) {
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

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Summarize a result for a tool response. */
export function getResultSummaryText(result: SingleResult): string {
  const finalText = getFinalAssistantText(result.messages);
  if (finalText) return finalText;
  if (result.errorMessage?.trim()) return result.errorMessage.trim();
  if (isResultError(result) && result.stderr.trim()) return result.stderr.trim();
  return "(no output)";
}
