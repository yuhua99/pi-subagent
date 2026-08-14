import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveForkSource } from "../delegation.ts";

test("resolveForkSource rejects a parent without a session file", () => {
  const result = resolveForkSource({
    getSessionFile: () => undefined,
    getLeafId: () => "leaf",
  });

  assert.deepEqual(result, {
    error: "Cannot use mode=\"fork\": fork requires a persisted parent session; the parent is running without a session file (--no-session). Restart without --no-session to use fork mode.",
  });
});

test("resolveForkSource rejects a missing parent session file", () => {
  const sourceSessionPath = path.join(os.tmpdir(), `pi-subagent-missing-${Date.now()}.jsonl`);
  const result = resolveForkSource({
    getSessionFile: () => sourceSessionPath,
    getLeafId: () => "leaf",
  });

  assert.deepEqual(result, {
    error: `Cannot use mode="fork": parent session file does not exist: ${sourceSessionPath}. Wait for it to persist before forking.`,
  });
});

test("resolveForkSource rejects a parent with no entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-fork-source-"));
  const sourceSessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sourceSessionPath, "session\n");

  const result = resolveForkSource({
    getSessionFile: () => sourceSessionPath,
    getLeafId: () => null,
  });

  assert.deepEqual(result, {
    error: "Cannot use mode=\"fork\": parent session has no entries to fork from. Add a session entry before forking.",
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveForkSource returns a persisted parent path and leaf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-fork-source-"));
  const sourceSessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sourceSessionPath, "session\n");

  const result = resolveForkSource({
    getSessionFile: () => sourceSessionPath,
    getLeafId: () => "leaf",
  });

  assert.deepEqual(result, { sourceSessionPath, leafId: "leaf" });
  fs.rmSync(dir, { recursive: true, force: true });
});
