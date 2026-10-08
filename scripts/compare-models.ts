/**
 * Laya vs Jev, out of the box, on this project's own gate samples.
 *
 *   npm run training:data     # writes training-data.jsonl from the session event logs
 *   npm run compare           # scores both models against those labels
 *
 * Both models are asked the identical question about the identical state — the question the product
 * actually asks, not a flattering one written for the occasion. Labels come from outcomes: "wake"
 * means the output was the run-up to a failure or a stall, "wait" means the job finished cleanly.
 *
 * What this cannot tell you: 82 samples with 10 positives is a small, lopsided set, and the trivial
 * "always wait" baseline is printed next to the results so it can be judged against something.
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
	detail: string;
}

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
	const index = args.indexOf(name);
	return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const dataPath = argOf("--data", "training-data.jsonl");
const limit = Number(argOf("--limit", "0")) || Number.POSITIVE_INFINITY;

// ---------------------------------------------------------------- the two contestants

/** The remote one: TypeSafe's Jev, resolved the way this machine's wiki tooling resolves it. */
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
		// No global config: fall back to environment variables alone.
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
			// No env file either.
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
): Promise<Verdict | undefined> {
	const started = Date.now();
	try {
		const res = await fetch(jev.url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${jev.key}` },
			body: JSON.stringify({ model: jev.model, state, questions: QUESTION }),
			signal: AbortSignal.timeout(30_000),
		});
		const latencyMs = Date.now() - started;
		if (!res.ok) return { choice: "error", latencyMs, detail: `HTTP ${res.status}` };
		const payload = (await res.json()) as {
			answers?: Record<string, { choice?: string; confidence?: number }>;
			usage?: { input_tokens?: number; output_tokens?: number };
		};
		const answer = payload.answers?.gate;
		if (!answer?.choice) return { choice: "error", latencyMs, detail: "no answer" };
		const tokens = payload.usage?.input_tokens ?? 0;
		return {
			choice: answer.choice,
			latencyMs,
			detail: `${tokens} in-tokens · conf ${(answer.confidence ?? 0).toFixed(2)}`,
		};
	} catch (error) {
		return { choice: "error", latencyMs: Date.now() - started, detail: (error as Error).name };
	}
}

async function askLaya(state: string): Promise<Verdict> {
	const started = Date.now();
	const verdict = await askGate(state);
	if (!verdict) return { choice: "error", latencyMs: Date.now() - started, detail: "unreachable" };
	const detail = verdict.starved
		? `state starved (${verdict.stateTokens} tok)`
		: `conf ${verdict.confidence.toFixed(2)}`;
	return { choice: verdict.choice, latencyMs: verdict.latencyMs, detail };
}

// ---------------------------------------------------------------- scoring

const WAKE_ANSWERED = (choice: string) => choice === "wake";

interface Row {
	sample: Sample;
	laya: Verdict;
	jev?: Verdict;
}

function score(rows: Row[], pick: (row: Row) => Verdict | undefined) {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	let tn = 0;
	let errors = 0;
	for (const row of rows) {
		const verdict = pick(row);
		if (!verdict || verdict.choice === "error") {
			errors += 1;
			continue;
		}
		const saidWake = WAKE_ANSWERED(verdict.choice);
		const wasWake = row.sample.label === "wake";
		if (wasWake && saidWake) tp += 1;
		else if (!wasWake && saidWake) fp += 1;
		else if (wasWake && !saidWake) fn += 1;
		else tn += 1;
	}
	const scored = tp + fp + fn + tn;
	const precision = tp + fp > 0 ? tp / (tp + fp) : Number.NaN;
	const recall = tp + fn > 0 ? tp / (tp + fn) : Number.NaN;
	return {
		scored,
		errors,
		accuracy: scored > 0 ? (tp + tn) / scored : Number.NaN,
		precision,
		recall,
		f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : Number.NaN,
		tp,
		fp,
		fn,
		tn,
	};
}

function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

// ---------------------------------------------------------------- run

const samples: Sample[] = readFileSync(dataPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as Sample)
	.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);

const positives = samples.filter((sample) => sample.label === "wake").length;
console.log(`data     ${dataPath}`);
console.log(`samples  ${samples.length}  (wake ${positives}, wait ${samples.length - positives})`);
console.log(
	`baseline always-wait accuracy ${(((samples.length - positives) / samples.length) * 100).toFixed(1)}%  ·  always-wake ${(((positives) / samples.length) * 100).toFixed(1)}%\n`,
);

const jev = resolveJev();
if (!jev) console.log("jev      no credentials found — running Laya alone\n");
else console.log(`jev      ${jev.model} via ${jev.source}\n`);

const rows: Row[] = [];
process.stdout.write("running");
for (const sample of samples) {
	const laya = await askLaya(sample.text);
	const jevVerdict = jev ? await askJev(jev, sample.text) : undefined;
	rows.push({ sample, laya, jev: jevVerdict });
	process.stdout.write(".");
}
console.log("\n");

const layaScore = score(rows, (row) => row.laya);
const jevScore = jev ? score(rows, (row) => row.jev) : undefined;
const pct = (value: number) => (Number.isNaN(value) ? "  n/a" : `${(value * 100).toFixed(1)}%`.padStart(6));

console.log("model                 scored  err   acc    prec   recall   F1    TP/FP/FN/TN   p50 latency");
console.log(
	`laya (local)          ${String(layaScore.scored).padStart(6)}  ${String(layaScore.errors).padStart(3)}  ${pct(layaScore.accuracy)} ${pct(layaScore.precision)} ${pct(layaScore.recall)} ${pct(layaScore.f1)}   ${layaScore.tp}/${layaScore.fp}/${layaScore.fn}/${layaScore.tn}       ${median(rows.map((row) => row.laya.latencyMs))} ms`,
);
if (jevScore) {
	console.log(
		`jev (remote)          ${String(jevScore.scored).padStart(6)}  ${String(jevScore.errors).padStart(3)}  ${pct(jevScore.accuracy)} ${pct(jevScore.precision)} ${pct(jevScore.recall)} ${pct(jevScore.f1)}   ${jevScore.tp}/${jevScore.fp}/${jevScore.fn}/${jevScore.tn}       ${median(rows.filter((row) => row.jev).map((row) => row.jev!.latencyMs))} ms`,
	);
}

// Where the two disagree, the labels are the tiebreak anyone can check by hand.
const disagreements = rows.filter(
	(row) =>
		row.jev &&
		row.laya.choice !== "error" &&
		row.jev.choice !== "error" &&
		WAKE_ANSWERED(row.laya.choice) !== WAKE_ANSWERED(row.jev.choice),
);
if (disagreements.length > 0) {
	console.log(`\ndisagreements: ${disagreements.length}`);
	for (const row of disagreements.slice(0, 5)) {
		const right = WAKE_ANSWERED(row.laya.choice) === (row.sample.label === "wake") ? "laya" : "jev";
		console.log(
			`  label ${row.sample.label.padEnd(4)} · laya ${row.laya.choice.padEnd(6)} · jev ${row.jev!.choice.padEnd(6)} · ${right} was right · ${row.sample.text.split("\n").pop()?.slice(0, 60) ?? ""}`,
		);
	}
}

console.log(`\nnote     positives are ${positives} of ${samples.length}; treat recall as indicative, not settled`);
