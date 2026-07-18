import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import {
	buildForkSessionSnapshotJsonl,
	failedPlaceholderResult,
	formatAgentNames,
	makeDetailsFactory,
	makeRunningPlaceholder,
	parseDelegationMode,
	reserveParallelPlaceholders,
} from "./delegation.ts";
import { cleanupManagedSessions, hasManagedSessionPath } from "./session_files.ts";
import {
	completeRun,
	getRun,
	listCompletedRuns,
	listRuns,
	reserveResumeRun,
	type SubagentRun,
} from "./registry.ts";
import { getResultSummaryText } from "./runner-events.js";
import { runAgent } from "./runner.ts";
import {
	DEFAULT_DELEGATION_MODE,
	isResultError,
	isResultSuccess,
	type DelegationMode,
	type SingleResult,
	type SubagentDetails,
} from "./types.ts";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from "./tool_schema.ts";

export interface SubagentToolParams {
	resume?: string;
	task?: string;
	agent?: string;
	mode?: unknown;
	cwd?: string;
	tasks?: Array<{ agent: string; task: string; cwd?: string }>;
}

export interface SubagentExecutionContext {
	cwd: string;
	sessionManager: {
		getHeader: () => unknown;
		getBranch: () => unknown[];
		getSessionId: () => string;
	};
	getSystemPrompt: () => string;
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: SubagentDetails;
	isError?: boolean;
}

interface SubagentExecution {
	execute(params: SubagentToolParams, ctx: SubagentExecutionContext, signal?: AbortSignal): Promise<ToolResult>;
	kill(id: string): SubagentRun | undefined;
	shutdown(): Promise<void>;
}

