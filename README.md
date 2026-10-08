# pi-job-listener

**Your agent stops waiting for things that are already dead.**

When an agent runs a slow command, it does the intuitive thing: it waits. So it sets a generous timeout
— 300 seconds, 600 seconds — and blocks the whole turn on it. If the build fails at second three, that
is not discovered at second three. It is discovered at second three hundred, when the timeout finally
expires and the shell hands back a wall of output with the failure buried at the bottom. The agent sat
there for five minutes watching a process that had already given up.

`pi-job-listener` replaces the `bash` tool so that does not happen.

- A command that finishes quickly behaves exactly as it does today.
- A command still running after ~5 seconds hands the agent a **pointer** — job id, state, log path — and
  the agent moves on instead of blocking.
- The agent is **woken the moment the job needs it**: it exited, it failed, it hit its timeout, or it
  has gone quiet without printing anything. A doomed process is noticed in seconds, not at the timeout.

The wake message is never a summary. It is a pointer, and the agent reads the log itself.

```
[job-1] exited with code 1 after 7s · 5 lines
command: pytest -q
intent: run the test suite
log: ~/.pi/agent/jobs/20261008-073143/job-1.log
Read the log if you need it. Do not re-run this command.
Look at job-1 before replying. Nothing else here needs a response.
```

That closing line is computed from the outcomes, because a wake is not always a summons. A job that
exited cleanly is news, not work — the agent should carry on rather than write up a job it already
knows about. So a clean finish ends with *"No reply needed — nothing here changes what you were doing.
Do not summarise this wake."*, and a batch containing a failure names the jobs worth looking at and
says the rest can be ignored.

## Install

```bash
pi install npm:pi-job-listener
```

Or from a checkout, which loads live from the working tree:

```bash
pi install ./pi-job-listener
```

