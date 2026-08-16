import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import {
	failedPlaceholderResult,
	makeDetailsFactory,
	makeRunningPlaceholder,
	reserveParallelPlaceholders,
} from "./delegation.ts";
import { cleanupManagedSessions, hasManagedSessionPath } from "./session_files.ts";
import {
	clearSessionState,
	completeRun,
	getRun,
	setRunPhase,
	bindToolCallRowInvalidate,
	listCompletedRuns,
	listRuns,
	reserveResumeRun,
	setRunTaskSummary,
	type SubagentRun,
} from "./registry.ts";
import { formatSubagentList } from "./render.ts";
import { runAgent } from "./runner.ts";
import { summarizeActivity, summarizeTask } from "./task_summary.ts";
import {
	getResultSummaryText,
	isResultError,
	isResultSuccess,
	type SingleResult,
	type SubagentDetails,
	type SubagentCtlDetails,
	type SubagentInspectDetails,
	type SubagentListDetails,
	type TaskSpec,
} from "./types.ts";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, type SubagentCtlInvocation, type SubagentInvocation } from "./tool_schema.ts";

export interface SubagentExecutionContext extends Pick<ExtensionContext, "modelRegistry"> {
	cwd: string;
	sessionManager: {
		getSessionId: () => string;
	};
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: SubagentDetails | SubagentListDetails | SubagentInspectDetails | SubagentCtlDetails;
	isError?: boolean;
}

interface SubagentExecution {
	execute(toolCallId: string, invocation: SubagentInvocation, ctx: SubagentExecutionContext, signal?: AbortSignal): Promise<ToolResult>;
	executeControl(invocation: SubagentCtlInvocation, ctx: Pick<ExtensionContext, "modelRegistry">, signal?: AbortSignal): Promise<ToolResult>;
	kill(id: string): SubagentRun | undefined;
	steer(id: string, text: string): SubagentRun | { error: string };
	shutdown(): Promise<void>;
}

