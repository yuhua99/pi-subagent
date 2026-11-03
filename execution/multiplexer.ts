/**
 * Terminal multiplexer backends: each hosts child pi runs, one tab per run.
 */

import { herdrMultiplexer } from "./herdr.ts";
import { rexMultiplexer } from "./rex.ts";

export const MULTIPLEXER_REQUIRED = "Subagents require running pi inside rex or herdr.";

/** A tab hosting one pi; ids are backend-specific. */
export interface PiTab {
  tabId: string;
  paneId: string;
}

export interface OpenPiOptions {
  cwd: string;
  label: string;
  focus: boolean;
  /** Agent name, for backends that track agents. */
  name: string;
  env?: Record<string, string>;
  piArgs: string[];
  /** First prompt; without one, pi opens idle for the user. */
  task?: string;
}

export interface Multiplexer {
  /** Whether this pi runs inside the multiplexer. */
  detect(): boolean;
  /**
   * Open a tab running pi. Resolves once the tab exists; `started` resolves once
   * pi has taken `task` (or is ready, without one), or "closed" if the user closed it first.
   */
  openPi(opts: OpenPiOptions): Promise<{ tab: PiTab; started: Promise<"started" | "closed"> }>;
  /** Submit text to the running pi like typed input. */
  steer(tab: PiTab, text: string): Promise<void>;
  /** Resolve once pi settles after its task, or "closed" if the user closed the tab or quit pi. */
  waitSettled(tab: PiTab): Promise<"settled" | "closed">;
  focus(tab: PiTab): Promise<void>;
  close(tab: PiTab): Promise<void>;
}

/** In priority order; the first detected backend hosts runs. */
const BACKENDS: Multiplexer[] = [herdrMultiplexer, rexMultiplexer];

export function detectMultiplexer(): Multiplexer | undefined {
  return BACKENDS.find((backend) => backend.detect());
}
