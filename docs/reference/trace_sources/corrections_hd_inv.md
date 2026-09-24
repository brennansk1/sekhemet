# Trace corrections: the harness-design, integration-review and inventory rows

*Re-verification of the `carried` and `gap` rows from HARNESS_DESIGN, INTEGRATION_REVIEW and the three FEATURE_INVENTORY files in [DESIGN_TRACE.md](../DESIGN_TRACE.md), 2026-09-25: every flagged row, a seeded sample of the rest, and a sweep of kernel rule numbers. The lead confirmed the rule that a `carried` capability must be built (otherwise it is `gap`), and accepted R5 (HD1:283 becomes `deliberate`).*


*Retrace of DESIGN_TRACE.md §5.1, §5.2 and §5.5 rows (keys `HD1:*`, `HD2:*`, `INV:*`) whose final status is `carried` or `gap`, against the working tree at `01a6d8a`, 2026-09-24. For each row checked, the old text was read at its line in `git show fb59ba2:<file>`, the raw trace row in `docs/reference/trace_sources/`, and the new text at every location the row names (and, where that failed, the rest of the design). No repository file was edited.*

## How the rows were chosen

- **Population.** 1,354 rows: `HARNESS_DESIGN.md` 921 (HD1 and HD2 in §5.1: 826 `carried`, 95 `gap`), `INTEGRATION_REVIEW.md` 71 (21 `carried`, 50 `gap`), the inventories 362 (331 `carried`, 31 `gap`).
- **Full check, 431 rows.**
  - 387 rows whose Now-in note or raw trace row mentions a loss, a weaker statement, "not built", "not yet", "dropped", "merged", "later", "pending", "partial", "unstated", an owner decision or a DEC/O number, or that were first traced as anything other than `carried` (a regular-expression pass over both texts; every `gap` row in scope fell into this set).
  - 44 more `carried` rows whose note says "(gap …)", "not-built", "partial" or "spec-stricter". The first pass missed them, and the brief's definition makes them suspect: an unbuilt capability is `gap`.
- **Sample, 210 rows**, from the remaining 923 `carried` rows, stratified by source, Python `random.Random(20260925)`, strata drawn in the order HD1 (90 of 444), HD2 rows of `HARNESS_DESIGN.md` (55 of 239), `INTEGRATION_REVIEW.md` (all 9), inventories (56 of 231); `rng.sample` over each pool in trace order, sorted by line.
- **Kernel pointer sweep, 39 rows.** `specs/kernel.md` was renumbered after the traces ran (the tracers cited the numbering of `5bec49c`: old rules 7–27 are now 8–38). The 38 in-scope rows outside the two sets above that cite a kernel rule number were each checked against the current rule text, plus one planner-pm row (`§2.1.7` → `§2.1.9`, the one other renumbering that reaches this scope).

Rows checked: 431 + 210 + 39 = **680** distinct rows.

## What was found, in short

1. **72 `carried` rows become `gap`.** In 71 the capability is not built, by the row's own note or the owning spec's §4; the 72nd, HD2:481, also lacks a criterion (item 4). DESIGN_TRACE §1 defines each of these as `gap`. Most already carry the change ID in their Now-in ("gates rule 33, GT-N3-2 (gap)"). Often the same item traced from another source is already `gap` (HD2:19 vs INV:S4, HD2:174 vs INV:H17, HD2:240 vs INV:X13), so the trace contradicts itself. The auditor put this class aside (audit §5, observation 3); the brief counts it. The lead should confirm the rule once, in trace §1, and then apply it to every row. The corrections below do so.
2. **Kernel rule numbers are stale in 48 rows.** In 40 of them this is the only error: 31 found by the sweep, 5 by the full check (HD1:6, HD1:206, INV:K23, INV:K26, INV:B12) and 4 by the sample (HD1:187, INV:K3, INV:B7, INV:B10). In 8 more it sits beside a status error, and the new location fixes both. The map from old to new numbers: 7→8, 8→9, 9→10, 10→11, 11→12, 12→13, 13→14, 14→15, 15→16, 16→19, 17→23, 18→24, 19→25, 20→26, 21→27, 22→28, 23→29, 24→30, 25→31, 26→32, 27→38. Rules 1–6 are unchanged. The whole trace (the PMFE rows too) should be swept with this map. Rows the fix passes rewrote already use the new numbers, so apply the map only to a row whose Now-in still equals its raw trace note.
3. **Lost precision, 11 rows.** Fields: `projects.tier` (INV:K14, HD2:386), the attempt status `done_pending_gates` (HD2:390), and the `gate_results` shape (INV:K18, HD2:392). Rules: `llms-full.txt` (HD2:96), the research brief's ambiguity rule (HD2:105), "a goal sits above projects" (HD1:174) and "politeness" in DEC-22 (HD2:453). Evidence numbers: 40% of tool-call failures from templates (HD1:283), and MTP 21% slower on the M4 (INV:O100).
4. **`gap` rows with no EARS criterion, 8 rows.** The cache-hit operator alert (HD1:238, INV:M18, INV:O46); `tool_search` answering a symbol query (HD2:9); the Dependabot/Renovate verification card (HD2:74); the draft PR and its evidence body (HD2:81); ready on green with CODEOWNERS reviewers (HD2:82); profile decay (HD2:481, which also has no §4 row).
5. **Wrong status otherwise, 12 rows.** Eleven are `deliberate`, not `carried`: `done_pending_gates`'s new meaning (HD1:314), a stall's destination (HD1:197), the 15-token pointer (HD1:223), "turn" (HD1:162), the REST route table (HD2:405), onboarding's qualification run (HD2:217), the search provider (HD2:114), the old `cards` defaults (HD2:387), the steps table (HD2:391), in-memory SQLite (INV:X22) and the front-door `board` under O23 (HD1:64). One is `later` (INV:O53). Five of them still need a reason written (HD1:314, HD1:197, HD2:217, HD2:114; HD2:387 needs its fields listed).
6. **Stale notes, 7 rows** (HD1:135, HD1:600, HD2:78, HD2:408, INV:Y14, INV:L8, INV:U7). Examples: Playwright and axe-core were approved in DEC-29 O5; `raw_details` is now in integrations 14; `description` is now in worker-loop 12; Registry is now a section of Configuration; the plugin cut is DEC-29 O4.

## Sample error rate

