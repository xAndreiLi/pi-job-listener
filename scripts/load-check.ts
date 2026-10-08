/**
 * Load check: runs the extension against a stub of the pi API, so the whole path can be
 * exercised without starting an agent session.
 *
 *   node node_modules/jiti/lib/jiti-cli.mjs scripts/load-check.ts
 *
 * Proves: the module loads and resolves its imports, the tools and command register,
 * session_start creates the event log, a fast command returns inline, a slow one hands
 * back a pointer, and the wake actually fires when the job ends.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway job history, set before the extension module reads its configuration, so this run
// cannot inherit orphans from an earlier one (or leave any behind for the next).
const jobsRoot = mkdtempSync(join(tmpdir(), "pjl-jobs-"));
process.env.PI_JOB_LISTENER_JOBS_DIR = jobsRoot;
// Pin the grace window: a test must not depend on whatever the product default is today.
process.env.PI_JOB_LISTENER_GRACE_MS = "2000";

interface RegisteredTool {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
	execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
}

const tools = new Map<string, RegisteredTool>();
const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<void>)[]>();
const commands = new Map<string, unknown>();
const sent: { message: any; options: any }[] = [];
const notes: string[] = [];
const lastStatus = new Map<string, string | undefined>();
const lastWidget = new Map<string, string[] | undefined>();
/** While true the stub agent is "busy", so wakes must queue instead of arriving. */
let busy = false;

const pi = {
	registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
	registerCommand: (name: string, options: unknown) => commands.set(name, options),
	on: (event: string, handler: (e: unknown, c: unknown) => Promise<void>) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		return () => {};
	},
	sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	sendUserMessage: () => {},
	appendEntry: () => {},
	getAgentDir: () => process.cwd(),
};

const ctx = {
	isIdle: () => !busy,
	cwd: process.cwd(),
	hasUI: true,
	ui: {
		notify: (text: string) => notes.push(text),
		setStatus: (key: string, text: string | undefined) => lastStatus.set(key, text),
		setWidget: (key: string, content: string[] | undefined) => lastWidget.set(key, content),
	},
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait, but keep printing. Two reasons: the supervisor kills a process that has been quiet for
 * `stall_seconds`, so a test that waits silently gets killed by the thing it is testing; and a
 * heartbeat is what a real long-running process would do anyway.
 */
async function waitWithHeartbeat(ms: number, label: string): Promise<void> {
	const step = 2_000;
	for (let waited = 0; waited < ms; waited += step) {
		await sleep(Math.min(step, ms - waited));
		console.log(`  ..   ${label} (${Math.round((waited + step) / 1000)}s)`);
	}
}

let failures = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`  FAIL ${name}\n       ${(error as Error).message}`);
	}
}

const factory = (await import("../src/extension.ts")).default as (api: unknown) => void;
factory(pi);

await check("registers a bash override, a jobs tool and a /jobs command", async () => {
	assert.ok(tools.has("bash"), "expected a bash tool");
	assert.ok(tools.has("jobs"), "expected a jobs tool");
	assert.ok(commands.has("jobs"), "expected a /jobs command");
	assert.match(tools.get("bash")!.description, /job id/);
	assert.ok((tools.get("bash")!.promptGuidelines ?? []).length >= 2, "expected prompt guidelines");
});

await check("session_start creates the event log and reports gate status", async () => {
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	const note = notes.join(" | ");
	assert.match(note, /pi-job-listener ready/);
	const dir = note.match(/logs (.+?)(?:\s|$)/)?.[1];
	assert.ok(dir, `expected a log directory in: ${note}`);
	assert.ok(existsSync(join(dir!, "events.jsonl")), "expected events.jsonl to exist");
});

await check("a fast command returns its output inline", async () => {
	const result = await tools.get("bash")!.execute("t1", { command: "node scripts/fake-job.mjs fast" }, undefined, undefined, ctx);
	const text = result.content[0].text;
	assert.match(text, /ok/, `expected inline output, got: ${text}`);
	assert.ok(!result.details?.detached, "a fast command must not detach");
});

await check("a slow command hands back a pointer instead of blocking", async () => {
	const result = await tools.get("bash")!.execute(
		"t2",
		{ command: "node scripts/fake-job.mjs build", stall_seconds: 30 },
		undefined,
		undefined,
		ctx,
	);
	const text = result.content[0].text;
	assert.match(text, /\u25b6 job-\d+ running/, `expected a job pointer, got: ${text}`);
	assert.match(text, /log:/);
	assert.equal(result.details?.detached, true);
	assert.ok(existsSync(result.details.log_path), "the log file should exist");
});

