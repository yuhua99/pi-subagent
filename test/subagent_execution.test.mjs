import assert from "node:assert/strict";
import { test } from "node:test";
import { clearSessionState, completeRun, registerRun } from "../registry.ts";
import { createSubagentExecution } from "../subagent_execution.ts";

function makeResult(overrides = {}) {
	return {
		agent: "a",
		agentSource: "user",
		task: "t",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

test("steer rejects completed run ids", () => {
	clearSessionState();
	const execution = createSubagentExecution({});
	const run = registerRun({ agent: "a", task: "t", pid: undefined, startedAt: 0, kill: () => {}, result: makeResult() });
	completeRun(run.id, makeResult({ exitCode: 0 }));

	assert.deepEqual(execution.steer(run.id, "continue"), {
		error: `Subagent [${run.id}] already finished. Use the subagent tool with { action: "resume", resume_id: "${run.id}", task } instead.`,
	});
	clearSessionState();
});

test("steer rejects unknown run ids", () => {
	clearSessionState();
	const execution = createSubagentExecution({});

	assert.deepEqual(execution.steer("zzzz", "continue"), {
		error: "No running subagent with id 'zzzz' (it may have already finished).",
	});
	clearSessionState();
});