Exact two-sided 95% Clopper–Pearson intervals (the implementation reproduces the audit's 14/124 → 6.3%–18.2%). A row counts once, by its most serious error.

| Measure | Errors / sampled | Rate | 95% interval |
| --- | --- | --- | --- |
| **All errors** | **27 / 210** | **12.9%** | **8.6% – 18.2%** |
| Status errors (the label cannot be defended) | 21 / 210 | 10.0% | 6.3% – 14.9% |
| – an unbuilt capability labelled `carried` (should be `gap`) | 12 / 210 | 5.7% | 3.0% – 9.8% |
| – lost precision, `gap` without EARS, or another wrong status | 9 / 210 | 4.3% | 2.0% – 8.0% |
| Location or note errors only (status right) | 6 / 210 | 2.9% | 1.1% – 6.1% |
| HD1 stratum | 8 / 90 | 8.9% | 3.9% – 16.8% |
| HD2 (`HARNESS_DESIGN.md`) stratum | 6 / 55 | 10.9% | 4.1% – 22.2% |
| `INTEGRATION_REVIEW.md` (census of the 9) | 1 / 9 | 11.1% | 0.3% – 48.2% |
| Inventory stratum | 12 / 56 | 21.4% | 11.6% – 34.4% |

Weighted by stratum size, about **12.6%** of the 923 unflagged rows (≈ 116 rows) are wrong, and about **9.7%** (≈ 90) have a wrong status. Those rows were **not** individually checked: the sample only estimates them. The figure is close to the audit's 11.3%. The inventory rows are the weakest: their "— agree" notes compare the spec's state with the inventory's state, not with the capability, so an unbuilt capability reads as `carried`. Excluding the unbuilt-capability class, the sample's status-error rate is 4.3% (2.0%–8.0%).

## Trace corrections

One line per corrected row, in trace order. *Kind* and the check that found it are given first in each note. "New location" is the replacement Now-in cell. Where a restoration is needed, the location says "(after restoration)" and the text is in the next section.

| Row | Old status | New status | New location | Note |
| --- | --- | --- | --- | --- |
| HD1:4 | carried | carried | SPINE spine 2; kernel rules 16–17 | *Location* (kernel sweep). Kernel renumbered: rule 15 is resolved projection values; nothing-durable-outside and model-visible-logged are 16 and 17 |
| HD1:6 | carried | carried | SPINE spine 1; kernel rule 27 | *Location* (full check). Kernel renumbered: entry conditions are rule 27 (rule 21 is owner/delegate/accepter) |
| HD1:45 | carried | carried | planner-pm §2.4–2.6; kernel rules 3, 29 | *Location* (kernel sweep). Kernel renumbered: WIP back-pressure is rule 29 (23 is the nine states) |
| HD1:46 | carried | carried | kernel rules 27 (entry conditions), 30 (rollup); gates rule 35 | *Location* (kernel sweep). Kernel renumbered: 21 and 24 are now owner/delegate and "held is not a state" |
| HD1:54 | carried | gap | surface rule 5, P10 (SUR-2, SUR-3) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap P10"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:64 | carried | deliberate | surface rule 13 (`ask` replaces `board` at the front door; `board --terminal` under `dev`), NEW-surface-6; owner decision O23 pending, default "approve" | *Wrong status* (sample). The front-door `board` command is removed by surface rule 13 under the default of open owner decision O23; the row names neither the change nor the pending decision |
| HD1:86 | carried | gap | extensibility rules 18–24, NEW-extensibility-3 (EXT-17: evidence and registry tools) | *Unbuilt, so `gap`* (sample). Evidence bundles are not exposed over MCP today (extensibility §4: "no evidence/registry tools"); HD1:112 and HD2:163 say the same |
| HD1:112 | carried | gap | extensibility rule 18, NEW-extensibility-3 (EXT-17) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("NEW-extensibility-3 gap"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:113 | carried | carried | kernel rules 8–11 | *Location* (kernel sweep). Kernel renumbered: the append-only table and hash chain are rules 8–11 (7 is association columns) |
| HD1:116 | carried | gap | runtime rule 12; kernel rule 32, §4 "Rewind invalidates earlier evidence for Review" not-built, S7 (K-S7-8) | *Unbuilt, so `gap`* (full check). Kernel §4 says the invalidation half is not built (S7); also kernel renumbered (rewind is rule 32, not 26) |
| HD1:129 | carried | gap | integrations rules 10, 15; review-git §2.5.7; P9, S5 (INT-12–14, RG-S5-18) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap P9/S5"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:130 | carried | gap | gates rule 11, T1 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("T1 gap"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:135 | gap | gap | gates rule 29, §8 Q1, NEW-gates-4 (GT-N4-6); Playwright and axe-core approved (DEC-29 O5), axe-core inside the product gate open (O27) | *Stale note* (full check). Stale note: "libraries still proposals (R16)" predates DEC-29 O5 |
| HD1:162 | carried | deliberate | DEC-26; NAMING "The run" (the old use of *turn* for all the steps of an attempt is retired); worker-loop §3 Terms | *Wrong status* (full check). Half the item is retired on purpose: NAMING says the old "turn = the steps of one attempt" is retired and *turn* survives only as the code's synonym for step; the reason is in DEC-26 |
| HD1:174 | carried | carried | planner-pm §2.11 rule 1 (after restoration) | *Lost precision* (sample). "a goal sits above projects" is stated nowhere; planner-pm §2.11 never relates goals to projects (kernel rule 6 only says goals belong to planner-pm) |
| HD1:176 | carried | carried | planner-pm §2.1.5 (budgets), §2.6.1 (actuals written back on acceptance); worker-loop rule 21; kernel rule 6 Attempt (tokens and seconds used) | *Location* (sample). Confirms audit #3: the actuals are not at the cited locations |
| HD1:182 | carried | carried | kernel rule 38 | *Location* (kernel sweep). Kernel renumbered: SQLite WAL is rule 38 (27 is entry conditions) |
| HD1:183 | carried | gap | kernel rule 9, NEW-kernel-1 (K-N1-1) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("timestamp coverage is NEW-kernel-1 gap; also kernel renumbered: the chain formula is rule 9, not 8"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:184 | carried | carried | kernel rule 14 | *Location* (kernel sweep). Kernel renumbered: projections are rule 14 (13 is one validated transaction) |
| HD1:185 | carried | carried | kernel rule 16 | *Location* (kernel sweep). Kernel renumbered: blobs under `.sekhemet/` are rule 16 |
| HD1:187 | carried | carried | kernel rules 23 (nine states), 27 (entry conditions) | *Location* (sample). Kernel renumbered: states are rule 23 and entry conditions rule 27 (17 and 21 are now model-visible logging and owner/delegate) |
| HD1:189 | carried | carried | kernel rule 23; NAMING | *Location* (kernel sweep). Kernel renumbered: the nine states are rule 23 (17 is model-visible logging) |
| HD1:190 | carried | carried | kernel rule 23 | *Location* (kernel sweep). Kernel renumbered: the nine states are rule 23 |
| HD1:192 | carried | gap | kernel rule 25 (unpark, reopen), K-S4-7, S4 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap S4/S5; also kernel renumbered: the legal edges are rule 25, not 19"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:193 | carried | gap | kernel rules 25, 27 (Small at `ready`); context §4 "Card size checked once, as Zone 3's fit at `ready`" not-built, NEW-context-2 | *Unbuilt, so `gap`* (kernel sweep). "context fits" at `ready` is not built (context §4, NEW-context-2); also kernel renumbered (entry conditions are rule 27, not 21) |
| HD1:197 | carried | deliberate | kernel rule 25 (LEGAL_TRANSITIONS, now in the spec); worker-loop rule 31 (budget reasons park unless the gates ran; `oscillation_detected` and `no_progress` go to Verify), §9 (after the reason is added) | *Wrong status* (sample). "code table" is stale (kernel rule 25 now carries the table). A stall no longer parks: worker-loop 31 sends `oscillation_detected` to Verify, and §9 records only the warn-once change, not the new destination |
| HD1:198 | carried | gap | kernel rule 27; context rule 10, NEW-context-2 | *Unbuilt, so `gap`* (kernel sweep). The budget-fit half of the Ready entry is not built (context §4); also kernel renumbered (rule 21 → 27) |
| HD1:201 | carried | gap | kernel rule 27 (`verify` entry), K-S4-6, S4 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap S4; also kernel renumbered: entry conditions are rule 27, not 21"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:202 | carried | carried | kernel rule 27 | *Location* (kernel sweep). Kernel renumbered: entry conditions are rule 27 |
| HD1:203 | carried | carried | kernel rule 27; review-git §2.5 | *Location* (kernel sweep). Kernel renumbered: entry conditions are rule 27 |
| HD1:206 | carried | carried | kernel rule 30, K-7 | *Location* (full check). Kernel renumbered: rollup is rule 30 (24 is "held is not a state") |
| HD1:208 | carried | carried | kernel rule 31 | *Location* (kernel sweep). Kernel renumbered: "a revision never loses what Review saw" is rule 31 (25 is the edge table) |
| HD1:211 | carried | carried | kernel rule 29 | *Location* (kernel sweep). Kernel renumbered: back-pressure is rule 29 |
| HD1:223 | carried | deliberate | context rule 3 (one line of ≤ 30 tokens at masking points, CX-M8-8), §9; DEC-24 | *Wrong status* (sample). The 15-token pointer masked after two observations became a ≤ 30-token line at batched masking points; the sibling HD1:123 (the same mechanism) is already `deliberate` |
| HD1:238 | gap | gap | context rule 7, §4 "Cache hit alert" partial, M8 (after CX-M8-10 is added) | *`gap` without EARS* (full check). The operator alert is in rule 7 and §4 (partial), but no CX-M8 criterion tests it (CX-M8-7 only records the median) |
| HD1:239 | carried | gap | context rule 22, P1 (CX-P1-1…5) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap P1"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:270 | carried | gap | models rule 28, §4 "Tool arm measured and pinned" not-built, NEW-models-5; OPEN_QUESTIONS benchmark 1 | *Unbuilt, so `gap`* (sample). The Now-in names NEW-models-5 and models §4 says not-built: the per-model tri-arm qualification is `gap` |
| HD1:283 | carried | carried | models rule 12 and §9 (after restoration) | *Lost precision* (full check). The "up to 40%" statistic is dropped (row admits it); restore as the rule's rationale or re-mark deliberate |
| HD1:314 | carried | deliberate | worker-loop rule 33, §9 (after the reason is added) | *Wrong status* (full check). Meaning changed, not refined: old = Worker finished declared work, ready for gates; new = claimed completion but the gates could not run. No reason recorded |
| HD1:343 | carried | gap | context rule 14, M5 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap M5"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:381 | carried | gap | review-git §2.2.1–2.2.3, S6 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap S6"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:409 | carried | gap | design-stage §2.5.7, P7 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap P7"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:428 | carried | gap | design-stage §2.5.1–2.5.2, P7, S8 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap P7/S8"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:440 | carried | gap | design-stage §2.4.1, P2 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap P2"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:474 | carried | carried | kernel rule 28, K-5 | *Location* (kernel sweep). Kernel renumbered: overrides are rule 28 (22 is "who built each attempt") |
| HD1:514 | carried | gap | gates rule 30, NEW-gates-4 (GT-N4-2) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap NEW-gates-4"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:541 | carried | gap | gates rule 33, NEW-gates-3 (GT-N3-2) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("(gap)"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:542 | carried | gap | gates rule 33, NEW-gates-3 (GT-N3-1) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("(gap)"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:543 | carried | gap | gates rule 33, NEW-gates-3 (GT-N3-3) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("(gap)"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:545 | carried | gap | gates rule 34, NEW-gates-3 (GT-N3-4) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("(gap)"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:557 | carried | gap | models rule 9, NEW-models-2 (MD-N2-1) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("(gap)"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:569 | carried | gap | models rule 20, NEW-models-3 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("(gap)"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:600 | gap | gap | context rule 27, NEW-context-6; DEC-28 (playbook rules deliberately outside the context version) | *Stale note* (full check). Half the item changed on purpose: playbook rules are no longer versioned with prompts and tool schemas (DEC-28, context rule 27); the row should say so |
| HD1:607 | carried | gap | review-git §2.3.7, P8 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap P8"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:611 | carried | gap | measurement rule 14, T7 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap T7"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD1:638 | carried | gap | measurement rule 24, NEW-measurement-2 (MS-N2-2) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("gap NEW-measurement-2"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| HD2:9 | gap | gap | worker-loop rule 12, §4 row, M2 (after WL-M2-7 is added) | *`gap` without EARS* (full check). §4 marks it not-built under M2, but no WL-M2 criterion covers a symbol query; the gap has no EARS criterion |
| HD2:74 | gap | gap | integrations rule 12, INT-16, P9 (after INT-16a is added) | *`gap` without EARS* (full check). INT-16 covers only the not-allowed-to-auto-merge branch; creating the verification card that runs the full gates, and auto-merge when policy allows, have no criterion |
| HD2:78 | carried | carried | integrations rule 14 (annotations with `raw_details`, redacted first) | *Stale note* (sample). Stale note "`raw_details` not listed, minor": rule 14 now lists `raw_details` |
| HD2:81 | gap | gap | integrations rule 15, INT-12, P9 (after INT-12a is added) | *`gap` without EARS* (full check). INT-12 requires a PR, not a draft PR, and nothing tests the evidence-summary body |
| HD2:82 | gap | gap | integrations rule 15, P9 (after INT-12b is added) | *`gap` without EARS* (full check). No criterion for "ready when every check succeeds" or for requesting CODEOWNERS reviewers |
| HD2:96 | carried | carried | design-stage §2.7.2 (after restoration) | *Lost precision* (sample). The row admits "`llms-full.txt` not named": the old tier 2 cached `llms.txt` **and** `llms-full.txt` per dependency version |
| HD2:105 | carried | carried | design-stage §2.7.3 (after restoration) | *Lost precision* (full check). The row admits "raise to the user is implicit only": §2.7.3 keeps the brief (what counts as an answer, what is out of scope) but not "ambiguity is resolved here or raised as a question, never guessed during gathering" |
| HD2:114 | carried | deliberate | design-stage §2.7.11, §9 (after the reason is added); PROVENANCE SearXNG row | *Wrong status* (full check). The old rule was SearXNG with no third-party query logging; the new rule also allows a Brave or Tavily key whose provider sees the queries. The AGPL separate-service rule is kept, but the widening has no recorded reason |
| HD2:207 | carried | gap | review-git §2.5.5, §4 "Restacked children re-run their gates" not-built, NEW-review-git-2 | *Unbuilt, so `gap`* (sample). Restacking is built but re-running the restacked cards' gates is not; INV:Y7 and INV:O33 (the same item) are `gap` |
| HD2:208 | carried | gap | review-git §2.6.5, §4 "Per-package gates in card verification; cross-repository change as two cards" partial, NEW-review-git-3 | *Unbuilt, so `gap`* (sample). §4 says partial (`runPackageGates` only from `sekhemet gate`; `splitAcrossRepos` has no caller); INV:Y19 (the same item) is `gap` |
| HD2:217 | carried | deliberate | surface rule 11, §9 (after the reason is added) | *Wrong status* (full check). The row itself says "deliberate": onboarding no longer runs the qualification suite, it offers it. No reason is recorded in surface §9 |
| HD2:306 | carried | gap | runtime rule 19, §4 "Per-card kWh budget; per-project caps" not-built, NEW-runtime-7 | *Unbuilt, so `gap`* (sample). Token and seconds budgets are built, the kWh budget and the project cap are not; INV:L22 (the same item) is `gap` |
| HD2:380 | carried | carried | kernel rule 16 | *Location* (kernel sweep). Kernel renumbered: blobs are rule 16 |
| HD2:382 | carried | carried | kernel rule 8 (plus the `UPDATE`/`DELETE` refusal, NEW-kernel-1) | *Location* (kernel sweep). Kernel renumbered: immutable events are rule 8 |
| HD2:383 | carried | carried | kernel rule 38, `pragmas.spec.ts` | *Location* (kernel sweep). Kernel renumbered: pragmas are rule 38 |
| HD2:385 | carried | carried | kernel rule 14, K-2 | *Location* (kernel sweep). Kernel renumbered: projections are rule 14 |
| HD2:386 | carried | carried | kernel rule 6 Project bullet (after restoration) | *Lost precision* (kernel sweep). `tier TEXT NOT NULL DEFAULT 'auto'` is dropped with no reason: kernel rule 6 lists the old per-project fields that are not columns but not `tier` (audit #51 names this row) |
| HD2:387 | carried | deliberate | kernel rules 6 (Card bullet, after restoration), 15 (order key), 23 (nine states), 24 (typed holds); K-S7-1 (difficulty 1–10); planner-pm §2.4 (step budget ≤ 40); worker-loop §3 Token budget row (none by default) | *Wrong status* (full check). Row admits "defaults are not restated". token_budget 32000 became "none" on purpose (worker-loop §3 gives the reason); blocked_reason became typed holds (kernel 24); assigned_tier DEFAULT 'auto' is dropped with no reason (same defect as audit #51 INV:K14) |
| HD2:390 | carried | carried | kernel rule 6 Attempt (after restoration); worker-loop rules 31, 33, 34; models rule 28 | *Lost precision* (full check). Kernel rule 6 lists attempt status as running/passed/failed/halted; the old CHECK's `done_pending_gates` status is gone with no note (it survives only as a stop reason) |
| HD2:391 | carried | deliberate | kernel rule 6 Step ("not stored: … a step's verdict is its gate results, and condensing savings are context's measure"); worker-loop rule 17 | *Wrong status* (kernel sweep). The same table as INV:K17, which the trace already marks `deliberate`: `success` and `tokens_condensed` are dropped on purpose with the reason in kernel rule 6 |
| HD2:392 | carried | carried | kernel rule 6 Gate result bullet (after restoration) | *Lost precision* (kernel sweep). Same defect as INV:K18: the `layer` CHECK (six values), `status` pass/fail, typed failures and `duration_ms` are stated nowhere |
| HD2:405 | carried | deliberate | runtime §3 ("superseded by the routes above; the code is the contract, and a route change updates this list") | *Wrong status* (sample). The old route table with request and response bodies is not restated; runtime §3 says so on purpose and gives the reason, so the row is `deliberate`, not `carried` |
| HD2:408 | carried | carried | kernel K-1, K-2; plugins cut in B0 (DEC-29 O4; extensibility rule 29) | *Stale note* (full check). "plugins cut: DEC-09" predates DEC-29 O4, which is the decision that cut the container and plugin mount |
| HD2:413 | carried | carried | kernel rules 29 (back-pressure), 30 (rollup); planner-pm §2.4 | *Location* (kernel sweep). Kernel renumbered: rule 24 is "held is not a state" |
| HD2:453 | carried | carried | DECISIONS DEC-22 (after restoration) | *Lost precision* (full check). Row admits "politeness dropped": DEC-22's row reads "Persona prompting for quality"; the old row was "Persona and politeness prompting" |
| HD2:481 | carried | gap | planner-pm §2.13.3, §4 (after a "Profile statements decay" row is added), P6 (after PM-P6 criterion is added) | *`gap` without EARS* (sample). The row admits decay is "not flagged in its state table": the integration review found decay unimplemented, yet planner-pm §4 lists the profile as built and no change or EARS criterion covers decay — neither `carried` nor a valid `gap` |
| INV:K1 | carried | carried | kernel rules 8–9, §4 built | *Location* (kernel sweep). Kernel renumbered: §2.7–8 are now association columns and the events table; the chain is 8–9 |
| INV:K2 | carried | carried | kernel rule 10, K-1; runtime rule 29, RUN-32 | *Location* (kernel sweep). Kernel renumbered: verification is rule 10 |
| INV:K3 | carried | carried | kernel rule 9 | *Location* (sample). Kernel renumbered: `payloadHash` over canonical JSON is rule 9 (rule 8 is the one `events` table) |
| INV:K5 | carried | carried | kernel rule 19 (`EVENT_ACTORS`), NEW-kernel-2 | *Location* (kernel sweep). Kernel renumbered: actors are rule 19 (16 is nothing durable outside the ledger) |
| INV:K8 | carried | carried | kernel rule 14, K-2 | *Location* (kernel sweep). Kernel renumbered: projections are rule 14 |
| INV:K14 | carried | carried | kernel rules 2, 6 Project bullet (after restoration) | *Lost precision* (kernel sweep). Audit #51: `tier` (default `'auto'`) is dropped silently; kernel rule 6 names the other old per-project fields that are not columns, but not this one |
| INV:K18 | carried | carried | kernel rule 6, Gate result bullet (after restoration); rules 14, 37 | *Lost precision* (sample). Kernel rule 6 promises "what each record holds, so that no field is lost" but has no Gate result bullet: the old columns (gate name, layer with its six-value CHECK, status, typed failures, duration in ms) are stated nowhere; rule 13 (the cited §2.13) is now the one-transaction rule |
| INV:K23 | carried | carried | kernel rule 38, tests `pragmas.spec.ts` | *Location* (full check). Kernel renumbered: WAL pragmas and `busy_timeout = 5000` are rule 38 (§2.27 is now entry conditions) |
| INV:K24 | carried | carried | kernel rule 23, §4 built | *Location* (kernel sweep). Kernel renumbered: the nine states are rule 23 |
| INV:K26 | carried | carried | kernel rule 16; §4 "ledger only durable channel" partial S7 | *Location* (full check). Kernel renumbered: "nothing durable outside the ledger" is rule 16 (15 is resolved projection values) |
| INV:S4 | carried | gap | security rule 7, §4 "Fail closed: gates" not-built, S3b (SEC-20) | *Unbuilt, so `gap`* (full check). The row's own note says "§4 not-built S3b": the Worker's tools fail closed (built) but gates do not; by §1 an unbuilt capability with a change ID is `gap` (HD2:19 and HD2:22, the same item, are already `gap`) |
| INV:S12 | carried | gap | security rule 43, worker-loop rule 13, §4 "Restricted mode strips tools" partial, S3a | *Unbuilt, so `gap`* (full check). §4 says partial (the visual gate still runs in restricted mode); the unbuilt part carries change S3a, so the row is `gap` |
| INV:Y14 | carried | carried | integrations rule 14, §4 built (annotations with `raw_details`) | *Stale note* (full check). Stale note "`raw_details` lost, O90": integrations §4 now names `raw_details` (audit observation 1) |
| INV:Y16 | carried | gap | integrations rule 15, INT-12–INT-14, P9 (draft, ready, CODEOWNERS and merge policy not built); review threads Later (integrations §7) | *Unbuilt, so `gap`* (full check). Note says "partial P9": the draft-to-ready-to-merge lifecycle is not built, and the same items from HARNESS_DESIGN (HD2:81, HD2:82, HD2:84) are already `gap` |
| INV:M9 | carried | gap | models rule 28, §4 "Tool arm measured and pinned" not-built, NEW-models-5 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("§4 "tool arm measured" not-built"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:M11 | carried | gap | models rule 25, §4 not-built, NEW-models-4 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("§4 not-built NEW-models-4"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:M13 | carried | gap | models rule 7, §4 "Calibration command and machine profile" partial, NEW-models-1 | *Unbuilt, so `gap`* (full check). Note says "partial NEW-models-1": the procedure is specified but has never run on the reference host |
| INV:M14 | carried | gap | models rule 8, §4 "Tier of the reference host" not-built, NEW-models-1 | *Unbuilt, so `gap`* (full check). Note says "partial"; §4 shows the tier mechanism misplaces the 24 GB host (tier S) and is not-built under NEW-models-1 |
| INV:M15 | carried | gap | models rule 9, §4 "Throughput floors refuse cards" partial, NEW-models-2 | *Unbuilt, so `gap`* (full check). §4 now says partial (the queue refuses; `run` has no check), change NEW-models-2; the row's "§4 not-built" note is also stale |
| INV:M18 | gap | gap | context rule 7, §4, M8 (after CX-M8-10 is added) | *`gap` without EARS* (full check). Same as HD1:238: no EARS criterion covers the alert |
| INV:M23 | carried | gap | models rule 30, §4 "Bake-off under the real harness" partial, NEW-models-4; history-mined tasks measurement T8 | *Unbuilt, so `gap`* (full check). Note says "partial (settings only)"; tasks from the repository's history are not built |
| INV:M25 | carried | gap | models rule 20, §4 "Declared hours, swap batching" partial, NEW-models-3; runtime rule 17 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("NEW-models-3, spec-stricter"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:G12 | carried | gap | gates rules 5–7, P1 (§4: every card not-built) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("§4 every card not-built"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:C4 | carried | gap | context rules 8–10, §4 "Four-zone layout" partial, M8 | *Unbuilt, so `gap`* (full check). Note says "§4 partial M8": the byte-stable prefix is not achieved (spec and criteria re-sent in the uncached tail; hit rate 0.29) |
| INV:C9 | carried | gap | extensibility rules 10–14, §4 skills-format and diagnostics rows partial, NEW-extensibility-4 | *Unbuilt, so `gap`* (full check). Note says "partial NEW-extensibility-4": `scripts/`, `references/`, `evals/` ignored, substring triggers (HD2:248/249 for the same parts are `gap`) |
| INV:C10 | carried | gap | extensibility rules 15, 17, EXT-27; §4 "Skills: SHA-256 pin, approve/revoke, audit" partial, S9 | *Unbuilt, so `gap`* (full check). Note says "partial S9": trust-on-first-use by default and the lock in the repository |
| INV:C12 | carried | gap | measurement rule 24, §4 partial, NEW-measurement-2 (MS-N2-2) | *Unbuilt, so `gap`* (full check). Note says "MS-N2-2 partial": the pass-rate half of the audit never runs (diagnostics called with no outcomes) |
| INV:C13 | carried | gap | context rule 25, M1 (CX-M1-11) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("M1 (structural filter) spec-stricter"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:L8 | carried | carried | worker-loop rule 12 (`run_cmd` timeout and `description`), WL-5; context rule 17 | *Stale note* (full check). Stale note "`description` unstated": worker-loop rule 12 now states the optional one-line `description` |
| INV:L18 | carried | gap | worker-loop rule 10, M2 (WL-M2-1) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("M2 not-built"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:B1 | carried | carried | kernel rules 25 (edges), 27 (entry conditions), 28 (override logged) | *Location* (kernel sweep). Kernel renumbered: 19 and 22 are now actors and builtBy |
| INV:B3 | carried | gap | review-git §2.2, §4 "ReviewWIP formula, back-pressure" partial, S6 | *Unbuilt, so `gap`* (full check). Note says "S6 partial": the count includes automated exits and is global, not per project |
| INV:B4 | carried | carried | kernel rule 29 | *Location* (kernel sweep). Kernel renumbered: back-pressure is rule 29 |
| INV:B7 | carried | carried | kernel rule 30, K-7 | *Location* (sample). Kernel renumbered: rollup is rule 30 (24 is "held is not a state") |
| INV:B10 | carried | carried | kernel rule 27 (WIP limits), §3 defaults row | *Location* (sample). Kernel renumbered: WIP limits and entry conditions are rule 27 (21 is owner/delegate/accepter) |
| INV:B12 | carried | carried | planner-pm §2.14; kernel rule 28 (override, never on security), K-5; Reroute and Explain Later (planner-pm §7) | *Location* (full check). Kernel renumbered: overrides are rule 28 (§2.22 is now "who built each attempt") |
| INV:P7 | carried | carried | planner-pm §2.1.9 (edit sketch), §2.5; worker-loop rule 28 | *Location* (kernel sweep). Planner-pm renumbered: §2.1.7 is now "each staged test case names the criterion"; the edit sketch is §2.1.9 |
| INV:P24 | carried | gap | context rule 22, P1; extensibility tool table | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("P1 not-built"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:E2 | carried | gap | measurement rule 17 (synthesised-tasks inlet), T8 (MS-T8-12); models rule 30 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("OPEN_QUESTIONS research gap; the bake-off runs a fixture, not mined tasks (models §4 partial)"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:E3 | carried | gap | gates rule 35; models rule 30, M4 (MD-M4-5); measurement rule 5 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("M4, spec-stricter"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:E5 | carried | gap | measurement rules 16a–19, §4 "Admission requires a significant gain" not-built, T8 | *Unbuilt, so `gap`* (sample). The inlets are not admitted by the suite today (`runFrozenRegressionGate` accepts a delta of 0); the note's "T8" names the change |
| INV:E19 | carried | gap | measurement rule 24, §4 "Diagnostics on real inputs" partial, NEW-measurement-2 (MS-N2-2); extensibility rule 16 | *Unbuilt, so `gap`* (sample). The note names NEW-measurement-2; the net-gain and bloat halves never run on real inputs (INV:C12 and HD1:638, the same item, are corrected to `gap`) |
| INV:U7 | carried | carried | dashboard §2.2, §2.11 (Workspace, Machine), §2.16 Configuration (the old Registry view, DEC-29 O2, O3); master board Later (dashboard §7) | *Stale note* (full check). Stale note: the Registry view is retired; it is a section of Configuration (NAMING keep list; dashboard §9) |
| INV:U14 | carried | gap | dashboard §2.4.3, P3 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("P3, spec-stricter"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:H15 | carried | gap | surface rules 21–25, §4 "Config layer: card overrides" not-built, NEW-surface-3 | *Unbuilt, so `gap`* (full check). The note's "DISAGREE on card layer" is now settled by surface §4: the card-overrides layer is not built (NEW-surface-3); the rest of the chain is built |
| INV:H17 | carried | gap | runtime rule 10, NEW-runtime-3 (RUN-9, RUN-10) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("NEW-runtime-3; HD2:174, the same item, is already `gap`"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:H19 | carried | gap | runtime rule 12; kernel rule 32, S7 (K-S7-8) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("kernel §4 "Rewind invalidates earlier evidence" not-built (S7); also kernel renumbered (§2.26 → rule 32)"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:X5 | carried | gap | design-stage §2.7.11, §2.6.3, §4 "`plan` honours offline config … queries logged" not-built, S8 | *Unbuilt, so `gap`* (sample). Every query and its result set on the ledger is not built (S8); HD2:116, the same item, is `gap` |
| INV:X11 | carried | gap | security rule 47, §4 air-gap row partial (manifest `tier` and `templateChecksum` optional and never checked; signature optional), NEW-security-2 (SEC-34) | *Unbuilt, so `gap`* (sample). HD2:232, the same manifest fields, is `gap` |
| INV:X12 | carried | gap | security rule 48, §4 "`llms.txt` snapshots, staleness on lockfile change" not-built, NEW-security-5 (SEC-44, SEC-45); the docs bundle and cache export are built | *Unbuilt, so `gap`* (sample). HD2:235 and HD2:236, the same items, are `gap` |
| INV:X13 | carried | gap | security rule 49, §4 "signed skill updates" not-built, NEW-security-5 (SEC-46); SEC-42 | *Unbuilt, so `gap`* (sample). The skill-update half is not built; HD2:240, the same item, is `gap` |
| INV:X14 | carried | gap | security rule 50, NEW-security-2 (SEC-33) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("NEW-security-2; HD2:241, the same item, is already `gap`"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:X22 | carried | deliberate | DEFINITION_OF_DONE §2A.1 (real on-disk SQLite; in-memory databases forbidden) | *Wrong status* (full check). The old item is in-memory SQLite test infrastructure with setup under 5 ms; the new DoD forbids it on purpose, as the trace already records for HD2:425 (`deliberate`, audit #89). "Still open" is wrong |
| INV:O21 | carried | gap | planner-pm §2.12, §4 "Signal responses executed as proposals" partial, NEW-planner-pm-5 | *Unbuilt, so `gap`* (full check). Note says "execution unbuilt": only `escalate_blockers` is acted on; the same signal table (INV:P20) is already `gap` under NEW-planner-pm-5 |
| INV:O27 | carried | carried | kernel rule 29 | *Location* (kernel sweep). Kernel renumbered: back-pressure is rule 29 |
| INV:O28 | carried | carried | kernel rule 30 | *Location* (kernel sweep). Kernel renumbered: rollup is rule 30 |
| INV:O33 | carried | gap | review-git §2.5.5, NEW-review-git-2 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("code gap; INV:Y7, the same item, is `gap` under NEW-review-git-2"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:O34 | carried | gap | review-git §2.6.4, NEW-review-git-1 | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("code gap; INV:Y6, the same item, is `gap` under NEW-review-git-1"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:O37 | carried | gap | gates rule 29, NEW-gates-4 (GT-N4-5) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("code gap; INV:G19, the same item, is `gap`"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:O38 | carried | gap | gates rule 29, NEW-gates-4 (GT-N4-4) | *Unbuilt, so `gap`* (full check). The row's own note marks the capability not built ("code gap (overlap); INV:G18, the same item, is `gap`"); by §1 an unbuilt capability with a change ID and criteria is `gap` |
| INV:O46 | gap | gap | context rule 7, §4, M8 (after CX-M8-10 is added) | *`gap` without EARS* (full check). Same as HD1:238: no EARS criterion covers the alert |
| INV:O53 | carried | later | context §7 (offline prompt optimisation, kept only if it gains ≥ 5%) | *Wrong status* (full check). The row's own location is a Later list: the optimiser and its kill switch are in context §7, so the row is `later`, not `carried` |
| INV:O67 | carried | gap | runtime rule 12; kernel rule 32, §4 "Rewind invalidates earlier evidence for Review" not-built, S7 (K-S7-8) | *Unbuilt, so `gap`* (kernel sweep). The invalidation half is not built; also kernel renumbered (§2.26 → rule 32) |
| INV:O70 | carried | gap | surface rule 21, §4 "Config layer: card overrides" not-built, NEW-surface-3 | *Unbuilt, so `gap`* (sample). The card-override layer the item singles out ("easy to drop") is exactly the unbuilt part |
| INV:O79 | carried | carried | kernel rule 9 | *Location* (kernel sweep). Kernel renumbered: `payloadHash` is rule 9 |
| INV:O80 | carried | carried | kernel rule 16 | *Location* (kernel sweep). Kernel renumbered: blobs are rule 16 |
| INV:O100 | carried | carried | models rule 13, §9 (after restoration) | *Lost precision* (sample). The rule (the machine profile wins; MTP off until measured) is carried, but the measurement the item records — MTP 21% slower on the M4 (CHRONICLE §2) — appears in no document |
| INV:D1 | carried | carried | kernel rules 24 (holds), 29 (back-pressure), NEW-kernel-3 | *Location* (kernel sweep). Kernel renumbered: §2.18 and §2.23 are now readers and the nine states |
| INV:D4 | carried | gap | security rule 25a, §4 "Ask answered by a person through a decision request" partial, NEW-security-6 (SEC-47–49) | *Unbuilt, so `gap`* (full check). §4 says partial (no test drives the approver path) and names NEW-security-6 |

## Spec restorations

The text to add or change, grouped by file and section, each with its row keys. Numbers are the old design's, checked against `fb59ba2` and, for record fields, against `packages/kernel/src/schema.ts` today. "Replace" quotes the current text exactly.

### `docs/design/specs/kernel.md` — §2 rule 6 (the record shapes)

**R1 — Project bullet: say where `tier` went** (INV:K14, HD2:386). Replace
> The old design's per-project "gate contract, conventions ref, stage, playbook ref" are not columns:

with
> The old design's per-project "gate contract, conventions ref, stage, playbook ref" and its `tier` column (default `'auto'`) are not columns:

and add at the end of that sentence, after "…and the stage is the design stage's ([design-stage.md](design-stage.md))":
> ; the hardware tier belongs to the host, not the project — it is derived from the host's memory by calibration ([models.md](models.md) rules 7–8), which is also why [surface.md](surface.md) rule 25 removed `machine.tier`.

**R2 — new Card bullet, placed after the "What kind of card it is" bullet** (HD2:387):
> - **Card** (`CardRecord`, `schema.ts` `CARDS_TABLE_BODY`): the planner's fields ([planner-pm.md](planner-pm.md) §2.1.5), the kind fields above, owner, delegate and accepter (rule 21), dependencies (rule 3) and the order key (rule 15). Three columns of the old `cards` table are not kept as they were: `assigned_tier` (default `'auto'`) is not stored, because the tier is the host's (Project, above); `blocked_reason` is today's free-text encoding of a hold and is replaced by the typed hold of rule 24 (NEW-kernel-3); and the old default `token_budget = 32000` is replaced by no token budget by default, since tokens are bounded by the step budget (40 per sample) and the per-request prompt budget ([worker-loop.md](worker-loop.md) §3, WL-T3-11).

**R3 — Attempt bullet: `done_pending_gates`** (HD2:390). After "status (`running`, `passed`, `failed`, `halted`)" insert:
> — the old status `done_pending_gates` is not an attempt status but a stop reason ([worker-loop.md](worker-loop.md) rules 31, 33), recorded in the attempt's stop reason —

**R4 — new Gate result bullet, placed after the Step bullet** (INV:K18, HD2:392):
> - **Gate result** (`GateResultRecord`, `schema.ts:198-210`): attempt, card, step, gate name, **layer** — one of `static`, `functional`, `robustness`, `security`, `visual`, `hygiene`, enforced by a `CHECK` ([gates.md](gates.md) rule 3) — status `pass` or `fail`, exit code, the typed failures ([gates.md](gates.md) rule 19), duration in milliseconds, and its source (rule 37).

### `docs/design/specs/models.md` — §9 Evidence and rationale

**R5 — why templates are pinned** (HD1:283). Add to §9:
> - **Why chat templates are pinned (rule 12):** in local inference, up to 40% of small-model tool-calling failures have been traced to template bugs, unescaped role tags and special-token mismatches (for example a malformed `<|im_start|>` or `<｜tool_calls｜>`, or a missing tool-header delimiter in llama.cpp or vLLM) — the old design's figure; its source was not recorded.

*Or* re-mark HD1:283 `deliberate` and state in models §9 why the unsourced figure was dropped. Carrying a number without a source goes against "sanity-check every number".

**R6 — the M4 measurement** (INV:O100). Add to the *Changed on purpose* bullet on MTP:
> On the M4 host of the earlier Chronicle profile, MTP measured 21% *slower* than plain decoding (CHRONICLE §2); that measurement, not a published speed-up, is why the machine profile decides (rule 13).

### `docs/design/specs/worker-loop.md` — §9 Evidence and rationale, the *Changed on purpose* bullet

**R7 — `done_pending_gates` changed meaning** (HD1:314). Append:
> ; `done_pending_gates` now means the Worker claimed completion but the gates could not run (rule 33) — the old meaning, "the Worker finished its declared work and the card is ready for gates", is the ordinary path from `finish_card` to verification, which needs no stop reason of its own because `finish_card` is a claim that verification always follows (rule 12)

**R8 — where a stopped stall goes** (HD1:197). Append:
> ; a stall stopped with `oscillation_detected` (or `no_progress`) goes to Verify, not Parked as the old state diagram had it — the tree may already pass its gates, and the ladder's fresh-context and re-plan rungs are the next change of inputs (rule 34); only a card whose rungs are spent parks (`repair_exhausted`)

*(R7 and R8 give the reason the current rules imply. The lead confirms them before they are written.)*

### `docs/design/specs/worker-loop.md` — §5 Changes, M2

**R9 — EARS criterion for the symbol query** (HD2:9). Add after WL-M2-6:
> - **WL-M2-7** WHEN the progressive-loading arm runs and a `tool_search` query names a code symbol (for example `ChronicleEvent`, `GENESIS_HASH`) THE SYSTEM SHALL load `read_symbol` and name, in its reply, the `read_symbol` calls to make.

### `docs/design/specs/integrations.md` — §5 Changes, P9 (merge-aware Accept)

**R10 — the draft and the ready-for-review step** (HD2:81, HD2:82; INV:Y16). Add after INT-12:
> - **INT-12a** WHEN PR-on-accept opens a pull request THE SYSTEM SHALL open it as a draft whose body is the evidence summary: the gates passed, diff stats, coverage and the abandoned attempts.
> - **INT-12b** WHEN every check run on that pull request reports `success` THE SYSTEM SHALL mark it ready for review and request the reviewers `CODEOWNERS` names for its changed files.

**R11 — the dependency-bot verification card** (HD2:74). Add before INT-16:
> - **INT-16a** WHEN a signed `pull_request.opened` webhook arrives for a pull request authored by Dependabot or Renovate THE SYSTEM SHALL create a verification card that runs the project's full gates on the pull request's head; WHEN every gate passes and the project's policy allows auto-merge THE SYSTEM SHALL enable auto-merge on it.

### `docs/design/specs/context.md` — §5 Changes, M8

**R12 — EARS criterion for the operator alert** (HD1:238, INV:M18, INV:O46). Add after CX-M8-9:
> - **CX-M8-10** WHEN an attempt's median server-reported cache-hit rate on the steps after its first is below 0.85 THE SYSTEM SHALL name the card and the median in the queue report and on the Machine view, for `run` as well as `queue`.

### `docs/design/specs/planner-pm.md`

**R13 — §2.11 rule 1: goals sit above projects** (HD1:174). Append to rule 1:
> A goal sits above projects: its record holds the statement, the criteria (each with its check kind and status), the budget, the strategy version and the state, and its strategy may plan cards in any project of the workspace.

*(The last clause reads "sits above projects" the way the old Goal row implied. The lead confirms it.)*

**R14 — profile decay: a §4 row and a criterion** (HD2:481). Add to §4:
> | Profile statements decay without new evidence | not-built | reinforcement raises a statement's strength (`learning/store.ts:300-327`) and nothing lowers it; `DECAY` applies only to rule values (`store.ts:53`, `:134`, `:269`) | P6 |

and to §5 P6:
> - **PM-P6-n** WHEN a profile statement has received no new evidence since its strength was last set THE SYSTEM SHALL lower its strength by the decay rule of §2.13.3 when the profile is next rebuilt, and SHALL record the new strength with the evidence it rests on.

*(Checked in the code: the strength only ever rises.)*

### `docs/design/specs/design-stage.md`

**R15 — §2.7 rule 2: `llms-full.txt`** (HD2:96). Replace
> local documentation and `llms.txt` per dependency version;

with
> local documentation (docsets and offline bundles the person installed) and `llms.txt` and `llms-full.txt` cached per dependency version;

**R16 — §2.7 rule 3: ambiguity in the brief** (HD2:105). Replace
> restate the question as a brief (what counts as an answer, what is out of scope);

with
> restate the question as a brief (what counts as an answer, what is out of scope) — an ambiguity is resolved in the brief or raised to the person as a question, never guessed at during gathering;

**R17 — §9: why a hosted search key is allowed** (HD2:114). Add:
> - **Why a hosted search provider is allowed:** the old design required a self-hosted SearXNG with no query logging to a third party. Many people will not run a separate service, and papers, page reads and GitHub work without one, so a Brave or Tavily key is allowed as the person's own choice. The Integrations card says that provider sees the queries, and SearXNG stays the private option.

*(A proposed reason. The lead confirms it, or rules the provider back to SearXNG only.)*

### `docs/design/specs/surface.md` — §9 Evidence and rationale

**R18 — why the qualification is offered, not run** (HD2:217). Add:
> - **Why onboarding offers the qualification instead of running it:** the old design ran the qualification suite during onboarding. On the reference host that loads each model in turn and takes minutes to hours, which the first run must not spend without asking. It is offered (rule 11), and the Configuration page runs it with the benchmark when a person asks ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O2).

### `docs/design/DECISIONS.md` — DEC-22, rejected techniques

**R19 — persona and politeness** (HD2:453). Replace the row label
> Persona prompting for quality ("you are a senior engineer")

with
> Persona and politeness prompting for quality ("you are a senior engineer", "please")

### `docs/reference/PROVENANCE.md` and `docs/reference/OPEN_QUESTIONS.md` — stale after DEC-29 O5

**R20** (HD1:135 note; the same staleness reaches every visual-gate row). In PROVENANCE's Licences table:
- Browser automation (playwright): replace "adding the library is a proposal awaiting the owner (ruling R16)" with "**approved 2026-09-24** (DEC-29 O5); not yet added".
- Accessibility engine (axe-core): replace "proposed as an unmodified development dependency, awaiting the owner" with "**approved 2026-09-24** (DEC-29 O5) as an unmodified development dependency; use inside the product's visual gate is owner decision O27 (default: not in v1)".

In OPEN_QUESTIONS, Research gaps, row "Layout-defect detection": replace "Playwright and axe-core are proposals awaiting the owner" with "Playwright and axe-core approved (DEC-29 O5); axe-core in the product gate is O27".

### `docs/design/specs/gates.md` — §2 rule 3 (layer table)

**R21 — coverage delta is Later** (HD1:504; not a status error). The Robustness row lists "coverage delta" as a v1 check while §7 defers it. Change the Robustness checks cell to
> Diff-scoped mutation scores (suite and acceptance-test, rule 32); coverage delta later (§7)

### `docs/reference/DESIGN_TRACE.md` — trace-level changes these corrections imply

**R22.**
- **§1 definitions.** Add to `carried`: "and the capability is built — a spec'd capability with a `not-built` or `partial` state is `gap`, with its change ID". This settles audit observation 3 the way the brief reads §1.
- **§1 totals**, for these three sources: `carried` −84 (72 to `gap`, 11 to `deliberate`, 1 to `later`), `gap` +72, `deliberate` +11, `later` +1.
- **§3.** Add INV:O53 to the context list.
- **§4.** Add the 11 new `deliberate` rows with the "reason recorded in" cell each row's New location gives.
- **Kernel map.** Apply the kernel renumbering map above to every row outside this scope (the PMFE rows) whose Now-in still equals its raw trace note.

## Totals

| | Rows |
| --- | --- |
| Population (these three sources, `carried` or `gap`) | 1,354 |
| **Rows checked** | **680**: 431 in the full check, 210 in the sample, 39 in the kernel pointer sweep |
| **Rows corrected** | **151**: 85 from the full check (19.7% of 431), 27 from the sample, 39 from the sweep |
| – `carried` → `gap` | 72 (71 unbuilt, plus HD2:481) |
| – `carried` → `deliberate` | 11 |
| – `carried` → `later` | 1 (INV:O53) |
| – status label unchanged | 67 (58 `carried`, 9 `gap`): 42 wrong locations (40 of them kernel renumbering alone), 7 stale notes, 11 lost precision (restore the text and keep `carried`), 7 `gap` rows needing an EARS criterion |
| **Restorations needed** | **21 spec or reference edits** (R1–R21) in 12 files: `kernel.md` 4, `models.md` 2, `worker-loop.md` 3, `integrations.md` 2, `context.md` 1, `planner-pm.md` 2, `design-stage.md` 3, `surface.md` 1, `DECISIONS.md` 1, `PROVENANCE.md` and `OPEN_QUESTIONS.md` 1, `gates.md` 1. They cover 27 row keys. **Plus R22**, the trace-level changes |
| Sample error rate (210 unflagged `carried` rows) | 27 / 210 = 12.9% (95% CI 8.6%–18.2%); status errors 21 / 210 = 10.0% (6.3%–14.9%) |
| Estimated errors left in the 923 − 210 = 713 unchecked unflagged rows | about 12.6% ≈ 90 rows, 9.7% ≈ 69 with a wrong status; most are the unbuilt-capability class, concentrated in the inventory rows (21.4% of that stratum) |

*Where the rows stop:* all 431 flagged rows and all 210 sampled rows have been checked. The kernel sweep covers every in-scope row that cites a kernel rule number. The remaining 713 unflagged `carried` rows were not checked one by one. The fastest next pass is the inventory rows whose note ends "— agree" or "spec-stricter": compare each with its owning spec's §4 state, because that is where the sample found most errors.
