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
changes: [T5, P9, S3c, NEW-runtime-1, NEW-runtime-2, NEW-runtime-3, NEW-runtime-4, NEW-runtime-5, NEW-runtime-6, NEW-runtime-7, NEW-runtime-8, NEW-runtime-9, NEW-runtime-10]
---

# Runtime: the supervisor, runs, sessions, the HTTP API, audit, telemetry and retention

## 1. Purpose

Sekhemet runs cards unattended for hours on a machine people also use. The runtime keeps that safe and recoverable: one runner at a time, every process killed when its time is up, a crash that loses nothing logged, a server that serves the board to the people allowed to see it, and records that do not grow without bound. It serves the spine rules that a card is the unit of work (there is no long-running session to rot) and that the event log is the only durable channel (everything here is recovered from it).

## 2. Behaviour

### The unit of execution

1. There are no chat sessions. A **card attempt** is the unit of execution; each starts with a context assembled fresh for the card ([context](context.md)), and resume, fork, rewind and replay are defined against attempts.

### One supervisor, one runner

2. One supervisor per repository owns the queue, card runs, the runner lease and the logs. The dashboard server, `run`, `queue` and `overnight` all go through it.
3. **The runner lease is atomic.** It is taken by exclusive creation of `.sekhemet/runner.lock`, carries the holder's pid, process start time and a random token, and is refreshed by a heartbeat every 3 s. A lease whose holder is gone — pid absent, or alive with a different start time — is stale and may be taken over. `run <card>`, `queue` and `overnight` all take it; a second runner is refused (CLI exit code 1; HTTP 409 naming the holder). On a single-user machine there is one lease. On a team server the lease is **per slot**: the qualified engine's parallel capacity N ([models](models.md)) gives N slot leases — the engine is llama.cpp by default, or **vLLM**, approved as the optional multi-user engine run as a separate process ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O8), used only once its (engine, model build, host, settings) combination has qualified under [models](models.md)' rules — each card holds one with its own worktree and sandbox, and no two running cards may write the same file (NEW-runtime-6).
4. While a runner holds the lease, it answers PM messages between Worker steps (only it can unload the Worker; a second large model would exhaust memory). With no lease holder, the server answers PM messages itself, but it loads a model only through the residency scheduler that [models](models.md) owns (one scheduler for every caller; adapters keyed by weights, not role), and refuses with a plain message when a model's memory footprint is unknown, rather than loading a second large model beside the Worker (NEW-runtime-6; the integration review's C3/C4).
4a. **Fair share across people** (team server). When two or more people have work queued, model time is scheduled by fair share per person; interactive PM replies run ahead of Worker steps; and any request that has waited longer than a configured bound is promoted ahead of both, so a long card is never starved (NEW-runtime-6).
5. **`daemon start|stop|status`** runs the dashboard server detached, writing `.sekhemet/daemon.json` (pid, port, start time, log path) and logging to `.sekhemet/daemon.log`. `stop` signals only a process whose pid **and** start time match the file; a recycled pid is never signalled.
6. Every detached run writes its output to a log file under `.sekhemet/logs/`; nothing is launched with its output discarded.

### Process lifetime

7. Every command runs with a timeout: SIGTERM, then SIGKILL after 500 ms if it is still alive. Kills reach **the whole process tree** (a new process group per command, signalled as a group), for timeouts, `stop_process`, card end and memory kills alike.
8. A command's memory is the resident size of its whole tree, sampled every 250 ms; past its cap (default 4096 MB, `SEKHEMET_MAX_COMMAND_MEMORY_MB`) the tree is killed and the result says so, rather than inferring an out-of-memory kill from an unexplained SIGKILL.
8a. A command's stdout and stderr are each captured up to 10 MB (`maxBufferBytes`); beyond that the capture stops and the result ends with `[output truncated at <n> bytes]`, so a runaway command cannot exhaust the harness's memory. What the model then sees is condensed and clamped by [context](context.md).
9. The harness's own signal handling releases the lease and kills its children before it exits; no handler calls `process.exit` before cleanup has run.

### Crash recovery (resume)

10. At start-up the supervisor sweeps: any card in In Progress whose attempt is still marked running, with no live lease holder, is a crashed attempt. Its attempt is finished with stop reason `crashed` — a stored reason of class **environment** in [worker-loop](worker-loop.md)'s one stop-reason table (rule 31), which is where its `parks`, `resumable` and next action are given; this spec defines no list of its own — the partial step is discarded, the worktree is restored to its last checkpoint commit, and the card returns to Ready with the attempt recorded. The next run resumes it at the last completed step. Nothing that was logged is lost, and nothing unlogged is trusted.

### Checkpoints, rewind, fork, replay

