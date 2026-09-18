# Sekhemet dashboard: frontend design

Status: proposal for the lead engineer · Date: 2026-09-18
Mockups: `docs/design/mockups/{board,review,card,runs}.html`. Open them straight from disk. They have no dependencies, and pressing `t` switches between Basalt and Sand.

This document has three parts: **(1)** a gap table that compares the design doc with what ships today, **(2)** the product design, and **(3)** a phased implementation plan sized to the repo's rule of fewer than 200 LOC across 1–3 files per card.

Sources read: *Design v2* §§ Name and brand, Data model, Card lifecycle, Stop reasons, Retry ladder, SPIDR, Decision request, Live monitoring, Evidence bundle, Memory watchdog, User interface (L1838–1899), Frontend design system (L1901–1984), REST API (L2306–2329), `@sekhemet/ui` (L2537); `FEATURE_INVENTORY.md` U1–U21 and H1–H20; `apps/harness/src/{ui_html,server,execute,doctor,config,index}.ts`; `packages/ui/src/{tokens,canvas,types}.ts`; `packages/kernel/src/types.ts`; `packages/gates/src/{evidence,types}.ts`; `packages/loop/src/{types,card_runner}.ts`; `packages/planner/src/types.ts`; `packages/models/src/memory.ts`. I also pulled every `/api/*` payload from the running server at `127.0.0.1:4040`, which serves the Chronicle sample repo.

---

## Part 1: Gap table

### 1.1 What is on screen today

The page is one 610-line template literal (`ui_html.ts`). Top to bottom it contains:

1. A 48px header holding six outlined chips: chain, `Pass@1 3/6 · 22.2 min`, model, memory, stream, and theme and search buttons.
2. A 7-column board with a gold uppercase `STORY` label on every tile.
3. A 5-box gate strip labelled `P T U L B`.
4. A `stepsUsed/stepBudget` bar.
5. An **event-log table that takes 38% of the viewport** and shows raw hashes.
6. A right-hand evidence drawer.
7. A command palette with two commands.

At 1440px the Review column is pushed partly off-screen, even though it is the one column the human exists for.

Seven problems follow from the data and the code:

- **The triage endpoints exist, but the UI has no triage.** `/api/cards/:id/{accept,return,park}` ship with CSRF protection, and no button or key in the page calls them. A human cannot accept a card from the dashboard.
- **Parked and rejected cards are invisible.** Neither `parked` nor `rejected` is in `COLUMNS` (`ui_html.ts:262`). A card that hits `memory_pressure` or is parked disappears from the board, which breaks "nothing blocks silently" (§1897).
- The column order in `packages/ui/src/canvas.ts:4` (`COLUMN_ORDER`) omits `planning`, so it disagrees with the page.
- **Model-authored labels leak into the UI verbatim.** Every card is `tier: "story"`, and every title ends in `(SPIDR: …)`. Stop reasons render as `oscillation detected`.
- **The gate strip misreports.** It always draws five boxes, P T U L B. `lint` never appears in evidence for the sample (the `lint` gate is not in its rung results), so the L box stays grey forever. `parse: pass` is synthesised whenever any rung ran. `bounds` is computed in the server by a heuristic that also counts the staged acceptance-test lines (hasher: 76 lines, of which 65 are the protected test file).
- **The evidence diff mixes worker output with staged, protected acceptance tests.** `tests/hasher.spec.ts`, 65 lines, is shown as if the worker wrote it. The typed failure's `suggestedFixFiles` points at that protected test file even though the actual fix is in `src/hasher.ts`.
- `gatesConfigSha256` in both sample bundles is `e3b0c442…`, the SHA-256 of the **empty string**. The review panel prints it as proof of the gate contract. That needs a backend fix; the UI must also flag it, as shown in the mockup.
- Text contrast: `--text-muted` measures **2.6–3.3:1** on every surface, yet it is used for card ids, budget text, counts and log cells, all of which are informational. `--state-fail` on `--bg-raised` measures **3.92:1** in Basalt and Sand state colours on raised measure 4.1–4.3:1, so state-coloured *text* on tiles fails AA. `--border-strong` measures **1.26–1.85:1**, which is too weak to serve as the focus ring the doc assigns to it. §4.9 gives the rules that fix this.

### 1.2 Feature-by-feature

Legend: **BUILT** means shipped and matches the doc. **SHALLOW** means present but incomplete, with the gap stated. **MISSING** means absent. For each item, *Data* says whether the backend already provides what the UI needs.

| # | Design requirement (doc §) | Status | What's missing | Data / endpoint |
|---|---|---|---|---|
| **Views** |
| V1 | Master board: multi-project rollup, hardware load, cards blocked on you with wait time (§1846) | MISSING | The whole view is missing. | No workspace or multi-project model in the server. Later phase. |
| V2 | Project board: columns Backlog→Review, WIP counters, DAG lines, budget bars (§1847) | SHALLOW | Parked and rejected are hidden. WIP limits appear only as `n/limit` text. No dependency lines or badges. The budget is steps only (no tokens or seconds). The tile's content is wrong (tier label, jargon titles). The log drawer takes 38% of the height. | `/api/board` has cards, `wipLimits` and `backpressureActive`. `dependsOn` is empty in all sample data. |
| V3 | Card view with 5 tabs: Evidence (default), Plan, Live Steps, Thread, Files (§1848) | MISSING | Only an evidence drawer exists. No Plan, Steps, Thread or Files tab, and no route. | Evidence: `/api/evidence/:card` (latest only). Steps: `.sekhemet/transcripts/<card>-<ts>.jsonl` exists on disk but is **not served**. Thread: derivable from `/api/events`, which cannot be filtered by card. Files: no endpoint. |
| V4 | Review view, the primary surface (§1849, §1853) | MISSING | No queue, gate strip, grouped diff, triage keys or return-reason capture. | Triage POSTs exist. Evidence exists. The return reason is written to `playbook_candidates.jsonl`. |
| V5 | Machine panel: VRAM, active tier, loaded models, throughput sparklines, cache hit rate (§1850) | SHALLOW | Two chips (memory, model) are parsed out of doctor prose with `split("(")`. | `/api/doctor` returns prose `detail` strings. `packages/models/src/memory.ts` has structured `MemoryPressureStatus` but nothing serves it. No throughput or cache data. |
| V6 | Registry view: models, qualification, bake-off matrix (§1851) | MISSING | The whole view is missing. | `bake-off` writes nothing the server reads. Later phase. |
| V7 | Decision inbox sorted by wait time (§1974, §1897) | MISSING | The whole view is missing. | `DecisionRequest` is typed in `planner/types.ts`, but requests are **never persisted or served**. |
| V8 | Goal view: burn-up, criteria, risk register (§915) | MISSING | The whole view is missing. | No goal records. Later phase. |
| V9 | Runs / scorecard (not a doc view, but implied by Pass@k evidence) | SHALLOW | One chip, `Pass@1 3/6 · 22.2 min`. | `/api/queue` serves the latest `queue_report.json` only. Each run **overwrites** it, so there is no history. |
| V10 | Ledger / event log | SHALLOW | Raw table (seq, type, actor, hash, prev, time) with no sentences, no filter and no link to the card. | `/api/events` returns the first 200 events only: no `?since=`, no `?card=`, and no paging past 200. |
| V11 | Playbook (learned rules, candidates from returns) (§1111, §820) | MISSING | The whole view is missing. | `.sekhemet/playbook.toml` and `playbook_candidates.jsonl` exist on disk and are not served. |
| V12 | Mobile: read-only board plus one-tap Accept/Return/Park (§1899) | MISSING | No breakpoints. The board scrolls horizontally with 186px-minimum columns. | Triage endpoints exist. |
| **Components** |
| C1 | Board column: name, WIP `3/4`, progress indicator, virtualized, h/j/k/l (§1968) | SHALLOW | The count and a 2px bar are present. There is no h/j/k/l. The header is ALL CAPS. The empty state is the generic "No cards". Nothing explains what a column means or why it is full. | `wipLimits`. The Review limit reason (`reviewMinutesPerDay`) is in config but not served. |
| C2 | Card tile: title, class chip, difficulty, token/second budget bars, 5-box gate strip, dependency badge (§1969) | SHALLOW | The tier label replaces the class chip. No difficulty. Budget covers steps only. Dependency count shows as `1d`. No running indicator, no wait time, no stop reason, no blocked state. | `difficulty`, `tokenBudget` and `secondsBudget` exist on `CardRecord` but are **unset** in sample data. The slice kind exists only inside the title string. Wait time can be derived from `card/status_changed` events but is not computed. |
| C3 | Gate strip: gates in execution order, hover shows the typed error, click goes to the log (§1971, §1855) | SHALLOW | Fixed P T U L B labels regardless of `gates.toml`. The hover is only a native title. There is no click target. | Rung results plus typed `failures[]` with `location`, `expected`, `actual`, `minimalRepro` and `suggestedAction`, which is rich. `gates.toml` (ids, order, blocking, protected globs, limits) is not served. |
| C4 | Diff viewer: split/unified, structural (difftastic), inline failure annotations (§1972) | SHALLOW | Unified colouring only, truncated at 400 lines. No file headers, line numbers, grouping or annotations. Staged tests are mixed in. | `diff` string, `failures[].location.{file,line}`, `scopeFiles`, `acceptanceTests`. No `structuralDiff`. |
| C5 | Evidence panel: diff, gate results, typed failures, test output, screenshots, stop reason, abandoned hypotheses (§963) | SHALLOW | Six metric boxes, a gate list, failures and the diff are present. The acceptance criteria that Review should be judged against are missing. The raw stop-reason enum is shown. There are no abandoned hypotheses and no attempt history. | `acceptanceCriteria` is on the card. There is no attempts index: `ev_*.json` files exist but are not listed per card. |
| C6 | Triage: `A` accept+squash, `R` return with reason, `P` park; returns feed the playbook (§1858) | MISSING (UI) | No UI. | Endpoints are BUILT and CSRF-guarded. |
| C7 | Decision request: radio options, consequences, effort delta, recommendation, countdown (§1973) | MISSING | The whole component is missing. | Type exists; not persisted (see V7). |
| C8 | Command palette: fuzzy cards, projects, commands, settings (§1976) | SHALLOW | Substring match, two commands, no groups, no shortcuts shown, no card actions. | Board data. |
| C9 | Keyboard map: 16 bindings (§1872) | SHALLOW | Only `⌘K` and `Esc` work. `?`, `g`-chords, `j/k/h/l`, `Space`, `Enter`, `c`, `x`, `a/r/p` are all absent. | None needed. |
| C10 | Cheat sheet (`?`) | MISSING | The whole component is missing. | None needed. |
| C11 | Live streaming: WS `/stream?card=`; replay from genesis (§1868) | SHALLOW | SSE (`/api/stream`) pushes the whole board plus events every second. Not per card. No step-level events: only `card/updated {stepsUsed}` and status changes. | Step detail is written only to the transcript file at the **end** of a card, so live steps have no source. |
| C12 | Toasts / notifications | MISSING | The whole component is missing. | None needed. |
| C13 | Iconography: single-weight 1.5px line set (§1978) | SHALLOW | Four ad-hoc inline SVGs plus `✓ ✗ –` glyphs. | None needed. |
| C14 | Virtualized board, 500+ cards, overscan 3 (§1861) | BUILT (vertical) | Windowing per column works (`paintColumn`). There is no horizontal windowing, and the whole board is re-rendered on every SSE frame. `VirtualCanvasManager` in `packages/ui` is unused by the page. | None needed. |
| **States** |
| S1 | Loading | SHALLOW | Only the evidence drawer shows "Loading evidence…". The board is blank until hydrate completes. | None needed. |
| S2 | Empty (per column, per view, first run) | SHALLOW | Generic "No cards". | None needed. |
| S3 | Error / offline / reconnecting | SHALLOW | The stream chip flips to "reconnecting" or "offline". Nothing is disabled, and there is no last-updated time. | None needed. |
| S4 | Running / streaming | MISSING | No running indicator on tiles. | Only status and `stepsUsed` updates exist. |
| S5 | Review at capacity (back-pressure) | SHALLOW | An amber banner with jargon ("No card may enter Verify"). | `backpressureActive`. |
| S6 | Memory-pressure pause | MISSING | Only a static memory chip. `memory_pressure` stop reason and queue halt are not shown. | Stop reason is in queue entries and evidence. Live level is not served. |
| S7 | Read-only server (`meta.triage=false`) | MISSING | No read-only affordance. | `/api/meta.triage`. |
| S8 | Ledger integrity broken | BUILT (chip) | "CHAIN BROKEN at #n" chip only, with no explanation or link. | `verification.corruptedSeq`. |
| **Foundations** |
| F1 | Tokens (15 roles × 2 themes) as CSS variables plus JSON (§1913, §1982) | BUILT | Fail, accent and blocked values were lifted for AA; this is documented in `tokens.ts`. Missing `--on-accent` and soft-tint roles, so the page improvises with `color-mix` and `rgba(0,0,0,.5)` for the scrim (a hard-coded colour). | `/tokens.css`, `/tokens.json`. |
| F2 | Typography: Inter / JetBrains Mono, 6-step scale, tabular numbers (§1937) | SHALLOW | The scale is used. The fonts are not bundled, so they silently fall back to the system stacks. ALL CAPS + tracking labels contradict "quiet, dense". | None needed. |
| F3 | Spacing / radius / no shadows / 120ms (§1959) | BUILT | `--space-5` is used in `.ev-body` but not defined (the scale ends at `--space-6`: 0..6 → 2..32). It is actually `24px`, so this is correct by luck. | None needed. |
| F4 | Both themes first-class (§1911) | BUILT | Sand renders. No `prefers-color-scheme` default. | None needed. |
| F5 | Brand: name, palette, icon glyph only; no lioness (§1980) | SHALLOW | The glyph is an arbitrary arrow-path. There is no favicon. | None needed. |
| **API (§2306)** |
| A1 | `GET /cards/:id/evidence` | BUILT as `/api/evidence/:card` | Latest attempt only. | None needed. |
| A2 | `POST /cards/:id/{accept,return,park}` | BUILT | Accept returns `sha`. Return goes to `ready`, not to `in_progress` as the doc says, which is fine and matches the lifecycle. | None needed. |
| A3 | `GET /events?since=` / `WS /stream?card=` | SHALLOW | See V10 and C11. | None needed. |
| A4 | `GET /decisions`, `POST /decisions/:id/answer` | MISSING | See V7. | None needed. |
| A5 | `GET /machine`, `POST /machine/calibrate` | MISSING | Doctor only. | None needed. |
| A6 | `POST /cards/:id/run`, `/gate`, `/split`, `/rewind`, `PATCH /cards/:id`, `POST /projects/:id/cards` | MISSING | No retry, re-check, split, rewind, edit or create from the UI. | None needed. |

