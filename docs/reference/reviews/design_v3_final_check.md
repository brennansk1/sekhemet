# Design v3 — final check

*Reviewer: a separate Claude Opus 5.5 instance, acting only as critic. I wrote none of this design. I read only; I edited no document except this one, ran no pnpm, tsc or vitest, and used no sub-agents. The only commands I ran were `git`, `grep`, `sed`, `awk`, and one Python calculation of the DEC-28 and Clopper–Pearson figures. While I worked, someone else added a row to `docs/README.md` indexing this file. I did not touch it.*

*Scope: `git diff 8b5ccb9..20dc4eb -- docs DEFINITION_OF_DONE.md CLAUDE.md README.md AGENTS.md`, which is one commit: "owner decisions, confirmation review fixed, trace complete". It changes 29 files. I read the whole diff except the `DESIGN_TRACE.md` rewrite. For the trace I checked the header, §2–§4, and five randomly sampled `carried` rows against the old text. Where the diff depended on text around it, I read that text too.*

*What I checked mechanically:*
- *Every criterion ID cited in the added lines is defined. The only exceptions are research-document IDs that are now labelled as such (`research TESTS_BROWNFIELD PM-TQ-1` and the like).*
- *No criterion ID is defined twice.*
- *The 106 `NEW-*` IDs in COVERAGE and in the specs' front matter are the same set.*
- *Every cross-reference I followed resolves: models rules 20a, 20b and 27a; MD-N4-4; review-git §2.3.7; planner-pm §2.15.8; runtime 34b; K-N7-1, K-N7-6 and K-N7-8; CX-M1-3; measurement rules 9a and 14.*
- *No bare `#dec-NN)` anchor is left.*
- *The `docs.spec.ts` front-matter parser strips `# comments`, so the annotated extensibility front matter still parses.*

*I spot-checked six new "State today" claims against the code, and all held:*
- *`versioning.ts:25-44` hashes the rules in force and the template text;*
- *`--validate-tools` calls `execFileSync` in the repository root (`wave2.ts:863-876`);*
- *`DEFAULT_PROJECT_CONFIG` has no `maxToolAppliedLines`;*
- *`board` is in `FRONT_DOOR`;*
- *the chat panel's idle line names the model (`pm_thread.js:248`);*
- *CLAUDE.md already stated the Node 22.13 floor at `8b5ccb9`.*

Severity follows the two earlier reviews:
- **Blocker:** the design is not ready for spec-driven development until it is fixed.
- **Major:** a contradiction or gap that a workstream would trip over, or a criterion that cannot become a failing test.
- **Minor:** wording, numbering or staleness.

---

## 1. Resolution of the confirmation review's findings

