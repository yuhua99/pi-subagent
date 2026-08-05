import assert from "node:assert/strict";
import test from "node:test";
import { AGENTS_OVERLAY_OPTIONS, registerAgentsCommand } from "../agents_command.ts";
import { renderAgentsOverlay } from "../agents_overlay.ts";
import { clearSessionState, registerRun } from "../registry.ts";

function result() {
	return {
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function commandHarness() {
	const calls = [];
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const ctx = {
		hasUI: true,
		ui: {
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
	registerAgentsCommand({ registerCommand(_name, definition) { command = definition; } });
	return { calls, ctx, command };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

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

test("agents overlay renders at narrow widths", () => {
	const theme = { fg: (_color, text) => text };
	for (const width of [1, 2, 3]) {
		assert.doesNotThrow(() =>
			renderAgentsOverlay({ width, terminalRows: 1, theme, header: "header", body: ["body"], footer: "footer" }),
		);
	}
});

test("/agents uses the shared centered overlay and returns from detail to list", async () => {
	clearSessionState();
	let statusUnsubscribed = 0;
	let streamUnsubscribed = 0;
	const run = registerRun({ agent: "worker", task: "task", pid: 1, startedAt: Date.now(), kill() {}, result: result() });
	run.onStatus = () => () => {
		statusUnsubscribed++;
	};
	run.onStream = () => () => {
		streamUnsubscribed++;
	};
	const { calls, command, ctx } = commandHarness();

	const handler = command.handler([], ctx);
	assert.deepEqual(calls[0].options, { overlay: true, overlayOptions: AGENTS_OVERLAY_OPTIONS });
	const listLines = calls[0].component.render(100);
	assertOverlayFrame(listLines, 100);
	calls[0].component.handleInput("\r");
	await nextTurn();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].options, { overlay: true, overlayOptions: AGENTS_OVERLAY_OPTIONS });
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
	registerRun({ agent: "worker", task: "task", pid: 1, startedAt: Date.now(), kill() { killed++; }, result: result() });
	const { calls, command, ctx } = commandHarness();

	const handler = command.handler([], ctx);
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
		registerRun({ agent: `worker-${index}`, task: "task", pid: index, startedAt: Date.now(), kill() {}, result: result() });
	}
	const { calls, command, ctx } = commandHarness();

	const handler = command.handler([], ctx);
	const lines = calls[0].component.render(100);
	assertOverlayFrame(lines, 100);
	assert.match(lines.join("\n"), /\(1\/20\)/);
	calls[0].component.handleInput("\x1b");
	await handler;
	clearSessionState();
});
