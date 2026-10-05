import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearSessionState,
  completeRun,
  listCompletedRuns,
  registerRun,
  reserveResumeRun,
} from "../execution/registry.ts";
import { recordRun, restoreRuns } from "../execution/run_history.ts";
import { makeResult, makeRun } from "./fixtures/run.mjs";

function recorder() {
  const entries = [];
  return {
    entries,
    appendEntry: (customType, data) =>
      entries.push({ type: "custom", customType, data: structuredClone(data) }),
  };
}

test("restoreRuns brings back a completed run that can still be resumed", () => {
  clearSessionState();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-history-"));
  const sessionPath = path.join(dir, "child.jsonl");
  fs.writeFileSync(sessionPath, "{}\n");
  const pi = recorder();
  const run = registerRun(makeRun({ agent: "worker", task: "audit", parentSessionId: "parent" }));
  recordRun(pi, run);
  run.sessionPath = sessionPath;
  recordRun(pi, completeRun(run.id, makeResult({ agent: "worker", task: "audit", status: "ok" })));
  clearSessionState();

  const entries = [{ type: "message", message: { role: "user" } }, ...pi.entries];
  restoreRuns(entries, entries);

  const [restored] = listCompletedRuns();
  assert.equal(listCompletedRuns().length, 1);
  assert.equal(restored.id, run.id);
  assert.equal(restored.result.status, "ok");
  assert.equal(restored.sessionPath, sessionPath);
  const resume = reserveResumeRun(run.id, "follow up", "parent", fs.existsSync, () => {});
  assert.equal("error" in resume, false);
  clearSessionState();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("restoreRuns lists a run that never recorded its end as killed", () => {
  clearSessionState();
  const pi = recorder();
  const run = registerRun(makeRun({ agent: "worker", task: "audit" }));
  recordRun(pi, run);
  clearSessionState();

  restoreRuns(pi.entries, pi.entries);

  const [restored] = listCompletedRuns();
  assert.equal(restored.id, run.id);
  assert.equal(restored.result.status, "killed");
  assert.equal(restored.result.errorMessage, "Subagent was killed when its parent session ended.");
  clearSessionState();
});

test("restoreRuns lists runs started on the branch with their latest outcome from any branch", () => {
  clearSessionState();
  const pi = recorder();
  const kept = registerRun(makeRun({ agent: "worker", task: "kept" }));
  const other = registerRun(makeRun({ agent: "worker", task: "other" }));
  recordRun(pi, kept);
  recordRun(pi, other);
  const [keptStart, otherStart] = pi.entries;
  recordRun(pi, completeRun(other.id, makeResult({ status: "ok" })));
  // kept settled after the user moved to another branch with /tree.
  recordRun(pi, completeRun(kept.id, makeResult({ status: "ok" })));
  clearSessionState();

  restoreRuns([keptStart], [keptStart, otherStart, ...pi.entries.slice(2)]);

  assert.deepEqual(
    listCompletedRuns().map((run) => [run.id, run.result.status]),
    [[kept.id, "ok"]],
  );
  clearSessionState();
});
