---
spec: dashboard
status: partial
audiences: [developer, beginner, non-developer]
code: [packages/ui/src/vocabulary.ts, packages/ui/src/tokens.ts, packages/ui/src/icons.ts, packages/ui/src/pm.ts, packages/ui/web/app.js, packages/ui/web/shell.js, packages/ui/web/keys.js, packages/ui/web/board.js, packages/ui/web/tile.js, packages/ui/web/review.js, packages/ui/web/decision.js, packages/ui/web/dag.js, packages/ui/web/sparkline.js, packages/ui/web/machine.js, packages/ui/web/pm_thread.js, packages/ui/web/proposals.js, packages/ui/web/insights.js, apps/harness/src/ui_html.ts, apps/harness/src/server.ts]
tests: [packages/ui/tests/vocabulary.spec.ts, packages/ui/tests/pm.spec.ts, packages/ui/tests/tokens.spec.ts, packages/ui/tests/icons.spec.ts, packages/ui/tests/diff_parse.spec.ts, packages/ui/tests/reorder.spec.ts, apps/harness/tests/server.spec.ts, apps/harness/tests/pm_api.spec.ts, apps/harness/tests/wave2_server.spec.ts]
changes: [P3, P4, P5, P11, P12, P13, T5, S3c, NEW-dashboard-1, NEW-dashboard-2, NEW-dashboard-3, NEW-dashboard-4, NEW-dashboard-5]
---

# The dashboard

## 1. Purpose

The dashboard is where all three audiences meet Sekhemet. For **developers** it is a board that reads like Jira, Linear or GitHub Projects and a review instrument that gets a decision in under a minute. For **beginners** it teaches the practice where it happens, through a Learn layer they can switch off. For **non-developers** it is a status page in plain words and a conversation with the project manager that can start a project — without a terminal. It serves the spine by making **the human the rate limiter** visible (Review WIP, back-pressure, *Needs you*) and by never letting the interface claim more than the evidence says. Behaviour behind the views lives in [planner-pm](planner-pm.md), [review-git](review-git.md), [design-stage](design-stage.md) and [integrations](integrations.md); the HTTP API is [runtime](runtime.md); PM shapes are [PM_CONTRACT](../PM_CONTRACT.md).

## 2. Behaviour

### 2.1 Stance

1. Every screen answers, in order: **What needs me? Can I trust it? What do I do?** That order sets the navigation, the default route and the hierarchy inside each view.
2. **State is colour; everything else is neutral.** Colour is reserved for the five state roles, and each is paired with an icon and words. Colour is never the only signal.
3. **Density over whitespace, evidence first, keyboard-complete, both themes first-class** (Basalt dark is the default; Sand light is tuned, not inverted). The theme is a choice kept per browser; the operating system's `prefers-color-scheme` does not pick it.
4. **Sentence case everywhere**; no all-caps letter-spaced labels. **Gold (`--accent`) appears in exactly four places**: the primary action (Accept), the active-nav indicator, the focus ring and the brand glyph.
5. **Every number has a unit and a basis** ("8 of 32 steps", "waiting 12m", "16.8k tokens in"). **Nothing is generic**: empty states say what a view is for and what fills it; errors say what failed, why, and what to do.
6. **Nothing the interface says outruns the evidence**: an empty gate contract, an altered ledger, a gate that did not run, a requirement whose tests pass without meeting their strength rule are shown as such. No model's confidence, and no model's claim that work is complete, is ever displayed.

### 2.2 Shell and navigation

1. **Grouped, labelled navigation** (sidebar ≥ 768 px), under the wordmark and a **project switcher** (*Chronicle ▾*, shown from the second project):

| Group | Items (route · chord) | Visible when |
| --- | --- | --- |
| Primary | **Status** `#/status` · `g s`; **Project manager** (*Seshat* as secondary text) `#/pm` · `g p`; **Review** `#/review` · `g r`; **Board** `#/board` · `g b`; **Insights** `#/insights` · `g i` | Always (Insights shows its "not enough data" state until 3 cards finish) |
| More (collapsible) | **Runs** `#/runs` · `g u`; **Dependencies** `#/graph` · `g d`; **Playbook** `#/playbook` · `g k`; **Integrations** `#/integrations` · `g n` | Runs: after the first completed run. Dependencies: when a card has `dependsOn`. Playbook: when the first rule or suggestion exists. Integrations: always (it is where one is connected) |
| System (footer menu) | **Machine** `#/machine` · `g m`; **Ledger** `#/ledger` · `g l`; **Registry** `#/registry`; **Workspace** `#/workspace` · `g w`; **Settings** `#/settings` · `g ,`; Theme; Keys | Registry: after the first bake-off. Workspace: from the second project |

   A view with nothing in it is **hidden, not empty**; the sidebar never shows a dead link. Items that count something show a count badge (Review: cards waiting; Playbook: rules awaiting approval). **Inbox** is merged into Review's *Needs you* group (its route stays and opens it).
2. **Widths.** ≥ 1280 px: sidebar 216 px. 1024–1279 px: a 176 px sidebar that **keeps its labels** (no icon-only rail; the `--rail-w` token is retired). < 768 px: no sidebar; a **bottom tab bar — Status · Review · Board · PM** — with 48 px targets. Topbar 44 px (16 px padding, 12 px gaps): view title, crumb, scope filters, ⌘K, live status.
3. **Footer status**, text plus one dot: *Live* / *Reconnecting…* / *Offline since 14:42*; *Ledger intact · 236 entries*; memory; the Worker's state (*Worker paused after step 5 while Seshat replies*, lapis, while it is); who you are, in company-server mode (§2.15.7). Memory turns amber only when it changes behaviour (a pause is imminent or active), never as a permanent state.
4. **Shell bars** (one at a time, priority: ledger altered > offline > memory pause > review full > Worker paused for Seshat), each 32 px under the topbar:

| State | Trigger | Treatment |
| --- | --- | --- |
| Loading | Before the first board response | Skeleton of the real geometry, no spinner; after 3 s *Connecting to Sekhemet…* |
| Reconnecting | Stream error | Amber dot; content stays; actions enabled for 10 s |
| Offline | No stream for > 10 s and `/api/meta` fails | **Offline since 14:42:30.** *Showing the last known state. Actions are disabled.* `Retry`; timestamps freeze |
| Read-only | `meta.triage === false` | Triage replaced by one line saying how to enable it; `a/r/p` show the same line |
| Review full | `backpressureActive` | **Review is full (3 of 3).** *Finished cards wait until you clear one.* `Open review` |
| Memory pause | Level critical, or the last stop was `memory_pressure` | **Paused for memory: 94% used.** *Sekhemet stopped the Worker safely. Work resumes below 85%.* `Machine`; the running tile flips to *Paused for memory* |
| Ledger altered | Chain verification fails | Red, not dismissible: **Ledger altered at entry #7.** *An entry no longer matches its hash. Stop and inspect before accepting anything.* `Open ledger`. Accept is disabled everywhere with that reason |
| Worker paused for Seshat | `PmStatus.workerPaused` | **Worker paused after step 5 while Seshat replies.** `Open Seshat`. Lapis rule, not amber: nothing is wrong |

5. **First run and default route.** The first visit asks one question: *I write code · I manage the work · I'm learning*. It sets the default route and the Learn default — *I write code*: Review when its queue is non-empty, else Board, Learn off; *I manage the work*: Status, Learn off; *I'm learning*: Board, Learn on; the answer is kept per browser and changeable from the footer and Settings. With no answer, a person who has never accepted a card lands on Status.

### 2.3 Keyboard

1. Three tiers: **navigation and triage** (learned in a day), the **command palette** (`⌘K`/`Ctrl+K`; anything in it needs no shortcut, and a palette entry is the default for a new action), and **`g` chords**, one per *visible* view. A chord is the **first letter** of the view's name where that letter is free; where it is taken, the keymap names a fixed alternative: `g u` Runs, `g k` Playbook, `g n` Integrations, `g ,` Settings. The previous chords (`g a` PM, `g f` Insights, `g q` Runs, `g e`) keep working silently for one release; `g s`, `g p` and `g i`, which meant Integrations, Playbook and Inbox before, take their new meanings at once and the cheat sheet says so for one release.
2. **No destructive or surprising action has a bare single-key binding**: there is no bare `t` for theme; theme and Learn are toggled from the palette, the footer and Settings.
3. **The cheat sheet (`?`) is the specification**: it and the palette are generated from one keymap, and an action not in it has no shortcut. It fits a 900 px-high window (scrolling inside), in four columns: Global, Navigate, Cards, Review. Keys that do not apply to the current view are dimmed.
4. Keys are ignored while focus is in a text field, except `Esc` and `⌘↵`.

| Where | Keys |
| --- | --- |
| Global | `⌘K` palette (`>` commands, `#` cards; no match offers *Ask Seshat: <query>*) · `?` keys · `g` + letter · `⌘J` Seshat panel · `Esc` close/back |
| Board | `h/l` columns, `j/k` cards (cross lane boundaries; `h/l` stay in the lane) · `Space` (or double-click) peek · `Enter` open · `x` select · `c` new card · `v` board/list · `⇧V` pipeline stages · `/` filter · `⇧S` cycle grouping · `Home/End` column ends |
| Board and list, focused card or selection | `⇧P` priority · `⇧E` points · `⇧L` labels · `⇧C` cycle · `⇧A` owner · `.` any field · in menus `1–9`, `↑↓`, `↵` |
| List | `x` · `⇧J/⇧K` extend · `⌘A` all visible · `Esc` clear · shift-click range · `Space` on a group header collapses it |
| Review and card | `a` accept · `r` send back · `p` park · `z` undo accept (grace window) · `x` acknowledge the focused finding · `j/k` next/previous · `o`/`Enter` open card · `[` `]` attempts · `f` facts rail · `u` unified/split · `n/N` next/previous annotation · `Space` expand file · `1–5` card tabs |
| Composer | `↵` send · `⇧↵` newline · `@` mention a card · `Esc` back to the page |
| Proposals | `y` apply · `n` discard · `⇧Y` apply all in the group · `j/k` move |
| Decision request | `1–9` pick · `↵` answer |

### 2.4 Board

