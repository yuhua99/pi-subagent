import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  allocateManagedSessionDir,
  cleanupManagedSessions,
  hasManagedSessionPath,
  registerManagedSessionPath,
} from "../execution/session_files.ts";

test("managed session paths are registered in allocated agent directories", () => {
  const dir = allocateManagedSessionDir("agent");
  const sessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionPath, "session\n");

  assert.equal(registerManagedSessionPath(sessionPath), sessionPath);
  assert.equal(hasManagedSessionPath(sessionPath), true);
  cleanupManagedSessions([sessionPath]);
  assert.equal(fs.existsSync(sessionPath), true);
  cleanupManagedSessions();
  assert.equal(fs.existsSync(sessionPath), false);
});

test("managed session cleanup retains active and successful paths", () => {
  const runningDir = allocateManagedSessionDir("running");
  const successfulDir = allocateManagedSessionDir("successful");
  const unretainedDir = allocateManagedSessionDir("unretained");
  const running = path.join(runningDir, "session.jsonl");
  const successful = path.join(successfulDir, "session.jsonl");
  const unretained = path.join(unretainedDir, "session.jsonl");
  for (const sessionPath of [running, successful, unretained]) {
    fs.writeFileSync(sessionPath, "session\n");
    registerManagedSessionPath(sessionPath);
  }

  cleanupManagedSessions([running, successful]);
  assert.equal(fs.existsSync(running), true);
  assert.equal(fs.existsSync(successful), true);
  assert.equal(fs.existsSync(unretained), false);
  cleanupManagedSessions();
  assert.equal(fs.existsSync(running), false);
  assert.equal(fs.existsSync(successful), false);
});
