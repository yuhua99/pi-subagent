/**
 * TUI rendering for subagent tool calls and results.
 *
 * Tool rows show errors and live status only. Rich detail lives in `/agents`.
 */

import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  getLiveStatus,
  getRun,
  registerToolCallInvalidator,
  resolveLiveResult,
  type ResolvedResult,
  type SubagentRun,
} from "../execution/registry.ts";
import { parseSubagentCtlInvocation, parseSubagentInvocation } from "./schema.ts";
import {
  type SingleResult,
  type SubagentCtlDetails,
  type SubagentDetails,
  type SubagentInspectDetails,
  type SubagentListDetails,
  type UsageStats,
  isResultError,
  parseTasksParam,
} from "../types.ts";

const STALE_FINISHED_MSG = "finished — result delivered separately";
const MAX_PENDING_QUESTION = 80;

export type RenderContext = {
  state: Record<string, any>;
  invalidate: () => void;
  toolCallId?: string;
  isPartial?: boolean;
  lastComponent?: unknown;
};

type ResolvedRow = ResolvedResult & { original: SingleResult };

type ResultContent = Array<{ type: string; text?: string }>;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function staleRowHeader(original: SingleResult, theme: { fg: ThemeFg }, prefix = "└─ "): string {
  return (
    theme.fg("muted", prefix) +
    theme.fg("accent", original.agent) +
    taskSummarySuffix(original, theme) +
    runningIdBadge(original, theme) +
    ` ${theme.fg("dim", "◌")}`
  );
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: Partial<UsageStats>, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRenderableResult(value: unknown): value is SingleResult {
  return (
    isRecord(value) &&
    typeof value.agent === "string" &&
    typeof value.exitCode === "number" &&
    Array.isArray(value.messages)
  );
}

function isRenderableDetails(value: unknown): value is SubagentDetails {
  return isRecord(value) && Array.isArray(value.results) && value.results.every(isRenderableResult);
}

function isRenderableListDetails(value: unknown): value is SubagentListDetails {
  return (
    isRecord(value) &&
    value.action === "list" &&
    Array.isArray(value.results) &&
    value.results.every(isRenderableResult)
  );
}

function isRenderableKillDetails(value: unknown): value is SubagentCtlDetails {
  return (
    isRecord(value) &&
    (value.action === "kill" || value.action === "steer" || value.action === "answer") &&
    typeof value.id === "string" &&
    (!("agent" in value) || typeof value.agent === "string")
  );
}

function isRenderableInspectDetails(value: unknown): value is SubagentInspectDetails {
  if (!isRecord(value) || value.action !== "inspect" || typeof value.id !== "string") return false;
  if (value.result === undefined) return true;
  if (!isRecord(value.result)) return false;
  return (
    typeof value.result.id === "string" &&
    typeof value.result.agent === "string" &&
    typeof value.result.task === "string" &&
    (value.result.taskSummary === undefined || typeof value.result.taskSummary === "string") &&
    (value.result.activitySummary === undefined ||
      typeof value.result.activitySummary === "string") &&
    typeof value.result.startedAt === "number" &&
    (value.result.finishedAt === undefined || typeof value.result.finishedAt === "number") &&
    (value.result.status === "running" ||
      value.result.status === "waiting_for_answer" ||
      value.result.status === "completed") &&
    isRenderableResult(value.result.result)
  );
}

function validationMessage(
  content: ResultContent,
  toolName: "subagent" | "subagent_ctl" = "subagent",
): string | undefined {
  const text = content.find(
    (block) => block.type === "text" && typeof block.text === "string",
  )?.text;
  if (!text?.startsWith(`Validation failed for tool "${toolName}":`)) return undefined;
  const received = text.match(/Received arguments:\s*(\{[\s\S]*\})\s*$/)?.[1];
  let args: unknown;
  try {
    args = received ? JSON.parse(received) : undefined;
  } catch {
    args = undefined;
  }
  const parsed =
    toolName === "subagent" ? parseSubagentInvocation(args) : parseSubagentCtlInvocation(args);
  return "error" in parsed ? `Validation error: ${parsed.error}` : undefined;
}

function fallbackText(
  content: ResultContent,
  toolName: "subagent" | "subagent_ctl" = "subagent",
): string {
  const validation = validationMessage(content, toolName);
  if (validation) return validation;
  const first = content[0];
  return first?.type === "text" && first.text ? first.text : "(no output)";
}

export type ThemeFg = (color: ThemeColor, text: string) => string;

// ---------------------------------------------------------------------------
// Shared rendering building blocks
// ---------------------------------------------------------------------------

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatSubagentList(entries: SubagentRun[], now = Date.now()): string {
  if (entries.length === 0) return "No subagents currently running.";
  const lines: string[] = [`${entries.length} running subagent(s):`];
  for (const e of entries) {
    lines.push(
      `[${e.id}] ${e.agent}${e.result.taskSummary ? ` — ${e.result.taskSummary}` : ""} — running ${formatElapsed(now - e.startedAt)}`,
    );
  }
  return lines.join("\n");
}

function runningIdBadge(r: SingleResult, theme: { fg: ThemeFg }): string {
  return r.exitCode === -1 && r.registryId ? theme.fg("dim", ` [${r.registryId}]`) : "";
}

function taskSummarySuffix(r: SingleResult, theme: { fg: ThemeFg }): string {
  return r.taskSummary ? theme.fg("dim", ` — ${r.taskSummary}`) : "";
}

function statusIcon(r: SingleResult, theme: { fg: ThemeFg }): string {
  if (r.exitCode === -1) return theme.fg("warning", "○");
  if (r.stopReason === "killed") return theme.fg("muted", "■");
  return isResultError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function statusColor(r: SingleResult): ThemeColor {
  return r.exitCode === -1
    ? "muted"
    : r.stopReason === "killed"
      ? "muted"
      : isResultError(r)
        ? "error"
        : "success";
}

function pendingQuestion(r: SingleResult): string | undefined {
  const question = r.registryId && getRun(r.registryId)?.pendingQuestion?.question;
  if (!question) return undefined;
  const singleLine = question.replace(/\s*[\r\n]+\s*/g, " ");
  return singleLine.length > MAX_PENDING_QUESTION
    ? `${singleLine.slice(0, MAX_PENDING_QUESTION - 1)}…`
    : singleLine;
}

function statusMessage(r: SingleResult): string {
  if (r.exitCode === -1) return "running";
  if (r.stopReason === "killed")
    return r.errorMessage && r.errorMessage !== "Subagent was killed."
      ? `killed — ${r.errorMessage}`
      : "killed";
  if (r.stopReason === "aborted" && isResultError(r))
    return r.errorMessage && r.errorMessage !== "Subagent was aborted."
      ? `aborted — ${r.errorMessage}`
      : "aborted";
  if (isResultError(r)) {
    const detail = r.errorMessage || r.stopReason;
    return `failed (exit ${r.exitCode})${detail ? ` — ${detail}` : ""}`;
  }
  return "completed";
}

function renderResolvedRow(
  { original, result, stale }: ResolvedRow,
  prefix: string,
  theme: { fg: ThemeFg },
): string {
  if (stale)
    return `${staleRowHeader(original, theme, prefix)} ${theme.fg("dim", STALE_FINISHED_MSG)}`;
  const question = pendingQuestion(result);
  const waiting = question !== undefined;
  return `${theme.fg("muted", prefix)}${theme.fg("accent", result.agent)}${taskSummarySuffix(result, theme)}${runningIdBadge(result, theme)} ${waiting ? theme.fg("warning", "?") : statusIcon(result, theme)} ${theme.fg(waiting ? "warning" : statusColor(result), waiting ? "waiting for answer" : statusMessage(result))}${waiting ? theme.fg("dim", ` — ${question}`) : ""}`;
}

// ---------------------------------------------------------------------------
// renderCall — shown while the tool is being invoked
// ---------------------------------------------------------------------------

export function renderCall(
  args: Record<string, any>,
  theme: { fg: ThemeFg; bold: (s: string) => string },
  context?: RenderContext,
): Text {
  if (context?.toolCallId && context.isPartial)
    registerToolCallInvalidator(context.toolCallId, context.invalidate);
  let detail = "...";
  if (args.action === "resume") {
    detail = `resume ${args.resume_id ?? "..."}`;
  } else if (args.action === "run") {
    const parsedTasks = parseTasksParam(args.tasks);
    const tasks = parsedTasks && "tasks" in parsedTasks ? parsedTasks.tasks : undefined;
    detail = tasks?.length === 1 ? tasks[0].agent : tasks?.length ? "parallel" : "...";
  }
  const content = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", detail);
  const text = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  text.setText(content);
  return text;
}

// ---------------------------------------------------------------------------
// renderResult — body shows errors and live status.
// ---------------------------------------------------------------------------

export function renderResult(
  result: { content: ResultContent; details?: unknown },
  theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
  const details = isRenderableDetails(result.details) ? result.details : undefined;
  if (!details || details.results.length === 0) return new Text(fallbackText(result.content), 0, 0);
  return renderResultRows(details, theme);
}

export function renderCtlCall(
  args: Record<string, any>,
  theme: { fg: ThemeFg; bold: (s: string) => string },
  _context?: RenderContext,
): Text {
  const title = theme.fg("toolTitle", theme.bold(`subagent_ctl ${args.action ?? "..."}`));
  const id =
    args.action === "inspect" ||
    args.action === "kill" ||
    args.action === "steer" ||
    args.action === "answer"
      ? theme.fg("accent", ` ${args.id ?? "..."}`)
      : "";
  return new Text(title + id, 0, 0);
}

function liveListedRuns(listed: SingleResult[]): ResolvedRow[] {
  const rows: ResolvedRow[] = [];
  for (const original of listed) {
    const id = original.registryId;
    if (id && getLiveStatus(id).kind === "completed") continue;
    rows.push({ original, ...resolveLiveResult(original) });
  }
  return rows;
}

function syncListRowSubscriptions(ids: string[], context?: RenderContext): void {
  if (!context) return;
  let unsubs = context.state.listUnsubs as Map<string, () => void> | undefined;
  if (!unsubs) {
    unsubs = new Map();
    context.state.listUnsubs = unsubs;
  }
  for (const [id, unsub] of unsubs) {
    if (!ids.includes(id) || getLiveStatus(id).kind !== "running") {
      unsub();
      unsubs.delete(id);
    }
  }
  for (const id of ids) {
    if (unsubs.has(id) || getLiveStatus(id).kind !== "running") continue;
    const run = getRun(id);
    if (!run) continue;
    unsubs.set(id, run.onStatus(context.invalidate));
  }
}

export function renderListResult(
  result: { content: ResultContent; details?: unknown },
  _options: unknown,
  theme: { fg: ThemeFg; bold: (s: string) => string },
  context?: RenderContext,
): Text {
  const details = isRenderableListDetails(result.details) ? result.details : undefined;
  if (!details) return new Text(fallbackText(result.content), 0, 0);
  syncListRowSubscriptions(
    details.results.flatMap(({ registryId }) => (registryId ? [registryId] : [])),
    context,
  );
  const liveRuns = liveListedRuns(details.results);
  if (liveRuns.length === 0) {
    return new Text(
      details.results.length === 0
        ? fallbackText(result.content)
        : "No subagents currently running.",
      0,
      0,
    );
  }
  const lines = liveRuns.map((row, index) => {
    const prefix = index === liveRuns.length - 1 ? "└─ " : "├─ ";
    return renderResolvedRow(row, prefix, theme);
  });
  return new Text(lines.join("\n"), 0, 0);
}

export function renderKillResult(
  result: { content: ResultContent; details?: unknown },
  _options: unknown,
  theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
  const details = isRenderableKillDetails(result.details) ? result.details : undefined;
  if (!details) return new Text(fallbackText(result.content), 0, 0);
  if (typeof details.agent === "string") {
    return new Text(
      `${theme.fg("muted", "└─ ")}${theme.fg("muted", "■")} ${theme.fg("muted", "killed")} ${theme.fg("accent", details.agent)}${theme.fg("dim", ` [${details.id}]`)}`,
      0,
      0,
    );
  }
  return new Text(
    `${theme.fg("muted", "└─ ")}${theme.fg("dim", `no running subagent [${details.id}]`)}`,
    0,
    0,
  );
}

export function renderSteerResult(
  result: { content: ResultContent; details?: unknown },
  _options: unknown,
  theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
  const details = isRenderableKillDetails(result.details) ? result.details : undefined;
  if (!details) return new Text(fallbackText(result.content, "subagent_ctl"), 0, 0);
  if (typeof details.agent === "string") {
    return new Text(
      `${theme.fg("muted", "└─ ")}${theme.fg("success", "✓")} ${theme.fg("success", "steered")} ${theme.fg("accent", details.agent)}${theme.fg("dim", ` [${details.id}]`)}`,
      0,
      0,
    );
  }
  return new Text(fallbackText(result.content, "subagent_ctl"), 0, 0);
}

export function renderAnswerResult(
  result: { content: ResultContent; details?: unknown },
  _options: unknown,
  theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
  const details = isRenderableKillDetails(result.details) ? result.details : undefined;
  if (!details) return new Text(fallbackText(result.content, "subagent_ctl"), 0, 0);
  if (typeof details.agent === "string") {
    return new Text(
      `${theme.fg("muted", "└─ ")}${theme.fg("success", "✓")} ${theme.fg("success", "answered")} ${theme.fg("accent", details.agent)}${theme.fg("dim", ` [${details.id}]`)}`,
      0,
      0,
    );
  }
  return new Text(fallbackText(result.content, "subagent_ctl"), 0, 0);
}

export function renderInspectResult(
  result: { content: ResultContent; details?: unknown },
  _options: unknown,
  theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
  const details = isRenderableInspectDetails(result.details) ? result.details : undefined;
  if (!details?.result) return new Text(fallbackText(result.content, "subagent_ctl"), 0, 0);
  const inspected = details.result;
  const waitingForAnswer = inspected.status === "waiting_for_answer";
  const active = inspected.status === "running" || waitingForAnswer;
  const icon = active
    ? theme.fg("warning", waitingForAnswer ? "?" : "○")
    : inspected.result.stopReason === "killed"
      ? theme.fg("muted", "■")
      : isResultError(inspected.result)
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
  const status = theme.fg(
    active ? "warning" : "muted",
    waitingForAnswer ? "waiting for answer" : inspected.status,
  );
  const activity = theme.fg("dim", inspected.activitySummary ?? "No activity yet.");
  return new Text(
    `${theme.fg("muted", "└─ ")}${icon} ${status} ${theme.fg("accent", inspected.agent)}${theme.fg("dim", ` [${inspected.id}]`)}\n${theme.fg("muted", "   ")}${activity}`,
    0,
    0,
  );
}

export function renderCtlResult(
  result: { content: ResultContent; details?: unknown },
  options: unknown,
  theme: { fg: ThemeFg; bold: (s: string) => string },
  context?: RenderContext,
): Text {
  if (isRenderableListDetails(result.details))
    return renderListResult(result, options, theme, context);
  if (isRenderableInspectDetails(result.details))
    return renderInspectResult(result, options, theme);
  if (isRenderableKillDetails(result.details)) {
    if (result.details.action === "kill") return renderKillResult(result, options, theme);
    if (result.details.action === "steer") return renderSteerResult(result, options, theme);
    return renderAnswerResult(result, options, theme);
  }
  return new Text(fallbackText(result.content, "subagent_ctl"), 0, 0);
}

function renderResultRows(details: SubagentDetails, theme: { fg: ThemeFg }): Text {
  const resolved: ResolvedRow[] = details.results.map((original) => ({
    original,
    ...resolveLiveResult(original),
  }));
  const lines = resolved.map((row, index) =>
    renderResolvedRow(row, index === resolved.length - 1 ? "└─ " : "├─ ", theme),
  );
  return new Text(lines.join("\n"), 0, 0);
}
