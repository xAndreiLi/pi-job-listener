# Timeout kill leaves orphaned grandchildren alive, and reports success

| | |
|---|---|
| **Date** | 2026-10-11 |
| **Target repo** | `C:/Coding/pi-job-listener` |
| **Version verified against** | **0.1.5**, commit `4ecb4b18670e2a20b40f51074edd5a2ce372a410` (2026-10-08) |
| **Requester** | Andrei Li |
| **Written by** | An agent session scoped to `C:/Coding/airbnb-agent` (STR pricing lab), which found the defect while running that project's dev server. That session cannot write this project's wiki, hence the handoff. |
| **Status** | **fixed in pi-job-listener 0.1.6** — the kill now carries a verdict (`confirmed` / `unconfirmed` / `unverified`) into the wake, the `jobs` tool and the event log. One gap is documented rather than closed; see *What 0.1.6 did and did not do* at the end of this file. |
| **Size / priority** | Small–medium (one function's contract + one state) / **medium-high** — it silently misreports process liveness, which is the thing this project exists to report accurately. |
| **Reproduced** | Twice, on different workloads: `next dev` (job-17, 900s timeout, survived holding :3000) and `uvicorn` (job-35, 1800s timeout, survived holding :8005). See *Reproduced on a second command*. |

## How to read this

One request. The backlog at the end is optional triage, clearly separated.

The request is **not** "make the kill work" — the code already attempts the right thing on Windows (`taskkill /T /F`). The request is that a kill be **verified and reported honestly when it fails**, because right now a failed kill is indistinguishable from a successful one and the job is marked `timeout` regardless.

## The ask

**Acceptance criterion.** After a hard-timeout (or stall) kill, the job's terminal state must reflect whether the process tree actually died. If it did not, the wake message must say so and name what survived.

Concretely, any one of these shapes satisfies it:

- `JobState` (`src/jobs.ts:41`) gains a distinguishable state, e.g. `"timeout_unconfirmed"`, **or**
- the job/wake payload gains `killConfirmed: boolean` plus `survivorPids?: number[]`, **or**
- the wake text itself is required to carry an explicit warning when the kill is unconfirmed.

And behaviourally:

1. `killJob` must not return `true` when the kill was not performed or not confirmed.
2. `killProcessTree` must surface failure — the taskkill exit code and stderr must not be discarded.
3. A failed first attempt must be retried or escalated before the job is declared terminal.
4. The wake for an unconfirmed kill should tell the agent the process may still hold its port, so it does not then `curl` the port and conclude the job is healthy.

Minimal shape of the message when unconfirmed:

```
[job-17] timeout after 900s · 0 lines · KILL UNCONFIRMED — tree may still be alive (survivors: 27716)
```

## Why — the incident

An agent ran a Next.js dev server as a supervised job:

```
cd C:/Coding/airbnb-agent && rm -f /tmp/next-dev.log && npm run dev:web > /tmp/next-dev.log 2>&1
```

with `timeout: 900` (the caller's value, not a listener default). At 900s the wake arrived:

```
[job-17] timeout after 900s · 0 lines
```

The `npm` wrapper did die. **The grandchild `next dev` did not.** It survived as pid 27716, kept `:3000` bound, and continued serving requests — a later `curl` to :3000 returned `HTTP 200 in 0.088s`, and the job's own log file grew from 37 to 39 lines as it handled new traffic.

**The damage is the misinformation, not the leak.** The listener considered the job finished; the port considered it alive; the agent could see both signals and had no way to tell which one was authoritative. The agent spent two subsequent turns reporting "job-17 is healthy, not stuck" — because from every observable angle except the listener's own bookkeeping, it *was*. Only the wake message suggested otherwise.

That matters more than a stray process because **an orphaned dev server holding a port is exactly the condition that produces stale-code confusion**. This machine's project wiki already documents that hazard for uvicorn under the same mechanism:

> "netstat showed two listeners on :8005 (old pid and new reloader), and the old worker answered with pre-edit output until the orphan was killed by pid."

Same class, different framework. A supervision tool that reports a clean `timeout` while the process keeps serving is worse than no supervision, because it teaches the agent to trust a status that is wrong.

### Reproduced on a second command

The same failure was observed again later the same day with a different workload, which rules out anything
specific to Next.js or to npm:

```
npm run dev:api   > /tmp/uvicorn.log 2>&1     (launched with timeout: 1800)
```

At 1800s the wake reported `[job-35] timeout after 1800s · 0 lines`. The `npm` launcher (pid 28008) died;
the **`uvicorn` reloader survived as pid 3576** — the same pid it had held since the original launch — kept
`:8005` bound, and kept answering: `HTTP 200 in 0.002034s`, with new lines appended to the job's log as it
served the probe.

Killing it produced the same re-parenting signature as the first incident:

```
SUCCESS: The process with PID 22520 (child process of PID 3576) has been terminated.
SUCCESS: The process with PID 3576 (child process of PID 28136) has been terminated.
```

The reloader's parent at kill time was **28136**, not the launcher 28008 — re-parented away from the tree
rooted at `job.pid`, exactly as in the first incident. **Two workloads, two ports, same signature.**

One difference worth noting for severity: this is the *documented* failure mode of `uvicorn --reload` on this
machine — an orphaned worker serving stale code — which is why a project here already carried a gotcha about
it before either of these incidents. The listener is not creating a new hazard so much as silently failing to
prevent a known one.

## Current behaviour, with evidence

Verified by reading the source at the commit above. **Line numbers will drift — re-read before editing.**

**The timeout path** (`src/jobs.ts:211-214`) — fires the kill, then immediately declares the job finished:

```ts
job.timers.hardTimeout = setTimeout(() => {
	killJob(job);            // :212  return value discarded
	finish("timeout", null); // :213  terminal state set unconditionally
}, Math.max(0, job.timeoutMs - Date.now()));
```

**`killJob`** (`src/jobs.ts:240-248`):

```ts
export function killJob(job: Job): boolean {
	if (job.state !== "running" || !job.pid) return false;  // :241
	try {
		killProcessTree(job.pid);
		return true;                                          // :244
	} catch {
		return false;
	}
}
```

**`killProcessTree`** (`src/jobs.ts:255-270`), Windows branch at `:256-262`:

```ts
if (process.platform === "win32") {
	spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
		stdio: "ignore",     // :258  result object never inspected
		windowsHide: true,
	});
	return;                  // :261
}
```

Three concrete, code-grounded defects:

- **D1 — taskkill's result is thrown away.** `spawnSync` returns `{status, signal, stdout, stderr, error}`; `:258` sets `stdio: "ignore"` and the return value is not assigned. A taskkill that failed, or that hit a PID that no longer existed ("process not found"), is indistinguishable from one that succeeded.
- **D2 — `killJob` structurally cannot report Windows failure.** `killProcessTree` swallows everything and returns early on Windows, so the `catch` at `:246` is unreachable there and `:244` always returns `true` whenever the `:241` guard passes. The boolean is consumed at `src/extension.ts:751` (`const killed = killJob(target);`) by the `jobs` tool's kill action, so the misleading value is surfaced to agents too.
- **D3 — no verification, no retry.** `finish("timeout", null)` runs on the next line with nothing confirming the tree is gone. There is no grace period and no second attempt.

**Why `taskkill /T` can miss the grandchild — hypothesis, not verified.** `job.pid` is the **shell's** pid, assigned at `src/jobs.ts:188` (`job.pid = child.pid`) right after spawning `shell.shell` (`:174-185`), so the tree is `bash.exe → npm.cmd / cmd.exe → node.exe (npm) → node.exe (next dev)`. `taskkill /T` walks the tree using recorded parent PIDs; on Windows an intermediate launcher that exits can leave its children re-parented or carrying a stale `ParentProcessId`, and the walk from the root then cannot reach them. I did **not** confirm which mechanism applied here — I captured no process listing at kill time, and the diagnostic that would have shown it was discarded by D1.

**Note the deliberate design this depends on** (`src/jobs.ts:174-181`) — the existing comment already recognises the constraint:

```ts
const detached = process.platform !== "win32";
// POSIX needs its own process group so the tree can be signalled as a group.
// On Windows `detached: true` silently swallows piped stdout, and taskkill /T
// already walks the tree, so the child stays attached.
```

So on Windows there is **one** mechanism and no fallback, where POSIX has two (`process.kill(-pid)` then `process.kill(pid)`).

## Decisions already made — do not relitigate

- **The 900s timeout was the caller's configuration, not a listener default.** The bug is the orphan and the false report, not the existence of timeouts. Removing timeouts is the wrong fix.
- **`detached: false` on Windows is correct and intentional** (`:176-181`). Do not "fix" this by detaching on Windows — that was already rejected for swallowing piped stdout, and stdout capture is the whole point of the tool.
- **The listener stays gate-only and wakes stay pointers.** Do not turn wakes into summaries; the closing line is computed from outcomes deliberately.
- **POSIX is fine.** `process.kill(-pid)` on a detached child is sound. Do not unify the two paths.

## Implementation plan

The seam is `killProcessTree` (`src/jobs.ts:255`) plus its caller `killJob` (`:240`), with the terminal-state decision at `src/jobs.ts:211-214`.

1. **`src/jobs.ts:255` — make `killProcessTree` report.** Return a result instead of `void` — e.g. `{ok: boolean, detail?: string}`. On Windows, assign the `spawnSync` result and inspect `status`/`error`; capture stderr into `detail`. Keep `stdio` piped rather than `"ignore"` so stderr is available (it is small and bounded).
2. **`src/jobs.ts:240` — make `killJob` honest.** Return the confirmed outcome. Keep the `:241` guard (a non-running job is legitimately `false`), but stop returning `true` on an unverified Windows kill.
3. **Add a confirm-and-retry helper** near `killProcessTree`, async to match the file's timer style: after the first kill, wait a short grace period (~250–500ms), check whether `job.pid` still exists, and if it does, escalate. On Windows escalation is a second `taskkill /T /F`, and if that also fails, enumerate descendants and kill leaf-first — PowerShell `Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"` or `wmic process where "ParentProcessId=<pid>"` (check availability on the target Windows version; `wmic` is deprecated).
4. **`src/jobs.ts:41` — extend `JobState`** with an unconfirmed-kill state, or add `killConfirmed`/`survivorPids` to the job record. Pick one; do not do both.
5. **`src/jobs.ts:211-214`** — await the confirm step (or handle its promise), then set the terminal state from its result.
6. **The wake formatter** — when the kill is unconfirmed, append the explicit warning and the surviving pids, so an agent does not read the port as proof of health.
7. **`src/extension.ts:751`** — the `jobs` kill action now receives a meaningful boolean; make sure its user-facing message reflects it.

## Gotchas

- **This extension is loaded from source, not from npm.** `C:/Users/liand/.pi/agent/settings.json` lists the entry as `..\\..\\..\\..\\Coding\\pi-job-listener`, so a change here takes effect on the next session with no install step — and a broken build breaks the agent's `bash` tool for **every** session on this machine. `npm run test:all` exists for a reason.
- **`job.pid` is the shell's pid**, not the workload's (`:188`). Any verification must reason about the tree; do not assume `job.pid` names the process that writes to the port.
- **`spawnSync` blocks the event loop.** A retry-with-sleep must use async timers, consistent with the `setTimeout` usage elsewhere in the file.
- **`killProcessTree` is exported and shared.** It is used by the `jobs` tool's manual `kill` action, not only by the timeout path, so its contract change affects manual kills too.
- **`stdio: "ignore"` is load-bearing for silence, not for correctness.** If you pipe stderr to inspect it, make sure a failing taskkill cannot leak output into any user-visible stream — route it to the job log or a diagnostic field.
- **Timing.** A process that has just received `/F` may take a moment to disappear from the process table. A confirm check that is too eager will report false negatives; too slow and the wake is delayed. A few hundred milliseconds with one retry is a reasonable first cut.

## Tests and docs

- **`scripts/harness.ts` is the suite** (`npm run test:jobs` → `jiti scripts/harness.ts`; `test:all` also runs `scripts/load-check.ts`).
- **The existing assertions are the problem, not the safety net.** `scripts/harness.ts:115` and `:145` both assert `equal(killJob(job), true, ...)`. That passes today *because* D2 makes the return value structurally true on Windows — so the suite gives false confidence in exactly the behaviour under repair. Update these to assert on the new contract and add a case where the kill cannot be confirmed.
- **Add a regression test that spawns a real tree with a grandchild that outlives its parent** — a shell launching a launcher launching a long-lived process — then times out the job and asserts no descendant survives. This is the only test that would have caught the incident.
- **No `docs/` directory exists in the repo**, and the README is the canonical user-facing description. If the wake message gains a new field, `README.md` describes the wake format and must be updated with it.

## Out of scope

- Changing timeout semantics, the stall threshold, the Laya gate, or the wake/no-reply decision logic.
- Any general-purpose process supervision or reaping daemon. The ask is confined to confirming a kill the code already attempts.
- POSIX behaviour, which is sound.
- **The wrong turn:** "the timeout was too short" or "long-running jobs shouldn't have timeouts". The timeout behaved exactly as configured; lengthening it would only have delayed the same orphan.

## Verification checklist

- [ ] A hard timeout on a job whose command spawns a grandchild leaves **no** surviving process (check the pid and the port).
- [ ] When the tree genuinely is gone, the wake message is unchanged in shape — no new noise on the happy path.
- [ ] When the kill cannot be confirmed, the wake explicitly says so and names the survivors.
- [ ] `killJob` returns `false` (or a non-confirmed result) when the process survived, and `true` only when it did not.
- [ ] Existing `scripts/harness.ts` cases updated for the new contract; a genuine orphan case added and failing before the fix.
- [ ] `npm run test:all` passes.
- [ ] A manual `jobs` kill (`src/extension.ts:751`) still kills and now reports accurately.
- [ ] No regression in stdout capture on Windows (the reason `detached` is false).

## Provenance

Written by an agent session scoped to `C:/Users/liand/airbnb-agent`, which is not scoped to this project and cannot write this project's wiki, on Andrei Li's instruction.

**Verified:** every `file:line` above was read at commit `4ecb4b1`, version 0.1.5. The version claim that this source is the running code comes from `C:/Users/liand/.pi/agent/settings.json` loading the extension from the repo path rather than an installed package.

**Not verified:**

- **Partly resolved after writing.** When the surviving processes were finally killed, `taskkill` reported `SUCCESS: The process with PID 27716 (child process of PID 13524) has been terminated.` — and for the second incident, `PID 3576 (child process of PID 28136)`. In both cases the orphan's parent at kill time was some unrelated pid, not any process in the shell → `npm` → workload chain, which is direct evidence that it had been **re-parented** away from the tree rooted at `job.pid`. So re-parenting is the mechanism rather than a taskkill error. What is still unproven is that `taskkill /T` was ever issued against the survivors at all, since D1 discarded its output.
- The precise reason the re-parent happened — an exiting `cmd.exe` shim under `npm.cmd` is the likely trigger, but unconfirmed.
- Whether this also affects jobs that **exit normally** rather than timing out. The stall path uses the same `killJob`, so it is likely, but only the timeout path was observed.
- Whether the same failure occurs for the `jobs` tool's manual kill.
- I did not build or run this project's test suite, and did not reproduce the incident deliberately — it occurred incidentally while running another project's dev server.

---

## What 0.1.6 did and did not do

Written after the fix, by the session that made it (2026-10-11).

**Done.** D1–D3 are closed: `killProcessTree` reports the `taskkill` exit code and stderr, `killJob`
returns a verdict instead of a structurally-true boolean, and the timeout path kills, waits 400 ms,
escalates once (a second `taskkill` plus a direct signal), then sets the terminal state from what it
could see. The wake, `jobs kill`, `jobs list` and the `terminal` line in `events.jsonl` all carry the
verdict. `scripts/harness.ts` gained three checks, including the grandchild-outlives-its-launcher case,
which fails against 0.1.5.

**The mechanism, confirmed.** A reproduction of `bash -> npm.cmd -> cmd -> node` shows what the
handoff could only hypothesize: after `taskkill /PID <shell> /T /F` exited 0, five descendants
survived, and their recorded parent pids pointed at processes that had already exited (MSYS2 `bash`
re-execs through transient processes; `npm.cmd`'s `cmd.exe` exits). `taskkill /T` walks *recorded
parent pids*, so it cannot cross a link whose parent is gone, and it does not report having missed
anything. Surviving the parent's exit is also why the port probe found them alive: nothing had ever
covered them.

**What is still not done — the honest gap.** Verification on Windows is observation, not proof: the
kill is reported `unverified` (nothing visible survived, but the whole tree could not be seen) rather
than `confirmed`, and `confirmed` now means "POSIX process group signalled, nothing left holding the
output". The one thing that *does* prove a survivor on Windows is the job's own stdout: a process that
inherited it keeps the pipe open, so the shell's `close` never fires and the kill is reported
`unconfirmed` — which is exactly how the incident's log kept growing. A child that redirected its
output elsewhere escapes every check the extension has, and that case is reported `unverified` rather
than "clean".

**The real fix, not taken here.** A Windows job object (`CreateJobObject` +
`AssignProcessToJobObject` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) is the only mechanism that both
contains the tree and can be asked what is left in it. It has to exist before the shell's first fork,
so the process that launches the shell must own the job: that is a change to the *spawn* path rather
than the kill path, and too much for a patch release. Until then, a Windows timeout says
`KILL UNVERIFIED`, and the wake tells the agent that a port still answering is the orphan.

**Left open from the original write-up:** whether the grandchild escaped because `taskkill /T` never
reached it or because it had already been re-parented (the reproduction says the latter), and whether
normal exits leak the same way — the reproduction suggests they would, since the leak is a property of
the launcher chain, not of the kill.
