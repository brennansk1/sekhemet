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
| [SPINE.md](design/SPINE.md) | Start here: what Sekhemet is, the spine, a project's journey, how the parts fit, what is locked for v1, the claims table and every specification's status. |
| [DECISIONS.md](design/DECISIONS.md) | Every settled decision — product, engineering, substitutions, rejected techniques — with its reason and what would reopen it. |
| [specs/README.md](design/specs/README.md) | The specification format, the index of specifications, and where each section of the old design went. |
| [specs/surface.md](design/specs/surface.md) | The CLI, first run, configuration, onboarding an existing repository. |
| [specs/kernel.md](design/specs/kernel.md) | Event log, projections, card lifecycle and its state machine. |
| [specs/worker-loop.md](design/specs/worker-loop.md) | The Worker's loop, tools, stop reasons, repair ladder, working method. |
| [specs/context.md](design/specs/context.md) | Context assembly, scope, context-rot defence, prompt layout and the playbook. |
| [specs/gates.md](design/specs/gates.md) | Gate layers, project gates, `gates.toml`, gate economics. |
| [specs/models.md](design/specs/models.md) | Hardware calibration, the model registry, inference servers, bake-off. |
| [specs/measurement.md](design/specs/measurement.md) | The frozen suite, the planning measure, statistics, self-improvement. |
| [specs/planner-pm.md](design/specs/planner-pm.md) | The planner, the PM (Seshat), goals, human collaboration. |
| [specs/design-stage.md](design/specs/design-stage.md) | The design stage, new projects, research and reuse. |
| [specs/review-git.md](design/specs/review-git.md) | The Reviewer, Accept, the git workflow. |
| [specs/dashboard.md](design/specs/dashboard.md) | The web dashboard: board, review, status, Learn layer, visual system. |
| [specs/security.md](design/specs/security.md) | Sandboxing, permissions, egress, secrets, workspace trust, air-gap. |
| [specs/integrations.md](design/specs/integrations.md) | GitHub, Jira, Linear, notifications, identity sources for the Team setup. |
| [specs/teams.md](design/specs/teams.md) | Solo and Team setups, accounts and sign-in, access levels, AI teammates, inbox, presence, audit, project updates. |
| [specs/extensibility.md](design/specs/extensibility.md) | Hooks, skills, MCP and ACP. |
| [specs/runtime.md](design/specs/runtime.md) | Daemon, runner lease, sessions, the HTTP API, audit, telemetry, retention. |
| [PM_CONTRACT.md](design/PM_CONTRACT.md) | The HTTP shapes between the dashboard and the PM, integrations and learning. |
| [NAMING.md](design/NAMING.md) | The naming rule: what keeps its professional name, what is themed. |
| [mockups/](design/mockups/) | Static HTML mockups of the dashboard surfaces (historical; the spec wins). |

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
| [DESIGN_RESEARCH_TESTS_BROWNFIELD.md](research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) | Test strength as the basis of "proven", working in existing codebases, and a source index that can take Python without a rebuild (TypeScript 7 has no programmatic API). |
| [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) | Mixed human and AI teams, erasure in a hash-chained log, backups, change and release, project documents in the repository, and review ergonomics for AI-written code. |
| [DESIGN_RESEARCH_TEAM_SERVER.md](research/DESIGN_RESEARCH_TEAM_SERVER.md) | Multi-user local inference on a team server, fair scheduling, qualification per engine, packaging and upgrades. |
| [DESIGN_RESEARCH_COLLABORATION.md](research/DESIGN_RESEARCH_COLLABORATION.md) | Access levels, the AI as a teammate that proposes, collaboration mechanics, sign-in on a team's own hardware, sharing one model fairly, and status for stakeholders and engineers. |
| [SANDBOX_REUSE.md](research/SANDBOX_REUSE.md) | Reusing an existing sandbox engine: Anthropic's sandbox-runtime against our Seatbelt, bubblewrap and egress code, criterion by criterion (DEC-39) |

## reference/: plans, measurements, reviews and registers

