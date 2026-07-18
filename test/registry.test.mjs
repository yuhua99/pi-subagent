import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	bindRowInvalidator,
	completeRun,
	getCompletedRun,
	getLiveStatus,
	getRun,
	listRuns,
	notifyStatus,
	notifyStream,
	registerRun,
	reserveResumeRun,
	resolveLiveResult,
	updateRun,
} from "../registry.ts";

function makeResult(overrides = {}) {
	return {
		agent: "a",
		agentSource: "user",
		task: "t",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

function cleanup() {
	for (const e of listRuns()) completeRun(e.id, e.result);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("registerRun returns a run with a 4-hex id and stores the full task", () => {
	cleanup();
	const long = "x".repeat(200);
	const run = registerRun({ agent: "scout", task: long, pid: 123, startedAt: 1, kill: () => {}, result: makeResult() });
	assert.match(run.id, /^[0-9a-f]{4}$/);
	assert.equal(run.task, long);
	const list = listRuns();
	assert.equal(list.length, 1);
	assert.equal(list[0].agent, "scout");
	assert.equal(list[0].pid, 123);
	cleanup();
});

test("ids are unique across concurrent entries", () => {
	cleanup();
	const ids = new Set();
	for (let i = 0; i < 50; i++) {
		ids.add(registerRun({ agent: "a", task: "t", pid: i, startedAt: 0, kill: () => {}, result: makeResult() }).id);
	}
	assert.equal(ids.size, 50);
	assert.equal(listRuns().length, 50);
	cleanup();
});

test("kill closure fires; getRun returns undefined after completeRun", () => {
	cleanup();
	let killed = false;
	const run = registerRun({ agent: "a", task: "t", pid: 1, startedAt: 0, kill: () => { killed = true; }, result: makeResult() });
	getRun(run.id).kill();
	assert.equal(killed, true);
	completeRun(run.id, makeResult({ exitCode: 0 }));
	assert.equal(getRun(run.id), undefined);
	assert.equal(listRuns().length, 0);
});

test("getRun returns undefined for unknown id", () => {
	cleanup();
	assert.equal(getRun("zzzz"), undefined);
});

test("updateRun replaces result reference", () => {
	cleanup();
	const first = makeResult();
	const run = registerRun({ agent: "a", task: "t", pid: undefined, startedAt: 0, kill: () => {}, result: first });
	const second = makeResult({ exitCode: 0 });
	updateRun(run.id, { result: second, pid: 42 });
	assert.equal(getRun(run.id).result, second);
	assert.equal(getRun(run.id).pid, 42);
	cleanup();
});

test("completeRun fires status subscribers exactly once then clears them", () => {
	cleanup();
	const run = registerRun({ agent: "a", task: "t", pid: undefined, startedAt: 0, kill: () => {}, result: makeResult() });
	let calls = 0;
	run.onStatus(() => { calls++; });
	completeRun(run.id, makeResult({ exitCode: 0 }));
	assert.equal(calls, 1);
	notifyStatus(run.id);
	assert.equal(calls, 1);
});

test("onStatus and onStream unsubscribe works", async () => {
	cleanup();
	const run = registerRun({ agent: "a", task: "t", pid: undefined, startedAt: 0, kill: () => {}, result: makeResult() });
	let s = 0, m = 0;
	const off1 = run.onStatus(() => { s++; });
	const off2 = run.onStream(() => { m++; });
	notifyStatus(run.id);
	assert.equal(s, 1);
	off1();
	off2();
	notifyStatus(run.id);
	assert.equal(s, 1);
	notifyStream(run.id);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(m, 0);
	cleanup();
});

test("notifyStream coalesces rapid notifies into one callback", async () => {
	cleanup();
	const run = registerRun({ agent: "a", task: "t", pid: undefined, startedAt: 0, kill: () => {}, result: makeResult() });
	let calls = 0;
	run.onStream(() => { calls++; });
	notifyStream(run.id);
	notifyStream(run.id);
	notifyStream(run.id);
	assert.equal(calls, 0);
	await sleep(40);
	assert.equal(calls, 1);
	cleanup();
});

test("completeRun cancels a pending stream notification", async () => {
	cleanup();
	const run = registerRun({ agent: "a", task: "t", pid: undefined, startedAt: 0, kill: () => {}, result: makeResult() });
	let calls = 0;
	run.onStream(() => { calls++; });
	notifyStream(run.id);
	completeRun(run.id, makeResult({ exitCode: 0 }));
	await sleep(40);
	assert.equal(calls, 0);
});

test("bindRowInvalidator: single-slot, fired by notifyStatus and by completeRun", () => {
	cleanup();
	const run = registerRun({ agent: "a", task: "t", pid: undefined, startedAt: 0, kill: () => {}, result: makeResult() });
	let a = 0, b = 0;
	bindRowInvalidator(run.id, () => { a++; });
	bindRowInvalidator(run.id, () => { b++; });
	notifyStatus(run.id);
	assert.equal(a, 0);
	assert.equal(b, 1);
	completeRun(run.id, makeResult({ exitCode: 0 }));
	assert.equal(b, 2);
});

test("resolveLiveResult is pure — accepts only one argument", () => {
	cleanup();
	assert.equal(resolveLiveResult.length, 1);
	const live = makeResult();
	assert.deepEqual(resolveLiveResult(live), { result: live, stale: false });
	const run = registerRun({ agent: "a", task: "t", pid: undefined, startedAt: 0, kill: () => {}, result: makeResult({ exitCode: 0, agent: "done" }) });
	const placeholder = makeResult({ registryId: run.id });
	const resolved = resolveLiveResult(placeholder);
	assert.equal(resolved.stale, false);
	assert.equal(resolved.result.agent, "done");
	cleanup();
});

test("getLiveStatus returns completed/running/stale correctly", () => {
	cleanup();
	assert.equal(getLiveStatus("zzzz").kind, "stale");
	const run = registerRun({ agent: "a", task: "t", pid: undefined, startedAt: 0, kill: () => {}, result: makeResult() });
	assert.equal(getLiveStatus(run.id).kind, "running");
	completeRun(run.id, makeResult({ exitCode: 0 }));
	assert.equal(getLiveStatus(run.id).kind, "completed");
});

test("completeRun works even when id is not in running (early-error path)", () => {
	cleanup();
	const r = makeResult({ exitCode: 1 });
	completeRun("dead", r);
	assert.equal(getLiveStatus("dead").kind, "completed");
});

test("resume reservations require a successful completed run in the same parent session", () => {
	cleanup();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
	const sessionPath = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionPath, "{}\n");
	const source = registerRun({
		agent: "a",
		task: "first",
		pid: undefined,
		startedAt: 0,
		kill: () => {},
		result: makeResult(),
		parentSessionId: "parent",
		delegationMode: "spawn",
		sessionPath,
		workingDirectory: dir,
	});
	completeRun(source.id, makeResult({ exitCode: 0 }));

	const reservation = reserveResumeRun(source.id, "follow up", "parent", fs.existsSync, () => {});
	assert.equal("error" in reservation, false);
	if ("error" in reservation) return;
	assert.equal(reservation.source.id, source.id);
	assert.equal(reservation.run.sourceRunId, source.id);
	assert.equal(reservation.run.lineageId, source.id);
	assert.equal(reserveResumeRun(source.id, "parallel follow up", "parent", fs.existsSync, () => {}).error !== undefined, true);

	completeRun(reservation.run.id, makeResult({ exitCode: 1 }));
	const retry = reserveResumeRun(source.id, "retry", "parent", fs.existsSync, () => {});
	assert.equal("error" in retry, false);
	if ("error" in retry) return;
	completeRun(retry.run.id, makeResult({ exitCode: 0 }));
	const descendant = getCompletedRun(retry.run.id);
	assert.equal(descendant?.sourceRunId, source.id);
	const second = reserveResumeRun(retry.run.id, "second follow up", "parent", fs.existsSync, () => {});
	assert.equal("error" in second, false);
	if (!("error" in second)) completeRun(second.run.id, makeResult({ exitCode: 0 }));
	fs.rmSync(dir, { recursive: true, force: true });
});

test("resume reservations reject failed, foreign-session, and missing-session runs", () => {
	cleanup();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
	const sessionPath = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionPath, "{}\n");
	const source = registerRun({
		agent: "a",
		task: "first",
		pid: undefined,
		startedAt: 0,
		kill: () => {},
		result: makeResult(),
		parentSessionId: "parent",
		delegationMode: "fork",
		sessionPath,
	});
	completeRun(source.id, makeResult({ exitCode: 1 }));
	assert.match(reserveResumeRun(source.id, "follow up", "parent", fs.existsSync, () => {}).error, /successfully completed/);

	const foreign = registerRun({
		agent: "a",
		task: "foreign",
		pid: undefined,
		startedAt: 0,
		kill: () => {},
		result: makeResult(),
		parentSessionId: "other",
		delegationMode: "spawn",
		sessionPath,
	});
	completeRun(foreign.id, makeResult({ exitCode: 0 }));
	assert.match(reserveResumeRun(foreign.id, "follow up", "parent", fs.existsSync, () => {}).error, /different parent/);

	const missing = registerRun({
		agent: "a",
		task: "missing",
		pid: undefined,
		startedAt: 0,
		kill: () => {},
		result: makeResult(),
		parentSessionId: "parent",
		delegationMode: "spawn",
		sessionPath: path.join(dir, "missing.jsonl"),
	});
	completeRun(missing.id, makeResult({ exitCode: 0 }));
	assert.match(reserveResumeRun(missing.id, "follow up", "parent", fs.existsSync, () => {}).error, /retain a session/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("killing a reserved resume removes it and releases its lineage lock", () => {
	cleanup();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
	const sessionPath = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionPath, "{}\n");
	const source = registerRun({
		agent: "a",
		task: "first",
		pid: undefined,
		startedAt: 0,
		kill: () => {},
		result: makeResult(),
		parentSessionId: "parent",
		delegationMode: "spawn",
		sessionPath,
	});
	completeRun(source.id, makeResult({ exitCode: 0 }));

	let killCalls = 0;
	const onKill = (id) => {
		killCalls++;
		const entry = getRun(id);
		if (entry) completeRun(id, { ...entry.result, exitCode: 1, stopReason: "killed" });
	};
	const reservation = reserveResumeRun(source.id, "follow up", "parent", fs.existsSync, onKill);
	assert.equal("error" in reservation, false);
	if ("error" in reservation) return;
	reservation.run.kill();
	reservation.run.kill();
	assert.equal(killCalls, 2);
	assert.equal(getRun(reservation.run.id), undefined);
	assert.equal(getCompletedRun(reservation.run.id)?.result.stopReason, "killed");

	const retry = reserveResumeRun(source.id, "retry", "parent", fs.existsSync, onKill);
	assert.equal("error" in retry, false);
	if (!("error" in retry)) completeRun(retry.run.id, makeResult({ exitCode: 0 }));
	fs.rmSync(dir, { recursive: true, force: true });
});