11. **Checkpoints** are commits on the card branch; their cadence and trailers are [review-git](review-git.md)'s (§2.6, ruling R1). Checkpoints are what resume, rewind and fork restore to, and they keep the worktree consistent with the log.
12. **Rewind** resets the worktree to step N's checkpoint, truncates nothing in the log, keeps the abandoned state at a preserved ref, records a rewind event, and invalidates any gate pass recorded after step N.
13. **Fork** creates a new attempt from step N with a parent reference and a different model, prompt version or budget; it never mutates the parent. Forks are how harness changes are A/B tested on real work.
14. **Replay** rebuilds an attempt's trajectory from the ledger (tool calls with targets and outcomes, gate results, tokens, stop reason), aligns two attempts step by step, and names the first step where they diverged and what changed in their reproducibility records (model, prompt, tool schema, rules, gates, harness). `--as <model>` runs a fresh attempt forked from the start on another model and diffs it. Replaying against another pinned configuration — a prompt version or a budget rather than a model — is a fork from step 0 (item 13); `--as` names only a model. Deterministic stages — context assembly and gates — reproduce exactly; model output may differ.

### Background processes and terminals

15. A card may start named background processes (a dev server, a watcher, a database) with `start_process`: each runs inside the card's sandbox, gets its own free loopback port as `PORT` so parallel cards do not collide, has its output captured with the same masking and redaction as any observation, and is killed — with its whole tree — at card end unless promoted to a project service.
16. A process may keep a writable stdin for tools that need terminal state (interactive installers, REPL-driven debugging); its transcript is logged as observations and it carries the same permissions as a command.

### Unattended hours

17. **The overnight window** is the complement of `[machine] reserved_hours`, narrowed by `[machine] overnight_hours` when set ([surface](surface.md) item 23). The machine is **reserved** inside `reserved_hours`, and whenever a person has pressed *Reserve now* in the dashboard or run `sekhemet dev reserve` until they release it. `overnight` runs queue rounds — and the overnight benchmark tier ([measurement](measurement.md) NEW-measurement-5) — while the machine is free: in the overnight window and not reserved, or inside reserved hours when the person has been idle for `--idle-min` minutes, until `--until`, until no Ready card remains, or until a breaker trips. Each round has a wall-clock limit; a round that exceeds it is killed (whole tree) and counted as a failure. Between rounds the model server stays up, so its weights and prompt cache stay warm; rounds work the backlog in project batches ([models](models.md) orders the swaps).
17a. **Pause a project.** A person can pause a project from the board (and `sekhemet dev pause|resume <project>`): the queue and `overnight` start no new card for it until it is resumed; a card already running is not interrupted (`abort` is its own action). The pause and the resume are ledger events naming who did them (NEW-runtime-10).
18. **Breakers** (compute governance): the daily energy budget (`power_budget_kwh_day`, 0 = none; energy = estimated machine watts × run time, `SEKHEMET_MACHINE_WATTS` overrides the estimate), `--max-failures` rounds failing in a row, and thermal throttling. A tripped breaker ends the night with its reason. *Narrowed from the old design's kWh "from hardware TDP and GPU utilisation":* the utilisation term needs a per-host utilisation source, which is Later (§7).
19. **Per-card and per-project budgets** in tokens, seconds and kilowatt-hours: a card at its cap is parked with a budget diagnosis, not continued into Verify (a breaker that lets the card continue is not a breaker); a project at its cap stops the scheduler. Cost is reported in machine time and energy, not API dollars.
20. **Nightly jobs** after the rounds: diff-scoped mutation testing, the convention-drift check posted to Seshat's thread, and a full offline vulnerability scan. The morning report — what reached Review, what parked and why — is Seshat's standup, delivered through the notifier ([integrations](integrations.md)).
21. **Scheduled and recurring cards.** A card becomes a template when it carries a schedule (cron: fields, ranges, steps, lists, names, macros) or a trigger (a file change, a dependency release, a named webhook). Each firing clones the template into a Ready card that inherits its acceptance tests, criteria, scope and budget; at most one open clone at a time. A wake-up inside the reserved hours waits unless the template is marked `urgent`. Schedules live on the card as labels; firings are ledger events.
22. **Memory pressure.** The memory watchdog's thresholds and actions are [models](models.md)' (ruling R27). When it asks to stop new worktrees, the queue starts no new card until it clears; every action the watchdog can request is either acted on here or removed there.

### The HTTP API and the live stream

