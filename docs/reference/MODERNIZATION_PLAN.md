# Modernization plan: the Opus 5.5 pass over an AI brownfield

*Set 2026-09-22, when the builder model changed from Claude Opus 5 to Claude Opus 5.5. Supersedes the completion plan of 2026-09-18 ("every inventory unit BUILT"); its inventory is an input here, and its three honesty rules are kept below.*

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

## Phase B — change, one workstream per domain

In the order Phase A ranks them. Each workstream: spec → plan → build → independent review → `pnpm gate` → commit, with large files split only as they are touched. Standing candidates, to be confirmed or reordered by Phase A:

- **The Worker's loop as explicit phases** — find, edit, verify — so the senior-engineer method is the loop's structure, splitting `session.ts` along the way.
- **The design restructured** into a short spine document (positioning, the fixed spine, how the parts fit) plus a specification per subsystem, each with a built / partial / not-built state.
- **Dashboard alignment** to professional boards — card anatomy, standard columns, labelled navigation, story map, burn-up, blocker causes — and a switchable **Learn** layer that teaches the practice.
- **New projects by conversation** with the PM, the design stage and the Researcher behind it.
- **The planning measure** — the fixtures' specifications planned from scratch and scored — because the frozen suite cannot see planning.

## Phase C — re-measure

The full frozen suite and the planning measure, against the Phase A baseline. The difference is the answer to whether the pass made the product better.

## Guardrails

- `pnpm gate` before every commit; `pnpm release-gate` (DEFINITION_OF_DONE §4, rungs 1–8) before any release.
- Every commit carries its `GateStatus` trailer.
- Complexity on changed files only: Biome's `noExcessiveCognitiveComplexity`, reported first and gated once the baseline is known.
- Never rebuild `dist/` while a suite run is in progress; check memory before loading a model and unload after.

## Known drift, recorded for Phase A

Found while writing this plan; each is resolved in its domain's review, not silently:

- **AGENTS.md bans "simulated Scrum personas (no fake Standups/Product Owners)"**, while the product has a PM persona (Seshat) that runs standups — and the positioning makes the professional PM central (domains 7 and 16).
- **The design's "100% local" locked decision** sits beside a positioning that plans cloud models after v1; the claims table records the resolution (after v1, optional per role), but the design's locked-decisions table still reads as permanent (domain 16).
- **CLAUDE.md described in-memory SQLite as the test standard**, contradicting DEFINITION_OF_DONE §2A; fixed in step 0 (domain 16).
- **`doctor` never detected a `llama-server`** — a 404 from Ollama's endpoint skipped the fallback — and did not probe the managed Worker's port 8098; fixed in step 0 (domain 5).

## Open decisions for the owner

- **A ceiling run:** the frozen suite once with a frontier model as the Worker, to separate harness defects from model limits. Measurement only — v1 stays 100% local — but it needs API access and costs money.

## Status

| Step | State |
| --- | --- |
| 0. Handoff: CLAUDE.md, AGENTS.md, DEFINITION_OF_DONE v2, release gate, this plan | Done 2026-09-22 |
| A. Review and baseline | Next |
| B. Workstreams | — |
| C. Re-measure | — |
