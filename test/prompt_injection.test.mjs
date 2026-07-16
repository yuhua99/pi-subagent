import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

function runInject(basePrompt, block) {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "prompt_injection.ts")).href;
  const script = `
    import { injectIntoSystemPrompt } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(injectIntoSystemPrompt(${JSON.stringify(basePrompt)}, ${JSON.stringify(block)})));
  `;

  return JSON.parse(
    execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: process.env,
      encoding: "utf-8",
    }),
  );
}

function runStrip(prompt) {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "prompt_injection.ts")).href;
  const script = `
    import { stripCwdTail } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(stripCwdTail(${JSON.stringify(prompt)})));
  `;

  return JSON.parse(
    execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: process.env,
      encoding: "utf-8",
    }),
  );
}

test("inserts the block before the last current working directory marker", () => {
  const prompt = "Stable prefix\nCurrent working directory: /tmp/project";
  assert.equal(
    runInject(prompt, "Injected policy"),
    "Stable prefix\n\nInjected policy\nCurrent working directory: /tmp/project",
  );
});

test("appends the block with a blank-line separator when the marker is absent", () => {
  assert.equal(runInject("Stable prompt", "Injected policy"), "Stable prompt\n\nInjected policy");
});

test("uses the last marker when it appears earlier in the prompt", () => {
  const prompt = "Earlier\nCurrent working directory: old\nMore\nCurrent working directory: new";
  assert.equal(
    runInject(prompt, "Injected policy"),
    "Earlier\nCurrent working directory: old\nMore\n\nInjected policy\nCurrent working directory: new",
  );
});

test("strips a trailing current working directory marker", () => {
  const prompt = "Stable prefix\nCurrent working directory: /some/path";
  assert.equal(runStrip(prompt), "Stable prefix");
});

test("preserves a marker that is not at the prompt tail", () => {
  const prompt = "Stable prefix\nCurrent working directory: /some/path\nMore content";
  assert.equal(runStrip(prompt), prompt);
});

test("preserves a prompt without a current working directory marker", () => {
  const prompt = "Stable prompt";
  assert.equal(runStrip(prompt), prompt);
});
