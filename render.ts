/**
 * TUI rendering for subagent tool calls and results.
 *
 * Tool rows show errors and live status only. Rich detail lives in `/agents`.
 */

import * as os from "node:os";
import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { bindRowInvalidator, getToolCallStatus, resolveLiveResult, type ResolvedResult, type SubagentRun } from "./registry.ts";
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
};

type ResolvedRow = ResolvedResult & { original: SingleResult };

function staleRowHeader(
	original: SingleResult,
	theme: { fg: ThemeFg },
): string {
	return (
		theme.fg("muted", "─── ") +
		theme.fg("accent", original.agent) +
		runningIdBadge(original, theme) +
		` ${theme.fg("dim", "◌")}`
	);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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
				for (const line of splitOutputLines(part.thinking)) {
					lines.push(theme.fg("dim", line));
				}
			} else if (part.type === "text") {
				for (const line of splitOutputLines(part.text)) {
					lines.push(theme.fg("toolOutput", line));
				}
			} else if (part.type === "toolCall") {
				const call = theme.fg("muted", "→ ") + formatToolCall(part.name, part.arguments, theme.fg.bind(theme));
				for (const line of splitOutputLines(call)) {
					lines.push(line);
				}
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

function killedBody(r: SingleResult, theme: { fg: ThemeFg }): Text {
	const message = r.errorMessage ? `[killed] ${r.errorMessage}` : "[killed]";
	return new Text(theme.fg("warning", message), 0, 0);
}

function singleErrorBody(r: SingleResult, theme: { fg: ThemeFg }): Container | Text {
	const lines: string[] = [];
	if (r.stopReason) lines.push(theme.fg("error", `[${r.stopReason}]`));

	if (r.errorMessage) {
		lines.push(theme.fg("error", `Error: ${r.errorMessage}`));
	} else {
		const fallback = r.stopReason
			? `Error: ${r.stopReason}`
			: `Error (exit ${r.exitCode})`;
		lines.push(theme.fg("error", fallback));
	}

	return new Text(lines.join("\n"), 0, 0);
}

// ---------------------------------------------------------------------------
// renderCall — shown while the tool is being invoked
// ---------------------------------------------------------------------------

export function renderCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: RenderContext,
): Text {
	const delegationMode = normalizeDelegationMode(args.mode);
	const modeBadge = delegationMode === "fork" ? theme.fg("muted", " [fork]") : "";
	const status = context?.toolCallId ? getToolCallStatus(context.toolCallId) : undefined;
	if (status?.kind === "running") bindRowInvalidator(status.result.registryId!, context!.invalidate);
	const headerIcon = status && status.kind !== "stale" ? `${statusIcon(status.result, theme)} ` : "";
	const headerBadge = status && status.kind !== "stale" ? runningIdBadge(status.result, theme) : "";

	const parsedTasks = parseTasksParam(args.tasks);
	const tasks = parsedTasks && "tasks" in parsedTasks ? parsedTasks.tasks : undefined;
	if (tasks && tasks.length > 0) {
		const text =
			headerIcon +
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${tasks.length} tasks)`) +
			modeBadge +
			headerBadge;
		return new Text(text, 0, 0);
	}

	// Single mode
	const agentName = args.agent || (args.resume ? `resume ${args.resume}` : "...");
	const text =
		headerIcon +
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		(args.resume ? "" : modeBadge) +
		headerBadge;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult — body shows errors and live status.
// ---------------------------------------------------------------------------

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: RenderContext,
): Container | Text {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "(no output)", 0, 0);
	}

	if (details.mode === "single") {
		return renderSingleResult(details.results[0], theme, context);
	}
	return renderParallelResult(details, theme, context);
}

// ---------------------------------------------------------------------------
// Single-mode result
// ---------------------------------------------------------------------------

function renderSingleResult(
	original: SingleResult,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: RenderContext,
): Container | Text {
	const { result: r, stale } = resolveLiveResult(original);
	if (!stale && r.exitCode === -1 && r.registryId && context) {
		bindRowInvalidator(r.registryId, context.invalidate);
	}
	if (stale) {
		return new Text(theme.fg("dim", STALE_FINISHED_MSG), 0, 0);
	}
	if (r.stopReason === "killed") {
		return killedBody(r, theme);
	}
	if (isResultError(r)) {
		return singleErrorBody(r, theme);
	}
	return new Container();
}

// ---------------------------------------------------------------------------
// Parallel-mode result
// ---------------------------------------------------------------------------

function renderParallelResult(
	details: SubagentDetails,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: RenderContext,
): Container | Text {
	const resolved: ResolvedRow[] = details.results.map((r) => {
		const res = resolveLiveResult(r);
		if (!res.stale && res.result.exitCode === -1 && res.result.registryId && context) {
			bindRowInvalidator(res.result.registryId, context.invalidate);
		}
		return { original: r, ...res };
	});
	const lines: string[] = [];
	for (const { original, result: r, stale } of resolved) {
		if (stale) {
			lines.push(`${staleRowHeader(original, theme)} ${theme.fg("dim", STALE_FINISHED_MSG)}`);
			continue;
		}
		lines.push(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)}${runningIdBadge(r, theme)} ${statusIcon(r, theme)}`);
		if (r.stopReason === "killed") {
			const msg = r.errorMessage ? `[killed] ${r.errorMessage}` : "[killed]";
			lines.push(theme.fg("warning", msg));
		} else if (isResultError(r)) {
			const msg = r.errorMessage
				? `Error: ${r.errorMessage}`
				: r.stopReason
					? `Error: ${r.stopReason}`
					: `Error (exit ${r.exitCode})`;
			lines.push(theme.fg("error", msg));
		}
	}

	return new Text(lines.join("\n"), 0, 0);
}
