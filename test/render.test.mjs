import assert from "node:assert/strict";
import test from "node:test";
import {
  renderCall,
  renderCtlCall,
  renderCtlResult,
  renderResult,
  renderSteerResult,
} from "../tool/render.ts";

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function validationText(toolName, args) {
  return `Validation failed for tool "${toolName}":
  - root: Expected union value

Received arguments:
${JSON.stringify(args, null, 2)}`;
}

function renderValidation(toolName, args, details) {
  const text = validationText(toolName, args);
  const result = { content: [{ type: "text", text }], details };
  let component;
  assert.doesNotThrow(() => {
    component =
      toolName === "subagent"
        ? renderResult(result, theme)
        : renderCtlResult(result, undefined, theme);
  });
  const output = component.render(200).join("\n").trim();
  assert.doesNotMatch(output, /Expected union|Received arguments|root:/);
  assert.equal(result.content[0].text, text);
  return output;
}

test("renderResult replaces malformed action validation diagnostics", () => {
  const args = { action: "resume", resume_id: "a1b2", task: "continue", cwd: "/tmp" };
  for (const details of [{}, undefined, { mode: "single", results: [null] }]) {
    assert.equal(
      renderValidation("subagent", args, details),
      'Validation error: action "resume" does not accept "cwd"',
    );
  }
});

test("renderResult gives action-oriented validation guidance", () => {
  const cases = [
    [
      { action: "run", agent: "worker" },
      'Validation error: action "run" requires "agent" and "task"',
    ],
    [{ action: "run_parallel" }, 'Validation error: action "run_parallel" requires "tasks"'],
    [
      { action: "run_parallel", tasks: [] },
      "Validation error: Invalid `tasks`: expected a non-empty array of { agent, task, cwd? } objects.",
    ],
    [
      { action: "run_parallel", tasks: [{ agent: "worker", task: "work" }], cwd: "/tmp" },
      'Validation error: action "run_parallel" does not accept "cwd"',
    ],
    [
      { action: "resume", resume_id: "a1b2" },
      'Validation error: action "resume" requires "resume_id" and "task"',
    ],
    [{ action: "unknown" }, 'Validation error: action must be "run", "run_parallel", or "resume"'],
  ];
  for (const [args, expected] of cases)
    assert.equal(renderValidation("subagent", args, {}), expected);
});

test("renderCtlResult gives control action validation guidance", () => {
  assert.equal(
    renderValidation("subagent_ctl", { action: "inspect" }, {}),
    'Validation error: action "inspect" requires a non-empty "id"',
  );
  assert.equal(
    renderValidation("subagent_ctl", { action: "kill" }, {}),
    'Validation error: action "kill" requires "id"',
  );
  assert.equal(
    renderValidation("subagent_ctl", { action: "list", id: "a1b2" }, {}),
    'Validation error: action "list" does not accept "id"',
  );
});

test("renderCall distinguishes delegation actions", () => {
  assert.equal(
    renderCall({ action: "run", agent: "worker" }, theme).render(200).join("\n").trim(),
    "subagent worker",
  );
  assert.equal(
    renderCall({ action: "run_parallel", tasks: [{ agent: "worker", task: "work" }] }, theme)
      .render(200)
      .join("\n")
      .trim(),
    "subagent parallel (1 tasks)",
  );
  assert.equal(
    renderCall({ action: "resume", resume_id: "a1b2" }, theme).render(200).join("\n").trim(),
    "subagent resume a1b2",
  );
});

test("renderCtlCall distinguishes control actions", () => {
  assert.equal(
    renderCtlCall({ action: "list" }, theme).render(200).join("\n").trim(),
    "subagent_ctl list",
  );
  assert.equal(
    renderCtlCall({ action: "kill", id: "a1b2" }, theme).render(200).join("\n").trim(),
    "subagent_ctl kill a1b2",
  );
  assert.equal(
    renderCtlCall({ action: "steer", id: "a1b2" }, theme).render(200).join("\n").trim(),
    "subagent_ctl steer a1b2",
  );
  assert.equal(
    renderCtlCall({ action: "inspect", id: "a1b2" }, theme).render(200).join("\n").trim(),
    "subagent_ctl inspect a1b2",
  );
});

test("renderCtlResult shows inspect status, agent, and activity", () => {
  const component = renderCtlResult(
    {
      content: [{ type: "text", text: "unused" }],
      details: {
        action: "inspect",
        id: "a1b2",
        result: {
          id: "a1b2",
          agent: "worker",
          task: "review files",
          activitySummary: "Reading the repository.",
          startedAt: 0,
          status: "running",
          result: { agent: "worker", exitCode: -1, messages: [] },
        },
      },
    },
    undefined,
    theme,
  );
  assert.equal(
    component
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n")
      .trim(),
    "└─ ○ running worker [a1b2]\n   Reading the repository.",
  );
});

test("renderSteerResult preserves completed-run errors", () => {
  const component = renderSteerResult(
    {
      content: [
        {
          type: "text",
          text: 'Subagent [a1b2] already finished. Use the subagent tool with { action: "resume", resume_id: "a1b2", task } instead.',
        },
      ],
      details: { action: "steer", id: "a1b2" },
    },
    undefined,
    theme,
  );
  assert.equal(
    component.render(200).join("\n").trim(),
    'Subagent [a1b2] already finished. Use the subagent tool with { action: "resume", resume_id: "a1b2", task } instead.',
  );
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
