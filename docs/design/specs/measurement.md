---
spec: measurement
status: partial
audiences: [developer]
code:
  - packages/eval/src/suite.ts
  - packages/eval/src/guardrails.ts
  - packages/eval/src/loops.ts
  - packages/eval/src/benchmark.ts
  - packages/eval/src/instrumentation.ts
  - packages/eval/src/mutation.ts
  - packages/eval/src/synthesis.ts
  - packages/eval/src/archive.ts
  - packages/eval/src/diagnostics.ts
  - packages/eval/src/phase0.ts
  - packages/eval/src/m0.ts
  - packages/eval/src/report.ts
  - scripts/run_suite.mjs
  - apps/harness/src/mutation_step.ts
  - apps/harness/src/registers.ts
  - apps/harness/src/tune.ts
  - apps/harness/src/learning/store.ts
tests:
  - packages/eval/tests/suite.spec.ts
  - packages/eval/tests/eval.spec.ts
  - packages/eval/tests/wave2.spec.ts
  - apps/harness/tests/mutation_step.spec.ts
  - apps/harness/tests/registers.spec.ts
  - apps/harness/tests/learning.spec.ts
  - apps/harness/tests/tune.spec.ts
changes: [M9, M10, M12, T7, T8, T11, NEW-measurement-1, NEW-measurement-2, NEW-measurement-3, NEW-measurement-4]
---

# Measurement and self-improvement

## 1. Purpose

Every claim Sekhemet makes about quality is unfalsifiable until it is measured on a fixed task set with the models it actually runs. Measurement is the admission test for every change the harness makes to itself, the way a model is qualified, and the only way to tell a feature that helps from one that merely exists. It applies the spine's first rule to the harness itself: **a change is admitted by a signal measured outside the generated text, never by argument**.

## 2. Behaviour

### The frozen suite

1. The frozen suite is a fixed set of 20–40 tasks, versioned in `fixtures/suite.json` (today four fixtures — chronicle 6, onyx 8, vanguard 8, basalt-canvas 8 — thirty tasks), each with a specification, a repository state and gates that decide pass or fail without a person. A task may be added, which bumps the version; no task is ever edited to make a result look better.
2. The **suite hash** covers everything that defines a task: the manifest, the fixture trees, the card specifications and the seed scripts that create them. A result is comparable only with results of the same hash.
3. A run copies each fixture into a fresh git repository, seeds it once, and runs every card through the real product path (`sekhemet run`). A passing card is accepted (squash-merged) before the next card starts, as in a real project. A card whose contract needs a module an earlier failed card never delivered is recorded as **blocked on that dependency** — unmeasured, not failed — because running it measures nothing.
4. One number comes out: **tasks passed**, reported as a pass rate with an exact (Clopper–Pearson) 95% interval, alongside its cost — wall-clock, tokens and cards that needed a repair rung — and the count of blocked cards. **Every failure is attributed to a named cause** in `SUITE_RUNS.md`. A change that does not move the number, or moves it down, is not an improvement however well it is argued.
5. **A run describes itself.** It records the harness commit and dirty flag, a SHA-256 of every built `dist` directory, every `SEKHEMET_*` variable, the Worker server's `/props` and build, the host fingerprint, the suite hash, and the thinking policy and working method. It re-hashes `dist` before each card and aborts if the build changed mid-run.
6. **Trials are independent.** During a measured run, learned state is isolated (its own configuration directory, model registry and exemplar store); no playbook rule or exemplar learned from one card in the run reaches a later card; and each card's evidence records the rules and exemplars it saw. This is the measurement half of one rule: in **production** use, a lesson verified by execution (a gate that failed and then passed with it applied) may reach later cards of the same run **on probation** and is rolled back by the paired rule ([context.md](context.md) rule 24f); in a **measurement run** — the frozen suite, a bake-off, the planning measure — no rule learned during the run is applied, so the run measures the harness, not what it learned from the test itself.
6a. **Only the Worker's work is measured as the Worker's.** An attempt a person built ([kernel.md](kernel.md) rule 22) never counts in a pass rate, a comparison, an inlet signal or the competence model; the frozen suite's comparison with live use would otherwise lose its meaning.
7. **The model stays resident** across the cards of a run; model load time is reported separately and never counted in a card's wall-clock.
8. **Reference solutions.** Each fixture card has a reference solution, validated against the frozen tests and hashed into the suite. A card can then run alone on a `main` holding its predecessors' reference work, which makes every card an independent, re-runnable trial. The "build the whole project" run, where each card builds on the Worker's own earlier cards, stays as a separate measure.
9. **One measurement path.** The suite runner lives in `packages/eval` as a tested module, and the bake-off, the rule gate, `m0` and every benchmark call it; each goes through the same card execution the product ships — same prompt, tools, thinking policy, working method, context window and tool arm, and the same roles and policies switched on (exploration, the Reviewer, the Researcher, escalated retries, the step cap) as the product ships them, so the benchmark measures what ships, not a harness with most features off. Any wrapper around a model adapter forwards every property, not only `generate`, and meters cached prompt tokens.
9a. **A run's settings are one recorded object.** Every run resolves its settings once — configuration, then flags — into one `RunProfile` (roles present, policies on, model roster, budgets, switches) that is written into the run's evidence. A named settings file (`--settings <file>`) is allowed, because the file itself is recorded; a flag that silently changes other flags (a `--profile benchmark` that turns on four others) is not ([surface.md](surface.md)).

### Statistics fit for 14–30 tasks

10. **Comparisons are paired.** Two settings are compared on the same cards, interleaved (A, B, A, B) with fixed seeds, and decided by an exact McNemar test on the cards where they disagree, or a Bayesian beta-binomial comparison; a sequential test (SPRT or a confidence sequence) may stop early. Runs are repeated; results report pass@k and pass^k. Adopting a new model for a role is such a comparison — a bake-off on the frozen suite on that host, the incumbent against the candidate ([models.md](models.md) rule 30a).
11. **Only large effects are claimed.** With 25–30 tasks a paired test has about 6–7% power to see a 10-point gain; about 155 paired tasks are needed at 20% disagreement (≈76 at 10%, ≈233 at 30%). So the 30-card suite claims only effects of **at least 20 points**, and every comparison states the smallest difference it could have detected. One trial at non-zero temperature is never a finding.
12. **When arms cannot be separated**, the default is the arm with the lower seconds per card, and the record says the pass rates were indistinguishable. This is how the thinking A/B (`off`, `surgical`, `all`, then the top two again) and the M2, M7/M11 and exemplar A/Bs are decided.
13. Only uncertain cards are re-run when narrowing an interval (SIFT-style slicing), and the re-runs are paired.

### The planning measure

