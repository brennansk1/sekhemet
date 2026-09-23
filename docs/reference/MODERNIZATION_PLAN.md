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

Sixteen domains cover the whole product. Each maps design sections to code.

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

| # | Workstream | Carries | Spec | Size |
| --- | --- | --- | --- | --- |
| **B0** | Housekeeping: the approved cuts; wire-or-cut decided for `retention.ts`, `research/desk.ts`, `adjudicate`/`acceptRevision` | D4 | several | S |
| **B1** | **Worker containment**: fail closed (S3b); one confined execution path for gates, dev servers and language servers with an allowlisted environment (S3a); one egress policy (S3); nested `.git` on Linux, the rest of the git hardening list and a `.git/config` preflight, per-worktree dependency links (G2–G4) | S2, S3, S3a, S3b | [security](../design/specs/security.md) | M–L |
| **B2** | **Measurement validity**, then the baseline | | | |
| B2.1 | Prompt coherence, separate thinking budget and `finish_reason`, data contracts as their own section, the append-only prompt for cache reuse | M1, M3, M5, M8 | [worker-loop](../design/specs/worker-loop.md), [context](../design/specs/context.md) | M |
| B2.2 | Provenance on every card; MTP measured per host in seconds per turn | M4, M7, M11 | [models](../design/specs/models.md) | S–M |
| B2.3 | Gate feedback proven on real tool output; built-in gates never vanish | M6 | [gates](../design/specs/gates.md) | S–M |
| B2.4 | Benchmark wrapper, mutation pre-check, small-sample statistics, the planning measure (with implicit-requirement recall and premature completion) | M9, M10, M12, T7 | [measurement](../design/specs/measurement.md) | M |
| B2.5 | **The baseline:** the thinking A/B arms, the strict working method, a fixed tool set (M2), then the full scored frozen suite and the planning measure, recorded | M2 | [measurement](../design/specs/measurement.md) | runs |
| **B3** | **The spine in code** | | | |
| B3.1 | Transitions checked in the kernel; one transaction per event | S4, S7 | [kernel](../design/specs/kernel.md) | M |
| B3.2 | Safe, reversible Accept; Review WIP from human decisions | S5, S6 | [review-git](../design/specs/review-git.md) | M |
| B3.3 | `plan` honours offline mode; CLI exit codes and `--version`; dashboard hardening; workspace trust | S8, S10, S3c, S9 | [surface](../design/specs/surface.md), [runtime](../design/specs/runtime.md), [security](../design/specs/security.md), [extensibility](../design/specs/extensibility.md) | M |
| **B4** | **The product** — the positioning, measured against the B2.5 baseline | | | |
| B4.1 | One first run for all three audiences, including an existing team repository | P10 | [surface](../design/specs/surface.md) | M |
| B4.2 | Navigation (grouped, labelled, phone bar) and colour/contrast roles | P11, P12 | [dashboard](../design/specs/dashboard.md) | S |
| B4.3 | One planner, model first, with an acceptance-criterion contract; project done computed from a requirement graph, with slices and appetite | P1, P13 | [planner-pm](../design/specs/planner-pm.md) | L |
| B4.4 | Start a project by conversation, with the design stage and research behind it; depth profile, comparables and walkthrough | P2, P14 | [planner-pm](../design/specs/planner-pm.md), [design-stage](../design/specs/design-stage.md) | L |
| B4.5 | Reuse survey by capability, with the SPDX licence classifier | P7 | [design-stage](../design/specs/design-stage.md) | M |
| B4.6 | A professional board: familiar columns and card anatomy, then story map and burn-up | P3 | [dashboard](../design/specs/dashboard.md) | M |
| B4.7 | The Learn layer; the status view for non-developers | P4, P5 | [dashboard](../design/specs/dashboard.md) | M |
| B4.8 | The senior-PM skill, scored on scripted conversations; the Reviewer rebuilt | P6, P8 | [planner-pm](../design/specs/planner-pm.md), [review-git](../design/specs/review-git.md) | M |
| B4.9 | GitHub first; then the company-server minimum (bind, identity, Accept role) | P9, D7 | [integrations](../design/specs/integrations.md), [runtime](../design/specs/runtime.md) | L |
| **B5** | **Structure**, as each workstream above touches it — never on its own | T1–T5, T8–T10 | per spec | — |

A large file is split only inside a workstream already working in it, behind tests, and its complexity must go down, not move (rule 6).

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