23. The dashboard server serves the board, the PM and the actions a person can take, on `127.0.0.1:4040` by default. Because it is a local web app on loopback, it works over an SSH tunnel and on a headless box: nothing needs a local display, and `--yes` prints the address instead of opening a browser ([surface](surface.md) item 7). Routes are grouped by domain — board and cards, card actions, runs and evidence, PM (shapes in [PM_CONTRACT.md](../PM_CONTRACT.md)), integrations, machine and models, learning, webhooks — each group in its own module behind one guard (T5).
23a. **Static files** under `/app/*` are served only from the web directory: a path with `..` or `.` segments, an encoded traversal, a backslash or a NUL is refused, and so is a symlink whose real path leaves the web root or a file whose extension has no known type. Each file is sent with its correct MIME type (`.js`, `.css`, `.json`, `.svg`, `.woff2`), `X-Content-Type-Options: nosniff` and `Cache-Control: no-cache` (ruling R19).
24. The guard runs first for every request: the Host check, the mutation token, framing and CSP rules in [security](security.md) item 37, and, in company-server mode, the person's session.
25. Live updates stream as server-sent events (`GET /api/stream`) and WebSocket (`/api/ws`); both carry ledger appends as JSON and accept only allowed origins. A server started without a card store is read-only and answers mutations 501. *Changed from the old design's single WebSocket at `ws://127.0.0.1:4040/stream`:* SSE is the dashboard's channel (it reconnects on its own and needs no library); the WebSocket remains for clients that want one.
25a. **Replay on reconnect and reload.** A stream opened with `?since=<seq>`, or reconnecting with `Last-Event-ID`, first replays every append after that sequence number (at most 5,000 per frame, marked with the range replayed); `?since=0` replays from genesis. A reloaded page hydrates from the projections — which the kernel rebuilds from the log — and resumes the stream from the last sequence number it holds, so the state a person sees after a reload equals the log's state at that sequence number. `GET /api/events` pages the log with `since`, `before`, `limit`, `order` and filters by `card`, `type` and `actor` (the subscription itself is [kernel](kernel.md)'s).
25b. **Token streaming.** While a step is generating, the runner writes the decoded tokens to `.sekhemet/live/<card>.txt`, and the stream sends them as `tokens` events (the last 2,000 characters, when the file changes) for the card view's Steps tab ([dashboard](dashboard.md)). The live file is a view, not a record: the ledger keeps the finished model response.

### Company-server binding (DEC-06)

26. `serve` binds to loopback unless `[server] host` (or `--host`) names another address. A non-loopback bind is refused at start-up unless identity is configured ([integrations](integrations.md) item 24) **and** traffic is encrypted — the server's own TLS certificate, or a proxy in `trusted_proxies` that terminates TLS.
27. With local accounts, a person signs in with their token and gets a session: a random session id in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, with an expiry, and a per-session mutation token. The live stream requires the same session. With a proxy, the proxy's session is the session.
28. Webhook routes (`/webhooks/github`) are authenticated by their own signatures, not sessions.

### Audit

29. The event log is the audit trail: each entry carries a sequence number and a SHA-256 over its content and the previous hash ([kernel](kernel.md)). `sekhemet log` and `GET /api/integrity` walk the chain and report the first broken sequence number, and check the projections against it.

### Telemetry

30. Spans follow OpenTelemetry's agent conventions: a span per card, per step, per model request (with token counts) and per tool call, stored locally in `.sekhemet/traces.db` and viewable in the dashboard (today: card, step and model-request spans — the code names the step span `turn`, [DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run) — readable through `sekhemet dev traces`; the tool-call span and the dashboard view are NEW-runtime-9).
31. Nothing leaves the machine unless the person asks: `sekhemet dev traces --otlp <url>` exports spans once, to the address given, and the export is recorded. There is no background telemetry.
32. **Metrics that matter**, computed from the ledger and traces: pass rate by card class and model (drives routing and budgets); prefix-cache hit rate per step (the binding performance constraint); tokens and seconds per card, estimate against actual; the gate-failure distribution (feeds the playbook); the stop-reason distribution (finds loop and scope problems); human review minutes per card (sets the Review WIP limit); and tokens removed by output condensing per card (what condensing saves, the statistic RTK tracks; condensing itself is [context](context.md)'s).

### Retention and logs

33. **Retention** runs at the start of every queue and selects the context packs, masked observations and transcripts of cards closed (Done or rejected) more than 30 days ago; a pack shared with an open card stays. Never pruned: the ledger, evidence bundles (which hold the final diff and gate results), and anything of an open card. **Pruning is a recorded erasure** ([kernel](kernel.md) rule 34): the selected blobs are deleted and, in the same transaction, one `ledger/erased {blobIds, reason: "retention", principal}` event lists every one of them, so a replay of a step whose pack was pruned names the gap and the `ledger/erased` seq instead of reporting a missing blob (K-N7-6, K-N7-8). The event's actor is the harness and its `principal` is the person who set the project's retention period — an event a person caused through a machine actor ([kernel](kernel.md) rule 19) — so that person must hold the Accept permission (K-N7-1); a retention period set by no one with that permission prunes nothing. A default period counts as set by the person who confirmed the project's first run ([surface](surface.md) item 5), who holds Accept on a solo project. Spine rule 2 allows exactly this: the owner amended it so that anything a model saw can be reconstructed *except content erased by a recorded `ledger/erased` event, which replay names as a gap* (O1, decided 2026-09-24, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)). The report-only interim that held while O1 was open has ended: retention prunes, always as a recorded erasure, and each run's report still lists what it pruned, with card ids. It is built in B3.3, after the erasure event exists (kernel NEW-kernel-7, B3.1); a build without `ledger/erased` prunes nothing. *Changed from the code:* `queue` prunes today with no ledger record (`index.ts:1242-1247`, `retention.ts:54-58`), which breaks spine rule 2 silently.
34. `daemon.log` and run logs rotate by size and keep a bounded number of files; `traces.db` keeps 30 days of spans; parked cards' worktrees are removed when the card is closed. Disk growth per 100 cards is bounded.
34a. **Retention of personal text.** Once the ledger has an erasable `private` part ([kernel](kernel.md) NEW-kernel-1), a project's retention period for `private` fields of closed cards erases them with reason `retention`, keeping structural fields and commitments, so the chain still verifies (NEW-runtime-8). **The default period is 90 days after a card closes** (owner decision O14, decided 2026-09-24, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)); a person holding Accept may set another period for the project, and the change is a recorded config event. This is separate from item 33's 30 days for packs, observations and transcripts, which are blobs, not ledger fields.

### Run reports

34b. **A queue run's report is a ledger event.** When `queue` or an overnight round ends, its report (`QueueReport`: per-card entries with attempt, stop reason, steps, tokens and duration; pass@1, pass after escalation, model swaps, throughput, prefix-cache summary, the watchdog level at the end, and retention's report) is appended as one `queue/reported {report}` event. `.sekhemet/queue_report.json` and `.sekhemet/runs/<startedAt>.json` are **derived caches** of those events (kernel rule 16: a cache that is safe to delete): they are written from the event, and when missing they are rebuilt from the ledger. The Runs view (`GET /api/runs`, `/api/runs/:id`) reads the projection of `queue/reported` events, not the directory. *Changed from the code:* the report exists only as files today, and the code calls the latest file "the record" (`execute.ts:1468-1482`, `dashboard_api.ts:311-343`) — a durable fact outside the ledger, which kernel rule 16 names a defect (NEW-runtime-9).