14. The frozen suite ships hand-written cards, so it measures the Worker, the gates and the loop — never the Planner. The planning measure sits beside it and is never merged into it:
    - **Card validity.** Each fixture's specification is planned from scratch. Each generated card is scored on SPIDR shape, a declared scope of 1–3 files and at most 200 changed lines, and an acceptance test that fails at the seed, passes on the reference solution and kills mutants of the reference (fail-at-seed alone proves nothing, because `src/` ships empty). Beside these, each card reports the test-strength figures of [gates.md](gates.md) rule 32a: red at an assertion against the interface stub, stub-kill, the acceptance-test mutation score and the oracle cross-check disagreement rate.
    - **End to end.** The Worker builds from the Planner's cards, and the score is the share of the **hand-written, held-out** acceptance tests that pass on the final `main`.
    - **The first mutation threshold comes from here.** A project's first blocking acceptance-test mutation threshold is derived from at least one planning-measure run's per-card "mutants killed" and entered in the register with its date before any project uses it (rule 26).
15. Public project-building benchmarks that run locally (Commit0 lite, 16 libraries; ProjDevBench, 20 problems) are candidates for an external planning measure — *proposed*.

### Null baselines

16. A learned component is compared with the cheapest thing that could work, at equal budget, before it ships. The context pruner is measured against structure-preserving random line dropping at the same token budget; if it does not clear that baseline on the suite it is deleted with its register row.

### Admission: one rule for what the system learns

