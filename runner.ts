/**
 * In-process subagent runner.
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { stripCwdTail } from "./prompt_injection.ts";
import { getRun, notifyStatus, notifyStream, registerRun, updateRun, type RunMetadata } from "./registry.ts";
import { createManagedResumeSessionFile, createManagedSessionFile } from "./session_files.ts";
import { KILL_TOOL_DESCRIPTION, LIST_TOOL_DESCRIPTION, SubagentKillParams, SubagentListParams, SubagentParams, TOOL_DESCRIPTION } from "./tool_schema.ts";
import {
	type DelegationMode,
	type SingleResult,
	emptyUsage,
	getFinalAssistantMessage,
	hasFinalAssistantOutput,
	normalizeCompletedResult,
} from "./types.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

async function unavailableToolResult() {
	return {
		content: [{ type: "text" as const, text: "Delegation is single-level: this subagent cannot delegate further." }],
		details: undefined,
		isError: true,
	};
}

function createForkStubTools() {
	return [
		defineTool({
			name: "subagent",
			label: "Subagent",
			description: TOOL_DESCRIPTION,
			parameters: SubagentParams,
			execute: unavailableToolResult,
		}),
		defineTool({
			name: "subagent_list",
			label: "List subagents",
			description: LIST_TOOL_DESCRIPTION,
			parameters: SubagentListParams,
			execute: unavailableToolResult,
		}),
		defineTool({
			name: "subagent_kill",
			label: "Kill subagent",
			description: KILL_TOOL_DESCRIPTION,
			parameters: SubagentKillParams,
			execute: unavailableToolResult,
		}),
	];
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function updateAssistantMetadata(result: SingleResult, message: AssistantMessage): void {
	if (!result.model && message.model) result.model = message.model;
	if (message.stopReason) result.stopReason = message.stopReason;
	if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function addTranscriptMessage(result: SingleResult, message: Message | undefined): boolean {
	if (!message || (message.role !== "assistant" && message.role !== "toolResult")) return false;

	if (message.role === "toolResult") {
		const index = result.messages.findIndex(
			(existing) => existing.role === "toolResult" && existing.toolCallId === message.toolCallId,
		);
		if (index >= 0) {
			result.messages[index] = message;
			return false;
		}
	} else {
		updateAssistantMetadata(result, message);
	}

	const signature = stableStringify(message);
	const seen = getSeenMessageSignatures(result);
	if (seen.has(signature)) return false;
	seen.add(signature);
	result.messages.push(message);

	if (message.role === "assistant") {
		result.usage.turns++;
		const usage = message.usage;
		if (usage) {
			result.usage.input += usage.input || 0;
			result.usage.output += usage.output || 0;
			result.usage.cacheRead += usage.cacheRead || 0;
			result.usage.cacheWrite += usage.cacheWrite || 0;
			result.usage.cost += usage.cost?.total || 0;
			result.usage.contextTokens = usage.totalTokens || 0;
		}
	}

	return true;
}

function getSeenMessageSignatures(result: SingleResult): Set<string> {
	const state = result as SingleResult & { seenMessageSignatures?: Set<string> };
	if (!state.seenMessageSignatures) {
		Object.defineProperty(state, "seenMessageSignatures", { value: new Set<string>() });
	}
	return state.seenMessageSignatures;
}

function addToolExecutionResult(result: SingleResult, event: {
	toolCallId?: string;
	toolName?: string;
	result?: { content?: unknown; details?: unknown; usage?: unknown; addedToolNames?: unknown };
	isError?: boolean;
}): boolean {
	if (!event.result || !event.toolCallId || !event.toolName) return false;
	if (result.messages.some((message) => message.role === "toolResult" && message.toolCallId === event.toolCallId)) {
		return false;
	}
	return addTranscriptMessage(result, {
		role: "toolResult",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		content: event.result.content ?? [],
		details: event.result.details,
		usage: event.result.usage,
		addedToolNames: event.result.addedToolNames,
		isError: event.isError,
		timestamp: Date.now(),
	} as Message);
}

export function processSessionEvent(result: SingleResult, event: unknown): "status" | "stream" | false {
	const sessionEvent = event as {
		type?: string;
		message?: Message;
		messages?: Message[];
		toolResults?: Message[];
		toolCallId?: string;
		toolName?: string;
		result?: { content?: unknown; details?: unknown; usage?: unknown; addedToolNames?: unknown };
		isError?: boolean;
	};

	switch (sessionEvent.type) {
		case "message_update":
			result.partialMessage = sessionEvent.message as AssistantMessage;
			return "stream";
		case "message_end":
			addTranscriptMessage(result, sessionEvent.message);
			result.partialMessage = undefined;
			return "status";
		case "tool_execution_end":
			addToolExecutionResult(result, sessionEvent);
			return "status";
		case "turn_end":
			addTranscriptMessage(result, sessionEvent.message);
			for (const message of sessionEvent.toolResults ?? []) addTranscriptMessage(result, message);
			result.partialMessage = undefined;
			return "status";
		case "agent_end":
			result.sawAgentEnd = true;
			for (const message of sessionEvent.messages ?? []) addTranscriptMessage(result, message);
			result.partialMessage = undefined;
			return "status";
		default:
			return false;
	}
}

/** Build the task message sent to the child session. */
export function buildTaskMessage(agent: AgentConfig, task: string, delegationMode: DelegationMode): string {
	if (delegationMode === "fork" && agent.systemPrompt.trim()) {
		return `Task instructions:\n\n${agent.systemPrompt.trim()}\n\nTask: ${task}`;
	}
	return `Task: ${task}`;
}

