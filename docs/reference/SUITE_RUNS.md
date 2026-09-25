# Frozen suite runs

Every recorded score, newest first. A run is comparable only to runs with the same suite hash; a different hash means the tasks or a fixture changed, and the two numbers are about different things.

The number to watch is not the pass count alone. It is **why the failures failed**, because a harness that stops its own cards and a model that cannot do the work fail at the same place in the column and for entirely different reasons.

---

## The runner changed (B2.4): later runs are not directly comparable to earlier ones

From the build that moves the suite runner into `packages/eval` (`suite_runner.ts`, measurement MS-M9-3), the suite runs each fixture through the product's `sekhemet queue` with its shipped defaults and `--auto-accept`, not card by card through `sekhemet run` (MS-M9-1, MS-M9-4): the queue's planning prelude, dependency deferral, learned rules and team note are now part of what is measured. Three things are also counted differently. The suite hash does not change, because it covers the manifest and the fixtures, not the runner. But a run on this build is **not directly comparable** to any run below, including the 10/14 on `468f67f`:

- **Tokens are totalled over every attempt.** The script read only the `latest-` bundle, which holds the last attempt, so a card that needed several attempts was under-counted.
- **A timeout is attributed to the runner.** A card the runner killed was reported with the stop reason of its last *finished* attempt. It now reads "timed out after N min", followed by the last recorded attempt's reason. The queue runs a fixture's cards in one process, so its timeout is the per-card timeout times the fixture's cards, and a card it never reached reads "no attempt recorded".
- **Cards with declared ids are checked for unmet dependencies.** The script loaded the board's facts only for fixtures seeded by a script (chronicle), so no card of onyx, vanguard or basalt-canvas could ever be recorded as blocked. `onyx_8_e2e`'s "fixed after the run" below was therefore incomplete: the `./x.js` form was read, but never for onyx. From this build, a card the queue deferred, or ran while a module it needs was still empty on `main` when the run ended, is recorded as blocked and left out of the pass rate's denominator (measurement rule 3).

- **A card never run is unmeasured.** A card the runner's timeout never reached, or one in a fixture whose queue wrote no report, is marked `notRun` and left out of the denominator like a blocked card; the queue now writes its report after every entry, so after a timeout the cards it finished keep their outcome.
- **A card blocked in only one arm of a comparison is that arm's failure**, and one blocked in both is left out and counted, so a change cannot hide losses behind the cards it blocks.

Each run also records its one `RunProfile` and that profile's hash (measurement rule 9a), and, when started with `--ab-entry`, the hash of the A/B's entry. **Still not isolated:** a passing card becomes an exemplar for later cards of the same run (measurement rule 6, NEW-measurement-1), so a fixture's later cards may see its earlier ones' work as examples.

---

## Both runs so far measured the wrong thing

**Read this before either score below.** The runner never accepted a passing card, so every card ran in a worktree branched from the untouched seed. A card that builds on another card's work — whose acceptance test imports a module an earlier card writes — therefore ran against an **empty file**, however well the earlier card had done.

The evidence is unambiguous. In run 2, `card_onyx_1_types` passed and wrote `CryptoEnvelope` into `src/types.ts` in its own worktree. `card_onyx_2_crypto`, which imports that type, found `src/types.ts` at **0 bytes**, and `main` held nothing but the seed commit. The pattern holds across the run: every passing card imported only its own module, and the dependent cards failed.

So the dominant failure in both runs — `oscillation_detected` on dependent cards — was largely the model reading a file for code that could not be there, reading it again, and being stopped. The harness mechanisms found along the way are real, but their measured effect is confounded, and neither score is a measurement of building a project. It was a measurement of building each card of a project alone.

This matters beyond these two numbers, because building projects is the thing this harness is meant to be best at, and a suite that never lets one card build on another cannot measure that at all.

The runner now accepts each passing card — squash-merging it to `main` — before the next card starts, as a real project would. A card whose contract needs a module that an earlier, failed card never delivered is recorded as **blocked on that dependency** rather than run against an empty file: it cannot pass, and running it measures nothing. That is a named cause, and it is honest about what a failed card costs the cards after it.

The fixtures were not touched: the suite hash covers the manifest and the fixtures, not the runner, so run 3 is comparable with both runs below.

---

## A defect in every run so far: the stall detector's fingerprint

Found by the first Phase A review (2026-09-22), confirmed with real git. The repository fingerprint the stall detector compares was HEAD plus `git status --porcelain`, which is identical however many times an already-modified file changes. So in **every run recorded below**, an edit to a file that was already changed could look like "the repository is unchanged", drawing a stall warning and, on a repeat, `oscillation_detected`. Some stall-family failures attributed to the model below may have been this; they were not re-examined. The fingerprint now hashes content. An A/B arm started on the old build (thinking off, 4/4 chronicle cards passed) was stopped so that every arm runs on the corrected one.

