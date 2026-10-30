import test from "node:test";
import assert from "node:assert/strict";
import extension from "../index.ts";
import { herdrMultiplexer } from "../execution/herdr.ts";
import { detectMultiplexer } from "../execution/multiplexer.ts";
import { EXIT_ON_SETTLE_ENV, rexMultiplexer } from "../execution/rex.ts";
import { DISABLED_ENV } from "../execution/runner.ts";

function withEnv(env, fn) {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const assign = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  assign(env);
  try {
    return fn();
  } finally {
    assign(previous);
  }
}

test("detectMultiplexer prefers rex over herdr", () => {
  withEnv({ REX_SESSION: "session:1", HERDR_ENV: "1" }, () =>
    assert.equal(detectMultiplexer(), rexMultiplexer),
  );
  withEnv({ REX_SESSION: undefined, HERDR_ENV: "1" }, () =>
    assert.equal(detectMultiplexer(), herdrMultiplexer),
  );
  withEnv({ REX_SESSION: undefined, HERDR_ENV: undefined }, () =>
    assert.equal(detectMultiplexer(), undefined),
  );
});

function loadChild(env) {
  const handlers = [];
  const pi = new Proxy(
    { on: (event, handler) => handlers.push({ event, handler }) },
    {
      get: (target, key) =>
        key in target ? target[key] : () => assert.fail(`child registered ${String(key)}`),
    },
  );
  withEnv(env, () => extension(pi));
  return handlers;
}

test("a child pi registers nothing unless asked to exit on settle", () => {
  assert.deepEqual(loadChild({ [DISABLED_ENV]: "1", [EXIT_ON_SETTLE_ENV]: undefined }), []);
});

test("a rex task run's child pi shuts down once the task settles", () => {
  const handlers = loadChild({ [DISABLED_ENV]: "1", [EXIT_ON_SETTLE_ENV]: "1" });
  assert.deepEqual(
    handlers.map(({ event }) => event),
    ["agent_settled"],
  );
  let shutdowns = 0;
  handlers[0].handler({ type: "agent_settled", aborted: false }, { shutdown: () => shutdowns++ });
  assert.equal(shutdowns, 1);
});
