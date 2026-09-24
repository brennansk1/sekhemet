# Audit of the design trace (`DESIGN_TRACE.md`)

*Independent audit, 2026-09-24, by an auditor who wrote none of the trace or the specs. It checks a random sample of rows in [DESIGN_TRACE.md](../DESIGN_TRACE.md) §5. For each row it reads the old text at the source line (the old files at `fb59ba2`) and the new text where the row says the item now lives. Nothing else was edited.*

**Snapshot.** The working tree on top of `20dc4eb`. Other sessions were editing the design while this audit ran: 24 files were modified in the tree, and eight rows of DESIGN_TRACE §5 changed between the start and the end of the audit (HD1:5, HD1:158, HD1:200, HD2:278, HD2:428, PMFE:217, INV:E13, INV:H25). None of those eight is in the sample. The spec evidence for every error below was checked again at the end of the audit.

## 1. Sampling method

- **Population.** Every row of the tables in DESIGN_TRACE §5, parsed by section: 5.1 `HARNESS_DESIGN.md` (HD), 5.2 `INTEGRATION_REVIEW.md` (IR), 5.3 `PM_DESIGN.md` (PM), 5.4 `FRONTEND_DESIGN.md` (FE) and 5.5 the three `FEATURE_INVENTORY` files (INV). That gives 2,148 rows. The counts by final status and source match the trace's §1 totals table: carried 1,663, gap 188, deliberate 166, later 131.
- **Strata.** The final status comes first, then the source. The allocation is fixed in advance so that every status meets its floor and every source appears in each status that has rows from it. `PM_DESIGN.md` has no `gap` rows, and `INTEGRATION_REVIEW.md` has only 3 `deliberate` rows and 1 `later` row, so both of those are taken whole.

| Final status | HD | IR | PM | FE | INV | Total |
| --- | --- | --- | --- | --- | --- | --- |
| carried | 16 | 8 | 13 | 13 | 14 | **64** |
| gap | 5 | 5 | — (0 exist) | 5 | 5 | **20** |
| deliberate | 5 | 3 (all) | 4 | 4 | 4 | **20** |
| later | 6 | 1 (all) | 4 | 4 | 5 | **20** |
| **Total** | 32 | 17 | 21 | 26 | 28 | **124** |