---

## Thinking A/B, arm "off" — Cyber-Tiel on `468f67f`, chronicle and onyx, 2026-09-22

The first arm of the thinking A/B (`SEKHEMET_THINKING=off`, `SEKHEMET_WORKER_METHOD=baseline`), on the build with the content fingerprint, the data-contract section and re-check thinking. Cyber-Tiel-Coder-35B-A3B IQ3_XXS with MTP, 16k context, one llama-server for all cards.

**10 of 14 passed, all first try** · suite 1.0.0 `192b6e95` · 53 min · 453k tokens · 0 repair rungs.

| Card | Result | Cause |
| --- | --- | --- |
| chronicle 1–4, onyx 1–3, 5–7 | pass (34–404 s) | `onyx_5_scanner` passed for the first time — impossible before the secrets gate stopped judging the staged test |
| `chron_ledger` (chronicle_5) | fail, 578 s | `oscillation_detected`: TS2375 with the correct remedy shown; a 230-line diff |
| `chron_api` (chronicle_6) | blocked | `src/ledger` never built |
| `onyx_4_vault` | fail, 423 s | `oscillation_detected`: TS2339 `db.run`, with the remedy listing the real members; a 216-line diff |
| `onyx_8_e2e` | fail, 1,200 s | Timed out against an **empty `vault.ts`**: its spec names its imports as `Vault from "./vault.js"`, a form the runner's dependency check did not read. **A runner defect**, fixed after the run: the card would now be recorded as blocked in 0 s |

**What it shows.** Both real failures are the same shape: a large first diff, a type error the harness explained correctly, and a model that did not converge on the fix. That is the Worker method's territory (small verified steps), not the gates'. **What it does not show:** anything statistical — 14 cards cannot separate arms by less than about 20 points (see [WEB_RESEARCH_2026-09.md](../research/WEB_RESEARCH_2026-09.md), group D). It is the "before" arm for the prompt fixes (COVERAGE M1, M3, M8), which come before the surgical and all arms.

---

## Runs 4 and 5 — Nail and Cyber-Tiel on one build, both stopped part-way

Same harness build, same fixtures, same suite hash `192b6e95fa3c`; only the Worker differs. Both runs were stopped deliberately — run 4 to switch models, run 5 to pause work — so neither is a score. What they establish is below; what they do not is said after.

**A correction first.** `sekhemet run` ignored `--worker` until this pair of runs: every earlier run, whatever it was asked for, used `nail-35b-a3b-ctx` with reasoning **disabled** (`disableReasoning: true`), an 8k context budget and a 2,048-token output cap. The Nail results stand as *Nail with thinking off*. Fixed so run 5 could use Cyber-Tiel; the default is unchanged.

| Card | Run 4 · Nail | Run 5 · Cyber-Tiel (MTP) | Cause of each failure |
| --- | --- | --- | --- |
| `chron_iface` | pass 46s | pass 25s | — |
| `chron_hasher` | pass 36s | pass 44s | — |
| `chron_db` | pass 26s | fail 194s | **Harness** (5): an unknown `DatabaseSyncOptions` key; the error named no real members and the model asked `tool_search` for the type eight times. Fixed: the failure now lists the type's members |
| `chron_verifier` | pass 64s | pass 74s | — |
| `chron_ledger` | fail 331s | blocked | **Model** (4): guessed `lastInsertRowId`, could not fix three type errors; plus a `tool_search` dead end on symbol names — **harness**, fixed. (5): blocked on `chron_db` |
| `chron_api` | fail 130s | blocked | **Blocked** in both: it builds on `ledger.ts`, empty on `main`. Run 4's runner missed the dependency because the spec named it and the test did not — fixed |
| `onyx_1_types` | pass 26s | pass 28s | — |
| `onyx_2_crypto` | pass 44s | pass 140s | — |
| `onyx_3_db` | pass 53s | pass 40s | — |
| `onyx_4_vault` | fail 64s | fail 716s | (4) **Model**, twice now: shown the exact `read_file` calls with `read_file` offered, it searched for `tool_search` itself — the harness now returns the files. (5) **Model + harness**: got past it, then used a column the schema names differently (the repo map did not show the schema — fixed) and re-ran one test command twelve times without editing (refused under the strict method, built) |
| `onyx_5_scanner` | not reached | timed out 20m | **Harness**: the secrets gate flagged AWS's documented example key in the *staged acceptance test*, a file the card may not edit. The card could never pass. Fixed |
| `onyx_6_injector` | not reached | pass 77s | — |
| `onyx_7_cli` | not reached | fail 207s | **Model**: three `string \| undefined` errors with a correct one-step remedy attached; it re-ran `check` instead of editing. The case the surgical-thinking A/B exists for |
| `onyx_8_e2e` | not reached | stopped | Unmeasured |

