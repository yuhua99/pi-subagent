/**
 * Rebuild a run's transcript and usage from the child pi's session file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SingleResult } from "../types.ts";

/** The run's session file (`<timestamp>_<sessionId>.jsonl`) inside its private `--session-dir`. */
export function findSessionFile(dir: string, sessionId: string): string | undefined {
  const file = fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .find((entry) => entry.endsWith(`_${sessionId}.jsonl`));
  return file && path.join(dir, file);
}

/**
 * Append messages created at or after `since` (resumed history is older) to the
 * result, skipping the run's own task prompt and accumulating assistant usage.
 */
export function readTranscript(result: SingleResult, sessionFile: string, since: number): void {
  let skippedTaskPrompt = false;
  // Skips malformed lines, such as a last line a kill cut off mid-write.
  for (const entry of parseSessionEntries(fs.readFileSync(sessionFile, "utf8"))) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.timestamp < since) continue;
    if (message.role === "user" && !skippedTaskPrompt) {
      skippedTaskPrompt = true;
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
      continue;
    }
    result.messages.push(message);
    if (message.role !== "assistant") continue;
    result.usage.turns++;
    const usage = message.usage;
    if (!usage) continue;
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }
}
