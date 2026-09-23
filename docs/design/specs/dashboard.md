---
spec: dashboard
status: partial
audiences: [developer, beginner, non-developer]
code: [packages/ui/src/vocabulary.ts, packages/ui/src/tokens.ts, packages/ui/src/icons.ts, packages/ui/src/pm.ts, packages/ui/web/app.js, packages/ui/web/shell.js, packages/ui/web/keys.js, packages/ui/web/board.js, packages/ui/web/tile.js, packages/ui/web/review.js, packages/ui/web/pm_thread.js, packages/ui/web/proposals.js, packages/ui/web/insights.js, apps/harness/src/ui_html.ts, apps/harness/src/server.ts]
tests: [packages/ui/tests/vocabulary.spec.ts, packages/ui/tests/pm.spec.ts, packages/ui/tests/tokens.spec.ts, packages/ui/tests/icons.spec.ts, packages/ui/tests/diff_parse.spec.ts, packages/ui/tests/reorder.spec.ts, apps/harness/tests/server.spec.ts, apps/harness/tests/pm_api.spec.ts, apps/harness/tests/wave2_server.spec.ts]
changes: [P3, P4, P5, P11, P12, P13, T5, S3c, NEW-dashboard-1, NEW-dashboard-2]
---

# The dashboard

## 1. Purpose

The dashboard is where all three audiences meet Sekhemet. For **developers** it is a board that reads like Jira, Linear or GitHub Projects and a review instrument that gets a decision in under a minute. For **beginners** it teaches the practice where it happens, through a Learn layer they can switch off. For **non-developers** it is a status page in plain words and a conversation with the project manager that can start a project — without a terminal. It serves the spine by making **the human the rate limiter** visible (Review WIP, back-pressure, *Needs you*) and by never letting the interface claim more than the evidence says. Behaviour behind the views lives in [planner-pm](planner-pm.md), [review-git](review-git.md), [design-stage](design-stage.md) and [integrations](integrations.md); the HTTP API is [runtime](runtime.md); PM shapes are [PM_CONTRACT](../PM_CONTRACT.md).

## 2. Behaviour

### 2.1 Stance

1. Every screen answers, in order: **What needs me? Can I trust it? What do I do?** That order sets the navigation, the default route and the hierarchy inside each view.
2. **State is colour; everything else is neutral.** Colour is reserved for the five state roles, and each is paired with an icon and words.
3. **Density over whitespace, evidence first, keyboard-complete, both themes first-class** (Basalt dark is the default; Sand light is tuned, not inverted).
4. **Sentence case everywhere**; no all-caps letter-spaced labels. **Gold (`--accent`) appears in exactly four places**: the primary action (Accept), the active-nav indicator, the focus ring and the brand glyph.
5. **Every number has a unit and a basis** ("8 of 32 steps", "waiting 12m", "16.8k tokens in"). **Nothing is generic**: empty states say what a view is for and what fills it; errors say what failed, why, and what to do.
6. **Nothing the interface says outruns the evidence**: an empty gate contract, an altered ledger, a gate that did not run are shown as such.

### 2.2 Shell and navigation

1. **Grouped, labelled navigation** (sidebar ≥ 768 px):

| Group | Items (route · chord) | Visible when |
| --- | --- | --- |
| Primary | **Status** `#/status` · `g s`; **Project manager** (*Seshat* as secondary text) `#/pm` · `g p`; **Review** `#/review` · `g r`; **Board** `#/board` · `g b`; **Insights** `#/insights` · `g i` | Always (Insights shows its "not enough data" state until 3 cards finish) |
| More (collapsible) | **Runs** `#/runs`; **Dependencies** `#/graph` · `g d`; **Playbook** `#/playbook`; **Integrations** `#/integrations` | Runs: after the first completed run. Dependencies: when a card has `dependsOn`. Playbook: when the first rule or suggestion exists. Integrations: always (it is where one is connected) |
| System (footer menu) | **Machine** `#/machine` · `g m`; **Ledger** `#/ledger` · `g l`; **Registry** `#/registry`; **Workspace** `#/workspace` · `g w`; Theme; Keys | Registry: after the first bake-off. Workspace: from the second project |

   A view with nothing in it is **hidden, not empty**; the sidebar never shows a dead link. **Inbox** is merged into Review's *Needs you* group (its route stays and opens it).
2. **Widths.** ≥ 1280 px: sidebar 216 px. 1024–1279 px: a 176 px sidebar that **keeps its labels** (no icon-only rail). < 768 px: no sidebar; a **bottom tab bar — Status · Review · Board · PM** — with 48 px targets. Topbar 44 px: view title, crumb, scope filters, ⌘K, live status.
3. **Footer status**, text plus one dot: *Live* / *Reconnecting…* / *Offline since 14:42*; *Ledger intact · 236 entries*; memory; the Worker's state. Memory turns amber only when it changes behaviour (a pause is imminent or active), never as a permanent state.
4. **Shell bars** (one at a time, priority: ledger altered > offline > memory pause > review full), each 32 px under the topbar:

| State | Trigger | Treatment |
| --- | --- | --- |
| Loading | Before the first board response | Skeleton of the real geometry, no spinner; after 3 s *Connecting to Sekhemet…* |
| Reconnecting | Stream error | Amber dot; content stays; actions enabled for 10 s |
| Offline | No stream for > 10 s and `/api/meta` fails | **Offline since 14:42:30.** *Showing the last known state. Actions are disabled.* `Retry`; timestamps freeze |
| Read-only | `meta.triage === false` | Triage replaced by one line saying how to enable it; `a/r/p` show the same line |
| Review full | `backpressureActive` | **Review is full (3 of 3).** *Finished cards wait until you clear one.* `Open review` |
| Memory pause | Level critical, or the last stop was `memory_pressure` | **Paused for memory: 94% used.** *Sekhemet stopped the Worker safely. Work resumes below 85%.* |
| Ledger altered | Chain verification fails | Red, not dismissible: **Ledger altered at entry #7.** Accept is disabled everywhere with that reason |

5. **First run and default route.** The first visit asks one question: *I write code · I manage the work · I'm learning*. It sets the default route and the Learn default — *I write code*: Review when its queue is non-empty, else Board, Learn off; *I manage the work*: Status, Learn off; *I'm learning*: Board, Learn on; the answer is kept per browser and changeable from the footer. With no answer, a person who has never accepted a card lands on Status.

### 2.3 Keyboard

1. Three tiers: **navigation and triage** (learned in a day), the **command palette** (`⌘K`/`Ctrl+K`; anything in it needs no shortcut, and a palette entry is the default for a new action), and **`g` chords**, one per *visible* view, each the **first letter** of the view's name. The previous chords (`g a`, `g f`, `g q`, `g e`) keep working silently for one release.
2. **No destructive or surprising action has a bare single-key binding**: there is no bare `t` for theme; theme and Learn are toggled from the palette and the footer.
3. **The cheat sheet (`?`) is the specification**: it and the palette are generated from one keymap, and an action not in it has no shortcut. It fits a 900 px-high window (scrolling inside), in four columns: Global, Navigate, Cards, Review. Keys that do not apply to the current view are dimmed.
4. Keys are ignored while focus is in a text field, except `Esc` and `⌘↵`.

| Where | Keys |
| --- | --- |
| Global | `⌘K` palette (`>` commands, `#` cards; no match offers *Ask Seshat: <query>*) · `?` keys · `g` + letter · `⌘J` Seshat panel · `Esc` close/back |
| Board | `h/l` columns, `j/k` cards (cross lane boundaries; `h/l` stay in the lane) · `Space` peek · `Enter` open · `x` select · `c` new card · `v` board/list · `⇧V` pipeline stages · `/` filter · `⇧S` cycle grouping · `Home/End` column ends |
| Board and list, focused card or selection | `⇧P` priority · `⇧E` points · `⇧L` labels · `⇧C` cycle · `⇧A` assignee · `.` any field · in menus `1–9`, `↑↓`, `↵` |
| List | `x` · `⇧J/⇧K` extend · `⌘A` all visible · `Esc` clear · shift-click range · `Space` on a group header collapses it |
| Review and card | `a` accept · `r` send back · `p` park · `z` undo accept (grace window) · `j/k` next/previous · `o`/`Enter` open card · `[` `]` attempts · `f` facts rail · `u` unified/split · `n/N` next/previous annotation · `Space` expand file · `1–5` card tabs |
| Composer | `↵` send · `⇧↵` newline · `@` mention a card · `Esc` back to the page |
| Proposals | `y` apply · `n` discard · `⇧Y` apply all in the group · `j/k` move |
| Decision request | `1–9` pick · `↵` answer |

