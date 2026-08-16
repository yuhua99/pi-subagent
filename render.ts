/**
 * TUI rendering for subagent tool calls and results.
 *
 * Tool rows show errors and live status only. Rich detail lives in `/agents`.
 */

import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getRun, listCompletedRuns, registerToolCallInvalidator, resolveLiveResult, type ResolvedResult, type SubagentRun } from "./registry.ts";
import { parseSubagentCtlInvocation, parseSubagentInvocation } from "./tool_schema.ts";
import {
	type SingleResult,
	type SubagentDetails,
	type SubagentCtlDetails,
	type SubagentInspectDetails,
	type SubagentListDetails,
	type UsageStats,
	isResultError,
	parseTasksParam,
} from "./types.ts";

const STALE_FINISHED_MSG = "finished — result delivered separately";

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
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isRenderableResult(value: unknown): value is SingleResult {
	return isRecord(value) && typeof value.agent === "string" && typeof value.exitCode === "number" && Array.isArray(value.messages);
}

function isRenderableDetails(value: unknown): value is SubagentDetails {
	return isRecord(value) && (value.mode === "single" || value.mode === "parallel") && Array.isArray(value.results) && value.results.every(isRenderableResult);
}

function isRenderableListDetails(value: unknown): value is SubagentListDetails {
	return isRecord(value) && value.action === "list" && Array.isArray(value.runs) && value.runs.every((run) => (
		isRecord(run) && typeof run.id === "string" && typeof run.agent === "string" &&
		(run.taskSummary === undefined || typeof run.taskSummary === "string") && typeof run.startedAt === "number"
	));
}

function isRenderableKillDetails(value: unknown): value is SubagentCtlDetails {
	return isRecord(value) && (value.action === "kill" || value.action === "steer") &&
		typeof value.id === "string" && (!("agent" in value) || typeof value.agent === "string");
}

function isRenderableInspectDetails(value: unknown): value is SubagentInspectDetails {
	if (!isRecord(value) || value.action !== "inspect" || typeof value.id !== "string") return false;
	if (value.result === undefined) return true;
	if (!isRecord(value.result)) return false;
	return typeof value.result.id === "string" && typeof value.result.agent === "string" &&
		typeof value.result.task === "string" && (value.result.taskSummary === undefined || typeof value.result.taskSummary === "string") &&
		(value.result.activitySummary === undefined || typeof value.result.activitySummary === "string") &&
		typeof value.result.startedAt === "number" && (value.result.finishedAt === undefined || typeof value.result.finishedAt === "number") &&
		(value.result.status === "running" || value.result.status === "completed") && isRenderableResult(value.result.result);
}

function validationMessage(content: ResultContent, toolName: "subagent" | "subagent_ctl" = "subagent"): string | undefined {
	const text = content.find((block) => block.type === "text" && typeof block.text === "string")?.text;
	if (!text?.startsWith(`Validation failed for tool "${toolName}":`)) return undefined;
	const received = text.match(/Received arguments:\s*(\{[\s\S]*\})\s*$/)?.[1];
	let args: unknown;
	try {
		args = received ? JSON.parse(received) : undefined;
	} catch {
		args = undefined;
	}
	const parsed = toolName === "subagent" ? parseSubagentInvocation(args) : parseSubagentCtlInvocation(args);
	return "error" in parsed ? `Validation error: ${parsed.error}` : undefined;
}

function fallbackText(content: ResultContent, toolName: "subagent" | "subagent_ctl" = "subagent"): string {
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
		lines.push(`[${e.id}] ${e.agent}${e.taskSummary ? ` — ${e.taskSummary}` : ""} — running ${formatElapsed(now - e.startedAt)}`);
	}
	return lines.join("\n");
}

function runningIdBadge(r: SingleResult, theme: { fg: ThemeFg }): string {
	return r.exitCode === -1 && r.registryId ? theme.fg("dim", ` [${r.registryId}]`) : "";
}

function taskSummarySuffix(r: SingleResult, theme: { fg: ThemeFg }): string {
	if (!r.registryId) return "";
	const taskSummary = getRun(r.registryId)?.taskSummary ?? listCompletedRuns().find((run) => run.id === r.registryId)?.taskSummary;
	return taskSummary ? theme.fg("dim", ` — ${taskSummary}`) : "";
}

function statusIcon(r: SingleResult, theme: { fg: ThemeFg }): string {
	if (r.exitCode === -1) return theme.fg("warning", "○");
	if (r.stopReason === "killed") return theme.fg("warning", "■");
	return isResultError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function statusColor(r: SingleResult): ThemeColor {
	return r.exitCode === -1 ? "muted" : r.stopReason === "killed" ? "warning" : isResultError(r) ? "error" : "success";
}

function statusMessage(r: SingleResult): string {
	if (r.exitCode === -1) return "running";
	if (r.stopReason === "killed") return r.errorMessage && r.errorMessage !== "Subagent was killed." ? `killed — ${r.errorMessage}` : "killed";
	if (r.stopReason === "aborted" && isResultError(r)) return r.errorMessage && r.errorMessage !== "Subagent was aborted." ? `aborted — ${r.errorMessage}` : "aborted";
	if (isResultError(r)) {
		const detail = r.errorMessage || r.stopReason;
		return `failed (exit ${r.exitCode})${detail ? ` — ${detail}` : ""}`;
	}
	return "completed";
}

// ---------------------------------------------------------------------------
// renderCall — shown while the tool is being invoked
// ---------------------------------------------------------------------------

export function renderCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: RenderContext,
): Text {
	if (context?.toolCallId && context.isPartial) registerToolCallInvalidator(context.toolCallId, context.invalidate);
	let detail = "...";
	if (args.action === "run_parallel") {
		const parsedTasks = parseTasksParam(args.tasks);
		const tasks = parsedTasks && "tasks" in parsedTasks ? parsedTasks.tasks : undefined;
		detail = tasks?.length ? `parallel (${tasks.length} tasks)` : "parallel";
	} else if (args.action === "resume") {
		detail = `resume ${args.resume_id ?? "..."}`;
	} else if (args.action === "run") {
		detail = args.agent ?? "...";
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
	return details.mode === "single"
		? renderSingleResult(details.results[0], theme)
		: renderParallelResult(details, theme);
}

export function renderCtlCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	_context?: RenderContext,
): Text {
	const title = theme.fg("toolTitle", theme.bold(`subagent_ctl ${args.action ?? "..."}`));
	const id = args.action === "inspect" || args.action === "kill" || args.action === "steer"
		? theme.fg("accent", ` ${args.id ?? "..."}`) : "";
	return new Text(title + id, 0, 0);
}

