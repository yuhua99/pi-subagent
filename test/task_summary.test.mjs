import assert from "node:assert/strict";
import { test } from "node:test";
import { formatActivityContext, parseTaskSummaryConfig } from "../tool/task_summary.ts";

test("task summary config rejects a missing file", () => {
  assert.equal(parseTaskSummaryConfig(undefined), undefined);
});

test("task summary config rejects invalid JSON", () => {
  assert.equal(parseTaskSummaryConfig("{"), undefined);
});

test("task summary config rejects invalid model strings", () => {
  assert.equal(parseTaskSummaryConfig('{"summaryModel":"provider"}'), undefined);
  assert.equal(parseTaskSummaryConfig('{"summaryModel":"/model"}'), undefined);
  assert.equal(parseTaskSummaryConfig('{"summaryModel":"provider/"}'), undefined);
});

test("task summary config accepts provider and model ids with slashes", () => {
  assert.deepEqual(parseTaskSummaryConfig('{"summaryModel":"provider/model"}'), {
    provider: "provider",
    id: "model",
  });
  assert.deepEqual(parseTaskSummaryConfig('{"summaryModel":"openrouter/anthropic/claude-x"}'), {
    provider: "openrouter",
    id: "anthropic/claude-x",
  });
});

test("activity context formats assistant text, tool calls, and tool results", () => {
  const context = formatActivityContext("Inspect the repository", [
    { role: "assistant", content: [{ type: "text", text: "I will inspect the files." }] },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "tool/task_summary.ts" },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "call-1",
      isError: false,
      content: [{ type: "text", text: "export function summarizeTask" }],
    },
  ]);

  assert.match(context, /Task:\nInspect the repository/);
  assert.match(context, /assistant: I will inspect the files\./);
  assert.match(context, /tool call: read\(path=tool\/task_summary\.ts\)/);
  assert.match(context, /tool result: export function summarizeTask/);
});

test("activity context keeps only the latest ten messages and is bounded", () => {
  const messages = Array.from({ length: 11 }, (_, index) => ({
    role: "assistant",
    content: [{ type: "text", text: `${index}:${"x".repeat(2_000)}` }],
  }));
  const context = formatActivityContext("t".repeat(3_000), messages);

  assert.match(context, /Task:\nt+/);
  assert.doesNotMatch(context, /(?:^|\n)assistant: 0:x/);
  for (let index = 1; index <= 10; index++) {
    assert.match(context, new RegExp(`${index}:x`));
  }
  assert.ok(context.length <= 6_000);
});
