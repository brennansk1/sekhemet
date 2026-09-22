# Frozen suite runs

Every recorded score, newest first. A run is comparable only to runs with the same suite hash; a different hash means the tasks or a fixture changed, and the two numbers are about different things.

The number to watch is not the pass count alone. It is **why the failures failed**, because a harness that stops its own cards and a model that cannot do the work fail at the same place in the column and for entirely different reasons.

---

## Both runs so far measured the wrong thing

**Read this before either score below.** The runner never accepted a passing card, so every card ran in a worktree branched from the untouched seed. A card that builds on another card's work — whose acceptance test imports a module an earlier card writes — therefore ran against an **empty file**, however well the earlier card had done.

The evidence is unambiguous. In run 2, `card_onyx_1_types` passed and wrote `CryptoEnvelope` into `src/types.ts` in its own worktree. `card_onyx_2_crypto`, which imports that type, found `src/types.ts` at **0 bytes**, and `main` held nothing but the seed commit. The pattern holds across the run: every passing card imported only its own module, and the dependent cards failed.

So the dominant failure in both runs — `oscillation_detected` on dependent cards — was largely the model reading a file for code that could not be there, reading it again, and being stopped. The harness mechanisms found along the way are real, but their measured effect is confounded, and neither score is a measurement of building a project. It was a measurement of building each card of a project alone.

This matters beyond these two numbers, because building projects is the thing this harness is meant to be best at, and a suite that never lets one card build on another cannot measure that at all.

The runner now accepts each passing card — squash-merging it to `main` — before the next card starts, as a real project would. A card whose contract needs a module that an earlier, failed card never delivered is recorded as **blocked on that dependency** rather than run against an empty file: it cannot pass, and running it measures nothing. That is a named cause, and it is honest about what a failed card costs the cards after it.

The fixtures were not touched: the suite hash covers the manifest and the fixtures, not the runner, so run 3 is comparable with both runs below.

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
