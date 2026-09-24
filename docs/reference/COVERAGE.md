# Coverage: the Phase A review of every domain

*Phase A of [MODERNIZATION_PLAN.md](MODERNIZATION_PLAN.md), 2026-09-22, at commit `468f67f`. Sixteen domains plus brand and UX (17), reviewed read-only by independent reviewers against the plan's seven questions; synthesised and ranked by the lead. The full reviews, with file:line evidence, are in `reviews/`. Nothing below changes code until the owner has reviewed this programme — except defects that invalidate measurement or put the owner's machine at risk, which are fixed first and named as such.*

## The verdict in one paragraph

The core ideas hold — gates decide, the event log records, a card is the unit of work — and several surfaces are professional-grade (Review, Insights, the PM's reporting). But **the code does not yet keep the spine it claims**: the Worker's sandbox can be escaped through the worktree's git metadata; the human is not the rate limiter (the Review WIP limit computes to 7,708); the state machine and Accept can be bypassed, including by an MCP client; and one bad write can break the ledger for good. Separately, the Worker has been measured under prompts that contradict themselves, with a prompt cache that barely works. **No domain should be rewritten or cut wholesale**; almost every verdict is *refactor*. The order is: safety and the spine first, then measurement validity, then the product workstreams that carry the positioning, with structure improved as each is touched.

## Coverage matrix

| # | Domain | Verdict | The finding that matters most | Review |
| --- | --- | --- | --- | --- |
| 1 | Product surface | Refactor | No first run reaches a first card; three setup paths; `--version` runs setup; the CLI exits 0 on a thrown error | `reviews/domain01_16_surface_docs.md` |
| 2 | Kernel and lifecycle | Refactor | Transitions are checked against the caller's `fromStatus`; events are committed before projection, so one bad write breaks rebuild forever | `reviews/domain02_09_kernel_review.md` |
| 3 | Worker loop | Refactor | Stall fingerprint, data contract and re-check thinking *(fixed in `468f67f`)*; contradictory feedback; `executeTurnInner` complexity 119 | `reviews/domain03_worker_loop.md` |
| 4 | Context and prompts | Refactor | Prompts contradict themselves; ~25% noise; KV cache hit 0.29 (~18 s prefill per turn); drop `tool_search` for the Worker | `reviews/domain04_context.md` |
| 5 | Models and hardware | Refactor | MTP on by default, never measured; thinking can overrun the 16k window unseen; the project's own research rates the uncensored Worker "not recommended" | `reviews/domain05_10_models_measurement.md` |
| 6 | Gates and done | Refactor | Core sound; false positives around it (type imports as definitions, `export *`); built-in layers vanish on exception; vitest remedies select zero tests | `reviews/domain06_gates_dod.md` |
| 7 | Planner and PM | Refactor | PM reporting professional; the backlog is not (title-echo criteria, five bugs, two planners); non-developers cannot start a project | `reviews/domain07_planner_pm.md` |
| 8 | Design stage and research | Refactor | Keyword risk detection misfires; the reuse survey still recommends wrong packages; `plan` goes online ignoring offline mode | `reviews/domain08_design_research.md` |
| 9 | Review and decisions | Refactor / rebuild the Reviewer | Accept merges before the board agrees, runs `checkout main` in the user's working copy, hard-codes `GateStatus: pass`, cannot be undone | `reviews/domain02_09_kernel_review.md` |
| 10 | Measurement and learning | Refactor | Evidence records the fixture's commit as the harness commit; admission accepts a delta of 0; three runners whose numbers cannot be compared | `reviews/domain05_10_models_measurement.md` |
| 11 | Security | Refactor — **stop-ship items** | Three ways Worker code runs outside the sandbox (the `.git` pointer; the visual gate's dev server, with the full environment; confinement that fails open); egress around "network denied"; DNS rebinding on the dashboard; secrets can enter the unpurgeable ledger | `reviews/domain11_14_security_runtime.md` |
| 12 | Integrations | Refactor | Jira/Linear export-only (re-import duplicates); three GitHub paths, three ID formats; "company server" is not built | `reviews/domain12_15_integrations_ext.md` |
| 13 | Dashboard | Refactor | The professional column mapping exists only in the Jira export; card anatomy is internal; no story map, burn-up or Learn layer | `reviews/domain13_dashboard.md` |
| 14 | Runtime and operations | Refactor | `daemonStop` can kill a recycled pid; the runner lease is not atomic and `run` never takes it; kills miss grandchildren; crashed cards stay In Progress; logs grow without limit | `reviews/domain11_14_security_runtime.md` |
| 15 | Extensibility | Refactor | Hooks sound; repo-supplied hooks, MCP servers and plugins run with no trust prompt; plugins cannot add tools or gates | `reviews/domain12_15_integrations_ext.md` |
| 16 | The documents | Rebuild the design; cut the inventories | 18 document contradictions; the design's config schema is near the reverse of the code; `main` is 240 commits behind | `reviews/domain01_16_surface_docs.md` |
| 17 | Brand and UX | Refactor the shell; keep the design system | No navigation below 768px; a flat 14-item nav that loses its labels on a laptop split; every "start something" path ends at a terminal command; teaching only in hover tooltips; the gates strip unreadable at 14 gates; accent gold and warning amber share one hue | `reviews/domain17_brand_ux.md` |

## The programme

### Tier 0 — stop-ship: safety and the spine

No further model runs start until S1–S2 are fixed; nothing is offered to a user until all are.

| | Change | Why | Size |
| --- | --- | --- | --- |
| S1 ✅ | Harden every unconfined git call in a worktree (`core.fsmonitor`, `core.hooksPath`, refuse a non-standard gitdir) and deny sandbox writes to the `.git` pointer | Critical, verified: code outside the sandbox from a confused or injected Worker | S |
| S2 ◐ | Stop granting sandbox writes through the `node_modules` link (read-only mount, or a per-worktree install) | High, verified: a card can alter dependencies the user runs unconfined | S–M |
| S3 | One egress policy: loopback and ports refused by the proxy, host sockets closed on Linux, registry lookups proxied and on the ledger, the policy not taken from the repo's own `gates.toml` | High | M |
| S3a | **One confined execution path**: the visual gate's dev server, language servers, monorepo package gates and `--validate-tools` all run inside the sandbox with an allowlisted environment | Critical: today they run Worker-written code unconfined with API keys and tokens | M |
| S3b | **Fail closed**: no confinement mechanism on the host means no Worker commands, unless the user explicitly opts out | Critical: contradicts the design's "fails closed" | S |
| S3c | Dashboard: Host-header check, a real per-session mutation token, no framing, a CSP; redact secrets before they reach packs, the ledger or evidence; tokens not readable from the sandbox | Medium, but the ledger cannot be purged once a secret is in it | M |
| S4 | Transition law in the kernel: check the stored status, remove the same-status bypass, route the 11 direct writers through it, no `override` for the `mcp` actor | Spine: the model never certifies its own work | S–M |
| S5 | Safe, reversible Accept: board first, merge with plumbing (never the user's working copy), real `GateStatus`, reject / reopen / revert | Spine: the human decides; data safety | M–L |
| S6 | Review WIP from human decisions only, per project, with a floor | Spine: the human is the rate limiter (7,708 today) | S |
| S7 | One validated transaction per event: append and project together | Spine: the event log is the only durable channel | M |
| S8 | `plan` honours offline mode and the research setting, and logs its queries | The local-first promise | S |
| S9 | Workspace trust for repo-supplied hooks, `mcp.json` and plugins | Security | M |
| S10 | CLI exit codes and `--version` | Scripts must be able to trust the CLI | S |

**S1 done, S2 partly, in the Phase A commit** — reviewed independently (`reviews/security_fix_review.md`), which found four gaps, two now closed:
- Git runs with `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `safe.bareRepository=explicit` and `log.showSignature=false` pinned through `GIT_CONFIG_*` for the harness process and everything it spawns (`packages/sync/src/git_hardening.ts`); tests prove an fsmonitor and a nested bare repository are refused.
- Sandboxed writes to `.git` are denied at any depth and in any case, on macOS by Seatbelt regex and in the permission engine; `.git` is re-bound read-only under bubblewrap. A tool path that resolves into `.git` through a symlink is refused (G1).
- The dependency link is read-only, with the tool caches (`.vite`, `.cache`) the gates need kept writable.
- **Still open:** nested `.git` under bubblewrap for commands (G2 on Linux); the remaining git keys the research lists (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, `--no-ext-diff --no-textconv`, `core.symlinks=false`, `protocol.file.allow=never`, an absolute git path) and a preflight that refuses a `.git/config` carrying filters or drivers (G3); shared code-bearing caches (G4, a per-worktree `node_modules` of links).

### Tier 1 — measurement validity (before the remaining A/B arms and the scored run)

| | Change | Why | Size |
| --- | --- | --- | --- |
| M1 | Prompt coherence: remove the contradictions ("history cleared" beside the history; "no other tool exists"; double numbering; masked compaction) | The Worker has been measured under self-contradicting prompts | S |
| M2 | A fixed tool set per card class instead of `tool_search` (as an A/B) | Runs 3–5 losses; 5 of 9 searches were for tools already loaded | S–M |
| M3 | Separate prompt, thinking and answer budgets; read `finish_reason` | An "all thinking" turn can overrun 16k and look like a stall | S |
| M4 | Provenance: the real harness commit, build hash, settings and server identity on every card; refuse a foreign server | A result must say what produced it | S–M |
| M5 | Data contracts as their own high-priority prompt section | Today they sit in the section cut first | S |
| M6 | Gate feedback proven on real tool output (vitest JSON; repros that select the failing test); built-in gates never vanish on error | Wrong remedies and silent passes | S–M |
| M7 | Measure MTP per host and per thinking policy | On by default, never measured | S |
| M8 | **Make the Worker prompt append-only** (diagnosed by the research): byte-identical system prompt and tools; earlier tool output never edited; compaction rare and whole; `--checkpoint-min-step` ~512–1024; drop `--cache-reuse`; `preserve_thinking` if thinking stays on | On a hybrid-attention model one changed early byte forces a full prefill; ~60% of model time is prompt reading | M |

| M11 | MTP A/B on **seconds per turn**, with two draft tokens, watching Metal's working set | MTP speeds decode only (~1.1–1.3x on this MoE) and slows prefill, which dominates agent turns | S |
| M12 | Statistics that fit 14–30 tasks: paired arms, exact or Bayesian intervals, repeated runs, pass^k; claim only effects of ≥20 points | At 25 tasks a paired test has ~6–7% power to see a 10-point gain | S |
| M9 | The benchmark wrapper passes on only `generate`, so every `m0` benchmark attempt ran a different prompt and budget than production (`instrumentation.ts`) — one measurement path (added by the gap sweep) | S |
| M10 | The mutation step never runs the tests unmutated first, so a checkout whose tests cannot run scores 1.0 (added by the gap sweep) | S |


### Tier 2 — the product workstreams (the positioning)

| | Change | Size |
| --- | --- | --- |
| P1 | **One planner, model first**, used by the CLI and the PM; an acceptance-criterion contract (no title echoes; correct idempotency rules); the five planner bugs; red-first on planner cards | L |
| P2 | **Start a project by conversation**: a `start_project` tool for the PM, design questions as board decisions with defaults, card zero from the ecosystem's generator | L |
| P3 | **A professional board**: five familiar columns over the gate states, card anatomy (key, type, assignee, points, epic, blocker cause), then story map and burn-up | M |
| P4 | **The Learn layer**, off by default for experts | M |
| P5 | **A status view for non-developers** on data that already exists (standup, signals, burn-up, "needs you") | M |
| P6 | **The senior-PM skill**, versioned and scored on ~20 scripted conversations | M |
| P7 | **Reuse survey by capability**, with one SPDX licence classifier shared with the licence gate | M |
| P8 | **The Reviewer rebuilt** to the design: per-criterion findings, before Review and before auto-accept | M |
| P9 | **GitHub first** (one adapter, one ID, pagination, merge-aware), one notifier, then the company-server minimum | L |
| P11 | **The navigation** (first slice, one card): grouped and labelled, labels kept at laptop widths, a phone bottom bar (Status · Review · Board · PM), first-letter chords, no bare `t` | S |
| P12 | **Colour and contrast**: a warning hue apart from the accent gold, neutral disabled buttons, a ≥3:1 control border, no muted text that must be read; checked by axe and screenshots in CI | S |
| P13 | **Project done is computed, never claimed** (owner, 2026-09-22): a requirement graph from the brief, traceability both ways and no orphan cards, release slices from a walking skeleton, "proven" from tests and gates on `main`, appetite and a circuit breaker ([research](../research/PROJECT_DONE_AND_DEPTH.md)) | L |
| P14 | **Depth and coverage** (owner, 2026-09-22): a depth profile with an ISO/IEC 25010 checklist, comparable products classified by Kano, a user walkthrough, clarifying questions only where the answer changes the cards | M |
| P10 | **One first run** for all three audiences — including onboarding an existing team repository, where `onboard.ts` is today a fourth separate way of deriving gates and `--apply` overwrites a hand-tuned `gates.toml` (gap sweep) | M |

### Tier 3 — structure, as each workstream touches it

| | Change | Size |
| --- | --- | --- |
| T1 | One gate pipeline: every gate, built-in or project, runs through one path with one result shape | M |
| T2 | An AST-based source index replacing the eight regex parsers (exports, imports, symbols) | M |
| T3 | A verification controller and one stop-reason table shared by the loop, the runner and the evidence bundle | M |
| T4 | `index.ts` as a command registry, with `queue` in its own module (strangler, between suite runs) | L |
| T5 | The dashboard server's 1,045-line closure split by route group | M |
| T6 ✅ | The design rebuilt as `SPINE.md`, one specification per subsystem and a decisions log. *Process — no subsystem spec; done in design v3.* | L |
| T7 | Paired trials with statistics, and the planning measure | M |
| T8 | Self-improvement admits a change only on a significant paired gain | S |
| T9 | The DEFINITION_OF_DONE test gaps: missing negative tests, one vanity assertion, skips on Linux. *Process — no subsystem spec; carried by DEFINITION_OF_DONE §2 and workstream B5.* | S |
| T10 | Executable documentation checks: README ↔ the front door, config schema ↔ `config.ts`, the `SEKHEMET_*` inventory, model names ↔ registry, `file:` links, spec front matter ↔ the SPINE status table | M |
| T11 | **Evaluation assets** the acceptance criteria depend on, built before the criteria that use them: the labelled reuse set (~40 needs, P7), the research golden set (25 questions, NEW-design-stage-2), golden briefs with annotated implicit requirements (≥ 10, P14 and T7), a held-out acceptance suite for premature completion (T7), seeded defects for the Reviewer (≥ 20, P8), scripted PM conversations with a rubric (~20, P6), scripted non-developer project starts (5, P2), injection fixtures (NEW-security-4), reference solutions per fixture card (T7), and a labelled set of UI screens for the visual checklist (GT-N4-2). Owned by measurement; each asset is versioned and hashed like the frozen suite | L |


### Changes added by the specifications (2026-09-22)

The design v3 specifications found gaps the Phase A programme had no ID for. Each keeps the ID its spec gave it; the spec holds its acceptance criteria, and the workstream column says where [MODERNIZATION_PLAN.md](MODERNIZATION_PLAN.md) builds it.

| ID | Change | Spec | Workstream |
| --- | --- | --- | --- |
| NEW-context-1 | One token estimator calibrated to the model | [context](../design/specs/context.md) | B2.1 |
| NEW-context-2 | Budgets asserted on the live path | [context](../design/specs/context.md) | B2.1 |
| NEW-context-3 | One allocator for every role | [context](../design/specs/context.md) | B4.0a |
| NEW-context-4 | Rules that are scoped exactly, kept once, and credited fairly | [context](../design/specs/context.md) | B4.0a |
| NEW-context-5 | The repo map's weighting and cache, and condensing savings | [context](../design/specs/context.md) | B4.0a |
| NEW-context-6 | The context version gates qualification; prompt changes are measured | [context](../design/specs/context.md) | B4.0a |
| NEW-dashboard-1 | Evidence that stays readable | [dashboard](../design/specs/dashboard.md) | B4.2 |
| NEW-dashboard-2 | A web layer under test, with one vocabulary | [dashboard](../design/specs/dashboard.md) | B4.2 |
| NEW-dashboard-3 | The model's output, live, on the Steps tab | [dashboard](../design/specs/dashboard.md) | B4.6 |
| NEW-dashboard-4 | Settings | [dashboard](../design/specs/dashboard.md) | B4.2 |
| NEW-dashboard-5 | Review for a team, and review that forces a look | [dashboard](../design/specs/dashboard.md) | B4.6 |
| NEW-design-stage-5 | The Researcher asked early, with the card in hand | [design-stage](../design/specs/design-stage.md) | B4.4 |
| NEW-design-stage-1 | Design-stage judgement | [design-stage](../design/specs/design-stage.md) | B4.4 |
| NEW-design-stage-2 | Research that can be verified and does not park wrongly | [design-stage](../design/specs/design-stage.md) | B4.4 |
| NEW-design-stage-3 | Project documents in the repository, generated from the ledger | [design-stage](../design/specs/design-stage.md) | B4.4 |
| NEW-design-stage-4 | Deep research that says how hard it looked | [design-stage](../design/specs/design-stage.md) | B4.4 |
| NEW-extensibility-1 | Board-lifecycle hooks | [extensibility](../design/specs/extensibility.md) | B3.3 |
| NEW-extensibility-2 | Hooks that fail visibly | [extensibility](../design/specs/extensibility.md) | B3.3 |
| NEW-extensibility-3 | MCP on the official SDK | [extensibility](../design/specs/extensibility.md) | B3.3 |
| NEW-extensibility-4 | Skills in the Agent Skills format | [extensibility](../design/specs/extensibility.md) | B3.3 |
| NEW-gates-1 | Unenforced invariants shown to a person | [gates](../design/specs/gates.md) | B2.3 |
| NEW-gates-2 | Judge only what the card wrote | [gates](../design/specs/gates.md) | B2.3 |
| NEW-gates-3 | Gate economics and flaky tests | [gates](../design/specs/gates.md) | B2.3 |
| NEW-gates-4 | The visual layer to its design | [gates](../design/specs/gates.md) | B2.3 |
| NEW-gates-5 | The gates the old design listed: templates, the claim gate, bundled static-analysis rules | [gates](../design/specs/gates.md) | B4.0b |
| NEW-gates-6 | Tests that can fail, checked before the build | [gates](../design/specs/gates.md) | B4.0b |
| NEW-gates-7 | Gates for existing codebases | [gates](../design/specs/gates.md) | B4.0b |
| NEW-gates-8 | The change kind and the test-strength record on the card | [gates](../design/specs/gates.md) | B4.0b |
| NEW-integrations-1 | Idempotent import | [integrations](../design/specs/integrations.md) | B4.9 |
| NEW-integrations-2 | Owner and delegate on every tracker | [integrations](../design/specs/integrations.md) | B4.9 |
| NEW-integrations-3 | External results name their source | [integrations](../design/specs/integrations.md) | B4.9 |
| NEW-kernel-1 | Hash chain v3 | [kernel](../design/specs/kernel.md) | B3.1 |
| NEW-kernel-2 | A `principal` column on events | [kernel](../design/specs/kernel.md) | B3.1 |
| NEW-kernel-3 | Held as a typed field | [kernel](../design/specs/kernel.md) | B3.1 |
| NEW-kernel-4 | Numbered migrations and one column table | [kernel](../design/specs/kernel.md) | B3.1 |
| NEW-kernel-5 | The lifecycle's missing conditions | [kernel](../design/specs/kernel.md) | B3.1 |
| NEW-kernel-6 | Who is on a card, and who built each attempt | [kernel](../design/specs/kernel.md) | B3.1 |
| NEW-kernel-7 | An erasable ledger | [kernel](../design/specs/kernel.md) | B3.1 |
| NEW-kernel-8 | Requirement versions and gate-result sources in the record | [kernel](../design/specs/kernel.md) | B3.1 |
| NEW-kernel-9 | The stored `kind`, `change` and `split` fields (DEC-26) | [kernel](../design/specs/kernel.md) | B3.1 |
| NEW-measurement-1 | Self-describing, isolated runs | [measurement](../design/specs/measurement.md) | B2.4 |
| NEW-measurement-2 | Diagnostics on real inputs | [measurement](../design/specs/measurement.md) | B2.4 |
| NEW-measurement-3 | Adoptions per phase | [measurement](../design/specs/measurement.md) | B2.4 |
| NEW-measurement-4 | Test strength and human-built work in the measures | [measurement](../design/specs/measurement.md) | B2.4 |
| NEW-models-1 | Calibrate the reference host and correct its tier | [models](../design/specs/models.md) | B4.0a |
| NEW-models-2 | Floors and the watchdog on every path | [models](../design/specs/models.md) | B4.0a |
| NEW-models-3 | Declared hours and swap batching | [models](../design/specs/models.md) | B4.0a |
| NEW-models-4 | One profile, one role enum, one construction path, a live registry | [models](../design/specs/models.md) | B4.0a |
| NEW-models-5 | Tool-arm qualification | [models](../design/specs/models.md) | B4.0a |
| NEW-models-6 | Competence rows that can improve routing | [models](../design/specs/models.md) | B4.0a |
| NEW-models-7 | Weights that a new user can obtain | [models](../design/specs/models.md) | B2.2 |
| NEW-models-8 | Engines as adapters, qualified per combination | [models](../design/specs/models.md) | B2.2 |
| NEW-models-9 | One scheduler owns residency | [models](../design/specs/models.md) | B4.0a |
| NEW-models-10 | Adopting a model is a measured decision | [models](../design/specs/models.md) | B4.0a |
| NEW-models-11 | The Spark-X2.5-4B Researcher bake-off | [models](../design/specs/models.md) | B4.4 |
| NEW-planner-pm-1 | Points on the board | [planner-pm](../design/specs/planner-pm.md) | B4.3 |
| NEW-planner-pm-2 | Signals propose, never mutate | [planner-pm](../design/specs/planner-pm.md) | B4.3 |
| NEW-planner-pm-3 | Split to the measured horizon | [planner-pm](../design/specs/planner-pm.md) | B4.3 |
| NEW-planner-pm-4 | The goal loop re-evaluates on the right events | [planner-pm](../design/specs/planner-pm.md) | B4.3 |
| NEW-planner-pm-5 | Every signal response is carried out, as a proposal where a person owns the field | [planner-pm](../design/specs/planner-pm.md) | B4.3 |
| NEW-planner-pm-6 | Planning on existing codebases | [planner-pm](../design/specs/planner-pm.md) | B4.3 |
| NEW-planner-pm-7 | Test approval and strength by depth profile | [planner-pm](../design/specs/planner-pm.md) | B4.3 |
| NEW-review-git-1 | A rebase conflict goes back to the Worker as typed failures | [review-git](../design/specs/review-git.md) | B3.2 |
| NEW-review-git-2 | Restacked children re-run their gates | [review-git](../design/specs/review-git.md) | B3.2 |
| NEW-review-git-3 | Per-package gates in card verification | [review-git](../design/specs/review-git.md) | B4.0b |
| NEW-review-git-4 | Versions follow SemVer's 0.y.z rule, per slice | [review-git](../design/specs/review-git.md) | B4.3 |
| NEW-review-git-5 | Review for a team: who may accept, who should look | [review-git](../design/specs/review-git.md) | B3.2 |
| NEW-runtime-1 | One supervisor, an atomic lease | [runtime](../design/specs/runtime.md) | B3.3 |
| NEW-runtime-2 | Kills that reach every descendant | [runtime](../design/specs/runtime.md) | B3.3 |
| NEW-runtime-3 | Crash recovery and bounded rounds | [runtime](../design/specs/runtime.md) | B3.3 |
| NEW-runtime-4 | Bounded disk | [runtime](../design/specs/runtime.md) | B3.3 |
| NEW-runtime-5 | The night does what it promises | [runtime](../design/specs/runtime.md) | B3.3 |
| NEW-runtime-6 | One scheduler, fair across people, per-slot leases | [runtime](../design/specs/runtime.md) | B4.10 |
| NEW-runtime-7 | Every budget the spec names is enforced | [runtime](../design/specs/runtime.md) | B4.10 |
| NEW-runtime-8 | Backup, restore, export and upgrades that lose nothing | [runtime](../design/specs/runtime.md) | B3.1 |
| NEW-runtime-9 | Telemetry as specified | [runtime](../design/specs/runtime.md) | B3.3 |
| NEW-runtime-10 | Pause a project | [runtime](../design/specs/runtime.md) | B3.3 |
| NEW-security-1 | Flag files that execute later | [security](../design/specs/security.md) | B1 |
| NEW-security-2 | The air-gap self-test checks at the proxy | [security](../design/specs/security.md) | B1 |
| NEW-security-3 | Small hardening items | [security](../design/specs/security.md) | B1 |
| NEW-security-4 | Injection fixtures run against the real Worker | [security](../design/specs/security.md) | B1 |
| NEW-security-5 | Documentation and skills that match the air-gapped project | [security](../design/specs/security.md) | B1 |
| NEW-security-6 | An Ask that a person really answers | [security](../design/specs/security.md) | B1 |
| NEW-security-7 | Erase a secret the scanner missed | [security](../design/specs/security.md) | B3.1 |
| NEW-surface-1 | One user directory | [surface](../design/specs/surface.md) | B3.3 |
| NEW-surface-2 | A terminal board in the board's words | [surface](../design/specs/surface.md) | B3.3 |
| NEW-surface-3 | The card layer of the configuration is real or removed | [surface](../design/specs/surface.md) | B3.3 |
| NEW-surface-4 | One install path per audience | [surface](../design/specs/surface.md) | B4.1 |
| NEW-surface-5 | One recorded run profile | [surface](../design/specs/surface.md) | B3.3 |
| NEW-worker-loop-1 | Repetition refusals that survive alternation and truncation | [worker-loop](../design/specs/worker-loop.md) | B2.1 |
| NEW-worker-loop-2 | The ladder's dead fields | [worker-loop](../design/specs/worker-loop.md) | B2.1 |
| NEW-worker-loop-3 | Remove the session's dead direct-tool API | [worker-loop](../design/specs/worker-loop.md) | B2.1 |
| NEW-worker-loop-4 | `ask` that can wait for a person without stopping the Worker | [worker-loop](../design/specs/worker-loop.md) | B4.0a |
| NEW-worker-loop-5 | One attempt record, a grounded re-plan, and equal repair chances | [worker-loop](../design/specs/worker-loop.md) | B4.0a |
| NEW-worker-loop-6 | Mechanical edits as tools | [worker-loop](../design/specs/worker-loop.md) | B4.0a |
| NEW-worker-loop-7 | Language servers as bounded tenants, reached through LSP | [worker-loop](../design/specs/worker-loop.md) | B4.0a |
| NEW-worker-loop-8 | MCP tools without their prefill cost | [worker-loop](../design/specs/worker-loop.md) | B4.0a |
| NEW-worker-loop-9 | Evidence-gated commit behind `SEKHEMET_EVIDENCE_GATE` (ECLoop), built for the B2.5 A/B | [worker-loop](../design/specs/worker-loop.md) | B2.1 |

## Decisions only the owner can make

**Decided by the owner on 2026-09-22** (records in [DECISIONS.md](../design/DECISIONS.md)): D1 keep Cyber-Tiel (DEC-04); D2 merge — done, `main` at `fb59ba2` (DEC-10); D3 as recommended (DEC-05); D4 as recommended (DEC-09); D5 as recommended — SPDX parsing and the official API clients approved, the rest still proposals (DEC-08); D6 after local v1 meets the Definition of Done (DEC-07); D7 as recommended (DEC-06). The sequence to v1 is in [MODERNIZATION_PLAN.md](MODERNIZATION_PLAN.md), Phase B.

| | Decision (→ outcome) | Recommendation at the time |
| --- | --- | --- |
| D1 → **keep Cyber-Tiel** (DEC-04) | **The Worker's weights.** The project's own research rates the uncensored Cyber-Tiel "not recommended" and names Tiel-Coder-35B-A3B-MTP (guardrailed, same size) as a drop-in — a ~13.6 GB download. The web research adds: Cyber-Tiel is an abliterated re-quantization of Ornith-1.5 (not Qwen3.6); its own card says it is "not an ordinary coding agent" and requires OS sandboxing; its published lead over Tiel (13.7 vs 12 of 25) is far too small a sample to mean anything, and no published score was measured at IQ3 | Decide before the A/B completes, so its result belongs to the weights we keep. With the sandbox findings above, the guardrailed model is the safer default |
| D2 → **merged** (DEC-10) | **Merge this branch to `main`** (240 commits behind; a fresh clone gets the stale CLAUDE.md) | Yes, as a reviewed pull request, after Tier 0's S1–S2 |
| D3 → **as recommended** (DEC-05) | **The positioning contradictions**: the locked decisions still say "solo developer" and ban personas | Reword the ban: agents never role-play ceremonies *with each other*; standups and retros are reports *for people* |
| D4 → **as recommended**; `container.ts` returned to the owner (DEC-09, O4) | **Cuts** (below) | Approve the dead-code cuts; decide wire-or-cut for the rest |
| D5 → **SPDX and official clients approved** (DEC-08) | **Library proposals** (below) | Approve the licence classifier and official API clients first |
| D6 → **after local v1** (DEC-07) | **A ceiling run** with a frontier model as Worker (measurement only) | Worth it once Tier 1 is done |
| D7 → **as recommended** (DEC-06) | **Company-server scope for v1** (bind host, identity, accept role) | Scope it for v1: the positioning names it |

### Cuts needing sign-off

| Code | Why | Proposed |
| --- | --- | --- |
| `packages/ui/src/canvas.ts` | Reachable only from a test | Cut |
| `container.ts` (kernel/sandbox) | Reachable only from a test | Cut |
| `retention.ts` | ~~Unused~~ — wired: `queue` prunes on start (`execute.ts:195`); found by the platform spec pass | Keep; retention becomes a recorded erasure after owner decision O1 |
| `apps/harness/src/research/desk.ts`; `adjudicate` / `acceptRevision` in `claims.ts` | Reachable only from tests | Wire in or cut |
| `buildFullPromptPack`, `engine.ts` (context) | Dead | Cut |
| The three `FEATURE_INVENTORY*.md` files | Superseded; the docs index forbids keeping versions side by side | Cut (git keeps them) |

### Library and tool proposals

Reported by the reviewers; **licences and maintenance to be verified before any is added, and nothing is added without the owner's yes.**

| Proposal | Licence (reported) | Would replace or add |
| --- | --- | --- |
| `spdx-expression-parse`, `spdx-satisfies`, `spdx-correct` | MIT / Apache-2.0 | The hand-rolled licence check that rejects MIT-0, Zlib and "MIT AND …" |
| deps.dev and OpenSSF Scorecard APIs | (services) | Package health for the reuse survey |
| `@mozilla/readability`, `linkedom`, `turndown` | Apache-2.0, ISC, MIT | Page-to-text for research |
| `repomix` | MIT | Repository digests for research |
| `uv` | MIT / Apache-2.0 | New Python projects (card zero) |
| `web-tree-sitter`, `@ast-grep/napi` | MIT | A repo map beyond TS/JS; structural search |
| `promptfoo`; GEPA (later) | MIT | Prompt evaluation; prompt optimisation |
| Zod or Valibot | MIT | Event-payload validation |
| Octokit, `@modelcontextprotocol/sdk`, `jira.js`, `@linear/sdk`, Slack Bolt | MIT / Apache-2.0 (to verify) | Official clients instead of hand-rolled ones |
| `oauth2-proxy` | MIT | Identity for the company-server mode |
| Inspect AI, `llama-bench`, `statsmodels`, mini-swe-agent, Terminal-Bench | MIT / BSD-3 / Apache-2.0 (to verify) | Evaluation, throughput and statistics |
| Node's `util.parseArgs`, `@clack/prompts`, `execa`; Vale, MADR | built-in / MIT / MIT | CLI parsing and prompts; docs linting; decision records |
| Tiel-Coder-35B-A3B-MTP weights | (model card) | See D1 |
| Inter and JetBrains Mono, vendored WOFF2 | SIL OFL 1.1 | The same type on every OS, offline |
| `@floating-ui/dom` | MIT | Accessible popovers for the Learn layer instead of `title=` tooltips |
| Lucide icons (optional; the pylon mark stays) | ISC | Consistent navigation and action icons |
| Playwright | Apache-2.0 | Screenshot regression at 400/1100/1440 in both themes |
| `axe-core`, `@axe-core/playwright` | **MPL-2.0, weak copyleft** — dev-only, unmodified | An accessibility gate: no serious violations |
| `@adobe/leonardo-contrast-colors` | Apache-2.0 | Palette hues generated to a target contrast |
| `bayes_evals` (Bowyer et al.) | to verify | Bayesian intervals for small-sample pass rates (M12) |
| Commit0 lite, ProjDevBench | to verify | Candidates for the planning measure; both run locally |
| Backlog.md (reference, not a dependency) | MIT | The closest local-first card anatomy; its definition-of-done checklist is worth borrowing |

## Research behind the programme

Four web-research digests ([WEB_RESEARCH_2026-09.md](../research/WEB_RESEARCH_2026-09.md)) changed four things above: M8 is now a known fix rather than a diagnosis; M11 and M12 are new; S1's remaining hardening list comes from the same flaw class found in Cursor, Claude Code, Copilot CLI and others; and the positioning's edge is **local, gated and teaching**, because Linear's agent already lets non-developers chat with a PM.

## The baseline so far

Thinking off, build `468f67f`, Cyber-Tiel IQ3_XXS with MTP, chronicle and onyx: **10 of 14 passed, all first try**, 53 minutes, 453k tokens. The four failures: two `oscillation_detected` after a type error whose remedy was shown (`chron_ledger` TS2375, `onyx_4_vault` TS2339); one blocked by the first; and `onyx_8_e2e`, which ran its full 20 minutes against the empty vault left by `onyx_4` — the runner's dependency check missed a spec that names its imports as `"./vault.js"`, now fixed. This is the "before prompt fixes" arm; M1, M3 and M8 come before the others.

## What was fixed during Phase A, and why it could not wait

- **`468f67f`** — the stall fingerprint, the data contract's placement and surgical thinking after a failed re-check: each would have invalidated the thinking A/B.
- **The Phase A commit** — S1 and most of S2 (above): Worker code could otherwise run outside the sandbox on the owner's machine during the remaining A/B arms.
- **Corrections to the record** — Phase 0's "GO at 100%" (11/11 establishes ≥76% at 95% confidence, not ≥90%), and the claims table's "Runs on your server — Built" (it is partial).
