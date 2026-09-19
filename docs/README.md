# Sekhemet documentation

Every document in `docs/` is listed here, and nowhere else is the source of truth. A test (`apps/harness/tests/docs.spec.ts`) fails the build if a document is missing from this index, a relative link is broken, or a new markdown file appears at the repository root outside the allowed set.

**Rules for adding a document**
1. Put it in the folder that matches its purpose (below). There is no `misc/`.
2. Add one line to this index: link, then what it is for, in one sentence.
3. Link other documents by relative path from where the file lives.
4. A document that replaces another deletes the old one; git keeps the history. Never keep "v1" and "v2" side by side.

## At the repository root (fixed set)

| File | Purpose |
|---|---|
| [README.md](../README.md) | What Sekhemet is, how to run it, current status. |
| [AGENTS.md](../AGENTS.md) | Rules for any AI agent working in this repo. |
| [CLAUDE.md](../CLAUDE.md) | Claude Code's operating guide for this repo. |
| [DEFINITION_OF_DONE.md](../DEFINITION_OF_DONE.md) | What "finished" means for the harness. |
| [DEV_LOG.md](../DEV_LOG.md) | Dated record of who did what, newest first. |

## design/: how the product works and looks

| File | Purpose |
|---|---|
| [HARNESS_DESIGN.md](design/HARNESS_DESIGN.md) | The full harness design: kernel, loop, gates, board, planner. |
| [FRONTEND_DESIGN.md](design/FRONTEND_DESIGN.md) | Dashboard information architecture, voice, tokens and phases. |
| [PM_DESIGN.md](design/PM_DESIGN.md) | Seshat (the project manager), team practices, Insights, Integrations. |
| [PM_CONTRACT.md](design/PM_CONTRACT.md) | Backend and dashboard contract for Seshat, integrations and learning. |
| [INTEGRATION_REVIEW.md](design/INTEGRATION_REVIEW.md) | How the Worker, Seshat, reviewer, Researcher, learning and scheduling fit together; findings, ranked fixes and a target architecture. |
| [NAMING.md](design/NAMING.md) | The naming rule: what keeps its professional name, what is themed. |
| [mockups/](design/mockups/) | Static HTML mockups of the dashboard surfaces. |

## benchmarks/: the test projects the harness must complete

| File | Purpose |
|---|---|
| [CHRONICLE_SPEC.md](benchmarks/CHRONICLE_SPEC.md) | Chronicle: the 6-card gate project (Pass@1 target at least 5/6). |
| [SHOWCASE_TRIFECTA_SPEC.md](benchmarks/SHOWCASE_TRIFECTA_SPEC.md) | Onyx, Basalt Canvas and Vanguard: the 24-card showcase projects. |

## research/: evidence behind decisions

| File | Purpose |
|---|---|
| [PM_RESEARCH_SYNTHESIS.md](research/PM_RESEARCH_SYNTHESIS.md) | Deep Research findings mapped to what is built and what is planned. |
| [MODEL_CANDIDATES.md](research/MODEL_CANDIDATES.md) | Local model candidates, benchmarks and the worker/manager choice. |
| [IMPLEMENTATION_AUDIT.md](research/IMPLEMENTATION_AUDIT.md) | Every request, research recommendation and paper finding against its commit and test: the gate before the evaluation. |
| [RESEARCH_REGISTER.md](research/RESEARCH_REGISTER.md) | Candidate techniques through spotted, triaged, shortlisted, benched and adopted or rejected, with evidence and pre-set thresholds; checked by the build. |

## reference/: exhaustive inventories

| File | Purpose |
|---|---|
| [FEATURE_INVENTORY.md](reference/FEATURE_INVENTORY.md) | Every feature in the design and its implementation status. |
| [FEATURE_INVENTORY_REAUDIT.md](reference/FEATURE_INVENTORY_REAUDIT.md) | The inventory re-audited against the current code: status per unit with its caller, and the remaining gaps ranked. |
| [FEATURE_INVENTORY_REAUDIT_2.md](reference/FEATURE_INVENTORY_REAUDIT_2.md) | Independent re-audit, pass 1: every unit except X and U scored against the gate (to depth, production caller, real test), with the gaps ranked. |
| [COMPLETION_PLAN.md](reference/COMPLETION_PLAN.md) | The gate: every inventory unit BUILT, in waves of two builders, verified by an independent re-audit. |
| [PROVENANCE.md](reference/PROVENANCE.md) | Every adopted technique's public source and the licence register the `licenses` gate enforces. |