### Backup, restore, export and upgrades

35. **Backup** (`sekhemet dev backup <path>`; restore with `sekhemet dev restore <path>`) uses SQLite's online backup API (`node:sqlite` `backup()`, built in), so writers continue while it copies; each backup records `ledger/backed_up` with its path and the sequence number it holds. `PRAGMA secure_delete` is on before any erasure, so erased content is overwritten rather than left on free pages.
36. **Restore re-applies erasures.** An erasure register beside the backups (event ids and reasons only, no personal data) lists every erasure; restoring a backup re-applies every erasure newer than the backup before the server accepts a request, and a restore refuses to start when erasures are known to exist and the register is missing. An old backup never silently brings back erased data or a leaked secret.
37. **Export with no lock-in.** `sekhemet dev export --ledger` writes NDJSON, one event per line with `seq`, `hash`, `prevHash`, the commitment of its private part, and its fields mapped to CloudEvents 1.0 attributes (`id`, `source`, `type`, `time`, `subject`); `--no-private` omits every private part and the chain still verifies; a standalone verifier checks the file offline. Projections and blobs are exported beside it.
38. **Upgrades migrate, never lose.** Schema migrations are numbered and forward-only and preserve the hash chain ([kernel](kernel.md)); a database older than the binary is backed up, migrated forward and its chain verified before the server serves; a database newer than the binary is refused with the version needed. A config migration runs in the same step ([surface](surface.md) reports renamed keys).

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
| `pruneRetention`, `RETENTION_DAYS = 30`, `RetentionReport`; `pruneRunData` | `packages/kernel/src/retention.ts`; `apps/harness/src/execute.ts:193` |
| `QueueReport`, `QueueEntry`, `writeQueueReport`; `listRuns` (the Runs view's source) | `apps/harness/src/execute.ts:1395-1482`; `apps/harness/src/dashboard_api.ts:311` |
| Events (new): `queue/reported {report}`; retention appends [kernel](kernel.md)'s `ledger/erased` with `reason: "retention"` | this spec; the event catalogue is kernel's |
| HTTP routes | `server.ts`, `rest_extra.ts`, `wave2_server.ts`, `pm_api.ts`, `integrations.ts`, `dashboard_api.ts` — listed below |
| CLI: `serve`, `board`, `daemon start\|stop\|status`, `run [card]`, `queue`, `overnight [--until HH:MM] [--idle-min N] [--max-failures N]`, `abort`, `rewind`, `fork`, `resume`, `replay <card> [--attempt N] [--diff A,B] [--as <model>]`, `log`, `traces [--since-hours N] [--out f] [--otlp url]` | `apps/harness/src/index.ts` |
| CLI (new): `dev backup <path>`, `dev restore <path>`, `dev export --ledger [--no-private]`, `dev pause\|resume <project>` | this spec |
| Config (new): `[server] host`, `port` (default 4040), `tls_cert`, `tls_key`, `trusted_proxies`, `session_hours`; `[scheduler] fair_share`, `max_wait_s` (the aging bound) | this spec |
| `SandboxOptions.maxBufferBytes` (default 10 MB, `DEFAULT_MAX_BUFFER`) | `packages/sandbox/src/types.ts:13`; `executor.ts:11, 196, 289-341` |
| `resolveStaticPath`, `MIME` | `apps/harness/src/server.ts:127-172` |
| SSE events: `append` (with `replay: {from, through, complete}`), `tokens` (`{cardId, text}`); live token file `.sekhemet/live/<card>.txt` | `server.ts:563-600, 1145-1170`; `liveTokenWriter` (`execute.ts:683`) |
| Request bodies: `cards/:id/split` takes `{parts: [{title, …}]}` (at least two; the SPIDR strategy is the planner's, [planner-pm](planner-pm.md)); `cards/:id/run` takes none | `rest_extra.ts:158-200` |

**Routes today** (all under `/api` unless noted; mutations are POST, PUT or DELETE):
- Board and cards: `board`, `workspace`, `projects`, `projects/:id`, `cards/:id`, `cards/:id/explain`, `cards/:id/attempts`, `cards/:id/transcript`, `cards/:id/diff`, `cards/:id/review`, `cards/:id/attachments`, `cycles`, `goals`, `decisions`, `planner/decisions`, `assumptions`, `recurring`, `wip`, `queue`.
- Card actions: `cards/:id/(accept|return|park)`, `cards/:id/(split|run|gate)`, `cards/:id/(abort|rewind|fork|override|reroute|reorder)`.
- Runs and evidence: `runs`, `evidence/:id`, `cards/:id/evidence`, `events?since=`, `stream` (SSE), `ws` (WebSocket), `integrity`, `metrics/flow`, `metrics/pm`, `signals`, `standup`, `capability`, `telemetry`.
- PM: `pm/messages`, `pm/thread`, `pm/proposals/:id/(apply|discard)` ([PM_CONTRACT.md](../PM_CONTRACT.md)).
- Integrations: see [integrations](integrations.md) §3; `/webhooks/github` (no `/api`).
- Machine and models: `machine`, `machine/calibrate`, `models`, `registry`, `doctor`, `meta`, `gates`, `playbook`, `learning`, `visual`.

The design's 2026-09-17 route table (`/workspace`, `/projects/:id/board`, `PATCH /cards/:id`, `/cards/:id/return`, `/decisions/:id/answer`, `WS /stream?card=`) is superseded by the routes above; the code is the contract, and a route change updates this list. The `reroute` and `explain` routes exist in code; the product behaviour behind them (forcing a model for a card; explaining an estimate or route) is [planner-pm](planner-pm.md)'s, where it is Later. A per-run budget override in the `run` body (old design) is not offered: Later (§7).

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
| Output capture capped at 10 MB with a truncation marker | built | `executor.ts:11, 289-341` | — |
| Per-card token and time budgets park the card | built | `PARKING_STOPS`, `BUDGET_STOPS` (`loop/src/card_runner.ts:265-285`); `runner_depth.spec.ts:270` | — |
| Per-card kWh budget; per-project caps | not-built | energy is counted per night only (`governance.ts:42-68`) | NEW-runtime-7 |
| Pause and resume a project | not-built | no such control | NEW-runtime-10 |
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
| Static `/app/*` serving: traversal refused, MIME types | built | `resolveStaticPath` (`server.ts:136-172`); `server.spec.ts:191` | — |
| Stream replay from `?since=` / `Last-Event-ID`, reload from projections | built | `server.ts:563-600`; `packages/ui/web/app.js:183-197` | — |
| Token streaming to the Steps tab | built | `liveTokenWriter` (`execute.ts:484-486, 683`); SSE `tokens` (`server.ts:1145-1170`) | — |
| PM with no lease loads through a residency scheduler | not-built | the no-lease path loads the PM model directly, with no footprint check (PM_CONTRACT §4.3; `pm/service.ts:222-320`) | NEW-runtime-6 |
| Fair share, per-slot leases on a team server | not-built | one global lease file (`pm/service.ts:57-110`) | NEW-runtime-6 |
| Backup, restore with erasures, ledger export, forward-only migrations | not-built | none | NEW-runtime-8 |
| Local traces, OTLP export on request | partial (was `built`; ruling R23) | card, step (the code's `turn`) and model-request spans (`execute.ts:531`, `tracing.ts:144-192`), export by `sekhemet dev traces` (`tracing.spec.ts`); no tool-call span; no dashboard view (nothing under `packages/ui/web` reads traces) | NEW-runtime-9 |
| Tokens removed by condensing, as a metric | not-built | the condenser computes `tokensSaved` per result (`context/src/condenser.ts:74-77, 414-420`); nothing outside it reads the figure | NEW-runtime-9 |
| Retention of packs, observations, transcripts | partial | wired at queue start (`index.ts:1243`), tested in the kernel (`blobs_retention.spec.ts`) but not through `queue`; it deletes with no `ledger/erased` record (`retention.ts:54-58`) | NEW-runtime-4 |
| Retention of `private` fields, 90 days by default | not-built | the ledger has no `private` part ([kernel](kernel.md) NEW-kernel-1) | NEW-runtime-8 |
| Run reports as a ledger event, files as a rebuildable cache | not-built | files only: `queue_report.json` and `runs/<startedAt>.json` (`execute.ts:1468-1482`); the Runs view reads the directory (`dashboard_api.ts:311-343`) | NEW-runtime-9 |
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
- **RUN-9** WHEN the supervisor starts and finds a card In Progress with a running attempt and no live lease THE SYSTEM SHALL finish the attempt with stop reason `crashed` (read, with its class and next action, from [worker-loop](worker-loop.md)'s stop-reason table, rule 31), restore the worktree to its last checkpoint and return the card to Ready.
- **RUN-10** WHEN a crashed card is next run THE SYSTEM SHALL continue from its last completed step.
- **RUN-11** WHEN an overnight round exceeds its wall-clock limit THE SYSTEM SHALL kill the round's process tree, count one failure and continue with the next round.
- **RUN-12** WHEN a chaos test kills the runner with SIGKILL mid-card THE SYSTEM SHALL, after restart, show no card stuck In Progress and no orphaned process.

### NEW-runtime-4 — bounded disk
*Justification: logs and traces grow without limit; retention is wired but untested through the command that runs it (review of domain 14, senior judgement 4); and it prunes what a model saw with no record, so replay cannot tell a pruned pack from a lost one (design v3 review B7). The owner decided O1 on 2026-09-24 ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)), so RUN-13 and RUN-54 apply, and RUN-55's report-only interim is withdrawn.*
- **RUN-13** WHEN `queue` starts and a card closed 31 days ago has context packs THE SYSTEM SHALL prune them, record them in one `ledger/erased` event with `reason: "retention"`, and keep its evidence bundle and every other ledger event.
- **RUN-54** WHEN retention prunes a context pack THE SYSTEM SHALL record it in a `ledger/erased` event with `reason: "retention"` and the pack's blob id, and replay of a step that used the pack SHALL name the gap and that event's seq, never report the pack as missing.
- **RUN-55** *(withdrawn 2026-09-24: it held only while O1 was open; the owner amended spine rule 2 ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O1), so retention prunes as a recorded erasure under RUN-13 and RUN-54. The number is not reused.)*
- **RUN-57** WHEN `queue` starts and a card closed 31 days ago has observations or transcripts THE SYSTEM SHALL delete them in the same `ledger/erased` event as its packs, and the queue's run report SHALL list every blob pruned, with its card id.
- **RUN-14** WHEN `daemon.log` exceeds its size limit THE SYSTEM SHALL rotate it and keep at most the configured number of files.
- **RUN-15** WHEN spans in `traces.db` are older than 30 days THE SYSTEM SHALL delete them at the next retention pass.
- **RUN-16** WHEN a parked card is closed THE SYSTEM SHALL remove its worktree and keep its branch.

### NEW-runtime-5 — the night does what it promises
*Justification: the full vulnerability scan never runs, and two watchdog actions are declared but never acted on.*
- **RUN-17** WHEN an overnight run finishes its rounds THE SYSTEM SHALL run the offline vulnerability scan and record its result on the ledger.
- **RUN-18** WHILE the watchdog requests `stopNewWorktrees` THE SYSTEM SHALL start no new card.
- **RUN-18a** WHEN one overnight round ends and the next begins THE SYSTEM SHALL reuse the running model server without reloading the model.

### NEW-runtime-6 — one scheduler, fair across people, per-slot leases
*Justification: the dashboard's no-lease path loads a second large model beside the Worker (integration review C3/C4, the 24 GB OOM path); a team server needs fairness and parallel slots keyed in from the start, or every queue and lease must be re-keyed later ([DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md)). Residency itself is [models](models.md)' (ruling R20).*
- **RUN-34** WHEN two or more people have work queued THE SYSTEM SHALL schedule model time by fair share per person, SHALL run interactive PM replies ahead of Worker steps, and SHALL promote any request that has waited longer than `max_wait_s` ahead of both.
- **RUN-35** WHEN the qualified capacity allows N concurrent cards THE SYSTEM SHALL run at most N, each holding its own slot lease, worktree and sandbox, and SHALL never let two running cards write the same file.
- **RUN-36** WHEN no runner holds the lease and a PM message needs a model whose memory footprint is unknown THE SYSTEM SHALL load nothing, answer that the model cannot be loaded safely, and record the refusal; with a known footprint it SHALL load only through the residency scheduler.

### NEW-runtime-7 — every budget the spec names is enforced
*Justification: per-card token and time budgets park the card, but the per-card kWh budget and the per-project caps of item 19 exist only in prose (inventory L22).*
- **RUN-37** WHEN a card's recorded energy reaches its kWh budget THE SYSTEM SHALL park it with a budget diagnosis naming the kWh cap.
- **RUN-38** WHEN a project's cumulative tokens, seconds or kWh reach its cap THE SYSTEM SHALL start no further card for that project and name the cap that stopped it.

### NEW-runtime-8 — backup, restore, export and upgrades that lose nothing
*Justification: an erasable ledger needs backups that do not resurrect erased data, a portable export, and migrations that never strand a ledger ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decisions 9–10, RUN-T1–T5; [DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md), upgrades). RUN-40, RUN-41 and RUN-43 depend on [kernel](kernel.md) NEW-kernel-1.*
- **RUN-39** WHEN `sekhemet dev backup <path>` runs THE SYSTEM SHALL write a consistent copy of the ledger with the SQLite online backup API while writers continue, and record `ledger/backed_up` with the path and the sequence number.
- **RUN-40** WHEN a backup is restored THE SYSTEM SHALL re-apply every erasure in the erasure register newer than the backup's sequence number before the server accepts requests, and SHALL refuse to start if the register is missing and erasures are known to exist.
- **RUN-41** WHEN a project's retention period for `private` fields elapses for a closed card — 90 days after it closed unless a person holding Accept set another period ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O14) — THE SYSTEM SHALL erase them with reason `retention`, and SHALL keep structural fields and commitments; WHEN the card closed 89 days ago under the default THE SYSTEM SHALL erase nothing of it.
- **RUN-42** WHEN `sekhemet dev export --ledger` runs THE SYSTEM SHALL write NDJSON with every event's `seq`, `hash`, `prevHash`, commitment and CloudEvents-mapped attributes, and a verifier run on that file alone SHALL reproduce the chain verdict.
- **RUN-43** WHEN `--no-private` is given THE SYSTEM SHALL omit every `private` part, and the exported chain SHALL still verify.
- **RUN-44** WHEN the harness starts on a database whose schema is newer than it knows THE SYSTEM SHALL refuse to start and name the version needed; WHEN the schema is older THE SYSTEM SHALL back it up, migrate it forward and verify the hash chain before serving.