This section owns the rule ([DEC-28](../DECISIONS.md#dec-28--one-rule-for-admitting-what-the-system-learns)); [context.md](context.md), [planner-pm.md](planner-pm.md), [extensibility.md](extensibility.md), [worker-loop.md](worker-loop.md) and PM_CONTRACT point here and restate nothing.

16a. **The admission table.** What is learned is admitted, kept and retired by the rule for its kind, and **no admission rule relies on an effect the measurement cannot resolve**:

    | What is learned | Admitted by | Kept or retired by |
    | --- | --- | --- |
    | A **project playbook rule** (this repository's paths, kinds, error codes) | A person's approval | Paired credit on this project's own attempt records, with rotation (rule 16b); retired automatically when its credit turns negative over its last 10 applications |
    | An **execution-verified lesson** during a run | Probation in production only (never in a measurement run, rule 6) | The same credit; it becomes a candidate for a person's approval at the run's end |
    | A **harness change** (prompt, tool, budget policy, skill, context version) | A paired frozen-suite A/B that shows a gain at the suite's resolution (at least 20 points on 30 cards, one-sided exact test at 0.05; rule 16c) | **Inconclusive** (the usual case): the change may be adopted only if it is cheaper or simpler and the paired result shows no significant loss, recorded as "not established"; otherwise it is not adopted |

    The frozen suite never admits a project rule: its fixtures cannot exercise a rule scoped to one repository's paths and error codes, so a suite score would measure nothing about it. The six inlets of rule 17 map onto the table: playbook rules are the first row; exemplar and skill *mechanisms*, prompts, tools and budget *policies* are harness changes; an individual exemplar enters by its inlet's volume threshold and structural filter (rules 20, MS-T8-6) and never within a measurement run; budgets and routes recalibrated inside an admitted policy are measurements, bounded by rule 17's ≤ 15% and rule 20's volume threshold; synthesised tasks are measurement instruments, admitted by revert-and-fail; generated tests stay advisory until a person promotes them. A skill a person installs into their own project is their configuration, like a hand-written `playbook.toml` rule: approved by them once its own checks pass ([extensibility.md](extensibility.md) item 17a), never a harness change.
16b. **Rotation and paired credit** — the statistic for the first two rows:
    - **Comparable cards** are cards of the same project and the same card class (`kind:ext`, [models.md](models.md) rule 31) whose scope the rule matches on every declared condition ([context.md](context.md) rule 24b).
    - **Rotation.** Among the comparable cards a rule matches, in the order they start, the rule is in the prompt of one and withheld from the next, alternately; each attempt record lists the rules its prompt held ([worker-loop.md](worker-loop.md) rule 39), so "with" and "without" are read from the ledger, never inferred.
    - **A pair** is two consecutive comparable cards, one with the rule and one without. Only **first attempts** count — never a retry or an escalated pass — and person-built attempts never do (rule 6a). A pair's outcome is whether each first attempt passed its gates (stop reason `gate_passed`).
    - **Credit** over the rule's last 10 pairs is the number of *helpful* pairs (with it passed, without it failed) minus the number of *harmful* pairs (the reverse); pairs where both passed or both failed count for nothing. These are the rule's helpful and harmful counts; nothing else increments them. Below 10 pairs the rule reports "insufficient data" and is neither credited nor retired.
    - **Retirement.** When the credit is below zero the rule is retired automatically, with its pairs as the evidence. A retired rule returns only by a person's approval, starting a fresh count.
    - **Probation** uses the same rotation and statistic within one production run, with no minimum: a lesson is withdrawn as soon as its credit over the pairs completed in the run is below zero, and one still on probation at the run's end goes to a person for approval with its pairs.
    - A rule with no real effect will sometimes retire by chance on 10 pairs. That is accepted: a person's approval, not the credit, admitted it, and retiring a rule that does nothing costs nothing; the credit only has to catch rules that hurt.
16c. **Harness changes.** The A/B is paired and interleaved on the frozen suite (rules 10, 13, MS-T7-4), at least two paired runs per arm (rule 19), against the recorded baseline `RunProfile` (rule 9a). **Admitted** when a one-sided exact test rejects "no gain" at 0.05 with a difference of at least 20 points (rule 11). **Inconclusive** — neither a resolvable gain nor a resolvable loss — the change may still be adopted when it is **cheaper** (lower median seconds per card, or tokens per card, over the paired runs) or **simpler** (it removes code, a tool, a switch or prompt tokens and adds none), **and** a one-sided exact test does not reject "no loss" at 0.05; `SUITE_RUNS.md` records it as "not established — cheaper" or "— simpler", with the context version or harness commit it admits. Otherwise the change is not adopted. An adopted change is watched and rolled back on a paired loss the suite resolves (rule 18).

### Self-improvement: one mechanism, six inlets

17. An objective signal becomes a bounded proposal; every proposal, whatever produced it, is admitted by the rule for its kind in the admission table (rule 16a) — a harness change by the frozen suite, a project rule by a person and then its paired credit — pinned by hash or commit when it takes effect, and watched afterwards. What varies between inlets is what they propose; how a proposal earns its place does not vary.

    | Inlet | Recorded signal | Proposes | Bound |
    | --- | --- | --- | --- |
    | Playbook rules | Repeated gate failures; send-back reasons | Add or retire a rule | One rule per retrospective |
    | Budgets and routes | Pass rate by card class, size, model, arm, steps | Adjust a class budget or a route | ≤ 15% per calibration cycle |
    | Skills | Recurring multi-step trajectories that passed | Package one as a skill with its own checks | One skill per proposal |
    | Exemplars | Accepted cards correlated with later pass rates | Index the top trajectories per class | Two per class |
    | Synthesised tasks | Fix commits and closed issues in this repository (C₋₁ fails, C₀ passes; paths scrubbed from the problem statement; dependencies installed in an ephemeral worktree per task) | A fail-to-pass regression task | Discarded if reverting the fix does not fail |
    | Generated tests | Mutants surviving the mutation gate | A test that kills the mutant | Advisory until a person promotes it; demoted to advisory again when the change it guards is rolled back |

    A seventh inlet must justify itself by the size of the signal it reads, not by the paper it comes from. Offline policy tuning (`sekhemet tune`: replaying recorded trajectories to choose when to stop an attempt; conservative, since a replayed policy can only stop earlier) feeds the budgets-and-routes inlet and proposes, never applies; a fresh repository with no history of its own starts from the machine's global tuning report, as a proposal through the same inlet. Every signal an inlet reads is tagged with its **source** (a gate transition, an attempt record, a person's action including an edit, a model's synthesis) and **how it was verified** (executed, approved by a person, or unverified); an unverified model synthesis never admits anything on its own.
18. **Guardrails.** (1) Every change is triggered by an objective, recorded signal; self-assessment is rejected. (2) Each inlet's bound holds; whole-system rewrites are blocked. (3) Every change is versioned or hash-pinned and rolled back automatically if the pass rate drops, compared **paired** — the same kind of cards with and without the change — never against whatever different cards ran before. (4) **Admission is grounded, never textual:** nothing durable is admitted unless a quantity measured outside the generated text strictly improves. For skills and generated tests the grounded signal is execution: a skill's own checks run in the gate host's sandbox as gates before the suite is even consulted.
19. **A harness change's admission needs a significant gain:** a one-sided exact test (or an interval excluding zero) over at least two paired runs on the suite path, with the suite hash checked. A delta of zero is not a gain. The one exception is rule 16c's inconclusive case — cheaper or simpler with no significant loss — which is recorded as "not established", never as a gain.
20. **Volume thresholds.** Below its minimum an inlet reports "insufficient data" instead of acting:

    | Inlet | Minimum before it may act |
    | --- | --- |
    | Playbook rules | 3 occurrences of the same signal |
    | Budgets and routes | `MIN_ARM_TRIALS` (5) per arm, with a Wilson interval that excludes the incumbent |
    | Skills | 3 instances of the trajectory, and its checks pass |
    | Exemplars | 5 accepted cards in the class, each structurally complete |
    | Synthesised tasks | None; each is validated by revert-and-fail |
    | Generated tests | None; advisory until promoted |

21. **A cheap pre-filter must be calibrated.** A fast surrogate score used to discard proposals before the full suite is calibrated against an anchor set scored both ways, with a monotone (isotonic) map, and is used only once the anchor set holds `MIN_ARM_TRIALS` pairs.
22. **What public data may seed.** Difficulty may be initialised from the SWE-bench Verified human annotations (1,699 instances, three annotators each), to calibrate the 1–10 scale only, never to rank TypeScript cards (the labels are Python time-to-fix estimates, 46% of them one repository). The pre-filter's calibration *form* may start from public (surrogate, ground-truth) pairs. Public outcome matrices may enter only as derived pass/fail booleans, never patch text. **Exemplars, playbook rules and routing are local-only by construction**: public trajectories carry another harness's tool vocabulary, review corpora have no join key to this harness's gates, and public data has no tool-arm dimension. Nothing is imported without the owner's yes.
23. **Excluded from v1:** weight updates (fine-tuning, RL) of any model. **Permanently excluded from self-modification:** the loop driver, the gate runner, sandbox boundaries and permission tables.
24. **Diagnostics** (`sekhemet doctor`'s playbook check and `qualify`) measure each skill and rule against a bare baseline on the suite: net pass-rate gain, token overhead in Zone 2 (a rule or skill adding more than 300 tokens to Zone 2 is flagged as **context debt** when its admission record shows no gain: for a rule, a paired credit (rule 16b) of zero or less over its last 10 pairs, or still "insufficient data" after 20 comparable cards; for a skill, a suite A/B recorded "not established" — a "significant gain of at least 3 points" was the earlier test, which the 30-card suite cannot detect), and conflicting, redundant or obsolete rules, each offered for retirement in one action. The diagnostics read the real outcomes, skills and rules — including rules on the ledger — not an empty input.
25. **Mutation as a measure.** A mutation campaign (the generated-tests inlet, `improve --mutants`) first runs the tests on the unmutated checkout and refuses to score if they fail; a change with no mutable lines scores "not applicable"; a language the campaign cannot mutate is reported, never silently skipped.

### The research register

26. Every candidate technique moves through `spotted → triaged → shortlisted → benched → adopted | rejected`, never skipping a state on the way to adopted (rejection is allowed from any state). From `shortlisted` on it carries an **adoption threshold and the date it was set**, and that date is on or before its last move, so the bar is fixed before the bench. `benched`, `adopted` and `rejected` entries carry evidence. `sekhemet register advance <id> <state> --evidence …` refuses an illegal move; `sekhemet register check` and its test fail the build when an entry breaks a rule. Entries adopted before the register existed say so and still owe a bench run against their threshold. **At most two techniques are adopted per phase** of the modernization plan: with only 20-point effects detectable on the suite, adopting more at once makes their effects impossible to tell apart (NEW-measurement-3).

### Open benchmarks on the reference machine

27. The benchmarks still owed on the reference machine (tool arm, step-budget curve, engine and cache retention, prefix-cache hit, planner swap cost, card size against pass rate, KV quantisation, pruner latency, mutation cost — seconds per mutant for acceptance-test-only runs and for suite runs, separately — vision false-pass rate, MTP, prompt optimiser, condensing reduction, scope precision and recall, goal-monitoring thresholds, each inlet against its baseline, the thinking policy) are kept, with their state and what each blocks, in [OPEN_QUESTIONS.md](../../reference/OPEN_QUESTIONS.md). Each is answered under this spec's statistics, recorded in `SUITE_RUNS.md`, and closed in the spec that owns the setting it decides.
27a. **Quantisation against the harness** ([PM_RESEARCH_SYNTHESIS.md](../../research/PM_RESEARCH_SYNTHESIS.md) §1 row 13 and §2 step 2). Nobody knows how much of the Worker's 25–40% failure rate is the 3-bit quantisation rather than the harness, and every harness improvement is bounded by the answer. The run: the frozen suite, paired and interleaved (rule 10), on the same Worker weights at IQ3_XXS and at a higher quantisation (Q4_K_M or above), with the same engine build, settings, context version and `RunProfile`, both arms on the same host. No build of the Worker above IQ3 fits the 24 GB reference host beside its KV cache (the Ornith-1.5 base's official GGUF is Q4_K_M at 21.7 GB, [MODEL_CANDIDATES.md](../../research/MODEL_CANDIDATES.md)), so both arms run on a larger host; whether a higher build of the same weights is published is checked first, and if none is, the run is recorded as blocked rather than substituted. The research proposed "more than ~15 points"; the suite resolves only 20 (rule 11), so a gain of at least 20 points says the quantisation, not the harness, is the bottleneck, and a smaller difference is "not established". It is the evidence [DEC-04](../DECISIONS.md#dec-04)'s "reopen if" needs — a paired run of at least 30 tasks with another local model of the same size ahead by 20 points — and it is to be listed among OPEN_QUESTIONS' benchmarks as blocking that decision.

### The fixtures' recorded bars

28. Earlier phases set bars on particular fixtures. They are kept here as recorded history so no one re-proposes them unknowingly; none is a v1 pass condition — v1 is judged by rule 4's interval and DoD §5.5 — because each was set before the statistics of rules 10–13 and on one run:

    | Bar | Set for | Still in force? |
    | --- | --- | --- |
    | Chronicle scorecard: Pass@1 ≥ 80% (5 of 6 cards on the first attempt), repair within ≤ 3 rungs, zero test mutation, zero out-of-scope writes, all 6 cards < 18 min on an M4 | Chronicle, the first fixture | As diagnostics only: zero test mutation and zero out-of-scope writes are enforced by gates and the write contract for every card; the 5/6 and 18-minute figures are single-run targets, reported beside the suite result, not pass conditions |
    | Showcase Trifecta: 24 cards (onyx, vanguard, basalt-canvas), < 140 changed lines per card, ~39 min autonomous, ≥ 98% slot-0 prompt-cache hit | The three showcase fixtures | The card-size bound is superseded by the 200-line gate; the cache target by [context.md](context.md)'s median ≥ 0.85 after the first step; the 39-minute run time is reported, not required |
    | M0 go/no-go: ≥ 90% valid-and-correct tool execution over 30 seeded tasks × 3 runs at step budgets 50 and 150; rework at 70–90%; below 70%, narrow the product to planning and review assistance | Phase 0's Worker decision | The protocol is kept in `sekhemet m0` (`m0.ts:6-46`: 30 tasks, 3 runs, budgets 50 and 150); the bar is historical — Phase 0's 11/11 establishes ≥ 76% at 95%, not ≥ 90% — and whether the pivot rule stands as a standing decision is §8 Q4 (tool-arm measurement is [models.md](models.md) NEW-models-5) |

### Evaluation assets (T11)

29. Several acceptance criteria in other specifications are scored against labelled data that must exist before the criterion can fail. These **evaluation assets** are owned here and treated like the frozen suite: each is versioned, hashed and listed in one manifest (`fixtures/eval_assets.json`) with its size, who labelled it and the criteria that use it; a result records the hash of the asset it was scored on and is comparable only with results on the same hash; an item is never edited to improve a result — a change is a new version. Labels are a person's or executed (a reference solution passes its frozen tests), never a model's. A **held-out** part is never shown to the role it tests. The assets, each built before the first criterion that uses it:

    | Asset | Size | Held out | Used by | Built in |
    | --- | --- | --- | --- | --- |
    | Reference solutions per fixture card | one per card (30) | from the Worker | MS-T7-2, MS-T7-3; scope precision and recall ([context.md](context.md) CX-P1-5) | B2.4 |
    | Golden briefs with annotated implicit requirements | ≥ 10 briefs | the annotations, from the Planner and Seshat | MS-T7-7; P14 ([design-stage.md](design-stage.md)) | B2.4 |
    | Held-out acceptance suite for premature completion | one per golden brief and fixture specification | wholly, from the Planner and Seshat | MS-T7-8 | B2.4 |
    | Research golden set | 25 questions with sourced answers | the answers, from the Researcher | NEW-design-stage-2; the Researcher bake-off ([models.md](models.md) NEW-models-11) | B2.4 |
    | Labelled reuse set | ~40 needs, each with the package a person judged right | the judgements, from the design stage | P7 ([design-stage.md](design-stage.md)) | B2.4 |
    | Seeded defects for the Reviewer | ≥ 20 defects in real diffs | the defects' locations, from the Reviewer | P8 ([review-git.md](review-git.md)) | B2.4 |
    | Scripted PM conversations with a rubric | ~20 | the rubric's expected answers, from Seshat | P6 ([planner-pm.md](planner-pm.md)) | B2.4 |
    | Scripted non-developer project starts | 5 | — | P2 ([planner-pm.md](planner-pm.md), [design-stage.md](design-stage.md)) | B2.4 |
    | Injection fixtures | one per injection route | from the Worker | NEW-security-4 ([security.md](security.md)) | B1, with S3 |
    | Labelled UI screens for the vision checklist | ≥ 60 a person approved, ≥ 30 with a seeded visual defect | the labels, from the vision model | [gates.md](gates.md) rule 30, GT-N4-2 | B2.4 |

## 3. Contract

| Item | Source |
| --- | --- |
| Suite manifest | `fixtures/suite.json` |
| `loadFrozenSuite`, `runFrozenSuite`, `summarise`, `compareRuns` | `packages/eval/src/suite.ts` |
| Suite runner (today a script) | `scripts/run_suite.mjs` — `node scripts/run_suite.mjs --worker <model> [--fixtures …] [--out <file>]` |
| Admission and rollback: `runFrozenRegressionGate`, `LearningGuard` | `packages/eval/src/guardrails.ts` |
| Inlets: `harvestExemplars`, `siftSlice`, `distillSkill` and the rest | `packages/eval/src/loops.ts` |
| Task synthesis, history mining | `packages/eval/src/synthesis.ts`, `history.ts` |
| Variant archive (register R5) | `packages/eval/src/archive.ts` |
| Mutation campaign | `packages/eval/src/mutation.ts`, `apps/harness/src/mutation_step.ts` |
| Benchmark harness, adapter wrapper | `packages/eval/src/benchmark.ts`, `instrumentation.ts` |
| Diagnostics | `packages/eval/src/diagnostics.ts` |
| Rule store and counters | `apps/harness/src/learning/store.ts` |
| Policy tuning | `apps/harness/src/tune.ts` |
| Register | `docs/research/RESEARCH_REGISTER.md`; `apps/harness/src/registers.ts` |
| M0 protocol `M0_DEFAULTS` (runs 3, budgets 50 and 150, 30 tasks) | `packages/eval/src/m0.ts:46` |
| Bake-off matrix `MODEL_MATRIX.md` | `packages/eval/src/report.ts:133-200` |
| Run settings `RunProfile` (new), `--settings <file>` | `apps/harness/src/index.ts` |
| CLI: `sekhemet m0`, `qualify`, `improve [--mutants]`, `bake-off`, `tune`, `register advance|check` | `apps/harness/src/wave2.ts`, `index.ts` |
| Record of runs | [SUITE_RUNS.md](../../reference/SUITE_RUNS.md) |
| Evaluation-asset manifest (new, T11) | `fixtures/eval_assets.json` |
| Rule credit (new, rule 16b): one function over `attempt/finished` records | `packages/eval` (T8) |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Frozen suite, versioned, hash-compared | built | `suite.ts`; `suite.spec.ts` | — |
| Suite hash covers card specs and seed scripts | not-built | Chronicle's card specs live in `scripts/seed_chronicle.mjs`, outside the hash (`suite.ts:90-124`) | NEW-measurement-1 |
| Accept passing cards; blocked cards recorded as blocked | built | `run_suite.mjs` (fix after runs 1–2; `./x.js` imports read since 47097ec) | — |
| Pass rate with an exact interval; blocked reported separately | not-built | raw counts; blocked counted as failures (`run_suite.mjs:171-190`) | M12 |
| Self-describing run; mixed-build abort | not-built | records only suite hash and worker (`run_suite.mjs:262`); run 1 split across two builds undetected | NEW-measurement-1 |
| Learned state isolated; no in-run exemplars or rules | not-built | a passing card becomes an exemplar for later cards in the same run (`execute.ts:721-742`); `queue` puts candidate rules in force (`store.ts:236-247`) | NEW-measurement-1 |
| Model resident across cards | not-built | `run` unloads on exit (`index.ts:1147-1153`) despite the runner's comment | T7 |
| Reference solutions; independent per-card trials | not-built | — | T7 |
| One measurement path | not-built | three runners: `run_suite.mjs`, `run_gate.sh` → `queue`, `BenchmarkHarness` (32k context, no project gates, thinking or method; `benchmark.ts:279-297`, `settings.ts:17`); `InstrumentedAdapter` forwards only `generate` (`instrumentation.ts:22-60`) | M9 |
| Paired comparison, exact/Bayesian tests, repeated runs | not-built | `compareRuns` counts +1 task as "improved" (`suite.ts:186-193`); no interval anywhere in eval; a Wilson function only in `pm/capability.ts:31` | M12, T7 |
| Planning measure | not-built | — | T7 |
| Pruner null baseline | not-built | the pruner is dormant (never fired on a real prompt) | T7 |
| Six inlets exist | partial | `loops.ts` still implements the old "loops 3, 4, 5, 8, 9"; `compareRuns`, `TaskSynthesizer`, `evolvePrompts`, `reflectiveMutator`, `paretoFront`, `siftProposals`, `mineCommitCandidates` unreachable | T8 |
| Admission requires a significant gain | not-built | `runFrozenRegressionGate` accepts a delta of 0 (`guardrails.ts:94-104`; enshrined by `wave2.spec.ts:198`); rule gate uses `run_gate.sh` → `queue` without a hash check (`wave2.ts:1140-1200`) | T8 |
| Paired rollback guard | not-built | compares against the previous ten *different* cards, or 1.0 on empty history (`guardrails.ts:147-150`); at n = 10 the SD ≈ 0.16 against a 0.1 threshold | T8 |
| Volume thresholds | partial | rules: one struggle creates a candidate; exemplars: no minimum (`loops.ts:332-360`); arms: `MIN_ARM_TRIALS = 5` built (`registry.ts:81`) | T8 |
| Skill admission by its own checks | not-built | `distillSkill` writes candidates; nothing runs their `evals/` | T8 |
| Calibrated pre-filter | not-built | — | T8 |
| Diagnostics on real inputs | partial | `playbookDiagnostics({ repoPath })` called with no outcomes, skills or cards (`wave2.ts:1111`); ledger rules not read | NEW-measurement-2 |
| Mutation baseline run | not-built | no unmutated run; a broken checkout scores 1.0; nothing mutable scores 1 (`mutation_step.ts:103-145`); Python/Rust skipped silently (`:39`) | M10 |
| Policy tuning by replay | built | `tune.ts`; `tune.spec.ts` | — |
| A fresh repository seeded from the global tuning report | not-built | `tune` reads only the current repository | T8 |
| Signals tagged with source and verification | not-built | — | T8 |
| Generated tests demoted on rollback | not-built | promotion exists; no rollback path touches them (`mutation_step.ts:150-160`) | T8 |
| Synthesised tasks install dependencies in an ephemeral worktree | not-built | `TaskSynthesizer` is unreachable (T8 row above) | T8 |
| One recorded `RunProfile`; measured runs have the product's roles and policies on | not-built | flags assembled per command; the benchmark runs with exploration, Reviewer, Researcher and escalated retries off (integration review E3) | M9 |
| Person-built attempts excluded from every measure | not-built | no `builtBy` yet ([kernel.md](kernel.md) NEW-kernel-6) | NEW-measurement-4 |
| Planning measure reports test strength per card | not-built | the planning measure itself is not built | NEW-measurement-4 |
| At most two adoptions per phase | not-built | the register does not count adoptions per phase | NEW-measurement-3 |
| Research register with pre-set thresholds | built | `registers.ts`; `registers.spec.ts` | — |
| M0 protocol (30 tasks × 3 runs × budgets 50/150) | built | `m0.ts:6-46`; `sekhemet m0` | — (its runner: M9) |
| One admission table; paired rule credit with rotation; the inconclusive rule | not-built | rules credited with every card's outcome (`learning/store.ts:258-280`); `runFrozenRegressionGate` has no inconclusive verdict (`guardrails.ts:94-104`) | T8 (with [context.md](context.md) NEW-context-4) |
| Evaluation assets: manifest, hashes, held-out parts | not-built | only the frozen suite exists (`fixtures/suite.json`); none of the assets of rule 29 | T11 |
| Quantisation against the harness run | not-built | never run | T7 |

## 5. Changes for v1

### M9 — one measurement path

- **MS-M9-1** WHEN `m0`, the bake-off, the rule gate or the suite runs a card THE SYSTEM SHALL execute it through the product's card execution, and the rendered first prompt SHALL be byte-identical to the product's for the same card, build and settings.
- **MS-M9-2** WHEN a model adapter is wrapped for instrumentation THE SYSTEM SHALL expose `contextWindow`, `nativeTools` and `preferredToolArm` unchanged and meter cached prompt tokens.
- **MS-M9-3** WHEN the suite runs THE SYSTEM SHALL use the runner module in `packages/eval`, covered by tests of dependency blocking, acceptance of passing cards, timeout attribution and per-attempt token totals.
- **MS-M9-4** WHEN any measured run starts THE SYSTEM SHALL resolve one `RunProfile` from configuration and flags, write it into the run's evidence, and run with the roles and policies the product ships switched on unless the profile names an arm under test.
- **MS-M9-5** WHEN a flag would change the value of another setting THE SYSTEM SHALL refuse it; WHEN `--settings <file>` names a settings file THE SYSTEM SHALL record the file's content hash in the evidence.

### M10 — mutation scores that cannot lie

- **MS-M10-1** WHEN the tests fail on the unmutated checkout THE SYSTEM SHALL refuse to score the campaign and report why.
- **MS-M10-2** WHEN a change has no mutable lines THE SYSTEM SHALL record the score as not applicable (`null`), not 1.
- **MS-M10-3** WHEN the changed files are in a language the campaign cannot mutate THE SYSTEM SHALL report the files as not measured.
- **MS-M10-4** WHEN the built-in mutation gate runs on a card ([gates.md](gates.md)) THE SYSTEM SHALL apply the same baseline rule.

### M12 — statistics that fit the sample

- **MS-M12-1** WHEN a suite run is summarised THE SYSTEM SHALL report passed / measured with a Clopper–Pearson 95% interval, and blocked cards as a separate count.
- **MS-M12-2** WHEN two runs are compared THE SYSTEM SHALL compare only cards run in both, report the discordant counts and an exact McNemar p-value, and state the smallest difference detectable at 80% power.
- **MS-M12-3** WHEN two runs differ by one task and the exact test is not significant THE SYSTEM SHALL NOT report "improved" (the current `suite.spec.ts:125` expectation is reversed).
- **MS-M12-4** WHEN a claim of an effect under 20 points is written from a 30-card comparison THE SYSTEM SHALL mark it "not established" in the summary.
- **MS-M12-5** WHEN repeated runs exist THE SYSTEM SHALL report pass@k and pass^k per card.

### T7 — paired, independent trials and the planning measure

- **MS-T7-1** WHEN a measured run starts THE SYSTEM SHALL keep the Worker model loaded until the run ends, and report load time separately.
- **MS-T7-2** WHEN a fixture card has a reference solution THE SYSTEM SHALL verify that the frozen tests fail on the seed and pass on the reference before any run uses it, and the reference SHALL be covered by the suite hash.
- **MS-T7-3** WHEN a single card is run in independent mode THE SYSTEM SHALL start it from a `main` that holds its predecessors' reference work, and its result SHALL not depend on any earlier card's outcome.
- **MS-T7-4** WHEN two arms are compared THE SYSTEM SHALL interleave them card by card with fixed seeds, and MAY stop early only under a sequential test whose error rate is stated.
- **MS-T7-5** WHEN the planning measure runs on a fixture THE SYSTEM SHALL report, per generated card, SPIDR shape, scope (files, lines), fail-at-seed, pass-on-reference and mutants killed; and, end to end, the share of held-out hand-written acceptance tests passing on the final `main`, next to — never merged into — the suite score.
- **MS-T7-6** WHEN the context pruner is evaluated THE SYSTEM SHALL compare it on the suite with structure-preserving random line dropping at the same token budget and record the result against register R3.

- **MS-T7-7** WHEN the planning measure runs THE SYSTEM SHALL also score **implicit-requirement recall**: the share of annotated unstated requirements in the golden set of briefs (at least 10 briefs, ReqElicitGym-style, T11) that end up in the accepted requirement graph, reported with an exact interval ([PROJECT_DONE_AND_DEPTH.md](../../research/PROJECT_DONE_AND_DEPTH.md) §3).
- **MS-T7-8** WHEN the planning measure runs THE SYSTEM SHALL score the **premature-completion rate**: the share of projects or slices the system marked proven that the held-out acceptance suite (T11), never shown to the planner, shows are not, reported with an exact interval ([PROJECT_DONE_AND_DEPTH.md](../../research/PROJECT_DONE_AND_DEPTH.md) §3).

### T8 — admission by the one rule: a significant paired gain for harness changes

- **MS-T8-1** WHEN a harness change's candidate run passes the same number of tasks as the baseline THE SYSTEM SHALL NOT admit it as a gain.
- **MS-T8-2** WHEN a harness change is evaluated THE SYSTEM SHALL use at least two paired runs on the suite path with the suite hash checked, and admit it as a gain only if a one-sided exact test rejects "no gain" at 0.05 (the inconclusive case is MS-T8-13).
- **MS-T8-3** WHEN an admitted change is watched THE SYSTEM SHALL compare cards run with and without it (paired), and roll it back automatically, flagging it, when the paired comparison shows a drop; with no history, it SHALL NOT assume a baseline of 1.0.
- **MS-T8-4** WHEN an inlet is below its volume threshold THE SYSTEM SHALL report "insufficient data" and propose nothing; one struggle SHALL NOT create a rule in force.
- **MS-T8-5** WHEN a skill candidate is proposed THE SYSTEM SHALL run its own checks in the gate host's sandbox first and discard it if they fail.
- **MS-T8-6** WHEN a trajectory has an unclosed tool call or out-of-order events THE SYSTEM SHALL NOT admit it as an exemplar or a skill source.
- **MS-T8-7** WHEN a pre-filter score discards a proposal THE SYSTEM SHALL have calibrated it on at least `MIN_ARM_TRIALS` anchor pairs; below that, every proposal SHALL go to the suite.
- **MS-T8-8** WHEN the eval package is built THE SYSTEM SHALL contain no inlet function unreachable from a command (reachability check), each having been wired into one of the six inlets or cut with the owner's sign-off.
- **MS-T8-9** WHEN an inlet records a signal THE SYSTEM SHALL tag it with its source and how it was verified, and an inlet SHALL NOT propose from signals that are all unverified model syntheses.
- **MS-T8-10** WHEN an admitted change is rolled back THE SYSTEM SHALL demote every generated test promoted because of it to advisory, and say so on each test's card.
- **MS-T8-11** WHEN `sekhemet tune` runs in a repository with fewer than `MIN_ARM_TRIALS` recorded attempts per class THE SYSTEM SHALL propose from the machine's global tuning report and label the proposal as inherited.
- **MS-T8-12** WHEN a task is synthesised from a fixing commit THE SYSTEM SHALL install its dependencies in an ephemeral worktree for that task, keep it only if the test fails on the commit before the fix and passes on the fix, and scrub file paths from its problem statement.
- **MS-T8-13** WHEN a harness change's paired A/B is inconclusive THE SYSTEM SHALL record it as adoptable only if the change is cheaper (lower median seconds or tokens per card over the paired runs) or simpler (it removes code, a tool, a switch or prompt tokens and adds none) and a one-sided exact test does not reject "no loss" at 0.05, and SHALL write the verdict "not established — cheaper" or "not established — simpler" with the context version or harness commit; in every other inconclusive case it SHALL record "not adopted".
- **MS-T8-14** WHEN a rule's or a probationary lesson's credit is needed THE SYSTEM SHALL compute it with one function in `packages/eval` from `attempt/finished` records alone — rotation membership, pairs of first attempts on comparable cards, helpful minus harmful over the last 10 pairs, "insufficient data" below 10 — and a test with ten scripted pairs (three helpful, five harmful) SHALL return −2 and retire the rule.

### T11 — evaluation assets

*Problem:* criteria in design-stage, planner-pm, review-git, gates, security and here are scored against labelled data nobody was scheduled to build, so they cannot fail and cannot pass (review M4).

- **MS-T11-1** WHEN an evaluation asset is registered THE SYSTEM SHALL record in `fixtures/eval_assets.json` its name, version, content hash, item count, the principal who labelled it and the criteria that use it, and SHALL refuse an entry missing any of them.
- **MS-T11-2** WHEN a criterion is scored against an asset THE SYSTEM SHALL verify the asset's hash against the manifest and refuse to score on a mismatch or on fewer items than the manifest declares, naming the asset; the result SHALL record the asset's hash, and two results SHALL be compared only when their hashes match.
- **MS-T11-3** WHEN the role an asset tests assembles a prompt over the asset's inputs THE SYSTEM SHALL include none of its held-out content (a test assembles the Planner's, Seshat's, the Researcher's, the Reviewer's and the vision checklist's prompts over each asset and searches them for every held-out item).
- **MS-T11-4** WHEN an asset's labels are recorded THE SYSTEM SHALL record the principal who labelled each item, and SHALL refuse a label whose only source is a model; a reference solution SHALL count as labelled only when it passes its card's frozen tests (MS-T7-2).
- **MS-T11-5** WHEN an asset item changes THE SYSTEM SHALL record a new version and hash, and the manifest SHALL keep the earlier version's hash so results on it stay identifiable.
- **MS-T11-6** WHEN every asset in rule 29's table is registered THE SYSTEM SHALL report each at or above the size the table gives (≥ 10 golden briefs, 25 research questions, ~40 reuse needs, ≥ 20 seeded defects, ~20 PM conversations, 5 project starts, one reference solution per fixture card, ≥ 60 approved and ≥ 30 defective screens).

### NEW-measurement-1 — self-describing, isolated runs

*Justification:* the evidence cannot say which build produced it, the suite hash misses the card specs, and trials leak learned state into each other — a result must say what produced it.

- **MS-N1-1** WHEN a seed script or card specification changes THE SYSTEM SHALL change the suite hash.
- **MS-N1-2** WHEN a measured run starts THE SYSTEM SHALL record the harness commit and dirty flag, the SHA-256 of each `dist`, every `SEKHEMET_*` variable, the server's `/props` and build, and the host fingerprint.
- **MS-N1-3** WHEN any `dist` hash changes between two cards of a run THE SYSTEM SHALL abort the run and say which package changed (a planted rebuild in a test aborts it).
- **MS-N1-4** WHEN a measured run executes THE SYSTEM SHALL use an isolated configuration directory, model registry and exemplar store, SHALL NOT make any rule or exemplar learned during the run available to a later card of the run, and SHALL record in each card's evidence the rules and exemplars it saw.

### NEW-measurement-2 — diagnostics on real inputs

*Justification:* the doctor's playbook check is called with no outcomes, skills or cards, so net gain and context debt can never appear.

- **MS-N2-1** WHEN `sekhemet doctor` runs in a project with recorded outcomes, skills and rules THE SYSTEM SHALL pass them to the diagnostics, including rules on the ledger.
- **MS-N2-2** WHEN a rule adds more than 300 Zone-2 tokens and its paired credit (rule 16b) over its last 10 pairs is zero or less — or it still has "insufficient data" after 20 comparable cards — or a skill adds more than 300 Zone-2 tokens and its suite A/B is recorded "not established", THE SYSTEM SHALL flag it as context debt, naming the tokens and the record, and offer its retirement.

### NEW-measurement-3 — adoptions per phase

*Justification:* the old design capped adopted techniques at two per phase; with a suite that detects only 20-point effects, more adoptions at once cannot be told apart (trace hd2 440).

- **MS-N3-1** WHEN a third technique would move to `adopted` within one phase THE SYSTEM SHALL refuse the move in `register advance`, naming the two already adopted, unless the owner's override is recorded.

### NEW-measurement-4 — test strength and human-built work in the measures

*Justification:* "proven" must be conditioned on measured test strength, whose first threshold needs a measurement before any project uses it; and once people build cards, the Worker's measured record must not mix their work in ([DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) §3.8; [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 2).

- **MS-TQ-1** WHEN the planning measure runs THE SYSTEM SHALL report, per generated card, red-at-assertion, stub-kill, the acceptance-test mutation score and the oracle cross-check disagreement rate, beside the existing fail-at-seed, pass-on-reference and mutants-killed figures.
- **MS-TQ-2** WHEN the first blocking acceptance-test mutation threshold is proposed THE SYSTEM SHALL derive it from at least one planning-measure run and record it in the register with its date before any project uses it.
- **MS-TQ-3** WHEN mutation cost is benchmarked on the reference machine THE SYSTEM SHALL record seconds per mutant for acceptance-test-only runs and for suite runs separately.
- **MS-N4-1** WHEN a pass rate, a paired comparison, an inlet signal or a competence row is computed THE SYSTEM SHALL exclude attempts whose `builtBy.kind` is `person`, and the summary SHALL state how many were excluded.

## 6. v1 acceptance

This spec is `built` when §5 passes, the full frozen suite has run on the release build with an exact 95% interval and every failure named (DoD §5.5, §6.3), the planning measure has run once with its score recorded, and these stay under test:

- **MS-1** WHEN two runs have different suite hashes THE SYSTEM SHALL refuse to compare them, naming both hashes.
- **MS-2** WHEN a register entry is advanced past `shortlisted` without a threshold, or its threshold date is after its last move THE SYSTEM SHALL refuse the move and fail `register check`.
- **MS-3** WHEN a replayed stopping policy would stop a recorded passing attempt before its pass THE SYSTEM SHALL count that attempt as failed under the policy.
- **MS-4** WHEN `sekhemet m0` runs with defaults THE SYSTEM SHALL run up to 30 tasks, 3 runs each, at step budgets 50 and 150, and report tasks that pass at 150 but never at 50 as step-starved.

## 7. Later

- **Calibrating against published systems** by fitting an item-response model to the public per-instance SWE-bench results (~10⁵ outcomes), so difficulty is on a published scale. Limits that bind it: the data is Python-heavy and concentrated in few repositories, so it calibrates a scale, never ranks TypeScript work; and success is dominated by the scaffold (16.7% vs 47.9% on the same instances), so nothing about routing or models may be fitted from it. Only the derived pass/fail matrix may be imported; the repository carries no licence and some patches are copyleft. An IRT or Bayesian capability model waits until about 30 attempts per kind exist.
- **The ceiling run** with a frontier model as Worker, after local v1 meets the Definition of Done ([DEC-07](../DECISIONS.md#dec-07)); a reference scaffold (mini-swe-agent, MIT) would separate harness defects from model limits — *proposed*.
- **Offline prompt optimisation** (GEPA) and evaluation frameworks (Inspect AI, promptfoo, Terminal-Bench, `statsmodels`, `bayes_evals`) — *proposed, need the owner's yes*; the in-repo statistics (~80 lines: Clopper–Pearson, Wilson, exact McNemar, paired bootstrap, SPRT) come first.
- **Fixtures in Python and Rust.** The old layout planned fixtures across TypeScript, Python and Rust; the frozen suite is TypeScript only until a non-TypeScript project becomes a v1 target ([DEC-20](../DECISIONS.md#dec-20)).
- **Mining this repository's own history for tasks** at SWE-rebench scale — the language-agnostic SWE-rebench pipeline could yield 10³–10⁴ TypeScript/Rust instances from permissively licensed dependencies, at real build-environment cost (69% of repositories fail to install).

## 8. Open questions

1. **Thinking A/B design.** DoD and the old design said "best pass rate for its wall-clock over at least two runs"; that cannot separate arms on 14–30 cards. *Recommendation:* rule 12 — paired, and when inseparable, the cheaper arm wins; run the surgical and all arms only after M1, M3 and M8, as COVERAGE sequences them.
2. **Loops 3, 4, 5, 8, 9 in `loops.ts`, and the variant archive (loop 7).** *Recommendation:* map `harvestExemplars` and `siftSlice` to the exemplar inlet and the re-run rule, `distillSkill` to the skill inlet, and cut the rest (needs the owner's sign-off). The variant archive (`archive.ts`, register R5: sample parents by performance, restore a previous variant pointer) is not one of the six inlets; *recommendation:* cut it, since rollback is by the paired rule and version pins, unless a seventh inlet is justified by its signal size (rule 17).
3. **Which public data to import.** *Recommendation:* only the SWE-bench Verified difficulty annotations (flag: licence unstated) and, for the pre-filter's form, the four scalar columns of `nebius/SWE-rebench-openhands-trajectories` (CC-BY-4.0); nothing else in v1. The survey's "single best import", `nebius/SWE-rebench-V2`, is not taken: it supplies difficulty *features* without labels (the Verified annotations are the only labels) and instances for anchor pairs, but each instance must be run under this harness — in its own container image and build environment — to become an anchor, which the one reference machine cannot afford in v1, and it carries patch text (59 copyleft rows, 5,038 with an unresolved licence) where rule 22 admits only derived booleans; its language-agnostic pipeline pointed at this project's own dependencies is the §7 item instead ([PUBLIC_DATA_SURVEY.md](../../research/PUBLIC_DATA_SURVEY.md) §1 and "The git-history alternative").
4. **The M0 pivot rule (owner decision).** If the Worker cannot run cards unattended (tool execution below 70% on the M0 protocol), the old plan narrowed the product to planning and review assistance. *Recommendation:* keep it as a standing decision in DECISIONS.md, re-evaluated on every Worker change, because it is the product's answer to its riskiest assumption.

## 9. Evidence and rationale

- Independent review of design v3 ([design_v3_review.md](../../reference/reviews/design_v3_review.md)): B6 (the admission table, [DEC-28](../DECISIONS.md#dec-28--one-rule-for-admitting-what-the-system-learns), owned here), M4 (T11), M5 and M6 (MS-N2-2, MS-T7-7, MS-T7-8), and the research-coverage notes on PM_RESEARCH_SYNTHESIS §2 step 2 (rule 27a), PROJECT_DONE_AND_DEPTH and `nebius/SWE-rebench-V2` (§8 Q3).
- Knowing when a project is done: [PROJECT_DONE_AND_DEPTH.md](../../research/PROJECT_DONE_AND_DEPTH.md) §3 — the two planning-measure items it adds to T7, implicit-requirement recall (ReqElicitGym, arXiv:2602.18306) and the premature-completion rate (NL2Repo-Bench's 49% early termination, arXiv:2512.12730), carried as MS-T7-7 and MS-T7-8.
- Review: [domain05_10_models_measurement.md](../../reference/reviews/domain05_10_models_measurement.md) (Domain 10); gap sweep ([gap_sweep.md](../../reference/reviews/gap_sweep.md): `instrumentation.ts`, `mutation_step.ts`, `diagnostics.ts`).
- Runs: [SUITE_RUNS.md](../../reference/SUITE_RUNS.md) — "both runs so far measured the wrong thing", the fingerprint defect in every run, run 1 split across two builds, the thinking A/B "off" arm (10/14, not separable from anything under 20 points).
- Statistics: [WEB_RESEARCH_2026-09.md](../../research/WEB_RESEARCH_2026-09.md) group D §C — Miller, "Adding Error Bars to Evals" (arXiv:2411.00640, paired differences, clustered errors, resampling); Bowyer et al. (arXiv:2503.01747, CLT intervals badly optimistic below a few hundred items); Bjarnason et al. (arXiv:2602.07150, single-run swings of 2.2–6.0 points, report pass@k and pass^k); HAL (arXiv:2510.11977); the power table (≈76/155/233 paired tasks at 10/20/30% disagreement; 6–7% power at 25 tasks). Phase 0's 11/11 establishes ≥ 76% at 95% (one-sided exact), not ≥ 90%.
- Benchmarks: group D §B (Commit0, ProjDevBench, NL2Repo-Bench, SlopCodeBench, DevBench, SWE-rebench).
- Grounded admission: SRMA (arXiv:2609.02750 — harmful proposals accepted 100% free-form, 34.5% self-gated, 6.2% grounded); skill admission by its own checks (Repo-To-Skill, arXiv:2609.02749); structural trajectory filter and prediction/decision/outcome rows (NeoHorse-1, arXiv:2609.08183); anchored surrogate calibration (WMRL, arXiv:2608.12564) — all in [PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md). Null baseline: arXiv:2609.03430.
- Public data: [PUBLIC_DATA_SURVEY.md](../../research/PUBLIC_DATA_SURVEY.md) (five verdicts; do-not-import list; the git-history alternative: this repository has ~155 usable commits).
- Open benchmarks: [OPEN_QUESTIONS.md](../../reference/OPEN_QUESTIONS.md).
- Decisions: [DEC-07](../DECISIONS.md#dec-07) (ceiling run after DoD), [DEC-09](../DECISIONS.md#dec-09) (unreachable code wired in or cut), [DEC-22](../DECISIONS.md#dec-22--rejected-techniques) (fine-tuning, public trajectories as exemplars, routing fitted to public results: rejected).
- *Changed on purpose* ([DEC-24](../DECISIONS.md#dec-24--deliberate-reversals-in-design-v3)): automatic rollback is decided by a paired comparison, not by a pass-rate drop over the next ten cards — at n = 10 the standard deviation is about 0.16 against a 0.1 threshold, so the window cannot separate noise from effect; the thinking A/B's winner is decided by the paired test with the cheaper arm winning a tie, not "best pass rate for its wall-clock over two runs"; the old `sekhemet dev audit` command's function lives in `sekhemet doctor`'s playbook check and `qualify` (rule 24); in-run learning is split by ruling R12 into production probation ([context.md](context.md) rule 24f) and measurement isolation (rule 6), where the integration review had proposed probation everywhere.
- Research: [DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) §3.1 and §3.8 (MS-TQ-1…3; mutation as a floor detector, not a proof: arXiv:2607.22880); [DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md) (adopting a model only through a bake-off). Integration review ([reviews/integration_review_2026-09-18.md](../../reference/reviews/integration_review_2026-09-18.md)) B1, E3, C6 and suggestions 8 and 12.
- Register process: [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md). Policy tuning after Dream-RSI (arXiv:2609.14858) and the capability model's Wilson intervals: [IMPLEMENTATION_AUDIT.md](../../research/IMPLEMENTATION_AUDIT.md).
