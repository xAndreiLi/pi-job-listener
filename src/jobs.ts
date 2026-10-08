/**
 * Job runner: spawn a command, tee its output to a log file, and report when it
 * needs attention.
 *
 * The wake policy lives in extension.ts. This file only produces facts about a job:
 * it started, it printed something, it exited, it was killed, or it went quiet.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	createWriteStream,
	openSync,
	readFileSync,
	readSync,
	statSync,
	type WriteStream,
} from "node:fs";

interface ShellSpec {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * Shell resolution is injected: pi passes its own resolver (Git Bash on Windows, honouring
 * the shellPath setting), while the test harness supplies a plain one. Defaults are here so
 * this module stays importable without pi.
 */
let resolveShell = (): ShellSpec =>
	process.platform === "win32"
		? { shell: "cmd.exe", args: ["/d", "/s", "/c"] }
		: { shell: "/bin/sh", args: ["-c"] };

export function configureShell(resolver: () => ShellSpec): void {
	resolveShell = resolver;
}

export type JobState = "running" | "exited" | "timeout" | "stalled" | "killed";

export interface Job {
	id: string;
	command: string;
	/** One line of why this was run — a trailing `# intent: ...` comment, else the command. */
	intent: string;
	cwd: string;
	logPath: string;
	pid: number | undefined;
	startedAt: number;
	endedAt?: number;
	state: JobState;
	exitCode: number | null;
	/** Completed lines seen so far. */
	lines: number;
	totalChars: number;
	lastOutputAt: number;
	/** Silence that counts as a terminal event. Agent-settable per call. */
	stallSeconds: number;
	/** Absolute deadline when the caller passed a `timeout`. */
	timeoutMs?: number;
	/** True once a stall has been reported for the current quiet period. */
	stallReported: boolean;
	/** Newest lines, newest last. Bounded — this is what the gate and the pointer see. */
	tail: string[];	lastGateAt: number;
	detached: boolean;
	/** Job ids are per session; this keys the registry entry it came from. */
	registryKey?: string;
	/** True when the process was started by an earlier session and only re-attached now. */
	adopted?: boolean;
	child?: ChildProcess;
	stream?: WriteStream;
	/** Resolver for waitForGrace, so an inline command is reported the moment it exits. */
	settle?: () => void;
	pending: string;
	timers: { stall?: NodeJS.Timeout; hardTimeout?: NodeJS.Timeout };
}

export interface TerminalReport {
	job: Job;
	reason: "exited" | "timeout" | "stalled" | "killed";
}

/**
 * Silence is reported, never punished.
 *
 * A supervisor only sees what reaches the command's stdout, so piping into a buffering command
 * (`cmd | tail`) or redirecting to a file (`cmd > log`) looks exactly like a hang, as does any build
 * that pauses to think. Killing on that signal destroys work that may have been running for minutes;
 * reporting it costs one turn and leaves the decision with the agent, which can kill the job
 * deliberately through the jobs tool once it has read the log.
 */
export type StallReport = (job: Job) => void;

const TAIL_LINES = 200;
const MAX_LINE_CHARS = 4_000;

