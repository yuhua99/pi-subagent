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
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { registerAgentsCommand } from "./agents_command.ts";
import { formatSubagentList, renderCall, renderKillCall, renderKillResult, renderListCall, renderListResult, renderResult, renderSteerCall, renderSteerResult } from "./render.ts";
import { injectIntoSystemPrompt } from "./prompt_injection.ts";
import { listRuns } from "./registry.ts";
import type { SubagentKillDetails, SubagentListDetails } from "./types.ts";
import { createSubagentExecution } from "./subagent_execution.ts";
import { formatSubagentSystemPrompt, KILL_TOOL_DESCRIPTION, LIST_TOOL_DESCRIPTION, STEER_TOOL_DESCRIPTION, SubagentKillParams, SubagentListParams, SubagentParams, SubagentSteerParams, TOOL_DESCRIPTION } from "./tool_schema.ts";

export default function (pi: ExtensionAPI) {
  registerAgentsCommand(pi);
  const execution = createSubagentExecution(pi);
  let discoveredAgents: AgentConfig[] = [];
  let discoveredOrchestrator: AgentConfig | null = null;

  pi.on("session_shutdown", () => execution.shutdown());

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
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return execution.execute(toolCallId, params, ctx, signal);
    },
    renderCall: (args, theme, context) => renderCall(args, theme, context),
    renderResult: (result, _options, theme) => renderResult(result, theme),
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List subagents",
    description: LIST_TOOL_DESCRIPTION,
    parameters: SubagentListParams,
    async execute() {
      const runs = listRuns();
      const details: SubagentListDetails = {
        runs: runs.map(({ id, agent, taskSummary, startedAt }) => ({ id, agent, taskSummary, startedAt })),
      };
      return {
        content: [{ type: "text" as const, text: formatSubagentList(runs) }],
        details,
      };
    },
    renderCall: (args, theme, context) => renderListCall(args, theme, context),
    renderResult: (result, _options, theme) => renderListResult(result, _options, theme),
  });

  pi.registerTool({
    name: "subagent_kill",
    label: "Kill subagent",
    description: KILL_TOOL_DESCRIPTION,
    parameters: SubagentKillParams,
    async execute(_toolCallId, params) {
      const entry = execution.kill(params.id);
      if (!entry) {
        const details: SubagentKillDetails = { id: params.id };
        return {
          content: [
            {
              type: "text" as const,
              text: `No running subagent with id '${params.id}' (it may have already finished).`,
            },
          ],
          details,
        };
      }
      const details: SubagentKillDetails = { id: entry.id, agent: entry.agent };
      return {
        content: [{ type: "text" as const, text: `Killed subagent [${entry.id}] (${entry.agent}).` }],
        details,
      };
    },
    renderCall: (args, theme, context) => renderKillCall(args, theme, context),
    renderResult: (result, _options, theme) => renderKillResult(result, _options, theme),
  });

  pi.registerTool({
    name: "subagent_steer",
    label: "Steer subagent",
    description: STEER_TOOL_DESCRIPTION,
    parameters: SubagentSteerParams,
    async execute(_toolCallId, params) {
      const entry = execution.steer(params.id, params.text);
      if ("error" in entry) {
        const details: SubagentKillDetails = { id: params.id };
        return {
          content: [{ type: "text" as const, text: entry.error }],
          details,
        };
      }
      const details: SubagentKillDetails = { id: entry.id, agent: entry.agent };
      return {
        content: [{ type: "text" as const, text: `Steered subagent [${entry.id}] (${entry.agent}).` }],
        details,
      };
    },
    renderCall: (args, theme, context) => renderSteerCall(args, theme, context),
    renderResult: (result, _options, theme) => renderSteerResult(result, _options, theme),
  });
}

