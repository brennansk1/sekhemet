# Domain 13: Dashboard and design system (Phase A review)

*Read-only review, 2026-09-22. Worktree `harness-definition-done-4d9161` @ 7944e9f. I checked the code and also looked at it running: `serve` against `/tmp/claude-501/suite/chronicle` (6 cards, one in progress) at 1440×900 and 800×600, reading `/api/board` directly. Paths are relative to the repo root.*

**Summary.** The dashboard is a capable **review instrument**, and it already has most of a Linear-style data layer (priority, points, labels, epic, cycle, assignee, saved views, swimlanes, list, bulk edit). It doesn't **look** like a professional board because the tile and the column model show the machine's state first and the team's fields second. Nothing here needs a rebuild. What it needs is a presentation-layer mapping, a better tile, and a Learn layer.

---

## 1. Positioning

**Developers (familiar board).**
- *Works:* the Review surface (gates strip, grouped diff, `A/R/P` triage). A List view with Linear columns (Priority, ID, Title, State, Epic, Cycle, Points, Labels, Assignee, Due, Updated; `packages/ui/web/list.js:29-40`). GitHub-Projects filter syntax and saved views (`viewbar.js:32-38`, `pm.ts:436-518`). Swimlanes by epic, assignee, priority or cycle (`viewbar.js:40-46`, `lanes.js`). Bulk edit (`bulk.js:23`). Flow Insights. The keyboard model.
- *Fails:*
  - The tile's main line is harness state. Ready cards read "Ready · 40-step budget" (`vocabulary.ts:615,625,631`).
  - Row 1 leads with SPIDR "kind" tags (Contract/Rules/Wiring, `tile.js:8-16`, `170`) where a pro board shows type, epic and assignee.
  - Columns are the nine-state machine (`vocabulary.ts:73-104`). Done is forced to a rail below 1600px (`board.js:99`), and Verify and Planning rail when empty (`board.js:35`).
  - There are no issue keys: `shortId` strips to slugs like `api` and `ledger` (`vocabulary.ts:359-365`).
  - You can't create a card in the UI. `c` shows a toast pointing to the CLI (`board.js:580-581`), and the empty board says to run `sekhemet plan` (`board.js:355`).

**Beginners (learn the practice).** There's teaching material, but only as scattered seeds and there's no layer:
- Per-column purpose copy (`COLUMN_EMPTY`, `vocabulary.ts:106-116`).
- The Review WIP tooltip that derives the limit (`board.js:111-114`).
- Insights charts titled as questions ("What is getting old?", "Where do queues form?", seen live).

Nothing explains *why* a WIP limit, thin slicing or Done-means-accepted matter. Renaming SPIDR to Contract/Storage/Flow/Rules/Research (`vocabulary.ts:21-42`) also hides the vocabulary a learner would look up. The claims table's "Not built" is accurate.

**Non-developers (talk to the PM).**
- *Works:* `#/pm` is a clean chat surface with starter prompts "Standup / What's at risk this week? / Plan the next cycle" (`pm_thread.js:252`), and its first appearance follows NAMING (`shell.js:11-18`).
- *Fails:*
  - It's one of 13 nav items among Ledger, Machine and Registry (`shell.js:6-28`).
  - The default route is Review or Board (`app.js:52-53`), never the PM.
  - The composer footer says "The Worker is starting a card. Sending pauses it at the next step while Seshat loads (about 40s)", which is operator language.
  - No route starts a new project.
  - `/api/standup`, `/api/goals` and `/api/signals` exist (`apps/harness/src/wave2_server.ts:282-297`), but no page renders them. The only client is `wave2_server.spec.ts:110-112`.

### Gap table against Jira / Linear / GitHub Projects

