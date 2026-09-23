# Phase A — Domain 5 (Models and hardware) and Domain 10 (Measurement and learning)

Read-only review at `468f67f`. Nothing was sent to ports 8098 or 11434. One spec was run: `packages/eval/tests/suite.spec.ts`, 13/13 green. **[unverified]** marks llama.cpp behaviour I could not check against the build in use.

**Headline.** The suite's numbers can't yet carry the decisions being made on them, for six reasons:
- The evidence records the wrong commit.
- The suite hash leaves out the Chronicle card specs.
- Every card reloads the model.
- A managed adapter adopts any server already on its port.
- The admission gate accepts changes that don't move the score.
- Every "improvement" rests on one trial at temperature 0.6.

The models layer is well designed, but it runs on defaults that were never measured. There is no `~/.sekhemet/machine.json`, and the registry holds no qualification, tool arm or MTP verdict for Cyber-Tiel.

---

## Domain 5 — Models and hardware

### 1. Positioning
- **A team can't yet choose a model per role and trust the result.**
  - The registry's shape (`registry.ts:42-68`) is right, but on this host it holds only Cyber-Tiel's template pin plus two test entries (`"a"`, `"b"`, 400/30 tok/s) that leaked into the real `~/.sekhemet/models.json`.
  - `isQualified` (`registry.ts:192`) has no caller, so qualification gates nothing.
- **The Worker is abliterated.**
  - `MANAGED_MODEL_FILES.worker` is Cyber-Tiel (`llama_server.ts:17-21`).
  - The project's own research rates it "Not recommended" for an autonomous harness (MODEL_CANDIDATES.md:73, 213).
  - The same research names a same-size, non-abliterated drop-in: Tiel-Coder-35B-A3B-GGUF-MTP (line 72).
  - A professional security review would stop there.

### 2. Drift
- **MTP is on without being measured.**
  - Design (M19): MTP only where measurement shows it pays.
  - Code: `mtpEnabled()` falls back to `profile.mtp === true` (`llama_server.ts:226-230`), and the Worker ships `mtp: true` (`:532`).
  - That contradicts the code's own rule: "not measured; speculative decoding stays off" (`calibration.ts:706`).
- **Per-model sampling is hard-coded, not read from the registry.**
  - `ModelEntry.sampling`, `reasoning`, `roles` and `contextWindow` are never read.
  - Sampling lives in five factories instead: `roster.ts:45-78`, `llama_server.ts:534/589/677`, `http_adapter.ts:1178`.
- **Three role vocabularies.**
  - `RegistryRole` = planner, executor, verifier, vision, pruner (`registry.ts:13`).
  - `ModelRole` = worker, manager, escalation, reviewer, researcher (`router.ts:20`).
  - The design's four roles are a third set.
- **Tiers are computed from usable memory, which puts the reference host in the wrong tier.**
  - Usable memory is ⅔ of 24 GB = 16 GB (`calibration.ts:296`), so the 24 GB reference host lands in **tier S** (`:187`), not the design's M.
  - Once calibrated, `roster.tuned()` (`roster.ts:150-172`) would silently cut Cyber-Tiel's window from 16k to 12,288.
  - The factory comment says 8k was already too small (`llama_server.ts:527-530`).
- **The thinking policy is split.** `session.ts:537` hard-codes `high` = 2,048 outside `REASONING_BUDGET_TOKENS`, so the policy lives in two places.

### 3. Dead and duplicated code
- **Duplicate profiles for the same model.**
  - Qwen3.8-27B has two. `createQwen38_27BAdapter` (`http_adapter.ts:1150`) is used by tests only, so it counts as dead.
  - Nail has three: `NAIL_WORKER_PROFILE`, `createNail35BAdapter` and `ollamaProfileForRole("worker")`.
- **Three worker-construction paths in the CLI, with different settings.**
  - `run` builds its adapter inline (`index.ts:1122-1128`). An Ollama tag there skips the roster: no registry, no tier cap, no engine decision.
  - `queue` goes through the roster (`:1272`).
  - `bakeoff` rebuilds a roster *afterwards* to describe what its child process used (`:1044-1053`).
