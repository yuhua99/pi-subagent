import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageComponent,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { registerAgentsCommand } from "../agents/command.ts";
import { NativeTranscriptRenderer } from "../agents/detail.ts";
import { isDetailQuietTool } from "../agents/detail_tools.ts";
import { renderAgentsOverlay } from "../agents/shell.ts";
import { clearSessionState, registerRun } from "../execution/registry.ts";
import { makeRun } from "./fixtures/run.mjs";

function commandHarness(toggle = { isEnabled: () => true, setEnabled: () => {} }) {
  const calls = [];
  const notifications = [];
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify(message) {
        notifications.push(message);
      },
      custom(factory, options) {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        calls.push({ component: factory(tui, theme, {}, resolve), options });
        return promise;
      },
    },
  };
  let command;
  registerAgentsCommand(
    {
      registerCommand(_name, definition) {
        command = definition;
      },
    },
    toggle,
  );
  return { calls, ctx, command, notifications };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test.before(() => initTheme());

function assertOverlayFrame(lines, width, terminalRows = 24) {
  const bodyRows = Math.max(3, Math.floor(terminalRows * 0.8) - 6);
  const border = "─".repeat(width - 2);
  assert.equal(lines.length, bodyRows + 6);
  for (const line of lines) assert.equal(line.length, width);
  for (const [index, line] of lines.entries()) {
    if (index !== 0 && index !== 2 && index !== bodyRows + 3 && index !== lines.length - 1) {
      assert.equal(line.slice(0, 2), "│ ");
      assert.equal(line.slice(-2), " │");
    }
  }
  assert.equal(lines[0], `╭${border}╮`);
  assert.equal(lines[2], `├${border}┤`);
  assert.equal(lines[bodyRows + 3], `├${border}┤`);
  assert.equal(lines.at(-1), `╰${border}╯`);
}

test("detail renders native assistant and tool transcript components", () => {
  const renderer = new NativeTranscriptRenderer({ requestRender() {} }, process.cwd());
  const lines = renderer.render(
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning" },
            { type: "text", text: "## Answer\n\nDone" },
            { type: "toolCall", id: "call_1", name: "unknown", arguments: { value: "input" } },
            { type: "toolCall", id: "call_2", name: "pending", arguments: { value: "waiting" } },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "unknown",
          content: [{ type: "text", text: "tool failed" }],
          isError: true,
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "failed answer" }],
          stopReason: "error",
          errorMessage: "assistant failed",
          timestamp: 3,
        },
      ],
    },
    60,
  );
  renderer.dispose();
  const transcript = lines.join("\n");
  assert.match(transcript, /reasoning/);
  assert.match(transcript, /Answer/);
  assert.match(transcript, /unknown/);
  assert.match(transcript, /tool failed/);
  assert.match(transcript, /pending/);
  assert.match(transcript, /assistant failed/);
});

test("detail reuses components until message, args, or result references change", () => {
  const renderer = new NativeTranscriptRenderer({ requestRender() {} }, process.cwd());
  const originalAssistantUpdate = AssistantMessageComponent.prototype.updateContent;
  const originalRender = ToolExecutionComponent.prototype.render;
  const originalUpdateArgs = ToolExecutionComponent.prototype.updateArgs;
  const originalUpdateResult = ToolExecutionComponent.prototype.updateResult;
  const components = new Set();
  let assistantUpdates = 0;
  let argsUpdates = 0;
  let resultUpdates = 0;
  AssistantMessageComponent.prototype.updateContent = function (...args) {
    assistantUpdates++;
    return originalAssistantUpdate.apply(this, args);
  };
  ToolExecutionComponent.prototype.render = function (width) {
    components.add(this);
    return originalRender.call(this, width);
  };
  ToolExecutionComponent.prototype.updateArgs = function (...args) {
    argsUpdates++;
    return originalUpdateArgs.apply(this, args);
  };
  ToolExecutionComponent.prototype.updateResult = function (...args) {
    resultUpdates++;
    return originalUpdateResult.apply(this, args);
  };
  try {
    const transcript = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_1", name: "unknown", arguments: { value: "input" } },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "unknown",
          content: [{ type: "text", text: "first" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    renderer.render(transcript, 60);
    renderer.render(transcript, 60);
    assert.equal(components.size, 1);
    assert.equal(assistantUpdates, 1);
    assert.equal(argsUpdates, 0);
    assert.equal(resultUpdates, 1);
    transcript.messages[0] = {
      ...transcript.messages[0],
      content: [
        { type: "toolCall", id: "call_1", name: "unknown", arguments: { value: "changed" } },
      ],
    };
    transcript.messages[1] = {
      ...transcript.messages[1],
      content: [{ type: "text", text: "second" }],
    };
    renderer.render(transcript, 60);
    assert.equal(components.size, 1);
    assert.equal(assistantUpdates, 2);
    assert.equal(argsUpdates, 1);
    assert.equal(resultUpdates, 2);
  } finally {
    AssistantMessageComponent.prototype.updateContent = originalAssistantUpdate;
    ToolExecutionComponent.prototype.render = originalRender;
    ToolExecutionComponent.prototype.updateArgs = originalUpdateArgs;
    ToolExecutionComponent.prototype.updateResult = originalUpdateResult;
    renderer.dispose();
  }
});

function detailTranscript(calls, results = []) {
  return {
    messages: [
      { role: "assistant", content: calls, timestamp: 1 },
      ...results.map(({ id, name, text, isError = false }, index) => ({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text }],
        isError,
        timestamp: index + 2,
      })),
    ],
  };
}

