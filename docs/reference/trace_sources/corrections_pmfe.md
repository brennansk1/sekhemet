# Trace corrections: the PM and frontend rows

*Full re-verification of every `carried` and `gap` row from PM_DESIGN and FRONTEND_DESIGN in [DESIGN_TRACE.md](../DESIGN_TRACE.md), 2026-09-25. Applied to the trace and the specs by the lead; the lead's choices: D6 restore the On hold count in the warn tone; D9 keep the global +1 px focus offset (deliberate, for consistency); D32 restore the 240 px Runs list; RT1 follow the code.*


Scope: every PMFE row of DESIGN_TRACE §5.3–5.4 whose final status is `carried` (485) or `gap` (12) — 497 rows. Each row was read against the old text (`git show fb59ba2:docs/design/PM_DESIGN.md`, `…/FRONTEND_DESIGN.md`) and the current text of dashboard.md, planner-pm.md, NAMING.md, PM_CONTRACT.md (and gates, runtime, surface, design-stage, integrations, models where the row points there). Where a row's build state was in doubt, the spec's §4 was read and, for five rows, the code was checked (`packages/ui/web/board.js` wait sort and keyed patching are built, so PMFE:418 and PMFE:424 stay `carried`; `vocabulary.ts` has the humanised fallback, so PMFE:518 stays `carried`; `pm_thread.js:238,246` has the read-only and Worker-running cost lines, so PMFE:86 and PMFE:88 are built).

Restoration ids (D-, P-, C-, N-, RT-) point to the second section.

## Trace corrections