| Convention | State | Evidence | Where it would live |
|---|---|---|---|
| Issue key (`CHR-12`) | **Missing** | `shortId` slug, `vocabulary.ts:359` | kernel: project key + sequence; `shortId` |
| Type icon (story/bug/task/epic) | **Missing** | `tier` exists (`kernel/src/types.ts:1,142`), removed from UI by FRONTEND §2.3; kind tags shown instead | `icons.ts` + tile row 1 |
| Priority glyph | Present | `marks.js:9-12`, `tile.js:168`; shows "No priority" dashes on every unset card (live) | hide when 0 |
| Assignee avatar | Partial | field `types.ts:194`, list column, grouping, bulk; **not on tile** | tile row 1, right |
| Estimate / points | Partial | `tile.js:169` when set; step budget shown instead | tile; budget → Facts/peek |
| Epic name/colour | Partial | `epicId`, epic lanes (`lanes.js:21-28`), list column; **not on tile** | tile row 3 chip + epic token set |
| Labels | Present | `marks.js:14-23` | — |
| Standard columns | Partial | 9 states, `vocabulary.ts:73`; the professional mapping exists **only in export**: `JIRA_STATUS` (`apps/harness/src/integrations.ts:274-284`: planning→To Do, verify+review→In Review, parked→On Hold) | a `boardColumn(status)` in `vocabulary.ts` |
| Labelled navigation | Partial | labels ≥1280px; icon rail below (`shell.css:453-463`), which is what the audit saw | grouped nav |
| Swimlanes | Present | `lanes.js` | — |
| Backlog list / ranking | Partial | List view + in-column reorder (`reorder.js`); no ranked backlog or sprint-planning split | `#/backlog` |
| Cycles / sprints | Present | cycle header with a linear-pace tick (`viewbar.js:296-335`) | — |
| Roadmap / timeline | **Missing** | — | new view over epics + due dates |
| Story map | **Missing** | claims table | new view (epics × SPIDR slices) |
| Burn-up / burn-down | **Missing** | claims table; `/api/goals` unused | Insights + cycle header |
| Blockers with causes | Partial | dependency "Waits on" (`vocabulary.ts:621-625`, `tile.js:131`); **`blockedReason` (`types.ts:199-200`, "shown on the board instead of silence") is never rendered**: zero hits in `packages/ui` | tile row 3 + red flag |
| WIP limits | Partial | header `n / limit` (`board.js:106-131`). Live `/api/board` returned `review: 7708` (median review time ≈ seconds in automated runs, `board/src/board_service.ts:207-222`), which `LIMIT_SHOWN = 20` then hides (`board.js:37,108`). **The Review limit is effectively invisible.** | board domain fix + UI floor |
| Quick create | **Missing** | `board.js:580` | tile "+" and `c` → Seshat or form |
| Flow metrics (CFD, cycle time, aging) | Present, above par | `insights.js` | — |

## 2. Drift

| Documents | Code |
|---|---|
| NAMING keep list: "Working · Checking · Done · … Closed" (`NAMING.md`, Work row). FRONTEND §2.3 maps In Progress→**Working**, Verify→**Checking**, Rejected→**Closed** | Code follows HARNESS_DESIGN "One name per state" (In Progress/Verify/Rejected, `vocabulary.ts:85-104`). But `shell.js:243` still says "wait in **Checking**", and `evidence.js:98,151` falls back to "Working". NAMING and FRONTEND are stale, and the code breaks its own rule twice. |
| HARNESS_DESIGN UI: `@tanstack/virtual` dual-axis; WebSocket `ws://127.0.0.1:4040/stream` | Hand-rolled `virtual.js` + `board.js:242-288`; SSE `/api/stream` (`app.js:188`). FRONTEND Part 4 made this decision; HARNESS_DESIGN never updated. |
| HARNESS "A navigation item for a view with nothing in it is hidden" (Views table: Runs, Playbook, Graph, Registry, Workspace, Insights, Integrations are Progressive) | Only Inbox has a `when` (`shell.js:9`); the other 12 are always shown. |
| HARNESS token table: fail `#C9503F`, Sand accent `#9A6E14` | `tokens.ts:49,67`: `#D2614F`, `#8E6512` (raised for AA; the code is right). |
| HARNESS "Card Tile: … budget progress bar, class chip, difficulty" | This is the anatomy the owner now rejects. FRONTEND §2.5.1 + PM_DESIGN §3.1 are the real spec. |
| FRONTEND §2.4.2 / §2.5.1: "no drag and drop in v1" | `reorder.js` implements drag-to-reorder within a column (PM_DESIGN B11). Fine, but FRONTEND is stale. |
| `canvas.ts:4` `COLUMN_ORDER` omits `rejected`; FRONTEND Phase 5 still lists it as a TODO | Moot: it's dead (see §3). |
| `wave2_server.ts:28` "the seven live signals" | Test asserts 6 (`wave2_server.spec.ts:112`). |
| Kernel `blockedReason` doc comment | Never displayed. |

