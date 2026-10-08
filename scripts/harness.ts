/**
 * Self-check for the parts of pi-job-listener that do not need pi:
 * the job runner and the Laya gate.
 *
 *   node <pi>/node_modules/jiti/bin/jiti.mjs scripts/harness.ts
 *
 * Stall and timeout values here are deliberately short so the whole run takes seconds;
 * the extension's own defaults are 10 s and none.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askGate, estimateTokens, tailForGate } from "../src/gate.ts";
import {
	type Job,
	type RegistryEntry,
	type TerminalReport,
	adoptJob,
	appendEvent,
	jobsSummary,
	killJob,
	markDetached,
	pidAlive,
	recentTail,
	readRegistry,
	startJob,
	waitForGrace,
} from "../src/jobs.ts";

const dir = mkdtempSync(join(tmpdir(), "pjl-harness-"));
const FIXTURE = "node scripts/fake-job.mjs";
let failures = 0;

function run(
	command: string,
	options: { graceMs?: number; stallSeconds?: number; timeoutSeconds?: number } = {},
): { job: Job; terminal: Promise<TerminalReport>; stalled: Promise<Job> } {
	let resolveTerminal: (report: TerminalReport) => void = () => {};
	let resolveStall: (job: Job) => void = () => {};
	const terminal = new Promise<TerminalReport>((resolve) => {
		resolveTerminal = resolve;
	});
	const stalled = new Promise<Job>((resolve) => {
		resolveStall = resolve;
	});
	const job = startJob({
		id: `t-${Math.random().toString(16).slice(2, 6)}`,
		command,
		cwd: process.cwd(),
		logPath: join(dir, `${Date.now()}.log`),
		stallSeconds: options.stallSeconds ?? 10,
		timeoutSeconds: options.timeoutSeconds,
		onStall: (j) => resolveStall(j),
		onTerminal: resolveTerminal,
	});
	return { job, terminal, stalled };
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`  FAIL ${name}\n       ${(error as Error).message}`);
	}
}

console.log(`harness dir: ${dir}\n\njobs`);

await check("a fast command finishes inside the grace window and reports inline", async () => {
	const { job } = run(`${FIXTURE} fast`, { graceMs: 5000 });
	const finished = await waitForGrace(job, 5000);
	assert.equal(finished, true, "expected the job to finish before the grace window closed");
	assert.equal(job.state, "exited");
	assert.equal(job.exitCode, 0);
	assert.match(recentTail(job), /ok/);
});

await check("a slow command survives the grace window and is still running", async () => {
	const { job, terminal } = run(`${FIXTURE} build`, { graceMs: 1500 });
	const finished = await waitForGrace(job, 1500);
	assert.equal(finished, false, "expected the build to outlive a 1.5 s grace window");
	assert.equal(job.state, "running");
	assert.ok(job.pid, "expected a pid");
	const report = await terminal;
	assert.equal(report.reason, "exited");
	assert.equal(job.exitCode, 0);
	assert.ok(job.lines > 10, `expected progress lines, got ${job.lines}`);
	assert.match(readFileSync(job.logPath, "utf8"), /build complete/);
});

await check("a non-zero exit is reported as an exit with its code", async () => {
	const { job, terminal } = run(`${FIXTURE} fail`, { graceMs: 1000, stallSeconds: 30 });
	const finished = await waitForGrace(job, 1000);
	assert.equal(finished, false);
	const report = await terminal;
	assert.equal(report.reason, "exited");
	assert.equal(job.exitCode, 1);
	assert.match(recentTail(job), /AssertionError/);
});

await check("silence is reported and the job is left running", async () => {
	const { job, stalled } = run(`${FIXTURE} quiet`, { graceMs: 800, stallSeconds: 2 });
	const finished = await waitForGrace(job, 800);
	assert.equal(finished, false, "expected the quiet job to detach");
	const reported = await stalled;
	assert.equal(reported.id, job.id, "the stall should name the job it is about");
	assert.equal(job.state, "running", "a stall must not kill the job");
	// The agent is the one who decides, through the jobs tool.
	assert.equal(killJob(job), true, "a stalled job should still be killable");
});

await check("the silence timer restarts when the job is handed back", async () => {
	const { job } = run(`${FIXTURE} quiet`, { graceMs: 500, stallSeconds: 2 });
	const before = job.lastOutputAt;
	await new Promise((resolve) => setTimeout(resolve, 300));
	markDetached(job, () => {});
	assert.equal(job.detached, true);
	assert.ok(job.lastOutputAt > before, "handing the job back must restart the silence clock");
	killJob(job);
});

await check("a timeout kills the job and reports the timeout", async () => {
	const { job, terminal } = run(`${FIXTURE} quiet`, {
		graceMs: 500,
		stallSeconds: 60,
		timeoutSeconds: 1,
	});
	await waitForGrace(job, 500);
	const report = await terminal;
	assert.equal(report.reason, "timeout");
	assert.equal(job.state, "timeout");
});

await check("killing a job stops its whole process tree", async () => {
	const { job, terminal } = run(`${FIXTURE} build`, { graceMs: 500, stallSeconds: 60 });
	await waitForGrace(job, 500);
	const pid = job.pid;
	assert.ok(pid, "expected a pid");
	assert.equal(killJob(job), true);
	const report = await terminal;
	assert.ok(["killed", "exited"].includes(report.reason), `unexpected reason ${report.reason}`);
	await new Promise((resolve) => setTimeout(resolve, 500));
	let alive = true;
	try {
		process.kill(pid, 0);
	} catch {
		alive = false;
	}
	assert.equal(alive, false, `pid ${pid} survived the tree kill`);
	assert.match(jobsSummary(job), /^t-/);
});

console.log("\ngate");

await check("the gate answers a job-output state", async () => {
	const verdict = await askGate(
		["tests/test_db.py ....F", "AssertionError: connection still in transaction", "1 failed, 311 passed"].join("\n"),
	);
	if (!verdict) {
		console.log("       (Laya not reachable — skipping; start laya-serve on 127.0.0.1:8000)");
		return;
	}
	assert.ok(["wake", "wait", "ignore"].includes(verdict.choice), `unexpected choice ${verdict.choice}`);
	assert.ok(verdict.stateTokens > 0, "expected the response to report state tokens");
	assert.equal(verdict.starved, false, `state was starved: ${verdict.stateTokens} of ~${verdict.expectedTokens} tokens`);
	assert.ok(verdict.latencyMs < 5000, `gate took ${verdict.latencyMs} ms`);
});

await check("tailForGate returns the newest lines, not the oldest", async () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
	const tail = tailForGate(lines);
	assert.match(tail, /line 99/);
	assert.ok(!tail.includes("line 0 "), "the head must not be included");
	assert.ok(tail.length <= 1200);
});

await check("a state far larger than the checkpoint budget is reported as truncated", async () => {
	const huge = Array.from({ length: 400 }, (_, i) => `[${i}] transpiling module ${i} of 400`).join("\n");
	const verdict = await askGate(huge);
	if (!verdict) {
		console.log("       (Laya not reachable — skipping)");
		return;
	}
	assert.equal(verdict.truncated, true, "expected the server to report truncation");
	assert.ok(estimateTokens(huge) > verdict.stateTokens, "expected a shortfall in state tokens");
});

console.log("\nregistry");

await check("the registry keeps the latest state per session and job", async () => {
	const registryPath = join(dir, "registry.jsonl");
	const base = {
		pid: process.pid,
		command: "cmd",
		intent: "cmd",
		logPath: join(dir, "absent.log"),
		startedAt: Date.now(),
		stallSeconds: 10,
	};
	appendEvent(registryPath, { ...base, session: "s1", job: "job-1", state: "running" });
	appendEvent(registryPath, { ...base, session: "s1", job: "job-1", state: "exited" });
	appendEvent(registryPath, { ...base, pid: 999_999, session: "s2", job: "job-1", state: "running" });

	const entries = readRegistry(registryPath);
	assert.equal(entries.length, 2, "two (session, job) keys");
	assert.equal(entries.find((e) => e.session === "s1")?.state, "exited", "the later entry must win");
	assert.equal(pidAlive(process.pid), true, "our own pid is alive");
	assert.equal(pidAlive(999_999), false, "an unused pid must read as dead");
});

await check("a job from a previous session is adopted and watched through its log", async () => {
	const logPath = join(dir, "adopted.log");
	const fd = openSync(logPath, "w");
	const child = spawn(process.execPath, ["scripts/fake-job.mjs", "fail"], {
		cwd: process.cwd(),
		stdio: ["ignore", fd, fd],
	});
	closeSync(fd);

	const entry: RegistryEntry = {
		session: "previous",
		job: "job-9",
		pid: child.pid,
		command: "node scripts/fake-job.mjs fail",
		intent: "fail",
		logPath,
		startedAt: Date.now(),
		stallSeconds: 30,
		state: "running",
	};

	let resolveTerminal: (report: TerminalReport) => void = () => {};
	const terminal = new Promise<TerminalReport>((resolve) => {
		resolveTerminal = resolve;
	});
	let outputCalls = 0;
	const { job } = adoptJob({
		entry,
		onOutput: () => {
			outputCalls += 1;
		},
		onStall: () => {},
		onTerminal: resolveTerminal,
		pollMs: 300,
	});

	assert.equal(job.adopted, true);
	const report = await terminal;
	assert.equal(report.reason, "exited", "the pid going away is how an adopted job ends");
	assert.ok(outputCalls > 0, "expected output observed through the log file");
	assert.ok(job.tail.length > 0, "expected lines read back from the log");
	assert.match(job.tail.join("\n"), /AssertionError/);
});

await check("a job outliving its stall threshold reports silence once, not each time it pauses", async () => {
	// Prints every 1.2 s against a 1 s threshold, so it is briefly quiet in every cycle. Without a
	// cooldown that is a stall report per pause; with one it is a single report.
	let reports = 0;
	const job = startJob({
		id: "t-cooldown",
		command: `${FIXTURE} tick 4 1200`,
		cwd: process.cwd(),
		logPath: join(dir, "cooldown.log"),
		stallSeconds: 1,
		onStall: () => {
			reports += 1;
		},
		onTerminal: () => {},
	});
	await new Promise((resolve) => setTimeout(resolve, 6_000));
	assert.equal(job.state, "exited", "the fixture should have finished");
	assert.equal(reports, 1, `expected one stall report, got ${reports}`);
});

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
