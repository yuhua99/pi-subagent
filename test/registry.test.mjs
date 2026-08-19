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
  getLiveStatus,
  getRun,
  listRuns,
  notifyStatus,
  notifyStream,
  registerRun,
  registerToolCallInvalidator,
  reserveResumeRun,
  resolveLiveResult,
  setRunPhase,
  bindToolCallRowInvalidate,
  updateRun,
} from "../execution/registry.ts";
import { makeResult, makeRun } from "./fixtures/run.mjs";

function cleanup() {
  for (const e of listRuns()) completeRun(e.id, e.result);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("registerRun returns a run with a 4-hex id and stores the full task", () => {
  cleanup();
  const long = "x".repeat(200);
  const run = registerRun(makeRun({ agent: "scout", task: long, startedAt: 1 }));
  assert.match(run.id, /^[0-9a-f]{4}$/);
  assert.equal(run.task, long);
  const list = listRuns();
  assert.equal(list.length, 1);
  assert.equal(list[0].agent, "scout");
  cleanup();
});

test("ids are unique across concurrent entries", () => {
  cleanup();
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    ids.add(registerRun(makeRun()).id);
  }
  assert.equal(ids.size, 50);
  assert.equal(listRuns().length, 50);
  cleanup();
});

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
  completeRun(run.id, makeResult({ exitCode: 0 }));
  assert.equal(getRun(run.id), undefined);
  assert.equal(listRuns().length, 0);
});

