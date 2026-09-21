# Frozen suite runs

Every recorded score, newest first. A run is comparable only to runs with the same suite hash; a different hash means the tasks or a fixture changed, and the two numbers are about different things.

The number to watch is not the pass count alone. It is **why the failures failed**, because a harness that stops its own cards and a model that cannot do the work fail at the same place in the column and for entirely different reasons.

---

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

### What this run does not establish

*   **It is not a measurement of the model.** With two thirds of the tasks ended by the harness, this score is a measurement of the harness. The model's actual capability on these tasks is unknown and will stay unknown until a run completes without the stall defect dominating.
*   **One run, non-zero temperature.** `card_chron_hasher` passed during the runner's validation and failed in this run. Single-trial differences here are noise, and no per-task result should be read as a fact about that task.
*   **`vacuous_tests` is a fixture question, not a harness one.** All three occurrences are the types-only card in each fixture. Their acceptance tests use `import type` and `expectTypeOf`, both erased at runtime, so the test passes against an empty file and the red-before-green check can never fail. The harness is right to refuse. The fixtures are deliberately left alone: editing one would change the suite hash and make this run incomparable to every run after it, which is the one thing a frozen suite exists to prevent.

### Reproducing it

```bash
node scripts/run_suite.mjs --worker nail-35b-a3b-ctx-16k:latest --out run.json
```

Check `ollama ps` and free memory first. The Worker is 13 GB on a 24 GB host, and this run needed six containers stopped and Docker quit. One card was stopped by the harness's own `memory_pressure` guard, which is the guard working.
