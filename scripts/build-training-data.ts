/**
 * Turn the session event logs into a `laya-train` dataset.
 *
 *   node node_modules/jiti/lib/jiti-cli.mjs scripts/build-training-data.ts [--out training-data.jsonl]
 *
 * The gate logs what it saw and what it answered; the terminal event that follows is the label.
 * Labelling rule, and why it is not simply "label everything with the final outcome":
 *
 *   - a job that ended cleanly: EVERY gate sample is a confirmed negative — nothing about that
 *     output needed the agent, and the job succeeded. Label: wait.
 *   - a job that failed, stalled or timed out: only the LAST sample before the terminal event is
 *     the run-up to trouble, which is the moment worth learning. Label: wake. Earlier samples are
 *     dropped, because labelling normal progress as "wake" would teach the gate to cry wolf.
 *   - jobs with no terminal event yet, and samples the server truncated or starved, are skipped.
 *
 * Samples where the gate saw less state than we sent are excluded rather than guessed at.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? (args[outIndex + 1] ?? "training-data.jsonl") : "training-data.jsonl";
const includeFailedRunupsOnly = !args.includes("--all-samples");

interface Event {
	ts: string;
	event: string;
	job?: string;
	tail?: string;
	choice?: string;
	confidence?: number;
	starved?: boolean;
	truncated?: boolean;
	reason?: string;
	exitCode?: number | null;
	lines?: number;
	previousJob?: string;
}

const jobsRoot = join(getAgentDir(), "jobs");

function sessionDirs(): string[] {
	try {
		return readdirSync(jobsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(jobsRoot, entry.name));
	} catch {
		return [];
	}
}

interface Sample {
	text: string;
	label: "wake" | "wait";
	job: string;
	session: string;
	choice: string;
	index: number;
}

const samples: Sample[] = [];
let jobsSeen = 0;
let skippedNoTerminal = 0;
let skippedUnusable = 0;
const outcomeCounts = { clean: 0, failed: 0, stalled: 0, timeout: 0, killed: 0 };

for (const dir of sessionDirs()) {
	let events: Event[];
	try {
		events = readFileSync(join(dir, "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Event);
	} catch {
		continue;
	}

	const byJob = new Map<string, Event[]>();
	for (const event of events) {
		if (!event.job || event.event === "adopted") continue;
		byJob.set(event.job, [...(byJob.get(event.job) ?? []), event]);
	}

	for (const [job, jobEvents] of byJob) {
		const gates = jobEvents.filter((event) => event.event === "gate" && event.tail);
		if (gates.length === 0) continue;
		jobsSeen += 1;

		const terminal = jobEvents.find((event) => event.event === "terminal");
		if (!terminal) {
			skippedNoTerminal += 1;
			continue;
		}

		const failed =
			terminal.reason === "exited" ? (terminal.exitCode ?? 0) !== 0 : terminal.reason !== "killed";
		const outcome = failed
			? terminal.reason === "exited"
				? "failed"
				: (terminal.reason as "stalled" | "timeout")
			: "clean";
		outcomeCounts[outcome] += 1;

		const usable = gates.filter((event) => !event.starved && !event.truncated);
		skippedUnusable += gates.length - usable.length;
		if (usable.length === 0) continue;

		if (!failed) {
			usable.forEach((event, index) => {
				samples.push({
					text: event.tail!,
					label: "wait",
					job,
					session: dir.split(/[\\/]/).pop()!,
					choice: event.choice ?? "?",
					index,
				});
			});
			continue;
		}

		// The run-up to trouble: the last sample before the terminal event.
		const runup = includeFailedRunupsOnly ? usable.slice(-1) : usable;
		for (const event of runup) {
			samples.push({
				text: event.tail!,
				label: "wake",
				job,
				session: dir.split(/[\\/]/).pop()!,
				choice: event.choice ?? "?",
				index: 0,
			});
		}
	}
}

writeFileSync(outPath, `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`);

const wakes = samples.filter((sample) => sample.label === "wake").length;
const agrees = samples.filter(
	(sample) =>
		(sample.label === "wake" && sample.choice === "wake") ||
		(sample.label === "wait" && sample.choice !== "wake"),
).length;

console.log(`scanned  ${jobsRoot}`);
console.log(`jobs with gate samples: ${jobsSeen}  (${skippedNoTerminal} had no terminal event yet)`);
console.log(
	`outcomes: ${outcomeCounts.clean} clean · ${outcomeCounts.failed} failed · ${outcomeCounts.stalled} stalled · ${outcomeCounts.timeout} timeout · ${outcomeCounts.killed} killed`,
);
console.log(`samples skipped (truncated or starved): ${skippedUnusable}`);
console.log(`\nwrote ${samples.length} samples to ${outPath}`);
console.log(`  wake ${wakes} · wait ${samples.length - wakes}`);
if (samples.length > 0) {
	console.log(
		`  current gate agreement: ${((agrees / samples.length) * 100).toFixed(0)}%  (shadow-mode gate, untuned)`,
	);
}
if (samples.length < 100) {
	console.log("\nUnder 100 samples — keep running normally before fine-tuning; more events, not more code.");
}
