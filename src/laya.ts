/**
 * Lifecycle for the local decision-model server.
 *
 * The gate wants a warm server, and asking whoever installed the package to keep one running by hand
 * is a poor trade. So: start one when a session needs it, stop it when the session ends — and only
 * ever the one this session started. A server already listening belongs to somebody else (a different
 * checkpoint, a manual run, another tool) and is left exactly where it is.
 *
 * Kept apart from the extension so it can be tested by starting a real process and killing it again.
 */

import { spawn } from "node:child_process";
import { isServerUp } from "./gate.ts";
import { killProcessTree } from "./jobs.ts";

export interface StartOptions {
	/** The gate endpoint, e.g. http://127.0.0.1:8000/v1/systemone — its /health is polled. */
	gateUrl: string;
	/** Shell command that starts the server. */
	command: string;
	/** How long to wait for it to answer /health. Model weights take seconds to load. */
	readyTimeoutMs?: number;
	pollMs?: number;
}

export interface RunningServer {
	pid: number | undefined;
	stop(): void;
}

export async function startLayaServer(options: StartOptions): Promise<RunningServer | undefined> {
	const child = spawn(options.command, {
		shell: true,
		// Same reasoning as the job runner: Windows swallows piped stdio on detached children, and
		// taskkill /T walks the tree anyway.
		detached: process.platform !== "win32",
		windowsHide: true,
		stdio: "ignore",
	});

	let stopped = false;
	const server: RunningServer = {
		pid: child.pid,
		stop: () => {
			stopped = true;
			if (child.pid) killProcessTree(child.pid);
		},
	};

	const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000);
	const pollMs = options.pollMs ?? 1_000;

	while (Date.now() < deadline) {
		if (stopped) return undefined;
		if (await isServerUp(options.gateUrl, 2_000)) return server;
		// A command that failed outright will never become healthy; do not hold the session open for it.
		if (child.exitCode !== null || child.signalCode !== null) return undefined;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}

	// Never leave a half-started server behind for the next session to trip over.
	server.stop();
	return undefined;
}
