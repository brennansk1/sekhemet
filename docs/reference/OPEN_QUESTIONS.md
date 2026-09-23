# Open questions and benchmarks still owed

*Moved from the 2026-09-17 design, with a state per item as of 2026-09-22. Every item blocks something; none closes by reading more. A spec that depends on one links here. When an item closes, record the evidence and the decision (in [DECISIONS.md](../design/DECISIONS.md) if it is one), then mark it closed — do not delete it.*

## Benchmarks on the reference machine

The reference machine is a 24 GB Apple Silicon Mac running the Worker (Cyber-Tiel MTP, IQ3_XXS). Statistics follow [measurement.md](../design/specs/measurement.md): paired arms, exact or Bayesian intervals, and no claim smaller than the suite can resolve.

| # | Question | Blocks | State |
| --- | --- | --- | --- |
| 1 | Which tool arm wins, and at what pass rate? | The product thesis | Open — superseded in form by COVERAGE M2 (a fixed tool set per card class, as an A/B) |
| 2 | Step-budget curve per card class | Budget setting, planner | Open |
| 3 | Engine choice and cross-turn cache retention | Inference configuration | **Answered in part** by research group A: on hybrid-attention models reuse needs an append-only prompt and checkpoint spacing; see COVERAGE M8 |
| 4 | Prefix-cache hit rate with a byte-stable prompt | Context layout | Open — measured 0.29 before M8; re-measure after |
| 5 | Planner swap cost versus co-loading | Tier profiles | Open |
| 6 | Card size versus pass rate | Decomposition granularity | Open |
| 7 | KV quantization effect on tool reliability | Memory budget | Open — no published study at IQ3; track tool-call error rates (research group D) |
| 8 | Line-pruner latency on a 4-core CPU host | Context pipeline | Deferred with the pruner ([DEC-21](../design/DECISIONS.md)) |
| 9 | Diff-scoped mutation cost per card | The mutation gate | Open — and COVERAGE M10 first (run tests unmutated first) |
| 10 | Vision checklist false-pass rate on real UI | The visual gate | Open |
| 11 | Speculative decoding (MTP) net effect on this machine | Throughput | Open — COVERAGE M7/M11: measure seconds per turn, two draft tokens |
| 12 | Prompt optimizer gain over hand-tuned | Whether to build one | Open |
| 13 | Output condensing reduction on the real command mix, and any dropped string a repair needed | Observation pipeline | Open |
| 14 | Goal-monitoring thresholds that trigger replans without thrashing | The live PM layer | Open |
| 15 | Each inlet against its frozen baseline | Inlet enablement | Open |
| 16 | Thinking off / surgical / all for the Worker | The Worker's method | **In progress** — arm "off" 10/14 (SUITE_RUNS, 2026-09-22); remaining arms after M1, M3, M8 |

## Research gaps

The 2026-09-17 design listed these as "finalized resolutions" citing work the Phase A review could not verify (*Meta-Task (2026)*, *ClarEval (2026)*, *Ask or Assume? (2026)*). They are research, not resolutions, until a source is checked and a measurement here agrees.

| Gap | Proposed approach | State |
| --- | --- | --- |
| Task synthesis from git history | Mine closed PRs with code and test changes; require fail-to-pass; scrub paths from problem statements | Open; sources to verify |
| Clarify versus assume | Convert a category of assumption into a question when people override it more than a threshold (proposed 15%) | Open; threshold unmeasured |
| Prompt-injection defence | Architectural containment, not model filtering — confirmed by 2026 literature (research groups B and D) | **Direction settled**; implementation is COVERAGE S3–S3c |
| Layout-defect detection | Playwright locator geometry, element screenshots, axe-core | Open; Playwright and axe-core are proposals awaiting the owner |
| Long-horizon reliability for open-weight Workers | Thin cards, fresh context, capped retries with gate verification | Direction settled; measured by the suite |
| Project-building measure | Candidates: Commit0 lite, ProjDevBench, DevBench, NL2Repo (research group D) | Open — COVERAGE T7 |

## Design questions still open

| Question | Recommendation | Where it is decided |
| --- | --- | --- |
| Retention of context packs and trajectories | Decided with `retention.ts` wire-or-cut ([DEC-09](../design/DECISIONS.md#dec-09)) | [runtime](../design/specs/runtime.md) |
| Gate runner as a separate daemon over mutual TLS, or in process | In process for v1; the separate runner only with company-server mode if the gate host is another machine | [gates](../design/specs/gates.md), [runtime](../design/specs/runtime.md) |
| A synced external item changes mid-card | Reconcile at the card's end; never pause a card for an external edit | [integrations](../design/specs/integrations.md) |
| Whether a local verifier earns its place on the largest tier | Measure before building | [models](../design/specs/models.md) |
| Plugin isolation and third-party signing | Workspace trust in v1 (COVERAGE S9); signing later | [extensibility](../design/specs/extensibility.md), [security](../design/specs/security.md) |
| Keyboard bindings and phone layout | Answered by the Phase A UX review: first-letter chords, a phone bottom bar | [dashboard](../design/specs/dashboard.md) |
