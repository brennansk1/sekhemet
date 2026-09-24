# Modernization plan: the Opus 5.5 pass over an AI brownfield

*Set 2026-09-22, when the builder model changed from Claude Opus 5 to Claude Opus 5.5; revised the same day after Phase A and the owner's decisions. Supersedes the completion plan of 2026-09-18 ("every inventory unit BUILT"); its inventory is an input here, and its three honesty rules are kept below.*

## Why a plan, and not a rewrite

The MVP path is complete ([MVP_PATH.md](MVP_PATH.md)): a card goes from Ready to Review unattended, and the three project gates wrap every card. What exists is also an **AI brownfield** — built fast by earlier model generations, across many sessions, with no architectural memory between them:

- 244 source files, about 72,000 lines, 173 test files; eight files over 1,300 lines (`apps/harness/src/index.ts` 2,081, `packages/loop/src/session.ts` 1,896, `card_runner.ts` 1,764, `tools.ts` 1,736);
- a design of 50 sections in 3,537 lines, plus three companion documents, which has drifted from the code (the design said reasoning is "raised for planning"; the Worker never had a planning step);
- an earlier audit found eleven modules written, tested and never wired in.

A better builder model is the chance to redesign this. The trap is a big-bang rewrite: it stops delivering, and large multi-file refactors are exactly where models are weakest. So the pass is **review everything, change what the review justifies, measure every change**.

**What the model change does and does not change.** The builder changed; the product did not. Sekhemet's Worker is still a local model (Cyber-Tiel), and its measured behaviour does not move because the builder improved. Opus 5.5 is spent where judgement decides quality: the design, the Worker's method, the PM's craft, the dashboard, and reading measurements.

## Rules

1. **Evidence first.** Every change names the card, replay, measurement or review finding that forced it.
2. **Builders do not grade themselves.** Every workstream gets an independent review — a separate model instance whose only job is critique — before it is committed. The harness's own spine, applied to building it.
3. **Dead code does not count.** Code reachable only from tests is dead; the reachability gate is run over Sekhemet itself.
4. **Cutting needs the owner's sign-off.** A review may recommend cutting a feature; nothing is cut without approval.
5. **Measure before and after.** No refactor lands before the baseline exists; each is measured against it. The frozen suite is the system-level characterization test.
6. **Strangler fig, not rewrite.** A large file is split only when a workstream already works inside it, behind tests, and its complexity must go down, not move.
7. **Spec before code.** Each workstream starts from a one-page spec and a numbered plan, and ends at `pnpm gate`.
8. **Context hygiene.** One workstream per session; code reading goes to subagents that return digests; the handoff lives in `DEV_LOG.md`, not in a transcript.

## Phase A — review every domain (read-only)

Sixteen domains cover the whole product; a seventeenth, brand and UX, was added during the review. Each maps design sections to code.

| # | Domain | Design | Code |
| --- | --- | --- | --- |
| 1 | Product surface | Product definition; the surface the user touches | CLI, front door, `index.ts` |
| 2 | Kernel and lifecycle | Data model; card lifecycle | `kernel`, `board` |
| 3 | Worker loop and tools | Worker loop; tool semantics; small-model leverage | `loop` |
| 4 | Context and prompts | Context assembly; context rot; prompt architecture | `context` |
| 5 | Models and hardware | Calibration; model registry | `models` |
| 6 | Gates and done | Definition of done; project gates; gate economics; repair contracts | `gates`, project gates |
| 7 | Planner and PM | Planner; goals; human collaboration | `planner`, `pm/`, PM_DESIGN |
| 8 | Design stage and research | Design stage; new projects; web research | `research/`, reuse survey |
| 9 | Review and decisions | The Reviewer; git workflow | review, triage |
| 10 | Measurement and learning | Measuring the harness; self-improvement | `eval`, `learning/`, the suite |
| 11 | Security | Security and sandboxing; air-gap | `sandbox`, secrets |
| 12 | Integrations | Integrations and sync; GitHub | `sync`, integrations |
| 13 | Dashboard | User interface; frontend design system | `ui`, 60 web modules, FRONTEND_DESIGN |
| 14 | Runtime and operations | Sessions and runtime; audit and telemetry | daemon, runtime |
| 15 | Extensibility | Extensibility; skills and tool catalogs | skills, MCP/ACP, SDK, hooks |
| 16 | The documents | Open questions; rejected techniques; build phases; DoD; CLAUDE/AGENTS | the design and root documents |

