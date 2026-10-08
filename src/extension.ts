/**
 * pi-job-listener — prototype.
 *
 * Replaces the `bash` tool so that a long-running command hands back a pointer instead
 * of blocking the turn. The agent goes idle, and this extension wakes it when the job
 * actually needs attention:
 *
 *   terminal events (exit, non-zero exit, timeout, quiet for stall_seconds) -> always wake
 *   anything else the process prints                                      -> Laya gate, SHADOW MODE
 *
 * Shadow mode is deliberate: the gate answers and its answer is logged, but nothing acts
 * on it. Zero-shot Laya missed the interactive-prompt case that matters most, so it has to
 * earn its place from real labelled events first (see the wiki decision page).
 *
 * The wake message is a pointer — job id, state, exit code, line count, log path — never a
 * summary. The agent reads the log itself.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GATE_ENABLED, GATE_URL, askGate, estimateTokens, gateAlive, tailForGate } from "./gate.ts";
import {
	type Job,
	type RegistryEntry,
	adoptJob,
	appendEvent,
	configureShell,
	jobsSummary,
	killJob,
	markDetached,
	pidAlive,
	readRegistry,
	recentTail,
	registryKey,
	startJob,
	waitForGrace,
} from "./jobs.ts";

// Use pi's own shell resolution (Git Bash on Windows, honouring the shellPath setting).
configureShell(() => getShellConfig());

const GRACE_MS = Number(process.env.PI_JOB_LISTENER_GRACE_MS ?? 5_000);
const DEFAULT_STALL_SECONDS = Number(process.env.PI_JOB_LISTENER_STALL_SECONDS ?? 10);
const GATE_INTERVAL_MS = Number(process.env.PI_JOB_LISTENER_GATE_INTERVAL_MS ?? 10_000);
const GATE_FAILURE_LIMIT = 3;
/** Overridable so a test can run against a throwaway directory instead of the real job history. */
const JOBS_ROOT = process.env.PI_JOB_LISTENER_JOBS_DIR ?? join(getAgentDir(), "jobs");

/** Structural view of the bits of ExtensionContext this extension needs. */
interface Ctx {
	isIdle(): boolean;
	cwd: string;
	hasUI?: boolean;
	ui?: {
		notify(message: string, level?: string): void;
		setStatus?(key: string, text: string | undefined): void;
		setWidget?(key: string, content: string[] | undefined, options?: { placement?: string }): void;
	};
}

