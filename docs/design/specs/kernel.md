---
spec: kernel
status: partial
audiences: [developer]
code:
  - packages/kernel/src/log.ts
  - packages/kernel/src/card_store.ts
  - packages/kernel/src/records.ts
  - packages/kernel/src/schema.ts
  - packages/kernel/src/types.ts
  - packages/board/src/board_service.ts
tests:
  - packages/kernel/tests/log.spec.ts
  - packages/kernel/tests/card_store.spec.ts
  - packages/kernel/tests/records.spec.ts
  - packages/kernel/tests/pragmas.spec.ts
  - packages/board/tests/board.spec.ts
  - packages/board/tests/entry_conditions.spec.ts
  - packages/board/tests/runner_backpressure.spec.ts
changes: [S4, S7, P3, NEW-kernel-1, NEW-kernel-2, NEW-kernel-3, NEW-kernel-4]
---

# Kernel: the event log, projections and the card lifecycle

## 1. Purpose

The kernel is the system of record. It keeps an append-only, hash-chained event log, derives the board from it, and enforces the one state machine every card moves through. It carries two spine rules directly: **the event log is the only durable channel**, and **a card is the unit of work**. It is also where "the model never certifies its own work" becomes unbypassable, because no writer can move a card past a gate the kernel's transition law refuses.

## 2. Behaviour

### Hierarchy and entities

1. Work nests four levels deep: workspace, project, card, subtask. A card may have a parent card; a subtask may not have children. A deeper nesting is refused at creation with `CardStructureError("hierarchy_depth")` before anything reaches the ledger.
2. At most three projects are active at once by default (the workspace cap); activating a fourth is refused with `CardStructureError("project_cap")`.
3. Card dependencies form a directed acyclic graph. Adding an edge that closes a cycle is refused with the cycle's path. A card is eligible to start only when every card it depends on is `done`.
4. Two running cards whose declared scopes overlap are never run at once; the board reports the overlap and the runner serialises them. A held card (rule 18) does not count as running.
5. Every card has a human-readable **key** — the project's prefix and a number, such as `CHR-12` — assigned at creation from a per-project counter carried in the `card/created` payload. Keys are monotonic, never reused (not even after a card is rejected), and stable across replay; the dashboard, the CLI and integrations show the key, while the internal id stays the join key.
6. The shapes are the TypeScript types in `packages/kernel/src/types.ts` (`CardRecord`, `EventRecord`, `AttemptRecord`, `StepRecord`, `GateResultRecord`, `EvidenceBundleRecord`, `DecisionRequestRecord`, `CompetenceEntry`, `ProjectRecord`). The SQL is `packages/kernel/src/schema.ts`. Goals belong to [planner-pm.md](planner-pm.md); evidence bundle contents to [gates.md](gates.md).

### The event log

