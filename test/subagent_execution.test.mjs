import assert from "node:assert/strict";
import { test } from "node:test";
import { clearSessionState, completeRun, registerRun } from "../execution/registry.ts";
import { createSubagentExecution } from "../execution/execution.ts";
import { makeResult, makeRun } from "./fixtures/run.mjs";

test("steer rejects completed run ids", () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(makeRun());
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

const summaryContext = { modelRegistry: { find: () => undefined } };

test("inspect returns live state with heuristic activity", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const result = makeResult({
    partialMessage: {
      role: "assistant",
      content: [{ type: "text", text: "Reading the repository." }],
    },
  });
  const run = registerRun(makeRun({ result }));

  const response = await execution.executeControl(
    { action: "inspect", id: run.id },
    summaryContext,
  );

  assert.equal(
    response.content[0].text,
    `Subagent [${run.id}] (a) is running.\n\nActivity: Reading the repository.`,
  );
  assert.equal(response.details.result.status, "running");
  assert.equal(response.details.result.agent, "a");
  assert.equal(response.details.result.activitySummary, "Reading the repository.");
  clearSessionState();
});

test("inspect returns retained state with heuristic activity", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(makeRun());
  completeRun(
    run.id,
    makeResult({
      exitCode: 0,
      messages: [{ role: "assistant", content: [{ type: "text", text: "Completed the task." }] }],
    }),
  );

  const response = await execution.executeControl(
    { action: "inspect", id: run.id },
    summaryContext,
  );

  assert.equal(
    response.content[0].text,
    `Subagent [${run.id}] (a) is completed.\n\nActivity: Completed the task.`,
  );
  assert.equal(response.details.result.status, "completed");
  assert.equal(response.details.result.activitySummary, "Completed the task.");
  assert.equal(typeof response.details.result.finishedAt, "number");
  clearSessionState();
});

test("inspect returns the existing missing-run flow", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});

  const response = await execution.executeControl(
    { action: "inspect", id: "zzzz" },
    summaryContext,
  );

  assert.equal(response.content[0].text, "No subagent with id 'zzzz' found.");
  assert.deepEqual(response.details, { action: "inspect", id: "zzzz" });
  clearSessionState();
});

const pollRefusal =
  "Results arrive automatically. Never poll subagent_ctl; end your turn immediately.";

test("list is blocked after a subagent starts", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  execution.markSpawned();

  const response = await execution.executeControl({ action: "list" }, summaryContext);

  assert.equal(response.content[0].text, pollRefusal);
  assert.deepEqual(response.details, { action: "list", results: [] });
  clearSessionState();
});

test("inspect is blocked after a subagent starts", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(makeRun());
  execution.markSpawned();

  const response = await execution.executeControl(
    { action: "inspect", id: run.id },
    summaryContext,
  );

  assert.equal(response.content[0].text, pollRefusal);
  assert.deepEqual(response.details, { action: "inspect", id: run.id });
  clearSessionState();
});

test("agent start unblocks inspect and list", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(
    makeRun({
      result: makeResult({
        partialMessage: {
          role: "assistant",
          content: [{ type: "text", text: "Reading the repository." }],
        },
      }),
    }),
  );
  execution.markSpawned();
  execution.onAgentStart();

  const inspect = await execution.executeControl({ action: "inspect", id: run.id }, summaryContext);
  const list = await execution.executeControl({ action: "list" }, summaryContext);

  assert.equal(
    inspect.content[0].text,
    `Subagent [${run.id}] (a) is running.\n\nActivity: Reading the repository.`,
  );
  assert.notEqual(inspect.content[0].text, pollRefusal);
  assert.equal(list.details.action, "list");
  assert.equal(list.details.results[0].registryId, run.id);
  clearSessionState();
});

test("kill and steer remain available after a subagent starts", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  let kills = 0;
  const run = registerRun(makeRun({ kill: () => kills++ }));
  execution.markSpawned();

  const killed = await execution.executeControl({ action: "kill", id: run.id }, summaryContext);
  const steered = await execution.executeControl(
    { action: "steer", id: run.id, text: "continue" },
    summaryContext,
  );

  assert.equal(killed.content[0].text, `Killed subagent [${run.id}] (a).`);
  assert.equal(kills, 1);
  assert.equal(steered.content[0].text, `Steered subagent [${run.id}] (a).`);
  assert.equal(run.steers[0].text, "continue");
  clearSessionState();
});