- **Unreachable from any product entry point:** `isQualified`, `sweepLaunchSettings`, `nextWorkWindow`, `isUserTime`, and `runPhase0` (reachable only from a snippet in PHASE0.md).

### 4. Complexity hotspots
- `http_adapter.ts` (1,198 lines) holds two wire formats, streaming, constrained decoding, usage parsing and the model profiles. `generateOpenAi` (`:950`) is the densest branch point.
- `calibration.ts` (828 lines) mixes tiers, host probes, the speculative decision and engine selection.

### 5. Test quality (DoD §2)
Coverage in numbers: 124 tests against 25 `toThrow`/`rejects` assertions. The real-socket fake server is good. Missing negatives:
- **Adopting a foreign server.**
  - `ensureRunning` returns as soon as anything answers `/health` on the port (`llama_server.ts:382-383`); it never checks `/props` against its own model path.
  - The evidence then reports *this adapter's* MTP and context settings, not the running server's.
- **A thinking turn can overrun the window.**
  - Prompt budget = window − maxTokens − 256 = 12,032 (`session.ts:921`). A thinking turn then requests 4,096 + budget (`http_adapter.ts:823`).
  - Under `all` that is 18,176 tokens in a 16,384 window.
  - `finish_reason` is never read, so a turn truncated mid-thought looks like "no tool call" and feeds the stall and oscillation stops.
- **Tests write to the real registry.** `ModelRegistry` defaults to the home directory (`registry.ts:75`). **[likely]** `calibrate_cmd.spec.ts:60-66` omits `registry: null` and caused the pollution in §1.
- **One test enshrines an unmeasured default.** `llama_server.spec.ts:5-19` asserts `--spec-type draft-mtp`.
- **One test reads a stale build.** `llama_server_lifetime.spec.ts` imports from `dist/`.

### 6. Senior judgement (ranked)
1. **Switch the Worker to Tiel-Coder-MTP before the thinking A/B picks a winner.** Otherwise the A/B result belongs to weights you'll later replace.
2. **Make provenance real.**
   - Verify `/props` before adopting a server.
   - Record per turn: the server's flags and build, `finish_reason`, reasoning tokens, and draft statistics (`timings.draft_n` / `draft_n_accepted`, **[unverified]** names). `usageFromLlamaServer` (`http_adapter.ts:338`) captures none of these.
3. **Why MTP may not speed up short agentic turns:**
   - *Prefill dominates.* Run 1 was 96.4% prompt tokens; MTP only speeds decode.
   - *Replies are short.* Tool calls are about 50–300 tokens, so the fixed cost of drafting and verifying is a large share of each turn.
   - *MoE verification is expensive.* Verifying k drafted tokens in a 3B-active MoE loads the union of their experts, which is close to k steps' worth of bandwidth on an M4. 78% acceptance can still net about 1×.
   - *Hybrid recurrent layers* must roll back state when a draft is rejected **[unverified cost]**.
   - *Memory.* The +0.4 GB head sits on a host already swapping (6.2 GB swap in the onyx validation).
   - *Not a same-build comparison.* "Level with Nail" compares different weights, quant and engine.

   **What to measure.** Same GGUF and same build, MTP on vs off, replaying real turn prompts from runs 4–5. Report per-turn prefill and decode time separately, plus tokens per verify step. **Decide MTP per thinking policy:** decode matters far more under `all`. `calibrateSpeculative` (`calibration.ts:728`) exists but has never run, and it uses only one synthetic 2k bucket.
4. **Generation limits for a thinking model:**
   - Budget three quantities: `prompt ≤ window − (answer cap + thinking cap + margin)`.
   - Set the answer cap from the p99 `write_file` size in runs 4–5; 4,096 is plausible.
   - Probe whether `thinking_budget_tokens` is actually honoured **[unverified]**; llama-server's `--reasoning-budget` historically took only −1 or 0. If it isn't, fall back to a client-side stop that closes `</think>`.
   - Treat `finish_reason = length` as a typed failure with a one-step remedy.
   - Cap `all` at about 1.5k thinking tokens under the 16k window.
5. **One `ModelProfile` record and one role enum**, loaded from the registry with factory defaults. This removes the duplicates in §3.
6. **Calibrate the reference host once**, then settle 12k vs 16k by measurement and correct the tier table.

