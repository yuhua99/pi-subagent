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

test("mixed requests roll back earlier resume reservations when a later lineage conflicts", async () => {
  clearSessionState();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-execution-"));
  const sessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionPath, "{}\n");
  const previousHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
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
    {
      requests: [
        { action: "run", agent: "worker", task: "new work", title: "Start new work" },
        { action: "resume", resume_id: source.id, task: "first follow up", title: "Continue" },
        {
          action: "resume",
          resume_id: source.id,
          task: "conflicting follow up",
          title: "Conflict",
        },
      ],
    },
    { cwd: dir, sessionManager: { getSessionId: () => "parent" } },
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
  if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = previousHerdrEnv;
});

const pollRefusal =
  "Results arrive automatically. Never poll subagent_ctl; end your turn immediately.";

test("list is blocked after a subagent starts", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  execution.markSpawned();

  const response = execution.executeControl({ action: "list" });

  assert.equal(response.content[0].text, pollRefusal);
  assert.deepEqual(response.details, { action: "list", results: [] });
  clearSessionState();
});

test("agent start unblocks list", async () => {
  clearSessionState();
  const execution = createSubagentExecution({});
  const run = registerRun(makeRun());
  execution.markSpawned();
  execution.onAgentStart();

  const list = execution.executeControl({ action: "list" });

  assert.notEqual(list.content[0].text, pollRefusal);
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

  const killed = execution.executeControl({ action: "kill", id: run.id });
  const steered = execution.executeControl({ action: "steer", id: run.id, text: "continue" });

  assert.equal(killed.content[0].text, `Killed subagent [${run.id}] (a).`);
  assert.equal(kills, 1);
  assert.equal(steered.content[0].text, `Steered subagent [${run.id}] (a).`);
  assert.equal(run.steers[0].text, "continue");
  clearSessionState();
});
