/**
 * TUI rendering for subagent tool calls and results.
 *
 * Tool rows show errors and live status only. Rich detail lives in `/agents`.
 */

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { resolveLiveResult, type ResolvedResult, type TrackedSubagent } from "./registry.js";
import {
	type DelegationMode,
	type SingleResult,
	type SubagentDetails,
	DEFAULT_DELEGATION_MODE,
	isResultError,
} from "./types.js";

const STALE_FINISHED_MSG = "finished (result delivered separately)";

export type RenderContext = {
	state: Record<string, any>;
	invalidate: () => void;
};

type ResolvedRow = ResolvedResult & { original: SingleResult };

function publishHeader(
	context: RenderContext | undefined,
	icon: string,
	badge = "",
): void {
	if (!context) return;
	if (context.state.headerIcon === icon && context.state.headerBadge === badge) return;
	context.state.headerIcon = icon;
	context.state.headerBadge = badge;
	queueMicrotask(context.invalidate);
}

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

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function normalizeDelegationMode(raw: unknown): DelegationMode {
	return raw === "fork" ? "fork" : DEFAULT_DELEGATION_MODE;
}

type ThemeFg = (color: ThemeColor, text: string) => string;

function formatToolCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const pathArg = (args.file_path || args.path || "...") as string;

	switch (toolName) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			return fg("muted", "$ ") + fg("toolOutput", truncate(cmd, 60));
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
			return fg("accent", toolName) + fg("dim", ` ${truncate(JSON.stringify(args), 50)}`);
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

export function formatSubagentList(entries: TrackedSubagent[], now = Date.now()): string {
	if (entries.length === 0) return "No subagents currently running.";
	const lines: string[] = [`${entries.length} running subagent(s):`];
	for (const e of entries) {
		const pid = e.pid !== undefined ? ` (pid ${e.pid})` : "";
		lines.push("", `[${e.id}] ${e.agent} — running ${formatElapsed(now - e.startedAt)}${pid}`, `  task: ${e.task}`);
	}
	return lines.join("\n");
}

function runningIdBadge(r: SingleResult, theme: { fg: ThemeFg }): string {
	return r.exitCode === -1 && r.registryId ? theme.fg("dim", ` [${r.registryId}]`) : "";
}

/** Full transcript lines for the /agents detail view: thinking, text, and tool calls. */
export function transcriptLines(messages: Message[], theme: { fg: ThemeFg }): string[] {
	const lines: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		if (lines.length > 0) lines.push("");
		for (const part of msg.content) {
			if (part.type === "thinking") {
				for (const line of splitOutputLines(part.thinking)) {
					lines.push(theme.fg("dim", `✻ ${line}`));
				}
			} else if (part.type === "text") {
				for (const line of splitOutputLines(part.text)) {
					lines.push(theme.fg("toolOutput", line));
				}
			} else if (part.type === "toolCall") {
				lines.push(theme.fg("muted", "→ ") + formatToolCall(part.name, part.arguments, theme.fg.bind(theme)));
			}
		}
	}
	return lines;
}

function statusIcon(r: SingleResult, theme: { fg: ThemeFg }): string {
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	return isResultError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
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
	context?: Pick<RenderContext, "state">,
): Text {
	const delegationMode = normalizeDelegationMode(args.mode);
	const modeBadge = theme.fg("muted", ` [${delegationMode}]`);
	const headerIcon = typeof context?.state.headerIcon === "string" ? `${context.state.headerIcon} ` : "";
	const headerBadge = typeof context?.state.headerBadge === "string" ? context.state.headerBadge : "";

	if (args.tasks && args.tasks.length > 0) {
		const text =
			headerIcon +
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			modeBadge +
			headerBadge;
		return new Text(text, 0, 0);
	}

	// Single mode
	const agentName = args.agent || "...";
	const text =
		headerIcon +
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		modeBadge +
		headerBadge;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult — body shows errors / live status; header icon/badge stay in
// sync via context.state for live/stale runs.
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
	const { result: r, stale } = resolveLiveResult(original, context?.invalidate);
	const icon = stale ? theme.fg("dim", "◌") : statusIcon(r, theme);
	const badge = stale ? "" : runningIdBadge(r, theme);
	publishHeader(context, icon, badge);
	if (stale) {
		return new Text(theme.fg("dim", STALE_FINISHED_MSG), 0, 0);
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
	const resolved: ResolvedRow[] = details.results.map((r) => ({
		original: r,
		...resolveLiveResult(r, context?.invalidate),
	}));
	const total = details.results.length;
	const staleCount = resolved.filter((x) => x.stale).length;
	const allStale = total > 0 && staleCount === total;
	const running = resolved.filter((x) => !x.stale && x.result.exitCode === -1).length;
	const failCount = resolved.filter((x) => !x.stale && isResultError(x.result)).length;
	const isRunning = running > 0;

	const icon = allStale
		? theme.fg("dim", "◌")
		: isRunning
			? theme.fg("warning", "⏳")
			: failCount > 0
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");

	publishHeader(context, icon);

	const lines: string[] = [];
	for (const { original, result: r, stale } of resolved) {
		if (stale) {
			lines.push(`${staleRowHeader(original, theme)} ${theme.fg("dim", STALE_FINISHED_MSG)}`);
			continue;
		}
		lines.push(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)}${runningIdBadge(r, theme)} ${statusIcon(r, theme)}`);
		if (isResultError(r)) {
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
