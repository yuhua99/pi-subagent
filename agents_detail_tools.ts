import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

type ToolStatus = "pending" | "ok" | "error";

type ToolMember = {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	group: string;
	status: ToolStatus;
	error?: string;
};

type ToolEntry = Pick<ToolMember, "toolCallId" | "toolName" | "args" | "group">;

const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls"]);
const QUIET_TOOLS = new Set([...EXPLORATION_TOOLS, "bash", "edit", "write"]);
const MAX_TEXT = 80;

export function isDetailQuietTool(toolName: string): boolean {
	return QUIET_TOOLS.has(toolName);
}

function shorten(text: string): string {
	const singleLine = text.replace(/\s*[\r\n]+\s*/g, " ");
	return singleLine.length > MAX_TEXT ? `${singleLine.slice(0, MAX_TEXT - 1)}…` : singleLine;
}

function firstError(result: { content?: Array<{ type: string; text?: string }> }): string {
	const text = result.content?.find((content) => content.type === "text")?.text ?? "";
	return shorten(text.split("\n", 1)[0]?.trim() || "error");
}

function target(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "read": {
			const path = args.file_path ?? args.path;
			return typeof path === "string" ? path : "read";
		}
		case "grep": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "grep";
			const path = typeof args.path === "string" ? args.path : "";
			return path ? `${pattern} in ${path}` : pattern;
		}
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "find";
			const path = typeof args.path === "string" ? args.path : "";
			return path ? `${pattern} in ${path}` : pattern;
		}
		case "ls":
			return typeof args.path === "string" && args.path ? args.path : ".";
		case "bash":
			return typeof args.command === "string" ? args.command : "bash";
		case "edit":
		case "write":
			return typeof args.path === "string" ? args.path : toolName;
		default:
			return toolName;
	}
}

export function createDetailToolRenderers(cwd: string) {
	const members = new Map<string, ToolMember>();
	let order: string[] = [];

	const memberFor = (toolCallId: string, toolName: string, args: Record<string, unknown>, group: string) => {
		let member = members.get(toolCallId);
		if (!member) {
			member = { toolCallId, toolName, args, group, status: "pending" };
			members.set(toolCallId, member);
		}
		member.toolName = toolName;
		member.args = args;
		member.group = group;
		return member;
	};

	const streak = (member: ToolMember): ToolMember[] => {
		const index = order.indexOf(member.toolCallId);
		if (index < 0 || !EXPLORATION_TOOLS.has(member.toolName) || member.status !== "ok") return [member];
		const matches = (item: ToolMember | undefined) =>
			item?.group === member.group && item.toolName === member.toolName && item.status === "ok";
		let start = index;
		while (start > 0 && matches(members.get(order[start - 1]))) start--;
		let end = index;
		while (end + 1 < order.length && matches(members.get(order[end + 1]))) end++;
		return order.slice(start, end + 1).flatMap((toolCallId) => {
			const item = members.get(toolCallId);
			return item ? [item] : [];
		});
	};

	const renderCall = (toolName: string, group: string) => (args: Record<string, unknown>, theme: any, context: any) => {
		const member = memberFor(context.toolCallId, toolName, args, group);
		const membersInStreak = streak(member);
		const allSucceeded = membersInStreak.length > 1 && membersInStreak.every((item) => item.status === "ok");
		if (allSucceeded && membersInStreak.at(-1)?.toolCallId !== member.toolCallId) return new Container();
		if (allSucceeded) {
			return new Text(
				theme.fg("success", "✓") + " " + theme.fg("dim", `${member.toolName} ×${membersInStreak.length} `) + theme.fg("accent", shorten(target(member.toolName, member.args))),
				1,
				0,
			);
		}
		const symbol = member.status === "error" ? theme.fg("error", "✗") : member.status === "ok" ? theme.fg("success", "✓") : theme.fg("dim", "·");
		const error = member.status === "error" && member.error ? ` ${theme.fg("error", member.error)}` : "";
		return new Text(`${symbol} ${theme.fg("dim", `${toolName} `)}${theme.fg("accent", shorten(target(toolName, args)))}${error}`, 1, 0);
	};

	const renderResult = (result: { content?: Array<{ type: string; text?: string }> }, options: { isPartial: boolean }, _theme: unknown, context: any) => {
		const member = members.get(context.toolCallId);
		if (member) {
			member.status = options.isPartial ? "pending" : context.isError ? "error" : "ok";
			member.error = context.isError ? firstError(result) : undefined;
		}
		return new Container();
	};

	const definition = (toolName: string, group: string): ToolDefinition<any, any> | undefined => {
		let original: ToolDefinition<any, any>;
		switch (toolName) {
			case "read":
				original = createReadToolDefinition(cwd);
				break;
			case "grep":
				original = createGrepToolDefinition(cwd);
				break;
			case "find":
				original = createFindToolDefinition(cwd);
				break;
			case "ls":
				original = createLsToolDefinition(cwd);
				break;
			case "bash":
				original = createBashToolDefinition(cwd);
				break;
			case "edit":
				original = createEditToolDefinition(cwd);
				break;
			case "write":
				original = createWriteToolDefinition(cwd);
				break;
			default:
				return undefined;
		}
		return { ...original, renderShell: "self", renderCall: renderCall(toolName, group), renderResult };
	};

	return {
		definition,
		sync(entries: ToolEntry[]): boolean {
			let changed = order.length !== entries.length;
			for (const [index, entry] of entries.entries()) {
				const member = members.get(entry.toolCallId);
				if (order[index] !== entry.toolCallId || !member || member.toolName !== entry.toolName || member.args !== entry.args || member.group !== entry.group) changed = true;
			}
			order = entries.map((entry) => entry.toolCallId);
			const active = new Set(order);
			for (const entry of entries) memberFor(entry.toolCallId, entry.toolName, entry.args, entry.group);
			for (const toolCallId of members.keys()) {
				if (!active.has(toolCallId)) members.delete(toolCallId);
			}
			return changed;
		},
		reset(toolCallId: string) {
			members.delete(toolCallId);
		},
		clear() {
			members.clear();
			order = [];
		},
	};
}