export function parseIntent(command: string): string {
	const match = command.match(/#\s*intent:\s*(.+)$/m);
	return match?.[1]?.trim() || command.replace(/\s+/g, " ").slice(0, 160);
}

/**
 * Append one JSONL event. Synchronous on purpose: this log is the training set, and a reader
 * (or the NEXT event) must never observe a half-written line or a missing file.
 */
export function appendEvent(eventsPath: string, event: Record<string, unknown>): void {
	try {
		appendFileSync(eventsPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
	} catch {
		// Event logging must never break a job.
	}
}

export interface StartOptions {
	id: string;
	command: string;
	cwd: string;
	logPath: string;
	stallSeconds: number;
	timeoutSeconds?: number;
	onOutput?: (job: Job, newChunk: string) => void;
	onStall?: StallReport;
	onTerminal: (report: TerminalReport) => void;
}

export function startJob(options: StartOptions): Job {
	const job: Job = {
		id: options.id,
		command: options.command,
		intent: parseIntent(options.command),
		cwd: options.cwd,
		logPath: options.logPath,
		pid: undefined,
		startedAt: Date.now(),
		state: "running",
		exitCode: null,
		lines: 0,
		totalChars: 0,
		lastOutputAt: Date.now(),
		stallSeconds: options.stallSeconds,
		timeoutMs:
			options.timeoutSeconds && options.timeoutSeconds > 0
				? Date.now() + options.timeoutSeconds * 1000
				: undefined,
		tail: [],
		lastGateAt: 0,
		detached: false,
		stallReported: false,
		pending: "",
		timers: {},
	};

	let settled = false;
	let flushed = false;
	const finish = (reason: TerminalReport["reason"], exitCode: number | null) => {
		if (settled) return;
		settled = true;
		clearTimers(job);
		job.state = reason === "exited" ? "exited" : reason;
		job.exitCode = exitCode;
		job.endedAt = Date.now();
		flushPending(job, options.onOutput);
		job.stream?.end();
		flushed = true;
		job.settle?.();
		options.onTerminal({ job, reason });
	};

	// pi's shell resolution: Git Bash on Windows, bash elsewhere, honouring shellPath.
	const shell = resolveShell();
	const viaStdin = shell.commandTransport === "stdin";
	const args = viaStdin ? [...shell.args] : [...shell.args, options.command];
	const detached = process.platform !== "win32";
	const child = spawn(shell.shell, args, {
		cwd: options.cwd,
		env: process.env,
		// POSIX needs its own process group so the tree can be signalled as a group.
		// On Windows `detached: true` silently swallows piped stdout, and taskkill /T
		// already walks the tree, so the child stays attached.
		detached,
		windowsHide: true,
		stdio: viaStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
	});
	if (viaStdin) child.stdin?.end(options.command);

	job.child = child;
	job.pid = child.pid;
	job.stream = createWriteStream(options.logPath, { flags: "w" });
	job.stream.on("error", () => {
		// A failed log must not take the job down; the pointer just points nowhere useful.
	});

	const onData = (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		job.totalChars += text.length;
		job.lastOutputAt = Date.now();
		if (!flushed) job.stream?.write(text);
		ingestLines(job, text);
		resetStallTimer(job, options.onStall);
		options.onOutput?.(job, text);
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);

	child.on("error", () => finish("killed", null));
	child.on("close", (code) => finish("exited", code));

	resetStallTimer(job, options.onStall);
	if (job.timeoutMs) {
		job.timers.hardTimeout = setTimeout(() => {
			killJob(job);
			finish("timeout", null);
		}, Math.max(0, job.timeoutMs - Date.now()));
	}

	return job;
}

/**
 * Resolves true when the job finishes inside the grace window (so it can be reported inline), false
 * when the window closes first. Event-driven on purpose: polling on a timer added the poll interval
 * to every short command — a 10 ms command reported as 60 ms.
 */
export function waitForGrace(job: Job, graceMs: number): Promise<boolean> {
	if (job.state !== "running") return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			job.settle = undefined;
			resolve(false);
		}, graceMs);
		job.settle = () => {
			clearTimeout(timer);
			job.settle = undefined;
			resolve(true);
		};
	});
}

export function killJob(job: Job): boolean {
	if (job.state !== "running" || !job.pid) return false;
	try {
		killProcessTree(job.pid);
		return true;
	} catch {
		return false;
	}
}

/**
 * Kill a process and everything it spawned.
 * Windows needs taskkill /T or grandchildren survive; on POSIX the child is detached
 * (its own process group), so signalling the group is enough.
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		return;
	}
	try {
		if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
		else process.kill(pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

export function recentTail(job: Job, lines = 40): string {
	return job.tail.slice(-lines).join("\n");
}

export function jobsSummary(job: Job): string {
	const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
	const state = job.state === "exited" ? `exited (${job.exitCode})` : job.state;
	return `${job.id} · ${state} · ${seconds}s · ${job.lines} lines · ${job.command.replace(/\s+/g, " ").slice(0, 80)}`;
}

/**
 * (Re)arm the silence timer. It reports once and does not re-arm itself: after the agent has been
 * told, the next report waits for the job to say something and then fall quiet again. Otherwise a
 * build that stays silent for five minutes would wake the agent every ten seconds.
 */
function resetStallTimer(job: Job, onStall?: StallReport): void {
	if (job.timers.stall) clearTimeout(job.timers.stall);
	job.timers.stall = setTimeout(() => {
		if (job.state !== "running") return;
		onStall?.(job);
	}, Math.max(1, job.stallSeconds) * 1000);
}

/**
 * The job has been handed back to the agent, so count silence from here. Without this a command
 * that printed nothing at all would report a stall at the instant it detached, landing right next
 * to the pointer that had just described it.
 */
export function markDetached(job: Job, onStall?: StallReport): void {
	job.detached = true;
	job.lastOutputAt = Date.now();
	resetStallTimer(job, onStall);
}

function clearTimers(job: Job): void {
	if (job.timers.stall) clearTimeout(job.timers.stall);
	if (job.timers.hardTimeout) clearTimeout(job.timers.hardTimeout);
	job.timers = {};
}

