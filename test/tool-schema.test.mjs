import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSubagentCtlInvocation,
  parseSubagentInvocation,
  SubagentCtlParams,
  SubagentParams,
} from "../tool_schema.ts";
import { parseTasksParam } from "../types.ts";

test("subagent schema has an action-discriminated object root", () => {
  assert.equal(SubagentParams.type, "object");
  assert.equal(SubagentParams.additionalProperties, false);
  assert.deepEqual(Object.keys(SubagentParams.properties), ["action", "agent", "task", "tasks", "resume_id", "cwd"]);
  assert.deepEqual(SubagentParams.required, ["action"]);
  assert.deepEqual(SubagentParams.properties.action.anyOf.map((schema) => schema.const), ["run", "run_parallel", "resume"]);
  const tasksSchema = SubagentParams.properties.tasks;
  const tasksArray = tasksSchema.anyOf.find((schema) => schema.type === "array");
  assert.equal(tasksArray.items.additionalProperties, false);
  assert.equal("cwd" in tasksArray.items.properties, true);
  assert.equal(tasksSchema.anyOf.some((schema) => schema.type === "string"), true);
});

test("subagent control schema has a required action", () => {
  assert.equal(SubagentCtlParams.type, "object");
  assert.equal(SubagentCtlParams.additionalProperties, false);
  assert.deepEqual(SubagentCtlParams.required, ["action"]);
  assert.deepEqual(SubagentCtlParams.properties.action.anyOf.map((schema) => schema.const), ["list", "kill", "steer", "inspect"]);
  assert.equal(SubagentCtlParams.properties.id.minLength, 1);
});

test("subagent action validation accepts each legal invocation", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "run", agent: "a", task: "t", cwd: "/tmp" }), {
    action: "run", agent: "a", task: "t", cwd: "/tmp",
  });
  assert.deepEqual(parseSubagentInvocation({ action: "run_parallel", tasks: '[{"agent":"a","task":"t"}]' }), {
    action: "run_parallel", tasks: [{ agent: "a", task: "t" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "resume", resume_id: "id", task: "t" }), {
    action: "resume", resume_id: "id", task: "t",
  });
});

test("subagent action validation reports action-specific invalid fields", () => {
  const cases = [
    [{ action: "run", agent: "a" }, 'action "run" requires "agent" and "task"'],
    [{ action: "run", agent: "a", task: "t", tasks: [] }, 'action "run" does not accept "tasks"'],
    [{ action: "run_parallel", tasks: [{ agent: "a", task: "t" }], cwd: "/tmp" }, 'action "run_parallel" does not accept "cwd"'],
    [{ action: "run", agent: "a", task: "t", mode: "spawn" }, 'action "run" does not accept "mode"'],
    [{ action: "other" }, 'action must be "run", "run_parallel", or "resume"'],
  ];
  for (const [params, error] of cases) assert.deepEqual(parseSubagentInvocation(params), { error });
});

test("subagent control validation enforces each action", () => {
  assert.deepEqual(parseSubagentCtlInvocation({ action: "list" }), { action: "list" });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "kill", id: "id" }), { action: "kill", id: "id" });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "steer", id: "id", text: "focus" }), { action: "steer", id: "id", text: "focus" });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "inspect", id: "id" }), { action: "inspect", id: "id" });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "list", id: "id" }), { error: 'action "list" does not accept "id"' });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "kill" }), { error: 'action "kill" requires "id"' });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "steer", id: "id" }), { error: 'action "steer" requires "id" and "text"' });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "inspect" }), { error: 'action "inspect" requires a non-empty "id"' });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "inspect", id: "" }), { error: 'action "inspect" requires a non-empty "id"' });
  assert.deepEqual(parseSubagentCtlInvocation({ action: "inspect", id: "id", run_id: "other" }), { error: 'action "inspect" does not accept "run_id"' });
});

test("parseTasksParam coerces JSON-encoded task strings", () => {
  assert.equal(parseTasksParam(undefined), undefined);
  assert.deepEqual(parseTasksParam([{ agent: "a", task: "t" }]), { tasks: [{ agent: "a", task: "t" }] });
  assert.deepEqual(parseTasksParam('[{"agent":"a","task":"t","cwd":"/tmp"}]'), {
    tasks: [{ agent: "a", task: "t", cwd: "/tmp" }],
  });
  assert.equal("error" in parseTasksParam("not json"), true);
  assert.equal("error" in parseTasksParam("[]"), true);
  assert.equal("error" in parseTasksParam('"just a string"'), true);
  assert.equal("error" in parseTasksParam([{ agent: "a" }]), true);
});