### NEW-runtime-9 — telemetry as specified
*Justification: the state table said `built`, but there is no tool-call span and no dashboard view of traces (inventory H22, ruling R23); the condensing saving is computed and never reported (old design: RTK tracks savings); run reports live only in files the code calls the record (design trace PMFE:440, kernel rule 16).*
- **RUN-45** WHEN the Worker makes a tool call THE SYSTEM SHALL record a span for it, child of the step's span (named `turn` in the code), with the tool's name and outcome.
- **RUN-46** WHEN a person opens a card's traces in the dashboard THE SYSTEM SHALL show its card, step, model-request and tool-call spans with their durations, labelling the step span *Step*.
- **RUN-47** WHEN a queue run's report is written THE SYSTEM SHALL include, per card, the tokens removed by output condensing.
- **RUN-56** WHEN a queue run ends THE SYSTEM SHALL append its report as one `queue/reported` event; and WHEN `.sekhemet/runs/` and `queue_report.json` are deleted THE SYSTEM SHALL list the same runs, with the same figures, in the Runs view, rebuilt from those events.

### NEW-runtime-10 — pause a project
*Justification: the old design's "Pause project" scheduler control is referenced by [planner-pm](planner-pm.md) and specified nowhere.*
- **RUN-48** WHEN a person pauses a project THE SYSTEM SHALL start no new card for it in `queue` or `overnight` until it is resumed, SHALL let a running card finish, and SHALL record the pause and the resume with the person who made each.

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

