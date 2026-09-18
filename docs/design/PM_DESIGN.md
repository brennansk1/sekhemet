# Sekhemet dashboard: the project manager and team practices

Status: design and build record for the lead engineer · Date: 2026-09-18
Extends: `FRONTEND_DESIGN.md` (same tokens, voice, keyboard model and shell). Where this document is silent, that one rules.
Backend contract: `PM_CONTRACT.md` (§2 card fields, §3 endpoints, §5 integration roadmap). Every surface here is built against those shapes and degrades to an honest empty or "not on this server" state while an endpoint returns 404.
Mockups: `docs/design/mockups/{pm,board-v2,insights}.html`. These are static snapshots of the built dashboard, rendered against contract-shaped fixtures with every stylesheet and the tokens inlined, so they show what ships today. Open them straight from disk; `t` switches between Basalt and Sand.

The user's brief, in their words: *"I want it to reflect the top project management strategies that the top companies and people are using… so it integrates well with existing setup within the company. However I want the way you interact with the project manager to be more ui ux friendly. I want you to be able to chat and talk with it like you would a real project manager you hired for the job using the correct model."*

This document has four parts: **(1)** what the surveyed tools and methods do, and what we take from each; **(2)** the project manager as a teammate (persona, chat surface, proposals, waiting states); **(3)** the board, list, insights and integrations upgrades; **(4)** the visual and keyboard specification and what is built.

---

## Part 1: What teams use, and what we take

### 1.1 Planning tools

| Practice | Where it comes from | What the tool does | What Sekhemet takes |
|---|---|---|---|
| **Priority as a 5-step scale** | Linear (No priority, Urgent, High, Medium, Low); Jira (Highest…Lowest); GitHub Projects (a single-select field, usually P0–P3) | A glyph in a fixed slot at the left of every row. Bars for High/Medium/Low, a boxed exclamation for Urgent, three dashes for none. Sort puts Urgent first and "none" last. | The same 0..4 scale (contract §2) and the same glyph language, so a Linear or Jira user reads it without learning anything. Sort is 1, 2, 3, 4, then 0. |
| **Estimates in points** | Linear (Fibonacci, exponential or T-shirt); Jira story points; Shortcut; GitHub Projects number field | A small number on the card, summed per column, cycle and epic. | Fibonacci points 1, 2, 3, 5, 8, shown as words (`3 pts`). Nothing larger: in Sekhemet an 8 is already a card the Planner should split, and the PM says so. |
| **Epics / projects** | Jira epics; Linear projects; Shortcut epics; GitHub parent issues and milestones | A parent grouping with a progress bar, filterable and usable as a swimlane. | `epicId` pointing at a card with `tier: "epic"`. Progress comes from `/api/board` `epics[]`. Epics appear as swimlanes, as a filter and as a table column, never as a separate hierarchy screen. |
| **Cycles / sprints / iterations** | Linear cycles (auto-rolling, with a cycle progress graph of scope, started and completed); Jira sprints (goal, dates, burndown); GitHub iterations; Shape Up six-week cycles with a cool-down | A time box with a goal, a start and end date, and a progress view. | A **cycle header** on the board: goal, dates, days left, and one progress bar split into done, in progress and not started points. Planning a cycle is a conversation with the PM that ends in proposals. |
| **Swimlanes** | Jira (by epic, assignee, query, or none); Kanban Method (lanes per class of service); GitHub Projects "group by" | Horizontal bands across the columns. | Group by **Epic**, **Assignee**, **Priority** or **Cycle**. Each lane header carries its count, points and (for epics) progress. |
| **Filters and saved views** | Linear views; Jira quick filters and JQL; GitHub Projects' filter bar (`label:bug priority:high`) with saved view tabs | A filter bar whose state can be named and kept. | A filter bar that is both clickable chips and a typed query (`priority:urgent,high label:api cycle:current`), the GitHub Projects syntax that developers already type. Views save the query and the grouping. |
| **List / table view** | Linear list; Jira list; GitHub Projects table; Height | The same items as rows with property columns, sortable, with inline edits. | `#/board/list`, switched with `v`. It shows the same filter and grouping as the board. |
| **Keyboard triage** | Linear (single-letter property keys, `x` to select, ⌘K for everything); Superhuman's lineage | Every property editable from the keyboard without opening the item. | `⇧P` priority, `⇧E` estimate, `⇧L` labels, `⇧C` cycle, `⇧A` assignee and `.` for any field, on the focused card or the whole selection. These are uppercase so they never collide with the lowercase triage verbs (`a` accept, `r` send back, `p` park). |
| **Multi-select and bulk edit** | Linear, Jira, GitHub | Select many and change one property on all of them. | `x` selects, and in the list `⇧J/⇧K` and shift-click extend the selection. A bulk bar docks at the bottom of the view with the same field actions. Each change is its own PATCH, so the ledger records one event per card. |

### 1.2 Flow method

| Practice | Source | What Sekhemet takes |
|---|---|---|
| **WIP limits** | Kanban Method (Anderson) | Already built: `n / limit` headers and capacity bars (FRONTEND_DESIGN §2.4.2). The Review limit is derived from review minutes per day. |
| **Classes of service** (Expedite, Fixed date, Standard, Intangible) | Kanban Method | These map onto what we already have: **Urgent** priority is Expedite, and a `dueDate` makes a card Fixed date. The saved view *Urgent and high* shows the expedite lane at a glance; Expedite only works when it is rare, and Merit calls it out in *What's at risk* when it isn't. We add no separate field. |
| **Cycle time** with percentiles | Kanban Method, Vacanti (*Actionable Agile Metrics*) | A scatter of each finished card's cycle time with 50th, 85th and 95th percentile lines, and the sentence: *85% of cards finish within 6.2 hours.* We use percentiles, not averages, because flow data is skewed. |
| **Throughput** | Kanban Method | Cards done per day as bars, with the 7-day average as a line. |
| **Cumulative flow diagram** | Kanban Method, Reinertsen | Stacked bands for Backlog → Done over 30 days. A widening band is a queue forming. |
| **Aging WIP** | Vacanti | Each unfinished card is a dot in its column, placed at its age, against the 50th and 85th percentile cycle-time bands. A dot above the 85th line is flagged *Older than 85% of finished cards*. This is the most actionable chart of the four, so it comes first. |
| **Appetite, betting, cool-down** | Shape Up (Basecamp) | The PM's cycle planning asks about appetite ("How many points do you want to bet on the ledger this cycle?") rather than filling capacity to the brim. It leaves 15–20% of a cycle unplanned by default. |
| **Standups** | Scrum, and how most teams actually run them | The PM's standup is three sections (*Done since yesterday · In flight · Needs you*), each line a card chip. It is posted to Slack when connected (§3.5). |

