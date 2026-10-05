import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { registerAgentsCommand } from "../agents/command.ts";
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

test("/agents rejects unknown toggle arguments", async () => {
  const setEnabledCalls = [];
  const { command, ctx, notifications } = commandHarness({
    isEnabled: () => true,
    setEnabled: (value) => setEnabledCalls.push(value),
  });

  await command.handler("bogus", ctx);

  assert.deepEqual(notifications, ["/agents [on|off|enable|disable]"]);
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

test("/agents uses the shared centered overlay and reports a run still starting", async () => {
  clearSessionState();
  registerRun(makeRun({ agent: "worker", task: "task", startedAt: Date.now() }));
  const { calls, command, ctx, notifications } = commandHarness();

  const handler = command.handler("", ctx);
  assert.deepEqual(calls[0].options, { overlay: true, overlayOptions: { width: "90%" } });
  assertOverlayFrame(calls[0].component.render(100), 100);
  calls[0].component.handleInput("\r");
  await handler;
  assert.equal(calls.length, 1);
  assert.match(notifications[0], /is still starting/);
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
