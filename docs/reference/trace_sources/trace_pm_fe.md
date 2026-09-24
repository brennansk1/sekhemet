# Raw trace: PM_DESIGN.md and FRONTEND_DESIGN.md

*Row data written by the tracing agent on 2026-09-22 (the old text is at `fb59ba2`), restored from its transcript after the session scratch directory was lost. Statuses are as first traced, before the fix passes; the verified final status of every row is in [DESIGN_TRACE.md](../DESIGN_TRACE.md).*

## Full trace

Source keys: `PM:n` = docs/design/PM_DESIGN.md line n; `FE:n` = docs/design/FRONTEND_DESIGN.md line n. New-doc references are by section (the spec files were still growing while this trace was taken, so line numbers drift; sections do not). `dash` = specs/dashboard.md, `ppm` = specs/planner-pm.md, `int` = specs/integrations.md, `rg` = specs/review-git.md, `rt` = specs/runtime.md, `PMC` = PM_CONTRACT.md.

### PM_DESIGN.md

| # | Source | Item | Status | Now in |
|---|---|---|---|---|
| 1 | PM:5 | Every PM surface degrades to an honest empty or "not on this server" state while its endpoint 404s | carried | dash §2.12.3 ("X isn't on this server yet", endpoint in a details line) |
| 2 | PM:6 | Mockups pm/board-v2/insights are static snapshots; `t` switches theme in them | carried | dash §9 (mockups listed); bare `t` removed from the product (dash §2.3.2) — mockup-only |
| 3 | PM:20 | Priority 0..4 on Linear's scale (0 none, 1 Urgent … 4 Low) | carried | ppm §2.7.1; PMC §2 |
| 4 | PM:20 | Priority glyph language: bars High/Med/Low, boxed exclamation Urgent, **three dashes for none** | contradicted | dash §2.4.4 "priority glyph (hidden when none)", P3 "only when priority ≠ 0" vs old "three dashes for none" |
| 5 | PM:20 | Sort 1,2,3,4 then 0 | carried | ppm §2.7.1 |
| 6 | PM:21 | Fibonacci points 1,2,3,5,8 shown as `3 pts` | carried | ppm §2.6.2; NEW-planner-pm-1 |
| 7 | PM:21 | Nothing larger than 8; an 8 is a card the Planner should split, and the PM says so | carried | ppm §2.6.2, NEW-planner-pm-1 |
| 8 | PM:21 | Points summed per column, cycle and epic | carried-weaker | Lane/group headers, cycle header, bulk bar carry points (dash §2.4.13–16); a per-column points sum on the board header is not stated (§2.4.3 has count/limit only) |
| 9 | PM:22 | `epicId` → card with `tier: "epic"` | carried | PMC §2 |
| 10 | PM:22 | Epic progress from `/api/board` `epics[]` | carried | PMC §3 |
| 11 | PM:22 | Epics appear as swimlanes, filter and table column, **never as a separate hierarchy screen** | contradicted | dash §2.4.17 adds a Story map `#/board/map` (epics across, slices beneath) — a separate epic view; probably intended, but the old "never" rule is not withdrawn anywhere |
| 12 | PM:23 | Cycle header: goal, dates, days left, one progress bar split done/in progress/not started by points | carried | dash §2.4.13 |
| 13 | PM:23 | Planning a cycle is a conversation ending in proposals | carried | ppm §2.7.7 |
| 14 | PM:24 | Group by Epic, Assignee, Priority, Cycle; lane header count, points, epic progress | carried | dash §2.4.14 |
| 15 | PM:25 | Filter bar = clickable chips + typed query in GitHub Projects syntax; views save query and grouping | carried | dash §2.4.11–12 |
| 16 | PM:26 | List view `#/board/list`, toggled with `v`, same filter/grouping | carried | dash §2.4.15, §2.3 |
| 17 | PM:27 | Field keys ⇧P ⇧E ⇧L ⇧C ⇧A and `.` on focused card or selection; uppercase so they never collide with a/r/p | carried | dash §2.3 keymap |
| 18 | PM:28 | `x` selects; ⇧J/⇧K and shift-click extend; bulk bar docks at the bottom | carried | dash §2.3, §2.4.16 |
| 19 | PM:28 | Each bulk change is its own PATCH; one ledger event per card | carried | ppm §2.14 ("one event per card") |
| 20 | PM:34 | WIP limits as `n / limit` headers and capacity bars | carried | dash §2.4.3 |
| 21 | PM:34 | Review limit derived from review minutes per day | carried | rg §2.2.1 |
| 22 | PM:35 | Classes of service: Urgent = Expedite, `dueDate` = Fixed date; no new field | carried | ppm §2.7.6 |
| 23 | PM:35 | Saved view *Urgent and high* shows the expedite lane; Seshat flags Expedite when it is not rare | carried | dash §2.4.11; ppm §2.7.6 (threshold: more than a WIP limit's worth of Urgent cards) |
| 24 | PM:36 | Cycle time scatter with 50/85/95 percentile lines | carried | dash §2.10.2 |
| 25 | PM:36 | SLE sentence *85% of cards finish within 6.2 hours* | carried | dash §2.10.1 |
| 26 | PM:36 | Percentiles, not averages, because flow data is skewed | carried-weaker | Percentiles used everywhere; the reason (which stops an "average" from returning) is not recorded in dash or DECISIONS |
| 27 | PM:37 | Throughput bars with 7-day average line | carried | dash §2.10.2 |
| 28 | PM:38 | Cumulative flow: stacked bands Backlog→Done over 30 days | carried | dash §2.10.2 (7/30/90 selectable) |
| 29 | PM:39 | Aging WIP: dot per unfinished card at its age against 50th/85th bands | carried | dash §2.10.2 |
| 30 | PM:39 | Dot above 85th flagged in words *Older than 85% of finished cards* | carried-weaker | dash §2.10.2 says "dots above 85% amber" — the words label is lost (colour-only, against dash §2.1.2) |
| 31 | PM:39 | Aging WIP is the first chart | carried | dash §2.10.2 ("first") |
| 32 | PM:40 | Cycle planning asks appetite (points to bet), not capacity to the brim | carried | ppm §2.7.7 |
| 33 | PM:40 | Leave 15–20% of a cycle unplanned by default | carried | ppm §2.7.3, §2.7.7 |
| 34 | PM:41 | Standup: *Done since yesterday · In flight · Needs you*, each line a card chip | carried | ppm §2.7.8 table; P6 (since the previous standup) |
| 35 | PM:41 | Standup posted to Slack when connected | carried | ppm §2.7.8; int INT-18 |
| 36 | PM:47 | PM is a named team member with an avatar **and a presence line** | carried-weaker | Avatar (monogram) dash §2.7.2; "presence line" not specified |
| 37 | PM:47 | PM messages cite cards and runs | carried | dash §2.7.4 |
| 38 | PM:47 | Avoid: an agent that edits issues without asking | carried | ppm §2.8.3 |
| 39 | PM:48 | The proposal: a plan as concrete field changes you edit, apply or discard | carried | ppm §2.8.3; edits recorded as preference pairs ppm §2.13.3 |
| 40 | PM:49 | Thread typography: prose first; tool use and reasoning as quiet, expandable detail; long work shows progress | carried-weaker | Prose-first carried (dash §2.7.3); "tool use/reasoning as expandable detail" not specified |
| 41 | PM:49 | Avoid bubbles on both sides, avatars on every line, decoration | carried | dash §2.7.3 |
| 42 | PM:50 | Field diffs with Apply/Discard per change and for all | carried | dash §2.7.7 |
| 43 | PM:50 | `y`/`n` (git add -p keys), `⇧Y` apply all; Apply all states how many cards it touches | carried | dash §2.3, §2.7.7 |
| 44 | PM:52 | Reply takes 40–120 s; explain the wait as steps with times | carried | ppm §2.8.6, §2.8.14; dash §2.7.8 |
| 45 | PM:60 | Name Seshat and its rationale | carried | NAMING themed names |
| 46 | PM:62 | Seshat runs on the manager model (`dirk-27b`), never the Worker | carried | ppm §2.8.1 (Planner role's model); models §2.3 (Dirk-Qwen3.8-27B default) |
| 47 | PM:62 | Panel header **always** shows *Seshat · Project manager · dirk-27b* so the user sees the correct model | contradicted | dash §2.7.2 "model id is in the header's details, not in the composer's copy"; NAMING "Panel header: *Seshat · Project manager*, without the model's name"; open question dash §8.3 |
| 48 | PM:64 | Avatar: 24 px rounded square, `--bg-overlay`, single letter at 600 weight in `--text-primary`; no gold, face, gradient | carried-weaker | dash §2.7.2 + NAMING (plain monogram on `--bg-overlay`, no gold/face); 24 px size and weight lost; old letter "M" (Merit) is stale |
| 49 | PM:64 | Worker, when quoted, uses the same avatar shape with "W"; You use your git initial | contradicted | NAMING "Never": the Worker, Planner, Researcher, Reviewer "get no names, avatars or voices"; yet dash §2.4.4 tile has a "W badge"; the You-initial rule is lost |
| 50 | PM:70 | Voice: answer first, then evidence | carried | ppm §2.8.2 |
| 51 | PM:71 | Numbers with a basis | carried | ppm §2.8.2 |
| 52 | PM:72 | Every card mentioned is an `@card` chip | carried | ppm §2.8.2; dash §2.7.4 |
| 53 | PM:73 | Proposes, never does; says *"I've proposed…"*, never *"I've changed…"* | carried | ppm §2.8.3 (the phrasing rule is lost; the behaviour is kept) |
| 54 | PM:74 | Says what it doesn't know; guesses marked *My read (not verified):* | carried | ppm §2.8.2, §2.8.11 |
| 55 | PM:75 | Most replies under 120 words; long answers use the three-heading standup shape | carried-weaker | 120 words kept (ppm §2.8.2); the long-answer shape is lost |
| 56 | PM:76 | No flattery, filler, exclamation, emoji, sign-off | carried | ppm §2.8.2 |
| 57 | PM:84-94 | Sample exchange: standup (sections, pace sentence, *Based on:* board time · run · ledger #) | carried-weaker | Only a link: ppm §2.8.8 names "the few-shot exchanges of PM_DESIGN §2.3" as skill content. PM_DESIGN is a superseded companion (specs/README "dissolved… and deleted"); if it is removed, the few-shots go with it |
| 58 | PM:96-110 | Sample: "why did the ledger card fail?" — stop reason, step, repeated action, upstream protected-test cause, send-back note + split proposal, *Based on* evidence id | carried-weaker | Behaviour carried ppm §2.8.11 and P6; the worked example is only by link (row 57) |
| 59 | PM:112-122 | Sample: "split this card" — over the 3-file bound, split along routes, **the original moves to Closed as *Split into 3 cards*** | carried-weaker | Split proposals carried (ppm §2.8.3, §2.3.3); what happens to the parent card on a split (moves to Closed/Rejected with a reason) is not stated in any new doc |
| 60 | PM:124-136 | Sample: "plan next cycle" — bet below the average with the basis, goal sentence, in/out deliberately, asks appetite on least-known card | carried | ppm §2.7.7; P6 (bet ≤ 85% of the mean of the last three cycles) |
| 61 | PM:138-149 | Sample: "what's at risk?" — aged card vs 85th pct, Review full, explicit *Not at risk* line, priority proposal | carried-weaker | Signals and starter carried (ppm §2.12, dash §2.7.6); the "say what is *not* at risk" habit exists only in the linked example |
| 62 | PM:153 | Seshat in two places sharing one thread | carried | dash §2.7.1 |
| 63 | PM:155 | Panel: persistent right dock, 400 px, `⌘J` from any view | carried | dash §2.7.1 |
| 64 | PM:155 | ≥1280 px dock: view narrows, columns relax to 184 px min, board scrolls with Working beside pinned Review and Parked | carried | dash §2.7.1 |
| 65 | PM:155 | 1024–1279 px: overlay at 380 px; board keeps its width | carried | dash §2.7.1 (old §4.2 said 360; the new spec settles on 380) |
| 66 | PM:155 | Open/closed remembered per browser; hidden on `#/pm` and below 768 px | carried | dash §2.7.1, §3 per-browser settings |
| 67 | PM:157 | Full view `#/pm` on chord `g a` | contradicted | dash §2.2.1 chord is `g p`; `g a` kept silently for one release (§2.3.1) |
| 68 | PM:157 | Full view: 720 px reading column, 288 px rail with Open proposals, Worker (state, step, paused), What Seshat can see (board snapshot time, last run, ledger head) | carried | dash §2.7.1 |
| 69 | PM:181 | Your messages: `--bg-raised`, right-aligned, max 85%, **time in 11 px secondary** | carried-weaker | dash §2.7.3; message timestamp lost |
| 70 | PM:182 | Seshat's replies: full-width prose, no bubble, one-line header (avatar, name, time) | carried | dash §2.7.3 |
| 71 | PM:183 | System messages: one centred 11 px secondary line | carried | dash §2.7.3 |
| 72 | PM:184 | Markdown limited to paragraphs, lists, bold, code, fenced code, `###` | carried | dash §2.7.3 |
| 73 | PM:184 | Pure escape-first renderer (`renderPmMarkdown`), unit-tested; model text never injects markup | carried | dash §2.7.3, S3c |
| 74 | PM:184 | Raw links render as text | carried | dash §2.7.3 |
| 75 | PM:188 | `@card_id` chip: state icon, short id in mono, title truncated at 32 chars | carried | dash §2.7.4 (id → key) |
| 76 | PM:188 | Click chip peeks; ⌘-click opens card view | carried | dash §2.7.4 |
| 77 | PM:189 | Unknown ids render as plain mono text | carried | dash §2.7.4, §6 |
| 78 | PM:190 | `@` in composer opens fuzzy card picker; `↵` inserts the chip token | carried | dash §2.7.4, §2.3 |
| 79 | PM:191 | Cites under the reply as *Based on:* chips for cards, runs (→ `#/runs/<id>`) and evidence (→ the card's evidence tab) | carried-weaker | dash §2.7.4; the link targets for run and evidence cites are lost |
| 80 | PM:193 | Context chip *Looking at: Board · Cycle 12 · 2 filters* / *@hasher* | carried | dash §2.7.5 |
| 81 | PM:193 | Sent as `context: { cardId?, view }`; `✕` drops it for the next message; it returns when you move | carried | dash §2.7.5; PMC §3 |
| 82 | PM:193 | Why the chip exists (silent context feels like surveillance; none makes you repeat yourself) | carried-weaker | Rationale lost; it guards against a "silently send context" change |
| 83 | PM:197 | Composer grows 1–8 lines; `↵` send, `⇧↵` newline, `Esc` returns focus without closing the panel | carried | dash §2.7.6, §2.3 |
| 84 | PM:198 | Starter prompts when thread empty or idle 12 h (Standup, What's at risk, Plan the next cycle) + contextual (*Why did @x fail?*, *Split @x* over 5 pts) | carried | dash §2.7.6 (+ *Start a new project*) |
| 85 | PM:199 | Cost line under the composer, 11 px secondary, says what sending does | carried | dash §2.7.6 |
| 86 | PM:200 | Worker-running cost line names the step (*step 5 of 32*) and the ETA (*about 40s*) | carried-weaker | dash §2.7.6 "*The Worker will pause after its current step while Seshat answers, then carry on.*" — step number and ETA dropped |
| 87 | PM:201 | Idle cost line *Seshat runs locally on dirk-27b. Replies take about a minute.* | contradicted | dash §2.7.6 and P5: "no model ids or API paths" in the cost line; *Seshat will reply in about a minute.* (deliberate, P5) |
| 88 | PM:202 | Read-only cost line + composer disabled | carried | dash §2.7.6 |
| 89 | PM:204 | A reply with `proposals[]` ends in a proposal group | carried | dash §2.7.7 |
| 90 | PM:207 | Group header *Proposed changes · 3 open*, *Discard all*, *Apply all ⇧Y* | carried | dash §2.7.7 |
| 91 | PM:224 | Field diff row: label (secondary, **96 px**), before struck on `--tint-fail`, arrow, after (primary, **500 weight**) on `--tint-pass` | carried-weaker | dash §2.7.7; label width and weight lost |
| 92 | PM:224 | Values as people read them (glyph+word, `3 pts`, names, *Worker*/*You*, `Sep 29`, *None*) | carried | dash §2.7.7 |
| 93 | PM:224 | Labels diff as a set (`+ security − later`) | carried | dash §2.7.7 |
| 94 | PM:224 | Colour never the only signal in a diff (arrow, strike, words) | carried | dash §2.1.2, §2.14 |
| 95 | PM:225 | Create/split: numbered new cards with title, kind, points, *waits on 1* | carried | dash §2.7.7 |
| 96 | PM:226 | Reorder shows *Position 7 → 2 in Ready*; move shows *Ready → Backlog* | carried-weaker | dash §2.7.7 has moves only; the reorder rendering is lost (reorder is a proposal kind, ppm §2.8.3) |
| 97 | PM:227 | Park and unpark proposals show the reason | carried | dash §2.7.7 ("park shows the reason") |
| 98 | PM:229-232 | Proposal states Open / Applied (pass check, *by you at 09:05*) / Discarded (struck line) / Stale (amber rule, reason inline, Apply disabled) | carried | dash §2.7.7, §6 |
| 99 | PM:233 | Apply all copy *Apply 3 changes to 5 cards*; in order; stops at first failure with *Applied 2 of 3…* | carried | dash §2.7.7; ppm §2.8.3, §6 |
| 100 | PM:233 | Applied changes are ledger events with actor *You* | carried | ppm §2.8.3 (PMC §3 event name `pm/proposal_applied` vs code `pm/proposal_state` — ppm §8.2) |
| 101 | PM:234 | Proposal keys y / n / ⇧Y / j,k when focused | carried | dash §2.3 |
| 102 | PM:235 | Import uses the same component; never silent; *Import from Jira CSV · 42 cards* | carried | dash §2.7.7, §2.11 |
| 103 | PM:239 | The wait is a visible procedure driven by `PmStatus.phase` | carried | dash §2.7.8; PMC §3 |
| 104 | PM:241 | Pending reply block under Seshat's header where the reply will land | carried | dash §2.7.8 |
| 105 | PM:249-251 | Block's explanation (*Only one model fits in memory… continues from step 6… You can keep working; the reply lands here.*) | missing | Should go in dash §2.7.8 |
| 106 | PM:256 | `waiting_for_step`: *Pausing the Worker after step 5* (step from `detail` or `step`); *Waiting for step 5 to finish. The Worker is never stopped mid-edit.* | carried | dash §2.7.8; PMC §3 |
| 107 | PM:257 | `loading_pm`: *about 40s*; 2 px lapis bar to the ETA (`detail`'s `~40s` or `etaSeconds`); past the ETA the bar stops and *Taking longer than usual.* | carried | dash §2.7.8; PMC §3 |
| 108 | PM:258 | `thinking`: elapsed only; after 90 s *Long answers can take up to two minutes on this machine.* | carried | dash §2.7.8 |
| 109 | PM:259 | `resuming_worker`: *Reloading the Worker; step 6 starts next.*; the reply is usually already above | carried | dash §2.7.8 |
| 110 | PM:260 | `idle`: block removed | carried-weaker | Implied, not stated |
| 111 | PM:263-265 | Row states: completed = pass check + duration; current = lapis ring + running timer (tabular, ticks once a second, nothing moves); future = empty circle, secondary | carried-weaker | dash §2.7.8 keeps only "rows with durations and a total timer"; icons, 1 s tick and no-motion rule lost |
| 112 | PM:266 | No runner lease → Worker rows omitted (*Loading the PM → Thinking*) | carried | dash §2.7.8 |
| 113 | PM:267 | Header timer = total since your message was queued | carried | dash §2.7.8 ("total timer") |
| 114 | PM:268 | Panel header repeats the current phase in one line with its time | carried | dash §2.7.2 |
| 115 | PM:269 | **Shell bar** (lowest priority) while `workerPaused`: *Worker paused after step 5 while Seshat replies.* + `Open Seshat`; lapis rule, not amber | carried-weaker | dash §2.7.8 moves it to the **footer** text; the `Open Seshat` action and its slot in the shell-bar priority order (§2.2.4 lists only four bars) are lost |
| 116 | PM:270 | Running tile reads *Paused for Seshat · step 5 of 32* | carried | dash §2.7.8 |
| 117 | PM:271 | Second message during a wait: *Queued · Seshat answers in order* | carried | dash §2.7.8 |
| 118 | PM:272 | Error state: *Seshat couldn't reply.* + server text verbatim + `Retry` (same text and context) | carried | dash §2.7.8 |
| 119 | PM:273 | Offline freezes timers, disables composer with *Offline. Your message would not reach Seshat.* | carried | dash §2.7.8 (copy lost, behaviour kept) |
| 120 | PM:279 | Thread 404: *Seshat isn't on this server yet* + how to fix; composer disabled with reason; nav item stays | carried | dash §2.7.9 |
| 121 | PM:280 | First conversation: local intro paragraph (not sent), then starters | carried | dash §2.7.9 |
| 122 | PM:281 | Loading: three skeleton lines | carried | dash §2.7.9 |
| 123 | PM:282 | Thread 5xx: *Couldn't load the conversation. The server returned 500.* `Retry` | carried | dash §2.7.9 ("thread error with Retry") |
| 124 | PM:292 | Tile row 1: priority · kind · labels (max 2, +n) · points · id | contradicted | dash §2.4.4 (P3): row 1 type icon · key · points · owner avatar; priority, epic, labels on row 3; kind moved to peek and Facts — deliberate |
| 125 | PM:300 | Priority glyph in a fixed 12 px slot **at the far left** so priorities scan as a column | carried-weaker | 12 px slot kept (dash §2.4.4) but it moves to row 3 and is hidden when none, so the column-scan property is lost |
| 126 | PM:302 | Low/Med/High = 1–3 of three rising bars; **unlit bars `--border-strong`** | carried-weaker | dash §2.4.4; unlit-bar colour lost (lives only in `pm.css`) |
| 127 | PM:303-304 | Urgent: rounded square with exclamation; glyph `--text-secondary`, Urgent `--text-primary`; shape, not colour | carried | dash §2.4.4 |
| 128 | PM:305 | Labels: 11 px secondary in 1 px `--border-subtle` outline, at most two, then `+n` | carried | dash §2.4.4 |
| 129 | PM:306 | Points `3 pts`, omitted when unset | carried | dash §2.4.4, P3 |
| 130 | PM:307 | Tile height stays 88 px because windowing depends on it | carried | dash §2.4.4 (88 px; reason lost) |
| 131 | PM:311 | View bar 40 px under the topbar on `--bg-base` with a hairline | carried | dash §2.4.11 (colour lost) |
| 132 | PM:317 | Board / List segmented control, `v` | carried | dash §2.4.11, §2.3 |
| 133 | PM:318 | Named views (All cards default, Current cycle, Needs you, Urgent and high, Unestimated) + saved; query in mono | carried | dash §2.4.11 |
| 134 | PM:319 | Filter chips (click to edit, `✕`); `+ Filter` fields Priority, Label, Epic, Cycle, Assignee, Kind, State | carried | dash §2.4.11 |
| 135 | PM:320-329 | Query terms incl. `cycle:current|none`, `is:blocked|needs-you|running|unestimated`, free words, `-` negation | carried | dash §2.4.12 (+ AND/OR semantics) |
| 136 | PM:331 | Chips and text are one filter object (`parseQuery`/`formatQuery`, unit-tested) | carried | dash §2.4.12; tests `pm.spec.ts` (§4) |
| 137 | PM:332 | Group None/Epic/Assignee/Priority/Cycle; `⇧S` cycles | carried | dash §2.4.11, §2.3 |
| 138 | PM:333 | Save view only when the filter differs; saves `{ name, query, group, layout }` | carried-weaker | dash §2.4.11; the saved-view shape is lost |
| 139 | PM:333 | Saved in this browser until `/api/views`; menu footer says so | carried | dash §2.4.11; server views in dash §7 |
| 140 | PM:335 | Cycle "in force" = marked active, **or a planned cycle whose dates contain today**, **unless the filter points at another cycle or `cycle:none`** | carried-weaker | dash §2.4.13 says only "when a cycle is in force"; the definition and the filter suppression are lost |
| 141 | PM:342 | Bar segments: done `--state-pass`, in progress `--state-running`, not started `--bg-overlay`, sized by points | carried-weaker | dash §2.4.13; segment colours lost |
| 142 | PM:343 | Tick at the linear pace (elapsed ÷ total days) | carried | dash §2.4.13 |
| 143 | PM:344 | < 2 days left and < 70% done → amber, tooltip *Behind the linear pace by 5 pts* | carried | dash §2.4.13 |
| 144 | PM:345 | Unestimated cards count as 1 pt; header says how many | carried | dash §2.4.13 |
| 145 | PM:346 | *Plan next cycle with Seshat* opens the panel with the prompt filled in, not sent | carried | dash §2.4.13 |
| 146 | PM:350 | Lane: 32 px header (chevron, name, count, points) and a row of the same columns | carried | dash §2.4.14 |
| 147 | PM:351 | Epic lanes show epic progress (`done / total` cards) | carried | dash §2.4.14 (basis lost) |
| 148 | PM:352 | Always a *No epic* / *No assignee* / *No cycle* / *No priority* lane, last | carried | dash §2.4.14 |
| 149 | PM:353 | Rails still collapse empty columns board-wide | contradicted | dash §2.4.2, P3: empty columns become chips above the board, never rails (deliberate) |
| 150 | PM:354-355 | Lane collapses with its chevron; `j/k` cross lanes, `h/l` stay | carried | dash §2.4.14, §2.3 |
| 151 | PM:356 | Lanes not windowed (filtered views); ungrouped board virtualized for 500+ | carried | dash §2.4.9 |
| 152 | PM:360 | List shares filter, grouping and selection with the board | carried | dash §2.4.15 |
| 153 | PM:362 | List columns (checkbox, Priority, ID, Title+kind, State, Epic, Cycle, Points, Labels, Assignee, Due, Updated) | carried | dash §2.4.15 (ID → Key) |
| 154 | PM:366 | Rows 36 px; title fluid, others fixed, numeric right-aligned | carried-weaker | dash §2.4.15; alignment rules lost |
| 155 | PM:367 | Group header 32 px with count and points; `Space` collapses | carried | dash §2.4.15, §2.3 |
| 156 | PM:368 | Sort: headers are buttons (Tab-reachable); second click reverses; stable, priority tiebreak | carried-weaker | dash §2.4.15; reversal and header-as-button lost |
| 157 | PM:369 | Inline edit by click or key (⇧P ⇧E ⇧L ⇧C ⇧A `.`) on Priority/Epic/Cycle/Points/Labels/Assignee/Due | carried | dash §2.4.15, §2.3 |
| 158 | PM:370 | Anchored menu with number keys | carried | dash §2.3 (`1–9`) |
| 159 | PM:371 | Labels menu is a checkable list with a *Create label "…"* row | missing | dash §2.4.15 |
| 160 | PM:372 | Due offers *Today*, *End of this week*, *End of the current cycle*, *No due date* | missing | dash §2.4.15 |
| 161 | PM:373 | Optimistic edit → `PATCH /api/cards/:id`; on failure revert + toast with the reason | carried | dash §2.4.15; ppm §2.14 |
| 162 | PM:374 | Selection `x`, ⇧J/⇧K, ⌘A, Esc, shift-click | carried | dash §2.3 |
| 163 | PM:375 | List keys follow the board (`Enter` open, `Space` peek) | carried | dash §2.3 |
| 164 | PM:379 | Bulk bar bottom-centre, 48 px, `--bg-overlay`, 1 px `--border-strong` | carried-weaker | dash §2.4.16 (48 px); colours lost |
| 165 | PM:382 | Bulk bar contents: count · points, field actions with key hints, Park, Ask Seshat, ✕ Esc | carried | dash §2.4.16 |
| 166 | PM:385 | Field actions reuse the inline-edit menus and apply to all selected | carried | dash §2.4.16 |
| 167 | PM:386 | Park asks one reason, one park per card | carried | dash §2.4.16 |
| 168 | PM:387 | Ask Seshat: selection as mentions, not sent (context carries one card) | carried | dash §2.4.16 |
| 169 | PM:388 | One toast reports the result, including partial failures | carried | dash §2.4.16 |
| 170 | PM:390 | Integrations `#/integrations` on `g s` | contradicted | dash §2.2.1: `g s` is Status; Integrations (More group) has no chord |
| 171 | PM:392 | Every integration card says what leaves the machine; nothing connected by default | carried | dash §2.11; int Principles 1 |
| 172 | PM:392 | Page in three sections Now / Next / Later following the roadmap | contradicted | dash §2.11 "no roadmap is hard-coded in the page"; NEW-dashboard-2 "WHEN `/api/integrations` omits an integration THE SYSTEM SHALL NOT show it". The API still returns `tier` (PMC §3) but no spec says the page groups by it |
| 173 | PM:398 | GitHub card: status, *Last synced* (`lastSyncAt`), last result counts, linked `owner/repo#n` in list view | carried | dash §2.11, §2.4.15; int item 8 |
| 174 | PM:398 | Pull / Push / Sync both; *Syncing with GitHub…* while running; errors verbatim | carried-weaker | dash §2.11; in-progress label lost |
| 175 | PM:398 | GitHub leaves: titles, specs, priority, points, cycle, state; uses `gh` login; no stored token | carried | dash §2.11 |
| 176 | PM:399 | PR on Accept switch (`PUT /api/integrations/github-pr`), current behaviour stated; leaves branch, diff, gate results | carried | dash §2.11; int item 15, §3 |
| 177 | PM:400 | Jira CSV columns (Summary, Issue Type, Priority, Story Points, Sprint, Epic Link, Labels, Description); Export/Import; leaves nothing | carried | int item 17, INT-31; dash §2.11 |
| 178 | PM:401 | Linear: same in Linear's fields | carried | int item 17 |
| 179 | PM:402 | Slack: standup, needs-you, run reports; host in mono, last message, delivered (`pm/notify ok`) | carried | dash §2.11; int items 20–22 |
| 180 | PM:402 | Slack controls: webhook field, Connect, Send test message, Disconnect | carried | dash §2.11; PMC §5 |
| 181 | PM:402 | Webhook URL is a credential: `~/.config/sekhemet/repos/…`, mode 0600, never in repo or ledger | carried | dash §2.11; int INT-30; PMC §5 |
| 182 | PM:404 | Import sheet: format picker (Jira CSV, Linear CSV, GitHub JSON, Sekhemet JSON), file chooser, paste box | carried | dash §2.11 |
| 183 | PM:404 | Preview → `/api/import` → proposals headed *Import from Jira CSV · 42 proposed changes*; apply one, some or all; never writes by itself | carried | dash §2.11; int item 18 |
| 184 | PM:404 | Server posts the preview into Seshat's thread (`messageId`); **the sheet says so** | carried-weaker | dash §2.11 keeps the posting; `messageId` is absent from PMC §3's import response and the sheet's notice is lost |
| 185 | PM:404 | Export `/api/export?format=…` names the file `sekhemet-<project>-<format>.csv|json` | carried | dash §2.11; PMC §3 |
| 186 | PM:406 | Next tier: quiet cards with name, one sentence, *Planned*, **no button** | carried-weaker | Page now renders from the API; the "Planned, no dead Connect button" rule is not restated |
| 187 | PM:408 | Jira and Linear live sync (OS keychain token) | later | int §7 (DEC-08); SPINE "Not in v1" |
| 188 | PM:409 | GitHub Actions gate mirror | carried | int item 14 (gate runs as Check Runs, built) |
| 189 | PM:410 | Microsoft Teams | later | int §7 |
| 190 | PM:411 | Slack replies | later | int §7 |
| 191 | PM:415 | Sentry, Datadog, PagerDuty as card sources (bug-card proposals) | later | int §7 |
| 192 | PM:416 | Notion and Confluence publishing (plans, run reports, decision logs; read linked specs) | later | int §7 |
| 193 | PM:418 | Later rows still state the data they would send | carried-weaker | Lost with the hard-coded roadmap (row 172) |
| 194 | PM:420 | Integrations 404: sections still render from the catalogue; Now cards *Not available on this server yet*, no controls | contradicted | NEW-dashboard-2 forbids a hard-coded catalogue; only the generic "isn't on this server yet" (dash §2.12.3) remains |
| 195 | PM:424 | Tier rationale (Stack Overflow 2025: GitHub 81%, Jira 46%, GitLab 36%; JetBrains 2025: Actions 33%) | carried | PMC §5; int §3 |
| 196 | PM:424 | UI copy keyed on ids; unknown id renders from the server's `name` and `detail` | carried-weaker | Implied by "renders what `/api/integrations` returns" (dash §2.11); the explicit fallback is not stated |
| 197 | PM:426-438 | Roadmap table: ids and what leaves the machine per integration | carried | PMC §3 (ids), §5 (table) |
| 198 | PM:440 | Insights `#/insights` on `g f` | contradicted | dash §2.2.1 chord `g i`; `g f` silent for one release |
| 199 | PM:442 | `/api/metrics/flow?days=30`, 7/30/90 selectable | carried | dash §2.10; PMC §3 |
| 200 | PM:444-449 | Headline: cycle time 85th pct, throughput, WIP (with how many over 85th), oldest in progress | carried | dash §2.10.1 |
| 201 | PM:453-456 | Aging WIP: columns Ready→Review on x, age on y, bands, amber above 85%, hover shows the card, click peeks | carried | dash §2.10.2 (hover weaker) |
| 202 | PM:457-459 | Cycle time: dashed percentile lines labelled `50% 2.1h` etc.; subtitle sentence | carried | dash §2.10.2 |
| 203 | PM:460-461 | Throughput: daily bars + 7-day moving average | carried | dash §2.10.2 |
| 204 | PM:462-465 | CFD: Backlog bottom → Done top; band colours by state role (running = Working, parked = Review as the human queue, pass = Done, neutral rest); legend ordered as the stack | carried-weaker | dash §2.10.2 "stacked bands in stack order"; the colour mapping (which makes the human queue visible) is lost |
| 205 | PM:467-472 | Chart rules: token classes, tabular, baseline + percentile rules only, `figcaption` | carried | dash §2.10.5 |
| 206 | PM:474 | Worker capability section (`GET /api/capability`) under the flow charts | carried | dash §2.10.3; rt routes |
| 207 | PM:476 | Per-kind row: point on 0–100% track, 95% Wilson bar, *16 of 18 passed · 89% (67–97%)* | carried | dash §2.10.3 |
| 208 | PM:476 | Rows ordered by attempts (best-evidenced first) | missing | dash §2.10.3 |
| 209 | PM:477 | < 10 attempts: *Too few attempts to trust* in amber, hollow point, secondary label | carried | dash §2.10.3 |
| 210 | PM:477 | Caption counts rough rows (*2 of 5 kinds have fewer than 10 attempts; treat those rates as rough*); a wide bar explained as uncertainty, not failure | missing | dash §2.10.3 |
| 211 | PM:478 | Pass rate by change size with 80% line; horizon sentence (`horizon80Lines`) | carried | dash §2.10.3 |
| 212 | PM:478 | Size buckets with < 10 attempts faded and labelled | missing | dash §2.10.3 |
| 213 | PM:478 | The server's `note` shown verbatim under the section | missing | dash §2.10.3 |
| 214 | PM:479 | Capability states: 404 names the endpoint; `sampleSize` 0 → *No finished attempts yet*; renders independently of flow metrics | carried-weaker | 404 covered by dash §2.12.3; the empty state and the independence rule are lost |
| 215 | PM:481 | Under 3 finished cards: *Not enough finished cards… need at least 3; you have 1.* | carried | dash §2.10.5 |
| 216 | PM:481 | Flow 404 message naming `/api/metrics/flow` | carried | dash §2.12.3 (generic) |
| 217 | PM:485 | Everything learned is context not weights, from gate results and human actions, on the ledger, **effective only after approval** | contradicted | ppm §2.13.3 and §8.1: profile statements are used at once (recommendation keeps that and corrects PMC §6); rules still need approval |
| 218 | PM:485 | Plain names (Playbook, rules, *What Seshat has learned about you*, Stopping policy) | carried | dash §2.11, §2.10.4; NAMING |
| 219 | PM:487 | Playbook lede (learned from gates and your actions, never a model grading itself; on this machine; on the ledger; takes effect after approval) | missing | dash §2.11 Playbook |
| 220 | PM:489 | *Needs your approval*: candidates **newest first**; Approve (primary), Edit, Retire | carried-weaker | dash §2.11; ordering lost |
| 221 | PM:490 | *Active*: retirement proposals (≥ 3 more harmful than helpful) first, amber rule, sentence with the counts, **Retire promoted**; rest **by value** | carried-weaker | dash §2.11 ("retirement proposals first, with the counts"); amber rule, promoted Retire and value ordering lost; threshold in ppm §2.13.2 |
| 222 | PM:491 | *Retired* collapsed | carried-weaker | Group listed (dash §2.11); collapsed default lost |
| 223 | PM:494 | Rule audience *For the Worker* / *For Seshat* | carried | dash §2.11 ("audience") |
| 224 | PM:495 | Source in words (four sources) **and its age** | carried-weaker | dash §2.11 ("source in words"); age lost |
| 225 | PM:496 | Scope chips (*Kind*, *Files*, *Error*, *Applies to every card*) | carried | dash §2.11 |
| 226 | PM:497 | Signed value bar relative to the page's largest \|value\|, red when negative; helpful/harmful counts with icons | carried-weaker | dash §2.11 ("value bar, helpful/harmful counts"); normalisation and negative colour lost |
| 227 | PM:498 | Evidence as `@card` chips with quoted note; first two shown, rest *n more signals* | carried-weaker | dash §2.11 ("evidence chips"); truncation rule lost |
| 228 | PM:501 | Inline edit: textarea, `⌘↵` saves, `Esc` cancels | carried-weaker | dash §2.11 ("inline edit"); keys lost |
| 229 | PM:501 | Every learning action optimistic, reverts on failure, states the result (*Approved. The rule is given to the Worker from the next matching card.*) | missing | dash §2.11 Playbook |
| 230 | PM:501 | `/api/learning` 404 → keep seeded rules and send-back suggestions from `/api/playbook` under a banner naming the endpoint | missing | dash §2.11 Playbook |
| 231 | PM:503 | Approve opens a reach picker *This project* (1) / *All projects* (2), sent as `{ reach: "global" }`; footer names `~/.config/sekhemet` | carried-weaker | Reach carried (dash §2.11; ppm §2.13.3; context §24); request field absent from PMC §6 endpoints; footer lost |
| 232 | PM:503 | Active rules carry a reach chip; all-projects rules drawn stronger | carried-weaker | Not stated |
| 233 | PM:503 | Seeded rules from `.sekhemet/playbook.toml` shown as active, read-only (*Edit in playbook.toml*) when the store lacks them | missing | dash §2.11; context §3 names the file only |
| 234 | PM:505-510 | *Seshat's review* (`card/review`) between Gates and Failures; count title; *advice, not a gate* line; `likely_send_back` amber first, `consider` quiet; absent when none | contradicted | rg §2.3 and §9 resolved drift: now the Reviewer role (never Seshat), findings met/unmet/unclear shown **first**, before the gates (dash §2.5.3). The advisory line and severity ordering are not carried |
| 235 | PM:512 | Retries run on the escalation model excluded from capability rates and said so | carried | dash §2.10.3 |
| 236 | PM:514 | *What Seshat has learned about you* is a Playbook section `#/playbook/profile` | carried | dash §2.11 |
| 237 | PM:516 | Profile lock line (stays on this machine; edit to correct; dismiss and Seshat stops using it) | carried-weaker | Behaviour in ppm §2.13.3; the on-page line lost |
| 238 | PM:517 | Active statements grouped by category, **strongest first** | carried-weaker | dash §2.11 (grouped); ordering lost |
| 239 | PM:518 | Strength bar + word (*Strong* ≥ 0.7, *Moderate* ≥ 0.4, *Weak*), source, dated evidence, Edit, Dismiss | carried | dash §2.11 |
| 240 | PM:519 | Dismissed statements collapsed at the end | missing | dash §2.11 |
| 241 | PM:521 | `#/pm` rail: three strongest statements, *See all 4 and edit them in Playbook*, *Stays on this machine* | carried-weaker | dash §2.7.1 (three strongest); link and note lost |
| 242 | PM:523 | Stopping policy under Worker capability when `/api/learning` returns `tuning` | carried | dash §2.10.4 |
| 243 | PM:525 | Headline sentence (cap, minutes saved, passes kept) | carried | dash §2.10.4 |
| 244 | PM:526 | Current vs recommended table: step budget, failed checks allowed, minutes, first-try passes, eventual passes | carried-weaker | dash §2.10.4 (table named, columns lost) |
| 245 | PM:527 | Copyable `sekhemet queue --max-turns 12` | carried | dash §2.10.4 |
| 246 | PM:528 | Note when the failed-check limit differs, because it has no flag yet | missing | dash §2.10.4 |
| 247 | PM:529 | Caveat: replay only stops earlier, never credits a pass, **cannot say whether a looser cap would rescue a failure** | carried-weaker | dash §2.10.4, ppm §2.13.4 carry the first half; the limitation on looser caps is lost |
| 248 | PM:530 | Full replay grid behind a disclosure | missing | dash §2.10.4 |
| 249 | PM:532 | When the current policy is already best, say so and offer no command | missing | dash §2.10.4 |
| 250 | PM:536 | Four roles: Worker; Seshat · PM; Adversarial reviewer (different family); Researcher (Apodex-1.1-mini, cites sources) | contradicted | models §21, SPINE: roles are Worker, **Planner**, Reviewer, Researcher; Seshat is a persona on the Planner's weights. Different-family Reviewer enforced (rg §2.3.7); Apodex default (models §3) |
| 251 | PM:538 | Machine › Models (`GET /api/models`): fixed role order; model id in mono; state dot *Resident* / *Swapped out* / *Not configured*; one-line description | carried-weaker | dash §2.11 Machine (states only); order, id in mono and description lost |
| 252 | PM:538 | A note every role shares (*No run in progress*) said once in the footer | carried-weaker | "one footer line" (dash §2.11) |
| 253 | PM:539-541 | Footer memory model: 24 GB *one model resident; swaps about 40 seconds each*; `coResident` → *room for all four, nothing swaps* | carried-weaker | dash §2.11 "one footer line on how they share memory"; the `coResident` case and the ~40 s figure lost |
| 254 | PM:542 | Roster 404 message naming the endpoint | carried | dash §2.12.3 |
| 255 | PM:543 | Researcher web access Now card: switch `PUT /api/integrations/research-web`; server `detail` names provider or how to set one | carried | dash §2.11; design-stage §3 |
| 256 | PM:543 | Provider line: SearXNG, or Brave/Tavily key; papers, page reads, GitHub need none | carried | design-stage §2.11 |
| 257 | PM:543 | Leaves: search queries and page URLs; private/local addresses never fetched | carried | dash §2.11; design-stage §2.3 |
| 258 | PM:544 | Research cites `{ url?, label }` → numbered **Sources** list (http/https only, new tab, `noopener noreferrer`, host in mono); **no URL → plain text**; card/run/evidence cites keep *Based on* | carried-weaker | dash §2.7.4; the no-URL rule is lost and PMC §3 `cites` lacks `url`/`label` |
| 259 | PM:554 | `#/pm` on `g a` | contradicted | `g p` (see row 67) |
| 260 | PM:555-556 | `⌘J` panel; `#/board` `g b`, `v` | carried | dash §2.3 |
| 261 | PM:557-558 | `g f` Insights, `g s` Integrations | contradicted | See rows 170, 198 |
| 262 | PM:562-567 | Field keys, select/extend/all/clear, `/` `v` `⇧S`, field menu `1–9 ↑↓ ↵`, composer and proposal keys | carried | dash §2.3 |
| 263 | PM:571 | No new colour roles: fifteen roles plus derived tints | carried | dash §2.13.1; tokens.ts (dash adds `--border-control`, not yet in tokens.ts — gap P12) |
| 264 | PM:573-588 | New icons: priority-none/low/medium/high/urgent, chat, insights, plug, split, arrow-right, list, filter, cycle, layers, send, expand | carried | All defined in `packages/ui/src/icons.ts` (dash §3 names it as the source) |
| 265 | PM:590 | Priority bars thickened in CSS (`stroke-width: 3`), unlit class `off`, icon test still holds | carried-weaker | Icon test rule carried (dash §2.13.6); the CSS thickening and `off` class are only in `pm.css` |
| 266 | PM:594 | Panel sizes: 400 (360 at 1024–1279), header 52, **composer min 44**, padding 16, message gap 24 | carried-weaker | dash §2.13.7; composer min height lost; 360 vs 380 settled on 380 |
| 267 | PM:595 | Proposal group: `--bg-surface`, 1 px `--border-subtle`, radius 6, header 36, proposal padding 12/16, diff rows 24 | carried-weaker | dash §2.13.7 keeps header 36 and rows 24 only |
| 268 | PM:596 | Pending block: rows 24, icons 12, times 11 right-aligned tabular, ETA bar 2 | carried-weaker | Only the 2 px bar kept (dash §2.7.8) |
| 269 | PM:597 | View bar 40, padding 16, gaps 8 | carried-weaker | 40 only (dash §2.13.7) |
| 270 | PM:598 | Cycle header 56, two lines, progress bar 6 px | carried-weaker | 56 only |
| 271 | PM:599-600 | Lane header 32; table row 36, group header 32 | carried | dash §2.13.7, §2.4.15 |
| 272 | PM:601 | Bulk bar 48, bottom 16, centred, radius 6 | carried-weaker | 48 + bottom centre only |
| 273 | PM:602 | Chart panel `--bg-surface`, 1 px hairline, 16 padding, 240 plot | carried-weaker | 240 only |
| 274 | PM:606 | Panel is a `complementary` landmark **labelled *Seshat, project manager*** | carried-weaker | dash §2.14.3; label lost |
| 275 | PM:607 | Thread `role="log"`, `aria-live="polite"`, only final replies announced, not timer ticks | carried | dash §2.14.3 |
| 276 | PM:608 | Pending block's current row `aria-busy="true"` | missing | dash §2.14.3 |
| 277 | PM:609 | Proposals a list of labelled groups; Apply/Discard names include the summary | carried | dash §2.14.3 |
| 278 | PM:610 | Field diffs as `dl` (*Priority: Medium, changes to Urgent*) | carried | dash §2.14.3 |
| 279 | PM:611 | Charts: `figcaption` + hidden data table | carried | dash §2.10.5 |
| 280 | PM:612 | List is a real `table` with `aria-sort` on sorted headers and `aria-selected` on rows | carried-weaker | Not in dash §2.14 (only the board listbox) |
| 281 | PM:613 | Bulk bar `role="toolbar"` announcing *3 selected* | carried | dash §2.14.3 |
| 282 | PM:617 | Every item checked in both themes at 1440 and 1024 | carried | dash §2.15.5 (widths now 1440/1100/400) |
| 283 | PM:619-627 | `src/pm.ts` pure logic served as `/app/lib/pm.js` (priority, diffs, markdown, filter, grouping, cycle progress, flow maths, waiting phases) | carried | dash §2.15.1, §3 |
| 284 | PM:628-636 | Web modules list | carried | dash §3 |
| 285 | PM:640 | Backend endpoints for PM, PATCH, cycles, flow, integrations, export, import | carried | rt §3 routes; PMC §3 |
| 286 | PM:640 | UI checked against a contract-shaped fixture server **and** a server with the endpoints absent | carried-weaker | The "not on this server" states are specified; the fixture-server verification is not |
| 287 | PM:640 | Optional contract fields used when present: `PmStatus.since/step/etaSeconds`, `cycleTime[].doneAt`, thread `model`, `epics[].progress.pointsDone`, integration `enabled`, `lastSyncAt` | carried-weaker | PMC §3 has `since/step/etaSeconds/doneAt/lastSyncAt`; **`pointsDone`** (PMC says `points`), a thread-level `model` and integration `enabled` are absent |
| 288 | PM:642 | Saved-view sync waits for `/api/views` | later | dash §7 |
| 289 | PM:642 | No drag and drop; moves explicit and recorded | carried | dash §2.4.5 (reorder within a column now allowed; between columns still gated) |
| 290 | PM:642 | No Undo for applied proposals; *Applied* is final and says so | carried | dash §2.7.7; undo in dash §7 (later) |

### FRONTEND_DESIGN.md

| # | Source | Item | Status | Now in |
|---|---|---|---|---|
| 291 | FE:4 | Mockups board/review/card/runs, `t` toggles theme in them | carried | dash §9 |
| 292 | FE:30 | Triage endpoints need UI (accept/return/park) | carried | dash §2.5.9–12; rg §3 |
| 293 | FE:31 | Parked and rejected cards must be visible ("nothing blocks silently") | carried | dash §2.4.1 (On hold column; Won't do filter) |
| 294 | FE:32 | `canvas.ts` `COLUMN_ORDER` disagrees with the page | carried | canvas.ts cut (DEC-09); `BOARD_COLUMN_ORDER` in vocabulary (dash §3) |
| 295 | FE:33 | Model-authored labels (tier, `(SPIDR: …)`, raw stop enums) must not leak | carried | dash §2.12; ppm P1 (kind from labels) |
| 296 | FE:34 | Gate strip must not invent gates: no fixed P T U L B, **no synthesised `parse: pass`** | carried-weaker | Configured order carried (dash §2.4.4, §2.5.4); the "no synthetic parse" rule (also FE:847) is not stated |
| 297 | FE:34 | `bounds` must not count staged acceptance-test lines | missing | gates §12 says only "exactly"; the exclusion is stated for secrets and integrity, not bounds |
| 298 | FE:35 | Diff separates staged protected tests; `suggestedFixFiles` must not point at protected tests | carried | dash §2.5.6; gates §7, GT-3 |
| 299 | FE:36 | `gatesConfigSha256` = empty-string hash: UI flags it **and the backend must hash the real `gates.toml`** | carried-weaker | UI flag carried (dash §2.5.4); no change item fixes the hashing |
| 300 | FE:37 | Contrast defects (muted 2.6–3.3:1, fail on raised 3.92:1, border-strong 1.26–1.85:1 unfit for focus) | carried | dash §2.13.2, §2.14, P12 |
| 301 | FE:46 | Master board: multi-project rollup, **hardware load**, cards blocked on you with wait time | carried-weaker | Workspace rollup (dash §2.11); hardware load absent; master board beyond rollup later (dash §7) |
| 302 | FE:47 | Project board columns, WIP counters, DAG lines, budget bars | carried | dash §2.4; dependency lines later (dash §7) |
| 303 | FE:48 | Card view with 5 tabs | carried | dash §2.6 |
| 304 | FE:49 | Review as the primary surface | carried | dash §2.5 |
| 305 | FE:50 | Machine: VRAM, **active tier**, loaded models, throughput sparklines, **cache hit rate** | carried-weaker | Memory and models carried (dash §2.11); tier and cache-hit rate not on Machine; sparklines later |
| 306 | FE:51 | Registry: models, qualification, bake-off matrix | carried | dash §2.11 |
| 307 | FE:52 | Decision inbox sorted by wait time | carried | dash §2.5.2 (Review › Needs you) |
| 308 | FE:53 | Goal view: burn-up, criteria, risk register | later | dash §7, ppm §7 (burn-up in v1: dash §2.4.17) |
| 309 | FE:54 | Runs with history (not overwritten) | carried | dash §2.11; rt routes `runs` |
| 310 | FE:55 | Ledger in sentences, filterable, linked to the card, paged beyond 200 | carried | dash §2.11 (paging: see row 452) |
| 311 | FE:56 | Playbook view | carried | dash §2.11 |
| 312 | FE:57 | Mobile: read-only board + one-tap Accept/Return/Park | carried | dash §2.15.3 |
| 313 | FE:59 | Column: name, WIP `3/4`, progress, virtualized, h/j/k/l; empty state explains the column | carried | dash §2.4.2–3, §2.4.10 |
| 314 | FE:60 | Tile: class chip, difficulty, token/second budget bars, dependency badge | contradicted | dash §9 resolved drift: "the tile shows budget, class chip and difficulty" replaced by the professional anatomy |
| 315 | FE:61 | Gate strip in execution order, typed-error hover, click to log; `gates.toml` served | carried | dash §2.5.4; `/api/gates` (dash §3) |
| 316 | FE:62 | Diff: split/unified, structural, inline annotations | carried | dash §2.5.6 |
| 317 | FE:63 | Evidence: criteria, plain stop reason, abandoned hypotheses, attempt history | carried | dash §2.5.3 |
| 318 | FE:64 | Triage A/R/P; returns feed the playbook | carried | dash §2.5; rg §2.4 |
| 319 | FE:65 | Decision request component | carried | dash §2.5.14 |
| 320 | FE:66 | Palette: fuzzy cards, projects, commands, settings | carried | dash §2.15.4 |
| 321 | FE:67 | Keyboard map | carried | dash §2.3 |
| 322 | FE:68 | Cheat sheet | carried | dash §2.3.3 |
| 323 | FE:69 | Live streaming with step-level events; replay from genesis | carried-weaker | SSE + WS (rt item 25); step-level events not named (row 450) |
| 324 | FE:70 | Toasts | carried | dash §2.13.7 |
| 325 | FE:71 | Single-weight 1.5 px icon set | carried | dash §2.13.6 |
| 326 | FE:72 | Virtualized board, 500+ cards, **overscan 3**, no full re-render per frame | carried-weaker | dash §2.4.8–9; overscan 3 lost |
| 327 | FE:74-81 | States: loading, empty, error/offline, running, review full, memory pause, read-only, ledger broken | carried | dash §2.2.4, §2.4.10 |
| 328 | FE:83 | Tokens 15 roles × 2 themes as CSS variables + JSON; add `--on-accent`, tints, `--scrim` | carried | dash §2.13.1; tokens.ts defines all |
| 329 | FE:84 | Inter/JetBrains Mono, 6-step scale, tabular numbers; fonts not bundled | carried | dash §2.13.4; vendoring later (dash §7) |
| 330 | FE:85 | Spacing/radius/no shadows/120 ms; `--space-5` undefined | carried | dash §2.13.5; tokens.ts SPACING has 24px at index 5 |
| 331 | FE:86 | Both themes first-class; **no `prefers-color-scheme` default** | missing | dash §2.1.3 fixes Basalt as default; following the OS preference is not addressed |
| 332 | FE:87 | Brand glyph and favicon | carried | dash §2.13.6 |
| 333 | FE:89-94 | API: evidence by attempt; accept returns sha; return → Ready; events/stream; decisions; machine + calibrate; run/gate/split/rewind/PATCH/create | carried | rt §3 route list; rg §2.4 (rewind from UI later, dash §7) |
| 334 | FE:102-108 | Stance: What needs me? Can I trust it? What do I do? — sets IA, default route, hierarchy | carried | dash §2.1.1 |
| 335 | FE:112 | No all-caps; headings sentence case 12.5/600 primary | carried | dash §2.1.4, §2.13.4 |
| 336 | FE:113 | Gold in exactly four places | carried | dash §2.1.4 |
| 337 | FE:114 | Chips rare; status in the sidebar footer as text + one dot | carried | dash §2.2.3 |
| 338 | FE:115-117 | Units and basis on every number; nothing generic; chrome neutral, state is colour + icon + words | carried | dash §2.1.2, §2.1.5 |
| 339 | FE:122-139 | Sidebar: project switcher (*Chronicle ▾*), count badges on nav items, footer (live · ledger · memory bar · model state · Theme · Keys) | carried-weaker | Footer carried (dash §2.2.3); project switcher and per-item count badges not specified |
| 340 | FE:144 | Review is default when the queue is non-empty; `g r` | carried | dash §2.2.5 (for *I write code*), §2.2.1 |
| 341 | FE:145 | Board default otherwise; `g b` | carried | dash §2.2.1, §2.2.5 |
| 342 | FE:146 | Card route; `Enter` | carried | dash §2.6 |
| 343 | FE:147 | Runs `#/runs[/:runId]` on `g q` | contradicted | dash §2.2.1: Runs has no chord; `g q` silent for one release |
| 344 | FE:148-149 | Ledger `g l`; Machine `g m` | carried | dash §2.2.1 |
| 345 | FE:150 | Playbook on `g p` | contradicted | `g p` is now Project manager; Playbook has no chord (dash §2.2.1) |
| 346 | FE:151 | Inbox `#/inbox` `g i`, hidden until `/api/decisions` returns 200 | contradicted | Inbox merged into Review › Needs you; `#/inbox` opens it; `g i` is Insights (dash §2.2.1) |
| 347 | FE:152 | Settings `#/settings` `g ,`: theme, density, **review minutes per day**, read-only config (Later) | missing | No Settings view in dash; theme/density move to palette/footer (§2.15.4); editing review minutes per day and viewing config from the UI appear nowhere, not even in Later |
| 348 | FE:153 | Workspace, Registry, Goals deferred | carried | Registry, Workspace in dash §2.11; goals later |
| 349 | FE:155 | Log drawer leaves the board; integrity in the footer | carried | dash §2.2.3, §2.11 |
| 350 | FE:157 | Review landing rationale; empty Review says *Nothing to review. 4 cards are ready to run.* | carried | dash §2.5.13 |
| 351 | FE:161 | ≥ 1280 px sidebar 216 px | carried | dash §2.2.2 |
| 352 | FE:162 | 1024–1279 px: 52 px icon rail, tooltips, count badges | contradicted | dash §2.2.2, P11: 176 px sidebar that keeps labels, no icon rail (tokens.ts still defines `--rail-w: 52px`) |
| 353 | FE:163 | < 768 px: bottom tabs **Review, Board, Runs**; single-column board with switcher; Evidence only; 48 px one-tap triage | contradicted | Bottom bar is *Status · Review · Board · PM* (dash §2.2.2); the rest carried (§2.15.3) |
| 354 | FE:167 | Voice: plain, exact, calm; verbs and numbers; name the gate | carried | SPINE Voice |
| 355 | FE:167 | Naming conventions (Workspace, Project, Card, Subtask, Gates, Evidence, Playbook, Worker, Planner, Library) | carried | NAMING keep list |
| 356 | FE:171-175 | Principles: outcome first; sentence case, no !/emoji; enums only in mono where greppable; quote errors verbatim; actor always named incl. *Sekhemet* | carried | dash §2.12.2 |
| 357 | FE:181 | Tier label removed; hierarchy by breadcrumb and a *3 subtasks* badge | carried-weaker | Breadcrumb carried; the subtasks badge lost |
| 358 | FE:182 | Strip `(SPIDR: …)` suffix; planner stores the slice as a field | carried | ppm P1 (kind from labels) |
| 359 | FE:183-190 | Kind mapping Interface→Contract, Data→Storage, Path→Flow, Rule→Rules, Spike→Research, Visual→UI, Integration→Wiring; tooltips; max two, first primary | carried-weaker | dash §2.12.4 keeps names and the two-kind rule; tooltips lost; **and the new docs disagree**: ppm §2.2.2 says Contract is an enabler "not presented as a SPIDR story" and SPIDR Interface means the *user* interface, while dash §2.12.4 has Learn name Contract's slice as Interface |
| 360 | FE:191-199 | Column names Backlog, Ready, Planning, Working, Checking, Review, Done, Parked (visible), Closed (only if non-empty) | contradicted | dash §2.4.1: To do / In progress / In review / Done / On hold, Won't do as a filter; NAMING keep list still lists Working, Checking, Closed (open question dash §8.2) |
| 361 | FE:200 | *3 of 6 first try*; Runs headline *Passed on the first try*; `Pass@1` only as a mono secondary label | carried-weaker | dash §2.11 Runs; the Pass@1 display rule lost |
| 362 | FE:201 | `passAfterEscalation` → *Passed after a planner retry* | missing | No label in dash §2.12.4 |
| 363 | FE:202 | `modelSwaps` → *Model swaps* | carried | dash §2.11 Runs |
| 364 | FE:203-213 | Eleven stop-reason labels and sentences; `memory_pressure` amber, not red | carried | dash §2.12.4 (tones explicit) |
| 365 | FE:214-219 | Gate labels with ids in mono; Types shows its command; **Size sentence *2 files, +11 −0 (limit 3 files, 200 lines)*** | carried-weaker | dash §2.12.4; the Size sentence lost |
| 366 | FE:220 | Gate states; Skipped vs Not run definitions | carried | dash §2.12.4 |
| 367 | FE:221 | Noun *Gates*; *4 of 4 gates passed* | carried | dash §2.12.4 |
| 368 | FE:222 | Back-pressure copy | carried | dash §2.2.4 |
| 369 | FE:223 | Integrity: *Ledger intact · 13 entries* / *Ledger altered at entry #7* + *An entry no longer matches its hash. Stop and inspect before accepting anything.* + `[Open ledger]` | carried-weaker | dash §2.2.3–4; the explanation and the action lost |
| 370 | FE:224 | Stream copy Live / Reconnecting… / Offline since … | carried | dash §2.2.3–4 |
| 371 | FE:225-227 | Nav words Ledger, Machine / Health checks, Suggested rules | carried | dash §2.2.1, §2.11 (Suggested rules → *Needs your approval*) |
| 372 | FE:228-230 | Triage labels, sentences and keys | carried | dash §2.12.4 |
| 373 | FE:231-242 | Card-fact vocabulary (steps, tokens, May edit, Done when, Protected, Waits on/Unblocks, Difficulty, Why it stopped, Checkpoints, Gate contract with empty warning, Tool set) | carried | dash §2.12.4, §2.5.8 |
| 374 | FE:243 | Actors executor/planner/human → Worker/Planner/You | carried | dash §2.12.2 |
| 375 | FE:244-246 | Ledger sentence patterns | carried | dash §2.11 Ledger |
| 376 | FE:247 | Empty Review copy ends with the command `sekhemet queue` | contradicted | dash §2.5.13: a **Run them** button, "not a command" (deliberate) |
| 377 | FE:248 | Empty copy for each of eight columns | carried-weaker | dash §2.4.10 gives one example; `COLUMN_EMPTY` in vocabulary (dash §3); five columns now |
| 378 | FE:249 | Empty evidence: *No attempts yet… Budget: 32 steps.* | carried | dash §2.5.13 |
| 379 | FE:250-253 | Errors: what, why, action; 409 verbatim; 400 prevented client-side; 403 copy | carried | dash §2.12.4, §6 |
| 380 | FE:254 | Read-only copy | carried | dash §2.2.4 |
| 381 | FE:262 | Loading: skeleton of real geometry, no spinner; after 3 s *Connecting…* | carried | dash §2.2.4 |
| 382 | FE:263-264 | Live green dot; Reconnecting amber, content stays, mutations enabled 10 s | carried | dash §2.2.4 |
| 383 | FE:265 | Offline: > 10 s and `/api/meta` fails; bar (`--bg-raised`, 1 px parked border); Retry; triage disabled with *Offline*; timestamps freeze | carried | dash §2.2.4, §6 (bar styling lost) |
| 384 | FE:266 | Read-only: triage replaced by a note; `a/r/p` toast the same copy | carried | dash §2.2.4 |
| 385 | FE:267 | Review full amber bar with `Open review` | carried | dash §2.2.4 |
| 386 | FE:268 | Memory pause trigger (critical, or last queue entry `memory_pressure`); copy; **`Machine` action**; running tile flips | carried-weaker | dash §2.2.4; the `Machine` action lost |
| 387 | FE:269 | Ledger altered: red, not dismissible; Accept disabled everywhere | carried | dash §2.2.4, NEW-dashboard-2 |
| 388 | FE:271 | One bar at a time; ledger > offline > memory > review full | carried | dash §2.2.4, §6 |
| 389 | FE:275 | Review goal: decide in under a minute without reading the trajectory | carried | rg §2.1.2 |
| 390 | FE:280-295 | Review layout at 1440 | carried | dash §2.5.1 |
| 391 | FE:298-301 | Queue: *Ready for review* oldest first; *Need you* (parked, failed after ladder, decisions) longest wait first | carried | dash §2.5.2 |
| 392 | FE:303 | Row 56 px; title 13/500 one line; meta 11 secondary; selected = 2 px `--text-primary` bar + `--bg-overlay`; wait amber after 2 h | carried-weaker | dash §2.5.2; the selected-row styling (and FE:788's list selection bar) lost |
| 393 | FE:305 | Evidence column fluid, min 560 | carried | dash §2.5.1 |
| 394 | FE:307 | Breadcrumb; attempt selector **disabled when there is only one attempt** | carried-weaker | dash §2.5.3; disabled rule lost |
| 395 | FE:308-313 | Title 18/600; outcome line; gates strip; failures by gate; grouped changes; *What the Worker tried* | carried | dash §2.5.3 |
| 396 | FE:317 | *Done when* neutral bullets; with all gates passing: *All gates passed. Criteria are checked by the acceptance tests.* | carried-weaker | dash §2.5.8 (Reviewer may judge); the sentence lost |
| 397 | FE:318-320 | Run facts; Scope; Provenance with Copy | carried | dash §2.5.8 |
| 398 | FE:322 | Triage bar sticky, 52 px, `--bg-surface`, top hairline | carried | dash §2.5.9 |
| 399 | FE:324 | Accept enabled only in review, blocking gates passed, triage on, ledger intact; reason inline | carried | dash §2.5.9 (+ permission) |
| 400 | FE:325-326 | Send back secondary; Park ghost | carried | dash §2.5.9 |
| 401 | FE:327 | Right-aligned hint `j k` · `Space` · `?` in the triage bar | missing | dash §2.5.9 |
| 402 | FE:328 | Need-you cards: Retry with planner once `POST …/run` exists; until then Send back and Park | carried | dash §2.5.9; later dash §7 |
| 403 | FE:332 | Accept: *Merging…*, 3 s grace toast with *Undo Z*, then POST; success toast with sha + Copy; row leaves, focus next; 409 toast, row stays | carried | dash §2.5.10, §6 |
| 404 | FE:333-338 | Send back composer: inline; required textarea; quick notes from failures; *Suggest as a playbook rule* on (informational, disabled-checked until a flag exists); `⌘↩`/`Esc`; toast and advance | carried | dash §2.5.11; rg §2.4 (candidate only when actionable) |
| 405 | FE:339 | Park popover: optional reason, three presets, `↩` confirms | carried | dash §2.5.12 |
| 406 | FE:340 | Keys `j/k`, `o`/`Enter`, `[ ]`, `f`, `u` | carried | dash §2.3 |
| 407 | FE:344-346 | Data: board `display` + `enteredColumnAt`; evidence; attempts endpoint | carried | dash §2.15.2; rt routes |
| 408 | FE:352 | Loading evidence: 4 gate boxes + 3 diff-line skeletons; queue interactive | carried | dash §2.5.13 |
| 409 | FE:353 | Empty queue: 24 px glyph in `--text-muted`, copy, Ready count, **right rail hidden** | carried-weaker | dash §2.5.13; glyph and hidden rail lost |
| 410 | FE:354-357 | No evidence (only Park); inline error with retry; state-change notice with Reload; offline/read-only | carried | dash §2.5.13 |
| 411 | FE:359 | 1024: Facts disclosure, queue 248; mobile queue full screen, file list tap-to-diff, bottom bar, send back in a sheet | carried | dash §2.5.1, §2.15.3 |
| 412 | FE:365 | Board topbar: filter chips, `Dependencies` toggle, density toggle | carried-weaker | Filters in view bar; Dependencies became `#/graph`; density toggle only in palette |
| 413 | FE:367 | Columns fluid min 200, max 300, gap 8, board padding 16 | carried | dash §2.4.2 (padding 16 lost) |
| 414 | FE:368 | Empty columns collapse to 36 px rails (after 5 min empty; Done below 1600 px) | contradicted | dash §2.4.2, P3: chips above the board; Done full whenever it has cards |
| 415 | FE:369 | Parked full column far right with amber count; Closed only when non-empty | carried | dash §2.4.1 (On hold; Won't do filter) |
| 416 | FE:370 | > 6 columns → horizontal windowing; Review and Parked pinned | carried | dash §2.4.2, §2.4.9 |
| 417 | FE:372 | Column header 36; name · count; WIP `1 / 3` + 2 px bar; secondary/amber/red; derivation tooltip; `⋯` menu (sort, collapse) | carried | dash §2.4.3 |
| 418 | FE:374 | In-column order by `orderKey`; **Review and Parked sort by wait time, longest first** | carried-weaker | Reordering carried (dash §2.4.5); the board's wait-time sort for those columns is lost |
| 419 | FE:378 | `h/l` keep the row index clamped; `j/k` | carried | dash §2.3 |
| 420 | FE:379 | Peek drawer 480 px with triage keys; `Enter` opens card | carried | dash §2.4.6 |
| 421 | FE:380 | `c` creates once `POST /cards` exists, else a toast with the CLI | gap | dash P3 (create through a planner proposal; no CLI message) |
| 422 | FE:381 | No drag and drop in v1; moves via recorded triage | carried | dash §2.4.5 (within-column reorder now allowed) |
| 423 | FE:382 | Click selects; `Space` **or double-click** peeks | carried-weaker | Double-click lost |
| 424 | FE:384 | SSE patches only changed tiles; keeps scroll/focus/drawer; **a focused card that changes column keeps focus and is scrolled into view; others don't scroll**; *just now* 10 s; no motion | carried-weaker | dash §2.4.8, §6; the focus-follow rule lost |
| 425 | FE:388 | Empty board: *No cards yet* + `sekhemet plan …` and the fixture seed command | contradicted | dash §2.4.10: **Start a project** button; "No path ends in use the CLI" (deliberate) |
| 426 | FE:389-392 | Empty column copy at top; filter no-match + Clear filter; review full + *Holding for review*; memory pause | carried | dash §2.4.10 |
| 427 | FE:394 | 1024: column min 220, horizontal scroll, pins; mobile switcher, tap → Evidence, no create/batch | carried | dash §2.15.3 |
| 428 | FE:396 | Board data: `display`, `/api/wip` merged, stream; `card/step` for the running status line | carried-weaker | See row 450 |
| 429 | FE:400-407 | Card view header 96 px: breadcrumb, title+kind, state pill + sentence, triage, `⋯` (Copy id, Open worktree path, View in ledger); tabs `1–5` | carried | dash §2.6 |
| 430 | FE:407 | Tabs 32 px with a 2 px `--accent` underline on the active tab | carried-weaker | Tab styling lost (and it would break "gold in exactly four places") |
| 431 | FE:409-420 | Evidence tab; Plan tab (spec, criteria, scope, three budgets, difficulty meter + routing, waits/unblocks, rationale, repair plan for attempt 2+) | carried | dash §2.6 |
| 432 | FE:420 | Persist the Planner's repair plan into evidence or the ledger | carried-weaker | dash §2.6 shows it; no spec states where it is persisted |
| 433 | FE:422-429 | Steps tab: tool calls with observation summaries, gate results, tokens/time right-aligned, loop annotation, stop row, live append, *3 new steps ↓*, expandable `write_file` | carried | dash §2.6 |
| 434 | FE:433-437 | Thread tab (quotes for notes); Files tab; no-data tab states | carried | dash §2.6 |
| 435 | FE:443 | Runs list 240 px (date, time, model, `3/6`, duration) | carried | dash §2.11 (width lost) |
| 436 | FE:445-450 | Headline blocks: *Passed first try*, *Passed after retry*, *Total time*, *Tokens*; deltas vs previous run | carried-weaker | dash §2.11 "headline numbers with deltas"; the four metrics lost |
| 437 | FE:451 | Timeline: segments proportional to duration, **filled by outcome, labelled by short id** | carried-weaker | dash §2.11 (sum to 100%); fill and labels lost |
| 438 | FE:452 | Cards table columns (title, attempt, result, why stopped, steps, time, tokens, accepted sha), sortable | carried-weaker | dash §2.11 names only *Why it stopped* |
| 439 | FE:453-454 | Stops by reason, each linked; run settings | carried | dash §2.11 |
| 440 | FE:456 | `writeQueueReport` also writes `.sekhemet/runs/<startedAt>.json` | carried-weaker | Runs endpoints exist (rt §3); storage not stated (kernel §15 says durable state is the ledger) |
| 441 | FE:459 | *No runs yet* + `sekhemet queue --auto-accept` | carried | Superseded: Runs is hidden until the first run (dash §2.2.1) |
| 442 | FE:460 | Run in progress: *Running · 2 of 6 cards · 4m*; timeline grows live | carried | dash §2.11 ("grows live"; copy lost) |
| 443 | FE:464 | Ledger columns seq, time, actor, type, hash (8 chars); prev-hash tooltip | carried | dash §2.11 |
| 444 | FE:466-469 | Filters card/actor/type; `Enter` detail with payload, payload hash, hash, prev; integrity header with verified time; first bad row red | carried | dash §2.11 |
| 445 | FE:475 | Memory gauge: used/total GB, level Normal/Warning/Critical, swap in use, 85/90/94% ticks, a sentence each | carried-weaker | dash §2.11 (gauge + thresholds + what happens); used/total, level names and swap lost |
| 446 | FE:476 | Model: worker id, resident, endpoint, keep-alive; tokens/s sparklines later | carried-weaker | dash §2.11 (by role, state); endpoint and keep-alive lost; sparklines later (dash §7) |
| 447 | FE:477-479 | Health checks with icon, name, plain detail, fix hint; sandbox mode; worktrees | carried | dash §2.11 |
| 448 | FE:480 | *Re-run checks* bypasses the **15 s** cache with **`?fresh=1`** | carried-weaker | dash §2.11 (bypasses the cache); duration and parameter lost |
| 449 | FE:482 | `GET /api/machine` shape; pushed on SSE as `event: machine` **every 5 s** | carried-weaker | rt routes list `machine`; shape and push cadence not stated (built: `server.ts:572`) |
| 450 | FE:658 (+FE:396, 431, 871) | `card/step` ledger event per turn `{ id, turn, calls, gate?, usage }` from `card_runner` `onProgress`; drives the running tile and live Steps | carried-weaker | Behaviour carried (dash §2.4.4, §2.6); no spec names the event or its shape (kernel §3 lists only "run events in `RUN_EVENTS`"); the code has it |
| 451 | FE:657 | Transcript endpoint shape `{ attempt, file, steps: [...] }` | carried-weaker | rt route `cards/:id/transcript`; shape lost |
| 452 | FE:471, 659 | `GET /api/events?since=&card=&limit=&order=desc` → `{ events, verification, nextCursor }`, paged newest first | carried-weaker | rt §3 lists only `events?since=`; the card filter the Thread tab needs, the limit, paging and order are not specified |
| 453 | FE:486 | Playbook rules table: instruction (2-line clamp), trigger gate, teaching card, since, pattern | carried | Superseded by the learning view (dash §2.11); fields in context §24 |
| 454 | FE:487 | Suggested rules with Promote (editor, pick trigger gate) and Dismiss | carried | dash §2.11 (*Needs your approval*: Approve, Edit, Retire) |
| 455 | FE:488 | Empty Playbook copy | carried | Superseded: Playbook hidden until the first rule (dash §2.2.1) |
| 456 | FE:490, 661 | `GET /api/playbook` shape `{ rules, candidates }` | carried-weaker | rt route listed; shape lost |
| 457 | FE:494 | Inbox: nav hidden until the endpoint exists; never a dead link | carried | dash §2.2.1 |
| 458 | FE:500 | Tile compact: **264 px wide**, 8/12 padding, 4 px gap | carried-weaker | dash §2.13.7 (padding); width and row gap lost |
| 459 | FE:504 | Row 1 kind tag · short id | contradicted | dash §2.4.4 (see row 124) |
| 460 | FE:505-508 | Title 13/500 2-line clamp; pips + status line; budget bar only when started | carried | dash §2.4.4 |
| 461 | FE:512 | The status line is the card's current truth, derived per state | carried | dash §2.4.4 |
| 462 | FE:516 | Ready: *Ready · 32-step budget* | contradicted | dash P3: "no step budget on the board face" (deliberate) |
| 463 | FE:517 | Blocked: link icon in `--state-blocked`, *Waits on X*, **title in `--text-secondary`** | contradicted | dash §2.4.4: "a blocker flag **in red**"; dash §2.13.3 keeps blocked = secondary text. Red is the fail role; the two new statements disagree, and the dimmed-title rule is lost |
| 464 | FE:518 | Planning: pencil, *Planner is writing the plan* | carried | dash §2.4.1 (*Being planned*) |
| 465 | FE:519 | Working: pulsing lapis dot, step line, 2 px running rule, lapis budget | carried | dash §2.4.4, §2.13.3, §2.13.5 |
| 466 | FE:520-521 | Checking: running pip ring; Failed-will-retry: red pips, rung line, fail rule | carried | dash §2.4.1, §2.13.3 |
| 467 | FE:522-524 | Review waiting (amber after 2 h); Parked (pause, amber, rule); Done (check-circle, secondary, no bars, sha + age) | carried | dash §2.4.1, §2.4.4 |
| 468 | FE:526 | Gate pips: 12×12 per configured gate in order; glyphs; glyph on fill; not-run 1 px outline; no letters; popover | carried | dash §2.4.4; `--on-state` in tokens.ts |
| 469 | FE:527 | Budget bar 2 px; secondary/lapis/amber ≥ 75%/red 100%; tokens and seconds as a second line in comfortable density | carried | dash §2.4.4 |
| 470 | FE:528 | Dependency badge: link icon + count, tooltip lists titles | carried | Replaced by the blocker flag with cause (dash §2.4.4, P3) |
| 471 | FE:529 | Difficulty diamond on the tile in comfortable density | contradicted | dash §2.4.4: difficulty moves to peek and Facts (deliberate) |
| 472 | FE:531-536 | Tile states (hover, focus ring offset −1, selected border + checkbox, both); heights 88/112 | carried | dash §2.4.4 |
| 473 | FE:540 | Column header variants incl. at-capacity tooltip *Full. The Worker holds finished cards until you clear one.* | carried-weaker | Variants carried (dash §2.4.3); the tooltip copy lost |
| 474 | FE:544 | Gates segment `[icon] Name duration`, 32 px, hairlines, `--bg-surface`; failed = 2 px fail top rule + count | carried | dash §2.5.4 |
| 475 | FE:546 | Popover (max 420 px): id and command, exit code, first 3 typed failures, *Show all* | carried | dash §2.5.4 (420 lost) |
| 476 | FE:547 | Click on a passed gate opens its raw log once stored; until then *No output recorded for passed gates.* | carried-weaker | dash §2.5.4 covers failing gates only |
| 477 | FE:548-549 | Order + derived Size; skipped with reason; empty-contract amber segment + tooltip | carried | dash §2.5.4 |
| 478 | FE:555-561 | Failure block: header, excerpt, Expected/Actual, repro + copy, *Suggested*, protected-file warning, fail rule, grouping | carried | dash §2.5.5 |
| 479 | FE:565 | Diff groups incl. *Other*; identical-to-`acceptance/<name>` note | carried | dash §2.5.6 |
| 480 | FE:566-571 | Sticky 32 px file header; 40 px gutters (muted allowed); tints; hunk headers secondary on raised; sign kept | carried | dash §2.5.6 |
| 481 | FE:572 | Annotation rows: 2 px fail rule, gate icon, message; **`role="note"`, focusable**; `n/N` | carried-weaker | dash §2.5.6; role and focusability lost (focus order in §2.14.4 mentions annotations) |
| 482 | FE:573-574 | Unified/split `u`; whitespace toggle; > 400 lines collapse; lockfiles/generated collapsed | carried | dash §2.5.6 |
| 483 | FE:580-584 | Button variants: primary (accent / `--on-accent`), secondary (raised, primary, border-subtle), ghost | carried-weaker | Variant names used (dash §2.5.9); fills/borders lost |
| 484 | FE:586 | Buttons 32 px high, 4 px radius, 12 px padding, `kbd` hint inside, 11 px mono | carried-weaker | Radius only (dash §2.13.5) |
| 485 | FE:586 | Disabled = 40% opacity; reason in adjacent text, never only a tooltip | contradicted | dash §2.13.2, P12: neutral fill (deliberate); the reason-in-text rule is carried |
| 486 | FE:592-597 | Decision request: question 15/600 + category; options with consequence, effort, risk, Preview; Recommended (neutral) + rationale; policy line; countdown per minute, amber < 15 min; destructive confirm; `1–9`, `↩` | carried | dash §2.5.14; ppm §2.10 |
| 487 | FE:601 | Scorecard block: label 11 secondary, value 22/600 tabular, delta 11 in state colour + arrow icon | carried-weaker | Value size only (dash §2.13.4) |
| 488 | FE:605-607 | Machine components: 6 px gauge with ticks; check row sizes; sparkline 120×24 (later) | carried-weaker | Sizes lost; sparklines later (dash §7) |
| 489 | FE:611-617 | Palette: 600 px at 12vh, raised + strong border, `--scrim`; 48 px/15 px input; groups; fuzzy highlight; shortcuts; `>`/`#`; `⌘↩`; recent cards | carried | dash §2.15.4, §2.3 |
| 490 | FE:621-625 | Toasts: bottom-left 16 px, max 3, 360 px, overlay + strong border, icon, one line, action; 4 s / errors stay; **`role="status"` / `role="alert"`**; hover pauses | carried-weaker | dash §2.13.7; ARIA roles lost |
| 491 | FE:629-631 | Cheat sheet: 720 px modal, four columns; dimmed inapplicable keys; reachable from the sidebar footer | carried | dash §2.3.3, §2.2.1 (Keys) |
| 492 | FE:635-643 | Key additions: `g q`, `g l`, `g p`, `1–5`, `[ ]`, `u`, `n/N`, `f`, **`t` theme**, `z`, `/` | contradicted | Bare `t` removed (dash §2.3.2, P11); `g q`/`g p` reassigned; the rest carried |
| 493 | FE:645 | Keys ignored in text fields except `Esc` and `⌘↩` | carried | dash §2.3.4 |
| 494 | FE:653 | `card.display` shape (title, kinds enum, shortId, stateLabel, statusLine, tone enum, stopLabel, enteredColumnAt, waitsOn, evidence summary) | carried-weaker | dash §2.15.2 lists fields; `stopLabel` and the enums lost |
| 495 | FE:654 | `GET /api/gates` → `{ gates[], protected, maxFiles, maxDiffLines, sha256, empty }` | carried-weaker | Route only (dash §3; rt §3); `empty` flag needed for the empty-contract warning is unstated |
| 496 | FE:655-656 | `GET /api/cards/:id` with attempts; `evidence?attempt=` | carried | dash §3; rt §3 |
| 497 | FE:660 | `GET /api/runs[/:id]` | carried | rt §3 |
| 498 | FE:663 | `/api/meta` adds `project, repoPath, triage, reviewMinutesPerDay, version, gitUser` | carried-weaker | `meta` route listed; the fields are not (the footer's "who you are" needs them, dash §2.15.7) |
| 499 | FE:664 | `POST /api/cards/:id/run` returns `{ attemptId }` | carried | rt RUN-4 (response returns the log path) |
| 500 | FE:665 | `GET /api/decisions`, answer endpoint | carried | rt §3; ppm §2.10 |
| 501 | FE:667-676 | Vocabulary functions in `vocabulary.ts`; server calls them; `/vocab.json`; browser never re-derives a label | gap | dash §2.12.1, §2.15.2; NEW-dashboard-2 (four status maps today) |
| 502 | FE:684-692 | Token additions `--on-accent`, `--on-state`, `--scrim`, tints (12% / 10%), `--sidebar-w`/`--rail-w`/`--topbar-h` | carried | dash §2.13.1; tokens.ts defines every one |
| 503 | FE:694 | Fonts: system fallback must look right; WOFF2 bundling optional | later | dash §7 (vendored fonts, owner's yes) |
| 504 | FE:698-710 | Type usage table | carried | dash §2.13.4 (wordmark tracking −0.01em and the `kbd` style lost) |
| 505 | FE:714-727 | Spacing per component (sidebar item padding/gaps/footer, topbar 16/12, column body 8, evidence 24 gap / 8 heading, failure block 8/12 + 8 gap, triage bar 0 24 / 8, palette group label 28, toast 12/16) | carried-weaker | dash §2.13.7 keeps heights; most paddings and gaps lost |
| 506 | FE:729-763 | Icon set (names and drawings) | carried | `packages/ui/src/icons.ts` defines every one |
| 507 | FE:765 | No filled icons, duotone, emoji, Unicode ✓ ✗ | carried | dash §2.13.6 |
| 508 | FE:767-776 | Colour application per tone | carried | dash §2.13.3 |
| 509 | FE:780-783 | Motion rules | carried | dash §2.13.5, §6 |
| 510 | FE:787 | Focus: 2 px accent outline, offset 1, `:focus-visible`; replaces `--border-strong` which fails | carried | dash §2.14.5 |
| 511 | FE:788-789 | Selection: overlay + strong border, or a 2 px `--text-primary` left bar in lists; focus and selection distinct | carried-weaker | Tile selection carried (dash §2.4.4); the list left-bar and the distinctness rule lost |
| 512 | FE:793-797 | Brand: pylon glyph path, wordmark, favicon 32 px on 6 px rounded bg-base; no tagline, mascot, lion | carried | dash §2.13.6 |
| 513 | FE:801-805 | Contrast rules (secondary ≥ 5.3, muted decorative, state text only on base/surface, state icons ≥ 3:1) + unit test | gap | dash §2.14.1, P12 (test partial) |
| 514 | FE:806-813 | Colour never alone; landmarks; board listbox roles; gates strip list; tabs; modal dialogs; one live region; Review focus order | carried | dash §2.14.3–4 |
| 515 | FE:814-815 | Targets 24×24 / 44×44; 200% zoom | gap | dash §2.14.5, P12 (copy buttons 14×14 today) |
| 516 | FE:823 | Static build-free ES modules under `/app/`; no framework/CDN; air-gapped; React/TanStack rejected; own virtualization | carried | dash §2.15.1, §9 resolved drift |
| 517 | FE:825-831 | Verification recipe: seed, serve, three viewports, both themes, compare mockups, keyboard only, empty error console | carried | dash §2.15.5 (viewports now 1440×900, 1100×800, 400×812) |
| 518 | FE:837 | Vocabulary covers every `ExecutionStopReason` and fixture suffix; **an unknown reason falls back to the humanised enum** | carried-weaker | worker-loop WL-11 covers every reason; the fallback rule lost |
| 519 | FE:838 | Contrast test thresholds (secondary ≥ 4.5 all surfaces; state ≥ 4.5 on base/surface, ≥ 3 on raised; accent ≥ 3; on-accent ≥ 4.5) | gap | dash P12 (≥ 4.5 text as used, ≥ 3 edges and icons) |
| 520 | FE:839 | Icon test: 24 viewBox, 1.5 stroke, no fill except `dot` | carried | dash §2.13.6; `icons.spec.ts` |
| 521 | FE:840 | Static serving: **`..` refused (path traversal)**, correct MIME types, every served `.js` passes `node --check`, `/vocab.json` | missing | No spec states traversal refusal or MIME for `/app/*` (security and rt are silent; dash §4 notes the syntax-only check) |
| 522 | FE:841 | Shell page about 60 lines | carried | dash §2.15.1 ("a small shell") |
| 523 | FE:847 | Board enrichment: gate list from evidence rung results in execution order, no synthetic `parse`; hasher example values | carried-weaker | See row 296 |
| 524 | FE:848 | Killing the server: Reconnecting, then Offline within 10 s, actions disabled | carried | dash §6 |
| 525 | FE:849 | No uppercase text on screen; pips have `aria-label`s | carried | dash §2.1.4, §2.14.3 |
| 526 | FE:850 | Parking via curl appears in Parked **within 1 s** with scroll preserved; 500 cards, no task > 50 ms | carried-weaker | 500/50 ms carried (dash §6); the 1 s latency lost |
| 527 | FE:851-853 | Keys work with the mouse unplugged; peek `Esc` returns focus to the tile; palette ranking and `>acc` | carried | dash §2.1.3, §2.3; palette §2.15.4 |
| 528 | FE:859 | `/api/gates` returns gates in order; `empty: true` for `e3b0c442…` | carried-weaker | See row 495 |
| 529 | FE:862-863 | Diff parser test; triage acceptance (A merges, empty R blocks, note → candidate, Z within 3 s sends nothing) | carried | dash §6; rg §2.4 |
| 530 | FE:870-871 | Transcript returns 8 steps with `stopReason`; one `card/step` per turn, chain valid | carried-weaker | See rows 450–451 |
| 531 | FE:873-876 | Card view acceptance (Enter opens evidence tab, 1–5, live steps, return note as a quote, running tile) | carried | dash §2.6, §2.4.4 |
| 532 | FE:881-886 | Runs history rows; Ledger tamper disables Accept; memory level at 0.85; Playbook view | carried | dash §2.11, NEW-dashboard-2; models (classifyMemoryPressure) |
| 533 | FE:890 | Later: Inbox and decision requests | carried | Built, in Review › Needs you (dash §2.5.2, §2.5.14) |
| 534 | FE:891 | Later: `POST /cards/:id/run` (Retry with planner) | later | dash §7 |
| 535 | FE:892 | Later: promoting playbook candidates | carried | Approve in Playbook (dash §2.11) |
| 536 | FE:893 | Later: mobile triage polish | carried | dash §2.15.3 |
| 537 | FE:894 | Later: dependency lines overlay | later | dash §7 |
| 538 | FE:895 | Later: bundled fonts | later | dash §7 |
| 539 | FE:896 | Later: sparklines | later | dash §7 |
| 540 | FE:897 | Later: master board, Registry, Goals | later | Registry and Workspace built (dash §2.11); master board beyond rollup and goal view later (dash §7) |
| 541 | FE:898 | Later: difftastic intent grouping | later | dash §7 |
| 542 | FE:900-901 | Planner stores `slice` on the card; fixture titles drop `(SPIDR: …)` | carried | ppm P1 (kind from labels; five parsers fixed) |
| 543 | FE:902 | `gatesConfigSha256` must hash the real `gates.toml` | carried-weaker | See row 299 |
| 544 | FE:903 | `suggestedFixFiles` must not point at protected tests | carried | gates §7, GT-3 |
| 545 | FE:904 | `bounds` must exclude staged acceptance tests | missing | See row 297 |
| 546 | FE:905 | `COLUMN_ORDER` should include planning and parked | carried | canvas.ts cut (DEC-09) |
