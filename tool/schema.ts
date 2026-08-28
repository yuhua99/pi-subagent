import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentConfig } from "../agents.ts";

export const MAX_REQUESTS = 5;

const AGENT_NAME_DESCRIPTION = "Agent name from the Available Subagents list.";

const RunRequest = Type.Object(
  {
    action: StringEnum(["run"] as const),
    agent: Type.String({ description: AGENT_NAME_DESCRIPTION }),
    task: Type.String({
      description: "A brief this subagent can execute with zero outside context.",
    }),
    cwd: Type.Optional(Type.String({ description: "Working directory for this agent's process." })),
  },
  { additionalProperties: false },
);

const ResumeRequest = Type.Object(
  {
    action: StringEnum(["resume"] as const),
    resume_id: Type.String({ description: "Id from a completed run's result message." }),
    task: Type.String({ description: "A follow-up continuing the prior run." }),
  },
  { additionalProperties: false },
);

export const SubagentParams = Type.Object(
  {
    requests: Type.Array(Type.Union([RunRequest, ResumeRequest]), {
      minItems: 1,
      maxItems: MAX_REQUESTS,
    }),
  },
  { additionalProperties: false },
);

export const SubagentCtlParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("kill"),
      Type.Literal("steer"),
      Type.Literal("answer"),
      Type.Literal("inspect"),
    ]),
    id: Type.Optional(
      Type.String({
        description:
          "Required for kill, steer, answer, and inspect. Run id from list output or a result message.",
      }),
    ),
    text: Type.Optional(
      Type.String({
        description: "Required for steer and answer. Message to deliver to the subagent.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type SubagentRequest =
  | { action: "run"; agent: string; task: string; cwd?: string }
  | { action: "resume"; resume_id: string; task: string };

export interface SubagentInvocation {
  requests: SubagentRequest[];
}

export type SubagentCtlInvocation =
  | { action: "list" }
  | { action: "kill"; id: string }
  | { action: "steer"; id: string; text: string }
  | { action: "answer"; id: string; text: string }
  | { action: "inspect"; id: string };

type ParseResult<T> = T | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(params: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(params).every((key) => allowed.includes(key));
}

function rejectedField(
  action: string,
  params: Record<string, unknown>,
  allowed: string[],
): string | undefined {
  const field = Object.keys(params).find(
    (key) => !allowed.includes(key) && params[key] !== undefined && params[key] !== "",
  );
  if (field === undefined) return undefined;
  const fields = allowed.filter((key) => key !== "action").map((key) => `"${key}"`);
  return fields.length === 0
    ? `action "${action}" takes no parameters`
    : `action "${action}" takes only ${fields.join(" and ")}`;
}

/** Validate a subagent delegation request batch. */
export function parseSubagentInvocation(params: unknown): ParseResult<SubagentInvocation> {
  if (!isRecord(params) || !hasOnlyFields(params, ["requests"])) {
    return { error: 'subagent requires only "requests"' };
  }
  if (!Array.isArray(params.requests) || params.requests.length === 0) {
    return { error: 'subagent requires a non-empty "requests" array' };
  }
  if (params.requests.length > MAX_REQUESTS) {
    return { error: `subagent accepts at most ${MAX_REQUESTS} requests` };
  }

  const requests: SubagentRequest[] = [];
  for (const request of params.requests) {
    if (!isRecord(request)) return { error: "each request must be an object" };

    if (request.action === "run") {
      if (!hasOnlyFields(request, ["action", "agent", "task", "cwd"])) {
        return { error: "run request has unsupported fields" };
      }
      if (
        typeof request.agent !== "string" ||
        typeof request.task !== "string" ||
        (request.cwd !== undefined && typeof request.cwd !== "string")
      ) {
        return { error: 'run request requires "agent" and "task" strings' };
      }
      requests.push({
        action: "run",
        agent: request.agent,
        task: request.task,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      });
      continue;
    }

    if (request.action === "resume") {
      if (!hasOnlyFields(request, ["action", "resume_id", "task"])) {
        return { error: "resume request has unsupported fields" };
      }
      if (typeof request.resume_id !== "string" || typeof request.task !== "string") {
        return { error: 'resume request requires "resume_id" and "task" strings' };
      }
      requests.push({ action: "resume", resume_id: request.resume_id, task: request.task });
      continue;
    }

    return { error: 'request action must be "run" or "resume"' };
  }

  return { requests };
}

/** Validate a subagent control action. */
export function parseSubagentCtlInvocation(params: unknown): ParseResult<SubagentCtlInvocation> {
  if (!isRecord(params)) return { error: "subagent_ctl requires an action" };
  const action = params.action;
  if (
    action !== "list" &&
    action !== "kill" &&
    action !== "steer" &&
    action !== "answer" &&
    action !== "inspect"
  ) {
    return { error: 'action must be "list", "kill", "steer", "answer", or "inspect"' };
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
    return { error: `action "${action}" requires a non-empty "id"` };
  }
  if (typeof params.text !== "string") return { error: `action "${action}" requires "text"` };
  const rejected = rejectedField(action, params, ["action", "id", "text"]);
  return rejected ? { error: rejected } : { action, id: params.id, text: params.text };
}

export const TOOL_DESCRIPTION = [
  "Delegate work to specialized subagents.",
  "",
  "Pass requests containing run entries with agent and task, or resume entries with resume_id and task.",
].join("\n");

export const CTL_TOOL_DESCRIPTION = [
  "Intervene in running subagents.",
  'Set action to "list", "kill" with id, "steer" with id and text, "answer" with id and text, or "inspect" with id.',
].join("\n");

export function formatSubagentSystemPrompt(agents: AgentConfig[]): string {
  const agentList = agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");
  return `## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

Delegation is single-level: subagents cannot spawn their own subagents.
`;
}