const WIDGET_KEY = "pi-job-listener";
const STATUS_KEY = "pi-job-listener";
/** Rows kept on the board; older jobs scroll into the event log. */
const BOARD_ROWS = 5;
/** How long a finished job stays on the board. */
const RECENT_MS = 30_000;
const TICK_MS = 1_000;

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	interface WakeItem {
		id: string;
		text: string;
		/** True when the outcome is something the agent has to decide about. */
		attention: boolean;
	}

	const pendingWakes: WakeItem[] = [];
	let counter = 0;

	let sessionDir = "";
	let eventsPath = "";
	let sessionId = "";
	let registryPath = "";
	let ctxRef: Ctx | undefined;
	let gateReady = false;
	let gateFailures = 0;
	let ticker: NodeJS.Timeout | undefined;
	/** Last gate answer per job — what Laya thought, shown on the board even though it acts on nothing. */
	const gateVerdicts = new Map<string, { choice: string; confidence: number; at: number }>();
	const adoptedWatchers: { stop: () => void }[] = [];

	function logEvent(event: Record<string, unknown>): void {
		if (eventsPath) appendEvent(eventsPath, event);
	}

	/**
	 * The registry outlives the session so a later one can find work this one left running. It is
	 * append-only JSONL; the latest entry per (session, job) wins.
	 */
	function writeRegistry(entry: RegistryEntry): void {
		if (registryPath) appendEvent(registryPath, entry);
	}

	// ---------------------------------------------------------------- the board

	function oneLine(command: string, max = 34): string {
		// Newlines become separators rather than spaces: flattening `cd x\nnpm test` to
		// `cd x npm test` invents a command that was never run.
		const flat = command
			.replace(/\s*\n\s*/g, " ; ")
			.replace(/[ \t]+/g, " ")
			.trim();
		return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
	}

	function secondsSince(from: number, to = Date.now()): number {
		return Math.max(0, Math.round((to - from) / 1000));
	}

	function jobRow(job: Job): string {
		const running = job.state === "running";
		const quietFor = running ? secondsSince(job.lastOutputAt) : 0;
		const icon = running ? "\u25b6" : job.exitCode === 0 ? "\u2713" : "\u2717";
		const state = running
			? quietFor >= job.stallSeconds
				? `quiet ${quietFor}s`
				: `${secondsSince(job.startedAt)}s`
			: job.state === "exited"
				? `exit ${job.exitCode}`
				: job.state;
		const verdict = gateVerdicts.get(job.id);
		// Shadow mode: this is what Laya *would* have done, and it wakes nobody.
		const gate = verdict
			? `laya ${verdict.choice === "wake" ? "WAKE" : verdict.choice} ${verdict.confidence.toFixed(2)}`
			: "laya —";
		return `${icon} ${job.id.padEnd(6)} ${oneLine(job.command, 30).padEnd(30)} ${state.padEnd(8)} ${String(job.lines).padStart(4)} ln  ${gate}`;
	}

	/**
	 * The whole UI: one status line while anything runs, and a small board above the editor.
	 * Nothing is drawn when no job has ever run, so a session that never starts one looks untouched.
	 */
	function renderBoard(): void {
		const ui = ctxRef?.ui;
		if (!ctxRef?.hasUI || !ui) return;

		const all = [...jobs.values()];
		const active = all.filter((job) => job.state === "running");
		// Finished jobs linger briefly so the outcome is visible, then get out of the way.
		const visible = all.filter(
			(job) => job.state === "running" || (job.endedAt ?? 0) > Date.now() - RECENT_MS,
		);

		if (ui.setStatus) {
			if (active.length === 0) {
				ui.setStatus(STATUS_KEY, undefined);
			} else {
				const oldest = active.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
				ui.setStatus(
					STATUS_KEY,
					`\u2699 ${active.length} job${active.length > 1 ? "s" : ""} \u00b7 ${oneLine(oldest.command, 24)} \u00b7 ${secondsSince(oldest.startedAt)}s`,
				);
			}
		}

		if (ui.setWidget) {
			if (visible.length === 0) {
				ui.setWidget(WIDGET_KEY, undefined);
			} else {
				ui.setWidget(
					WIDGET_KEY,
					["jobs \u00b7 gate shadow, not acted on", ...visible.slice(-BOARD_ROWS).map(jobRow)],
					{ placement: "aboveEditor" },
				);
			}
		}

		// Elapsed time only moves while something is on the board; idle costs nothing.
		if (visible.length > 0 && !ticker) ticker = setInterval(renderBoard, TICK_MS);
		if (visible.length === 0 && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	// ---------------------------------------------------------------- waking

	function pointer(job: Job, reason: string): string {
		const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
		if (job.adopted) {
			const state = reason === "stalled" ? `quiet for ${job.stallSeconds}s` : "ended";
			return [
				`[${job.id}] ${state} after ${seconds}s · started by a previous session, so the exit code is unknown`,
				`command: ${oneLine(job.command, 160)}`,
				`intent: ${job.intent}`,
				`log: ${job.logPath}`,
				"Read the log if you need it. Do not re-run this command.",
			].join("\n");
		}
		const state =
			reason === "exited"
				? `exited with code ${job.exitCode}`
				: reason === "stalled"
					? `quiet for ${job.stallSeconds}s`
					: reason;
		return [
			`[${job.id}] ${state} after ${seconds}s · ${job.lines} lines`,
			`command: ${job.command.replace(/\s+/g, " ").slice(0, 160)}`,
			`intent: ${job.intent}`,
			`log: ${job.logPath}`,
			"Read the log if you need it. Do not re-run this command.",
		].join("\n");
	}

	/**
	 * Does this outcome need the agent to decide anything? A clean exit is news, not work: the agent
	 * should carry on rather than reply with a summary of a job it already knows about.
	 */
	function attentionFor(job: Job, reason: string): boolean {
		if (reason !== "exited") return true;
		return (job.exitCode ?? 0) !== 0;
	}

	/** One line per job when a batch is large, so a wake does not fill the transcript. */
	function compactWake(block: string): string {
		const lines = block.split("\n");
		const head = lines[0] ?? block;
		const log = lines.find((line) => line.startsWith("log: "))?.slice(5);
		return log ? `${head} · ${log}` : head;
	}

	/**
	 * One wake per batch, delivered only when the agent is idle. The closing line is computed from the
	 * outcomes so the agent can tell a notification from a summons: without it, every finished job
	 * invites a written reply, and a batch of test runs drags a full report out of an idle agent.
	 */
	function flushWakes(): void {
		if (!pendingWakes.length || !ctxRef?.isIdle()) return;
		const batch = [...pendingWakes];
		pendingWakes.length = 0;

		const needsAttention = batch.filter((item) => item.attention);
		const directive = needsAttention.length
			? `Look at ${needsAttention.map((item) => item.id).join(", ")} before replying. Nothing else here needs a response.`
			: "No reply needed — nothing here changes what you were doing. Do not summarise this wake.";

		const text =
			batch.length === 1
				? `${batch[0]?.text}\n${directive}`
				: [
						`${batch.length} jobs finished · ${needsAttention.length ? `${needsAttention.length} need attention` : "nothing failed"}`,
						...(batch.length > 3 ? batch.map((item) => compactWake(item.text)) : batch.map((item) => item.text)),
						directive,
					].join("\n");

		logEvent({
			event: "wake",
			jobs: batch.map((item) => item.id),
			chars: text.length,
			batched: batch.length,
			attention: needsAttention.length,
		});
		pi.sendMessage({ customType: "job-event", content: text, display: true }, { triggerTurn: true });
	}

	function queueWake(item: WakeItem): void {
		pendingWakes.push(item);
		flushWakes();
	}

	// ----------------------------------------------------------- job events

	function onTerminal(report: { job: Job; reason: string }): void {
		const { job, reason } = report;
		const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
		logEvent({
			event: "terminal",
			job: job.id,
			reason,
			exitCode: job.exitCode,
			lines: job.lines,
			seconds,
		});
		if (job.registryKey) {
			const [session, original] = job.registryKey.split(":");
			writeRegistry({
				session: session ?? sessionId,
				job: original ?? job.id,
				pid: job.pid,
				command: job.command,
				intent: job.intent,
				logPath: job.logPath,
				startedAt: job.startedAt,
				stallSeconds: job.stallSeconds,
				state: job.state,
			});
		}
		renderBoard();

		// A command that finished inside the grace window was reported to the agent inline:
		// it already has the output, so waking it would be pure noise.
		if (!job.detached) {
			logEvent({ event: "inline", job: job.id, reason, exitCode: job.exitCode });
			return;
		}
		queueWake({ id: job.id, text: pointer(job, reason), attention: attentionFor(job, reason) });
	}

	/**
	 * Shadow gate: asks the local model whether this output was worth a wake, and records
	 * the answer. It never wakes anyone. Joined against the terminal event afterwards, this
	 * is the training set for fine-tuning the gate.
	 */
	function onOutput(job: Job): void {
		if (!gateReady) return;
		// Only sample jobs that actually became background work; sampling inline commands
		// would fill the training set with decisions nobody ever faced.
		if (!job.detached && Date.now() - job.startedAt < GRACE_MS) return;
		const now = Date.now();
		if (now - job.lastGateAt < GATE_INTERVAL_MS) return;
		job.lastGateAt = now;

		const tail = tailForGate(job.tail);
		if (!tail.trim()) return;
		const expectedTokens = estimateTokens(tail);

		void askGate(tail).then((verdict) => {
			if (!verdict) {
				gateFailures += 1;
				logEvent({ event: "gate_error", job: job.id, failures: gateFailures });
				if (gateFailures >= GATE_FAILURE_LIMIT) {
					gateReady = false;
					logEvent({ event: "gate_disabled", reason: "repeated failures" });
				}
				return;
			}
			logEvent({
				event: "gate",
				job: job.id,
				shadow: true,
				choice: verdict.choice,
				confidence: Number(verdict.confidence.toFixed(4)),
				probabilities: verdict.probabilities,
				stateTokens: verdict.stateTokens,
				expectedTokens,
				tailChars: tail.length,
				truncated: verdict.truncated,
				starved: verdict.starved,
				latencyMs: verdict.latencyMs,
				// The exact text the model saw: this is the training example, and without it
				// the log cannot be turned into a dataset afterwards.
				tail,
			});
			gateVerdicts.set(job.id, {
				choice: verdict.choice,
				confidence: verdict.confidence,
				at: Date.now(),
			});
			renderBoard();
		});
	}

	// -------------------------------------------------------------- session

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx as unknown as Ctx;
		const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
		sessionId = stamp;
		sessionDir = join(JOBS_ROOT, stamp);
		eventsPath = join(sessionDir, "events.jsonl");
		registryPath = join(JOBS_ROOT, "registry.jsonl");
		try {
			mkdirSync(sessionDir, { recursive: true });
		} catch {
			// If the directory cannot be created the pointer is useless, but the job still runs.
		}

		gateReady = GATE_ENABLED && (await gateAlive());
		logEvent({
			event: "session_start",
			cwd: ctxRef.cwd,
			gateEnabled: GATE_ENABLED,
			gateReady,
			gateUrl: GATE_URL,
			stallSeconds: DEFAULT_STALL_SECONDS,
			graceMs: GRACE_MS,
		});
		if (ctxRef.hasUI) {
			ctxRef.ui?.notify(
				gateReady
					? `pi-job-listener ready · gate shadow-mode on · logs ${sessionDir}`
					: `pi-job-listener ready · gate off (${GATE_ENABLED ? "Laya not reachable" : "disabled"}) · logs ${sessionDir}`,
				gateReady ? "info" : "warning",
			);
		}

		// Work an earlier session left behind: adopt what is still running, and report what
		// finished while nobody was watching. Without this a job that outlives a session is
		// lost for good, which is the one thing a supervisor must not do.
		const orphans = readRegistry(registryPath).filter((entry) => entry.state === "running");
		for (const entry of orphans) {
			if (pidAlive(entry.pid)) {
				const { job, stop } = adoptJob({
					entry,
					onOutput: (j) => onOutput(j),
					onStall,
					onTerminal,
				});
				job.id = `job-${++counter}`;
				jobs.set(job.id, job);
				adoptedWatchers.push({ stop });
				writeRegistry({ ...entry, state: "adopted" });
				logEvent({ event: "adopted", job: job.id, previousJob: entry.job, pid: entry.pid, logPath: entry.logPath });
			} else {
				writeRegistry({ ...entry, state: "orphaned" });
				logEvent({ event: "orphan_ended", job: entry.job, logPath: entry.logPath });
				queueWake({
					id: entry.job,
					attention: true,
					text: [
						`[${entry.job}] ended while no session was watching · log: ${entry.logPath}`,
						`command: ${oneLine(entry.command, 160)}`,
						"Read the log if you need it. Do not re-run this command.",
					].join("\n"),
				});
			}
		}
	});

	// Refresh the context, then deliver anything queued while the agent was working.
	const refresh = (ctx: unknown) => {
		ctxRef = ctx as Ctx;
		flushWakes();
	};
	pi.on("turn_end", async (_event, ctx) => refresh(ctx));
	pi.on("agent_settled", async (_event, ctx) => refresh(ctx));

	pi.on("session_shutdown", async () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		for (const job of jobs.values()) {
			if (job.timers.stall) clearTimeout(job.timers.stall);
			if (job.timers.hardTimeout) clearTimeout(job.timers.hardTimeout);
		}
		for (const watcher of adoptedWatchers) watcher.stop();
		// Running jobs are deliberately left alive: killing a 20-minute build because the
		// session ended is worse than an orphan whose log keeps growing.
		logEvent({ event: "session_shutdown" });
	});

	/**
	 * Silence, reported. The job keeps running — it may simply be thinking, or writing to a file, or
	 * piping into something that buffers. The agent decides whether it is stuck, and kills it through
	 * the jobs tool if it is.
	 */
	function onStall(job: Job): void {
		logEvent({
			event: "stalled",
			job: job.id,
			quietSeconds: secondsSince(job.lastOutputAt),
			stillRunning: true,
			lines: job.lines,
		});
		pendingWakes.push({
			id: job.id,
			attention: true,
			text: [
				`[${job.id}] still running · quiet for ${job.stallSeconds}s · ${job.lines} lines`,
				`command: ${oneLine(job.command, 160)}`,
				`intent: ${job.intent}`,
				`log: ${job.logPath}`,
				"It has not printed anything, which may mean it is thinking or may mean it is stuck on input. Read the log, then kill it with the jobs tool if it is dead.",
			].join("\n"),
		});
		renderBoard();
		flushWakes();
	}

	// ------------------------------------------------------------- bash tool

	pi.registerTool({
		name: "bash",
		label: "bash (supervised)",
		description:
			"Execute a shell command in the current working directory. Short commands return their output as usual. " +
			"A command still running after a short grace period returns a job id and a log path instead of blocking; " +
			"you are woken when it exits, fails, times out, or prints nothing for stall_seconds. Output is truncated to the last 2000 lines.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Hard limit in seconds. The job is killed and you are woken when it is reached.",
				}),
			),
			stall_seconds: Type.Optional(
				Type.Number({
					description:
						"You are woken if the job prints nothing for this many seconds. Default 10. Raise it for commands that are legitimately quiet, such as a long compile.",
				}),
			),
		}),
		promptGuidelines: [
			"Long commands return a job id instead of output: the process keeps running and you are woken when it needs you. Do not re-run a command that returned a job id.",
			"Never use sleep to wait for something. Start the process and wait for the wake message.",
			"Raise stall_seconds for a command that is expected to be quiet for a while; lower it when you need to hear about a hang quickly.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = `job-${++counter}`;
			const logPath = join(sessionDir || getAgentDir(), `${id}.log`);
			const stallSeconds = params.stall_seconds ?? DEFAULT_STALL_SECONDS;

			const job = startJob({
				id,
				command: params.command,
				cwd: (ctx as unknown as Ctx).cwd,
				logPath,
				stallSeconds,
				timeoutSeconds: params.timeout,
				onOutput: (j) => onOutput(j),
				onStall,
				onTerminal,
			});
			jobs.set(id, job);
			job.registryKey = registryKey(sessionId, id);
			renderBoard();
			logEvent({
				event: "started",
				job: id,
				command: params.command,
				intent: job.intent,
				cwd: job.cwd,
				pid: job.pid,
				stallSeconds,
				timeoutSeconds: params.timeout ?? null,
			});
			writeRegistry({
				session: sessionId,
				job: id,
				pid: job.pid,
				command: job.command,
				intent: job.intent,
				logPath: job.logPath,
				startedAt: job.startedAt,
				stallSeconds,
				state: "running",
			});

			const finished = await waitForGrace(job, GRACE_MS);

			if (finished) {
				const shown = job.tail;
				const truncated = job.lines > shown.length;
				const output = shown.join("\n").trim();
				const suffix =
					job.state === "exited"
						? job.exitCode === 0
							? ""
							: `\n[exit code ${job.exitCode}]`
						: `\n[${job.state}]`;
				// A long command used to lose its earlier lines without saying so. The log has all of
				// them, and the built-in bash renderer turns these details into a truncation notice.
				const notice = truncated
					? `\n\n[showing the last ${shown.length} of ${job.lines} lines. Full output: ${logPath}]`
					: "";
				return {
					content: [
						{
							type: "text" as const,
							text: (output || "(no output)") + suffix + notice,
						},
					],
					details: {
						exit_code: job.exitCode,
						fullOutputPath: logPath,
						truncation: truncated
							? {
									truncated: true,
									truncatedBy: "lines" as const,
									outputLines: shown.length,
									totalLines: job.lines,
								}
							: undefined,
					},
					isError: job.state !== "exited" || job.exitCode !== 0,
				};
			}

			job.detached = true;
			markDetached(job, onStall);
			renderBoard();
			logEvent({ event: "detached", job: id, pid: job.pid });
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`\u25b6 ${id} running (pid ${job.pid}) \u00b7 log: ${logPath}`,
							`You will be woken when it exits, fails, times out, or goes quiet for ${stallSeconds}s. Do not re-run it.`,
						].join("\n"),
					},
				],
				details: { job_id: id, log_path: logPath, detached: true },
			};
		},
	});

	// ------------------------------------------------------------- jobs tool

	pi.registerTool({
		name: "jobs",
		label: "jobs",
		description: "List, inspect, or stop processes started by the supervised bash tool.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("status"),
					Type.Literal("tail"),
					Type.Literal("kill"),
				],
				{ description: "What to do" },
			),
			job_id: Type.Optional(
				Type.String({ description: "Job id, for status, tail and kill. Defaults to the most recent job." }),
			),
			lines: Type.Optional(
				Type.Number({ description: "How many trailing lines to return for tail. Default 40." }),
			),
		}),
		async execute(_toolCallId, params) {
			const all = [...jobs.values()];
			if (params.action === "list") {
				const text = all.length
					? all.map(jobsSummary).join("\n")
					: "No jobs in this session.";
				return { content: [{ type: "text" as const, text }], details: { count: all.length } };
			}

			const target = params.job_id
				? jobs.get(params.job_id)
				: all[all.length - 1];
			if (!target) {
				return {
					content: [{ type: "text" as const, text: `No job ${params.job_id ?? "(most recent)"}.` }],
					details: { found: false },
					isError: true,
				};
			}

			if (params.action === "kill") {
				const killed = killJob(target);
				logEvent({ event: "killed", job: target.id, by: "agent" });
				return {
					content: [
						{
							type: "text" as const,
							text: killed ? `Killed ${target.id} and its children.` : `${target.id} was not running.`,
						},
					],
					details: { job_id: target.id, killed },
				};
			}

			const body =
				params.action === "tail"
					? recentTail(target, params.lines ?? 40) || "(no output yet)"
					: jobsSummary(target);
			return {
				content: [{ type: "text" as const, text: body }],
				details: { job_id: target.id, state: target.state, log_path: target.logPath },
			};
		},
	});

	pi.registerCommand("jobs", {
		description: "Show processes supervised by pi-job-listener",
		handler: async (_args, ctx) => {
			const all = [...jobs.values()];
			const text = all.length
				? all.map(jobsSummary).join("\n")
				: `No jobs this session. Logs: ${sessionDir}`;
			(ctx as unknown as Ctx).ui?.notify(text, "info");
		},
	});
}