### 7. Verdicts
| File | Verdict |
|---|---|
| `http_adapter.ts` | Refactor: split out wire formats, usage and profiles; add `finish_reason` and draft stats |
| `llama_server.ts` | Refactor: verify the server via `/props`; move profiles into the registry |
| `roster.ts` | Keep, as the only construction path |
| `reasoning.ts` | Keep; absorb `thinkingFor` |
| `registry.ts` | Refactor: key by host fingerprint, make sampling live, safe merge on write, one role enum |
| `calibration.ts` | Keep the logic, split the file, and actually run it |
| `watchdog.ts`, `memory.ts` | Keep (the watchdog is wired into `queue` only) |
| `bakeoff.ts` | Refactor: take settings from the child's evidence |
| `qualification.ts` | Keep; wire in `isQualified` as a Worker gate |
| `schedule.ts` | Cut candidate: half its exports are unreachable (needs owner sign-off) |

---

## Domain 10 — Measurement and learning

### 1. Positioning
The honesty culture in SUITE_RUNS.md is exemplary: it retracts its own claims and names a cause for every failure. The mechanics don't yet support it:
- **The evidence records the wrong commit.** `harnessCommit(this.options.repoRoot)` (`card_runner.ts:1549`) takes the **fixture repo's** HEAD. No bundle names the harness build that produced it.
- **The suite hash doesn't cover the Chronicle cards.** `loadFrozenSuite` (`suite.ts:90-124`) hashes the manifest and the fixture trees. Chronicle's six card specs live in `scripts/seed_chronicle.mjs`, outside the hash.
- **A run doesn't describe itself.** `run_suite.mjs:262` records only the suite hash and the worker. It records no harness SHA, `dist` hash, `SEKHEMET_*` environment, MTP state or server build. Run 1's mid-run rebuild would go undetected again.
- **The model is reloaded for every card.**
  - The runner claims the model "stays resident across cards" (`run_suite.mjs:8`).
  - In fact `run` calls `model.unload()` on exit (`index.ts:1147-1153`).
  - Every card's wall-clock therefore includes a model load and a cold prefill, which confounds the Nail vs Cyber-Tiel times.
- **Per-card attribution is partial.**
  - Token counts come from the last attempt only (`run_suite.mjs:190`).
  - A timeout that follows a written attempt is reported with the stale stop reason (`:171-184`).
  - Blocked cards are counted as failures rather than "unmeasured".
- **Exemplars leak between cards within a run.** A passing card's trajectory becomes an exemplar that later cards of its class see in the same run (`execute.ts:721-742`). The trials are not independent, and nothing records which exemplars a card saw.

### 2. Drift
| Design | Code |
|---|---|
| Admit only if the change *beats* the frozen baseline | `runFrozenRegressionGate` accepts a delta of 0 (`guardrails.ts:94-104`); the test enshrines it (`wave2.spec.ts:198`) |
| Budgets and routes need `MIN_ARM_TRIALS` plus a Wilson interval | No interval anywhere in eval. `compareRuns` counts +1 task as "improved" (`suite.ts:186-193`, test `suite.spec.ts:125`). A Wilson function exists only in `pm/capability.ts:31` |
| Exemplars: at least 5 accepted cards per class, suite-admitted | Harvested from any passed card, with no minimum and no admission (`loops.ts:332-360`) |
| Playbook rules: at least 3 occurrences | One struggle creates a candidate, and `queue` puts it in force for the rest of the run (`store.ts:236-247`) |
| Roll back over a 10-card window | Compared against the *previous* 10 different cards, or against 1.0 when history is empty (`guardrails.ts:147-150`). At n=10, SD ≈ 0.16 against a 0.1 threshold: a coin flip |
| Admission runs through the frozen suite | The rule gate uses `run_gate.sh` → `queue` (`wave2.ts:1140-1200`), a different path, with no hash check |

### 3. Dead and duplicated code
**Three measurement paths whose numbers can't be compared:**
- `run_suite.mjs`: per-card `run`, merge on pass, dependency blocking.
- `run_gate.sh` → `queue --auto-accept`: used by the bake-off and the rule gate.
- `BenchmarkHarness` (`benchmark.ts:279-294`): drives the session directly, with no project gates, thinking policy, working method or exemplars, and a 32k context (`settings.ts:17`). Used by M0.