**What this establishes.** On the ten cards both reached, Nail passed 7 and Cyber-Tiel 6 — but Cyber-Tiel's one extra loss was `chron_db`, a harness defect (now fixed) that then blocked two dependent cards, while Nail lost `chron_ledger` to its own guessed API. They failed different cards for different reasons, and one trial cannot separate them. Cyber-Tiel fails *later and more usefully*: on the vault card it read the modules, wrote the code, ran the tests and reached real bugs where Nail never left a tool-search loop. Every failure has a named cause; the harness causes are fixed in source and none is in this build.

**What it does not.** Both models ran with thinking off on ordinary turns. That is the next experiment, and the most likely to move the number.

MTP was active throughout — draft acceptance 53–93%, typically ~78% — but generation ran at 26–32 tokens/s, level with Nail without MTP, and prompt reading at about half Nail's rate (llama-server vs Ollama; not purely a model difference).

---

## Run 3 — stopped after 2 cards: the harness's own new gate

Stopped deliberately after two cards, both lost to one harness defect introduced the same day.

| Card | Result | Cause |
| --- | --- | --- |
| `chron_iface` | `replan_requested`, 215s | **Harness: regression gate false positive** |
| `chron_hasher` | `oscillation_detected`, 97s | **Harness: the same** — its only gate failure |

The new regression gate treated `tests/.gitkeep`, which every fixture has and which is empty on `main`, as a test the card had emptied. Its remedy was `git checkout`, a tool the Worker does not have, so both cards spent their remaining turns searching for one. Continuing would have measured that defect thirty times. Fixed, with tests, and the fix is recorded in the design.

**Process change:** before a full run, every project gate is now run against every seeded fixture with no card changes, where each must pass. A gate that fails an untouched repository is broken, and finding that out costs seconds, not an hour of model time.

---

## Validating the merge fix — onyx only, 2026-09-22

Before spending an hour on a full run, the eight onyx cards were run alone to see whether merging passing cards changes anything. It does.

| Card | Run 1 | Run 2 | Validation | Cause |
| --- | --- | --- | --- | --- |
| `onyx_1_types` | refused | pass | **pass** 116s | — merged; `main` now holds `CryptoEnvelope` |
| `onyx_2_crypto` | fail | fail | **pass** 46s | Dependent card; passed once its dependency was on `main` |
| `onyx_3_db` | pass | pass | **pass** 37s | stable |
| `onyx_4_vault` | fail | — | fail 71s | **Harness: dead-end `tool_search` reply** — see below |
| `onyx_5_scanner` | fail | — | fail 184s | `memory_pressure` — the harness's guard stopped it |
| `onyx_6`–`onyx_8` | fail | — | fail 1–2s | `memory_pressure` — refused to start |

**The one card that could not be explained by the old runner was a harness defect too.** `onyx_4_vault` had all three dependencies merged. Its replay: seven turns, every one a `tool_search` for `crypto.js db.js types.js`, each answered *"No tool matches"*. The Worker was using the tool-loader as a file finder, and the reply gave it nothing to do next; `read_file` was loaded throughout. The reply now names the `read_file` calls that do what was asked. Fixed, with a test, and the design's one-step rule now binds tool replies as well as gate failures.

**Four cards were lost to memory, not to the task.** Swap reached 6.2 of 7 GB with the Worker loaded; the guard stopped `onyx_5` mid-card and refused the rest. That is the guard doing its job, and it means these four are unmeasured, not failed. They are not counted against the harness or the model.

One run, non-zero temperature: `onyx_2_crypto` passing is consistent with the mechanism — it failed twice against an empty `types.ts` and passed the first time `types.ts` was real — but it is one trial.

---

## Run 2 — 2026-09-22, stopped at 9 of 30

Stopped deliberately. Swap rose from 1.5 GB to 4.3 GB over the run, stepping up by roughly 100–200 MB per card without recovering, with twenty cards still to go and a prior near-out-of-memory on this host. The partial result is recorded rather than discarded.

| Card | Run 1 | Run 2 | Attributable? |
| --- | --- | --- | --- |
| `onyx_1_types` | refused, 1s | **pass** | Yes — types-only cards now show red on typecheck |
| `chron_iface` | refused, 1s | ran 155s, `memory_pressure` | Yes — unblocked; its outcome was masked by memory |
| `chron_hasher` | fail | **pass** | No — this card passed, failed and passed across three runs |
| `chron_db`, `onyx_3_db` | pass | pass | stable |
| `verifier`, `ledger`, `api`, `onyx_2` | fail | fail | All depend on another card's module — see above |

**2/9 → 4/9 on the paired cards, and half of that is evidence.** The types-only fix is established by mechanism: both types cards went from refused in one second to running. The `chron_hasher` flip is noise until more runs say otherwise. Every card that did not change is a dependent card, which the section above explains.