### Major findings N1–N10

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| N1 | The context version includes the rules in force, so a rule event disqualifies the Worker | **Resolved** | context rule 27 splits the stamp in two:<br>- a **context version** over harness assets only: templates, copy module, tool catalog and schemas, budget policies;<br>- a **guidance list** of project data (rules, skills, exemplars, conventions), which invalidates nothing.<br><br>CX-6, CX-N6-1 and CX-N6-2 are rewritten. The new CX-N6-3 requires that `computeContextVersion` take no project inputs, checked by a type-level test. DEC-28's closing paragraph, measurement 16a, extensibility 15a and MD-M4-5 all agree. The State-today row names `versioning.ts:25-44`, and that claim held in the code. |
| N2 | "Inconclusive → cheaper or simpler" admits changes on no evidence | **Resolved** | measurement 16c, DEC-28 row 3, MS-T8-13 and context 21a now require:<br>- **one** cost measure named before the run (median tokens per card);<br>- a one-sided paired Wilcoxon test at 0.05;<br>- "simpler" computed from the diff;<br>- the smallest detectable loss at 80% power recorded;<br>- a refused entry when the cost measure was written after the first card.<br><br>MS-T8-13 has a scripted negative case. *Residue:* rule 12 and worker-loop 29a now disagree on how the B2.5 arms are decided (**F10**). |
| N3 | Rolling-10 retirement retires helpful rules by chance | **Resolved** | Rules are now tested only at fixed looks (20, 40 and 80 pairs), by a one-sided sign test at 0.05/3 per look, and never below 20 pairs. This is in measurement 16b, DEC-28, context 24 and 24e, CX-N4-6, MS-T8-14, dashboard §2.11, planner-pm §2.13.2 and PM_CONTRACT §0. I recomputed every figure 16b quotes, exactly and with dependent looks; all hold:<br>- a rule lifting 70→80% is retired with probability **0.0010**;<br>- a neutral rule at 70%: **0.021**;<br>- a rule lowering 80→70%: **0.225**;<br>- a rule lowering 80→60%: **0.701**.<br><br>MS-T8-14's scripted cases hold too: 1–9 gives P = 11/1024 = 0.0107, so retired; 2–8 gives P = 56/1024 = 0.0547, so kept. |
| N4 | Zone 4 not shown to fit | **Resolved (residue minor)** | The Zone 4 worked example is added to context rule 10 and DEC-27.<br>- Observations are held to 300 tokens, with a 1,500-token budget (rule 3).<br>- Older steps become one ~25-token line each.<br>- Reasoning is clipped to 300 tokens as it is appended (rule 4).<br>- An out-of-schedule masking point is placed from the projection *before* a request is sent (CX-N2-5).<br>- W is fixed per attempt (worker-loop 22, WL-M3-5).<br>- CX-N2-3 now covers the last step of each fixture's longest attempt and counts forced masking points.<br>- The new CX-N2-4 is a scripted 40-step stress case.<br><br>The sums are right: 1,500 + 300 + 850 + 300 + 60 = 3,010 ≤ 3,034; Zones 1–3 total 6,950 (69.6% of W); 3,010 + 6,950 = 9,960, which is 99.76% of W. The limit is stated honestly: at that fill the pressure tiers mask first. The labelled "worst case" is not the worst case (**m-a**). |
| N5 | Two numbers for INVEST *Small*; missing `ready` entry condition | **Resolved** | There is now one number: Zone 3's cap at the resolved Worker's W, 3,792 tokens on the reference Worker. It appears in DEC-27, DEC-24's row, planner-pm §2.4, PM-12, PM-13 and the new PM-14 (one computation), models rule 11 and MD-N4-10, and CX-N2-2. The rule adds that "no other token limit" exists, checked by a search test. Kernel rule 27 gains the `ready` row, and K-N5-7 checks it. |
| N6 | DoD §5.1 contradicts the change kinds and the tool-applied bound | **Resolved** | DoD §5.1.1 now gives the red/green rule for each `change`, and §5.1.2 counts only the Worker's own lines against the 200-line bound. gates rules 6b and 12 are rewritten to agree and say so. There are three new criteria:<br>- GT-TQ-10: a characterization test must fail against the stand-in implementations;<br>- GT-TQ-11: an `upgrade` card names the tests it must keep passing;<br>- GT-BF-5: `max_tool_applied_lines` 500 is in `DEFAULT_PROJECT_CONFIG`. |
| N7 | Four early dependencies had no builder | **Resolved** | In the plan:<br>- (a) M2 is built in B2.1, both arms, with WL-M2-6 capping the tool schemas at 1,700 tokens per class;<br>- (b) T8 is built in B2.4 (measurement T8 preamble; B5 drops T3 and T8);<br>- (c) T3 is built in B2.1, and SEC-2 says how B1's `git_metadata_tampered` joins it (worker-loop rule 31);<br>- (d) until P14 and P1 exist, gates rule 32a and GT-TQ-12 use the *internal tool* profile and route test gaps to a person;<br>- (e) NEW-surface-5 and MS-M9-5 say which share of the `RunProfile` each carries.<br><br>*Residue:* T8's credit function reads `attempt/finished`, a record built in B4.0a (**m-l**). |
| N8 | Machine time undercounts the A/Bs | **Partly resolved** | Done:<br>- "Phase" is defined in rule 26 and MS-N3-1 (B2, B3 and B4 each count as one).<br>- The plan adds a sentence: each prompt, tool, budget-policy or skill change costs a paired A/B of about eight machine-hours.<br><br>Not done:<br>- There is no per-workstream A/B column.<br>- B2.5 is not re-totalled. It is still "about two machine-days" and still omits the MTP A/B, the choice of masking interval k among 4, 8 and 16, the exemplar A/B (CX-M1-7) and the M8 cache run (CX-M8-7).<br>- Phase B is not totalled.<br>- The new overnight benchmark now competes for the same overnight window, and the plan does not count it. |
| N9 | Evaluation assets put the owner's labelling in front of the baseline | **Partly resolved** | Done:<br>- measurement rule 29 and the plan's new "Evaluation assets" table build each asset in the workstream that first uses it. Only reference solutions, golden briefs and the held-out suite remain in B2.4.<br>- MS-T11-6 and MS-T11-7 enforce this.<br><br>Not done:<br>- The plan still does not give person-hours of labelling per asset.<br>- The UI-screens asset is now built in B4.0b, but its criterion GT-N4-2 belongs to NEW-gates-4, which is in B2.3 (**F7**). |
| N10 | A lead ruling reversed the owner's learning rule, unqueued | **Partly resolved** | Done:<br>- R12 is marked **owner**.<br>- O15 covers probation, with approval first as the default (context 24f, CX-N4-7, MS-T8-15, measurement rule 6).<br>- O24 covers profile statements.<br>- PM_CONTRACT §0 and §6 have target rows.<br><br>Not done:<br>- Item (ii), **automatic retirement of a person-approved rule**, has no O-entry. DEC-28 still retires such rules automatically, where PM_CONTRACT §6 had them "proposed for retirement".<br>- planner-pm §2.13.3 and §8 Q1, and PM_CONTRACT §0, still say profile statements are "not yet in the owner queue", although O24 exists (**F8**). |

### Minor findings n1–n25

