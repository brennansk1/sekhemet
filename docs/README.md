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
| [WEB_RESEARCH_2026-09.md](research/WEB_RESEARCH_2026-09.md) | Web research for the Opus 5.5 pass: prompt-cache reuse and MTP on hybrid models, sandbox and git safety, the competitive landscape and professional practice, small-sample statistics and model choice. |
| [WORKER_METHOD_LITERATURE.md](research/WORKER_METHOD_LITERATURE.md) | The literature behind the Worker's senior-engineer working method: interface ablations, planning, verification and repair for small agentic models. |
| [PAPER_REVIEWS_2026-09.md](research/PAPER_REVIEWS_2026-09.md) | Six September 2026 papers and one model release reviewed against the design, with what to integrate. |
| [PUBLIC_DATA_SURVEY.md](research/PUBLIC_DATA_SURVEY.md) | Which public datasets could seed the learning loops and the playbook, with verified licences and verdicts. |
| [PROJECT_DONE_AND_DEPTH.md](research/PROJECT_DONE_AND_DEPTH.md) | Why LLMs misjudge when a project is done and how much to build, what works (requirement graphs, appetite, story-map slices, Kano, comparables, quality checklists), and how Sekhemet builds it in. |

## reference/: exhaustive inventories

| File | Purpose |
|---|---|
| [FEATURE_INVENTORY.md](reference/FEATURE_INVENTORY.md) | Every feature in the design and its implementation status. |
| [FEATURE_INVENTORY_REAUDIT.md](reference/FEATURE_INVENTORY_REAUDIT.md) | The inventory re-audited against the current code: status per unit with its caller, and the remaining gaps ranked. |
| [FEATURE_INVENTORY_REAUDIT_2.md](reference/FEATURE_INVENTORY_REAUDIT_2.md) | Independent re-audit, pass 1: every unit except X and U scored against the gate (to depth, production caller, real test), with the gaps ranked. |
| [SUITE_RUNS.md](reference/SUITE_RUNS.md) | Every recorded frozen-suite score with its hash, and why the failures failed. |
| [PHASE0.md](reference/PHASE0.md) | The go/no-go measurement and its verdict: what was measured, what it does not establish, and how to reproduce it. |
| [MVP_PATH.md](reference/MVP_PATH.md) | The one sequence that has to work, and what is deliberately sequenced behind it. The gap lists are ordered by unit; this is ordered by what ships. |
| [MODERNIZATION_PLAN.md](reference/MODERNIZATION_PLAN.md) | The Opus 5.5 pass over the AI brownfield: review every domain, change what the review justifies, measure every change. Supersedes the 2026-09-18 completion plan. |
| [COVERAGE.md](reference/COVERAGE.md) | Phase A of the modernization: every domain reviewed, the ranked programme, and the decisions that need the owner. |
| [reviews/domain01_16_surface_docs.md](reference/reviews/domain01_16_surface_docs.md) | Phase A review: product surface and the documents. |
| [reviews/domain02_09_kernel_review.md](reference/reviews/domain02_09_kernel_review.md) | Phase A review: kernel, lifecycle, review and human decisions. |
| [reviews/domain03_worker_loop.md](reference/reviews/domain03_worker_loop.md) | Phase A review: the Worker loop and tools. |
| [reviews/domain04_context.md](reference/reviews/domain04_context.md) | Phase A review: context assembly and prompts. |
| [reviews/domain05_10_models_measurement.md](reference/reviews/domain05_10_models_measurement.md) | Phase A review: models, hardware, measurement and learning. |
| [reviews/domain06_gates_dod.md](reference/reviews/domain06_gates_dod.md) | Phase A review: gates, and the DEFINITION_OF_DONE audit. |
| [reviews/domain07_planner_pm.md](reference/reviews/domain07_planner_pm.md) | Phase A review: the Planner and the PM. |
| [reviews/domain08_design_research.md](reference/reviews/domain08_design_research.md) | Phase A review: the design stage and research. |
| [reviews/domain11_14_security_runtime.md](reference/reviews/domain11_14_security_runtime.md) | Phase A review: security and runtime (defensive: findings and fixes). |
| [reviews/gap_sweep.md](reference/reviews/gap_sweep.md) | Phase A gap sweep: the twelve source files no domain review mentioned. |
| [reviews/security_fix_review.md](reference/reviews/security_fix_review.md) | Independent review of the S1/S2 sandbox fixes: what they close and what stays open. |
| [reviews/domain12_15_integrations_ext.md](reference/reviews/domain12_15_integrations_ext.md) | Phase A review: integrations and extensibility. |
| [reviews/domain13_dashboard.md](reference/reviews/domain13_dashboard.md) | Phase A review: the dashboard and design system. |
| [reviews/domain17_brand_ux.md](reference/reviews/domain17_brand_ux.md) | Phase A review: brand, visual and interaction design, accessibility, and the three audiences' task walks. |
| [PROVENANCE.md](reference/PROVENANCE.md) | Every adopted technique's public source and the licence register the `licenses` gate enforces. |