## 3. Dead and duplicated code

**Web modules.** An import-graph walk from `app.js` reaches all 60 `.js` files (there's also `boot.js`, linked from `ui_html.ts:52`). There are **no orphan modules**.

**Dead in `packages/ui/src`:**
- `canvas.ts` (`VirtualCanvasManager`, `COLUMN_ORDER`; 172 lines) is referenced only by `tests/ui.spec.ts:3,8,93`. The page uses `web/virtual.js`, so by rule 3 of the plan this is dead. `types.ts` (canvas types) goes with it.
- **Endpoints with no client other than tests:** `/api/goals`, `/api/standup`, `/api/signals` (`wave2_server.ts:282-297`), `/api/workspace` and `/api/assumptions` (`rest_extra.ts:108,236`), `GET /api/recurring`. These are **uncertain**: the MCP server or CLI may reach the same stores directly. Their data is exactly what burn-up and non-developer status need, so wire them rather than cut them.

**Duplication:**
- **Status → column label, four copies:** `vocabulary.ts:93`, `insights.js:27-34` (`CFD_LABEL`), `integrations.ts:276-284` (`JIRA_STATUS`), and `pm.ts:871` `CFD_KEYS`.
- **SPIDR title stripping, two copies:** `vocabulary.ts:44` `SPIDR_SUFFIX` vs `integrations.ts:285` `cleanTitle`.
- **HTML escaping, three copies:** `dom.js:7`, `shots.js:49`, `pm.ts:306` `escapeHtml`.
- **Small helpers re-declared per view:** `titleOf` ×4 (graph, ledger, playbook, runs), `ago` ×2, `clock` ×2, `when` ×3.
- **CSS organised by build wave, not by component:** `board.css` + `board2.css` (1,681 lines) + `wave2.css` + `views.css`, 6.8k lines in 9 sheets. `board2.css` re-opens `.tile` and `.r1`.
- **Server routes split by build wave too:** `server.ts`, `wave2_server.ts`, `rest_extra.ts`, `pm_api.ts`.

## 4. Complexity hotspots

| File | Lines | Issue |
|---|---|---|
| `apps/harness/src/server.ts` | 1,261 | `startDashboardServer` is one ~1,045-line closure (`:216-1261`) with 21 inline `if (url…)` routes, plus the board enrichment (`:392`). The single worst file in the domain. |
| `packages/ui/src/pm.ts` | 1,338 | Grab bag: priority, markdown, the filter language, cycle stats, CFD, capability rows, learned rules, roster. "pm" names none of it. |
| `packages/ui/src/vocabulary.ts` | 1,145 | Coherent, but `statusLine`/`describeCard` (`:611-747`) encodes the tile's anatomy. This is the function the redesign changes. |
| `web/board.js` | 744 | Virtualization, culling, rails, pinning, keys, tooltips and mounting all in one module-level `ui` singleton. |
| `web/integrations.js` | 560 | A hard-coded catalogue plus a Now/Next/**Later roadmap** (10 entries) inside the product. |
| `web/insights.js`, `pm_thread.js`, `viewbar.js` | 556 / 553 / 534 | Hand-drawn SVG charts with no shared primitives; a thread mounted twice; filters + views + cycle header in one module. |

## 5. Test quality (DEFINITION_OF_DONE §2)

- **`packages/ui/tests`** (7 specs, 79 `it`, ~320 `expect`) is good where it exists. `vocabulary.spec.ts` (26 tests; I ran it and it passes) and `pm.spec.ts` (31) use exact equality, with some negative cases ("unknown reason falls back"). There are few trivial assertions (about 6 `toBeTruthy/Defined` in total). `ui.spec.ts` spends 2 of its 5 tests on the dead `VirtualCanvasManager`.
- **The ~60 web modules have almost no behavioural tests.** Only three pure helpers are imported by tests: `diff_parse.js`, `reorder_logic.js`, `review_parse.js`. The server spec checks every module only for **syntax** (`node --check`, `apps/harness/tests/server.spec.ts:92-130`), plus a regex that no template interpolates `card.title` (`:180-187`). Nothing tests:
  - which columns render
  - what a tile shows
  - whether the nav hides empty views
  - whether Accept is disabled when the ledger is altered
  - keyboard paths
  - the 7708 WIP masking

  Visual verification is a manual recipe (FRONTEND Part 4). Against DoD §2B's "two negative cases per happy path", the dashboard is essentially **untested at the behaviour level**. There is also no a11y or contrast check of the rendered DOM; only `tokens.spec.ts` checks contrast.
- `wave2_server.spec.ts:111` asserts `String(standup.text)).toBeTruthy()`, which is a §2C trivial assertion.

## 6. Senior judgement (ranked by impact)

1. **Split "state" from "column".** Keep the nine stored states and their gates (HARNESS lifecycle). Render **five professional columns**, with the machine state as a **status badge** on the tile.
2. **Rebuild the tile around professional anatomy**, and move harness telemetry (steps, budget, kind) into peek and Facts.
3. **A Learn layer**, off by default and one key away.
4. **A non-developer front door**: a status page from the unused `/api/standup` + `/api/signals`, and PM-first nav for people who aren't developers.
5. **Story map, burn-up, roadmap** as views over data that already exists (epics, cycles, estimates, goals).
6. **Pay down the structure while touching it**: split `server.ts` routes by resource, one label map, delete `canvas.ts`, and consolidate the wave-named CSS and server files.
7. **Behaviour tests for the web layer**: extract more pure `*_logic.js` (as `reorder_logic.js` does) and test columns, tile model and nav with exact values.

### (a) Card anatomy and column model

| Column | States inside | Status badge on tile (colour = state token) |
|---|---|---|
| **Backlog** | backlog | — |
| **To Do** | ready, planning | `Planning` (pencil) when planning; `Blocked · waits on X` |
| **In Progress** | in_progress, verify | `Running step 5/40` (lapis) · `Checking gates…` · `Types failed · retrying` (red) |
| **In Review** | review | `4/4 gates ✓ · waiting 2h` (green; amber >2h). The WIP limit sits here, as in Kanban. |
| **Done** | done | `Merged ba1338e` |
| *On Hold* (shown only if non-empty) | parked | `Paused for memory`, or the user's note |
| *Won't Do* (filter only) | rejected | — |

This is the same mapping `integrations.ts:276-284` already uses for Jira export, so the board and the export would finally agree. The gate stays meaningful:
- Verify still blocks entry to In Review, because that is a state transition, not a column.
- A card *failing* in verify shows red inside In Progress. That matches how pro teams see "CI red on my PR".
- A toggle **"Show pipeline stages"** (or `⇧V`) splits In Progress and To Do back into the nine machine columns for operators.

The one decision to settle with the owner is whether Planning belongs in To Do or In Progress. I recommend To Do: nothing is being built yet.

**Tile (88px kept):**
- Row 1: type icon · `CHR-12` key · (right) points · assignee avatar (Worker = a plain "W" monogram; a person = initials)
- Row 2: title
- Row 3: priority glyph (hidden when none) · epic chip (colour from an 8-hue epic token set; muted, since chrome stays neutral) · up to 2 labels
- Row 4: status badge (the current `statusLine`, minus "N-step budget") + gate pips when relevant; a red **blocker flag with its cause** (`blockedReason` or `Waits on X`)

The step budget bar shows only while In Progress. Kind (SPIDR) moves to peek/Facts, *or* becomes the "type" icon for learners (see b).

### (b) The Learn layer

- **What it teaches:**
  - Why each column exists and what moves a card.
  - WIP limits and Little's law, from their own numbers.
  - Thin slicing (SPIDR) and INVEST readiness.
  - Definition of done = gates + a human accept.
  - Estimation in points vs. time.
  - Cycles, and reading the burn-up and CFD.
  - Why review is the bottleneck.
- **Where:** a `?`-circle "Why?" affordance that shows only when Learn is on:
  - on column headers ("In Review holds at most 3 because you review ~60 min/day…", from the existing tooltip)
  - on the WIP bar, the gate pips, the points field and each Insights chart
  - on Seshat's proposals ("I split this Path-first because…")

  Plus a *Learn* side panel with 8–10 short lessons, each linked to the live element and to the external canon (Kanban Guide, INVEST, SPIDR).
- **Staying out of an expert's way:**
  - Off by default once a user has accepted N cards, or it's asked at first run ("New to team boards?").
  - A single toggle in the sidebar footer and a `L` key, stored per browser.
  - It adds **no** layout in the off state: a single `data-learn` attribute on `<html>`, with `.why{display:none}` unless it's set.
  - Content lives in one pure module (`learn.ts`, like `vocabulary.ts`) so it's unit-testable and reusable by Seshat.

### (c) Smallest first slice that makes the board feel familiar

One card, 1–3 files, under 200 LOC:
1. Add `BOARD_COLUMNS` (five professional columns → member states) and `boardColumnOf(status)` to `vocabulary.ts`.
2. Group by it in `board.js` `byColumn` (`:88`), with the machine state kept as the tile's status text.
3. Drop "· N-step budget" from `statusLine` for backlog and ready.
4. Hide the "No priority" glyph.

Tests use exact values in `vocabulary.spec.ts` (every state maps to exactly one column; `verify` failing → In Progress + fail tone). This removes the two things the audit saw first (strange columns, "40-step budget"). Issue keys and type icons come next; they need a kernel field.

## 7. Verdict per module

| Module | Verdict |
|---|---|
| `src/vocabulary.ts`, `tokens.ts`, `icons.ts` | **Keep**. Refactor `statusLine`/`describeCard` for the new anatomy; add epic hues and type icons. |
| `src/pm.ts` | **Refactor**: split into filter, metrics and PM formatting. |
| `src/canvas.ts` (+`types.ts`) | **Cut**. It's dead; cutting needs the owner's sign-off. |
| `web/board.js`, `tile.js`, `lanes.js`, `shell.js` | **Refactor**: column model, tile anatomy, grouped and progressive nav; extract testable logic. |
| Review, evidence, gates, diff, triage, card tabs, list, viewbar, fields, bulk, palette, keys | **Keep**. Review is the strongest surface. |
| `insights.js`, `pm_*.js` | **Keep**; add burn-up, a non-developer status mode and a "Start a project" entry. |
| `integrations.js` | **Refactor**: move the roadmap out of the product. |
| graph, registry, workspace, machine, ledger, runs, playbook | **Keep**, behind progressive nav. |
| CSS (9 sheets) | **Refactor**: per-component files. |
| `server.ts`, `wave2_server.ts`, `rest_extra.ts` | **Refactor** (strangler): a route table by resource; wire goals, standup and signals. |
| `dashboard_api.ts`, `ui_html.ts` | **Keep**. |

---

## Top 5 changes

**1. Professional column model with gate states as badges.**
- *What:* five columns (Backlog / To Do / In Progress / In Review / Done, plus On Hold when non-empty) over the nine stored states, and a "pipeline stages" toggle.
- *Why:* the audit found Ready|Planning|In Progress|Verify|Review|Done with Verify and Done collapsed (`vocabulary.ts:73`, `board.js:35,99`). The mapping already exists for export (`integrations.ts:276-284`), so the board and Jira currently disagree.
- *Effort:* S (slice c) → M with the toggle.
- *Risk:* operators lose at-a-glance Verify. The toggle mitigates it, and the failing-verify red badge keeps it visible.
- *How measured:* a spec asserting the exact state→column table. A live check at 1440 shows Done as a full column and no rails for gated states. A 5-minute "name the column" test with one Jira user.

**2. Professional tile anatomy.**
- *What:* key, type icon, assignee, points, epic chip, priority, status badge and blocker cause. Budget and kind move to peek.
- *Why:*
  - "40-step budget" comes from `vocabulary.ts:615`.
  - Kind tags lead row 1 (`tile.js:170`).
  - Assignee and epic exist in data (`types.ts:189-194`) but not on the tile.
  - `blockedReason` is never rendered.
- *Effort:* M (the tile plus a kernel issue-key field, which crosses into domain 2).
- *Risk:* 88px height and virtualization (`board.js:40`); keep 4 rows.
- *How measured:* a `describeCard` exact-value spec for each of the 9 states. No internal term (`step budget`, SPIDR kind) on the board surface, checked by a grep test like the existing escape test.

**3. The Learn layer.**
- *What:* a `learn.ts` content module, `data-learn` "Why?" affordances on columns, WIP, gates, points and charts, and a lessons panel. Off for experts.
- *Why:* the claims table says "Not built". Only seeds exist today (`COLUMN_EMPTY`, `board.js:111`, the Insights questions).
- *Effort:* M.
- *Risk:* clutter or a condescending tone. Mitigate with zero DOM cost when off and one toggle.
- *How measured:* a spec that every column, gate and metric has a lesson; the off-state DOM has zero `.why` nodes; a beginner walkthrough in which a new user can explain WIP limits afterward.

**4. A non-developer front door on existing data.**
- *What:* a PM-first "Status" view: standup text, signals, cycle burn-up, "needs you". A role toggle makes it the default route. Seshat's copy is de-jargoned. There's a "Start a project" entry, even if it only seeds the conversation at first.
- *Why:*
  - `/api/standup`, `/api/signals` and `/api/goals` have no UI client (`wave2_server.ts:282-297`).
  - The default route is Review or Board (`app.js:52`).
  - The PM sits among 13 developer nav items.
- *Effort:* M.
- *Risk:* scope creep into project creation (domain 8). Keep it to a conversation entry.
- *How measured:* the endpoints gain a UI caller (reachability). A non-developer can answer "how is it going?" without leaving the page.

**5. Behaviour tests and structure for the web layer.**
- *What:*
  - Extract pure `board_logic.js`, `nav_logic.js` and `tile_model` and test them with exact values and negative cases.
  - One label map.
  - Delete `canvas.ts` (with sign-off).
  - Split `startDashboardServer` into a route table.
  - Surface the Review WIP limit with a sane floor, instead of `LIMIT_SHOWN` hiding 7708.
- *Why:* the ~60 modules have syntax-only coverage (`server.spec.ts:92-130`); a 1,045-line closure; four copies of the column labels.
- *Effort:* M–L (incremental, strangler).
- *Risk:* low if it's done only in files Phase B already touches.
- *How measured:*
  - Number of web modules with behavioural tests (3 today).
  - Cognitive complexity of `server.ts`.
  - Zero duplicate status maps (grep test).
  - The Review header shows a real limit on the suite repo.