### 2.4 Board

1. **Five professional columns over the nine stored states** (the same mapping the Jira export uses, so the board and the export agree):

| Column | Stored states | Status badge on the tile |
| --- | --- | --- |
| **Backlog** | backlog | — |
| **To do** | ready, planning | *Being planned* (pencil) · *Blocked · waits on X* |
| **In progress** | in_progress, verify | *Step 5 of 32 · editing src/hasher.ts* (running) · *Checking gates…* · *Types failed · retrying (rung 1 of 4)* (fail) |
| **In review** | review | *4 of 4 gates passed · waiting 2h* (amber after 2 h). The Review WIP limit sits here |
| **Done** | done | *Merged ba1338e · 2h ago* |
| *On hold* (only when non-empty) | parked | *Paused for memory*, *Looping · parked*, or the person's note |
| *Won't do* (a filter, not a column) | rejected | — |

   Verify still gates entry to In review (a transition, not a column). **Pipeline stages** (`⇧V`) splits To do and In progress back into the nine machine columns for operators; the choice is kept per browser.
2. **Columns.** Fluid (`min 200px`, `max 300px`, 8 px gap). **Empty columns collapse into chips above the board** (*Done 4 ›*), never rotated rails; Done is a full column whenever it has cards. In review and On hold are pinned in view when the board scrolls horizontally.
3. **Column header** (36 px): name · `count / limit` for WIP-limited columns · a 2 px capacity bar (`--text-secondary`; amber at capacity; red over) · a Learn *?* when Learn is on · a `⋯` menu (sort by priority, wait time or recently changed; collapse). The In review limit is always shown with its derivation (*limit 3, from 60 review minutes a day at ~20 min per card*); no limit is hidden for being large.
4. **Tile anatomy** (88 px compact; 112 px comfortable adds a one-line spec excerpt and budget detail):

```
┌──────────────────────────────────────────┐
│ ◇ CHR-12                    3 pts  JD·W  │ row 1: type icon · issue key · points · owner avatar, with a W badge while the Worker builds it as delegate
│ Implement canonical JSON and SHA-256     │ row 2: title, 2-line clamp
│ ▮▮▯  Ledger  api  security               │ row 3: priority glyph (hidden when none) · epic chip · ≤2 labels, then +n
│ ✕ Types failed · 3 errors · 22h          │ row 4: status badge (icon + colour + words) · gate pips · work item age
└──────────────────────────────────────────┘
```

   - **Owner and delegate.** A person stays the card's owner; the Worker is a delegate that builds it (the convention Linear, Cursor, Codex and Copilot use), defined in [integrations](integrations.md).
   - **The status never truncates its cause**; it may wrap to two lines inside the 88 px by dropping row 3's labels. A **blocker flag** in red shows `blockedReason` or *Waits on X*.
   - One badge is icon + colour + words, and **never combines a stage with a failure mark** (no "✕ Planning"): it says what is true now (*Needs a new plan*).
   - **Priority glyph**: a fixed 12 px slot; three rising bars (1–3 lit) for Low/Medium/High in `--text-secondary`, a boxed exclamation for Urgent in `--text-primary`; the shape, not colour, carries priority.
   - **Epic chip** uses one of eight muted epic hues (chrome stays neutral). **Labels**: 11 px secondary text in a 1 px outline.
   - **Gate pips**: one 12×12 box per configured gate in `gates.toml` order — ✓ passed, ✕ failed, – skipped, ring running, empty not run — with no letters; the popover (focus or hover) lists each gate's name, state, duration and first error line.
   - **Step-budget bar** (2 px) only while In progress: secondary by default, lapis while running, amber ≥ 75%, red at 100%, with *8 of 32 steps*. Card kind (Contract, Flow, Rules…) and difficulty move to the peek drawer and Facts.
   - **Work item age** shows on every In progress and In review tile (Kanban Guide), turning amber past the 85th-percentile cycle time.
   - **Tile states**: hover `--bg-overlay`; focus a 2 px accent ring; selected (`x`) a `--border-strong` border and a checkbox; both can co-exist. Done tiles are secondary text with no bars.
5. **Moves between columns happen only through recorded, gated actions** (triage, decisions, proposals); there is no drag between columns. **Reordering within a column** (drag or keys) is allowed and is recorded as one event.
6. **Peek drawer** (`Space`, 480 px): gates, failures, outcome, *Done when*, kind and difficulty, a compact file list, and triage keys that work inside it. `Enter` opens the card view.
7. **Quick create** (`c`, or the `+` on a column): a one-line title and optional description that goes through the planner pipeline as a create proposal ([planner-pm](planner-pm.md)) and is shown for Apply. No path ends in "use the CLI".
8. **Live updates** patch only changed tiles, keyed by id; they never re-render the board or reset scroll, focus or an open drawer; a tile that changed shows *just now* for 10 s; no motion.
9. **Scale.** Windowed columns and cards keep 500 synthetic cards scrolling with no main-thread task over 50 ms. Swimlanes are not windowed (they are for filtered views).
10. **Board states:** *No cards yet* with a **Start a project** button (opens Seshat) and a secondary *or plan a feature* line; empty-column copy at the top of the column (*Cards whose dependencies are done.* …); *No cards match "Kind: UI"* with `Clear filter`; review full and memory pause as shell bars, with *Holding for review* on held tiles.
11. **View bar** (40 px): `[Board | List]`, **View** menu (*All cards*, *Current cycle*, *Needs you*, *Urgent and high*, *Unestimated*, and saved views, each with its query in mono), filter chips, `+ Filter` (Priority, Label, Epic, Cycle, Assignee, Kind, State), the query box, **Group** (None, Epic, Assignee, Priority, Cycle), and **Save view** (shown only when the filter differs; saved per browser until a views endpoint exists, and the menu says *Saved in this browser*).
12. **Query language** (GitHub Projects syntax): `priority:urgent,high`, `label:api`, `epic:ledger`, `cycle:current|none`, `assignee:worker|human`, `kind:rules`, `is:blocked|needs-you|running|unestimated`, free words on title and key, `-` to negate; terms AND, values OR; chips and text are two views of one filter object.
13. **Cycle header** (56 px) when a cycle is in force: name, goal, dates, days left; one progress bar split by points into done, in progress and not started; a tick at the linear pace; *4 days left* turns amber with fewer than 2 days left and under 70% done (*Behind the linear pace by 5 pts*); unestimated cards count as 1 point and the header says how many; **Plan next cycle with Seshat** opens the panel with that prompt filled in, not sent.
14. **Swimlanes** by Epic (with its progress bar), Assignee, Priority or Cycle; each lane header (32 px) has count and points; the *No epic* (etc.) lane is last; lanes collapse.
15. **List view** (`#/board/list`, `v`): columns Priority · Key · Title (with kind) · State · Epic · Cycle · Points · Labels · Assignee · Due · Updated; 36 px rows; group headers with count and points; sortable headers (stable, priority as tiebreak); inline edits by click or key with an anchored menu; edits are optimistic, revert on failure and say why; `externalRef` links to the issue.
16. **Bulk bar** (48 px, bottom centre) with the selection's count and points: the field actions, **Park** (one reason, one park per card), **Ask Seshat** (the selection as mentions, not sent); one toast reports the result (*Set on 2 of 3. hasher: the server returned 409.*).
17. **Story map** (`#/board/map`): epics across in the backbone's user order, their slices beneath, a line under the first slice; cards keep their tiles and states. **Burn-up**: done points and total scope as two lines per cycle and per project, so scope growth is visible apart from velocity.
18. **Dependencies** (`#/graph`): cards and `dependsOn` edges; nodes are focusable, named elements (not inside an image), and the view is hidden when there are no edges.

