/**
 * Live test: drive a real pi session over RPC and watch a spontaneous wake.
 *
 *   node scripts/live-test.mjs
 *
 * The question this answers that the stub cannot: when pi is genuinely idle — settled, with no
 * input pending — does a `sendMessage(..., { triggerTurn: true })` from a timer start a new turn?
 *
 * Prints a timeline and exits non-zero if no wake turn followed the job.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const CWD = process.cwd();
// --installed drops the -e flag, so the test exercises the globally installed package
// rather than the one-off load. Same process, two very different claims.
const installed = process.argv.includes("--installed");
const PROMPT = [
	"Use the bash tool to run exactly this command, once, with no arguments added:",
	"node scripts/fake-job.mjs fail",
	"Then reply with one short sentence and stop. Do not run anything else, and do not wait for it.",
].join(" ");

const args = ["--mode", "rpc", "--no-session"];
if (!installed) args.push("-e", "./src/extension.ts");
console.log(installed ? "mode: installed package" : "mode: -e (one-off load)");

const child = spawn("pi", args, {
	cwd: CWD,
	shell: true,
	env: process.env,
	stdio: ["pipe", "pipe", "pipe"],
});

const started = Date.now();
const records = [];
const stderr = [];
let settledAt = null;
let wakeAt = null;
let wakeText = null;
let promptSent = false;

function stamp() {
	return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}

function send(command) {
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	// RPC framing is LF-only; a generic line reader would also split on U+2028/U+2029.
	let index = buffer.indexOf("\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).replace(/\r$/, "");
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (line.trim()) handle(line);
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

function handle(line) {
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		return;
	}
	records.push({ t: stamp(), record });
	const type = record.type;

	if (type === "response" && record.command === "prompt" && record.success) {
		console.log(`${stamp()}  prompt accepted (${record.data?.disposition})`);
	}
	if (type === "agent_settled") {
		// The first settle ends the prompted turn; later ones end wake turns. The delay we care
		// about is measured from the first, so it is not overwritten.
		if (!settledAt) settledAt = Date.now();
		console.log(`${stamp()}  agent_settled (idle)`);
	}
	if (type === "agent_start" && settledAt) {
		wakeAt = Date.now();
		console.log(`${stamp()}  agent_start AFTER settling  <-- spontaneous turn`);
	}
	if (type === "message" || type === "message_start" || type === "message_end") {
		const message = record.message ?? record;
		const text = typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "").slice(0, 400);
		if (settledAt && !wakeText) {
			wakeText = text;
			console.log(`${stamp()}  message after settling: ${text.slice(0, 220)}`);
		}
	}
	if (type === "tool_execution_start") {
		console.log(`${stamp()}  tool: ${record.toolName ?? record.name}`);
	}
}

send({ id: "p1", type: "prompt", message: PROMPT });
promptSent = true;
console.log(`${stamp()}  prompt sent`);

// Give the run time to detach the job and then be woken by it.
const deadline = Date.now() + 75_000;
await new Promise((resolve) => {
	const timer = setInterval(() => {
		if (wakeAt && Date.now() - wakeAt > 12_000) {
			clearInterval(timer);
			resolve();
		} else if (Date.now() > deadline) {
			clearInterval(timer);
			resolve();
		}
	}, 500);
});

writeFileSync(join(CWD, "scripts", "live-test-records.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
child.stdin.end();
await new Promise((resolve) => setTimeout(resolve, 1500));
child.kill();

console.log("\n--- verdict ---");
console.log(`prompt sent:            ${promptSent}`);
console.log(`settled:                ${settledAt ? "yes" : "no"}`);
console.log(`spontaneous wake turn:  ${wakeAt ? "yes" : "no"}`);
console.log(`time from settle to wake: ${wakeAt && settledAt ? `${Math.abs(wakeAt - settledAt) / 1000}s` : "n/a"}`);
if (wakeText) console.log(`wake message:\n${wakeText.slice(0, 400)}`);
if (stderr.length) {
	const text = stderr.join("");
	const suspicious = text
		.split("\n")
		.filter((line) => /warn|duplicate|error|extension/i.test(line))
		.slice(0, 6);
	console.log(
		`\nstderr: ${text.length} bytes, ${suspicious.length ? `${suspicious.length} lines worth reading` : "no warnings or errors"}`,
	);
	if (suspicious.length) console.log(suspicious.join("\n"));
}
console.log(`\nfull record stream: scripts/live-test-records.jsonl (${records.length} records)`);
process.exit(wakeAt ? 0 : 1);
