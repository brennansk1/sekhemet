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
  - packages/kernel/src/blobs.ts
  - packages/kernel/src/order_key.ts
  - packages/board/src/board_service.ts
tests:
  - packages/kernel/tests/log.spec.ts
  - packages/kernel/tests/card_store.spec.ts
  - packages/kernel/tests/records.spec.ts
  - packages/kernel/tests/pragmas.spec.ts
  - packages/kernel/tests/dossier.spec.ts
  - packages/board/tests/board.spec.ts
  - packages/board/tests/entry_conditions.spec.ts
  - packages/board/tests/runner_backpressure.spec.ts
  - apps/harness/tests/runner_wiring.spec.ts
changes: [S4, S7, P3, NEW-kernel-1, NEW-kernel-2, NEW-kernel-3, NEW-kernel-4, NEW-kernel-5, NEW-kernel-6, NEW-kernel-7, NEW-kernel-8, NEW-kernel-9]
---

# Kernel: the event log, projections and the card lifecycle

## 1. Purpose

The kernel is the system of record. It keeps an append-only, hash-chained event log, derives the board from it, and enforces the one state machine every card moves through. It carries two spine rules directly: **the event log is the only durable channel**, and **a card is the unit of work**. It is also where "the model never certifies its own work" becomes unbypassable, because no writer can move a card past a gate the kernel's transition law refuses. Because every later format (exports, sync, measurement, erasure) reads the event envelope and the card record, both are fixed here now, before teams depend on them.

## 2. Behaviour

### Hierarchy and entities

