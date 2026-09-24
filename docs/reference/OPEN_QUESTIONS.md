# Open questions and benchmarks still owed

*Moved from the 2026-09-17 design, with a state per item as of 2026-09-22. Every item blocks something; none closes by reading more. A spec that depends on one links here. When an item closes, record the evidence and the decision (in [DECISIONS.md](../design/DECISIONS.md) if it is one), then mark it closed — do not delete it.*

## Owner decisions

Decisions only the owner can make, each with the default the design uses until then. **A stated default unblocks a workstream**: the workstream builds the default, and the owner's later answer may change its scope. Only a decision listed in the plan's "Needs first" column, which has no safe default, holds a workstream back ([plan](MODERNIZATION_PLAN.md#phase-b--build-to-the-definition-of-done-one-workstream-at-a-time)); the "Affects" column below is for information.

**Decided 2026-09-24** — O1–O14, recorded in [DECISIONS](../design/DECISIONS.md) DEC-29 (and DEC-30 for O12): O1 spine amended for erasure; O2 a Configuration page that scans model folders, recommends roles, downloads explicitly and runs the benchmark; O3 model names on the Configuration page; O4 cut the plugin container and the SDK; O5–O9 approved (Playwright, axe-core, fast-check, Valibot, vLLM, npm package and container image); O10 change kinds in v1; O11 solo developers may self-accept, teams may not; O12 professional documentation layout (DEC-30); O13 light Accept friction; O14 90-day retention.

**Decided 2026-09-25:** O15–O27 take their recommended defaults ([DEC-33](../design/DECISIONS.md#dec-33)). The table below keeps each question and its answer for the record.

**Answered:**

| # | Decision | Affects | Recommendation (the default until decided) |
| --- | --- | --- | --- |
| O15 | **Learning on probation during a run** (ruling R12): may an execution-verified lesson apply to later cards in the same production run before a person approves it? It reverses the owner's 2026-09-18 rule | B2.4 (T8, MS-T8-15), B4.0a (NEW-context-4) | No — approval first, as the owner ruled in 2026-09; revisit when the admission measure exists |
| O16 | **Research before building versus offline by default**: the owner wants research before anything is built; the spine says nothing leaves the machine without a yes | B3.3 (S8), B4.4 | Ask once, on the first new project; a yes turns research on for every later project, and nothing leaves the machine before it |
| O17 | **Stand-in ("stub-kill") check blocking level**: from the *internal tool* depth profile up, or only from *production* | B4.0b (NEW-gates-6) | From *internal tool*: two or three test runs, catches the commonest test that cannot fail |
| O18 | **Pin `@typescript/typescript6`** (Apache-2.0) for the harness's own parser | B4.0b (T2) | Not now: stay on `typescript` 5.9 behind the adapter; pin only when a project needs 6.0 syntax |
| O19 | **`web-tree-sitter`** (MIT) for the Python adapter | Later (after v1's TypeScript index) | Only when Python becomes a target; the fact schema is fixed now |
| O20 | **The M0 pivot rule**: if the Worker cannot run cards unattended (valid tool calls below 70% on the M0 protocol), narrow the product to planning and review assistance | B2.5 | Keep it as a standing decision, re-checked on every Worker change |
| O21 | **`llama-bench`** (MIT) for throughput and MTP measurements | B2.2 | Approve (a measurement tool, not a dependency of the product) |
| O22 | **Public review datasets** as Reviewer evaluation sets: c-CRAB and SWE-PRBench (CC BY 4.0), CodeReviewQA (MIT) | B4.8 (T11) | Approve, used for evaluation only and credited |
| O23 | **`sekhemet ask "<question>"`**: Seshat from the terminal, for non-developers and SSH users; it would replace `board` in the front door (`board --terminal` moves under `dev`) | B4.1 | Approve |
| O24 | **Profile statements used at once**: may what Seshat learns about a person ("prefers short answers", "reviews in the morning") shape replies before the person approves it? Every statement is shown on their profile, editable and deletable | B4.8 (P6) | Yes, shown and editable at once; nothing about code or the harness is learned this way |
| O25 | **Automatic retirement of a rule a person approved**: when a project rule's paired credit shows harm at a fixed look (DEC-28), is it retired automatically (with a notice, and restorable), or proposed to the person for retirement? | B2.4 (T8), B4.0a | Retired automatically with a notice and one-click restore — a harmful rule should not stay in force while it waits for someone |
| O26 | **Importing public benchmark annotations** (SWE-bench Verified difficulty annotations; `nebius` trajectory columns) as priors for the competence model | B2.4 | Do not import in v1; revisit when local data is too thin to calibrate (measurement §8 Q3) |
| O27 | **axe-core inside the product's visual gate** (it would run on users' projects, not only on Sekhemet's own tests) | B2.3 | Not in v1: the gate keeps its own accessibility subset; axe-core stays a development dependency (O5) |

## Benchmarks on the reference machine

The reference machine is a 24 GB Apple Silicon Mac running the Worker (Cyber-Tiel MTP, IQ3_XXS). Statistics follow [measurement.md](../design/specs/measurement.md): paired arms, exact or Bayesian intervals, and no claim smaller than the suite can resolve.

| # | Question | Blocks | State |
| --- | --- | --- | --- |
| 1 | Which tool arm wins, and at what pass rate? | The product thesis | Open — superseded in form by COVERAGE M2 (a fixed tool set per card class, as an A/B) |
| 2 | Step-budget curve per card class | Budget setting, planner | Open |
| 3 | Engine choice and cache retention across steps | Inference configuration | **Answered in part** by research group A: on hybrid-attention models reuse needs an append-only prompt and checkpoint spacing; see COVERAGE M8 |
| 4 | Prefix-cache hit rate with a byte-stable prompt | Context layout | Open — measured 0.29 before M8; re-measure after |
| 5 | Planner swap cost versus co-loading | Tier profiles | Open |
| 6 | Card size versus pass rate | Decomposition granularity | Open |
| 7 | KV quantization effect on tool reliability | Memory budget | Open — no published study at IQ3; track tool-call error rates (research group D) |
| 8 | Line-pruner latency on a 4-core CPU host | Context pipeline | Deferred with the pruner ([DEC-21](../design/DECISIONS.md)) |
| 9 | Diff-scoped mutation cost per card | The mutation gate | Open — and COVERAGE M10 first (run tests unmutated first) |
| 10 | Vision checklist false-pass rate on real UI | The visual gate | Open |
| 11 | Speculative decoding (MTP) net effect on this machine | Throughput | Open — COVERAGE M7/M11: measure seconds per step, two draft tokens |
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
| Layout-defect detection | Playwright locator geometry, element screenshots, axe-core | Open; Playwright and axe-core approved (DEC-29 O5); axe-core in the product gate is O27 |
| Long-horizon reliability for open-weight Workers | Thin cards, fresh context, capped retries with gate verification | Direction settled; measured by the suite |
| Project-building measure | Candidates: Commit0 lite, ProjDevBench, DevBench, NL2Repo (research group D) | Open — COVERAGE T7 |

## Design questions still open

| Question | Recommendation | Where it is decided |
| --- | --- | --- |
| Retention of context packs and trajectories | **Closed**: `retention.ts` is wired and prunes as a recorded erasure (DEC-29 O1); 90 days for personal free text (O14) | [runtime](../design/specs/runtime.md) |
| Gate runner as a separate daemon over mutual TLS, or in process | In process for v1; the separate runner only with company-server mode if the gate host is another machine | [gates](../design/specs/gates.md), [runtime](../design/specs/runtime.md) |
| A synced external item changes mid-card | Reconcile at the card's end; never pause a card for an external edit. **Adopted** 2026-09-22 (ruling R6): the edit is recorded, and at the card's end a changed scope or criteria sends the card to Planning with the change named | [integrations](../design/specs/integrations.md) item 5 |
| **Closed** (DEC-29 O1) — the spine's "anything a model saw can be reconstructed" once erasure exists | Add "except content erased by a recorded `ledger/erased` event; replay names each gap" — an owner decision on the spine ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 8) | [kernel](../design/specs/kernel.md); consumed by [security](../design/specs/security.md) item 34b and [runtime](../design/specs/runtime.md) items 34a–36 |
| Which install artefacts ship | **Closed** (DEC-29 O9): an npm package and a container image; a single executable later | [surface](../design/specs/surface.md) |
| macOS confinement if Apple removes `sandbox-exec` | Keep it behind the sandbox interface with loud containment tests; fail closed if it breaks; research a VM per card then | [security](../design/specs/security.md) open question 4 |
| Whether a local verifier earns its place on the largest tier | Measure before building | [models](../design/specs/models.md) |
| Plugin isolation and third-party signing | **Closed**: plugins are cut (DEC-29 O4); workspace trust gates hooks, `mcp.json` and skills (S9); skill signing later | [extensibility](../design/specs/extensibility.md), [security](../design/specs/security.md) |
| Keyboard bindings and phone layout | Answered by the Phase A UX review: first-letter chords, a phone bottom bar | [dashboard](../design/specs/dashboard.md) |
