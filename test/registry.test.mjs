import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  attachRunSteer,
  clearSessionState,
  completeRun,
  listCompletedRuns,
  getRun,
  listRuns,
  registerRun,
  reserveResumeRun,
  setRunTaskSummary,
  cancelResumeReservation,
  updateRun,
} from "../execution/registry.ts";
import { makeResult, makeRun } from "./fixtures/run.mjs";

function cleanup() {
  for (const e of listRuns()) completeRun(e.id, e.result);
}

test("kill closure fires; getRun returns undefined after completeRun", () => {
  cleanup();
  let killed = false;
  const run = registerRun(
    makeRun({
      kill: () => {
        killed = true;
      },
    }),
  );
  getRun(run.id).kill();
  assert.equal(killed, true);
  completeRun(run.id, makeResult({ status: "ok" }));
  assert.equal(getRun(run.id), undefined);
  assert.equal(listRuns().length, 0);
});

test("steer with an attached callback delivers immediately and records history", () => {
  cleanup();
  const delivered = [];
  const run = registerRun(makeRun());
  attachRunSteer(run.id, (text) => {
    delivered.push(text);
  });
  run.steer("focus on tests");
  assert.deepEqual(delivered, ["focus on tests"]);
  assert.deepEqual(
    run.steers.map(({ text }) => text),
    ["focus on tests"],
  );
  assert.equal(typeof run.steers[0].at, "number");
  completeRun(run.id, makeResult({ status: "ok" }));
  assert.deepEqual(listCompletedRuns()[0].steers, run.steers);
  cleanup();
});

test("steer before callback attachment queues and flushes FIFO", () => {
  cleanup();
  const delivered = [];
  const run = registerRun(makeRun());
  run.steer("first");
  run.steer("second");
  attachRunSteer(run.id, (text) => {
    delivered.push(text);
  });
  assert.deepEqual(delivered, ["first", "second"]);
  assert.deepEqual(
    run.steers.map(({ text }) => text),
    ["first", "second"],
  );
  cleanup();
});

test("registerRun stamps its id onto the result and keeps that object stable", () => {
  cleanup();
  const result = makeResult();
  const run = registerRun(makeRun({ result }));
  assert.equal(result.registryId, run.id);
  updateRun(run.id, { startedAt: 42 });
  assert.equal(getRun(run.id).result, result);
  assert.equal(getRun(run.id).startedAt, 42);
  cleanup();
});

test("setRunTaskSummary stores a live run title on its result", () => {
  clearSessionState();
  const run = registerRun(makeRun());
  setRunTaskSummary(run.id, run.task, "Live title");
  assert.equal(run.result.taskSummary, "Live title");
  clearSessionState();
});

test("setRunTaskSummary stores a late completed title on its result", () => {
  clearSessionState();
  const run = registerRun(makeRun());
  completeRun(run.id, makeResult({ status: "ok" }));
  setRunTaskSummary(run.id, run.task, "Completed title");
  const completed = listCompletedRuns()[0];
  assert.equal(completed.result.taskSummary, "Completed title");
  clearSessionState();
});

test("completeRun copies a live task summary onto its result", () => {
  clearSessionState();
  const run = registerRun(makeRun());
  setRunTaskSummary(run.id, run.task, "Completed title");
  completeRun(run.id, makeResult({ status: "ok" }));
  const completed = listCompletedRuns()[0];
  assert.equal(completed.result.taskSummary, "Completed title");
  clearSessionState();
});

test("completeRun preserves an existing result task summary without a live run", () => {
  clearSessionState();
  const result = makeResult({ status: "failed", taskSummary: "Existing title" });
  completeRun("dead", result);
  assert.equal(listCompletedRuns()[0].result.taskSummary, "Existing title");
  clearSessionState();
});

test("clearSessionState clears session-scoped run and resume state", () => {
  cleanup();
  const source = registerRun(
    makeRun({
      task: "first",
      parentSessionId: "parent",
      sessionPath: "session",
    }),
  );
  completeRun(source.id, makeResult({ status: "ok" }));
  const reservation = reserveResumeRun(
    source.id,
    "follow up",
    "parent",
    () => true,
    () => {},
  );
  assert.equal("error" in reservation, false);
  assert.equal(listRuns().length, 1);

  clearSessionState();
  assert.equal(listRuns().length, 0);
  assert.equal(listCompletedRuns().length, 0);
});

