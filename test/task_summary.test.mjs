import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskSummaryConfig } from "../task_summary.ts";

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
	assert.deepEqual(parseTaskSummaryConfig('{"summaryModel":"provider/model"}'), { provider: "provider", id: "model" });
	assert.deepEqual(parseTaskSummaryConfig('{"summaryModel":"openrouter/anthropic/claude-x"}'), { provider: "openrouter", id: "anthropic/claude-x" });
});
