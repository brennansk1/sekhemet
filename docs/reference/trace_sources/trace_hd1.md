# Raw trace: HARNESS_DESIGN.md lines 1–1800

*Row data written by the tracing agent on 2026-09-22 (the old text is at `fb59ba2`), restored from its transcript after the session scratch directory was lost. Statuses are as first traced, before the fix passes; the verified final status of every row is in [DESIGN_TRACE.md](../DESIGN_TRACE.md).*

| HD:17 | Mission: spec → diff surviving checks nobody could edit; records enough that next attempt is cheaper | carried | SPINE §What Sekhemet is, spine 1–2 |
| HD:19 | A card owns one worktree, branch, declared scope, deterministic context, budget, attempt, evidence bundle, measured outcome; no session | carried | SPINE spine 3; kernel §2 |
| HD:19 | Same card + same repo → byte-identical prompt (prefix cache + honest measurement) | carried | context §2.1 rule 1; CX-1 |
| HD:21 | Event log is the only durable channel; model-visible means logged, enforced at runtime | carried | SPINE spine 2; kernel rule 15 |
| HD:21 | Board, replay, fork, audit trail, competence model are projections of the one stream | carried | SPINE spine 2; kernel rule 13 |
| HD:23 | Every column boundary is an entry condition decided by an executable gate, never the model | carried | SPINE spine 1; kernel rule 21 |
| HD:23 | Failure → one typed shape; top few reach the model, rest in evidence by reference | carried | gates rules 19–20 |
| HD:25 | Human is the rate limiter: review minutes → Review WIP → back-pressures Verify → Worker | carried | SPINE spine 4; review-git §2.2 |
| HD:27 | Learning only from recorded signals; spent only in the stable prompt zone at a card boundary | carried | SPINE consequence 1; context rule 23 |
| HD:27 | Imported prior never admitted as a change; only sets a starting value the first local signal overrules | carried | measurement rule 22 |
| HD:29 | Feature not traceable to the six paragraphs is a candidate for deletion | carried-weaker | SPINE §Where the edge is: test is now "serves local/gates/teaching edge", not the six-paragraph machine; the "ten loops→one, research no privileges, doc embedding index removed" precedents only implicitly kept (measurement §2, design-stage §2.7, DEC-22) |
| HD:35 | Locked: 100% local inference in v1 | carried | DEC-03; SPINE Locked |
| HD:36 | Locked: target user = solo developer running local models | contradicted | DEC-01 supersedes: "coding harness for professional teams" (deliberate, owner) |
| HD:37 | Locked: hardware 16–128 GB self-calibrating | carried | SPINE Locked; models §2 rule 8 |
| HD:38 | Locked: four roles as registry entries, never agents/personas; swapped small, co-loaded large | carried | SPINE §Roles; models rules 21–22; DEC-05 |
| HD:39 | Locked: fresh context per card; no long-running session | carried | SPINE Locked; runtime rule 1 |
| HD:40 | Locked: done = executable gates only; agent never certifies own work | carried | SPINE Locked ("gates and a person's acceptance") |
| HD:41 | Locked: offline by default; git remotes and GitHub sync opt-in adapters | carried | SPINE Locked; security rule 29 |
| HD:42 | Locked: TypeScript throughout v1 | carried | SPINE Locked; DEC-20 |
| HD:43 | Rejected on evidence: Scrum-role agents, parallel same-file writers, self-refine, debate, unbounded best-of-N, embedding RAG, large windows, persona prompting, continuous-embedding compression | carried | DEC-22 (all nine present) |
| HD:51 | Substitution: bubblewrap on Linux instead of Landlock+seccomp; isolation level recorded per card | carried | DEC-21; security rules 8, 17 |
| HD:52 | Substitution: plain git worktrees instead of copy-on-write clones | carried | DEC-21; security 24a |
| HD:53 | Substitution: keyword heuristic pruner; SWE-Pruner deferred behind random-dropping null baseline, else row removed | carried | DEC-21; context Later; measurement rule 16, MS-T7-6 |
| HD:54 | Substitution: source installer instead of packaged offline installers | carried | DEC-21; security rule 45 |
| HD:56 | Python/Rust/Go degrade to flat map + unchecked parse, stated on card and evidence; functional gate templates kept | carried | DEC-20; surface rule 30, SUR-33 |
| HD:56 | Tree-sitter symbol-level support is v2 | later | context Later; worker-loop Later; DEC-20 |
| HD:56 | Harness may do less for a language but never claim to have checked | carried | SPINE consequence 2 |
| HD:60 | Non-goals v1: teams, multi-user boards, RBAC, SSO | contradicted | DEC-06 puts company-server mode (identity, Accept role) in v1; RBAC beyond Accept and SSO beyond proxy stay out (deliberate) |
| HD:60 | Non-goals v1: compliance pack; Azure DevOps connector | carried-weaker | SPINE "Not in v1" omits both explicitly; compliance only as a claim not to make; Azure DevOps not mentioned anywhere |
| HD:60 | Non-goals v1: Jira/Linear connectors | carried | SPINE Not in v1 (live two-way sync); integrations rule 19 (export/import only) |
| HD:60 | Non-goals v1: multi-machine inference pooling, any cloud model path | carried | SPINE Not in v1; models Later |
| HD:68 | Voice: plain, exact, calm; never "done" for "I think so"; verbs and numbers; no exclamation; name the gate | carried | SPINE §Voice |
| HD:72 | Naming: Workspace, Project/Card/Subtask, Gates, Evidence, Playbook, four roles, Inbox | carried | NAMING.md (referenced); dashboard §nav (Inbox merged into Review › Needs you) |
| HD:112 | Claims table: machine built / server partial (127.0.0.1 only, writer = "human", gate host certs localhost) | carried | SPINE claims table (server "not built"); DEC-06; integrations |
| HD:113 | Claim: whole process built with gaps (Worker method, story map, burn-up) | carried | SPINE claims; dashboard P3 |
| HD:114 | Claim: fits PM practice partial (Jira/Linear CSV, GitHub JSON export, Slack; no live sync; no familiar card anatomy) | carried | SPINE claims; integrations rule 17; dashboard P3 |
| HD:115 | Claim: teaching beginners not built; Learn layer planned | gap | dashboard Learn layer (P4/P5 family) |
| HD:116 | Claim: non-devs talk to PM partial; start-by-conversation not built | gap | planner-pm P2; design-stage P2 |
| HD:117 | Claim: choose each role's model, managed llama-server or any Ollama tag | carried | models rules 14, 26; MD-N4-3 |
| HD:118 | Claim: frozen suite and bake-off built; SWE-rebench not integrated | carried | SPINE claims; measurement Later (SWE-rebench mining) |
| HD:119 | Claim: cloud models after v1, plug into a role, never a requirement | later | DEC-03; models Later |
| HD:123 | Pillar 1: zero telemetry, offline-capable install | carried | runtime rules 31, RUN-33; security air-gap |
| HD:124 | Pillar 2: automatic model selection, scheduled swaps, overnight mode | carried | models rules 20, 26; runtime rule 17 |
| HD:125 | Pillar 3: tolerant tool interface, symbol edits, parse gate, assembled context, fresh per card, planner/Worker cascade | carried | models rule 28 (arm B); worker-loop rules 12, 14; context §2 |
| HD:126 | Pillar 4: nested boards, decomposition to competence envelope, dependency scheduling, token/time accounting, WIP tied to review | carried | planner-pm §2.4–2.6; kernel rules 3, 23 |
| HD:127 | Pillar 5: per-column gates with status rollup and evidence bundle | carried | kernel rules 21, 24; gates rule 35 |
| HD:128 | Pillar 6: git-native, GitHub and Forgejo sync, AGENTS.md/CLAUDE.md, MCP and ACP, existing CI as gate source | carried | integrations; surface rules 5.3, 9; extensibility |
| HD:132 | Structural advantage: compute accounting (tokens, time) | carried | runtime rules 18, 32; planner-pm §2.6 |
| HD:136 | Claims not to make: frontier parity on ambiguous work, guaranteed correctness, unmeasured benchmarks, nonexistent compliance | carried | SPINE §Never claim |
| HD:140 | Simplicity bar = Claude Code (one command, conversation, permission prompt, unread project file) | carried | surface §1 |
| HD:146 | Six day-one concepts: card, accept/send back, gates, evidence, model pair, repository | carried | surface rule 1 ("the models" replaces "model pair") |
| HD:150 | Gates derived from project scripts, seen but not written on day one | carried | surface rules 1, 5.3 |
| HD:155 | Everything else exported to the user is a defect until defaulted or progressive | carried | surface rule 2 |
| HD:159 | First run: resolve profile, derive gates, verify model files, print one paragraph, one confirmation, open board | carried | surface rule 5, SUR-2/3 (gap P10) |
| HD:163 | First-run text names "14 GB to fetch" and `--models-dir` | carried | surface rule 5 example |
| HD:168 | No file written by the user before the first card; config/gates/hooks/mcp/skills/tiers/rosters/stop reasons exist, none encountered | carried | surface rule 8 |
| HD:174 | Four verdicts per surface item: Day one, Default, Progressive (trigger named; empty view hidden), Developer (`dev` namespace) | carried | surface rule 2 |
| HD:181 | Eight front-door commands; research question is not a command | carried | surface rules 13, 15 |
| HD:185 | `sekhemet` opens board (first run sets up) | carried | surface rule 13 table |
| HD:186 | `sekhemet "<spec>"` plans and runs in one verb | carried | surface rule 13 |
| HD:187 | `sekhemet run [card]` absorbs queue/run/resume | carried | surface rule 13 |
| HD:188 | `sekhemet review` opens next card waiting on a person | carried | surface rule 13 |
| HD:189 | `accept`, `send-back <card> "<reason>"`, `park`/`unpark` | carried | surface rule 13; review-git §2.4 |
| HD:190 | `sekhemet board` the board in the terminal | carried | surface rule 13 (`--terminal` for text) |
| HD:191 | `sekhemet doctor` checks install incl. weights exist | carried | surface rule 13; models rule 5 |
| HD:192 | `sekhemet dev <x>`; listed only by `dev --help` | carried | surface rule 13 |
| HD:194 | New user-facing command must displace one | carried | surface rule 14 |
| HD:194 | A `--profile`-style flag rewriting other flags is an unchosen default | carried | surface rule 14 |
| HD:194 | Every destructive action reachable from UI is reachable from CLI with its undo | carried | surface rule 14; review-git §2.4 |
| HD:196 | Moved means unlisted, not removed (calls without `dev` still run) | carried | surface rule 13, SUR-31 |
| HD:200 | Single non-command word refused with suggestion (`reveiw`→`review`) | carried | surface rule 15 (edit distance 2), SUR-28 |
| HD:201 | `run` with no card runs the queue; with a card runs or resumes it | carried | surface rule 13 |
| HD:202 | `review` shows oldest Review card, gates, diff size, three deciding commands | carried | surface rule 13 |
| HD:202 | send-back reason required; becomes next attempt's instruction and playbook candidate; shares implementation with board buttons | carried | surface rule 16; review-git §2.4 |
| HD:204 | One list of commands feeds parser and dispatcher (six unrouted handlers incl. `overnight` found) | carried | surface rule 17, T4 |
| HD:208 | A wrong default fails loudly, naming the file to edit | carried | surface rule 3, SUR-12 |
| HD:210 | A parsed config key must be read, else deleted from schema | carried | surface rule 4, SUR-21 |
| HD:214 | Parity claim: matches top five except cloud scale and cloud latency | carried-weaker | Competitor columns deliberately dropped (specs/README); the parity *claim* itself is not restated anywhere — fine, but note it is no longer a claim |
| HD:220 | Primary interface: board-native nested kanban; CLI/TUI secondary | carried | SPINE; surface Later (TUI later); dashboard §1 |
| HD:221 | Inference: llama.cpp / MLX, zero telemetry | contradicted | models rule 14 says "an MLX path is available on Apple Silicon"; context Later and extensibility tool table say MLX is a later adapter — new docs disagree |
| HD:222 | Core architecture: Cordis-inspired TS kernel + SQLite WAL event log | carried | kernel; PROVENANCE techniques |
| HD:223 | Tools: symbol-scoped AST tools + LSP + RTK sandboxed bash | carried | worker-loop rule 12 (TS language service); context rule 17 |
| HD:224 | Permissions: 3-tier Allow/Ask/Deny + OS sandbox + scope write confinement | carried | security rules 4–17, 25 |
| HD:225 | Hooks: 10-point waterfall across loop, gate, sync events | carried | extensibility rule 4 |
| HD:226 | Skills: open Agent Skills (`SKILL.md`) + tiered rules + doctor diagnostics | carried | extensibility rules 10–17 |
| HD:227 | MCP: dual client and server (boards, cards, gates, evidence exposed) | carried | extensibility rules 18–24 |
| HD:228 | Session: fresh deterministic context per card; replay, fork, rewind from SQLite WAL | carried | runtime rules 1, 11–14 |
| HD:229 | Subagents: nested board DAG + SPIDR + branch-and-return isolation | carried | planner-pm §2.7.9; context rule 18 |
| HD:230 | Context: AST repo map + RTK (60–90%) + SWE-Pruner Pro (40–60%) + masking | carried-weaker | RTK carried (context rule 17; R2 threshold ≥60%); pruner deferred (DEC-21); the 60–90% / 40–60% figures survive only as register thresholds, not claims |
| HD:231 | Git: per-card worktrees, checkpoint commits, squash-on-accept Conventional Commits, stacked branches, difftastic | carried | review-git §2.5–2.6 |
| HD:232 | DoD: Static, Functional, Robustness, Security, Visual, Hygiene; agent never certifies | carried | gates rule 3 |
| HD:233 | Hardware self-calibration S/M/L/XL + memory pressure watchdog with dynamic throttling | carried | models rules 7–9, 19 |
| HD:234 | Air-gap kit with local package mirrors (npm, devpi, crates) + byte-identical prompt caching | carried-weaker | security rules 45–50 (lockfile allowlist mirror); devpi/crates mirror services moved to security Later |
| HD:244 | `read` line-numbered 1-based, byte-budgeted | carried | worker-loop rule 12 (start/end; outline over 200 lines) |
| HD:244 | `edit` exact replacement with uniqueness constraint | carried | worker-loop rule 12 |
| HD:244 | `grep` over ripgrep with three modes (files, content, counts) | carried-weaker | worker-loop rule 12 `grep_search` "capped, gitignore-aware"; three output modes lost — "files and counts" is only an A/B candidate (rule 29) |
| HD:244 | `glob` mtime-sorted | carried-weaker | `find_files` capped and gitignore-aware; mtime ordering not stated anywhere |
| HD:244 | `run` sandboxed bash with RTK condensing | carried | worker-loop rule 12 `run_cmd`; context rule 17 |
| HD:244 | AST tools `replace_symbol_body`, `insert_after_symbol`, `read_symbol`, `find_references` backed by an LSP client pool | carried | worker-loop rule 12 (TS language service; adds `go_to_definition`) |
| HD:244 | Search and fetch tools segregated to research cards | carried | worker-loop rule 12; design-stage §2.7.10, v1 acceptance |
| HD:252 | Three-tier permission model, Deny always wins | carried | security rule 25 |
| HD:252 | OS sandbox macOS Seatbelt; Linux namespaces + Landlock + seccomp | carried | security rules 9–17 (bubblewrap per DEC-21; Landlock/seccomp hardening) |
| HD:252 | Writes outside `filesTouched` denied | carried | worker-loop rule 14; security rule 25 |
| HD:252 | gates.toml, gate tests, loop control, sandbox configs permanently denied without human override | carried | security rule 25; gates rules 2, 7 |
| HD:252 | Untrusted content tagged; triggers elevated restrictions | carried | security rule 42 |
| HD:260 | Ten hook events: card/start, pre-step, pre-tool, post-tool, pre-gate, post-gate, card/end, review/return, playbook/propose, turn-stopping | carried | extensibility rule 4 |
| HD:260 | Hooks run outside the sandbox with user privileges (formatters, lint fixers, notifications) | carried | extensibility §2 table; rule 6 adds fail-closed for pre-* events |
| HD:268 | Skills under `.sekhemet/skills/<name>/` with SKILL.md, scripts, references, regression evals | carried | extensibility rule 10 |
| HD:268 | Manifest lines budgeted into Zone 2; full instructions load only when card class matches triggers | carried | extensibility rules 11–12, 14; context rule 8 |
| HD:268 | Doctor benchmarks each skill on held-out tasks, prunes context-bloat rules | carried | extensibility rule 16; measurement rule 24 |
| HD:277 | MCP client: servers declared in `config.toml`; discovered tools budgeted and exposed to planner and Worker | carried | extensibility rules 22–23 (declared in `mcp.json`; Worker only via `worker_tools`) |
| HD:278 | MCP server exposes workspace, boards, cards, gates, evidence bundles, model registry to IDEs/CLI/CI | carried | extensibility rule 18 (evidence and registry read-only: NEW-extensibility-3 gap) |
| HD:286 | Append-only SHA-256 hash-chained event log | carried | kernel rules 7–10 |
| HD:287 | Resume: reconstruct board state, restore worktree to last checkpoint, resume | carried | runtime rule 10 |
| HD:288 | Fork at step N with modified model route, prompt version or budget | carried | runtime rule 13, RUN-27 |
| HD:289 | Rewind: reset worktree to step N checkpoint, record event, invalidate later gate passes | carried | runtime rule 12; kernel rule 26, K-S7-8 |
| HD:290 | Replay against pinned configurations for A/B | carried | runtime rule 14 |
| HD:291 | Headless CLI `sekhemet run <card>` | carried | surface rule 18; extensibility rule 27 |
| HD:291 | TypeScript SDK with async-iterator event streams | carried-weaker | extensibility rule 28: "If it ships (open question 1)" — now conditional |
| HD:299 | Nested board is the subagent system; subtasks inherit project context, isolated sub-context, return structured summary + evidence id | carried | planner-pm §2.7.9; context rule 18 |
| HD:307 | Context: Aider AST repo map + PageRank | carried | context rule 13 |
| HD:307 | Headless LSP expansion stage | contradicted | context rule 28: "No LSP expansion as an assembly stage (the language service backs tools instead)" — deliberate |
| HD:307 | Masking tool outputs older than 2 steps with 15-token pointers | contradicted | context rule 3: five most recent never masked outside pressure; pressure may reduce to two; masking in batches every k turns (M8, deliberate) |
| HD:315 | Per-card worktrees with copy-on-write cloning | later | review-git Later; DEC-21 |
| HD:315 | Checkpoint commits on every passing step | contradicted | review-git §2.6.3: every 5 steps when files changed and before Verify; runtime rule 11: after every gate-passing step and every masking boundary — the two new specs disagree with each other |
| HD:315 | Squash-on-accept into Conventional Commits | carried | review-git §2.5.4 |
| HD:315 | Stacked branches for decomposed feature chains | carried | review-git §2.6.2, §2.5.5 |
| HD:315 | Structural diffs (difftastic) | carried | review-git §2.6.6 (partial, S5); gates Later for the bundle field |
| HD:315 | Opt-in GitHub App adapter managing the PR lifecycle | carried | integrations rule 10; review-git §2.5.7 (gap P9/S5) |
| HD:323 | Gates run on an isolated gate host | carried | gates rule 11 (separate host when configured, else local sandbox; T1 gap) |
| HD:324 | Static: in-memory AST parse, `tsc --noEmit`, linter | carried | gates rule 3; worker-loop rule 14 |
| HD:325 | Functional: unit, integration, acceptance tests that must fail before implementation | carried | gates rules 3, 5–6 |
| HD:326 | Robustness: diff-scoped mutation (Stryker / cargo-mutants) | carried | gates rule 32 (own diff-scoped step; PROVENANCE) |
| HD:327 | Security: gitleaks, existence/slopsquatting checks, osv-scanner | carried | gates rules 3, 15; security rule 44; GT-10 |
| HD:328 | Visual: Playwright DOM assertions, layout bounding boxes, pixelmatch element screenshots, axe-core | carried-weaker | gates rule 29 carries console, layout, screenshot, a11y; **DOM assertions** are not in the gate's behaviour (only in extensibility's tool list); library choice is gates OQ1 |
| HD:329 | EvidenceBundle with difftastic enabling "5-second human acceptance" | contradicted | review-git §2.1.2: "a decision in under a minute"; structural diff is Later in the bundle (claim softened, deliberate?) |
| HD:335 | Omitted: cloud routing and fallback (data leakage, hides competence limits) | carried | DEC-03; models rule 1 ("never a silent fallback") |
| HD:336 | Omitted: continuous conversational accumulation (context rot) | carried | runtime rationale "Why no sessions"; DEC-23 |
| HD:337 | Omitted: lossy model summarization of context | carried | context rule 28 |
| HD:338 | Omitted: multi-agent debate | carried | DEC-22 |
| HD:339 | Omitted: simulated Scrum role agents | carried | DEC-22, DEC-05 |
| HD:340 | Omitted: parallel agents writing same files; overlapping siblings serialized | carried | DEC-22; kernel rule 4 |
| HD:341 | Omitted: embedding RAG as code context | carried | DEC-22; context rule 28 |
| HD:347 | Rewind from card view: "rewind to step N", truncates nothing, invalidates later gate pass | later | dashboard Later (card view); CLI built (runtime rule 12) |
| HD:348 | Dynamic tool loading: deferred tools by name, `tool_search` loads schema into volatile zone | carried | worker-loop rule 11 and M2 A/B; worker-loop OQ2, context OQ2 (append as message, never edit tools array) |
| HD:348 | MCP servers with many tools usable without prefill cost | carried-weaker | only as worker-loop OQ2 recommendation (keep `tool_search` for non-Worker roles above ~10 tools) |
| HD:349 | External review cards on PRs not created by the harness; never edits; findings as evidence / review comments | carried | review-git §2.7; integrations rule 13 |
| HD:350 | Scheduled (cron) and triggered (webhook, file change, dependency release) recurring cards cloned from template; declared hours unless urgent | carried | runtime rule 21 |
| HD:351 | Agent-driven browser `browse` (navigate, a11y tree, click, type, screenshot); reads free, writes need URL allowlist; screenshots to evidence | carried | security rule 42a; worker-loop rule 12 |
| HD:352 | IDE extension (VS Code over ACP) and TUI | later | SPINE Not in v1; surface Later; dashboard Later |
| HD:353 | Implementation previews: 2–3 approach previews in decision requests | carried | planner-pm §2.10.2 (previewSketch) |
| HD:354 | Skill and playbook diagnostics (net gain, prune bloat) | carried | measurement rule 24; extensibility rule 16 |
| HD:355 | Memory watchdog: disable speculative decoding, shed observation caches, throttle parallel worktrees at 85–90% | carried-weaker | see row for HD:1491–1493 (90% stage lost in models; runtime rule 22 still cites 85–90%) |
| HD:356 | Restricted mode: no `run`, read-only AST inspection, static gates only | carried | worker-loop rule 13; security rule 43 |
| HD:358 | Still deferred: plugin marketplace | later | extensibility Later |
| HD:358 | Still deferred: remote control from mobile beyond notifications | later | integrations Later; dashboard Later |
| HD:358 | Still deferred: team chat entry points | later | integrations Later |
| HD:362 | Every capability is a plugin claiming a service key (Cordis) | contradicted | extensibility rule 29: no plugin API in v1, `container.ts` cut (DEC-09); packages replace service keys (SPINE §How the parts fit) — deliberate |
| HD:366 | Invariant: model-visible means logged, runtime assertion enforces it | carried-weaker | SPINE spine 2 states it; no spec has a criterion or contract naming the runtime assertion (kernel rule 15 covers durability, not the assertion) |
| HD:370 | Service keys ctx.events … ctx.sync and what each owns | carried | SPINE package table (renamed to packages) |
| HD:387 | Processes: board UI, core host, inference host, gate runner (Linux sandbox), SQLite store; same machine on single box | carried | SPINE §How the parts fit |
| HD:398 | Step = one model request + tool calls; turn = steps for one card attempt | contradicted | worker-loop rule 5 uses "turn" for one model call and "sample/attempt" for the whole; terminology inverted (not flagged anywhere) |
| HD:398 | Turn-flow events: card/start, step/start, context/assembled, model/request, model/response, tool/call, tool/result, step/end, gate/run, gate/result, card/end | carried-weaker | kernel Contract defers to `RUN_EVENTS` in `records.ts`; none of these event names is stated in any new doc |
| HD:400 | Waterfall extension points: pre-step (inject checkpoints/questions), pre/post-tool (permissions, parse gate, secret scan), turn-stopping (stall, budget) | carried | extensibility rules 4–6 |
| HD:402 | Plugin isolation and third-party versioning deferred past v1 | later | OPEN_QUESTIONS design Q5; extensibility Later |
| HD:406 | Four-level hierarchy capped; deeper nesting rejected at creation | carried | kernel rule 1, K-3 |
| HD:412 | Workspace: id, name, machine profile, active project cap (default 3) | carried | kernel rule 2 |
| HD:413 | Project: repo path, gate contract, conventions ref, stage, playbook ref | carried-weaker | kernel rule 6 defers to `ProjectRecord`; fields not stated in any doc |
| HD:414 | Card key fields (parent, spec, criteria, state, difficulty, budgets, actuals, route, deps, evidence ref) | carried | kernel rule 6 (`CardRecord`); planner-pm §2.1.5 |
| HD:416 | ContextPack: id, card ref, sections, token counts, prefix hash | carried-weaker | kernel rule 15 (content-addressed blob); fields only in code |
| HD:417 | EvidenceBundle entity fields | carried | gates rule 35 |
| HD:418 | Attempt: model, quant, step budget, stop reason, cost | carried | kernel rule 6 (`AttemptRecord`); gates rule 35 settings |
| HD:419 | GateResult: name, status, typed failures, duration, artifacts | carried | gates Contract (`GateResult`) |
| HD:420 | Goal sits above projects | carried | planner-pm §2.11 |
| HD:433 | Card difficulty 1..10, planner-assigned | carried | planner-pm §2.4 Estimable; K-S7-1 |
| HD:434 | Card budget and actuals: steps, tokens, seconds | carried | planner-pm §2.1.5; worker-loop rule 21 |
| HD:444 | Card route: planner and worker model ids | carried | planner-pm §2.1.5 ("routing") |
| HD:448 | dependsOn DAG, cycle-checked on write | carried | kernel rule 3 |
| HD:449 | filesTouched declared scope; writes outside fail the card | carried | worker-loop rules 14, 16 (typed refusal; `scope_violation`) |
| HD:452 | externalRef {system github/forgejo, id, url} | carried | integrations rule 8 (adds jira, linear) |
| HD:463 | Eligible only when every dependency done; overlapping siblings serialized | carried | kernel rules 3–4 |
| HD:467 | SQLite WAL, single writer | carried | kernel rule 27 |
| HD:467 | Hash chain over (seq, ts, actor, type, cardId, payloadHash, prevHash) — one definition | carried | kernel rule 8 (one formula in code; timestamp coverage is NEW-kernel-1 gap) |
| HD:467 | Board state is a projection, rebuildable | carried | kernel rule 13 |
| HD:467 | Context packs and evidence on disk under `.sekhemet/`, referenced by hash | carried | kernel rule 15 |
| HD:469 | Retention: packs and raw observations pruned 30 days after close; evidence, final diff, gate pass events kept forever | carried | runtime rule 33 |
| HD:473 | Columns are states; each transition has an entry gate | carried | kernel rules 17, 21 |
| HD:473 | UI offers an explicit override (drag past a gate) recorded as a human decision | carried-weaker | kernel rule 22 (API/`override:` reason); dashboard rule 5 forbids drag between columns and specifies no override control in the UI |
| HD:477 | Nine states, one name each across storage, column, error, docs | carried | kernel rule 17 |
| HD:481 | State table: backlog, ready, planning, in_progress, verify, review, done, parked, rejected with meanings | carried | kernel rule 17 |
| HD:491 | Working/Checking/Closed retired | carried | kernel OQ1 (NAMING.md still conflicts; recommendation to fix) |
| HD:493 | parked→ready and rejected→ready reachable from CLI | carried | kernel rule 19, K-S4-7 (gap S4/S5) |
| HD:498 | Edge Backlog→Ready (deps met, context fits) | carried | kernel rule 21 table |
| HD:499 | Edge Ready→Planning (planner claims); Planning→InProgress (plan + criteria approved) | carried-weaker | only in `LEGAL_TRANSITIONS` code; planner-pm §2.4 says INVEST runs "from Planning to Ready" — the new flow direction is not stated in prose |
| HD:503 | Edge Verify→Planning on gate fail (replan) | carried-weaker | code table only; not stated in kernel prose |
| HD:505 | Edge Review→InProgress on human change request | contradicted | review-git §2.4 / resolved drift: send back goes to Ready (deliberate) |
| HD:507 | Edge InProgress→Parked on stall or budget | carried | code table; worker-loop rule 34.4 |
| HD:516 | Ready entry: deps done; context pack assembles within budget; criteria present | carried | kernel rule 21; context rule 10, CX-N2-2 |
| HD:517 | Planning entry: planner model available; difficulty scored | missing | kernel rule 21 table has no Planning-specific condition |
| HD:518 | InProgress entry: plan exists; acceptance tests written and failing (types-only card red on typecheck); scope declared | carried-weaker | scope (kernel 21), red-first (gates rule 6, GT-8); "plan exists" is not an entry condition anywhere |
| HD:519 | Verify entry: Worker stopped with recorded stop reason | carried | kernel rule 21, K-S4-6 (gap S4) |
| HD:520 | Review entry: every required gate passed; evidence complete | carried | kernel rule 21; gates rule 9 |
| HD:521 | Done entry: human acceptance recorded | carried | kernel rule 21 |
| HD:522 | Parked entry: stall, budget exhaustion, capability ceiling | carried-weaker | no stated entry condition for Parked; reached by stop reasons (worker-loop rule 31 `parks`) |
| HD:523 | Rejected: closed unmerged; reopen → Ready | carried | review-git §2.4 |
| HD:527 | Rollup: parent done only if all children done AND parent integration gate passes on merged result | carried | kernel rule 24, K-7 |
| HD:527 | Project status is rollup of top-level cards | carried-weaker | not restated in the new docs |
| HD:531 | Regression protection: evidence snapshotted at Review; revision must re-pass every gate | carried | kernel rule 25 |
| HD:531 | A revision regressing a previously passing gate is rejected; card returns to Planning with the regression named | carried-weaker | kernel rule 25 only says revisions re-pass every gate; the return-to-Planning-with-named-regression rule and the snapshot are not stated (code comment in board_service only) |
| HD:538 | ReviewWIP = floor(reviewMinutesPerDay / medianReviewMinutesPerCard) | carried | review-git §2.2.1 |
| HD:541 | When Review full, no card may enter Verify | carried | kernel rule 23; review-git §2.2.4 |
| HD:545 | Context assembled deterministically per card, never accumulated | carried | context rule 1 |
| HD:549 | Repo map: tag extraction, file graph, personalized PageRank seeded to scope, binary-search fit | carried | context rule 13 (TS compiler, not Tree-sitter; budget 1,200) |
| HD:549 | Aider edge-weight multipliers: mentioned and well-named identifiers up, in-scope files highest | carried-weaker | context rule 13 says only "seeded on the card's scope"; identifier weighting not stated |
| HD:549 | Repo map cached by path and mtime plus content hash | carried-weaker | context rule 13: "cached by paths, sizes and mtimes" — content hash dropped |
| HD:550 | LSP expansion stage, headless servers pooled per project | contradicted | context rule 28 (no LSP stage); language servers only in onboarding (surface rule 9) |
| HD:551 | Line-level pruning with SWE-Pruner on gate host | later | context Later; DEC-21 |
| HD:551 | [BENCH] pruner CPU latency on 4-core host | later | OPEN_QUESTIONS #8 (deferred with pruner) |
| HD:552 | Budget fit to tier working budget, below window | carried | context rule 10 |
| HD:558 | Four-zone prompt layout and stability | carried | context rule 8 (Zone 3 now per attempt incl. spec; Zone 4 per turn) |
| HD:563 | Zone 4 = card spec, criteria, scope, open TODOs, latest observation, re-injected goal | contradicted | context rule 8 / CX-M8-6: full spec and criteria move into cached Zone 3; tail holds counter, unmet criteria, latest observation, one next action (deliberate, M8) |
| HD:565 | Zone 2 versioned, updated only between cards | carried | context rules 8, 24; CX-5 |
| HD:569 | Masked pointer example (~15 tokens with EvidenceRef) | carried | context rule 3 (`recall(ref)`) |
| HD:569 | Full observations remain in log/disk, retrievable by reference | carried | context rules 3, 17 |
| HD:569 | Goal and open TODOs re-injected at tail every step | carried | context rule 8 |
| HD:573 | `run` routes commands through the RTK binary | carried-weaker | context rule 17: native reimplementation; PROVENANCE says binary optional behind `run` — no spec states when the binary is used |
| HD:574 | RTK four strategies: filtering, grouping, truncation, deduplication | carried | context rule 17 |
| HD:579 | RTK tracks savings statistics | missing | no condensing-savings metric in context §2.29 or runtime metrics |
| HD:579 | read/grep/glob native condensing; lossless for repair data; raw output saved to evidence | carried | context rule 17, CX-3 |
| HD:581 | [BENCH] condensing reduction on real command mix, dropped strings | carried | OPEN_QUESTIONS #13 |
| HD:585 | Subtask branching: child seeded from parent zones 1–2 + own scope; returns summary + evidence ref | carried | context rule 18, CX-4 |
| HD:590 | llama.cpp: `--cache-ram` 8–16 GiB, `--ctx-checkpoints 32`, `--checkpoint-min-step 8192` | contradicted | context rule 6: 2,048/6 at ≤32 GB, 4,096/8 at ≤64 GB, 8,192/16 above; min-step 512–1,024 (deliberate, research group A) |
| HD:590 | Slot prefix similarity `-sps` | missing | not mentioned in context or models |
| HD:590 | `cache_prompt: true` on every request | carried | context rule 6 |
| HD:591 | Zero silent cache invalidation; volatile data banned from prefix | carried | context rule 5 |
| HD:592 | MLX path: unified memory reuse, MTPLX native MTP heads | later | context Later |
| HD:593 | Prefix-cache hit rate recorded per step; <85% on tool-result steps is a defect | carried | context rule 7 (median over turns after first) |
| HD:593 | Low hit rate alerts the operator | carried-weaker | context rule 7: "reported in the run's evidence" — no alert |
| HD:599 | Planner declares scope by bounded search before Ready, outside Worker budget | carried | context rule 22 (gap P1) |
| HD:601 | Step 1: identifiers looked up in symbol table | carried | context rule 22, CX-P1-1 |
| HD:602 | Step 2: lexical search ranked defs>refs, source>tests>generated | carried | context rule 22, CX-P1-4 |
| HD:603 | Step 3: one-hop graph expansion | carried | context rule 22, CX-P1-3 |
| HD:604 | Step 4: cap 12 tool calls and one Planner turn; else decision request asking which files | carried | context rule 22, CX-P1-2 |
| HD:606 | filesTouched is a declaration: may read outside, may not write outside | carried | context rule 22 |
| HD:606 | [BENCH] scope precision/recall vs human-named files decides the cap | missing | not in OPEN_QUESTIONS or context OQ; CX-P1-3 records provenance per file but no precision/recall measure |
| HD:616 | Decompose to fit with headroom; unfittable card is a planning failure | carried | planner-pm §2.4 Small; context rule 10 |
| HD:619 | Learned line pruning (SWE-Pruner Pro) | later | context Later |
| HD:620 | Zone caps: Z1 ≤0.12W, Z2 ≤0.10W, Z3 ≤0.50W, Z4 remainder ≥0.20W; shrink map, drop symbols, fail Ready | carried | context rule 10 (identical numbers) |
| HD:626 | Observation masking: older than last two replaced in place | contradicted | context rule 3 (last five; batch masking) — see HD:307 |
| HD:627 | Graduated pressure 70/80/85/90%; 95% ends step `budget_exhausted` | carried | context rule 12, CX-2 |
| HD:628 | Goal re-injection at tail (lost-in-the-middle) | carried | context rule 8 |
| HD:629 | Placement: immutable front, task end, nothing important mid-block | carried | context rule 9 |
| HD:630 | Typed failures, not logs | carried | context rule 16 |
| HD:631 | Reasoning traces stripped between steps unless model registered as benefiting | contradicted | context rule 4 / CX-M8-5: earlier thinking preserved (`preserve_thinking`); stripping only at a masking point (deliberate, M8) |
| HD:637 | Branch and return | carried | context rule 18 |
| HD:638 | Fresh context on rungs 2 and 3 | carried | context rule 19 |
| HD:639 | Stall detection ends turn before context fills | carried | worker-loop rules 17–18 |
| HD:640 | Step budgets by class as a ceiling on generated context | carried | worker-loop rule 21 |
| HD:644 | No model-written trajectory summaries | carried | context rule 28 |
| HD:645 | No embedding compression of code | carried | context rule 28; DEC-22 |
| HD:646 | No large windows; larger tier buys co-residency and parallel cards | carried | context rule 28; models rule 8 |
| HD:650 | Measurement per step (zone tokens, masked count, hit rate) and per card (peak, steps to first pass, pass vs pack size); competence model lowers budgets | carried | context rule 29 |
| HD:656 | Target envelope: 3B-active MoE or ~30B class with 16k–32k working context, bounded verifiable cards | carried | models rules 2, 8 |
| HD:682 | Localization stage 1: tag queries + PageRank rank symbols | carried | context rule 13 |
| HD:683 | Localization stage 2: LSP expands defs/refs/signatures for declared scope | contradicted | context rule 28 (no LSP stage); data contracts section partly replaces it (context rule 14) |
| HD:688 | Edit sketch from Planner: target AST symbols, preconditions, invariant contracts, diff sketch without boilerplate | carried-weaker | planner-pm §2.1.7/§2.5 say difficulty 4–7 "gets an edit sketch"; its contents are never defined; ladder's `requireSketch` is a dead field (NEW-worker-loop-2) |
| HD:689 | Worker applies sketch mechanically via symbol replacement | carried-weaker | worker-loop rule 28: plan/sketch "reaches the Worker as guidance" — no mechanism specified |
| HD:692 | Format tax: grammar constraints degrade small-model reasoning 15–30% | carried | models rule 28; DEC-22 |
| HD:693 | Constraints help on terminal payloads, hurt on reasoning and selection | carried | models rule 28 |
| HD:695 | Tri-arm A/B/C qualified per model; winner pinned [BENCH] | carried | models rule 28, NEW-models-5; OPEN_QUESTIONS #1 |
| HD:700 | 0.6B skimmer strips 40–60% of code lines | later | context Later (pruner) |
| HD:701 | Observation masking older than 2 steps | contradicted | see HD:307 |
| HD:706 | Symbol replacements cannot match twice, no offset arithmetic, whitespace-immune | carried | worker-loop rule 12 |
| HD:707 | Every edit passes in-memory parse gate before disk; syntax errors abort without burning steps | carried | worker-loop rule 14, WL-3 |
| HD:711 | Ban ungrounded self-reflection loops | carried | worker-loop rule 3; DEC-22 |
| HD:712 | Parallel pass@k on L/XL or overnight; k ∈ [2,4], T ∈ [0.4,0.7] | carried-weaker | worker-loop rule 37: k 1–4, temps 0.4–0.7, but **sequential**; parallel samples in worker-loop Later; tier/overnight gating not stated |
| HD:713 | Each sample verified in isolated ephemeral worktree; first to pass selected | carried | worker-loop rule 37 |
| HD:719 | GateFailure example with location/expected/actual/minimalRepro | carried | gates rule 19 |
| HD:721 | Only top 3 topologically ordered failures reach the model | carried | gates rule 20 |
| HD:722 | 4-rung ladder enforces fresh context | carried | worker-loop rule 34 |
| HD:726 | Exemplar source: accepted cards **and fixing commits from repo's own git history** | carried-weaker | context rule 25: accepted cards of same class only; fixing commits feed only synthesized tasks |
| HD:727 | 1–2 accepted trajectories of same class into Zone 2 | carried | context rules 8, 25 (as diff hunks) |
| HD:731 | Up to 40% of tool-call failures from template bugs | carried-weaker | rationale for template pinning kept (models rule 12); statistic not carried (fine as narrative) |
| HD:732 | Vendor-exact Jinja templates SHA-256 pinned; change invalidates qualification | carried | models rule 12, MD-2 |
| HD:733 | KV 8-bit; 4-bit prohibited for tool-calling models | carried | models rule 10, MD-1 |
| HD:734 | 2026 cache flags (8–16 GiB, 32 checkpoints, 8192 min-step, -sps) | contradicted | see HD:590 |
| HD:735 | Native MTP 1.6×–2.6× decode speed-up | contradicted | models rule 13 and evidence: MTP off until measured; ~1.28× decode with prefill penalty (deliberate, claim withdrawn) |
| HD:735 | Draft-model speculative decoding (`-md`) qualified per machine | missing | models rule 13 covers only MTP; draft-model path absent |
| HD:739 | SPIDR sizing: scope 1–3 files, <200 lines diff | carried | gates rule 12; planner-pm §2.1.4 |
| HD:740 | Sandbox blocks writes outside scope | carried | worker-loop rule 14 |
| HD:747 | Worker: single writer, one card at a time | carried | worker-loop rule 4 |
| HD:751 | Tool arm chosen per model by measurement; registry records winner | carried | models rule 28 |
| HD:755 | Tool set flat, no nested objects or unions | carried-weaker | worker-loop rule 11 (native schemas) — "flat, no nested objects/unions" constraint not stated |
| HD:756 | `read` line-numbered byte-budgeted | carried | worker-loop rule 12 |
| HD:757 | `read_symbol`, `find_references` | carried | worker-loop rule 12 |
| HD:758 | `replace_symbol_body`, `insert_after_symbol` | carried | worker-loop rule 12 |
| HD:759 | `edit` fallback with uniqueness | carried | worker-loop rule 12 |
| HD:760 | `run` sandboxed with RTK | carried | worker-loop rule 12 |
| HD:761 | `docs` version-pinned documentation across knowledge tiers | carried | worker-loop rule 12 |
| HD:762 | `deps_source` installed dependency source at resolved version | carried | worker-loop rule 12 (`dependencies`) |
| HD:763 | `repo`: tree, file at a ref, code search, releases between two versions | carried-weaker | worker-loop rule 12 lists `git_history` (repository history); design-stage §2.7.10 still calls the Worker tools `docs, deps_source, repo, ask` — names disagree and "releases between two versions" for the Worker is not stated |
| HD:764 | `ask` non-blocking question answered at a later step boundary | contradicted | worker-loop rule 12 says `ask` posts a non-blocking decision request answered at a later turn; design-stage Later says "in v1 the Worker's `ask` answers from its card's contract" — the specs disagree |
| HD:765 | `note` writes to card thread or posts a decision request | carried | worker-loop rule 12 |
| HD:767 | Code-mode single script when registry marks Worker script-capable | carried | worker-loop rule 12 `run_script`, WL-M2-4 |
| HD:772 | Write path 1: scope check | carried | worker-loop rule 14 |
| HD:773 | Write path 2: Tree-sitter AST parse | carried | worker-loop rule 14 (compiler for TS/JS; other languages where a checker exists) |
| HD:774 | Write path 3: gitleaks-pattern secret scan | carried | worker-loop rule 14 |
| HD:775 | Failure aborts write, typed error, disk untouched | carried | worker-loop rule 14, WL-3 |
| HD:779 | Rolling window of (tool, argumentHash, repoStateHash) | carried | worker-loop rule 17 |
| HD:780 | Two identical signatures, unchanged repo → stall | carried | worker-loop rule 18 |
| HD:781 | A-B-A → oscillation | carried | worker-loop rule 18 |
| HD:782 | Both terminate the turn immediately | contradicted | worker-loop rule 18: first repetition is a warning; a repeat after it stops with `oscillation_detected` (deliberate) |
| HD:782 | Step budgets set dynamically per card class by the planner | carried | worker-loop rule 21 (p80×1.25, ±15%, ≥4) |
| HD:787 | Stop reason `done_pending_gates` | carried | worker-loop rule 33 (meaning refined) |
| HD:788 | Stop reason `budget_exhausted` | carried | worker-loop OQ1 class |
| HD:789 | Stop reason `no_progress` | carried | worker-loop rule 19 |
| HD:790 | Stop reason `scope_violation` | carried | worker-loop rule 32 |
| HD:791 | Stop reason `capability_ceiling` | carried | worker-loop rule 34.4 |
| HD:792 | Stop reason `human_abort` | carried | worker-loop rule 32 (hook veto separated) |
| HD:794 | Stop reasons never collapsed; core competence signal | carried | worker-loop rule 30 |
| HD:794 | Six is the vocabulary; new conditions are details, not new members | carried-weaker | code stores 18; worker-loop OQ1 recommends 18 stored + 7 learned classes — the rule is now an open question and the class count changes to seven |
| HD:796 | Every stop reason names the next action (vacuous tests named; scope file named with widen offer; ceiling names escalation) | carried | worker-loop rules 31–32, WL-11 |
| HD:800 | Rung 1: typed feedback, same context, max 2 | carried | worker-loop rule 34.1 |
| HD:801 | Rung 2: fresh pack, same plan, max 1 | carried | worker-loop rule 34.2 |
| HD:802 | Rung 3: narrow scope or escalate one model tier (competence model chooses); re-decomposition only at rung 4 | contradicted | worker-loop rule 34.3: rung 3 is **re-plan** by the Planner (the old text explicitly put re-decomposition at rung 4); escalation moved to Later; "narrow the scope" option not mentioned anywhere |
| HD:803 | Rung 4: park with a question naming tried/failed/suspected; re-decomposition an answer | carried | worker-loop rule 34.4 |
| HD:805 | Worker never re-reads its prior reasoning across rungs; each rung rebuilds from clean pack | carried | worker-loop rule 35 |
| HD:809 | Reasoning suppressed for mechanical steps; raised for planning or after rung-1 failure | carried | worker-loop rule 24 (policy table) |
| HD:809 | Prior reasoning stripped between steps unless registry notes benefit | contradicted | see HD:631 |
| HD:811 | Finding: Worker never planned; default profile disabled reasoning | carried | worker-loop §9 / OQ16 context (narrative) |
| HD:816 | Thinking policy off / surgical / all, `SEKHEMET_THINKING`, recorded in evidence | carried | worker-loop rules 24, 27 |
| HD:821 | Winner = best pass rate for wall-clock, same build/model, ≥2 runs | contradicted | measurement rule 12 and OQ1: paired comparison; when inseparable the cheaper arm wins (deliberate, documented) |
| HD:825 | Every habit enforced by structure, never a prompt sentence | carried | worker-loop rule 1 |
| HD:831 | Broken edit never lands (parse + secret scan before disk) | carried | worker-loop rule 14 |
| HD:832 | Done means proven: `finish_card` refused while last check failed (strict) | carried | worker-loop rule 26 |
| HD:833 | Don't repeat what failed: re-running same command with no file change refused; trimming-only variants are the same | carried | worker-loop rule 26, NEW-worker-loop-1 |
| HD:834 | Acceptance test inline; imported signatures shown before any write; `edit` preferred over whole-file rewrite | carried | worker-loop rule 12; context rules 14–15; planner-pm §2.1.6 |
| HD:834 | Data contract (interface fields, CREATE TABLE) in the map; files with nothing to build on dropped | carried | context rules 13–14, M5 |
| HD:835 | Think on first turn and after a failed check | carried | worker-loop rule 24 |
| HD:836 | Short views, recent history in full, failures cut to the assertion | carried | worker-loop rule 29 (100-line window A/B); context rules 3, 16 |
| HD:837 | After a failure the next edit states which assertion it addresses (A/B) | carried | worker-loop rule 29 (`hypothesis`) |
| HD:839 | Fingerprint hashes working-tree content via throwaway index | carried | worker-loop rule 17, WL-1 |
| HD:839 | Data contract as own section appended to whichever map is used | carried | context rule 14 (gap M5) |
| HD:839 | Surgical thinking also after a failed automatic re-check | carried | worker-loop rule 24, WL-7 |
| HD:841 | No planning/todo tool for the Worker; planning upstream | carried | worker-loop rule 28 |
| HD:843 | Every behaviour-changing mechanism ships behind a switch, admitted by the frozen suite | carried | worker-loop rule 1 |
| HD:853 | Read semantics: paginated, byte-budgeted; read-before-edit precondition | carried | worker-loop rule 12 |
| HD:854 | Edit: unique match; `replace_all` for renames; exact whitespace/line endings | contradicted | worker-loop rule 12: `replace_all` is not offered; line endings normalised (deliberate) |
| HD:855 | Write discouraged for existing files | carried | worker-loop rule 12 |
| HD:856 | Grep regex, three modes, context lines, head limit, gitignore-aware | carried-weaker | see HD:244 grep row |
| HD:858 | Bash with timeout and description field | carried-weaker | `run_cmd` has a timeout; description field not stated |
| HD:863 | Incremental discovery; fewer tools per agent (reviewer: read/grep/glob; implementer + edit/bash; researcher + fetch) | carried-weaker | worker-loop rule 10 (`CLASS_TOOLS` per kind); per-role tool lists not stated |
| HD:869 | Line numbers 1-based start/end, not offsets | carried | worker-loop rule 12 |
| HD:870 | Symbol edits + exact-replace fallback with parse gate before write | carried | worker-loop rules 12, 14 |
| HD:871 | Grep capped, gitignore-aware; repo map answers first | carried | worker-loop rule 12; context rule 13 |
| HD:872 | Glob identical semantics | carried-weaker | see HD:244 glob row (mtime sort) |
| HD:873 | `run` denies raw `cat`/`grep`/`sed` when structured equivalent exists | carried | worker-loop rule 12, WL-5 |
| HD:874 | Explore, Plan, Implement as card classes with fixed tool lists | carried | worker-loop rule 10; models rule 31 (kinds renamed: spike/interface/implement/data/rule/review/research) |
| HD:875 | Todo = subtask list + open TODOs in volatile tail | carried | context rule 8 |
| HD:876 | Ask user = `note` with question and options into card thread and inbox | carried | worker-loop rule 12 (`ask`/`note`) |
| HD:880 | Deterministic map first, budgeted search second; read-before-edit and uniqueness enforced mechanically; mask and end step instead of summarising | carried | worker-loop rules 12, 14; context rules 3, 12 |
| HD:884 | Planner rejects Scrum role-play; deterministic scheduling + automated decomposition | carried | planner-pm §2.7.4; DEC-05 |
| HD:888 | Responsibilities: decomposition, criteria, difficulty, DAG, prioritisation, budgets, routing, replanning, status from gate results | carried | planner-pm §2.1–2.7 |
| HD:892 | Split until every leaf satisfies tier context and step budget | carried | planner-pm §2.4 Small |
| HD:896 | SPIDR Spike: research/spike card writing notes and a toy test | carried | planner-pm §2.2 table |
| HD:897 | SPIDR Path: happy path first | carried | planner-pm §2.2 table |
| HD:898 | SPIDR Interface = type contracts/schemas first | contradicted | planner-pm §2.2: Interface is the *user* interface (Cohn's meaning); type contracts become a separate `Contract` enabler card (deliberate) |
| HD:899 | SPIDR Data: single entity/basic payload first | carried | planner-pm §2.2 |
| HD:900 | SPIDR Rules: relax validation/auth/rate limits first | carried | planner-pm §2.2 (with hard-invariant exception) |
| HD:904 | INVEST pre-flight before Planning → In Progress | contradicted | planner-pm §2.4 says "Before a card moves from Planning to Ready" |
| HD:908 | Independent: zero scope overlap with active cards; DAG acyclic; overlap → serialize | carried | planner-pm §2.4 |
| HD:909 | Negotiable: criteria not line-by-line syntax; reject → goal criteria | carried | planner-pm §2.4 |
| HD:910 | Valuable: links to project gate or goal criterion; reject orphans | carried | planner-pm §2.4 (adds epic behaviour) |
| HD:911 | Estimable: difficulty maps to throughput envelope; >7 forces re-split | carried | planner-pm §2.4 |
| HD:912 | Small: pack ≤25% of tier **working context**; step budget ≤40 | carried-weaker | planner-pm §2.4 says "≤ 25% of the tier **window**" — the base changed from working context to window (a looser bound) |
| HD:913 | Testable: failing test committed before handoff | carried | planner-pm §2.4; gates GT-P1-1 |
| HD:918 | WSJF = (value + time criticality + risk reduction)/(estimated steps × difficulty) | carried | planner-pm §2.7.2 |
| HD:919 | RICE for idea-stage repos; weights in config.toml; planner never invents weights | carried | planner-pm §2.7.2 |
| HD:923 | Estimates in tokens, seconds, steps; never story points | contradicted | planner-pm §2.6: machine estimate tokens/seconds/steps; human estimate is Fibonacci points (documented resolved drift) |
| HD:924 | EstimatedTokens = BasePackTokens + Difficulty × HistoricalTokensPerDifficulty[Class]; actuals write back | carried | planner-pm §2.6.1 |
| HD:929 | ReviewWIP from project's accepted-card history, floored at 1 | carried | review-git §2.2.1–2.2.3 (per project; 15-min prior; gap S6) |
| HD:929 | Planner opens no more work toward Review than allowed; prefers splitting to keep diffs small | carried | planner-pm §2.7.5 |
| HD:933 | Routing: difficulty <4 direct with plan; 4–7 edit sketch; >7 split | carried | planner-pm §2.5 |
| HD:933 | Rung-3 failure or context exceeds tier budget at max decomposition → `capability_ceiling`, escalate with diagnostic | carried | planner-pm §2.5 |
| HD:937 | Process profiles Kanban / Scrum (sprint goals, reviews, retros) / Shape Up (appetite, betting table); execution always Kanban | carried | planner-pm §2.7.3 |
| HD:937 | Retros analyse gate failures and synthesise playbook candidates | carried | planner-pm §2.7.4 |
| HD:941 | Conversation is the main input surface; board is the state; nothing durable in transcript | carried | planner-pm §2.8.3–2.8.5 |
| HD:943 | Ambiguity resolved in conversation is cheapest; Planner talkative here | carried | design-stage §2.2 |
| HD:947 | Holds the whole workspace; answers from event log across projects | carried | planner-pm §2.8.5 |
| HD:948 | Asks before assuming on scope/invariant ambiguity; decides when conventions answer | carried | planner-pm §2.10.1 |
| HD:948 | Asking about something the playbook already settles is a defect | missing | no new doc states that a question the playbook answers is a defect |
| HD:949 | Proposes; board records; editing in conversation edits cards | carried | planner-pm §2.8.3 |
| HD:950 | Reports from evidence; never characterises work as going well | carried | planner-pm §2.8.2, §2.8.14 |
| HD:956 | Conversation never evicts a running Worker; reply waits for step boundary | contradicted | planner-pm §2.8.6: PM pauses the Worker at a step boundary, loads, answers, Worker resumes (documented resolved drift) |
| HD:957 | Conversation has no memory of its own; no user profile | contradicted | planner-pm §2.13.3: ledger-backed editable user profile (documented resolved drift, owner) |
| HD:958 | Conversation cannot accept, override a gate, or mark done | carried | planner-pm §2.8.4 |
| HD:962 | Terminal is default conversation surface; `sekhemet` opens it; board chat panel is same conversation | later | planner-pm Later (terminal conversation); surface OQ1 (`sekhemet ask`) |
| HD:964 | [RESEARCH] Calibrate ask-vs-assume on ClarEval; symmetric failure modes ("you should have known" questions; send-backs knowable in advance) measurable | later | planner-pm Later (ClarEval); OPEN_QUESTIONS research gap; the two named failure-mode measures are not carried |
| HD:970 | Six things: problem, outcome, non-goals, constraints, riskiest assumption, first slice; infer most, say so | carried | design-stage §2.1, §2.3 |
| HD:972 | Never announce steps; never say "requirements", "phase", "let me gather" | carried | design-stage §2.2.6 |
| HD:976 | Propose and proceed (calculator example) | carried | design-stage §2.2.1 |
| HD:982 | Ask only when uncertain and expensive to get wrong | carried | design-stage §2.2.2 |
| HD:984 | One question at a time, the one that most changes the backlog | carried | design-stage §2.2.3 |
| HD:986 | A question whose answers produce the same cards is not asked | carried | design-stage §2.2.3; planner-pm §2.10.1 |
| HD:988 | "Just build it" and silence are complete answers; never re-offered | carried | design-stage §2.2.4 |
| HD:990 | Nothing blocked on the conversation; question left open on board | carried | design-stage §2.2.5 |
| HD:994 | Brief at `.sekhemet/brief.md`, versioned, amendable | carried | design-stage §2.3 |
| HD:998 | Brief sections: Problem (incl. "today instead"), Outcome, Non-goals, Constraints, Prior art (cited, Researcher), Riskiest assumption, First slice, Definition of done, Invariants | carried | design-stage §2.3 |
| HD:1010 | Prior art researched by the Researcher with sources, not recalled from weights | carried | design-stage §2.5.7 (gap P7) |
| HD:1016 | Backbone of user activities; thinnest slice through all becomes first cards | carried | design-stage §2.3; planner-pm §2.2.5 |
| HD:1018 | Narrow and complete over one part deep; unbuilt shape visible | carried | design-stage §2.3; planner-pm §2.2.5 |
| HD:1020 | Riskiest assumption scheduled first regardless of backbone | contradicted | planner-pm §2.2.4 / design-stage resolved drift: scheduled right after the contract card (deliberate) |
| HD:1026 | Every slice carries a behaviour with concrete values; model asked for it | carried | planner-pm §2.3.1 |
| HD:1026 | Without a model, behaviour = spec's own words | carried-weaker | planner-pm §2.1.2 heuristic fallback exists; the "spec's own words" rule is not restated |
| HD:1026 | Hard invariants ("never", "twice", "exactly once", "idempotent") scheduled right after contract | carried | planner-pm §2.2.3 |
| HD:1026 | Riskiest assumption planned even if unwritten (billing gets a charge-twice card second in line) | carried | planner-pm §2.2.4 |
| HD:1030 | Assumptions recorded with defaults, visible on board, outcome recorded when contradicted; measures default quality | carried | design-stage §2.2.9; planner-pm §2.10.4 |
| HD:1036 | Proportion table: --json flag / calculator / S3 sync / billing | carried | design-stage §2.1 |
| HD:1043 | Brief written only when worth reading later; otherwise assumptions on cards | carried | design-stage §2.1.2 |
| HD:1051 | Proportion chosen by rules before any model is loaded | carried | design-stage §2.1.2 |
| HD:1053 | Brief when money/identity/personal data; never overwrite existing brief; riskiest assumption named | carried | design-stage §2.1.2, v1 acceptance |
| HD:1054 | At most two questions on hard-to-change external contracts | carried | design-stage §2.1.2 |
| HD:1055 | One sentence for new project or large change | carried | design-stage §2.1.2 |
| HD:1056 | Nothing for small change to existing project | carried | design-stage §2.1.2 |
| HD:1058 | Quality words become constraints with defaults, not cards | carried | design-stage §2.2.8 |
| HD:1058 | Every default an assumption on every card and on the epic; request phrasing dropped | carried | design-stage §2.2.8–9 |
| HD:1062 | Reuse survey whenever design stage says anything | carried | design-stage §2.5 |
| HD:1064 | Registries (npm; PyPI by name) and GitHub, one short keyword query per need; only keywords leave | carried | design-stage §2.5.1–2 (gap P7/S8) |
| HD:1065 | Literature only for algorithmic work | carried | design-stage §2.5.1 |
| HD:1067 | Relevance: ≥2 need words in name/description; kind words dropped from query | carried | design-stage §2.5.3 |
| HD:1067 | Popularity: ≥1,000 weekly downloads or 20 stars | carried | design-stage §2.5.3 |
| HD:1067 | Licences: permissive recommended; weak copyleft flagged; GPL/AGPL named in exclusions; no licence dropped silently | carried | design-stage §2.5.3 |
| HD:1069 | "May already cover this", never "already does this"; Worker told to read one before depending | carried | design-stage §2.5.4 (Researcher reads README first; OQ2) |
| HD:1069 | Archived or untouched 2 years not recommended | carried | design-stage §2.5.3 |
| HD:1069 | Unreachable source reported as not searched | carried | design-stage §2.5.5 |
| HD:1071 | Results to person (one line), brief Prior art, each card's dossier with depend-or-note instruction; Worker never searches | carried | design-stage §2.5.6 |
| HD:1073 | `--offline` / `SEKHEMET_OFFLINE=1` plans without looking and says so | carried | design-stage §2.6.1 |
| HD:1075 | Not built: riskiest-assumption scheduling, model phrasing, deep Researcher before planning | gap | NEW-design-stage-1, P7 (riskiest scheduling now built per planner-pm §4) |
| HD:1081 | New TS project has static layer from first file | carried | design-stage §2.4.1 |
| HD:1087 | Card zero runs ecosystem generator (`cargo new`, `uv init`, `pnpm create vite`, `npm init`) | carried | design-stage §2.4.1 (gap P2) |
| HD:1089 | Template library rejected; generator + version recorded in brief | carried | design-stage §2.4.1, §9 Rejected |
| HD:1093 | Card one: failing test exists, runs, fails for stated reason | carried | design-stage §2.4.2 |
| HD:1101 | Novel architecture: "talk it through with me, then I will cut the cards" | carried | design-stage §2.4.3 |
| HD:1105 | Format interactions for rapid "5-second approvals" | contradicted | review-git: "under a minute"; planner previews "choose before the Worker touches a file" — 5-second target dropped |
| HD:1113 | Steer: free text delivered at next step boundary as `card/steer`, no restart, no prefix invalidation, lands in volatile tail | later | planner-pm Later |
| HD:1114 | Scope amendment mid-card; Worker told | later | planner-pm Later |
| HD:1115 | Abort with a reason → stop detail + playbook candidate | carried | planner-pm §2.14 |
| HD:1119 | Steer cannot relax gate, widen permission, accept | later | planner-pm Later (rules retained for when built) |
| HD:1120 | Steer recorded before delivery; steered outcome flagged, excluded from unattended stats | later | planner-pm Later |
| HD:1121 | Steering not required for correctness | later | planner-pm Later |
| HD:1127 | Card state decides: attached human answers in seconds while Worker holds its slot; 60 s single timeout | later | planner-pm Later ("v1 always proceeds on the default") |
| HD:1127 | Unattached/deadline: `safe_default` takes recommendation, `default_deny` parks | carried | planner-pm §2.10.3 |
| HD:1132 | Pause & Persist: card to Parked/Planning, compute and VRAM fully released, scheduler loads next card | carried-weaker | planner-pm §2.10.2: work proceeds on the default meanwhile; `default_deny` parks at deadline — what happens to a `default_deny` card *before* the deadline, and the explicit VRAM release, are unstated |
| HD:1134 | Durable resume on answer (UI, CLI, notification webhook): `decision/answered`, rehydrate context, resume | carried-weaker | planner-pm §2.10.2 records `decision/answered` from board/CLI/notification; resuming a parked `default_deny` card after a late answer is not specified |
| HD:1139 | Question policy: Assume / Ask / Spike | carried | planner-pm §2.10.1 |
| HD:1142 | Questions batched into one decision request per planning pass | contradicted | planner-pm §2.10.1: at most two open questions per pass, each its own request (deliberate) |
| HD:1142 | >3 questions → spec rejected as under-specified | contradicted | planner-pm §2.10.1 / P2: never refused (documented resolved drift) |
| HD:1147 | DecisionRequest shape: options (label, consequence, effortDelta, riskNote, previewSketch), recommendation, policy, defaultIfNoAnswer (optionIndex, deadline ISO 8601) | carried | planner-pm §2.10.2; Contract `DecisionRequest` |
| HD:1171 | previewSketch: files touched, candidate symbol changes, blast radius | carried | planner-pm §2.10.2 |
| HD:1176 | safe_default for low-risk choices → `decision/default_applied`, proceeds | carried | planner-pm §2.10.3 |
| HD:1177 | default_deny for overriding gates, deleting files, untrusted deps, DB schema; parks and notifies; never auto-approve destructive | carried | planner-pm §2.10.3 |
| HD:1183 | Session Intake | carried | planner-pm §2.7.8 |
| HD:1184 | Session Planning: plans, acceptance tests, budgets, one batched decision request | carried | planner-pm §2.7.8 (at most two questions) |
| HD:1185 | Session Standup: passed, parked, waiting on you, wait times | carried | planner-pm §2.7.8 |
| HD:1186 | Session Review: accept, return with reason, or split | carried | planner-pm §2.7.8, §2.14 |
| HD:1187 | Session Retrospective: end of sprint or every N cards | carried | planner-pm §2.7.8 (`retroEveryCards`) |
| HD:1188 | Session Replan: rung-3 failure, scope change, capacity change; diff vs previous plan | carried | planner-pm §2.7.8 |
| HD:1192 | Status derived from gates and log, never freehand | carried | planner-pm §2.8.14 |
| HD:1192 | Standup lists cards by state, decisions waiting, **then the machine's plan for the next window** | carried-weaker | planner-pm §2.7.8 standup: Done / In flight / Needs you / pace / citations — the machine's plan for the next window is gone |
| HD:1192 | Estimates always show range and basis | carried | planner-pm §2.6.3 |
| HD:1196 | Escalate on capability_ceiling, external dependency, gate failing for credentials/env drift, budget forecast over cap; state diagnosis, tried, smallest unblocking action | carried | planner-pm §2.5 |
| HD:1202 | Human cmd: Accept, Return with reason, Split | carried | planner-pm §2.14 |
| HD:1203 | Human cmd: Park, Unpark, Reprioritize (recomputes schedule) | carried | planner-pm §2.14 |
| HD:1204 | Human cmd: Override gate with recorded reason, never security | carried | planner-pm §2.14; kernel rule 22 |
| HD:1205 | Human cmd: Reroute (force model or arm for a card) | later | planner-pm Later (runtime still lists a `reroute` endpoint) |
| HD:1206 | Human cmd: Explain evidence behind estimate, route or decision | later | planner-pm Later ("Seshat already explains on request"); runtime lists `cards/:id/explain` |
| HD:1207 | Human cmd: Pause project | missing | planner-pm §2.14 points to runtime for "Pause project, set hours"; runtime specifies reserved hours only — no pause-project control anywhere |
| HD:1207 | Human cmd: Set hours | carried | surface rule 23 `reserved_hours`; runtime rule 17 |
| HD:1211 | Trust calibration: override rate moves assume→ask, accepted recommendations ask→assume; thresholds visible and adjustable | carried | planner-pm §2.10.4 |
| HD:1213 | Override rate >15% shifts category to Ask | carried | planner-pm §2.10.4, v1 acceptance |
| HD:1217 | Goal: outcome with criteria pursued until met or reported impossible; runs continuously | carried | planner-pm §2.11 |
| HD:1222 | Goal record fields (workspaceId, projectIds, statement, criteria kind/check/status, budget tokens/hours/deadline, strategy, state enum) | carried | planner-pm Contract (`Goal` in goals.ts) |
| HD:1247 | Criteria semantics gate / metric / human; all-human flagged unverifiable | carried | planner-pm §2.11.1 |
| HD:1251 | `/goal <statement>` opens intake: restate, criteria, budget, assumptions; nothing runs until approved | carried-weaker | planner-pm §2.11.2 via `sekhemet goal`; no `/goal` chat command (goals are CLI/API only in v1) |
| HD:1251 | Strategy versioned so replans can be diffed | carried | planner-pm §2.11.2–3 |
| HD:1266 | Criteria re-evaluated on every card close **and on a timer** | carried-weaker | planner-pm §2.11.3: on every card close only — timer lost |
| HD:1266 | Replan triggers: rung-3 fail, regression of met criterion, budget over cap, dependency or environment change, card advancing no criterion | carried-weaker | planner-pm §2.11.3 lists "environment changes" — a *dependency* change trigger dropped |
| HD:1266 | Replan posted to the goal thread with diff and one-paragraph reason | carried-weaker | diff and reason carried; "posted to the goal thread" not |
| HD:1287 | Signal: burn-up vs scope (two curves) → forecast ETA | carried | planner-pm §2.12 |
| HD:1288 | Signal: scope drift >20% → halt auxiliary cards; decision request | carried | planner-pm §2.12 |
| HD:1289 | Signal: column p95 > 2.5× p50 → flag congestion, adjust step budget, flag model degradation | carried-weaker | planner-pm §2.12: "propose step-budget changes"; "flag model degradation" dropped; old diagram said 2× (new keeps 2.5×) |
| HD:1290 | Signal: blocker >12 h (2 h during active work) → top of inbox, batch decisions | carried | planner-pm §2.12 |
| HD:1291 | Signal: ≥3 gate failures in one file → pause implementation, route to Planner to re-split on Interface/Data | carried-weaker | planner-pm §2.12: "propose re-splitting" — automatic pause of implementation removed (consistent with "signals propose") |
| HD:1292 | Signal: Review backlog ≥ ReviewWIP → hard back-pressure | carried | planner-pm §2.12 |
| HD:1293 | Signal: RAID risk register; high-risk assumption >24 h → verification spike | carried | planner-pm §2.12 (proposed spike) |
| HD:1295 | Responses automatic within visible preset bounds, else decision request | carried | planner-pm §2.12 (automatic only when no person-owned field changes) |
| HD:1299 | Goal view: statement, criteria, burn-up, strategy graph, risk register, forecast range, filtered inbox | later | planner-pm Later; dashboard Later |
| HD:1299 | Goal with no state change in a configurable window is highlighted | missing | not in dashboard, planner-pm or Later |
| HD:1303 | Multiple goals by WSJF; one may be sole active; scheduler explains per window | carried | planner-pm §2.11.4 |
| HD:1307 | Goal met only when all criteria met and verified; blocked with diagnosis; never partial as done | carried | planner-pm §2.11.5 |
| HD:1311 | gates.toml versioned, Worker cannot modify; tampering detected by hash fails the card | carried | gates rule 2, GT-1 |
| HD:1317 | Layer Static (parse, format, lint, typecheck) on gate host | carried | gates rule 3 |
| HD:1318 | Layer Functional incl. acceptance tests first | carried | gates rule 3 |
| HD:1319 | Layer Robustness: mutation score, coverage delta; nightly for large diffs | carried-weaker | coverage delta in gates Later; "nightly for large diffs" not stated (runtime nightly mutation exists, RUN-17 area) |
| HD:1320 | Layer Security: secret scan, dependency existence + allowlist, vuln scan | carried | gates rule 3 |
| HD:1321 | Layer Visual on gate host with a browser | carried | gates rules 3, 29 |
| HD:1322 | Layer Hygiene: changelog, no debug output, commit trailers (Agent-Model, Agent-Harness, Agent-Role, Co-authored-by) on core host | carried | gates rules 3, 17; review-git §2.5.4 |
| HD:1323 | Layer Human: review with evidence on the board | carried | gates rule 3 |
| HD:1327 | Planner writes acceptance tests first; they must fail; Worker cannot edit gate test patterns | carried | gates rules 5–7 |
| HD:1333 | Visual 1: runtime exceptions, HTTP ≥400, unhandled rejections | carried | gates rule 29 |
| HD:1334 | Visual 2: bounding boxes: overlap, zero size, off-screen, horizontal overflow | carried | gates rule 29 |
| HD:1335 | Visual 3: element screenshots, masking, animations off, maxDiffPixelRatio 0.01 | carried | gates rule 29 |
| HD:1336 | Visual 4: axe-core at 1280 and 375 px, zero critical | carried | gates rule 29 |
| HD:1337 | Visual 5: atomic yes/no checklist at temperature 0 | carried | gates rule 30 (gap NEW-gates-4) |
| HD:1339 | Vision model can fail but never pass; baselines need human approval; blocks nothing until false-pass measured | carried | gates rules 30–31; OPEN_QUESTIONS #10 |
| HD:1343 | Mutation diff-scoped, advisory then blocking per project, never 100% | carried | gates rule 32 |
| HD:1347 | Secrets gate scans what the branch adds, excluding staged acceptance tests | carried | gates rule 15, GT-4 |
| HD:1349 | Evidence contents: diff, gate results, test output, screenshots, scan reports, stop reason, tried-and-abandoned | carried | gates rule 35 |
| HD:1357 | Evidence `structuralDiff` (difftastic) | later | gates Later |
| HD:1370 | Evidence `trajectoryRef` = SHA-256 of event-log slice | carried-weaker | gates rule 35: "a reference to the trajectory" — hash form not stated |
| HD:1380 | Reachability: export reachable if production imports it or contract asks for it (tests wherever, spec, criteria) | carried | gates rule 24 |
| HD:1382 | Card's own unit tests don't make code reachable; only card-added exports judged; entry points public | carried | gates rule 24 |
| HD:1386 | Rejected: "no production caller fails the card" | carried | gates §9 (not to be re-proposed) |
| HD:1387 | Rejected: fixture-layout-only acceptance tests | carried | gates §9, GT-P1-3 |
| HD:1388 | Errs toward reachable: name in any import clause counts; word in card text counts | carried | gates rule 24 |
| HD:1390 | Remedy: wire in, un-export, or `note` naming a later card — each one edit | carried | gates rule 24, GT-5 |
| HD:1396 | Regression: failures of tests on main restated as regressions listing changed files | carried | gates rule 25 |
| HD:1396 | Refuses removed or emptied tests from main | carried | gates rule 25 |
| HD:1398 | Judges against main, never card's own tests; outside git judges nothing | carried | gates rules 15–16 (integration branch, not hard-coded main) |
| HD:1400 | Only code files count as tests; file empty on main can't be emptied | carried | gates rule 25 |
| HD:1400 | Failure carries test content from main so restoring is one write | carried | gates rule 21, GT-6 |
| HD:1400 | A test too long to carry is reported with `note` instead | missing | not stated in gates rule 21/25 |
| HD:1404 | Architecture gate reads brief Invariants on every verification | carried | gates rule 26 |
| HD:1406 | Form `A/` does not import `B` (trailing `/` = directory) | carried | gates rule 26 |
| HD:1407 | Form `Name` is defined only in `path` | carried | gates rule 26, GT-T2-2 |
| HD:1409 | Judges only changed files; remedies single edit (remove import / delete duplicate and import original) | carried | gates rules 15, 21, GT-7 |
| HD:1409 | No brief or no invariants → enforces nothing | carried | gates rule 26 |
| HD:1411 | Unmatched line is "not enforced" and said so; showing on board not built | gap | gates rule 26, NEW-gates-1 |
| HD:1413 | All three project gates wrap every card's gate run regardless of gates.toml | carried | gates §Project gates intro |
| HD:1421 | Arithmetic: 4 rungs × 4 samples = 16 gate runs; gates dominate cost | carried | gates rule 33 |
| HD:1423 | Impacted tests first, short-circuit; full suite once before Review | carried | gates rule 33, GT-N3-2 (gap) |
| HD:1424 | Verdict cached by tree hash + gate's pinned hash | carried | gates rule 33, GT-N3-1 (gap) |
| HD:1425 | Static before functional, ordered by cost | carried | gates rule 33, GT-N3-3 (gap) |
| HD:1426 | Each gate has a timeout; timeout = failure with own repair procedure | carried | gates rule 33 |
| HD:1432 | Flaky: re-run failing tests once on unchanged tree before first rung; quarantine, report with both runs | carried | gates rule 34, GT-N3-4 (gap) |
| HD:1433 | Wrong gate: Worker stops with a stop reason naming gate and reason; human decides | carried | gates rule 18, GT-M6-5 (`gate_suspected`, gap) |
| HD:1434 | Gate that cannot run: needs declared in gates.toml; unavailable stated in evidence, never silently skipped | carried | gates rules 9–10, GT-T1-7 |
| HD:1438 | Harness never asks user to pick model or context size | carried | surface rule 2 (Default); models rule 7 |
| HD:1446 | Named defaults fetchable and hash-verified from a source in the component register | gap | models rule 4, NEW-models-7 |
| HD:1447 | doctor verifies weights exist, readable, hash before anything green | carried | models rule 5, MD-6 (hash: NEW-models-7) |
| HD:1448 | One override `--models-dir` + config equivalent; per-model env vars not a surface | carried | models rule 6; surface rule 27 |
| HD:1450 | No shipped model path outside user config (absolute, external volume, author dirs) | carried | models rule 6, MD-N7-3 |
| HD:1454 | Calibration: memory budget, bandwidth, prefill/decode per context length; sweep batch and offload one step back from cliff; profile by hardware fingerprint; re-run on change | carried | models rule 7, NEW-models-1 |
| HD:1458 | Tier table S/M/L/XL (budget, planner, worker, co-load, working context, parallel cards) | carried | models rule 8 (identical) |
| HD:1465 | Model names absent; registry fills from measurement; larger tiers buy co-residency not prompt | carried | models rule 8 |
| HD:1469 | Throughput floors: overnight 40/10 ~70 s; interactive 100/20 ~30 s; recommended 300/40 ~12 s | carried | models rule 9 (identical) |
| HD:1475 | Below overnight floor refuse cards and say why; below 16 GB unsupported | carried | models rule 9, MD-N2-1 (gap) |
| HD:1479 | KV 8-bit; lower only if model qualifies with it | carried | models rule 10 |
| HD:1479 | Flash attention on; prefill batch swept; expert offload only when needed | carried | models rule 10 |
| HD:1479 | Speculative decoding via MTP or qualified draft models where bandwidth permits | carried-weaker | models rule 13: MTP only, off until measured; draft-model path gone |
| HD:1481 | Sampling per model in registry, not global | carried | models rule 11, MD-N4-2 |
| HD:1481 | Templates pinned per build with SHA-256 | carried | models rule 12 |
| HD:1485 | Engine adapter: llama.cpp baseline; MLX on Apple Silicon; choose by measurement weighting cache retention | carried | models rule 14 (MLX status contradicted, see HD:221) |
| HD:1485 | [BENCH] engine choice on 24 GB M4 | carried | OPEN_QUESTIONS #3 |
| HD:1490 | Watchdog polls OS pressure and VRAM every 2 s | carried | models rule 19 |
| HD:1491 | 85%: suspend speculative decoding | carried | models rule 19 (elevated, 0.85), MD-M11-3 |
| HD:1492 | 90%: throttle parallel cards to 1, trim LSP symbol caches, cascade observation pointers across older turns | carried-weaker | models rule 19: "high" trims KV and prompt caches; no 90% threshold (ratios 0.85/0.94 only); parallel-cards-to-1 and forced observation masking are not listed (runtime rule 22 still says "85–90%") |
| HD:1493 | 94%: pause active turns gracefully and persist state to SQLite WAL | carried | models rule 19 (critical 0.94 pauses; emergency unloads) |
| HD:1497 | Declared hours; backlog worked outside; swaps batched by project; planning in scheduled blocks when co-loading impossible | carried | models rule 20, NEW-models-3 (gap) |
| HD:1505 | Four roles and their jobs; Reviewer from a different family | carried | models rule 21 |
| HD:1507 | Roles are `ModelEntry.roles` values, not agents; no simulated conversation | carried | models rule 22; DEC-05 |
| HD:1509 | One model may hold several roles; never co-reside below 32 GB | carried | models rule 22 |
| HD:1509 | Absent role degrades to named fallback (no Reviewer → unreviewed and card says so; no Researcher → repo only) | carried | models rule 23, MD-5 |
| HD:1511 | Fifth role only when an existing one cannot be qualified | carried | models rule 24 |
| HD:1516 | ModelEntry fields (family, quant, size, window, template, sampling, reasoning, toolArm, scriptCapable, throughput per bucket, qualification, roles incl. vision) | carried | models rule 25 (vision now a capability, not a role) |
| HD:1551 | Qualification suite: own tool schemas, deterministic scoring; schema validity, selection, arguments, multi-turn recovery, out-of-scope refusal | carried | models rule 27 |
| HD:1553 | Worker bar internal, not comparable to public leaderboards; multi-turn below single-turn accounted | carried | models rule 27 |
| HD:1557 | Bake-off: closed issues + fixing commits → fail-to-pass; recent commits → reconstruction; run under real harness | carried | models rule 30 |
| HD:1559 | Every result recorded with full settings; number without settings inadmissible | carried | models rule 30; models §1 |
| HD:1566 | cardClass = "<kind>:<ext>" | carried | models rule 31 |
| HD:1569 | Seven closed kinds; ext from primary scope extension or `none` | carried | models rule 31 |
| HD:1573 | Class properties: predictable, knowable before run, coarse enough to fill | carried | models rule 31 |
| HD:1577 | Tool sets by kind; budgets, routes, exemplars by whole class | carried | models rule 31 |
| HD:1581 | Competence row: class, files, difficulty, model, arm, step budget, stop reason, gate failures | carried | models rule 32 |
| HD:1583 | Prediction, decision, outcome as three separate fields | gap | models rule 32, NEW-models-6 |
| HD:1585 | [RESEARCH] task synthesis: closed PRs, fail-to-pass invariant, scrubbed paths | carried | OPEN_QUESTIONS research gaps row 1 |
| HD:1587 | [BENCH] card size vs pass rate sets decomposition granularity | carried | OPEN_QUESTIONS #6 |
| HD:1591 | Every prompt change A/B tested against the card eval before shipping | carried-weaker | measurement admits inlet proposals by the suite; no rule requires a hand-made prompt/template change to be A/B-tested (context CX-M1-7 covers exemplars only) |
| HD:1597 | Guidance: scoped, dated, attributed, retired, delivered in stable zone at card boundary | carried | context rule 23 |
| HD:1599 | Measurements keyed by class and settings | carried | context rule 23 |
| HD:1601 | Fetched bytes content-addressed, expire by mutability, safe to delete | carried | context rule 23 (expiry schedule in design-stage Later) |
| HD:1603 | A fourth store is a design error; one location and one writer per kind | carried | context rule 23; DEC-22 ("seventh durable store" row — numbering odd but intent kept) |
| HD:1607 | System prompt short; <1,000 tokens; tool interface <2,000 | carried | context rules 10, 21; CX-M1-3 |
| HD:1609 | Positive concrete instructions; no persona; tags not JSON reasoning | carried | context rule 21 |
| HD:1613 | Playbook per project, versioned, zone 2, grows by delta | carried | context rule 24 |
| HD:1615 | Entries from gate failures and retros, deduplicated, applied at card boundaries, with origin, retirable | carried | context rule 24 |
| HD:1618 | Playbook TOML fields: id, originCard, triggerGate, pattern, instruction, effectiveDate, evalPassRateDelta | carried | context rule 24 (id, origin card, trigger gate, instruction, effective date, evidence; pattern → scope) |
| HD:1631 | Exemplars: 1–2 from own history; no generic examples | carried | context rule 25 |
| HD:1635 | Offline optimiser in idle hours with planner as reflection engine; keep only if clears threshold; drop if <5% | later | context Later (GEPA, ≥5%); runtime Later; OPEN_QUESTIONS #12 |
| HD:1639 | Prompts, playbooks, tool schemas versioned together; change invalidates qualification **and triggers a re-run** | carried-weaker | context rule 27 invalidates qualification; automatic re-run not stated |
| HD:1643 | Reviewer answers "does this change do what the card asked?" | carried | review-git §2.3.1 |
| HD:1647 | Trigger: every card entering Review with a diff; research/no-diff skip | carried | review-git §2.3.2 |
| HD:1649 | Inputs: spec, criteria, diff, gate results; not the transcript | carried | review-git §2.3.3 |
| HD:1651 | Procedure: per criterion met/unmet with hunk; three failure modes gates miss | carried | review-git §2.3.4 |
| HD:1656 | ReviewFinding shape | carried | review-git §2.3.5 |
| HD:1664 | Authority none | carried | review-git §2.3.6 |
| HD:1666 | Different family enforced; unfilled role said in Review | carried | review-git §2.3.7 (gap P8) |
| HD:1668 | Acceptance: flags more seeded defects than empty list; FP low enough that a human reads by card 20 | carried | review-git P8, OQ2 |
| HD:1676 | Frozen suite 20–40 tasks, versioned; no edits to improve results; hash recorded with every result | carried | measurement rules 1–2 |
| HD:1678 | One number (tasks passed) with cost (wall-clock, tokens, repair-rung cards); non-improving change is not an improvement | carried | measurement rule 4 |
| HD:1680 | Suite doesn't measure planning; planning measure beside it (fail-before/pass-after reference; end-to-end share) | carried | measurement rule 14 (gap T7) |
| HD:1684 | Suite gates the self-improvement loop | carried | measurement rule 17 |
| HD:1685 | Suite qualifies registry models | carried | models rule 27 |
| HD:1686 | Suite gates asserted-not-measured components (pruner) | carried | measurement rule 16 |
| HD:1690 | Null baselines at equal budget; random line dropping; 31 of 60; delete if not beaten | carried | measurement rule 16; context §9 |
| HD:1696 | IRT calibration against SWE-bench per-instance results (~10⁵) | later | measurement Later |
| HD:1698 | Limits: Python-heavy; scaffold dominates (16.7% vs 47.9%); only pass/fail matrix importable, not patches | carried | measurement Later; models rule 32 |
| HD:1702 | One mechanism: signal → bounded proposal → suite → pinned → auto-rollback if pass rate drops **over next ten cards** | contradicted | measurement rule 18(3), MS-T8-3: rollback on a **paired** comparison; the ten-card window is recorded as the defect (deliberate) |
| HD:1722 | Six inlets with signals, proposals, bounds (1 rule/retro; ≤15%/cycle; 1 skill; 2/class; revert-and-fail; advisory tests) | carried | measurement rule 17 (identical) |
| HD:1731 | Seventh inlet justified by signal size, not paper | carried | measurement rule 17 |
| HD:1735 | Guardrail 1: measured signal; subjective self-assessment rejected everywhere incl. research prose | carried | measurement rule 18; design-stage §2.7.5 |
| HD:1736 | Guardrail 2: bounded change; whole-system rewrites blocked | carried | measurement rule 18 |
| HD:1737 | Guardrail 3: atomic rollback over moving ten-card window | contradicted | see HD:1702 (paired rollback) |
| HD:1738 | Guardrail 4: grounded admission (100% / 34.5% / 6.2%); skills and tests admitted by execution as GateResults | carried | measurement rule 18(4); §9 |
| HD:1742 | Volume thresholds below which inlets report insufficient data | carried | measurement rule 20 |
| HD:1746 | Playbook: 3 occurrences | carried | measurement rule 20 |
| HD:1747 | Budgets/routes: MIN_ARM_TRIALS per arm, Wilson excludes incumbent | carried | measurement rule 20 (MIN_ARM_TRIALS = 5) |
| HD:1748 | Skills: 3 instances and checks pass | carried | measurement rule 20 |
| HD:1749 | Exemplars: 5 accepted cards in class | carried | measurement rule 20 |
| HD:1750 | Synthesized tasks and generated tests: no minimum | carried | measurement rule 20 |
| HD:1753 | Difficulty prior from SWE-bench Verified annotations (1,699, 3 annotators), scale only | carried | measurement rule 22 |
| HD:1753 | Pre-filter calibrated from public pairs by monotone correction, gated on minimum trials | carried | measurement rules 21–22 |
| HD:1753 | Exemplars, playbook rules, routing local-only | carried | measurement rule 22; context rule 25; DEC-22 |
| HD:1757 | Weight updates excluded in v1; fine-tuning deferred until in-context plateaus | carried | measurement rule 23; DEC-22 |
| HD:1757 | Loop driver, gate runner, sandbox boundaries, permission tables permanently excluded from self-modification | carried | measurement rule 23 |
| HD:1759 | [BENCH] inlet gains; each enabled only after beating baseline | carried | OPEN_QUESTIONS #15 |
| HD:1763 | `sekhemet dev audit` command | carried-weaker | measurement rule 24 moves the function into `sekhemet doctor`'s playbook check and `qualify`; the `dev audit` name is gone (surface lists no such command) |
| HD:1764 | Net gain per skill/rule vs bare baseline on the suite | carried | measurement rule 24 (gap NEW-measurement-2) |
| HD:1765 | Context debt: >300 Zone-2 tokens without significant ≥+3% gain | carried | measurement rule 24, MS-N2-2 ("3 points") |
| HD:1766 | Conflicting/redundant/obsolete rules flagged; retire with a single keystroke | carried | measurement rule 24 ("one action") |
| HD:1774 | No self-critique; extra compute to bounded repeated sampling with gate selection; applies to code, plans, research prose | carried | worker-loop rule 3; design-stage §2.7.5 |
| HD:1780 | Ladder rung 1 same context typed failure | carried | worker-loop rule 34.1 |
| HD:1781 | Rung 2 fresh context discarding the polluted conversation | carried | worker-loop rule 34.2 |
| HD:1782 | Rung 3 narrowed scope or escalated model, chosen by competence model | contradicted | see HD:802 (re-plan in v1; escalation Later; narrowing gone) |
| HD:1783 | Rung 4 park with a decision request; never silent | carried | worker-loop rule 34.4 |
| HD:1785 | A rung that does not change inputs is not a rung | carried | worker-loop rule 35 |
| HD:1785 | Three failures with different contexts → route to Planner for decomposition, not a fourth attempt | carried | worker-loop rule 36 |
| HD:1787 | Every stop reason names next action; `vacuous_tests`, `rebase_conflict`, `integration_failed` carry remedy | carried | worker-loop rules 31–32; OQ1 environment class |
| HD:1794 | GateFailure shape: gate, location, expected, actual, minimalRepro, suggestedAction | carried | gates rule 19, GT-M6-6 |