test("resume reservations require a successful completed run in the same parent session", () => {
  cleanup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
  const sessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionPath, "{}\n");
  const source = registerRun(
    makeRun({
      task: "first",
      parentSessionId: "parent",
      sessionPath,
      workingDirectory: dir,
    }),
  );
  completeRun(source.id, makeResult({ status: "ok" }));

  const reservation = reserveResumeRun(source.id, "follow up", "parent", fs.existsSync, () => {});
  assert.equal("error" in reservation, false);
  if ("error" in reservation) return;
  assert.equal(reservation.source.id, source.id);
  assert.equal(reservation.run.sourceRunId, source.id);
  assert.equal(reservation.run.lineageId, source.id);
  assert.equal(
    reserveResumeRun(source.id, "parallel follow up", "parent", fs.existsSync, () => {}).error !==
      undefined,
    true,
  );

  completeRun(reservation.run.id, makeResult({ status: "failed" }));
  const retry = reserveResumeRun(source.id, "retry", "parent", fs.existsSync, () => {});
  assert.equal("error" in retry, false);
  if ("error" in retry) return;
  completeRun(retry.run.id, makeResult({ status: "ok" }));
  const descendant = listCompletedRuns().find((entry) => entry.id === retry.run.id);
  assert.equal(descendant?.sourceRunId, source.id);
  const second = reserveResumeRun(
    retry.run.id,
    "second follow up",
    "parent",
    fs.existsSync,
    () => {},
  );
  assert.equal("error" in second, false);
  if (!("error" in second)) completeRun(second.run.id, makeResult({ status: "ok" }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resume reservations reject failed, foreign-session, and missing-session runs", () => {
  cleanup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
  const sessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionPath, "{}\n");
  const source = registerRun(
    makeRun({
      task: "first",
      parentSessionId: "parent",
      sessionPath,
    }),
  );
  completeRun(source.id, makeResult({ status: "failed" }));
  assert.match(
    reserveResumeRun(source.id, "follow up", "parent", fs.existsSync, () => {}).error,
    /successfully completed/,
  );

  const foreign = registerRun(
    makeRun({
      task: "foreign",
      parentSessionId: "other",
      sessionPath,
    }),
  );
  completeRun(foreign.id, makeResult({ status: "ok" }));
  assert.match(
    reserveResumeRun(foreign.id, "follow up", "parent", fs.existsSync, () => {}).error,
    /different parent/,
  );

  const missing = registerRun(
    makeRun({
      task: "missing",
      parentSessionId: "parent",
      sessionPath: path.join(dir, "missing.jsonl"),
    }),
  );
  completeRun(missing.id, makeResult({ status: "ok" }));
  assert.match(
    reserveResumeRun(missing.id, "follow up", "parent", fs.existsSync, () => {}).error,
    /retain a session/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cancelResumeReservation rolls back a reserved resume and frees its lineage", () => {
  clearSessionState();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
  const sessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionPath, "{}\n");
  const source = registerRun(
    makeRun({
      task: "first",
      parentSessionId: "parent",
      sessionPath,
    }),
  );
  completeRun(source.id, makeResult({ status: "ok" }));

  const reservation = reserveResumeRun(source.id, "follow up", "parent", fs.existsSync, () => {});
  assert.equal("error" in reservation, false);
  if ("error" in reservation) return;
  assert.equal(cancelResumeReservation(reservation.run.id), true);
  assert.equal(getRun(reservation.run.id), undefined);
  assert.equal(
    listCompletedRuns().some((entry) => entry.id === reservation.run.id),
    false,
  );

  const retry = reserveResumeRun(source.id, "retry", "parent", fs.existsSync, () => {});
  assert.equal("error" in retry, false);
  if ("error" in retry) return;
  completeRun(retry.run.id, makeResult({ status: "ok" }));
  clearSessionState();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("killing a reserved resume removes it and releases its lineage lock", () => {
  cleanup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
  const sessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionPath, "{}\n");
  const source = registerRun(
    makeRun({
      task: "first",
      parentSessionId: "parent",
      sessionPath,
    }),
  );
  completeRun(source.id, makeResult({ status: "ok" }));

  let killCalls = 0;
  const onKill = (id) => {
    killCalls++;
    const entry = getRun(id);
    if (entry) completeRun(id, { ...entry.result, status: "killed" });
  };
  const reservation = reserveResumeRun(source.id, "follow up", "parent", fs.existsSync, onKill);
  assert.equal("error" in reservation, false);
  if ("error" in reservation) return;
  reservation.run.kill();
  reservation.run.kill();
  assert.equal(killCalls, 2);
  assert.equal(getRun(reservation.run.id), undefined);
  assert.equal(
    listCompletedRuns().find((entry) => entry.id === reservation.run.id)?.result.status,
    "killed",
  );

  const retry = reserveResumeRun(source.id, "retry", "parent", fs.existsSync, onKill);
  assert.equal("error" in retry, false);
  if (!("error" in retry)) completeRun(retry.run.id, makeResult({ status: "ok" }));
  fs.rmSync(dir, { recursive: true, force: true });
});