---

## Part 2: Design

### 2.1 Design stance

Sekhemet is a **review instrument**, not a project tracker with an AI bolted on. The user's job is to read evidence and make a call. Every screen answers three questions in this order:

1. **What needs me?**
2. **Can I trust it?**
3. **What do I do?**

That order sets the IA, the default route, and the hierarchy inside each view.

Rules that remove the "default template" feel, and that apply everywhere:

- **No ALL-CAPS letter-spaced labels.** Section and column headings use sentence case at 12.5px/600 in `--text-primary`. Anything that should be quieter uses `--text-secondary`. The gold uppercase `STORY` label is gone for good.
- **Gold is not decoration.** `--accent` appears in exactly four places: the primary action button (Accept), the active-nav indicator, the focus ring, and the brand glyph. It never appears on labels, types or ids.
- **Chips are rare.** The header does not become a row of outlined pills. Status lives in one place (the sidebar footer) as text plus a single status dot.
- **Every number has a unit and a basis:** "8 of 32 steps", "waiting 12m", "16.8k tokens in". Never a bare `8/32 · 1d`.
- **Nothing is generic.** Empty states say what the column or view is for and what fills it. Errors state what failed and what to do.
- **Chrome is neutral and state is colour.** Colour is reserved for the five state roles, and each is paired with an icon and words.

### 2.2 Information architecture

```
┌ Sidebar (216px) ─────┬ Topbar (44px): view title · scope filters · ⌘K · live status ───────────┐
│ ◎ Sekhemet       ⌘K  │                                                                          │
│ Chronicle ▾          │                              View body                                   │
│                      │                                                                          │
│ ● Review          1  │                                                                          │
│   Board              │                                                                          │
│   Runs               │                                                                          │
│   Inbox           —  │   (hidden until /api/decisions exists)                                   │
│   Ledger             │                                                                          │
│   Playbook        5  │                                                                          │
│   Machine            │                                                                          │
│                      │                                                                          │
│ ─────────────        │                                                                          │
│ ● Live · ledger intact│                                                                         │
│ Memory 61%  ▮▮▮▮▮▯▯▯ │                                                                          │
│ nail-35b-a3b · idle  │                                                                          │
│ ◐ Theme   ? Keys     │                                                                          │
└──────────────────────┴──────────────────────────────────────────────────────────────────────────┘
```

| View | Route | Key | Purpose | Scope |
|---|---|---|---|---|
| **Review** | `#/review` (default when the review queue is not empty) | `g r` | Clear the queue: evidence, then verdict. | **Now** (Phase 2) |
| **Board** | `#/board` (default otherwise) | `g b` | See flow: where every card is and what is stuck. | **Now** (Phase 1) |
| **Card** | `#/card/:id/{evidence,plan,steps,thread,files}` | `Enter` | Everything about one card. | **Now** (Phase 3) |
| **Runs** | `#/runs[/:runId]` | `g q` (q for queue) | Did the last unattended run go well? Scorecards and comparisons. | **Now** (Phase 4) |
| **Ledger** | `#/ledger` | `g l` | The tamper-evident history, in sentences. Replaces the board's log drawer. | **Now** (Phase 4) |
| **Machine** | `#/machine` | `g m` | Health checks, memory, model, sandbox. | **Now** (Phase 4) |
| **Playbook** | `#/playbook` | `g p` | Learned rules plus suggestions from your send-back notes. | **Now** (Phase 4) |
| **Inbox** | `#/inbox` | `g i` | Decision requests, sorted by wait time. | **Later** (Phase 5): the planner must persist `DecisionRequest`s first. The nav item stays hidden until `/api/decisions` returns 200. |
| Settings | `#/settings` | `g ,` | Theme, density, review minutes per day, read-only config. | Later (Phase 5) |
| Workspace (master board), Registry, Goals | — | — | Multi-project rollup, bake-off matrix, goal burn-up. | **Deferred**: there is no multi-project or goal model yet, and designing them now would be fiction. |

Why the log drawer leaves the board: the log is audit material, not flow. It takes 38% of the board's height and pushes Review off-screen. The ledger becomes its own view. On the board, only the integrity status stays, in the sidebar footer.

Why Review is the landing view: the doc names it the primary product surface (§1853), and the human's job is to clear it. If the queue is empty the app opens on Board, and the empty Review state says so ("Nothing to review. 4 cards are ready to run.").

**Responsive model.**

- ≥1280px: sidebar expanded at 216px.
- 1024–1279px: sidebar collapses to a 52px icon rail, with labels in tooltips and counts as small badges.
- <768px: **read-only mobile**. A bottom tab bar holds Review, Board and Runs. The board becomes a single column with a column switcher. Card view shows Evidence only. Triage is one tap on large buttons (48px targets), per §1899.

### 2.3 Voice and language

The doc's voice (§33): *plain, exact, calm; verbs and numbers; name the gate, not the feeling; never say "done" when it means "I think so."* The doc's naming conventions (§37) are kept: **Workspace, Project, Card, Subtask, Gates, Evidence, Playbook, Worker, Planner, Library**. What changes is everything the implementation invented on top of them.

**Principles**

1. Write for a senior developer who is reading fast. Lead with the outcome, then the reason, then the detail.
2. Use sentence case everywhere. No exclamation marks and no emoji.
3. Show internal enums only in mono, and only in places where a developer might grep for them: evidence detail and ledger rows. Everywhere else, use the plain label.
4. Quote exact error text verbatim in evidence. Never paraphrase a compiler.
5. The actor is always named: **Worker**, **Planner**, **You** (or the git user name), **Sekhemet** (for harness actions such as gates or memory pauses).

**Term table (old → new)**

