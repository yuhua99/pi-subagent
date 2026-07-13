/**
 * TUI rendering for subagent tool calls and results.
 */

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getResultSummaryText } from "./runner-events.js";
import { resolveLiveResult, type ResolvedResult, type TrackedSubagent } from "./registry.js";
import {
	type DelegationMode,
	type DisplayItem,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
	DEFAULT_DELEGATION_MODE,
	aggregateUsage,
	getDisplayItems,
	getFinalOutput,
	isResultError,
	isResultSuccess,
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

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Partial<UsageStats>, model?: string): string {
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
	const lines = [`${entries.length} running subagent(s):`];
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
// renderResult — shown after the tool completes, and also while it is still
// running: renders live/stale state and publishes header icon/badge back
// into `context.state` so the collapsed tool-call header stays in sync.
// ---------------------------------------------------------------------------

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: RenderContext,
): Container | Text {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "(no output)", 0, 0);
	}

	const delegationMode = normalizeDelegationMode(
		(details as Partial<SubagentDetails>).delegationMode,
	);
	if (details.mode === "single") {
		return renderSingleResult(details.results[0], expanded, theme, context);
	}
	return renderParallelResult(details, delegationMode, expanded, theme, context);
}

// ---------------------------------------------------------------------------
// Single-mode result
// ---------------------------------------------------------------------------

function renderSingleResult(
	original: SingleResult,
	expanded: boolean,
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
	const error = isResultError(r);

	if (expanded) {
		return renderSingleExpanded(
			r,
			error,
			getDisplayItems(r.messages),
			getFinalOutput(r.messages),
			theme,
		);
	}
	return renderSingleCollapsed(r, error, theme);
}

function renderSingleExpanded(
	r: SingleResult,
	error: boolean,
	displayItems: DisplayItem[],
	finalOutput: string,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	if (error && r.stopReason) {
		container.addChild(new Text(theme.fg("error", `[${r.stopReason}]`), 0, 0));
	}
	if (error && r.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}
	if (error && (r.stopReason || r.errorMessage)) {
		container.addChild(new Spacer(1));
	}

	// Task
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", r.task), 0, 0));

	// Output
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
	if (displayItems.length === 0 && !finalOutput) {
		const summary = getResultSummaryText(r);
		container.addChild(new Text(theme.fg("muted", summary), 0, 0));
	} else {
		for (const item of displayItems) {
			if (item.type === "toolCall") {
				container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
			}
		}
		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}
	}

	// Usage
	const usageStr = formatUsage(r.usage, r.model);
	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
	}

	return container;
}

function renderSingleCollapsed(
	r: SingleResult,
	error: boolean,
	theme: { fg: ThemeFg },
): Container | Text {
	const lines: string[] = [];
	if (error && r.stopReason) lines.push(theme.fg("error", `[${r.stopReason}]`));

	if (error && r.errorMessage) {
		lines.push(theme.fg("error", `Error: ${r.errorMessage}`));
	} else if (error) {
		const fallback = r.stopReason
			? `Error: ${r.stopReason}`
			: `Error (exit ${r.exitCode})`;
		lines.push(theme.fg("error", fallback));
	}

	if (lines.length === 0) return new Container();
	return new Text(lines.join("\n"), 0, 0);
}

// ---------------------------------------------------------------------------
// Parallel-mode result
// ---------------------------------------------------------------------------

function renderParallelResult(
	details: SubagentDetails,
	delegationMode: DelegationMode,
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: RenderContext,
): Container | Text {
	const resolved: ResolvedRow[] = details.results.map((r) => ({
		original: r,
		...resolveLiveResult(r, context?.invalidate),
	}));
	const liveResults = resolved.filter((x) => !x.stale).map((x) => x.result);
	const total = details.results.length;
	const staleCount = resolved.filter((x) => x.stale).length;
	const allStale = total > 0 && staleCount === total;
	const running = resolved.filter((x) => !x.stale && x.result.exitCode === -1).length;
	const successCount = resolved.filter((x) => !x.stale && isResultSuccess(x.result)).length;
	const failCount = resolved.filter((x) => !x.stale && isResultError(x.result)).length;
	const isRunning = running > 0;
	const liveTotal = total - staleCount;

	const icon = allStale
		? theme.fg("dim", "◌")
		: isRunning
			? theme.fg("warning", "⏳")
			: failCount > 0
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");

	const status = allStale
		? `${total} task(s) finished (results delivered separately)`
		: isRunning
			? `${successCount + failCount}/${liveTotal} done, ${running} running`
			: `${successCount}/${liveTotal} tasks`;

	publishHeader(context, icon);

	if (expanded) {
		return renderParallelExpanded(resolved, liveResults, delegationMode, status, theme);
	}
	return renderParallelCollapsed(resolved, theme);
}

function renderParallelExpanded(
	resolved: ResolvedRow[],
	liveResults: SingleResult[],
	delegationMode: DelegationMode,
	status: string,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(
		new Text(
			`${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}${theme.fg("muted", ` [${delegationMode}]`)}`,
			0,
			0,
		),
	);

	for (const { original, result: r, stale } of resolved) {
		if (stale) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					`${staleRowHeader(original, theme)}${theme.fg("dim", ` ${STALE_FINISHED_MSG}`)}`,
					0,
					0,
				),
			);
			continue;
		}
		const rIcon = statusIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);

		container.addChild(new Spacer(1));
		container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)}${runningIdBadge(r, theme)} ${rIcon}`, 0, 0));
		container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

		for (const item of displayItems) {
			if (item.type === "toolCall") {
				container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
			}
		}

		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		} else if (isResultError(r)) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("error", getResultSummaryText(r)), 0, 0));
		}

		const taskUsage = formatUsage(r.usage, r.model);
		if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
	}

	const totalUsage = formatUsage(aggregateUsage(liveResults));
	if (totalUsage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
	}

	return container;
}

function renderParallelCollapsed(
	resolved: ResolvedRow[],
	theme: { fg: ThemeFg },
): Text {
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
