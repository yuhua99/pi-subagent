import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findSessionFile, readTranscript } from "../execution/transcript.ts";
import { makeResult } from "./fixtures/run.mjs";

function writeSession(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-transcript-"));
  const nested = path.join(dir, "--cwd--");
  fs.mkdirSync(nested);
  const file = path.join(nested, "2026_a1b2.jsonl");
  fs.writeFileSync(
    file,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"),
  );
  return { dir, file };
}

const message = (msg) => ({
  type: "message",
  id: "x",
  parentId: null,
  timestamp: "",
  message: msg,
});

test("findSessionFile picks the run's own session among others in its dir", () => {
  const { dir, file } = writeSession([{ type: "session", version: 3 }]);
  fs.writeFileSync(path.join(dir, "system-prompt.md"), "prompt");
  fs.writeFileSync(path.join(path.dirname(file), "2027_other.jsonl"), "");

  assert.equal(findSessionFile(dir, "a1b2"), file);
  assert.equal(findSessionFile(dir, "zzzz"), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readTranscript keeps new messages, skips the task prompt, and sums usage", () => {
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
    timestamp: 12,
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text: "file contents" }],
    timestamp: 13,
  };
  const steer = {
    role: "user",
    content: [{ type: "text", text: "Focus on tests." }],
    timestamp: 14,
  };
  const { dir, file } = writeSession([
    { type: "session", version: 3 },
    message({ role: "user", content: [{ type: "text", text: "Old task" }], timestamp: 1 }),
    message({ role: "assistant", content: [{ type: "text", text: "Old answer" }], timestamp: 2 }),
    message({ role: "system", sections: {}, timestamp: 10 }),
    message({ role: "user", content: [{ type: "text", text: "Task: new" }], timestamp: 11 }),
    message(assistant),
    message(toolResult),
    { type: "custom", customType: "x", data: {} },
    message(steer),
    '{"type":"message","mess',
  ]);
  const result = makeResult();

  readTranscript(result, file, 10);

  assert.deepEqual(result.messages, [assistant, toolResult, steer]);
  assert.deepEqual(result.usage, {
    input: 3,
    output: 5,
    cacheRead: 7,
    cacheWrite: 11,
    cost: 0.25,
    contextTokens: 26,
    turns: 1,
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