test("detail shares its quiet tool predicate", () => {
  for (const toolName of ["read", "grep", "find", "ls", "bash", "write", "edit"])
    assert.equal(isDetailQuietTool(toolName), true);
  assert.equal(isDetailQuietTool("other"), false);
});

test("detail disables images only for quiet tools", () => {
  const renderer = new NativeTranscriptRenderer({ requestRender() {} }, process.cwd());
  const originalRender = ToolExecutionComponent.prototype.render;
  const components = new Map();
  ToolExecutionComponent.prototype.render = function (width) {
    components.set(this.toolName, this);
    return originalRender.call(this, width);
  };
  try {
    renderer.render(
      detailTranscript([
        { type: "toolCall", id: "read_image", name: "read", arguments: { path: "image.png" } },
        { type: "toolCall", id: "bash_image", name: "bash", arguments: { command: "echo image" } },
        { type: "toolCall", id: "other_image", name: "other", arguments: {} },
      ]),
      80,
    );
    assert.equal(components.get("read").showImages, false);
    assert.equal(components.get("bash").showImages, false);
    assert.equal(components.get("other").showImages, true);
  } finally {
    ToolExecutionComponent.prototype.render = originalRender;
    renderer.dispose();
  }
});

test("detail applies quiet tool policy", () => {
  const cases = [
    {
      name: "renders each quiet call on its own row",
      calls: [
        { type: "toolCall", id: "mixed_read_1", name: "read", arguments: { path: "first.ts" } },
        {
          type: "toolCall",
          id: "mixed_grep",
          name: "grep",
          arguments: { pattern: "needle", path: "src" },
        },
        { type: "toolCall", id: "mixed_read_2", name: "read", arguments: { path: "final.ts" } },
      ],
      results: [
        { id: "mixed_read_1", name: "read", text: "first output" },
        { id: "mixed_grep", name: "grep", text: "grep output" },
        { id: "mixed_read_2", name: "read", text: "final output" },
      ],
      matches: [/first.ts/, /needle in src/, /final.ts/],
      misses: [/×\d/, /first output|grep output|final output/],
    },
    {
      name: "does not collapse same-type exploration calls",
      calls: [
        { type: "toolCall", id: "same_read_1", name: "read", arguments: { path: "first.ts" } },
        { type: "toolCall", id: "same_read_2", name: "read", arguments: { path: "second.ts" } },
      ],
      results: [
        { id: "same_read_1", name: "read", text: "first output" },
        { id: "same_read_2", name: "read", text: "second output" },
      ],
      matches: [/first.ts/, /second.ts/],
      misses: [/×\d/, /first output|second output/],
    },
    {
      name: "shows intent with tool detail when present",
      calls: [
        {
          type: "toolCall",
          id: "intent_read",
          name: "read",
          arguments: { path: "src/a.ts", intent: "check entry" },
        },
        {
          type: "toolCall",
          id: "intent_bash",
          name: "bash",
          arguments: { command: "ls -la", intent: "list files" },
        },
      ],
      results: [
        { id: "intent_read", name: "read", text: "file body" },
        { id: "intent_bash", name: "bash", text: "listing" },
      ],
      matches: [/check entry.*read.*src\/a\.ts/, /list files.*bash.*ls -la/],
      misses: [/file body|listing/],
    },
    {
      name: "keeps bash, edit, and write quiet and separate",
      calls: [
        { type: "toolCall", id: "quiet_bash", name: "bash", arguments: { command: "echo quiet" } },
        {
          type: "toolCall",
          id: "quiet_edit",
          name: "edit",
          arguments: { path: "quiet.ts", edits: [] },
        },
        {
          type: "toolCall",
          id: "quiet_write",
          name: "write",
          arguments: { path: "quiet.txt", content: "text" },
        },
        { type: "toolCall", id: "native_other", name: "other", arguments: {} },
      ],
      results: [
        { id: "quiet_bash", name: "bash", text: "bash result" },
        { id: "quiet_edit", name: "edit", text: "edit result" },
        { id: "quiet_write", name: "write", text: "write result" },
        { id: "native_other", name: "other", text: "native result" },
      ],
      matches: [/echo quiet/, /quiet.ts/, /quiet.txt/, /native result/],
      misses: [/×\d/, /bash result|edit result|write result/],
    },
    {
      name: "renders multiline quiet rows on one line",
      calls: [
        {
          type: "toolCall",
          id: "multiline_bash",
          name: "bash",
          arguments: { command: "cat <<'EOF'\r\nhello\r\nEOF" },
        },
        {
          type: "toolCall",
          id: "multiline_grep",
          name: "grep",
          arguments: { pattern: "one\r\ntwo", path: "src" },
        },
      ],
      results: [
        { id: "multiline_bash", name: "bash", text: "bash result" },
        { id: "multiline_grep", name: "grep", text: "grep result" },
      ],
      matches: [/cat <<'EOF' hello EOF/, /one two in src/],
      misses: [/hello\nEOF|one\ntwo/],
    },
    {
      name: "keeps pending and errors visible on their own rows",
      calls: [
        { type: "toolCall", id: "before_1", name: "read", arguments: { path: "before-1.ts" } },
        { type: "toolCall", id: "before_2", name: "read", arguments: { path: "before-2.ts" } },
        { type: "toolCall", id: "pending", name: "read", arguments: { path: "pending.ts" } },
        { type: "toolCall", id: "error", name: "read", arguments: { path: "denied.ts" } },
        { type: "toolCall", id: "after_1", name: "read", arguments: { path: "after-1.ts" } },
        { type: "toolCall", id: "after_2", name: "read", arguments: { path: "after-2.ts" } },
      ],
      results: [
        { id: "before_1", name: "read", text: "before output" },
        { id: "before_2", name: "read", text: "before output" },
        { id: "error", name: "read", text: "permission denied\nmore output", isError: true },
        { id: "after_1", name: "read", text: "after output" },
        { id: "after_2", name: "read", text: "after output" },
      ],
      matches: [
        /before-1\.ts/,
        /before-2\.ts/,
        /pending.ts/,
        /denied.ts/,
        /permission denied/,
        /after-1\.ts/,
        /after-2\.ts/,
      ],
      misses: [/×\d/, /before output|after output/],
    },
  ];
  for (const policy of cases) {
    const renderer = new NativeTranscriptRenderer({ requestRender() {} }, process.cwd());
    const lines = renderer.render(detailTranscript(policy.calls, policy.results), 80).join("\n");
    renderer.dispose();
    for (const match of policy.matches) assert.match(lines, match, policy.name);
    for (const miss of policy.misses) assert.doesNotMatch(lines, miss, policy.name);
  }
});