### 1.3 AI teammates

| Product | What it does well | What we take | What we avoid |
|---|---|---|---|
| **Linear agents** | An agent is a workspace member: you assign or mention it, and it works inside the issue. Its activity is a visible thread of thoughts, actions and responses. | The PM is a **named member of the team** with an avatar and a presence line. Its messages cite cards and runs. | An agent that edits issues without asking. |
| **GitHub Copilot Workspace** | Spec, then plan, then implementation, and every step is editable before anything runs. | The **proposal**: the PM writes a plan as concrete field changes that you edit, apply or discard. | Plans as prose you have to translate into edits yourself. |
| **Claude** | A calm, readable thread. Prose first; tool use and reasoning shown as quiet, expandable detail. Long work shows progress. | The thread's typography and restraint. Citations as small, specific references under the reply. | Chat bubbles on both sides, avatars on every line, decoration. |
| **Cursor** | Proposed diffs render inline, with Accept and Reject per hunk and for all (⌘↵ / ⌘⌫). | **Field diffs** (`Medium → High`) with Apply and Discard per change and for all. We use `y`/`n` (the `git add -p` keys) and `⇧Y` to apply all. | Accepting everything by reflex: Apply all states how many cards it touches. |

The long-wait pattern in all four is weak. They show a spinner with no explanation. Our reply takes 40–120 seconds because the Worker must stop and the manager model must load, so we explain the wait as steps with times (§2.5).

---

## Part 2: The project manager

### 2.1 Who it is

The project manager is **Merit**. The name comes from Merit-Ptah, the earliest named physician on record, and it also reads as the English word. It is short, it is a name rather than a mascot, and it sits in the same world as Sekhemet without costume.

Merit runs on the **manager model** (`dirk-27b`, contract §1), never on the Worker. The panel header always says so: *Merit · Project manager · dirk-27b*. The user asked for "the correct model", and seeing the model named is how they know they have it.

The avatar is a 24px rounded square in `--bg-overlay` with a single "M" in 600 weight, `--text-primary`. It carries no gold, no face and no gradient. The Worker, when it is quoted, uses the same shape with "W", and You use your git initial.

### 2.2 Voice

Merit follows the product voice (FRONTEND_DESIGN §2.3) and adds the habits of a good hired PM:

1. **The answer first, then the evidence.** *"Two things are at risk: the ledger and the HTTP API."* comes before any explanation.
2. **Numbers, with a basis.** *"13 of 21 points done with 4 days left"*, never "going well".
3. **Names the card, links the card.** Every card it mentions is an `@card` chip.
4. **Proposes and never does.** Every change is a proposal you apply. Merit says *"I've proposed…"*, never *"I've changed…"*.
5. **Says what it doesn't know.** *"I can't see why the run stopped; there's no evidence for attempt 2."* Guesses are marked as guesses: *"My read (not verified):"*.
6. **Short.** Most replies are under 120 words. Long answers use the three-heading standup shape.
7. **No flattery or filler.** No "Great question", no exclamation marks, no emoji, no sign-off.

### 2.3 Sample exchanges

Card chips are written `@hasher`. Proposal blocks are shown as they render.

**Standup**

> **You:** standup
>
> **Merit:** Since yesterday: 2 cards done, 1 waiting on you, 1 stuck.
>
> **Done** · @iface *Define Chronicle contract interfaces* (1 step, 1.2s) · @canon *Canonical key order* (6 steps)
> **In flight** · @hasher is on step 5 of 32, and Types has failed twice on the same line.
> **Needs you** · @api has been in Review for 3h 10m. It passed all 4 gates. · @tamper is parked: *Paused for memory* at 94%.
>
> Cycle 12 has 13 of 21 points done with 4 days left. That is on pace if @hasher lands today.
>
> *Based on: board at 09:02 · run 18 Sep 02:14 · ledger #212*

**"Why did the ledger card fail?"**

> **You:** why did the ledger card fail?
>
> **Merit:** @ledger stopped on **Looping** at step 8: steps 6–8 repeated `note "stuck"` without changing a file.
>
> The cause is upstream of the loop. Types failed three times with `TS2353` at `tests/hasher.spec.ts:25`. That file is a protected acceptance test, so the fix belongs in `src/hasher.ts`: `hashEvent` takes `ChronicleEvent` where the test passes `{ payload, prev }`. The Worker kept trying to edit the test, was refused, and ran out of ideas.
>
> I'd send it back with that note, and split out the canonical-JSON rule, which is a separate 2-point problem.
>
> ▸ **Proposed changes · 2** (field diff, §2.4)
> *Update @ledger* · Estimate `5 pts → 3 pts`
> *Create card* · "Canonical JSON for hash input" · Rules · 2 pts · Cycle 12
>
> *Based on: evidence ev_7f3a (attempt 2) · steps 6–8 · gates.toml*

**"Split this card"** (sent with the card in context)

> **You:** split this card
>
> **Merit:** @http is 8 points and touches 5 files, which is over the 3-file bound, so the Worker will hit Size before it finishes. It splits cleanly along the routes:
>
> ▸ **Split @http into 3 cards · 3 + 3 + 2 pts**
> 1. *Read routes: GET /events and /verify* · Flow · 3 pts · `src/http/read.ts`
> 2. *Write route: POST /events with validation* · Rules · 3 pts · waits on 1
> 3. *Error envelope and status codes* · Contract · 2 pts
> The original moves to Closed as *Split into 3 cards*.

**"Plan next cycle"**

> **You:** plan next cycle
>
> **Merit:** Cycle 12 ends Friday with about 8 points left. For Cycle 13 (Sep 29 – Oct 10) I suggest betting 18 points, not the 24 you've averaged. Two of the last three cycles carried work over, and the 85th-percentile cycle time rose from 4.1h to 6.2h.
>
> The goal I'd write: *Chronicle is usable over HTTP.*
> In: @http split (8), @auth (5), @tamper (3), @docs (2) = 18.
> Out, deliberately: @export (5) waits on the API shape; @bench (3) is research with no deadline.
>
> ▸ **Proposed changes · 6** · Create cycle *Cycle 13* · Assign 4 cards to Cycle 13 · Priority @auth `Medium → High`
>
> How much do you want to bet on @auth? It's the least-known card here.

**"What's at risk this week?"**

