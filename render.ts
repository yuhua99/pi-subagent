/**
 * TUI rendering for subagent tool calls and results.
 *
 * Tool rows show errors and live status only. Rich detail lives in `/agents`.
 */

import * as os from "node:os";
import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerToolCallInvalidator, resolveLiveResult, type ResolvedResult, type SubagentRun } from "./registry.ts";
import {
	type DelegationMode,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
	DEFAULT_DELEGATION_MODE,
	isResultError,
	parseTasksParam,
} from "./types.ts";

const STALE_FINISHED_MSG = "finished (result delivered separately)";

export type RenderContext = {
	state: Record<string, any>;
	invalidate: () => void;
	toolCallId?: string;
	isPartial?: boolean;
	lastComponent?: unknown;
};

type ResolvedRow = ResolvedResult & { original: SingleResult };

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function staleRowHeader(original: SingleResult, theme: { fg: ThemeFg }, prefix = "└─ "): string {
	return (
		theme.fg("muted", prefix) +
		theme.fg("accent", original.agent) +
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
		lines.push(`[${e.id}] ${e.agent} — running ${formatElapsed(now - e.startedAt)}`);
	}
	return lines.join("\n");
}

function runningIdBadge(r: SingleResult, theme: { fg: ThemeFg }): string {
	return r.exitCode === -1 && r.registryId ? theme.fg("dim", ` [${r.registryId}]`) : "";
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
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	if (r.stopReason === "killed") return theme.fg("warning", "■");
	return isResultError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function statusColor(r: SingleResult): ThemeColor {
	return r.exitCode === -1 ? "muted" : r.stopReason === "killed" ? "warning" : isResultError(r) ? "error" : "success";
}

function statusMessage(r: SingleResult): string {
	if (r.exitCode === -1) return "running";
	if (r.stopReason === "killed") return r.errorMessage ? `[killed] ${r.errorMessage}` : "[killed]";
	if (isResultError(r)) {
		if (r.errorMessage) return `Error: ${r.errorMessage}`;
		return r.stopReason ? `Error: ${r.stopReason}` : `Error (exit ${r.exitCode})`;
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
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "(no output)", 0, 0);
	}
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
	return new Text(`${theme.fg("muted", "└─ ")}${statusIcon(r, theme)} ${theme.fg(statusColor(r), statusMessage(r))}${runningIdBadge(r, theme)}`, 0, 0);
}

// ---------------------------------------------------------------------------
// Parallel-mode result
// ---------------------------------------------------------------------------

function renderParallelResult(details: SubagentDetails, theme: { fg: ThemeFg }): Text {
	const resolved: ResolvedRow[] = details.results.map((original) => ({ original, ...resolveLiveResult(original) }));
	const lines = resolved.map(({ original, result: r, stale }, index) => {
		const prefix = index === resolved.length - 1 ? "└─ " : "├─ ";
		if (stale) return `${staleRowHeader(original, theme, prefix)} ${theme.fg("dim", STALE_FINISHED_MSG)}`;
		return `${theme.fg("muted", prefix)}${theme.fg("accent", r.agent)}${runningIdBadge(r, theme)} ${statusIcon(r, theme)} ${theme.fg(statusColor(r), statusMessage(r))}`;
	});
	return new Text(lines.join("\n"), 0, 0);
}
