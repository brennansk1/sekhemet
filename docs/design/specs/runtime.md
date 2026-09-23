---
spec: runtime
status: partial
audiences: [developer]
code:
  - apps/harness/src/daemon.ts
  - apps/harness/src/pm/service.ts
  - apps/harness/src/server.ts
  - apps/harness/src/rest_extra.ts
  - apps/harness/src/wave2_server.ts
  - apps/harness/src/ws.ts
  - apps/harness/src/overnight.ts
  - apps/harness/src/scheduler.ts
  - apps/harness/src/recurring.ts
  - apps/harness/src/governance.ts
  - apps/harness/src/tracing.ts
  - apps/harness/src/replay.ts
  - packages/kernel/src/retention.ts
  - packages/sandbox/src/executor.ts
tests:
  - apps/harness/tests/daemon_ws.spec.ts
  - apps/harness/tests/server.spec.ts
  - apps/harness/tests/rest_extra.spec.ts
  - apps/harness/tests/control.spec.ts
  - apps/harness/tests/replay.spec.ts
  - apps/harness/tests/overnight.spec.ts
  - apps/harness/tests/recurring.spec.ts
  - apps/harness/tests/tracing.spec.ts
  - packages/kernel/tests/blobs_retention.spec.ts
  - packages/sandbox/tests/containment.spec.ts
changes: [T5, P9, S3c]
---

# Runtime: the supervisor, runs, sessions, the HTTP API, audit, telemetry and retention

## 1. Purpose

Sekhemet runs cards unattended for hours on a machine people also use. The runtime keeps that safe and recoverable: one runner at a time, every process killed when its time is up, a crash that loses nothing logged, a server that serves the board to the people allowed to see it, and records that do not grow without bound. It serves the spine rules that a card is the unit of work (there is no long-running session to rot) and that the event log is the only durable channel (everything here is recovered from it).

## 2. Behaviour

### The unit of execution

1. There are no chat sessions. A **card attempt** is the unit of execution; each starts with a context assembled fresh for the card ([context](context.md)), and resume, fork, rewind and replay are defined against attempts.

### One supervisor, one runner

2. One supervisor per repository owns the queue, card runs, the runner lease and the logs. The dashboard server, `run`, `queue` and `overnight` all go through it.
3. **The runner lease is atomic.** It is taken by exclusive creation of `.sekhemet/runner.lock`, carries the holder's pid, process start time and a random token, and is refreshed by a heartbeat every 3 s. A lease whose holder is gone — pid absent, or alive with a different start time — is stale and may be taken over. `run <card>`, `queue` and `overnight` all take it; a second runner is refused (CLI exit code 1; HTTP 409 naming the holder).
4. While a runner holds the lease, it answers PM messages between Worker steps (only it can unload the Worker; a second large model would exhaust memory). Model residency itself is [models](models.md)'.
5. **`daemon start|stop|status`** runs the dashboard server detached, writing `.sekhemet/daemon.json` (pid, port, start time, log path) and logging to `.sekhemet/daemon.log`. `stop` signals only a process whose pid **and** start time match the file; a recycled pid is never signalled.
6. Every detached run writes its output to a log file under `.sekhemet/logs/`; nothing is launched with its output discarded.

### Process lifetime

7. Every command runs with a timeout: SIGTERM, then SIGKILL after 500 ms if it is still alive. Kills reach **the whole process tree** (a new process group per command, signalled as a group), for timeouts, `stop_process`, card end and memory kills alike.
8. A command's memory is the resident size of its whole tree, sampled every 250 ms; past its cap (default 4096 MB, `SEKHEMET_MAX_COMMAND_MEMORY_MB`) the tree is killed and the result says so, rather than inferring an out-of-memory kill from an unexplained SIGKILL.
9. The harness's own signal handling releases the lease and kills its children before it exits; no handler calls `process.exit` before cleanup has run.

### Crash recovery (resume)

10. At start-up the supervisor sweeps: any card in In Progress whose attempt is still marked running, with no live lease holder, is a crashed attempt. Its attempt is finished with stop reason `crashed`, the partial step is discarded, the worktree is restored to its last checkpoint commit, and the card returns to Ready with the attempt recorded. The next run resumes it at the last completed step. Nothing that was logged is lost, and nothing unlogged is trusted.

### Checkpoints, rewind, fork, replay