RUN-1 to RUN-25, RUN-34 to RUN-48, RUN-54, RUN-56 and RUN-57 (with RUN-18a; RUN-55 is withdrawn; RUN-40, RUN-41 and RUN-43 once [kernel](kernel.md) NEW-kernel-1 lands, and RUN-13, RUN-54 and RUN-57 once kernel NEW-kernel-7 lands, both in B3.1), plus these built behaviours kept under test:
- **RUN-26** WHEN a card is rewound past a step whose gates passed THE SYSTEM SHALL mark that pass invalid and keep the abandoned state at a preserved ref.
- **RUN-27** WHEN an attempt is forked at step N THE SYSTEM SHALL create a new attempt with a parent reference and leave the parent unchanged.
- **RUN-28** WHEN `replay --diff A,B` compares two attempts THE SYSTEM SHALL name the first divergent step and the reproducibility fields that differ.
- **RUN-29** WHEN a command's tree exceeds its memory cap THE SYSTEM SHALL kill it and report the peak and the cap.
- **RUN-30** WHEN today's energy use reaches `power_budget_kwh_day` THE SYSTEM SHALL stop the overnight run with the energy breaker's reason.
- **RUN-31** WHEN a recurring template fires while a clone is still open THE SYSTEM SHALL not create a second clone.
- **RUN-32** WHEN one ledger event's content is altered THE SYSTEM SHALL report that event's sequence number as the first break.
- **RUN-33** WHEN no `--otlp` is given THE SYSTEM SHALL make no outbound request for telemetry.
- **RUN-49** WHEN `/app/..%2fpackage.json`, a path with a backslash or NUL, a symlink out of the web root, or an unknown extension is requested THE SYSTEM SHALL answer 404 and serve nothing; WHEN a `.js` file is served THE SYSTEM SHALL send `text/javascript` with `nosniff`.
- **RUN-50** WHEN a stream opens with `?since=<seq>` THE SYSTEM SHALL first send every append after that sequence number, marked with the range replayed.
- **RUN-51** WHEN a command writes more than 10 MB to stdout THE SYSTEM SHALL keep the first 10 MB and end the result with the truncation marker.
- **RUN-52** WHEN a card reaches its token or time budget THE SYSTEM SHALL park it with a budget diagnosis and not move it to Verify.
- **RUN-53** WHEN a running step is generating THE SYSTEM SHALL send its decoded tokens as `tokens` events while the ledger keeps only the finished response.

