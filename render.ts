/**
 * TUI rendering for subagent tool calls and results.
 *
 * Tool rows show errors and live status only. Rich detail lives in `/agents`.
 */

import * as os from "node:os";
import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getRun, listCompletedRuns, registerToolCallInvalidator, resolveLiveResult, type ResolvedResult, type SubagentRun } from "./registry.ts";
import {
	type DelegationMode,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
	DEFAULT_DELEGATION_MODE,
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

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function normalizeDelegationMode(raw: unknown): DelegationMode {
	return raw === "fork" ? "fork" : DEFAULT_DELEGATION_MODE;
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

function hasUnexpectedKeys(args: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(args).some((key) => !allowed.includes(key));
}

function taskListGuidance(value: unknown): string | undefined {
	if (typeof value === "string") return undefined;
	if (!Array.isArray(value) || value.length === 0) return "Validation error: `tasks` must be a non-empty array of `{ agent, task, cwd? }` or a JSON string.";
	for (const task of value) {
		if (!isRecord(task)) return "Validation error: task items must be `{ agent, task, cwd? }`.";
		if (hasUnexpectedKeys(task, ["agent", "task", "cwd"])) return "Validation error: task items accept only `agent`, `task`, and optional `cwd`.";
		if (typeof task.agent !== "string") return "Validation error: task item `agent` must be a string.";
		if (typeof task.task !== "string") return "Validation error: task item `task` must be a string.";
		if (task.cwd !== undefined && typeof task.cwd !== "string") return "Validation error: task item `cwd` must be a string.";
	}
}

function validationGuidance(args: unknown): string {
	if (!isRecord(args)) return "Validation error: use `{ agent, task }`, `{ tasks }`, or `{ resume, task }`.";
	if ("resume" in args) {
		if (typeof args.resume !== "string") return "Validation error: resume requires string `resume` and `task`.";
		if (!("task" in args)) return "Validation error: resume requires `task`.";
		if (typeof args.task !== "string") return "Validation error: resume `task` must be a string.";
		if ("cwd" in args) return "Validation error: resume does not accept `cwd`; use only `resume` and `task`.";
		return "Validation error: resume accepts only `resume` and `task`.";
	}
	if ("tasks" in args) {
		if (hasUnexpectedKeys(args, ["tasks", "mode"])) return "Validation error: parallel calls accept only `tasks` and optional `mode`.";
		if (args.mode !== undefined && typeof args.mode !== "string") return "Validation error: parallel call `mode` must be a string.";
		const taskGuidance = taskListGuidance(args.tasks);
		if (taskGuidance) return taskGuidance;
		return "Validation error: parallel calls accept `tasks` as an array or JSON string, with optional `mode`.";
	}
	if ("agent" in args) {
		if (typeof args.agent !== "string") return "Validation error: single subagent calls require string `agent` and `task`.";
		if (!("task" in args)) return "Validation error: single subagent calls require `task`.";
		if (typeof args.task !== "string") return "Validation error: single subagent `task` must be a string.";
		if (args.mode !== undefined && typeof args.mode !== "string") return "Validation error: single call `mode` must be a string.";
		if (args.cwd !== undefined && typeof args.cwd !== "string") return "Validation error: single call `cwd` must be a string.";
		if (hasUnexpectedKeys(args, ["agent", "task", "mode", "cwd"])) return "Validation error: single calls accept only `agent`, `task`, optional `mode`, and optional `cwd`.";
		return "Validation error: single calls accept string `agent`, `task`, optional `mode`, and optional `cwd`.";
	}
	return "Validation error: use `{ agent, task }`, `{ tasks }`, or `{ resume, task }`.";
}

function validationMessage(content: ResultContent): string | undefined {
	const text = content.find((block) => block.type === "text" && typeof block.text === "string")?.text;
	if (!text?.startsWith('Validation failed for tool "subagent":')) return undefined;
	const received = text.match(/Received arguments:\s*(\{[\s\S]*\})\s*$/)?.[1];
	try {
		return validationGuidance(received ? JSON.parse(received) : undefined);
	} catch {
		return validationGuidance(undefined);
	}
}

function fallbackText(content: ResultContent): string {
	const validation = validationMessage(content);
	if (validation) return validation;
	const first = content[0];
	return first?.type === "text" && first.text ? first.text : "(no output)";
}

export type ThemeFg = (color: ThemeColor, text: string) => string;

function formatToolCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const pathArg = (args.file_path || args.path || "...") as string;

	switch (toolName) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			return splitOutputLines(cmd)
				.map((line, i) => (i === 0 ? fg("muted", "$ ") : "  ") + fg("toolOutput", line))
				.join("\n");
		}
		case "read": {
			let text = fg("accent", shortenPath(pathArg));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const lines = ((args.content || "") as string).split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(pathArg));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenPath(pathArg));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenPath((args.path || ".") as string));
		case "find":
			return fg("muted", "find ") + fg("accent", (args.pattern || "*") as string) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${(args.pattern || "") as string}/`) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		default:
			return fg("accent", toolName) + fg("dim", ` ${JSON.stringify(args)}`);
	}
}

// ---------------------------------------------------------------------------
// Shared rendering building blocks
// ---------------------------------------------------------------------------

function splitOutputLines(text: string): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

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

/** Full transcript lines for the /agents detail view: thinking, text, and tool calls. Appends `partialMessage` when present to render live streaming output. */
export function transcriptLines(r: Pick<SingleResult, "messages" | "partialMessage">, theme: { fg: ThemeFg }): string[] {
	const lines: string[] = [];
	const messages = r.partialMessage ? [...r.messages, r.partialMessage] : r.messages;
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		if (lines.length > 0) lines.push("");
		for (const part of msg.content) {
			if (part.type === "thinking") {
				for (const line of splitOutputLines(part.thinking)) lines.push(theme.fg("dim", line));
			} else if (part.type === "text") {
				for (const line of splitOutputLines(part.text)) lines.push(theme.fg("toolOutput", line));
			} else if (part.type === "toolCall") {
				const call = theme.fg("muted", "→ ") + formatToolCall(part.name, part.arguments, theme.fg.bind(theme));
				for (const line of splitOutputLines(call)) lines.push(line);
			}
		}
	}
	return lines;
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
	const delegationMode = normalizeDelegationMode(args.mode);
	const modeBadge = delegationMode === "fork" ? theme.fg("muted", " [fork]") : "";
	const parsedTasks = parseTasksParam(args.tasks);
	const tasks = parsedTasks && "tasks" in parsedTasks ? parsedTasks.tasks : undefined;
	let content: string;
	if (tasks && tasks.length > 0) {
		content = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${tasks.length} tasks)`) + modeBadge;
	} else {
		const agentName = args.agent || (args.resume ? `resume ${args.resume}` : "...");
		content = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + (args.resume ? "" : modeBadge);
	}
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
