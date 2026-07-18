import test from "node:test";
import assert from "node:assert/strict";
import { buildPiArgs } from "../runner.ts";
import { isResultError, isResultSuccess, normalizeCompletedResult } from "../types.ts";

function makeResult(overrides = {}) {
  return {
    agent: "oracle",
    agentSource: "user",
    task: "repro",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...overrides,
  };
}

test("normalizeCompletedResult keeps intermediate assistant output as a failure without agent_end", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Let me check that for you." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult treats agent_end with final assistant output as semantic success", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "No matches found; exit code 1 was expected." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult preserves semantic completion when the process is aborted after agent_end", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "aborted",
    errorMessage: "Subagent was aborted.",
    stderr: "Subagent was aborted.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult keeps aborts as errors without semantic completion", () => {
  const result = makeResult({
    exitCode: 130,
    stderr: "",
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Subagent was aborted.");
  assert.equal(result.stderr, "Subagent was aborted.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("running results are neither success nor error", () => {
  const result = makeResult({ exitCode: -1 });

  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), false);
});

function makeBuildOptions(overrides = {}) {
  const { agent = {}, inherited = {}, ...options } = overrides;
  return {
    agent: {
      name: "oracle",
      description: "",
      source: "user",
      systemPrompt: "Persona",
      ...agent,
    },
    personaPromptPath: "/tmp/persona.md",
    task: "repro",
    delegationMode: "spawn",
    parentSystemPromptPath: null,
    inherited: {
      extensionArgs: [],
      alwaysProxy: [],
      fallbackModel: undefined,
      fallbackThinking: undefined,
      fallbackTools: undefined,
      fallbackNoTools: false,
      ...inherited,
    },
    ...options,
  };
}

test("buildPiArgs uses a managed session and persona append prompt in spawn mode", () => {
  const args = buildPiArgs(makeBuildOptions({ sessionPath: "/tmp/spawn.jsonl" }));

  assert.equal(args.includes("--no-session"), false);
  assert.equal(args[args.indexOf("--session") + 1], "/tmp/spawn.jsonl");
  assert.deepEqual(args.slice(-3), ["--append-system-prompt", "/tmp/persona.md", "Task: repro"]);
  assert.equal(args.includes("--system-prompt"), false);
});

test("buildPiArgs resumes using the existing native session path", () => {
  const args = buildPiArgs(makeBuildOptions({ sessionPath: "/tmp/resume.jsonl" }));

  assert.equal(args.includes("--no-session"), false);
  assert.equal(args[args.indexOf("--session") + 1], "/tmp/resume.jsonl");
});

test("buildPiArgs aligns fork mode with the parent prompt", () => {
  const args = buildPiArgs(makeBuildOptions({
    delegationMode: "fork",
    sessionPath: "/tmp/fork.jsonl",
    parentSystemPromptPath: "/tmp/parent.md",
    inherited: {
      alwaysProxy: ["--provider", "test", "--system-prompt", "old.md", "--verbose"],
    },
  }));

  assert.equal(args.includes("--append-system-prompt"), false);
  assert.equal(args.includes("old.md"), false);
  assert.deepEqual(args.slice(-5), [
    "--system-prompt",
    "/tmp/parent.md",
    "--no-context-files",
    "--no-skills",
    "Task instructions:\n\nPersona\n\nTask: repro",
  ]);
  assert.equal(args.includes("--session"), true);
  assert.equal(args[args.indexOf("--session") + 1], "/tmp/fork.jsonl");
});

test("buildPiArgs ignores agent tools and thinking overrides in fork mode", () => {
  const args = buildPiArgs(makeBuildOptions({
    delegationMode: "fork",
    agent: { tools: ["read"], thinking: "high" },
    inherited: { fallbackTools: "read,bash" },
  }));

  assert.equal(args.includes("--tools"), true);
  assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
  assert.equal(args.includes("read"), false);
  assert.equal(args.includes("--thinking"), false);
});

test("buildPiArgs degrades fork mode without a parent prompt", () => {
  const args = buildPiArgs(makeBuildOptions({ delegationMode: "fork" }));

  assert.equal(args.includes("--system-prompt"), false);
  assert.equal(args.includes("--no-context-files"), false);
  assert.equal(args.includes("--no-skills"), false);
});
