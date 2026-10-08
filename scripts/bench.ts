/**
 * What does the supervisor cost?
 *
 *   node node_modules/jiti/lib/jiti-cli.mjs scripts/bench.ts
 *
 * Measures three things that matter and one that is easy to forget:
 *   - the wall-time overhead added to an ordinary short command
 *   - how much later a detached job's wake arrives after its process actually exited
 *   - what a session leaves on disk and in memory per command
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jobsRoot = mkdtempSync(join(tmpdir(), "pjl-bench-"));
process.env.PI_JOB_LISTENER_JOBS_DIR = jobsRoot;
process.env.PI_JOB_LISTENER_GRACE_MS = "1000";
process.env.PI_JOB_LISTENER_GATE = "off"; // isolate the runner from anything the gate adds

const sent: { message: any; options: any }[] = [];
const tools = new Map<string, any>();
const handlers = new Map<string, any[]>();
const pi = {
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerCommand: () => {},
	on: (event: string, handler: any) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		return () => {};
	},
	sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	sendUserMessage: () => {},
	appendEntry: () => {},
};
const ctx = {
	isIdle: () => true,
	cwd: process.cwd(),
	hasUI: false,
	ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
};

const factory = (await import("../src/extension.ts")).default as (api: unknown) => void;
factory(pi);
for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);

const bash = tools.get("bash")!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const mean = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);

async function through(command: string): Promise<number> {
	const started = Date.now();
	await bash.execute("bench", { command }, undefined, undefined, ctx);
	return Date.now() - started;
}

function direct(command: string): number {
	const started = Date.now();
	spawnSync("cmd.exe", ["/d", "/s", "/c", command], { stdio: "ignore", windowsHide: true });
	return Date.now() - started;
}

const N = 15;
const command = "echo hi";

// Warm both paths: the first supervised command pays module and file setup that the steady state
// does not, and reporting that as overhead would be dishonest.
await through(command);
direct(command);

const directTimes: number[] = [];
const supervisedTimes: number[] = [];
for (let i = 0; i < N; i++) {
	directTimes.push(direct(command));
	supervisedTimes.push(await through(command));
}

console.log(`short command "${command}", ${N} runs`);
console.log(`  direct      median ${median(directTimes)} ms   mean ${mean(directTimes)} ms`);
console.log(`  supervised  median ${median(supervisedTimes)} ms   mean ${mean(supervisedTimes)} ms`);
console.log(
	`  overhead    median ${median(supervisedTimes) - median(directTimes)} ms   mean ${mean(supervisedTimes) - mean(directTimes)} ms`,
);

// ---- wake latency: how long after the process exits does the agent hear about it?
const heapsBefore = process.memoryUsage().heapUsed;
const t0 = Date.now();
await bash.execute("bench-slow", { command: "node -e \"setTimeout(()=>{},2500)\"", stall_seconds: 60 }, undefined, undefined, ctx);
const pointerAt = Date.now() - t0;
const deadline = Date.now() + 8_000;
while (sent.length === 0 && Date.now() < deadline) await sleep(20);
const wakeAt = sent.length ? Date.now() - t0 : NaN;
console.log(`\ndetached job (process exits at ~2500 ms, grace ${process.env.PI_JOB_LISTENER_GRACE_MS} ms)`);
console.log(`  pointer returned at  ${pointerAt} ms`);
console.log(`  wake delivered at    ${wakeAt} ms  (${wakeAt - 2500} ms after the process exited)`);

// ---- disk: every command writes a log, inline or not
const files = readdirSync(jobsRoot, { recursive: true } as never) as string[];
const logs = files.filter((name) => String(name).endsWith(".log"));
let bytes = 0;
for (const name of logs) {
	try {
		bytes += statSync(join(jobsRoot, String(name))).size;
	} catch {
		// vanished
	}
}
console.log(`\ndisk after ${N * 2 + 3} commands`);
console.log(`  ${logs.length} log files, ${bytes} bytes total (${logs.length ? (bytes / logs.length).toFixed(0) : 0} bytes each)`);

// ---- memory: the in-memory job map is never pruned
const heapsAfter = process.memoryUsage().heapUsed;
console.log(`\nmemory`);
console.log(`  heap grew ${Math.round((heapsAfter - heapsBefore) / 1024)} KB across the measured commands`);
console.log(`  note: the jobs map keeps every job for the life of the session, so this grows with use`);
