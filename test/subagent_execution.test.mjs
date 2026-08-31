import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  clearSessionState,
  completeRun,
  listRuns,
  registerRun,
  reserveResumeRun,
  setRunPendingQuestion,
} from "../execution/registry.ts";
import { createSubagentExecution } from "../execution/execution.ts";
import { makeResult, makeRun } from "./fixtures/run.mjs";

test("steer rejects completed run ids", () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(makeRun());
  completeRun(run.id, makeResult({ status: "ok" }));

  assert.deepEqual(execution.steer(run.id, "continue"), {
    error: `Subagent [${run.id}] already finished. Use the subagent tool with { requests: [{ action: "resume", resume_id: "${run.id}", task }] } instead.`,
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

test("mixed requests roll back earlier resume reservations when a later lineage conflicts", async () => {
  clearSessionState();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-execution-"));
  const sessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionPath, "{}\n");
  const source = registerRun(
    makeRun({
      agent: "worker",
      task: "first",
      parentSessionId: "parent",
      sessionPath,
    }),
  );
  completeRun(source.id, makeResult({ status: "ok" }));
  let sentMessages = 0;
  const execution = createSubagentExecution({ sendMessage: () => sentMessages++ }, () => [
    {
      name: "worker",
      description: "",
      systemPrompt: "",
      source: "user",
      filePath: "",
    },
  ]);

  const response = await execution.execute(
    "mixed-resume",
    {
      requests: [
        { action: "run", agent: "worker", task: "new work", intent: "Start new work" },
        { action: "resume", resume_id: source.id, task: "first follow up", intent: "Continue" },
        {
          action: "resume",
          resume_id: source.id,
          task: "conflicting follow up",
          intent: "Conflict",
        },
      ],
    },
    {
      ...summaryContext,
      cwd: dir,
      sessionManager: { getSessionId: () => "parent" },
    },
  );

  assert.match(response.content[0].text, /another resume is already running/);
  assert.deepEqual(response.details, { results: [] });
  assert.equal(sentMessages, 0);
  assert.equal(listRuns().length, 0);

  const retry = reserveResumeRun(source.id, "retry", "parent", fs.existsSync, () => {});
  assert.equal("error" in retry, false);
  if (!("error" in retry)) completeRun(retry.run.id, makeResult({ status: "ok" }));
  clearSessionState();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("answer rejects unknown run ids", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});

  const response = await execution.executeControl(
    { action: "answer", id: "zzzz", text: "continue" },
    summaryContext,
  );

  assert.equal(
    response.content[0].text,
    "No running subagent with id 'zzzz' (it may have already finished).",
  );
  assert.deepEqual(response.details, { action: "answer", id: "zzzz" });
  clearSessionState();
});

test("answer rejects runs without a pending question", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(makeRun());

  const response = await execution.executeControl(
    { action: "answer", id: run.id, text: "continue" },
    summaryContext,
  );

  assert.equal(response.content[0].text, `Subagent [${run.id}] (a) has no pending question.`);
  assert.deepEqual(response.details, { action: "answer", id: run.id });
  clearSessionState();
});

test("answer resolves a pending question", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(makeRun());
  let pending;
  const question = new Promise((resolve, reject) => {
    pending = { resolve, reject };
  });
  setRunPendingQuestion(run.id, {
    question: "Should I continue?",
    resolve: pending.resolve,
    reject: pending.reject,
  });

  const response = await execution.executeControl(
    { action: "answer", id: run.id, text: "Continue with the tests." },
    summaryContext,
  );

  assert.equal(response.content[0].text, `Answered subagent [${run.id}] (a).`);
  assert.deepEqual(response.details, { action: "answer", id: run.id, agent: "a" });
  assert.equal(await question, "Continue with the tests.");
  clearSessionState();
});

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
      status: "ok",
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

test("list remains available for a pending question after a subagent starts", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(makeRun());
  setRunPendingQuestion(run.id, {
    question: "Which file should I edit?",
    resolve: () => {},
    reject: () => {},
  });
  execution.markSpawned();

  const response = await execution.executeControl({ action: "list" }, summaryContext);

  assert.match(response.content[0].text, new RegExp(`waiting_for_answer: \\[${run.id}\\] a: Which file should I edit\\?`));
  assert.equal(response.details.results[0].registryId, run.id);
  clearSessionState();
});

test("inspect remains available and shows a pending question after a subagent starts", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(makeRun());
  setRunPendingQuestion(run.id, {
    question: "Which file should I edit?",
    resolve: () => {},
    reject: () => {},
  });
  execution.markSpawned();

  const response = await execution.executeControl(
    { action: "inspect", id: run.id },
    summaryContext,
  );

  assert.match(
    response.content[0].text,
    new RegExp(`Subagent \\[${run.id}\\] \\(a\\) is waiting_for_answer\\.\\n\\nQuestion: Which file should I edit\\?`),
  );
  assert.equal(response.details.result.status, "waiting_for_answer");
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