test("getRun returns undefined for unknown id", () => {
  cleanup();
  assert.equal(getRun("zzzz"), undefined);
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
  completeRun(run.id, makeResult({ exitCode: 0 }));
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

test("updateRun replaces result reference", () => {
  cleanup();
  const first = makeResult();
  const run = registerRun(makeRun({ result: first }));
  const second = makeResult({ exitCode: 0 });
  updateRun(run.id, { result: second });
  assert.equal(getRun(run.id).result, second);
  cleanup();
});

test("completeRun retains status subscribers for late updates until unsubscribed", () => {
  cleanup();
  const run = registerRun(makeRun());
  let calls = 0;
  const unsubscribe = run.onStatus(() => {
    calls++;
  });
  completeRun(run.id, makeResult({ exitCode: 0 }));
  assert.equal(calls, 1);
  notifyStatus(run.id);
  assert.equal(calls, 2);
  unsubscribe();
  notifyStatus(run.id);
  assert.equal(calls, 2);
});

test("onStatus and onStream unsubscribe works", async () => {
  cleanup();
  const run = registerRun(makeRun());
  let s = 0,
    m = 0;
  const off1 = run.onStatus(() => {
    s++;
  });
  const off2 = run.onStream(() => {
    m++;
  });
  notifyStatus(run.id);
  assert.equal(s, 1);
  off1();
  off2();
  notifyStatus(run.id);
  assert.equal(s, 1);
  notifyStream(run.id);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(m, 0);
  cleanup();
});

test("notifyStream coalesces rapid notifies into one callback", async () => {
  cleanup();
  const run = registerRun(makeRun());
  let calls = 0;
  run.onStream(() => {
    calls++;
  });
  notifyStream(run.id);
  notifyStream(run.id);
  notifyStream(run.id);
  assert.equal(calls, 0);
  await sleep(120);
  assert.equal(calls, 1);
  cleanup();
});

test("completeRun cancels a pending stream notification", async () => {
  cleanup();
  const run = registerRun(makeRun());
  let calls = 0;
  run.onStream(() => {
    calls++;
  });
  notifyStream(run.id);
  completeRun(run.id, makeResult({ exitCode: 0 }));
  await sleep(40);
  assert.equal(calls, 0);
});

test("bindToolCallRowInvalidate: single-slot, fired by notifyStatus and background completion", () => {
  cleanup();
  const run = registerRun(makeRun());
  let a = 0,
    b = 0;
  registerToolCallInvalidator("first", () => {
    a++;
  });
  registerToolCallInvalidator("second", () => {
    b++;
  });
  bindToolCallRowInvalidate("first", run.id);
  bindToolCallRowInvalidate("second", run.id);
  notifyStatus(run.id);
  assert.equal(a, 0);
  assert.equal(b, 1);
  completeRun(run.id, makeResult({ exitCode: 0 }));
  assert.equal(b, 1);

  const background = registerRun(makeRun());
  bindToolCallRowInvalidate("second", background.id);
  setRunPhase(background.id, "background");
  completeRun(background.id, makeResult({ exitCode: 0 }));
  assert.equal(b, 2);
});

test("tool call row invalidator handoff works in either registration order", () => {
  clearSessionState();
  const before = registerRun(makeRun());
  let beforeCalls = 0;
  registerToolCallInvalidator("before", () => {
    beforeCalls++;
  });
  bindToolCallRowInvalidate("before", before.id);
  notifyStatus(before.id);
  assert.equal(beforeCalls, 1);

  const after = registerRun(makeRun());
  let afterCalls = 0;
  bindToolCallRowInvalidate("after", after.id);
  registerToolCallInvalidator("after", () => {
    afterCalls++;
  });
  notifyStatus(after.id);
  assert.equal(afterCalls, 1);
  cleanup();
});

test("tool call row invalidator is handed off to every parallel member", () => {
  clearSessionState();
  const first = registerRun(makeRun());
  const second = registerRun(makeRun());
  let calls = 0;
  bindToolCallRowInvalidate("batch", first.id);
  bindToolCallRowInvalidate("batch", second.id);
  registerToolCallInvalidator("batch", () => {
    calls++;
  });
  notifyStatus(first.id);
  notifyStatus(second.id);
  assert.equal(calls, 2);
  cleanup();
});

test("background batch completion invalidates for each completed member", () => {
  clearSessionState();
  const first = registerRun(makeRun());
  const second = registerRun(makeRun());
  let calls = 0;
  registerToolCallInvalidator("background-batch", () => {
    calls++;
  });
  bindToolCallRowInvalidate("background-batch", first.id);
  bindToolCallRowInvalidate("background-batch", second.id);
  setRunPhase(first.id, "background");
  setRunPhase(second.id, "background");
  completeRun(first.id, makeResult({ exitCode: 0 }));
  assert.equal(calls, 1);
  completeRun(second.id, makeResult({ exitCode: 0 }));
  assert.equal(calls, 2);
});

test("resolveLiveResult is pure — accepts only one argument", () => {
  cleanup();
  assert.equal(resolveLiveResult.length, 1);
  const live = makeResult();
  assert.deepEqual(resolveLiveResult(live), { result: live, stale: false });
  const run = registerRun(makeRun({ result: makeResult({ exitCode: 0, agent: "done" }) }));
  const placeholder = makeResult({ registryId: run.id });
  const resolved = resolveLiveResult(placeholder);
  assert.equal(resolved.stale, false);
  assert.equal(resolved.result.agent, "done");
  cleanup();
});

test("getLiveStatus returns completed/running/stale correctly", () => {
  cleanup();
  assert.equal(getLiveStatus("zzzz").kind, "stale");
  const run = registerRun(makeRun());
  assert.equal(getLiveStatus(run.id).kind, "running");
  completeRun(run.id, makeResult({ exitCode: 0 }));
  assert.equal(getLiveStatus(run.id).kind, "completed");
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
  completeRun(source.id, makeResult({ exitCode: 0 }));
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
  assert.equal(getLiveStatus(source.id).kind, "stale");
});

test("completeRun works even when id is not in running (early-error path)", () => {
  cleanup();
  const r = makeResult({ exitCode: 1 });
  completeRun("dead", r);
  assert.equal(getLiveStatus("dead").kind, "completed");
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
  completeRun(source.id, makeResult({ exitCode: 0 }));

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

  completeRun(reservation.run.id, makeResult({ exitCode: 1 }));
  const retry = reserveResumeRun(source.id, "retry", "parent", fs.existsSync, () => {});
  assert.equal("error" in retry, false);
  if ("error" in retry) return;
  completeRun(retry.run.id, makeResult({ exitCode: 0 }));
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
  if (!("error" in second)) completeRun(second.run.id, makeResult({ exitCode: 0 }));
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
  completeRun(source.id, makeResult({ exitCode: 1 }));
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
  completeRun(foreign.id, makeResult({ exitCode: 0 }));
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
  completeRun(missing.id, makeResult({ exitCode: 0 }));
  assert.match(
    reserveResumeRun(missing.id, "follow up", "parent", fs.existsSync, () => {}).error,
    /retain a session/,
  );
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
  completeRun(source.id, makeResult({ exitCode: 0 }));

  let killCalls = 0;
  const onKill = (id) => {
    killCalls++;
    const entry = getRun(id);
    if (entry) completeRun(id, { ...entry.result, exitCode: 1, stopReason: "killed" });
  };
  const reservation = reserveResumeRun(source.id, "follow up", "parent", fs.existsSync, onKill);
  assert.equal("error" in reservation, false);
  if ("error" in reservation) return;
  reservation.run.kill();
  reservation.run.kill();
  assert.equal(killCalls, 2);
  assert.equal(getRun(reservation.run.id), undefined);
  assert.equal(
    listCompletedRuns().find((entry) => entry.id === reservation.run.id)?.result.stopReason,
    "killed",
  );

  const retry = reserveResumeRun(source.id, "retry", "parent", fs.existsSync, onKill);
  assert.equal("error" in retry, false);
  if (!("error" in retry)) completeRun(retry.run.id, makeResult({ exitCode: 0 }));
  fs.rmSync(dir, { recursive: true, force: true });
});
