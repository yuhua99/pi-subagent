import assert from "node:assert/strict";
import test from "node:test";
import { getSubagentInvocationShape, SubagentParams } from "../tool_schema.ts";
import { parseTasksParam } from "../types.ts";

test("subagent schema has an object root and preserves parameter types", () => {
  assert.equal(SubagentParams.type, "object");
  assert.equal(SubagentParams.anyOf, undefined);
  assert.equal(SubagentParams.additionalProperties, false);
  assert.deepEqual(Object.keys(SubagentParams.properties), ["agent", "task", "tasks", "resume", "mode", "cwd"]);
  const tasksSchema = SubagentParams.properties.tasks;
  const tasksArray = tasksSchema.anyOf.find((schema) => schema.type === "array");
  assert.equal(tasksArray.items.additionalProperties, false);
  assert.equal("cwd" in tasksArray.items.properties, true);
  assert.equal(tasksSchema.anyOf.some((schema) => schema.type === "string"), true);
});

test("subagent invocation validation accepts only the three shapes", () => {
  assert.equal(getSubagentInvocationShape({ agent: "a", task: "t" }), "single");
  assert.equal(getSubagentInvocationShape({ agent: "a", task: "t", cwd: "/tmp", mode: "fork" }), "single");
  assert.equal(getSubagentInvocationShape({ tasks: [{ agent: "a", task: "t" }] }), "parallel");
  assert.equal(getSubagentInvocationShape({ resume: "id", task: "t" }), "resume");
  assert.equal(getSubagentInvocationShape({ agent: "a", task: "t", tasks: [{ agent: "b", task: "u" }] }), undefined);
  assert.equal(getSubagentInvocationShape({ resume: "id", task: "t", agent: "a" }), undefined);
  assert.equal(getSubagentInvocationShape({ tasks: [{ agent: "a", task: "t" }], cwd: "/tmp" }), undefined);
  assert.equal(getSubagentInvocationShape({ resume: "id", task: "t", mode: "fork" }), undefined);
  assert.equal(getSubagentInvocationShape({ agent: "a" }), undefined);
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