export function createSubagentExecution(pi: Pick<ExtensionAPI, "sendMessage">): SubagentExecution {
	const retainedSessionPaths = () => {
		const paths = new Set<string>();
		for (const entry of listRuns()) {
			if (entry.sessionPath) paths.add(entry.sessionPath);
		}
		for (const entry of listCompletedRuns()) {
			if (isResultSuccess(entry.result) && entry.delegationMode && entry.sessionPath) {
				paths.add(entry.sessionPath);
			}
		}
		return paths;
	};

	const completeSubagentRun = (id: string, result: SingleResult) => {
		if (!getRun(id)) return;
		result.registryId = id;
		completeRun(id, result);
		cleanupManagedSessions(retainedSessionPaths());
	};

	const onResumeKill = (id: string) => {
		const entry = getRun(id);
		if (!entry) return;
		completeSubagentRun(id, failedPlaceholderResult(entry.result, "killed", "Subagent was killed before it started."));
	};

	const executeSingle = async (
		agentName: string,
		task: string,
		cwd: string | undefined,
		delegationMode: DelegationMode,
		forkSessionSnapshotJsonl: string | undefined,
		parentSystemPrompt: string | undefined,
		agents: AgentConfig[],
		defaultCwd: string,
		makeDetails: ReturnType<typeof makeDetailsFactory>,
		reservedRegistryId?: string,
		sessionPath?: string,
		parentSessionId?: string,
		sourceRunId?: string,
		lineageId?: string,
		signal?: AbortSignal,
	): Promise<ToolResult> => {
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
			sessionPath,
			parentSessionId,
			workingDirectory: defaultCwd,
			sourceRunId,
			lineageId,
			reservedRegistryId,
			signal,
			onSpawn: (id) => onSpawn(id),
		});

		let raced:
			| { kind: "spawned"; id: string }
			| { kind: "done"; r: Awaited<ReturnType<typeof runAgent>> };
		try {
			raced = await Promise.race([
				spawned.then((id) => ({ kind: "spawned" as const, id })),
				runPromise.then((r) => ({ kind: "done" as const, r })),
			]);
		} catch (err: unknown) {
			if (!reservedRegistryId) {
				cleanupManagedSessions(retainedSessionPaths());
				throw err;
			}
			const message = err instanceof Error ? err.message : String(err);
			const r = failedPlaceholderResult(
				makeRunningPlaceholder(agentName, task, agents, reservedRegistryId),
				"error",
				message,
			);
			completeSubagentRun(reservedRegistryId, r);
			return {
				content: [{ type: "text", text: `Agent ${r.stopReason || "failed"}: ${getResultSummaryText(r)}` }],
				details: makeDetails("single")([r]),
				isError: true,
			};
		}

		if (raced.kind === "done") {
			const r = raced.r;
			const id = r.registryId ?? reservedRegistryId;
			if (id) {
				r.registryId = id;
				completeSubagentRun(id, r);
			}
			if (isResultError(r)) {
				return {
					content: [{ type: "text", text: `Agent ${r.stopReason || "failed"}: ${getResultSummaryText(r)}` }],
					details: makeDetails("single")([r]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: r.registryId ? `Completed subagent [${r.registryId}]:\n\n${getResultSummaryText(r)}` : getResultSummaryText(r) }],
				details: makeDetails("single")([r]),
			};
		}

		runPromise.then((result) => {
			const id = result.registryId ?? raced.id;
			const status = isResultError(result) ? (result.stopReason || "failed") : "completed";
			completeSubagentRun(id, result);
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
			completeSubagentRun(raced.id, r);
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
			content: [{
				type: "text",
				text: `Started subagent [${raced.id}] (${agentName}). The result will be delivered to you automatically as a new message when it finishes. Do NOT wait, poll subagent_list, or sleep. If you have nothing else to do, end your turn now.`,
			}],
			details: makeDetails("single")([makeRunningPlaceholder(agentName, task, agents, raced.id)]),
		};
	};

	const executeParallel = async (
		tasks: Array<{ agent: string; task: string; cwd?: string }>,
		delegationMode: DelegationMode,
		forkSessionSnapshotJsonl: string | undefined,
		parentSystemPrompt: string | undefined,
		agents: AgentConfig[],
		defaultCwd: string,
		makeDetails: ReturnType<typeof makeDetailsFactory>,
		parentSessionId: string,
		signal?: AbortSignal,
	): Promise<ToolResult> => {
		if (tasks.length > MAX_PARALLEL_TASKS) {
			return {
				content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
				details: makeDetails("parallel")([]),
				isError: true,
			};
		}

		const { placeholders, killedResults } = reserveParallelPlaceholders(tasks, agents, completeSubagentRun);
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
					parentSessionId,
					workingDirectory: t.cwd ?? defaultCwd,
					signal,
					reservedRegistryId: placeholders[i].registryId,
				});
				completeSubagentRun(r.registryId ?? placeholders[i].registryId!, r);
				return r;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const r = failedPlaceholderResult(placeholders[i], "error", message);
				completeSubagentRun(placeholders[i].registryId!, r);
				return r;
			}
		});

		batchPromise.then((results) => {
			const successCount = results.filter((r) => isResultSuccess(r)).length;
			const summaries = results.map((r) =>
				`[${r.registryId ?? "?"}] [${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r)}`,
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
					completeSubagentRun(p.registryId, failedPlaceholderResult(p, "error", message));
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
			content: [{
				type: "text",
				text: `Started ${tasks.length} parallel subagent(s). The combined result will be delivered to you automatically as a new message when all finish. Do NOT wait, poll subagent_list, or sleep. If you have nothing else to do, end your turn now.`,
			}],
			details: makeDetails("parallel")(placeholders),
		};
	};

	const execute = async (params: SubagentToolParams, ctx: SubagentExecutionContext, signal?: AbortSignal): Promise<ToolResult> => {
		const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, "both");
		const parentSessionId = ctx.sessionManager.getSessionId();
		const hasResume = params.resume !== undefined;
		const hasTasks = (params.tasks?.length ?? 0) > 0;
		const hasSingle = typeof params.agent === "string" && typeof params.task === "string";

		if (hasResume) {
			const defaultDetails = makeDetailsFactory(projectAgentsDir, DEFAULT_DELEGATION_MODE);
			if (
				typeof params.resume !== "string" ||
				typeof params.task !== "string" ||
				params.agent !== undefined ||
				params.tasks !== undefined ||
				params.mode !== undefined ||
				params.cwd !== undefined
			) {
				return {
					content: [{ type: "text", text: `Invalid resume parameters. Use exactly { resume, task } and do not combine them with agent/tasks/mode/cwd.\nAvailable agents: ${formatAgentNames(agents)}` }],
					details: defaultDetails("single")([]),
					isError: true,
				};
			}
			const reservation = reserveResumeRun(params.resume, params.task, parentSessionId, hasManagedSessionPath, onResumeKill);
			if ("error" in reservation) {
				return {
					content: [{ type: "text", text: reservation.error }],
					details: defaultDetails("single")([]),
					isError: true,
				};
			}
			const source = reservation.source;
			const delegationMode = source.delegationMode!;
			const makeDetails = makeDetailsFactory(projectAgentsDir, delegationMode);
			return executeSingle(
				source.agent,
				params.task,
				undefined,
				delegationMode,
				undefined,
				delegationMode === "fork" ? ctx.getSystemPrompt() : undefined,
				agents,
				source.workingDirectory ?? ctx.cwd,
				makeDetails,
				reservation.run.id,
				source.sessionPath,
				parentSessionId,
				source.id,
				source.lineageId,
				signal,
			);
		}

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
		if (hasTasks && hasSingle || !hasTasks && !hasSingle) {
			return {
				content: [{ type: "text", text: `Invalid parameters. Provide exactly one invocation shape.\nAvailable agents: ${formatAgentNames(agents)}` }],
				details: makeDetails("single")([]),
				isError: true,
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
				parentSessionId,
				signal,
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
			undefined,
			undefined,
			parentSessionId,
			undefined,
			undefined,
			signal,
		);
	};

	return {
		execute,
		kill(id: string) {
			const entry = getRun(id);
			entry?.kill();
			return entry;
		},
		async shutdown() {
			const entries = listRuns();
			const completions = entries.map((entry) => new Promise<void>((resolve) => {
				let finished = false;
				let unsubscribe: (() => void) | undefined;
				const finish = () => {
					if (finished) return;
					finished = true;
					unsubscribe?.();
					resolve();
				};
				unsubscribe = entry.onStatus(() => {
					queueMicrotask(() => {
						if (!getRun(entry.id)) finish();
					});
				});
				if (!getRun(entry.id)) finish();
			}));
			for (const entry of entries) entry.kill();
			await Promise.all(completions);
			cleanupManagedSessions();
		},
	};
}

export async function mapConcurrent<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = Array.from({ length: items.length });
	let nextIndex = 0;
	const worker = async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}