async function createResourceLoader(
	cwd: string,
	agent: AgentConfig,
	delegationMode: DelegationMode,
	parentSystemPrompt: string | undefined,
): Promise<DefaultResourceLoader> {
	const fork = delegationMode === "fork";
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		...(fork ? {
			noSkills: true,
			noContextFiles: true,
			systemPromptOverride: () => stripCwdTail(parentSystemPrompt ?? ""),
		} : {
			appendSystemPromptOverride: (base) => agent.systemPrompt.trim()
				? [...base, agent.systemPrompt]
				: base,
		}),
	});
	await loader.reload();
	return loader;
}

async function resolveSpawnModel(agent: AgentConfig): Promise<{
	modelRuntime?: ModelRuntime;
	model?: ReturnType<typeof resolveCliModel>["model"];
	thinkingLevel?: ThinkingLevel;
}> {
	if (!agent.model) return {};
	const modelName = agent.model;
	const modelRuntime = await ModelRuntime.create();
	const resolution = resolveCliModel({ cliModel: modelName, modelRuntime });
	if (resolution.error || !resolution.model) {
		throw new Error(resolution.error ?? `Could not resolve model "${modelName}".`);
	}
	return { modelRuntime, model: resolution.model, thinkingLevel: resolution.thinkingLevel };
}

export interface RunAgentOptions {
	cwd: string;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	taskCwd?: string;
	delegationMode: DelegationMode;
	forkSessionSnapshotJsonl?: string;
	sessionPath?: string;
	parentSessionId?: string;
	workingDirectory?: string;
	sourceRunId?: string;
	lineageId?: string;
	parentSystemPrompt?: string;
	signal?: AbortSignal;
	onSpawn?: (registryId: string) => void;
	reservedRegistryId?: string;
}

function failedResult(result: SingleResult, message: string): SingleResult {
	result.exitCode = 1;
	result.stopReason = "error";
	result.errorMessage = message;
	result.stderr = message;
	return result;
}

function createEarlyFailure(
	opts: RunAgentOptions,
	agentSource: SingleResult["agentSource"],
	message: string,
	model?: string,
): SingleResult {
	return {
		agent: opts.agentName,
		agentSource,
		task: opts.task,
		exitCode: 1,
		messages: [],
		stderr: message,
		usage: emptyUsage(),
		...(model !== undefined ? { model } : {}),
		stopReason: "error",
		errorMessage: message,
		registryId: opts.reservedRegistryId,
	};
}

