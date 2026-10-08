/**
 * Laya vs Jev, out of the box, on this project's own gate samples.
 *
 *   npm run training:data     # writes training-data.jsonl from the session event logs
 *   npm run compare           # audits the corpus, then scores both models against it
 *
 * It runs in three stages, because the first one decides whether the other two mean anything:
 *
 *   1. AUDIT   is this corpus usable at all? Duplicate rows, identical texts carrying opposite
 *              labels (unlearnable by construction), and how much of the positive class is visible
 *              in the text at all. Labels here are derived from what the job did *after* the sample,
 *              so a "wake" label does not mean the text looked like trouble — often it did not.
 *   2. BASELINE always-wait, always-wake, and a keyword rule. A model that does not beat a regex on
 *              this corpus has not earned a remote call, let alone a wake.
 *   3. MODELS  both models, warm, asked the same question about the same state, with balanced
 *              accuracy, MCC, a Wilson interval on recall, and their positive rate against the base
 *              rate — because "recall" from a model that says wake three times too often is a bias,
 *              not a skill.
 *
 * NOTE: the Jev half uploads the sample text to the provider. The samples are job output.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askGate } from "../src/gate.ts";

interface Sample {
	text: string;
	label: "wake" | "wait";
	job?: string;
	session?: string;
}

interface Verdict {
	choice: string;
	latencyMs: number;
	/** Set when the state never reached the model, so a wrong answer is not scored as a wrong judgement. */
	unusable?: string;
	detail: string;
}

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
	const index = args.indexOf(name);
	return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const dataPath = argOf("--data", "training-data.jsonl");
const repeatCount = Number(argOf("--repeat", "20"));

