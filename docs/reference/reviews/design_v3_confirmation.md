# Design v3 — confirmation review

*Reviewer: a separate Claude Opus 5.5 instance, acting only as critic; I wrote none of this design. Read-only: I edited no document except this one, ran no pnpm, tsc or vitest, and used no sub-agents. The tree was commit `8b5ccb9`. When the review began, the only uncommitted change was one row in `docs/README.md` that indexes this file. While it ran, others edited the tree in parallel:
- DESIGN_TRACE was rewritten (now 2,496 lines).
- planner-pm gained NEW-planner-pm-8, and COVERAGE its row, so there are now 99 `NEW-*` IDs.
- DECISIONS gained ruling R29.
- There were small edits to PM_CONTRACT §6 and dashboard §2.11.

**B1 is judged from DESIGN_TRACE's state at the end of this review.** Every other finding is judged from the text as I read it. Findings that the parallel edits may have touched say so.*

*Method: I re-checked each finding of [design_v3_review.md](design_v3_review.md) against the current text of SPINE, DECISIONS (DEC-25 to DEC-28), NAMING, PM_CONTRACT, OPEN_QUESTIONS (O1–O14), MODERNIZATION_PLAN, COVERAGE, DEFINITION_OF_DONE, DESIGN_TRACE and all fifteen specs. I checked cross-references mechanically:*
- *All `NEW-*` IDs in spec front matter appear in COVERAGE, and COVERAGE has none the specs lack. There were 98 at `8b5ccb9` and 99 after the parallel NEW-planner-pm-8.*
- *Every `O<n>` a document cites exists (O1–O14).*
- *Every `DEC-<n>` a document cites exists. Three anchors are broken (n7).*
- *No criterion ID is defined twice. Seven cited IDs are defined nowhere (n8).*
- *Every EARS criterion in §5 of every spec has an ID.*

*I also spot-checked twelve new "State today" claims against the code, and all held: `DEFAULT_TIER_BUDGET` 32,768, `defaultStepBudget` 40, card-record step budget 50 and eval 50, `ModelEntry.family` unread, `unpark` always to Ready, decisions resume to Backlog or Planning, the static Review fallback of 3, the Node check accepting any 22.x, `PROMPT_ZONE_BUDGETS` 1,000/2,000, zone fractions 0.12/0.10/0.50/0.20, `cardKind()` re-derived from labels, title and keywords, and 18 `CARD_STOP_REASONS`.*

