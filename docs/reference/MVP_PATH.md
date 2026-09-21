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
| 7 | **Review shows the evidence, and a person accepts** | The human decision is the product | **Done — board shows it in Review, `accept` squash-merged it to main as `69a8be6` and moved it to Done** |
| 8 | **The same card runs twice identically** | Byte-identical prompts are what make the cache and the measurement real | Partly: `replay` reconstructs all three attempts faithfully from the log. Byte-identical prompts across two runs of one card is still unverified |

Steps 4 and 6 are answered. A local 35B-A3B emits valid, correct tool calls, and a card has gone from Ready to Review unattended with a complete evidence bundle. The thesis holds and the machine works end to end.

### What the first end-to-end run taught us

It took three attempts, and the failures were worth more than the pass. The replay of all three is in the event log.

**Attempt 1** — the model wrote a plausible implementation and one import of a type (`ChronicleEvent`) that no file exports. Typecheck failed. It then read `src/types.ts` four times and was stopped by the stall detector at turn 8. Every mechanism behaved correctly on the way: the worktree, the acceptance test staged and verified failing first, typed gate feedback, a checkpoint, the evidence bundle and a recorded stop reason.

**Attempts 2 and 3** — both tried `write_file src/types.ts`, and **both were denied**: the card's declared scope is `src/hasher.ts`, and scope confinement refused the write. Attempt 2 then re-read the file and stalled. Attempt 3 instead ran `edit src/hasher.ts`, removed the bad import, and passed all ten gates in four turns.

**The finding: the model's repair instinct was right and its only legal move was different.** Adding the missing type to `types.ts` is what a person would do; the card forbade it, correctly, because scope is what makes a card reviewable. What the harness never told the model was *that* the file was out of scope and that the fix had to live inside `src/hasher.ts`. The design already requires every gate failure to arrive as a typed failure carrying a suggested action; a scope denial is a failure the model must act on and does not get that treatment. Attempt 2 spent its whole budget rediscovering a refusal it was never given a way around.

**What is not established.** Attempt 3 followed a reset of the scoped file, and it is tempting to credit the reset. That cannot be claimed: these are single trials at non-zero temperature, and attempts 2 and 3 differ only in the model's final turn. The honest statement is that one attempt found the in-scope fix and two did not. Whether resetting a scoped file between attempts helps is a question for the frozen suite, not a conclusion from one card.

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