| # | Status | Evidence |
| --- | --- | --- |
| n1 | Partly resolved | Fixed: worker-loop rule 5 now says the code's *turn*; RUN-45 and RUN-46 now label the span *Step*; EXT-31, the surface config comment and PM_CONTRACT §4 now say step. The step budget is per sample (DEC-26, worker-loop 21, WL-T3-13, the defaults table).<br>Still *turn*: OPEN_QUESTIONS benchmarks #3 ("cross-turn cache retention") and #11 ("seconds per turn"); SPINE's package table (`loop`: "The Worker's turn driver"); DEC-24's first row ("masking every turn"). |
| n2 | Resolved | Zone 4 is "at least 0.40W′ by construction" (context rule 10). CX-N2-3 now asserts the whole prompt fits within W. |
| n3 | Resolved | `budget_exhausted` now carries `budget: steps` or `budget: context` (worker-loop 31a, WL-T3-12, CX-2, context rule 12). The next action for `context` offers a split, not more steps. |
| n4 | Resolved | planner-pm §2.10.3 now cites DEC-24 and kernel rule 27 without the stale sentence. |
| n5 | Resolved | worker-loop §9 now says "twenty-three stored reasons in seven failure classes plus a success class". |
| n6 | Resolved | Resolved already (trace §2 empty). |
| n7 | Resolved | No bare `#dec-22)` or `#dec-28)` anchor remains anywhere in `docs/`. |
| n8 | Resolved | gates rule 5 cites PM-P1-17. The planner-pm, surface and review-git citations are now written as research IDs ("research TESTS_BROWNFIELD PM-TQ-2", "research RG-T5"). |
| n9 | **Unresolved** | DECISIONS still says "Newest first within each group". The product group runs DEC-01…11, then DEC-29 and DEC-30 (newest last). The engineering group runs 25–28, 20, 24, 21–23. There is still no note that DEC-12…19 do not exist. |
| n10 | Resolved (moot) | O10 was decided (DEC-29): all five `change` values ship in v1. |
| n11 | Resolved | No "last 10 applications" or rolling window remains. The fixed looks are used everywhere. |
| n12 | Partly resolved | Most spec §9 and justification lines now cite `DEC-25.R*`. Bare "ruling R6/R7/R10/R13/R15/R18/R23/R27" remains in dashboard, extensibility, surface, integrations, runtime, security and NAMING. None of the bare references now collides with a register R-number in the same sentence, but the convention is half-applied. |
| n13 | Resolved | `review_minutes_per_day ≤ 0` is refused where it is set: review-git §2.2.3, RG-S6-8, SUR-48b, DB-N4-3. The static limit of 3 is never used for Review. |
| n14 | Resolved | planner-pm §2.13.3 and the dashboard's Playbook footer now point to `~/.sekhemet/`. planner-pm §8 Q2 is closed, and PM_CONTRACT §3 names `pm/proposal_state`. |
| n15 | Resolved | PM_CONTRACT §0 has target rows for the card `key`, `kind`/`change`/`split`, the `awaitingMerge` hold and `PmStatus.model`. |
| n16 | Resolved | INT-12 targets the configured integration branch. INT-14 clears the hold and the accepter, and the card stays in Review. |
| n17 | Resolved for the rows it named; **recurs** for O15–O24 | O8, O10, O11 and O14 are decided, and the "Design questions still open" rows are closed. The new O15–O24 disagree with the plan's "Needs first" column in six places (**F8**). |
| n18 | Partly resolved | gates §8 Q2 is marked decided and matches DoD §2B. The DoD version line still reads "3, 2026-09-22", although §2B, §3B.3 and §5.1 changed on 2026-09-24. |
| n19 | Resolved | The COVERAGE cuts row now says `container.ts` is reachable and cut by DEC-29 O4. DEC-09's "Cut:" list is now correct in outcome, and its correction note says why. |
| n20 | **Unresolved** | MODERNIZATION_PLAN still says "the 95 further changes". COVERAGE and the front matter carry **106**. |
| n21 | Resolved in the specs | The dashboard and NAMING now say "of 40". The mockups (`board.html` lines 250, 251 and 271) still show 32. They are design references, so this is noted only. |
| n22 | **Unresolved** | SPINE's journey diagram still has `G -- send back --> E` (Worker builds). DEC-24 and kernel rule 25 send a card back to Ready. |
| n23 | Resolved (it already was at `8b5ccb9`) | CLAUDE.md line 53 reads "Node 26 (22.13+ supported…)" at `8b5ccb9` and now. |
| n24 | Resolved | K-N5-4 now comes before K-N5-5. |
| n25 | Resolved | worker-loop 29a says the ECLoop arm is compared against B2.5's other winning settings, and that the frozen baseline records its verdict. |

**Tally.** Of N1–N10: 7 resolved (N4 with a minor residue), 3 partly resolved (N8, N9, N10), none unresolved. Of n1–n25: 18 resolved (n10 as moot, n21 in the specs only), 4 partly resolved (n1, n12, n17 — whose recurrence is new finding F8 — and n18) and 3 unresolved (n9, n20, n22).

### What remains of the first review's findings

- **B1, the trace.** DEC-29 has the owner confirming all 131 Later rows, which closes half of plan exit 4. Two things remain:
  - Exit 4's **independent check of the trace against the old text** has still not been made. The header still says the 1,425 rows first classed `carried` "were not re-read one by one". My five-row sample found no misclassification and one mis-cited location (HD1:5 names kernel rule 13 for "projections of the one stream"; it is rule 14, and SPINE rule 2 carries it anyway). Five rows is far below the ≥ 100 the confirmation review recommended.
  - The trace went stale when DEC-29 was taken (**m-d**).
- **M2, the sizing of B2.1.** B2.1 now carries M1, M2, M3, M5, M8 and T3, plus NEW-context-1/2, NEW-worker-loop-1/2/3/9, the Zone 4 projection and a fixed W. It is still sized "M".
- **M3, the owner queue.** The queue now covers every owner decision a spec names, except automatic retirement (N10 ii) and three low-stakes proposals (**F8**).

