import test from "node:test";
import assert from "node:assert/strict";
import { excludeSubagentExtensions, processSessionEvent } from "../runner.ts";
import { getFinalAssistantText, isResultError, isResultSuccess, normalizeCompletedResult } from "../types.ts";

function makeResult(overrides = {}) {
	return {
		agent: "oracle",
		agentSource: "user",
		task: "repro",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		...overrides,
	};
}

test("normalizeCompletedResult keeps intermediate assistant output as a failure without agent_end", () => {
	const result = makeResult({
		exitCode: 1,
		stopReason: "error",
		errorMessage: "Command exited with code 1",
		stderr: "Command exited with code 1",
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: "Let me check that for you." }],
			timestamp: 1,
		}],
	});

	normalizeCompletedResult(result, false);

	assert.equal(result.exitCode, 1);
	assert.equal(isResultSuccess(result), false);
	assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult treats a clean completed transcript as success", () => {
	const result = makeResult({
		exitCode: 1,
		stderr: "Command exited with code 1",
		sawAgentEnd: true,
		messages: [{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "No matches found; exit code 1 was expected." }],
			timestamp: 1,
		}],
	});

	normalizeCompletedResult(result, false);

	assert.equal(result.exitCode, 0);
	assert.equal(result.stopReason, undefined);
	assert.equal(isResultSuccess(result), true);
	assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult preserves provider errors with partial output", () => {
	const result = makeResult({
		exitCode: 0,
		stopReason: "error",
		errorMessage: "Provider failed",
		messages: [{
			role: "assistant",
			stopReason: "error",
			errorMessage: "Provider failed",
			content: [{ type: "text", text: "Partial answer" }],
			timestamp: 1,
		}],
	});

	normalizeCompletedResult(result, false);

	assert.equal(result.exitCode, 1);
	assert.equal(result.errorMessage, "Provider failed");
	assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult rejects length stops without final text", () => {
	const result = makeResult({
		exitCode: 0,
		stopReason: "length",
		messages: [{
			role: "assistant",
			stopReason: "length",
			content: [],
			timestamp: 1,
		}],
	});

	normalizeCompletedResult(result, false);

	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage, /output token limit/);
});

test("normalizeCompletedResult preserves semantic completion after an abort", () => {
	const result = makeResult({
		exitCode: 130,
		stopReason: "aborted",
		errorMessage: "Subagent was aborted.",
		sawAgentEnd: true,
		messages: [{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Done." }],
			timestamp: 1,
		}],
	});

	normalizeCompletedResult(result, true);

	assert.equal(result.exitCode, 0);
	assert.equal(result.stopReason, undefined);
	assert.equal(result.errorMessage, undefined);
});

test("getFinalAssistantText falls back past a non-text final assistant message", () => {
	assert.equal(getFinalAssistantText([
		{ role: "assistant", content: [{ type: "text", text: "Completed work." }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }], timestamp: 2 },
	]), "Completed work.");
});

test("processSessionEvent streams partial messages and deduplicates transcript usage", () => {
	const result = makeResult();
	const assistant = {
		role: "assistant",
		model: "test-model",
		stopReason: "stop",
		content: [{ type: "text", text: "Done." }],
		usage: {
			input: 3,
			output: 5,
			cacheRead: 7,
			cacheWrite: 11,
			totalTokens: 26,
			cost: { total: 0.25 },
		},
		timestamp: 2,
	};
	const toolResult = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 3,
	};

	assert.equal(processSessionEvent(result, {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "Do" }], timestamp: 1 },
	}), "stream");
	assert.equal(result.partialMessage.content[0].text, "Do");
	assert.equal(processSessionEvent(result, { type: "message_end", message: assistant }), "status");
	assert.equal(processSessionEvent(result, {
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "read",
		result: { content: toolResult.content },
		isError: false,
	}), "status");
	processSessionEvent(result, { type: "message_end", message: toolResult });
	processSessionEvent(result, { type: "turn_end", message: assistant, toolResults: [toolResult] });
	assert.equal(processSessionEvent(result, { type: "agent_end", messages: [assistant, toolResult] }), "status");

	assert.equal(result.partialMessage, undefined);
	assert.deepEqual(result.messages.map((message) => message.role), ["assistant", "toolResult"]);
	assert.equal(result.messages[1], toolResult);
	assert.deepEqual(result.usage, {
		input: 3,
		output: 5,
		cacheRead: 7,
		cacheWrite: 11,
		cost: 0.25,
		contextTokens: 26,
		turns: 1,
	});
	assert.equal(result.model, "test-model");
	assert.equal(result.stopReason, "stop");
	assert.equal(result.sawAgentEnd, true);
});

test("processSessionEvent records delivered steers but excludes the initial task prompt", () => {
	const result = makeResult();
	const initialTask = { role: "user", content: [{ type: "text", text: "Task: repro" }], timestamp: 1 };
	const steer = { role: "user", content: [{ type: "text", text: "Focus on tests." }], timestamp: 2 };
	const assistant = { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 3 };

	processSessionEvent(result, { type: "message_end", message: initialTask });
	processSessionEvent(result, { type: "message_end", message: steer });
	processSessionEvent(result, { type: "agent_end", messages: [initialTask, steer, assistant] });

	assert.deepEqual(result.messages, [steer, assistant]);
});

test("excludeSubagentExtensions filters extensions that register subagent", () => {
	const subagentExtension = { tools: new Map([["subagent", {}]]) };
	const otherExtension = { tools: new Map([["other_tool", {}]]) };
	const base = { extensions: [subagentExtension, otherExtension], errors: [] };

	const filtered = excludeSubagentExtensions(base);

	assert.deepEqual(filtered.extensions, [otherExtension]);
	assert.equal(filtered.errors, base.errors);
});

test("excludeSubagentExtensions preserves an empty extension list", () => {
	const base = { extensions: [], errors: [] };

	assert.deepEqual(excludeSubagentExtensions(base), base);
});