> **You:** what's at risk this week?
>
> **Merit:** Two things.
>
> 1. **@hasher** is 22h old. 85% of finished cards took under 6.2h, so it's older than almost everything we've shipped. It has failed Types four times.
> 2. **Review is full (3 of 3).** Finished cards are waiting in Checking, so the cycle is blocked on review time rather than Worker time. The oldest, @api, has waited 3h 10m.
>
> Not at risk: @tamper is parked for memory, not for a defect, and it resumes below 85%.
>
> ▸ **Proposed changes · 1** · Priority @hasher `Medium → Urgent`

### 2.4 The chat surface

Merit lives in two places that share one thread.

**The panel.** This is a persistent right-side dock, 400px wide, toggled with `⌘J` from any view. From 1280px it is a dock, not an overlay: the view narrows (board columns relax to a 184px minimum, and when the columns overflow the board scrolls so Working sits beside the pinned Review and Parked columns), so the board stays usable next to the conversation. From 1024 to 1279px there is not enough width for both, so the panel overlays the view at 380px, like the peek drawer, and the board keeps its width. Its open or closed state is remembered per browser. It hides on `#/pm` and below 768px.

**The full view** is `#/pm` (`g a`, for "ask"). It has the thread in a 720px reading column and a right rail (288px) with *Open proposals*, *Worker* (state, step, paused or not) and *What Merit can see* (board snapshot time, last run, ledger head).

```
┌ side ┬ Board · Chronicle ─────────────────────────────── ⌘K ┬ Merit ─────────────── ⤢ ✕ ┐
│      │ [Board|List] View: Cycle 12 ▾  Priority: High ✕ + Filter │ M  Merit                   │
│      │ Cycle 12 · Ship the ledger · 4 days left ▬▬▬▬▬▬░░ 13/21  │    Project manager · dirk-27b│
│      │ ┌Backlog┐┌Ready┐┌Working┐┌Checking┐┌Review┐              ├────────────────────────────┤
│      │ │ ▮▮▮   ││     ││       ││        ││      │              │ You               09:02    │
│      │ │ tile  ││tile ││ tile  ││        ││ tile │              │ what's at risk this week?  │
│      │ │       ││     ││       ││        ││      │              │                            │
│      │ │       ││     ││       ││        ││      │              │ M Merit            09:03   │
│      │ │       ││     ││       ││        ││      │              │ Two things. …              │
│      │ │       ││     ││       ││        ││      │              │ ┌ Proposed changes · 1 ──┐ │
│      │ │       ││     ││       ││        ││      │              │ │ Priority  Medium → Urg │ │
│      │ │       ││     ││       ││        ││      │              │ │        Discard  Apply y│ │
│      │ │       ││     ││       ││        ││      │              │ └────────────────────────┘ │
│      │ │       ││     ││       ││        ││      │              │ Looking at: Board · Cycle 12 ✕│
│      │ │       ││     ││       ││        ││      │              │ [Ask Merit…            ↵ ] │
│      │ └───────┘└─────┘└───────┘└────────┘└──────┘              │ Sending pauses the Worker… │
└──────┴──────────────────────────────────────────────────────────┴────────────────────────────┘
```

**Messages.**

- **Your messages** sit on a quiet `--bg-raised` block, right-aligned, max 85% wide, with the time in 11px secondary.
- **Merit's replies** are full-width prose with no bubble, under a one-line header (avatar, *Merit*, time). This is the Claude pattern: the reply is a document, not a text message.
- **System messages** (e.g. *Merit was restarted; the thread continues.*) are a single centred 11px secondary line.
- Markdown is limited to paragraphs, bullet and numbered lists, **bold**, `code`, fenced code blocks and `###` headings. It is rendered by a pure, escape-first renderer (`renderPmMarkdown`, unit-tested), so model text can never inject markup. Raw links render as text: Merit points at cards and runs, not at the web.

**Card and run references.**