---

## 2. New findings

### Blockers

**None.** No change since `8b5ccb9` makes the design unfit for spec-driven development as a whole. One major finding, F1, sits in B1's own specification and must be fixed before B1 starts. The trace's independent check (exit 4) is carried from the first review's B1, not new.

### Major

#### F1. The new `[network] research` key contradicts security's egress items and SEC-13, inside B1's S3
- **Evidence.**
  - surface item 24 (new): `research` "governs only the Researcher's harness-side requests … with `yes`, research may reach any public host not in `fetch_deny`, logged, **whatever `mode` says**".
  - SUR-48a: with `research = "yes"` and `mode = "offline"`, the Researcher fetches a public host.
  - DS-S8-1 says the same, and so does DEC-29's O16 default.
  - security item 28 (unchanged) defines the one network policy as "`[network] mode`, `fetch_allow`, `fetch_deny`" and does not name `research`.
  - security item 29 (unchanged): "With `mode = "offline"` … **harness-side requests reach only loopback**."
  - security item 32 (unchanged): research fetches go through `NetworkPolicy`, "which applies the mode".
  - **SEC-13** (S3, built in **B1**): "WHEN no user config sets `[network] mode` THE SYSTEM SHALL behave as offline in `plan`, the supply-chain gate **and research**, with no outbound request recorded". A user who answered yes and left `mode` unset satisfies SUR-48a's precondition. The two criteria then demand opposite results.
  - There is a second conflict, over `allowlist`. design-stage §2.6.3 still defines `fetch_allow` as "domains the Researcher may read". surface 24 lets a research "yes" reach any public host, whatever `mode` and `fetch_allow` say. So a person who chose `allowlist` gets a wider policy for research than they wrote.
  - security 29a (new) says "`mode` is not changed by it", but it does not amend items 28, 29, 32 or SEC-13.
  - A project "may turn [research] off for itself" (design-stage §2.6.1, DS-S8-6). That is not among the narrowings surface items 24 and 26 list for a project file.
- **Why it matters.** B1 carries S3, "one egress policy", and SEC-13 is one of its criteria. Security contradicts surface and design-stage (DoD §5.2.4), in the security spec itself.
- **Fix.**
  - Amend security items 28, 29 and 32 to name `research` as the one exception to `mode`: harness-side research requests only, through `NetworkPolicy`, logged, and never reaching a sandbox.
  - Rewrite SEC-13 as "with neither `mode` nor `research` set …", and add a SEC criterion mirroring SUR-48a.
  - Decide whether a research "yes" under `mode = "allowlist"` is bounded by `fetch_allow`. Recommendation: yes, so a "yes" never widens a list the person wrote. Then fix design-stage §2.6.3 or surface 24 to match.
  - Add "may set `research = "no"`" to surface item 24's list of what a project file may narrow.

#### F2. O11: review-git and integrations name different people as the "delegator"
- **Evidence.**
  - review-git §2.4.1 (new): on a team, "the person who **delegated it to the Worker** (the card's `owner` while its `delegate` is the Worker, kernel) may not accept it."
  - integrations item 6b (new): "Independence is judged from the ledger — **the principal on `card/delegated`** … never from the tracker's current assignee, so reassigning the synced issue to someone else **changes the card's owner but not who may accept it**."
  - INT-40: after the tracker reassigns, the system "SHALL still refuse an accept by the principal who delegated it".
  - kernel rule 21 records `card/delegated {from, to}` "naming the principal who made it", and a separate `card/owner_changed`.
  - After Alice delegates to the Worker and a tracker, or the dashboard, moves the owner to Bob, review-git refuses Bob and allows Alice. integrations refuses Alice and allows Bob. RG-N5-1, SUR-53 and dashboard §2.15.7 inherit review-git's reading.
- **Fix.** In review-git §2.4.1 and RG-N5-1, define the delegator as the principal who recorded the latest `card/delegated` to the Worker. Say explicitly that a later owner who neither built nor delegated the card may accept it. Add a review-git criterion that changes the owner after delegation, so B3.2's own tests fix one meaning before B4.9 builds INT-40.

#### F3. The Configuration page's Assign has three incompatible rules
- **Evidence.**
  - models rule 4d, rule 30a and MD-N10-3 all say a person may assign any **qualified** model with or without a benchmark. A model that is not qualified is refused, "naming the missing qualification".
  - dashboard §2.16.1 says the same, and says the button reads **Qualify to assign** and "assigns when it passes".
  - **DB-N6-5** says: "WHEN a person assigns a model that the adoption rule … does not yet allow … THE SYSTEM SHALL NOT assign it and SHALL **open Benchmark** with that model in that role's picker."
  - PM_CONTRACT: `PUT /api/config/roles/:role` is refused with 409 `{ needs: "benchmark" }`.
  - PM_CONTRACT defines `RoleAssignment.qualified` as "the adoption rule allows this model in this role", which conflates qualification (models rule 27a) with adoption (rule 30a).
- **Why it matters.** B4.1 would build and test a flow that the owning spec (models) forbids.
- **Fix.**
  - DB-N6-5: refuse an unqualified model and offer **Qualify to assign** (a models 27a run), not Benchmark.
  - PM_CONTRACT: `needs: "qualification"`, and define `qualified` as rule 27a's qualification on this host.
  - Say once, in models 30a, that the adoption rule's bake-off applies only to the baseline and the shipped defaults.

