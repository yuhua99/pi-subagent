import assert from "node:assert/strict";
import test from "node:test";
import { SubagentParams } from "../tool_schema.ts";
import { parseTasksParam } from "../types.ts";

function branch(required) {
  return SubagentParams.anyOf.find((item) => item.required?.includes(required));
}

function structurallyMatches(schema, value) {
  if (!schema.required?.every((key) => key in value)) return false;
  if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in schema.properties))) {
    return false;
  }
  return true;
}

function accepts(value) {
  return SubagentParams.anyOf.some((schema) => structurallyMatches(schema, value));
}

test("subagent schema rejects mixed invocation shapes structurally", () => {
  assert.equal(Array.isArray(SubagentParams.anyOf), true);
  assert.equal(SubagentParams.anyOf.length, 3);
  assert.equal(SubagentParams.anyOf.every((schema) => schema.additionalProperties === false), true);
  const tasksSchema = branch("tasks").properties.tasks;
  const tasksArray = tasksSchema.anyOf.find((schema) => schema.type === "array");
  assert.equal(tasksArray.items.additionalProperties, false);
  assert.equal("cwd" in tasksArray.items.properties, true);
  assert.equal(tasksSchema.anyOf.some((schema) => schema.type === "string"), true);
  assert.deepEqual(branch("resume").required, ["resume", "task"]);
  assert.equal(branch("resume").properties.agent, undefined);
  assert.equal(branch("resume").properties.mode, undefined);
  assert.deepEqual(branch("agent").required, ["agent", "task"]);
  assert.deepEqual(branch("tasks").required, ["tasks"]);
  assert.equal(accepts({ agent: "a", task: "t", tasks: [{ agent: "b", task: "u" }] }), false);
  assert.equal(accepts({ resume: "id", task: "t", agent: "a" }), false);
  assert.equal(accepts({ tasks: [{ agent: "a", task: "t" }], cwd: "/tmp" }), false);
  assert.equal(accepts({ agent: "a", task: "t", cwd: "/tmp" }), true);
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
