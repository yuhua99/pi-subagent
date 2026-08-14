import { Type } from "typebox";
import type { AgentConfig } from "./agents.ts";
import { DEFAULT_DELEGATION_MODE, parseTasksParam, type DelegationMode, type TaskSpec } from "./types.ts";

const MODE_PARAM_DESCRIPTION =
  "Context mode for new runs. 'spawn' (default): child gets only the task prompt; isolated and cheaper. 'fork': child inherits a snapshot of this session's context; costlier and may leak sensitive context.";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;

const TaskItem = Type.Object({
  agent: Type.String({
    description: "Must match an available agent name exactly.",
  }),
  task: Type.String({
    description: "In spawn mode it must be self-contained.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for this agent's process." }),
  ),
}, { additionalProperties: false });

const DelegationAction = Type.Union([
  Type.Literal("run"),
  Type.Literal("run_parallel"),
  Type.Literal("resume"),
]);

const DelegationModeParam = Type.Union([
  Type.Literal("spawn"),
  Type.Literal("fork"),
], {
  description: MODE_PARAM_DESCRIPTION,
  default: DEFAULT_DELEGATION_MODE,
});

export const SubagentParams = Type.Object({
  action: DelegationAction,
  agent: Type.Optional(Type.String({
    description: "Must match an available agent name exactly.",
  })),
  task: Type.Optional(Type.String({
    description: "In spawn mode it must be self-contained.",
  })),
  tasks: Type.Optional(Type.Union([Type.Array(TaskItem, { minItems: 1 }), Type.String()], {
    description: "Parallel runs as an array of task objects or a JSON-encoded array.",
  })),
  resume_id: Type.Optional(Type.String({
    description: "Completed subagent run id from this parent Pi session.",
  })),
  mode: Type.Optional(DelegationModeParam),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the agent process.",
  })),
}, { additionalProperties: false });

export const SubagentCtlParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("kill"),
    Type.Literal("steer"),
    Type.Literal("inspect"),
  ]),
  id: Type.Optional(Type.String({
    description: "Registry id of the running subagent.",
  })),
  run_id: Type.Optional(Type.String({
    minLength: 1,
    description: "Registry id of the subagent run to inspect.",
  })),
  text: Type.Optional(Type.String({
    description: "Message to deliver to the subagent.",
  })),
}, { additionalProperties: false });

export type SubagentInvocation =
  | { action: "run"; agent: string; task: string; mode?: DelegationMode; cwd?: string }
  | { action: "run_parallel"; tasks: TaskSpec[]; mode?: DelegationMode }
  | { action: "resume"; resume_id: string; task: string };

export type SubagentCtlInvocation =
  | { action: "list" }
  | { action: "kill"; id: string }
  | { action: "steer"; id: string; text: string }
  | { action: "inspect"; run_id: string };

type ParseResult<T> = T | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectedField(action: string, params: Record<string, unknown>, allowed: string[]): string | undefined {
  const field = Object.keys(params).find((key) => !allowed.includes(key));
  return field === undefined ? undefined : `action "${action}" does not accept "${field}"`;
}

function parseMode(action: string, mode: unknown): DelegationMode | { error: string } | undefined {
  if (mode === undefined) return undefined;
  if (mode === "spawn" || mode === "fork") return mode;
  return { error: `action "${action}" requires "mode" to be "spawn" or "fork"` };
}