Every domain answers the same seven questions:

1. **Positioning.** Does it serve professional teams, beginners and non-developers — would a professional recognise it, and would a beginner learn the right practice from it?
2. **Drift.** Where do design and code disagree?
3. **Dead and duplicated code.**
4. **Complexity hotspots.**
5. **Test quality** against DEFINITION_OF_DONE §2 — trivial assertions, missing negative cases, mocked infrastructure.
6. **Senior judgement.** What would a senior engineer or PM do differently, ranked by impact?
7. **Verdict:** keep, refactor, rebuild or cut.

**Output:** `docs/reference/COVERAGE.md` — sixteen domains by seven questions, every cell filled with evidence — and a ranked, sequenced change programme. The owner reviews it before any code changes. Reviews run three agents at a time on disjoint domains; judgement stays with the lead.

**Alongside Phase A, the baseline** (it uses the local machine; review agents do not): the thinking A/B on Cyber-Tiel (`SEKHEMET_THINKING` off / surgical / all, then the top two again), then a full scored run of the frozen suite with the winning settings, recorded against its hash with a named cause for every failure.

## Owner decisions after Phase A (2026-09-22)

Recorded in full in [DECISIONS.md](../design/DECISIONS.md):

| | Decision | Consequence for the plan |
| --- | --- | --- |
| D1 | Keep Cyber-Tiel as the Worker ([DEC-04](../design/DECISIONS.md#dec-04)) | Worker containment is the first workstream after the design; the sandbox is its only guardrail |
| D2 | `main` merged, and tracks the work ([DEC-10](../design/DECISIONS.md#dec-10)) | `main` is fast-forwarded as each workstream lands |
| D3 | One persona for people; no ceremonies between agents ([DEC-05](../design/DECISIONS.md#dec-05)) | AGENTS.md and the spine reworded |
| D4 | Dead code cut; three modules wired in or cut by their workstream ([DEC-09](../design/DECISIONS.md#dec-09)) | Workstream B0 |
| D5 | SPDX parsing and the official API clients approved ([DEC-08](../design/DECISIONS.md#dec-08)) | Added when their workstream arrives; other proposals still need a yes each |
| D6 | The ceiling run comes after local v1 is done ([DEC-07](../design/DECISIONS.md#dec-07)) | After Phase C |
| D7 | Company-server minimum in v1 ([DEC-06](../design/DECISIONS.md#dec-06)) | Part of workstream B4.9 |

## Phase A.5 — the design refined until it is ready to build from

Phase A found the design and the code disagreeing in eighteen places and four separate records of "what is built". Spec-driven development needs a specification that is true before it can be built against, so this phase rebuilds the design (COVERAGE T6) before any Phase B workstream starts:

- [SPINE.md](../design/SPINE.md): positioning, the spine, the journey, roles, how the parts fit, locked decisions, the claims table, and one status row per specification;
- fifteen specifications in [docs/design/specs/](../design/specs/README.md), each with its status, its state per capability with evidence, and EARS acceptance criteria for every change it carries;
- [DECISIONS.md](../design/DECISIONS.md) and [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md);
- the 2026-09-17 design and its companions archived, with a map from each old section to its new home;
- [DEFINITION_OF_DONE.md](../../DEFINITION_OF_DONE.md) v3: what done means for a specification, a workstream and the product (§5–§6).

**Exit — ready for spec-driven development** when:
1. every specification meets DEFINITION_OF_DONE §5.2 (ready for building);
2. every COVERAGE change ID (S, M, P, T) is carried by at least one specification — where two share one, each says which part it carries — and every gap a specification found has an ID;
3. `docs.spec.ts` fails when a specification's front matter and the SPINE status table disagree (the first slice of T10);
4. **nothing was lost**: [DESIGN_TRACE.md](DESIGN_TRACE.md) traces every capability and requirement of the old design, its companions and the three feature inventories to the place that now carries it, and every item not carried was decided by the owner; every recommendation in `docs/research/` that was accepted is carried by a spec that cites it; an independent review checked the trace against the old text and found no contradiction between specifications;
5. `pnpm gate` passes and `main` is fast-forwarded.

## Phase B — build to the Definition of Done, one workstream at a time

Each workstream is one session: specification → numbered plan → failing tests → build → independent review → `pnpm gate` → the specification updated → `main` fast-forwarded (DEFINITION_OF_DONE §5.3). The order below follows three rules: nothing unsafe runs the uncensored Worker again; nothing is refactored before it is measured; and the product work that carries the positioning comes once the ground under it is solid.

| # | Workstream | Carries (Phase A IDs; the rest in COVERAGE) | Spec | Needs first | Size |
| --- | --- | --- | --- | --- | --- |
| **B0** | Housekeeping: the approved cuts, including the plugin container and the SDK package (DEC-29 O4), with extensibility's front matter updated in the same commit; the dead loops and the variant archive (DEC-25 R31); wire-or-cut for `research/desk.ts` and `adjudicate`/`acceptRevision` | D4 | several | — | S |
| **B1** | **Worker containment**: fail closed; one confined execution path with an allowlisted environment; one egress policy; nested `.git` on Linux, the rest of the git hardening list, a `.git/config` preflight, per-worktree dependency links; injection fixtures run against the real Worker | S2, S3, S3a, S3b | [security](../design/specs/security.md) | B0 | M–L |
| **B2** | **Measurement validity, then the baseline** | | | | |
| B2.1 | Prompt coherence; thinking budget and `finish_reason`; data contracts; the append-only prompt; token budgets that fit the window, Zone 4 included (DEC-27); the fixed tool set per card class; the one stop-reason table; the evidence-gated-commit switch for B2.5 | M1, M2, M3, M5, M8, T3 | [worker-loop](../design/specs/worker-loop.md), [context](../design/specs/context.md) | B1 | L — three packages (prompt and budgets; tool sets and stop reasons; the switch), each its own cards |
| B2.2 | Provenance on every card; qualification per engine, model, host and settings; MTP measured in seconds per step | M4, M7, M11 | [models](../design/specs/models.md) | B1 | M |
| B2.3 | Gate feedback proven on real tool output; built-in gates never vanish | M6 | [gates](../design/specs/gates.md) | B1 | M |
| B2.4 | One measurement path, mutation pre-check, small-sample statistics, the planning measure, the admission code (T8 — built and tested on scripted attempt records; it runs live once NEW-worker-loop-5 lands in B4.0a), and the **evaluation assets the baseline uses** — reference solutions, golden briefs, the held-out acceptance suite (T11, first part) | M9, M10, M12, T7, T8, T11 | [measurement](../design/specs/measurement.md) | B2.1–B2.3 | L |
| B2.5 | **The baseline**: the thinking arms, the strict method, the fixed-tool-set arm (M2), the evidence-gated commit (ECLoop) arm, then the full scored suite and the planning measure. Freezes the **baseline RunProfile** (below) | M2 | [measurement](../design/specs/measurement.md) | B2.4 | machine time |
| **B3** | **The spine in code** | | | | |
| B3.1 | Transitions checked in the kernel; one transaction per event; hash chain v3 with a private part; owner, delegate and accepter; versioned requirements; backup and migrations | S4, S7 | [kernel](../design/specs/kernel.md) | B2.5 | L |
| B3.2 | Safe, reversible Accept; Review WIP from human decisions; accept-awaiting-merge | S5, S6 | [review-git](../design/specs/review-git.md) | B3.1 | M |
| B3.3 | Offline `plan`; CLI exit codes; dashboard hardening; workspace trust; runner lease and process safety; retention as recorded erasure | S8, S10, S3c, S9 | [surface](../design/specs/surface.md), [runtime](../design/specs/runtime.md), [security](../design/specs/security.md), [extensibility](../design/specs/extensibility.md) | B3.1 | L |
| **B4** | **Depth in the core, then the product** — each measured against the B2.5 baseline | | | | |
| B4.0a | The engine after the baseline: one allocator for every role, rule curation, language servers through LSP, the rename tool, MCP without prefill cost, the residency scheduler, the registry the code reads | — | [context](../design/specs/context.md), [worker-loop](../design/specs/worker-loop.md), [models](../design/specs/models.md) | B2.5 | L |
| B4.0b | One gate pipeline (T1) and the source index (T2), then test strength and work on existing code (change kinds, superseded tests, the error baseline). Until the depth profile (P14) and the test-author step (P1) exist, test strength uses the *internal tool* profile and the planner's current acceptance tests | T1, T2 | [gates](../design/specs/gates.md) | B4.0a | L |
| B4.1 | One first run for all three audiences, including an existing team repository; a new user's first card end to end; the **Configuration page** — model folders scanned, roles recommended, explicit downloads, and the benchmark: the Worker and Planner screens and the overnight tier's Worker and planning runs here; the Reviewer's and Researcher's screens join with B4.8 and B4.4 (until then they read "Not measured yet") (DEC-29 O2, O3) | P10 | [surface](../design/specs/surface.md), [models](../design/specs/models.md), [dashboard](../design/specs/dashboard.md) | B3.3, B4.0a | L |
| B4.2 | Navigation and colour/contrast roles | P11, P12 | [dashboard](../design/specs/dashboard.md) | B3.3 | S |
| B4.3 | One planner, model first, with an acceptance-criterion contract; project done computed from a requirement graph, with slices and appetite | P1, P13 | [planner-pm](../design/specs/planner-pm.md) | B4.0b | L |
| B4.4 | Start a project by conversation; depth profile, comparables and walkthrough; project documents in the repository | P2, P14 | [planner-pm](../design/specs/planner-pm.md), [design-stage](../design/specs/design-stage.md) | B4.3 | L |
| B4.5 | Reuse survey by capability, with the SPDX licence classifier | P7 | [design-stage](../design/specs/design-stage.md) | B4.4 | M |
| B4.6 | A professional board: familiar columns and card anatomy, story map and burn-up | P3 | [dashboard](../design/specs/dashboard.md) | B4.3 | M |
| B4.7 | The Learn layer; the status view for non-developers | P4, P5 | [dashboard](../design/specs/dashboard.md) | B4.6 | M |
| B4.8 | The senior-PM skill, scored; the Reviewer rebuilt | P6, P8 | [planner-pm](../design/specs/planner-pm.md), [review-git](../design/specs/review-git.md) | B4.4, B3.2 | M |
| B4.9 | GitHub first: one adapter, one ID, merge-aware, owner and delegate mapped | P9 | [integrations](../design/specs/integrations.md) | B3.2 | M |
| B4.10 | The company-server minimum: bind, identity, Accept permission, fair scheduling across people | P9, DEC-06 | [runtime](../design/specs/runtime.md), [integrations](../design/specs/integrations.md) | B4.9 | L |
| **B5** | **Structure**, as each workstream above touches it — never on its own | T4, T5, T9, T10 | per spec | — | — |

### Milestones the owner sees

| After | The owner can see |
| --- | --- |
| B1 | The uncensored Worker cannot leave its sandbox: the containment suite, including a Worker that tries, is green on macOS and Linux |
| B2.5 | A recorded, reproducible baseline: one RunProfile, the full suite and the planning measure, every failure named |
| B3 | A person can safely accept, undo and send back cards on a real repository, and the ledger survives a crash and an upgrade |
| B4.4 | A non-developer starts a project on the reference machine by conversation and watches its must-haves become proven |
| B4.10 | A small team uses one server: each person's identity, who may accept, fair turns on the model |
| C | v1: DEFINITION_OF_DONE §6 on one release commit |

### The baseline RunProfile

B2.5 ends by freezing one recorded `RunProfile` — Worker model, quantisation, engine and its settings, the thinking policy, the tool arm, the working method, the context version, the gates configuration and the suite hash — in [SUITE_RUNS.md](SUITE_RUNS.md). Every later comparison names it; a workstream that changes any field compares against it, paired.

### Evaluation assets, each built before its first use (T11)

Every asset needs a person's labels; the estimates are the owner's time, and the plan waits on them where the asset is first used. In total about 30–40 person-hours, most of it in B2.4 (about 12) and B4.8 (about 10).

| Asset | Built in | First used by | Labelling (person-hours, estimate) |
| --- | --- | --- | --- |
| Reference solutions per fixture card; golden briefs with annotated implicit requirements; the held-out acceptance suite | B2.4 | B2.5 (the planning measure) | about 12 |
| Injection fixtures | B1 | B1 (the Worker that tries to leave) | about 3 |
| The quick benchmark's screening sets — 6 Worker cards and 3 golden briefs in B4.1; the Researcher's 5 questions over a cached corpus with B4.4; the Reviewer's 10 seeded defects with B4.8 | B4.1, B4.4, B4.8 | the Configuration page's quick benchmark (NEW-measurement-5) | about 3 (reused from the sets below) |
| Labelled UI screens | B2.3 | the visual checklist (GT-N4-2) | about 3 |
| The research golden set; scripted non-developer project starts | B4.4 | B4.4 | about 6 |
| The labelled reuse set | B4.5 | B4.5 | about 4 |
| Seeded defects; public review datasets (O22); scripted PM conversations | B4.8 | B4.8 | about 10 |

### Machine time

The reference machine is the bottleneck: it cannot build while a suite runs, and one 30-card run takes about two hours (14 cards took 53 minutes). A paired A/B is at least two runs per arm. Budget: **B2.5 about two machine-days** (the three thinking arms, the strict method, the tool arm and the evidence-gated arm, each twice, then the full suite and the planning measure); **every later workstream that touches the loop, context, gates, models, sandbox or runner, one confirmation run** (DEFINITION_OF_DONE §5.3.4) — and **a paired A/B, two runs per arm (about eight machine-hours), for any workstream that changes a prompt, a tool, a budget policy or a skill**, because those are harness changes admitted only by DEC-28. B2.1, B4.0a and B4.0b each carry several; they are batched into as few A/Bs as the changes allow. **In total** about 10–14 machine-days across Phase B — two for B2.5, about eight hours per paired A/B in B2.1, B4.0a and B4.0b (several each, batched), a confirmation run for each other workstream that touches a run, and Phase C's final suite and planning measure — almost all of it overnight. The owner's own overnight benchmarks of model combinations (NEW-measurement-5) use the same window and never overlap a plan run: the plan's runs take the window first. Runs are scheduled overnight and batched; code work continues on a second checkout that does not rebuild the suite's `dist/`.

### Risks

| Risk | Early sign | Response |
| --- | --- | --- |
| Apple removes `sandbox-exec` | A macOS release deprecates it further | Fail closed (S3b); a VM per card ([security](../design/specs/security.md) §8) |
| The uncensored Worker defeats containment | An injection fixture escapes in B1 | Stop runs; DEC-04's reopen condition applies |
| No model of a different family fits the Reviewer on 24 GB | B4.8 qualification finds none | Ship v1 with the Reviewer unfilled and say so; P8's acceptance is then measured on a larger host ([review-git](../design/specs/review-git.md) §8) |
| Memory: language servers, the Planner and the Reviewer swapping on 24 GB | The watchdog's high stage during B4.0a | The residency scheduler (NEW-models-9); fewer co-resident tools |
| v1 measures below the B2.5 baseline | Phase C paired comparison | A loss the suite can resolve blocks the release; the responsible workstream is reverted or fixed |
| The suite cannot resolve the improvements | Most A/Bs come back inconclusive | DEC-28: inconclusive changes are adopted only if cheaper or simpler and not worse |

"Needs first" lists the workstreams that must land before; every owner decision the design depends on is now either decided or has a stated default that unblocks it ([OPEN_QUESTIONS](OPEN_QUESTIONS.md#owner-decisions)), so none appears there.

The table names each workstream's Phase A changes; the 106 further changes the specifications added (`NEW-<spec>-<n>`) are listed in [COVERAGE.md](COVERAGE.md) with the workstream that builds each, so every change has a place in this sequence.

A large file is split only inside a workstream already working in it, behind tests, and its complexity must go down, not move (rule 6).

Two rules carried from the 2026-09-17 design govern the order and the estimates:

- **Depth before reach.** The core — the Worker loop, gates, context assembly, review and measurement — is held to the full bar and is what the harness is judged on. Supporting surface (the SDK, notifications, the air-gap kit, the integration catalogue) may stay thin, and its spec says so. A thin supporting surface is a decision; a thin core is a defect.
- **A package is not a card.** Several mechanisms are packages built over many cards behind an interface, never one card: deep research, the GitHub adapter, the language-server pool, the repo map with its ranking and budget fit, the failure-parser set, structural diffs, the virtualised board, the visual gate stack, the source index (T2) and the requirement graph (P13). A plan that shows one of them as a single card is wrong by an order of magnitude.

## Phase C — measure, then release

Phase C is DEFINITION_OF_DONE §6 checked on one release commit: every specification built, the spine kept in code, the full frozen suite and the planning measure against the B2.5 baseline, the three audience walks, accessibility, the company-server minimum, a new user's first card, and the release gate. The difference from the baseline is the answer to whether the pass made the product better.

**After v1:** the ceiling run with a frontier model as the Worker ([DEC-07](../design/DECISIONS.md#dec-07)), then cloud models per role ([DEC-03](../design/DECISIONS.md#dec-03)).

## Guardrails

- `pnpm gate` before every commit; `pnpm release-gate` (DEFINITION_OF_DONE §4, rungs 1–8) before any release.
- Every commit carries its `GateStatus` trailer.
- Complexity on changed files only: Biome's `noExcessiveCognitiveComplexity`, reported first and gated once the baseline is known.
- Never rebuild `dist/` while a suite run is in progress; check memory before loading a model and unload after.

## Proposals: new features and existing code

*Owner's standing permission, 2026-09-22.* Reviews may **propose** new features, and legally usable existing repositories and libraries — Python included — in place of building from scratch. Every proposal names what it is, its licence (permissive, or flagged if weak copyleft), how it is maintained, what it replaces or adds, and why. **Nothing is added without the owner's explicit yes**; proposals are collected in `COVERAGE.md` for that decision. Approved so far: [DEC-08](../design/DECISIONS.md#dec-08).

## Status

| Step | State |
| --- | --- |
| 0. Handoff: CLAUDE.md, AGENTS.md, DEFINITION_OF_DONE v2, release gate, this plan | Done 2026-09-22 |
| A. Review and baseline | Review done (17 domains, `COVERAGE.md`); owner decisions D1–D7 taken; baseline arm "off" 10/14, the rest in B2.5 |
| A.5 Design refined for spec-driven development | In progress |
| B. Workstreams B0–B5 | — |
| C. Measure and release | — |
