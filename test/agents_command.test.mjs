import assert from "node:assert/strict";
import test from "node:test";
import { registerAgentsCommand } from "../agents/command.ts";
import { clearSessionState, registerRun } from "../execution/registry.ts";
import { makeRun } from "./fixtures/run.mjs";

function commandHarness(toggle = { isEnabled: () => true, setEnabled: () => {} }) {
  const calls = [];
  const notifications = [];
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify(message) {
        notifications.push(message);
      },
      async select(title, options) {
        calls.push({ title, options });
        return options[0];
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

test("/agents lists runs in a selector and reports a run still starting", async () => {
  clearSessionState();
  const run = registerRun(makeRun({ agent: "worker", task: "task", startedAt: Date.now() }));
  const { calls, command, ctx, notifications } = commandHarness();

  await command.handler("", ctx);

  assert.equal(calls[0].title, "Subagents — 1 running · 0 completed");
  assert.match(calls[0].options[0], new RegExp(`^○ \\[${run.id}\\] worker — .* — task$`));
  assert.match(notifications[0], /is still starting/);
  clearSessionState();
});