export function createSubagentExecution(pi: Pick<ExtensionAPI, "sendMessage">): SubagentExecution {
	const startTaskSummary = (id: string, task: string, ctx: SubagentExecutionContext) => {
		void summarizeTask(task, ctx).then((summary) => {
			if (summary) setRunTaskSummary(id, task, summary);
		}).catch(() => {});
	};

	const retainedSessionPaths = () => {
		const paths = new Set<string>();
		for (const entry of listRuns()) {
			if (entry.sessionPath) paths.add(entry.sessionPath);
		}
		for (const entry of listCompletedRuns()) {
			if (isResultSuccess(entry.result) && entry.sessionPath) {
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
		agents: AgentConfig[],
		defaultCwd: string,
		ctx: SubagentExecutionContext,
		makeDetails: ReturnType<typeof makeDetailsFactory>,
		reservedRegistryId?: string,
		sessionPath?: string,
		parentSessionId?: string,
		sourceRunId?: string,
		lineageId?: string,
		toolCallId?: string,
		signal?: AbortSignal,
	): Promise<ToolResult> => {
		let onSpawn: (id: string) => void;
		const spawned = new Promise<string>((resolve) => {
			onSpawn = resolve;
		});

		if (reservedRegistryId) startTaskSummary(reservedRegistryId, task, ctx);

		const runPromise = runAgent({
			cwd: defaultCwd,
			agents,
			agentName,
			task,
			taskCwd: cwd,
			sessionPath,
			parentSessionId,
			workingDirectory: defaultCwd,
			sourceRunId,
			lineageId,
			reservedRegistryId,
			signal,
			onSpawn: (id) => {
				if (toolCallId) bindToolCallRowInvalidate(toolCallId, id);
				if (!reservedRegistryId) startTaskSummary(id, task, ctx);
				onSpawn(id);
			},
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

		setRunPhase(raced.id, "background");
		return {
			content: [{
				type: "text",
				text: `Started subagent [${raced.id}] (${agentName}). The result will be delivered to you automatically as a new message when it finishes. Do NOT poll subagent_ctl or sleep. End your turn immediately.`,
			}],
			details: makeDetails("single")([makeRunningPlaceholder(agentName, task, agents, raced.id)]),
		};
	};

	const executeParallel = async (
		tasks: TaskSpec[],
		agents: AgentConfig[],
		defaultCwd: string,
		makeDetails: ReturnType<typeof makeDetailsFactory>,
		ctx: SubagentExecutionContext,
		parentSessionId: string,
		toolCallId: string,
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
		for (const p of placeholders) {
			bindToolCallRowInvalidate(toolCallId, p.registryId!);
			startTaskSummary(p.registryId!, p.task, ctx);
		}
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

		for (const placeholder of placeholders) setRunPhase(placeholder.registryId!, "background");
		return {
			content: [{
				type: "text",
				text: `Started ${tasks.length} parallel subagent(s). The combined result will be delivered to you automatically as a new message when all finish. Do NOT poll subagent_ctl or sleep. End your turn immediately.`,
			}],
			details: makeDetails("parallel")(placeholders),
		};
	};

	const execute = async (toolCallId: string, invocation: SubagentInvocation, ctx: SubagentExecutionContext, signal?: AbortSignal): Promise<ToolResult> => {
		const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, "both");
		const parentSessionId = ctx.sessionManager.getSessionId();
		const makeDetails = makeDetailsFactory(projectAgentsDir);

		if (invocation.action === "resume") {
			const reservation = reserveResumeRun(invocation.resume_id, invocation.task, parentSessionId, hasManagedSessionPath, onResumeKill);
			if ("error" in reservation) {
				return {
					content: [{ type: "text", text: reservation.error }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}
			const source = reservation.source;
			return executeSingle(
				source.agent,
				invocation.task,
				undefined,
				agents,
				source.workingDirectory ?? ctx.cwd,
				ctx,
				makeDetails,
				reservation.run.id,
				source.sessionPath,
				parentSessionId,
				source.id,
				source.lineageId,
				toolCallId,
				signal,
			);
		}

		if (invocation.action === "run_parallel") {
			return executeParallel(
				invocation.tasks,
				agents,
				ctx.cwd,
				makeDetails,
				ctx,
				parentSessionId,
				toolCallId,
				signal,
			);
		}
		return executeSingle(
			invocation.agent,
			invocation.task,
			invocation.cwd,
			agents,
			ctx.cwd,
			ctx,
			makeDetails,
			undefined,
			undefined,
			parentSessionId,
			undefined,
			undefined,
			toolCallId,
			signal,
		);
	};

	const kill = (id: string) => {
		const entry = getRun(id);
		entry?.kill();
		return entry;
	};
	const steer = (id: string, text: string) => {
		const entry = getRun(id);
		if (entry) {
			entry.steer(text);
			return entry;
		}
		if (listCompletedRuns().some((run) => run.id === id)) {
			return { error: `Subagent [${id}] already finished. Use the subagent tool with { action: "resume", resume_id: "${id}", task } instead.` };
		}
		return { error: `No running subagent with id '${id}' (it may have already finished).` };
	};

	return {
		execute,
		async executeControl(invocation, ctx, signal) {
			if (invocation.action === "list") {
				const runs = listRuns();
				const details: SubagentListDetails = {
					action: "list",
					runs: runs.map(({ id, agent, taskSummary, startedAt }) => ({ id, agent, taskSummary, startedAt })),
				};
				return { content: [{ type: "text", text: formatSubagentList(runs) }], details };
			}
			if (invocation.action === "inspect") {
				const live = getRun(invocation.id);
				const completed = live ? undefined : listCompletedRuns().find((run) => run.id === invocation.id);
				const entry = live ?? completed;
				if (!entry) {
					const details: SubagentInspectDetails = { action: "inspect", id: invocation.id };
					return {
						content: [{ type: "text", text: `No subagent with id '${invocation.id}' found.` }],
						details,
					};
				}
				const activitySummary = await summarizeActivity(entry.task, entry.result.messages, ctx, signal)
					?? fallbackActivitySummary(entry.result);
				const status = live ? "running" : "completed";
				const details: SubagentInspectDetails = {
					action: "inspect",
					id: invocation.id,
					result: {
						id: entry.id,
						agent: entry.agent,
						task: entry.task,
						...(entry.taskSummary ? { taskSummary: entry.taskSummary } : {}),
						activitySummary,
						startedAt: entry.startedAt,
						...(completed ? { finishedAt: completed.finishedAt } : {}),
						status,
						result: entry.result,
					},
				};
				return {
					content: [{ type: "text", text: `Subagent [${entry.id}] (${entry.agent}) is ${status}.\n\nActivity: ${activitySummary}` }],
					details,
				};
			}
			if (invocation.action === "kill") {
				const entry = kill(invocation.id);
				if (!entry) {
					const details: SubagentCtlDetails = { action: "kill", id: invocation.id };
					return {
						content: [{ type: "text", text: `No running subagent with id '${invocation.id}' (it may have already finished).` }],
						details,
					};
				}
				const details: SubagentCtlDetails = { action: "kill", id: entry.id, agent: entry.agent };
				return { content: [{ type: "text", text: `Killed subagent [${entry.id}] (${entry.agent}).` }], details };
			}
			const entry = steer(invocation.id, invocation.text);
			if ("error" in entry) {
				const details: SubagentCtlDetails = { action: "steer", id: invocation.id };
				return { content: [{ type: "text", text: entry.error }], details };
			}
			const details: SubagentCtlDetails = { action: "steer", id: entry.id, agent: entry.agent };
			return { content: [{ type: "text", text: `Steered subagent [${entry.id}] (${entry.agent}).` }], details };
		},
		kill,
		steer,
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
			clearSessionState();
		},
	};
}

function fallbackActivitySummary(result: SingleResult): string {
	const compact = (text: string) => {
		const activity = text.replace(/\s+/g, " ").trim();
		return activity.length <= 300 ? activity : `${activity.slice(0, 299)}…`;
	};
	const partial = result.partialMessage?.content.find((part) => part.type === "text" && part.text.trim());
	if (partial?.type === "text") return compact(partial.text);
	const latest = result.messages.at(-1);
	if (latest?.role === "assistant") {
		const text = latest.content.find((part) => part.type === "text" && part.text.trim());
		if (text?.type === "text") return compact(text.text);
		const toolCall = latest.content.find((part) => part.type === "toolCall");
		if (toolCall?.type === "toolCall") return `Calling ${toolCall.name}.`;
	}
	if (latest?.role === "toolResult") return `Received result from ${latest.toolName}.`;
	const summary = getResultSummaryText(result);
	return summary === "(no output)" ? "No activity yet." : compact(summary);
}

async function mapConcurrent<TIn, TOut>(
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