**Unreachable from product code:** `compareRuns`, `TaskSynthesizer`, `evolvePrompts`, `reflectiveMutator`, `paretoFront`, `siftProposals`, `mineCommitCandidates`, `writeModelMatrix`.

`loops.ts` still implements "loops 3, 4, 5, 8 and 9" from a design section that has since been rewritten as "one mechanism, six inlets".

### 4. Complexity hotspots
- `run_suite.mjs:143-167` infers dependencies by regex over test imports and spec prose, and has no tests.
- `wave2.ts` is a grab-bag: M0, the rule gate, the bake-off, scheduling and mutation.

### 5. Test quality
The eval specs meet DoD §2A: real git, real subprocesses, fail-to-pass checks (`eval.spec.ts:63-118`). Gaps:
- `run_suite.mjs` has no tests at all.
- Statistically wrong behaviour is asserted in two specs (see §2).
- There is no negative test for `LearningGuard` with an empty history.

### 6. Senior judgement (ranked)
1. **Self-describing runs, and refuse mixed builds.**
   - Record the harness SHA and dirty flag, a sha256 of every `dist`, all `SEKHEMET_*` variables, the server's `/props` and the host fingerprint.
   - Re-hash `dist` before each card and abort if it changed.
   - Bring the seed scripts into the suite hash, and fix `harnessCommit`.
   - Isolate `SEKHEMET_CONFIG_DIR`, `SEKHEMET_MODEL_REGISTRY` and the exemplar store during measurement.
2. **Make repeated trials cheap.**
   - *Keep the model resident:* add `run --keep-loaded`, or let `run_suite` own the server.
   - *Break the dependency cascade:* write one reference solution per fixture, validated against the frozen tests and hashed. Run each card on a `main` holding its predecessors' reference work, so every card becomes an independent trial that can be re-run alone. Keep the "build the whole project" run as a separate measure.
   - *Pair the arms:* interleave the two arms (ABAB) with fixed seeds, decide with an exact McNemar test on the cards where they disagree, and stop early with a sequential test (SPRT).
   - *Re-run only the uncertain cards,* using `siftSlice` (`loops.ts:36`).
   - *Scale of the problem:* one 30-task run has a ±17-point 95% interval. Phase 0's 11/11 has a Wilson lower bound of **74%**, below its own 90% go bar.
3. **The planning measure.**
   - *(a) Card validity.* Plan each fixture's spec from scratch. Score each card on SPIDR shape, ≤200 LOC and 1–3 files. Its acceptance test must fail at seed, pass on the reference solution, and kill mutants of the reference (via `runMutationCampaign`); fail-at-seed alone proves nothing, because `src/` ships empty.
   - *(b) End to end.* The Worker builds from the Planner's cards, and the score is the share of the **hand-written, held-out** acceptance tests that pass on the final `main`. This part needs no references.
   - Report it beside the suite, never merged into it.
4. **Admission must show a gain.** Require a one-sided exact test (or a confidence interval excluding 0) over at least two paired runs on the suite path, with the hash checked. Make `LearningGuard` compare the *same* cards with and without the change.
5. **One runner.** Move the `run_suite` logic into `packages/eval`. The bake-off, rule gate and M0 all call it, and `BenchmarkHarness` goes through `executeCard`.

### 7. Verdicts
| File | Verdict |
|---|---|
| `eval/src/suite.ts` | Keep; add statistics and provenance, and hash the seed scripts |
| `scripts/run_suite.mjs` | Rebuild as a tested `packages/eval` module |
| `eval/src/benchmark.ts` | Refactor onto `executeCard`, or cut |
| `phase0.ts`, `m0.ts` | Keep; add a CLI and intervals; re-run Phase 0 for the current Worker |
| `guardrails.ts` | Refactor: gain-based admission, paired guard |
| `loops.ts` | Keep `siftSlice` and `harvestExemplars`; cut the unreached loops (needs sign-off) |
| `synthesis.ts`, `history.ts`, `mutation.ts` | Keep |
| `learning/store.ts`, `reflect.ts` | Refactor: 3-occurrence floor; no run-scope rules while measuring |
| `learning/explore.ts`, `review.ts` | Keep |

