/**
 * The Laya gate: asks a local System 1 decision model whether a chunk of process
 * output is worth waking the agent for. Speaks the Jev wire shape (POST /v1/systemone).
 *
 * Two traps this file exists to avoid, both measured on 2026-10-08 (see the wiki page
 * procedures/gotcha-laya-decision-model.md):
 *
 * 1. A verbose question starves the state. Laya splits its context between the question
 *    and the state, and a long instructions string plus wordy criteria left only 14
 *    state tokens in a probe — the model then returned identical probabilities for every
 *    input. The answer looked plausible while it had seen almost nothing. So: terse
 *    question, and assert `state_tokens` against the input length on every call.
 *
 * 2. Truncation keeps the HEAD of the state (laya/common.py: `ids[:max_len]`). A build
 *    log's interesting line is at the end, so we send a bounded tail and flag when the
 *    response reports truncation.
 *
 * The gate never throws and never blocks a wake: on any failure it returns null and the
 * caller records a gate_error. It is in shadow mode for now — it answers, and its answer
 * is logged as training data, but nothing acts on it yet.
 */

export const GATE_URL =
	process.env.PI_JOB_LISTENER_GATE_URL ?? "http://127.0.0.1:8000/v1/systemone";
export const GATE_MODEL = process.env.PI_JOB_LISTENER_GATE_MODEL ?? "english";
export const GATE_ENABLED = process.env.PI_JOB_LISTENER_GATE !== "off";

const REQUEST_TIMEOUT_MS = 5_000;
/** Keeps the state comfortably inside a 512-token checkpoint's budget. */
const MAX_TAIL_CHARS = 1_200;
/** English runs about 4 characters per token; below half of that, the state got eaten. */
const MIN_STATE_TOKEN_RATIO = 0.5;

/** Terse on purpose — every word here competes with the state for the token budget. */
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

export interface GateVerdict {
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
	/** Tokens of state the model actually attended to, after the server dropped what did not fit. */
	stateTokens: number;
	/** What we expected it to see, estimated from the characters we sent. */
	expectedTokens: number;
	truncated: boolean;
	/** The model was shown far less of the log than we sent — treat the answer as unusable. */
	starved: boolean;
	latencyMs: number;
}

interface GateResponse {
	answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
	usage?: {
		state_tokens?: number;
		state_tokens_dropped?: number;
		truncated?: boolean;
		input_tokens?: number;
	};
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Newest lines first-class: the tail is what a gate needs, because truncation keeps the head. */
export function tailForGate(lines: string[], maxChars = MAX_TAIL_CHARS): string {
	const out: string[] = [];
	let used = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? "";
		if (used + line.length + 1 > maxChars && out.length > 0) break;
		out.unshift(line);
		used += line.length + 1;
	}
	return out.join("\n");
}

/** The health endpoint that belongs to a gate URL. */
export function healthUrlFor(gateUrl: string): string {
	return gateUrl.replace(/\/v1\/systemone.*$/, "/health");
}

/** Is anything answering on the gate's health endpoint? */
export async function isServerUp(gateUrl: string, timeoutMs = 2_000): Promise<boolean> {
	try {
		const res = await fetch(healthUrlFor(gateUrl), { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

export async function gateAlive(): Promise<boolean> {
	return isServerUp(GATE_URL, REQUEST_TIMEOUT_MS);
}

export async function askGate(state: string): Promise<GateVerdict | null> {
	const started = Date.now();
	try {
		const res = await fetch(GATE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: GATE_MODEL, state, questions: QUESTION }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) return null;

		const payload = (await res.json()) as GateResponse;
		const answer = payload.answers?.gate;
		if (!answer?.choice) return null;

		// `state_tokens` counts everything the server tokenized, including what it then
		// dropped, so the effective window is the difference. Measuring a 401-line log here
		// reported state_tokens=11177 / dropped=10708 — only ~469 tokens reached the model.
		const fullTokens = payload.usage?.state_tokens ?? 0;
		const dropped = payload.usage?.state_tokens_dropped ?? 0;
		const stateTokens = Math.max(0, fullTokens - dropped);
		const expectedTokens = estimateTokens(state);
		return {
			choice: answer.choice,
			confidence: answer.confidence ?? 0,
			probabilities: answer.probabilities ?? {},
			stateTokens,
			expectedTokens,
			truncated: payload.usage?.truncated === true || dropped > 0,
			starved: expectedTokens > 0 && stateTokens < expectedTokens * MIN_STATE_TOKEN_RATIO,
			latencyMs: Date.now() - started,
		};
	} catch {
		return null;
	}
}