11. **Checkpoints.** The Worker commits to the card branch after every gate-passing step and at every masked-observation boundary. Checkpoints are what resume, rewind and fork restore to, and they keep the worktree consistent with the log.
12. **Rewind** resets the worktree to step N's checkpoint, truncates nothing in the log, keeps the abandoned state at a preserved ref, records a rewind event, and invalidates any gate pass recorded after step N.
13. **Fork** creates a new attempt from step N with a parent reference and a different model, prompt version or budget; it never mutates the parent. Forks are how harness changes are A/B tested on real work.
14. **Replay** rebuilds an attempt's trajectory from the ledger (tool calls with targets and outcomes, gate results, tokens, stop reason), aligns two attempts step by step, and names the first step where they diverged and what changed in their reproducibility records (model, prompt, tool schema, rules, gates, harness). `--as <model>` runs a fresh attempt forked from the start on another model and diffs it. Deterministic stages — context assembly and gates — reproduce exactly; model output may differ.

### Background processes and terminals

15. A card may start named background processes (a dev server, a watcher, a database) with `start_process`: each runs inside the card's sandbox, gets its own free loopback port as `PORT` so parallel cards do not collide, has its output captured with the same masking and redaction as any observation, and is killed — with its whole tree — at card end unless promoted to a project service.
16. A process may keep a writable stdin for tools that need terminal state (interactive installers, REPL-driven debugging); its transcript is logged as observations and it carries the same permissions as a command.

### Unattended hours

17. `overnight` runs queue rounds while the machine is free: outside the person's reserved hours ([surface](surface.md) config), or inside them when the person has been idle for `--idle-min` minutes, until `--until`, until no Ready card remains, or until a breaker trips. Each round has a wall-clock limit; a round that exceeds it is killed (whole tree) and counted as a failure.
18. **Breakers** (compute governance): the daily energy budget (`power_budget_kwh_day`, 0 = none; energy = estimated machine watts × run time, `SEKHEMET_MACHINE_WATTS` overrides the estimate), `--max-failures` rounds failing in a row, and thermal throttling. A tripped breaker ends the night with its reason.
19. **Per-card and per-project budgets** in tokens, seconds and kilowatt-hours: a card at its cap is parked, not continued; a project at its cap stops the scheduler. Cost is reported in machine time and energy, not API dollars.
20. **Nightly jobs** after the rounds: diff-scoped mutation testing, the convention-drift check posted to Seshat's thread, and a full offline vulnerability scan. The morning report — what reached Review, what parked and why — is Seshat's standup, delivered through the notifier ([integrations](integrations.md)).
21. **Scheduled and recurring cards.** A card becomes a template when it carries a schedule (cron: fields, ranges, steps, lists, names, macros) or a trigger (a file change, a dependency release, a named webhook). Each firing clones the template into a Ready card that inherits its acceptance tests, criteria, scope and budget; at most one open clone at a time. A wake-up inside the reserved hours waits unless the template is marked `urgent`. Schedules live on the card as labels; firings are ledger events.
22. **Memory pressure.** When the memory watchdog ([models](models.md), thresholds 85–90%) asks to stop new worktrees, the queue starts no new card until it clears; every watchdog action the watchdog can request is either acted on or removed.

### The HTTP API and the live stream

23. The dashboard server serves the board, the PM and the actions a person can take, on `127.0.0.1:4040` by default. Routes are grouped by domain — board and cards, card actions, runs and evidence, PM (shapes in [PM_CONTRACT.md](../PM_CONTRACT.md)), integrations, machine and models, learning, webhooks — each group in its own module behind one guard (T5).
24. The guard runs first for every request: the Host check, the mutation token, framing and CSP rules in [security](security.md) item 37, and, in company-server mode, the person's session.
25. Live updates stream as server-sent events (`GET /api/stream`) and WebSocket (`/api/ws`); both carry ledger appends as JSON and accept only allowed origins. A server started without a card store is read-only and answers mutations 501.

### Company-server binding (DEC-06)

26. `serve` binds to loopback unless `[server] host` (or `--host`) names another address. A non-loopback bind is refused at start-up unless identity is configured ([integrations](integrations.md) item 24) **and** traffic is encrypted — the server's own TLS certificate, or a proxy in `trusted_proxies` that terminates TLS.
27. With local accounts, a person signs in with their token and gets a session: a random session id in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, with an expiry, and a per-session mutation token. The live stream requires the same session. With a proxy, the proxy's session is the session.
28. Webhook routes (`/webhooks/github`) are authenticated by their own signatures, not sessions.