/** Split a stream into lines, keeping the tail bounded. Handles \r progress bars. */
function ingestLines(job: Job, text: string): void {
	job.pending += text;
	const parts = job.pending.split(/\r\n|\r|\n/);
	job.pending = parts.pop() ?? "";
	for (const line of parts) {
		job.lines += 1;
		job.tail.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
		if (job.tail.length > TAIL_LINES) job.tail.shift();
	}
}

function flushPending(job: Job, onOutput?: (job: Job, chunk: string) => void): void {
	if (!job.pending) return;
	job.lines += 1;
	job.tail.push(job.pending);
	if (job.tail.length > TAIL_LINES) job.tail.shift();
	onOutput?.(job, job.pending);
	job.pending = "";
}

// ------------------------------------------------------------------ registry

/**
 * The registry is append-only JSONL, latest entry per (session, job) winning. It exists so a
 * session that starts later can find work an earlier session left running.
 */
export interface RegistryEntry {
	session: string;
	job: string;
	pid: number | undefined;
	command: string;
	intent: string;
	logPath: string;
	startedAt: number;
	stallSeconds: number;
	state: string;
}

export function registryKey(session: string, job: string): string {
	return `${session}:${job}`;
}

export function readRegistry(registryPath: string): RegistryEntry[] {
	let lines: string[] = [];
	try {
		lines = readFileSync(registryPath, "utf8").split("\n");
	} catch {
		return [];
	}
	const latest = new Map<string, RegistryEntry>();
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as RegistryEntry;
			if (entry?.job && entry?.session) latest.set(registryKey(entry.session, entry.job), entry);
		} catch {
			// A torn line is not worth failing over.
		}
	}
	return [...latest.values()];
}

export function pidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** How much of the log to pull in when re-attaching: enough for the gate, not the whole file. */
const ADOPT_TAIL_BYTES = 8_000;

/** Read just the end of a log without loading the whole thing into memory. */
function readLogTail(path: string, bytes = ADOPT_TAIL_BYTES): string {
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - bytes);
		const length = size - start;
		if (length <= 0) return "";
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, start);
			return buffer.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

export interface AdoptOptions {
	entry: RegistryEntry;
	onOutput: (job: Job) => void;
	onStall: StallReport;
	onTerminal: (report: TerminalReport) => void;
	pollMs?: number;
}

/**
 * Watch a job a previous session started. Its pid and its log file are all we have: there is no
 * child handle, so no exit code, and no stdout — progress is read back out of the log.
 */
export function adoptJob(options: AdoptOptions): { job: Job; stop: () => void } {
	const { entry } = options;
	const job: Job = {
		id: entry.job,
		command: entry.command,
		intent: entry.intent,
		cwd: "",
		logPath: entry.logPath,
		pid: entry.pid,
		startedAt: entry.startedAt,
		state: "running",
		exitCode: null,
		lines: 0,
		totalChars: 0,
		lastOutputAt: Date.now(),
		stallSeconds: entry.stallSeconds,
		tail: [],
		lastGateAt: 0,
		detached: true,
		adopted: true,
		stallReported: false,
		registryKey: registryKey(entry.session, entry.job),
		pending: "",
		timers: {},
	};

	let size = 0;
	let done = false;
	try {
		size = statSync(entry.logPath).size;
	} catch {
		size = 0;
	}

	const finish = (reason: TerminalReport["reason"]) => {
		if (done) return;
		done = true;
		clearInterval(poll);
		job.state = reason === "exited" ? "exited" : reason;
		job.endedAt = Date.now();
		options.onTerminal({ job, reason });
	};

	const poll = setInterval(() => {
		const now = Date.now();
		let next = size;
		try {
			next = statSync(entry.logPath).size;
		} catch {
			// Log rotated or removed; keep watching the pid.
		}
		if (next > size) {
			size = next;
			job.lastOutputAt = now;
			job.stallReported = false;
			job.totalChars = next;
			// Re-read the end of the log rather than accumulating deltas: we have no stdout here.
			const lines = readLogTail(entry.logPath)
				.split(/\r\n|\r|\n/)
				.filter((line) => line.length > 0);
			job.tail = lines.slice(-TAIL_LINES);
			job.lines = lines.length;
			options.onOutput(job);
		}
		if (!pidAlive(job.pid)) finish("exited");
		else if (now - job.lastOutputAt > job.stallSeconds * 1000 && !job.stallReported) {
			// Report, never kill: an adopted process has no stdout handle, so all we know is that its
			// log stopped growing — which a buffered or file-redirected command does on purpose.
			job.stallReported = true;
			options.onStall(job);
		}
	}, options.pollMs ?? 2_000);

	return {
		job,
		stop: () => {
			done = true;
			clearInterval(poll);
		},
	};
}
