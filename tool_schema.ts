import { Type } from "typebox";
import type { AgentConfig } from "./agents.js";
import { DEFAULT_DELEGATION_MODE } from "./types.js";

const SPAWN_MODE_DESCRIPTION =
  "'spawn' (default): child receives only the provided task prompt. Best for isolated, reproducible tasks with lower token/cost and less context leakage.";
const FORK_MODE_DESCRIPTION =
  "'fork': child receives a forked snapshot of current session context plus the task prompt. Best for follow-up tasks that rely on prior context; usually higher token/cost and may include sensitive context.";
const SINGLE_MODE_EXAMPLE =
  '{ "agent": "agent-name", "task": "Detailed task...", "mode": "spawn" }';
const PARALLEL_MODE_EXAMPLE =
  '{ "tasks": [{ "agent": "agent-name", "task": "..." }, { "agent": "other-agent", "task": "..." }], "mode": "fork" }';
const RESUME_MODE_EXAMPLE =
  '{ "resume": "completed-run-id", "task": "Follow-up task..." }';

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;

const TaskItem = Type.Object({
  agent: Type.String({
    description: "Name of an available agent (must match exactly)",
  }),
  task: Type.String({
    description:
      "Task description for this delegated run. In spawn mode include all required context; in fork mode the subagent also sees your current session context.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for this agent's process" }),
  ),
}, { additionalProperties: false });

const SingleParams = Type.Object({
  agent: Type.String({
    description: "Agent name for single mode. Must match an available agent name exactly.",
  }),
  task: Type.String({
    description:
      "Task description for single mode. In spawn mode it must be self-contained; in fork mode the subagent also receives your current session context.",
  }),
  mode: Type.Optional(
    Type.String({
      description:
        "Context mode for delegated runs. 'spawn' (default) sends only the task prompt (best for isolated, reproducible runs with lower token/cost and less context leakage). 'fork' adds a snapshot of current session context plus task prompt (best for follow-up work, but usually higher token/cost and may include sensitive context).",
      default: DEFAULT_DELEGATION_MODE,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent process (single mode only)",
    }),
  ),
}, { additionalProperties: false });

const ParallelParams = Type.Object({
  tasks: Type.Array(TaskItem, {
    minItems: 1,
    description:
      "For parallel mode: array of {agent, task} objects. Do NOT set agent/task when using this.",
  }),
  mode: Type.Optional(
    Type.String({
      description:
        "Context mode for delegated runs. 'spawn' (default) sends only the task prompt (best for isolated, reproducible runs with lower token/cost and less context leakage). 'fork' adds a snapshot of current session context plus task prompt (best for follow-up work, but usually higher token/cost and may include sensitive context).",
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
  "IMPORTANT: Use exactly ONE invocation shape:",
  "  Single mode:   set `agent` and `task` (both required together).",
  "  Parallel mode: set `tasks` array (do NOT also set `agent`/`task`).",
  "  Resume mode:  set `resume` and `task` (do NOT set agent/tasks/mode/cwd).",
  "",
  "Optional context mode applies only to new single or parallel runs:",
  `- ${SPAWN_MODE_DESCRIPTION}`,
  `- ${FORK_MODE_DESCRIPTION}`,
  "",
  `Example single:   ${SINGLE_MODE_EXAMPLE}`,
  `Example parallel: ${PARALLEL_MODE_EXAMPLE}`,
  `Example resume:   ${RESUME_MODE_EXAMPLE}`,
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
