# Implementation audit: requirements, research and papers against what is built

The user's gate before the final evaluation: every feature, every research recommendation and every paper finding is either built (with its commit and the test that proves it), or deliberately not built for a stated reason. Every commit and test file below was checked to exist when this audit was written (see "Verification" at the end).

Status: **Built**, **Not built (by design)**, or **Needs hardware** (waits on the 128 GB Ubuntu host).

## 1. The user's requests, this cycle

| Request | Status | Commits | Proof (tests) |
|---|---|---|---|
| Chat with a project manager like one you hired, on the right model | Built: Seshat on the manager model; proposals, never silent edits | f99611d, 74ad6ec | apps/harness/tests/pm.spec.ts, pm_api.spec.ts |
| Board practices of top teams (priority, estimates, epics, cycles, flow metrics) | Built | f99611d, 61f7a64, 3d044af | packages/kernel/tests/team_fields.spec.ts, pm_api.spec.ts |
| Integrations a dev team uses (GitHub, Jira, Linear, Slack; roadmap for the rest) | Built | f99611d, 48eb93a, 515856c | pm_api.spec.ts |
| Pause the Worker to answer chat | Built | 74ad6ec | pm.spec.ts |
| Compaction on the level of Claude Code | Built: reversible compaction with `recall`, working memory, hybrid chat summary | 5fd3019, ae434fc, 2165493 | packages/context/tests/compaction.spec.ts, packages/loop/tests/working_memory.spec.ts |
| Agents that read their own history | Built: `git_history`; retries inherit lessons | 6e8206e, 26b926e | packages/loop/tests/history_tools.spec.ts |
| Do not reinvent the wheel; use legally usable libraries | Built: licence-checked library search, `dependencies` tool, the Researcher | d0626e3, b6eb636, 6e8206e, 764deec | apps/harness/tests/libraries.spec.ts, researcher.spec.ts |
| Organised documentation | Built: index plus a build-failing docs test | b028fe0 | apps/harness/tests/docs.spec.ts |
| Check RAM and unload during swaps | Built: unload confirmed, pressure waited out, swap refused otherwise | 26b926e | packages/models/tests/router_swap.spec.ts |
| Be strategic about when each model loads; plan for new hardware | Built: role batching, same-weights sharing, co-residency on large hosts, KV slot cache | 84cffa4, d1033d7, 8f2c986 | router_swap.spec.ts, slot_cache.spec.ts |
| Ubuntu AI node (128 GB) | Built: bubblewrap sandbox, PSI memory, configurable llama paths. End-to-end run: **needs hardware** | 79e0468 | packages/sandbox/tests/bubblewrap.spec.ts, packages/models/tests/memory_psi.spec.ts |
| Themed names only where it causes no confusion | Built: NAMING.md | 3d044af | (UI tests) |
| Self-improvement for Worker and manager; learning for the project and across projects; a user profile | Built | d1033d7, 520ae43, 3bfe6e1, c8d843f | apps/harness/tests/learning.spec.ts, tune.spec.ts, review.spec.ts |
| Manager calls out issues and the Worker learns from them | Built: Seshat's reflection, then candidate rules | d1033d7 | learning.spec.ts |
| Four models: worker, manager, adversarial reviewer, researcher (Apodex) | Built: roles, `/api/models`, Researcher with evidence and sources | 764deec, 1117479, 8d2791f | researcher.spec.ts, pm_api.spec.ts |
| Researcher browses the web and papers | Built: papers (HF, arXiv, S2), page fetch, GitHub, configured web search | 5e74e60, 4be429b | apps/harness/tests/web_research.spec.ts |
| Frontend of Claude-desktop quality, visually inspected | Built: Seshat, board v2, Insights and Integrations inspected by the lead. The latest learning, review and roster screens are inspected before the evaluation | 4dca1e5, 0560fbc, 61f7a64, 4f80811, e817749 | packages/ui/tests/*.spec.ts |

## 2. Research synthesis (docs/research/PM_RESEARCH_SYNTHESIS.md)

| Recommendation | Status | Commits / reason |
|---|---|---|
| Line-level localization (+4–8 pp) | Built | 8cecd2d (code at the failing line), c77c359 and 24f34b3 (real API members) |
| Split by the hazard law; measured size horizon | Built | 1f8bb18 (80% horizon); Seshat is told to split cards above it |
| Cap retries; escalate rather than retry the weak model | Built | 3bfe6e1 (replay-tuned stopping), 84cffa4 (escalation routing) |
| Reflection anchored to executable signals | Built | every learning loop starts from gate results or human actions (d1033d7) |
| ACE playbook with helpful/harmful counters; human-approved | Built | d1033d7, 520ae43 |
| Verify before persisting; prune skills that hurt | Built | rules are candidates until approved; retirement candidates at harmful minus helpful ≥ 3 |
| Context budget; edges for critical facts; top-k rules | Built | window budget and staged reductions; at most 8 scoped rules per card; the goal at the tail |
| Capability model from the ledger (Wilson, horizon) | Built | 1f8bb18 |
| IRT / Bayesian (D-BIRD) capability model | Not built (by design) | Both reports say it needs dozens of outcomes per cell; Wilson intervals plus the size horizon are the right model until about 30 attempts per kind. Revisit once the Trifecta data exists. |
| Preference learning from edits and send-backs; decay; scoping | Built | d1033d7, 520ae43 (Mem0-style consolidation, Erev-Roth value) |
| Proactivity budget (3–5 a day, offer rather than nag) | Built by design | Seshat speaks only when asked. The only unprompted messages are the run report (Slack, if connected) and review notes on cards. |
| Swap cost: static prompt head, ledger answers, KV persistence | Built | 1f8bb18 (static system prompt), 2165493 (status answered from the ledger), 8f2c986 (slot cache) |
| Measure Seshat (acceptance, planned-card pass rate, corrections, forecast) | Built | 8d2791f (`/api/metrics/pm`, Monte Carlo forecast) |
| Quantization versus scaffold isolation | **Needs hardware** | A Q6/Q8 worker does not fit next to anything on 24 GB. Planned first run on the 128 GB host, with the Q8_0 Researcher. |
| Mutation testing of tests | Not built (by design) | The Worker never writes the acceptance tests: they are protected (the permission engine denies edits), proven fail-to-pass per card, and the integrity gate (816e5e4) rejects skipped, focused or vacuous tests and suppressions. Mutation testing guards agent-written tests, which this flow does not accept. |
| Differential patch testing | Not built (by design) | It needs a human oracle patch per task, which user projects do not have. The fixtures' fail-to-pass proof covers the benchmark. |
| Temporal knowledge graph memory | Not built (by design) | The ledger is already time-stamped and append-only, and the Mem0 operations (520ae43) handle updates and contradictions. A graph store adds a dependency without a measured gain at this scale. |
| MLX-native MTP instead of llama.cpp | Not built (by design) | The target host is AMD on Linux (Vulkan/ROCm), where MLX does not run. |
| Local LoRA fine-tuning | Not built (by design) | Both reports: the data is too small and forgetting too costly. |

## 3. Papers the user asked to be read

| Paper | Take-away built | Commits |
|---|---|---|
| Dream-RSI (2609.14858) | Replay tuner over recorded trajectories; the policy is tuned, not the weights | 3bfe6e1 |
| AutoDev (2403.08299) | AI reviewer before the human; the Worker's `ask` | c8d843f, 777e5d9 |
| RSIAgent (2609.15364) | Learn the environment first: configuration constraints, plus the curriculum's module APIs | 610b77a, d0ff42d |
| SoL-Pi (2609.20519) | Delegated reading (outlines of large files); compaction and condensing already present | 01b6998 |
| Mem0 (2504.19413) | ADD/UPDATE/DELETE/NOOP consolidation of rules and profile | 520ae43 |
| ARIS (2605.03042) | Integrity gate against "plausible unsupported success"; cross-family reviewer role; rejected ideas kept on the ledger | 816e5e4, 8d2791f |
| The Complexity Trap (2508.21433) | Masking plus structured compaction for the Worker; hybrid summary for Seshat | 5fd3019, 2165493 |
| Apodex 1.1 (2608.23283) | The Researcher model: IQ3_M for this host, Q8_0 on the 128 GB host | 764deec, 5e74e60 |

## 3a. Requests of 2026-09-18/19: the research service and the harness units

| Request | Status | Commits | Proof (tests) |
|---|---|---|---|
| Research service seeded from Helga's, expanded to papers and the web, driven by Apodex | Built. Ported from Helga: pacing (documented limits), robots, cache, source weights, docs reader, coverage loop. Added: OpenAlex, citation snowballing, paper sections, Crawl4AI pages, private SearXNG, research memory | 52dd5c4, 91f79ab, 3c96a7d | apps/harness/tests/research_service.spec.ts |
| On the level of Claude's and Gemini's web tools | Built: domain and recency filters, focused page reads (BM25 chunks), search-and-read, a References contract | 91f79ab, aa44d29, a8ed030 | research_service.spec.ts, apodex_research.spec.ts |
| Tailored to Apodex in every way | Built from its vendor harness FrontierAgent (Apache-2.0): trained tool names, argument shapes and result formats, the extraction prompt, research, sub-agent and coordinator prompts, the Agent Team for deep research, repair of unverified citations, separate server slots for conversation and extraction | 91f79ab, 3c96a7d, aa44d29 | apodex_research.spec.ts |
| Crawl4AI built in | Built: a warm sidecar behind robots and pacing. Its attribution is in NOTICE and the CLI help | 91f79ab | research_service.spec.ts |
| Test it with a manager's tasks | Done, live on Apodex IQ3_M: a library choice, a technology comparison, published research, a security advisory, and a deep feature plan. After tonight's fixes: grounded, 0 unverified citations, confidence 0.6 and 1.0 on the first two, 5–6 min each | a8ed030, b51a958 | live batch /private/tmp/claude-501/mgr3.jsonl (not a repository file) |
| Rename the project manager to Seshat | Built | d9ae90a | apps/harness/tests/slash.spec.ts, packages/ui/tests |
| Harness units H1, H3, H8, H10–H16, H20–H26 | Built: daemon plus WebSocket; calibrate; replay and trajectory diff; MCP server and client; REST completeness; SDK; ACP; config.toml applied; slash commands; ntfy/Gotify push; overnight scheduler; OTel spans; compute governance; reproducibility record; init and installer. H26 is the M20 watchdog wired into the queue | e9e6804, 5661807, 90a6ec1, 73c3fd7, 3462f49, abcc16e, d8f4f6f, e591074, 87660a7, 2c7dc14, 2dbf355, e6fe612, cfa8e5c, ebcf082, 9d3ce0e | daemon_ws, calibrate_cmd, replay, mcp, mcp_client, rest_extra, sdk, acp, config_apply, slash, notify, overnight, tracing, repro, init (apps/harness/tests/*.spec.ts) |
| Research safety and knowledge tiers (X4, X5, X8, X9) | Built: llms.txt first, research on the ledger, untrusted wrapper for web content, cache lifetimes by kind | 95faa92 | research_service.spec.ts |

## 3b. Phase B (B0–B4.7, 2026-09-25 → 27): research recommendations built or left

One row per recommendation Phase B acted on; the spec named holds the detail and its State rows. *compliance C1–C6* is the compliance-fixes workstream (not yet committed when this was written). Every live measurement waits on model time and says so.

| Recommendation (source) | Status | Commits | Proof (tests) |
|---|---|---|---|
| The rest of the git hardening list and a `.git/config` preflight (WEB_RESEARCH group A; S1, S2) | Built; nested `.git` under bubblewrap (G2, Linux) still partial | b341663 | packages/sync/tests/git_preflight.spec.ts, git_hardening.spec.ts |
| Fail closed without a confinement mechanism; one egress policy through a hardened proxy (WEB_RESEARCH; S3, S3b) | Built | b341663, 525585e | packages/sandbox/tests/fail_closed.spec.ts, egress_hardening.spec.ts |
| Append-only Worker prompt for the prefix cache (WEB_RESEARCH, M8) | Partial: static blocks byte-stable; history as native messages and the 0.85 hit rate not built | 5b17ed1, 2d97d02 | packages/context/tests/worker_prompt_ctx3.spec.ts |
| MTP judged on seconds per step, ABBA with a sign test (WEB_RESEARCH; M7, M11) | Built; the per-host measurement waits on model time | 028b592, 0e30e61 | packages/models/tests/mtp_ab.spec.ts |
| Small-sample statistics: exact intervals, paired sign test, admission only on a significant paired gain (M12, T8) | Built; the live admission needs NEW-worker-loop-5's records | 028b592, df72861 | packages/eval/tests/stats.spec.ts, admission.spec.ts, packages/models/tests/qualification_sampling.spec.ts |
| Evidence-gated commit (ECLoop) as an A/B arm | Built behind `SEKHEMET_EVIDENCE_GATE`; the arm runs in B2.5 | df72861 | packages/loop/tests/evidence_gate.spec.ts |
| Tool-call format per model (Format Tax, R4) | Partial: arms scored and pinned only past `MIN_ARM_TRIALS` | 2d97d02 | packages/models/tests/tool_arm_n5.spec.ts |
| Mutation testing of tests (reverses §2's "not built": DESIGN_RESEARCH_TESTS_BROWNFIELD) | Built as test strength by depth profile | 160310d, eb6776f | packages/gates/tests/test_strength.spec.ts, mutation_scores.spec.ts |
| Characterization and red/green by change kind; an error baseline; superseded tests (DESIGN_RESEARCH_TESTS_BROWNFIELD) | Built; the `characterize`/`refactor`/`upgrade` values partial | eb6776f | packages/gates/tests/change_kinds.spec.ts, baseline.spec.ts; apps/harness/tests/regression_superseded.spec.ts |
| Project done computed from a requirement graph (PROJECT_DONE_AND_DEPTH, DEC-11) | Built | 2542716 | packages/kernel/tests/requirement_graph.spec.ts; apps/harness/tests/project_done.spec.ts |
| A depth profile with the ISO/IEC 25010 checklist and comparables (DEC-11, P14) | Partial | eedf2f5 | packages/planner/tests/depth_coverage.spec.ts |
| Project documents in the repository as MADR 4.0 records (DESIGN_RESEARCH_TEAMS_DATA_CHANGE) | Built; read with `marked` (DEC-44) | eedf2f5, compliance C1 | apps/harness/tests/project_docs.spec.ts, project_docs_markdown.spec.ts |
| SemVer's 0.y.z rule, through `semver` (DESIGN_RESEARCH_TEAMS_DATA_CHANGE decision 13) | Built | 2542716, compliance C1 | apps/harness/tests/release_version.spec.ts |
| One SPDX licence classifier shared with the licence gate (REUSE_SURVEY, DEC-08) | Built | 5e56b5d | packages/gates/tests/licence_classifier.spec.ts |
| BM25 ranking over name, description and keywords; deps.dev package health (REUSE_SURVEY, DEC-44) | Built; OpenSSF Scorecard and dependents counts left unused | compliance C3 | apps/harness/tests/reuse_ranking.spec.ts, reuse_deps_dev.spec.ts |
| gitleaks' own rule file for the offline history scan; `yaml` for CI files (DEC-43, DEC-44) | Built | compliance C2 | packages/gates/tests/gitleaks_vendored.spec.ts, gitleaks_rules.spec.ts; apps/harness/tests/ci_files.spec.ts |
| Smart Swap: a round-trip cost model, one `decide()`, a replay simulator (SMART_SWAP_RESEARCH_2026-09, DEC-45) | Built; calibration and the load-mode A/B wait on model time | 160310d | packages/models/tests/swap_decide.spec.ts, swap_sim.spec.ts |
| Weights identified by their GGUF header (DEC-44) | Built | 5019670 | packages/models/tests/model_scan.spec.ts |
| MCP on the official SDK (DEC-08) | Built | d3c1e08 | apps/harness/tests/mcp_sdk_server.spec.ts |
| Passkeys and OIDC for self-hosted sign-in (DESIGN_RESEARCH_COLLABORATION, DEC-38) | Built | 66d1276 | apps/harness/tests/team_sso.spec.ts |
| Accessibility checked with axe in Chromium (P12) | Built | 2920484 | apps/harness/tests/a11y.spec.ts |
| A story map and burn-up like the tools teams use (PROJECT_DONE_AND_DEPTH, P3) | Built | 4433b1a | packages/ui/tests/storymap.spec.ts, burnup.spec.ts |
| The professional vocabulary of Jira, Linear and GitHub (DEC-31) | Built on screen and in the CLI; model-facing prompts wait on a suite A/B | 3410f94, compliance C4 | packages/ui/tests/professional_language.spec.ts; apps/harness/tests/cli_language.spec.ts |
| Forecasts as 50% and 85% ranges, never one date (DESIGN_RESEARCH_COLLABORATION) | Built | 3410f94 | packages/ui/tests/status.spec.ts |
| A smaller Researcher by bake-off (Spark-X2.5-4B) | Partial: the golden set and runner built; the bake-off waits on model time | eedf2f5 | apps/harness/tests/research_bakeoff.spec.ts |
| A cross-family Reviewer judging each criterion (AutoDev, ARIS; P8) | Left: B4.8 | — | — |
| The senior-PM skill scored on scripted conversations; non-directive suggestions (DESIGN_RESEARCH_COLLABORATION; P6, NEW-planner-pm-9) | Left: B4.8 (suggestions with reasons partly built) | — | — |
| TruffleHog's live verification | Not built (by design): AGPL, and it sends secrets away (DEC-44) | — | — |

## 4. Known deviations

- **Commit trailers.** Feature commits carry Card, Agent-Model, Agent-Harness, Agent-Role and Co-authored-by, as CLAUDE.md specifies. `GateStatus` and `Step` appear on checkpoint commits only, as CLAUDE.md scopes them. DEFINITION_OF_DONE §6 lists `GateStatus` for every commit. The two documents disagree; this cycle followed CLAUDE.md.
- **Two commits went in with a failing test** (d0626e3, 5e74e60). Each was fixed in the next commit (b6eb636, 4be429b). Commits now gate on the test runner's exit code.

## Verification

Checked with `git cat-file -e <sha>` for every commit and `test -f` for every test file named above, at the time of writing. The final evaluation (Chronicle plus the Showcase Trifecta, one run on the finished build) follows this audit.
