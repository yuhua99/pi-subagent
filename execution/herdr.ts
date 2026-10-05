/**
 * Herdr CLI wrapper: tabs and pi agents in the caller's herdr session.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isInsideHerdr(): boolean {
  return process.env.HERDR_ENV === "1";
}

async function herdr(args: string[]): Promise<any> {
  try {
    const { stdout } = await execFileAsync("herdr", args);
    // Some commands (e.g. pane report-metadata) succeed with empty stdout.
    return stdout.trim() ? JSON.parse(stdout).result : undefined;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim() ?? "";
    let message = stderr || (error instanceof Error ? error.message : String(error));
    try {
      message = JSON.parse(stderr).error.message;
    } catch {}
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${message}`);
  }
}

export interface HerdrTab {
  tabId: string;
  paneId: string;
}

export async function createTab(opts: {
  cwd: string;
  label: string;
  focus: boolean;
  env?: Record<string, string>;
}): Promise<HerdrTab> {
  const args = ["tab", "create", "--cwd", opts.cwd, "--label", opts.label];
  if (process.env.HERDR_WORKSPACE_ID) args.push("--workspace", process.env.HERDR_WORKSPACE_ID);
  for (const [key, value] of Object.entries(opts.env ?? {})) args.push("--env", `${key}=${value}`);
  args.push(opts.focus ? "--focus" : "--no-focus");
  const result = await herdr(args);
  return { tabId: result.tab.tab_id, paneId: result.root_pane.pane_id };
}

/** Start an interactive pi in a fresh tab's shell pane; resolves once herdr sees it ready. */
export async function startPi(name: string, paneId: string, piArgs: string[]): Promise<void> {
  await herdr(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", ...piArgs]);
}

/** Replace the agent name herdr's sidebar shows for a pane; display only. */
export async function setDisplayAgent(paneId: string, text: string): Promise<void> {
  await herdr([
    "pane",
    "report-metadata",
    paneId,
    "--source",
    "pi-subagent",
    "--display-agent",
    text,
  ]);
}

type AgentStatus = "idle" | "working" | "blocked" | "done";

function untilArgs(states: AgentStatus[]): string[] {
  return states.flatMap((state) => ["--until", state]);
}

/** Submit text to a live agent like typed input; with `until`, resolve once one of those states follows. */
export async function promptAgent(
  target: string,
  text: string,
  until: AgentStatus[] = [],
): Promise<void> {
  const args = ["agent", "prompt", target, text];
  if (until.length > 0) args.push("--wait", ...untilArgs(until));
  await herdr(args);
}

export async function waitAgent(target: string, until: AgentStatus[]): Promise<void> {
  await herdr(["agent", "wait", target, ...untilArgs(until)]);
}

export async function agentExists(target: string): Promise<boolean> {
  return herdr(["agent", "get", target]).then(
    () => true,
    () => false,
  );
}

export async function tabExists(tabId: string): Promise<boolean> {
  return herdr(["tab", "get", tabId]).then(
    () => true,
    () => false,
  );
}

export async function focusTab(tabId: string): Promise<void> {
  await herdr(["tab", "focus", tabId]);
}

export async function closeTab(tabId: string): Promise<void> {
  await herdr(["tab", "close", tabId]);
}