| Where | Old (today) | New | Notes |
|---|---|---|---|
| Tile header | `STORY` / `EPIC` / `FEATURE` / `TASK` tier label | *(removed)* | Hierarchy appears only when it exists: a breadcrumb `Chronicle › Ledger` and a `3 subtasks` badge. The tier survives internally. Where it must be named (card metadata), use **Card** or **Subtask** per §37. |
| Title suffix | `… (SPIDR: Rule)` | Title without the suffix, plus a **kind** tag | The server strips `/\s*\(SPIDR:[^)]*\)\s*$/`, and in the long run the planner stores `slice` as a field. |
| SPIDR kind | `Interface` | **Contract** | Tooltip: *Defines types and interfaces before behaviour.* |
| | `Data` | **Storage** | *Persists or shapes data.* |
| | `Path` | **Flow** | *Implements a working path end to end.* |
| | `Rule` / `Rules` | **Rules** | *Adds validation, invariants or edge cases.* |
| | `Spike` | **Research** | *Removes an unknown; produces notes and a probe test.* |
| | `Visual` (fixtures) | **UI** | |
| | `Integration` (fixtures) | **Wiring** | *Connects finished parts.* |
| | `Rule & Path`, `Rule/Interface` | **Rules + Flow**, **Rules + Contract** | At most two kind tags. The first is the primary kind. |
| Columns | Backlog | **Backlog** | Unchanged. |
| | Ready | **Ready** | |
| | Planning | **Planning** | |
| | In Progress | **Working** | The Worker is executing. |
| | Verify | **Checking** | Gates are running. |
| | Review | **Review** | |
| | Done | **Done** | |
| | Parked | **Parked** | Now visible. |
| | Rejected | **Closed** | Shown only if non-empty. |
| Header chip | `Pass@1 3/6 · 22.2 min` | Sidebar Runs row: **3 of 6 first try** | Runs view headline: *Passed on the first try: 3 of 6*. `Pass@1` appears only as a mono secondary label for people who benchmark. |
| Runs | `passAfterEscalation` | **Passed after a planner retry** | |
| | `modelSwaps` | **Model swaps** | |
| Stop reasons (short label · sentence) | `gate_passed` | **Passed** · *All gates passed on step N.* | |
| | `budget_exhausted` | **Out of steps** · *Used all 32 budgeted steps without passing.* | |
| | `oscillation_detected` | **Looping** · *Repeated the same actions without changing any file.* | |
| | `no_progress` | **Stalled** · *No file changed for 3 steps.* | |
| | `repair_exhausted` | **Couldn't fix** · *Tried N repairs; the same gate kept failing.* | |
| | `memory_pressure` | **Paused for memory** · *Stopped safely at 94% memory. Resumable.* | Amber, not red. It is a safety stop, not a failure. |
| | `quota_suspended` | **Paused for quota** · *The model provider's limit was reached.* | |
| | `error` | **Harness error** · *Sekhemet failed, not the Worker. See the ledger entry.* | |
| | `scope_violation` (doc) | **Out of scope** · *Tried to edit `src/x.ts`, which this card may not touch.* | |
| | `capability_ceiling` (doc) | **Too hard for this model** · *Needs a split or a stronger model.* | |
| | `human_abort` (doc) | **Stopped by you** | |
| Gates (label · id kept in mono) | `parse` | **Parse** · `parse` | |
| | `typecheck` | **Types** · `typecheck` | The evidence detail shows the command: `pnpm typecheck`. |
| | `test` / `unit` | **Tests** · `unit` | |
| | `lint` | **Lint** · `lint` | |
| | `bounds` | **Size** · `bounds` | *2 files, +11 −0 (limit 3 files, 200 lines).* |
| | `visual` | **Visual** · `visual` | |
| Gate states | pass / fail / skipped / not run / running | **Passed / Failed / Skipped / Not run / Running** | "Skipped" means the gate was configured and did not run because an earlier blocking gate failed. "Not run" means the card never reached gates. |
| Generic noun | "gate strip" | **Gates** | "4 of 4 gates passed". |
| Back-pressure banner | *Review at capacity. No card may enter Verify until a review is accepted or returned.* | **Review is full (3 of 3).** *Finished cards will wait in Checking until you clear one.* `[Open review]` | |
| Integrity chip | `chain verified · 13` / `CHAIN BROKEN at #n` | **Ledger intact · 13 entries** / **Ledger altered at entry #7**: *An entry no longer matches its hash. Stop and inspect before accepting anything.* `[Open ledger]` | |
| Stream | `live` / `reconnecting` / `offline` | **Live** / **Reconnecting…** / **Offline since 14:42. Showing the last known state.** | |
| Nav | "Event log" | **Ledger** | |
| | "Doctor" | **Machine** (view), **Health checks** (section) | |
| | `playbook_candidates.jsonl` | **Suggested rules** | |
| Triage | Accept | **Accept** `A`: *Merges to main as one commit.* | |
| | Return | **Send back** `R`: *Returns the card to Ready with your note for the Worker.* | |
| | Park | **Park** `P`: *Sets the card aside. Nothing runs until you unpark it.* | |
| Card facts | `stepsUsed/stepBudget` | **8 of 32 steps** | |
| | `turns` | **steps** | One vocabulary. The transcript "turn" is a step. |
| | `Tokens in / out` | **Tokens** 16.8k in · 1.4k out | |
| | `scopeFiles` | **May edit** | |
| | `acceptanceCriteria` | **Done when** | |
| | `acceptanceTests` | **Acceptance tests** with a *Protected* lock icon | |
| | `dependsOn` | **Waits on** / **Unblocks** | |
| | `difficulty` | **Difficulty 6/10** | |
| | `stopReason` | **Why it stopped** | |
| | `checkpointShas` | **Checkpoints** | |
| | `gatesConfigSha256` | **Gate contract** `e3b0c442…` | With warning *Empty gate contract* when it equals the empty-string hash. |
| | `settings.toolArm arm_a_flat` | **Tool set** `arm_a_flat` | |
| Actors | `executor` / `planner` / `human` | **Worker** / **Planner** / **You** | |
| Event types (ledger sentences) | `card/created` | *Planner created* **Define Chronicle contract interfaces** | |
| | `card/status_changed` | *Worker moved* **…** *from Working to Checking* | |
| | `card/updated {stepsUsed: 8}` | *Worker finished step 8 on* **…** | |
| Empty: Review | — | **Nothing to review.** *Cards land here when every gate passes. 4 cards are ready to run: `sekhemet queue`* | |
| Empty: Board column | "No cards" | Backlog: *Ideas and split-off work.* Ready: *Cards whose dependencies are done.* Planning: *The Planner is writing plans and tests.* Working: *No Worker running.* Checking: *Nothing being checked.* Review: *Nothing waiting for you.* Done: *Accepted cards appear here.* Parked: *Nothing parked.* | |
| Empty: Evidence | *This card has not run yet…* | **No attempts yet.** *Evidence appears after the Worker's first run. Budget: 32 steps.* | |
| Errors | *Could not load evidence.* | **Couldn't load evidence for hasher.** *The server returned 500. Retry `⟳`* | Always: what, why (status or message), action. |
| | 409 on accept | **Couldn't accept.** + server message verbatim, e.g. *Card is in Checking, not Review.* | |
| | 400 on return | (prevented client-side) *Add a note for the Worker. It's what they'll read next.* | |
| | 403 | **This action must come from the dashboard.** *Reload the page.* | |
| Read-only | — | **Read-only.** *This server was started without triage. Restart with `sekhemet serve` to accept or send back.* | |

### 2.4 Views

Every view shares the shell (§2.2). The shell's global states apply to every view and are specified once here:

