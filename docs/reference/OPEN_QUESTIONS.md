# Open questions and benchmarks still owed

*Moved from the 2026-09-17 design, with a state per item as of 2026-09-22. Every item blocks something; none closes by reading more. A spec that depends on one links here. When an item closes, record the evidence and the decision (in [DECISIONS.md](../design/DECISIONS.md) if it is one), then mark it closed — do not delete it.*

## Owner decisions

Decisions only the owner can make, each with the workstream it blocks and the default the design uses until then. A workstream does not start while an unresolved owner decision sits in its path ([plan](MODERNIZATION_PLAN.md#phase-b--build-to-the-definition-of-done-one-workstream-at-a-time)).

| # | Decision | Blocks | Recommendation (the default until decided) |
| --- | --- | --- | --- |
| O1 | **Spine rule 2 and erasure.** Amend "anything a model saw can be reconstructed" to "…except content erased by a recorded `ledger/erased` event, which replay names as a gap" — needed for personal data on a company server, leaked secrets, and retention | B3.1 (NEW-kernel-7), B3.3 (retention) | Amend. Until then nothing is erased or pruned: retention only reports what it would prune |
| O2 | **Weights by explicit command** (ruling R7): a person may run a download command for a registry model; the published hash is verified | B2.2 (NEW-models-7) | Allow, hash-verified, never automatic |
| O3 | **Seshat's model name** out of the panel header (ruling R15), shown in details and on Machine | B4.2 | Move it |
| O4 | **Cut the plugin container** (`container.ts`, reachable from `execute.ts:378`) and **the SDK package** | B0 | Cut both; until then plugins load only in a trusted workspace (S9) |
| O5 | **Browser test tooling**: Playwright (Apache-2.0) and axe-core (MPL-2.0, weak copyleft, unmodified dev dependency), needed by DEFINITION_OF_DONE §6.4–6.5 and dashboard P12 | B4.2, B4.6, B4.7, Phase C | Approve both as development dependencies. Without them the audience walks run on the harness's own headless-Chromium client, with less coverage |
| O6 | **fast-check** (MIT) for property-based acceptance tests derived from EARS criteria | B4.3 (NEW-planner-pm-7) | Approve |
| O7 | **Zod or Valibot** (MIT) for event-payload validation | B3.1 | Approve one (Valibot: smaller, tree-shakable) |
| O8 | **vLLM** (Apache-2.0, a separate process) as the multi-user NVIDIA engine | B4.9 | Approve as an optional engine; llama.cpp stays the default |
| O9 | **Install artefacts**: an npm package for a person and a container image for a team server | B4.1 | Approve both; a single executable later |
| O10 | **Card change kinds in v1** (`characterize`, `refactor`, `upgrade`) for work on existing codebases | B2.3, B4.3 | In v1: without them, refactor and characterization cards fail as `vacuous_tests` |
| O11 | **Self-accept on a team server**: may the person who handed a card to the Worker accept it? | B3.2, B4.9 | No, unless they are the only person with the Accept permission on the project |
| O12 | **Where project documents live** in the user's repository | B4.4 | `docs/project/`, configurable, committed through Accept |
| O13 | **Accept friction**: acknowledge each unmet or unclear Reviewer finding before Accept | B3.2 | Light: one key per finding |
| O14 | **Retention of personal free text** on a team server | B3.3 | 90 days for closed cards' free text, then erased (after O1) |

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
| 17 | Scope precision and recall against the files a person would have named, per card class | The scope cap ([context](../design/specs/context.md)) | Open — carried from the 2026-09-17 design's [BENCH] item; CX-P1-3 records each file's provenance, but nothing yet measures precision or recall |
| 18 | How much of the Worker's failure rate is quantisation (IQ3_XXS) rather than the harness: the frozen suite at a higher quantisation of the same model, paired | DEC-04's reopen condition; where to spend effort (PM_RESEARCH_SYNTHESIS §2 step 2) | Open — needs a host with the memory for the higher quantisation, or a smaller fixture subset; [measurement](../design/specs/measurement.md) |

## Research gaps

The 2026-09-17 design listed these as "finalized resolutions" citing work the Phase A review could not verify (*Meta-Task (2026)*, *ClarEval (2026)*, *Ask or Assume? (2026)*). They are research, not resolutions, until a source is checked and a measurement here agrees.

| Gap | Proposed approach | State |
| --- | --- | --- |
| Task synthesis from git history | Mine closed PRs with code and test changes; require fail-to-pass (the pre-change commit fails, the change passes); scrub paths from problem statements; isolate each task's dependencies in an ephemeral worktree | Open; sources to verify |
| Clarify versus assume | Convert a category of assumption into a question when people override it more than a threshold (proposed 15%). Measure both failure modes: questions a person says the harness "should have known" (asked too much), and send-backs whose reason was knowable before the card started (asked too little) | Open; threshold unmeasured |
| Prompt-injection defence | Architectural containment, not model filtering — confirmed by 2026 literature (research groups B and D) | **Direction settled**; implementation is COVERAGE S3–S3c |
| Layout-defect detection | Playwright locator geometry, element screenshots, axe-core | Open; Playwright and axe-core are proposals awaiting the owner |
| Long-horizon reliability for open-weight Workers | Thin cards, fresh context, capped retries with gate verification | Direction settled; measured by the suite |
| Project-building measure | Candidates: Commit0 lite, ProjDevBench, DevBench, NL2Repo (research group D) | Open — COVERAGE T7 |

## Design questions still open

| Question | Recommendation | Where it is decided |
| --- | --- | --- |
| Retention of context packs and trajectories | Decided with `retention.ts` wire-or-cut ([DEC-09](../design/DECISIONS.md#dec-09)) | [runtime](../design/specs/runtime.md) |
| Gate runner as a separate daemon over mutual TLS, or in process | In process for v1; the separate runner only with company-server mode if the gate host is another machine | [gates](../design/specs/gates.md), [runtime](../design/specs/runtime.md) |
| A synced external item changes mid-card | Reconcile at the card's end; never pause a card for an external edit. **Adopted** 2026-09-22 (ruling R6): the edit is recorded, and at the card's end a changed scope or criteria sends the card to Planning with the change named | [integrations](../design/specs/integrations.md) item 5 |
| The spine's "anything a model saw can be reconstructed" once erasure exists | Add "except content erased by a recorded `ledger/erased` event; replay names each gap" — an owner decision on the spine ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 8) | [kernel](../design/specs/kernel.md); consumed by [security](../design/specs/security.md) item 34b and [runtime](../design/specs/runtime.md) items 34a–36 |
| Which install artefacts ship | An npm package for a person and a container image for a team server (inference in its own container); a single executable once Node's feature is stable | [surface](../design/specs/surface.md) open question 4 |
| macOS confinement if Apple removes `sandbox-exec` | Keep it behind the sandbox interface with loud containment tests; fail closed if it breaks; research a VM per card then | [security](../design/specs/security.md) open question 4 |
| Whether a local verifier earns its place on the largest tier | Measure before building | [models](../design/specs/models.md) |
| Plugin isolation and third-party signing | Workspace trust in v1 (COVERAGE S9); signing later | [extensibility](../design/specs/extensibility.md), [security](../design/specs/security.md) |
| Keyboard bindings and phone layout | Answered by the Phase A UX review: first-letter chords, a phone bottom bar | [dashboard](../design/specs/dashboard.md) |
