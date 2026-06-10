/**
 * Pi Subagent Extension
 *
 * Delegates tasks to specialized subagents, each running as an isolated `pi`
 * process.
 *
 * Supports two invocation shapes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *
 * And two context modes:
 *   - spawn (default): child gets only the task prompt.
 *   - fork: child gets a forked snapshot of current session context + task prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, discoverAgentsWithStarter } from "./agents.js";
import {
  buildForkSessionSnapshotJsonl,
  confirmProjectAgentsIfNeeded,
  formatAgentNames,
  getCycleViolations,
  getRequestedProjectAgents,
  makeDetailsFactory,
  parseDelegationMode,
  resolveDelegationDepthConfig,
} from "./delegation.js";
import { formatSubagentList, renderCall, renderResult } from "./render.js";
import { getSubagent, listSubagents } from "./registry.js";
import { getResultSummaryText } from "./runner-events.js";
import { mapConcurrent, runAgent } from "./runner.js";
import { KILL_TOOL_DESCRIPTION, LIST_TOOL_DESCRIPTION, MAX_CONCURRENCY, MAX_PARALLEL_TASKS, PARALLEL_HEARTBEAT_MS, SubagentKillParams, SubagentListParams, SubagentParams, TOOL_DESCRIPTION } from "./tool_schema.js";
import { DEFAULT_DELEGATION_MODE, emptyUsage, isResultError, isResultSuccess, type DelegationMode, type SingleResult } from "./types.js";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 3).",
    type: "string",
  });
  pi.registerFlag("subagent-prevent-cycles", {
    description: "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });

  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    resolveDelegationDepthConfig(pi);

  let discoveredAgents: AgentConfig[] = [];

  pi.on("session_shutdown", async () => {
    for (const entry of listSubagents()) entry.kill();
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!canDelegate) return;

    const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
    discoveredAgents = starterDiscovery.discovery.agents;

    if (ctx.hasUI) {
      if (starterDiscovery.createdAgentPath) {
        ctx.ui.notify(
          `Created starter subagent "explorer" at:\n${starterDiscovery.createdAgentPath}\n\nEdit this file or add more agents in the same directory to customize delegation.`,
          "info",
        );
      } else if (starterDiscovery.error && discoveredAgents.length === 0) {
        ctx.ui.notify(`No subagents found. ${starterDiscovery.error}`, "info");
      } else if (discoveredAgents.length > 0) {
        const list = discoveredAgents.map((a) => `  - ${a.name} (${a.source})`).join("\n");
        ctx.ui.notify(`Found ${discoveredAgents.length} subagent(s):\n${list}`, "info");
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    if (discoveredAgents.length === 0) return;

    const agentList = discoveredAgents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

### How to call the subagent tool

Each subagent runs in an **isolated process**.

Context behavior is controlled by optional 'mode':
- 'spawn' (default): child receives only the provided task prompt. Best for isolated, reproducible tasks with lower token/cost and less context leakage.
- 'fork': child receives a forked snapshot of current session context plus the task prompt. Best for follow-up tasks that rely on prior context; usually higher token/cost and may include sensitive context.

**Single mode** — delegate one task:
\`\`\`json
{ "agent": "agent-name", "task": "Detailed task...", "mode": "spawn" }
\`\`\`

**Parallel mode** — run multiple tasks concurrently (do NOT also set agent/task):
\`\`\`json
{ "tasks": [{ "agent": "agent-name", "task": "..." }, { "agent": "other-agent", "task": "..." }], "mode": "fork" }
\`\`\`

Use single mode for one task, parallel mode when tasks are independent and can run simultaneously.

### Runtime delegation guards

- Max depth: current depth ${currentDepth}, max depth ${maxDepth}
- Cycle prevention: ${preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${ancestorAgentStack.length > 0 ? ancestorAgentStack.join(" -> ") : "(root)"}
`,
    };
  });

  if (!canDelegate) return;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: TOOL_DESCRIPTION,
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
      const { agents, projectAgentsDir } = starterDiscovery.discovery;

      const delegationMode = parseDelegationMode(params.mode);
      if (!delegationMode) {
        const makeDetails = makeDetailsFactory(projectAgentsDir, DEFAULT_DELEGATION_MODE);
        return {
          content: [{ type: "text", text: `Invalid mode "${String(params.mode)}". Expected "spawn" or "fork".\nAvailable agents: ${formatAgentNames(agents)}` }],
          details: makeDetails("single")([]),
          isError: true,
        };
      }

      const makeDetails = makeDetailsFactory(projectAgentsDir, delegationMode);

      let forkSessionSnapshotJsonl: string | undefined;
      if (delegationMode === "fork") {
        forkSessionSnapshotJsonl = buildForkSessionSnapshotJsonl(ctx.sessionManager) ?? undefined;
        if (!forkSessionSnapshotJsonl) {
          return {
            content: [{ type: "text", text: 'Cannot use mode="fork": failed to snapshot current session context.' }],
            details: makeDetails("single")([]),
            isError: true,
          };
        }
      }

      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      if (Number(hasTasks) + Number(hasSingle) !== 1) {
        return {
          content: [{ type: "text", text: `Invalid parameters. Provide exactly one invocation shape.\nAvailable agents: ${formatAgentNames(agents)}` }],
          details: makeDetails("single")([]),
        };
      }

      const requested = new Set<string>();
      if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
      if (params.agent) requested.add(params.agent);

      if (preventCycles) {
        const cycleViolations = getCycleViolations(requested, ancestorAgentStack);
        if (cycleViolations.length > 0) {
          const stackText = ancestorAgentStack.length > 0 ? ancestorAgentStack.join(" -> ") : "(root)";
          return {
            content: [
              {
                type: "text",
                text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.\nCurrent stack: ${stackText}\n\nThis guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
              },
            ],
            details: makeDetails(hasTasks ? "parallel" : "single")([]),
            isError: true,
          };
        }
      }

      const requestedProjectAgents = getRequestedProjectAgents(agents, requested);
      const shouldConfirmProjectAgents = params.confirmProjectAgents ?? true;
      if (requestedProjectAgents.length > 0 && shouldConfirmProjectAgents) {
        if (ctx.hasUI) {
          const approved = await confirmProjectAgentsIfNeeded(requestedProjectAgents, projectAgentsDir, ctx);
          if (!approved) {
            return {
              content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
              details: makeDetails(hasTasks ? "parallel" : "single")([]),
            };
          }
        } else {
          const names = requestedProjectAgents.map((a) => a.name).join(", ");
          const dir = projectAgentsDir ?? "(unknown)";
          return {
            content: [
              {
                type: "text",
                text: `Blocked: project-local agent confirmation is required in non-UI mode.\nAgents: ${names}\nSource: ${dir}\n\nRe-run with confirmProjectAgents: false only if this repository is trusted.`,
              },
            ],
            details: makeDetails(hasTasks ? "parallel" : "single")([]),
            isError: true,
          };
        }
      }

      if (params.background) {
        if (hasTasks) {
          return {
            content: [
              {
                type: "text",
                text: "background: true supports single mode only. Call the tool multiple times to run several background jobs concurrently.",
              },
            ],
            details: makeDetails("parallel")([]),
            isError: true,
          };
        }
        return executeBackground(
          params.agent!,
          params.task!,
          params.cwd,
          delegationMode,
          forkSessionSnapshotJsonl,
          agents,
          ctx.cwd,
          makeDetails,
        );
      }

      if (params.tasks && params.tasks.length > 0) {
        return executeParallel(
          params.tasks,
          delegationMode,
          forkSessionSnapshotJsonl,
          agents,
          ctx.cwd,
          signal,
          onUpdate,
          makeDetails,
        );
      }

      return executeSingle(
        params.agent!,
        params.task!,
        params.cwd,
        delegationMode,
        forkSessionSnapshotJsonl,
        agents,
        ctx.cwd,
        signal,
        onUpdate,
        makeDetails,
      );
    },

    renderCall: (args, theme) => renderCall(args, theme),
    renderResult: (result, { expanded }, theme) => renderResult(result, expanded, theme),
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List subagents",
    description: LIST_TOOL_DESCRIPTION,
    parameters: SubagentListParams,

    async execute() {
      return {
        content: [{ type: "text" as const, text: formatSubagentList(listSubagents()) }],
      };
    },
  });

  pi.registerTool({
    name: "subagent_kill",
    label: "Kill subagent",
    description: KILL_TOOL_DESCRIPTION,
    parameters: SubagentKillParams,

    async execute(_toolCallId, params) {
      const entry = getSubagent(params.id);
      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No running subagent with id '${params.id}' (it may have already finished).`,
            },
          ],
        };
      }
      entry.kill();
      return {
        content: [{ type: "text" as const, text: `Killed subagent [${entry.id}] (${entry.agent}).` }],
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Mode implementations
  // ---------------------------------------------------------------------------

  async function executeSingle(
    agentName: string,
    task: string,
    cwd: string | undefined,
    delegationMode: DelegationMode,
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    const result = await runAgent({
      cwd: defaultCwd,
      agents,
      agentName,
      task,
      taskCwd: cwd,
      delegationMode,
      forkSessionSnapshotJsonl,
      parentDepth: currentDepth,
      parentAgentStack: ancestorAgentStack,
      maxDepth,
      preventCycles,
      signal,
      onUpdate,
      makeDetails: makeDetails("single"),
    });

    if (isResultError(result)) {
      return {
        content: [{ type: "text" as const, text: `Agent ${result.stopReason || "failed"}: ${getResultSummaryText(result)}` }],
        details: makeDetails("single")([result]),
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: getResultSummaryText(result) }],
      details: makeDetails("single")([result]),
    };
  }

  async function executeBackground(
    agentName: string,
    task: string,
    cwd: string | undefined,
    delegationMode: DelegationMode,
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    let onSpawn: (id: string) => void;
    const spawned = new Promise<string>((resolve) => {
      onSpawn = resolve;
    });

    const runPromise = runAgent({
      cwd: defaultCwd,
      agents,
      agentName,
      task,
      taskCwd: cwd,
      delegationMode,
      forkSessionSnapshotJsonl,
      parentDepth: currentDepth,
      parentAgentStack: ancestorAgentStack,
      maxDepth,
      preventCycles,
      onSpawn: (id) => onSpawn(id),
      makeDetails: makeDetails("single"),
    });

    const raced = await Promise.race([
      spawned.then((id) => ({ kind: "spawned" as const, id })),
      runPromise.then((r) => ({ kind: "done" as const, r })),
    ]);

    if (raced.kind === "done") {
      const r = raced.r;
      if (isResultError(r)) {
        return {
          content: [{ type: "text" as const, text: `Agent ${r.stopReason || "failed"}: ${getResultSummaryText(r)}` }],
          details: makeDetails("single")([r]),
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: getResultSummaryText(r) }],
        details: makeDetails("single")([r]),
      };
    }

    runPromise.then((result) => {
      const id = result.registryId ?? raced.id;
      const status = isResultError(result) ? (result.stopReason || "failed") : "completed";
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Background subagent [${id}] (${result.agent}) ${status}.\n\n${getResultSummaryText(result)}`,
          display: true,
          details: makeDetails("single")([result]),
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Started background subagent [${raced.id}] (${agentName}). It runs concurrently; the result will be delivered automatically when it finishes. Use subagent_list to check progress or subagent_kill to stop it.`,
        },
      ],
      details: makeDetails("single")([]),
    };
  }

  async function executeParallel(
    tasks: Array<{ agent: string; task: string; cwd?: string }>,
    delegationMode: DelegationMode,
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    if (tasks.length > MAX_PARALLEL_TASKS) {
      return {
        content: [{ type: "text" as const, text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
        details: makeDetails("parallel")([]),
      };
    }

    const allResults: SingleResult[] = tasks.map((t) => ({
      agent: t.agent,
      agentSource: "unknown" as const,
      task: t.task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
    }));

    const emitProgress = () => {
      if (!onUpdate) return;
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      onUpdate({
        content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
        details: makeDetails("parallel")([...allResults]),
      });
    };

    let heartbeat: NodeJS.Timeout | undefined;
    if (onUpdate) {
      emitProgress();
      heartbeat = setInterval(() => {
        if (allResults.some((r) => r.exitCode === -1)) emitProgress();
      }, PARALLEL_HEARTBEAT_MS);
    }

    let results: SingleResult[];
    try {
      results = await mapConcurrent(tasks, MAX_CONCURRENCY, async (t, index) => {
        const result = await runAgent({
          cwd: defaultCwd,
          agents,
          agentName: t.agent,
          task: t.task,
          taskCwd: t.cwd,
          delegationMode,
          forkSessionSnapshotJsonl,
          parentDepth: currentDepth,
          parentAgentStack: ancestorAgentStack,
          maxDepth,
          preventCycles,
          signal,
          onUpdate: (partial) => {
            if (partial.details?.results[0]) {
              allResults[index] = partial.details.results[0];
              emitProgress();
            }
          },
          makeDetails: makeDetails("parallel"),
        });
        allResults[index] = result;
        emitProgress();
        return result;
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const successCount = results.filter((r) => isResultSuccess(r)).length;
    const summaries = results.map((r) =>
      `[${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r)}`,
    );

    return {
      content: [{ type: "text" as const, text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
      details: makeDetails("parallel")(results),
    };
  }
}
