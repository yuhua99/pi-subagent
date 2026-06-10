import { Type } from "typebox";
import { DEFAULT_DELEGATION_MODE } from "./types.js";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PARALLEL_HEARTBEAT_MS = 1000;

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
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run as a background job (single mode only). The tool returns immediately with a job id; the result is delivered to you automatically when the subagent finishes. Use subagent_list/subagent_kill to manage it. Default: false (blocking).",
      default: false,
    }),
  ),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Whether to prompt the user before running project-local agents. Default: true.",
      default: true,
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
  "Optional context mode switch:",
  "  mode: \"spawn\" (default) -> child gets only your task prompt.",
  "                             Best for isolated/reproducible work; lower token/cost and less context leakage.",
  "  mode: \"fork\"            -> child gets current session context + your task prompt.",
  "                             Best for follow-up work that depends on prior context; higher token/cost and may include sensitive context.",
  "",
  "Optional background mode (single mode only):",
  "  background: true -> returns immediately with a job id; the result is delivered",
  "                      automatically when the subagent finishes. Manage with",
  "                      subagent_list / subagent_kill. Start multiple background jobs",
  "                      by calling this tool repeatedly.",
  "",
  'Example single:   { agent: "writer", task: "Rewrite README.md", mode: "spawn" }',
  'Example parallel: { tasks: [{ agent: "writer", task: "..." }, { agent: "tester", task: "..." }], mode: "fork" }',
].join("\n");