- In both directions, `@card_id` renders as a **card chip**: state icon, short id in mono, then the title truncated at 32 characters. Clicking the chip opens the peek drawer, and `⌘`-click opens the card view.
- Unknown ids render as plain mono text, so a model that invents an id shows nothing clickable.
- Typing `@` in the composer opens a card picker that fuzzy-matches titles and ids; `↵` inserts the chip token.
- **Cites** (`cites[]`) render under the reply as one line: *Based on:* followed by chips for cards, runs (`run 18 Sep 02:14` → `#/runs/<id>`) and evidence (`ev_7f3a` → the card's evidence tab).

**The context chip.** Above the composer a chip states what Merit will be told you're looking at: *Looking at: Board · Cycle 12 · 2 filters*, or *Looking at: @hasher* when a card is focused or open. It is sent as `context: { cardId?, view }`. `✕` removes it for the next message, and it comes back when you move. The chip keeps the context visible; a PM that silently knows what you're looking at feels like surveillance, and one that doesn't makes you repeat yourself.

**The composer.**

- The textarea grows from 1 to 8 lines. `↵` sends, `⇧↵` adds a newline, and `Esc` returns focus to the page without closing the panel.
- **Starter prompts** appear when the thread is empty or has been idle for 12h: *Standup* · *What's at risk this week?* · *Plan the next cycle*, plus a contextual one, *Why did @hasher fail?* when the focused card has failed, or *Split @http* when it is over 5 points.
- **The cost line.** Under the composer, in 11px secondary, one sentence says what sending will do, because it is not free:
  - Worker running: *The Worker is on step 5 of 32. Sending pauses it at the next step while Merit loads (about 40s).*
  - Idle: *Merit runs locally on dirk-27b. Replies take about a minute.*
  - Read-only: *Read-only server. Restart with `sekhemet serve` to talk to Merit.* (The composer is disabled.)

**Proposals.** A reply with `proposals[]` ends in a **proposal group**:

```
┌ Proposed changes · 3 open ──────────────────────── Discard all · Apply all ⇧Y ┐
│ ↑ Update @hasher Implement canonical JSON and SHA-256 hash chaining            │
│   Priority   ▮▮▯ Medium   →  ▣ Urgent                                          │
│   Estimate   3 pts        →  5 pts                                             │
│   Labels     + security   − later                                              │
│                                                    Discard n    Apply  y       │
├────────────────────────────────────────────────────────────────────────────────┤
│ ⑂ Split @http into 3 cards · 3 + 3 + 2 pts                                     │
│   1  Read routes: GET /events and /verify         Flow · 3 pts                 │
│   2  Write route: POST /events with validation    Rules · 3 pts                │
│   3  Error envelope and status codes              Contract · 2 pts             │
│   The original moves to Closed.                    Discard n    Apply  y       │
├────────────────────────────────────────────────────────────────────────────────┤
│ ✓ Applied · Create cycle "Cycle 13" · Sep 29 – Oct 10 · by you at 09:05        │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Field diff.** One row per field in `patch`: label (secondary, 96px), the before value (secondary, struck through, on `--tint-fail`), an arrow, and the after value (primary, 500, on `--tint-pass`). Values are formatted as people read them: priority with its glyph and word, points as `3 pts`, cycles and epics by name, assignee as *Worker* or *You*, dates as `Sep 29`. Labels diff as a set (`+ security − later`), not as two lists. An absent value reads *None*. Colour is never the only signal: the arrow, the strike and the words carry it.
- **Create and split** show the new cards as a numbered list: title, kind, points, and dependencies (*waits on 1*).
- **Reorder and move** show *Position 7 → 2 in Ready* or *Ready → Backlog*.
- **Park and unpark** show the reason.
- **States:**
  - *Open* (actions shown).
  - *Applied* collapses to one line with a pass check and *by you at 09:05*.
  - *Discarded* collapses to one struck line.
  - *Stale* shows the diff with an amber rule and *@hasher changed after Merit proposed this. Ask again for a fresh proposal.* Apply is disabled and the reason is stated inline.
- **Apply all** says what it does: *Apply 3 changes to 5 cards*. It applies in order, stops at the first failure and reports it: *Applied 2 of 3. "Split @http" failed: card is in Working.* Applied changes are ledger events with actor *You* (contract §3).
- **Keys** (when a proposal or its group has focus): `y` apply, `n` discard, `⇧Y` apply all open in this group, `j/k` move between proposals.
- **Import uses the same component** (§3.5). An import is never silent; it is a proposal group titled *Import from Jira CSV · 42 cards*.

### 2.5 Waiting and preemption

A reply takes 40–120 seconds on a 24 GB machine: the Worker must reach a step boundary, unload, and the manager model must load. A spinner would make that feel broken. Instead the wait is **a visible procedure with times**, driven by `PmStatus.phase`.

Where the reply will appear, the thread shows a **pending reply** block under Merit's header:

```
M  Merit                                                          1:04
   ✓ Paused the Worker after step 5                               0:07
   ◌ Loading the PM · about 40s  ▬▬▬▬▬▬▬▬▬▬▬░░░░                  0:31
   ○ Thinking
   ○ Resuming the Worker
   Only one model fits in memory, so the Worker waits at a safe step
   boundary and continues from step 6 once Merit has replied. You can
   keep working; the reply lands here.
```

| `phase` | Row text | Detail |
|---|---|---|
| `waiting_for_step` | **Pausing the Worker after step 5** | The step comes from `detail` (or `step`). While this row is current: *Waiting for step 5 to finish. The Worker is never stopped mid-edit.* |
| `loading_pm` | **Loading the PM · about 40s** | A 2px lapis bar fills toward the ETA (from `detail`'s `~40s`, or `etaSeconds`). Past the ETA the bar stops and the row reads *Taking longer than usual.* |
| `thinking` | **Thinking** | Elapsed time only. After 90s: *Long answers can take up to two minutes on this machine.* |
| `resuming_worker` | **Resuming the Worker** | *Reloading the Worker; step 6 starts next.* The reply is usually already shown above this row. |
| `idle` | (block removed) | — |

- **Rows:**
  - Completed rows get a pass check and their duration.
  - The current row gets the lapis ring icon and a running timer (tabular, updated once a second; the text changes but nothing moves).
  - Future rows are an empty circle in secondary.
- If no runner holds the lease (contract §4.3), the Worker rows are omitted: *Loading the PM → Thinking*.
- **The header timer** (top right of the block) is the total since your message was queued.
- **The panel header** repeats the current phase in one line (*Loading the PM · 0:31*) so the state is visible when the thread is scrolled.
- **The shell bar** (FRONTEND_DESIGN §2.4, lowest priority) shows, while `workerPaused` is true: *Worker paused after step 5 while Merit replies.* `Open Merit`. It uses the lapis running rule, not amber: nothing is wrong.
- **The running tile** reads *Paused for Merit · step 5 of 32* instead of its step line.
- **Queued messages.** A second message sent during a wait shows *Queued · Merit answers in order* under it. The contract answers messages in sequence, and the UI does not pretend otherwise.
- **Errors.** A message in state `error` shows *Merit couldn't reply.* with the server's text verbatim, and `Retry`, which resends the same text and context.
- **Offline** (FRONTEND_DESIGN §2.4 shell) freezes timers and disables the composer with *Offline. Your message would not reach Merit.*

### 2.6 States of the whole surface

| State | Trigger | Treatment |
|---|---|---|
| Not on this server | `GET /api/pm/thread` returns 404 | Panel body: **Merit isn't on this server yet.** *This Sekhemet server has no project-manager endpoints (`GET /api/pm/thread` returned 404). Update Sekhemet and restart `sekhemet serve`.* The composer is disabled with the reason stated. The nav item still shows so the feature is discoverable. |
| First conversation | Thread empty | Merit introduces itself in one paragraph (rendered locally, not sent): *I'm Merit, the project manager for Chronicle. I read the board, the runs and the ledger, and I propose changes you approve. I never change the board myself.* Then the starter prompts. |
| Loading the thread | First fetch | Three skeleton lines in the thread. |
| Error | Thread fetch 5xx | **Couldn't load the conversation.** *The server returned 500.* `Retry` |

---

## Part 3: Board, list, insights and integrations

### 3.1 Tile additions (extends FRONTEND_DESIGN §2.5.1)

```
┌──────────────────────────────────────────┐
│ ▮▮▯ Rules  api  security     3 pts hasher │  row 1: priority · kind · labels (max 2, +n) · points · id
│ Implement canonical JSON and SHA-256     │  row 2: title
│ hash chaining                            │
│ ✓✗✗·  Types failed · 3 errors            │  row 3: unchanged, still the most important line
│ ▬▬▬▬▬▬░░░░░░░░░░░░░░░░  8 of 32 steps    │  row 4: unchanged
└──────────────────────────────────────────┘
```

- **The priority glyph** takes a fixed 12px slot at the far left, so priorities scan as a column.
  - None: three short dashes.
  - Low, Medium and High: one, two or three of three rising bars. The unlit bars are `--border-strong`.
  - Urgent: a rounded square with an exclamation.
  - The glyph is `--text-secondary`, and Urgent is `--text-primary`. **Colour stays reserved for state** (FRONTEND_DESIGN §2.1); the shape carries the priority, as in Linear's grey bars.
- **Labels** are 11px secondary text in a 1px `--border-subtle` outline, at most two, then `+2`.
- **Points** are `3 pts`, right-aligned before the id. They are omitted when unset.
- The tile's height stays at 88px. The board's windowing depends on it.

### 3.2 Board chrome: view bar, filters, saved views, cycle header, swimlanes

**The view bar** is 40px under the topbar, on `--bg-base` with a hairline:

```
[Board | List]  View: Current cycle ▾   Priority: Urgent, High ✕   Label: api ✕   + Filter   ⌕ Filter…  /      Group: Epic ▾   Save view
```

- **Board | List** is a segmented control, toggled with `v`. List is `#/board/list`.
- **Views** are named: *All cards* (default), *Current cycle*, *Needs you*, *Urgent and high*, *Unestimated*, plus your saved ones. The menu shows each view's query in mono under its name.
- **Filter chips** carry the field and its values. Click one to edit it, or `✕` to remove it. **+ Filter** opens field → values menus: Priority, Label, Epic, Cycle, Assignee, Kind, State.
- **The query box** (`/`) takes the same filter as text, in GitHub Projects syntax:
  - `priority:urgent,high`
  - `label:api`
  - `epic:ledger`
  - `cycle:current` (or `cycle:none`)
  - `assignee:worker|human`
  - `kind:rules`
  - `is:blocked|needs-you|running|unestimated`
  - Free words match the title and id.
  - A `-` prefix negates, e.g. `-label:later`.

  Chips and text are two views of one filter object (`parseQuery` / `formatQuery`, unit-tested).
- **Group** offers None, Epic, Assignee, Priority or Cycle, and `⇧S` cycles through them.
- **Save view** appears only when the filter differs from the chosen view. It saves `{ name, query, group, layout }`. Views are kept in this browser (`localStorage`) until a `/api/views` endpoint exists. That is stated in the menu footer: *Saved in this browser.*

**The cycle header** is shown whenever a cycle is in force (marked active, or a planned cycle whose dates contain today), unless the filter points at another cycle or `cycle:none`:

```
Cycle 12  Ship the ledger end to end            Sep 15 – Sep 28 · 4 days left
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▒▒▒▒▒▒░░░░░░░░   13 of 21 pts done · 5 in progress · 3 not started      Plan next cycle with Merit
```

- The progress bar is one bar with three segments: done (`--state-pass`), in progress (`--state-running`) and not started (`--bg-overlay`), each sized by points.
- A thin tick marks where the cycle *should* be if work were linear (elapsed days ÷ total days). This is Linear's scope-versus-time read without a second chart.
- When there are fewer than 2 days left and under 70% of points are done, *4 days left* becomes amber and the tooltip reads *Behind the linear pace by 5 pts.*
- Unestimated cards count as 1 point, and the header says so: *2 cards unestimated, counted as 1 pt.*
- **Plan next cycle with Merit** opens the panel with that prompt filled in, not sent.

**Swimlanes.** When grouped, the board becomes lanes:

- Each lane has a 32px header (chevron, name, count, points) and a row of the same columns.
- **Epic** lanes show the epic's progress bar (`done / total` cards).
- There is always a *No epic* lane (*No assignee*, *No cycle*, *No priority* for the other groupings), and it comes last.
- Rails still collapse empty columns, board-wide.
- A lane collapses with its chevron.
- `j/k` cross lane boundaries, and `h/l` stay in the lane.
- Lanes are not windowed; they are meant for a filtered view (a cycle, an epic). The ungrouped board keeps its virtualization for 500+ cards.

### 3.3 List / table view

`#/board/list`. It uses the same filter, grouping and selection as the board.

| | Priority | ID | Title | State | Epic | Cycle | Points | Labels | Assignee | Due | Updated |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ☐ | ▮▮▮ | `hasher` | Implement canonical JSON… `Rules` | ✗ Checking | Ledger | Cycle 12 | 3 pts | api | Worker | Sep 26 | 12m ago |

- **Rows** are 36px. The title column is fluid; the others are fixed and right-aligned where numeric.
- **Groups** get a 32px header with count and points. `Space` on a group header collapses it.
- **Sorting.** Click a header (headers are buttons, reachable with `Tab`). A second click reverses. The sort is stable with priority as the tiebreak.
- **Inline editing.** Click a Priority, Epic, Cycle, Points, Labels, Assignee or Due cell, or press its key on the focused row (`⇧P`, `⇧E`, `⇧L`, `⇧C`, `⇧A`, or `.` for any field):
  - A menu anchored to the cell shows the options with their number keys (`1`–`5`).
  - Labels is a checkable list with a *Create label "…"* row.
  - Due offers *Today*, *End of this week*, *End of the current cycle* and *No due date*.
  - The edit is **optimistic**: the cell changes at once, then `PATCH /api/cards/:id` runs. On failure the cell reverts and a toast gives the reason, e.g. *Couldn't set priority on hasher. The server returned 404: this server can't edit cards yet.*
- **Selection.** `x` toggles, `⇧J/⇧K` extend, `⌘A` selects every visible row, and `Esc` clears. Shift-click selects a range.
- **Keys** follow the board: `Enter` opens the card and `Space` peeks.

### 3.4 Bulk actions

With one or more cards selected, a bar docks at the bottom-centre of the view (48px, `--bg-overlay`, 1px `--border-strong`):

```
3 selected · 8 pts   Priority ⇧P   Points ⇧E   Cycle ⇧C   Labels ⇧L   Assignee ⇧A   Park   Ask Merit   ✕ Esc
```

- Field actions open the same menus as inline editing and apply to all selected cards.
- **Park** asks for one reason and posts one park per card.
- **Ask Merit** opens the panel with the selection already mentioned, not sent: *About @hasher @api @cli:*. The contract's `context` carries one card, so a selection travels as mentions.
- **Results** are reported in one toast: *Set priority High on 3 cards*, or *Set on 2 of 3. hasher: the server returned 409.*

### 3.5 Integrations (`#/integrations`, `g s`)

The page follows the approved roadmap (contract §5), in three sections. Every card on it says, in one line, **what leaves this machine when connected**. Nothing is connected by default.

**Now: connect these.**

| Integration | Card body | Controls |
|---|---|---|
| **GitHub Issues + Projects** | Status (*Connected to acme/chronicle via gh* or *gh isn't signed in*) and *Last synced 12 minutes ago* (`lastSyncAt`). Linked cards show their `externalRef.id` (`owner/repo#n`) in the list view, linking to the issue. The last sync's result is shown as *4 created · 9 updated · 2 skipped · 0 errors*. | **Pull**, **Push**, **Sync both** (primary). A sync in progress shows *Syncing with GitHub…* on the button. Errors list verbatim. *Leaves this machine: card titles, specs, priority, points, cycle and state, as issues and Projects fields in the repo you choose. Uses your `gh` login; Sekhemet stores no token.* |
| **GitHub PR on accept** | *Accept opens a pull request with the evidence as its body, instead of merging locally.* | A switch (`PUT /api/integrations/github-pr { enabled }`), with the current behaviour stated beside it: *Accept merges locally as one commit.* *Leaves this machine: the card branch, its diff, and the gate results.* |
| **Jira** | Import and export in Jira's CSV columns (Summary, Issue Type, Priority, Story Points, Sprint, Epic Link, Labels, Description). | **Export Jira CSV**, **Import…** *Leaves this machine: nothing. Export writes a file; you upload it to Jira yourself.* |
| **Linear** | The same, in Linear's fields. | **Export Linear CSV**, **Import…** Same data line. |
| **Slack for the PM** | *Merit posts the daily standup, "needs you" alerts and run reports to one channel.* Connected: the channel's webhook host in mono, the last message sent, and whether it was delivered (`pm/notify` `ok`). | A webhook URL field with **Connect**, then **Send test message** and **Disconnect**. *Leaves this machine: standup text, card titles that need you, and run summaries.* A lock line says the webhook URL is a credential: *Sekhemet keeps it in `~/.config/sekhemet/repos/…` with mode 0600, never in the repository or the ledger.* |

**Import** opens a sheet with a format picker (Jira CSV, Linear CSV, GitHub JSON, Sekhemet JSON), a file chooser and a paste box. **Preview** posts to `/api/import` and renders the returned proposals with the §2.4 component, headed *Import from Jira CSV · 42 proposed changes*. You apply one, some or all. Import never writes the board by itself. The server also posts the preview into Merit's thread (`messageId`), so it can be decided there too; the sheet says so. **Export** links download `/api/export?format=…`, which names the file `sekhemet-<project>-<format>.csv|json`.

**Next: planned.** Each is a quiet card with its name, one sentence and *Planned*. There is no button.

- Jira and Linear live sync: *uses a token from your OS keychain*.
- GitHub Actions gate mirror.
- Microsoft Teams.
- Slack replies.

**Later: on the roadmap.** These are compact rows under *Later*:

- Sentry, Datadog and PagerDuty as card sources.
- Notion and Confluence publishing.

Each still states the data it would send. Listing them is honest and sets expectations; a dead Connect button would not.

**Not on this server** (`/api/integrations` 404): the three sections still render from the design's catalogue so the roadmap is visible, but every Now card reads *Not available on this server yet* and has no controls.

#### 3.5.1 The roadmap (PM_CONTRACT §5, approved 2026-09-18)

The tiers follow what dev teams use most. From Stack Overflow 2025: GitHub 81%, Jira 46% and GitLab 36%; Slack is the top chat tool, Teams the top video tool and Confluence the top docs tool. JetBrains 2025 has GitHub Actions at 33%, the top CI. The UI keys its copy on these ids, and an unknown id still renders from the server's `name` and `detail`.

| Tier | id | Integration | What it does | What leaves the machine |
|---|---|---|---|---|
| Now | `github` | GitHub Issues + Projects | Two-way sync via `gh`. Priority, points and cycle map to Projects fields; linked by `externalRef`. | Card fields, to the chosen repository |
| Now | `github-pr` | GitHub PR on accept | Accept pushes the branch and opens a PR with the evidence as its body | Branch, diff, gate results |
| Now | `jira` | Jira import/export | CSV in Jira's import columns; import previewed as proposals | Nothing (you upload the file) |
| Now | `linear` | Linear import/export | CSV/JSON in Linear's fields | Nothing (you upload the file) |
| Now | `slack` | Slack for the PM | Incoming webhook: standup, needs-you alerts, run reports (`pm/notify`) | Those messages |
| Next | `jira-sync`, `linear-sync` | Live sync | REST/GraphQL with a token from the OS keychain | Card fields |
| Next | `github-actions` | Gate mirror | Gate results as a check run on the PR | Gate results |
| Next | `teams` | Microsoft Teams | The Slack messages via an incoming webhook | Those messages |
| Next | `slack-replies` | Slack replies | Talk to Merit from a Slack thread | The conversation |
| Later | `sentry`, `datadog`, `pagerduty` | Card sources | Errors, regressions and incidents arrive as proposals for bug cards | Nothing (data comes in) |
| Later | `notion`, `confluence` | Publishing | Merit publishes cycle plans, run reports and decision logs; reads linked specs | Those pages |

### 3.6 Insights (`#/insights`, `g f`)

Flow metrics for the last 30 days (`/api/metrics/flow?days=30`, with 7, 30 or 90 selectable). A headline row has four numbers, then four charts, each answering one question in its title.

**The headline row:**

- **Cycle time (85th pct)** 6.2h
- **Throughput** 2.4 cards a day
- **Work in progress** 7 cards, 2 over 85th pct
- **Oldest in progress** 22h (hasher)

**The four charts:**

1. **Aging WIP: "What is getting old?"**
   - Columns Ready → Review on the x axis, age on y, one dot per unfinished card.
   - Horizontal bands at the 50th and 85th percentile of finished cycle times.
   - Dots above 85% are amber. Hovering shows the card, and clicking peeks it.
2. **Cycle time: "How long do cards take?"**
   - A scatter of finished cards, with dashed percentile lines labelled `50% 2.1h`, `85% 6.2h`, `95% 9.8h`.
   - The subtitle sentence is the one to repeat in a standup: *85% of cards finish within 6.2 hours.*
3. **Throughput: "How much finishes?"**
   - Daily bars with a 7-day moving average line.
4. **Cumulative flow: "Where do queues form?"**
   - Stacked bands, Backlog at the bottom and Done at the top.
   - Band colours use the state roles: running for Working, parked for Review (the human queue), pass for Done, and neutral surfaces for the rest.
   - The legend is ordered as the stack.

**Chart rules** follow FRONTEND_DESIGN §2.5.8–9:

- Charts are SVG coloured only through token classes.
- Tabular numbers throughout.
- No gridlines beyond a baseline and the percentile rules.
- Each chart carries a one-line text summary for screen readers (`<figcaption>`).

**Worker capability** (`GET /api/capability`) is a second section under the flow charts. It answers "what can the Worker be trusted with?":

- **Which kinds of card does it pass?** One row per kind. Each row has a point at the pass rate on a 0–100% track, a bar for its 95% Wilson interval (`low`–`high`), and the words *16 of 18 passed · 89% (67–97%)*. Rows are ordered by attempts, so the best-evidenced come first.
- **Fewer than 10 attempts is called out in words**: *Too few attempts to trust*, in amber under the row. The point is hollow and the label secondary. The caption counts these rows: *2 of 5 kinds have fewer than 10 attempts; treat those rates as rough.* A wide bar is explained as uncertainty, not failure.
- **How big a change can it handle?** Pass rate by change size (`sizeCurve`) as bars, with an 80% reference line. The caption is the horizon sentence: *The Worker passes 80% of cards that change up to about 62 lines* (`horizon80Lines`). Buckets with fewer than 10 attempts are faded and say so. The server's `note` is shown verbatim under the section.
- **States:** a 404 shows *Worker capability isn't on this server yet*, naming the endpoint. `sampleSize` 0 shows *No finished attempts yet*. The section renders independently of the flow metrics, so either can be missing.

**Empty** (under 3 finished cards): *Not enough finished cards to measure flow yet. Insights need at least 3; you have 1.* **Not on this server** (404): *Flow metrics aren't on this server yet (`/api/metrics/flow` returned 404).*

### 3.7 Learning: Playbook, what Merit has learned about you, and the stopping policy (PM_CONTRACT §6)

Everything learned is context, not weights. It comes from gate results and human actions, is recorded on the ledger, and takes effect only after approval. The UI's job is to make that visible and reversible, and it keeps the plain names (NAMING.md): Playbook, rules, *What Merit has learned about you*, Stopping policy.

**Playbook (`#/playbook`).** A lede says, once, what the page is: *Learned from gate results and what you do, never from a model grading itself. Everything stays on this machine and is recorded on the ledger. A rule takes effect only after you approve it.* Rules are grouped by status:

- **Needs your approval** (candidates, newest first): **Approve** (primary), **Edit** and **Retire**.
- **Active**: **Edit** and **Retire**. Rules proposed for retirement (at least 3 more harmful than helpful uses) come first, with an amber rule and the sentence *Proposed for retirement: used 6 times on failing first attempts, 2 on passing ones.* Their Retire button is promoted. The rest follow by value.
- **Retired**: collapsed.

Each rule shows:

- who it is for (*For the Worker* / *For Merit*);
- its source in words (*From your send-back note*, *From a fix that took the Worker several tries*, *From Merit's end-of-run review*, *Seeded with the project*) and its age;
- scope chips (*Kind: Rules*, *Files: `src/**/hash*.ts`*, *Error: `TS2353`*, or *Applies to: every card*);
- for used rules, a signed value bar (relative to the page's largest |value|, red when negative), plus helpful and harmful counts with their icons;
- its evidence as `@card` chips with the quoted note, the first two shown and the rest behind *n more signals*.

Edit is inline (a textarea, `⌘↵` saves, `Esc` cancels). Every action is optimistic, reverts on failure and states the result: *Approved. The rule is given to the Worker from the next matching card.* When `/api/learning` returns 404, the page keeps the seeded rules and send-back suggestions from `/api/playbook` under a banner that names the endpoint.

**Reach.** Approve opens a two-option picker: *This project* (1) or *All projects* (2), sent as `{ reach: "global" }`. Its footer says *All-projects rules live in ~/.config/sekhemet and apply to every repository on this machine.* Active rules carry a reach chip (*This project* / *All projects*), and all-projects rules are drawn slightly stronger. The seeded rules from `.sekhemet/playbook.toml` stay visible as active, read-only rules (*Edit in playbook.toml*) whenever the learning store doesn't carry them itself.

**Merit's review** (ledger `card/review`, written when Merit checks a passing card) appears in the evidence column of Review and of the card view, between Gates and Failures:

- It is titled *Merit's review* with a count (*1 likely send-back*).
- It has one line: *Merit checked this diff against what it has learned about you (Playbook). It's advice, not a gate: Accept is still yours.*
- `likely_send_back` findings are amber warnings (an alert icon and a 2px parked rule) and come first; `consider` findings are quiet.
- The section is absent when there is no review.

**Escalated retries.** When a queue entry records that a retry ran on the escalation model (`escalated`, or a per-entry `model` that differs from the report's), Worker capability adds *2 retries in the last run used the escalation model (…), not the Worker. They aren't counted in these rates.* Today's `QueueEntry` carries no such field, so the note stays hidden.

**What Merit has learned about you** is a section of Playbook (`#/playbook/profile`), because it is the same kind of thing: learned, local, editable. It has:

- a lock line: *These stay on this machine, in the project's ledger. Edit a statement to correct it; dismiss it and Merit stops using it.*;
- active statements grouped by category (Code style, Planning, Communication, Priorities), strongest first;
- for each statement, a strength bar with a word (*Strong* ≥ 0.7, *Moderate* ≥ 0.4, *Weak*), its source in words, its evidence notes with dates, and **Edit** and **Dismiss**;
- dismissed statements collapsed at the end.

The `#/pm` rail carries a compact summary: the three strongest statements, *See all 4 and edit them in Playbook*, and *Stays on this machine*.

**Stopping policy** (Insights, under Worker capability) appears when `/api/learning` returns `tuning`. It contains:

- A headline: *A 12-step cap would have cut 50.4 to 31 minutes (38% less) and kept 18 of 18 passes.*
- A current-versus-recommended table: step budget, failed checks allowed, minutes, first-try passes, eventual passes.
- The copyable command `sekhemet queue --max-turns 12`.
- A note when the failed-check limit also differs, because it has no flag yet.
- The caveat: *Replay only stops a recorded run earlier than it really stopped. It never credits a pass the Worker didn't make, so it can't overstate what a tighter cap keeps. It can't tell you whether a looser cap would have rescued a failure.*
- The full replay grid behind a disclosure.

When the current policy is already best, the section says so and offers no command.

### 3.8 The model roster and the Researcher

Four roles, named by what they do (NAMING.md): the **Worker**; **Merit · Project manager**; the **Adversarial reviewer**, a different model family so it catches what the Worker's family misses; and the **Researcher** (Apodex-1.1-mini), which gathers evidence from papers, docs, registries and the project's history, and cites a source for every answer.

- **Machine › Models** (`GET /api/models`) shows the four roles in that fixed order. Each has its model id in mono, its state with a dot (*Resident*, *Swapped out*, *Not configured*) and a one-line description. A note every role shares (*No run in progress*) is said once, in the footer line, rather than four times.
- The footer also states the memory model:
  - On a 24 GB host: *One model is resident at a time on this machine; Sekhemet swaps them as the work needs (about 40 seconds each).*
  - When `coResident` is true: *This machine has room for all four at once, so nothing swaps.*
- A 404 shows *The model roster isn't on this server yet*, naming the endpoint.
- **Integrations › Researcher web access** is a Now card with a switch (`PUT /api/integrations/research-web { enabled }`). It shows the server's `detail`, which names the search provider or says how to set one. The configuration line reads *Web search needs a provider you configure: a self-hosted SearXNG, or a Brave or Tavily key in the environment; papers, page reads and GitHub work without one.* Under *Leaves this machine*: *Search queries, and the URLs of the pages it reads. Private and local addresses are never fetched.*
- **Research answers in Merit's thread.** Reply `cites` entries with `{ url?, label }` render as a compact numbered **Sources** list under the reply: the label is a link (http and https only, opening in a new tab, `rel="noopener noreferrer"`) followed by the host in mono. Entries without a URL are plain text. Card, run and evidence cites keep their *Based on:* chips.

---

## Part 4: Specification

### 4.1 Routes and keys

| Route | Key | View |
|---|---|---|
| `#/pm` | `g a` | Merit, full view |
| (panel) | `⌘J` | Toggle the Merit panel from anywhere |
| `#/board` · `#/board/list` | `g b`, then `v` | Board and list |
| `#/insights` | `g f` | Flow metrics |
| `#/integrations` | `g s` | Integrations |

| Where | Key | Action |
|---|---|---|
| Board / list, focused card or selection | `⇧P` `⇧E` `⇧L` `⇧C` `⇧A` `.` | Priority, points, labels, cycle, assignee, any field |
| Board / list | `x` · `⇧J`/`⇧K` · `⌘A` (list) · `Esc` | Select, extend, all, clear |
| Board / list | `/` · `v` · `⇧S` | Filter box, board/list, cycle grouping |
| Field menu | `1`–`9` · `↑↓` · `↵` | Pick |
| Composer | `↵` · `⇧↵` · `@` · `Esc` | Send, newline, mention a card, back to page |
| Proposal | `y` · `n` · `⇧Y` · `j/k` | Apply, discard, apply all, next/previous |

### 4.2 Components and tokens

No new colour roles are needed; everything is built from the fifteen roles plus the derived tints (FRONTEND_DESIGN §3.1). The new icons in `packages/ui/src/icons.ts` (1.5px, 24 viewBox) are:

| Icon | Drawing | Use |
|---|---|---|
| `priority-none` | three short dashes | No priority |
| `priority-low` / `-medium` / `-high` | three rising bars, 1–3 lit (unlit bars use class `off`) | Priority |
| `priority-urgent` | rounded square with an exclamation | Urgent |
| `chat` | speech bubble with two lines | Merit nav, Ask Merit |
| `insights` | three rising bars with a trend line | Insights nav |
| `plug` | two-prong plug | Integrations nav |
| `split` | one line forking into two | Split proposal |
| `arrow-right` | arrow | Field diff |
| `list` | three lines with bullets | List view |
| `filter` | funnel | Filter |
| `cycle` | circular arrow with a gap | Cycle |
| `layers` | stacked rhombs | Group / swimlanes |
| `send` | paper plane | Composer send |
| `expand` | two corner arrows | Open full view |

The priority bars use a thicker stroke through CSS (`.prio .ic path { stroke-width: 3 }`) so they read as bars at 12px. The unlit bars are coloured `--border-strong` by class, and the icon test still holds (no fills, no colours, no stroke-width in the icon bodies).

| Component | Size |
|---|---|
| Merit panel | 400px wide (360 at 1024–1279); header 52px; composer min 44px; padding 16px; message gap 24px |
| Proposal group | `--bg-surface`, 1px `--border-subtle`, radius 6. Header 36px; each proposal 12px 16px; diff rows 24px |
| Pending block | Rows 24px, 12px icons, 11px times right-aligned tabular; ETA bar 2px |
| View bar | 40px, 16px padding, 8px gaps |
| Cycle header | 56px, two lines; progress bar 6px |
| Lane header | 32px |
| Table row | 36px; group header 32px |
| Bulk bar | 48px, bottom 16px, centred, radius 6 |
| Insights chart panel | `--bg-surface` with a 1px hairline, 16px padding, 240px plot height |

### 4.3 Accessibility

- **The panel** is a `complementary` landmark labelled *Merit, project manager*.
  - The thread is `role="log"` with `aria-live="polite"`. Only Merit's final replies are announced (*Merit replied. 2 proposed changes.*); timer ticks are not.
  - The pending block's current row has `aria-busy="true"`.
- **Proposals** are a `list`. Each proposal is a `group` labelled by its summary. Apply and Discard are buttons whose accessible names include the summary.
- **Field diffs** are a `dl` read as *Priority: Medium, changes to Urgent*.
- **Charts** each have a `figcaption` sentence and a hidden table of their data.
- **Table** is a real `table` with `aria-sort` on sorted headers and `aria-selected` on rows.
- **The bulk bar** is `role="toolbar"` and announces *3 selected*.

### 4.4 What is built, and what waits on the backend

**Built** (`packages/ui`; every item was checked in Basalt and Sand at 1440 and 1024):

- `src/pm.ts`: pure logic, served to the browser as `/app/lib/pm.js`.
  - Priority scale and ordering.
  - Proposal diff rows.
  - The safe markdown renderer and mention parsing.
  - The filter query language.
  - Grouping.
  - Cycle progress.
  - Flow metric maths: percentiles, moving average, aging classification, CFD stacking.
  - Waiting-phase steps.
- `web/pm_client.js`: thread state and the `pm` stream events.
- `web/pm_panel.js`, `web/pm_view.js`, `web/proposals.js`: the chat surface.
- `web/viewbar.js`: filters, views, grouping and the cycle header.
- `web/lanes.js`, `web/list.js`, `web/fields.js`, `web/bulk.js`: swimlanes, table, inline editing and bulk actions.
- `web/picker.js`: the anchored single/multi picker and one-field prompt used by filters, edits and saved views.
- `web/marks.js`: the priority glyph, label chips, points and `@card` chips.
- `web/insights.js` and `web/integrations.js`: the two new views.
- `web/pm.css` and `web/board2.css`: their styles.
- Icons in `src/icons.ts`.

The board's tile, sort and keyboard were extended in place.

**Backend:** the lead's `/api/pm/*`, `PATCH /api/cards/:id`, `/api/cycles`, `/api/metrics/flow`, `/api/integrations` (with Slack and sync), `/api/export` and `/api/import` landed during the build. The UI was checked against a contract-shaped fixture server, because a real PM reply loads a 27B model and the host was busy, and against a server with those endpoints absent (the *not on this server* states). The contract's optional fields are all used when present: `PmStatus.since`, `step` and `etaSeconds`; `cycleTime[].doneAt`; the thread's `model`; `epics[].progress.pointsDone`; and integration `enabled` and `lastSyncAt`.

**Deliberately not built:** saved views sync (views stay in this browser until a `/api/views` exists); drag and drop (FRONTEND_DESIGN §2.4.2 still holds: moves are explicit and recorded); an Undo for applied proposals (the contract has none, so *Applied* is final and says so).