function createRunningResult(opts: RunAgentOptions, agent: AgentConfig): SingleResult {
	return {
		agent: opts.agentName,
		agentSource: agent.source,
		task: opts.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	};
}

interface PreparedRunSession {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	managedSessionPath: string;
}

async function createRunSession(
	opts: RunAgentOptions,
	agent: AgentConfig,
	result: SingleResult,
): Promise<PreparedRunSession | undefined> {
	const isFreshSpawn = opts.delegationMode === "spawn" && !opts.sessionPath;
	if (isFreshSpawn && agent.model === undefined) {
		failedResult(result, `Agent "${agent.name}" config must specify a model for fresh spawn runs.`);
		return undefined;
	}
	if (isFreshSpawn && agent.thinking !== undefined && !THINKING_LEVELS.includes(agent.thinking as ThinkingLevel)) {
		failedResult(
			result,
			`Invalid thinking level "${agent.thinking}" for agent "${agent.name}". Expected one of: ${THINKING_LEVELS.join(", ")}.`,
		);
		return undefined;
	}

	let resolved: Awaited<ReturnType<typeof resolveSpawnModel>> = {};
	if (isFreshSpawn) {
		try {
			resolved = await resolveSpawnModel(agent);
		} catch (error) {
			failedResult(result, error instanceof Error ? error.message : String(error));
			return undefined;
		}
		if (agent.thinking === undefined && resolved.thinkingLevel === undefined) {
			failedResult(result, `Agent "${agent.name}" config must specify a thinking level for fresh spawn runs.`);
			return undefined;
		}
	}

	const effectiveCwd = opts.taskCwd ?? opts.cwd;
	const managedSessionPath = opts.sessionPath
		? createManagedResumeSessionFile(agent.name, opts.sessionPath)
		: createManagedSessionFile(
			agent.name,
			opts.delegationMode === "fork" ? opts.forkSessionSnapshotJsonl : undefined,
		).filePath;
	try {
		const loader = await createResourceLoader(effectiveCwd, agent, opts.delegationMode, opts.parentSystemPrompt);
		const thinkingLevel = isFreshSpawn
			? (agent.thinking as ThinkingLevel | undefined) ?? resolved.thinkingLevel
			: undefined;
		const tools = isFreshSpawn ? agent.tools : undefined;
		const created = await createAgentSession({
			cwd: effectiveCwd,
			agentDir: getAgentDir(),
			resourceLoader: loader,
			sessionManager: SessionManager.open(managedSessionPath, undefined, effectiveCwd),
			...(tools !== undefined ? { tools } : {}),
			...(opts.delegationMode === "fork" ? { customTools: createForkStubTools() } : {}),
			...("modelRuntime" in resolved && resolved.modelRuntime ? { modelRuntime: resolved.modelRuntime } : {}),
			...("model" in resolved && resolved.model ? { model: resolved.model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
		});
		return { session: created.session, managedSessionPath };
	} catch (error) {
		failedResult(result, error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

interface RunControl {
	state: { wasAborted: boolean; wasKilled: boolean };
	abortSession(killed: boolean): void;
}

function createRunControl(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): RunControl {
	const state = { wasAborted: false, wasKilled: false };
	return {
		state,
		abortSession(killed) {
			if (killed) state.wasKilled = true;
			else state.wasAborted = true;
			void session.abort().catch(() => {});
		},
	};
}

function attachRun(
	opts: RunAgentOptions,
	agent: AgentConfig,
	result: SingleResult,
	managedSessionPath: string,
	control: RunControl,
): string {
	const runMetadata: RunMetadata = {
		sessionPath: managedSessionPath,
		workingDirectory: opts.taskCwd ?? opts.workingDirectory ?? opts.cwd,
		parentSessionId: opts.parentSessionId,
		delegationMode: opts.delegationMode,
		sourceRunId: opts.sourceRunId,
		lineageId: opts.lineageId,
	};
	const kill = () => control.abortSession(true);
	let registryId: string;
	if (opts.reservedRegistryId) {
		registryId = opts.reservedRegistryId;
		updateRun(registryId, {
			...runMetadata,
			pid: undefined,
			startedAt: Date.now(),
			kill,
			result,
		});
		if (!getRun(registryId)) control.abortSession(true);
	} else {
		registryId = registerRun({
			agent: agent.name,
			task: opts.task,
			pid: undefined,
			startedAt: Date.now(),
			kill,
			result,
			...runMetadata,
		}).id;
	}
	result.registryId = registryId;
	opts.onSpawn?.(registryId);
	return registryId;
}

async function runSessionPrompt(
	opts: RunAgentOptions,
	agent: AgentConfig,
	result: SingleResult,
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	registryId: string,
	control: RunControl,
): Promise<SingleResult> {
	const unsubscribe = session.subscribe((event) => {
		const kind = processSessionEvent(result, event);
		if (kind === "stream") notifyStream(registryId);
		else if (kind === "status") notifyStatus(registryId);
	});
	let abortHandler: (() => void) | undefined;
	if (opts.signal) {
		abortHandler = () => control.abortSession(false);
		if (opts.signal.aborted) abortHandler();
		else opts.signal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		if (control.state.wasKilled || control.state.wasAborted) {
			result.exitCode = 130;
		} else {
			try {
				await session.prompt(buildTaskMessage(agent, opts.task, opts.delegationMode));
				const finalAssistant = getFinalAssistantMessage(result.messages);
				if (!finalAssistant) {
					failedResult(result, "Subagent completed without an assistant response.");
				} else {
					result.model = finalAssistant.model;
					result.stopReason = finalAssistant.stopReason;
					result.errorMessage = finalAssistant.errorMessage;
					result.exitCode = result.stopReason === "error" ||
						(result.stopReason === "length" && !hasFinalAssistantOutput(result))
						? 1
						: 0;
				}
			} catch (error) {
				failedResult(result, error instanceof Error ? error.message : String(error));
			}
		}

		const normalized = normalizeCompletedResult(result, control.state.wasAborted || control.state.wasKilled);
		if (control.state.wasKilled && normalized.stopReason === "aborted") {
			normalized.stopReason = "killed";
			normalized.errorMessage = "Subagent was killed.";
			if (normalized.stderr === "Subagent was aborted.") normalized.stderr = "Subagent was killed.";
		}
		notifyStatus(registryId);
		return normalized;
	} finally {
		if (opts.signal && abortHandler) opts.signal.removeEventListener("abort", abortHandler);
		unsubscribe();
		session.dispose();
	}
}

/** Run one subagent in an isolated in-process SDK session. */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
	const agent = opts.agents.find((entry) => entry.name === opts.agentName);
	if (!agent) {
		const available = opts.agents.map((entry) => `"${entry.name}"`).join(", ") || "none";
		return createEarlyFailure(
			opts,
			"unknown",
			`Unknown agent: "${opts.agentName}". Available agents: ${available}.`,
		);
	}
	if (opts.delegationMode === "fork" && !opts.sessionPath && !opts.forkSessionSnapshotJsonl?.trim()) {
		return createEarlyFailure(
			opts,
			agent.source,
			"Cannot run in fork mode: missing parent session snapshot context.",
			agent.model,
		);
	}

	const result = createRunningResult(opts, agent);
	const prepared = await createRunSession(opts, agent, result);
	if (!prepared) return result;
	const control = createRunControl(prepared.session);
	const registryId = attachRun(opts, agent, result, prepared.managedSessionPath, control);
	return runSessionPrompt(opts, agent, result, prepared.session, registryId, control);
}
