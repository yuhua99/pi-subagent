/**
 * Pi Subagent Extension
 *
 * Registers delegation and control tools plus session event wiring.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { registerAgentsCommand } from "./agents/command.ts";
import { createSubagentToggle } from "./agents/toggle.ts";
import { renderCall, renderCtlCall, renderCtlResult, renderResult } from "./tool/render.ts";
import { injectIntoSystemPrompt } from "./execution/prompt_injection.ts";
import { createSubagentExecution } from "./execution/execution.ts";
import {
  CTL_TOOL_DESCRIPTION,
  formatSubagentSystemPrompt,
  parseSubagentCtlInvocation,
  parseSubagentInvocation,
  SubagentCtlParams,
  SubagentParams,
  TOOL_DESCRIPTION,
} from "./tool/schema.ts";

export default function (pi: ExtensionAPI) {
  const toggle = createSubagentToggle(pi);
  registerAgentsCommand(pi, toggle);
  const execution = createSubagentExecution(pi);
  let discoveredAgents: AgentConfig[] = [];
  let discoveredOrchestrator: AgentConfig | null = null;

  pi.on("session_shutdown", () => execution.shutdown());

  pi.on("session_start", async (_event, ctx) => {
    toggle.restoreFromBranch(ctx.sessionManager.getBranch());

    const discovery = discoverAgents(ctx.cwd, "both");
    discoveredAgents = discovery.agents;
    discoveredOrchestrator = discovery.orchestrator;

    if (ctx.hasUI && (discoveredAgents.length > 0 || discoveredOrchestrator)) {
      const lines = discoveredAgents.map((a) => `  - ${a.name} (${a.source})`);
      if (discoveredOrchestrator) {
        lines.push(
          `  - ${discoveredOrchestrator.name} (${discoveredOrchestrator.source}, orchestrator)`,
        );
      }
      const header =
        discoveredAgents.length > 0
          ? `Found ${discoveredAgents.length} subagent(s):`
          : "Found orchestrator:";
      ctx.ui.notify(`${header}\n${lines.join("\n")}`, "info");
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!toggle.isEnabled()) return undefined;
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
      const invocation = parseSubagentInvocation(params);
      if ("error" in invocation) {
        return { content: [{ type: "text" as const, text: invocation.error }], isError: true };
      }
      return execution.execute(toolCallId, invocation, ctx, signal);
    },
    renderCall: (args, theme, context) => renderCall(args, theme, context),
    renderResult: (result, _options, theme) => renderResult(result, theme),
  });

  pi.registerTool({
    name: "subagent_ctl",
    label: "Subagent control",
    description: CTL_TOOL_DESCRIPTION,
    parameters: SubagentCtlParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const invocation = parseSubagentCtlInvocation(params);
      if ("error" in invocation) {
        return { content: [{ type: "text" as const, text: invocation.error }], isError: true };
      }
      return execution.executeControl(invocation, ctx, signal);
    },
    renderCall: (args, theme, context) => renderCtlCall(args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderCtlResult(result, options, theme, context),
  });
}