- **Draw.** Python `random.Random(20260924)` (the audit date is the seed). One generator is shared across strata. Strata are visited in the order carried, gap, deliberate, later, and within each status HD, IR, PM, FE, INV. In each stratum `rng.sample(pool, n)` draws from the rows in file order, and the draw is then sorted by line. Rerunning the same parse and the same calls reproduces the sample exactly.
- **What was read.** For each row: the old text at its `HD:`/`IR:`/`PM:`/`FE:`/`FI:` line in `git show fb59ba2:<file>`, with the surrounding lines, and the new text at every location the row names (the numbered item in the spec's §2, its §4 state table, its §5 EARS criteria, §7 Later, §9, DECISIONS, OPEN_QUESTIONS, PROVENANCE or DEFINITION_OF_DONE). Where the row's location did not hold the item, the rest of the design was searched as well.
- **Criteria (from the brief).**
  - `carried`: the new text is at least as precise as the old, and every number is identical or was changed on purpose with a recorded reason.
  - `gap`: a change ID with EARS acceptance criteria.
  - `deliberate`: the reason is recorded where the row says.
  - `later`: a reason is given. A reason, a condition for its return, or the v1 behaviour that replaces it all count.

  Whether a `carried` item is built yet is not part of the `carried` test; see §5, observation 3.
- **Verdicts.**
  - **correct**;
  - **wrong status**: another status fits the evidence;
  - **wrong location**: the item or its reason is not where the row says, or the row's note contradicts the text at that location;
  - **lost precision**: labelled `carried`, but a normative detail of the old text (a number, a string, a behaviour) is in no new document, and no reason is recorded for dropping it.

  Two kinds of error are reported separately:
  - **status errors**: wrong status, lost precision, or a missing reason. The status as labelled cannot be defended.
  - **location or note errors**: the status is right, but the row's pointer or its annotation is wrong.

## 2. Every sampled row

`#` is the sample index. *Trace line* is the line in DESIGN_TRACE.md. Rule numbers are §2 items of the named spec.

### 2.1 `carried` (64)

| # | Row | Trace line | Old | Item | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | HD1:18 | 273 | HD:41 | Offline by default; remotes and sync opt-in | correct | SPINE "Locked for v1" Network row; security 29 |
| 2 | HD1:66 | 321 | HD:192 | `sekhemet dev <x>`, listed only by `dev --help` | correct | surface 13 (and still runs without `dev`) |
| 3 | HD1:176 | 431 | HD:434-443 | Card budget **and actuals** (steps, tokens, seconds) | **wrong location** | Budgets are at the cited planner-pm §2.1.5 and worker-loop 21; the actuals are at neither. They are at planner-pm §2.6.1 ("actuals write back on acceptance") and in kernel rule 6 (the attempt's tokens and seconds used; step records) |
| 4 | HD1:353 | 608 | HD:869 | `read` line numbers 1-based start/end | correct | worker-loop 12 ("1-based inclusive `start`/`end`") |
| 5 | HD1:466 | 721 | HD:1187 | Retrospective at end of sprint or every N cards | correct | planner-pm §2.7.8 table (`retroEveryCards`) |
| 6 | HD1:542 | 797 | HD:1424 | Gate verdict cached by tree hash + gate hash | correct | gates 33 has the same key; GT-N3-1. Not built (gates §4 "absent", NEW-gates-3); see §5, observation 3 |
| 7 | HD2:38 | 942 | HD:1856 | Offline vulnerability scan with `osv-scanner` | correct | security 44, last sentence |
| 8 | HD2:59 | 963 | HD:1905 | Reads `AGENTS.md`/`CLAUDE.md` into Zone 2 | correct | context 8 zone table, Zone 2; CX-8 |
| 9 | HD2:76 | 980 | HD:1937 | Inbound issue text is untrusted and wrapped | correct | integrations 3; INT-32 |
| 10 | HD2:194 | 1098 | HD:2280 | Never resolves a semantic conflict by preferring one side | correct | review-git §2.6.4, same sentence |
| 11 | HD2:227 | 1131 | HD:2376 | Generated `AGENTS.md` and playbook drafts need sign-off | correct | surface 10 (everything a draft under `.sekhemet/onboard/` until accepted) |
| 12 | HD2:250 | 1154 | HD:2452 | A skill lacking its required tools is omitted | correct | extensibility 12 |
| 13 | HD2:304 | 1208 | HD:2600 | Traces stored locally in SQLite, viewable in the UI | correct | runtime 30 (`.sekhemet/traces.db`; dashboard view is NEW-runtime-9) |
| 14 | HD2:349 | 1253 | HD:2705 | Surface ladder by luminance, no shadows; both themes | correct | dashboard §2.13.1 |
| 15 | HD2:399 | 1303 | HD:3050-3081 | Worked `gates.toml` example | correct | gates 36: same gates, args and parsers; the Stryker gate is reduced to a sentence that keeps `blocking = false` and `timeout_s = 1800` |
| 16 | HD2:431 | 1335 | HD:3394 | Phase 2 PM-layer list | correct | An aggregate row. The items are traced separately (for example HD1:145 dynamic tool loading, HD2:286 native condensing). The phase grouping is roadmap, not behaviour |
| 17 | HD2:461 | 1370 | IR:55 | Worker budget 16,384 − 4,096 − 256 = 12,032 | correct | worker-loop 22: 9,984 with the thinking cap, and it names 12,032 as the non-thinking figure (more precise) |
| 18 | HD2:479 | 1388 | IR:136 | Send-back note unseen by the next attempt | correct | review-git §2.4 Send back: "what the Worker is told next (dossier)"; worker-loop 5a |
| 19 | HD2:491 | 1400 | IR:178 | Worker questions recorded as `actor: "human"` | correct | integrations 25, INT-25. The secondary cite kernel §2.16 (nothing durable outside the ledger) is irrelevant but harmless |
| 20 | HD2:492 | 1401 | IR:179 | One reply attached to every asking card | correct | kernel 20 (answers threaded under the question they name); K-10 |
| 21 | HD2:499 | 1408 | IR:199 | `moduleApiSummary` wrapped three times | correct | gates GT-T2-3 (one index module answers exports) |
| 22 | HD2:511 | 1420 | IR:224 | Card dossier: typed events on the ledger | correct | kernel 20 (all seven types plus `card/repair_plan`); worker-loop 5a |
| 23 | HD2:522 | 1431 | IR:253 | PM chat as a view with Worker questions labelled | correct | dashboard §2.7.3; kernel 19 |
| 24 | HD2:525 | 1434 | IR:267 | Goal restated at the tail | correct | context 8 ("the tail restates the goal in one line") |
| 25 | PMFE:21 | 1470 | PM:34 | Review limit derived from review minutes per day | correct | review-git §2.2.1 (formula, 60 default, 15-minute prior) |
| 26 | PMFE:41 | 1490 | PM:49 | Avoid bubbles both sides, avatars every line, decoration | correct | dashboard §2.7.3 (one-sided layout, full-width prose, no avatar per line) |
| 27 | PMFE:48 | 1497 | PM:64 | Avatar 24 px rounded square, overlay, 600 weight, no gold | correct | dashboard §2.7.2, same values |
| 28 | PMFE:112 | 1561 | PM:266 | No runner lease → Worker rows omitted | correct | dashboard §2.7.8 ("Worker rows are omitted when nothing was running") |
| 29 | PMFE:119 | 1568 | PM:273 | Offline disables the composer with *Offline. Your message would not reach Seshat.* | **lost precision** | dashboard §2.7.8 keeps "freezes timers and disables the composer", but the copy is in no document (search for "would not reach": 0 hits). The row itself says "copy lost". The same dashboard section keeps its other copy strings verbatim |
| 30 | PMFE:139 | 1588 | PM:333 | Saved views in this browser until `/api/views`; footer says so | correct | dashboard §2.4.11 |
| 31 | PMFE:144 | 1593 | PM:345 | Unestimated cards count 1 pt; header says how many | correct | dashboard §2.4.13, same copy |
| 32 | PMFE:145 | 1594 | PM:346 | *Plan next cycle with Seshat* prefills, not sent | correct | dashboard §2.4.13 |
| 33 | PMFE:177 | 1626 | PM:400 | Jira CSV columns | correct | integrations 17, the same eight columns; INT-31 |
| 34 | PMFE:207 | 1656 | PM:476 | Per-kind capability row with Wilson bar and copy | correct | dashboard §2.10.3, same copy and ordering |
| 35 | PMFE:260 | 1709 | PM:555-556 | `⌘J` panel; `#/board` on `g b`, `v` | correct | dashboard §2.3 (first-letter chords, `⌘J`, `v`) |
| 36 | PMFE:264 | 1713 | PM:573-588 | New icons (priority, chat, insights, plug, …) | correct | dashboard §3 names `packages/ui/src/icons.ts` as the source; all 13 names were found there. The drawings are held by code, not the spec |
| 37 | PMFE:281 | 1730 | PM:613 | Bulk bar `role="toolbar"` announcing *3 selected* | correct | dashboard §2.14.3 |
| 38 | PMFE:301 | 1755 | FE:46 | Master board: rollup, load, blocked-on-you with wait | correct | dashboard §2.11 Workspace; beyond that, §7 |
| 39 | PMFE:337 | 1791 | FE:114 | Chips rare; status in the footer as text + one dot | correct | dashboard §2.2.3 |
| 40 | PMFE:373 | 1827 | FE:231-242 | Card-fact vocabulary | correct | dashboard §2.12.4 Card facts row; §2.5.8 (tool set, gate contract) |
| 41 | PMFE:415 | 1869 | FE:369 | Parked a full column far right **with an amber count**; **Closed** only when non-empty | **wrong status** | dashboard §2.4.1: On hold shows only when non-empty, but Closed is no longer a column (*Won't do* is "a filter, not a column", with NAMING's reason for retiring *Closed*), and no amber count is specified. That is a deliberate change, the same as its sibling PMFE:360 (`deliberate`) |
| 42 | PMFE:419 | 1873 | FE:378 | `h/l` keep the row index clamped; `j/k` | **lost precision** | dashboard §2.3 Board keys: "`h/l` columns, `j/k` cards … `h/l` stay in the lane". The row-index clamp is not stated anywhere (the only "clamp" in dashboard is the title's 2-line clamp) |
| 43 | PMFE:420 | 1874 | FE:379 | Peek drawer 480 px with triage keys; `Enter` opens | correct | dashboard §2.4.6 |
| 44 | PMFE:423 | 1877 | FE:382 | **A click selects**; `Space` or double-click peeks | **lost precision** | dashboard §2.3 has `Space` (or double-click) to peek and `x` to select. A mouse click on a tile is specified nowhere. Originally traced `carried-weaker` |
| 45 | PMFE:435 | 1889 | FE:443 | Runs list 240 px (date, **time**, model, `3/6`, duration) | **lost precision** | dashboard §2.11 Runs: "date, model, *3 of 6 first try*, duration". The 240 px width is gone (the row admits "width lost") and so is the time column |
| 46 | PMFE:450 | 1904 | FE:658 | `card/step` event `{ id, turn, calls, gate?, usage }` | correct | kernel §3 event table; dashboard §3 shapes row |
| 47 | PMFE:452 | 1906 | FE:471, 659 | `GET /api/events?since=&card=&limit=&order=desc` | correct | dashboard §3 shapes row; runtime 25a (adds `before`, filters) |
| 48 | PMFE:466 | 1920 | FE:520-521 | Checking pips with running ring; fail pips, rung line, fail rule | correct | dashboard §2.4.4 gate pips; §2.4.1 badge *Types failed · retrying (rung 1 of 4)*; §2.13.3 fail rule |
| 49 | PMFE:531 | 1985 | FE:873-876 | Card view acceptance (Enter, 1–5, live steps, return note quote) | correct | dashboard §2.6 (tabs 1–5, live Steps, Thread "note as a quote"); §2.4.6 `Enter` |
| 50 | PMFE:545 | 1999 | FE:904 | `bounds` excludes staged acceptance tests | correct | gates 12; GT-11 |
| 51 | INV:K14 | 2021 | FI:58 | `projects` table incl. `tier` (default `'auto'`) | **lost precision** | The old SQL (HD:2904-2913) had `tier TEXT NOT NULL DEFAULT 'auto'`. kernel rule 6 lists the Project fields and names the old per-project fields that are not columns, with reasons, but `tier` is not among them. `schema.ts` has no `tier`. The field was dropped silently (the same applies to HD2:386) |
| 52 | INV:M13 | 2098 | FI:147 | Hardware calibration procedure | correct | models 7, every step of the old procedure plus the Metal limits |
| 53 | INV:C4 | 2151 | FI:210 | Four zones, byte-stable prefix | correct | context 8–10 (zone contents re-arranged on purpose, M8, traced separately as HD1:221) |
| 54 | INV:L20 | 2194 | FI:259 | `browse` sandboxed browser | correct | worker-loop 12; security 42a (click/type need a URL allowlist, screenshots to evidence) |
| 55 | INV:B8 | 2218 | FI:294 | Project-scoped board | correct | kernel `ProjectRecord`; dashboard project switcher and Workspace |
| 56 | INV:H5 | 2313 | FI:405 | `plan "<spec>"` | correct | planner-pm 1 and its CLI row (`sekhemet plan "<spec>"`); surface 13 |
| 57 | INV:H18 | 2326 | FI:418 | Fork at step N | correct | runtime 13; RUN-27 |
| 58 | INV:H23 | 2331 | FI:423 | Compute governance kWh, breakers, project cap | correct | runtime 18 (watts × time, with the recorded reason for dropping GPU utilisation), 19 |
| 59 | INV:X17 | 2357 | FI:451 | `PROVENANCE.md` register | correct | `docs/reference/PROVENANCE.md` exists; the technique table has source and date columns |
| 60 | INV:O23 | 2397 | FI:493 | Blocked 12 h / 2 h active | correct | planner-pm §2.12 signal table |
| 61 | INV:O25 | 2399 | FI:495 | RAID > 24 h → time-boxed verification spike | correct | planner-pm §2.12 ("Propose a verification spike"; a spike is a time-boxed card by §2.10.1). Dispatch becomes propose, in line with the spine |
| 62 | INV:O32 | 2406 | FI:502 | Branch naming from the parent | correct | review-git §2.6.2 |
| 63 | INV:O69 | 2443 | FI:539 | Reload re-streams from genesis or checkpoint | correct | runtime 25a (`?since=0` replays from genesis); dashboard §2.4.8 |
| 64 | INV:O91 | 2465 | FI:561 | SARIF gzip then base64 | correct | integrations 14 ("SARIF v2.1.0 (gzip, base64)") |

### 2.2 `gap` (20)

| # | Row | Trace line | Old | Item | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 65 | HD1:560 | 815 | HD:1479 | Speculative decoding (MTP or a draft model) | correct | models 13 (off until measured, with the reason); NEW-models-8, MD-N8-2, MD-N8-5 |
| 66 | HD2:53 | 957 | HD:1901 | GraphQL has a separate rate budget | correct | integrations 11a; INT-11c |
| 67 | HD2:135 | 1039 | HD:2126 | Claim gate declared in `gates.toml`, hash-pinned | correct | gates 27a; GT-N5-3; design-stage DS-N2-2 |
| 68 | HD2:185 | 1089 | HD:2268 | Outside declared hours, keep caches warm | correct | runtime 17; RUN-18a (the server is reused across rounds) |
| 69 | HD2:240 | 1144 | HD:2396 | Plugin and skill updates by signed bundle | correct | security 49; SEC-46 for skills. The plugin half is cut, with the reason at security 38 and extensibility 29 |
| 70 | HD2:462 | 1371 | IR:57-61 | A1: no single allocator | correct | context 10a; CX-N3-1, CX-N3-2 |
| 71 | HD2:464 | 1373 | IR:68-72 | A3: the same fact from four places | correct | context 24c; CX-N4-4 |
| 72 | HD2:472 | 1381 | IR:108-110 | A10: Seshat, Reviewer and Researcher prompts unbudgeted | correct | context 10c; CX-N3-3, CX-N3-7, CX-N3-8 |
| 73 | HD2:476 | 1385 | IR:128-131 | B4: three outcome stores disagree | correct | worker-loop 39; WL-N5-1, WL-N5-2 |
| 74 | HD2:508 | 1417 | IR:221 | Suggestion 3: rule scope and deduplication | correct | context 24a (built), 24b, 24c; CX-N4-1, CX-N4-2, CX-N4-4 |
| 75 | PMFE:421 | 1875 | FE:380 | `c` creates a card | correct | dashboard §2.4.7; DB-P3-12. The CLI-toast fallback is removed on purpose, and §9 gives the reason ("no path ends in a terminal") |
| 76 | PMFE:432 | 1886 | FE:420 | Persist the repair plan | correct | worker-loop 34.3; WL-N5-5, WL-N5-6; kernel 20 `card/repair_plan` |
| 77 | PMFE:440 | 1894 | FE:456 | `writeQueueReport` also writes `runs/<startedAt>.json` | correct | runtime 34b (the file is now a derived cache of `queue/reported`); RUN-56 |
| 78 | PMFE:501 | 1955 | FE:667-676 | One vocabulary module; the browser never re-derives a label | correct | dashboard §2.12.1; DB-N2-3 to DB-N2-6 |
| 79 | PMFE:528 | 1982 | FE:859 | `/api/gates` in order; `empty: true` | correct | gates §3 HTTP row; GT-T1-10 (`empty` redefined as "no `gates.toml`", with the reason) |
| 80 | INV:M19 | 2104 | FI:153 | Speculative decoding by measurement; draft model | correct | models 13; MD-N8-5 |
| 81 | INV:G27 | 2142 | FI:195 | Gate templates by language | correct | gates 23a table; GT-N5-1, GT-N5-2 |
| 82 | INV:L22 | 2196 | FI:261 | Token, seconds and kWh budgets; park at cap | correct | runtime 19; RUN-37, RUN-38 |
| 83 | INV:O29 | 2403 | FI:499 | A regression returns the card to Planning, named | correct | kernel 31; §4 "partial"; K-N5-4 |
| 84 | INV:O86 | 2460 | FI:556 | GraphQL budget, webhooks, batching, idempotency, backoff | correct | integrations 11, 11a; INT-8, INT-11b to INT-11d |

### 2.3 `deliberate` (20)

| # | Row | Trace line | Old | Item | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 85 | HD1:124 | 379 | HD:315 | Per-card worktrees by copy-on-write clone | correct | DEC-21 "Plain git worktrees", with its why and reopen-if |
| 86 | HD1:325 | 580 | HD:802 | Rung 3: narrow scope or escalate one tier | correct | worker-loop 34.3; §7 "Escalating the model" (needs a second Worker v1 lacks); §9 |
| 87 | HD1:637 | 892 | HD:1763 | `sekhemet dev audit` command | **wrong status** (reason missing) | measurement §9 lists it under "changed on purpose" but says only *what* changed ("the function lives in `doctor`'s playbook check and `qualify`"), not *why*. Every other item in that bullet carries a reason after a dash. measurement 24 gives none either |
| 88 | HD2:300 | 1204 | HD:2542-2543, 2572 | DevDocs, Kiwix, Dozzle | correct | PROVENANCE Licences rows: "Not used", each with its reason |
| 89 | HD2:425 | 1329 | HD:3353 | Tests on in-memory SQLite, setup under 5 ms | correct | DEFINITION_OF_DONE §2A.1 (real on-disk SQLite, mocks forbidden); §2D.3–4 |
| 90 | HD2:473 | 1382 | IR:114-117 | B1: nothing learned reaches the Worker on the benchmark | correct | measurement 6 (isolation in measured runs is now the rule, with the reason); DEC-25 R12 |
| 91 | HD2:513 | 1422 | IR:226 | Suggestion 8: in-run probation | correct | measurement 6; context 24f; R12 and O15 (probation off until the owner decides) |
| 92 | HD2:520 | 1429 | IR:234-239 | Batch sequence on 24 GB | correct | review-git §2.3.2 and §9 (Reviewer once per queue pass); models 20a keeps the Worker → Researcher → Planner → retries order |
| 93 | PMFE:4 | 1453 | PM:20 | Priority glyphs incl. three dashes for none | correct | dashboard §9 ("hidden for *No priority* (no three dashes)", with the reason) |
| 94 | PMFE:49 | 1498 | PM:64 | Worker quoted with a "W" avatar; you with your git initial | correct | dashboard §9 (R10: a role never has an avatar; a person keeps initials) |
| 95 | PMFE:125 | 1574 | PM:300 | Priority glyph in a fixed 12 px slot, far left | correct | dashboard §9 (moves to row 3; the List view scans priority) |
| 96 | PMFE:250 | 1699 | PM:536 | Four roles incl. "Seshat · PM" as a role | correct | models 21; DEC-05 (Seshat is the persona on the Planner's weights, with why) |
| 97 | PMFE:376 | 1830 | FE:247 | Empty Review copy ends with `sekhemet queue` | correct | dashboard §9 ("offer buttons … no path ends in a terminal") |
| 98 | PMFE:425 | 1879 | FE:388 | Empty board: `sekhemet plan …` and the seed command | correct | dashboard §2.4.10 (*Start a project* button); §9 same bullet |
| 99 | PMFE:430 | 1884 | FE:407 | Tabs with a 2 px `--accent` underline | correct | dashboard §2.6 (`--text-primary` underline); §9 "gold stays in its four places" |
| 100 | PMFE:459 | 1913 | FE:504 | Tile row 1: kind tag · short id | correct | dashboard §9 (professional anatomy; row 1 is identity) |
| 101 | INV:K9 | 2016 | FI:53 | Service container | **wrong location** (stale note) | The status is right, and the reason is at extensibility 29 and §8 Q2. But the row's note, "container is reachable; trust-gated until the owner decides the cut, O4", contradicts both: O4 is decided (DEC-29, cut in B0), and rule 29 says plugins "never need a trust gate". The sibling HD1:158 was corrected during this audit; this row was not |
| 102 | INV:K17 | 2024 | FI:61 | `steps` table incl. `success`, `tokens_condensed` | correct | kernel rule 6 Step ("not stored: a step's verdict is its gate results …"); `repo_state_hash` kept |
| 103 | INV:C18 | 2165 | FI:224 | Reasoning traces stripped between steps | correct | context 4; DEC-24 row 2 |
| 104 | INV:U13 | 2295 | FI:383 | Card tile components (class chip, budget bars, 5-box strip) | correct | dashboard §9 ("replaced by the professional anatomy — a tile should read like Jira's") |

### 2.4 `later` (20)

| # | Row | Trace line | Old | Item | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 105 | HD1:218 | 473 | HD:551 | [BENCH] pruner CPU latency, 4-core host | correct | OPEN_QUESTIONS benchmarks row 8 ("Deferred with the pruner", DEC-21) |
| 106 | HD1:450 | 705 | HD:1121 | Steering not required for correctness | correct | planner-pm §7 Steering (abort and send-back cover v1; the rule is kept for when it is built) |
| 107 | HD2:17 | 921 | HD:1825 | Local verifier to rank or triage attempts | correct | gates §7 last bullet (only if it beats gate-only selection at equal wall-clock) |
| 108 | HD2:220 | 1124 | HD:2360-2361 | Go **and** Java/Kotlin templates as Phase 3 | **wrong status** | gates 23a: the Go template is **built** (`go build`, `go vet`, `go test`), so that half is carried, not later. Java/Kotlin is "not built; later (its language server starts slowly)" inside rule 23a, but gates §7 has no Java/Kotlin gate template (only index adapters). Trace §3 still counts the row among gates' Later list |
| 109 | HD2:246 | 1150 | HD:2420-2440 | Per-skill pull/adapt/build decisions (19 rows) | **lost precision** | extensibility §7 has 12 rows. The eight *Build* skills are merged into one row, and their notes are gone ("Tiered lookup, citation format, budget", "How to write acceptance tests the Worker cannot game", "Per gate type, concrete repair procedure", …). The row's claim "kept in full" is false. No reason is given for making the catalogue Later |
| 110 | HD2:297 | 1201 | HD:2580 | hyperfine benchmark gate | correct | gates §7 ("until a card carries a measurable performance criterion") |
| 111 | HD2:489 | 1398 | IR:170-173 | C6: the tuner's 12-step cap is never applied | correct | planner-pm §7 last bullet (`tune --apply` a person's act; admitted only on a paired gain) |
| 112 | PMFE:187 | 1636 | PM:408 | Jira and Linear live sync | correct | integrations §7; PM_CONTRACT §5 roadmap tier *Next* (owner-approved order, keychain token kept) |
| 113 | PMFE:189 | 1638 | PM:410 | Microsoft Teams | correct | integrations §7; PM_CONTRACT §5 *Next* (the owner-approved order is the reason) |
| 114 | PMFE:190 | 1639 | PM:411 | Slack replies | correct | as #113 |
| 115 | PMFE:192 | 1641 | PM:416 | Notion and Confluence publishing | correct | integrations §7; PM_CONTRACT §5 *Later* |
| 116 | PMFE:308 | 1762 | FE:53 | Goal view: burn-up, criteria, risk register | correct | dashboard §7; planner-pm §7 (goals are CLI and API in v1; the highlight needs the view) |
| 117 | PMFE:534 | 1988 | FE:891 | `POST /cards/:id/run` (Retry with planner) | correct | dashboard §7. The v1 substitute is in §2.5.9 ("until then only Send back and Park"). That is weak (no why), but it meets the criterion |
| 118 | PMFE:538 | 1992 | FE:895 | Bundled fonts | correct | dashboard §7 (a proposal needing the owner's yes; system fallbacks until then) |
| 119 | PMFE:540 | 1994 | FE:897 | Master board, Registry, Goals | correct | dashboard §7 (master board beyond Workspace; goal view); Registry built as Configuration (§2.16) |
| 120 | INV:K10 | 2017 | FI:54 | Reversible plugin manager | **wrong location** (stale note) | The status is right: extensibility §7 "A plugin API … designed fresh". But the note "cut pending O4" is stale: the cut is decided and scheduled (DEC-29 O4; extensibility 29, "cut in B0") |
| 121 | INV:S14 | 2054 | FI:95 | CoW worktrees + linked deps | correct | review-git §7 (copy-on-write); DEC-21 why; security 24 (linked deps, built) |
| 122 | INV:X9 | 2349 | FI:443 | Doc cache TTLs (90 d official, 14 d blogs) | **wrong status** (reason missing) | design-stage §7 keeps the numbers (and adds more tiers), but gives no reason, return condition or v1 substitute for the deferral. design-stage §2.7.2 describes the research cache with no expiry at all |
| 123 | INV:O60 | 2434 | FI:530 | Every skill ships an eval card | correct | extensibility §7 (v1 runs the evals a skill has, EXT-27a) |
| 124 | INV:O84 | 2458 | FI:554 | git-cliff changelog + semver bump on a release | **wrong status** | This is v1, not Later. review-git §2.6.7 computes the version from Conventional Commits (with the `0.y.z` rule), builds the changelog in or with git-cliff, and tags on `sekhemet release --confirm`; planner-pm §2.15.8 proposes a release per slice (built in part, P13). Only *publishing* a GitHub Release is in integrations §7 |

## 3. Error rate

Intervals are exact two-sided 95% Clopper–Pearson intervals, computed from the binomial CDF.

| Measure | Errors / sampled | Rate | 95% interval |
| --- | --- | --- | --- |
| **All errors** | **14 / 124** | **11.3%** | **6.3% – 18.2%** |
| Status errors (the label cannot be defended) | 11 / 124 | 8.9% | 4.5% – 15.3% |
| Location or note errors only (status right) | 3 / 124 | 2.4% | 0.5% – 6.9% |

By stratum and by source:

| Stratum | Errors | Rate | 95% interval |
| --- | --- | --- | --- |
| carried | 7 / 64 | 10.9% | 4.5% – 21.2% |
| gap | 0 / 20 | 0% | 0% – 16.8% |
| deliberate | 2 / 20 | 10.0% | 1.2% – 31.7% |
| later | 5 / 20 | 25.0% | 8.7% – 49.1% |
| `HARNESS_DESIGN.md` | 4 / 32 | 12.5% | 3.5% – 29.0% |
| `INTEGRATION_REVIEW.md` | 0 / 17 | 0% | 0% – 19.5% |
| `PM_DESIGN.md` | 1 / 21 | 4.8% | 0.1% – 23.8% |
| `FRONTEND_DESIGN.md` | 4 / 26 | 15.4% | 4.4% – 34.9% |
| `FEATURE_INVENTORY` files | 5 / 28 | 17.9% | 6.1% – 36.9% |

**About the whole trace.** The sample is stratified with unequal fractions (carried 64 of 1,663; later 20 of 131), so 11.3% is the rate in the sample, not an unbiased estimate for all 2,148 rows. Weighting each status by its size gives about **10.8%**, roughly 230 rows. Almost all of that comes from the `carried` stratum, whose own interval (4.5–21.2%) is the one to quote for it. The `gap` rows are the most reliable: 0 of 20. The `later` rows are the least reliable: 5 of 20. Most errors are small (a lost UI string or dimension, a stale note, a missing reason). Two are real misclassifications: #41, a column changed on purpose but marked `carried`, and #124, a built v1 capability marked `later`.

## 4. Every error, with its fix

Each fix belongs to the trace (a row's status or its Now-in cell) or to the spec the row points at. Where the spec is the better place, the trace row is updated in the same commit.

| # | Row | Kind | Fix |
| --- | --- | --- | --- |
| 3 | HD1:176 | wrong location | Now-in → "planner-pm §2.1.5 (budgets), §2.6.1 (actuals written back on acceptance); worker-loop rule 21; kernel rule 6 (attempt tokens and seconds used, step records)". |
| 29 | PMFE:119 | lost precision | Restore the copy in dashboard §2.7.8: "Offline freezes timers and disables the composer with *Offline. Your message would not reach Seshat.*" Then remove "copy lost" from the row. Otherwise re-mark the row `deliberate` and record why the string was dropped. |
| 41 | PMFE:415 | wrong status | Re-mark `deliberate`. Now-in → "dashboard §2.4.1 (On hold only when non-empty and pinned; *Won't do* a filter, not a column); NAMING (*Closed* retired, with the reason)". The amber count: either restore it in dashboard §2.4.3 (the On hold count in the parked tone) or record in dashboard §9 why it went. |
| 42 | PMFE:419 | lost precision | Add to dashboard §2.3, Board row: "`h/l` keep the row index, clamped to the target column's length". |
| 44 | PMFE:423 | lost precision | Add to dashboard §2.3 or §2.4.6: "a click selects a tile; `Space` or double-click peeks". |
| 45 | PMFE:435 | lost precision | In dashboard §2.11 Runs, restore "a 240 px list: date, time, model, *3 of 6 first try*, duration", or re-mark the row `deliberate` with a reason (the professional layout may not want a fixed width). |
| 51 | INV:K14 | lost precision | In kernel rule 6, Project, add `tier` to the list of old per-project fields that are not columns, with the reason (hardware tier is per host, from [models](../../design/specs/models.md) calibration, not per project). Mark HD2:386 the same way. |
| 87 | HD1:637 | reason missing | Complete measurement §9's bullet with the why, for example "… lives in `doctor`'s playbook check and `qualify` (rule 24) — one fewer command at the front door (surface rule 13), and `doctor` already reads the playbook". |
| 108 | HD2:220 | wrong status | Split the row. Go template → `carried` (gates rule 23a, built). Java/Kotlin template → `later`, with a gates §7 bullet ("a Java/Kotlin gate template: javac, checkstyle, JUnit, PIT — later; its language server starts slowly and no v1 user needs it"). Correct trace §3's gates count to match. |
| 109 | HD2:246 | lost precision | Restore the eight *Build* rows, each with its old note, in extensibility §7's catalogue table. Otherwise change the Now-in to "Build rows merged into one; per-skill notes dropped" and re-mark the row `deliberate` with a reason. Also add a one-line reason why the catalogue is Later. |
| 122 | INV:X9 | reason missing | Add a reason to design-stage §7 "Cache expiry by mutability", for example "v1 keeps the research cache without expiry because every entry carries its fetch date and content hash and a person can clear it; expiry arrives with the persistent project corpus". Otherwise state the v1 behaviour in design-stage §2.7.2. |
| 124 | INV:O84 | wrong status | Re-mark `carried`. Now-in → "review-git §2.6.7 (version from Conventional Commits with the 0.y.z rule; changelog built in or by git-cliff; tag on `--confirm`); planner-pm §2.15.8 (release per slice, P13); integrations §7 (publishing a GitHub Release only)". |
| 101 | INV:K9 | stale note | Now-in → "extensibility rule 29 (cut in B0, DEC-29 O4; no trust gate needed), §8 Q2 (decided)", in both §4 (trace line 208) and §5 (trace line 2016). |
| 120 | INV:K10 | stale note | Now-in → "extensibility §7 (a plugin API designed fresh, after v1); plugins cut in B0 (rule 29, DEC-29 O4)". |

## 5. Observations beyond the sample

These come from reading the trace while auditing. They are not counted in the rates above.

1. **`carried` rows that admit lost detail.** A search of the Now-in column of all 1,663 `carried` rows for "lost", "dropped", "gone" or "not restated" finds 14 rows whose own note says a detail was lost:
   - HD2:387, HD2:453;
   - PMFE:53, PMFE:119, PMFE:130, PMFE:131, PMFE:147, PMFE:383, PMFE:413, PMFE:435, PMFE:442, PMFE:475, PMFE:504;
   - INV:Y14.

   Under the brief's definition ("equal or greater precision") these are not `carried`. Each needs the detail restored, or re-marking `deliberate` with a reason. The two that fell in the sample (PMFE:119, PMFE:435) are errors #29 and #45. INV:Y14's note is also stale: integrations rule 14 now names `raw_details`.
2. **Stale owner-decision notes.** INV:K9 (at trace lines 208 and 2016) and INV:K10 (line 2017) still describe O4 as pending, but DEC-29 decided it on 2026-09-24. HD1:158, which had the same note, was corrected while this audit ran. The correction left a doubled word, "container cut cut in B0".
3. **`carried` versus `gap`.** The trace's §1 defines `gap` as "a capability that is not built yet, with a change ID and acceptance criteria". Yet 14 `carried` rows say in their own note that the capability is unbuilt:
   - HD1:541, HD1:542 (sample #6), HD1:543, HD1:545, HD1:557 and HD1:569 are each marked "(gap)" with a NEW- change ID;
   - INV:S4, INV:M9, INV:M11 and others cite a `not-built` state.

   The brief's `carried` test is about precision, not about build state, so this audit did not count them. But the trace's own taxonomy is inconsistent. Either `carried` means "stated with precision, whatever is built", and §1 should say so, or these rows are `gap`.
4. **Trace §3's claim.** §3 says every `later` row "sits in the named document's Later list with its reason". Two sampled rows break that: HD2:220 is not in gates §7, and INV:X9 has no reason. A third, PMFE:534, has only a v1 substitute, and that is outside the Later list. Assuming the sampled `later` rate holds (25%, interval 8.7–49.1%), between roughly 11 and 64 of the 131 `later` rows need the same repair. A full pass over the `later` rows (131, one sitting) would be cheaper than extrapolating.
5. **Where the trace is strong.** All 20 `gap` rows had a change ID and EARS criteria that match the old item. Every `INTEGRATION_REVIEW.md` row in the sample (17) was correct. Numbers were checked on every sampled row that had one: 12,032 and 9,984, the 90/14-day TTLs, 1,800 s, 24 h, 12 h and 2 h, 480 px, 16,384. None was changed silently. Every number that changed has a recorded reason.
