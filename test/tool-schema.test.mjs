import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REQUESTS,
  parseSubagentCtlInvocation,
  parseSubagentInvocation,
  SubagentCtlParams,
  SubagentParams,
} from "../tool/schema.ts";

test("subagent schema has a bounded request batch root", () => {
  assert.equal(SubagentParams.type, "object");
  assert.equal(SubagentParams.additionalProperties, false);
  assert.deepEqual(Object.keys(SubagentParams.properties), ["requests"]);
  assert.deepEqual(SubagentParams.required, ["requests"]);

  const requests = SubagentParams.properties.requests;
  assert.equal(requests.type, "array");
  assert.equal(requests.minItems, 1);
  assert.equal(requests.maxItems, MAX_REQUESTS);
  const [run, resume] = requests.items.anyOf;
  assert.equal(run.additionalProperties, false);
  assert.deepEqual(run.required, ["action", "agent", "task", "intent"]);
  assert.deepEqual(Object.keys(run.properties), ["action", "agent", "task", "intent", "cwd"]);
  assert.deepEqual(run.properties.action.enum, ["run"]);
  assert.equal(resume.additionalProperties, false);
  assert.deepEqual(resume.required, ["action", "resume_id", "task", "intent"]);
  assert.deepEqual(Object.keys(resume.properties), ["action", "resume_id", "task", "intent"]);
  assert.deepEqual(resume.properties.action.enum, ["resume"]);
});

test("subagent control schema has a required action", () => {
  assert.equal(SubagentCtlParams.type, "object");
  assert.equal(SubagentCtlParams.additionalProperties, false);
  assert.deepEqual(SubagentCtlParams.required, ["action"]);
  assert.deepEqual(
    SubagentCtlParams.properties.action.anyOf.map((schema) => schema.const),
    ["list", "kill", "steer", "answer", "inspect"],
  );
  assert.equal(SubagentCtlParams.properties.id.minLength, undefined);
});

test("subagent request validation accepts run, resume, mixed, intent, and cwd requests", () => {
  assert.deepEqual(
    parseSubagentInvocation({
      requests: [{ action: "run", agent: "a", task: "t", intent: "Review files" }],
    }),
    {
      requests: [{ action: "run", agent: "a", task: "t", intent: "Review files" }],
    },
  );
  assert.deepEqual(
    parseSubagentInvocation({
      requests: [{ action: "resume", resume_id: "id", task: "t", intent: "Continue review" }],
    }),
    { requests: [{ action: "resume", resume_id: "id", task: "t", intent: "Continue review" }] },
  );
  assert.deepEqual(
    parseSubagentInvocation({
      requests: [
        { action: "run", agent: "a", task: "t", intent: "review", cwd: "/tmp" },
        { action: "resume", resume_id: "id", task: "follow up", intent: "continue" },
      ],
    }),
    {
      requests: [
        { action: "run", agent: "a", task: "t", intent: "review", cwd: "/tmp" },
        { action: "resume", resume_id: "id", task: "follow up", intent: "continue" },
      ],
    },
  );
});

test("subagent request validation rejects legacy roots and invalid request branches", () => {
  const run = { action: "run", agent: "a", task: "t", intent: "Review files" };
  const cases = [
    [{ action: "run", agent: "a", task: "t" }, 'subagent requires only "requests"'],
    [{ action: "run", tasks: [run] }, 'subagent requires only "requests"'],
    [{ action: "run", tasks: '[{"agent":"a","task":"t"}]' }, 'subagent requires only "requests"'],
    [
      { action: "resume", resume_id: "id", task: "t", intent: "i" },
      'subagent requires only "requests"',
    ],
    [{ requests: [] }, 'subagent requires a non-empty "requests" array'],
    [
      { requests: Array.from({ length: MAX_REQUESTS + 1 }, () => run) },
      `subagent accepts at most ${MAX_REQUESTS} requests`,
    ],
    [{ requests: [{ ...run, extra: true }] }, "run request has unsupported fields"],
    [
      { requests: [{ action: "run", task: "t", intent: "i" }] },
      'run request requires "agent", "task", and "intent" strings',
    ],
    [
      { requests: [{ action: "run", agent: "a", intent: "i" }] },
      'run request requires "agent", "task", and "intent" strings',
    ],
    [
      { requests: [{ action: "run", agent: "a", task: "t" }] },
      'run request requires "agent", "task", and "intent" strings',
    ],
    [
      { requests: [{ action: "run", agent: 1, task: "t", intent: "i" }] },
      'run request requires "agent", "task", and "intent" strings',
    ],
    [
      { requests: [{ action: "run", agent: "a", task: 1, intent: "i" }] },
      'run request requires "agent", "task", and "intent" strings',
    ],
    [
      { requests: [{ ...run, intent: 1 }] },
      'run request requires "agent", "task", and "intent" strings',
    ],
    [
      { requests: [{ action: "resume", resume_id: "id", task: "t", intent: "i", cwd: "/tmp" }] },
      "resume request has unsupported fields",
    ],
    [
      { requests: [{ action: "resume", task: "t", intent: "i" }] },
      'resume request requires "resume_id", "task", and "intent" strings',
    ],
    [
      { requests: [{ action: "resume", resume_id: "id", intent: "i" }] },
      'resume request requires "resume_id", "task", and "intent" strings',
    ],
    [
      { requests: [{ action: "resume", resume_id: "id", task: "t" }] },
      'resume request requires "resume_id", "task", and "intent" strings',
    ],
    [
      { requests: [{ action: "resume", resume_id: 1, task: "t", intent: "i" }] },
      'resume request requires "resume_id", "task", and "intent" strings',
    ],
    [
      { requests: [{ action: "resume", resume_id: "id", task: 1, intent: "i" }] },
      'resume request requires "resume_id", "task", and "intent" strings',
    ],
    [{ requests: [{ action: "other", task: "t" }] }, 'request action must be "run" or "resume"'],
  ];
  for (const [params, error] of cases) assert.deepEqual(parseSubagentInvocation(params), { error });
});

test("subagent control validation enforces each action", () => {
  assert.deepEqual(parseSubagentCtlInvocation({ action: "list" }), { action: "list" });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "list", id: "" }), { action: "list" });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "kill", id: "id" }), {
    action: "kill",
    id: "id",
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "steer", id: "id", text: "focus" }), {
    action: "steer",
    id: "id",
    text: "focus",
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "answer", id: "id", text: "answer" }), {
    action: "answer",
    id: "id",
    text: "answer",
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "inspect", id: "id" }), {
    action: "inspect",
    id: "id",
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "list", id: "id" }), {
    error: 'action "list" takes no parameters',
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "kill" }), {
    error: 'action "kill" requires a non-empty "id"',
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "kill", id: "" }), {
    error: 'action "kill" requires a non-empty "id"',
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "steer", id: "" }), {
    error: 'action "steer" requires a non-empty "id"',
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "steer", id: "id" }), {
    error: 'action "steer" requires "text"',
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "answer", id: "" }), {
    error: 'action "answer" requires a non-empty "id"',
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "answer", id: "id" }), {
    error: 'action "answer" requires "text"',
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "inspect" }), {
    error: 'action "inspect" requires a non-empty "id"',
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "inspect", id: "" }), {
    error: 'action "inspect" requires a non-empty "id"',
  });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "inspect", id: "id", run_id: "other" }), {
    error: 'action "inspect" takes only "id"',
  });
});