| Shell state | Trigger | Treatment |
|---|---|---|
| **Loading (first paint)** | Before the first `/api/board` response | Skeleton layout: sidebar is real, and the view body shows neutral `--bg-raised` bars of the real geometry (columns, tile heights). No spinner. After 3s, add the line *Connecting to Sekhemet on 127.0.0.1:4040…* |
| **Live** | SSE open | Sidebar footer: green dot plus **Live**. |
| **Reconnecting** | SSE `error` | Amber dot plus **Reconnecting…**. Content stays. Mutations stay enabled for 10s, because the fetch may still work. |
| **Offline** | No SSE for >10s and `/api/meta` fails | Full-width 32px bar under the topbar in `--bg-raised`, 1px `--state-parked` bottom border: **Offline since 14:42:30.** *Showing the last known state. Actions are disabled.* `Retry`. All triage buttons are disabled with the tooltip *Offline*. Timestamps freeze (they don't count up). |
| **Read-only** | `meta.triage === false` | Triage bar replaced by a one-line note (see the term table). Keys `a/r/p` show a toast with the same copy. |
| **Review full** | `backpressureActive` | Same 32px bar, amber: **Review is full (3 of 3).** *Finished cards will wait in Checking until you clear one.* `Open review`. |
| **Memory pause** | Machine level `critical` or the latest queue entry is `memory_pressure` | Amber bar: **Paused for memory: 94% used.** *Sekhemet stopped the Worker safely before the system would swap. Work resumes below 85%.* `Machine`. The running tile flips to "Paused for memory". |
| **Ledger altered** | `verification.valid === false` | Red bar that cannot be dismissed. **Accept is disabled globally** with the tooltip *Ledger altered at entry #7. Inspect before accepting.* |

Only one bar shows at a time. Priority: ledger altered > offline > memory pause > review full.

#### 2.4.1 Review: the primary surface

**Purpose:** decide on one card in under a minute, without reading the trajectory.

**Layout at 1440px** (mockup: `review.html`)

```
┌ side ┬ Review · 1 ready · 3 need you ──────────────────────────────── [Filter ▾] ⌘K  ● Live ┐
│      ├─ Queue (296px) ───────┬─ Evidence ─────────────────────────────────┬─ Facts (288) ─┤
│      │ Ready for review   1  │ Chronicle › card_chron_iface     attempt 1 │ Done when     │
│      │ ▌Define Chronicle…    │ Define Chronicle contract interfaces       │ ☑ ChronicleEv…│
│      │  Contract · 4/4 ✓ 12m │ [Contract]  Passed on step 1 · 1.2s        │ ☑ AuditReport…│
│      │ Need you          3   │ ┌ Gates ─────────────────────────────────┐ │ ☑ tsc + biome │
│      │  Canonical JSON…      │ │✓ Parse │✓ Types 0.4s│✓ Tests 0.5s│✓ Size│ │ Run           │
│      │  Looping · 2 failed   │ └────────────────────────────────────────┘ │ Steps 1 of 24 │
│      │  Tamper detection…    │ Changes · 1 file · +18 −0                  │ Time 1.2s     │
│      │  Stalled · 4m41s      │ ▾ Implementation  src/types.ts   +18       │ Tokens 2.1k/180│
│      │  HTTP micro-API…      │   1 + export interface ChronicleEvent<T…   │ Model …       │
│      │  Paused for memory    │   …                                        │ Gate contract │
│      │                       │ ▸ Acceptance tests (protected) — unchanged │ Checkpoint    │
│      │                       ├────────────────────────────────────────────┤               │
│      │                       │ [Accept  A] [Send back  R] [Park  P]  j/k next · ? keys  │
└──────┴───────────────────────┴────────────────────────────────────────────┴───────────────┘
```

**Queue (left, 296px).** Two groups:

- **Ready for review**: cards in `review`, oldest first.
- **Need you**: cards in `parked`, cards whose latest evidence failed after the retry ladder, and (later) cards with a pending decision. Sorted by wait time, longest first.

Each row is 56px: title (13/500, one line, ellipsis), then a meta line (11px `--text-secondary`): kind · state icon plus short stop label · wait time. The selected row gets a 2px `--text-primary` left bar and a `--bg-overlay` background. Wait time turns `--state-parked` after 2h, per §910.

**Evidence (centre, fluid, min 560px).** In order:

1. Breadcrumb (project › card id in mono, xs), attempt selector `attempt 1 ▾` (disabled when there is only one attempt).
2. Title (18/600).
3. Outcome line: kind tag, state icon, then *Passed on step 1 · 1.2s* or *Failed: Types, Tests · Looping on step 8*.
4. **Gates strip** (§2.5.3), full-width.
5. **Failures** (only when failing): one block per typed failure, grouped by gate. See §2.5.4.
6. **Changes**: the diff viewer (§2.5.5), grouped into *Implementation* (files in `scopeFiles`), *Acceptance tests* (files matching `acceptanceTests`, collapsed, lock icon, "protected, staged by Sekhemet") and *Outside scope* (anything else, expanded, red rule, "the Worker edited a file this card may not touch").
7. **What the Worker tried** (optional): abandoned hypotheses, once the evidence bundle carries them.

**Facts rail (right, 288px):**

- **Done when**: acceptance criteria as a checklist. v1 shows neutral bullets, because criteria are not individually verified. When all gates pass, a single line reads *All gates passed. Criteria are checked by the acceptance tests.*
- **Run**: steps, time, tokens, model, tool set.
- **Scope**: may-edit files and acceptance tests.
- **Provenance**: gate contract hash (warns if empty), checkpoint sha, evidence id. Each has a copy button.

**Triage bar:** sticky at the bottom of the Evidence column, 52px, `--bg-surface` with a 1px top hairline.

- **Accept `A`** is the primary gold button. It is enabled only if the card is in `review`, every blocking gate passed, triage is on, and the ledger is intact. When disabled, the reason appears inline to its right: *Accept needs every gate passing.*
- **Send back `R`** is a secondary button.
- **Park `P`** is a ghost button.
- Right-aligned hint: `j k` next/prev · `Space` expand file · `?` keys.
- For failing cards (Need-you group), Accept is replaced by **Retry with planner** once `POST /api/cards/:id/run` exists. Until then only Send back and Park are shown.

**Interactions**

- **Accept.** Press `A`. The button changes to *Merging…* with a 3-second grace toast: **Accepting "Define Chronicle contract interfaces"** `Undo Z`. Then POST. On 200: toast **Merged to main as `ba1338e`** `Copy`, the row leaves the queue, and focus moves to the next row. On 409: an error toast carrying the server text, and the row stays.
- **Send back.** Press `R` to expand an inline composer above the triage bar. It is not a modal, so the evidence stays visible while you write. It contains:
  - A textarea, *What should the Worker do differently?*. This field is required, since the server enforces it.
  - **Quick notes**, generated from the failures. Example: *Fix the parameter type in src/hasher.ts; the test is protected.* *Use canonical key order in canonicalJson.* Clicking a chip inserts its text.
  - A checkbox, **Suggest as a playbook rule** (on by default), with the caption *Your note becomes a candidate rule in Playbook.* This mirrors the server, which always appends to `playbook_candidates.jsonl`. Until a flag exists the checkbox is informational and disabled-checked.
  - `⌘↩` sends and `Esc` cancels.
  - On success: toast **Sent back to Ready with your note**, then advance to the next row.
- **Park.** Press `P` to open a small popover with an optional reason and three presets (*Waiting on me*, *Needs a decision*, *Not now*). `↩` confirms.
- **Other keys.** `j/k` moves through the queue. `o` or `Enter` opens the full card view. `[` and `]` switch attempts. `f` toggles the Facts rail. `u` toggles unified/split diff.

**Data**

- Queue: `/api/board` filtered client-side. NEW: enrich each card with `display` (§2.6) plus `enteredColumnAt`.
- Evidence: `/api/evidence/:card`. NEW: `/api/cards/:id/attempts` for the attempt selector.
- Actions: existing POSTs.

**States**

| State | Treatment |
|---|---|
| Loading evidence | Gates strip skeleton (4 boxes) and three diff-line skeletons. The queue stays interactive. |
| Empty queue | Centre: glyph at 24px in `--text-muted`, then **Nothing to review.** *Cards land here when every gate passes.* A secondary line counts Ready cards with the command. The right rail is hidden. |
| Card has no evidence | **No attempts yet.** (see the term table). Triage shows only Park. |
| Evidence 404 or 500 | Inline error block with the retry action. Queue unaffected. |
| Card changes state while open | Non-blocking notice under the title: *This card moved to Working 3s ago. Evidence may be out of date.* `Reload` |
| Offline or read-only | Triage disabled as in the shell states. |

**1024px:** the Facts rail collapses into a *Facts* disclosure under the outcome line, and the queue narrows to 248px. **Mobile:** the queue is a full screen. Tapping a row opens evidence showing the gates strip, failures, a *Changes* file list (tap a file for the diff), and a fixed bottom bar with three 48px buttons: Accept, Send back, Park. Send back opens a bottom sheet with the textarea and quick notes.

#### 2.4.2 Board

**Purpose:** see the flow, what is stuck, and why. Mockup: `board.html`.

**Layout at 1440px:** topbar with *Board · Chronicle*, filter chips (`Kind`, `State: Needs you`, `Search`), a `Dependencies` toggle (Phase 5), and a density toggle. Below it sits the column strip.

- Columns are fluid: `flex: 1 1 0` with `min-width: 200px` and `max-width: 300px`, an 8px gap and 16px board padding.
- **Empty columns collapse into 36px rails**: a vertical sentence-case name and a count. Click, or focus and press `Enter`, to expand one. Rails apply to Backlog, Ready, Planning, Checking and Done once they have been empty for over 5 minutes, and to Done whenever the viewport is under 1600px.
- **Parked** is always a full column when it holds cards, placed far right with an amber count. **Closed** renders only when it holds cards.
- At 1440px this layout fits Backlog, Working, Checking, Review and Parked as full columns plus three rails, with no horizontal scroll (verified in `board.html`). Once more than six columns hold cards, the horizontal virtualizer windows the extra columns off-screen. Review and Parked stay pinned in view, because the human's queue is never the part that gets scrolled away.

**Column header** (36px): name (12.5/600, sentence case) · count. For WIP-limited columns, the count reads `1 / 3` with a 2px capacity bar under the header. The bar fills `--text-secondary`, turns `--state-parked` at capacity and `--state-fail` over the limit. Tooltip on the count: *Review limit 3, from 60 review minutes a day at ~20 min per card.* The header also has a column menu `⋯` (sort: priority / wait time / recently changed; collapse).

**Tiles** follow §2.5.1. Ordering inside a column uses `orderKey`. Review and Parked sort by wait time, longest first.

**Interactions**

- `h/l` moves between columns, keeping the row index clamped. `j/k` moves within a column.
- `Space` opens the **peek drawer**: a 480px right panel with gates, failures, outcome, *Done when*, and a compact file list, plus triage keys that work inside the drawer. `Enter` opens the card view.
- `x` selects. Batch actions (Park *n* cards) come in Phase 5. `c` creates a card once `POST /cards` exists; until then it shows a toast with the CLI (`sekhemet plan "<spec>"`).
- There is **no drag and drop in v1.** Columns are gated states (§349). Moves happen through triage actions, which are explicit and recorded.
- A mouse click selects and `Space`/double-click peeks.

**Live updates.** An SSE frame patches only the changed tiles, keyed by id. It never re-renders the board, and it never resets scroll, focus or an open drawer. A card that changes column keeps focus if it was focused, and the view scrolls it into view only if it was focused. Otherwise, the tile shows a `just now` meta for 10 seconds. There is no motion.

**States**

- **Empty board**, meaning no cards at all. Centre: **No cards yet.** *Plan a feature into cards:* `sekhemet plan "Build a tamper-evident ledger"`. Or seed a fixture: `node scripts/seed_project.mjs chronicle`.
- **Empty column:** the per-column copy from §2.3, in `--text-secondary`, at the top of the column (not centred).
- **Filter with no match:** *No cards match "Kind: UI".* `Clear filter`.
- **Review full:** the shell bar, plus the Review header count in amber and a *Holding for review* tag on Checking tiles that are waiting on capacity.
- **Memory pause:** the shell bar, and the running tile shows *Paused for memory*.

**1024px:** column min-width 220px, icon-rail sidebar, horizontal scroll with Review and Parked pinned. **Mobile:** a column switcher as a segmented control scrolling horizontally (`Ready 4 · Working 1 · Review 1 …`), one column visible, tiles at full width, and a tap opens the Evidence card view. No create or batch actions.

**Data:** `/api/board` plus the NEW `display` enrichment, `/api/wip` merged into the board payload, and `/api/stream`. NEW (Phase 3): a `card/step` event so a running tile can show *Step 5 of 32 · editing src/hasher.ts*.

#### 2.4.3 Card view

Route: `#/card/:id/:tab`. Mockup: `card.html`, which shows the failing hasher card on the Evidence and Steps tabs.

**Header, 96px:**

- Breadcrumb, then title (18/600) with the kind tag.
- A state pill with icon (e.g. `● Checking`) and the outcome sentence.
- Right side: triage buttons (same rules as Review) and a `⋯` menu (Copy id, Open worktree path, View in ledger).
- Tabs underneath (32px, with the active tab carrying a 2px `--accent` underline): **Evidence · Plan · Steps · Thread · Files**, bound to keys `1`–`5`.

**Evidence** (default) is the same composition as the Review centre and rail, full width.

**Plan**

- Spec (prose)
- **Done when** checklist
- **May edit** and **Acceptance tests** (protected)
- Budget: steps, tokens, seconds, each as used/budget bars
- Difficulty 1–10 as a 10-segment meter, with routing (*Direct / Edit sketch / Split*) when known
- **Waits on** and **Unblocks**, as linked titles
- The kind's rationale (`PlannedStory.rationale`)
- The **Planner's repair plan** for attempt 2+. NEW: persist the `planRepair` output into evidence or the ledger.

**Steps** is the live transcript, rendered one step per row.

- Each row carries a step number, then the tool calls as `write_file src/hasher.ts`, `finish_card`, `note "stuck"`, with each observation summary on the line below (*overwrote src/hasher.ts (11 lines)*).
- Steps that ran gates carry a compact gates result (*Types failed · 3 errors*).
- Token and time usage sit right-aligned in tabular `--text-secondary`.
- Loop detection is annotated where it fired. The final row states the stop: **Looping**, *steps 6–8 repeated `note "stuck"` with no file change.*
- A running card streams new steps at the bottom with no animation. The view auto-follows while the scroll position is at the bottom; if you scroll up, it shows *3 new steps ↓*.
- Clicking a `write_file` step expands the written content, with syntax colouring kept neutral.

Data: NEW `GET /api/cards/:id/transcript?attempt=` returns `{ attempt, file, steps: TranscriptStep[] }` from `.sekhemet/transcripts/`. Live: NEW `card/step` ledger events (see §2.6).

**Thread** is the human-readable timeline for this card from the ledger: created, moved, returned (with the note), parked, accepted (with sha), decisions (later), and notes. Send-back notes render as quotes. Data: NEW `GET /api/events?card=:id`.

**Files** is a table of every file relevant to the card. Columns: path (mono), role (*May edit* / *Protected test* / *Outside scope*), change (+/−), and gate failures on that file (count, linked). Clicking a row jumps to that file in Evidence.

**States:** a tab with no data (e.g. Steps before the first run) shows *No steps yet. The Worker hasn't started this card.* Streaming, error and offline follow the shell.

#### 2.4.4 Runs

**Purpose:** "Did last night's unattended run go well, and is it better than the last one?" Mockup: `runs.html`.

**Layout:** a left list of runs (240px), with each row showing date, time, model, `3/6` and duration. The scorecard fills the right.

1. **Headline row**: four number blocks (22/600 tabular):
   - **Passed first try** 3 of 6
   - **Passed after retry** 0
   - **Total time** 22m 10s
   - **Tokens** 121.4k in · 31.5k out
   Each block has a delta against the previous run when history exists (`+1` in `--state-pass`, `−2m` etc.).
2. **Timeline:** a horizontal sequential bar. Each card is a segment whose width is proportional to its duration, filled by outcome (pass / fail / paused) and labelled with the short id. It shows at a glance that the three failures consumed 86% of the run (1,143s of 1,330s).
3. **Cards table:** card title (linked), attempt, result icon plus label, **Why it stopped**, steps, time, tokens in/out, accepted (sha or —). Sortable.
4. **Why runs stop:** a stacked count by stop reason (Passed 3, Stalled 1, Couldn't fix 1, Paused for memory 1), each linked to a filtered table.
5. **Run settings:** worker model, manager model, model swaps, and the harness commit.

**Data:** `/api/queue` today. NEW `GET /api/runs` returns `{ runs: {id, startedAt, model, passAt1, totalDurationMs, cards}[] }` and `GET /api/runs/:id` returns a `QueueReport`. This requires `writeQueueReport` to also write `.sekhemet/runs/<startedAt>.json`, a small change in `execute.ts`.

**States:**
- **No runs yet:** **No runs yet.** *Run every Ready card unattended:* `sekhemet queue --auto-accept`.
- **A run is in progress** (NEW flag): the top row reads *Running · 2 of 6 cards · 4m*, and the timeline grows live.

#### 2.4.5 Ledger

A full-height table where each row is a **sentence**. Example: *Worker moved* **Implement canonical JSON…** *from Working to Checking.* Columns: seq (tabular) · time · actor · event type (mono, `--text-secondary`) · hash (8 chars, mono), with prev-hash in a tooltip.

- Filters: card, actor, type.
- `Enter` on a row opens a detail panel with the full payload JSON, payload hash, hash and prev.
- The header states integrity: **Ledger intact · 13 entries · verified 14:48:02**.
- If the ledger is broken, the first bad row gets a red left rule and the header explains it.

Data: NEW `GET /api/events?since=&card=&limit=` (paged, newest first).

#### 2.4.6 Machine

- **Memory:** a large gauge showing used/total GB, level (Normal / Warning / Critical), swap in use, and the three thresholds (85% / 90% / 94%) marked on the bar, with the doc sentence for what happens at each level.
- **Model:** the worker model id, whether it is resident, the endpoint, keep-alive, and (Phase 5) tokens/s sparklines from `card/step` usage.
- **Health checks:** the doctor list, each with an icon, name, plain detail and fix hint. Example for the skills warning: *No skills folder. Create `.sekhemet/skills/` to load skills.*
- **Sandbox:** the confinement mode.
- **Worktrees:** count and the list of card ids.
- `Re-run checks` bypasses the 15s cache with a NEW `?fresh=1`.

Data: NEW `GET /api/machine` returns `{ memory: MemoryPressureStatus & { usedBytes, totalBytes, swapUsedBytes }, models: { worker?: {id, resident, endpoint}, manager?: … }, checks: DiagnosticCheck[] }`, pushed on the SSE stream as `event: machine` every 5s.

#### 2.4.7 Playbook

- **Rules:** a table with the instruction (prose, 2-line clamp, expandable), the gate it responds to (Types, Tests…), the card that taught it (linked), since (date) and the pattern.
- **Suggested rules:** send-back notes, each with card, note, date, **Promote** (opens an editor pre-filled with the note, where you pick a trigger gate) and **Dismiss**.
- Empty state: *No suggestions. Every note you write when sending a card back shows up here.*

Data: NEW `GET /api/playbook` returns `{ rules: PlaybookRule[], candidates: {cardId, reason, at}[] }`. Promote and Dismiss come in Phase 5.

#### 2.4.8 Inbox (Phase 5)

A list of decision requests sorted by wait time, using the §2.5.7 component. The nav item is hidden until the endpoint exists; the sidebar never shows a dead link.

### 2.5 Components

#### 2.5.1 Card tile

Mockup: `board.html`. Anatomy (compact density, 264px wide, 8px/12px padding, 4px internal gap):

```
┌──────────────────────────────────────────┐
│ Rules                              hasher │  row 1: kind tag · short id (mono 11, secondary)
│ Implement canonical JSON and SHA-256     │  row 2: title 13/500, 2-line clamp
│ hash chaining                            │
│ ✓✗✗·  Types failed · 3 errors            │  row 3: gate pips + status line (11, secondary)
│ ▬▬▬▬▬▬░░░░░░░░░░░░░░░░  8 of 32 steps    │  row 4: budget bar + text (only when started)
└──────────────────────────────────────────┘
```

**Row 3 is the most important line.** It is the card's current truth, in words, derived per state:

| State | Left mark | Status line | Extra |
|---|---|---|---|
| Ready | gate pips all *not run* (hidden) | *Ready · 32-step budget* | — |
| Blocked (deps not done) | link icon, `--state-blocked` | *Waits on* **Tamper detection** | Title in `--text-secondary`. |
| Planning | pencil icon | *Planner is writing the plan* | — |
| Working (running) | pulsing lapis dot | *Step 5 of 32 · editing src/hasher.ts* | 2px `--state-running` left rule; budget bar in lapis. |
| Checking (gates running) | pips, with the running one as a lapis ring | *Running Tests…* | — |
| Failed, will retry | pips with red | *Types failed · retrying (rung 1 of 4)* | 2px `--state-fail` left rule. |
| Review | pips all green | *4 of 4 gates passed · waiting 12m* | Wait time turns amber after 2h. |
| Parked | pause icon, amber | *Paused for memory*, *Looping · parked*, or the user's park note | 2px `--state-parked` left rule. |
| Done | check-circle, `--text-secondary` | *Accepted · ba1338e · 2h ago* | Whole tile at `--text-secondary`, with no bars. |

- **Gate pips:** one 12×12 box per *configured* gate in `gates.toml` order. Each holds a 1.5px glyph: ✓ passed, ✕ failed, – skipped, a ring for running, and empty for not run. The glyph uses `--bg-base` on a state fill for pass and fail (6.0:1 and 4.6:1). Not run is a 1px `--border-strong` outline. There are **no letters**; the tooltip and aria give the names. Hovering shows a mini popover with each gate's name, state, duration and first error line.
- **Budget bar:** 2px high. It fills `--text-secondary` by default, lapis while running, amber at ≥75% and red at 100%. Text reads *8 of 32 steps*. Tokens and seconds are added as a second line in comfortable density only, when budgets exist.
- **Dependency badge:** a link icon and count (`2`) in row 1, right-aligned before the id, when `dependsOn` has entries that are not done. The tooltip lists the titles.
- **Difficulty:** in comfortable density only, as a diamond icon and `6` in row 1 (the difficulty meter lives in Plan).
- **Tile states:**
  - Hover: `--bg-overlay`.
  - Focused: a 2px `--accent` ring, offset −1.
  - Selected (`x`): `--border-strong` border and a checkbox in row 1.
  - Selected and focused: both.
  - Dragging does not exist in v1.
- **Heights:** compact is 88px. Comfortable is 112px, adding a spec excerpt (1 line) and budget detail.

#### 2.5.2 Column header

Described in §2.4.2. Variants: normal, WIP-limited, at capacity (amber count and bar, plus the tooltip *Full. The Worker holds finished cards until you clear one.*), over capacity (red), and collapsed rail.

#### 2.5.3 Gates strip (Review / Card)

A full-width segmented row. Each segment is `[icon] Name  duration`, 32px tall, separated by 1px hairlines, on `--bg-surface`. A failed segment has a 2px `--state-fail` top rule and a count: *Types ✕ 3*.

- **Hover or focus** a segment: a popover (max 420px) with the gate id and command in mono, the exit code, the first 3 typed failures (`file:line`, message), and *Show all (3)*.
- **Click or `Enter`:** scroll to and expand that gate's Failures group. For passed gates it opens the raw log once it is stored (Phase 5). Until then it shows *No output recorded for passed gates.*
- **Order:** `gates.toml` order, followed by the derived gates (Size). Skipped gates are shown in `--text-secondary` with the reason *Skipped because Types failed*.
- **Empty contract** (hash equals the empty-string hash): a trailing amber segment, **Gate contract empty**. The tooltip reads *gates.toml hashed to the empty string. These results were not verified against a contract.*

#### 2.5.4 Failure block

One block per typed failure:

- Header line: gate icon, then `tests/hasher.spec.ts:25:7` in mono and linked (jumps to the diff line), then the code `TS2353`.
- Body: the exact `errorExcerpt` in mono 12.5/1.55.
- Two-column **Expected / Actual** row when present.
- `$ pnpm typecheck` (repro, with a copy button).
- *Suggested:* the `suggestedAction`.
- If a `suggestedFixFiles` entry is protected, a warning: *The suggested file is a protected test. The fix belongs in the implementation.* This flags the hasher failure seen in the data, where the error is reported in the test but caused by `hashEvent`'s parameter type in `src/hasher.ts`.
- Styling: `--bg-surface` with a 2px left rule in `--state-fail`. Failures with the same message are grouped: *3 × TS2353 in tests/hasher.spec.ts*, expand to see each line.

#### 2.5.5 Diff viewer

- **Grouping (cheap intent grouping, Phase 2).** Files go into *Implementation* (in `scopeFiles`), *Acceptance tests* (`acceptanceTests` / protected globs, collapsed by default, lock icon, "staged by Sekhemet · not written by the Worker" when the file is identical to `acceptance/<name>`), *Outside scope*, and *Other*. True structural intent (difftastic) comes in Phase 5.
- **File header, 32px, sticky within the scroller:** chevron, path (mono), role tag, `+18 −0`, and *Copy path*.
- **Lines:** old and new gutters (tabular, `--text-muted` is allowed here as decorative per §4.9, 40px each), a sign column, then code in mono 12.5/1.55.
  - Added lines: background `color-mix(in srgb, var(--state-pass) 10%, transparent)`, text `--text-primary`.
  - Removed lines: the same with fail.
  - Hunk headers: `--text-secondary` on `--bg-raised`.
  - Colour is never the only signal; the `+`/`−` sign stays.
- **Inline annotations:** after the line a failure points at, insert a full-width note row. It carries a 2px `--state-fail` left rule, a gate icon, and *Types · TS2353 Object literal may only specify known properties…*. It is `role="note"` and focusable. `n` and `N` jump between annotations.
- **Modes:** unified (default) and split (`u`). Whitespace-only changes are hidden, with a toggle.
- Large files: collapse after 400 lines with *Show 212 more lines*. Generated files and lockfiles are collapsed by default.

#### 2.5.6 Triage bar and composer

Described in §2.4.1. Button specs:

| Button | Background | Text | Border |
|---|---|---|---|
| Primary | `--accent` | `--on-accent` (NEW token) | none |
| Secondary | `--bg-raised` | `--text-primary` | 1px `--border-subtle` |
| Ghost | none | `--text-secondary` | none |

All buttons are 32px high with 4px radius and 12px horizontal padding. A `kbd` hint sits inside the button, right-aligned, in 11px mono. Disabled buttons use 40% opacity and state the reason in adjacent text, never only in a tooltip.

#### 2.5.7 Decision request (Phase 5)

A card-width panel:

- The question (15/600) and the category tag.
- A radio list. Each option row has the label (13/500) and the consequence (13, secondary), plus *Effort +6 steps / ~7k tokens* and *Risk: …* in 11px. A *Preview* disclosure shows `previewSketch` (files, symbols, blast radius) in mono.
- The recommended option carries a **Recommended** tag (neutral, not gold) and the rationale beneath it.
- Footer: the policy line. *If you don't answer by 16:00 (in 2h 14m), option B is applied.* (`safe_default`), or *If you don't answer, the card stays parked.* (`default_deny`, with a lock icon). The countdown updates every minute (not every second) and turns amber under 15 minutes.
- **Destructive** options have a red rule and need an explicit confirm.
- Keys: `1`–`9` pick an option and `↩` answers.

#### 2.5.8 Run scorecard

Described in §2.4.4. The number block is: label (11, secondary), value (22/600 tabular), delta (11, state colour plus arrow icon).

#### 2.5.9 Machine panel components

- **Memory gauge:** a 6px bar with threshold ticks.
- **Check row:** 16px icon, name 13/500, detail 12.5 secondary, fix hint.
- **Sparkline** (Phase 5): 120×24 SVG, 1.5px `--text-secondary` stroke, with the last point as a state-coloured dot.

#### 2.5.10 Command palette

- 600px wide at 12vh from the top, `--bg-raised` with a 1px `--border-strong` border and no shadow. The scrim uses the NEW token `--scrim`.
- The input is 15px and 48px high.
- Results are grouped: **Actions on focused card** (Accept, Send back, Park, Open, Copy id), **Cards** (title, kind, state icon), **Go to** (views, with their `g`-chords), and **Preferences** (Theme, Density).
- Fuzzy matching highlights matched characters in `--text-primary` against the rest in `--text-secondary`. Each row shows its shortcut on the right.
- Prefixes: `>` filters to commands and `#` to cards.
- `↑↓` moves, `↩` runs, `⌘↩` opens in the card view, `Esc` closes.
- The empty query shows recent cards and the top actions.

#### 2.5.11 Toasts

- Bottom-left, 16px from the edges, stacking upward, at most 3.
- 360px wide on `--bg-overlay` with a 1px `--border-strong` border, a state icon and one line of text, plus an optional action (`Undo Z`, `Copy`).
- Success and info toasts last 4s; errors stay until dismissed.
- `role="status"` for info and `role="alert"` for errors.
- Hovering pauses the timer.

#### 2.5.12 Keyboard cheat sheet (`?`)

- A modal 720px wide in four columns: Global, Navigate, Cards, Review.
- Each row is a description plus its `kbd` keys. Keys that do not apply to the current view are dimmed.
- It is also reachable from the sidebar footer.

**Full key map.** This is the doc's §1872 map plus these additions:

- `g q` Runs, `g l` Ledger, `g p` Playbook
- `1–5` card tabs
- `[` / `]` attempts
- `u` diff mode
- `n` / `N` next or previous annotation
- `f` Facts rail
- `t` theme
- `z` undo accept (during the grace window)
- `/` focuses the filter

Keys are ignored while focus is in a text field, except `Esc` and `⌘↩`.

### 2.6 Data contract changes (NEW endpoints and fields)

All of these are additive and read-only unless marked otherwise.

| Endpoint / field | Shape | Source | Phase |
|---|---|---|---|
| `card.display` on `/api/board` and stream | `{ title: string; kinds: ("contract"\|"storage"\|"flow"\|"rules"\|"research"\|"ui"\|"wiring")[]; shortId: string; stateLabel: string; statusLine: string; tone: "neutral"\|"running"\|"pass"\|"fail"\|"parked"\|"blocked"; stopLabel?: string; enteredColumnAt?: string; waitsOn?: {id,title}[]; evidence?: { passed: boolean; gates: {id,label,state,durationMs?,failures:number}[]; linesAdded:number; linesRemoved:number; files:number } }` | New `packages/ui/src/vocabulary.ts` (pure), called in `server.ts` `boardWithEvidence()` | 0–1 |
| `GET /api/gates` | `{ gates: {id, rung, layer, label, blocking}[]; protected: string[]; maxFiles: number; maxDiffLines: number; sha256: string; empty: boolean }` | `loadGatesConfig(repoPath)` | 2 |
| `GET /api/cards/:id` | `{ card: CardRecord & {display}; attempts: {attempt, evidenceId, createdAt, passed, stopReason}[] }` | Card store plus `.sekhemet/evidence/ev_*.json` scan (or a new `index-<card>.json`) | 2 |
| `GET /api/evidence/:card?attempt=n` | `EvidenceBundle` | As today, with an attempt selector | 2 |
| `GET /api/cards/:id/transcript?attempt=` | `{ attempt, file, steps: {turn, calls:{name, target?:string, summary:string, ok:boolean}[], gate?:{passed, failures:string[]}, usage:{promptTokens, completionTokens, durationMs}, stopReason?}[] }` | `.sekhemet/transcripts/` | 3 |
| `card/step` ledger event | `{ id, turn, calls:[{name, target}], gate?:{passed, failed:string[]}, usage }` | `card_runner` `onProgress` → `log.append` | 3 |
| `GET /api/events?since=&card=&limit=&order=desc` | `{ events, verification, nextCursor }` | EventLog | 3 |
| `GET /api/runs`, `GET /api/runs/:id` | See §2.4.4 | `.sekhemet/runs/*.json` (new write in `writeQueueReport`) | 4 |
| `GET /api/playbook` | `{ rules: {id, originCard, triggerGate, pattern, instruction, effectiveDate}[]; candidates: {cardId, reason, at}[] }` | `playbook.toml` plus jsonl | 4 |
| `GET /api/machine` + SSE `event: machine` | See §2.4.6 | `currentMemoryPressure`, `readSwapUsedBytes`, router, `runDoctor` | 4 |
| `/api/meta` additions | `{ project, repoPath, triage, reviewMinutesPerDay, version, gitUser }` | config | 1 |
| `POST /api/cards/:id/run` (mutating) | `{ attemptId }` | `executeCard` in background | 5 |
| `GET /api/decisions`, `POST /api/decisions/:id/answer` | Per §2319 | Planner persistence | 5 |

**Presentation logic belongs in `packages/ui/src/vocabulary.ts`:**

- `parseTitle(title) → {title, kinds}`
- `stopReasonLabel(reason) → {short, sentence, tone}`
- `columnLabel(status)`
- `gateLabel(rung)`
- `statusLine(card, evidence, now)`
- `formatWait(ms)`, `formatTokens(n)`

The server calls these functions, and they are unit-tested there. They are also published as `/vocab.json` for plugin panels. The browser never re-derives a label. This keeps the language in one place and testable.

---

## Part 3: Visual specification

### 3.1 Tokens: additions to `packages/ui/src/tokens.ts`

Existing roles are unchanged. The following are added and derived; no component hard-codes a colour:

| Token | Basalt | Sand | Use |
|---|---|---|---|
| `--on-accent` | `#14120F` (6.9:1 on accent) | `#FFFFFF` (5.2:1) | Text on primary buttons. |
| `--on-state` | `#14120F` | `#FFFFFF` | Glyphs on pass/fail/running fills. |
| `--scrim` | `rgb(8 7 6 / 0.6)` | `rgb(28 26 22 / 0.35)` | Palette and modal backdrop (replaces the hard-coded `rgba(0,0,0,.5)`). |
| `--tint-pass` / `--tint-fail` / `--tint-running` / `--tint-parked` | `color-mix(in srgb, var(--state-*) 12%, transparent)` | 10% | Diff lines, failure blocks, state rows. |
| `--sidebar-w` / `--rail-w` / `--topbar-h` | 216px / 52px / 44px | same | Layout constants. |

The fonts remain `Inter` / `JetBrains Mono` with the system fallback. Bundling the WOFF2 files (both OFL) under `packages/ui/web/fonts/` is optional in Phase 5. Until then the design must look right in `-apple-system` / `SF Mono`, and the mockups were checked that way.

### 3.2 Type usage

| Element | Size / weight / leading | Colour |
|---|---|---|
| Wordmark | 15 / 600 / tight, tracking −0.01em | `--text-primary` |
| View title (topbar) | 15 / 600 | primary |
| Card title (Review, Card view) | 18 / 600 / tight | primary |
| Scorecard number | 22 / 600, tabular | primary |
| Section heading | 12.5 / 600, sentence case | primary |
| Body, tile title | 13 / 400 (tile 500) / tight on tiles, normal elsewhere | primary |
| Meta, status line, column counts | 11 / 400–500, tabular | `--text-secondary` |
| Mono ids, hashes, event types | 11 mono | secondary |
| Code, diff, error excerpts | 12.5 mono / 1.55 | primary |
| kbd | 11 mono, 1px `--border-subtle`, 3px radius, 0 4px padding | secondary |
| Diff line numbers | 11 mono | `--text-muted` (decorative only) |

### 3.3 Spacing per component

| Component | Values |
|---|---|
| Sidebar | Item 28px high, 8px horizontal padding, 2px gap; group gap 16px; footer 12px padding. |
| Topbar | 44px, 16px padding, 12px gaps. |
| Column | Header 36px (0 12px); body padding 8px; tile gap 8px; column gap 8px; board padding 16px. |
| Tile | 8px 12px padding, 4px row gap, 6px radius. |
| Review queue row | 56px, 8px 12px padding. |
| Evidence column | 24px padding; 24px section gap; 8px heading-to-content. |
| Gates strip segment | 32px, 0 12px padding. |
| Failure block | 8px 12px padding, 8px gap between blocks. |
| Diff | File header 32px; line 20px (12.5 × 1.55 ≈ 19.4, rounded to 20). |
| Triage bar | 52px, 0 24px padding, 8px button gap. |
| Palette | Row 36px, group label 28px. |
| Toast | 12px 16px padding. |

### 3.4 Icons: single weight, 1.5px stroke, 24 viewBox, round caps and joins, `currentColor`

The sprite lives in `packages/ui/src/icons.ts` (`icon(name, size=16)` returns an SVG string). The mockups carry the path data.

| Name | Drawing | Used for |
|---|---|---|
| `review` | tray with a check | nav Review |
| `board` | three vertical rounded bars of unequal height | nav Board |
| `runs` | play triangle over a baseline with ticks | nav Runs |
| `inbox` | tray with an arrow down | nav Inbox |
| `ledger` | stacked lines with a chain link at the right | nav Ledger |
| `playbook` | open book | nav Playbook |
| `machine` | chip square with pins | nav Machine |
| `settings` | three sliders | Settings |
| `search` | circle and handle | palette |
| `check` / `x` / `minus` | stroke glyphs | gate states |
| `ring` | circle with a 90° gap | running gate |
| `dot` | 6px filled circle | live, running |
| `pause` | two bars | parked, memory |
| `link` | chain link | waits on |
| `lock` | padlock | protected file |
| `alert` | triangle with a bar | warnings |
| `merge` | git-merge (two nodes joining) | Accept |
| `send-back` | corner-up-left arrow | Send back |
| `park` | square with a pause | Park |
| `clock` | clock | wait time |
| `file` / `file-diff` | page / page with ± | files |
| `copy` | two squares | copy |
| `chevron-right` / `chevron-down` | chevrons | disclosure |
| `sun` / `moon` | theme | theme |
| `keyboard` | keycaps | keys |
| `memory` | memory module | Machine |
| `pencil` | pencil | Planning |
| `undo` | counter-clockwise arrow | undo |
| `external` | box with an arrow | open worktree |

No filled icons, no duotone, no emoji, and no Unicode `✓ ✗` glyphs in the product.

### 3.5 Colour application per state

| Tone | Fill (pips, dots) | Rule (2px left or top) | Text | Tint background |
|---|---|---|---|---|
| running | `--state-running` | yes | Only on base/surface. On raised, use secondary text plus a lapis icon. | `--tint-running` for the live step row |
| pass | `--state-pass` | no (success is quiet) | Base/surface only | diff additions |
| fail | `--state-fail` | yes | Base/surface only | failure blocks, diff removals |
| parked (needs you) | `--state-parked` | yes | Base/surface only | shell bars |
| blocked | `--state-blocked` | no | Secondary | — |
| neutral | — | — | primary/secondary | — |

### 3.6 Motion

- Motion is 120ms ease-out and applies only to hover, press, focus, drawer or palette open (opacity plus 8px translate), and popovers.
- These append with **zero animation**: board reflow, streaming steps, SSE patches, toast stack shifts.
- The running dot pulses (opacity 1 to 0.35, 1.6s, infinite). It is the only perpetual animation.
- `prefers-reduced-motion: reduce` removes the pulse and translates. Drawers switch instantly.

### 3.7 Focus and selection

- Focus: `outline: 2px solid var(--accent); outline-offset: 1px` on `:focus-visible`. This deliberately replaces the doc's `--border-strong`, which measures 1.3–1.9:1 and fails WCAG 2.2 focus visibility. Accent measures ≥3.8:1 on every surface in both themes.
- Selection: `--bg-overlay` plus a `--border-strong` border, or a 2px `--text-primary` left bar in lists.
- Focus and selection are distinct and can co-exist.

### 3.8 Brand

- **Glyph:** a **pylon gate with a sun disc**: two tapered towers joined by a baseline, with a disc floating between the tower tops. It is drawn in 1.5px line in `--accent`. It reads as "gate", the product's core idea, and as the solar disc of the name's goddess, without any figure.
- Path (24 viewBox): `M3 20 L5.5 9 H10 V20 M21 20 L18.5 9 H14 V20 M2 20 H22`, plus `circle cx=12 cy=6 r=2.25`.
- **Wordmark:** "Sekhemet" in Inter 600, tracking −0.01em, `--text-primary`, placed 8px right of an 18px glyph.
- **Favicon:** the glyph at 32px on a `--bg-base` rounded square (6px).
- No taglines in the product chrome, no mascot, no lion.

### 3.9 Accessibility

- **Contrast rules**, measured on the shipped tokens:
  - Informational text uses `--text-secondary` or stronger (≥5.3:1 everywhere).
  - `--text-muted` is **decorative only**: line numbers, disabled controls, placeholders. It is never used for ids, counts or timestamps.
  - State-coloured **text** only sits on `--bg-base` or `--bg-surface`. On tiles (`--bg-raised`), state is carried by the icon or pip (a non-text element, which needs ≥3:1; all states measure ≥3.7:1) and the words use secondary text.
  - Add a unit test to `packages/ui/tests` that asserts these pairs with the existing `contrastRatio`.
- **Colour never stands alone.** Every state has an icon and a word, and diffs keep their `+`/`−` signs.
- **Landmarks:** `nav` (sidebar), `header` (topbar), `main` (view), `aside` (Facts rail, peek drawer).
- **Board:** each column is `role="group"` with `aria-labelledby` pointing at its header. Its list is `role="listbox"` with `aria-orientation="vertical"`. Tiles are `role="option"` with `aria-selected` (for `x` selection) and `aria-describedby` pointing at the status line. There is a single tab stop into the board with roving `tabindex`: `h/j/k/l` and the arrow keys move, and `Home`/`End` jump to the column ends.
- **Gates strip:** `role="list"`. Each segment is a button with an `aria-label` such as "Types: failed, 3 errors, 0.7 seconds".
- **Tabs:** WAI-ARIA tabs pattern (`tablist`, `tab`, `tabpanel`, arrow keys).
- **Palette and cheat sheet:** `role="dialog" aria-modal="true"`, focus trapped, focus returned to the invoker on close. The palette uses `combobox` plus `listbox`.
- **Live region:** one polite `aria-live` region announces state changes of the **focused or selected** card and triage results. Background churn is not announced.
- **Order of focus in Review:** queue → gates strip → failures → diff files → triage bar. `Tab` inside the diff visits file headers and annotations, not lines.
- **Targets:** at least 24×24 on desktop and 44×44 on mobile.
- **Zoom:** layouts hold at 200% zoom, where the 1024 rules take over.

---

## Part 4: Implementation plan

Constraints: each task is a card of fewer than 200 LOC across 1–3 files. Contracts and tests come first (CLAUDE.md §2). Nothing ships a hard-coded colour.

**Architecture decision (Phase 0).** The single template literal cannot grow into eight views. The page moves to **static, build-free ES modules** served from `packages/ui/web/`. This keeps the constraints: no framework, no CDN, air-gapped. The server serves `/app/*` from that directory with correct MIME types, and `ui_html.ts` shrinks to the shell HTML. The doc's React/TanStack stack is deliberately not adopted, because the local-first and no-build constraints outweigh it. The existing hand-rolled column virtualization is kept and moved into `web/board.js`.

**Visual verification recipe (every UI task).**

1. Seed with `node scripts/seed_project.mjs chronicle`, then run `sekhemet serve --repo <seeded>`.
2. Open `http://127.0.0.1:4040` in the Browser pane at 1440×900, 1024×768 and 375×812 (`resize_window`), in both themes (`t`).
3. Screenshot, then compare against the matching mockup in `docs/design/mockups/`.
4. Check the task's keys with the keyboard only.
5. Run `read_console_messages` with `onlyErrors`; the result must be empty.

### Phase 0: Foundations

| # | Task | Files | Acceptance |
|---|---|---|---|
| 0.1 | Vocabulary module: `parseTitle`, `stopReasonLabel`, `columnLabel`, `gateLabel`, `formatWait`, `formatTokens`, `KIND_LABELS` | `packages/ui/src/vocabulary.ts`, `packages/ui/tests/vocabulary.spec.ts`, `packages/ui/src/index.ts` | The spec covers every `ExecutionStopReason` and every fixture title suffix (`SPIDR: Rule & Path`, `Rule/Interface`, `Visual`, `Integration`). An unknown reason falls back to the humanised enum. |
| 0.2 | Token additions (`--on-accent`, `--on-state`, `--scrim`, tints, layout) plus a contrast test for the §3.9 pairs | `packages/ui/src/tokens.ts`, `packages/ui/tests/tokens.spec.ts` | The test asserts secondary ≥4.5 on all surfaces, state ≥4.5 on base and surface, state ≥3 on raised, accent ≥3 on all surfaces, and on-accent ≥4.5. |
| 0.3 | Icon sprite (all §3.4 icons) | `packages/ui/src/icons.ts`, test | Every icon is 24 viewBox with stroke-width 1.5 and has no `fill` except `dot`. The test enforces this. |
| 0.4 | Static asset serving: `/app/*.js` and `/app/*.css` from `packages/ui/web`, path-traversal safe, `/vocab.json` | `apps/harness/src/server.ts`, `apps/harness/tests/server.spec.ts` | `..` is refused. MIME types are correct. Every served `.js` passes `node --check`. |
| 0.5 | Shell skeleton: `ui_html.ts` becomes about 60 lines (shell markup and module script), plus `web/app.js` (hash router, store, SSE), `web/base.css` | `apps/harness/src/ui_html.ts`, `packages/ui/web/app.js`, `packages/ui/web/base.css` | The page loads with the sidebar and an empty view per route. The existing "served page parses" test still passes. |

### Phase 1: Shell and board

| # | Task | Files | Acceptance |
|---|---|---|---|
| 1.1 | Board enrichment: `display` on cards (title, kinds, statusLine, tone, enteredColumnAt from the last status event, waitsOn, evidence summary). Gate list comes from evidence rung results in execution order; no synthetic `parse`. | `apps/harness/src/server.ts`, `packages/ui/src/vocabulary.ts` (statusLine), test | `/api/board` hasher → `display.title` = "Implement canonical JSON and SHA-256 hash chaining", `kinds` = ["rules"], `statusLine` = "Types failed · 3 errors". |
| 1.2 | Sidebar and topbar, with status footer (live, ledger, memory, model) and the four shell bars | `packages/ui/web/shell.js`, `packages/ui/web/shell.css` | Matches the `board.html` chrome in both themes. Killing the server shows Reconnecting, then Offline within 10s, and actions disable. |
| 1.3 | Tile component (all §2.5.1 states) | `packages/ui/web/tile.js`, `packages/ui/web/board.css` | Matches the `board.html` tiles. No uppercase text on screen. Axe-style manual check: the pips have `aria-label`s. |
| 1.4 | Board columns: headers with limits and bars, collapsed rails, Parked and Closed visible, empty copy, per-tile patching from SSE (no full re-render) | `packages/ui/web/board.js` | Parking a card via curl shows it in Parked within 1s, with scroll position preserved. 500 synthetic cards scroll without jank (Performance panel shows no long tasks over 50ms). |
| 1.5 | Keyboard core: `h/j/k/l`, `g`-chords, `?` cheat sheet, `Esc` stack, `t` theme | `packages/ui/web/keys.js`, `packages/ui/web/cheatsheet.js` | Every §2.5.12 key works on Board with the mouse unplugged. |
| 1.6 | Peek drawer (`Space`) | `packages/ui/web/peek.js` | `Space` on hasher shows the gates and 3 failures. `Esc` returns focus to the tile. |
| 1.7 | Palette v2 (groups, fuzzy, shortcuts, card actions) | `packages/ui/web/palette.js` | `⌘K` "hash" ranks the hasher first. `>acc` offers Accept for the focused card. |

### Phase 2: Review

| # | Task | Files | Acceptance |
|---|---|---|---|
| 2.1 | `GET /api/gates`, `GET /api/cards/:id` (with attempts), `?attempt=` on evidence | `apps/harness/src/server.ts`, test | Hasher returns 2 gates in order. `empty: true` when the hash equals `e3b0c442…`. |
| 2.2 | Review layout: queue groups, selection, `j/k`, empty state | `packages/ui/web/review.js`, `packages/ui/web/review.css` | Matches `review.html` at 1440 and 1024. |
| 2.3 | Gates strip, failure blocks, protected-file warning | `packages/ui/web/gates.js`, `packages/ui/web/failures.js` | Hasher shows *Types ✕ 3* and the protected-test warning. Hovering a segment shows the first errors. |
| 2.4 | Diff viewer: parse the unified diff, grouping, gutters, inline annotations, `n/N`, `u` | `packages/ui/web/diff.js`, `packages/ui/web/diff.css`, `packages/ui/tests/diff_parse.spec.ts` (parser exported from `vocabulary`-style pure module) | Hasher: `src/hasher.ts` under Implementation, `tests/hasher.spec.ts` collapsed under Acceptance tests, and annotations after lines 25, 58 and 59. |
| 2.5 | Triage bar: Accept with grace and undo, Send back composer with quick notes, Park popover, toasts, read-only and offline handling | `packages/ui/web/triage.js`, `packages/ui/web/toast.js` | `A` on iface merges and the toast shows the sha. `R` with an empty note blocks. After `R` plus a note, a new line appears in `playbook_candidates.jsonl`. `Z` within 3s cancels with no POST (network panel). |
| 2.6 | Facts rail (Done when, Run, Scope, Provenance) plus the empty-contract warning | `packages/ui/web/facts.js` | Matches `review.html`. |

### Phase 3: Card view and live steps

| # | Task | Files | Acceptance |
|---|---|---|---|
| 3.1 | `GET /api/cards/:id/transcript`, `GET /api/events?card=&since=&limit=` | `apps/harness/src/server.ts`, test | Hasher returns 8 steps, and step 8 has `stopReason` `oscillation_detected`. |
| 3.2 | `card/step` ledger event from the runner | `packages/loop/src/card_runner.ts`, `apps/harness/src/execute.ts`, test | A queue run appends one `card/step` per turn. The hash chain stays valid. |
| 3.3 | Card view shell and tabs, Evidence tab (reuses Review parts) | `packages/ui/web/card.js` | `Enter` on a tile opens `#/card/<id>/evidence`. `1–5` switch tabs. |
| 3.4 | Steps tab: live follow and loop annotation | `packages/ui/web/steps.js` | Matches `card.html` Steps. While a card runs, new steps append with no animation, and auto-follow pauses on scroll-up. |
| 3.5 | Plan, Thread, Files tabs | `packages/ui/web/plan.js`, `packages/ui/web/thread.js`, `packages/ui/web/files.js` | The return note appears as a quote in Thread. |
| 3.6 | Running tile status from `card/step` (*Step 5 of 32 · editing src/hasher.ts*) | `packages/ui/web/tile.js`, `apps/harness/src/server.ts` | Visible during a real `sekhemet queue`. |

### Phase 4: Runs, Ledger, Machine, Playbook

| # | Task | Files | Acceptance |
|---|---|---|---|
| 4.1 | Run history write plus `GET /api/runs[/:id]` | `apps/harness/src/execute.ts`, `apps/harness/src/server.ts`, test | Two queue runs show two rows. The old `/api/queue` still works. |
| 4.2 | Runs view (headline, timeline, table, stop breakdown) | `packages/ui/web/runs.js`, `packages/ui/web/runs.css` | Matches `runs.html`. The timeline widths sum to 100%. |
| 4.3 | Ledger view (sentences, filters, detail, integrity) | `packages/ui/web/ledger.js` | Tampering a row in the SQLite file shows the red bar and disables Accept. |
| 4.4 | `GET /api/machine` plus the SSE `machine` event | `apps/harness/src/server.ts`, test | The level changes when `classifyMemoryPressure` crosses 0.85. |
| 4.5 | Machine view | `packages/ui/web/machine.js` | The skills warning shows its fix hint. |
| 4.6 | `GET /api/playbook` plus the Playbook view (read-only) | `apps/harness/src/server.ts`, `packages/ui/web/playbook.js` | 5 Chronicle rules. Candidates appear after a send-back. |

### Phase 5: Later

- Inbox and decision requests, which need planner persistence plus `/api/decisions`.
- `POST /cards/:id/run` (Retry with planner).
- Promoting playbook candidates.
- Mobile triage polish.
- Dependency lines overlay.
- Bundled fonts.
- Sparklines.
- Master board, Registry and Goals once their models exist.
- difftastic structural intent grouping.
- Backend data fixes found in recon, to be flagged to their owners:
  - The planner should store `slice` on `CardRecord` instead of in the title.
  - Fixture `cards.json` titles should drop the `(SPIDR: …)` suffix once `slice` exists.
  - `gatesConfigSha256` must hash the real `gates.toml`; the preview hashes an empty file.
  - `suggestedFixFiles` should not point at protected tests.
  - `bounds` should exclude staged acceptance tests.
  - `canvas.ts` `COLUMN_ORDER` should include `planning` and `parked`.
