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
  status: ToolStatus;
  error?: string;
};

const QUIET_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "find",
  "ls",
]);
const MAX_TEXT = 80;

export function isDetailQuietTool(toolName: string): boolean {
  return QUIET_TOOLS.has(toolName);
}

function shorten(text: string): string {
  const singleLine = text.replace(/\s*[\r\n]+\s*/g, " ");
  return singleLine.length > MAX_TEXT
    ? `${singleLine.slice(0, MAX_TEXT - 1)}…`
    : singleLine;
}

function firstError(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  const text =
    result.content?.find((content) => content.type === "text")?.text ?? "";
  return shorten(text.split("\n", 1)[0]?.trim() || "error");
}

function target(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read": {
      const path = args.file_path ?? args.path;
      return typeof path === "string" ? path : "read";
    }
    case "grep":
    case "find": {
      const pattern =
        typeof args.pattern === "string" ? args.pattern : toolName;
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

function detail(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": {
      const command =
        typeof args.command === "string" ? args.command.split("\n", 1)[0] : "";
      return command ? `$ ${command}` : "";
    }
    case "read": {
      const path = args.file_path ?? args.path;
      return typeof path === "string" ? path : "";
    }
    case "edit":
    case "write":
      return typeof args.path === "string" ? args.path : "";
    case "grep":
    case "find":
      return typeof args.pattern === "string" ? args.pattern : "";
    case "ls":
      return typeof args.path === "string" && args.path ? args.path : ".";
    default:
      return "";
  }
}

export function createDetailToolRenderers(cwd: string) {
  const members = new Map<string, ToolMember>();

  const memberFor = (toolCallId: string) => {
    let member = members.get(toolCallId);
    if (!member) {
      member = { status: "pending" };
      members.set(toolCallId, member);
    }
    return member;
  };

  const renderCall =
    (toolName: string) =>
    (args: Record<string, unknown>, theme: any, context: any) => {
      const member = memberFor(context.toolCallId);
      const intent = typeof args.intent === "string" ? args.intent.trim() : "";
      const primary = intent || target(toolName, args);
      const d = intent ? detail(toolName, args) : "";
      const symbol =
        member.status === "error"
          ? theme.fg("error", "✗")
          : member.status === "ok"
            ? theme.fg("success", "✓")
            : theme.fg("dim", "·");
      let line = `${symbol} ${theme.fg("dim", toolName)} ${theme.fg("accent", shorten(primary))}`;
      if (d && d !== primary) line += ` ${theme.fg("dim", shorten(d))}`;
      if (member.status === "error" && member.error)
        line += `\n  ${theme.fg("error", member.error)}`;
      return new Text(line, 1, 0);
    };

  const renderResult = (
    result: { content?: Array<{ type: string; text?: string }> },
    options: { isPartial: boolean },
    _theme: unknown,
    context: any,
  ) => {
    const member = members.get(context.toolCallId);
    if (member) {
      member.status = options.isPartial
        ? "pending"
        : context.isError
          ? "error"
          : "ok";
      member.error = context.isError ? firstError(result) : undefined;
    }
    return new Container();
  };

  const definition = (
    toolName: string,
  ): ToolDefinition<any, any> | undefined => {
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
    return {
      ...original,
      renderShell: "self",
      renderCall: renderCall(toolName),
      renderResult,
    };
  };

  return {
    definition,
    sync(toolCallIds: string[]) {
      const active = new Set(toolCallIds);
      for (const toolCallId of members.keys()) {
        if (!active.has(toolCallId)) members.delete(toolCallId);
      }
    },
    reset(toolCallId: string) {
      members.delete(toolCallId);
    },
    clear() {
      members.clear();
    },
  };
}