await check("the board shows the running job while it is detached", async () => {
	const status = lastStatus.get("pi-job-listener");
	assert.ok(status, "expected a status line while a job runs");
	assert.match(status!, /1 job/);
	const widget = lastWidget.get("pi-job-listener");
	assert.ok(widget, "expected the board while a job runs");
	assert.match(widget![0]!, /gate shadow/);
	assert.match(widget!.join("\n"), /job-2/);
	assert.match(widget!.join("\n"), /\u25b6/, "a running job should be marked as running");
	assert.match(widget!.join("\n"), /laya —/, "no verdict yet, and it must say so");
});

await check("the wake fires when the detached job ends, and is a pointer not a summary", async () => {
	await waitWithHeartbeat(12_000, "waiting for the detached job to end");
	// Count only the wake for the detached job: another one for a job left over by a previous
	// session is the orphan-recovery path doing its job, not a duplicate.
	const forDetached = sent.filter((entry) => /\[job-\d+\] exited with code 0/.test(String(entry.message.content)));
	assert.equal(forDetached.length, 1, `expected exactly one wake for the detached job, got ${forDetached.length}`);
	const { message, options } = forDetached[0];
	const text = message.content as string;
	assert.equal(message.customType, "job-event");
	assert.equal(options.triggerTurn, true, "the wake must trigger a turn");
	assert.match(text, /log: /);
	assert.match(text, /Do not re-run this command/);
	// A pointer, not a digest: no build output should appear in the wake message.
	assert.ok(!/transforming|modules transformed/.test(text), "the wake must not carry output");
});

await check("the board records Laya's verdict and clears the status line when idle", async () => {
	assert.equal(
		lastStatus.get("pi-job-listener"),
		undefined,
		"the status line should clear once nothing is running",
	);
	const widget = lastWidget.get("pi-job-listener") ?? [];
	const rows = widget.join("\n");
	if (rows.includes("laya WAKE") || rows.includes("laya wait") || rows.includes("laya ignore")) {
		assert.match(rows, /laya (WAKE|wait|ignore) \d\.\d\d/, "a verdict should carry its confidence");
	} else {
		console.log("       (no gate verdict this run — the job was shorter than the gate interval)");
	}
	assert.match(rows, /\u2713|\u2717/, "a finished job should show its outcome");
});

await check("shadow gate recorded answers in the event log", async () => {
	const dir = notes.join(" ").match(/logs (.+?)(?:\s|$)/)?.[1];
	assert.ok(dir, `expected a log directory in: ${notes.join(" | ")}`);
	const events = readFileSync(join(dir!, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const kinds = events.map((e) => e.event);
	assert.ok(kinds.includes("started"), `expected a started event, got ${kinds.join(",")}`);
	assert.ok(kinds.includes("detached"), "expected a detached event");
	assert.ok(kinds.includes("terminal"), "expected a terminal event");
	assert.ok(kinds.includes("wake"), "expected a wake event");
	const gates = events.filter((e) => e.event === "gate");
	if (gates.length === 0) {
		console.log("       (no gate sample this run — the job was shorter than the gate interval)");
	} else {
		const gate = gates[0];
		assert.equal(gate.shadow, true, "the gate must be in shadow mode");
		assert.ok(typeof gate.choice === "string", "expected a choice");
		assert.ok(gate.stateTokens > 0, "expected state tokens");
		assert.equal(gate.starved, false, `gate state was starved: ${gate.stateTokens} of ~${gate.expectedTokens}`);
	}
});

await check("the jobs tool reports what ran", async () => {
	const result = await tools.get("jobs")!.execute("t3", { action: "list" }, undefined, undefined, ctx);
	const text = result.content[0].text as string;
	assert.match(text, /job-1/);
	assert.match(text, /job-2/);
});

await check("a batch of jobs collapses to one line each in a single wake", async () => {
	const before = sent.length;
	busy = true;
	// Four jobs that outlive the pinned grace window, started together. Their wakes must queue
	// while the agent is busy and then arrive as one message, not four.
	await Promise.all(
		[0, 1, 2, 3].map((i) =>
			tools.get("bash")!.execute(
				`t-batch-${i}`,
				{ command: "node scripts/fake-job.mjs fail", stall_seconds: 60 },
				undefined,
				undefined,
				ctx,
			),
		),
	);
	await waitWithHeartbeat(9_000, "waiting for four jobs");
	assert.equal(sent.length, before, "nothing may be delivered while the agent is busy");

	busy = false;
	for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
	assert.equal(sent.length, before + 1, `expected one batched wake, got ${sent.length - before}`);

	const text = String(sent[before]?.message.content ?? "");
	assert.match(text, /^4 jobs finished:$/m, `expected a batch header, got: ${text.slice(0, 120)}`);
	const rows = text.split("\n").filter((line) => line.startsWith("[job-"));
	assert.equal(rows.length, 4, `expected four rows, got ${rows.length}`);
	for (const row of rows) {
		assert.match(row, /[\\/][^\\/]+\.log$/, `a compact row must still carry its log: ${row}`);
	}
});

console.log(failures === 0 ? "\nload check passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
