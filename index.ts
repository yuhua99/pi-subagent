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
import { type AgentConfig, discoverAgents } from "./agents.js";
import { registerAgentsCommand } from "./agents_command.js";
import {
  buildForkSessionSnapshotJsonl,
  failedPlaceholderResult,
  formatAgentNames,
  isSubagentChild,
  isSubagentForkChild,
  makeDetailsFactory,
  makeRunningPlaceholder,
  parseDelegationMode,
  reserveParallelPlaceholders,
} from "./delegation.js";
import { formatSubagentList, renderCall, renderResult } from "./render.js";
import { injectIntoSystemPrompt } from "./prompt_injection.js";
import { completeRun, getRun, listRuns } from "./registry.js";
import { getResultSummaryText } from "./runner-events.js";
import { mapConcurrent, runAgent } from "./runner.js";
import { formatSubagentSystemPrompt, KILL_TOOL_DESCRIPTION, LIST_TOOL_DESCRIPTION, MAX_CONCURRENCY, MAX_PARALLEL_TASKS, SubagentKillParams, SubagentListParams, SubagentParams, TOOL_DESCRIPTION } from "./tool_schema.js";
import { DEFAULT_DELEGATION_MODE, isResultError, isResultSuccess, type DelegationMode } from "./types.js";

export default function (pi: ExtensionAPI) {
  // Fork children register schema-identical stub tools instead of returning
  // early: the parent's cached request prefix includes these tool schemas, so
  // omitting them would diverge the tool segment and forfeit the prompt cache.
  if (isSubagentForkChild()) {
    registerForkChildStubs(pi);
    return;
  }
  if (isSubagentChild()) return;

  registerAgentsCommand(pi);

  let discoveredAgents: AgentConfig[] = [];
  let discoveredOrchestrator: AgentConfig | null = null;

  pi.on("session_shutdown", async () => {
    for (const entry of listRuns()) entry.kill();
  });

  pi.on("session_start", async (_event, ctx) => {
    const discovery = discoverAgents(ctx.cwd, "both");
    discoveredAgents = discovery.agents;
    discoveredOrchestrator = discovery.orchestrator;

    if (ctx.hasUI && (discoveredAgents.length > 0 || discoveredOrchestrator)) {
      const lines = discoveredAgents.map((a) => `  - ${a.name} (${a.source})`);
      if (discoveredOrchestrator) {
        lines.push(`  - ${discoveredOrchestrator.name} (${discoveredOrchestrator.source}, orchestrator)`);
      }
      const header = discoveredAgents.length > 0
        ? `Found ${discoveredAgents.length} subagent(s):`
        : "Found orchestrator:";
      ctx.ui.notify(`${header}\n${lines.join("\n")}`, "info");
    }
  });

  pi.on("before_agent_start", async (event) => {
    const parts: string[] = [];
    const orchestratorPrompt = discoveredOrchestrator?.systemPrompt.trim();
    if (orchestratorPrompt) parts.push(orchestratorPrompt);
    if (discoveredAgents.length > 0) parts.push(formatSubagentSystemPrompt(discoveredAgents));
    if (parts.length === 0) return undefined;
    return {
      systemPrompt: injectIntoSystemPrompt(event.systemPrompt, parts.join("\n\n")),
    };
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: TOOL_DESCRIPTION,
    parameters: SubagentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, "both");

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

      const parentSystemPrompt = delegationMode === "fork" ? ctx.getSystemPrompt() : undefined;

      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      if (Number(hasTasks) + Number(hasSingle) !== 1) {
        return {
          content: [{ type: "text", text: `Invalid parameters. Provide exactly one invocation shape.\nAvailable agents: ${formatAgentNames(agents)}` }],
          details: makeDetails("single")([]),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        return executeParallel(
          params.tasks,
          delegationMode,
          forkSessionSnapshotJsonl,
          parentSystemPrompt,
          agents,
          ctx.cwd,
          makeDetails,
        );
      }

      return executeSingle(
        params.agent!,
        params.task!,
        params.cwd,
        delegationMode,
        forkSessionSnapshotJsonl,
        parentSystemPrompt,
        agents,
        ctx.cwd,
        makeDetails,
      );
    },

    renderCall: (args, theme, context) => renderCall(args, theme, context),
    renderResult: (result, _options, theme, context) => renderResult(result, theme, context),
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List subagents",
    description: LIST_TOOL_DESCRIPTION,
    parameters: SubagentListParams,

    async execute() {
      return {
        content: [{ type: "text" as const, text: formatSubagentList(listRuns()) }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "subagent_kill",
    label: "Kill subagent",
    description: KILL_TOOL_DESCRIPTION,
    parameters: SubagentKillParams,

    async execute(_toolCallId, params) {
      const entry = getRun(params.id);
      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No running subagent with id '${params.id}' (it may have already finished).`,
            },
          ],
          details: undefined,
        };
      }
      entry.kill();
      return {
        content: [{ type: "text" as const, text: `Killed subagent [${entry.id}] (${entry.agent}).` }],
        details: undefined,
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
    parentSystemPrompt: string | undefined,
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
      parentSystemPrompt,
      onSpawn: (id) => onSpawn(id),
    });

    const raced = await Promise.race([
      spawned.then((id) => ({ kind: "spawned" as const, id })),
      runPromise.then((r) => ({ kind: "done" as const, r })),
    ]);

    if (raced.kind === "done") {
      const r = raced.r;
      if (r.registryId) completeRun(r.registryId, r);
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
      completeRun(id, result);
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Background subagent [${id}] (${result.agent}) ${status}.\n\n${getResultSummaryText(result)}`,
          display: false,
          details: makeDetails("single")([result]),
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const r = failedPlaceholderResult(makeRunningPlaceholder(agentName, task, agents, raced.id), "error", message);
      completeRun(raced.id, r);
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Background subagent [${raced.id}] (${agentName}) failed: ${message}`,
          display: false,
          details: makeDetails("single")([r]),
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Started subagent [${raced.id}] (${agentName}). The result will be delivered to you automatically as a new message when it finishes. Do NOT wait, poll subagent_list, or sleep. If you have nothing else to do, end your turn now.`,
        },
      ],
      details: makeDetails("single")([
        makeRunningPlaceholder(agentName, task, agents, raced.id),
      ]),
    };
  }

  async function executeParallel(
    tasks: Array<{ agent: string; task: string; cwd?: string }>,
    delegationMode: DelegationMode,
    forkSessionSnapshotJsonl: string | undefined,
    parentSystemPrompt: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    if (tasks.length > MAX_PARALLEL_TASKS) {
      return {
        content: [{ type: "text" as const, text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
        details: makeDetails("parallel")([]),
      };
    }

    const { placeholders, killedResults } = reserveParallelPlaceholders(tasks, agents);

    const batchPromise = mapConcurrent(tasks, MAX_CONCURRENCY, async (t, i) => {
      const killed = killedResults[i];
      if (killed) return killed;
      try {
        const r = await runAgent({
          cwd: defaultCwd,
          agents,
          agentName: t.agent,
          task: t.task,
          taskCwd: t.cwd,
          delegationMode,
          forkSessionSnapshotJsonl,
          parentSystemPrompt,
          reservedRegistryId: placeholders[i].registryId,
        });
        completeRun(r.registryId ?? placeholders[i].registryId!, r);
        return r;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const r = failedPlaceholderResult(placeholders[i], "error", message);
        completeRun(placeholders[i].registryId!, r);
        return r;
      }
    });

    batchPromise.then((results) => {
      const successCount = results.filter((r) => isResultSuccess(r)).length;
      const summaries = results.map((r) =>
        `[${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r)}`,
      );
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Parallel subagent batch finished: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
          display: false,
          details: makeDetails("parallel")(results),
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      for (const p of placeholders) {
        if (p.registryId && getRun(p.registryId)) {
          completeRun(p.registryId, failedPlaceholderResult(p, "error", message));
        }
      }
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Parallel subagent batch failed: ${message}`,
          display: false,
          details: makeDetails("parallel")(placeholders),
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Started ${tasks.length} parallel subagent(s). The combined result will be delivered to you automatically as a new message when all finish. Do NOT wait, poll subagent_list, or sleep. If you have nothing else to do, end your turn now.`,
        },
      ],
      details: makeDetails("parallel")(placeholders),
    };
  }
}

function registerForkChildStubs(pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: TOOL_DESCRIPTION,
    parameters: SubagentParams,
    async execute() {
      return {
        content: [{ type: "text" as const, text: "Delegation is single-level: this subagent cannot delegate further." }],
        details: undefined,
        isError: true,
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List subagents",
    description: LIST_TOOL_DESCRIPTION,
    parameters: SubagentListParams,
    async execute() {
      return {
        content: [{ type: "text" as const, text: "Delegation is single-level: this subagent cannot delegate further." }],
        details: undefined,
        isError: true,
      };
    },
  });

  pi.registerTool({
    name: "subagent_kill",
    label: "Kill subagent",
    description: KILL_TOOL_DESCRIPTION,
    parameters: SubagentKillParams,
    async execute() {
      return {
        content: [{ type: "text" as const, text: "Delegation is single-level: this subagent cannot delegate further." }],
        details: undefined,
        isError: true,
      };
    },
  });
}