Replaying those runs also found a bug in the stall fix itself: its one warning was spent per card rather than per stall episode. Fixed, with a test.



## Run 1 — 2026-09-21, the baseline

| | |
| --- | --- |
| Suite | `1.0.0` · hash `192b6e95fa3c` · 30 tasks |
| Worker | `nail-35b-a3b-ctx-16k` (35B-A3B, IQ3_S, 13 GB) |
| **Score** | **5 / 30 passed**, all five on the first try |
| Cost | 60 minutes · 847,481 tokens (817,208 prompt, 30,273 completion) |
| Host | 24 GB Apple M4, Ollama, nothing else running |

### Why the 25 failures failed

| Stop reason | Count | What it is |
| --- | --- | --- |
| `oscillation_detected` | **19** | The harness ended the card. See below. |
| `vacuous_tests` | 3 | The staged acceptance test passed against untouched code, so the card could not start. |
| `no_progress` | 1 | The same family as oscillation. |
| `memory_pressure` | 1 | The harness stopped itself before the host ran out of memory. |
| timed out | 1 | Killed by the runner at 20 minutes. |

### The finding: two thirds of the suite died on a harness defect

Twenty of the twenty-five failures are the stall family, and they are not the model failing the task. A representative replay, from `card_chron_verifier`:

```
Attempt 1: failed, 2 step(s), 6791 tokens
   1. read_file src/types.ts
   2. read_file src/types.ts | stop: oscillation_detected
```

That card had a thirty-two step budget and was ended on step two, having read one file twice and written nothing. Several others died in 19 to 22 seconds the same way.

The cost profile says the same thing from another angle: **96.4% of the tokens spent were prompt, 3.6% completion.** The suite spent an hour assembling context for models that were stopped before they could use it.

The detector's logic was correct — those turns genuinely made no progress. What was wrong was the consequence. The design requires a failure the Worker must act on to arrive typed and carrying a suggested action; gate failures have always had that, scope denials were given it earlier the same day, and stalls had neither. A Worker that repeats itself once has not been *told* it is repeating, so ending its card assumes a chance it never got.

### Correction: this run was split across two builds

**The run was not a clean baseline, and an earlier version of this record said it was.** The stall fix was compiled into `dist/` at 17:10:39 UTC while the run was in progress, and each card is a fresh process, so it loaded whatever was on disk when it started:

| Build | Cards | Result |
| --- | --- | --- |
| Before the fix | 23 (chronicle, onyx, vanguard, `canvas_1`) | 4 passed |
| With the fix | 7 (`card_canvas_2` to `card_canvas_8`) | **0 passed** — 6 `oscillation_detected`, 1 `no_progress` |

That split is an accident, and it turns out to be informative. It shows the stall fix did what it was built to do and did **not** by itself rescue a card.

**The fix works mechanically.** Pre-fix cards were ended on step two; `card_canvas_3_card_tile`, under the fix, ran eight steps and survived an identical repeat that the old detector would have ended.

**It did not change the outcome, and the reason is the real finding.** That card wrote its file, failed typecheck on three imports that `./tokens.js` does not export, and was told, for each: *"The module does not export that name. Read the module and use its actual export."* It read the module. It read it again, four times in all, then repeated `check` and was stopped.

The harness's own suggested action produced the loop the harness then punished. "Read the module" cannot be completed in one step — reading returns nothing the model can act on — so a model that follows it faithfully repeats it. **A suggested action must be completable in one step; where it asks the model to go and fetch something, the failure should carry that thing instead.**

So the earlier claim that the stall-family failures were "a harness defect the fix addresses" is withdrawn in that form. They are a harness defect, but the defect is in the feedback that leads into the stall, not in the stall detector alone.

### What this run does not establish

*   **It is not a measurement of the model.** With most failures traceable to harness feedback, this score measures the harness. The model's capability on these tasks is still unknown.
*   **One run, non-zero temperature.** `card_chron_hasher` passed during the runner's validation and failed here. Single-trial differences are noise.
*   **`vacuous_tests` is a harness question, not a fixture one.** All three occurrences are the types-only card in each fixture. Their acceptance tests use `import type` and `expectTypeOf`, both erased at runtime, so the test passes against an empty file and the red-before-green check can never fail. The harness is right to refuse to start, and wrong to gate such a card on a runtime test at all: a types-only card's red check is a typecheck. The fixtures are deliberately left alone, because editing one would change the suite hash.

### Reproducing it

```bash
node scripts/run_suite.mjs --worker nail-35b-a3b-ctx-16k:latest --out run.json
```

Check `ollama ps` and free memory first. The Worker is 13 GB on a 24 GB host, and this run needed six containers stopped and Docker quit. One card was stopped by the harness's own `memory_pressure` guard, which is the guard working.