test("detail tool state is isolated per transcript renderer", () => {
  const first = new NativeTranscriptRenderer({ requestRender() {} }, process.cwd());
  const second = new NativeTranscriptRenderer({ requestRender() {} }, process.cwd());
  const firstLines = first
    .render(
      detailTranscript(
        [
          { type: "toolCall", id: "first_read", name: "read", arguments: { path: "first.ts" } },
          { type: "toolCall", id: "first_read_2", name: "read", arguments: { path: "second.ts" } },
        ],
        [
          { id: "first_read", name: "read", text: "first" },
          { id: "first_read_2", name: "read", text: "second" },
        ],
      ),
      80,
    )
    .join("\n");
  const switchedLines = first
    .render(
      detailTranscript([
        { type: "toolCall", id: "switched_read", name: "read", arguments: { path: "switched.ts" } },
      ]),
      80,
    )
    .join("\n");
  const secondLines = second
    .render(
      detailTranscript([
        { type: "toolCall", id: "second_read", name: "read", arguments: { path: "second.ts" } },
      ]),
      80,
    )
    .join("\n");
  first.dispose();
  second.dispose();
  assert.match(firstLines, /first\.ts/);
  assert.match(firstLines, /second\.ts/);
  assert.doesNotMatch(firstLines, /×\d/);
  assert.match(switchedLines, /switched.ts/);
  assert.doesNotMatch(switchedLines, /first\.ts|×\d/);
  assert.match(secondLines, /second\.ts/);
  assert.doesNotMatch(secondLines, /first\.ts|×\d/);
});