### Audit

29. The event log is the audit trail: each entry carries a sequence number and a SHA-256 over its content and the previous hash ([kernel](kernel.md)). `sekhemet log` and `GET /api/integrity` walk the chain and report the first broken sequence number, and check the projections against it.

### Telemetry

30. Spans follow OpenTelemetry's agent conventions: a span per card, per model request (with token counts) and per tool call, stored locally in `.sekhemet/traces.db` and viewable in the dashboard.
31. Nothing leaves the machine unless the person asks: `sekhemet dev traces --otlp <url>` exports spans once, to the address given, and the export is recorded. There is no background telemetry.
32. **Metrics that matter**, computed from the ledger and traces: pass rate by card class and model (drives routing and budgets); prefix-cache hit rate per step (the binding performance constraint); tokens and seconds per card, estimate against actual; the gate-failure distribution (feeds the playbook); the stop-reason distribution (finds loop and scope problems); human review minutes per card (sets the Review WIP limit).

### Retention and logs

33. **Retention** runs at the start of every queue: context packs, masked observations and transcripts of cards closed (Done or rejected) more than 30 days ago are pruned; a pack shared with an open card stays. Never pruned: the ledger, evidence bundles (which hold the final diff and gate results), and anything of an open card.
34. `daemon.log` and run logs rotate by size and keep a bounded number of files; `traces.db` keeps 30 days of spans; parked cards' worktrees are removed when the card is closed. Disk growth per 100 cards is bounded.

## 3. Contract

| Item | Source |
| --- | --- |
| `DaemonInfo`, `daemonStart`, `daemonStop`, `daemonStatus` | `apps/harness/src/daemon.ts` |
| `holdRunnerLease`, `runnerLease`, `Lease` | `apps/harness/src/pm/service.ts:57-120` |
| `ProcessSandbox.execute` (timeout, memory cap), `sampleTreeMemory` | `packages/sandbox/src/executor.ts` |
| `runOvernight`, `mayRun`, `recordUsage`, `GOVERNANCE_EVENTS`, `thermalState` | `apps/harness/src/overnight.ts`, `governance.ts` |
| `parseHours`, `isReserved` | `apps/harness/src/scheduler.ts` |
| Recurring labels: `template`, `schedule:<cron>`, `trigger:file:<glob>`, `trigger:release:npm:<pkg>`, `trigger:webhook:<name>`, `urgent` | `apps/harness/src/recurring.ts` |
| `trajectories`, replay diff | `apps/harness/src/replay.ts` |
| `Tracer`, `tracesCommand` | `apps/harness/src/tracing.ts` |
| `pruneRetention`, `RETENTION_DAYS = 30`; `pruneRunData` | `packages/kernel/src/retention.ts`; `apps/harness/src/execute.ts:193` |
| HTTP routes | `server.ts`, `rest_extra.ts`, `wave2_server.ts`, `pm_api.ts`, `integrations.ts`, `dashboard_api.ts` — listed below |
| CLI: `serve`, `board`, `daemon start\|stop\|status`, `run [card]`, `queue`, `overnight [--until HH:MM] [--idle-min N] [--max-failures N]`, `abort`, `rewind`, `fork`, `resume`, `replay <card> [--attempt N] [--diff A,B] [--as <model>]`, `log`, `traces [--since-hours N] [--out f] [--otlp url]` | `apps/harness/src/index.ts` |
| Config (new): `[server] host`, `port` (default 4040), `tls_cert`, `tls_key`, `trusted_proxies`, `session_hours` | this spec |

