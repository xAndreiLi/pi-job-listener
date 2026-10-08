# Changelog

## Unreleased

### Added

- **The local model server is now managed per session** (`PI_JOB_LISTENER_LAYA_CMD`). If it is set, a
  session starts the server when it needs one and stops it on shutdown, so nobody has to remember to
  start it or clean it up. Only a server the session started is ever stopped: anything already
  listening is left alone, and a command that dies immediately is reported rather than waited out.
- Session start no longer waits for the gate: the server is resolved in the background, because a
  session opened to run `ls` should not queue behind model weights loading.

## 0.1.2 — 2026-10-08

### Changed

- **The board shows what a job is doing, not what the watcher is called.** Each running job now carries
  the newest line it printed, so you can see progress without opening a log.
- Removed model names, mode names and confidence numbers from the board. A flag on a *running* job now
  reads `⚠ needs a look`; finished jobs never carry one, because their exit code already says whether
  they went well.
- The header states facts — `jobs · 1 running · 1 failed` — instead of naming the mode it runs in.

### Fixed

- **Stall reports are rate-limited per job** (at least 6× the threshold apart, 60 s at the default).
  A job that prints more slowly than its threshold is briefly quiet in every cycle, so it reported a
  stall on each pause: one measured job produced six reports in two minutes, none of them new.
- **A wake says whether it needs a reply.** A batch with a failure names the jobs worth looking at and
  says the rest can be ignored; a clean batch says no reply is needed. A wake that arrives while other
  jobs are still running says the picture is incomplete and to wait or cancel first.

## 0.1.1 — 2026-10-08

Same source as 0.1.0. This release exists to prove the trusted-publishing path: the first version
published by CI over OIDC rather than by a token, with an attestation to match.

### Changed

- The README opens with what the package is for — an agent that blocks a turn on a long timeout does
  not discover a failure at the second it happens, it discovers it when the timeout expires.
- Install instructions: `pi install npm:pi-job-listener`, and the optional Laya server for the gate.

## 0.1.0 — 2026-10-08

First release. A supervisor for long-running processes: the `bash` tool hands back a pointer instead
of blocking the turn, and the agent is woken when the job actually needs it.

### Added

- **`bash` override.** A command still running after the grace window (5 s) returns a job id and a log
  path instead of blocking. Short commands are unaffected. Extra parameters: `timeout` (hard limit,
  killed) and `stall_seconds` (silence threshold, per call).
- **Unconditional wakes** on exit, non-zero exit, and timeout. The wake carries a pointer — job id,
  state, exit code, line count, log path, intent — never a summary of the output.
- **Silence is reported, not punished.** A job quiet for `stall_seconds` wakes the agent and keeps
  running; the agent reads the log and kills it through the `jobs` tool if it is stuck. Reported once
  per quiet period, so a long silent build produces one wake rather than one every ten seconds.
- **`jobs` tool** (`list` / `status` / `tail` / `kill`) and a `/jobs` command.
- **Status line and board** above the editor: what is running, for how long, how many lines, whether it
  has gone quiet, and what the Laya gate would have answered. Finished jobs linger 30 s then clear.
- **Job registry** in `~/.pi/agent/jobs/registry.jsonl`. A later session adopts work that outlived the
  last one — polling its pid and its log, since an adopted process has no exit code to report.
- **Laya gate in shadow mode.** Every sample of running output is put to a local decision model, which
  answers and is logged but never wakes anyone. The answer is joined to the outcome that followed it,
  which is the training set: `scripts/build-training-data.ts` turns it into `laya-train` JSONL.
- **Session event log** at `~/.pi/agent/jobs/<session>/events.jsonl`: one JSON object per event,
  including the exact text the gate saw.

### Notes

- Verified live: a real pi session detached a job, settled, and started a new turn 11.8 s later carrying
  only the pointer.
- Measured: ~18 ms of overhead per short command, ~103 ms between a process exiting and the wake
  arriving. Batching turns N simultaneous job completions into one wake message.