1. **Five professional columns over the nine stored states** (the same mapping the Jira export uses, so the board and the export agree; the names are [NAMING](../NAMING.md)'s):

| Column | Stored states | Status badge on the tile |
| --- | --- | --- |
| **Backlog** | backlog | — |
| **To do** | ready, planning | *Being planned* (pencil) · *Blocked · waits on X* |
| **In progress** | in_progress, verify | *Step 5 of 32 · editing src/hasher.ts* (running) · *Checking gates…* · *Waiting for the Reviewer* · *Types failed · retrying (rung 1 of 4)* (fail) · *Paused for Seshat · step 5 of 32* |
| **In review** | review | *4 of 4 gates passed · waiting 2h* (amber after 2 h). The Review WIP limit sits here |
| **Done** | done | *Merged ba1338e · 2h ago* |
| *On hold* (only when non-empty) | parked | *Paused for memory*, *Looping · parked*, *Decision needed*, or the person's note |
| *Won't do* (a filter, not a column) | rejected | — (split parents read *Split into 3 cards*) |

   Verify still gates entry to In review (a transition, not a column). **Pipeline stages** (`⇧V`) splits To do and In progress back into the nine machine columns for operators, named as stored (Backlog, Ready, Planning, In Progress, Verify, Review, Done, Parked, Rejected); the choice is kept per browser. Moving a card past a failing gate is never a board gesture: a gate override is a recorded human decision with a reason, made from the CLI or the API ([kernel](kernel.md)); the card view shows that it happened.
2. **Columns.** Fluid (`min 200px`, `max 300px`, 8 px gap; 8 px body padding, 16 px board padding). **Empty columns collapse into chips above the board** (*Done 4 ›*), never rotated rails; Done is a full column whenever it has cards. In review and On hold are pinned in view when the board scrolls horizontally. Cards in a column keep their recorded order (a fractional `order_key`, [kernel](kernel.md)), except In review and On hold, which sort by wait time, longest first.
3. **Column header** (36 px, 0 12 px padding): name · `count / limit` for WIP-limited columns · the column's points sum (*13 pts*) · a 2 px capacity bar (`--text-secondary`; amber at capacity; red over) · a Learn *?* when Learn is on · a `⋯` menu (sort by priority, wait time or recently changed; collapse). The In review limit is always shown with its derivation (*limit 3, from 60 review minutes a day at ~20 min per card*); no limit is hidden for being large. At capacity the header says, as visible text in its popover, *Full. The Worker holds finished cards until you clear one.*
4. **Tile anatomy** (88 px compact; 112 px comfortable adds a one-line spec excerpt and budget detail; width follows the column; 8/12 px padding, 4 px row gap, 6 px radius):

```
┌──────────────────────────────────────────┐
│ ◇ CHR-12              3 pts  JD  Worker  │ row 1: type icon · issue key · points · owner (a person's avatar) · delegate chip
│ Implement canonical JSON and SHA-256     │ row 2: title, 2-line clamp
│ ▮▮▯  Ledger  api  security  3 subtasks   │ row 3: priority glyph (hidden when none) · epic chip · ≤2 labels, then +n · subtasks
│ ✕ Types failed · 3 errors · 22h          │ row 4: status badge (icon + colour + words) · gate pips · work item age
└──────────────────────────────────────────┘
```

   - **Owner and delegate.** A person stays the card's **owner** and may have an avatar (a 20 px monogram of their initials); the Worker, or another person, is the **delegate** that builds it, shown as a **text chip** (*Worker*, or the person's name) — the convention Linear, Cursor, Codex and Copilot use. **A role never has an avatar** ([NAMING](../NAMING.md)). The fields are [kernel](kernel.md)'s (`owner`, `delegate`); the export mapping is [integrations](integrations.md)'s.
   - **The status never truncates its cause**; it may wrap to two lines inside the 88 px by dropping row 3's labels.
   - **Blocked.** A card with a `blockedReason` or an unfinished dependency carries a **blocker flag in the fail tone, with the link icon and the word *Blocked*** and its cause (*Blocked · waits on @hasher*); colour is never the only signal.
   - One badge is icon + colour + words, and **never combines a stage with a failure mark** (no "✕ Planning"): it says what is true now (*Needs a new plan*).
   - **Priority glyph**: a fixed 12 px slot; three rising bars (1–3 lit, unlit bars in `--border-strong`, stroke 3 so the icon test holds) for Low/Medium/High in `--text-secondary`, a boxed exclamation for Urgent in `--text-primary`; the shape, not colour, carries priority. No glyph for *No priority*; the list's Priority column is where priorities scan as a column.
   - **Epic chip** uses one of eight muted epic hues (chrome stays neutral). **Labels**: 11 px secondary text in a 1 px outline.
   - **Gate pips**: one 12×12 box per gate the card's evidence ran, in `gates.toml` order — ✓ passed, ✕ failed, – skipped, ring running, empty not run — with no letters, and **never a gate the evidence did not run** (no synthesised *Parse: pass*); the popover (focus or hover) lists each gate's name, state, duration and first error line.
   - **Step-budget bar** (2 px) only while In progress: secondary by default, lapis while running, amber ≥ 75%, red at 100%, with *8 of 32 steps*. Card kind (Contract, Flow, Rules…) and difficulty move to the peek drawer and Facts.
   - **Work item age** shows on every In progress and In review tile (Kanban Guide), turning amber past the 85th-percentile cycle time.
   - **Tile states**: hover `--bg-overlay`; focus a 2 px accent ring; selected (`x`) a `--border-strong` border and a checkbox; focus and selection are visibly distinct and can co-exist. Done tiles are secondary text with no bars.
5. **Moves between columns happen only through recorded, gated actions** (triage, decisions, proposals); there is no drag between columns. **Reordering within a column** (drag or keys) is allowed and is recorded as one event.
6. **Peek drawer** (`Space` or double-click, 480 px): gates, failures, outcome, *Done when*, kind and difficulty, owner, delegate and suggested accepters ([review-git §2.4](review-git.md)), a compact file list, and triage keys that work inside it. `Enter` opens the card view.
7. **Quick create** (`c`, or the `+` on a column): a one-line title and optional description that goes through the planner pipeline as a create proposal ([planner-pm](planner-pm.md)) and is shown for Apply. No path ends in "use the CLI".
8. **Live updates** patch only changed tiles, keyed by id; they never re-render the board or reset scroll, focus or an open drawer; a focused card that changes column keeps focus and is scrolled into view, and no other card scrolls; a tile that changed shows *just now* for 10 s; no motion. A change made through the API (a park by `curl`) appears within 1 s. **A reload rebuilds the same state** from `/api/board` and the stream's replay (`?since=`, `Last-Event-ID`; `server.ts:574-580`), so what a person sees never depends on having watched live.
9. **Scale.** Windowed columns and cards (an overscan of 3 cards) keep 500 synthetic cards scrolling with no main-thread task over 50 ms and under 50 MB of DOM memory. Swimlanes are not windowed (they are for filtered views).
10. **Board states:** *No cards yet* with a **Start a project** button (opens Seshat) and a secondary *or plan a feature* line; empty-column copy at the top of each column (Backlog *Ideas and split-off work.* · To do *Cards whose dependencies are done, and cards being planned.* · In progress *No Worker running.* · In review *Nothing waiting for you.* · Done *Accepted cards appear here.* · On hold *Nothing parked.*); *No cards match "Kind: UI"* with `Clear filter`; review full and memory pause as shell bars, with *Holding for review* on held tiles.
11. **View bar** (40 px, 16 px padding, 8 px gaps): `[Board | List]`, **View** menu (*All cards*, *Current cycle*, *Needs you*, *Urgent and high*, *Unestimated*, and saved views, each with its query in mono), filter chips, `+ Filter` (Priority, Label, Epic, Cycle, Owner, Delegate, Kind, State), the query box, **Group** (None, Epic, Owner, Priority, Cycle), a density toggle, and **Save view** (shown only when the filter differs; saves `{ name, query, group, layout }` per browser until a views endpoint exists, and the menu says *Saved in this browser*).
12. **Query language** (GitHub Projects syntax): `priority:urgent,high`, `label:api`, `epic:ledger`, `cycle:current|none`, `owner:@me|<name>`, `delegate:worker|<name>`, `assignee:` (an alias for `owner:`), `kind:rules`, `is:blocked|needs-you|running|unestimated`, free words on title and key, `-` to negate; terms AND, values OR; chips and text are two views of one filter object (`parseQuery` / `formatQuery`).
13. **Cycle header** (56 px, two lines, a 6 px progress bar) when a cycle is **in force** — marked active, or a planned cycle whose dates contain today — unless the filter points at another cycle or `cycle:none`: name, goal, dates, days left; one progress bar split by points into done (`--state-pass`), in progress (`--state-running`) and not started (`--bg-overlay`); a tick at the linear pace (elapsed days ÷ total days); *4 days left* turns amber with fewer than 2 days left and under 70% done (*Behind the linear pace by 5 pts*, in visible text on focus); unestimated cards count as 1 point and the header says how many (*2 cards unestimated, counted as 1 pt*); **Plan next cycle with Seshat** opens the panel with that prompt filled in, not sent.
14. **Swimlanes** by Epic (with its progress bar), Owner, Priority or Cycle; each lane header (32 px) has count and points; the *No epic* (etc.) lane is last; lanes collapse.
15. **List view** (`#/board/list`, `v`): a real table with columns Priority · Key · Title (with kind) · State · Epic · Cycle · Points · Labels · Owner · Delegate · Due · Updated; 36 px rows; the title fluid, other columns fixed, numbers right-aligned; group headers with count and points; headers are buttons (Tab-reachable) that sort, and a second click reverses (stable, priority as tiebreak); inline edits by click or key with an anchored menu — the **Labels** menu is a checkable list with a *Create label "…"* row; **Due** offers *Today*, *End of this week*, *End of the current cycle*, *No due date* and a date; edits are optimistic, revert on failure and say why; `externalRef` links to the issue. A selected row has a 2 px `--text-primary` left bar.
16. **Bulk bar** (48 px, bottom centre, 16 px from the bottom, radius 6, `--bg-overlay` with a 1 px `--border-strong` edge) with the selection's count and points: the field actions, **Park** (one reason, one park per card), **Ask Seshat** (the selection as mentions, not sent); one toast reports the result (*Set on 2 of 3. hasher: the server returned 409.*).
17. **Story map** (`#/board/map`): the backbone of user activities across in user order, the release slices as horizontal bands beneath (the first, the walking skeleton, marked), and each requirement in its slice with its state: **proven**, **passing, strength unmet**, **planned**, **unplanned**, **suspect** (revised since its cards or tests were linked) or **cut**, each an icon plus words ([planner-pm §2.15](planner-pm.md)). Cards keep their tiles and states under their requirement. The story map is a view of the board's cards, not a separate epic hierarchy. **Burn-up**: done points and total scope as two lines per cycle and per project, so scope growth is visible apart from velocity.
18. **Dependencies** (`#/graph`): cards laid out in layers by their longest dependency path (`dag.js`) with `dependsOn` edges; nodes are focusable, named elements (not inside an image), and the view is hidden when there are no edges.

### 2.5 Review

1. **Layout at 1440 px**: queue (296 px) · evidence (fluid, min 560 px, 24 px padding, 24 px between sections, 8 px heading to content) · facts rail (288 px); at 1024 px the rail becomes a *Facts* disclosure and the queue 248 px; on a phone the queue is a full screen and evidence opens with a fixed bottom bar of three 48 px buttons.
2. **Queue**: *Ready for review* (cards in Review, oldest first) and *Needs you* (parked cards, cards failed after the retry ladder, open decisions — the former Inbox —, slices at their appetite and proposed releases, longest wait first). Rows are 56 px (8/12 px padding): title (13/500, one line), then kind · state icon and short stop label · wait time (amber after 2 h) in 11 px secondary; a selected row has a 2 px `--text-primary` left bar on `--bg-overlay`. Each Review row shows the suggested accepters when the project has a `CODEOWNERS` file.
3. **Evidence column**, in order: breadcrumb and attempt selector (disabled when there is only one attempt); title; outcome line (*Passed on step 1 · 1.2s* or *Failed: Types, Tests · Looping on step 8*; *Built by Jane (person)* for a person-built card); **Reviewer findings** (§2.5.4a); the **gates strip**; **failures**; **changes**; *What the Worker tried* when the evidence carries abandoned hypotheses.
   - **4a. Reviewer findings**, attributed to *Reviewer* and its model id, titled with a count (*Reviewer · 1 unmet, 1 unclear*) and one line: *The Reviewer checked the diff against the card's criteria. It's advice, not a gate: Accept is yours.* Unmet findings first (fail icon and rule), then unclear (parked icon), then met, collapsed behind *n met*; each names its criterion and `file:line` (a link to the diff line) and can be acknowledged (`x`). Under them, the **coverage line** (*Reviewer read 3 of 3 files; 41 of 58 changed lines are cited by no finding*), with the uncited lines listed behind a disclosure. With no Reviewer, the unfilled-role reason ([review-git](review-git.md)); with no findings to show, the section is absent.
