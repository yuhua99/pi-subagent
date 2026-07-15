import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getFinalAssistantText,
  getResultSummaryText,
  processPiEvent,
  processPiJsonLine,
} from "../runner-events.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function makeResult() {
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
  };
}

test("repro: captures final assistant output from agent_end after non-zero tool exit", async () => {
  const fixturePath = path.join(testDir, "fixtures", "agent-end-error-only.jsonl");
  const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");
  const result = makeResult();

  for (const line of lines) {
    processPiJsonLine(line, result);
  }

  result.exitCode = 1;

  assert.equal(result.messages.length, 2);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(result.usage.turns, 2);
  assert.equal(
    getFinalAssistantText(result.messages),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
  assert.equal(
    getResultSummaryText(result),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
});

test("deduplicates assistant messages repeated across message_end, turn_end, and agent_end", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Still here" }],
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  };

  const result = makeResult();
  processPiEvent({ type: "message_end", message }, result);
  processPiEvent({ type: "turn_end", message, toolResults: [] }, result);
  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 1);
  assert.equal(result.usage.output, 2);
  assert.equal(result.sawAgentEnd, true);
});

test("message_update stores the snapshot on partialMessage and returns 'stream'", () => {
  const result = makeResult();
  const snapshot = {
    role: "assistant",
    content: [{ type: "text", text: "partial" }],
    timestamp: 1,
  };

  const ret = processPiEvent({ type: "message_update", message: snapshot }, result);

  assert.equal(ret, "stream");
  assert.equal(result.partialMessage, snapshot);
  assert.equal(result.messages.length, 0);
  assert.equal(result.usage.turns, 0);
});

test("subsequent message_update replaces the snapshot", () => {
  const result = makeResult();
  const first = { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 1 };
  const second = { role: "assistant", content: [{ type: "text", text: "ab" }], timestamp: 2 };

  processPiEvent({ type: "message_update", message: first }, result);
  const ret = processPiEvent({ type: "message_update", message: second }, result);

  assert.equal(ret, "stream");
  assert.equal(result.partialMessage, second);
  assert.equal(result.messages.length, 0);
});

test("message_end clears partialMessage and returns 'status'", () => {
  const result = makeResult();
  const partial = { role: "assistant", content: [{ type: "text", text: "par" }], timestamp: 1 };
  const finalMsg = {
    role: "assistant",
    content: [{ type: "text", text: "partial done" }],
    timestamp: 2,
  };

  processPiEvent({ type: "message_update", message: partial }, result);
  const ret = processPiEvent({ type: "message_end", message: finalMsg }, result);

  assert.equal(ret, "status");
  assert.equal(result.partialMessage, undefined);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0], finalMsg);
});

test("duplicate turn_end after message_end still returns 'status' without double-counting", () => {
  const result = makeResult();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    usage: {
      input: 5,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  };

  const endRet = processPiEvent({ type: "message_end", message }, result);
  const turnRet = processPiEvent({ type: "turn_end", message, toolResults: [] }, result);

  assert.equal(endRet, "status");
  assert.equal(turnRet, "status");
  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 5);
  assert.equal(result.usage.output, 7);
  assert.equal(result.partialMessage, undefined);
});

test("agent_end with all-duplicate messages returns 'status' and sets sawAgentEnd", () => {
  const result = makeResult();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    timestamp: 1,
  };

  processPiEvent({ type: "message_end", message }, result);
  const ret = processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(ret, "status");
  assert.equal(result.sawAgentEnd, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.partialMessage, undefined);
});

test("non-zero exit code does not hide the final assistant text", () => {
  const result = makeResult();
  result.exitCode = 1;
  result.errorMessage = "Command exited with code 1";
  result.stderr = "stderr noise that should be a fallback only";
  result.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "No matches found" }],
    timestamp: 1,
  });

  assert.equal(getResultSummaryText(result), "No matches found");
});

test("stderr remains a fallback only for error results", () => {
  const okResult = makeResult();
  okResult.exitCode = 0;
  okResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(okResult), "(no output)");

  const failedResult = makeResult();
  failedResult.exitCode = 1;
  failedResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(failedResult), "warning on stderr");
});