---

## Proposals (owner decides; nothing is added without a yes)
| Name | Licence | Maintenance | Adds or replaces | Why |
|---|---|---|---|---|
| **Inspect AI** (Python) | MIT | Very active | Adds repeated trials, pass@k reducers, sandboxing and a log viewer, wrapping `sekhemet run` as a solver | Variance runs without building a framework |
| **llama.cpp `llama-bench`** | MIT | Very active | Replaces the synthetic timing in `calibrateModel` | Repetitions with standard deviation on the same build; the right tool for the MTP A/B |
| **statsmodels / SciPy** | BSD-3 | Very active | Adds McNemar tests, confidence intervals and binomial tests for offline SUITE_RUNS analysis | Correct small-sample statistics for the written record |
| **In-repo `stats.ts`** (~80 lines: Wilson, exact McNemar, paired bootstrap, SPRT) | own | — | Replaces `compareRuns`' raw delta and the private Wilson in `pm/` | The gate stays in TypeScript; too small to justify a dependency |
| **Tiel-Coder-35B-A3B-GGUF-MTP** (weights) | MIT (model card) | Community quantizer | Replaces Cyber-Tiel | Not abliterated, same architecture and size; the project's own recommendation |
| **mini-swe-agent** | MIT | Active | Adds a reference scaffold for the open "ceiling run" question | Separates harness defects from model limits |
| **Terminal-Bench harness** | Apache-2.0 **[verify]** | Active | Adds a public agentic benchmark | Places the Worker against published numbers |

---

## Top 5 changes

1. **Provenance plus a guard against mixed builds.**
   - *What:* fix `harnessCommit`; hash the seed scripts; record and re-check `dist`, the environment and the server's `/props` on every card; isolate learned state during runs; refuse a foreign server.
   - *Why:* `card_runner.ts:1549`; `seed_chronicle.mjs` sits outside the hash; `llama_server.ts:382`; run 1 was split across two builds.
   - *Effort:* S–M. *Risk:* low.
   - *Measured by:* a planted rebuild aborts the run; the bundle shows the harness SHA; editing a seed script changes the hash.
2. **Independent, paired, cheap trials.**
   - *What:* resident model; reference solutions; ABAB arms with seeds; McNemar and SPRT; SIFT re-runs.
   - *Why:* `index.ts:1147-1153` reloads the model per card; the dependency cascade in runs 4–5; single-trial deltas (`suite.ts:186`); Phase 0's lower bound is 74%.
   - *Effort:* M. *Risk:* the references must pass the frozen tests.
   - *Measured by:* seconds per card; runs needed to settle the thinking A/B.
3. **Admission requires a significant gain.**
   - *What:* the regression gate and rule gate run through the suite path with the hash checked; exemplars and run-scope rules are gated like any other inlet.
   - *Why:* `guardrails.ts:94-104`; `loops.ts:332`; `store.ts:236`; `wave2.ts:1140`.
   - *Effort:* M. *Risk:* fewer admissions, which is the intent.
   - *Measured by:* replaying past proposals and counting how many would have been admitted.
4. **Worker weights, MTP and thinking limits set by measurement.**
   - *What:* switch to Tiel-Coder-MTP; run the MTP A/B per thinking policy on real turns; separate the prompt, thinking and answer budgets; read `finish_reason` and draft stats.
   - *Why:* MODEL_CANDIDATES:73; `llama_server.ts:230, 532`; the 18,176-token request against a 16,384 window.
   - *Effort:* M. *Risk:* invalidates the runs 4–5 comparison, so do it before the A/B.
   - *Measured by:* share of truncated turns, MTP speedup per policy, paired pass rate.
5. **The planning measure.**
   - *What:* card validity against the references plus mutation, and end-to-end held-out acceptance coverage.
   - *Why:* HARNESS_DESIGN "What it does not measure: planning"; `src/` ships empty, so fail-at-seed is vacuous.
   - *Effort:* M–L (needs change 2's references). *Risk:* the Planner's own variance, so run it paired.
   - *Measured by:* % valid cards and % held-out tests passing, against the hand-written-card baseline.
