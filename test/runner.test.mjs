import test from "node:test";
import assert from "node:assert/strict";
import { getFinalAssistantText, isResultError, normalizeCompletedResult } from "../types.ts";

function makeResult(overrides = {}) {
  return {
    agent: "oracle",
    agentSource: "user",
    task: "repro",
    status: "running",
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

test("normalizeCompletedResult preserves provider errors with partial output", () => {
  const result = makeResult({
    stopReason: "error",
    errorMessage: "Provider failed",
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Provider failed",
        content: [{ type: "text", text: "Partial answer" }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result);

  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "Provider failed");
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult rejects length stops without final text", () => {
  const result = makeResult({
    stopReason: "length",
    messages: [
      {
        role: "assistant",
        stopReason: "length",
        content: [],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result);

  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /output token limit/);
});

test("normalizeCompletedResult reports a kill that produced no output", () => {
  const result = makeResult({ stopReason: "aborted" });

  normalizeCompletedResult(result, "killed");

  assert.equal(result.status, "killed");
  assert.equal(result.errorMessage, "Subagent was killed.");
  assert.equal(result.stderr, "Subagent was killed.");
  assert.equal(isResultError(result), true);
});

test("getFinalAssistantText falls back past a non-text final assistant message", () => {
  assert.equal(
    getFinalAssistantText([
      { role: "assistant", content: [{ type: "text", text: "Completed work." }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 2,
      },
    ]),
    "Completed work.",
  );
});