### 2.5 Review

1. **Layout at 1440 px**: queue (296 px) · evidence (fluid, min 560 px) · facts rail (288 px); at 1024 px the rail becomes a *Facts* disclosure and the queue 248 px; on a phone the queue is a full screen and evidence opens with a fixed bottom bar of three 48 px buttons.
2. **Queue**: *Ready for review* (cards in Review, oldest first) and *Needs you* (parked cards, cards failed after the retry ladder, open decisions — the former Inbox — longest wait first). Rows are 56 px: title, then kind · state icon and short stop label · wait time (amber after 2 h).
3. **Evidence column**, in order: breadcrumb and attempt selector; title; outcome line (*Passed on step 1 · 1.2s* or *Failed: Types, Tests · Looping on step 8*); **Reviewer findings** (per criterion met/unmet/unclear with the `file:line`, attributed to *Reviewer* and its model; or the unfilled-role reason — [review-git](review-git.md)); the **gates strip**; **failures**; **changes**; *What the Worker tried* when the evidence carries abandoned hypotheses.
4. **Gates strip**: a segment per gate — icon, name, duration — in `gates.toml` order then derived gates (Size); failed segments get a red top rule and a count (*Types ✕ 3*); skipped ones say *Skipped because Types failed*. With **more than six gates**, gates are grouped by family with a count (*Security 4/4 ✓*), failing groups first, passing ones behind *+6 passed*; on a phone the strip is a vertical list. Focus or hover shows gate id and command in mono, exit code, the first three typed failures and *Show all*; click scrolls to that gate's failures. An empty gate contract (the empty-string hash) adds an amber **Gate contract empty** segment.
5. **Failure block**, one per typed failure: gate icon, `file:line:col` linked to the diff line, the code (`TS2353`); the exact error excerpt in mono; *Expected / Actual* when present; the repro command with Copy; *Suggested:*; a warning when the suggested file is a protected test (*the fix belongs in the implementation*). Identical messages group (*3 × TS2353 in tests/hasher.spec.ts*).
6. **Diff viewer**: files grouped *Implementation* (in scope), *Acceptance tests* (collapsed, lock icon, *staged by Sekhemet · not written by the Worker*), *Outside scope* (expanded, red rule) and *Other*; sticky 32 px file headers with path, role, `+18 −0` and Copy path; old/new gutters; added and removed lines on tints with their `+`/`−` signs kept; inline annotation rows after the line a failure points at (`n/N`); unified or split (`u`); whitespace-only changes hidden with a toggle; files over 400 lines, lockfiles and generated files collapsed; a structural (difftastic) view when available.
7. **Screenshots**: for a visual gate, the baseline, the new capture and a pixel-difference overlay side by side (a slider between baseline and capture), and the images attached to the card; the pure pairing and pixel-diff logic is tested.
8. **Facts rail**: *Done when* (the criteria; neutral bullets unless the Reviewer judged them); *Run* (steps, time, tokens, model, tool set, thinking policy and working method); *Scope* (may edit; protected tests); *Provenance* (gate contract hash with the empty warning, checkpoint sha, evidence id, each with Copy).
9. **Triage bar** (52 px, sticky under the evidence): **Accept `A`** (primary) is enabled only when the card is in Review, every blocking gate passed, triage is on, the ledger is intact and the person holds the Accept permission; when disabled its reason is written beside it, never only in a tooltip. **Send back `R`** (secondary) and **Park `P`** (ghost). For *Needs you* cards, Accept becomes **Retry with planner** once that endpoint exists; until then only Send back and Park.
10. **Accept**: `A` shows *Merging…* with a 3-second grace toast *Accepting "…"* `Undo Z`; `z` in the window cancels with no request sent. Then success *Merged to main as ba1338e* `Copy`, the row leaves and focus moves to the next; a refusal shows the server's message verbatim and the row stays.
11. **Send back**: an inline composer above the triage bar (not a modal): a required textarea *What should the Worker do differently?*; **quick notes** generated from the failures (clicking inserts); *Suggest as a playbook rule* (on); `⌘↵` sends, `Esc` cancels; then *Sent back to Ready with your note* and advance.
12. **Park**: a popover with an optional reason and presets *Waiting on me*, *Needs a decision*, *Not now*.
13. **States**: loading (gates and diff skeletons, queue interactive); empty queue (*Nothing to review. Cards land here when every gate passes.* plus a count of Ready cards and a **Run them** button, not a command); no evidence (*No attempts yet*, only Park); error inline with Retry; a card that changed state while open (*This card moved to In progress 3s ago.* `Reload`); offline and read-only per the shell.
14. **Decision request** (in *Needs you*): the question (15/600) and its category; radio options, each with consequence, *Effort +6 steps / ~7k tokens*, *Risk: …* and a *Preview* disclosure (files, symbols, blast radius); the **Recommended** tag (neutral, not gold) with its rationale; the policy line (*If you don't answer by 16:00 (in 2h 14m), option B is applied.* or *If you don't answer, the card stays parked.* with a lock); the countdown updates each minute and turns amber under 15 minutes; destructive options have a red rule and an explicit confirm.

### 2.6 Card view