export function renderListResult(
	result: { content: ResultContent; details?: unknown },
	_options: unknown,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const details = isRenderableListDetails(result.details) ? result.details : undefined;
	if (!details || details.runs.length === 0) return new Text(fallbackText(result.content), 0, 0);
	const lines = details.runs.map((run, index) => {
		const prefix = index === details.runs.length - 1 ? "└─ " : "├─ ";
		const summary = run.taskSummary ? theme.fg("dim", ` — ${run.taskSummary}`) : "";
		return `${theme.fg("muted", prefix)}${theme.fg("accent", run.agent)}${summary}${theme.fg("dim", ` [${run.id}]`)} ${theme.fg("warning", "○")} ${theme.fg("muted", `running ${formatElapsed(Date.now() - run.startedAt)}`)}`;
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
	if ("agent" in details) {
		return new Text(`${theme.fg("muted", "└─ ")}${theme.fg("warning", "■")} ${theme.fg("warning", "killed")} ${theme.fg("accent", details.agent)}${theme.fg("dim", ` [${details.id}]`)}`, 0, 0);
	}
	return new Text(`${theme.fg("muted", "└─ ")}${theme.fg("dim", `no running subagent [${details.id}]`)}`, 0, 0);
}

export function renderSteerResult(
	result: { content: ResultContent; details?: unknown },
	_options: unknown,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const details = isRenderableKillDetails(result.details) ? result.details : undefined;
	if (!details) return new Text(fallbackText(result.content, "subagent_ctl"), 0, 0);
	if ("agent" in details) {
		return new Text(`${theme.fg("muted", "└─ ")}${theme.fg("success", "✓")} ${theme.fg("success", "steered")} ${theme.fg("accent", details.agent)}${theme.fg("dim", ` [${details.id}]`)}`, 0, 0);
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
	const icon = inspected.status === "running" ? theme.fg("warning", "○")
		: isResultError(inspected.result) ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const status = theme.fg(inspected.status === "running" ? "warning" : "muted", inspected.status);
	const activity = theme.fg("dim", inspected.activitySummary ?? "No activity yet.");
	return new Text(`${theme.fg("muted", "└─ ")}${icon} ${status} ${theme.fg("accent", inspected.agent)}${theme.fg("dim", ` [${inspected.id}]`)}\n${theme.fg("muted", "   ")}${activity}`, 0, 0);
}

export function renderCtlResult(
	result: { content: ResultContent; details?: unknown },
	options: unknown,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	if (isRenderableListDetails(result.details)) return renderListResult(result, options, theme);
	if (isRenderableInspectDetails(result.details)) return renderInspectResult(result, options, theme);
	if (isRenderableKillDetails(result.details)) {
		return result.details.action === "kill"
			? renderKillResult(result, options, theme)
			: renderSteerResult(result, options, theme);
	}
	return new Text(fallbackText(result.content, "subagent_ctl"), 0, 0);
}

// ---------------------------------------------------------------------------
// Single-mode result
// ---------------------------------------------------------------------------

function renderSingleResult(original: SingleResult, theme: { fg: ThemeFg }): Text {
	const { result: r, stale } = resolveLiveResult(original);
	if (stale) return new Text(`${staleRowHeader(original, theme)} ${theme.fg("dim", STALE_FINISHED_MSG)}`, 0, 0);
	return new Text(`${theme.fg("muted", "└─ ")}${statusIcon(r, theme)} ${theme.fg(statusColor(r), statusMessage(r))}${runningIdBadge(r, theme)}${taskSummarySuffix(r, theme)}`, 0, 0);
}

// ---------------------------------------------------------------------------
// Parallel-mode result
// ---------------------------------------------------------------------------

function renderParallelResult(details: SubagentDetails, theme: { fg: ThemeFg }): Text {
	const resolved: ResolvedRow[] = details.results.map((original) => ({ original, ...resolveLiveResult(original) }));
	const lines = resolved.map(({ original, result: r, stale }, index) => {
		const prefix = index === resolved.length - 1 ? "└─ " : "├─ ";
		if (stale) return `${staleRowHeader(original, theme, prefix)} ${theme.fg("dim", STALE_FINISHED_MSG)}`;
		return `${theme.fg("muted", prefix)}${theme.fg("accent", r.agent)}${taskSummarySuffix(r, theme)}${runningIdBadge(r, theme)} ${statusIcon(r, theme)} ${theme.fg(statusColor(r), statusMessage(r))}`;
	});
	return new Text(lines.join("\n"), 0, 0);
}