4. **Gates strip**: a segment per gate the evidence ran (32 px, 0 12 px padding) — icon, name, duration — in `gates.toml` order then derived gates (Size); failed segments get a red top rule and a count (*Types ✕ 3*); skipped ones say *Skipped because Types failed*. With **more than six gates**, gates are grouped by family with a count (*Security 4/4 ✓*), failing groups first, passing ones behind *+6 passed*; on a phone the strip is a vertical list. Focus or hover shows gate id and command in mono, exit code, the first three typed failures and *Show all*; click scrolls to that gate's failures; a passed gate opens its raw log once stored, and until then says *No output recorded for passed gates.* An empty gate contract (the empty-string hash) adds an amber **Gate contract empty** segment.
5. **Failure block**, one per typed failure (8/12 px padding, 8 px apart): gate icon, `file:line:col` linked to the diff line, the code (`TS2353`); the exact error excerpt in mono; *Expected / Actual* when present; the repro command with Copy; *Suggested:*; a warning when the suggested file is a protected test (*the fix belongs in the implementation*). Identical messages group (*3 × TS2353 in tests/hasher.spec.ts*).
6. **Diff viewer**: files grouped *Implementation* (in scope, **ordered by risk**: files with failures, then files with unmet or unclear findings, then by changed lines — never alphabetically; each file gets a *seen* mark once it has been on screen), *Acceptance tests* (collapsed under a one-line summary of what they assert, lock icon, *staged by Sekhemet · not written by the Worker*; each test's approval state when the depth profile requires one — *Approved by Jane · example table*, *Needs approval* — and each **superseded** base test beside its new version, [planner-pm §2.16–2.17](planner-pm.md)), *Outside scope* (expanded, red rule) and *Other*; sticky 32 px file headers with path, role, `+18 −0` and Copy path; old/new gutters; added and removed lines on tints with their `+`/`−` signs kept; inline annotation rows after the line a failure points at — a 2 px fail rule, gate icon and message, `role="note"` and focusable (`n/N`); unified or split (`u`); whitespace-only changes hidden with a toggle; files over 400 lines, lockfiles and generated files collapsed; a structural (difftastic) view when available.
7. **Screenshots**: for a visual gate, the baseline, the new capture and a pixel-difference overlay side by side (a slider between baseline and capture), and the images attached to the card; the pure pairing and pixel-diff logic is tested.
8. **Facts rail**: *Done when* (the criteria; neutral bullets unless the Reviewer judged them; with every gate passing and no Reviewer: *All gates passed. Criteria are checked by the acceptance tests.*); *Run* (steps, time, tokens, model, tool set, thinking policy and working method, built by); *Scope* (may edit; protected tests); *Provenance* (gate contract hash with the empty warning, checkpoint sha, evidence id, each with Copy).
9. **Triage bar** (52 px, 0 24 px padding, 8 px button gap, sticky under the evidence): **Accept `A`** (primary) is enabled only when the card is in Review, every blocking gate passed, triage is on, the ledger is intact, the person holds the Accept permission and may accept this card (independent accept, code owners — [review-git §2.4](review-git.md)), **every unmet or unclear finding is acknowledged and every Implementation file has been shown**; when disabled its reason is written beside it, never only in a tooltip (*2 findings to acknowledge · 1 file not yet shown*). **Send back `R`** (secondary) and **Park `P`** (ghost). A right-aligned hint shows `j k` · `Space` · `?`. For *Needs you* cards, Accept becomes **Retry with planner** once that endpoint exists; until then only Send back and Park.
10. **Accept**: `A` shows *Merging…* with a 3-second grace toast *Accepting "…"* `Undo Z`; `z` in the window cancels with no request sent. Then success *Merged to main as ba1338e* `Copy`, the row leaves and focus moves to the next; a refusal shows the server's message verbatim and the row stays.
11. **Send back**: an inline composer above the triage bar (not a modal): a required textarea *What should the Worker do differently?*; **quick notes** generated from the failures and the unmet findings (clicking inserts); *Suggest as a playbook rule* (on); `⌘↵` sends, `Esc` cancels; then *Sent back to Ready with your note* and advance.
12. **Park**: a popover with an optional reason and presets *Waiting on me*, *Needs a decision*, *Not now*.
13. **States**: loading (gates and diff skeletons, queue interactive); empty queue (a 24 px decorative glyph, *Nothing to review. Cards land here when every gate passes.* plus a count of Ready cards and a **Run them** button, not a command; the facts rail hidden); no evidence (*No attempts yet*, only Park); error inline with Retry; a card that changed state while open (*This card moved to In progress 3s ago.* `Reload`); offline and read-only per the shell.
14. **Decision request** (in *Needs you*; `decision.js`): the question (15/600) and its category; radio options, each with consequence, *Effort +6 steps / ~7k tokens*, *Risk: …* and a *Preview* disclosure (files, symbols, blast radius); the **Recommended** tag (neutral, not gold) with its rationale; the policy line (*If you don't answer by 16:00 (in 2h 14m), option B is applied.* or *If you don't answer, the card stays parked.* with a lock); the countdown updates each minute and turns amber under 15 minutes; destructive options have a red rule and an explicit confirm. An oracle disagreement ([planner-pm §2.17](planner-pm.md)) renders the same way, with the two sampled expected values as the options.
15. **Fast reviews.** A decision faster than 500 changed lines an hour is marked *fast review* in the ledger row and in Insights' review section; nothing is blocked ([review-git §2.2](review-git.md)).

### 2.6 Card view

`#/card/:id/{evidence,plan,steps,thread,files}` (`1–5`; tabs 32 px, the active one with a 2 px `--text-primary` underline — not gold, which is kept to its four places). Header (96 px): breadcrumb (with *3 subtasks* when it has children), title with kind, state pill with its sentence, owner and delegate, triage buttons (same rules as Review) and a `⋯` menu (Copy id, Open worktree path, View in ledger).
- **Evidence** — the Review composition, full width.
- **Plan** — spec; *Done when* with each criterion's id and approval; the requirements it traces to, with version and a *suspect* mark when revised since; *May edit* and protected *Acceptance tests* (as example tables where staged that way, with their approval state); budgets (steps, tokens, seconds as used/budget bars); difficulty as a 10-segment meter with routing (*Direct / Edit sketch / Split*) and the edit sketch when there is one; *Waits on* and *Unblocks*; the slice's rationale; the planner's repair plan for attempt 2+, read from the card's dossier ([worker-loop](worker-loop.md)).
- **Steps** — one row per step: tool calls (`write_file src/hasher.ts`) with their observation summaries, gate results, tokens and time right-aligned; loop detection annotated where it fired; the final row states the stop. Live steps append from `card/step` events with no animation, and the running step shows the model's output as it streams (`event: tokens`; NEW-dashboard-3); auto-follow pauses when scrolled up (*3 new steps ↓*); `write_file` rows expand to the written content.
- **Thread** — the card's ledger timeline in sentences (`/api/events?card=`, newest first, paged): created, moved, returned (note as a quote), parked, decisions, delegated, accepted with sha and whether the accept was independent.
- **Files** — path, role (*May edit* / *Protected test* / *Outside scope*), `+/−`, gate failures per file; a row jumps to the file in Evidence.
- Tabs with no data say so (*No steps yet. The Worker hasn't started this card.*).

### 2.7 Seshat: the panel and the full view

1. **Two places, one thread.** A right **panel** toggled with `⌘J` from any view: a 400 px dock from 1280 px (the view narrows; board columns relax to a 184 px minimum and the To do / In progress columns scroll beside pinned In review and On hold); a 380 px overlay from 1024 to 1279 px; hidden on `#/pm` and below 768 px (the bottom bar's PM tab opens the full view). Open or closed is remembered per browser. The **full view** `#/pm` has a 720 px reading column and a 288 px rail: *Open proposals*, *Worker* (state, step, paused), *What Seshat can see* (board snapshot time, last run, ledger head) and the three strongest *What Seshat has learned about you* statements, with *See all 4 and edit them in Playbook* and *Stays on this machine*.
2. **Header** (52 px): *Seshat · Project manager*, a plain monogram avatar (24 px rounded square on `--bg-overlay`, the letter *S* at 600 weight in `--text-primary`; no gold, face or gradient), and a **presence line** — *Replies in about a minute* when idle, the current phase with its timer when waiting (*Loading the project manager · 0:31*), so the state is visible when the thread is scrolled. **The model's id is not in the header**; it is in the header's details disclosure and on Machine.
3. **Messages**: yours right-aligned on `--bg-raised` (max 85%) with the time in 11 px secondary; Seshat's full-width prose under a one-line header; tool use and research steps as quiet, collapsed detail under the reply, prose first; a question the Worker asked (its `ask`) that Seshat answered appears in the same thread, labelled as the Worker's (*The Worker asked about @hasher*), never as yours (attribution is [kernel](kernel.md)'s); system lines centred at 11 px. Markdown is limited to paragraphs, lists, bold, code, fenced code and `###` headings, rendered by an escape-first renderer; links from model text render as text.
4. **Card chips**: `@card` in either direction renders state icon, key and title (32 characters); click peeks, `⌘`-click opens; **unknown ids render as plain mono text**. `@` in the composer opens a fuzzy card picker. **Cites** render as *Based on:* chips for cards, runs (to `#/runs/<id>`) and evidence (to the card's Evidence tab); research sources render as a numbered **Sources** list (http and https only, new tab, `rel="noopener noreferrer"`, host in mono; a source with no URL is plain text).
5. **Context chip** above the composer: *Looking at: Board · Cycle 12 · 2 filters* or *Looking at: @hasher*; `✕` drops it for the next message; it returns when you move. Sent as `context: { cardId?, view }`. It exists because context sent silently feels like surveillance, and no context makes a person repeat themselves.
6. **Composer**: grows 1–8 lines from a 44 px minimum; **starter prompts** when the thread is empty or idle 12 h — *Standup*, *What's at risk this week?*, *Plan the next cycle*, **Start a new project** — plus a contextual one (*Why did @hasher fail?* for a failed focused card; *Split @http* over 5 points). A **cost line** in plain words says what sending does: idle, *Seshat runs on this machine. Replies take about a minute.* (it may name the model in plain words); with the Worker running, *The Worker will pause after step 5 of 32 while Seshat answers (about 40s), then carry on.*; read-only: how to enable. No API paths, and no model id anywhere but the idle line.
7. **Proposal group** at the end of a reply (`--bg-surface`, 1 px `--border-subtle`, radius 6; header 36 px; each proposal 12/16 px padding): header *Proposed changes · 3 open* with *Discard all* and *Apply all ⇧Y* (*Apply 3 changes to 5 cards*). A **field diff** per field (24 px rows): the label (secondary, 96 px), the before value struck on the fail tint, an arrow, the after value (primary, 500 weight) on the pass tint; values as people read them (priority glyph and word, `3 pts`, cycle and epic names, *Worker* / *You*, `Sep 29`, *None*); labels diff as a set (`+ security − later`). Create and split show numbered new cards with kind, points and *waits on 1*; moves show *Ready → Backlog*; reorders show *Position 7 → 2 in Ready*; park shows the reason. States: *Open*; *Applied* (one line, pass check, *by you at 09:05*); *Discarded* (one struck line); *Stale* (amber rule, *@hasher changed after Seshat proposed this. Ask again.*, Apply disabled). *Apply all* stops at the first failure (*Applied 2 of 3. "Split @http" failed: card is in progress.*). Applied is final and says so. **Imports use the same component** (*Import from Jira CSV · 42 proposed changes*), and so do edits to the exported project documents coming back as proposals ([design-stage §2.3](design-stage.md)).
8. **Waiting is a procedure with times**, not a spinner. A pending block under Seshat's header shows rows (24 px; 12 px icons; times 11 px, right-aligned, tabular) and a total timer since the message was queued:

| Phase | Row | Detail |
| --- | --- | --- |
| `waiting_for_step` | **Pausing the Worker after step 5** | *Waiting for step 5 to finish. The Worker is never stopped mid-edit.* |
| `loading_pm` | **Loading the project manager · about 40s** | A 2 px lapis bar toward the ETA (`etaSeconds`); past it, *Taking longer than usual.* |
| `thinking` | **Thinking** | Elapsed; after 90 s *Long answers can take up to two minutes on this machine.* |
| `resuming_worker` | **Resuming the Worker** | *Step 6 starts next.* |
| `idle` | (block removed) | — |

   Completed rows get a pass check and their duration; the current row a lapis ring and a running timer (tabular, updated once a second — the text changes, nothing moves) and `aria-busy="true"`; future rows an empty circle in secondary. Under the rows, once: *Only one model fits in memory, so the Worker waits at a safe step boundary and continues from step 6 once Seshat has replied. You can keep working; the reply lands here.* Worker rows are omitted when nothing was running. The shell bar and footer say *Worker paused after step 5 while Seshat replies* (lapis, not amber); the running tile reads *Paused for Seshat · step 5 of 32*. A second message shows *Queued · Seshat answers in order*. An error shows *Seshat couldn't reply.* with the server text and `Retry` (same text and context). Offline freezes timers and disables the composer.
9. **Surface states**: *Seshat isn't on this server yet* (thread endpoint 404; composer disabled with the reason; the nav item stays); first conversation — a one-paragraph local introduction (*I'm Seshat, the project manager for Chronicle. I read the board, the runs and the ledger, and I propose changes you approve. I never change the board myself.*) then the starters; loading (three skeleton lines); thread error with Retry.

### 2.8 Status: the non-developer's home

`#/status` (`g s`; the phone's first tab):
1. A **sentence headline** in plain words from the ledger (*On track: 4 of 6 cards done. 1 needs a new plan; Seshat suggests splitting it.*).
2. **What's proven**, per release slice: *9 of 11 must-haves proven*, with requirements whose tests pass but whose strength rule is unmet counted apart (*2 passing, not yet strong enough*) and suspect ones named; and the appetite used, in plain words (*18 of 24 cards, 3 of 5 days*).
3. **Burn-up** for the current cycle or project.
4. **Needs you**, each item with plain buttons (*Review it*, *Answer*, *Unpark*; for a slice at its appetite, Seshat's three choices *Accept as it is*, *Cut the nice-to-haves*, *Extend*; for a proposed release, *Read the notes* and *Tag the release*; for tests awaiting approval, *Check the examples*).
5. **What changed today** — the standup in plain mode ([planner-pm](planner-pm.md)).
6. **Risks** — the live signals that fired, in sentences.
7. An inline **Ask Seshat…** box and a primary **Start a new project** button that opens Seshat with the start-project conversation.
8. Every label uses `plainStatus` (*Being planned*, *Being built*, *Waiting for review*, *Done*); no stop-reason codes, ids or gate names without words. It works at 400 px.

### 2.9 The Learn layer

1. **Off for experts, on for learners**, set by the first-run question and toggled by a labelled **Learn** button (book icon and the word) in the topbar, the footer, Settings and the palette; kept per browser. It sets one `data-learn` attribute; **when off it adds no DOM and no layout**.
2. **Contextual, dismissible, findable again** (NN/g): when on, key terms get a dotted underline and a small *?* button — on column headers, the WIP count and bar, gate pips and the gates strip, the points field, the cycle header, each Insights chart, the story map's slices and requirement states, and Seshat's proposals (*I split this Path-first because…*). The *?* opens an **accessible popover** (keyboard reachable, not a `title`): two sentences on *what it is*, one line **from your own numbers** (*In review holds at most 3 because you review about 60 minutes a day and a review takes about 20*), and one link to the canon (Kanban Guide, INVEST, SPIDR — linked, not copied: CC BY-SA). Standard conventions are not explained.
3. **The Learn sheet**: 8–10 short lessons as a checklist — why each column exists and what moves a card; WIP limits and Little's law from their numbers; thin vertical slices (SPIDR) and INVEST; done = gates + a person's accept, and a project done = its must-haves proven; points versus time; cycles, burn-up and cumulative flow; work item age and the service-level expectation; why review is the bottleneck. **Show me** highlights the live element.
4. Content lives in one pure module (`learn.ts`), unit-tested and shared with Seshat's teaching mode. Empty states double as learning cues.

### 2.10 Insights

`#/insights`, over 7, 30 or 90 days. Percentiles, never averages, because flow data is skewed and a mean hides the long tail people wait on.
1. **Headline**: cycle time (85th percentile), throughput (cards a day), work in progress (with how many are older than the 85th percentile), oldest in progress. The **service-level expectation** sentence: *85% of cards finish within 6.2 hours.*
2. **Four charts**, each titled as its question (a panel on `--bg-surface` with a 1 px hairline, 16 px padding, a 240 px plot): **Aging WIP** (*What is getting old?* — one dot per unfinished card by column and age, 50th and 85th percentile bands, dots above the 85th amber and labelled in words *Older than 85% of finished cards*, click peeks) first; **Cycle time** (*How long do cards take?* — scatter with 50/85/95% lines); **Throughput** (*How much finishes?* — daily bars with a 7-day moving average); **Cumulative flow** (*Where do queues form?* — stacked bands, Backlog at the bottom and Done at the top; running for In progress, parked for In review (the human queue), pass for Done, neutral surfaces for the rest; the legend ordered as the stack); plus **Burn-up** (§2.4.17).
3. **Worker capability** (`/api/capability`): per card kind, ordered by attempts (best-evidenced first), a point at the pass rate on a 0–100% track with its 95% Wilson interval as a bar and *16 of 18 passed · 89% (67–97%)*; fewer than 10 attempts says *Too few attempts to trust* in amber with a hollow point, and the caption counts those rows (*2 of 5 kinds have fewer than 10 attempts; treat those rates as rough*) and says a wide bar is uncertainty, not failure; pass rate by change size with an 80% line and the horizon sentence (*passes 80% of cards that change up to about 62 lines*), buckets with fewer than 10 attempts faded and labelled; the server's `note` verbatim under the section; retries run on an escalation model and person-built attempts are excluded and said so. States: 404 *Worker capability isn't on this server yet* naming the endpoint; `sampleSize` 0 *No finished attempts yet*. The section renders independently of the flow metrics, so either can be missing.
4. **Stopping policy**, when a tuning report exists: the headline (*A 12-step cap would have cut 50.4 to 31 minutes (38% less) and kept 18 of 18 passes.*); a current-versus-recommended table (step budget, failed checks allowed, minutes, first-try passes, eventual passes); the copyable `sekhemet queue --max-turns 12`; a note when the failed-check limit also differs, because it has no flag yet; the caveat *Replay only stops a recorded run earlier than it really stopped. It never credits a pass the Worker didn't make, so it can't overstate what a tighter cap keeps. It can't tell you whether a looser cap would have rescued a failure.*; the full replay grid behind a disclosure. When the current policy is already best, it says so and offers no command.
5. **Review**: median review minutes per card with its basis (the 15-minute prior until five human reviews exist), review rate (changed lines an hour), and fast reviews counted apart.
6. Charts are SVG coloured only through token classes, tabular numerals, no gridlines beyond a baseline and percentile rules, each with a `figcaption` sentence and a hidden data table. Axis ticks are never repeated; plurals are correct. Under 3 finished cards: *Not enough finished cards to measure flow yet. Insights need at least 3; you have 1.* Flow metrics 404: *Flow metrics aren't on this server yet (`/api/metrics/flow` returned 404).*

### 2.11 The other views

- **Runs** — a list of runs (date, model, *3 of 6 first try*, duration) and a scorecard: headline blocks *Passed first try*, *Passed after retry*, *Total time*, *Tokens*, each with a delta against the previous run (label 11 secondary, value 22/600 tabular, delta 11 in the state colour with an arrow icon); `Pass@1` appears only as a mono secondary label; a timeline whose segment widths sum to 100%, proportional to duration, filled by outcome and labelled by short id; the cards table (title, attempt, result, *Why it stopped*, steps, time, tokens, accepted sha; sortable); stops by reason, each linked; run settings (Worker, manager, model swaps, harness commit). A run in progress grows live.
- **Ledger** — one sentence per event (*Worker moved **…** from In progress to Verify*), seq, time, actor, type and short hash in mono; filters by card, actor and type; a row opens the payload, payload hash, hash and prev; the header states integrity; a broken chain marks the first bad row; an erased field shows the erased marker and the `ledger/erased` entry that removed it ([kernel](kernel.md)).
- **Machine** — the memory gauge (6 px, ticks at the 85/90/94% thresholds and a sentence on what happens at each, owned by [models](models.md)): used / total GB, the level (*Normal*, *Warning*, *Critical*), swap in use; the active hardware tier; the models by role in a fixed order — Worker, Planner (Seshat), Reviewer, Researcher — each with its model id in mono, a state dot (*Resident*, *Swapped out*, *Not configured*), endpoint, keep-alive and a one-line description, with a note every role shares said once in the footer, and the memory model in one line (*One model is resident at a time on this machine; Sekhemet swaps them as the work needs (about 40 seconds each).*, or with `coResident` *This machine has room for all four at once, so nothing swaps.*); **telemetry sparklines** (120×24) of memory, decode speed and prefix-cache hit rate, sampled every 5 s while the page is open (`machine.js:160-205`); health checks with plain fix hints; sandbox mode; worktrees. *Re-run checks* bypasses the 15 s cache (`?fresh=1`). A roster 404 shows *The model roster isn't on this server yet*, naming the endpoint.
- **Playbook** — a lede, once: *Learned from gate results and what you do, never from a model grading itself. Everything stays on this machine and is recorded on the ledger. A rule takes effect only after you approve it.* Then *Needs your approval* (newest first; **Approve** primary, **Edit**, **Retire**), *Active* (retirement proposals — at least 3 more harmful than helpful uses — first, with an amber rule, the sentence with the counts, and **Retire** promoted; the rest by value), *Retired* (collapsed). Each rule shows who it is for (*For the Worker* / *For Seshat*), its source in words (*From your send-back note*, *From a fix that took the Worker several tries*, *From Seshat's end-of-run review*, *Seeded with the project*) and its age, scope chips, a signed value bar relative to the page's largest |value| (red when negative), helpful and harmful counts with their icons, a reach chip (*This project* / *All projects*, the latter drawn slightly stronger), and evidence as `@card` chips with the quoted note (the first two shown, the rest behind *n more signals*). Edit is inline (a textarea, `⌘↵` saves, `Esc` cancels). Approve opens a reach picker, *This project* (1) or *All projects* (2), whose footer says *All-projects rules live in ~/.config/sekhemet and apply to every repository on this machine.* Every action is optimistic, reverts on failure and states the result (*Approved. The rule is given to the Worker from the next matching card.*). Seeded rules from `.sekhemet/playbook.toml` stay visible as active, read-only rules (*Edit in playbook.toml*) when the learning store does not carry them. When `/api/learning` returns 404, the page keeps the seeded rules and send-back suggestions from `/api/playbook` under a banner naming the endpoint. **What Seshat has learned about you** (`#/playbook/profile`): a lock line (*These stay on this machine, in the project's ledger. Edit a statement to correct it; dismiss it and Seshat stops using it.*); active statements grouped by category (Code style, Planning, Communication, Priorities), strongest first, each with a strength bar and word (*Strong* ≥ 0.7, *Moderate* ≥ 0.4, *Weak*), its source, its evidence with dates, **Edit** and **Dismiss**; dismissed statements collapsed at the end.
- **Registry**, **Workspace** — the bake-off matrix (the results `writeBakeOffMatrix` records, [models](models.md)) and the multi-project rollup (cards waiting on you across projects with wait times, and the machine's load: what is running where and the memory in use).
- **Settings** (`#/settings`, `g ,`) — per-browser preferences (theme, density, Learn, first-run role) and, per project, **review minutes per day** (editable by a person holding the Accept permission; the change is a recorded config event and ReviewWIP is recomputed at once, [review-git](review-git.md)) and the effective configuration, read-only, with where each value came from (NEW-dashboard-4).
- **Integrations** — renders what `/api/integrations` returns ([integrations](integrations.md) owns the catalogue and behaviour), **grouped by the `tier` field the API returns** (*Now*, *Next*, *Later*); nothing is hard-coded in the page, and nothing is connected by default. *Now* cards have their controls; *Next* and *Later* cards are quiet — name, one sentence, *Planned*, **no button** — and still state the data they would send. Copy is keyed on the integration id; an id the page does not know renders from the server's `name` and `detail`. Every card states in one line **what leaves this machine when connected**:

| Card | Body and controls | Leaves this machine |
| --- | --- | --- |
| GitHub Issues and Projects | *Connected to acme/chronicle via gh* or *gh isn't signed in*; *Last synced 12 minutes ago*; last result *4 created · 9 updated · 2 skipped · 0 errors*; **Pull**, **Push**, **Sync both**, with *Syncing with GitHub…* while one runs; errors verbatim | Card titles, specs, priority, points, cycle and state, to the repository you choose; uses your `gh` login, no stored token |
| Pull request on Accept | A named switch with the current behaviour beside it (*Accept merges locally as one commit*) | The card branch, its diff and gate results |
| Jira · Linear | **Export** (their CSV columns) and **Import…**; never shown as "Connected" | Nothing: you upload the file yourself |
| Slack | Webhook field, **Connect**, **Send test message**, **Disconnect**; the channel host, the last message and whether it was delivered; a lock line: the webhook URL is a credential kept in `~/.config/sekhemet` with mode 0600, never in the repository or the ledger | Standup text, titles of cards that need you, run summaries |
| Research web access | A switch; which search provider is configured, or how to configure one (*Web search needs a provider you configure: a self-hosted SearXNG, or a Brave or Tavily key in the environment; papers, page reads and GitHub work without one.*) | Search queries and the URLs of pages read; private and local addresses are never fetched |

  **Import** opens a sheet (format picker: Jira CSV, Linear CSV, GitHub JSON, Sekhemet JSON; file chooser; paste box); **Preview** renders the returned proposals with the §2.7 component and posts the same preview into Seshat's thread, and the sheet says so (*The preview is also in Seshat's thread.*). Export downloads `sekhemet-<project>-<format>.csv|json`. A 404 shows *Integrations aren't on this server yet* with the endpoint in a details line, and no catalogue.

### 2.12 Voice and vocabulary

1. **One label source.** Every column, state, stop reason, gate, kind and actor label comes from `vocabulary.ts` (and `plainStatus` for the plain mode), served to the page; the browser never re-derives a label, and no second status map exists anywhere. Words follow [NAMING](../NAMING.md). A stop reason the vocabulary does not know falls back to its humanised enum, never to a blank.
2. Internal enums appear only in mono where a developer might grep for them (evidence detail, ledger rows). Compiler and gate errors are quoted verbatim. Actors are named *Worker*, *Planner*, *Reviewer*, *You* (or the person's name) and *Sekhemet*.
3. **No operator language on user surfaces**: no API paths, model ids in running copy (the idle cost line and the details disclosures excepted, §2.7), or "N-step budget" on the board face. A missing endpoint reads *X isn't on this server yet* with the endpoint in a details line.
4. **The essentials the label source must carry** (short label · sentence · tone):

| Kind of term | Labels |
| --- | --- |
| Stop reasons | Passed · *All gates passed on step N.* · pass — Passed after a planner retry (`passAfterEscalation`) · pass — Out of steps · *Used all 32 budgeted steps without passing.* · fail — Looping · *Repeated the same actions without changing any file.* · fail — Stalled · *No file changed for 3 steps.* · fail — Couldn't fix · *Tried N repairs; the same gate kept failing.* · fail — **Paused for memory** · *Stopped safely at 94% memory. Resumable.* · **parked, not fail** (a safety stop) — Paused for quota · parked — Harness error · *Sekhemet failed, not the Worker.* · fail — Out of scope · *Tried to edit a file this card may not touch.* · fail — Too hard for this model · *Needs a split or a stronger model.* · parked — Stopped by you · neutral |
| Gates | Parse · Types · Tests · Lint · Size · Visual (id kept in mono in evidence; Types shows its command); states Passed · Failed · **Skipped** (configured, not run because an earlier blocking gate failed) · **Not run** (the card never reached gates) · Running; *4 of 4 gates passed*; Size's sentence *2 files, +11 −0 (limit 3 files, 200 lines)* |
| Card kinds | Contract · Storage · Flow · Rules · Research · UI · Wiring (at most two, the first primary), and for existing code Feature · Fix · Characterize · Refactor · Upgrade; each with a one-line description in its popover. With Learn on, a SPIDR kind names its slice — Flow → Path, Storage → Data, Rules → Rules, Research → Spike, UI → Interface (the *user* interface) — and Contract and Wiring are named as enablers, not SPIDR slices ([planner-pm §2.2](planner-pm.md)) |
| Requirement states | Proven · Passing, strength unmet · Planned · Unplanned · Suspect · Cut |
| Card facts | *Done when* (criteria) · *May edit* (scope) · *Acceptance tests* (protected) · *Waits on* / *Unblocks* · *Difficulty 6/10* · *Why it stopped* · *Checkpoints* · *Gate contract* · *8 of 32 steps* (a step is one model call and its tool calls, [NAMING](../NAMING.md)) · *Tokens 16.8k in · 1.4k out* · *Built by* |
| Actions | Accept · *Merges to main as one commit.* — Send back · *Returns the card to Ready with your note for the Worker.* — Park · *Sets the card aside. Nothing runs until you unpark it.* |
| Errors | What, why, action: *Couldn't load evidence for hasher. The server returned 500.* `Retry`; a refused accept quotes the server (*Card is in Verify, not Review.*); *This action must come from the dashboard. Reload the page.* |

### 2.13 Visual system

1. **Tokens** are the single source of truth for colour, published as CSS custom properties and JSON (`tokens.ts`, `/tokens.css`, `/tokens.json`); components never hard-code a colour. Fifteen roles per theme — `bg-base`, `bg-surface`, `bg-raised`, `bg-overlay` (the surface ladder: depth by luminance, **no drop shadows**), `border-subtle`, `border-strong`, `text-primary`, `text-secondary`, `text-muted`, `accent` (Egyptian gold), `state-pass` (Nile green), `state-fail` (red ochre), `state-running` (lapis), `state-parked` (needs you), `state-blocked` — plus derived `on-accent`, `on-state`, `scrim`, `tint-{pass,fail,running,parked}` (12% Basalt, 10% Sand) and layout constants. The values are in `tokens.ts`, not here; the contrast test (§2.14.1) is what holds them.
2. **Colour roles (P12):** the warning/parked hue is moved clearly apart from the accent (a copper, ≈ `#C8743A` Basalt / `#9A4F1C` Sand, re-measured); **disabled buttons use a neutral fill**, never faded gold; a **`--border-control`** role at ≥ 3:1 edges every input; **`--text-muted` is decorative only** (line numbers, disabled controls, decorative glyphs) and never carries text a person must read, placeholders included.
3. **Colour per tone**: running — fill, rule, text only on base/surface, tint for the live step; pass — quiet, no rule; fail — fill, rule, tint for failure blocks and removals, and the blocker flag (§2.4.4); parked — fill, rule, shell bars; blocked — the dependency link icon and secondary text for *waits on* detail.
4. **Type**: Inter and JetBrains Mono with system fallbacks that must look right on their own; sizes 11 / 12.5 / 13 / 15 / 18 / 22 px; leading 1.25 / 1.45 / 1.55 (code); tabular numerals for every number. Usage: wordmark and view titles 15/600; card title in Review 18/600; scorecard numbers 22/600; section headings 12.5/600; body and tile titles 13; meta 11 secondary; code 12.5 mono; diff line numbers 11 mono in `--text-muted`.
5. **Spacing** 2, 4, 8, 12, 16, 24, 32 px; **radius** 4 px controls and chips, 6 px cards, 0 for full-bleed panels; **motion** 120 ms ease-out for hover, press, focus, drawer and popover only; board reflow, streaming and patches append with no animation; the running dot's pulse (1 → 0.35 opacity, 1.6 s) is the only perpetual animation; `prefers-reduced-motion` removes it and all translates.
6. **Icons**: one 1.5 px line set on a 24 viewBox, `currentColor`, round caps and joins, no fills except `dot`, no emoji or Unicode check marks in the product; distinct glyphs for every nav item (Review and Inbox never share one). **Brand**: the pylon gate with a sun disc (`M3 20 L5.5 9 H10 V20 M21 20 L18.5 9 H14 V20 M2 20 H22` plus a circle at 12,6 r 2.25) in accent; wordmark *Sekhemet* in Inter 600; favicon the glyph on a 6 px rounded `bg-base` square; no mascot, lion or tagline in the chrome. Where the product introduces itself: *Sekhemet — a coding harness for professional teams*.
7. **Component sizes**: sidebar item 28 px (8 px horizontal padding, 2 px gap; 16 px between groups; footer 12 px padding); topbar 44 px; column header 36 px; tile padding 8/12 px; review queue row 56 px; evidence padding 24 px; gates segment 32 px; failure block 8/12 px; diff file header 32 px, line 20 px; triage bar 52 px; **buttons** 32 px high, 4 px radius, 12 px horizontal padding, with the `kbd` hint inside in 11 px mono — primary on `--accent` with `--on-accent` text, secondary on `--bg-raised` with primary text and a `--border-subtle` edge, ghost with no fill; palette 600 px wide, rows 36 px, group labels 28 px; toasts 360 px, bottom-left 16 px from the edges, 12/16 px padding, `--bg-overlay` with a `--border-strong` edge, an icon, one line and an action, at most 3, success 4 s (`role="status"`), errors until dismissed (`role="alert"`), hover pauses; Seshat panel 400 px (header 52 px, 16 px padding, 24 px message gap, composer at least 44 px); proposal group header 36 px, diff rows 24 px; pending-block rows 24 px; view bar 40 px; cycle header 56 px; lane header 32 px; table row 36 px; bulk bar 48 px; chart plot 240 px; memory gauge 6 px; sparkline 120×24.

### 2.14 Accessibility

1. Every colour pair used as text or as a control's only edge meets WCAG 2.2 AA **as used**, asserted by a test over the tokens in their actual pairings (placeholders, Sand accent on raised, state text on tiles): text ≥ 4.5:1, with body text (`--text-primary` on base and surface) ≥ 7:1; controls' edges, state icons and the accent ≥ 3:1. State-coloured text sits only on base or surface; on raised tiles state is carried by the icon (≥ 3:1) with secondary words.
2. **Nothing a person needs is only on hover**: WIP reasons, full status lines, gate names and priority meanings are in keyboard-reachable popovers or visible text.
3. Landmarks (`nav`, `header`, `main`, `aside`); the board a roving-tabindex listbox per column with `aria-selected` and the status line as description; the list a real `table` with `aria-sort` on the sorted header and `aria-selected` on rows; the gates strip a list of named buttons (*Types: failed, 3 errors, 0.7 seconds*); diff annotations `role="note"` and focusable; WAI-ARIA tabs; palette and cheat sheet as modal dialogs that trap and return focus (the palette a combobox); the Seshat panel a `complementary` landmark labelled *Seshat, project manager*, with its thread as `role="log"`, announcing only final replies (*Seshat replied. 2 proposed changes.*), and the pending block's current row `aria-busy="true"`; proposals a list of labelled groups with Apply/Discard names including the summary; field diffs as `dl`; the bulk bar a toolbar announcing *3 selected*; toasts `role="status"` or `role="alert"`; one polite live region for the focused card and triage results.
4. Focus order in Review: queue → Reviewer findings → gates strip → failures → diff files → triage bar; `Tab` inside the diff visits file headers and annotations, not lines.
5. Focus: a 2 px accent outline, offset 1 px, on `:focus-visible` (≥ 3:1 on every surface). Targets ≥ 24×24 px on desktop (copy buttons included) and ≥ 44×44 px on a phone. Layouts hold at 200% zoom. Every control has an accessible name.

### 2.15 How it is built

1. **Static, build-free ES modules** served from `packages/ui/web` under `/app/`; no framework, no CDN, works air-gapped; the served page is a small shell. Presentation logic is pure TypeScript in `packages/ui/src` (vocabulary, board model, tile model, nav model, keymap, learn content, filter language, flow maths), served as `/app/lib/*.js` and unit-tested with exact values; web modules only render. How `/app/*` is served safely (no `..` traversal, correct MIME types) is [runtime](runtime.md)'s.
2. Live data arrives on the server-sent event stream (`/api/stream`: `append` for ledger events including `card/step`, `pm` for PM status, `machine` every 5 s, `tokens` for the running model's output); windowing is the page's own (`virtual.js`); CSS is organised per component. The server enriches each card with a `display` object from the vocabulary (title, kinds, key, state label, status line, stop label, tone, entered-column time, waits-on, evidence summary) and publishes the vocabulary as `/vocab.json` for plugin panels.
3. **Responsive.** 1440 px: everything at full size. 1024–1279 px: labelled narrow sidebar; board columns min 220 px with horizontal scroll and In review / On hold pinned; Review's facts rail as a disclosure. < 768 px: the bottom bar; the board as one column with a segmented column switcher (*To do 4 · In progress 1 · In review 1 …*) and full-width tiles; the card view shows Evidence only; triage is one tap on 48 px buttons with send-back in a bottom sheet; no create or bulk actions; Status and PM fully usable.
4. **Palette.** 600 px at 12vh; a 48 px, 15 px input; groups *Actions on the focused card*, *Cards*, *Go to* (with chords), *Preferences* (theme, density, Learn); fuzzy matches highlighted; each row shows its shortcut; `⌘↵` opens a card in the card view; the empty query shows recent cards and top actions.
5. **Verification of every UI change**: seed a fixture project, open it at 1440×900, 1100×800 and 400×812 in both themes, compare with `docs/design/mockups/`, exercise the change's keys with the keyboard only, and require an empty error console; check each view against a contract-shaped fixture server **and** a server with the endpoints absent, so every "not on this server yet" state is seen.
6. **Security, page side (S3c):** every mutating request carries the per-session token the server issued to this page (not a constant header); the page runs under a Content-Security-Policy with no inline script and `frame-ancestors 'none'`; model and repository text reaches the DOM only through escaping renderers. The server side (Host check, token issue, headers) is [runtime](runtime.md) and [security](security.md).
7. **Company server (D7), page side:** the footer shows who you are; Accept is disabled with *You don't have the Accept permission on this project* when you lack it, and with *You built this card; another person must accept it* (or who may) when independent accept applies; ledger and thread entries name people, not "human".

## 3. Contract

| Item | Where |
| --- | --- |
| Labels, `statusLine`, `describeCard`, `columnLabel`, `stopReasonLabel`, `BOARD_COLUMN_ORDER`, `COLUMN_EMPTY`; new `BOARD_COLUMNS`, `boardColumnOf(status)`, `plainStatus` | `packages/ui/src/vocabulary.ts` |
| Tokens, derived roles, layout, typography | `packages/ui/src/tokens.ts` (`/tokens.css`, `/tokens.json`) |
| Icons | `packages/ui/src/icons.ts` |
| Filter language, proposal diffs, PM markdown, cycle progress, flow maths, waiting phases, capability rows, learning views | `packages/ui/src/pm.ts` (to split by concern) |
| New pure modules | `learn.ts` (lessons), `keymap.ts` (one keymap for cheat sheet and palette), board/tile/nav models |
| Web modules | `packages/ui/web/*.js` (shell, keys, board, tile, lanes, list, viewbar, fields, bulk, review, evidence, gates, failures, diff, triage, decision, card tabs, steps, pm_panel/pm_view/pm_thread/proposals, insights, runs, ledger, machine, sparkline, playbook, learning_view, registry, workspace, graph, dag, integrations; new settings, story map) |
| Shapes the page depends on (named, not copied) | `card.display` (`vocabulary.ts` `describeCard`); the `card/step` event `{ id, turn, calls, gate?, usage }` (`execute.ts:230-250`, `stepEventPayload`); `event: tokens { cardId, text }` (`server.ts:1164`); the transcript `{ attempt, file, steps }` (`/api/cards/:id/transcript`); `/api/events?since=&card=&limit=&order=desc` → `{ events, verification, nextCursor }`; `/api/machine` and `event: machine` every 5 s (`server.ts:570-572`); `/api/gates` → `{ gates, protected, maxFiles, maxDiffLines, sha256, empty }` (`server.ts:803`); `/api/meta` → `{ project, repoPath, triage, reviewMinutesPerDay, version, gitUser }`; `/api/playbook` → `{ rules, candidates }`; `/api/integrations` entries with `tier`, `name`, `detail`, `enabled`, `lastSyncAt`. PM shapes in [PM_CONTRACT](../PM_CONTRACT.md); the page uses these optional fields when present: `PmStatus.since/step/etaSeconds`, `cycleTime[].doneAt`, a thread-level `model`, `epics[].progress.pointsDone`, integration `enabled`, `lastSyncAt`, reply `cites[].url/label`, the import response's `messageId` |
| Endpoints consumed (defined in [runtime](runtime.md)) | `/api/board`, `/api/stream`, `/api/meta`, `/api/wip`, `/api/cards/:id`, `/api/evidence/:card?attempt=`, `/api/cards/:id/transcript`, `/api/events`, `/api/gates`, `/api/runs`, `/api/machine`, `/api/models`, `/api/playbook`, `/api/learning`, `/api/decisions`, `/api/pm/*`, `/api/cycles`, `/api/metrics/flow`, `/api/capability`, `/api/integrations`, `/api/import`, `/api/export`, `/api/goals`, `/api/standup`, `/api/signals`, triage `POST`s, `PATCH /api/cards/:id`; new: the requirement graph and slices, releases, test approvals, review records, project settings |
| Routes | `#/status`, `#/pm`, `#/review`, `#/board`, `#/board/list`, `#/board/map`, `#/card/:id/:tab`, `#/insights`, `#/runs[/:id]`, `#/graph`, `#/playbook[/profile]`, `#/integrations`, `#/machine`, `#/ledger`, `#/registry`, `#/workspace`, `#/settings`, `#/inbox` (opens Review › Needs you) |
| Per-browser settings | theme, density, Learn, first-run role, pipeline stages, panel open, saved views `{ name, query, group, layout }` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Review surface: queue, evidence, gates, failures, grouped diff, facts, triage with grace undo | built | `review.js`, `evidence.js`, `diff.js`, `triage.js`; `diff_parse.spec.ts`, triage endpoints in `server.spec.ts:311-355` | — |
| Decision request component | built | `decision.js` | — |
| Gates strip readable at many gates and on a phone; no stage+failure badge; no synthesised gate | not-built | 14 gates overlap; "✕ Planning" (domain17 §2) | NEW-dashboard-1 |
| Card view tabs, peek, palette, toasts, cheat sheet | built | `card.js`, `peek.js`, `palette.js`, `cheatsheet.js` | NEW-dashboard-2 (no behaviour tests) |
| Live Steps from `card/step`; streamed model output | partial | `card/step` written (`execute.ts:541`) and read (`dashboard_api.ts:233-243`); the server streams `event: tokens` (`server.ts:1164`, `execute.ts:486, 683`) but the page has no listener (`app.js:188-246`) | NEW-dashboard-3 |
| Nine machine columns; five professional columns; pipeline toggle | partial | `BOARD_COLUMN_ORDER` (`vocabulary.ts:73`); the professional mapping exists only in the Jira export (`integrations.ts:274-284`) | P3 |
| Tile anatomy: key, type, owner, delegate, epic, blocker cause, age | partial | Priority, labels, points on the tile (`tile.js:168-170`); no key (`shortId` slug, `vocabulary.ts:359`), no owner, delegate or epic, `blockedReason` never rendered, "40-step budget" (`vocabulary.ts:615`), cause truncated (`tile.js:171`) | P3 |
| Review WIP limit visible | not-built | `LIMIT_SHOWN = 20` hides larger limits (`board.js:37,108`) | P3 (with S6 in [review-git](review-git.md)) |
| Collapsed columns as chips; Done a full column | not-built | Rotated rails; Done forced to a rail below 1600 px (`board.js:99`) | P3 |
| Quick create without the CLI | not-built | `c` shows "Create cards from the CLI" (`board.js:580`) | P3 |
| View bar, query language, saved views, swimlanes, cycle header, list, bulk, inline edit | built | `viewbar.js`, `lanes.js`, `list.js`, `bulk.js`, `fields.js`; `pm.spec.ts:288-390` | — |
| `owner:` and `delegate:` queries | not-built | The card has one `assignee` string ([kernel](kernel.md)) | NEW-dashboard-5 |
| Reorder within a column | built | `reorder.js`; `reorder.spec.ts` | — |
| Story map with requirement states; burn-up | not-built | — | P3, P13 |
| Seshat panel and full view, proposals, waiting phases, surface states | built | `pm_panel.js`, `pm_view.js`, `pm_thread.js`, `proposals.js`; `pm.spec.ts:123-290, 428-455` | — |
| Composer copy without operator language; Start a new project starter | not-built | "Seshat runs locally on dirk-27b" on every state (`pm_thread.js:248`); starters lack it (`pm_thread.js:252`) | P5 |
| Status view for non-developers | not-built | `/api/standup`, `/api/signals`, `/api/goals` have no UI client (`wave2_server.ts:282-297`) | P5 |
| Learn layer | not-built | Teaching only in `title` tooltips (`board.js:106-119`) | P4 |
| Grouped, labelled, progressive navigation; phone bottom bar; chords for every visible view; no bare `t` | not-built | 13 flat items, only Inbox conditional (`shell.js:6-28`); no nav < 768 px (`shell.css:513`); chords `g a/f/q/e/s` (`keys.js:13-27`); bare `t` (`keys.js:91`) | P11 |
| First-run role question and default route | not-built | Default is Review or Board (`app.js:52-53`) | P11 |
| Settings view | not-built | No `#/settings` route | NEW-dashboard-4 |
| Insights: flow charts, capability, stopping policy | built | `insights.js`; flow maths and capability rows in `pm.spec.ts:392-480` | — |
| Runs, Ledger, Machine (with telemetry sparklines), Playbook and profile, Registry, Workspace, Dependencies, Integrations | built | `runs.js`, `ledger.js`, `machine.js` (sparklines `machine.js:7, 160-205`, `sparkline.js`), `learning_view.js`, `registry.js`, `workspace.js`, `graph.js`, `dag.js`, `integrations.js`; `server_runs.spec.ts`, `pm.spec.ts:480-560` | NEW-dashboard-2 |
| The restored view detail (menus §2.4.15, pending rows §2.7.8, capability and stopping-policy states §2.10.3–4, Playbook states §2.11) | partial | Present in the web modules as the PM design described them, not individually verified; no behaviour tests | NEW-dashboard-2 |
| Machine shows the active hardware tier | not-built | Not in `machine.js` | NEW-dashboard-2 |
| Integrations grouped by the API's `tier`, with no hard-coded roadmap | not-built | Catalogue and Now/Next/Later list in `integrations.js` | NEW-dashboard-2 |
| Review ergonomics: risk-ordered files, Reviewer coverage, acknowledgement before Accept, person-built label, supersessions and test approvals | not-built | Files grouped by role, then in the diff's own path order (`diff.js:173-175`) | NEW-dashboard-5 |
| Tokens, contrast test, icons test | partial | `tokens.spec.ts`, `icons.spec.ts`; warn hue equals accent hue (40°); disabled Accept 2.1:1 (`base.css:163`); `border-strong` 1.3–1.9:1 on inputs; muted placeholders 2.6–3.6:1; body text 14–17:1 (computed from `tokens.ts:34-64`) | P12 |
| Accessible names and targets | partial | PR switch unnamed (`integrations.js:230`); copy buttons 14×14; graph nodes inside `role="img"` (`graph.js:61`) | P12 |
| One label map | not-built | Four status maps (`vocabulary.ts:93`, `insights.js:27-34`, `integrations.ts:276-284`, `pm.ts:871`); `Checking`/`Working` leak (`shell.js:243`, `evidence.js:98,151`) | NEW-dashboard-2 |
| Behaviour tests for the web layer | not-built | ~60 modules checked for syntax only (`server.spec.ts:92-130`) | NEW-dashboard-2 |
| Per-session mutation token, CSP, no framing | not-built | A constant `X-Sekhemet-Action: 1` header (`server.ts:116`) | S3c |
| Server routes split by resource | not-built | `startDashboardServer` is one ~1,045-line closure (`server.ts:216-1261`) | T5 |

## 5. Changes for v1

### P3 — A professional board
*The columns are the machine's nine states, the tile shows harness telemetry first, and nothing starts without the CLI.*

- WHEN the board renders THE SYSTEM SHALL show Backlog, To do, In progress, In review and Done, plus On hold only when a card is parked, and map every stored state to exactly one of them as in §2.4.1.
- WHEN a card in verify has a failing gate THE SYSTEM SHALL show it in In progress with a fail-tone badge naming the gate.
- WHEN pipeline stages are toggled on THE SYSTEM SHALL show the nine stored states as columns and keep that choice after a reload.
- WHEN a tile renders THE SYSTEM SHALL show the issue key, type icon, points (when set), owner, delegate chip (when a delegate is set), title, priority glyph (only when priority ≠ 0), epic chip, up to two labels, the status badge and, for In progress and In review, the work item age.
- WHEN a tile's delegate is the Worker THE SYSTEM SHALL show the text chip *Worker* and no avatar or letter badge.
- WHEN a card has a `blockedReason` or an unfinished dependency THE SYSTEM SHALL show a blocker flag in the fail tone with the link icon, the word *Blocked* and its cause.
- WHEN the status text is longer than one line THE SYSTEM SHALL wrap it and never cut off the cause.
- WHEN a card is in Backlog or Ready THE SYSTEM SHALL show no step budget on the board face.
- WHEN the In review limit is computed THE SYSTEM SHALL show `count / limit` and its derivation whatever the limit's size, and every column header SHALL show its points sum.
- WHEN a column is empty THE SYSTEM SHALL show it as a chip above the board, and Done SHALL be a full column whenever it has cards, at every width.
- WHEN In review or On hold renders THE SYSTEM SHALL order its cards by wait time, longest first.
- WHEN a person presses `c` or a column's `+` THE SYSTEM SHALL open a create form whose result is a proposal from the planner pipeline, and no message SHALL tell them to use the CLI.
- WHEN a board has epics with slices THE SYSTEM SHALL render `#/board/map` with epics in backbone order and the first slice marked.
- WHEN a cycle is in force THE SYSTEM SHALL render a burn-up with separate done and scope lines; WHEN the filter is `cycle:none` THE SYSTEM SHALL hide the cycle header.
- WHEN a focused card changes column on a stream frame THE SYSTEM SHALL keep focus on it and scroll it into view, and SHALL scroll no other card.
- WHEN the page is reloaded mid-run THE SYSTEM SHALL show the same columns, tiles and statuses as a page that stayed open.
- WHEN a developer uses the board at 1440 and 1100 px THE SYSTEM SHALL let them find which card is blocked and why within three actions (DEFINITION_OF_DONE §6.4).

### P4 — The Learn layer
*The claims table says "not built"; teaching exists only in hover tooltips.*

- WHEN Learn is off THE SYSTEM SHALL render zero Learn nodes and the same layout as without the feature.
- WHEN Learn is on THE SYSTEM SHALL show a *?* on every column header, WIP count, gate pip group, points field, cycle header, Insights chart and story-map slice.
- WHEN a *?* is activated by keyboard THE SYSTEM SHALL open a popover with the concept, a line computed from the project's own numbers, and a link to its canonical source, and `Esc` SHALL return focus to the *?*.
- WHEN the In review limit is 3 at 60 review minutes a day THE SYSTEM SHALL say so in that popover with those numbers.
- WHEN `learn.ts` is tested THE SYSTEM SHALL have a lesson for every board column, every gate family and every Insights metric.
- WHEN Learn is on and a Contract card's kind is explained THE SYSTEM SHALL call it an enabler and SHALL NOT name a SPIDR slice for it.
- WHEN a person answers the first-run question with "I'm learning" THE SYSTEM SHALL turn Learn on; with "I write code" it SHALL stay off.
- WHEN a beginner with Learn on starts from the board THE SYSTEM SHALL let them reach the explanation of a WIP limit by keyboard alone (DEFINITION_OF_DONE §6.4).

### P5 — Status for non-developers, and starting a project without a terminal
*Non-developers land in jargon; the standup, signals and goals APIs are unused; every "start" path ends at a terminal.*

- WHEN a person opens `#/status` THE SYSTEM SHALL show a plain-language headline, the proven count per slice, a burn-up, *Needs you* with buttons, today's standup in plain mode, the fired signals as sentences, an Ask box and a **Start a new project** button.
- WHEN any Status or plain-mode text is rendered THE SYSTEM SHALL contain no stop-reason code, card id without a title, or gate id without words.
- WHEN **Start a new project** is pressed THE SYSTEM SHALL open Seshat with the start-project conversation, and applying its proposal group SHALL create the project's cards with no terminal step.
- WHEN the palette query is "new project" THE SYSTEM SHALL offer *Start a new project*; WHEN a query matches nothing THE SYSTEM SHALL offer *Ask Seshat: <query>*.
- WHEN the composer's cost line renders THE SYSTEM SHALL contain no API path, and a model id only in the idle line.
- WHEN the Seshat panel header renders THE SYSTEM SHALL show *Seshat · Project manager* and the presence line, and SHALL show the model id only inside the header's details disclosure.
- WHEN a non-developer at 400 px wide starts a project and then asks how it is going THE SYSTEM SHALL complete both without a terminal (DEFINITION_OF_DONE §6.4).

### P11 — The navigation
*14 flat items, labels lost at laptop widths, no phone navigation, chords that are not mnemonics, a bare `t`.*

- WHEN the dashboard has no runs, no dependency edges, no bake-off and one project THE SYSTEM SHALL show no Runs, Dependencies, Registry or Workspace item.
- WHEN the window is 1100 px wide THE SYSTEM SHALL show every nav label.
- WHEN the window is 400 px wide THE SYSTEM SHALL show a bottom bar with Status, Review, Board and PM, each reachable in one tap.
- WHEN a person presses `g` then a letter THE SYSTEM SHALL go to the visible view the keymap assigns that chord; every visible view SHALL have exactly one chord, no two views SHALL share one, and `t` alone SHALL do nothing.
- WHEN Playbook, Runs or Integrations is visible THE SYSTEM SHALL reach it with `g k`, `g u` or `g n` respectively, and from the palette.
- WHEN the cheat sheet opens in a 900 px-high window THE SYSTEM SHALL show every key group without clipping, and every entry SHALL come from the same keymap as the palette.
- WHEN decisions are waiting THE SYSTEM SHALL list them under Review › *Needs you* and `#/inbox` SHALL open that group.

### P12 — Colour and contrast
*Gold and warning amber share a hue; disabled Accept is 2.1:1; input borders 1.3–1.9:1; placeholders carry instructions in muted text.*

- WHEN the token test runs THE SYSTEM SHALL assert every text pair as used ≥ 4.5:1, body text (`--text-primary` on base and surface) ≥ 7:1, and every control edge, state icon and the accent ≥ 3:1, in both themes.
- WHEN the parked/warning hue and the accent hue are compared THE SYSTEM SHALL find at least 20° of hue between them in both themes.
- WHEN a button is disabled THE SYSTEM SHALL render it with a neutral fill, and its reason as adjacent text.
- WHEN any input renders THE SYSTEM SHALL edge it with `--border-control`.
- WHEN any placeholder or information-bearing text renders THE SYSTEM SHALL NOT use `--text-muted`.
- WHEN the accessibility check runs over every route at 400, 1100 and 1440 px in both themes THE SYSTEM SHALL find no control without an accessible name, no target under 24×24 px on desktop, and no information available only on hover.

### P13 — Where "done" is drawn (page side)

- WHEN a project has a requirement graph THE SYSTEM SHALL show its story map with the backbone of user activities, the release slices as horizontal bands, and each requirement as proven, passing with strength unmet, planned, unplanned, suspect or cut.
- WHEN the Status view shows a project THE SYSTEM SHALL state the proven count of must-have requirements per slice ("9 of 11 must-haves proven"), count requirements whose tests pass without meeting their strength rule apart from the proven ones, and state the appetite used, in plain words.
- WHEN a requirement's tests pass but its test-strength record does not meet the profile's rule THE SYSTEM SHALL show *Passing, strength unmet* on the story map and in Status, and SHALL NOT show it as proven (research TESTS_BROWNFIELD PM-TQ-8).
- WHEN a requirement has been revised since a card or test was linked to it THE SYSTEM SHALL mark it *Suspect* on the story map and in the card's Plan tab.
- WHEN a slice reaches its appetite THE SYSTEM SHALL show Seshat's three choices (accept as proven, cut named nice-to-haves, extend) as buttons in Needs you.
- WHEN a release is proposed for a slice THE SYSTEM SHALL show its notes and changelog in Needs you with a *Tag the release* button, and SHALL tag nothing without that press.
- WHEN tests await a person's approval under the depth profile THE SYSTEM SHALL list them in Needs you and render each as its example table (given → expected) with Approve.
- WHEN the Learn layer is on THE SYSTEM SHALL explain the walking skeleton, release slices, must-have versus nice-to-have, appetite and *strength unmet* where they appear.

### T5 — The dashboard server split by route group (page side)
*The UI is served by one ~1,045-line closure; the server split itself is [runtime](runtime.md)'s.*

- WHEN the route table is enumerated in a test THE SYSTEM SHALL resolve every endpoint in §3's consumed list to exactly one handler module, and the existing server specs SHALL pass unchanged.

### S3c — Dashboard hardening (page side)
- WHEN a mutating request is sent without this page's session token THE SYSTEM SHALL refuse it, and the page SHALL send the token on every mutation it makes.
- WHEN the page is loaded THE SYSTEM SHALL run with a Content-Security-Policy that allows no inline script and `frame-ancestors 'none'`, and every view SHALL still work.
- WHEN model or repository text contains HTML THE SYSTEM SHALL render it as text in every view.

### NEW-dashboard-1 — Evidence that stays readable
*The gates strip, the product's central evidence element, breaks at 14 gates and on a phone (domain17 §2, top change 4). Not in COVERAGE.*

- WHEN a card has 14 gates in 5 families THE SYSTEM SHALL show 5 grouped segments, failing groups first, and a *+n passed* overflow.
- WHEN the strip renders at 400 px THE SYSTEM SHALL render it as a vertical list with no overlapping text.
- WHEN a card in Planning has failing evidence THE SYSTEM SHALL show one badge describing its current state (*Needs a new plan*), never a failure mark on a stage name.
- WHEN a card's evidence ran no Parse gate THE SYSTEM SHALL show no Parse segment or pip for it.

### NEW-dashboard-2 — A web layer under test, with one vocabulary
*About 60 modules are checked for syntax only; four status maps; wave-named CSS; a hard-coded integrations roadmap (domain13 §3, §5). Not in COVERAGE beyond T9's general gaps.*

- WHEN the board, tile and nav models are tested THE SYSTEM SHALL assert exact outputs for every stored state, including at least two negative cases per model.
- WHEN the ledger fails verification THE SYSTEM SHALL disable Accept on Review, the card view and the peek drawer, asserted by a test.
- WHEN the repository is searched for status-to-label maps THE SYSTEM SHALL find exactly one, in `vocabulary.ts`.
- WHEN the vocabulary is asked for a stop reason it does not know THE SYSTEM SHALL return its humanised enum.
- WHEN `/api/integrations` omits an integration THE SYSTEM SHALL NOT show it; WHEN it returns entries with tiers THE SYSTEM SHALL group them as Now, Next and Later, and Next and Later cards SHALL have no button.
- WHEN each state named in §2.7.8 (pending rows), §2.10.3–4 (capability and stopping policy) and §2.11 (Playbook, profile, Machine roster) is rendered from a fixture THE SYSTEM SHALL produce its specified text, asserted by a test, including the 404 state of each endpoint.
- WHEN Machine renders THE SYSTEM SHALL show the active hardware tier.

### NEW-dashboard-3 — The model's output, live, on the Steps tab
*The server streams `event: tokens` but no page listens, so a long model call looks like a stall (inventory M2; `server.ts:1164`, `app.js:188-246`).*

- WHEN the Steps tab of a running card is open and the stream sends `tokens` frames for that card THE SYSTEM SHALL append their text to the current step row, with no animation, and SHALL replace it with the step's summary when its `card/step` event arrives.
- WHEN the Steps tab is not open THE SYSTEM SHALL keep no token text in memory.

### NEW-dashboard-4 — Settings
*The Settings view (theme, density, review minutes per day, read-only configuration) was dropped without a Later entry (trace pm_fe row 347; ruling R18).*

- WHEN a person opens `#/settings` or presses `g ,` THE SYSTEM SHALL show theme, density, Learn and first-run role, and the project's review minutes per day and effective configuration with each value's source.
- WHEN a person holding the Accept permission changes review minutes per day THE SYSTEM SHALL record the change as an event with the principal and show the recomputed ReviewWIP at once; WHEN a person without it tries THE SYSTEM SHALL disable the field with that reason beside it.

### NEW-dashboard-5 — Review for a team, and review that forces a look
*Files are grouped alphabetically, the Reviewer's coverage is invisible, Accept can be pressed without looking, and a team cannot filter by who owns or builds a card ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decisions 1, 16; DB-T1…T6; TESTS_BROWNFIELD decisions 6, 8).*

- WHEN a card's diff is shown in Review THE SYSTEM SHALL order Implementation files by failures, then Reviewer-unmet or unclear hunks, then changed lines, and SHALL NOT order them alphabetically (DB-T3).
- WHEN Reviewer findings are shown THE SYSTEM SHALL show the Reviewer's coverage: files not read, and changed lines cited by no finding (DB-T4).
- WHEN any `unmet` or `unclear` finding is unacknowledged, or any Implementation file has not been shown, THE SYSTEM SHALL keep Accept disabled and write which remain beside the button (DB-T5).
- WHEN a card is person-built THE SYSTEM SHALL say so in the outcome line and in Facts (DB-T6).
- WHEN the query `delegate:worker` or `owner:@me` is entered THE SYSTEM SHALL filter by those fields; `assignee:` SHALL mean the owner (DB-T2).
- WHEN a tile is shown THE SYSTEM SHALL show the owner's avatar when the owner is a person and, while a delegate is set, the delegate as a text chip — *Worker*, or the person's name (DB-T1 as ruled by R10).
- WHEN a card supersedes a base test THE SYSTEM SHALL list the old and new test side by side in the Acceptance tests group.
- WHEN the depth profile requires a person's approval of a card's tests THE SYSTEM SHALL show each test's approval state in the Acceptance tests group, and an approval voided by a content change SHALL read *Needs approval again*.
- WHEN independent accept applies and the viewer may not accept THE SYSTEM SHALL disable Accept and name who may accept.

## 6. v1 acceptance

All criteria in §5, plus:

- WHEN Accept is pressed THE SYSTEM SHALL show a 3-second grace toast, and `z` within it SHALL cancel with no request sent.
- WHEN send back is submitted with an empty note THE SYSTEM SHALL block it client-side with *Add a note for the Worker.*
- WHEN one shell state is active and another begins THE SYSTEM SHALL show only the higher-priority bar (ledger altered > offline > memory pause > review full > Worker paused for Seshat).
- WHEN the stream is silent for more than 10 s and `/api/meta` fails THE SYSTEM SHALL show *Offline since …*, freeze timestamps and disable every action.
- WHEN a stream frame changes one card THE SYSTEM SHALL patch that tile only, keeping scroll position, focus and any open drawer.
- WHEN a card is parked through the API THE SYSTEM SHALL show it in On hold within 1 s with the scroll position preserved.
- WHEN a Seshat reply mentions an id that is not a card THE SYSTEM SHALL render it as plain text.
- WHEN a proposal is stale THE SYSTEM SHALL disable its Apply and say why.
- WHEN 500 cards are loaded THE SYSTEM SHALL scroll the board with no main-thread task over 50 ms and under 50 MB of DOM memory.
- WHEN `prefers-reduced-motion: reduce` is set THE SYSTEM SHALL show no pulse and no translate.
- WHEN a tile is in a WIP-limited column at capacity THE SYSTEM SHALL colour its capacity bar amber, and red over the limit.
- WHEN Machine is open THE SYSTEM SHALL draw the memory, decode-speed and prefix-cache sparklines from samples taken every 5 s.

## 7. Later

- **Rewind from the card view** ("rewind to step N": reset the worktree to that checkpoint, record the rewind, invalidate later gate passes; it truncates nothing). `sekhemet rewind` and `fork` exist on the CLI ([kernel](kernel.md)); the card view offers them after v1.
- **Retry with planner** from Review (`POST /api/cards/:id/run`).
- **Saved views on the server** (a views endpoint); **undo for applied proposals**.
- **Dependency lines over the board**; **pan and zoom, and the critical path, on the dependency graph** (v1 lays it out in layers); **master board across workspaces** beyond the Workspace rollup; **goal view** with the strategy graph and risk register.
- **A gate-override control in the UI** (with its required reason). v1 records overrides from the CLI and the API only, so the board has no gesture that bypasses a gate.
- **Intent grouping of diffs by difftastic** ("Core interface definition", "Handler implementation", "Acceptance tests") beyond scope- and risk-based grouping.
- **A native wrapper, an IDE extension, a TUI**, and **remote control from a phone beyond read-only status and one-tap triage**.
- **Vendored Inter and JetBrains Mono** (SIL OFL 1.1, as WOFF2), **`@floating-ui/dom`** for popovers, **Lucide** icons, **Playwright** screenshot regression and **axe-core** (MPL-2.0, dev-only) — all **proposed, needing the owner's yes**; until then the popovers, checks and screenshots use what is in the repository, and the system font fallbacks must look right.
- **A client-state contract** (`IBoardUIState`: active project, selection, pending decisions, telemetry) — the page keeps this state in `store.js`; a typed contract earns its place when a second client exists.
- **A split of the flow charts by `delegate.kind`** (Worker-built versus person-built) as a view; v1 keeps one WIP and one cycle time per column.

## 8. Open questions

1. **Planning in To do or In progress?** *Recommendation:* To do — nothing is being built yet; the badge says *Being planned*.
2. **Column names in NAMING.** *Resolved:* NAMING now keeps the nine stored names for pipeline view and the stored state, and the five board columns (with On hold and Won't do) for the board; *Working*, *Checking* and *Closed* are retired.
3. **Should the PM's model id be visible?** *Ruled (R15):* not in the panel header (non-developers read it as noise); in the header's details and on Machine, and the idle cost line may name it. Listed for the owner, who once asked to *see* the correct model.
4. **Playwright and axe.** The v1 audience tests (DEFINITION_OF_DONE §6.4) need a real browser driver. *Recommendation:* approve Playwright (Apache-2.0) and axe-core (MPL-2.0, dev-only, unmodified) together.
5. **Accept friction** (research TEAMS_DATA_CHANGE decision 16, the owner's choice). *Recommendation, written into §2.5.9:* light — one key per unmet or unclear finding and each Implementation file shown once; see [review-git §8](review-git.md).
6. **Self-accept on a server.** Decided in [review-git §8](review-git.md); the page shows whatever that rule refuses, with who may accept.

## 9. Evidence and rationale

- Reviews: [domain13_dashboard.md](../../reference/reviews/domain13_dashboard.md) (the professional column mapping, tile anatomy, Learn layer, gap table against Jira/Linear/GitHub) and [domain17_brand_ux.md](../../reference/reviews/domain17_brand_ux.md) (navigation, colour, contrast audit, the three audiences' walk-throughs).
- Practice: the Kanban Guide 2025 requires WIP, throughput, **work item age** and cycle time plus a **service-level expectation** and explicit policies — hence age on tiles, the SLE sentence, and column policies in Learn; NN/g finds pushed tutorials are forgotten while contextual, dismissible, re-findable help works and standard conventions need no explanation — hence the Learn layer's shape; empty states should show status, teach, and offer the next step — [WEB_RESEARCH group C §7](../../research/WEB_RESEARCH_2026-09.md#7-professional-kanban-conventions). Linear's default workflow (Backlog, Todo, In Progress, Done, Canceled), Jira's left-most/right-most column semantics and story points, GitHub's agent statuses on Projects boards, and the human-owner/agent-delegate split — §6 and §7.
- Positioning: Linear Agent already offers PM chat to non-developers, so the dashboard's edge is gates at the column boundary ("accepted means proven"), teaching the practice, and running locally — [group C gap analysis](../../research/WEB_RESEARCH_2026-09.md#gap-analysis).
- Seshat quiet by default, offering in the panel rather than pinging (offering preferred 90% vs 47%; an interruption costs ~23 minutes), capability shown as Wilson intervals from the ledger rather than public leaderboards, and the swap-cost wait explained as steps — [PM_RESEARCH_SYNTHESIS.md](../../research/PM_RESEARCH_SYNTHESIS.md) §1 rows 8, 10, 11.
- Review ergonomics and teams (§2.5.3–9, §2.4.4, §2.4.12): file order changes what is found (Fregnan et al., ESEC/FSE 2022: 64% lower odds for the last file); reviewers follow where an LLM points (arXiv 2411.11401), hence coverage; findings as reminders, not verdicts (Spadini et al., ICSE 2020, search-only); light cognitive forcing (Buçinca et al., CSCW 2021); owner and delegate as two typed fields (Linear) — [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) §2.1, §2.5. *Passing, strength unmet* and test approval by example table: [DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) decisions 1, 5, 6. The team-server research ([DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md)) adds nothing page-side beyond the scheduler's fair share, which [runtime](runtime.md) owns.
- What was taken from each tool (priority scale, points, cycles, swimlanes, GitHub query syntax, keyboard triage, Copilot Workspace's editable plan as the proposal, Cursor's per-change apply, Claude's thread typography): the old PM design Part 1 (git `fb59ba2:docs/design/PM_DESIGN.md`).
- Mockups: `docs/design/mockups/` (board, review, card, runs, pm, board-v2, insights).
- **Resolved drift and deliberate reversals** (each: what changed, why):
  - Server-sent events and the page's own windowing replace the old design's WebSocket and `@tanstack/virtual` — no build step, air-gapped; a React/TanStack stack was rejected for the same reason.
  - Reordering within a column is allowed; moves between columns stay gated.
  - The token values in `tokens.ts` (raised for AA; the parked hue moved to copper) replace the old design's hex table — one source, held by a test.
  - "The tile shows budget, class chip, difficulty and a dependency count" is replaced by the professional anatomy — a tile should read like Jira's; the machine's detail moved to the peek drawer and Facts.
  - Empty columns become chips, not 36 px rails; Done is a full column — rails hid the work people most want to see.
  - A 176 px labelled sidebar replaces the 52 px icon rail at 1024–1279 px — people scan for the words.
  - The phone's tabs are Status · Review · Board · PM, not Review · Board · Runs — the phone is the non-developer's and the reviewer's device.
  - Five primary views are always visible (Status, PM, Review, Board, Insights), not three; Machine sits always in the System menu; Integrations is always listed — the three audiences each need their home, and Integrations is where a connection starts. Insights shows a teaching empty state instead of hiding, because its empty state explains what fills it.
  - No bare `t`; chords reassigned (`g p` PM, `g s` Status, `g i` Insights) — theme is not worth a bare key, and the primary views get the mnemonic letters.
  - The empty Review queue and the empty board offer buttons, not `sekhemet queue` or `sekhemet plan` — no path ends in a terminal.
  - Disabled controls use a neutral fill, not 40% opacity — faded gold read as enabled.
  - The priority glyph moves to row 3 and is hidden for *No priority* (no three dashes) — row 1 is identity (key, points, people), row 3 is planning attributes, and the List view is where priority scans as a column.
  - The story map is a view of the board's cards, not "a separate epic hierarchy screen" — epics still appear as swimlanes, a filter and a column; the map adds the release slices P13 needs.
  - A role never has an avatar (R10): the Worker is a text chip, not a *W* badge; a person keeps their initials. The blocker flag uses the fail tone with an icon and the word *Blocked* (R11); the old dimmed title is dropped, because a dimmed title reads as done or disabled.
  - *Seshat's review* becomes the **Reviewer**'s findings, shown first — the Reviewer is a role, not Seshat (DEC-05), and findings lead because they are reminders of where to look; the "advice, not a gate" line and the severity order are kept.
  - The model id leaves the panel header (R15) — non-developers read it as noise; it stays one disclosure away and on Machine.
  - The Integrations page no longer carries its own catalogue for a 404 — a page-held catalogue drifts from the server's; the API's `tier` keeps the roadmap visible.
  - Card tabs underline in `--text-primary`, not gold — gold stays in its four places.
