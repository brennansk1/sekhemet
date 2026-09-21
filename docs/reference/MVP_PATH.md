# The path to MVP

The gap list in [FEATURE_INVENTORY_REAUDIT_2.md](FEATURE_INVENTORY_REAUDIT_2.md) is organised by unit, which is the right shape for an audit and the wrong shape for shipping. Closing gaps by package builds every layer to the same height and produces a system where nothing works end to end until everything does. This document is the other axis: the one path that has to work, and what is deliberately not on it.

**MVP is one sentence, and it is the design's own:** a card goes from Ready to Review unattended, with an evidence bundle, on a real repository. Not a card class. Not every language. One card, one repository, all the way through.

## The rule

Work that is on the path below is done next. Work that is not on it waits, however small or tempting, and "while I'm in here" is how a project ends up 70% built in every direction and finished in none.

Two exceptions, both narrow: a defect that breaks the path, and a change that deletes something.

## The path

| # | Step | Why it is on the path | State |
| --- | --- | --- | --- |
| 1 | **Weights resolve from configuration** | Nothing runs at all without this | Done |
| 2 | **`doctor` verifies the weights exist** | An all-green diagnostic followed by file-not-found is worse than no diagnostic | Done |
| 3 | **The gate command, and hooks that run it** | Our own definition of done; without it, breakage is found by whoever runs tests by hand | Done |
| 4 | **Phase 0: the tool-arm measurement** | Every quality claim in the design rested on a number that did not exist | **Done — GO at 100%, see [PHASE0.md](PHASE0.md)** |
| 5 | **The frozen suite produces one number** | Makes every later claim checkable, and is the admission test the self-improvement loop already assumes | Built; has not yet produced a number |
| 6 | **One card, Ready → Review, unattended** | The MVP sentence | **Done — 2026-09-21, `card_chron_hasher`, 4 turns, 10/10 gates, evidence `ev_fb8a3ec4d1`** |
| 7 | **Review shows the evidence, and a person accepts** | The human decision is the product; a card that cannot be accepted is not done | Partly built |
| 8 | **The same card runs twice identically** | Byte-identical prompts are what make the cache and the measurement real, and a replay that drifts means neither is | Untested |

Steps 4 and 6 are answered. A local 35B-A3B emits valid, correct tool calls, and a card has gone from Ready to Review unattended with a complete evidence bundle. The thesis holds and the machine works end to end.

### What the first end-to-end run taught us

It took three attempts, and the failures were worth more than the pass.

**Attempt 1** — the model wrote a plausible implementation and hallucinated one import (`ChronicleEvent` from a file that exports nothing). Typecheck failed, the model read files four times without fixing it, and the stall detector stopped it at turn 8. Every mechanism behaved correctly: the worktree, the staged acceptance test verified failing first, gate feedback, the checkpoint, the evidence bundle, and a recorded stop reason.

**Attempt 2** — rung 2, a fresh context. It stopped at turn 4, again on oscillation, having rewritten byte-identical content. The detector was right: the repository state hash genuinely did not change.

**Attempt 3** — after resetting the one file in the card's scope to its pre-attempt state, the same model on the same card passed in four turns with all ten gates green.

**The finding: a fresh context does not help while the model's previous wrong answer is still in the worktree for it to read back.** Rung 2 rebuilds the prompt and leaves the artifact, so the model reads its own mistake, reproduces it, and stalls — which reads as a capability ceiling and is actually a stale file. The ladder's second rung should reset the card's declared scope to its state at the start of the attempt, keeping everything outside that scope. This is one card's evidence, not a measurement, but it turned an apparent model failure into a pass and is worth fixing before the frozen suite runs.

## Deliberately not on the path

Not cancelled — sequenced. Each of these is defensible work that does not make step 6 happen sooner:

*   **Python, Rust and Go beyond their functional gates.** v1 is TypeScript-first, already signed off.
*   **The self-improvement inlets.** They need volume that does not exist until cards have been running for weeks, and they are gated on the frozen suite that step 5 builds.
*   **Deep Research, and the research corpus.** The Desk's model-free lookups serve step 6; the deep pipeline does not.
*   **Air-gap, MCP server, ACP, the SDK, governance, notifications, integrations.** Supporting surface, thin by design until the core is proven.
*   **The dashboard beyond Board, Card and Review.** Nine of twelve views are progressive by specification.
*   **Anything whose acceptance criterion is a benchmark that has not run.** That is circular until step 5.

## How to tell this is working

The measure is not units closed. It is **how far a card gets** before something stops it, and that number should move every session. A session that closes six units and leaves the card stopping in the same place has not moved the product.

When step 6 passes, the gap list becomes the roadmap again, and it will be shorter than it is now — because running the thing once will reveal which of the remaining units were never needed.
