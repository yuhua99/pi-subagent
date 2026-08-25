import assert from "node:assert/strict";
import test from "node:test";
import { clearSessionState, completeRun, registerRun } from "../execution/registry.ts";
import {
  renderCall,
  renderCtlCall,
  renderCtlResult,
  renderResult,
  renderSteerResult,
} from "../tool/render.ts";
import { makeResult, makeRun } from "./fixtures/run.mjs";

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
  for (const details of [{}, undefined, { results: [null] }]) {
    assert.equal(
      renderValidation("subagent", args, details),
      'Validation error: action "resume" does not accept "cwd"',
    );
  }
});

test("renderResult gives action-oriented validation guidance", () => {
  const cases = [
    [{ action: "run" }, 'Validation error: action "run" requires "tasks"'],
    [
      { action: "run", tasks: [] },
      "Validation error: Invalid `tasks`: expected a non-empty array of { agent, task, cwd? } objects.",
    ],
    [
      { action: "run", tasks: [{ agent: "worker", task: "work" }], cwd: "/tmp", agent: "worker" },
      'Validation error: action "run" does not accept "cwd"',
    ],
    [
      { action: "resume", resume_id: "a1b2" },
      'Validation error: action "resume" requires "resume_id" and "task"',
    ],
    [{ action: "unknown" }, 'Validation error: action must be "run" or "resume"'],
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
    'Validation error: action "kill" requires a non-empty "id"',
  );
  assert.equal(
    renderValidation("subagent_ctl", { action: "list", id: "a1b2" }, {}),
    'Validation error: action "list" does not accept "id"',
  );
});

test("renderCall distinguishes delegation actions", () => {
  assert.equal(
    renderCall({ action: "run", tasks: [{ agent: "worker", task: "work" }] }, theme)
      .render(200)
      .join("\n")
      .trim(),
    "subagent worker",
  );
  assert.equal(
    renderCall(
      {
        action: "run",
        tasks: [
          { agent: "worker", task: "work" },
          { agent: "reviewer", task: "review" },
        ],
      },
      theme,
    )
      .render(200)
      .join("\n")
      .trim(),
    "subagent parallel",
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

test("renderCtlResult list shares resolved rows and drops completed runs", () => {
  clearSessionState();
  const run = registerRun(makeRun({ agent: "worker" }));
  run.result.registryId = run.id;
  run.result.taskSummary = "review files";
  const result = {
    content: [{ type: "text", text: "unused" }],
    details: {
      action: "list",
      results: [
        run.result,
        makeResult({ agent: "ghost", registryId: "dead", taskSummary: "review files" }),
      ],
    },
  };
  const live = renderCtlResult(result, undefined, theme).render(200).join("\n");
  assert.match(live, new RegExp(`worker — review files \\[${run.id}\\] ○ running`));
  assert.match(live, /ghost — review files \[dead\] ◌ finished — result delivered separately/);
  completeRun(run.id, makeResult({ exitCode: 0 }));
  const after = renderCtlResult(result, undefined, theme).render(200).join("\n");
  assert.doesNotMatch(after, /worker/);
  assert.match(after, /ghost — review files \[dead\] ◌ finished — result delivered separately/);
  clearSessionState();
});

test("renderCtlResult list keeps evicted completed placeholders stale", () => {
  clearSessionState();
  const run = registerRun(makeRun({ agent: "worker" }));
  run.result.registryId = run.id;
  const storedResult = { ...run.result, registryId: run.id, taskSummary: "review files" };
  const result = {
    content: [{ type: "text", text: "unused" }],
    details: { action: "list", results: [storedResult] },
  };
  completeRun(run.id, makeResult({ exitCode: 0 }));
  clearSessionState();
  const output = renderCtlResult(result, undefined, theme).render(200).join("\n");
  assert.match(
    output,
    /worker — review files \[[a-f0-9]+\] ◌ finished — result delivered separately/,
  );
  assert.doesNotMatch(output, /completed/);
});

test("renderCtlResult list invalidates when a listed run completes", () => {
  clearSessionState();
  const run = registerRun(makeRun({ agent: "worker", startedAt: Date.now() }));
  run.result.registryId = run.id;
  let invalidations = 0;
  const context = { state: {}, invalidate: () => invalidations++ };
  const result = {
    content: [{ type: "text", text: "unused" }],
    details: {
      action: "list",
      results: [run.result],
    },
  };
  assert.match(
    renderCtlResult(result, undefined, theme, context).render(200).join("\n"),
    /running/,
  );
  completeRun(run.id, makeResult({ exitCode: 0 }));
  assert.equal(invalidations, 1);
  assert.equal(
    renderCtlResult(result, undefined, theme, context).render(200).join("\n").trim(),
    "No subagents currently running.",
  );
  clearSessionState();
});

test("renderResult shows task summary without registry id", () => {
  const component = renderResult(
    {
      content: [{ type: "text", text: "unused" }],
      details: {
        results: [{ agent: "worker", exitCode: 0, messages: [], taskSummary: "review files" }],
      },
    },
    theme,
  );
  assert.equal(component.render(200).join("\n").trim(), "└─ worker — review files ✓ completed");
});

test("renderResult keeps normal subagent result rendering", () => {
  const component = renderResult(
    {
      content: [{ type: "text", text: "unused" }],
      details: { results: [{ agent: "worker", exitCode: 0, messages: [] }] },
    },
    theme,
  );
  assert.equal(component.render(200).join("\n").trim(), "└─ worker ✓ completed");
});
