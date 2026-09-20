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
| 4 | **Phase 0: the tool-arm measurement** | Every quality claim in the design rests on a number that does not exist. It either validates the thesis or narrows the product, and both answers are worth having before more is built | **Next** |
| 5 | **The frozen suite produces one number** | Makes every later claim checkable, and is the admission test the self-improvement loop already assumes | **Next** |
| 6 | **One card, Ready → Review, unattended** | The MVP sentence. Needs: context assembly, the Worker loop, the gate runner, the evidence bundle, the state machine | Partly built, never run end to end |
| 7 | **Review shows the evidence, and a person accepts** | The human decision is the product; a card that cannot be accepted is not done | Partly built |
| 8 | **The same card runs twice identically** | Byte-identical prompts are what make the cache and the measurement real, and a replay that drifts means neither is | Untested |

Steps 4 and 5 cost about a weekend together and unblock every judgement after them. They are next for that reason, not because they are the most interesting work left.

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
