import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupManagedSessions, createManagedResumeSessionFile } from "../session_files.ts";

test("resume sessions copy the source before appending", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-resume-"));
  const source = path.join(dir, "source.jsonl");
  fs.writeFileSync(source, "source\n");

  const resumed = createManagedResumeSessionFile("agent", source);
  fs.appendFileSync(resumed, "resumed\n");

  assert.equal(fs.readFileSync(source, "utf-8"), "source\n");
  assert.equal(fs.readFileSync(resumed, "utf-8"), "source\nresumed\n");
  cleanupManagedSessions([resumed]);
  assert.equal(fs.existsSync(resumed), true);
  cleanupManagedSessions();
  assert.equal(fs.existsSync(resumed), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("managed session cleanup retains active and successful paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-managed-"));
  const source = path.join(dir, "source.jsonl");
  fs.writeFileSync(source, "source\n");
  const running = createManagedResumeSessionFile("running", source);
  const successful = createManagedResumeSessionFile("successful", source);
  const unretained = createManagedResumeSessionFile("unretained", source);

  cleanupManagedSessions([running, successful]);
  assert.equal(fs.existsSync(running), true);
  assert.equal(fs.existsSync(successful), true);
  assert.equal(fs.existsSync(unretained), false);
  cleanupManagedSessions();
  fs.rmSync(dir, { recursive: true, force: true });
});