Optional: a local [Laya](https://huggingface.co/convaiinnovations/laya) server enables the gate, which
reads ambiguous output and decides whether it is worth waking the agent for. Without it the gate stays
idle and everything else works. See [Configuration](#configuration).

## Wake policy

| Event | What happens |
|---|---|
| command finishes inside the grace window (~5 s) | output returned inline, nothing to wake for |
| job exits | wake, always |
| job exits non-zero | wake, always |
| job exceeds its `timeout` | killed, then wake |
| job prints nothing for `stall_seconds` (default 10) | **wake — the job keeps running**; the agent reads the log and kills it via the `jobs` tool if it is stuck |
| job printed something and is still running | **Laya gate**, shadow mode — logged, not acted on |

Every wake ends with a line saying whether it needs a reply. And a stall for one job is not re-reported
until the job has been quiet for several times its threshold — otherwise a job that prints more slowly
than the threshold reports a stall on every pause, which one measured job did six times in two minutes.

Terminal events bypass the gate on purpose: a model that says "wait" on a finished job strands the
agent. The gate's worst case is a missed optional wake, never an agent asleep on a dead process.

Silence is the one signal that is reported rather than acted on, because the supervisor only sees what
reaches the command's stdout — a command piped into something that buffers, or redirected to a file,
looks exactly like a hang, and so does a build that pauses to think. Killing on that signal destroys
work; reporting it costs one turn. A stall is reported **once per quiet period**: the next report waits
for the job to say something and fall quiet again, so a five-minute silent build produces one wake, not
a wake every ten seconds. The clock restarts when a job is handed back, so a command that printed
nothing at all does not report a stall in the same instant as the pointer describing it.

## Shadow mode

The gate answers every sample and its answer is written to the event log, but nothing acts on it yet.
Zero-shot Laya missed the interactive-prompt case — the one that matters most, because a job waiting
on input hangs forever — and its confidence never exceeded 0.14, so it has to earn its place from real
labelled events before it is allowed to wake anyone.

Each session writes `~/.pi/agent/jobs/<timestamp>/events.jsonl`, one JSON object per line:

```json
{"event":"gate","job":"job-2","shadow":true,"choice":"ignore","confidence":0.0436,
 "probabilities":{"wake":0.1966,"wait":0.375,"ignore":0.4285},
 "stateTokens":200,"expectedTokens":118,"truncated":false,"starved":false,"latencyMs":369}
{"event":"terminal","job":"job-2","reason":"exited","exitCode":0,"lines":23,"seconds":8}
```

Joining the `gate` line to the `terminal` line is the training set: *was ignoring this output correct?*
The valuable rows are the misses — `ignore` followed by an exit code that is not zero.

Fine-tuning is `laya-train` from that JSONL once a few hundred rows exist.

## Tools

- `bash` — supervised shell. Extra parameters: `stall_seconds`, `timeout`.
- `jobs` — `list` / `status` / `tail` / `kill`.
- `/jobs` — the same list in the transcript.

## Reattaching after a restart

Every job is written to `~/.pi/agent/jobs/registry.jsonl` when it starts and updated when it ends. A
later session reads that file on start:

- a job whose pid is **still alive** is adopted — its log is polled for growth, its pid for liveness,
  and a stall is raised if the log stops growing. There is no exit code, because the process was not
  this session's child, and the wake says so.
- a job whose pid is **gone** produced a wake immediately: it ended while nobody was watching.

Without this, a job that outlives a session is lost, which is the one thing a supervisor must not do.

## Training data

```bash
node node_modules/jiti/lib/jiti-cli.mjs scripts/build-training-data.ts --out training-data.jsonl
```

Reads every session's `events.jsonl`, joins each `gate` sample to the `terminal` event that followed
it, and writes `{text, label}` rows for `laya-train`. The labelling rule:

- a job that ended cleanly — **every** sample is a confirmed negative (`wait`)
- a job that failed, stalled or timed out — only the **last** sample before the terminal event is the
  run-up to trouble (`wake`); earlier samples are dropped, because labelling ordinary progress as
  `wake` would teach the gate to cry wolf
- truncated or starved samples are skipped rather than guessed at

It prints the class balance and the shadow gate's current agreement rate. Under 100 samples it tells
you to go and use it rather than write more code.

## The board

While anything is running, the extension draws a small board above the editor and a status line:

```
jobs · gate shadow, not acted on
▶ job-2  pnpm build --filter web        14s        63 ln  laya wait 0.37
✓ job-1  node scripts/fake-job.mjs fast  0s         1 ln  laya —
✗ job-3  pytest -q                      exit 1     412 ln  laya WAKE 0.61
```

- `▶` running, `✓` clean exit, `✗` anything else. Elapsed time ticks once a second while a job runs,
  and switches to `quiet 14s` when a job has gone silent for longer than its stall threshold — the
  same condition that produces a stall wake.
- `laya WAKE 0.61` is the shadow gate's answer, uppercased when it wanted to wake the agent. It is a
  preview of what the gate *would* do — in shadow mode it wakes nobody.
- Finished jobs stay for 30 s so the outcome is visible, then clear themselves. With nothing running
  and nothing recent, the board and the status line both disappear.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_JOB_LISTENER_GRACE_MS` | `5000` | How long a command may run before it is handed back as a job |
| `PI_JOB_LISTENER_STALL_SECONDS` | `10` | Default silence before a job is treated as stalled |
| `PI_JOB_LISTENER_GATE` | on | `off` disables the gate entirely |
| `PI_JOB_LISTENER_GATE_URL` | `http://127.0.0.1:8000/v1/systemone` | Local Laya server |
| `PI_JOB_LISTENER_GATE_MODEL` | `english` | Laya checkpoint. `jev-latest` is rejected — use a Laya name |
| `PI_JOB_LISTENER_GATE_INTERVAL_MS` | `10000` | Minimum gap between gate samples for one job |

## Develop

`node_modules` is a junction to the pi install, so the peer dependencies resolve without a download.

```bash
node node_modules/jiti/lib/jiti-cli.mjs scripts/harness.ts      # job runner, gate, registry
node node_modules/jiti/lib/jiti-cli.mjs scripts/load-check.ts   # full extension against a stub pi API
node scripts/live-test.mjs                                      # a real pi session over RPC
```

`scripts/live-test.mjs` is the one that matters for any change to the wake path: it starts pi in RPC
mode with the extension loaded, prompts it to run a long command, and watches for a turn that starts
by itself. Print mode cannot test this — it exits as soon as the agent settles.

`scripts/fake-job.mjs` provides deterministic stand-ins: `fast`, `build`, `fail`, `quiet`, `hang`.

## Performance (measured 2026-10-08 on this machine)

| | |
|---|---|
| short command (`echo hi`), run directly | 17 ms |
| short command, through the supervisor | 35 ms |
| **overhead added per command** | **~18 ms** |
| pointer returned for a job that outlives the grace window | grace window + ~15 ms |
| wake delivered after the process exits | ~103 ms |
| disk per command | one log file (~3 bytes for `echo hi`) |

The first measurement of that overhead was **43 ms**. `waitForGrace` polled on a 50 ms timer, so a
command that exited in 10 ms was only noticed on the next tick. It resolves on the process's own exit
event now, which removed more than half of it; the rest is spawning a shell and opening the log.

## Known limits (prototype)

- An adopted job has no exit code: the process belonged to an earlier session, so only its pid and its
  log are available. A recycled pid could be mistaken for a live job; the wake reports the exit code
  as unknown rather than inventing one.
- Jobs survive `session_shutdown` on purpose — killing a 20-minute build because a session ended is worse.
  The Laya server is *not* managed yet; start it yourself and set `LAYA_IDLE_UNLOAD_SECONDS=0`.
- Output is not streamed to the transcript while a job runs detached; it goes to the log only.
- `bash` is overridden for every session the extension is loaded in.
- Every command writes a log file, inline ones included, and nothing prunes them: a long session leaves
  a directory of tiny files under `~/.pi/agent/jobs/`. The in-memory job map is kept for the whole
  session too (~20 KB per job, mostly the 200-line tail buffer), so neither the disk nor the memory
  side of a session is bounded yet.

## Verified

- 2026-10-08: a real pi session (RPC mode) detached a job at the grace window, then started a new
  turn on its own 11.8 s in, carrying the pointer and nothing else.
- 21 self-checks across `harness.ts` and `load-check.ts`.
