import { Type } from "typebox";
import type { AgentConfig } from "./agents.ts";
import { DEFAULT_DELEGATION_MODE } from "./types.ts";

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

const SingleParams = Type.Object({
  agent: Type.String({
    description: "Must match an available agent name exactly.",
  }),
  task: Type.String({
    description: "In spawn mode it must be self-contained.",
  }),
  mode: Type.Optional(
    Type.String({
      description: MODE_PARAM_DESCRIPTION,
      default: DEFAULT_DELEGATION_MODE,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent process.",
    }),
  ),
}, { additionalProperties: false });

const ParallelParams = Type.Object({
  tasks: Type.Union([Type.Array(TaskItem, { minItems: 1 }), Type.String()], {
    description:
      "Parallel runs as a JSON array, not a JSON-encoded string. Do not set agent/task with this.",
  }),
  mode: Type.Optional(
    Type.String({
      description: MODE_PARAM_DESCRIPTION,
      default: DEFAULT_DELEGATION_MODE,
    }),
  ),
}, { additionalProperties: false });

const ResumeParams = Type.Object({
  resume: Type.String({
    description: "Completed subagent run id from this parent Pi session.",
  }),
  task: Type.String({ description: "Follow-up task appended to the completed run's session." }),
}, { additionalProperties: false });

export const SubagentParams = Type.Union([SingleParams, ParallelParams, ResumeParams]);

export const SubagentListParams = Type.Object({});

export const SubagentKillParams = Type.Object({
  id: Type.String({
    description: "Registry id of the running subagent to kill (as shown by subagent_list).",
  }),
});

export const LIST_TOOL_DESCRIPTION = [
  "List subagents currently running as direct children of this session.",
  "Returns each subagent's id (used by subagent_kill), agent name, elapsed time, and task preview.",
].join("\n");

export const KILL_TOOL_DESCRIPTION = [
  "Kill a running subagent by id (see subagent_list for ids).",
  "Sends SIGTERM with a SIGKILL fallback. Killing one child of a parallel batch does not affect its siblings.",
].join("\n");

export const TOOL_DESCRIPTION = [
  "Delegate work to specialized subagents running in isolated pi processes.",
  "",
  "Use exactly one invocation shape: {agent, task} | {tasks} | {resume, task}.",
].join("\n");

export function formatSubagentSystemPrompt(agents: AgentConfig[]): string {
  const agentList = agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");
  return `## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

Follow the subagent tool description for invocation shapes and context modes.
Delegation is single-level: subagents cannot spawn their own subagents.
`;
}
