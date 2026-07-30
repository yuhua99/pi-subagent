import assert from "node:assert/strict";
import test from "node:test";
import { renderResult } from "../render.ts";

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function validationText(args) {
  const diagnostics = ["  - root: Expected union value"];
  if ("cwd" in args) diagnostics.push("  - cwd: Unexpected property");
  return `Validation failed for tool "subagent":
${diagnostics.join("\n")}

Received arguments:
${JSON.stringify(args, null, 2)}`;
}

function renderValidation(args, details) {
  const text = validationText(args);
  const result = { content: [{ type: "text", text }], details };
  let component;
  assert.doesNotThrow(() => {
    component = renderResult(result, theme);
  });
  const output = component.render(200).join("\n").trim();
  assert.doesNotMatch(output, /Expected union|Unexpected property|Received arguments|root:/);
  assert.equal(result.content[0].text, text);
  return output;
}

test("renderResult replaces malformed resume validation diagnostics", () => {
  const args = { resume: "a1b2", task: "continue", cwd: "/tmp" };
  for (const details of [{}, undefined, { mode: "single", results: [null] }]) {
    assert.equal(
      renderValidation(args, details),
      "Validation error: resume does not accept `cwd`; use only `resume` and `task`.",
    );
  }
});

test("renderResult gives validation guidance for each invocation shape", () => {
  const cases = [
    [{ resume: "a1b2" }, "Validation error: resume requires `task`."],
    [{ agent: "worker" }, "Validation error: single subagent calls require `task`."],
    [{ agent: "worker", task: "work", mode: {} }, "Validation error: single call `mode` must be a string."],
    [{ agent: "worker", task: "work", cwd: {} }, "Validation error: single call `cwd` must be a string."],
    [{ tasks: [] }, "Validation error: `tasks` must be a non-empty array of `{ agent, task, cwd? }` or a JSON string."],
    [{ tasks: [{ agent: "worker" }] }, "Validation error: task item `task` must be a string."],
    [{ tasks: [{ agent: "worker", task: "work", extra: true }] }, "Validation error: task items accept only `agent`, `task`, and optional `cwd`."],
    [{ tasks: [{ agent: "worker", task: "work", cwd: {} }] }, "Validation error: task item `cwd` must be a string."],
    [{ tasks: [{ agent: "worker", task: "work" }], mode: {} }, "Validation error: parallel call `mode` must be a string."],
    [{ tasks: "[]", cwd: "/tmp" }, "Validation error: parallel calls accept only `tasks` and optional `mode`."],
    [{ mode: "fork" }, "Validation error: use `{ agent, task }`, `{ tasks }`, or `{ resume, task }`."],
  ];
  for (const [args, expected] of cases) assert.equal(renderValidation(args, {}), expected);
});

test("renderResult keeps normal subagent result rendering", () => {
  const component = renderResult(
    {
      content: [{ type: "text", text: "unused" }],
      details: { mode: "single", results: [{ agent: "worker", exitCode: 0, messages: [] }] },
    },
    theme,
  );
  assert.equal(component.render(200).join("\n").trim(), "└─ ✓ completed");
});
