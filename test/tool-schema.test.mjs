import assert from "node:assert/strict";
import test from "node:test";
import { SubagentParams } from "../tool_schema.ts";

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
  assert.equal(branch("tasks").properties.tasks.items.additionalProperties, false);
  assert.equal("cwd" in branch("tasks").properties.tasks.items.properties, true);
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