1. Work nests four levels deep: workspace, project, card, subtask. A card may have a parent card; a subtask may not have children. A deeper nesting is refused at creation with `CardStructureError("hierarchy_depth")` before anything reaches the ledger.
2. At most three projects are active at once by default (the workspace cap); activating a fourth is refused with `CardStructureError("project_cap")`.
3. Card dependencies form a directed acyclic graph. Adding an edge that closes a cycle is refused with the cycle's path. A card is eligible to start only when every card it depends on is `done`.
4. Two running cards whose declared scopes overlap are never run at once; the board reports the overlap and the runner serialises them. A held card (rule 24) does not count as running.
5. Every card has a human-readable **key** — the project's prefix and a number, such as `CHR-12` — assigned at creation from a per-project counter carried in the `card/created` payload. Keys are monotonic, never reused (not even after a card is rejected), and stable across replay; the dashboard, the CLI and integrations show the key, while the internal id stays the join key.
6. The shapes are the TypeScript types in `packages/kernel/src/types.ts` (`CardRecord`, `EventRecord`, `AttemptRecord`, `StepRecord`, `GateResultRecord`, `EvidenceBundleRecord`, `DecisionRequestRecord`, `CompetenceEntry`, `ProjectRecord`). The SQL is `packages/kernel/src/schema.ts`. Goals belong to [planner-pm.md](planner-pm.md); evidence bundle contents to [gates.md](gates.md). What each record holds, so that no field is lost to a later rewrite:
   - **Project** (`ProjectRecord`): id, name, root path, git branch, status (`active`, `idle`, `paused`, `archived`, `done`; the code stores the first, third and fourth today) and review minutes per day. The old design's per-project "gate contract, conventions ref, stage, playbook ref" and its `tier` column (default `'auto'`) are not columns: the gate contract is `.sekhemet/gates.toml` ([gates.md](gates.md)), conventions and the playbook are guidance on the ledger ([context.md](context.md)), and the stage is the design stage's ([design-stage.md](design-stage.md)); the hardware tier belongs to the host, not the project — it is derived from the host's memory by calibration ([models.md](models.md) rules 7–8), which is also why [surface.md](surface.md) rule 25 removed `machine.tier`.
   - **Project status** has two sources and no third. The kernel's rollup of the project's top-level cards (rule 30) yields only `active` (some top-level card is open) or `idle` (none is); it never yields "complete". `paused` and `archived` are a person's. `done` comes only from a `slice/accepted` event — a person's acceptance of the release slice that completes the project, which [planner-pm.md](planner-pm.md) computes from the requirement graph (P13; [DEC-11](../DECISIONS.md#dec-11)): a project whose cards are all Done but whose must-haves are unplanned is `idle`, never done.
   - **What kind of card it is** ([DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)) is three stored, closed fields, set when the card is planned and carried in `card/created`:
     - `kind` — `spike`, `interface`, `implement`, `data`, `rule`, `review` or `research`. It selects the Worker's tools ([worker-loop.md](worker-loop.md) rule 10), the red-first rule ([gates.md](gates.md) rule 6) and rule scoping ([context.md](context.md) rule 24b), and it is the first half of the card class ([models.md](models.md) rule 31). People see the labels of the one map in [NAMING.md](../NAMING.md) (`interface` → *Contract*, `data` → *Storage*, `implement` → *Flow*, `rule` → *Rules*; *UI* and *Wiring* are display refinements of `implement`, never stored).
     - `change` — `feature`, `fix`, `characterize`, `refactor` or `upgrade`: what the card does to existing code. A new project's cards are `feature`. Its red/green rule is [gates.md](gates.md)'s (rule 6b, NEW-gates-8); all five ship in v1 ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O10).
     - `split` — `spike`, `path`, `interface`, `data`, `rules`, or none: the SPIDR axis the planner split the parent story on, where *interface* means the user interface. It records provenance and selects nothing.

     Today only `kind` exists, and it is not stored: `cardKind()` re-derives it on every read from a label, a SPIDR marker in the title, or keywords (`card_class.ts:93-102`), so renaming a card can change its tools (NEW-kernel-9).
   - **Card** (`CardRecord`, `schema.ts` `CARDS_TABLE_BODY`): the planner's fields ([planner-pm.md](planner-pm.md) §2.1.5), the kind fields above, owner, delegate and accepter (rule 21), dependencies (rule 3) and the order key (rule 15). Three columns of the old `cards` table are not kept as they were: `assigned_tier` (default `'auto'`) is not stored, because the tier is the host's (Project, above); `blocked_reason` is today's free-text encoding of a hold and is replaced by the typed hold of rule 24 (NEW-kernel-3); and the old default `token_budget = 32000` is replaced by no token budget by default, since tokens are bounded by the step budget (40 per sample) and the per-request prompt budget ([worker-loop.md](worker-loop.md) §3, WL-T3-11).
   - **Attempt**: card, attempt number, repair rung (1–4), tool arm (`A`, `B`, `C`), model, status (`running`, `passed`, `failed`, `halted`) — the old status `done_pending_gates` is not an attempt status but a stop reason ([worker-loop.md](worker-loop.md) rules 31, 33), recorded in the attempt's stop reason — stop reason, tokens and seconds used, evidence id, and the fork and resume points it came from (`schema.ts:163-179`); plus `builtBy` (NEW-kernel-6).
   - **Step**: attempt, step index, the calls, the context pack id, the repository state hash, prompt and completion tokens, duration, stop reason and the checkpoint's `git_ref` (`schema.ts:181-196`). The old step fields `success` and `tokens_condensed` are not stored: a step's verdict is its gate results, and condensing savings are [context.md](context.md)'s measure (rule 29 there).
   - **Gate result** (`GateResultRecord`, `schema.ts:198-210`): attempt, card, step, gate name, **layer** — one of `static`, `functional`, `robustness`, `security`, `visual`, `hygiene`, enforced by a `CHECK` ([gates.md](gates.md) rule 3) — status `pass` or `fail`, exit code, the typed failures ([gates.md](gates.md) rule 19), duration in milliseconds, and its source (rule 37).
   - **Context pack** (`ContextPack`, `blobs.ts:52`): card, attempt, step, model, the exact system prompt, prompt, tool names and reasoning setting of one request, stored as a content-addressed blob. Per-zone token counts and the prefix hash are the per-step record of [context.md](context.md) (rule 29), not fields of the pack.
   - **Checkpoint**: a `step/checkpointed` event sets the step's `git_ref` (`records.ts:253`), so `sekhemet replay` and rewind find the commit on the ledger. When checkpoints are committed is [review-git.md](review-git.md)'s (DEC-25 R1).
7. Every event carries typed, indexed association columns — `card_id`, `attempt_id`, `step_id` — beside its payload (`schema.ts:76`, `:90-91`, `:106`), so a card's history is read by index, never by parsing payloads.

### The event log

8. Every change to durable state is an event appended to one SQLite table, `events`, in `.sekhemet/events.db`. Events are immutable; a correction is a new event. The database rejects any `UPDATE` or `DELETE` on `events`. The only deletion the kernel ever performs is of an event's **private part** by a recorded erasure (rule 34); the event row itself is never touched.
9. Each event carries a SHA-256 `payloadHash` over the canonical (key-sorted) JSON of its payload, and a chain `hash` over its identity, its association columns, its payload hash and the previous event's hash. There is **one** chain formula per recorded `hash_version`, defined only in `EventLog.computeHash` (`log.ts`); this spec and every other document link to it rather than restating it. From v3 the formula covers the event's timestamp (`created_at`), the principal, and the salted commitment to the event's private part (rule 33).
10. Verifying the chain names the first corrupt `seq`. Verification is incremental: it starts from the last verified `seq` and re-hashes only newer events.
11. A row written under an earlier formula verifies under that formula; a row with no recorded version is verified by the legacy rule the code keeps for it.
12. The chain head is anchored outside SQLite: every accepted card's merge commit carries `Ledger-Head: <seq>:<hash>` (written by the Accept path, [review-git.md](review-git.md)), and `sekhemet log` cross-checks the newest anchor against the ledger, which exposes a truncated tail. The chain is never rewritten — rewriting would invalidate every anchor already in git.
13. **One validated transaction per event.** A write validates its payload (against the event type's schema — a Valibot schema per event type in one registry, the owner's choice of library, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O7 — and the projection's constraints), then appends the event and applies its projection inside one `BEGIN IMMEDIATE` transaction. If validation or projection fails, nothing is appended. A poison event — one that cannot be projected — can therefore never enter the ledger.
14. The board, attempts, steps, gate results, evidence records, decisions, dossiers and competence rows are projections of the log. `rebuildProjections()` replays the log from `seq` 1 and produces byte-identical projections; `verifyProjections()` compares them without writing. `sekhemet log` prints the chain verdict and the projection verdict, exits 1 on drift, and `sekhemet log --rebuild` rebuilds.
15. Every value a projection needs (ids, order keys, timestamps) is resolved before the event is appended and carried in its payload, so a replay never generates a value. A card's **order key** is a lexicographic fractional index (`order_key.ts`, `keyBetween`): a move between two cards gets a key strictly between theirs without renumbering any other card.
16. Nothing durable lives outside the ledger. A file under `.sekhemet/` is either a content-addressed blob that an event references by hash (context packs, evidence bundles, transcripts) or a cache that is safe to delete. A decision, a candidate rule or a pointer to "the latest" anything that exists only in a file is a defect.
17. **Model-visible means logged.** The exact prompt of every model request is stored as a context pack, by hash, *before* the request is sent, and the step records the pack's id; if the pack cannot be stored the request is not sent (`card_runner.ts:536-552`). Anything a model saw can be reconstructed from the ledger and its blobs, **except content erased by a recorded `ledger/erased` event, which replay names as a gap** (rule 34) — spine rule 2 as the owner amended it ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O1, decided 2026-09-24). Erasure and retention as recorded erasure are built in B3 (NEW-kernel-7 in B3.1; retention in B3.3, [runtime.md](runtime.md)); until they are, nothing is erased or pruned, so the exception has nothing to name.
18. **Readers.** Consumers read the log through the `EventLog` API: `getEvents(fromSeq, limit)` pages by `seq`; `getEventsByCard`, `getEventsByTypes` and `getEventsByCardAndTypes` read by index; `subscribe(filter, callback)` notifies a subscriber of each matching event only after its transaction commits, so a subscriber never acts on an event that was rolled back (`log.ts:201-251`). The dashboard's stream and the HTTP event routes are [runtime.md](runtime.md)'s.
19. Every event names its **actor** from one closed set (`EVENT_ACTORS`, enforced by a `CHECK` and by `append`): *which role or component* wrote it. Separately, a `principal` column names *which person* it acts for — required when the actor is `human`, and on any event a person caused through a machine actor (an MCP client, the dashboard, an auto-accept a person switched on); null for purely machine events. The principal is an **opaque, stable subject id** (`p_…`, random at creation), never an email or a name; the person's name, email and avatar live in a `person/*` record whose personal fields are private (rule 33) and erasable. On a single-user install the harness creates one principal and records the git `user.email` (else the OS user) in that person's private record. The principal is covered by the chain hash and carried through replay. The identity layer resolves it ([integrations.md](integrations.md) owns identity and who may Accept, [DEC-06](../DECISIONS.md#dec-06)). The actor set stays fixed; people are never added to it. Git trailers such as `Accepted-by` keep a display name, as git authorship already does ([review-git.md](review-git.md)).
20. **The card dossier.** Everything the team learns about a card is a typed event on the ledger, one type per kind: `card/lesson`, `card/note`, `card/question` (default actor `worker`), `card/answer` (`manager`), `card/research` (`researcher`), `card/review` (`reviewer`) and `card/send_back` (`human`), each with non-empty text and optional attempt number, `inReplyTo`, sources and verdict (`types.ts:231-275`); and, new, `card/repair_plan` (`planner`): the re-plan rung's plan, whose text is its summary and whose structured body is the plan's contract — target files, the ordered edits, what not to touch and the failures it addresses ([worker-loop.md](worker-loop.md) rule 34.3, NEW-worker-loop-5) — so the dashboard's card view and the Worker's next attempt read the same plan from one place. One reader, `getDossier(cardId)`, returns them oldest first and threads each answer under the question it names, so an answer written for another card can never attach to this one (`card_store.ts:646`, `:719`). In-memory maps, side files and notes that go nowhere are replaced by it. Which role reads the dossier, and when, is [worker-loop.md](worker-loop.md)'s (the runner), [review-git.md](review-git.md)'s (the Reviewer) and [planner-pm.md](planner-pm.md)'s (Seshat).

### Who is on a card

21. A card names three people-or-agents in typed fields, never in a free string: **`owner`** — the principal responsible for it (the board's Assignee filter reads the owner); **`delegate`** — who builds it, `{kind: "worker" | "person", id}` or none; and **`accepter`** — the principal who accepted it, empty until then. A change of delegate appends `card/delegated {from, to}` and a change of owner appends `card/owner_changed`, each naming the principal who made it. The legacy `assignee` string ("worker", "human" or a name, `types.ts:194`) is migrated into these fields and retired (NEW-kernel-6).
22. **Who built each attempt.** Every attempt, and every checkpoint, records `builtBy {kind: "worker" | "person", id}`. A person-built card passes exactly the same entry conditions and gates as a Worker-built one; the only bypass is the recorded `override:` of rule 28. Person-built attempts are excluded from the Worker's pass rate, the competence model and every playbook signal, so the measured record of the Worker never mixes in people's work ([models.md](models.md), [measurement.md](measurement.md)).

### The state machine

23. A card is in exactly one of nine states, stored as `backlog`, `ready`, `planning`, `in_progress`, `verify`, `review`, `done`, `parked`, `rejected`. The stored value, the column heading in the pipeline view, error messages and the documents use the same nine names. **The nine-state machine is the truth.** The board's five familiar columns (Backlog, To do, In progress, In review, Done, plus On hold when non-empty; [NAMING.md](../NAMING.md), [dashboard.md](dashboard.md)) are a read-only projection over these states: no column exists in storage, a move on the board is a transition request in stored states, and no rule in this spec is expressed in board columns.
24. **Held is not a state.** A hold is a typed field on a card that keeps its state; nothing encodes a state in free text. There are two kinds:
    - **Back-pressure** `{kind: "backpressure", awaiting, reason}`: a card whose move was refused by back-pressure keeps its state and waits for the named state; recorded by `card/held`, cleared by `card/released`.
    - **Awaiting merge** `{kind: "awaitingMerge", pr, since}`: a card accepted with pull-request-on-accept on ([review-git.md](review-git.md) §2.5.7, [integrations.md](integrations.md)) stays in `review`, shown as *Accepted · PR #n open*, and is **not counted toward Review's WIP limit**, because a person has already decided it. `card/pr_opened {pr, url, headSha}` sets the hold. `card/pr_closed {pr, merged}` clears it: when `merged` is true the card moves to `done` (the accepting decision is already on the ledger, and the merge is the last condition of the `done` entry); when false the card stays in `review` awaiting a new decision and counts toward WIP again, and `card/pr_closed` is the record that the earlier acceptance did not complete (its `accepter` is cleared in the projection).
25. The legal edges are one table, `LEGAL_TRANSITIONS` (`board_service.ts:32`):

    | From | To |
    | --- | --- |
    | `backlog` | `ready`, `parked`, `rejected` |
    | `ready` | `planning`, `in_progress`, `backlog`, `parked`, `rejected` |
    | `planning` | `ready`, `in_progress`, `backlog`, `parked`, `rejected` |
    | `in_progress` | `verify`, `ready`, `planning`, `parked`, `rejected` |
    | `verify` | `review`, `planning`, `in_progress`, `ready`, `parked`, `rejected` |
    | `review` | `done`, `planning`, `ready`, `in_progress`, `parked`, `rejected` |
    | `done` | `ready` |
    | `parked` | `ready`, `planning`, `backlog`, `rejected` |
    | `rejected` | `backlog`, `ready` |

    The flows the edges carry: **Ready → Planning** when the Planner claims a card to decompose it or to re-plan it; **Planning → In Progress** (or back to Ready) once its criteria, tests and scope satisfy the entry conditions; **In Progress → Verify** when an attempt ends; **Verify → Planning** when the gates ran and failed — the card needs a new plan, and Verify is a transition, not a place cards accumulate (`card_runner.ts:1664-1676`); **In Progress → Planning** on `replan_requested`; a `rebase_conflict` returns to the Worker with typed hunks, or parks the card when a conflict lies outside its scope ([review-git](review-git.md) NEW-review-git-1); **Review → Ready** when a person sends a card back (a returned card is re-queued, not resumed mid-attempt; [DEC-24](../DECISIONS.md#dec-24--deliberate-reversals-in-design-v3), [review-git.md](review-git.md)). Every state has at least one exit a person can reach from the command line: `parked → ready` (`sekhemet unpark`) and `rejected → ready` (`sekhemet reopen`, specified in [review-git.md](review-git.md)). **Unpark** returns a card to the state it was parked from when that was `backlog` or `planning`, and to `ready` otherwise — a card parked from `in_progress`, `verify` or `review` is re-queued, never resumed into the middle of a state, because `parked` has no edge back to those states and gets none. The `card/status_changed` event into `parked` records the state it left, so the target is read from the ledger. A late answer to a `default_deny` decision unparks the same way ([planner-pm.md](planner-pm.md) §2.10.3). Today `unpark` always moves to `ready` (`triage.ts:86-95`).
26. **The transition law is in the kernel.** A status change is a compare-and-set: the caller names the status it expects, and the kernel checks the edge against the **stored** status. A mismatch is refused (`stale_from`), an illegal edge is refused (`illegal_transition`), and a move to the state the card is already in appends nothing. There is no other way to change a card's status: the board, the runner, research cards, external review, decisions, sessions, recurring templates, the PM's slash commands, MCP and the dashboard all go through it.
27. On top of the law, the board adds entry conditions, per-column WIP limits and back-pressure. When the harness runs, entry conditions are always on, and they never depend on who built the card (rule 22):

    | Target | Entry condition |
    | --- | --- |
    | `ready` (from `backlog`) | Acceptance criteria or acceptance tests present |
    | `ready` (from `backlog` or `planning`) | INVEST's *Small*: the card's Zone 3 content fits Zone 3's cap at the resolved Worker's prompt budget — 3,792 tokens on the reference Worker — measured once by the context allocator ([context.md](context.md) rule 10, CX-N2-2; [DEC-27](../DECISIONS.md#dec-27--context-budgets-are-fixed-in-tokens-at-the-reference-window)). It is the only token-count limit on a card; a parent card, which never runs itself, is exempt |
    | `ready`, `planning`, `in_progress` | Every dependency is `done` |
    | `planning` | A difficulty score (1–10) is recorded, or the Planner scores the card on entry; a Planner model is resolvable for the project (NEW-kernel-5) |
    | `in_progress` | A declared scope, unless the card is a parent (a parent never runs itself) |
    | `verify` | The current attempt ended with a recorded stop reason; Review is below its WIP limit (back-pressure) |
    | `review` | The latest evidence bundle ran at least one gate and every blocking gate passed; no **blocking** gate was unavailable (an unavailable advisory gate is stated in the evidence and does not block; [gates.md](gates.md) rule 9) |
    | `done` | An accepting decision ([review-git.md](review-git.md)) and, when the card holds an `awaitingMerge` hold, its pull request merged (rule 24); or, for a parent, the rollup rule below |
    | `parked` | A recorded reason: a stop reason whose table entry parks ([worker-loop.md](worker-loop.md) rule 31), a person's reason, or an open `default_deny` decision request on the card — such a card parks **from the request**, releasing its Worker slot and memory, not at the deadline ([planner-pm.md](planner-pm.md) §2.10.3) (NEW-kernel-5) |

    The red/green rule of the card's `change` — for `feature` and `fix`, acceptance tests staged and failing at an assertion before work — is enforced by the runner at the start of `in_progress` and specified in [gates.md](gates.md) (rule 6b). There is **no separate "plan exists" condition** on `in_progress` (the old design's): the owner decided against it ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)), because the find phase and the staged failing tests already cover it — a card's criteria, acceptance tests and scope are its plan (§8 Q6).
28. **Overrides.** A person may move a card past an illegal edge or a failed entry condition by giving a reason prefixed `override:`. The override is recorded on the ledger as `card/override`, naming the principal and what was overridden. Only an actor `human` with a principal may override; `mcp`, `harness`, `worker`, `planner` and every other actor may not. No override passes a failing security-layer gate into `review` or `done`. The HTTP route and the CLI carry the override; how the dashboard offers it is [dashboard.md](dashboard.md)'s.
29. **Back-pressure.** When Review holds as many cards as its WIP limit, no card may enter `verify`; the runner holds the card instead of failing it. A card with an `awaitingMerge` hold is not counted (rule 24). How the Review limit is computed from human review time is specified in [review-git.md](review-git.md) (S6); Worker-built and person-built cards count alike. **Before the first human review** the limit is review-git's prior — ⌊`reviewMinutesPerDay` ÷ 15 minutes⌋ per project, which is 4 at the default of 60 minutes a day ([surface.md](surface.md) item 23) — not the board's static 3 (`board_service.ts:19`), which the prior replaces (S6).
30. **Rollup.** A parent card reaches `done` only when every child is `done` **and** the project's blocking gates pass on the merged result. The rollup records `card/rollup` with the children and the verdict, moves the parent to `done` along legal edges when it passes, and to `planning` with the failures when it does not. Success is never inferred from children alone. The same holds one level up: the rollup of a project's top-level cards yields `active` or `idle`, never done; a project is `done` only by a `slice/accepted` event for the slice that completes it (rule 6).
31. **A revision never loses what Review saw.** A revised card returns to Review only through the same `review` entry condition, so every revision re-passes every gate. When a gate that passed in the card's latest passing evidence (its Review snapshot) fails on a later attempt, the card returns to `planning` with the regression named — "`test` passed at Review (`ev_…`) and fails now" (`card_runner.ts:1397`, `:1672`). Protection of what `main` already guarantees is the regression gate ([gates.md](gates.md)).
32. **Rewind and fork** (the commands are [runtime.md](runtime.md)'s) record `card/rewound` or `card/fork_requested` with the checkpoint, keep the abandoned state under a ref, and return the card to `ready`. Evidence recorded before a rewind no longer satisfies the `review` entry condition: rewinding past a gate pass invalidates it.

### Privacy and erasure

33. **Each event has a structural part and a private part.** The `payload` holds structural fields only — ids, states, numbers, hashes, enumerations — and is hashed as before. Personal data, free text (Seshat's messages, send-back notes, decision answers, issue bodies, park reasons) and anything the secret scanner may miss go in the event's **`private`** part, stored in a separate table `event_private(event_id, salt, body)`. The chain hash covers `commitment = SHA-256(salt ‖ canonical(private))`, with a fresh 32-byte random salt per event. The payload schema registry (K-S7-4) marks every field `structural`, `personal`, `free_text` or `secret_bearing`, and a write that puts a non-structural field into `payload` is refused. An unsalted hash of a short personal value can be confirmed by guessing, which is why the salt is per event and stored off the chain.
34. **Erasure** (spine rule 2's one exception, decided by the owner — [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O1; rule 17). A person holding the Accept permission may erase the private parts of events — for a data subject, for a leaked secret, or when a retention period ends — by deleting their `event_private` rows with `PRAGMA secure_delete` on and appending, in the same transaction, `ledger/erased {eventIds, blobIds, fields, reason: "erasure" | "secret" | "retention", principal}`; the WAL is then checkpointed (`wal_checkpoint(TRUNCATE)`). The `principal` is always a person: for `erasure` and `secret`, the person who ran the erasure; for `retention`, which a job runs, the person holding the Accept permission who set the retention period that expired ([runtime.md](runtime.md) item 34a) — a retention erasure is that person's standing decision, never a machine's. **The retention period for personal free text on a team server is 90 days after the card closes** ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O14), configurable per project; on a single-user install nothing is erased by retention unless a person sets a period. The erasure reports that old WAL frames and the operating system's own copies are outside its reach. After an erasure the chain still verifies: an event whose private row is gone is reported "erased at seq N by `ledger/erased` seq M", never as corrupt; a private row that was *altered* rather than deleted makes the chain invalid at that event. Projections read an erased field as a fixed marker, and rebuilt projections equal the live ones. A secret found after the fact is handled in three steps — rotate it, erase the private parts, delete the blobs that contain it — with the order and the evidence case in [security.md](security.md) (NEW-security-7). For it the kernel provides `findPrivate(needle)`, which lists the events whose private part contains a string (searching `event_private` only, never logging the needle), and blob deletion: a content-addressed blob (context pack, transcript) is deleted by id and the deletion is recorded in the same `ledger/erased` event (`blobIds`), so a later replay names the gap instead of reporting a missing blob as corruption.
35. **Backups respect erasure.** A backup is a consistent copy made with SQLite's online backup API (`node:sqlite` `backup()`) while writers continue, and records `ledger/backed_up {path, seq}`. That `backup()` exists at the supported Node floor (22.13) is to be verified in B3.1 before K-N7-4 is written against it; if it does not, the floor moves or the copy is made with `VACUUM INTO` (one read transaction, which WAL writers do not block), and the criterion stands either way. An **erasure register** — event ids and reasons only, no personal data, a copy of ledger facts rather than a second source of truth — is kept beside the backups, outside the backup set. Restoring a backup re-applies every erasure in the register newer than the backup's `seq` before anything reads the restored ledger, and a restore refuses to proceed when erasures are known to exist and the register is missing. The kernel provides the mechanism and [runtime.md](runtime.md) the commands (NEW-runtime-8: `sekhemet backup`, `restore`, retention periods per data class, the NDJSON export): `EventLog.backup(path)` (a consistent online copy that records `ledger/backed_up`), the erasure register (appended to by every `ledger/erased`, readable without opening the ledger), and `applyErasures(register, afterSeq)`, which re-applies each listed erasure idempotently and reports what it re-applied.

### Requirements and provenance in the record

36. **Requirements are versioned and their links can go suspect.** A requirement id is stable and never reused, like a card key. `requirement/revised {id, version}` bumps its version. Every card→requirement and test→requirement link records the requirement version it was made against; a revision marks every link made against an earlier version **suspect**, and a suspect link stays suspect until a principal re-confirms it (`trace/confirmed`) or the linked card is superseded. Links are written by the machine as a side effect (the planner writes card→requirement; staging acceptance tests writes test→requirement, with the test id as file plus test name), never by a person filling a matrix. What a revision does to open cards, slices and releases is [planner-pm.md](planner-pm.md)'s.
37. **Gate results name their source.** `GateResultRecord.source` is `local` or `external`; an external result also records `externalRef {system, checkName, runUrl, headSha}`. An external result never satisfies a blocking gate unless the project declares that check blocking ([gates.md](gates.md)), and never counts as evidence for a card whose branch head differs from its `headSha` ([integrations.md](integrations.md)).

### Storage

38. SQLite in WAL mode, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`, one database per repository. Schema changes are numbered, forward-only migrations recorded in `PRAGMA user_version`; a migration never drops a column that holds data, preserves the hash chain, is preceded by a backup (rule 35), and is followed by a chain verification before the harness serves anything. A database newer than the binary is refused. Each card field is declared once, in one column table from which the DDL, the insert and the replay projection are derived (today one column is declared in nine places).

## 3. Contract

| Item | Source |
| --- | --- |
| Card, event, run-record and project types | `packages/kernel/src/types.ts` |
| Actors: `EVENT_ACTORS` (13 today) | `packages/kernel/src/types.ts:325` |
| States: `CardStatus`; stop reasons: `CardStopReason`, `CARD_STOP_REASONS` | `packages/kernel/src/types.ts:13`, `:41`, `:72` (the stop-reason table is owned by [worker-loop.md](worker-loop.md), T3) |
| Chain formula and verification: `EventLog.computeHash`, `verifyHashChain` | `packages/kernel/src/log.ts:84`, `:333` |
| Readers: `getEvents(fromSeq, limit)`, `getEventsByCard`, `getEventsByTypes`, `getEventsByCardAndTypes`, `subscribe(filter, callback)` | `packages/kernel/src/log.ts:201-330` |
| Canonical payload hash | `packages/kernel/src/canonical_json.ts` |
| Payload schema registry (new, K-S7-4): one Valibot schema per event type, each field marked with its data class (rule 33); Valibot (MIT) is approved as a runtime dependency of `kernel` ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O7) | `packages/kernel/src/` (new module) |
| Schema, pragmas and migrations | `packages/kernel/src/schema.ts` |
| Card writes, dependencies, projects, replay, dossier: `CardStore`, `recordDossierEntry`, `getDossier` | `packages/kernel/src/card_store.ts:646`, `:719` |
| Dossier kinds and event types: `DossierEntryKind`, `DOSSIER_EVENT_TYPES`, `DOSSIER_DEFAULT_ACTORS`; new kind `repair_plan` → `card/repair_plan` (actor `planner`, body `{targetFiles, edits, doNotTouch, failuresAddressed}`, NEW-worker-loop-5) | `packages/kernel/src/types.ts:231-275` |
| Card kind fields (new stored columns, NEW-kernel-9): `kind` (`CardKind`, closed: `spike`, `interface`, `implement`, `data`, `rule`, `review`, `research`), `change` (closed: `feature`, `fix`, `characterize`, `refactor`, `upgrade`; behaviour in [gates.md](gates.md) NEW-gates-8), `split` (closed: `spike`, `path`, `interface`, `data`, `rules`, or none); display labels from [NAMING.md](../NAMING.md) ([DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)) | `packages/kernel/src/card_class.ts:34-51` (`CardKind`, `CARD_KINDS`; derived today by `cardKind()`, `:93-102`), `types.ts` `CardRecord` |
| Attempts, steps, gate results, evidence, decisions, competence: `RunLedger`, `RUN_EVENTS` (`attempt/started`, `attempt/finished`, `step/recorded`, `step/checkpointed`, `gate/result`, `evidence/recorded`, `decision/requested`, `decision/answered`, `decision/timed_out`, `competence/recorded`) | `packages/kernel/src/records.ts:29` |
| Context pack `ContextPack`, `serializeContextPack`, `BlobStore` | `packages/kernel/src/blobs.ts` |
| Order keys `keyBetween` | `packages/kernel/src/order_key.ts` |
| Edge table, entry conditions, WIP, back-pressure, hold: `LEGAL_TRANSITIONS`, `BoardServiceImpl` | `packages/board/src/board_service.ts:32`, `:146` |
| Refusal codes: `TransitionRefusedError` (`card_not_found`, `illegal_transition`, `entry_condition`, `security_gate`, `back_pressure`, `wip_limit`; adds `stale_from`, `override_forbidden`) | `packages/board/src/types.ts` |
| Default WIP limits: planning 3, in_progress 5, verify 5, review 3 — the code's static values today. Before the first human review, Review's limit is review-git's prior ⌊`reviewMinutesPerDay` (default 60) ÷ 15⌋ = 4 per project, which replaces the static 3 (rule 29, S6) | `packages/board/src/board_service.ts:13-19` |
| Hierarchy and project cap: `MAX_CARD_DEPTH = 2`, `DEFAULT_ACTIVE_PROJECT_CAP = 3` | `packages/kernel/src/card_store.ts:32`, `:35` |
| Card events: `card/created`, `card/status_changed`, `card/updated`, `card/override`, `card/rollup`, `card/dependency_*`, `card/rewound`, `card/fork_requested`; `card/step` (one per Worker step — id, the step index, stored in a field the code names `turn`, calls, gate, usage — the live Steps view's source, written at `apps/harness/src/execute.ts:541`); new: `card/held`, `card/released` (rule 24's back-pressure hold), `card/pr_opened {pr, url, headSha}`, `card/pr_closed {pr, merged}` (the `awaitingMerge` hold), `card/delegated`, `card/owner_changed`, `card/repair_plan` | `card_store.ts`, `execute.ts` |
| Slice acceptance (new): `slice/accepted {sliceId, principal}` — a person's acceptance of a release slice, the only event that can make a project `done`; owned by [planner-pm.md](planner-pm.md) (P13) | `planner-pm.md` |
| Queue run report (new): `queue/reported {report}`, one per `queue` or overnight round, owned by [runtime.md](runtime.md) item 34b; listed here because the event catalogue is the kernel's | [runtime.md](runtime.md) NEW-runtime-9 (RUN-56) |
| Machine reservation (new): `machine/reserved {principal, until?}` and `machine/released {principal}`, owned by [runtime.md](runtime.md) item 17; the latest decides whether the machine is reserved outside `reserved_hours`; listed here because the event catalogue is the kernel's | [runtime.md](runtime.md) NEW-runtime-5 (RUN-58) |
| Model-combination benchmark result (new): `measure/benchmarked {tier: "quick" \| "overnight", runProfile, roles, …}`, one per quick screen and one per combination of an overnight run, owned by [measurement.md](measurement.md) NEW-measurement-5; listed here because the event catalogue is the kernel's | [measurement.md](measurement.md) MS-N5-8, MS-N5-11 |
| Ledger and record events (new): `ledger/erased`, `ledger/backed_up`, `person/*`, `requirement/revised`, `trace/confirmed`; erasure API (new): `EventLog.backup`, `applyErasures`, `findPrivate`, `BlobStore.delete`; the erasure register file beside the backups | this spec, NEW-kernel-6/7/8; commands in [runtime.md](runtime.md) NEW-runtime-8, the secret procedure in [security.md](security.md) NEW-security-7 |
| New fields (NEW-kernel-6/8): `CardRecord.owner`, `.delegate`, `.accepter`; `AttemptRecord.builtBy`; `GateResultRecord.source`, `.externalRef`; `event_private` table | `types.ts`, `schema.ts` |
| CLI: `sekhemet log [--rebuild]`, `park`, `unpark`, `send-back`, `accept`, `erase` (new) | `apps/harness/src/index.ts:647`, `front_door.ts` |
| HTTP: `POST /api/cards/:id/override` (body `toStatus`, `reason`) | `apps/harness/src/server.ts:979`; the API itself is [runtime.md](runtime.md) |
| MCP: `sekhemet_move_card` (to `ready`, `backlog`, `parked` only) | `apps/harness/src/mcp.ts:156` |

The earlier design's `Card` interface, event interface and SQL listing are retired in favour of the types and `schema.ts` above; where they differed (`filesTouched` vs `scopeFiles`, `column_state` vs `status`, a seven-actor set, a formula without `id`), the code's names stand. Its step-flow event names (`card/start`, `step/start`, `context/assembled`, `model/request`, `model/response`, `tool/call`, `tool/result`, `step/end`, `gate/run`, `card/end`) were never the code's: a step is `card/step` plus `step/recorded` with its context pack, a gate run is `gate/result`, and an attempt's start and end are `attempt/started` and `attempt/finished`. The run's words — an **attempt** holds one **sample** (or up to k under pass@k), a sample is a sequence of **steps**, and "turn" is only the code's synonym for step — are fixed by [DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run) and [NAMING.md](../NAMING.md).

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Append-only log with payload hash and chain; tamper detection naming the seq | built | `log.ts:146`; `log.spec.ts:42`, `:92`, `:121`; `sekhemet log` | — |
| Chain covers the timestamp; `UPDATE`/`DELETE` refused; incremental verification; external anchor | not-built | the hash omits `created_at` (`log.ts:95-105`); no triggers (`schema.ts:100-113`); `verifyHashChain` re-hashes the whole ledger on every SSE frame (`server.ts:471`) | NEW-kernel-1 |
| Replay: `rebuildProjections`, `verifyProjections`, `log --rebuild` | built | `card_store.ts:1299`, `:1331`; `index.ts:647` | — |
| Typed association columns, indexed | built | `schema.ts:76`, `:90-91`, `:106` | — |
| Attempt rung and tool arm; step repository hash; checkpoint `git_ref` | built | `schema.ts:124-125`, `:163-196`; `records.ts:253`; `records.spec.ts` | — |
| Readers and post-commit subscription | built | `log.ts:201-330`; `log.spec.ts` | — |
| Model-visible means logged (prompt stored before the request; refusal if it cannot be) | built | `card_runner.ts:536-552`, `:1002`; `runner_wiring.spec.ts:338` | — |
| Card dossier events and one threaded reader | built | `types.ts:231-275`; `card_store.ts:646`, `:719`; `dossier.spec.ts` | — |
| One validated transaction per event (no poison events) | not-built | append then project outside the transaction (`card_store.ts:399-407`, `500-514`); one bad write makes rebuild throw forever (probe, kernel review §1) | S7 |
| Ledger as the only durable channel | partial | `sendBack` now records `card/send_back` (`triage.ts:57`) but still writes `.sekhemet/playbook_candidates.jsonl` (`triage.ts:63-68`); Review reads `latest-<card>.json` (`execute.ts:1233-1242`) | S7 |
| Principal on events (separate from actor, in the chain), opaque id | not-built | actors are role names only; `answerDecision` takes any string (`records.ts:537`) | NEW-kernel-2 |
| Owner, delegate, accepter; `builtBy` per attempt | not-built | `assignee?: string` "worker, human, or a person's name" (`types.ts:194`); no `builtBy` column (`schema.ts:163-179`) | NEW-kernel-6 |
| Private part, salted commitment, erasure, erasure-aware backup | not-built | the payload hash is unsalted SHA-256 over the whole payload (`log.ts:84-106`); no `event_private`, no backup command | NEW-kernel-1, NEW-kernel-7 |
| Versioned requirements and suspect links | not-built | no `requirement/*` event in the code | NEW-kernel-8 |
| Gate results record their source | not-built | `GateResultRecord` has no source (`types.ts:432-445`) | NEW-kernel-8 |
| Card key (`CHR-12`) | not-built | cards carry only `card_<uuid8>` ids (`card_store.ts:337`) | P3 |
| Board columns as a projection over the nine states | partial | the mapping exists only in the Jira export (`integrations.ts:274-284`) | P3 ([dashboard.md](dashboard.md)) |
| Nine states with one name each | built | `types.ts:13`; `ui/src/vocabulary.ts:93` | — |
| Edge table and override record | built | `board_service.ts:32`, `:192`; `entry_conditions.spec.ts:78` | — |
| Verify → Planning on a gate failure, regression against the Review snapshot named | partial | `card_runner.ts:1397`, `:1664-1676`; no test asserts the named regression | NEW-kernel-5 |
| Transition law checked against the stored status; single path for all writers | not-built | checked against caller's `fromStatus` (`board_service.ts:272`); same-status bypass (`:267-270`); 11 direct `updateCardStatus` callers (`research/cards.ts:84,128-136`, `external_review.ts:141,244,252`, `planner/decisions.ts:123,209,236`, `planner/sessions.ts:160`, `pm/slash.ts:119`, `recurring.ts:175`) | S4 |
| No override from MCP or other non-human actors | not-built | `sekhemet_move_card` passes a caller-supplied reason, so `override:` works over MCP (`mcp.ts:175`) | S4 |
| Entry conditions: criteria, dependencies, scope, passing evidence, accepting actor | built | `board_service.ts:146-179`; `entry_conditions.spec.ts:43`, `:61` | — |
| Entry to Planning (difficulty, Planner) and to Parked (a reason) | not-built | `entryConditionFailure` checks only dependencies for `planning` and nothing for `parked` (`board_service.ts:151-156`) | NEW-kernel-5 |
| Entry to Ready checks INVEST's *Small* as Zone 3's fit | not-built | `ready` checks criteria and dependencies only (`board_service.ts:146-179`); the planner's own bound is 4,096 tokens of "pack" ([planner-pm.md](planner-pm.md) §2.4) | NEW-kernel-5 |
| Entry to Verify requires a recorded stop reason | not-built | no check in `entryConditionFailure` | S4 |
| Security gate never overridden | built | `board_service.ts:282`; `entry_conditions.spec.ts:93` | — |
| Back-pressure at Verify | built | `board_service.ts:314-324`; `runner_backpressure.spec.ts` | — (limit: S6, [review-git.md](review-git.md)) |
| Held as a typed field | partial | a `blockedReason` string prefix (`board_service.ts:347-403`) | NEW-kernel-3 |
| Awaiting-merge hold, excluded from Review's WIP; `card/pr_opened`, `card/pr_closed` | not-built | an accepted card with an open pull request has no record but `card/accepted { pr }`; nothing excludes it from the Review count | NEW-kernel-3 |
| Dependency DAG with cycle refusal; eligibility | built | `card_store.ts:771-851` | — |
| Overlapping scopes serialised | built | `board_service.ts:410`; `entry_conditions.spec.ts:145` | — |
| Hierarchy cap and project cap | built | `card_store.ts:343-356`, `:975` | — |
| Rollup with integration gate | built | `execute.ts:1039`; `control.spec.ts:173` | — |
| Project status: `active`/`idle` from the rollup, `done` only from a person's slice acceptance | not-built | `ProjectStatus` is stored, set only by hand (`types.ts:556`) | NEW-kernel-5 |
| Unpark to the parked-from state when it was Backlog or Planning, else Ready | partial | `unpark` always moves to `ready` (`triage.ts:86-95`) | NEW-kernel-5 |
| `kind`, `change` and `split` stored on the card | not-built | `kind` re-derived on every read by `cardKind()` from labels, a SPIDR title marker or keywords (`card_class.ts:93-102`); no `change` or `split` field (`types.ts:139-202`) | NEW-kernel-9 |
| Repair-plan dossier entry | not-built | `DossierEntryKind` has no repair plan (`types.ts:231-275`); the re-plan's output is held in memory (`ReplanRequest`, `card_runner.ts:217`) | NEW-worker-loop-5 |
| Order key as a fractional index | built | `order_key.ts`; `schema.ts:52`, `:68` | — |
| Exits from Parked and Rejected reachable from the CLI | partial | `unpark` exists; no `reopen` or `reject` verb (kernel review §2) | S4 (verbs delivered with S5) |
| Numbered migrations; one column table; backup and chain check around a migration | not-built | DDL-text sniffing; `rebuildCardsTableIfStale` drops unknown columns (`schema.ts:333-344`, `:444`); the card column list is declared in nine places (`schema.ts:27-63`, `287-317`; `card_store.ts:65-140`, `152-197`, `259-305`, `1087-1189`) | NEW-kernel-4 |
| Rewind and fork recorded; card returns to Ready | built | `execute.ts:895-921`; `control.spec.ts:203` | — |
| Rewind invalidates earlier evidence for Review | not-built | Review reads `latest-<card>.json`, which a rewind does not touch | S7 |

## 5. Changes for v1

### S7 — one validated transaction per event

*Problem:* events are committed before projection, so one bad write breaks replay for good, and two decisions live in files instead of the ledger.

- **K-S7-1** WHEN `createCard` is called with `difficulty: 11` THE SYSTEM SHALL throw, the event count SHALL be unchanged, and `verifyProjections()` SHALL return `identical: true`.
- **K-S7-2** WHEN a status write names a value outside the nine states THE SYSTEM SHALL refuse it before appending, and `rebuildProjections()` SHALL still succeed.
- **K-S7-3** WHEN the projection step throws after validation passed (fault injected) THE SYSTEM SHALL roll back the append, so that after reopening the database neither the event nor the projection change exists.
- **K-S7-4** WHEN an event type has a registered payload schema (a Valibot schema in the one registry, DEC-29 O7) and a payload fails it THE SYSTEM SHALL refuse the write with an error naming the event type and the failing field.
- **K-S7-5** WHEN `POST /api/cards/:id/override` carries a `toStatus` that is not a `CardStatus` THE SYSTEM SHALL respond 400 and append nothing.
- **K-S7-6** WHEN a person sends a card back THE SYSTEM SHALL record the playbook candidate as a ledger event and SHALL NOT write `.sekhemet/playbook_candidates.jsonl`.
- **K-S7-7** WHEN the Review entry condition reads a card's evidence THE SYSTEM SHALL resolve the bundle from the evidence id recorded on the ledger, and deleting `latest-<card>.json` SHALL NOT change the verdict.
- **K-S7-8** WHEN a card that has passing evidence is rewound to an earlier step THE SYSTEM SHALL refuse its move into `review` until evidence recorded after the rewind passes.
- **K-S7-9** WHEN an event type's payload schema marks a field `personal`, `free_text` or `secret_bearing` THE SYSTEM SHALL store that field only in the event's private part, and SHALL refuse a write that places it in `payload`, naming the event type and the field.
- **K-S7-10** WHEN the payload schema registry is walked THE SYSTEM SHALL find a data class (`structural`, `personal`, `free_text`, `secret_bearing`) on every field of every registered event type.

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

*Justification:* the chain does not cover the timestamps that review time and WIP are measured from, verifies by re-hashing everything, cannot see a truncated tail, and — as written before this revision — would have put personal data into an unsalted chain that can never be purged (research: [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 6). v3 is fixed once; a v4 would leave every v3 row unerasable.

- **K-N1-1** WHEN a row's `created_at` is edited directly in SQLite THE SYSTEM SHALL report the chain invalid at that row's `seq`.
- **K-N1-2** WHEN any statement tries to `UPDATE` or `DELETE` a row of `events` THE SYSTEM SHALL abort that statement.
- **K-N1-3** WHEN the chain was verified up to `seq` N and M events are appended THE SYSTEM SHALL verify by hashing exactly M events.
- **K-N1-4** WHEN a ledger holds rows under two formula versions THE SYSTEM SHALL verify each row by its own version and report `valid: true` when none was altered.
- **K-N1-5** WHEN the newest `Ledger-Head` trailer on the integration branch names a `seq` greater than the ledger's last `seq` THE SYSTEM SHALL report the ledger truncated and exit 1 from `sekhemet log`.
- **K-N1-6** WHEN an event with a private part is appended THE SYSTEM SHALL draw a fresh 32-byte random salt, store the salt and the private body in `event_private`, and include `SHA-256(salt ‖ canonical(private))` in the v3 chain hash; two events with identical private bodies SHALL have different commitments.
- **K-N1-7** WHEN an `event_private` row is altered but not deleted THE SYSTEM SHALL report the chain invalid at that event's `seq`.

### NEW-kernel-2 — a `principal` column on events

*Justification:* DoD §6.6 and [DEC-06](../DECISIONS.md#dec-06) (company-server mode) require that every event names its person; today "human" is a role, not a person, and actor and person are conflated. The principal is an opaque id so that erasing a person never requires rewriting the chain or keeping a guessable hash of their email (EDPB Guidelines 02/2025 ¶52, in the research above, decision 5).

- **K-N2-1** WHEN an event with actor `human` is appended without a principal THE SYSTEM SHALL refuse it.
- **K-N2-2** WHEN a decision request is answered, a card is accepted, or an override is recorded THE SYSTEM SHALL record the acting principal on that event.
- **K-N2-3** WHEN a stored event's `principal` is edited directly in SQLite THE SYSTEM SHALL report the chain invalid at that `seq`.
- **K-N2-4** WHEN projections are rebuilt from the ledger THE SYSTEM SHALL reproduce every principal exactly, and `verifyProjections()` SHALL return `identical: true`.
- **K-N2-5** WHEN an MCP client or the dashboard moves a card on a person's behalf THE SYSTEM SHALL record actor `mcp` or `human` as the component that wrote it and the person as the principal.
- **K-N2-6** WHEN a purely machine event (a step, a gate result) is appended THE SYSTEM SHALL store a null principal, and the actor set SHALL be unchanged.
- **K-N2-7** WHEN an event is appended for a principal THE SYSTEM SHALL store an opaque id matching `p_[0-9a-z]+`, and SHALL NOT store an email address or a name in the `principal` column or in any `structural` payload field (a test appends with a git `user.email` configured and searches every structural column for it).

### P3 — the card key (the kernel's share of the professional board, [dashboard.md](dashboard.md))

- **K-P3-1** WHEN a card is created in a project with prefix `CHR` THE SYSTEM SHALL assign the key `CHR-<n>`, where n is one more than the highest number ever assigned in that project, carried in the `card/created` payload.
- **K-P3-2** WHEN a card is rejected or deleted from view and a new card is created THE SYSTEM SHALL NOT reuse the old card's key.
- **K-P3-3** WHEN projections are rebuilt THE SYSTEM SHALL reproduce every key exactly, and the CLI SHALL accept a key wherever it accepts a card id.

### NEW-kernel-3 — held as a typed field, including awaiting merge

*Justification:* "held" is a hidden tenth state parsed out of free text; and a card accepted with a pull request still open has no state at all — left in `review` it blocks back-pressure although a person has already decided it, and it has no legal edge but `done` (review M10).

- **K-N3-1** WHEN back-pressure refuses the runner's move into `verify` THE SYSTEM SHALL append `card/held` naming the awaited status and the reason, and the board state SHALL list the card as held without reading `blockedReason`.
- **K-N3-2** WHEN a held card's awaited move succeeds THE SYSTEM SHALL append `card/released` and clear the hold; while the move is still refused it SHALL keep the hold and append nothing.
- **K-N3-3** WHEN a card is accepted with pull-request-on-accept on and its pull request opens THE SYSTEM SHALL append `card/pr_opened {pr, url, headSha}`, keep the card in `review` with an `awaitingMerge` hold, and SHALL NOT count it toward Review's WIP limit (a test fills Review to its limit with awaiting-merge cards and a further card still enters `verify`).
- **K-N3-4** WHEN `card/pr_closed` records the pull request merged THE SYSTEM SHALL move the card to `done`; WHEN it records it closed without merging THE SYSTEM SHALL clear the hold and the `accepter`, keep the card in `review`, and count it toward the WIP limit again.
- **K-N3-5** WHEN a card holds an `awaitingMerge` hold THE SYSTEM SHALL refuse its move into `done` by any path other than `card/pr_closed {merged: true}`, and projections rebuilt from the ledger SHALL reproduce every hold exactly.

### NEW-kernel-4 — numbered migrations and one column table

*Justification:* migrations sniff DDL text, one silently drops unknown columns, and one column declared in nine places is the likeliest source of replay drift. An upgrade must never strand a user's ledger ([DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md), "upgrades migrate data").

- **K-N4-1** WHEN a database at `user_version` N below the current version is opened THE SYSTEM SHALL apply migrations N+1 to current, each in its own transaction, and set `user_version`.
- **K-N4-2** WHEN a database's `user_version` is above the current version THE SYSTEM SHALL refuse to open it with a message naming both versions.
- **K-N4-3** WHEN a migration would remove a column that holds a non-null value THE SYSTEM SHALL abort the migration and leave the database unchanged.
- **K-N4-4** WHEN a column is added to the card column table THE SYSTEM SHALL include it in the `cards` DDL, the insert and the replay projection without any other edit (a test adds a column to a fixture table and checks all three).
- **K-N4-5** WHEN a migration is about to run THE SYSTEM SHALL first write a backup of the database (rule 35) and name its path; WHEN the migrations have run THE SYSTEM SHALL verify the hash chain and refuse to serve if it is invalid.

### NEW-kernel-5 — the lifecycle's missing conditions

*Justification:* the old design's entry conditions for Planning and Parked, the project rollup and the named-regression return were carried only in code comments or not at all (traces hd1 199, 204, 207, 209; inventory G23). The review found three more: unpark aimed at "its previous state", which has no legal edge from `parked` (M7); `default_deny` parking at the deadline in one document and at the request in another (M8, settled for the request); and a project reading "complete" from its cards while its must-haves were unplanned (M12). The confirmation review found the `ready` row missing INVEST's size check, which DEC-27 makes the one card-size number (N5, K-N5-7); the owner decided there is no "plan exists" condition (DEC-29, K-N5-8).

- **K-N5-1** WHEN a card without a recorded difficulty score is moved into `planning` and no Planner model is resolvable for the project THE SYSTEM SHALL refuse with `entry_condition` naming the missing Planner; WHEN a Planner is resolvable, the card SHALL be scored (1–10) as part of the move.
- **K-N5-2** WHEN a card is moved into `parked` without a stop reason whose table entry parks, a person's reason or an open `default_deny` decision request on the card THE SYSTEM SHALL refuse with `entry_condition`; WHEN a `default_deny` decision request is recorded for a card THE SYSTEM SHALL park the card from the request, not at its deadline.
- **K-N5-3** WHEN no top-level card of a project is open THE SYSTEM SHALL derive the project's status as `idle`, and WHEN one is open, as `active`; WHEN every top-level card is `done` and no `slice/accepted` event completes the project THE SYSTEM SHALL still report `idle`, never done; a person's `paused` or `archived` SHALL take precedence over both.
- **K-N5-4** WHEN an attempt's gates fail on a card whose latest passing evidence recorded those gates as passing THE SYSTEM SHALL move the card to `planning` with a reason naming each regressed gate and the evidence id it passed in.
- **K-N5-5** WHEN a `slice/accepted` event records a person's acceptance of the slice [planner-pm.md](planner-pm.md) computed as completing the project THE SYSTEM SHALL set the project's status to `done`, and SHALL refuse a `done` status from any other event or actor; WHEN a top-level card is opened afterwards, the rollup SHALL report `active` again.
- **K-N5-6** WHEN `sekhemet unpark` moves a card THE SYSTEM SHALL move it to the state recorded as its parked-from state when that was `backlog` or `planning`, and to `ready` otherwise; a card parked from `in_progress`, `verify` or `review` SHALL arrive in `ready`, and `LEGAL_TRANSITIONS` SHALL gain no edge from `parked`.
- **K-N5-7** WHEN a card is moved into `ready` from `backlog` or `planning` THE SYSTEM SHALL ask the context allocator to measure the card's Zone 3 content at the resolved Worker's prompt budget, and SHALL refuse the move with `entry_condition` naming the zone's size and its cap (3,792 tokens on the reference Worker) when it does not fit; a parent card SHALL be exempt, and no other token-count limit SHALL apply at any entry condition.
- **K-N5-8** WHEN a card moves from `ready` or `planning` into `in_progress` THE SYSTEM SHALL NOT require a recorded plan, sketch or plan event (a test moves a card with criteria, staged failing tests and a scope, and no plan, into `in_progress`).

### NEW-kernel-6 — who is on a card, and who built each attempt

*Justification:* `assignee` is a free string mixing "worker", "human" and names; nothing records whether the Worker or a person built an attempt. Both are cheap now and a migration of every row and export format later ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decisions 1–2; Linear's assignee/delegate split).

- **K-N6-1** WHEN a card is created THE SYSTEM SHALL record an `owner` principal id and a `delegate` of kind `worker`, `person` or none, and SHALL refuse a `delegate.kind` outside that set.
- **K-N6-2** WHEN a card's delegate or owner changes THE SYSTEM SHALL append `card/delegated {from, to}` or `card/owner_changed {from, to}` naming the principal who made the change.
- **K-N6-3** WHEN a card is accepted THE SYSTEM SHALL set its `accepter` to the accepting principal, and projections rebuilt from the ledger SHALL reproduce owner, delegate and accepter exactly.
- **K-N6-4** WHEN an attempt or a checkpoint is recorded THE SYSTEM SHALL record `builtBy {kind, id}`; WHEN `builtBy.kind` is `person` THE SYSTEM SHALL exclude that attempt from `CompetenceEntry` rows and from pass rate by model.
- **K-N6-5** WHEN a person-built card requests entry to `review` THE SYSTEM SHALL apply the same entry conditions as for a Worker-built card, and a failing blocking gate SHALL refuse the move without an `override:` reason.
- **K-N6-6** WHEN a database holding cards with the legacy `assignee` string is migrated THE SYSTEM SHALL map `worker` to `delegate: {kind: "worker"}`, a person's name to that person's principal as owner, and `human` to the project's single principal, and the `assignee` column SHALL no longer be written.

### NEW-kernel-7 — an erasable ledger

*Justification:* a scanner false negative or a person's name in a Seshat message is otherwise permanent, and restoring a backup would silently bring erased data back. The design follows the regulator's own recommended pattern (EDPB 02/2025 ¶52–53: salted commitment on the chain, data and salt off it) and event-sourcing's *forgettable payloads* ([research](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decisions 6, 9). No compliance claim is made (SPINE): the product offers the mechanism; the deploying team decides the basis.

- **K-N7-1** WHEN a person holding the Accept permission erases events for a subject or a secret THE SYSTEM SHALL delete their `event_private` rows with `secure_delete` on, append `ledger/erased {eventIds, blobIds, fields, reason, principal}` in the same transaction, append the event ids and reason to the erasure register, and checkpoint the WAL; a principal without the Accept permission SHALL be refused.
- **K-N7-2** WHEN the chain is verified after an erasure THE SYSTEM SHALL report `valid: true`, and SHALL list each erased event as "erased at seq N by `ledger/erased` seq M" rather than as corrupt.
- **K-N7-3** WHEN projections are rebuilt after an erasure THE SYSTEM SHALL produce projections identical to those maintained live, with each erased field shown as the erased marker.
- **K-N7-4** WHEN a backup is taken THE SYSTEM SHALL write a consistent copy while a writer is appending (the online backup API, or rule 35's fallback), the copy SHALL verify, and `ledger/backed_up {path, seq}` SHALL be appended.
- **K-N7-5** WHEN a backup taken at `seq` S is restored and the erasure register lists erasures after S THE SYSTEM SHALL re-apply them before any read of the restored ledger; WHEN erasures are known to exist and the register is missing, the restore SHALL refuse and say why.
- **K-N7-6** WHEN a model request is replayed and its context pack references erased content THE SYSTEM SHALL name the gap and the `ledger/erased` seq, never substitute or omit silently.
- **K-N7-7** WHEN `findPrivate(needle)` is called THE SYSTEM SHALL return exactly the events whose private part contains the needle, and SHALL NOT write the needle to the ledger, a log or a blob.
- **K-N7-8** WHEN an erasure names blob ids THE SYSTEM SHALL delete those blobs, list them in the `ledger/erased` event, and `verifyProjections()` and replay SHALL report them as erased, not missing.
- **K-N7-9** WHEN `applyErasures(register, afterSeq)` is run twice on the same restored ledger THE SYSTEM SHALL leave it identical after the second run (idempotent) and report the erasures it re-applied the first time.

### NEW-kernel-8 — requirement versions and gate-result sources in the record

*Justification:* without a version on every link, impact analysis after a requirement changes is impossible for every link written before the fix; without a source on every gate result, the day external CI results arrive they are indistinguishable from local runs ([research](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decisions 11–12; Doorstop's suspect links).

- **K-N8-1** WHEN a requirement is revised THE SYSTEM SHALL append `requirement/revised {id, version}` and SHALL mark every card→requirement and test→requirement link made against an earlier version as suspect.
- **K-N8-2** WHEN a link is suspect THE SYSTEM SHALL keep it suspect until a principal re-confirms it (`trace/confirmed`) or the linked card is superseded; WHEN a requirement is created, its id SHALL never equal an id used before in the project.
- **K-N8-3** WHEN a gate result is recorded THE SYSTEM SHALL store `source: "local"` or `source: "external"`, and an external result SHALL carry `externalRef {system, checkName, runUrl, headSha}`; a result without a source SHALL be refused.
- **K-N8-4** WHEN the `review` entry condition reads evidence containing an external result for a check the project has not declared blocking THE SYSTEM SHALL treat it as advisory, and WHEN its `headSha` differs from the card branch head THE SYSTEM SHALL NOT count it at all.

### NEW-kernel-9 — the card's kind, change and split, stored

*Justification:* the kind selects the Worker's tools, the red-first rule and rule scoping, yet it is re-derived from the title on every read, so renaming a card can change its tools; and three vocabularies for "card kind" (SPIDR letters, display labels, change kinds) had no single stored home (review B3; [DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)).

- **K-N9-1** WHEN a card is created THE SYSTEM SHALL store its `kind` from the closed set of seven in the `card/created` payload and refuse any other value; WHEN the caller gives none, it SHALL derive the kind once, at creation, with `cardKind()`, and store it, so that replay never re-derives it.
- **K-N9-2** WHEN a card's title or labels change after creation THE SYSTEM SHALL NOT change its stored `kind`; WHEN a principal changes `kind` or `change` THE SYSTEM SHALL record it as `card/updated` naming the principal, and SHALL refuse the change while the card is `in_progress` or `verify`.
- **K-N9-3** WHEN a card is created THE SYSTEM SHALL store `change` as one of `feature`, `fix`, `characterize`, `refactor`, `upgrade` (default `feature`; [gates.md](gates.md) GT-N8-1 owns when a value is required), and `split` as one of `spike`, `path`, `interface`, `data`, `rules` or none, refusing any other value of either.
- **K-N9-4** WHEN the tool set, the red-first rule, rule scoping or the card class is computed THE SYSTEM SHALL read the stored `kind`, and SHALL NOT read `split` (a search test finds no reader of `split` outside display and export).
- **K-N9-5** WHEN projections are rebuilt THE SYSTEM SHALL reproduce `kind`, `change` and `split` exactly; WHEN a database without these columns is migrated THE SYSTEM SHALL store for each card the kind `cardKind()` derives at migration time, `change: "feature"` and `split` from the title's SPIDR marker where there is one.

## 6. v1 acceptance

This spec is `built` when every criterion in §5 passes and these behaviours, already built, stay under test:

- **K-1** WHEN one payload byte or one stored hash is flipped on disk THE SYSTEM SHALL report the chain invalid at that `seq` (`log.spec.ts:92`, `:121`).
- **K-2** WHEN projections are rebuilt from the ledger THE SYSTEM SHALL produce byte-identical projections, and `sekhemet log` SHALL exit 1 when they differ.
- **K-3** WHEN a card is created three levels below a card, or a dependency would close a cycle, or a fourth project is activated THE SYSTEM SHALL refuse with `hierarchy_depth`, `dependency_cycle` or `project_cap` respectively, before appending.
- **K-4** WHEN any entry condition in §2 rule 27 fails THE SYSTEM SHALL refuse the move with `entry_condition` and a message naming the missing item.
- **K-5** WHEN a card's latest evidence fails a security-layer gate THE SYSTEM SHALL refuse a move into `review` or `done` even with an `override:` reason.
- **K-6** WHEN Review is at its WIP limit THE SYSTEM SHALL refuse entry to `verify` with `back_pressure`, and the runner SHALL hold the card rather than fail it.
- **K-7** WHEN the last child of a parent is accepted and the integration gates pass THE SYSTEM SHALL move the parent to `done` and record `card/rollup`; WHEN they fail, to `planning` with the failures.
- **K-8** WHEN a card is moved into the scope of a running card THE SYSTEM SHALL report the overlapping files and SHALL NOT run both.
- **K-9** WHEN a model request's context pack cannot be stored THE SYSTEM SHALL NOT send the request (`runner_wiring.spec.ts:338` covers the stored case; the refusal case is added).
- **K-10** WHEN a Worker question and Seshat's answer to another card's question are both recorded THE SYSTEM SHALL thread each answer only under the question it names (`dossier.spec.ts`).
- **K-11** WHEN a subscriber is registered and a write is rolled back THE SYSTEM SHALL NOT notify the subscriber of that event.

## 7. Later

- **An external timestamping or signing service for the chain.** The git anchor (rule 12) closes truncation for a single repository; notarisation matters only for compliance use, which is not v1.
- **Crypto-shredding of backups and exports** (per-subject keys). Deleting private rows plus a declared backup window covers v1; per-subject keys add a key-management system the product does not otherwise need, and ciphertext is still personal data in the regulator's reading. Reopen if a team needs exports revocable after they leave the machine.
- **Splitting `card_store.ts`** (1,351 lines, six concerns) into `CardRepository`, `DependencyGraph`, `DossierStore`, `ProjectStore` and `Projector`. It is done strangler-style inside the S7 workstream, since S7 touches every write, and is accepted by K-S7-1…10 plus K-N4-4; it is listed here only because it is not a behaviour.
- **Retention of context packs and transcripts** (`retention.ts`, 30 days after close, evidence kept forever) and retention of private fields per data class are runtime jobs; see [runtime.md](runtime.md).

## 8. Open questions

1. *Closed.* **The state names in [NAMING.md](../NAMING.md).** NAMING now keeps the nine stored names for the pipeline view and the board's sentence-case columns, and retires *Working, Checking, Closed* (rule 23).
2. **`worker` and `executor` are both actors.** *Recommendation:* new writes use `worker`; `executor` stays valid for existing rows only (a `CHECK` cannot drop it without rewriting history).
3. **`harness` as an accepting actor** (`ACCEPTING_ACTORS`, `board_service.ts:110`) lets `queue --auto-accept` and rollup reach `done`. *Recommendation:* keep it only for rollup and for an auto-accept switch that a named person turned on, recorded as that person's standing decision; [review-git.md](review-git.md) owns the rule.
4. *Decided.* **Validation library.** The payload registry in K-S7-4 uses **Valibot**, approved by the owner ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O7); Zod and a hand-written validator per event type are not used.
5. *Decided.* **The spine's wording on reconstruction** ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O1). SPINE rule 2 now reads "… except content erased by a recorded `ledger/erased` event (personal data, a leaked secret, retention), which replay names as a gap". Erasure (NEW-kernel-7) proceeds in B3.1 and retention as recorded erasure in B3.3; rules 17 and 34 are written to it.
6. *Decided.* **A "plan exists" condition on `in_progress`.** The old design required one; the code lets a card go from Ready straight to In Progress. The owner decided **no** ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)): the find phase and the red tests cover it; a card's criteria, acceptance tests and scope are its plan, and where [planner-pm.md](planner-pm.md) requires an edit sketch (difficulty 4–7) it reaches the Worker as guidance, not as an entry condition (rule 27, K-N5-8).
7. *Decided.* **Retention default for private fields** ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O14): on a team server, the free text in closed cards' private parts is kept **90 days** after the card closes and then erased by `ledger/erased {reason: "retention"}`, whose principal is the person who set the period (rule 34). The period is configurable per project ([runtime.md](runtime.md) item 34a).

## 9. Evidence and rationale

- Review: [domain02_09_kernel_review.md](../../reference/reviews/domain02_09_kernel_review.md) (probes for poison events, the `fromStatus` bypass, the `created_at` edit and tail truncation).
- Research: [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) — decisions 1–2 (owner/delegate/accepter, `builtBy`; Linear, Jira and GitHub Copilot's models), 5–9 (opaque principal, salted commitment, data classes, spine wording, erasure-aware backup; EDPB Guidelines 02/2025 v2.0 ¶50–53, ¶102–104; ICO on backups; Verraes's forgettable payloads; SQLite `secure_delete`; `node:sqlite` `backup()`), 11–12 (versioned requirements, gate-result source). [DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md) (forward-only migrations with a backup and a chain check).
- Integration review: the card dossier (suggestion 6, target architecture) is built as rule 20; its readers are owned by the specs that read it.
- Programme: [COVERAGE.md](../../reference/COVERAGE.md) S4, S7; DoD §6.2 and §6.6.
- *Changed on purpose:* the actor set is the code's thirteen with a separate principal, not the old seven ([DEC-06](../DECISIONS.md#dec-06)); send-back returns a card to Ready, not In Progress ([DEC-24](../DECISIONS.md#dec-24--deliberate-reversals-in-design-v3)): a returned card is re-queued, not resumed mid-attempt.
- Owner decisions ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)): O1 (spine rule 2 amended for erasure: rules 17, 34), O7 (Valibot for the payload registry: rule 13, K-S7-4), O14 (90-day retention: rule 34), no "plan exists" condition (rule 27, K-N5-8).
- Confirmation review ([design_v3_confirmation.md](../../reference/reviews/design_v3_confirmation.md)): N5 (INVEST's *Small* is the `ready` row's Zone 3 fit, K-N5-7), n24 (K-N5 in order).
- Independent review of design v3 ([design_v3_review.md](../../reference/reviews/design_v3_review.md)): B3 and B4 ([DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run): `kind`, `change`, `split`; attempt ⊃ sample ⊃ step), B7 (erasure waited on O1, since decided), M7 (unpark), M8 (`default_deny` parks from the request), M10 (awaiting merge), M12 (project done only from `slice/accepted`), M21 (only blocking gates), m3, m4, m12. Trace row PMFE:432 ([DESIGN_TRACE.md](../../reference/DESIGN_TRACE.md)): the repair plan as a dossier entry.
- *Rejected:* XState for the state machine — the edge table is ten lines and correct; the defect was trusting the caller (kernel review, Proposals). Rewriting the chain to erase (git filter-repo style) — it changes every later hash and invalidates every `Ledger-Head` anchor already in git.