test("agents overlay renders at narrow widths", () => {
  const theme = { fg: (_color, text) => text };
  for (const width of [1, 2, 3]) {
    assert.doesNotThrow(() =>
      renderAgentsOverlay({
        width,
        terminalRows: 1,
        theme,
        header: "header",
        body: ["body"],
        footer: "footer",
      }),
    );
  }
});

test("/agents rejects unknown toggle arguments", async () => {
  const setEnabledCalls = [];
  const { command, ctx, notifications } = commandHarness({
    isEnabled: () => true,
    setEnabled: (value) => setEnabledCalls.push(value),
  });

  await command.handler("bogus", ctx);

  assert.deepEqual(notifications, ["/agents [on|off]"]);
  assert.deepEqual(setEnabledCalls, []);
});

test("/agents cannot toggle after conversation starts", async () => {
  const setEnabledCalls = [];
  const { command, ctx, notifications } = commandHarness({
    isEnabled: () => true,
    setEnabled: (value) => setEnabledCalls.push(value),
  });
  ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "user" } }];

  await command.handler("off", ctx);

  assert.deepEqual(notifications, [
    "Cannot toggle subagent delegation after the conversation has started",
  ]);
  assert.deepEqual(setEnabledCalls, []);
});

test("/agents off disables delegation before conversation starts", async () => {
  const setEnabledCalls = [];
  const { command, ctx, notifications } = commandHarness({
    isEnabled: () => true,
    setEnabled: (value) => setEnabledCalls.push(value),
  });

  await command.handler("off", ctx);

  assert.deepEqual(setEnabledCalls, [false]);
  assert.deepEqual(notifications, ["Subagent delegation disabled"]);
});

test("/agents on reports enabled when delegation is already enabled", async () => {
  const setEnabledCalls = [];
  const { command, ctx, notifications } = commandHarness({
    isEnabled: () => true,
    setEnabled: (value) => setEnabledCalls.push(value),
  });

  await command.handler("on", ctx);

  assert.deepEqual(notifications, ["Subagent delegation already enabled"]);
  assert.deepEqual(setEnabledCalls, []);
});

test("/agents uses the shared centered overlay and returns from detail to list", async () => {
  clearSessionState();
  let statusUnsubscribed = 0;
  let streamUnsubscribed = 0;
  const run = registerRun(makeRun({ agent: "worker", task: "task", startedAt: Date.now() }));
  run.onStatus = () => () => {
    statusUnsubscribed++;
  };
  run.onStream = () => () => {
    streamUnsubscribed++;
  };
  const { calls, command, ctx } = commandHarness();

  const handler = command.handler("", ctx);
  assert.deepEqual(calls[0].options, { overlay: true, overlayOptions: { width: "90%" } });
  const listLines = calls[0].component.render(100);
  assertOverlayFrame(listLines, 100);
  calls[0].component.handleInput("\r");
  await nextTurn();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].options, { overlay: true, overlayOptions: { width: "90%" } });
  const detailLines = calls[1].component.render(100);
  assertOverlayFrame(detailLines, 100);
  assert.equal(detailLines.length, listLines.length);
  calls[1].component.handleInput("\x1b");
  await nextTurn();
  assert.equal(statusUnsubscribed, 1);
  assert.equal(streamUnsubscribed, 1);
  assert.equal(calls.length, 3);
  calls[2].component.handleInput("\x1b");
  await handler;
  clearSessionState();
});

test("/agents list kills and removes the selected running run", async () => {
  clearSessionState();
  let killed = 0;
  registerRun(
    makeRun({
      agent: "worker",
      task: "task",
      startedAt: Date.now(),
      kill() {
        killed++;
      },
    }),
  );
  const { calls, command, ctx } = commandHarness();

  const handler = command.handler("", ctx);
  const populatedLines = calls[0].component.render(100);
  calls[0].component.handleInput("x");
  assert.equal(killed, 1);
  const emptyLines = calls[0].component.render(100);
  assert.match(emptyLines.join("\n"), /No subagents running/);
  assertOverlayFrame(emptyLines, 100);
  assert.equal(emptyLines.length, populatedLines.length);
  calls[0].component.handleInput("\x1b");
  await handler;
  clearSessionState();
});

test("/agents list clips long SelectList output within the shared shell", async () => {
  clearSessionState();
  for (let index = 0; index < 20; index++) {
    registerRun(makeRun({ agent: `worker-${index}`, task: "task", startedAt: Date.now() }));
  }
  const { calls, command, ctx } = commandHarness();

  const handler = command.handler("", ctx);
  const lines = calls[0].component.render(100);
  assertOverlayFrame(lines, 100);
  assert.match(lines.join("\n"), /\(1\/20\)/);
  calls[0].component.handleInput("\x1b");
  await handler;
  clearSessionState();
});