**Routes today** (all under `/api` unless noted; mutations are POST, PUT or DELETE):
- Board and cards: `board`, `workspace`, `projects`, `projects/:id`, `cards/:id`, `cards/:id/explain`, `cards/:id/attempts`, `cards/:id/transcript`, `cards/:id/diff`, `cards/:id/review`, `cards/:id/attachments`, `cycles`, `goals`, `decisions`, `planner/decisions`, `assumptions`, `recurring`, `wip`, `queue`.
- Card actions: `cards/:id/(accept|return|park)`, `cards/:id/(split|run|gate)`, `cards/:id/(abort|rewind|fork|override|reroute|reorder)`.
- Runs and evidence: `runs`, `evidence/:id`, `cards/:id/evidence`, `events?since=`, `stream` (SSE), `ws` (WebSocket), `integrity`, `metrics/flow`, `metrics/pm`, `signals`, `standup`, `capability`, `telemetry`.
- PM: `pm/messages`, `pm/thread`, `pm/proposals/:id/(apply|discard)` ([PM_CONTRACT.md](../PM_CONTRACT.md)).
- Integrations: see [integrations](integrations.md) §3; `/webhooks/github` (no `/api`).
- Machine and models: `machine`, `machine/calibrate`, `models`, `registry`, `doctor`, `meta`, `gates`, `playbook`, `learning`, `visual`.

The design's 2026-09-17 route table (`/workspace`, `/projects/:id/board`, `PATCH /cards/:id`, `/cards/:id/return`, `/decisions/:id/answer`, `WS /stream?card=`) is superseded by the routes above; the code is the contract, and a route change updates this list.

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Daemon start/stop/status | partial | `daemon.ts`; `stop` trusts a bare pid (`:26-33, 109-118`); the test mocks kill and asserts "Stopped" while the process lives (`daemon_ws.spec.ts:128-153`) | NEW-runtime-1 |
| Runner lease | partial | written with `writeFileSync`, not exclusive (`pm/service.ts:66-104`); taken only by `queue` (`index.ts:1355`); the REST `run` checks it but its child never takes it (`rest_extra.ts:192-202`) | NEW-runtime-1 |
| Detached runs leave no log | not-built | `stdio: "ignore"` (`rest_extra.ts:55-64`) | NEW-runtime-1 |
| Timeout SIGTERM → 500 ms → SIGKILL | built | `executor.ts:248-266`; `containment.spec.ts:204` | — |
| Kills reach the whole tree | partial | memory kill walks the tree (`executor.ts:271-285`); timeouts and `dispose` signal one pid (`executor.ts:251`, `loop/src/tools.ts:1057-1067`) | NEW-runtime-2 |
| Signal handlers exit before cleanup | not-built | `models/src/llama_server.ts:448-452` | NEW-runtime-2 |
| Crash sweep at start-up | not-built | crashed cards stay In Progress; the queue takes only Ready cards | NEW-runtime-3 |
| Overnight round time limit | not-built | the queue child has no timeout (`overnight.ts:60-73`) | NEW-runtime-3 |
| Rewind, fork, resume from checkpoint | built | `control.spec.ts:203, 228` | — |
| Replay and `--as` | built | `replay.ts`; `replay.spec.ts` | — |
| Background processes, confined, own port | built | `loop/src/tools.ts:969-1014`; killed at card end without descendants (`:1057`) | NEW-runtime-2 |
| Overnight, breakers, reserved hours | built | `overnight.spec.ts` | — |
| Recurring and scheduled cards | built | `recurring.spec.ts` | — |
| Nightly mutation and drift check | built | `overnight.ts:40, 95` | — |
| Nightly full vulnerability scan | not-built | — | NEW-runtime-5 |
| Watchdog `stopNewWorktrees`, `shortenKeepAlive` | not-built | declared (`models/src/watchdog.ts:27-49`); `isActive` never called | NEW-runtime-5 |
| Server: one 1,261-line closure, guards copied into five modules | partial | `server.ts:490-1190`; `isTrustedMutation` (`:115-126`) vs `originAllowed` (`ws.ts:32`) disagree | T5 |
| Host check, session token, CSP | not-built | [security](security.md) S3c | S3c |
| Non-loopback bind with identity and TLS | not-built | `server.listen(port, "127.0.0.1")` (`server.ts:1190`) | P9 (DEC-06) |
| Audit chain verification | built | `log.verifyHashChain`; `/api/integrity` (`server.ts:1046`) | — |
| Local traces, OTLP export on request | built | `tracing.ts`; `tracing.spec.ts` | — |
| Retention of packs, observations, transcripts | partial | wired at queue start (`index.ts:1243`), tested in the kernel (`blobs_retention.spec.ts`) but not through `queue` | NEW-runtime-4 |
| Log rotation, trace retention, worktree cleanup | not-built | `daemon.log` appends forever; `traces.db` has no retention (`tracing.ts:39-48`) | NEW-runtime-4 |

