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
changes: [M9, M10, M12, T7, T8, NEW-measurement-1, NEW-measurement-2, NEW-measurement-3, NEW-measurement-4]
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
9. **One measurement path.** The suite runner lives in `packages/eval` as a tested module, and the bake-off, the rule gate, `m0` and every benchmark call it; each goes through the same card execution the product ships — same prompt, tools, thinking policy, working method, context window and tool arm, and the same roles and policies switched on (exploration, the Reviewer, the Researcher, escalated retries, the turn cap) as the product ships them, so the benchmark measures what ships, not a harness with most features off. Any wrapper around a model adapter forwards every property, not only `generate`, and meters cached prompt tokens.
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

### Self-improvement: one mechanism, six inlets

17. An objective signal becomes a bounded proposal; every proposal, whatever produced it, is scored against the frozen suite before it takes effect, pinned by hash or commit when it does, and watched afterwards. What varies between inlets is what they propose; how a proposal earns its place does not vary.

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
19. **Admission needs a significant gain:** a one-sided exact test (or an interval excluding zero) over at least two paired runs on the suite path, with the suite hash checked. A delta of zero is not a gain.
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
24. **Diagnostics** (`sekhemet doctor`'s playbook check and `qualify`) measure each skill and rule against a bare baseline on the suite: net pass-rate gain, token overhead in Zone 2 (a rule adding more than 300 tokens without a significant gain of at least 3 points is flagged as context debt), and conflicting, redundant or obsolete rules, each offered for retirement in one action. The diagnostics read the real outcomes, skills and rules — including rules on the ledger — not an empty input.
25. **Mutation as a measure.** A mutation campaign (the generated-tests inlet, `improve --mutants`) first runs the tests on the unmutated checkout and refuses to score if they fail; a change with no mutable lines scores "not applicable"; a language the campaign cannot mutate is reported, never silently skipped.

### The research register

26. Every candidate technique moves through `spotted → triaged → shortlisted → benched → adopted | rejected`, never skipping a state on the way to adopted (rejection is allowed from any state). From `shortlisted` on it carries an **adoption threshold and the date it was set**, and that date is on or before its last move, so the bar is fixed before the bench. `benched`, `adopted` and `rejected` entries carry evidence. `sekhemet register advance <id> <state> --evidence …` refuses an illegal move; `sekhemet register check` and its test fail the build when an entry breaks a rule. Entries adopted before the register existed say so and still owe a bench run against their threshold. **At most two techniques are adopted per phase** of the modernization plan: with only 20-point effects detectable on the suite, adopting more at once makes their effects impossible to tell apart (NEW-measurement-3).

### Open benchmarks on the reference machine

27. The benchmarks still owed on the reference machine (tool arm, step-budget curve, engine and cache retention, prefix-cache hit, planner swap cost, card size against pass rate, KV quantisation, pruner latency, mutation cost — seconds per mutant for acceptance-test-only runs and for suite runs, separately — vision false-pass rate, MTP, prompt optimiser, condensing reduction, scope precision and recall, goal-monitoring thresholds, each inlet against its baseline, the thinking policy) are kept, with their state and what each blocks, in [OPEN_QUESTIONS.md](../../reference/OPEN_QUESTIONS.md). Each is answered under this spec's statistics, recorded in `SUITE_RUNS.md`, and closed in the spec that owns the setting it decides.

### The fixtures' recorded bars

28. Earlier phases set bars on particular fixtures. They are kept here as recorded history so no one re-proposes them unknowingly; none is a v1 pass condition — v1 is judged by rule 4's interval and DoD §5.5 — because each was set before the statistics of rules 10–13 and on one run:

    | Bar | Set for | Still in force? |
    | --- | --- | --- |
    | Chronicle scorecard: Pass@1 ≥ 80% (5 of 6 cards on the first turn), repair within ≤ 3 rungs, zero test mutation, zero out-of-scope writes, all 6 cards < 18 min on an M4 | Chronicle, the first fixture | As diagnostics only: zero test mutation and zero out-of-scope writes are enforced by gates and the write contract for every card; the 5/6 and 18-minute figures are single-run targets, reported beside the suite result, not pass conditions |
    | Showcase Trifecta: 24 cards (onyx, vanguard, basalt-canvas), < 140 changed lines per card, ~39 min autonomous, ≥ 98% slot-0 prompt-cache hit | The three showcase fixtures | The card-size bound is superseded by the 200-line gate; the cache target by [context.md](context.md)'s median ≥ 0.85 after the first turn; the 39-minute run time is reported, not required |
    | M0 go/no-go: ≥ 90% valid-and-correct tool execution over 30 seeded tasks × 3 runs at step budgets 50 and 150; rework at 70–90%; below 70%, narrow the product to planning and review assistance | Phase 0's Worker decision | The protocol is kept in `sekhemet m0` (`m0.ts:6-46`: 30 tasks, 3 runs, budgets 50 and 150); the bar is historical — Phase 0's 11/11 establishes ≥ 76% at 95%, not ≥ 90% — and whether the pivot rule stands as a standing decision is §8 Q4 (tool-arm measurement is [models.md](models.md) NEW-models-5) |

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

- WHEN the planning measure runs THE SYSTEM SHALL also score **implicit-requirement recall**: the share of annotated unstated requirements in a golden set of briefs (at least 10 briefs, ReqElicitGym-style) that end up in the accepted requirement graph, reported with an exact interval.
- WHEN the planning measure runs THE SYSTEM SHALL score the **premature-completion rate**: projects or slices the system marked proven that a held-out acceptance suite, never shown to the planner, shows are not.

### T8 — admission only on a significant paired gain

- **MS-T8-1** WHEN a proposal's candidate run passes the same number of tasks as the baseline THE SYSTEM SHALL NOT admit it.
- **MS-T8-2** WHEN a proposal is evaluated THE SYSTEM SHALL use at least two paired runs on the suite path with the suite hash checked, and admit only if a one-sided exact test rejects "no gain" at 0.05.
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

### NEW-measurement-1 — self-describing, isolated runs

*Justification:* the evidence cannot say which build produced it, the suite hash misses the card specs, and trials leak learned state into each other — a result must say what produced it.

- **MS-N1-1** WHEN a seed script or card specification changes THE SYSTEM SHALL change the suite hash.
- **MS-N1-2** WHEN a measured run starts THE SYSTEM SHALL record the harness commit and dirty flag, the SHA-256 of each `dist`, every `SEKHEMET_*` variable, the server's `/props` and build, and the host fingerprint.
- **MS-N1-3** WHEN any `dist` hash changes between two cards of a run THE SYSTEM SHALL abort the run and say which package changed (a planted rebuild in a test aborts it).
- **MS-N1-4** WHEN a measured run executes THE SYSTEM SHALL use an isolated configuration directory, model registry and exemplar store, SHALL NOT make any rule or exemplar learned during the run available to a later card of the run, and SHALL record in each card's evidence the rules and exemplars it saw.

### NEW-measurement-2 — diagnostics on real inputs

*Justification:* the doctor's playbook check is called with no outcomes, skills or cards, so net gain and context debt can never appear.

- **MS-N2-1** WHEN `sekhemet doctor` runs in a project with recorded outcomes, skills and rules THE SYSTEM SHALL pass them to the diagnostics, including rules on the ledger.
- **MS-N2-2** WHEN a rule adds more than 300 Zone-2 tokens without a significant gain of at least 3 points THE SYSTEM SHALL flag it as context debt and offer its retirement.

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
3. **Which public data to import.** *Recommendation:* only the SWE-bench Verified difficulty annotations (flag: licence unstated) and, for the pre-filter's form, the four scalar columns of `nebius/SWE-rebench-openhands-trajectories` (CC-BY-4.0); nothing else in v1.
4. **The M0 pivot rule (owner decision).** If the Worker cannot run cards unattended (tool execution below 70% on the M0 protocol), the old plan narrowed the product to planning and review assistance. *Recommendation:* keep it as a standing decision in DECISIONS.md, re-evaluated on every Worker change, because it is the product's answer to its riskiest assumption.

## 9. Evidence and rationale

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