/** Words that make trouble visible in the text. A reference, not a gate. */
const FAILURE_SIGNAL =
	/(error|fail|traceback|assert|exception|panic|fatal|timed out|cannot|can't|not found|denied|refused|exited with code [1-9]|\bE[45]\d{2}\b|✗|×)/i;

const rows: Sample[] = readFileSync(dataPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as Sample);

// ---------------------------------------------------------------- 1. audit

const byText = new Map<string, Set<string>>();
for (const row of rows) {
	const key = row.text.trim();
	if (!byText.has(key)) byText.set(key, new Set());
	byText.get(key)!.add(row.label);
}
const distinct = [...byText.keys()];
const conflicts = [...byText.values()].filter((labels) => labels.size > 1).length;
const positives = rows.filter((row) => row.label === "wake").length;
const distinctPositives = distinct.filter((text) => byText.get(text)!.has("wake")).length;
const visiblePositives = distinct.filter(
	(text) => byText.get(text)!.has("wake") && FAILURE_SIGNAL.test(text),
).length;

console.log("=== audit ===");
console.log(`rows                 ${rows.length}`);
console.log(`distinct texts       ${distinct.length}  (${rows.length - distinct.length} duplicate rows)`);
console.log(`label conflicts      ${conflicts}  (identical text, opposite labels — unlearnable)`);
console.log(`positives            ${positives} rows · ${distinctPositives} distinct`);
console.log(
	`text-visible positives ${visiblePositives} of ${distinctPositives} distinct  — a perfect reader of the text can score at most ${distinctPositives ? ((visiblePositives / distinctPositives) * 100).toFixed(0) : 0}% recall here`,
);
console.log(
	"note                 labels come from what the job did NEXT, so most positives are ordinary\n" +
		"                     progress that merely preceded a failure. Recall above the ceiling means a\n" +
		"                     model is predicting the future, not reading the text — suspect a wake bias.",
);

// ---------------------------------------------------------------- 2. baselines

function scoreAll(
	label: (sample: Sample) => boolean,
	subset: Sample[] = rows,
): { tp: number; fp: number; fn: number; tn: number } {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	let tn = 0;
	for (const sample of subset) {
		const said = label(sample);
		const was = sample.label === "wake";
		if (was && said) tp += 1;
		else if (!was && said) fp += 1;
		else if (was && !said) fn += 1;
		else tn += 1;
	}
	return { tp, fp, fn, tn };
}

function metrics(counts: { tp: number; fp: number; fn: number; tn: number }) {
	const { tp, fp, fn, tn } = counts;
	const scored = tp + fp + fn + tn;
	const recall = tp + fn > 0 ? tp / (tp + fn) : Number.NaN;
	const precision = tp + fp > 0 ? tp / (tp + fp) : Number.NaN;
	const specificity = tn + fp > 0 ? tn / (tn + fp) : Number.NaN;
	const balanced = (recall + specificity) / 2;
	// Matthews correlation: the one number that stays honest under this class imbalance.
	const denominator = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
	const mcc = denominator > 0 ? (tp * tn - fp * fn) / denominator : 0;
	return {
		scored,
		recall,
		precision,
		balanced,
		mcc,
		...counts,
		positiveRate: scored > 0 ? (tp + fp) / scored : Number.NaN,
	};
}

/** Wilson interval — 12 positives do not justify a bare percentage. */
function wilson(successes: number, total: number): [number, number] {
	if (total === 0) return [Number.NaN, Number.NaN];
	const z = 1.96;
	const p = successes / total;
	const denominator = 1 + (z * z) / total;
	const centre = p + (z * z) / (2 * total);
	const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
	return [(centre - spread) / denominator, (centre + spread) / denominator];
}

const baseRate = positives / rows.length;
const keyword = scoreAll((sample) => FAILURE_SIGNAL.test(sample.text));

console.log("\n=== baselines ===");
const fmt = (value: number) => (Number.isNaN(value) ? "   n/a" : `${(value * 100).toFixed(1)}%`.padStart(6));
console.log(
	`keyword rule        recall ${fmt(metrics(keyword).recall)}  precision ${fmt(metrics(keyword).precision)}  balanced ${fmt(metrics(keyword).balanced)}  MCC ${metrics(keyword).mcc.toFixed(2)}  says-wake ${fmt(metrics(keyword).positiveRate)}`,
);
console.log(
	`always-wait         recall ${fmt(0)}  precision ${fmt(Number.NaN)}  balanced ${fmt(0.5)}  MCC ${metrics({ tp: 0, fp: 0, fn: positives, tn: rows.length - positives }).mcc.toFixed(2)}  says-wake ${fmt(0)}`,
);
console.log(`base rate of wake   ${fmt(baseRate)}`);

// ---------------------------------------------------------------- 3. models

function resolveJev(): { url: string; model: string; key: string; source: string } | undefined {
	let provider = process.env.JEV_PROVIDER ?? "typesafe";
	let envFile = join(homedir(), ".env");
	try {
		const config = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "jev-wiki.json"), "utf8")) as {
			provider?: string;
			envFile?: string;
		};
		provider = config.provider ?? provider;
		envFile = config.envFile ?? envFile;
	} catch {
		// No global config: environment variables alone.
	}
	const candidates =
		provider === "openrouter"
			? ["OPENROUTER_API_KEY", "JEV_TOKEN", "TYPESAFE_API_KEY"]
			: ["TYPESAFE_API_KEY", "JEV_TOKEN"];
	let key = "";
	let source = "";
	for (const name of candidates) {
		if (process.env[name]) {
			key = process.env[name]!;
			source = `env ${name}`;
			break;
		}
	}
	if (!key) {
		try {
			for (const line of readFileSync(envFile, "utf8").split("\n")) {
				const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/);
				if (match && candidates.includes(match[1]!)) {
					key = match[2]!.trim().replace(/^["']|["']$/g, "");
					source = `${envFile} ${match[1]}`;
					break;
				}
			}
		} catch {
			// No env file.
		}
	}
	if (!key) return undefined;
	return provider === "openrouter"
		? { url: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest", key, source }
		: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", key, source };
}

const QUESTION = {
	gate: {
		type: "choice",
		instructions: "Should the agent be woken to look at this process?",
		criteria: {
			wake: "failed, finished, asking a question, or blocked",
			wait: "still working normally",
			ignore: "harmless noise",
		},
	},
} as const;

async function askJev(
	jev: { url: string; model: string; key: string },
	state: string,
): Promise<Verdict> {
	const started = Date.now();
	try {
		const res = await fetch(jev.url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${jev.key}` },
			body: JSON.stringify({ model: jev.model, state, questions: QUESTION }),
			signal: AbortSignal.timeout(30_000),
		});
		const latencyMs = Date.now() - started;
		if (!res.ok) return { choice: "error", latencyMs, unusable: `HTTP ${res.status}`, detail: "" };
		const payload = (await res.json()) as {
			answers?: Record<string, { choice?: string; confidence?: number }>;
			usage?: { input_tokens?: number };
		};
		const answer = payload.answers?.gate;
		if (!answer?.choice) return { choice: "error", latencyMs, unusable: "no answer", detail: "" };
		return {
			choice: answer.choice,
			latencyMs,
			detail: `${payload.usage?.input_tokens ?? 0} tok · conf ${(answer.confidence ?? 0).toFixed(2)}`,
		};
	} catch (error) {
		return { choice: "error", latencyMs: Date.now() - started, unusable: (error as Error).name, detail: "" };
	}
}

async function askLaya(state: string): Promise<Verdict> {
	const verdict = await askGate(state);
	if (!verdict) return { choice: "error", latencyMs: 0, unusable: "unreachable", detail: "" };
	return {
		choice: verdict.choice,
		latencyMs: verdict.latencyMs,
		// A state the model never saw is not a judgement it got wrong.
		unusable: verdict.starved || verdict.truncated ? "state truncated" : undefined,
		detail: `${verdict.stateTokens} tok · conf ${verdict.confidence.toFixed(2)}`,
	};
}

const jev = resolveJev();
if (!jev) console.log("\njev: no credentials found — running Laya alone");

// Preflight before committing an hour to timeouts. A provider that is down does not merely slow the
// run down: samples it never answers would be scored as silence, which is a result about the network
// dressed up as a result about the model.
if (jev) {
	process.stdout.write("preflight: reaching the remote model");
	const probe = await askJev(jev, "preflight probe");
	if (probe.choice === "error") {
		console.log(`\n\naborting: the remote model did not answer a single probe (${probe.unusable ?? probe.choice}).`);
		console.log("Re-run when the provider is healthy — a comparison taken now would measure its outage.");
		// process.exit() drops output still queued to a pipe, which is how an abort message goes missing.
		await new Promise((resolve) => process.stdout.write("", resolve));
		process.exit(2);
	}
	console.log(` ok (${probe.latencyMs} ms)\n`);
}

// Warm both paths first: a cold model load is a latency result, not a model property.
await askLaya("warm up");

console.log("\n=== models ===");
const uniqueSamples = distinct.map((text) => rows.find((row) => row.text.trim() === text)!);
process.stdout.write(`scoring ${uniqueSamples.length} distinct samples`);
const results: { sample: Sample; laya: Verdict; jev?: Verdict }[] = [];
for (const sample of uniqueSamples) {
	const laya = await askLaya(sample.text);
	const jevVerdict = jev ? await askJev(jev, sample.text) : undefined;
	results.push({ sample, laya, jev: jevVerdict });
	process.stdout.write(".");
}
console.log("\n");

function modelMetrics(pick: (row: (typeof results)[number]) => Verdict | undefined) {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	let tn = 0;
	let unusable = 0;
	for (const row of results) {
		const verdict = pick(row);
		// An answer that never arrived is scored as **silence**, not dropped. Excluding it would grade a
		// flaky provider on whichever samples it happened to answer — and if the gate cannot answer, the
		// product's behaviour is not to wake anyone, so that is the honest score.
		const said = !!verdict && !verdict.unusable && verdict.choice === "wake";
		if (!verdict || verdict.unusable || verdict.choice === "error") unusable += 1;
		const was = row.sample.label === "wake";
		if (was && said) tp += 1;
		else if (!was && said) fp += 1;
		else if (was && !said) fn += 1;
		else tn += 1;
	}
	return { ...metrics({ tp, fp, fn, tn }), unusable, scored: results.length };
}

console.log("model            recall  (95% CI)          precision  balanced  MCC   says-wake   TP/FP/FN/TN   no-answer  p50");
for (const [name, pick, latencies] of [
	["laya (local)", (row: (typeof results)[number]) => row.laya, results.map((row) => row.laya.latencyMs)],
	[
		"jev (remote)",
		(row: (typeof results)[number]) => row.jev,
		results.filter((row) => row.jev).map((row) => row.jev!.latencyMs),
	],
] as const) {
	if (name.startsWith("jev") && !jev) continue;
	const m = modelMetrics(pick as (row: (typeof results)[number]) => Verdict | undefined);
	const [low, high] = wilson(m.tp, m.tp + m.fn);
	const sorted = [...latencies].sort((a, b) => a - b);
	console.log(
		`${name.padEnd(16)} ${fmt(m.recall)}  (${fmt(low)}–${fmt(high)})  ${fmt(m.precision)}  ${fmt(m.balanced)}  ${m.mcc.toFixed(2)}  ${fmt(m.positiveRate)}   ${m.tp}/${m.fp}/${m.fn}/${m.tn}     ${String(m.unusable).padStart(2)}      ${sorted[Math.floor(sorted.length / 2)]} ms`,
	);
	if (m.unusable / Math.max(1, m.scored) > 0.2) {
		console.log(
			`                 ^ ${m.unusable} of ${m.scored} samples got no answer — this row measures the provider's availability, not the model.`,
		);
	}
}

// Determinism: the same input twice. A model that answers differently is not a stable gate.
if (repeatCount > 0 && uniqueSamples.length > 0) {
	const subset = uniqueSamples.slice(0, repeatCount);
	let layaStable = 0;
	let jevStable = 0;
	for (const sample of subset) {
		const again = await askLaya(sample.text);
		const first = results.find((row) => row.sample === sample)!;
		if (again.choice === first.laya.choice) layaStable += 1;
		if (jev && first.jev) {
			const jevAgain = await askJev(jev, sample.text);
			if (jevAgain.choice === first.jev.choice) jevStable += 1;
		}
	}
	console.log(
		`\ndeterminism (${subset.length} samples repeated): laya ${layaStable}/${subset.length}${jev ? ` · jev ${jevStable}/${subset.length}` : ""} identical answers`,
	);
}

console.log(
	`\nread this as: ${positives} positives in ${rows.length} rows is a small, outcome-labelled set.\n` +
		`A model beating the keyword rule on recall, balanced accuracy and MCC is worth pursuing; one\n` +
		`that only raises recall while its says-wake rate climbs far above ${fmt(baseRate).trim()} is biased, not skilled.`,
);