## 5. Changes for v1

The review's runtime items had no programme ID; they are proposed here.

### NEW-runtime-1 — one supervisor, an atomic lease
*Justification: `daemonStop` can signal a recycled pid; two Workers can run at once, the second adopting the first's model server (review of domain 14, senior judgement 1).*
- **RUN-1** WHEN `daemon stop` runs and the recorded pid now belongs to a process with a different start time THE SYSTEM SHALL signal nothing, remove the stale file and print "Not running".
- **RUN-2** WHEN two processes try to take the runner lease at the same moment THE SYSTEM SHALL grant it to exactly one.
- **RUN-3** WHEN `sekhemet run <card>` starts while another runner holds the lease THE SYSTEM SHALL exit 1 naming the holder's pid, and run nothing.
- **RUN-4** WHEN `POST /api/cards/:id/run` starts a run THE SYSTEM SHALL have the run take the lease and write its output to a log file whose path the response returns.
- **RUN-5** WHEN the lease holder was killed with SIGKILL THE SYSTEM SHALL let the next runner take the lease without manual cleanup.

### NEW-runtime-2 — kills that reach every descendant
*Justification: timeouts and card-end kills signal only the direct child, so grandchildren survive; signal handlers exit before releasing the lease (review of domain 14, drift and complexity).*
- **RUN-6** WHEN a command that started a grandchild exceeds its timeout THE SYSTEM SHALL leave no process of that tree running 1 s after the SIGKILL.
- **RUN-7** WHEN a card ends with a background process that forked a child THE SYSTEM SHALL leave no process of that tree running.
- **RUN-8** WHEN the harness receives SIGTERM while holding the lease THE SYSTEM SHALL release the lease and kill its children before exiting.

### NEW-runtime-3 — crash recovery and bounded rounds
*Justification: a crashed card stays In Progress for ever, and a hung queue child blocks the whole night (review of domain 14, senior judgement 3).*
- **RUN-9** WHEN the supervisor starts and finds a card In Progress with a running attempt and no live lease THE SYSTEM SHALL finish the attempt with stop reason `crashed`, restore the worktree to its last checkpoint and return the card to Ready.
- **RUN-10** WHEN a crashed card is next run THE SYSTEM SHALL continue from its last completed step.
- **RUN-11** WHEN an overnight round exceeds its wall-clock limit THE SYSTEM SHALL kill the round's process tree, count one failure and continue with the next round.
- **RUN-12** WHEN a chaos test kills the runner with SIGKILL mid-card THE SYSTEM SHALL, after restart, show no card stuck In Progress and no orphaned process.

### NEW-runtime-4 — bounded disk
*Justification: logs and traces grow without limit; retention is wired but untested through the command that runs it (review of domain 14, senior judgement 4).*
- **RUN-13** WHEN `queue` starts and a card closed 31 days ago has context packs THE SYSTEM SHALL prune them and keep its evidence bundle and every ledger event.
- **RUN-14** WHEN `daemon.log` exceeds its size limit THE SYSTEM SHALL rotate it and keep at most the configured number of files.
- **RUN-15** WHEN spans in `traces.db` are older than 30 days THE SYSTEM SHALL delete them at the next retention pass.
- **RUN-16** WHEN a parked card is closed THE SYSTEM SHALL remove its worktree and keep its branch.

### NEW-runtime-5 — the night does what it promises
*Justification: the full vulnerability scan never runs, and two watchdog actions are declared but never acted on.*
- **RUN-17** WHEN an overnight run finishes its rounds THE SYSTEM SHALL run the offline vulnerability scan and record its result on the ledger.
- **RUN-18** WHILE the watchdog requests `stopNewWorktrees` THE SYSTEM SHALL start no new card.

### T5 — the server by route group, one guard
- **RUN-19** WHEN any `/api` route is requested THE SYSTEM SHALL pass it through the single guard before its handler, and a test SHALL enumerate every mutating route and show each refuses a request without the token.
- **RUN-20** WHEN the WebSocket and SSE streams check an origin THE SYSTEM SHALL use the same function as the mutation guard.