| File | Purpose |
|---|---|
| [SUITE_RUNS.md](reference/SUITE_RUNS.md) | Every recorded frozen-suite score with its hash, and why the failures failed. |
| [PHASE0.md](reference/PHASE0.md) | The go/no-go measurement and its verdict: what was measured, what it does not establish, and how to reproduce it. |
| [MVP_PATH.md](reference/MVP_PATH.md) | The one sequence that has to work, and what is deliberately sequenced behind it. The gap lists are ordered by unit; this is ordered by what ships. |
| [MODERNIZATION_PLAN.md](reference/MODERNIZATION_PLAN.md) | The Opus 5.5 pass over the AI brownfield: review every domain, change what the review justifies, measure every change. Supersedes the 2026-09-18 completion plan. |
| [COVERAGE.md](reference/COVERAGE.md) | Phase A of the modernization: every domain reviewed, the ranked programme, and the decisions that need the owner. |
| [OPEN_QUESTIONS.md](reference/OPEN_QUESTIONS.md) | Benchmarks still owed, unverified research gaps and open design questions, each with its state and where it is decided. |
| [DESIGN_TRACE.md](reference/DESIGN_TRACE.md) | The proof that design v3 lost nothing: every item of the 2026-09-17 design, its companions and the feature inventories traced to where it lives now, with what moved to Later and what changed on purpose. |
| [trace_sources/trace_hd1.md](reference/trace_sources/trace_hd1.md) | Raw trace rows of the old design, lines 1–1800, as first traced on 2026-09-22; the verified status is in DESIGN_TRACE.md. |
| [trace_sources/trace_hd2.md](reference/trace_sources/trace_hd2.md) | Raw trace rows of the old design, lines 1801–end, and the integration review, as first traced on 2026-09-22; the verified status is in DESIGN_TRACE.md. |
| [trace_sources/trace_pm_fe.md](reference/trace_sources/trace_pm_fe.md) | Raw trace rows of the old PM and frontend designs, as first traced on 2026-09-22; the verified status is in DESIGN_TRACE.md. |
| [trace_sources/trace_inv.md](reference/trace_sources/trace_inv.md) | Raw trace rows of the three feature inventories, as first traced on 2026-09-22; the verified status is in DESIGN_TRACE.md. |
| [trace_sources/corrections_later_deliberate.md](reference/trace_sources/corrections_later_deliberate.md) | Corrections from re-verifying every later and deliberate trace row. |
| [trace_sources/corrections_pmfe.md](reference/trace_sources/corrections_pmfe.md) | Corrections from re-verifying every PM and frontend trace row, and the dashboard details restored. |
| [trace_sources/corrections_hd_inv.md](reference/trace_sources/corrections_hd_inv.md) | Corrections from re-verifying the harness-design, integration-review and inventory trace rows. |
| [trace_sources/corrections_inv_full.md](reference/trace_sources/corrections_inv_full.md) | Corrections from the full check of every remaining inventory trace row. |
| [trace_sources/corrections_hd_full.md](reference/trace_sources/corrections_hd_full.md) | Corrections from the full check of every remaining harness-design and integration-review trace row. |
| [reviews/integration_review_2026-09-18.md](reference/reviews/integration_review_2026-09-18.md) | A dated review of how the Worker, Seshat, reviewer, Researcher, learning and scheduling fit together; its findings are folded into the specs. |
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
| [reviews/design_v3_review.md](reference/reviews/design_v3_review.md) | Independent review of design v3: contradictions, readiness for spec-driven development, research coverage, the spine, and depth in the core. |
| [reviews/design_v3_confirmation.md](reference/reviews/design_v3_confirmation.md) | A second, independent review confirming each finding of the first is resolved, and whether design v3 is ready for spec-driven development. |
| [reviews/design_v3_final_check.md](reference/reviews/design_v3_final_check.md) | The last independent check of design v3: what changed after the confirmation review, and the verdict on starting Phase B. |
| [reviews/design_trace_audit.md](reference/reviews/design_trace_audit.md) | An independent audit of 124 sampled trace rows against the old text: the error rate and every error found. |
| [PROVENANCE.md](reference/PROVENANCE.md) | Every adopted technique's public source and the licence register the `licenses` gate enforces. |