## 7. Later

- **launchd or systemd `--user` supervision** and restart; `proper-lockfile`, `tree-kill`, `pino` with rotation — proposals from the review needing the owner's yes (the behaviours above hold without them).
- **A gate host on another machine**: `gate-host` serves gates over mutual TLS on `127.0.0.1:7443` today, with certificates for `localhost` and `127.0.0.1`; `--host`, configurable certificate names and no shared-path assumption come with multi-machine gates.
- **Promoting a background process to a project service.**
- **The prompt optimiser overnight** (`improve`), once self-improvement admits only significant paired gains ([measurement](measurement.md), T8).
- **Energy from TDP × GPU utilisation** (the old design's formula) — needs a utilisation source on each host (on macOS `powermetrics` needs root); v1 estimates watts × run time with a user override (item 18).
- **A per-run budget override** in `POST /cards/:id/run` (old design `run { budgetOverride }`) — a card's budget is set with the card; a one-off override would make its measured record incomparable. `queue --max-turns` already caps every card's steps for one run, without changing the card.
- **A compliance pack** (audit exports, external timestamping or signing of the chain head) — the old design's Phase 4; v1 claims no compliance certification (SPINE), and the ledger export (item 37) is the handoff.
- **A single-executable build** — Later in [surface](surface.md) (the container image for the team server is approved for v1, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O9, and specified there, NEW-surface-4); **Litestream** for continuous replication on a company server — a proposal (Apache-2.0) needing the owner's yes; single machines use the built-in backup (item 35).
- **Kubernetes deployment, per-tenant token quotas beyond fair share** — a team server is one machine in v1; fair share with aging is enough for one team.
- **Multi-machine inference pooling** (SPINE: not in v1).

## 8. Open questions

1. **`retention.ts`: wire in or cut (DEC-09)?** *Decided:* keep it — it is already wired (`queue` prunes on every start, `index.ts:1243`) — extend it to logs, traces and closed worktrees (NEW-runtime-4), test it through `queue`, and make every prune a `ledger/erased` record (item 33). The owner's O1 ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)) removed the report-only interim.
2. **Where do reproducibility records live?** Every card must record model, quantisation, template checksum, prompt-set version, playbook version, tool-schema version and engine settings. *Recommendation:* owned by M4 in [models](models.md) and [measurement](measurement.md); replay (item 14) consumes them.
3. **Supervisor as its own process, or the dashboard server?** *Recommendation:* the server process, started by `daemon start` or `serve`, with `run`/`queue` from the CLI taking the same lease; a separate supervisor only if the chaos test (RUN-12) cannot pass otherwise.

## 9. Evidence and rationale

- Review: [domains 11 and 14](../../reference/reviews/domain11_14_security_runtime.md#runtime-rubric-questions-27) — PID reuse, the non-atomic lease, tree kills, the crash sweep, the watchdog's dead actions, rotation.
- [INTEGRATION_REVIEW.md](../../reference/reviews/integration_review_2026-09-18.md) §C — why one runner and one scheduler own residency (the dashboard's second scheduler, C4; suggestion 10) → item 4, RUN-36.
- Research, [DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md): fair multi-tenant serving (VTC, FairServe, Equinox) and Chimera's starvation counter → item 4a, RUN-34; llama.cpp parallel slots and vLLM continuous batching → item 3, RUN-35 (vLLM approved as the optional engine, O8); forward-only migrations with a backup and a refusal of a newer database → item 38, RUN-44. Engine choice and qualification are [models](models.md)'.
- Research, [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md): decisions 9 (online backup, `secure_delete`, an erasure register; the ICO's "beyond use") and 10 (NDJSON export mapped to CloudEvents; GDPR portability) → items 34a, 35–37, NEW-runtime-8. CloudEvents is used as a field mapping only, with no SDK.
- Deliberate changes from the 2026-09-17 design, each stated where it applies: SSE instead of one WebSocket (item 25); energy without the utilisation term (item 18); checkpoint cadence owned by review-git (item 11, ruling R1); watchdog thresholds owned by models (item 22, ruling R27).
- Decisions: [DEC-06](../DECISIONS.md#dec-06) (company server), [DEC-09](../DECISIONS.md#dec-09) (retention's wire-or-cut), [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) (O1 erasure and retention as recorded erasure → items 33, 34a; O8 vLLM → item 3; O9 the container image → §7; O14 90 days → item 34a), [DEC-22](../DECISIONS.md#dec-22--rejected-techniques) (no long-running conversational sessions).
- **Why no sessions:** long conversational sessions rot (context decay, lost-in-the-middle, hallucinated agreements); a fresh deterministic context per attempt, with resume, fork, rewind and replay from the log, gives every session feature without the decay.
