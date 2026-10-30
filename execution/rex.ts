/**
 * Rex backend: each pi runs as the program of its own window in the caller's rex session.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Multiplexer } from "./multiplexer.ts";

const execFileAsync = promisify(execFile);

/** Set on a task run's pi: it exits once the task settles, which is how rex reports completion. */
export const EXIT_ON_SETTLE_ENV = "PI_SUBAGENT_EXIT_ON_SETTLE";

const session = () => process.env.REX_SESSION!;

/** Each tab's last steer, so one steer's paste and Enter land before the next begins. */
const steerQueues = new WeakMap<object, Promise<void>>();

function failure(args: string[], error: unknown): Error {
  const stderr = (error as { stderr?: string }).stderr?.trim().replace(/^Error: /, "");
  const message = stderr || (error instanceof Error ? error.message : String(error));
  return new Error(`rex ${args.slice(0, 2).join(" ")} failed: ${message}`);
}

async function rex(args: string[]): Promise<string> {
  try {
    return (await execFileAsync("rex", args)).stdout;
  } catch (error) {
    throw failure(args, error);
  }
}

export const rexMultiplexer: Multiplexer = {
  detect: () => Boolean(process.env.REX_SESSION),

  async openPi(opts) {
    const env = { ...opts.env };
    const piArgs = [...opts.piArgs];
    const args = ["window", "new", "-s", session(), opts.label, "-c", opts.cwd];
    args.push(`--focus=${opts.focus}`, "--json");
    if (opts.task) {
      env[EXIT_ON_SETTLE_ENV] = "1";
      piArgs.push(opts.task);
      // The runner, not pi's exit, closes a task run's window.
      args.push("--keep-open");
    }
    const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    args.push("--", "env", ...envArgs, "pi", ...piArgs);
    const created = JSON.parse(await rex(args));
    const tab = { tabId: created.window_id, paneId: created.block_ids[0] };
    // pi takes the task as its first message, so there is nothing to wait for.
    return { tab, started: Promise.resolve("started" as const) };
  },

  steer(tab, text) {
    // A paste keeps multi-line text in one prompt; Enter then submits it.
    const event = { block_id: tab.paneId, event: { type: "paste", payload: { text } } };
    const submit = async () => {
      await rex(["api", "call", "-s", session(), "block.event", JSON.stringify(event)]);
      await rex(["send-key", "-s", session(), "-b", tab.paneId, "enter"]);
    };
    const next = (steerQueues.get(tab) ?? Promise.resolve()).catch(() => {}).then(submit);
    steerQueues.set(tab, next);
    return next;
  },

  async waitSettled(tab) {
    const args = ["wait", "-s", session(), tab.paneId, "--json"];
    // `rex wait` prints the program's exit, or only the block id when the block closed first.
    const ended = await execFileAsync("rex", args).catch((error: unknown) => error);
    let payload: { exit_code?: number; error?: string };
    try {
      payload = JSON.parse((ended as { stdout?: string }).stdout ?? "");
    } catch {
      // The block was already gone when the wait began.
      if (/not found/.test((ended as { stderr?: string }).stderr ?? "")) return "closed";
      throw failure(args, ended);
    }
    if (payload.exit_code === undefined) return "closed";
    if (payload.exit_code === 0) return "settled";
    throw new Error(`pi exited with ${payload.error ?? `status ${payload.exit_code}`}`);
  },

  async focus(tab) {
    await rex(["focus", "-s", session(), tab.paneId]);
  },

  async close(tab) {
    await rex(["window", "close", "-s", session(), tab.tabId]);
  },
};
