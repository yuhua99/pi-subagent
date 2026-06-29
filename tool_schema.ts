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
});

export const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: "Agent name for single mode. Must match an available agent name exactly.",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "Task description for single mode. In spawn mode it must be self-contained; in fork mode the subagent also receives your current session context.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description:
        "For parallel mode: array of {agent, task} objects. Each task runs in an isolated process concurrently. Do NOT set agent/task when using this.",
    }),
  ),
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
});

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
  "",
  "Optional context mode:",
  `- ${SPAWN_MODE_DESCRIPTION}`,
  `- ${FORK_MODE_DESCRIPTION}`,
  "",
  `Example single:   ${SINGLE_MODE_EXAMPLE}`,
  `Example parallel: ${PARALLEL_MODE_EXAMPLE}`,
].join("\n");

export function formatSubagentSystemPrompt(agents: AgentConfig[]): string {
  const agentList = agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");
  return `## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

### How to call the subagent tool

Each subagent runs in an **isolated process**.

Context behavior is controlled by optional 'mode':
- ${SPAWN_MODE_DESCRIPTION}
- ${FORK_MODE_DESCRIPTION}

**Single mode** \u2014 delegate one task:
\`\`\`json
${SINGLE_MODE_EXAMPLE}
\`\`\`

**Parallel mode** \u2014 run multiple tasks concurrently (do NOT also set agent/task):
\`\`\`json
${PARALLEL_MODE_EXAMPLE}
\`\`\`

Use single mode for one task, parallel mode when tasks are independent and can run simultaneously.

Delegation is single-level: subagents cannot spawn their own subagents.
`;
}
