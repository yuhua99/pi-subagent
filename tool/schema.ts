import { Type } from "typebox";
import type { AgentConfig } from "../agents.ts";
import { parseTasksParam, type TaskSpec } from "../types.ts";

export const MAX_PARALLEL_TASKS = 5;

const AGENT_NAME_DESCRIPTION = "Agent name from the Available Subagents list.";

const TaskItem = Type.Object(
  {
    agent: Type.String({
      description: AGENT_NAME_DESCRIPTION,
    }),
    task: Type.String({
      description: "A brief this subagent can execute with zero outside context.",
    }),
    cwd: Type.Optional(Type.String({ description: "Working directory for this agent's process." })),
  },
  { additionalProperties: false },
);

const DelegationAction = Type.Union([Type.Literal("run"), Type.Literal("resume")]);

export const SubagentParams = Type.Object(
  {
    action: DelegationAction,
    task: Type.Optional(
      Type.String({
        description: "A follow-up continuing the prior run.",
      }),
    ),
    tasks: Type.Optional(
      Type.Union(
        [Type.Array(TaskItem, { minItems: 1, maxItems: MAX_PARALLEL_TASKS }), Type.String()],
        {
          description: "Tasks to run concurrently.",
        },
      ),
    ),
    resume_id: Type.Optional(
      Type.String({
        description: "The id from a completed run's result message.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const SubagentCtlParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("kill"),
      Type.Literal("steer"),
      Type.Literal("inspect"),
    ]),
    id: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Run id from list output or a result message (e.g. c3e1).",
      }),
    ),
    text: Type.Optional(
      Type.String({
        description: "Message to deliver to the subagent.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type SubagentInvocation =
  | { action: "run"; tasks: TaskSpec[] }
  | { action: "resume"; resume_id: string; task: string };

export type SubagentCtlInvocation =
  | { action: "list" }
  | { action: "kill"; id: string }
  | { action: "steer"; id: string; text: string }
  | { action: "inspect"; id: string };

type ParseResult<T> = T | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectedField(
  action: string,
  params: Record<string, unknown>,
  allowed: string[],
): string | undefined {
  const field = Object.keys(params).find((key) => !allowed.includes(key));
  return field === undefined ? undefined : `action "${action}" does not accept "${field}"`;
}

/** Validate and normalize a subagent delegation action. */
export function parseSubagentInvocation(params: unknown): ParseResult<SubagentInvocation> {
  if (!isRecord(params)) return { error: "subagent requires an action" };
  const action = params.action;
  if (action !== "run" && action !== "resume") {
    return { error: 'action must be "run" or "resume"' };
  }

  if (action === "run") {
    if (params.tasks === undefined) return { error: 'action "run" requires "tasks"' };
    const rejected = rejectedField(action, params, ["action", "tasks"]);
    if (rejected) return { error: rejected };
    const parsedTasks = parseTasksParam(params.tasks);
    if (!parsedTasks) return { error: 'action "run" requires "tasks"' };
    if ("error" in parsedTasks) return parsedTasks;
    if (parsedTasks.tasks.length > MAX_PARALLEL_TASKS) {
      return { error: `action "run" accepts at most ${MAX_PARALLEL_TASKS} tasks` };
    }
    return { action, tasks: parsedTasks.tasks };
  }

  if (typeof params.resume_id !== "string" || typeof params.task !== "string") {
    return { error: 'action "resume" requires "resume_id" and "task"' };
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
    return { error: 'action must be "list", "kill", "steer", or "inspect"' };
  }
  if (action === "list") {
    const rejected = rejectedField(action, params, ["action"]);
    return rejected ? { error: rejected } : { action };
  }
  if (action === "kill") {
    if (typeof params.id !== "string" || params.id.length === 0) {
      return { error: 'action "kill" requires a non-empty "id"' };
    }
    const rejected = rejectedField(action, params, ["action", "id"]);
    return rejected ? { error: rejected } : { action, id: params.id };
  }
  if (action === "inspect") {
    if (typeof params.id !== "string" || params.id.length === 0) {
      return { error: 'action "inspect" requires a non-empty "id"' };
    }
    const rejected = rejectedField(action, params, ["action", "id"]);
    return rejected ? { error: rejected } : { action, id: params.id };
  }
  if (typeof params.id !== "string" || params.id.length === 0) {
    return { error: 'action "steer" requires a non-empty "id"' };
  }
  if (typeof params.text !== "string") return { error: 'action "steer" requires "text"' };
  const rejected = rejectedField(action, params, ["action", "id", "text"]);
  return rejected ? { error: rejected } : { action, id: params.id, text: params.text };
}

export const TOOL_DESCRIPTION = [
  "Delegate work to specialized subagents.",
  "",
  'Set action to "run" with tasks, or "resume" with resume_id and task.',
].join("\n");

export const CTL_TOOL_DESCRIPTION = [
  "Intervene in running subagents.",
  'Set action to "list", "kill" with id, "steer" with id and text, or "inspect" with id.',
].join("\n");

export function formatSubagentSystemPrompt(agents: AgentConfig[]): string {
  const agentList = agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");
  return `## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

Delegation is single-level: subagents cannot spawn their own subagents.
`;
}