### P9 (DEC-06) — company-server binding and sessions
- **RUN-21** WHEN `serve --host 0.0.0.0` starts with no identity configured THE SYSTEM SHALL refuse to start and say what is missing.
- **RUN-22** WHEN `serve` binds a non-loopback address with identity but without TLS and without a TLS-terminating proxy in `trusted_proxies` THE SYSTEM SHALL refuse to start.
- **RUN-23** WHEN a request without a valid session reaches any route except a signed webhook THE SYSTEM SHALL answer 401.
- **RUN-24** WHEN a session expires THE SYSTEM SHALL refuse its mutation token and its live stream.
- **RUN-25** WHEN two people use the server at once THE SYSTEM SHALL attribute each one's actions to that person (end-to-end test with two users behind a proxy, where only the accepter can accept).

## 6. v1 acceptance

RUN-1 to RUN-25, plus these built behaviours kept under test:
- **RUN-26** WHEN a card is rewound past a step whose gates passed THE SYSTEM SHALL mark that pass invalid and keep the abandoned state at a preserved ref.
- **RUN-27** WHEN an attempt is forked at step N THE SYSTEM SHALL create a new attempt with a parent reference and leave the parent unchanged.
- **RUN-28** WHEN `replay --diff A,B` compares two attempts THE SYSTEM SHALL name the first divergent step and the reproducibility fields that differ.
- **RUN-29** WHEN a command's tree exceeds its memory cap THE SYSTEM SHALL kill it and report the peak and the cap.
- **RUN-30** WHEN today's energy use reaches `power_budget_kwh_day` THE SYSTEM SHALL stop the overnight run with the energy breaker's reason.
- **RUN-31** WHEN a recurring template fires while a clone is still open THE SYSTEM SHALL not create a second clone.
- **RUN-32** WHEN one ledger event's content is altered THE SYSTEM SHALL report that event's sequence number as the first break.
- **RUN-33** WHEN no `--otlp` is given THE SYSTEM SHALL make no outbound request for telemetry.

## 7. Later

- **launchd or systemd `--user` supervision** and restart; `proper-lockfile`, `tree-kill`, `pino` with rotation — proposals from the review needing the owner's yes (the behaviours above hold without them).
- **A gate host on another machine**: `gate-host` serves gates over mutual TLS on `127.0.0.1:7443` today, with certificates for `localhost` and `127.0.0.1`; `--host`, configurable certificate names and no shared-path assumption come with multi-machine gates.
- **Promoting a background process to a project service.**
- **The prompt optimiser overnight** (`improve`), once self-improvement admits only significant paired gains ([measurement](measurement.md), T8).
- **Multi-machine inference pooling** (SPINE: not in v1).

## 8. Open questions

1. **`retention.ts`: wire in or cut (DEC-09)?** It is already wired — `queue` prunes on every start (`index.ts:1243`) — so COVERAGE's "unused" is out of date. *Recommendation:* keep it, extend it to logs, traces and closed worktrees (NEW-runtime-4), and test it through `queue`.
2. **Where do reproducibility records live?** Every card must record model, quantisation, template checksum, prompt-set version, playbook version, tool-schema version and engine settings. *Recommendation:* owned by M4 in [models](models.md) and [measurement](measurement.md); replay (item 14) consumes them.
3. **Supervisor as its own process, or the dashboard server?** *Recommendation:* the server process, started by `daemon start` or `serve`, with `run`/`queue` from the CLI taking the same lease; a separate supervisor only if the chaos test (RUN-12) cannot pass otherwise.

## 9. Evidence and rationale

- Review: [domains 11 and 14](../../reference/reviews/domain11_14_security_runtime.md#runtime-rubric-questions-27) — PID reuse, the non-atomic lease, tree kills, the crash sweep, the watchdog's dead actions, rotation.
- [INTEGRATION_REVIEW.md](../INTEGRATION_REVIEW.md) §C — why one runner and one scheduler own residency (the dashboard's second scheduler, C4).
- Decisions: [DEC-06](../DECISIONS.md#dec-06) (company server), [DEC-09](../DECISIONS.md#dec-09) (retention's wire-or-cut), [DEC-22](../DECISIONS.md#dec-22--rejected-techniques) (no long-running conversational sessions).
- **Why no sessions:** long conversational sessions rot (context decay, lost-in-the-middle, hallucinated agreements); a fresh deterministic context per attempt, with resume, fork, rewind and replay from the log, gives every session feature without the decay.