#### F4. The quick benchmark's minutes and card count do not agree across DEC-29, measurement, the dashboard and the plan
- **Evidence: minutes.**
  - DEC-29 O2a says "about **10–15 minutes per new model**, most of it the Worker's five capped cards and loading; **under about 40 minutes** for a full combination with nothing cached".
  - The dashboard (§2.16.2) repeats both figures.
  - measurement rule 32 and MS-N5-1 set the targets at 15 minutes per model and 40 minutes per screen.
  - A full combination with nothing cached is four new models plus the end-to-end check. At the stated 10–15 minutes each, that is **40–60 minutes before the end-to-end check** (2–3 cards through Planner, Worker and Reviewer, with a swap each way). Its length is not capped anywhere.
  - Loading alone breaks the per-model figure on the reference machine: CLAUDE.md puts a Worker load from the USB drive at about five minutes. The Worker's screen (rule 31) is then 5 × 2 minutes + ~5 minutes = ~15 minutes on its own.
  - So "under about 40 minutes" is not reachable under the design's own figures unless the three other roles and the end-to-end check fit in about 25 minutes together. The documents never say so.
- **Evidence: card count.** The Worker's screening set is:
  - "about **5** frozen-suite cards" in measurement rule 31, DEC-29 and the plan's asset table;
  - "~**8** frozen-suite cards across kinds" in measurement rule 29's asset table.

  Rule 35's example ("On 8 cards … 6 of 8 is about 0.35 to 0.97") and NEW-measurement-5's justification ("how little 8 cards can tell apart") also assume 8.
- **Fix.**
  - State per-role targets that sum to the combination target, for example: Worker ≤ 15 minutes with its load, Planner, Reviewer and Researcher ≤ 5 each, end-to-end check ≤ 10 with a per-card cap.
  - Or drop "under about 40 minutes" from DEC-29 and the page copy.
  - Choose one Worker card count and use it in rule 29, rule 31, rule 35, the justification and the plan.

#### F5. On 5 cards the quick tier can never tell two Worker models (or two Researchers) apart, by its own rule
- **Evidence.**
  - Rule 35 and MS-N5-4 label two combinations "indistinguishable" whenever their Clopper–Pearson 95% intervals overlap on every role in which they differ.
  - I computed the intervals. **5/5 is [0.478, 1] and 0/5 is [0, 0.522]: they overlap.** So on the 5-card Worker screen (rule 31) and the 5-question Researcher screen, no two models can ever be ranked, whatever their results.
  - On 8 cards, only 8/8 against ≤ 1/8 separates.
  - The overlap rule is also unpaired, although rule 10 says comparisons "are paired" and the quick tier runs the same cards for every candidate.
  - models 4c and MD-N12-4 then prefer "the smaller footprint, then the registry default". In practice, then, the Worker recommendation will never come from the quick score, and the page's purpose ("how effective a combination is") will not be met for the most important role.
- **Why it matters.** DoD §5.2.3 is satisfied, since MS-N5-4 can be a failing test. But the criterion encodes a statistic that cannot do its job, and the owner's O2a expectation is that the quick tier discriminates.
- **Fix.**
  - Compare candidates on the same cards with the paired exact test (McNemar or sign test on discordant cards, rule 10), not by interval overlap.
  - Report each role's secondary, higher-resolution measures beside the pass count: seconds per card, valid tool-call rate, and steps to pass. Say in the page copy that the quick tier resolves speed and fit, but only large differences in correctness.
  - If correctness must discriminate, size the Worker set so that a stated difference (for example 0/n against n/n) separates, and budget its minutes under F4.