| Row | Old status | New status | New location | Note |
| --- | --- | --- | --- | --- |
| PMFE:6 | carried | gap | ppm §2.6.2; NEW-planner-pm-1 (PM-N1-1) | ppm §4 "Points written to cards: not-built" — the planner writes no `estimate`; the row's capability is unbuilt |
| PMFE:7 | carried | gap | ppm §2.6.2; NEW-planner-pm-1 (PM-N1-2) | "an 8 is proposed for splitting" is PM-N1-2, unbuilt |
| PMFE:8 | carried | gap | dash §2.4.3 (column points sum), §2.4.13–14 (cycle and lane points, built); P3 (DB-P3-9) | No column-header points sum in `board.js`; dash §4 has no row for it — add one (D45) |
| PMFE:34 | carried | gap | ppm §2.7.8 table; P6 (PM-P6-3) | ppm §4: three builders and a lifetime count, so "done since the last standup" is unbuilt |
| PMFE:53 | carried | carried | ppm §2.8.2 (*"I've proposed…"*, never *"I've changed…"*), §2.8.3 | Stale note: the phrasing rule is restored in §2.8.2; delete "the phrasing rule is lost" |
| PMFE:56 | carried | carried (after P1) | ppm §2.8.2 | "No flattery **or filler**" ("Great question") lost; restore P1 |
| PMFE:57 | carried | carried (after P2) | ppm §2.8.17; §9 | Example "step 5 of 32" became "step 5 of 40" with no reason; the shortening is recorded ("shortened") but the number change is not; P2 |
| PMFE:70 | carried | carried (after D24) | dash §2.7.3 | Header contents lost: "(avatar, *Seshat*, time)", "no bubble" |
| PMFE:71 | carried | carried (after D24) | dash §2.7.3 | "secondary" colour and the example system line lost |
| PMFE:78 | carried | carried (after D25) | dash §2.7.4 | Fuzzy match on titles and ids and "`↵` inserts the chip token" lost (§2.3's composer row has only "`@` mention a card") |
| PMFE:83 | carried | carried (after D5) | dash §2.7.6, §2.3 | "`Esc` returns focus to the page **without closing the panel**" lost |
| PMFE:85 | carried | carried (after D26) | dash §2.7.6 | Position and style lost: "under the composer, in 11px secondary" |
| PMFE:86 | carried | carried (after D47) | dash §2.7.6 | Copy rewritten under P5 (recorded as P5's intent) but the example budget went 32 → 40 with no reason; D47 |
| PMFE:88 | carried | carried (after D26) | dash §2.7.6 | "(The composer is disabled.)" in read-only is in no document |
| PMFE:97 | carried | carried (after D27) | dash §2.7.7 | "Park **and unpark** show the reason" — unpark lost |
| PMFE:98 | carried | carried (after D27) | dash §2.7.7 | Stale copy shortened: old *…Ask again for a fresh proposal.*, new *…Ask again.*; "the diff" and "reason stated inline" lost |
| PMFE:100 | carried | carried | ppm §2.8.3; PMC §3 (`pm/proposal_state`, actor `human`) | Stale note: ppm §8 Q2 is resolved and PMC §3 now names `pm/proposal_state`; drop "vs" |
| PMFE:107 | carried | carried (after D28) | dash §2.7.8 | "Past the ETA **the bar stops**" lost |
| PMFE:109 | carried | carried (after D28) | dash §2.7.8 | Copy shortened: old *Reloading the Worker; step 6 starts next.*, new *Step 6 starts next.*; "the reply is usually already shown above this row" lost |
| PMFE:116 | carried | carried (after D47) | dash §2.7.8, §2.4.1 | Example "step 5 of 32" → "step 5 of 40" with no reason; D47 |
| PMFE:119 | carried | carried (after D28) | dash §2.7.8 | Audit #29: copy *Offline. Your message would not reach Seshat.* lost; restore and delete "copy lost" |
| PMFE:120 | carried | carried (after D29) | dash §2.7.9 | The "how to fix" details text is in no document |
| PMFE:123 | carried | carried (after D29) | dash §2.7.9 | Copy **Couldn't load the conversation.** *The server returned 500.* lost ("thread error with Retry" only) |
| PMFE:128 | carried | carried (after D9) | dash §2.4.4 | Outline colour `--border-subtle` lost |
| PMFE:130 | carried | carried (after D9) | dash §2.4.4 | Reason lost ("the board's windowing depends on it"); the row itself says "reason lost" |
| PMFE:131 | carried | carried (after D11) | dash §2.4.11 | "under the topbar, on `--bg-base` with a hairline" lost; the row says "colour lost" |
| PMFE:133 | carried | carried (after D11) | dash §2.4.11 | *All cards* **(default)** lost |
| PMFE:134 | carried | carried (after D11) | dash §2.4.11 | "Click one to edit it, or `✕` to remove it" lost (Assignee → Owner, Delegate is DEC-25 R10, fine) |
| PMFE:147 | carried | carried (after D12) | dash §2.4.14 | Basis `done / total` cards lost; the row says "basis lost" |
| PMFE:152 | carried | carried (after D13) | dash §2.4.15 | "It uses the same filter, grouping and selection as the board" is not stated |
| PMFE:153 | carried | carried (after D13) | dash §2.4.15 | The leading selection-checkbox column lost (ID → Key and Assignee → Owner, Delegate are fine) |
| PMFE:155 | carried | carried (after D13) | dash §2.4.15, §2.3 | Group header height 32 px lost (§2.13.7 has lane header 32, table row 36, no group header) |
| PMFE:157 | carried | carried (after D13) | dash §2.4.15, §2.3 | Which cells are inline-editable (Priority, Epic, Cycle, Points, Labels, Assignee/Owner, Due) lost |
| PMFE:165 | carried | carried (after D14) | dash §2.4.16 | Key hints on the field actions and `✕ Esc` lost |
| PMFE:166 | carried | carried (after D14) | dash §2.4.16 | "Field actions open the same menus as inline editing and apply to all selected cards" not stated |
| PMFE:172 | carried | gap | dash §2.11 (by API `tier`); NEW-dashboard-2 (DB-N2-7) | dash §4 "Integrations grouped by the API's `tier`: not-built" |
| PMFE:174 | carried | carried (after D36) | dash §2.11 | **Sync both (primary)** — which button is primary lost |
| PMFE:181 | carried | deliberate | surface item 22, NEW-surface-1 (justification: one secret-bearing directory the sandbox can deny); PMC §0 (Slack row); dash §2.11 | The path changed on purpose (`~/.config/sekhemet/repos/…` → `~/.sekhemet`); mode 0600 and "never in repo or ledger" kept |
| PMFE:197 | carried | carried (after C3) | PMC §3 (ids), §5 (table) | PMC §5's table has no "What leaves the machine" column; the per-integration data line for Next/Later (card fields, gate results, those messages, the conversation, nothing, those pages) is lost, yet dash §2.11 says Next/Later cards "still state the data they would send" |
| PMFE:201 | carried | carried (after D30) | dash §2.10.2 | x axis (columns Ready → Review, now To do → In review) and "hovering shows the card" lost; the row says "hover weaker" |
| PMFE:202 | carried | carried (after D30) | dash §2.10.2 | "dashed" lines and their value labels (`50% 2.1h`, `85% 6.2h`, `95% 9.8h`) lost |
| PMFE:205 | carried | carried | dash §2.10.6 | Wrong item: chart rules are §2.10 item 6 (item 5 is Review) |
| PMFE:215 | carried | carried | dash §2.10.6 | Wrong item: §2.10.6, not §2.10.5 |
| PMFE:216 | carried | carried | dash §2.10.6 (verbatim) | Not "generic": *Flow metrics aren't on this server yet (`/api/metrics/flow` returned 404).* is verbatim in §2.10.6 |
| PMFE:225 | carried | carried (after D35) | dash §2.11 Playbook | The chip vocabulary (*Kind: Rules*, *Files: …*, *Error: …*, *Applies to: every card*) lost |
| PMFE:231 | carried | carried (after C4) | dash §2.11 Playbook; PMC §6 | Wire shape `{ reach: "global" }` is in no document (PMC §6 approve takes no body); the footer path `~/.config/sekhemet` → `~/.sekhemet` is deliberate (NEW-surface-1) |
| PMFE:235 | carried | carried (after D31) | dash §2.10.3 | The copy *2 retries in the last run used the escalation model (…), not the Worker. They aren't counted in these rates.* and its condition lost |
| PMFE:254 | carried | carried | dash §2.11 Machine (verbatim) | Wrong location: the roster 404 copy is verbatim in §2.11 Machine, not §2.12.3 |
| PMFE:255 | carried | carried (after C2) | design-stage §3 (`PUT /api/integrations/research-web`); dash §2.11 | PMC §3's "canonical" integration ids omit `research-web` |
| PMFE:256 | carried | carried | design-stage §2.7.11 | Wrong location: "design-stage §2.11" does not exist; the provider line is §2.7 item 11 |
| PMFE:258 | carried | carried (after C1) | dash §2.7.4, §3 | PMC §3 `PmMessage.cites` has no `url`/`label`, though dash §3 depends on `cites[].url/label` and PMC is "change this file first" |
| PMFE:263 | carried | deliberate | dash §2.13.2 (P12: `--border-control` at ≥ 3:1 edges every input, because `border-strong` is 1.3–1.9:1 on inputs, dash §5 P12 intro) | "No new colour roles" is contradicted on purpose: v3 adds `--border-control` |
| PMFE:266 | carried | carried | dash §2.7.1, §2.13.7 | Note: the 1024–1279 overlay is 380 px (old §2.4); old §4.2's "360" conflicted with it — say so, as PMFE:65 does |
| PMFE:271 | carried | carried (after D13) | dash §2.13.7, §2.4.15 | Table group header 32 px is in neither place (same loss as PMFE:155) |
| PMFE:279 | carried | carried | dash §2.10.6, §2.14.3 | Wrong item: §2.10.6 |
| PMFE:282 | carried | deliberate (after D47) | dash §2.15.5 | Widths changed 1024 → 1100 and 400 added, with no reason recorded; D47 |
| PMFE:287 | carried | carried | dash §3 (optional fields); PMC §0 (`PmStatus.model` dropped, O3) | Stale note: the thread `model` is dropped on purpose (DEC-29 O3), not "in PM_CONTRACT §3" as a used field |
| PMFE:295 | carried | gap | dash §2.12.1; NEW-dashboard-2 (DB-N2-3…5); ppm P1 (PM-P1-10) | dash §4 "One label map: not-built" (`Checking`/`Working` leak; kind from title suffix); ppm §4 "kind, change, split… not-built" |
| PMFE:296 | carried | gap | dash §2.4.4, §2.5.4; NEW-dashboard-1 (DB-N1-4); gates T1 (GT-T1-11) | dash §4 "no synthesised gate: not-built" |
| PMFE:298 | carried | carried | dash §2.5.6; gates rule 7, GT-3 | Wrong location: "gates §7" is the Later section; it is rule 7 (built, gates §4) |
| PMFE:306 | carried | carried | dash §2.16.1 (Qualify to assign), §2.16.2 (History absorbs the bake-off matrix, `writeBakeOffMatrix`) | Stale location: Registry is now a section of Configuration (O2, O3) |
| PMFE:338 | carried | carried (after D47) | dash §2.1.5 | Example "8 of 32 steps" → "8 of 40 steps" with no reason; D47 |
| PMFE:340 | carried | deliberate (after D47) | dash §2.2.5 | The default route now follows the first-run role; Review-when-non-empty holds only for *I write code*. §9 gives no reason for role-based routing; D47 |
| PMFE:341 | carried | deliberate (after D47) | dash §2.2.5 | As PMFE:340 |
| PMFE:347 | gap | gap | dash §2.16.3–5 (Review capacity, This browser, Project configuration); NEW-dashboard-4 (R18, O2) | Stale location: "dashboard §2.11" — Settings is now three Configuration sections |
| PMFE:348 | carried | carried | dash §2.16 (Registry → Configuration › Benchmark), §2.11 (Workspace); goals dash §7 | Stale location for Registry |
| PMFE:355 | carried | carried (after N1) | NAMING keep list | *Library* (in the old naming list) is in no v3 naming document; add it or record it as dropped |
| PMFE:358 | carried | gap | ppm §2.2.1, §3 (`split` field); P1 (PM-P1-10, PM-P1-11) | ppm §4 "`kind`, `change` and `split` stored as three fields: not-built" |
| PMFE:364 | carried | carried (after D37) | dash §2.12.4 | Two sentences lost: quota's *The model provider's limit was reached.*; error's *See the ledger entry.* |
| PMFE:373 | carried | carried (after D47) | dash §2.12.4 | Example "8 of 32 steps" → "8 of 40 steps"; D47 |
| PMFE:375 | carried | carried (after D33) | dash §2.11 Ledger | Only one sentence pattern kept; *Planner created…* and *Worker finished step 8 on…* lost |
| PMFE:377 | carried | carried (after D37) | dash §2.4.10 | Board-column copy is kept, but Pipeline stages (⇧V) still shows Ready, Planning and Verify, and their copy (*Cards whose dependencies are done.*, *The Planner is writing plans and tests.*, *Nothing being checked.*) is lost |
| PMFE:378 | carried | carried (after D22) | dash §2.5.13 | *Evidence appears after the Worker's first run. Budget: 32 steps.* lost (only "No attempts yet") |
| PMFE:379 | carried | carried (after D37) | dash §2.12.4, §6 | **Couldn't accept.** title and *It's what they'll read next.* (400 on send back) lost |
| PMFE:380 | carried | carried (after D2) | dash §2.2.4 | Read-only copy lost ("one line saying how to enable it") |
| PMFE:383 | carried | carried (after D1) | dash §2.2.4 | Bar styling (`--bg-raised`, 1 px `--state-parked` bottom border) lost; the row says so |
| PMFE:386 | carried | carried (after D3) | dash §2.2.4 | Copy shortened: *…safely **before the system would swap**.* lost |
| PMFE:398 | carried | carried (after D19) | dash §2.5.9 | `--bg-surface` and the 1 px top hairline lost |
| PMFE:399 | carried | carried (after D19) | dash §2.5.9 | The gate reason copy *Accept needs every gate passing.* lost |
| PMFE:404 | carried | carried (after D20) | dash §2.5.11 | Caption *Your note becomes a candidate rule in Playbook.* lost |
| PMFE:405 | carried | carried (after D21) | dash §2.5.12 | "`↩` confirms" lost |
| PMFE:408 | carried | carried (after D22) | dash §2.5.13 | Counts lost: 4 gate boxes, 3 diff-line skeletons |
| PMFE:411 | carried | carried (after D15) | dash §2.5.1, §2.15.3 | Phone evidence content (gates strip, failures, *Changes* file list, tap a file for its diff) lost |
| PMFE:413 | carried | carried | dash §2.4.2 | Stale note: "16 px board padding" is now in §2.4.2; delete "(padding 16 lost)" |
| PMFE:415 | carried | deliberate (after D6) | dash §2.4.1 (On hold only when non-empty, pinned; *Won't do* a filter, not a column); NAMING (*Closed* retired, with the reason) | Audit #41; amber count restored or reasoned by D6 |
| PMFE:416 | carried | carried (after D8) | dash §2.4.2, §2.4.9 | Threshold lost: "once more than six columns hold cards" |
| PMFE:419 | carried | carried (after D4) | dash §2.3 | Audit #42: row-index clamp lost |
| PMFE:423 | carried | carried (after D4) | dash §2.3 | Audit #44: "a mouse click selects" lost |
| PMFE:435 | carried | carried (after D32) | dash §2.11 Runs | Audit #45: 240 px and the time column lost |
| PMFE:441 | carried | deliberate (after D47) | dash §2.2.1 (Runs hidden until the first completed run) | "Superseded" is a deliberate change; no reason recorded for dropping the empty state and its `sekhemet queue --auto-accept` |
| PMFE:442 | carried | carried (after D32) | dash §2.11 Runs | Copy *Running · 2 of 6 cards · 4m* lost; the row says so |
| PMFE:443 | carried | carried (after D33) | dash §2.11 Ledger | "8 chars" and type in `--text-secondary` lost |
| PMFE:444 | carried | carried (after D33) | dash §2.11 Ledger | Integrity header's verified time and the first bad row's red left rule lost |
| PMFE:447 | carried | carried (after D34) | dash §2.11 Machine | Worktrees "count and the list of card ids" and the fix-hint example lost |
| PMFE:453 | carried | deliberate (after D47) | dash §2.11 Playbook (learning view) | The FE rules table (instruction, trigger gate, teaching card, since, pattern) is replaced on purpose; no reason recorded |
| PMFE:454 | carried | deliberate (after D47) | dash §2.11 Playbook (*Needs your approval*: Approve, Edit, Retire) | Promote-with-trigger-gate and Dismiss replaced; no reason recorded |
| PMFE:455 | carried | deliberate (after D47) | dash §2.2.1 (Playbook hidden until the first rule or suggestion) | Empty copy dropped on purpose; no reason recorded |
| PMFE:460 | carried | carried (after D9, D39) | dash §2.4.4 | Tile title weight 500 lost (§2.13.4 "body and tile titles 13"; 13/500 appears only for the queue row) |
| PMFE:465 | carried | carried (after D38) | dash §2.4.4, §2.13.3 | The running tile's 2 px left rule: rule width is stated nowhere for tiles |
| PMFE:466 | carried | carried (after D7, D38) | dash §2.4.1, §2.13.3 | Status copy *Running Tests…* (names the running gate) became *Checking gates…* with no reason; the 2 px fail left rule is not stated |
| PMFE:468 | carried | carried (after D9) | dash §2.4.4 | Glyph on state fill (`--on-state`), 1.5 px glyph, not-run 1 px `--border-strong` outline lost ("per gate the evidence ran" is a deliberate change under NEW-dashboard-1, fine) |
| PMFE:470 | carried | deliberate | dash §2.4.4 (blocker flag); dash §9 ("the tile shows … a dependency count is replaced by the professional anatomy"; R11 blocker flag) | "Replaced" is a deliberate change with its reason in dash §9 |
| PMFE:472 | carried | carried (after D9) | dash §2.4.4 | Tile focus ring "offset −1" lost (§2.14.5's global offset is +1 px) |
| PMFE:474 | carried | carried (after D16) | dash §2.5.4 | "separated by 1 px hairlines, on `--bg-surface`" and "2 px" top rule lost |
| PMFE:475 | carried | carried (after D16) | dash §2.5.4 | Popover max 420 px lost; the row says so |
| PMFE:477 | carried | carried (after D16) | dash §2.5.4 | Empty-contract tooltip copy lost; also §2.5.4 still defines the empty contract as "the empty-string hash", which GT-T1-10 retires |
| PMFE:478 | carried | carried (after D17) | dash §2.5.5 | Protected-file warning copy shortened; "expand to see each line" lost |
| PMFE:479 | carried | carried (after D18) | dash §2.5.6 | The condition "when the file is identical to `acceptance/<name>`" lost |
| PMFE:480 | carried | carried (after D18) | dash §2.5.6 | 40 px gutters, hunk headers (`--text-secondary` on `--bg-raised`) and the header chevron lost |
| PMFE:483 | carried | carried (after D42) | dash §2.13.7 | Ghost text colour `--text-secondary` lost |
| PMFE:486 | carried | carried (after D23) | dash §2.5.14 | Option-row type (label 13/500, consequence 13 secondary, effort/risk 11 px) and Preview "in mono" lost |
| PMFE:488 | carried | carried (after D34) | dash §2.11, §2.13.7 | Check-row sizes (16 px icon, 13/500 name, 12.5 secondary detail) and sparkline stroke/last-point dot lost |
| PMFE:489 | carried | carried (after D44) | dash §2.15.4 | Surface (`--bg-raised`, 1 px `--border-strong`, no shadow, `--scrim`), group contents and highlight colours lost |
| PMFE:490 | carried | carried (after D42) | dash §2.13.7 | "stacking upward" and "state icon" lost |
| PMFE:491 | carried | carried (after D42) | dash §2.3.3 | Cheat sheet width 720 px lost |
| PMFE:499 | carried | deliberate (after RT1) | runtime RUN-4, §3 | Response changed from `{ attemptId }` to a log path with no recorded reason |
| PMFE:502 | carried | carried | dash §2.13.1; tokens.ts | Note: `--rail-w` is retired on purpose (dash §2.2.2; §9 "A 176 px labelled sidebar replaces the 52 px icon rail") — say so instead of "tokens.ts defines every one" |
| PMFE:504 | carried | carried (after D39) | dash §2.13.4 | Wordmark tracking −0.01em, tile title 500, mono ids 11 secondary and the `kbd` style lost; the row says two of these |
| PMFE:505 | carried | carried (after D8) | dash §2.13.7, §2.4.2 | Tile gap 8 px (between tiles in a column) lost |
| PMFE:508 | carried | carried (after D38) | dash §2.13.3 | "Rule (2px left or top)" width lost |
| PMFE:509 | carried | carried (after D40) | dash §2.13.5, §6 | Palette open, the 8 px translate, toast-stack shifts and "drawers switch instantly" lost |
| PMFE:512 | carried | carried (after D41) | dash §2.13.6 | Favicon 32 px, glyph 18 px with the wordmark 8 px right of it, wordmark tracking lost |
| PMFE:514 | carried | carried (after D43) | dash §2.14.3–4 | Column `group` labelled by its header, tile `option` + `aria-describedby`, and "focused **or selected** card; background churn not announced" lost |
| PMFE:515 | gap | gap (after D46) | dash §2.14.5; P12 (DB-P12-6) | DB-P12-6 tests only the 24×24 desktop target; 44×44 on a phone and 200% zoom have no EARS criterion |
| PMFE:517 | carried | deliberate (after D47) | dash §2.15.5 | Viewports changed (1024×768 → 1100×800, 375×812 → 400×812) with no reason; D47 |
| PMFE:523 | carried | gap | dash §2.4.4; gates rule 35, T1 (GT-T1-11); NEW-dashboard-1 (DB-N1-4) | The page-side "no synthetic parse" is not built (dash §4) |
| PMFE:527 | carried | carried (after D10) | dash §2.3, §2.4.6, §2.15.4 | "Peek `Esc` returns focus to the tile" lost |
| PMFE:542 | carried | gap | ppm §2.2.1 (`split` field); P1 (PM-P1-11) | As PMFE:358 |
| PMFE:544 | carried | carried | gates rule 7, GT-3 | Wrong location: "gates §7" → rule 7 |

## Spec restorations

Old text is quoted from `fb59ba2`. "Add" means insert into the named item; "replace" gives the new wording. Where the old text used retired names (*Working*, *Checking*, *Parked*, *Closed*, `assignee`), the restoration uses NAMING's names; everything else is verbatim or near-verbatim.

### docs/design/specs/dashboard.md

**§2.2.4 Shell bars (table)**
- **D1** (PMFE:383) Offline row, Treatment — replace with: "A full-width 32 px bar under the topbar in `--bg-raised` with a 1 px `--state-parked` bottom border: **Offline since 14:42:30.** *Showing the last known state. Actions are disabled.* `Retry`. Every triage button is disabled with the reason *Offline* beside it; timestamps freeze (they don't count up)." (Old FE:265 said "with the tooltip *Offline*"; §2.14.2 forbids hover-only reasons, hence "beside it".)
- **D2** (PMFE:380) Read-only row, Treatment — replace with: "Triage replaced by one line: **Read-only.** *This server was started without triage. Restart with `sekhemet serve` to accept or send back.* `a/r/p` show the same line as a toast." (FE:254, FE:266.)
- **D3** (PMFE:386) Memory pause row — replace the sentence with: "**Paused for memory: 94% used.** *Sekhemet stopped the Worker safely before the system would swap. Work resumes below 85%.*" (FE:268.)

**§2.3 Keyboard (table)**
- **D4** (PMFE:419, PMFE:423) Board row — replace "`h/l` columns, `j/k` cards (cross lane boundaries; `h/l` stay in the lane)" with "`h/l` columns, keeping the row index, clamped to the target column's length; `j/k` cards (cross lane boundaries; `h/l` stay in the lane)", and add after the peek entry: "a mouse click selects a tile; `Space` (or double-click) peeks". (FE:378, FE:382.)
- **D5** (PMFE:83) Composer row — replace "`Esc` back to the page" with "`Esc` returns focus to the page without closing the panel". (PM:197.)

**§2.4.1 Columns and §2.4.3 Column header**
- **D6** (PMFE:415) Either add to §2.4.3: "On hold, when it holds cards, sits far right and shows its count in the parked tone (`--state-parked`)." (FE:369 "placed far right with an amber count") — or add to §9: "*Closed* is no longer a column (*Won't do* is a filter, NAMING) and On hold's count is no longer amber: <reason>". Then re-mark the row `deliberate` with Now-in "dash §2.4.1 (On hold only when non-empty, pinned; Won't do a filter); NAMING (*Closed* retired)".
- **D7** (PMFE:466) §2.4.1 In progress badges — replace *Checking gates…* with "*Running Tests…* (naming the gate that is running)", as FE:520 had it; or record in §9 why the gate's name was dropped.

**§2.4.2 Columns**
- **D8** (PMFE:416, PMFE:505) Replace "(`min 200px`, `max 300px`, 8 px gap; 8 px body padding, 16 px board padding)" with "(`min 200px`, `max 300px`, 8 px between columns and 8 px between tiles; 8 px body padding, 16 px board padding)", and add after the pinning sentence: "Once more than six columns hold cards (as in Pipeline stages), the columns beyond the viewport are windowed horizontally; In review and On hold stay pinned, because the person's queue is never the part that gets scrolled away." (FE:370, FE:718.)

**§2.4.4 Tile anatomy**
- **D9** (PMFE:128, 130, 460, 468, 472)
  - Heading — replace "(88 px compact; 112 px comfortable …)" with "(88 px compact; 112 px comfortable …; the heights are fixed because the board's windowing depends on them)". (PM:307.)
  - Diagram row 2 comment — "row 2: title 13/500, 2-line clamp". (FE:505.)
  - Labels — "**Labels**: 11 px secondary text in a 1 px `--border-subtle` outline". (PM:305.)
  - Gate pips — add: "each glyph is a 1.5 px line in `--on-state` on the state fill for passed and failed; *not run* is a 1 px `--border-strong` outline". (FE:526; `--bg-base` there is now `--on-state`.)
  - Tile states — replace "focus a 2 px accent ring" with "focus a 2 px accent ring, offset −1 px (inside the tile)". (FE:532.) If the global +1 px of §2.14.5 is meant to govern tiles too, say so in §9 instead.

**§2.4.6 Peek drawer**
- **D10** (PMFE:527) Add: "`Esc` closes the drawer and returns focus to the tile." (FE:852.)

**§2.4.11 View bar**
- **D11** (PMFE:131, 133, 134) Replace "**View bar** (40 px, 16 px padding, 8 px gaps)" with "**View bar** (40 px under the topbar, on `--bg-base` with a hairline; 16 px padding, 8 px gaps)"; replace "**View** menu (*All cards*, …" with "**View** menu (*All cards*, the default, …"; replace "filter chips" with "filter chips (click one to edit it, `✕` to remove it)". (PM:311, PM:318, PM:319.)

**§2.4.14 Swimlanes**
- **D12** (PMFE:147) Replace "by Epic (with its progress bar)" with "by Epic (with its progress bar, `done / total` cards)". (PM:351.)

**§2.4.15 List view**
- **D13** (PMFE:152, 153, 155, 157, 271)
  - Add at the start: "It uses the same filter, grouping and selection as the board." (PM:360.)
  - Columns — "a leading selection checkbox · Priority · Key · …". (PM:362.)
  - Replace "group headers with count and points" with "group headers (32 px) with count and points". (PM:367; also add "list group header 32 px" to §2.13.7's size list, PM:600.)
  - Replace "inline edits by click or key with an anchored menu" with "inline edits — click a Priority, Epic, Cycle, Points, Labels, Owner, Delegate or Due cell, or press its key on the focused row — with a menu anchored to the cell". (PM:369–370.)

**§2.4.16 Bulk bar**
- **D14** (PMFE:165, 166) Replace "with the selection's count and points: the field actions, **Park** …, **Ask Seshat** …" with "with the selection's count and points (*3 selected · 8 pts*), the field actions with their keys (*Priority ⇧P · Points ⇧E · Cycle ⇧C · Labels ⇧L · Owner ⇧A*) — the same menus as inline editing, applied to every selected card —, **Park** (one reason, one park per card), **Ask Seshat** (the selection as mentions, not sent) and `✕ Esc`". (PM:382, PM:385.)

**§2.5.1 Review layout**
- **D15** (PMFE:411) Replace "on a phone the queue is a full screen and evidence opens with a fixed bottom bar of three 48 px buttons" with "on a phone the queue is a full screen; tapping a row opens evidence — the gates strip, failures and a *Changes* file list (tap a file for its diff) — with a fixed bottom bar of three 48 px buttons". (FE:359.)

**§2.5.4 Gates strip**
- **D16** (PMFE:474, 475, 477)
  - Replace "a segment per gate the evidence ran (32 px, 0 12 px padding) — icon, name, duration —" with "a segment per gate the evidence ran (32 px, 0 12 px padding, separated by 1 px hairlines, on `--bg-surface`) — icon, name, duration —", and "failed segments get a red top rule and a count" with "failed segments get a 2 px `--state-fail` top rule and a count". (FE:544.)
  - Replace "Focus or hover shows gate id and command …" with "Focus or hover shows a popover (at most 420 px wide) with the gate id and command …". (FE:546.)
  - Empty contract: the old tooltip was *gates.toml hashed to the empty string. These results were not verified against a contract.* (FE:549). Because GT-T1-10 retires the empty-string hash ("no `gates.toml`", `empty: true`), replace "An empty gate contract (the empty-string hash) adds an amber **Gate contract empty** segment" with "An empty gate contract (no `gates.toml`: `/api/gates` returns `empty: true`, GT-T1-10) adds an amber **Gate contract empty** segment whose popover reads *No gates.toml: these results were not verified against a contract.*" — and make §2.5.8 Provenance's "the empty warning" match.

**§2.5.5 Failure block**
- **D17** (PMFE:478) Replace "a warning when the suggested file is a protected test (*the fix belongs in the implementation*)" with "a warning when the suggested file is a protected test (*The suggested file is a protected test. The fix belongs in the implementation.*)", and "Identical messages group (*3 × TS2353 in tests/hasher.spec.ts*)" with "… (*3 × TS2353 in tests/hasher.spec.ts*), expanding to show each line". (FE:560–561.)

**§2.5.6 Diff viewer**
- **D18** (PMFE:479, 480)
  - Replace "*staged by Sekhemet · not written by the Worker*" with "*staged by Sekhemet · not written by the Worker* (shown when the file is identical to its staged copy, `acceptance/<name>`)". (FE:565.)
  - Replace "sticky 32 px file headers with path, role, `+18 −0` and Copy path; old/new gutters" with "sticky 32 px file headers with a chevron, path, role, `+18 −0` and Copy path; old and new gutters (tabular, 40 px each, `--text-muted` as decoration); hunk headers in `--text-secondary` on `--bg-raised`". (FE:566–570.)

**§2.5.9 Triage bar**
- **D19** (PMFE:398, 399) Replace "**Triage bar** (52 px, 0 24 px padding, 8 px button gap, sticky under the evidence)" with "**Triage bar** (52 px, 0 24 px padding, 8 px button gap, `--bg-surface` with a 1 px top hairline, sticky under the evidence)", and the reason example with "(*Accept needs every gate passing.*; *2 findings to acknowledge · 1 file not yet shown*)". (FE:322, FE:324.)

**§2.5.11 Send back**
- **D20** (PMFE:404) Replace "*Suggest as a playbook rule* (on)" with "*Suggest as a playbook rule* (on), captioned *Your note becomes a candidate rule in Playbook.*" (FE:336). Because planner-pm §2.13.2 now admits only actionable notes, the honest v3 caption is: *Your note becomes a candidate rule in Playbook when it names a file, symbol, gate or error.*

**§2.5.12 Park**
- **D21** (PMFE:405) Append: "`↵` confirms." (FE:339.)

**§2.5.13 States**
- **D22** (PMFE:378, 408) Replace "loading (gates and diff skeletons, queue interactive)" with "loading (a gates-strip skeleton of 4 boxes and 3 diff-line skeletons; the queue stays interactive)" (FE:352), and "no evidence (*No attempts yet*, only Park)" with "no evidence (**No attempts yet.** *Evidence appears after the Worker's first run. Budget: 40 steps.* — the card's own step budget —; triage shows only Park)" (FE:249, FE:354).

**§2.5.14 Decision request**
- **D23** (PMFE:486) Replace "radio options, each with consequence, *Effort +6 steps / ~7k tokens*, *Risk: …* and a *Preview* disclosure (files, symbols, blast radius)" with "radio options, each with its label (13/500), consequence (13, secondary), *Effort +6 steps / ~7k tokens* and *Risk: …* in 11 px, and a *Preview* disclosure in mono (files, symbols, blast radius)". (FE:593.)

**§2.7.3 Messages**
- **D24** (PMFE:70, 71) Replace "Seshat's full-width prose under a one-line header" with "Seshat's full-width prose, with no bubble, under a one-line header (avatar, *Seshat*, time)" (PM:182), and "system lines centred at 11 px" with "system lines (*Seshat was restarted; the thread continues.*) as one centred 11 px secondary line" (PM:183).

**§2.7.4 Card chips**
- **D25** (PMFE:78) Replace "`@` in the composer opens a fuzzy card picker" with "`@` in the composer opens a card picker that fuzzy-matches titles and keys; `↵` inserts the chip". (PM:190.)

**§2.7.6 Composer**
- **D26** (PMFE:85, 88) Replace "A **cost line** in plain words says what sending does" with "A **cost line** under the composer, in 11 px secondary, says in plain words what sending does" (PM:199), and "read-only: how to enable" with "read-only: how to enable it, and the composer is disabled" (PM:202).

**§2.7.7 Proposal group**
- **D27** (PMFE:97, 98) Replace "park shows the reason" with "park and unpark show the reason" (PM:227), and the Stale state with "*Stale* (the diff with an amber rule and *@hasher changed after Seshat proposed this. Ask again for a fresh proposal.*; Apply disabled, the reason stated inline)" (PM:232).

**§2.7.8 Waiting (table and after it)**
- **D28** (PMFE:107, 109, 119)
  - `loading_pm` Detail — "A 2 px lapis bar toward the ETA (`etaSeconds`); past it the bar stops and the row reads *Taking longer than usual.*" (PM:257.)
  - `resuming_worker` Detail — "*Reloading the Worker; step 6 starts next.* The reply is usually already shown above this row." (PM:259.)
  - Last sentence — replace "Offline freezes timers and disables the composer." with "Offline freezes timers and disables the composer with *Offline. Your message would not reach Seshat.*" (PM:273; audit #29.) Then delete "copy lost" from PMFE:119.

**§2.7.9 Surface states**
- **D29** (PMFE:120, 123) Replace "*Seshat isn't on this server yet* (thread endpoint 404; …)" with "**Seshat isn't on this server yet.** with the details line *This Sekhemet server has no project-manager endpoints (`GET /api/pm/thread` returned 404). Update Sekhemet and restart `sekhemet serve`.* (composer disabled with the reason; the nav item stays)" (PM:279), and "thread error with Retry" with "thread error (a 5xx): **Couldn't load the conversation.** *The server returned 500.* `Retry`" (PM:282).

**§2.10.2 Four charts**
- **D30** (PMFE:201, 202) Aging WIP — replace "one dot per unfinished card by column and age" with "the columns To do → In review on the x axis and age on y, one dot per unfinished card", and "click peeks" with "hovering or focusing a dot names the card, and clicking peeks it" (PM:454–456). Cycle time — replace "scatter with 50/85/95% lines" with "scatter with dashed 50/85/95% lines labelled with their values (`50% 2.1h`, `85% 6.2h`, `95% 9.8h`)" (PM:458).

**§2.10.3 Worker capability**
- **D31** (PMFE:235) Replace "retries run on an escalation model and person-built attempts are excluded and said so" with "retries run on an escalation model and person-built attempts are excluded and said so — *2 retries in the last run used the escalation model (…), not the Worker. They aren't counted in these rates.* — shown when a queue entry records that a retry ran on the escalation model (`escalated`, or a per-entry `model` that differs from the report's)". (PM:512.)

**§2.11 Runs**
- **D32** (PMFE:435, 442) Replace "a list of runs (date, model, *3 of 6 first try*, duration)" with "a 240 px list of runs (date, time, model, *3 of 6 first try*, duration)" (FE:443; audit #45), and "A run in progress grows live." with "A run in progress reads *Running · 2 of 6 cards · 4m* in its row, and the timeline grows live." (FE:460.) If the owner prefers a fluid list, re-mark PMFE:435 `deliberate` with that reason instead.

**§2.11 Ledger**
- **D33** (PMFE:375, 443, 444) Replace "one sentence per event (*Worker moved **…** from In progress to Verify*), seq, time, actor, type and short hash in mono" with "one sentence per event (*Planner created* **…**; *Worker moved* **…** *from In progress to Verify*; *Worker finished step 8 on* **…**), seq (tabular), time, actor, type (mono, `--text-secondary`) and the hash's first 8 characters in mono"; replace "the header states integrity; a broken chain marks the first bad row" with "the header states integrity and when it was verified (*Ledger intact · 13 entries · verified 14:48:02*); a broken chain gives the first bad row a red left rule, and the header explains it". (FE:244–246, FE:464, FE:468–469.)

**§2.11 Machine**
- **D34** (PMFE:447, 488) Replace "health checks with plain fix hints; sandbox mode; worktrees" with "health checks, each a row with a 16 px icon, name (13/500), detail (12.5, secondary) and a plain fix hint (*No skills folder. Create `.sekhemet/skills/` to load skills.*); sandbox mode; worktrees (their count and card ids)" (FE:477–479, FE:606), and "**telemetry sparklines** (120×24)" with "**telemetry sparklines** (120×24, a 1.5 px `--text-secondary` stroke with the last point as a state-coloured dot)" (FE:607).

**§2.11 Playbook**
- **D35** (PMFE:225) Replace "scope chips" with "scope chips (*Kind: Rules*, *Files: `src/**/hash*.ts`*, *Error: `TS2353`*, or *Applies to: every card*)". (PM:497.)

**§2.11 Integrations (table, GitHub row)**
- **D36** (PMFE:174) Replace "**Pull**, **Push**, **Sync both**" with "**Pull**, **Push**, **Sync both** (primary)". (PM:398.)

**§2.12.4 Label source, and §2.4.10 Board states**
- **D37** (PMFE:364, 377, 379)
  - Stop reasons — replace "Paused for quota · parked" with "Paused for quota · *The model provider's limit was reached.* · parked", and "Harness error · *Sekhemet failed, not the Worker.* · fail" with "Harness error · *Sekhemet failed, not the Worker. See the ledger entry.* · fail". (FE:209–210.)
  - Errors — replace "a refused accept quotes the server (*Card is in Verify, not Review.*)" with "a refused accept is titled **Couldn't accept.** and quotes the server (*Card is in Verify, not Review.*); an empty send-back note is blocked client-side with *Add a note for the Worker. It's what they'll read next.*" (FE:251–252), and align §6 DB-2's copy to the same two sentences.
  - §2.4.10 — append: "In Pipeline stages the machine columns keep their own empty copy: Ready *Cards whose dependencies are done.* · Planning *The Planner is writing plans and tests.* · Verify *Nothing being checked.*" (FE:248, retired names replaced.)

**§2.13.3 Colour per tone**
- **D38** (PMFE:465, 466, 508) Prepend: "A rule is 2 px — on the left of a tile, row or block, or on top of a gates segment. The running, failed-and-retrying and On hold tiles carry one in their tone." (FE:519, 521, 523, 769.)

**§2.13.4 Type**
- **D39** (PMFE:460, 504) Replace the usage sentence with: "wordmark 15/600, tracking −0.01em; view titles 15/600; card title in Review and the card view 18/600; scorecard numbers 22/600; section headings 12.5/600; body 13/400 and tile titles 13/500; meta, status lines and column counts 11 secondary; mono ids, hashes and event types 11 mono secondary; code 12.5 mono; `kbd` 11 mono in a 1 px `--border-subtle` outline, 3 px radius, 0 4 px padding, secondary; diff line numbers 11 mono in `--text-muted`." (FE:700–710.)

**§2.13.5 Spacing, radius, motion**
- **D40** (PMFE:509) Replace the motion clause with: "**motion** 120 ms ease-out, only for hover, press, focus, drawer and palette open (opacity plus an 8 px translate) and popovers; board reflow, streaming, patches and toast-stack shifts append with no animation; the running dot's pulse (1 → 0.35 opacity, 1.6 s) is the only perpetual animation; `prefers-reduced-motion` removes it and all translates, and drawers switch instantly." (FE:780–783.)

**§2.13.6 Brand**
- **D41** (PMFE:512) Replace "wordmark *Sekhemet* in Inter 600; favicon the glyph on a 6 px rounded `bg-base` square" with "the glyph drawn in a 1.5 px line in accent; wordmark *Sekhemet* in Inter 600, tracking −0.01em, `--text-primary`, 8 px right of an 18 px glyph; favicon the glyph at 32 px on a 6 px rounded `bg-base` square". (FE:793–796.)

**§2.13.7 Component sizes**
- **D42** (PMFE:483, 490, 491) Replace "ghost with no fill" with "ghost with no fill and `--text-secondary` text" (FE:584); replace "toasts 360 px, bottom-left 16 px from the edges, … an icon, one line and an action, at most 3" with "toasts 360 px, bottom-left 16 px from the edges, stacking upward, … a state icon, one line and an action, at most 3" (FE:621–622); add "cheat sheet a 720 px modal" (FE:629).

**§2.14.3 Accessibility**
- **D43** (PMFE:514) Replace "the board a roving-tabindex listbox per column with `aria-selected` and the status line as description" with "each board column a `group` labelled by its header, holding a vertical `listbox` of `option` tiles with roving tabindex, `aria-selected` and `aria-describedby` pointing at the status line"; replace "one polite live region for the focused card and triage results" with "one polite live region for the focused or selected card and triage results; background changes are not announced". (FE:808, FE:812.)

**§2.15.4 Palette**
- **D44** (PMFE:489) Replace "**Palette.** 600 px at 12vh; a 48 px, 15 px input; groups *Actions on the focused card*, *Cards*, *Go to* (with chords), *Preferences* (theme, density, Learn); fuzzy matches highlighted" with "**Palette.** 600 px at 12vh, `--bg-raised` with a 1 px `--border-strong` edge and no shadow, over `--scrim`; a 48 px, 15 px input; groups *Actions on the focused card* (Accept, Send back, Park, Open, Copy id), *Cards* (title, kind, state icon), *Go to* (with chords), *Preferences* (theme, density, Learn); matched characters in `--text-primary` against the rest in `--text-secondary`". (FE:611–614.)

**§4 State today**
- **D45** (PMFE:8) Add a row: "Column-header points sum (§2.4.3) | not-built | no points in the column header (`board.js`) | P3". (Wait-time sort and keyed tile patching are built — `board.js:81-82`, `board.js:213` — so PMFE:418 and PMFE:424 stay `carried`; a §4 row saying so would stop the next trace from guessing.)

**§5 P12**
- **D46** (PMFE:515) Extend DB-P12-6: "…no target under 24×24 px on desktop **or under 44×44 px at 400 px**, **no layout that breaks at 200% zoom**, and no information available only on hover."

**§9 Evidence and rationale ("Resolved drift and deliberate reversals")**
- **D47** add these bullets (each: what changed, why):
  - (PMFE:86, 116, 338, 373; with P2 for PMFE:57) "Copy examples use a 40-step budget (*8 of 40 steps*, *step 5 of 40*), not the old mockups' 32 — 40 is the one step cap the planner enforces (`INVEST_MAX_STEPS`, [planner-pm §2.4](../../design/specs/planner-pm.md)), so an example never shows a budget no card can have."
  - (PMFE:282, 517) "The verification widths are 1440×900, 1100×800 and 400×812, not 1024×768 and 375×812 — 1100 sits inside the 1024–1279 band whose labelled sidebar is new (§2.2.2), and 400 is the width at which Status must work for a non-developer (§2.8.8)."
  - (PMFE:340, 341) "The default route follows the first-run role (§2.2.5) rather than always being Review-or-Board — a non-developer's home is Status, and a beginner's is the Board with Learn on; *I write code* keeps the old rule."
  - (PMFE:441, 455) "Runs and Playbook have no empty state: each is hidden until it has content (§2.2.1), so their old empty copy (with `sekhemet queue --auto-accept`) is gone — a hidden view is never a dead link, and no path ends in a terminal."
  - (PMFE:453, 454) "The old Playbook table (instruction, trigger gate, teaching card, since, pattern) and its *Promote* / *Dismiss* of suggested rules are replaced by the learning view (§2.11) — rules are approved, scoped and credited from the learning store ([DEC-28](../../design/DECISIONS.md#dec-28--one-rule-for-admitting-what-the-system-learns)), not promoted from a candidates file with one trigger gate."
  - (PMFE:415, if D6 is not restored) "On hold's count is no longer amber: <reason>."

### docs/design/specs/planner-pm.md

- **P1** (PMFE:56) §2.8.2 — replace "no flattery, exclamation marks, emoji or sign-off" with "no flattery or filler (no "Great question"), no exclamation marks, emoji or sign-off". (PM:76.)
- **P2** (PMFE:57) §9 — extend "The sample exchanges of §2.8.17 are carried from PM_DESIGN §2.3 (git `fb59ba2`), shortened." with ", and their step budget is 40 (`INVEST_MAX_STEPS`, §2.4), not the old 32".

### docs/design/PM_CONTRACT.md

- **C1** (PMFE:258) §3 `PmMessage` — replace `cites?: { cardId?: string; runId?: string; evidenceId?: string }[];` with `cites?: { cardId?: string; runId?: string; evidenceId?: string; url?: string; label?: string }[];   // url + label: a research source, rendered in the Sources list (http/https only)`. (PM:544.)
- **C2** (PMFE:255) §3 Integrations — add `research-web` to the "now" ids, and add the line: "`PUT /api/integrations/research-web` with `{ enabled }` returns the entry; the server's `detail` names the search provider or says how to configure one ([design-stage](../../design/specs/design-stage.md) §3)." (PM:543.)
- **C3** (PMFE:197) §5 roadmap table — add a column **What leaves the machine**: GitHub Issues + Projects: *Card fields, to the chosen repository*; GitHub PR on accept: *Branch, diff, gate results*; Jira and Linear import/export: *Nothing (you upload the file)*; Slack for the PM: *Those messages*; Jira / Linear live sync: *Card fields*; GitHub Actions gate mirror: *Gate results*; Microsoft Teams: *Those messages*; Slack replies: *The conversation*; Sentry / Datadog / PagerDuty: *Nothing (data comes in)*; Notion / Confluence: *Those pages*. (PM:426–438.)
- **C4** (PMFE:231) §6 Endpoints — replace "`POST /api/learning/rules/:id/(approve|retire)`" with "`POST /api/learning/rules/:id/approve` with `{ reach?: "project" | "global" }` (default `project`; `global` stores the rule in the user directory), `POST /api/learning/rules/:id/retire`". (PM:503.)

### docs/design/NAMING.md

- **N1** (PMFE:355) Keep list — either add *Library* with its meaning (the old naming list, FE:167: "Workspace, Project, Card, Subtask, Gates, Evidence, Playbook, Worker, Planner, Library"), or add one line under the keep list: "*Library* (the 2026-09-17 naming list) is not used by any v3 surface and is retired."

### docs/design/specs/runtime.md

- **RT1** (PMFE:499) The old contract was `POST /api/cards/:id/run` → `{ attemptId }` (FE:664); RUN-4 returns a log path. Either add `attemptId` to RUN-4's response ("…write its output to a log file, and return `{ attemptId, log }`"), which makes the row `carried` again, or add to runtime §9: "`cards/:id/run` returns the log path, not an attempt id — <reason>", and re-mark the row `deliberate`.

## Totals

- **Rows checked:** 497 (485 `carried`, 12 `gap`).
- **Rows corrected:** 129 (26%).
  - **Status changes: 23.** `carried` → `gap`: 10 (PMFE:6, 7, 8, 34, 172, 295, 296, 358, 523, 542). `carried` → `deliberate`: 13 (PMFE:181, 263, 282, 340, 341, 415, 441, 453, 454, 455, 470, 499, 517); 10 of them need a reason written first (D6, D47, RT1), and 3 already have one (PMFE:181, 263, 470).
  - **Lost precision: 89.** Each stays `carried` (or `gap`, for PMFE:515, whose EARS criterion lacks the 44×44 and 200% zoom checks) once its restoration lands. Five of them (PMFE:57, 86, 116, 338, 373) lost nothing but an example number changed from 32 to 40 with no reason.
  - **Location or note only (status right): 17** (PMFE:53, 100, 205, 215, 216, 254, 256, 266, 279, 287, 298, 306, 347, 348, 413, 502, 544).
- **Restorations needed:** 55. dashboard.md 47 (D1–D47; D47 bundles six §9 reasons), planner-pm.md 2 (P1, P2), PM_CONTRACT.md 4 (C1–C4), NAMING.md 1 (N1), runtime.md 1 (RT1).
- **Rows found correct:** 368. Ten of the 12 `gap` rows are correct as they stand: each has a change ID and matching EARS criteria. The other two are PMFE:347 (stale location) and PMFE:515 (incomplete EARS).
- **Build state was checked in code for five rows,** so they were not moved to `gap` on a guess: PMFE:418 (wait sort, `board.js:81-82`), PMFE:424 (keyed patching, `board.js:213`), PMFE:518 (humanised fallback, `vocabulary.ts:311`), and PMFE:86 and 88 (cost lines, `pm_thread.js:238, 246`).
