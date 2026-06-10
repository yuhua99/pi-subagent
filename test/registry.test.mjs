import assert from "node:assert/strict";
import { test } from "node:test";
import {
	getSubagent,
	listSubagents,
	registerSubagent,
	unregisterSubagent,
} from "../registry.ts";

function cleanup() {
	for (const e of listSubagents()) unregisterSubagent(e.id);
}

test("register returns a 4-hex id and list shows the entry", () => {
	cleanup();
	const id = registerSubagent({ agent: "scout", task: "find things", pid: 123, startedAt: 1, kill: () => {} });
	assert.match(id, /^[0-9a-f]{4}$/);
	const list = listSubagents();
	assert.equal(list.length, 1);
	assert.equal(list[0].agent, "scout");
	assert.equal(list[0].pid, 123);
	cleanup();
});

test("task preview is truncated to 80 chars + ellipsis", () => {
	cleanup();
	const long = "x".repeat(200);
	const id = registerSubagent({ agent: "a", task: long, pid: undefined, startedAt: 0, kill: () => {} });
	assert.equal(getSubagent(id).task, `${"x".repeat(80)}...`);
	cleanup();
});

test("ids are unique across concurrent entries", () => {
	cleanup();
	const ids = new Set();
	for (let i = 0; i < 50; i++) {
		ids.add(registerSubagent({ agent: "a", task: "t", pid: i, startedAt: 0, kill: () => {} }));
	}
	assert.equal(ids.size, 50);
	assert.equal(listSubagents().length, 50);
	cleanup();
});

test("kill invokes the registered closure; unregister removes the entry", () => {
	cleanup();
	let killed = false;
	const id = registerSubagent({ agent: "a", task: "t", pid: 1, startedAt: 0, kill: () => { killed = true; } });
	getSubagent(id).kill();
	assert.equal(killed, true);
	unregisterSubagent(id);
	assert.equal(getSubagent(id), undefined);
	assert.equal(listSubagents().length, 0);
});

test("getSubagent returns undefined for unknown id", () => {
	cleanup();
	assert.equal(getSubagent("zzzz"), undefined);
});