7. Every change to durable state is an event appended to one SQLite table, `events`, in `.sekhemet/events.db`. Events are immutable; a correction is a new event. The database rejects any `UPDATE` or `DELETE` on `events`.
8. Each event carries a SHA-256 `payloadHash` over the canonical (key-sorted) JSON of its payload, and a chain `hash` over its identity, its association columns, its payload hash and the previous event's hash. There is **one** chain formula per recorded `hash_version`, defined only in `EventLog.computeHash` (`log.ts`); this spec and every other document link to it rather than restating it. The formula covers the event's timestamp (`created_at`) and, for events by a person, the principal.
9. Verifying the chain names the first corrupt `seq`. Verification is incremental: it starts from the last verified `seq` and re-hashes only newer events.
10. A row written under an earlier formula verifies under that formula; a row with no recorded version is verified by the legacy rule the code keeps for it.
11. The chain head is anchored outside SQLite: every accepted card's merge commit carries `Ledger-Head: <seq>:<hash>` (written by the Accept path, [review-git.md](review-git.md)), and `sekhemet log` cross-checks the newest anchor against the ledger, which exposes a truncated tail.
12. **One validated transaction per event.** A write validates its payload (against the event type's schema and the projection's constraints), then appends the event and applies its projection inside one `BEGIN IMMEDIATE` transaction. If validation or projection fails, nothing is appended. A poison event — one that cannot be projected — can therefore never enter the ledger.
13. The board, attempts, steps, gate results, evidence records, decisions and competence rows are projections of the log. `rebuildProjections()` replays the log from `seq` 1 and produces byte-identical projections; `verifyProjections()` compares them without writing. `sekhemet log` prints the chain verdict and the projection verdict, exits 1 on drift, and `sekhemet log --rebuild` rebuilds.
14. Every value a projection needs (ids, order keys, timestamps) is resolved before the event is appended and carried in its payload, so a replay never generates a value.
15. Nothing durable lives outside the ledger. A file under `.sekhemet/` is either a content-addressed blob that an event references by hash (context packs, evidence bundles, transcripts) or a cache that is safe to delete. A decision, a candidate rule or a pointer to "the latest" anything that exists only in a file is a defect.
16. Every event names its **actor** from one closed set (`EVENT_ACTORS`, enforced by a `CHECK` and by `append`): *which role or component* wrote it. Separately, a `principal` column names *which person* it acts for — required when the actor is `human`, and on any event a person caused through a machine actor (an MCP client, the dashboard, an auto-accept a person switched on); null for purely machine events. The principal is covered by the chain hash and carried through replay. The identity layer resolves it ([integrations.md](integrations.md) owns identity and who may Accept, [DEC-06](../DECISIONS.md#dec-06)); on a single-user install it is the git `user.email`, else the OS user. The actor set stays fixed; people are never added to it.

### The state machine

17. A card is in exactly one of nine states, stored as `backlog`, `ready`, `planning`, `in_progress`, `verify`, `review`, `done`, `parked`, `rejected`. The stored value, the column heading in the pipeline view, error messages and the documents use the same nine names. **The nine-state machine is the truth.** The board's five familiar columns (Backlog, To Do, In Progress, In Review, Done, plus On Hold when non-empty, [dashboard.md](dashboard.md)) are a read-only projection over these states: no column exists in storage, a move on the board is a transition request in stored states, and no rule in this spec is expressed in board columns.
18. **Held is not a state.** A card whose move was refused by back-pressure keeps its state and is marked held, with the state it waits for and the reason, as a typed field recorded by `card/held` and cleared by `card/released`. Nothing encodes a state in free text.
19. The legal edges are one table, `LEGAL_TRANSITIONS`. Every state has at least one exit a person can reach from the command line: `parked → ready` (`sekhemet unpark`) and `rejected → ready` (`sekhemet reopen`, specified in [review-git.md](review-git.md)).
20. **The transition law is in the kernel.** A status change is a compare-and-set: the caller names the status it expects, and the kernel checks the edge against the **stored** status. A mismatch is refused (`stale_from`), an illegal edge is refused (`illegal_transition`), and a move to the state the card is already in appends nothing. There is no other way to change a card's status: the board, the runner, research cards, external review, decisions, sessions, recurring templates, the PM's slash commands, MCP and the dashboard all go through it.
21. On top of the law, the board adds entry conditions, per-column WIP limits and back-pressure. When the harness runs, entry conditions are always on:

    | Target | Entry condition |
    | --- | --- |
    | `ready` (from `backlog`) | Acceptance criteria or acceptance tests present |
    | `ready`, `planning`, `in_progress` | Every dependency is `done` |
    | `in_progress` | A declared scope, unless the card is a parent (a parent never runs itself) |
    | `verify` | The current attempt ended with a recorded stop reason; Review is below its WIP limit (back-pressure) |
    | `review` | The latest evidence bundle ran at least one gate and every blocking gate passed; no gate was unavailable |
    | `done` | An accepting decision ([review-git.md](review-git.md)); or, for a parent, the rollup rule below |

    Red-first — acceptance tests staged and failing before work — is enforced by the runner at the start of `in_progress` and specified in [gates.md](gates.md).
22. **Overrides.** A person may move a card past an illegal edge or a failed entry condition by giving a reason prefixed `override:`. The override is recorded on the ledger as `card/override`, naming the principal and what was overridden. Only an actor `human` with a principal may override; `mcp`, `harness`, `worker`, `planner` and every other actor may not. No override passes a failing security-layer gate into `review` or `done`.
23. **Back-pressure.** When Review holds as many cards as its WIP limit, no card may enter `verify`; the runner holds the card instead of failing it. How the Review limit is computed from human review time is specified in [review-git.md](review-git.md) (S6).
24. **Rollup.** A parent card reaches `done` only when every child is `done` **and** the project's blocking gates pass on the merged result. The rollup records `card/rollup` with the children and the verdict, moves the parent to `done` along legal edges when it passes, and to `planning` with the failures when it does not. Success is never inferred from children alone.
25. A revised card returns to Review only through the same `review` entry condition, so every revision re-passes every gate. Protection of what `main` already guarantees is the regression gate ([gates.md](gates.md)).
26. **Rewind and fork** (the commands are [runtime.md](runtime.md)'s) record `card/rewound` or `card/fork_requested` with the checkpoint, keep the abandoned state under a ref, and return the card to `ready`. Evidence recorded before a rewind no longer satisfies the `review` entry condition: rewinding past a gate pass invalidates it.

### Storage

27. SQLite in WAL mode, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`, one database per repository. Schema changes are numbered migrations recorded in `PRAGMA user_version`; a migration never drops a column that holds data. Each card field is declared once, in one column table from which the DDL, the insert and the replay projection are derived (today one column is declared in nine places).

## 3. Contract

| Item | Source |
| --- | --- |
| Card, event, run-record and project types | `packages/kernel/src/types.ts` |
| Actors: `EVENT_ACTORS` (13 today) | `packages/kernel/src/types.ts:325` |
| States: `CardStatus`; stop reasons: `CardStopReason`, `CARD_STOP_REASONS` | `packages/kernel/src/types.ts:13`, `:41`, `:72` (the stop-reason table is owned by [worker-loop.md](worker-loop.md), T3) |
| Chain formula and verification: `EventLog.computeHash`, `verifyHashChain` | `packages/kernel/src/log.ts:84`, `:333` |
| Canonical payload hash | `packages/kernel/src/canonical_json.ts` |
| Schema, pragmas and migrations | `packages/kernel/src/schema.ts` |
| Card writes, dependencies, projects, replay: `CardStore` | `packages/kernel/src/card_store.ts` |
| Attempts, steps, gate results, evidence, decisions, competence: `RunLedger`, `RUN_EVENTS` | `packages/kernel/src/records.ts` |
| Edge table, entry conditions, WIP, back-pressure, hold: `LEGAL_TRANSITIONS`, `BoardServiceImpl` | `packages/board/src/board_service.ts:32`, `:120` |
| Refusal codes: `TransitionRefusedError` (`card_not_found`, `illegal_transition`, `entry_condition`, `security_gate`, `back_pressure`, `wip_limit`; adds `stale_from`, `override_forbidden`) | `packages/board/src/types.ts` |
| Default WIP limits: planning 3, in_progress 5, verify 5, review 3 (before calibration) | `packages/board/src/board_service.ts:13` |
| Hierarchy and project cap: `MAX_CARD_DEPTH = 2`, `DEFAULT_ACTIVE_PROJECT_CAP = 3` | `packages/kernel/src/card_store.ts:32`, `:35` |
| Events: `card/created`, `card/status_changed`, `card/updated`, `card/override`, `card/rollup`, `card/dependency_*`, `card/held`, `card/released` (new), run events in `RUN_EVENTS` | `card_store.ts`, `records.ts:29` |
| CLI: `sekhemet log [--rebuild]`, `park`, `unpark`, `send-back`, `accept` | `apps/harness/src/index.ts:647`, `front_door.ts` |
| HTTP: `POST /api/cards/:id/override` (body `toStatus`, `reason`) | `apps/harness/src/server.ts:979`; the API itself is [runtime.md](runtime.md) |
| MCP: `sekhemet_move_card` (to `ready`, `backlog`, `parked` only) | `apps/harness/src/mcp.ts:156` |

The earlier design's `Card` interface, event interface and SQL listing are retired in favour of the types and `schema.ts` above; where they differed (`filesTouched` vs `scopeFiles`, `column_state` vs `status`, a seven-actor set, a formula without `id`), the code's names stand.

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Append-only log with payload hash and chain; tamper detection naming the seq | built | `log.ts:146`; `log.spec.ts:42`, `:92`, `:121`; `sekhemet log` | — |
| Chain covers the timestamp; `UPDATE`/`DELETE` refused; incremental verification; external anchor | not-built | the hash omits `created_at` (`log.ts:95-105`); no triggers (`schema.ts:100-113`); `verifyHashChain` re-hashes the whole ledger on every SSE frame (`server.ts:471`) | NEW-kernel-1 |
| Replay: `rebuildProjections`, `verifyProjections`, `log --rebuild` | built | `card_store.ts:1299`, `:1331`; `index.ts:647` | — |
| One validated transaction per event (no poison events) | not-built | append then project outside the transaction (`card_store.ts:399-407`, `500-514`); one bad write makes rebuild throw forever (probe, kernel review §1) | S7 |
| Ledger as the only durable channel | partial | `sendBack` writes `.sekhemet/playbook_candidates.jsonl` (`triage.ts:63-68`); Review reads `latest-<card>.json` (`execute.ts:1233-1242`) | S7 |
| Principal on events (separate from actor, in the chain) | not-built | actors are role names only; `answerDecision` takes any string (`records.ts:537`) | NEW-kernel-2 |
| Card key (`CHR-12`) | not-built | cards carry only `card_<uuid8>` ids (`card_store.ts:337`) | P3 |
| Board columns as a projection over the nine states | partial | the mapping exists only in the Jira export (`integrations.ts:274-284`) | P3 ([dashboard.md](dashboard.md)) |
| Nine states with one name each | built | `types.ts:13`; `ui/src/vocabulary.ts:93` | — |
| Edge table and override record | built | `board_service.ts:32`, `:192`; `entry_conditions.spec.ts:78` | — |
| Transition law checked against the stored status; single path for all writers | not-built | checked against caller's `fromStatus` (`board_service.ts:272`); same-status bypass (`:267-270`); 11 direct `updateCardStatus` callers (`research/cards.ts:84,128-136`, `external_review.ts:141,244,252`, `planner/decisions.ts:123,209,236`, `planner/sessions.ts:160`, `pm/slash.ts:119`, `recurring.ts:175`) | S4 |
| No override from MCP or other non-human actors | not-built | `sekhemet_move_card` passes a caller-supplied reason, so `override:` works over MCP (`mcp.ts:175`) | S4 |
| Entry conditions: criteria, dependencies, scope, passing evidence, accepting actor | built | `board_service.ts:137`; `entry_conditions.spec.ts:43`, `:61` | — |
| Entry to Verify requires a recorded stop reason | not-built | no check in `entryConditionFailure` | S4 |
| Security gate never overridden | built | `board_service.ts:282`; `entry_conditions.spec.ts:93` | — |
| Back-pressure at Verify | built | `board_service.ts:314-324`; `runner_backpressure.spec.ts` | — (limit: S6, [review-git.md](review-git.md)) |
| Held as a typed field | partial | a `blockedReason` string prefix (`board_service.ts:347-403`) | NEW-kernel-3 |
| Dependency DAG with cycle refusal; eligibility | built | `card_store.ts:771-851` | — |
| Overlapping scopes serialised | built | `board_service.ts:410`; `entry_conditions.spec.ts:145` | — |
| Hierarchy cap and project cap | built | `card_store.ts:343-356`, `:975` | — |
| Rollup with integration gate | built | `execute.ts:1039`; `control.spec.ts:173` | — |
| Exits from Parked and Rejected reachable from the CLI | partial | `unpark` exists; no `reopen` or `reject` verb (kernel review §2) | S4 (verbs delivered with S5) |
| Numbered migrations; one column table | not-built | DDL-text sniffing; `rebuildCardsTableIfStale` drops unknown columns (`schema.ts:333-344`, `:444`); the card column list is declared in nine places (`schema.ts:27-63`, `287-317`; `card_store.ts:65-140`, `152-197`, `259-305`, `1087-1189`) | NEW-kernel-4 |
| Rewind and fork recorded; card returns to Ready | built | `execute.ts:895-921`; `control.spec.ts:203` | — |
| Rewind invalidates earlier evidence for Review | not-built | Review reads `latest-<card>.json`, which a rewind does not touch | S7 |

## 5. Changes for v1

### S7 — one validated transaction per event

*Problem:* events are committed before projection, so one bad write breaks replay for good, and two decisions live in files instead of the ledger.

- **K-S7-1** WHEN `createCard` is called with `difficulty: 11` THE SYSTEM SHALL throw, the event count SHALL be unchanged, and `verifyProjections()` SHALL return `identical: true`.
- **K-S7-2** WHEN a status write names a value outside the nine states THE SYSTEM SHALL refuse it before appending, and `rebuildProjections()` SHALL still succeed.
- **K-S7-3** WHEN the projection step throws after validation passed (fault injected) THE SYSTEM SHALL roll back the append, so that after reopening the database neither the event nor the projection change exists.
- **K-S7-4** WHEN an event type has a registered payload schema and a payload fails it THE SYSTEM SHALL refuse the write with an error naming the event type and the failing field.
- **K-S7-5** WHEN `POST /api/cards/:id/override` carries a `toStatus` that is not a `CardStatus` THE SYSTEM SHALL respond 400 and append nothing.
- **K-S7-6** WHEN a person sends a card back THE SYSTEM SHALL record the playbook candidate as a ledger event and SHALL NOT write `.sekhemet/playbook_candidates.jsonl`.
- **K-S7-7** WHEN the Review entry condition reads a card's evidence THE SYSTEM SHALL resolve the bundle from the evidence id recorded on the ledger, and deleting `latest-<card>.json` SHALL NOT change the verdict.
- **K-S7-8** WHEN a card that has passing evidence is rewound to an earlier step THE SYSTEM SHALL refuse its move into `review` until evidence recorded after the rewind passes.

### S4 — the transition law in the kernel

*Problem:* the edge check trusts the caller's `fromStatus`, equal statuses skip every check, and eleven writers bypass the board.

- **K-S4-1** WHEN a transition names a `fromStatus` different from the stored status THE SYSTEM SHALL refuse it with `stale_from` and append nothing (a Backlog card sent `{from: "done", to: "done"}` stays in Backlog).
- **K-S4-2** WHEN a transition's target equals the stored status THE SYSTEM SHALL append no event and return the card unchanged.
- **K-S4-3** WHEN the production source is searched THE SYSTEM SHALL contain no call to a status-writing method outside `packages/kernel` and `packages/board` (a test enumerating callers fails otherwise).
- **K-S4-4** WHEN a research card's note is written, or an external review finishes, THE SYSTEM SHALL move the card through the board, so that back-pressure and the `review` entry condition apply; an external-review card whose gates failed SHALL NOT enter `review`.
- **K-S4-5** WHEN an actor other than `human`, or a `human` event without a principal, gives an `override:` reason THE SYSTEM SHALL refuse with `override_forbidden` and append nothing.
- **K-S4-6** WHEN a card would enter `verify` and its current attempt has no recorded stop reason THE SYSTEM SHALL refuse with `entry_condition`.
- **K-S4-7** WHEN the CLI's verbs are enumerated THE SYSTEM SHALL provide, for each of `parked` and `rejected`, a verb that moves the card to `ready`.

### NEW-kernel-1 — hash chain v3

*Justification:* the chain does not cover the timestamps that review time and WIP are measured from, verifies by re-hashing everything, and cannot see a truncated tail.

- **K-N1-1** WHEN a row's `created_at` is edited directly in SQLite THE SYSTEM SHALL report the chain invalid at that row's `seq`.
- **K-N1-2** WHEN any statement tries to `UPDATE` or `DELETE` a row of `events` THE SYSTEM SHALL abort that statement.
- **K-N1-3** WHEN the chain was verified up to `seq` N and M events are appended THE SYSTEM SHALL verify by hashing exactly M events.
- **K-N1-4** WHEN a ledger holds rows under two formula versions THE SYSTEM SHALL verify each row by its own version and report `valid: true` when none was altered.
- **K-N1-5** WHEN the newest `Ledger-Head` trailer on the integration branch names a `seq` greater than the ledger's last `seq` THE SYSTEM SHALL report the ledger truncated and exit 1 from `sekhemet log`.

### NEW-kernel-2 — a `principal` column on events

*Justification:* DoD §6.6 and [DEC-06](../DECISIONS.md#dec-06) (company-server mode) require that every event names its person; today "human" is a role, not a person, and actor and person are conflated.

- **K-N2-1** WHEN an event with actor `human` is appended without a principal THE SYSTEM SHALL refuse it.
- **K-N2-2** WHEN a decision request is answered, a card is accepted, or an override is recorded THE SYSTEM SHALL record the acting principal on that event.
- **K-N2-3** WHEN a stored event's `principal` is edited directly in SQLite THE SYSTEM SHALL report the chain invalid at that `seq`.
- **K-N2-4** WHEN projections are rebuilt from the ledger THE SYSTEM SHALL reproduce every principal exactly, and `verifyProjections()` SHALL return `identical: true`.
- **K-N2-5** WHEN an MCP client or the dashboard moves a card on a person's behalf THE SYSTEM SHALL record actor `mcp` or `human` as the component that wrote it and the person as the principal.
- **K-N2-6** WHEN a purely machine event (a step, a gate result) is appended THE SYSTEM SHALL store a null principal, and the actor set SHALL be unchanged.

### P3 — the card key (the kernel's share of the professional board, [dashboard.md](dashboard.md))

- **K-P3-1** WHEN a card is created in a project with prefix `CHR` THE SYSTEM SHALL assign the key `CHR-<n>`, where n is one more than the highest number ever assigned in that project, carried in the `card/created` payload.
- **K-P3-2** WHEN a card is rejected or deleted from view and a new card is created THE SYSTEM SHALL NOT reuse the old card's key.
- **K-P3-3** WHEN projections are rebuilt THE SYSTEM SHALL reproduce every key exactly, and the CLI SHALL accept a key wherever it accepts a card id.

### NEW-kernel-3 — held as a typed field

*Justification:* "held" is a hidden tenth state parsed out of free text.

- **K-N3-1** WHEN back-pressure refuses the runner's move into `verify` THE SYSTEM SHALL append `card/held` naming the awaited status and the reason, and the board state SHALL list the card as held without reading `blockedReason`.
- **K-N3-2** WHEN a held card's awaited move succeeds THE SYSTEM SHALL append `card/released` and clear the hold; while the move is still refused it SHALL keep the hold and append nothing.

### NEW-kernel-4 — numbered migrations and one column table

*Justification:* migrations sniff DDL text, one silently drops unknown columns, and one column declared in nine places is the likeliest source of replay drift.

- **K-N4-1** WHEN a database at `user_version` N below the current version is opened THE SYSTEM SHALL apply migrations N+1 to current, each in its own transaction, and set `user_version`.
- **K-N4-2** WHEN a database's `user_version` is above the current version THE SYSTEM SHALL refuse to open it with a message naming both versions.
- **K-N4-3** WHEN a migration would remove a column that holds a non-null value THE SYSTEM SHALL abort the migration and leave the database unchanged.
- **K-N4-4** WHEN a column is added to the card column table THE SYSTEM SHALL include it in the `cards` DDL, the insert and the replay projection without any other edit (a test adds a column to a fixture table and checks all three).

## 6. v1 acceptance

This spec is `built` when every criterion in §5 passes and these behaviours, already built, stay under test:

- **K-1** WHEN one payload byte or one stored hash is flipped on disk THE SYSTEM SHALL report the chain invalid at that `seq` (`log.spec.ts:92`, `:121`).
- **K-2** WHEN projections are rebuilt from the ledger THE SYSTEM SHALL produce byte-identical projections, and `sekhemet log` SHALL exit 1 when they differ.
- **K-3** WHEN a card is created three levels below a card, or a dependency would close a cycle, or a fourth project is activated THE SYSTEM SHALL refuse with `hierarchy_depth`, `dependency_cycle` or `project_cap` respectively, before appending.
- **K-4** WHEN any entry condition in §2 rule 21 fails THE SYSTEM SHALL refuse the move with `entry_condition` and a message naming the missing item.
- **K-5** WHEN a card's latest evidence fails a security-layer gate THE SYSTEM SHALL refuse a move into `review` or `done` even with an `override:` reason.
- **K-6** WHEN Review is at its WIP limit THE SYSTEM SHALL refuse entry to `verify` with `back_pressure`, and the runner SHALL hold the card rather than fail it.
- **K-7** WHEN the last child of a parent is accepted and the integration gates pass THE SYSTEM SHALL move the parent to `done` and record `card/rollup`; WHEN they fail, to `planning` with the failures.
- **K-8** WHEN a card is moved into the scope of a running card THE SYSTEM SHALL report the overlapping files and SHALL NOT run both.

## 7. Later

- **An external timestamping or signing service for the chain.** The git anchor (rule 11) closes truncation for a single repository; notarisation matters only for compliance use, which is not v1.
- **Splitting `card_store.ts`** (1,351 lines, six concerns) into `CardRepository`, `DependencyGraph`, `DossierStore`, `ProjectStore` and `Projector`. It is done strangler-style inside the S7 workstream, since S7 touches every write, and is accepted by K-S7-1…8 plus K-N4-4; it is listed here only because it is not a behaviour.
- **Retention of context packs and transcripts** (`retention.ts`, 30 days after close, evidence kept forever) is a runtime job; see [runtime.md](runtime.md).

## 8. Open questions

1. **The state names in [NAMING.md](../NAMING.md).** Its keep list gives *Working, Checking, Closed*; the code, the UI and this spec use *In Progress, Verify, Rejected*, and the old design retired the former for the reason in rule 17. *Recommendation:* NAMING.md changes to the nine stored names for the pipeline view and adds the five board columns from [dashboard.md](dashboard.md).
2. **`worker` and `executor` are both actors.** *Recommendation:* new writes use `worker`; `executor` stays valid for existing rows only (a `CHECK` cannot drop it without rewriting history).
3. **`harness` as an accepting actor** (`ACCEPTING_ACTORS`, `board_service.ts:110`) lets `queue --auto-accept` and rollup reach `done`. *Recommendation:* keep it only for rollup and for an auto-accept switch that a named person turned on, recorded as that person's standing decision; [review-git.md](review-git.md) owns the rule.
4. **Validation library.** The payload registry in K-S7-4 could use Zod or Valibot — *proposed, needs the owner's yes*; a hand-written validator per event type is the fallback.

## 9. Evidence and rationale

- Review: [domain02_09_kernel_review.md](../../reference/reviews/domain02_09_kernel_review.md) (probes for poison events, the `fromStatus` bypass, the `created_at` edit and tail truncation).
- Programme: [COVERAGE.md](../../reference/COVERAGE.md) S4, S7; DoD §6.2 and §6.6.
- *Rejected:* XState for the state machine — the edge table is ten lines and correct; the defect was trusting the caller (kernel review, Proposals).