Severity follows the first review:
- **Blocker**: the design is not ready for spec-driven development (DoD §5.2 or the plan's A.5 exit) until it is fixed.
- **Major**: a contradiction or gap that a workstream would trip over, or a criterion that cannot become a failing test.
- **Minor**: wording, numbering or staleness.

---

## 1. Resolution of the first review's findings

### Blockers

| # | Finding | Status | Evidence now / what remains |
| --- | --- | --- | --- |
| B1 | `DESIGN_TRACE.md` missing | **Partly resolved (most of it)** | *Judged at the end of the review. The committed version (693 lines) called itself "incomplete" and had 247 unchecked rows. It was rewritten while I reviewed.* Now:<br>- Every one of the 2,148 items is listed in §5 with where it lives: 1,663 carried, 188 gap, 166 deliberate, 131 later, none still open. The raw traces are in `trace_sources/`.<br>- §2 "Still open" is empty, and its last three rows were resolved (NEW-planner-pm-8, DEC-25 R29).<br>- All 31 row citations in the specs, including the 10 that did not resolve at `8b5ccb9`, now match a row. They are still plain text, not anchors.<br><br>What remains against plan exit 4:<br>**(a)** §3 lists 131 items moved to Later "for the owner to confirm", and some `deliberate` rows "rest on a recommendation that still awaits the owner". Exit 4 requires "every item not carried was decided by the owner", but no O-entry asks for that decision.<br>**(b)** The 723 rows that were not `carried` were re-read by "this verification", which the lead's process ran. The rows first classed `carried` (1,425) were only swept for later decisions, not re-read. Exit 4 also requires that "an independent review checked the trace against the old text"; that has not happened (this review did not re-read the old text).<br><br>Plan exit 4 is **not yet met**, but only the owner's confirmation and an independent sample check remain. |
| B2 | Rulings R1–R27 not in the repository | **Resolved** | DEC-25 tabulates R1–R28 with their owning specs, and marks R7 and R15 **owner** (→ O2, O3). Two things remain. The R-numbers collide with RESEARCH_REGISTER's R1–R12 (n12). R12 changes a behaviour the owner asked for but is not marked owner (**N10**). |
| B3 | Three card-kind vocabularies | **Resolved** | DEC-26 defines three stored fields, `kind`, `change` and `split`. NAMING has one label map. The fields are stored by kernel rule 6 (NEW-kernel-9, K-N9-1…5). planner-pm §2.2 and §2.16, gates rule 6b and §8 Q3 (decided), and models rule 31 all agree. Residue: DEC-26 fixes the three brownfield values as decided while O10 is open (n10), and three criteria cite research IDs that are defined nowhere (n8). |
| B4 | Step / turn / sample / attempt hierarchy | **Resolved (minor residue)** | DEC-26, NAMING "The run" and worker-loop §3 agree on attempt ⊃ sample ⊃ step. Residue (n1): worker-loop rule 5 says "the code's *step* is a synonym of step"; it should say *turn*. RUN-45 and RUN-46 (a user-facing trace view), EXT-31, surface's config comment, PM_CONTRACT §4 and OPEN_QUESTIONS #3 and #11 still say *turn*. Nothing says whether the step budget counts per sample or per attempt. |
| B5 | Zone 1 infeasible at W = 9,984 | **Resolved for Zone 1** | DEC-27 and context rule 10 cap Zone 1 at 2,400 tokens (700 system prompt, 1,700 tools). The worked example checks out: W′ = 7,584; Zone 2 = 758; Zone 3 = 3,792. CX-M1-3 and CX-N2-1…3 assert it on real prompts. **But** the fix moves the infeasibility to Zone 4, the whole step history (**N4**). It also sets a Zone 3 cap that disagrees with INVEST *Small* (**N5**). |
| B6 | Four admission rules, none able to fire | **Resolved structurally** | DEC-28 and measurement §2 rules 16a–16c give one table. context rule 24, planner-pm §2.13.2, extensibility and PM_CONTRACT §0 point to it. MS-N2-2 no longer uses 3 points. The rule it introduces has three new defects: context-version churn (**N1**), a loophole in "inconclusive → cheaper" (**N2**) and retirement by noise (**N3**). |
| B7 | Spine rule 2 changed before the owner decided | **Resolved** | O1 is first in the owner queue and blocks B3.1 and B3.3. Kernel rules 17 and 34 and §8 Q5 default to "nothing is erased": `erase` refuses and retention only reports. Runtime rule 33 makes pruning a recorded erasure. RUN-54 says replay names the gap. RUN-55 holds while O1 is open. |

### Major

| # | Finding | Status | Evidence now / what remains |
| --- | --- | --- | --- |
| M1 | Stop reasons outside the one table | **Resolved** | worker-loop rule 31 lists all 23 reasons, each with class, parks, resumable, may-verify, target and next action. There are seven failure classes plus a `success` class that holds `gate_passed`. WL-T3-9 and WL-T3-10 enforce it, and DEC-24 is updated. Stale sentence in worker-loop §9 (n5). |
| M2 | Workstream sizes and order not revised | **Partly resolved** | The allocator, curator, LSP, rename tool and MCP index moved to a new B4.0a, and T1/T2 with the change kinds to B4.0b, ahead of the gates work that needs them. There is now a "Needs first" column. What remains: B2.1 is still sized "M" with ten change sets (M1, M3, M5, M8, NEW-context-1/2, NEW-worker-loop-1/2/3/9). The code for M2 has no build workstream. T8 and T3 sit in B5 although earlier workstreams need them. NEW-gates-6 still depends on B4.3 and B4.4 output. NEW-review-git-4 is still in B4.3. See **N7**. |
| M3 | No owner-decision queue | **Partly resolved** | OPEN_QUESTIONS now has O1–O14 with the workstream each blocks and a default, and the plan applies the "does not start while open" rule. What remains: specs name owner decisions that are not in the queue. One sits on **B1's path**: security §8 Q1, cutting the `--validate-tools` execution path (plan rule 4: a cut needs the owner). The others: gates §8 Q5, Q6 and Q7 (B4.0b), models §8 Q1 `schedule.ts` (B4.0a), measurement §8 Q2 (inlet cuts, which MS-T8-8 needs signed off, B2.4) and Q4 (the M0 pivot), worker-loop §8 Q1 ("pending the owner's confirmation", B4.0a), planner-pm §8 Q1 (profile statements), and the owner confirmation of DESIGN_TRACE §3. The queue's "Blocks" column also disagrees with the plan (n17). |
| M4 | Evaluation assets unscheduled | **Resolved** | T11 has an asset table in measurement rule 29 (size, held-out part, users, workstream), a manifest, and MS-T11-1…6. B2.4 carries T11. The scheduling cost this creates is **N9**. |
| M5 | Criteria that are not failing tests | **Resolved** | PM-P6-13: at least 16 of 20 conversations. RG-P8-13: recall ≥ 0.3 on ≥ 20 defects with ≤ 1 false positive per card. WL-T3-6 and SUR-19 use a deterministic scripted-adapter replay. CX-N4-6 defines comparable cards and the credit. GT-N4-2 is exact: the one-sided upper bound on wrong fails is ≤ 5% on ≥ 60 screens, which I checked: 0/60 gives 4.9%, 1/93 gives ≈ 5.0%. MS-N2-2 is restated. CX-N6-2 names its mechanism. WL-M2-5 and GT-T2-4 are now system behaviour. DS-N2-9 has a statistic. |
| M6 | Criteria without IDs | **Resolved** | Every `THE SYSTEM SHALL` in the specs' §5 carries an ID, and there are no duplicates. |
| M7 | `unpark` to "previous state" | **Resolved** | Kernel rule 25 and K-N5-6, review-git §2.4, planner-pm §2.10.3 and PM-5, and DEC-24 all say: to Ready, or to Backlog or Planning if the card was parked from there. |
| M8 | `default_deny` parks at the request or at the deadline | **Resolved** | DEC-24, kernel rule 27, K-N5-2, planner-pm §2.10.3 and PM-6 all say it parks from the request. One stale sentence (n4). |
| M9 | Plugins cut, owner-pending or trust-gated | **Resolved** | Extensibility item 29 and EXT-5b say trust-gated with the cut pending O4. EXT-28 applies only if the owner cuts. security items 38 and SEC-28, and SPINE's `sdk` row, agree. Residue: the COVERAGE cuts table and DEC-09's "Cut:" list still name `container.ts` (n19). |
| M10 | A PR-on-accept card has no state | **Resolved** | Kernel rule 24 adds an `awaitingMerge` hold, kept out of the WIP count, with K-N3-3…5 and `card/pr_opened` / `card/pr_closed`. review-git §2.5.7 and RG-S5-15/16 agree. Wording residue in INT-12 and INT-14 (n16). |
| M11 | INVEST sized to 32k | **Resolved** | planner-pm §2.4 and PM-12, models rule 11 and DEC-24 all use 4,096 tokens on 16,384. The number now conflicts with DEC-27's Zone 3 (**N5**). |
| M12 | Project "complete" from cards | **Resolved** | The rollup yields `active` or `idle`. `done` comes only from `slice/accepted` (kernel rule 6, rule 30, K-N5-3 and K-N5-5). |
| M13 | Reviewer may be unfillable | **Resolved** | models rule 3 records every default's family, proposes Gemma-4-26B-A4B as the Reviewer with an alternate, and states what happens if none qualifies. The plan's risk table and RG-P8-10 agree. |
| M14 | Network key names | **Resolved** | surface item 24 owns `[network] mode`, `fetch_allow` and `fetch_deny`. design-stage, security item 28 and gates `network_allow` use those names. SUR-48, DS-N4-3/4 and SEC-12a test them. |
| M15 | PM_CONTRACT stale | **Partly resolved** | The new §0 table marks each shape current or target with its change ID (`assignee`, `externalRef`, the mutation token, the `cfd` keys, the PM with no runner, the Slack path, the rule lifecycle). §1 drops the model name. What remains: the shapes the board now needs are absent (card `key`, `kind`/`change`/`split`, the `awaitingMerge` hold). The `PmStatus.model` comment still says "dirk-27b". §6 still says "approved by a human before it takes effect" with no target row for probation or profile statements (n15, **N10**). |
| M16 | DoD carries reversed v1 rules | **Resolved** | §3B–§3D cite security, context and extensibility instead of restating them. §2B is decided (risk-based outside the core). Residue: gates §8 Q2 is not marked decided, and its recommended package set differs from the one the DoD records (n18). DoD §5.1 now conflicts with the change kinds (**N6**). |
| M17 | IX-6 in v1 | **Resolved** | IX-6 moved to gates §7 with its criterion kept. |
| M18 | ECLoop neither carried nor rejected | **Resolved** | worker-loop rule 29a and NEW-worker-loop-9 (WL-N9-1…4) add it as a switch with a threshold set in advance, register R12, built in B2.1 and run in B2.5. The comparison baseline is circular (n25). |
| M19 | No defaults for enforced budgets | **Resolved** | worker-loop §3 and gates §3 have defaults tables, each value with its source: step 40, seconds step × 70 s, find share 13 of 40, k = 8, `max_tool_applied_lines` 500, gate timeouts. Example copy still says "of 32" (n21). |
| M20 | Auto-accept recorded two ways | **Resolved** | review-git §2.5.6, RG-S5-8/9, kernel rule 19 and DoD §5.1.5 agree: a person's standing decision, named as principal, never in company-server mode. |
| M21 | Unavailable advisory gates block Review | **Resolved** | Kernel rule 27's `review` row says "no **blocking** gate was unavailable". |

### Minor

| # | Status | Note |
| --- | --- | --- |
| m1 | Resolved | worker-loop rules 37–40 are in order, and GT-T1-12 now precedes 13. New case: kernel K-N5-4 follows K-N5-6 (n24). |
| m2 | Resolved | context §8 Q1 is rewritten. Rule 12 and CX-M8-3 agree that 85% is the first tier to force a masking point. |
| m3 | Resolved | kernel §8 Q1 and integrations §8 Q2 are closed. |
| m4 | Resolved | Kernel rule 23 uses sentence case. |
| m5 | Resolved | The DEC-24 row reads 23 stored reasons plus a success class. |
| m6 | Resolved | The COVERAGE decision table shows outcomes, and M9 and M10 have rows. |
| m7 | Resolved | "Sixteen domains; a seventeenth added" matches "17 domains". |
| m8 | Partly resolved | surface 5a sets the floor at Node 22.13 (with kernel rule 35), but CLAUDE.md still says "Node 26 (20+ supported)" (n23). |
| m9 | Resolved | `sekhemet "<spec>"` now plans and runs, in both documents. |
| m10 | Resolved | DS-N1-4 says the first question is not the cap. |
| m11 | Resolved | planner-pm §2.5 says depth counts re-splits of one lineage. |
| m12 | Partly resolved | The prior of 4 applies from the first card (kernel rule 29, review-git §2.2.3). review-git still floors ReviewWIP at 1 in §2.2.1 but falls back to the static 3 when minutes ≤ 0 in §2.2.3 (n13). |
| m13 | Resolved | COVERAGE says retention is wired and waits on O1. |
| m14 | Resolved | SPINE marks `sdk` "cut pending the owner (O4)". |
| m15 | Resolved | DS-P14-4: the regulated profile claims no compliance. |
| m16 | Resolved | PM_CONTRACT §1 drops the model name and allows co-residency. The `PmStatus` comment residue is in n15. |

### Research coverage

| Item | Status | Evidence |
| --- | --- | --- |
| ECLoop evidence-gated commit (PROJECT_DONE_AND_DEPTH) | Resolved | worker-loop 29a, NEW-worker-loop-9, register R12 |
| Citation of PROJECT_DONE_AND_DEPTH in measurement and dashboard | Resolved | 4 citations in each |
| WORKER_METHOD implication 3 changed on purpose | Resolved | worker-loop §9 states the change and why |
| PM_RESEARCH_SYNTHESIS §2 step 2 (quantisation against harness) | Resolved | measurement 27a, OPEN_QUESTIONS benchmark 18. It needs a larger host and has no change ID, so it is carried but not scheduled |
| Spark-X2.5-4B | Resolved | NEW-models-11, B4.4 |
| `nebius/SWE-rebench-V2` not adopted | Resolved | measurement §8 Q3 gives the reason |
| IX-6 against the research's "later" | Resolved | gates §7 (M17) |

### Depth items 1–7

| # | Status | Note |
| --- | --- | --- |
| 1 Defaults | Resolved | M19 |
| 2 Context budgets | Resolved for Zone 1 | Zone 4 is not shown to fit (**N4**) |
| 3 Learning admission | Resolved structurally | **N1–N3** |
| 4 Reviewer bar and model | Resolved | RG-P8-13, models rule 3 |
| 5 Worker-level evidence gate | Resolved | M18 |
| 6 Re-plan output contract | Resolved | worker-loop 34.3 `RepairPlan`, the `card/repair_plan` dossier entry, WL-N5-5…7, CX-N3-5 |
| 7 Impacted tests before T2 | Resolved | gates rule 33, GT-N3-2 (full suite, stated in the evidence) |

### Plan items 1–7 and DoD §6.7

| Item | Status | Note |
| --- | --- | --- |
| 1 Effort and critical path | Partly resolved | A dependency column exists. There are still no card counts or elapsed time, no statement of what runs in parallel, B2.1 is undersized, and three items are unscheduled (**N7**) |
| 2 Machine time | Partly resolved | A budget exists, but it undercounts the A/Bs the specs require (**N8**) |
| 3 Owner-decision queue | Partly resolved | See M3 |
| 4 Evaluation assets as work | Resolved | T11 in B2.4. It is placed on the critical path (**N9**) |
| 5 Risk register | Resolved | Six risks, each with an early sign and a response |
| 6 Milestones the owner sees | Resolved | After B1, B2.5, B3, B4.4, B4.10 and C |
| 7 The frozen baseline | Resolved | The baseline `RunProfile` is recorded in SUITE_RUNS |
| DoD §6.7 — no single end-to-end criterion | Resolved | SUR-47 is §6.7 and runs last on the reference machine |

**Tally of the first review:**
- Blockers: 6 resolved, 1 partly resolved (B1).
- Major: 18 resolved, 3 partly resolved (M2, M3, M15).
- Minor: 14 resolved, 2 partly resolved (m8, m12).
- Other items: all 7 research items, all 7 depth items and DoD §6.7 resolved. Plan items 4–7 resolved; plan items 1–3 partly resolved.
- **Unresolved: none.**

---
## 2. New findings introduced or exposed by the fixes

### Blockers

**None new.** The only blocker still open is B1 (the trace), carried from the first review.

### Major

#### N1. The context version includes "the rules in force", so approving or retiring a project rule becomes a harness change and disqualifies the Worker
- **Evidence.**
  - context rule 27: "The prompt templates, **the rules in force** and the tool catalog are hashed together into one context version … A new version invalidates the affected models' qualification … a model with an invalidated qualification is not used as Worker without a recorded override."
  - CX-6: "WHEN the prompt templates, **rules** or tools change THE SYSTEM SHALL produce a new context version". CX-N6-1 invalidates qualification on any version change.
  - DEC-28 row 3 and measurement 16a list "**context version**" as a *harness change*, which the frozen-suite A/B admits.
  - DEC-28 row 1 and measurement 16a also say: "The frozen suite never admits a project rule". Rules are approved by a person (CX-N4-*) and retired automatically (CX-N4-6).
  - So the specs, read together, say a person's approval, or an automatic retirement, (a) needs a suite A/B and (b) disqualifies the Worker until it is re-qualified. CX-N6-2 hashes only templates, copy and tool descriptions, which is a second, incompatible definition of the same version.
- **Why it matters.** DEC-28 contradicts context (DoD §5.2.4), inside the learning mechanism the first review's B6 was about. As written, the playbook cannot operate without re-qualifying the Worker after every rule event.
- **Fix.** Split the version in two:
  - A **harness context version**: templates, copy module, tool catalog and schemas, allocator policy. It gates qualification (CX-N6-1), the A/B (DEC-28 row 3) and the release gate (CX-N6-2).
  - A **guidance version**: rules in force, exemplars and probationary lessons for the project. It is stamped on every pack and evidence record (CX-6) but invalidates nothing.

  Amend context rule 27, CX-6, CX-N6-1 and DEC-28 row 3 to say which one each means.

#### N2. "Inconclusive → adopt if cheaper or simpler" admits changes the suite cannot show are harmless, and needs no evidence that they are cheaper
- **Evidence.**
  - measurement 16c and MS-T8-13: "cheaper (lower median seconds per card, **or** tokens per card, over the paired runs)". There is no test, no margin, and either of two noisy metrics will do.
  - The companion condition "a one-sided exact test does not reject 'no loss' at 0.05" cannot fail for losses the suite cannot resolve. measurement rule 11 puts a paired test's power at 6–7% for a 10-point effect on 25–30 tasks, so a change that costs up to about 20 points usually passes.
  - DEC-28's closing sentence claims "No admission rule relies on an effect the measurement cannot resolve", but this one relies on the absence of such an effect.
  - context rule 21a and CX-N6-2 make this verdict the release-gate path for every prompt change, so in practice nearly any prompt edit ships as "not established — cheaper".
- **Fix.**
  - Before the run, choose **one** cost metric (seconds per card).
  - Require a paired test on it (for example a Wilcoxon signed-rank test at 0.05, per card) with a stated minimum saving (for example ≥ 10%).
  - Make "simpler" a checkable diff property: net lines removed, and no added switch, tool or prompt token.
  - Record in every "not established" verdict the smallest loss the run could have detected, as MS-M12-2 already does for gains.

#### N3. Retirement on "credit below zero" over a rolling 10 pairs retires helpful rules by chance
- **Evidence.**
  - measurement 16b and CX-N4-6: "WHEN the credit is below zero THE SYSTEM SHALL retire the rule automatically", evaluated after every new pair over the last 10.
  - I computed the exact probability at a single evaluation. A rule that raises a class's pass rate from 70% to 80% (+1 with probability 0.24, −1 with probability 0.14 per pair) is retired **21.6%** of the time. A neutral rule at 70% is retired 40.3% of the time. A harmful rule (80% → 70%) is caught only 60.4% of the time.
  - Because the window rolls, a helpful rule faces that 22% about once per new pair, so over a few dozen pairs it is very likely retired.
  - 16b's defence ("a rule with no real effect will sometimes retire … the credit only has to catch rules that hurt") covers neutral rules, not helpful ones. The statistic separates helpful from harmful little better than a coin.
  - Retirement is also a *harness-side* reversal of a person's approval (see N10).
- **Fix.** Evaluate on non-overlapping blocks of 10 pairs, and retire only when a one-sided sign test on the discordant pairs rejects "no harm" at 0.10. In the numbers above, a credit of −3 or lower catches a 10-point harm 22% of the time per block and retires a 10-point help 3% of the time. Keep probation's "withdraw at first negative" only within one run. Update MS-T8-14's scripted case to match.

#### N4. Zone 4 must hold the whole step history, but no worked example shows it fits
- **Evidence.**
  - DEC-27's worked example leaves Zone 4 at least 7,584 − 758 − 3,792 = **3,034 tokens**. Zone 4 holds "the volatile tail and the step history" (context rule 10).
  - The history's standing contents:
    - Every assistant tool-call message, which is never masked. Rule 3 masks only observations. At ~80–150 tokens a step, a 40-step attempt (the default, WL-T3-11) accumulates 3,200–6,000 tokens of calls alone.
    - A ~15-token pointer per masked observation.
    - "The five most recent observations" in full (rule 3), each up to the clamp of 2,400 + 1,200 characters, about 1,200 tokens at the measured ~3.0 characters per token (NEW-context-1). That is up to ~6,000 tokens.
    - Under `surgical` or `all`, earlier reasoning sent back (CX-M8-5), up to 2,048 tokens per thinking step, removable only at a masking point (rule 4).
  - With k = 8 (worker-loop defaults), the 85% and 90% tiers, not the schedule, will cause most masking points late in an attempt. That is the prefix churn M8 exists to remove, and it works against CX-M8-7's median hit rate of ≥ 0.85. Or the step reaches 95% and ends with `budget_exhausted` before the step budget is spent.
  - CX-N2-3 checks only "first, repair and post-masking steps", with a Zone 4 floor of 1,517 that can never fail (n2), so no criterion would catch this.
  - Related: WL-M3-1 sizes each request's prompt by *that request's* thinking cap. Under `surgical`, W then moves between 12,032 (no thinking) and 9,984 (thinking) from one step to the next. A prompt that fit a non-thinking step must be trimmed on the thinking step after a failure, exactly where the cache matters.
- **Fix.**
  - Add a Zone 4 worked example for a 40-step attempt at W = 9,984: per-step call tokens, observation tokens, thinking policy.
  - State "the most recent observations" as a token budget, not a count.
  - Say whether preserved thinking is clipped, or stripped at every masking point.
  - Fix W per attempt at the largest thinking cap the policy can request.
  - Extend CX-N2-3 to the last step of the longest recorded attempt of each fixture, asserting the history fits without an out-of-schedule masking point, or recording how many were forced.
  - If it cannot fit, lower the default step budget or k with the measurement that shows it.

#### N5. INVEST *Small* (4,096 tokens of "context pack") and DEC-27's Zone 3 (3,792) are two different numbers for one check, and the check sits at an entry condition kernel does not list
- **Evidence.**
  - planner-pm §2.4 and PM-12 refuse "a card whose pack exceeds 4,096 tokens". "Context pack" is defined only in kernel rule 6, as the *whole* request ("the exact system prompt, prompt, tool names…").
  - Read that way, every real card fails: Zone 1 alone is 2,400, and today's median prompt is 7,563.
  - Read as the card's own material, 4,096 exceeds Zone 3's cap of 3,792. A card can then pass INVEST and be refused by CX-N2-2 "at the `ready` entry condition" — a condition that is not in kernel rule 27's `ready` row ("acceptance criteria or tests present; every dependency done").
- **Fix.**
  - Define INVEST *Small* as "the card's Zone 3 content fits Zone 3's cap at the resolved Worker's W (3,792 tokens at the reference), measured by the allocator". That makes one number and one owner (DEC-27).
  - Add the row to kernel rule 27.
  - Update PM-12, models rule 11 and DEC-24's INVEST row.

#### N6. DEFINITION_OF_DONE §5.1 contradicts the change kinds and the tool-applied bound
- **Evidence.**
  - DoD §5.1.1: a card is done only if "its acceptance tests were staged and **failed** before any work (red first…)".
  - gates rule 6b: a `characterize` card is **green** on the base ("green on base is the card's proof"). A `refactor` card has "no new behaviour tests". An `upgrade` card is a package-manager step. O10's default ships all three in v1.
  - DoD §5.1.2: "its diff is at most 200 lines across 1–3 files". gates rule 12 and GT-BF-3, with WL-N6-1, count tool-applied lines (a rename across fourteen files) against a separate `max_tool_applied_lines` of 500.
  - Under the DoD, no brownfield card can ever be done.
- **Fix.**
  - §5.1.1: "its acceptance tests met the red/green rule of its `change` ([gates](../../design/specs/gates.md) rule 6b) before any work".
  - §5.1.2: "hand-written diff at most 200 lines across 1–3 files; lines applied by a declared mechanical tool within their own bound".

#### N7. Four items the early workstreams depend on have no build workstream
- **Evidence and consequence.**
  - **(a) M2's code.** WL-M2-1…5 (`CLASS_TOOLS` for every class, a fixed array of ≤ 12 tools for `implement`, the losing arm unreachable) is carried only by B2.5, and B2.5's size is "machine time". B2.1's CX-M1-3 and DEC-27 assume "a fixed, flat tool set per card class, M2" to fit 1,700 tokens, while `implement` today falls through to all 28 tools. B2.5 cannot run an arm nobody built.
  - **(b) T8, the admission mechanism** (MS-T8-1…14, the DEC-28 table). It is in B5, "never on its own". But B2.5's ECLoop verdict (rule 29a applies MS-T8-13), B4.0a's rule credit (CX-N4-6 calls MS-T8-14) and the release-gate check CX-N6-2 all read its verdicts. T8 is not structure; it is the core's learning rule.
  - **(c) T3, the one stop-reason table**, is also in B5. B1 (SEC-2 `git_metadata_tampered`), B2.3 (`gate_suspected`) and B3.3 (`crashed`, RUN-9) each add a reason to it. The plan should say which workstream creates the table.
  - **(d) NEW-gates-6 (B4.0b)** reads the depth profile (rule 32a; P14, built in B4.4) and routes test gaps to the test-author step (GT-TQ-5; P1, built in B4.3). Both are built after it.
  - **(e) The RunProfile is specified twice.** NEW-surface-5 (SUR-44/45, B3.3) specifies the same `RunProfile` as MS-M9-4/5 (B2.4), and B2.5 freezes it. Plan exit 2 requires each to say which part it carries.
- **Fix.** Put WL-M2-1…4 in B2.1 (build both arms), T8 in B2.4, and name T3's first builder (B1). In NEW-gates-6, state the default profile until P14 exists and "route to a person" until B4.3. Mark SUR-44/45 as surface's CLI-layer share of MS-M9-4/5.

#### N8. The machine-time budget undercounts the paired runs the specs require
- **Evidence.**
  - Plan, *Machine time*: "every later workstream that touches the loop, context, gates, models, sandbox or runner, **one confirmation run**".
  - But context rule 21a and CX-N6-2 let a change to the prompt templates, copy module or tool descriptions ship only with a paired A/B. measurement 16c requires "at least two paired runs per arm": four runs, about eight machine-hours at about two hours per 30-card run.
  - B4.0a (the allocator changes every prompt; `rename_symbol` changes the tool catalog), B4.0b, and NEW-worker-loop-6/7 each change the harness context version.
  - B2.5's "about two machine-days" omits:
    - the MTP A/B (M7, M11 in B2.2);
    - the choice of masking interval among k = 4, 8 and 16 (context §8 Q1);
    - the exemplar A/B (CX-M1-7);
    - the M8 cache run (CX-M8-7).
  - MS-N3-1 allows at most two register adoptions "per phase", and Phase B is one phase containing every workstream.
- **Fix.**
  - Add a column to the Phase B table: the A/Bs each workstream must run and the runs they cost.
  - Re-total B2.5 and Phase B.
  - Define "phase" for MS-N3-1 (recommend: B2, B3 and B4 each count as one).

#### N9. The evaluation assets put the owner's labelling time in front of the baseline
- **Evidence.**
  - measurement rule 29 schedules all ten assets in B2.4, which gates B2.5, and B2.5 gates B3 and B4.
  - Only the reference solutions, golden briefs and held-out suite serve B2.5 and T7. The reuse set (P7, B4.5), seeded defects (P8, B4.8), PM conversations (P6, B4.8), UI screens (GT-N4-2), research golden set (B4.4) and project starts (P2, B4.4) are first used in B4.
  - MS-T11-4 refuses any label "whose only source is a model", so every label is a person's work.
  - The same rule 29 says "each built before the first criterion that uses it".
- **Fix.**
  - B2.4 builds only the assets B2.5 and T7 use.
  - Each other asset moves to the workstream just before its first user.
  - The plan states the person-hours of labelling per asset.

#### N10. A lead ruling reverses a learning rule the owner asked for, and it is not in the owner queue
- **Evidence.**
  - PM_CONTRACT §6: "The user asked that both the Worker and Seshat get better over time … Everything learned is: … **approved by a human before it takes effect**."
  - DEC-25 R12 (not marked **owner**) and DEC-28 row 2 apply execution-verified lessons in production **without** approval.
  - DEC-28 row 1 retires a person-approved rule **automatically**, where PM_CONTRACT §6 had "proposed for retirement".
  - planner-pm §8 Q1 recommends that profile statements take effect at once. DESIGN_TRACE PMFE:217 records that as "awaiting the owner", but no O-entry exists.
  - DEC-25 says rulings "that change behaviour a person sees … wait for the owner's confirmation".
- **Fix.**
  - Mark R12 **owner**.
  - Add O-entries, with R12's current behaviour as the default until the owner decides: (i) in-run probation without approval, (ii) automatic retirement of an approved rule, (iii) profile statements used at once.
  - Add a PM_CONTRACT §0 target row for each.

### Minor

- **n1.** Leftover uses of *turn* after B4:
  - worker-loop rule 5 says "the code's *step* is a synonym of step"; it should say *turn*.
  - RUN-45 and RUN-46 ("the turn's span"; a trace view people see), EXT-31 ("next model turn"), surface's config comment ("max turns (model requests) per sample"), PM_CONTRACT §4 ("after every Worker turn") and OPEN_QUESTIONS #3 and #11 still say *turn*.
  - No document says whether the step budget counts per sample or per attempt. surface says per sample; DEC-26 does not say.
- **n2.** The worked example in context rule 10 says Zone 4 is "≥ 1,517 (3,034 when every other zone is full)". This is backwards. With Zone 2 ≤ 0.10W′ and Zone 3 ≤ 0.50W′, Zone 4 is never below 0.40W′ = 3,034. So the 0.20W′ floor never binds, and CX-N2-3's "Zone 4 ≥ 1,517" can never fail.
- **n3.** context rule 12 ends a step at 95% pressure with `budget_exhausted`. The next action for that reason in worker-loop rule 31 is about steps ("raise it for the class or split the card"). The table has no context-overflow reason.
- **n4.** planner-pm §2.10.3 still says "where DEC-24's row and kernel rule 27 say 'at its deadline', this reading is the one that holds". Both now say "from the request".
- **n5.** worker-loop §9 still says "six stop reasons became eighteen stored in seven classes (DEC-24)". DEC-24 now says 23 reasons plus a success class.
- **n6.** *(Fixed during the review.)* The committed DESIGN_TRACE listed three "still open" rows (PMFE:432, PMFE:440, INV:X21) that the specs had already resolved. The rewritten trace lists none open.
- **n7.** Three broken anchors. The headings are `DEC-22 — rejected techniques` and `DEC-28 — one rule…`, so these links do not resolve:
  - `DECISIONS.md#dec-22`, in planner-pm §2.16 item 5 and design-stage §2 item 8;
  - `DECISIONS.md#dec-28`, in planner-pm §2.13.2.
- **n8.** Seven criterion IDs are cited but defined nowhere. They are research-document IDs that the specs renamed (to PM-P1-17…19, PM-N7-*, SUR-35…38):
  - `PM-TQ-1`, cited in gates rule 5;
  - `PM-TQ-2`, `-3`, `-4` and `-8`, and `PM-BF-1`, cited in planner-pm;
  - `SUR-BF-1`, cited in surface.
- **n9.** DECISIONS says "newest first within each group", but the engineering group runs DEC-25…28, DEC-20, DEC-24, then 21–23. DEC-12…19 do not exist; say so, so no one looks for them.
- **n10.** DEC-26 states `characterize`, `refactor` and `upgrade` as decided values while O10 (whether they ship in v1) is open. Suggested wording: "the enumeration is fixed; which values ship is O10".
- **n11.** DEC-28 and context rule 24 say "its last 10 **applications**". measurement 16b and CX-N4-6 say "its last 10 **pairs**", and each pair is two applications.
- **n12.** The ruling numbers R1–R28 collide with RESEARCH_REGISTER's R1–R12. For example, worker-loop's "register R12" is ECLoop, while measurement §9's "ruling R12" is probation. Prefix the rulings (DEC-25.R12).
- **n13.** review-git §2.2.1 floors ReviewWIP at 1. §2.2.3 keeps the static 3 when `review_minutes_per_day ≤ 0`. Kernel rule 29 says the prior replaces the static 3. Pick one.
- **n14.** planner-pm §2.13.3 still has "all projects (`~/.config/sekhemet`)", against NEW-surface-1's `~/.sekhemet/`. planner-pm §8 Q2 is still open, though PM_CONTRACT §3 already names `pm/proposal_state`.
- **n15.** PM_CONTRACT §0 lacks the card `key` (kernel rule 5), `kind`/`change`/`split` (NEW-kernel-9) and the `awaitingMerge` hold (kernel rule 24), all of which the board reads. The `PmStatus.model` comment still says `"dirk-27b"`.
- **n16.** INT-12 opens the pull request "against the repository's default branch", but gates rule 16 and review-git use the configured integration branch. INT-14 says "return the card to Review" for a card that never left Review; only its hold is cleared.
- **n17.** The owner queue disagrees with the plan's "Needs first" column:

  | Decision | OPEN_QUESTIONS says it blocks | The plan says |
  | --- | --- | --- |
  | O8 | B4.9 | B4.10 |
  | O10 | B2.3 | B4.0b (B2.3 no longer carries change kinds) |
  | O11 | B4.9 | B4.10 |
  | O14 | B3.3 | not listed |

  Also, OPEN_QUESTIONS "Design questions still open" still says retention is "decided with `retention.ts` wire-or-cut (DEC-09)", and its spine row duplicates O1 without linking to it.
- **n18.** DoD's version line still reads "3, 2026-09-22" after the §2B and §3 changes of 2026-09-24. gates §8 Q2 is not marked decided. Its recommendation (gates, kernel, security) is not the package set the DoD recorded (kernel, sandbox, sync, gates, loop, context).
- **n19.** COVERAGE's "Cuts needing sign-off" still lists `container.ts` as "Reachable only from a test — Cut", and DEC-09's "Cut:" sentence still names it. DEC-09's own correction and O4 contradict both.
- **n20.** MODERNIZATION_PLAN says "the 95 further changes". The specs and COVERAGE carry 99.
- **n21.** dashboard §2.4 ("Step 5 of 32") and NAMING ("*8 of 32 steps*") use 32, but the one default is 40 steps (WL-T3-11).
- **n22.** SPINE's journey diagram sends "send back" to *Worker builds*. DEC-24 and kernel rule 25 send it to Ready.
- **n23.** CLAUDE.md says "Node 26 (20+ supported)". surface 5a and kernel rule 35 make 22.13 the floor.
- **n24.** kernel lists K-N5-4 after K-N5-6.
- **n25.** worker-loop 29a compares ECLoop "against the B2.5 baseline RunProfile", but the arm runs inside B2.5 to set that baseline. Say it is compared against B2.5's other winning settings, and that the frozen baseline records its verdict.

---
## 3. Readiness per spec against DEFINITION_OF_DONE §5.2

§5.2 has four tests:
1. front matter and "State today" agree with the code;
2. every gap has a change ID;
3. every criterion is EARS and can be a failing test;
4. no contradiction with another spec, DECISIONS or SPINE, and every open question carries a recommendation.

For test 1, I spot-checked twelve claims (listed in the header), and every one held. Test 2 holds for every spec: all 99 `NEW-*` IDs and every S/M/P/T ID are in COVERAGE. "Nearly" means only minor or cross-document fixes stand between the spec and §5.2.

| Spec | §5.2.1 | §5.2.2 | §5.2.3 | §5.2.4: what still fails | First workstream | Ready? |
| --- | --- | --- | --- | --- | --- | --- |
| security | held | yes | yes | Unqueued owner cut of `--validate-tools` (M3). It is avoidable: S3a can confine the path instead of cutting it | **B1** | **yes**, once the `--validate-tools` choice is stated |
| extensibility | held | yes | yes | none beyond O4, which is queued | B0, B3.3 | **yes** |
| worker-loop | held | yes | yes | M2's code unscheduled (N7a); history budget (N4, shared with context); rule 5 typo, §9 stale sentence, unqueued §8 Q1 (n1, n5, M3) | B2.1 | nearly |
| context | held | yes | yes | Context version against DEC-28 (**N1**); Zone 4 not shown to fit (**N4**); Zone 3 against INVEST and the missing `ready` entry condition (**N5**); the Zone 4 floor (n2); the 95% stop reason (n3) | B2.1 | **no** |
| gates | held | yes | yes | DoD §5.1 against rule 6b and rule 12 (**N6**, fixed in the DoD); NEW-gates-6 ordering (N7d); §8 Q2 not closed, Q5–Q7 unqueued (n18, M3); `PM-TQ-1` citation (n8) | B2.3 | nearly |
| kernel | held | yes | yes | Needs the Zone 3 `ready` row (N5); K-N5 order (n24) | B3.1 | nearly |
| models | held | yes | yes | `schedule.ts` owner item unqueued (M3); rule 11's 4,096 follows N5 | B2.2 | nearly |
| measurement | held | yes | yes | The inconclusive rule (**N2**); retirement statistic (**N3**); T8 unscheduled (**N7b**); T11 on the critical path (**N9**); "phase" undefined (N8) | B2.4 | **no** |
| planner-pm | held | yes | yes | INVEST *Small* (**N5**); probation and profile statements not queued (**N10**); stale §2.10.3 sentence, `~/.config` and §8 Q2 (n4, n14); broken anchors and dangling IDs (n7, n8) | B4.3 | **no** |
| design-stage | held | yes | yes | Broken `#dec-22` anchor (n7) | B4.4 | nearly |
| review-git | held | yes | yes | ReviewWIP floor against the static 3 (n13) | B3.2 | nearly |
| dashboard | held | yes | yes | Examples say 32 steps (n21); P12 and §6.4 wait on O5 (queued) | B4.2 | nearly |
| integrations | held | yes | yes | INT-12 branch wording and INT-14 (n16) | B4.9 | nearly |
| runtime | held | yes | yes | *Turn* in RUN-45/46 (n1) | B3.1, B3.3 | nearly |
| surface | held | yes | yes | SUR-44/45 duplicate MS-M9-4/5 (N7e); config comment says "turns … per sample" (n1) | B3.3 | nearly |

Cross-document items outside the specs: DoD §5.1 (N6); the plan (N7, N8, N9, n20); OPEN_QUESTIONS (M3, N10, n17); DECISIONS (N1, N2, n9–n12); DESIGN_TRACE (B1).

---

## 4. Verdict

**The design is not yet ready to declare Phase A.5 complete.**
- Plan exit 1 (every spec meets §5.2) fails for context, measurement and planner-pm.
- Plan exit 4 (nothing lost) is not yet met. DESIGN_TRACE now lists every item, but the owner has not confirmed the Later and deliberate rows, and no independent check of the trace against the old text has been made.
- I could not check exits 3 and 5 without running anything. `docs.spec.ts` does contain the SPINE status-table test.

**Every blocker from the first review has been addressed except B1, and the fixes introduced no new blocker.** What remains is either outside the documents (the trace, and one owner decision) or belongs to workstreams after B1. So the path to B0 and B1 is short.

**Must change before B0 starts:**
1. **Close plan exit 4 on DESIGN_TRACE.** The rewrite during this review listed all 2,148 items, left none open and made every spec citation resolve. Two things remain:
   - Put the §3 Later list (131 rows), and the `deliberate` rows that rest on a recommendation awaiting the owner, to the owner as one O-entry: confirm all, or name exceptions.
   - Have an independent reviewer check the trace against the old text on a random sample. Recommendation: at least 100 of the 1,663 `carried` rows, stratified by source, with zero misclassifications allowed at that size; or re-read every row if any is found.

   Making citations anchors is optional.
2. **The owner decides O4** (the plugin container and SDK cut): B0's "Needs first".
3. **Queue the owner decisions the specs already name** (M3, N10): security §8 Q1, gates §8 Q5–Q7, models §8 Q1, measurement §8 Q2 and Q4, worker-loop §8 Q1, planner-pm §8 Q1, R12's probation and automatic retirement, and the Later list. Correct the "Blocks" column so it matches the plan (n17). For B1 itself, only security §8 Q1 matters, and B1 can avoid it by confining `--validate-tools` under S3a rather than cutting it.

**B1 can then start.** security and extensibility meet §5.2 once the `--validate-tools` choice is written into security.

**Must change before the named later workstream starts.** Each is a document edit, and doing them in the same pass is cheapest:

| Before | Fix |
| --- | --- |
| **B2.1** | N4 (a Zone 4 worked example for a 40-step attempt, W fixed per attempt, a token budget for recent observations, CX-N2-3 extended to last steps); N5 (INVEST *Small* equals the Zone 3 cap; add the kernel `ready` row); N7a (WL-M2-1…4 built in B2.1); n2, n3 |
| **B2.4** | N2 (the inconclusive rule gets a test and a margin); N3 (block-wise retirement with a sign test); N7b (T8 moves into B2.4); N9 (T11 split by first user, with person-hours); N8's definition of "phase" |
| **B2.5** | N8 (count the A/Bs and re-total machine time); n25 (what ECLoop is compared against) |
| **B3.1** | n24; N7c (the stop-reason table's first builder is named, and B1's `git_metadata_tampered` is added to it) |
| **B4.0a** | N1 (split harness and guidance versions in context rule 27, CX-6, CX-N6-1 and DEC-28); N10 (owner answers on probation and automatic retirement, or their defaults recorded) |
| **B4.0b** | N6 (DoD §5.1.1–2 follow `change` and the tool-applied bound); N7d (a default depth profile; test gaps routed to a person until B4.3) |
| **Any time** | The minor items n1, n4–n23 |

**Counts.**
- Of the first review's findings:
  - blockers: 6 resolved, 1 partly resolved;
  - major: 18 resolved, 3 partly resolved;
  - minor: 14 resolved, 2 partly resolved;
  - research, depth and DoD §6.7 items: all resolved;
  - plan items: 4 resolved, 3 partly resolved;
  - unresolved: none.
- New findings: **0 blockers, 10 major (N1–N10), 25 minor (n1–n25).**
