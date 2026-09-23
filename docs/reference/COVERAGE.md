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

*Added by the gap sweep:* **M9** — the benchmark wrapper passes on only `generate`, so every `m0` benchmark attempt ran a different prompt and budget than production (`instrumentation.ts`); **M10** — the mutation step never runs the tests unmutated first, so a checkout whose tests cannot run scores 1.0.

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
| P10 | **One first run** for all three audiences — including onboarding an existing team repository, where `onboard.ts` is today a fourth separate way of deriving gates and `--apply` overwrites a hand-tuned `gates.toml` (gap sweep) | M |

### Tier 3 — structure, as each workstream touches it

One gate pipeline and an AST-based source index (replacing eight regex parsers); a verification controller and one stop-reason table; `index.ts` as a command registry with `queue` in its own module; the dashboard server's 1,045-line closure split; the design rebuilt as a ~300-line spine plus one specification per subsystem and a decisions folder; paired trials with statistics, and the planning measure; self-improvement admitted only on a significant gain; the DEFINITION_OF_DONE test gaps (negative tests, one vanity assertion, skips on Linux).

## Decisions only the owner can make

| | Decision | Recommendation |
| --- | --- | --- |
| D1 | **The Worker's weights.** The project's own research rates the uncensored Cyber-Tiel "not recommended" and names Tiel-Coder-35B-A3B-MTP (guardrailed, same size) as a drop-in — a ~13.6 GB download. The web research adds: Cyber-Tiel is an abliterated re-quantization of Ornith-1.5 (not Qwen3.6); its own card says it is "not an ordinary coding agent" and requires OS sandboxing; its published lead over Tiel (13.7 vs 12 of 25) is far too small a sample to mean anything, and no published score was measured at IQ3 | Decide before the A/B completes, so its result belongs to the weights we keep. With the sandbox findings above, the guardrailed model is the safer default |
| D2 | **Merge this branch to `main`** (240 commits behind; a fresh clone gets the stale CLAUDE.md) | Yes, as a reviewed pull request, after Tier 0's S1–S2 |
| D3 | **The positioning contradictions**: the locked decisions still say "solo developer" and ban personas | Reword the ban: agents never role-play ceremonies *with each other*; standups and retros are reports *for people* |
| D4 | **Cuts** (below) | Approve the dead-code cuts; decide wire-or-cut for the rest |
| D5 | **Library proposals** (below) | Approve the licence classifier and official API clients first |
| D6 | **A ceiling run** with a frontier model as Worker (measurement only) | Worth it once Tier 1 is done |
| D7 | **Company-server scope for v1** (bind host, identity, accept role) | Scope it for v1: the positioning names it |

### Cuts needing sign-off

| Code | Why | Proposed |
| --- | --- | --- |
| `packages/ui/src/canvas.ts` | Reachable only from a test | Cut |
| `container.ts` (kernel/sandbox) | Reachable only from a test | Cut |
| `retention.ts` | Unused | Wire in or cut |
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