/** Validate and normalize a subagent delegation action. */
export function parseSubagentInvocation(params: unknown): ParseResult<SubagentInvocation> {
  if (!isRecord(params)) return { error: "subagent requires an action" };
  const action = params.action;
  if (action !== "run" && action !== "run_parallel" && action !== "resume") {
    return { error: "action must be \"run\", \"run_parallel\", or \"resume\"" };
  }

  if (action === "run") {
    if (typeof params.agent !== "string" || typeof params.task !== "string") {
      return { error: "action \"run\" requires \"agent\" and \"task\"" };
    }
    const rejected = rejectedField(action, params, ["action", "agent", "task", "mode", "cwd"]);
    if (rejected) return { error: rejected };
    if (params.cwd !== undefined && typeof params.cwd !== "string") {
      return { error: "action \"run\" requires \"cwd\" to be a string" };
    }
    const mode = parseMode(action, params.mode);
    if (mode && typeof mode === "object") return mode;
    return { action, agent: params.agent, task: params.task, ...(mode ? { mode } : {}), ...(params.cwd !== undefined ? { cwd: params.cwd } : {}) };
  }

  if (action === "run_parallel") {
    if (params.tasks === undefined) return { error: "action \"run_parallel\" requires \"tasks\"" };
    const rejected = rejectedField(action, params, ["action", "tasks", "mode"]);
    if (rejected) return { error: rejected };
    const parsedTasks = parseTasksParam(params.tasks);
    if (!parsedTasks) return { error: "action \"run_parallel\" requires \"tasks\"" };
    if ("error" in parsedTasks) return parsedTasks;
    const mode = parseMode(action, params.mode);
    if (mode && typeof mode === "object") return mode;
    return { action, tasks: parsedTasks.tasks, ...(mode ? { mode } : {}) };
  }

  if (typeof params.resume_id !== "string" || typeof params.task !== "string") {
    return { error: "action \"resume\" requires \"resume_id\" and \"task\"" };
  }
  const rejected = rejectedField(action, params, ["action", "resume_id", "task"]);
  if (rejected) return { error: rejected };
  return { action, resume_id: params.resume_id, task: params.task };
}

/** Validate a subagent control action. */
export function parseSubagentCtlInvocation(params: unknown): ParseResult<SubagentCtlInvocation> {
  if (!isRecord(params)) return { error: "subagent_ctl requires an action" };
  const action = params.action;
  if (action !== "list" && action !== "kill" && action !== "steer" && action !== "inspect") {
    return { error: "action must be \"list\", \"kill\", \"steer\", or \"inspect\"" };
  }
  if (action === "list") {
    const rejected = rejectedField(action, params, ["action"]);
    return rejected ? { error: rejected } : { action };
  }
  if (action === "kill") {
    if (typeof params.id !== "string") return { error: "action \"kill\" requires \"id\"" };
    const rejected = rejectedField(action, params, ["action", "id"]);
    return rejected ? { error: rejected } : { action, id: params.id };
  }
  if (action === "inspect") {
    if (typeof params.run_id !== "string" || params.run_id.length === 0) {
      return { error: "action \"inspect\" requires a non-empty \"run_id\"" };
    }
    const rejected = rejectedField(action, params, ["action", "run_id"]);
    return rejected ? { error: rejected } : { action, run_id: params.run_id };
  }
  if (typeof params.id !== "string" || typeof params.text !== "string") {
    return { error: "action \"steer\" requires \"id\" and \"text\"" };
  }
  const rejected = rejectedField(action, params, ["action", "id", "text"]);
  return rejected ? { error: rejected } : { action, id: params.id, text: params.text };
}

export const TOOL_DESCRIPTION = [
  "Delegate work to specialized subagents.",
  "",
  "Set action to \"run\" with agent and task, \"run_parallel\" with tasks, or \"resume\" with resume_id and task.",
].join("\n");

export const CTL_TOOL_DESCRIPTION = [
  "Manage direct subagents in this session.",
  "Set action to \"list\", \"kill\" with id, \"steer\" with id and text, or \"inspect\" with run_id.",
].join("\n");

export function formatSubagentSystemPrompt(agents: AgentConfig[]): string {
  const agentList = agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");
  return `## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

Use \`subagent\` with action \`run\`, \`run_parallel\`, or \`resume\`. Use \`subagent_ctl\` with action \`list\`, \`kill\`, \`steer\`, or \`inspect\` to manage runs.
Delegation is single-level: subagents cannot spawn their own subagents.
`;
}