#### F6. The overnight tier's interleaving, its example window and runtime's idle rule conflict with models 20b
- **Evidence.**
  - measurement rule 37 and MS-N5-10 interleave "card by card across the combinations". Combinations differ in their Worker, and on the 24 GB host no two Workers co-reside (models rule 22). So every card needs a model swap: about 30 cards × 2 runs × up to 3 combinations, at 40–120 s each (models 20a), or about 5 minutes from the USB drive.
  - models 20b says "the residency scheduler loads each combination's models in the order that **minimises swaps**". That is the opposite of card-by-card interleaving.
  - The example "*2 of 3 combinations fit tonight's window, 01:00–06:00*" (dashboard §2.16.2, measurement rule 37) cannot hold. Each combination needs at least two full-suite runs of about two hours each (the plan's *Machine time*), plus the planning measure and two role sets. That is more than four hours per combination in a five-hour window, so at most one fits.
  - runtime item 17 (new) runs "queue rounds — **and the overnight benchmark tier** — … in the overnight window and not reserved, **or inside reserved hours when the person has been idle**". models 20b and MD-N3-4 forbid the benchmark inside `reserved_hours` "not even when the person is idle".
- **Fix.**
  - Pair by card, but run in counterbalanced blocks: all of one combination's cards for a run, then the next combination's, with the order reversed on the second run. This keeps the pairing that rule 10 needs at one swap per block. State this in rule 37, MS-N5-10 and models 20b.
  - Recompute the example from the plan's two hours per run.
  - Take the benchmark out of runtime 17's idle exception.

#### F7. Workstream order: the Configuration benchmark and one asset come before the things they measure
- **Evidence.**
  - NEW-measurement-5, NEW-models-12 and NEW-dashboard-6 are in **B4.1** (COVERAGE and the plan). The quick tier's parts are ready at different times:
    - The Reviewer screen scores defects found at their locations. The Reviewer procedure it would exercise is rebuilt only in **B4.8** (P8; today it "checks style only … runs after the merge").
    - The Researcher screen needs the research pipeline and golden set of **B4.4** (NEW-design-stage-2, MD-N11-1).
    - The end-to-end check runs "Planner, Worker and Reviewer".
  - The overnight tier runs "the Reviewer's and the Researcher's full evaluation sets". Those are built in B4.4 and B4.8, so MS-N5-10 cannot pass in B4.1, and MS-T11-7 refuses to score against a partial set.
  - The labelled UI screens are now built in **B4.0b** (rule 29, the plan's asset table: "first used by the visual checklist (GT-N4-2)"). But GT-N4-2 belongs to NEW-gates-4, which COVERAGE puts in **B2.3**.
- **Fix.**
  - Split NEW-measurement-5 by readiness: the Worker and Planner screens and the page in B4.1; the Reviewer and Researcher screens, and the overnight tier's role sets, added with B4.8 and B4.4. Or state that a role's quick score is `not_measured` until its role's workstream lands; `RoleScore.state` already allows this.
  - Either move GT-N4-2's rate-dependent clause to B4.0b or move the asset to B2.3.

#### F8. The owner queue and the plan disagree on what blocks what, and some owner items are stale or unqueued
- **Evidence: what blocks what.** The plan's rule (MODERNIZATION_PLAN, line 171) is that "a workstream does not start while an owner decision in its **'Needs first'** column is open". OPEN_QUESTIONS's rule is that it does not start "while an unresolved owner decision sits **in its path**", with its own Blocks column. The two columns disagree:

  | Decision | OPEN_QUESTIONS "Blocks" | Plan "Needs first" |
  | --- | --- | --- |
  | O15 | B2.4, B4.0a | neither |
  | O16 | B3.3, B4.4 | neither |
  | O20 | B2.5 | not listed |
  | O21 | B2.2 | not listed (B2.2 lists only B1 and O2) |
  | O22 | B4.8 | not listed |
  | O24 | B4.8 | not listed |

  O17, O18 and O23 agree. Neither document says whether a stated default unblocks a workstream. Under OPEN_QUESTIONS's rule, B2.2, B2.4 and B2.5 cannot start until O21, O15 and O20 are answered; under the plan's rule they can. B0 and B1 are named by neither document, so they are clear either way.
- **Evidence: stale queue references.**
  - planner-pm §2.13.3 and §8 Q1, and PM_CONTRACT §0 ("Profile statements"), still say the question "is not yet in the owner queue"; it is **O24**.
  - O15's Blocks column and PM_CONTRACT §0's "Lessons learned during a run" row cite **NEW-measurement-3**, which is "adoptions per phase". Probation lives in T8 (MS-T8-15) and NEW-context-4.
- **Evidence: owner items with no O-entry.**
  - N10 (ii): automatic retirement of a person-approved rule (DEC-28 row 1, against PM_CONTRACT §6's original "proposed for retirement").
  - measurement §8 Q3: importing the SWE-bench Verified annotations and `nebius` columns, where rule 22 says "Nothing is imported without the owner's yes".
  - gates §8 Q1: axe-core inside the product's visual gate, "a proposal until the owner says otherwise".
  - review-git §8 Q3 asks "with the owner's yes" for the public review sets but does not link O22.

  Each has a safe default (don't import, don't ship, approval first), so none blocks.
- **Fix.**
  - Choose one rule. Recommended: "a stated default unblocks; the owner's answer may change the workstream's scope". Write it in both documents, and make the plan's Needs first column the only list.
  - Point planner-pm and PM_CONTRACT to O24.
  - Correct O15's change ID.
  - Add an O-entry for automatic retirement, with DEC-28's fixed looks as the default, and one for the measurement §8 Q3 import.

#### F9. Retention of personal free text: kernel limits the 90-day default to a team server; runtime applies it everywhere
- **Evidence.**
  - DEC-29 O14 gives the retention of personal free text **on a team server** as 90 days.
  - kernel rule 34 (new): "The retention period for personal free text **on a team server** is 90 days after the card closes … **on a single-user install nothing is erased by retention unless a person sets a period**."
  - runtime item 34a (new): "**The default period is 90 days after a card closes**", with no team-server qualifier.
  - RUN-41: "90 days after it closed unless a person holding Accept set another period"; "WHEN the card closed 89 days ago under the default THE SYSTEM SHALL erase nothing". No single-user exception.
  - B3.3's RUN-41 would erase a solo user's private text at 90 days, which kernel rule 34 forbids.
- **Fix.** Add "on a team server (company-server mode); none by default on a single-user install" to runtime 34a and RUN-41. Add a RUN criterion for the single-user case.

#### F10. B2.5's arms are decided by two different rules
- **Evidence.**
  - measurement rule 12 (new sentence): an arm of "a setting that must take one value before the baseline `RunProfile` is frozen (B2.5)" is decided, when the pass rates cannot be separated, by **lower seconds per card**.
  - worker-loop 29a (new): the evidence-gated-commit arm, run inside B2.5, is, when inconclusive, "adopted only as measurement rule 16c allows — simpler by the diff, or cheaper on **median tokens per card by a paired Wilcoxon test**".
  - The two rules give different answers for the same arm: a faster but token-heavier ECLoop is adopted by rule 12 and rejected by 16c. And because the switch adds a switch, 16c's "simpler" can never apply.
  - The strict-method arm, also in B2.5, is covered by neither sentence explicitly.
- **Fix.** Say in rule 12 which B2.5 arms it decides: every setting the baseline must fix, the ECLoop switch included. Then either drop 29a's reference to 16c, or state that ECLoop, as a new mechanism rather than a choice among existing arms, is admitted by 16c and defaults to off when inconclusive.

### Minor

- **m-a. The Zone 4 "worst case" is a typical case after a masking point.**
  - The table is headed "right before a scheduled masking point", yet it counts five full steps and one reasoning block. With k = 8, up to seven steps stay unmasked since the last point, and each thinking step's reasoning is kept until the next point (rule 4, CX-M8-9): up to 7 × 300 tokens.
  - The table allows ~60 tokens per tool call. An `edit` or `write` call carries code: the confirmation review estimated 80–150 tokens a step for calls.
  - CX-M8-8 allows 30 tokens per one-line summary, not 25. Thirty-four lines at 30 tokens is 1,020, which makes the total 3,180 against a 3,034 budget.
  - "≈ 86% of W" after the tiers mask assumes the latest observation is masked too. CX-M8-6 keeps it in the tail; with it kept, the figure is ~88.7%.
  - The projection masking point (CX-N2-5) still guarantees a fit, so nothing fails. But DEC-27's "about 3,010 tokens in the worst case" should read "after a masking point". The true bound is whatever the projection enforces, and CX-N2-3 already counts the forced masking points.
- **m-b. Three §8 entries say "Decided" and then "until it is decided".**
  - models §8 Q1 (R30);
  - measurement §8 Q2 (R31), which still says "MS-T8-8 cannot pass";
  - worker-loop §8 Q1 (R32).

  MS-T8-8 requires "the owner's sign-off" for an inlet cut. R31 is the lead's ruling; cite DEC-09 (the owner's rule that dead code is cut) as the sign-off, or queue it. Models §9 still lists "M3 residue (§8 Q1 not in the owner queue)".
- **m-c. DEC-25 is stale after DEC-29.**
  - DEC-25's R15 row still reads "in the panel's details and on Machine". O3 replaced it, and dashboard §8 Q3 says so; mark R15 superseded.
  - R29 is listed after R32.
  - DEC-28 row 3 says "skill" where measurement 16a says "harness skill". DEC-28's own closing sentence resolves it, but the row should say "harness skill" too.
- **m-d. DESIGN_TRACE is stale after DEC-29.**
  - The header still says `deliberate` rows "rest on a recommendation that still awaits the owner (OPEN_QUESTIONS O1–O14)".
  - §3 is still headed "for the owner to confirm", although DEC-29 confirmed it.
  - These rows still cite open decisions: HD1:158, HD2:170 and INV:K9 ("pending the owner, O4"); HD1:200 ("recommendation awaiting the owner"; decided, K-N5-8); HD2:428 (now O20); PMFE:217 (now O24); INV:E13 (now R31); INV:H25 (O9 decided).
  - HD1:5 cites kernel rule 13 for "projections"; it is rule 14.
- **m-e. DEC-29's authority is hard to audit.** Its preamble says "O1–O3 of the owner's list were delegated to the lead". The table marks O1, O10 and O14 as "lead, delegated", and O2 and O3 as the owner's own. The numbering of "the owner's list" is evidently not the queue's. Because O1 amends a spine rule, quote the owner's delegation and give its date, and use the queue's numbers.
- **m-f. Two statements about which folders are scanned disagree.** surface's config comment for `[models] folders` says the page scans "besides `SEKHEMET_MODELS_DIR` and the known stores". models 4a and MD-N12-8 say the known stores are only *suggested* and "scan none of them until a person adds it".
- **m-g. PM_CONTRACT's Configuration shapes need two fixes.**
  - `FoundModel.fits` is single-valued, but fit is per role (models 4b, MD-N12-3), because KV size depends on each role's context.
  - `Role` omits `vision`, yet surface's `[models] vision = "auto"` exists. Say whether Configuration covers the vision model, and where it is set if not.
- **m-h. "Reserve now" has no owner.** models rule 20 and runtime 17 name a *Reserve now* button on the dashboard and `sekhemet dev reserve`. Neither dashboard nor surface specifies the control or the command, and neither has a criterion for it. MD-N3-1 and MD-N3-4 test only its effect.
- **m-i. NAMING's Configuration words are stale.** They define *Benchmark* as "the frozen suite, or a bake-off on chosen models". Say "the quick and overnight benchmarks of model combinations", and add *Quick*, *Overnight*, *Indistinguishable* and *Morning report*, which the page uses.
- **m-j. A leftover pronoun in models rule 20.** "…while it is idle **outside them**" still refers to the renamed "declared hours". It should say "in the overnight window".
- **m-k. B0 must update extensibility's front matter.** B0 cuts `packages/sdk`, `container.ts` and `apps/harness/tests/sdk.spec.ts`, which extensibility's front matter lists under `code:` and `tests:`. `docs.spec.ts` fails on a listed path that does not exist. Add "update extensibility's front matter in the same commit" to B0's row.
- **m-l. T8 is built before the record it reads.** T8 (B2.4) computes rule credit "from `attempt/finished` records alone" (MS-T8-14), but `attempt/finished` is WL-N5-1 (NEW-worker-loop-5, **B4.0a**). Say that B2.4 builds and tests the function on scripted records, and that it runs live from B4.0a.
- **m-m. COVERAGE is stale.** The cuts row for `retention.ts` still reads "becomes a recorded erasure after owner decision O1"; O1 is decided. The title of NEW-models-3 is still "Declared hours and swap batching", where the spec now says "reserved hours, the overnight window and swap batching".
- **m-n. The Configuration permission rule is too broad.** dashboard §2.16 says that in company-server mode "every change on this page needs the Accept permission". That sentence covers *This browser* (theme, density, Learn), which is a per-browser preference and not a server change. Exempt that section.

---

## 3. Verdict

**Is the design ready to begin Phase B (B0, then B1), apart from the owner's open O15–O24? Not by the letter of the Phase A.5 exit. In substance, B0 is ready now, and B1 is ready after one document fix and the trace check.** Every remaining item is a document edit.

**The Phase A.5 exit, item by item:**
1. *Every spec meets DoD §5.2.* **Not met** for security (F1), review-git and integrations (F2), dashboard, models and PM_CONTRACT (F3), measurement (F4–F7, F10), worker-loop (F10), kernel and runtime (F9), and planner-pm (F8's stale queue references). Tests 1 and 2 of §5.2 held wherever I checked. Test 3 holds: every new criterion can be a failing test, though MS-N5-4 encodes a statistic that cannot discriminate (F5). The failures are all test 4, contradictions between documents.
2. *Every change ID is carried, and shares are stated.* **Met.** The 106 `NEW-*` IDs match between COVERAGE and the front matter, and the RunProfile share (N7e) is stated.
3. *`docs.spec.ts`.* I could not run it. Its parser handles the new front-matter comments. B0 must keep the extensibility front matter in step with the cut (m-k).
4. *Nothing was lost.* **Half met.** The owner confirmed the 131 Later rows (DEC-29), and every open `deliberate` row is now decided or queued (O15–O24). **The independent check of the trace against the old text has still not been made.** My five-row sample is not that check. This review also found contradictions between specifications (F1–F3, F9, F10), which the exit forbids.
5. *`pnpm gate` passes and `main` is fast-forwarded.* Not checked.

**None of O15–O24 sits in the path of B0 or B1**, in either the plan's "Needs first" column or the OPEN_QUESTIONS "Blocks" column. Each has a stated default. The two documents still disagree about whether a default unblocks later workstreams (F8).

**B0 is ready.** Its owner decision (O4) is decided. Extensibility, SPINE, security 38 and 49, COVERAGE and DEC-09 now agree that the plugin container and the SDK are cut. EXT-28 and EXT-28a are testable. The only work to add is keeping the front matter in step (m-k).

**B1 needs F1 first.** B1's own S3 criterion SEC-13, and security items 28, 29 and 32, contradict the new `[network] research` key (surface 24, SUR-48a, DS-S8-1). The rest of B1's path is clean:
- the `--validate-tools` choice is written in (item 4a, SEC-17a), closing the confirmation review's M3 item for B1;
- SEC-2 says how `git_metadata_tampered` lands before the stop-reason table;
- the injection fixtures are scheduled in B1.

**Before B1, also close exit 4's independent trace check.** I recommend the confirmation review's sample: at least 100 of the 1,663 `carried` rows, stratified by source, with every row re-read if any is misclassified. The alternative is for the owner to record that B0 and B1 may start without it. Fix the trace's stale references (m-d) in the same pass.

**Must change before the named workstream:**

| Before | Fix |
| --- | --- |
| **B0** | m-k, within B0 itself |
| **B1** | F1 (security items 28, 29, 32; SEC-13; the allowlist question; the project-file narrowing); the trace sample, or the owner's waiver |
| **B2.2, B2.4, B2.5** | F8: one rule for whether a default unblocks, which settles O15, O20 and O21; F10; N8 (re-total B2.5 and Phase B, and count the overnight benchmark); N9 (person-hours per asset); m-l |
| **B2.3 / B4.0b** | F7: the UI-screens asset against NEW-gates-4 |
| **B3.2** | F2 |
| **B3.3** | F9 |
| **B4.0a** | F8: an O-entry for automatic retirement of approved rules (N10 ii) |
| **B4.1** | F3, F4, F5, F6, F7; m-f, m-g, m-h, m-i, m-n |
| **Any time** | m-a (DEC-27's "worst case" wording), m-b, m-c, m-d, m-e, m-j, m-m; the unresolved minors n9, n20, n22 and the residues of n1, n12 and n18 |

**Counts.**
- Confirmation review, N1–N10: 7 resolved, 3 partly resolved (N8, N9, N10), 0 unresolved.
- Confirmation review, n1–n25: 18 resolved, 4 partly resolved (n1, n12, n17, n18), 3 unresolved (n9, n20, n22).
- New findings: **0 blockers, 10 major (F1–F10), 14 minor (m-a–m-n).**