`#/card/:id/{evidence,plan,steps,thread,files}` (`1–5`). Header (96 px): breadcrumb, title with kind, state pill with its sentence, triage buttons (same rules as Review) and a `⋯` menu (Copy id, Open worktree path, View in ledger).
- **Evidence** — the Review composition, full width.
- **Plan** — spec; *Done when*; *May edit* and protected *Acceptance tests*; budgets (steps, tokens, seconds as used/budget bars); difficulty as a 10-segment meter with routing (*Direct / Edit sketch / Split*); *Waits on* and *Unblocks*; the slice's rationale; the planner's repair plan for attempt 2+.
- **Steps** — one row per step: tool calls (`write_file src/hasher.ts`) with their observation summaries, gate results, tokens and time right-aligned; loop detection annotated where it fired; the final row states the stop. Live steps append with no animation; auto-follow pauses when scrolled up (*3 new steps ↓*); `write_file` rows expand to the written content.
- **Thread** — the card's ledger timeline in sentences: created, moved, returned (note as a quote), parked, decisions, accepted with sha.
- **Files** — path, role (*May edit* / *Protected test* / *Outside scope*), `+/−`, gate failures per file; a row jumps to the file in Evidence.
- Tabs with no data say so (*No steps yet. The Worker hasn't started this card.*).

### 2.7 Seshat: the panel and the full view

1. **Two places, one thread.** A right **panel** toggled with `⌘J` from any view: a 400 px dock from 1280 px (the view narrows; board columns relax to a 184 px minimum and Working-side columns scroll beside pinned In review and On hold); a 380 px overlay from 1024 to 1279 px; hidden on `#/pm` and below 768 px (the bottom bar's PM tab opens the full view). Open or closed is remembered per browser. The **full view** `#/pm` has a 720 px reading column and a 288 px rail: *Open proposals*, *Worker* (state, step, paused), *What Seshat can see* (board snapshot time, last run, ledger head) and the three strongest *What Seshat has learned about you* statements.
2. **Header**: *Seshat · Project manager*, a plain monogram avatar (no gold, no face), and the current phase when waiting. The model id is in the header's details, not in the composer's copy.
3. **Messages**: yours right-aligned on `--bg-raised` (max 85%); Seshat's full-width prose under a one-line header; system lines centred at 11 px. Markdown is limited to paragraphs, lists, bold, code, fenced code and `###` headings, rendered by an escape-first renderer; links from model text render as text.
4. **Card chips**: `@card` in either direction renders state icon, key and title (32 characters); click peeks, `⌘`-click opens; **unknown ids render as plain mono text**. `@` in the composer opens a fuzzy card picker. **Cites** render as *Based on:* chips for cards, runs and evidence; research sources render as a numbered **Sources** list (http and https only, new tab, `rel="noopener noreferrer"`, host in mono).
5. **Context chip** above the composer: *Looking at: Board · Cycle 12 · 2 filters* or *Looking at: @hasher*; `✕` drops it for the next message; it returns when you move. Sent as `context: { cardId?, view }`.
6. **Composer**: grows 1–8 lines; **starter prompts** when the thread is empty or idle 12 h — *Standup*, *What's at risk this week?*, *Plan the next cycle*, **Start a new project** — plus a contextual one (*Why did @hasher fail?* for a failed focused card; *Split @http* over 5 points). A **cost line** in plain words says what sending does: *Seshat will reply in about a minute.* / *The Worker will pause after its current step while Seshat answers, then carry on.* / read-only: how to enable. No model ids or API paths.
7. **Proposal group** at the end of a reply: header *Proposed changes · 3 open* with *Discard all* and *Apply all ⇧Y* (*Apply 3 changes to 5 cards*). A **field diff** per field: label, the before value struck on the fail tint, an arrow, the after value on the pass tint; values as people read them (priority glyph and word, `3 pts`, cycle and epic names, *Worker* / *You*, `Sep 29`, *None*); labels diff as a set (`+ security − later`). Create and split show numbered new cards with kind, points and *waits on 1*; moves show *Ready → Backlog*; park shows the reason. States: *Open*; *Applied* (one line, pass check, *by you at 09:05*); *Discarded* (one struck line); *Stale* (amber rule, *@hasher changed after Seshat proposed this. Ask again.*, Apply disabled). *Apply all* stops at the first failure (*Applied 2 of 3. "Split @http" failed: card is in progress.*). Applied is final and says so. **Imports use the same component** (*Import from Jira CSV · 42 proposed changes*).
8. **Waiting is a procedure with times**, not a spinner. A pending block under Seshat's header shows rows with durations and a total timer:

| Phase | Row | Detail |
| --- | --- | --- |
| `waiting_for_step` | **Pausing the Worker after step 5** | *The Worker is never stopped mid-edit.* |
| `loading_pm` | **Loading the project manager · about 40s** | A 2 px bar toward the ETA; past it, *Taking longer than usual.* |
| `thinking` | **Thinking** | Elapsed; after 90 s *Long answers can take up to two minutes on this machine.* |
| `resuming_worker` | **Resuming the Worker** | *Step 6 starts next.* |

   Worker rows are omitted when nothing was running. The shell footer says *Worker paused after step 5 while Seshat replies* (lapis, not amber); the running tile reads *Paused for Seshat · step 5 of 32*. A second message shows *Queued · Seshat answers in order*. An error shows *Seshat couldn't reply.* with the server text and `Retry` (same text and context). Offline freezes timers and disables the composer.
9. **Surface states**: *Seshat isn't on this server yet* (thread endpoint 404; composer disabled with the reason; the nav item stays); first conversation — a one-paragraph local introduction (*I'm Seshat, the project manager for Chronicle. I read the board, the runs and the ledger, and I propose changes you approve. I never change the board myself.*) then the starters; loading (three skeleton lines); thread error with Retry.

### 2.8 Status: the non-developer's home

`#/status` (`g s`; the phone's first tab):
1. A **sentence headline** in plain words from the ledger (*On track: 4 of 6 cards done. 1 needs a new plan; Seshat suggests splitting it.*).
2. **Burn-up** for the current cycle or project.
3. **Needs you**, each item with plain buttons (*Review it*, *Answer*, *Unpark*).
4. **What changed today** — the standup in plain mode ([planner-pm](planner-pm.md)).
5. **Risks** — the live signals that fired, in sentences.
6. An inline **Ask Seshat…** box and a primary **Start a new project** button that opens Seshat with the start-project conversation.
7. Every label uses `plainStatus` (*Being planned*, *Being built*, *Waiting for review*, *Done*); no stop-reason codes, ids or gate names without words. It works at 400 px.

### 2.9 The Learn layer

1. **Off for experts, on for learners**, set by the first-run question and toggled by a labelled **Learn** button (book icon and the word) in the topbar, the footer and the palette; kept per browser. It sets one `data-learn` attribute; **when off it adds no DOM and no layout**.
2. **Contextual, dismissible, findable again** (NN/g): when on, key terms get a dotted underline and a small *?* button — on column headers, the WIP count and bar, gate pips and the gates strip, the points field, the cycle header, each Insights chart, and Seshat's proposals (*I split this Path-first because…*). The *?* opens an **accessible popover** (keyboard reachable, not a `title`): two sentences on *what it is*, one line **from your own numbers** (*In review holds at most 3 because you review about 60 minutes a day and a review takes about 20*), and one link to the canon (Kanban Guide, INVEST, SPIDR — linked, not copied: CC BY-SA). Standard conventions are not explained.
3. **The Learn sheet**: 8–10 short lessons as a checklist — why each column exists and what moves a card; WIP limits and Little's law from their numbers; thin vertical slices (SPIDR) and INVEST; done = gates + a person's accept; points versus time; cycles, burn-up and cumulative flow; work item age and the service-level expectation; why review is the bottleneck. **Show me** highlights the live element.
4. Content lives in one pure module (`learn.ts`), unit-tested and shared with Seshat's teaching mode. Empty states double as learning cues.

### 2.10 Insights

`#/insights`, over 7, 30 or 90 days:
1. **Headline**: cycle time (85th percentile), throughput (cards a day), work in progress (with how many are older than the 85th percentile), oldest in progress. The **service-level expectation** sentence: *85% of cards finish within 6.2 hours.*
2. **Four charts**, each titled as its question: **Aging WIP** (*What is getting old?* — one dot per unfinished card by column and age, 50th and 85th percentile bands, dots above 85% amber, click peeks) first; **Cycle time** (*How long do cards take?* — scatter with 50/85/95% lines); **Throughput** (*How much finishes?* — daily bars with a 7-day average); **Cumulative flow** (*Where do queues form?* — stacked bands in stack order); plus **Burn-up** (§2.4.17).
3. **Worker capability**: per card kind, pass rate with its 95% Wilson interval and *16 of 18 passed · 89% (67–97%)*; fewer than 10 attempts says *Too few attempts to trust* with a hollow point; pass rate by change size with an 80% line and the horizon sentence (*passes 80% of cards that change up to about 62 lines*); retries run on an escalation model are excluded and said so.
4. **Stopping policy**, when a tuning report exists: the headline, current-versus-recommended table, the copyable `sekhemet queue --max-turns 12`, and the caveat that replay never credits a pass the Worker did not make.
5. Charts are SVG coloured only through token classes, tabular numerals, no gridlines beyond a baseline and percentile rules, each with a `figcaption` sentence and a hidden data table. Axis ticks are never repeated; plurals are correct. Under 3 finished cards: *Not enough finished cards to measure flow yet. Insights need at least 3; you have 1.*

### 2.11 The other views

- **Runs** — a list of runs (date, model, *3 of 6 first try*, duration) and a scorecard: headline numbers with deltas against the previous run; a timeline whose segment widths sum to 100%; the cards table with *Why it stopped*; stops by reason, each linked; run settings (Worker, manager, model swaps, harness commit). A run in progress grows live.
- **Ledger** — one sentence per event (*Worker moved **…** from In progress to Verify*), seq, time, actor, type and short hash in mono; filters by card, actor and type; a row opens the payload, payload hash, hash and prev; the header states integrity; a broken chain marks the first bad row.
- **Machine** — memory gauge with the 85/90/94% thresholds and what happens at each; the models by role (*Resident*, *Swapped out*, *Not configured*) with one footer line on how they share memory; health checks with plain fix hints; sandbox mode; worktrees. *Re-run checks* bypasses the cache.
- **Playbook** — *Needs your approval*, *Active* (retirement proposals first, with the counts that justify them), *Retired*; each rule's audience, source in words, scope chips, value bar, helpful/harmful counts and evidence chips; approve with reach (*This project* / *All projects*); inline edit; **What Seshat has learned about you** (`#/playbook/profile`) grouped by category with strength words (*Strong* ≥ 0.7, *Moderate* ≥ 0.4, *Weak*), evidence, Edit and Dismiss.
- **Registry**, **Workspace** — the bake-off matrix and the multi-project rollup (cards waiting on you across projects, with wait times).
- **Integrations** — renders what `/api/integrations` returns ([integrations](integrations.md) owns the catalogue and behaviour); no roadmap is hard-coded in the page, and nothing is connected by default. Every card states in one line **what leaves this machine when connected**:

| Card | Body and controls | Leaves this machine |
| --- | --- | --- |
| GitHub Issues and Projects | *Connected to acme/chronicle via gh* or *gh isn't signed in*; *Last synced 12 minutes ago*; last result *4 created · 9 updated · 2 skipped · 0 errors*; **Pull**, **Push**, **Sync both**; errors verbatim | Card titles, specs, priority, points, cycle and state, to the repository you choose; uses your `gh` login, no stored token |
| Pull request on Accept | A switch with the current behaviour beside it (*Accept merges locally as one commit*) | The card branch, its diff and gate results |
| Jira · Linear | **Export** (their CSV columns) and **Import…**; never shown as "Connected" | Nothing: you upload the file yourself |
| Slack | Webhook field, **Connect**, **Send test message**, **Disconnect**; the channel host, the last message and whether it was delivered; a lock line: the webhook URL is a credential kept in `~/.config/sekhemet` with mode 0600, never in the repository or the ledger | Standup text, titles of cards that need you, run summaries |
| Research web access | A switch; which search provider is configured, or how to configure one | Search queries and the URLs of pages read; private and local addresses are never fetched |

  **Import** opens a sheet (format picker: Jira CSV, Linear CSV, GitHub JSON, Sekhemet JSON; file chooser; paste box); **Preview** renders the returned proposals with the §2.7 component and posts the same preview into Seshat's thread. Export downloads `sekhemet-<project>-<format>.csv|json`.

### 2.12 Voice and vocabulary

1. **One label source.** Every column, state, stop reason, gate, kind and actor label comes from `vocabulary.ts` (and `plainStatus` for the plain mode), served to the page; the browser never re-derives a label, and no second status map exists anywhere. Words follow [NAMING](../NAMING.md).
2. Internal enums appear only in mono where a developer might grep for them (evidence detail, ledger rows). Compiler and gate errors are quoted verbatim. Actors are named *Worker*, *Planner*, *Reviewer*, *You* (or the person's name) and *Sekhemet*.
3. **No operator language on user surfaces**: no API paths, model ids in running copy, or "N-step budget" on the board face. A missing endpoint reads *X isn't on this server yet* with the endpoint in a details line.
4. **The essentials the label source must carry** (short label · sentence · tone):

| Kind of term | Labels |
| --- | --- |
| Stop reasons | Passed · *All gates passed on step N.* · pass — Out of steps · *Used all 32 budgeted steps without passing.* · fail — Looping · *Repeated the same actions without changing any file.* · fail — Stalled · *No file changed for 3 steps.* · fail — Couldn't fix · *Tried N repairs; the same gate kept failing.* · fail — **Paused for memory** · *Stopped safely at 94% memory. Resumable.* · **parked, not fail** (a safety stop) — Paused for quota · parked — Harness error · *Sekhemet failed, not the Worker.* · fail — Out of scope · *Tried to edit a file this card may not touch.* · fail — Too hard for this model · *Needs a split or a stronger model.* · parked — Stopped by you · neutral |
| Gates | Parse · Types · Tests · Lint · Size · Visual (id kept in mono in evidence); states Passed · Failed · **Skipped** (configured, not run because an earlier blocking gate failed) · **Not run** (the card never reached gates) · Running; *4 of 4 gates passed* |
| Card kinds | Contract · Storage · Flow · Rules · Research · UI · Wiring (at most two, the first primary); with Learn on, each names its SPIDR slice (Interface, Data, Path, Rules, Spike) so a learner can look it up |
| Card facts | *Done when* (criteria) · *May edit* (scope) · *Acceptance tests* (protected) · *Waits on* / *Unblocks* · *Difficulty 6/10* · *Why it stopped* · *Checkpoints* · *Gate contract* · *8 of 32 steps* (a transcript turn is a step) · *Tokens 16.8k in · 1.4k out* |
| Actions | Accept · *Merges to main as one commit.* — Send back · *Returns the card to Ready with your note for the Worker.* — Park · *Sets the card aside. Nothing runs until you unpark it.* |
| Errors | What, why, action: *Couldn't load evidence for hasher. The server returned 500.* `Retry`; a refused accept quotes the server (*Card is in Verify, not Review.*); *This action must come from the dashboard. Reload the page.* |

### 2.13 Visual system

1. **Tokens** are the single source of truth for colour, published as CSS custom properties and JSON (`tokens.ts`, `/tokens.css`, `/tokens.json`); components never hard-code a colour. Fifteen roles per theme — `bg-base`, `bg-surface`, `bg-raised`, `bg-overlay` (the surface ladder: depth by luminance, **no drop shadows**), `border-subtle`, `border-strong`, `text-primary`, `text-secondary`, `text-muted`, `accent` (Egyptian gold), `state-pass` (Nile green), `state-fail` (red ochre), `state-running` (lapis), `state-parked` (needs you), `state-blocked` — plus derived `on-accent`, `on-state`, `scrim`, `tint-{pass,fail,running,parked}` (12% Basalt, 10% Sand) and layout constants. The values are in `tokens.ts`, not here.
2. **Colour roles (P12):** the warning/parked hue is moved clearly apart from the accent (a copper, ≈ `#C8743A` Basalt / `#9A4F1C` Sand, re-measured); **disabled buttons use a neutral fill**, never faded gold; a **`--border-control`** role at ≥ 3:1 edges every input; **`--text-muted` is decorative only** (line numbers, disabled controls) and never carries text a person must read, placeholders included.
3. **Colour per tone**: running — fill, rule, text only on base/surface, tint for the live step; pass — quiet, no rule; fail — fill, rule, tint for failure blocks and removals; parked — fill, rule, shell bars; blocked — secondary text.
4. **Type**: Inter and JetBrains Mono with system fallbacks; sizes 11 / 12.5 / 13 / 15 / 18 / 22 px; leading 1.25 / 1.45 / 1.55 (code); tabular numerals for every number. Usage: wordmark and view titles 15/600; card title in Review 18/600; scorecard numbers 22/600; section headings 12.5/600; body and tile titles 13; meta 11 secondary; code 12.5 mono.
5. **Spacing** 2, 4, 8, 12, 16, 24, 32 px; **radius** 4 px controls and chips, 6 px cards, 0 for full-bleed panels; **motion** 120 ms ease-out for hover, press, focus, drawer and popover only; board reflow, streaming and patches append with no animation; the running dot's pulse (1 → 0.35 opacity, 1.6 s) is the only perpetual animation; `prefers-reduced-motion` removes it and all translates.
6. **Icons**: one 1.5 px line set on a 24 viewBox, `currentColor`, round caps, no fills except `dot`, no emoji or Unicode check marks in the product; distinct glyphs for every nav item (Review and Inbox never share one). **Brand**: the pylon gate with a sun disc (`M3 20 L5.5 9 H10 V20 M21 20 L18.5 9 H14 V20 M2 20 H22` plus a circle at 12,6 r 2.25) in accent; wordmark *Sekhemet* in Inter 600; favicon the glyph on a 6 px rounded `bg-base` square; no mascot, lion or tagline in the chrome. Where the product introduces itself: *Sekhemet — a coding harness for professional teams*.
7. **Component sizes**: sidebar item 28 px; column header 36 px; tile padding 8/12 px; review queue row 56 px; evidence padding 24 px; gates segment 32 px; diff line 20 px; triage bar 52 px; palette 600 px wide, rows 36 px; toasts 360 px, bottom-left, at most 3, success 4 s, errors until dismissed, hover pauses; Seshat panel 400 px (header 52 px, 16 px padding, 24 px message gap); proposal group header 36 px, diff rows 24 px; view bar 40 px; cycle header 56 px; lane header 32 px; table row 36 px; bulk bar 48 px; chart plot 240 px.

### 2.14 Accessibility

1. Every colour pair used as text or as a control's only edge meets WCAG 2.2 AA **as used**, asserted by a test over the tokens in their actual pairings (placeholders, Sand accent on raised, state text on tiles). State-coloured text sits only on base or surface; on raised tiles state is carried by the icon (≥ 3:1) with secondary words.
2. **Nothing a person needs is only on hover**: WIP reasons, full status lines, gate names and priority meanings are in keyboard-reachable popovers or visible text.
3. Landmarks (`nav`, `header`, `main`, `aside`); the board a roving-tabindex listbox per column with `aria-selected` and the status line as description; the gates strip a list of named buttons (*Types: failed, 3 errors, 0.7 seconds*); WAI-ARIA tabs; palette and cheat sheet as modal dialogs that trap and return focus (the palette a combobox); the Seshat panel a `complementary` landmark with its thread as `role="log"`, announcing only final replies (*Seshat replied. 2 proposed changes.*); proposals a list of labelled groups with Apply/Discard names including the summary; field diffs as `dl`; the bulk bar a toolbar announcing *3 selected*; one polite live region for the focused card and triage results.
4. Focus order in Review: queue → gates strip → failures → diff files → triage bar; `Tab` inside the diff visits file headers and annotations, not lines.
5. Focus: a 2 px accent outline, offset 1 px, on `:focus-visible` (≥ 3:1 on every surface). Targets ≥ 24×24 px on desktop (copy buttons included) and ≥ 44×44 px on a phone. Layouts hold at 200% zoom. Every control has an accessible name.

### 2.15 How it is built

1. **Static, build-free ES modules** served from `packages/ui/web` under `/app/`; no framework, no CDN, works air-gapped; the served page is a small shell. Presentation logic is pure TypeScript in `packages/ui/src` (vocabulary, board model, tile model, nav model, keymap, learn content, filter language, flow maths), served as `/app/lib/*.js` and unit-tested with exact values; web modules only render.
2. Live data arrives on the server-sent event stream (`/api/stream`); windowing is the page's own (`virtual.js`); CSS is organised per component. The server enriches each card with a `display` object from the vocabulary (title, kinds, key, state label, status line, tone, entered-column time, waits-on, evidence summary) and publishes the vocabulary as `/vocab.json` for plugin panels.
3. **Responsive.** 1440 px: everything at full size. 1024–1279 px: labelled narrow sidebar; board columns min 220 px with horizontal scroll and In review / On hold pinned; Review's facts rail as a disclosure. < 768 px: the bottom bar; the board as one column with a segmented column switcher (*To do 4 · In progress 1 · In review 1 …*) and full-width tiles; the card view shows Evidence only; triage is one tap on 48 px buttons with send-back in a bottom sheet; no create or bulk actions; Status and PM fully usable.
4. **Palette.** 600 px at 12vh; a 48 px, 15 px input; groups *Actions on the focused card*, *Cards*, *Go to* (with chords), *Preferences* (theme, density, Learn); fuzzy matches highlighted; each row shows its shortcut; `⌘↵` opens a card in the card view; the empty query shows recent cards and top actions.
5. **Verification of every UI change**: seed a fixture project, open it at 1440×900, 1100×800 and 400×812 in both themes, compare with `docs/design/mockups/`, exercise the change's keys with the keyboard only, and require an empty error console.
6. **Security, page side (S3c):** every mutating request carries the per-session token the server issued to this page (not a constant header); the page runs under a Content-Security-Policy with no inline script and `frame-ancestors 'none'`; model and repository text reaches the DOM only through escaping renderers. The server side (Host check, token issue, headers) is [runtime](runtime.md) and [security](security.md).
7. **Company server (D7), page side:** the footer shows who you are; Accept is disabled with *You don't have the Accept permission on this project* when you lack it; ledger and thread entries name people, not "human".

## 3. Contract

| Item | Where |
| --- | --- |
| Labels, `statusLine`, `describeCard`, `columnLabel`, `stopReasonLabel`, `BOARD_COLUMN_ORDER`, `COLUMN_EMPTY`; new `BOARD_COLUMNS`, `boardColumnOf(status)`, `plainStatus` | `packages/ui/src/vocabulary.ts` |
| Tokens, derived roles, layout, typography | `packages/ui/src/tokens.ts` (`/tokens.css`, `/tokens.json`) |
| Icons | `packages/ui/src/icons.ts` |
| Filter language, proposal diffs, PM markdown, cycle progress, flow maths, waiting phases, capability rows, learning views | `packages/ui/src/pm.ts` (to split by concern) |
| New pure modules | `learn.ts` (lessons), `keymap.ts` (one keymap for cheat sheet and palette), board/tile/nav models |
| Web modules | `packages/ui/web/*.js` (shell, keys, board, tile, lanes, list, viewbar, fields, bulk, review, evidence, gates, failures, diff, triage, card tabs, pm_panel/pm_view/pm_thread/proposals, insights, runs, ledger, machine, playbook, registry, workspace, graph, integrations) |
| Endpoints consumed (defined in [runtime](runtime.md); PM shapes in [PM_CONTRACT](../PM_CONTRACT.md)) | `/api/board`, `/api/stream`, `/api/meta`, `/api/cards/:id`, `/api/evidence/:card?attempt=`, `/api/cards/:id/transcript`, `/api/events`, `/api/gates`, `/api/runs`, `/api/machine`, `/api/models`, `/api/playbook`, `/api/learning`, `/api/decisions`, `/api/pm/*`, `/api/cycles`, `/api/metrics/flow`, `/api/capability`, `/api/integrations`, `/api/import`, `/api/export`, `/api/goals`, `/api/standup`, `/api/signals`, triage `POST`s, `PATCH /api/cards/:id` |
| Routes | `#/status`, `#/pm`, `#/review`, `#/board`, `#/board/list`, `#/board/map`, `#/card/:id/:tab`, `#/insights`, `#/runs[/:id]`, `#/graph`, `#/playbook[/profile]`, `#/integrations`, `#/machine`, `#/ledger`, `#/registry`, `#/workspace`, `#/inbox` (opens Review › Needs you) |
| Per-browser settings | theme, density, Learn, first-run role, pipeline stages, panel open, saved views |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Review surface: queue, evidence, gates, failures, grouped diff, facts, triage with grace undo | built | `review.js`, `evidence.js`, `diff.js`, `triage.js`; `diff_parse.spec.ts`, triage endpoints in `server.spec.ts:311-355` | — |
| Gates strip readable at many gates and on a phone; no stage+failure badge | not-built | 14 gates overlap; "✕ Planning" (domain17 §2) | NEW-dashboard-1 |
| Card view tabs, peek, palette, toasts, cheat sheet | built | `card.js`, `peek.js`, `palette.js`, `cheatsheet.js` | NEW-dashboard-2 (no behaviour tests) |
| Nine machine columns; five professional columns; pipeline toggle | partial | `BOARD_COLUMN_ORDER` (`vocabulary.ts:73`); the professional mapping exists only in the Jira export (`integrations.ts:274-284`) | P3 |
| Tile anatomy: key, type, assignee, epic, blocker cause, age | partial | Priority, labels, points on the tile (`tile.js:168-170`); no key (`shortId` slug, `vocabulary.ts:359`), no assignee or epic, `blockedReason` never rendered, "40-step budget" (`vocabulary.ts:615`), cause truncated (`tile.js:171`) | P3 |
| Review WIP limit visible | not-built | `LIMIT_SHOWN = 20` hides larger limits (`board.js:37,108`) | P3 (with S6 in [review-git](review-git.md)) |
| Collapsed columns as chips; Done a full column | not-built | Rotated rails; Done forced to a rail below 1600 px (`board.js:99`) | P3 |
| Quick create without the CLI | not-built | `c` shows "Create cards from the CLI" (`board.js:580`) | P3 |
| View bar, query language, saved views, swimlanes, cycle header, list, bulk, inline edit | built | `viewbar.js`, `lanes.js`, `list.js`, `bulk.js`, `fields.js`; `pm.spec.ts:288-390` | — |
| Reorder within a column | built | `reorder.js`; `reorder.spec.ts` | — |
| Story map; burn-up | not-built | — | P3 |
| Seshat panel and full view, proposals, waiting phases, surface states | built | `pm_panel.js`, `pm_view.js`, `pm_thread.js`, `proposals.js`; `pm.spec.ts:123-290, 428-455` | — |
| Composer copy without operator language; Start a new project starter | not-built | "Seshat runs locally on dirk-27b" (`pm_thread.js:248`); starters lack it (`pm_thread.js:252`) | P5 |
| Status view for non-developers | not-built | `/api/standup`, `/api/signals`, `/api/goals` have no UI client (`wave2_server.ts:282-297`) | P5 |
| Learn layer | not-built | Teaching only in `title` tooltips (`board.js:106-119`) | P4 |
| Grouped, labelled, progressive navigation; phone bottom bar; first-letter chords; no bare `t` | not-built | 13 flat items, only Inbox conditional (`shell.js:6-28`); no nav < 768 px (`shell.css:513`); chords `g a/f/q/e/s` (`keys.js:13-27`); bare `t` (`keys.js:91`) | P11 |
| First-run role question and default route | not-built | Default is Review or Board (`app.js:52-53`) | P11 |
| Insights: flow charts, capability, stopping policy | built | `insights.js`; flow maths and capability rows in `pm.spec.ts:392-480` | — |
| Runs, Ledger, Machine, Playbook and profile, Registry, Workspace, Dependencies, Integrations | built | `runs.js`, `ledger.js`, `machine.js`, `learning_view.js`, `registry.js`, `workspace.js`, `graph.js`, `integrations.js`; `server_runs.spec.ts`, `pm.spec.ts:480-560` | NEW-dashboard-2 |
| Integrations page without a hard-coded roadmap | not-built | Catalogue and Now/Next/Later list in `integrations.js` | NEW-dashboard-2 |
| Tokens, contrast test, icons test | partial | `tokens.spec.ts`, `icons.spec.ts`; warn hue equals accent hue (40°); disabled Accept 2.1:1 (`base.css:163`); `border-strong` 1.3–1.9:1 on inputs; muted placeholders 2.6–3.6:1 | P12 |
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
- WHEN a tile renders THE SYSTEM SHALL show the issue key, type icon, points (when set), assignee, title, priority glyph (only when priority ≠ 0), epic chip, up to two labels, the status badge and, for In progress and In review, the work item age.
- WHEN a card has a `blockedReason` or an unfinished dependency THE SYSTEM SHALL show a blocker flag with its cause on the tile.
- WHEN the status text is longer than one line THE SYSTEM SHALL wrap it and never cut off the cause.
- WHEN a card is in Backlog or Ready THE SYSTEM SHALL show no step budget on the board face.
- WHEN the In review limit is computed THE SYSTEM SHALL show `count / limit` and its derivation whatever the limit's size.
- WHEN a column is empty THE SYSTEM SHALL show it as a chip above the board, and Done SHALL be a full column whenever it has cards, at every width.
- WHEN a person presses `c` or a column's `+` THE SYSTEM SHALL open a create form whose result is a proposal from the planner pipeline, and no message SHALL tell them to use the CLI.
- WHEN a board has epics with slices THE SYSTEM SHALL render `#/board/map` with epics in backbone order and the first slice marked.
- WHEN a cycle is in force THE SYSTEM SHALL render a burn-up with separate done and scope lines.
- WHEN a developer uses the board at 1440 and 1100 px THE SYSTEM SHALL let them find which card is blocked and why within three actions (DEFINITION_OF_DONE §6.4).

### P4 — The Learn layer
*The claims table says "not built"; teaching exists only in hover tooltips.*

- WHEN Learn is off THE SYSTEM SHALL render zero Learn nodes and the same layout as without the feature.
- WHEN Learn is on THE SYSTEM SHALL show a *?* on every column header, WIP count, gate pip group, points field, cycle header and Insights chart.
- WHEN a *?* is activated by keyboard THE SYSTEM SHALL open a popover with the concept, a line computed from the project's own numbers, and a link to its canonical source, and `Esc` SHALL return focus to the *?*.
- WHEN the In review limit is 3 at 60 review minutes a day THE SYSTEM SHALL say so in that popover with those numbers.
- WHEN `learn.ts` is tested THE SYSTEM SHALL have a lesson for every board column, every gate family and every Insights metric.
- WHEN a person answers the first-run question with "I'm learning" THE SYSTEM SHALL turn Learn on; with "I write code" it SHALL stay off.
- WHEN a beginner with Learn on starts from the board THE SYSTEM SHALL let them reach the explanation of a WIP limit by keyboard alone (DEFINITION_OF_DONE §6.4).

### P5 — Status for non-developers, and starting a project without a terminal
*Non-developers land in jargon; the standup, signals and goals APIs are unused; every "start" path ends at a terminal.*

- WHEN a person opens `#/status` THE SYSTEM SHALL show a plain-language headline, a burn-up, *Needs you* with buttons, today's standup in plain mode, the fired signals as sentences, an Ask box and a **Start a new project** button.
- WHEN any Status or plain-mode text is rendered THE SYSTEM SHALL contain no stop-reason code, card id without a title, or gate id without words.
- WHEN **Start a new project** is pressed THE SYSTEM SHALL open Seshat with the start-project conversation, and applying its proposal group SHALL create the project's cards with no terminal step.
- WHEN the palette query is "new project" THE SYSTEM SHALL offer *Start a new project*; WHEN a query matches nothing THE SYSTEM SHALL offer *Ask Seshat: <query>*.
- WHEN the composer's cost line renders THE SYSTEM SHALL contain no model id and no API path.
- WHEN a non-developer at 400 px wide starts a project and then asks how it is going THE SYSTEM SHALL complete both without a terminal (DEFINITION_OF_DONE §6.4).

### P11 — The navigation
*14 flat items, labels lost at laptop widths, no phone navigation, chords that are not mnemonics, a bare `t`.*

- WHEN the dashboard has no runs, no dependency edges, no bake-off and one project THE SYSTEM SHALL show no Runs, Dependencies, Registry or Workspace item.
- WHEN the window is 1100 px wide THE SYSTEM SHALL show every nav label.
- WHEN the window is 400 px wide THE SYSTEM SHALL show a bottom bar with Status, Review, Board and PM, each reachable in one tap.
- WHEN a person presses `g` then a letter THE SYSTEM SHALL go to the visible view whose name starts with that letter; `t` alone SHALL do nothing.
- WHEN the cheat sheet opens in a 900 px-high window THE SYSTEM SHALL show every key group without clipping, and every entry SHALL come from the same keymap as the palette.
- WHEN decisions are waiting THE SYSTEM SHALL list them under Review › *Needs you* and `#/inbox` SHALL open that group.

### P12 — Colour and contrast
*Gold and warning amber share a hue; disabled Accept is 2.1:1; input borders 1.3–1.9:1; placeholders carry instructions in muted text.*

- WHEN the token test runs THE SYSTEM SHALL assert every text pair as used ≥ 4.5:1 and every control edge and state icon ≥ 3:1, in both themes.
- WHEN the parked/warning hue and the accent hue are compared THE SYSTEM SHALL find at least 20° of hue between them in both themes.
- WHEN a button is disabled THE SYSTEM SHALL render it with a neutral fill, and its reason as adjacent text.
- WHEN any input renders THE SYSTEM SHALL edge it with `--border-control`.
- WHEN any placeholder or information-bearing text renders THE SYSTEM SHALL NOT use `--text-muted`.
- WHEN the accessibility check runs over every route at 400, 1100 and 1440 px in both themes THE SYSTEM SHALL find no control without an accessible name, no target under 24×24 px on desktop, and no information available only on hover.

### P13 — Where "done" is drawn (page side)

- WHEN a project has a requirement graph THE SYSTEM SHALL show its story map with the backbone of user activities, the release slices as horizontal bands, and each requirement as proven, planned, unplanned or cut.
- WHEN the Status view shows a project THE SYSTEM SHALL state the proven count of must-have requirements per slice ("9 of 11 must-haves proven") and the appetite used, in plain words.
- WHEN a slice reaches its appetite THE SYSTEM SHALL show Seshat's three choices (accept as proven, cut named nice-to-haves, extend) as buttons in Needs you.
- WHEN the Learn layer is on THE SYSTEM SHALL explain the walking skeleton, release slices, must-have versus nice-to-have, and appetite where they appear.

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

### NEW-dashboard-2 — A web layer under test, with one vocabulary
*About 60 modules are checked for syntax only; four status maps; wave-named CSS; a hard-coded integrations roadmap (domain13 §3, §5). Not in COVERAGE beyond T9's general gaps.*

- WHEN the board, tile and nav models are tested THE SYSTEM SHALL assert exact outputs for every stored state, including at least two negative cases per model.
- WHEN the ledger fails verification THE SYSTEM SHALL disable Accept on Review, the card view and the peek drawer, asserted by a test.
- WHEN the repository is searched for status-to-label maps THE SYSTEM SHALL find exactly one, in `vocabulary.ts`.
- WHEN `/api/integrations` omits an integration THE SYSTEM SHALL NOT show it.

## 6. v1 acceptance

All criteria in §5, plus:

- WHEN Accept is pressed THE SYSTEM SHALL show a 3-second grace toast, and `z` within it SHALL cancel with no request sent.
- WHEN send back is submitted with an empty note THE SYSTEM SHALL block it client-side with *Add a note for the Worker.*
- WHEN one shell state is active and another begins THE SYSTEM SHALL show only the higher-priority bar (ledger altered > offline > memory pause > review full).
- WHEN the stream is silent for more than 10 s and `/api/meta` fails THE SYSTEM SHALL show *Offline since …*, freeze timestamps and disable every action.
- WHEN a stream frame changes one card THE SYSTEM SHALL patch that tile only, keeping scroll position, focus and any open drawer.
- WHEN a Seshat reply mentions an id that is not a card THE SYSTEM SHALL render it as plain text.
- WHEN a proposal is stale THE SYSTEM SHALL disable its Apply and say why.
- WHEN 500 cards are loaded THE SYSTEM SHALL scroll the board with no main-thread task over 50 ms.
- WHEN `prefers-reduced-motion: reduce` is set THE SYSTEM SHALL show no pulse and no translate.
- WHEN a tile is in a WIP-limited column at capacity THE SYSTEM SHALL colour its capacity bar amber, and red over the limit.

## 7. Later

- **Rewind from the card view** ("rewind to step N": reset the worktree to that checkpoint, record the rewind, invalidate later gate passes). `sekhemet rewind` and `fork` exist on the CLI ([kernel](kernel.md)); the card view offers them after v1.
- **Retry with planner** from Review (`POST /api/cards/:id/run`).
- **Saved views on the server** (a views endpoint); **undo for applied proposals**.
- **Sparklines** of tokens/s on Machine; **dependency lines over the board**; **master board across workspaces** beyond the Workspace rollup; **goal view** with the strategy graph and risk register.
- **Intent grouping of diffs by difftastic** beyond scope-based grouping.
- **A native wrapper, an IDE extension, a TUI**, and **remote control from a phone beyond read-only status and one-tap triage**.
- **Vendored Inter and JetBrains Mono** (SIL OFL 1.1), **`@floating-ui/dom`** for popovers, **Lucide** icons, **Playwright** screenshot regression and **axe-core** (MPL-2.0, dev-only) — all **proposed, needing the owner's yes**; until then the popovers, checks and screenshots use what is in the repository.

## 8. Open questions

1. **Planning in To do or In progress?** *Recommendation:* To do — nothing is being built yet; the badge says *Being planned*.
2. **Column names in NAMING.** NAMING's keep list says Working, Checking, Closed; the code says In Progress, Verify, Rejected; this spec shows To do, In progress, In review, On hold, Won't do on the board and the nine stored names in pipeline view. *Recommendation:* NAMING adopts this split and drops Working/Checking/Closed.
3. **Should the PM's model id be visible?** The owner once asked to *see* the correct model; the brand review calls the id operator language. *Recommendation:* show it in the panel header's details and on Machine, never in running copy.
4. **Playwright and axe.** The v1 audience tests (DEFINITION_OF_DONE §6.4) need a real browser driver. *Recommendation:* approve Playwright (Apache-2.0) and axe-core (MPL-2.0, dev-only, unmodified) together.

## 9. Evidence and rationale

- Reviews: [domain13_dashboard.md](../../reference/reviews/domain13_dashboard.md) (the professional column mapping, tile anatomy, Learn layer, gap table against Jira/Linear/GitHub) and [domain17_brand_ux.md](../../reference/reviews/domain17_brand_ux.md) (navigation, colour, contrast audit, the three audiences' walk-throughs).
- Practice: the Kanban Guide 2025 requires WIP, throughput, **work item age** and cycle time plus a **service-level expectation** and explicit policies — hence age on tiles, the SLE sentence, and column policies in Learn; NN/g finds pushed tutorials are forgotten while contextual, dismissible, re-findable help works and standard conventions need no explanation — hence the Learn layer's shape; empty states should show status, teach, and offer the next step — [WEB_RESEARCH group C §7](../../research/WEB_RESEARCH_2026-09.md#7-professional-kanban-conventions). Linear's default workflow (Backlog, Todo, In Progress, Done, Canceled), Jira's left-most/right-most column semantics and story points, GitHub's agent statuses on Projects boards, and the human-owner/agent-delegate split — §6 and §7.
- Positioning: Linear Agent already offers PM chat to non-developers, so the dashboard's edge is gates at the column boundary ("accepted means proven"), teaching the practice, and running locally — [group C gap analysis](../../research/WEB_RESEARCH_2026-09.md#gap-analysis).
- Seshat quiet by default, offering in the panel rather than pinging (offering preferred 90% vs 47%; an interruption costs ~23 minutes), capability shown as Wilson intervals from the ledger rather than public leaderboards, and the swap-cost wait explained as steps — [PM_RESEARCH_SYNTHESIS.md](../../research/PM_RESEARCH_SYNTHESIS.md) §1 rows 8, 10, 11.
- What was taken from each tool (priority scale, points, cycles, swimlanes, GitHub query syntax, keyboard triage, Copilot Workspace's editable plan as the proposal, Cursor's per-change apply, Claude's thread typography): [PM_DESIGN Part 1](../PM_DESIGN.md#part-1-what-teams-use-and-what-we-take).
- Mockups: `docs/design/mockups/` (board, review, card, runs, pm, board-v2, insights).
- **Resolved drift:** server-sent events and the page's own windowing replace the old design's WebSocket and `@tanstack/virtual` (no build step, air-gapped); reordering within a column is allowed (moves between columns stay gated); the token values in `tokens.ts` (raised for AA) replace the old design's table; "the tile shows budget, class chip and difficulty" is replaced by the professional anatomy; a React/TanStack stack was rejected for the same no-build reason.
