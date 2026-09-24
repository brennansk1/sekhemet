# Design trace: the 2026-09-17 design into design v3

*This is the check that design v3 lost nothing from the design of 2026-09-17 (`HARNESS_DESIGN.md`), its companions (`PM_DESIGN.md`, `FRONTEND_DESIGN.md`, `INTEGRATION_REVIEW.md`) or the three feature inventories. Every normative item those documents held is listed here with where it lives now, or why it does not. The old files are at `fb59ba2` (`git show fb59ba2:docs/design/HARNESS_DESIGN.md`); the raw traces, with each item's full text, are in [trace_sources/](trace_sources/). Checked against the specs at `8b5ccb9`.*

## 1. What this is, and how it was checked

**Method.** Four traces went through each old source from top to bottom (2026-09-22). Each extracted every normative item: a capability, behaviour, mechanism, number, threshold, field, command, UI state or edge case. Each item was classified against the new documents as `carried`, `carried-weaker`, `gap`, `later`, `contradicted` or `missing`. Fix passes then worked on every row that was not `carried`, following the lead's rulings ([DEC-25](../design/DECISIONS.md), R1–R28), and an independent review revised the specs again (`8b5ccb9`). This verification re-read the spec text for **every row that was not `carried`** (723 rows), without relying on the fix passes' own reports.

The 1,425 rows first traced as `carried` keep the trace's location. They were not re-read one by one. Instead they were swept for the decisions taken after the traces ran: DEC-24's later rows, DEC-26 (one vocabulary for kind and run), DEC-27 (token budgets) and DEC-28 (one admission rule). Six that those decisions changed are re-marked `deliberate`. Final statuses:

- `carried` — the spec states the item with its original precision;
- `gap` — carried as a capability that is not built yet, with a change ID and acceptance criteria;
- `deliberate` — changed on purpose, with the reason written in the spec's §9, in [DECISIONS](../design/DECISIONS.md) (DEC-24 lists the reversals, DEC-25 the rulings) or in the owning spec's own text;
- `later` — in a spec's §7 Later (or SPINE's "Not in v1", or OPEN_QUESTIONS), with a reason;
- `still-weaker` / `still-missing` — not resolved; listed in §2.

Rows that rested on a decided: no "plan exists" condition (DEC-29; kernel K-N5-8) were settled on 2026-09-24 by [DECISIONS](../design/DECISIONS.md) DEC-29 (O1–O14); rows that still depend on an open owner decision (O15–O27) name it and its default.

**Row keys.** `HD1:n` and `HD2:n` are rows *n* of [trace_hd1.md](trace_sources/trace_hd1.md) and [trace_hd2.md](trace_sources/trace_hd2.md), counted in order; HD2 also covers `INTEGRATION_REVIEW.md`. `PMFE:n` is row *n* of [trace_pm_fe.md](trace_sources/trace_pm_fe.md). `INV:<unit>` is the unit id in [trace_inv.md](trace_sources/trace_inv.md): `O` rows are the original inventory's "features most likely to be overlooked", and `D` rows are the re-audit's defects. In the Old column, `HD:`, `IR:`, `PM:`, `FE:` and `FI:` give the line in the old file. A rule number is a §2 item in the named spec. Items are shortened here; the full text is in the trace files.

**Totals.**

| Source | Items | Not `carried` when traced | `carried` | `gap` | `deliberate` | `later` | `still-weaker` | `still-missing` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `HARNESS_DESIGN.md` | 1109 | 335 | 826 | 95 | 87 | 101 | 0 | 0 |
| `INTEGRATION_REVIEW.md` | 75 | 65 | 21 | 50 | 3 | 1 | 0 | 0 |
| `PM_DESIGN.md` | 290 | 104 | 266 | 0 | 18 | 6 | 0 | 0 |
| `FRONTEND_DESIGN.md` | 256 | 93 | 219 | 12 | 18 | 7 | 0 | 0 |
| The three `FEATURE_INVENTORY` files | 418 | 126 | 331 | 31 | 40 | 16 | 0 | 0 |
| **All** | 2148 | 723 | 1663 | 188 | 166 | 131 | 0 | 0 |

## 2. Still open

None. The three rows the verification left open were resolved by the lead on 2026-09-24:
- **HD2:488** → `gap`: [planner-pm](../design/specs/planner-pm.md) NEW-planner-pm-8 (dependencies only from what a card declares, names or imports; never a blanket wait on a types card).
- **PMFE:221** → `deliberate`: [dashboard](../design/specs/dashboard.md) §2.11 now shows DEC-28's paired-credit retirement; PM_CONTRACT §6 marks the counts as today's behaviour with the target in its §0.
- **INV:O104** → `deliberate`: [DECISIONS](../design/DECISIONS.md) DEC-25 R29 (the `relay-finisher` role left with the relay protocol; `suspended-quota` stays).

## 3. Moved to Later (confirmed by the owner, DEC-29, 2026-09-24)

131 items. Each sits in the named document's Later list with its reason, and returns only with the evidence or version that reason names. They are grouped by the document that holds them now.

**design-stage** (22) — HD2:87 Two research modes, Research Desk and Deep Research (serves; trigger;…; HD2:95 The Desk loads no model: a second slot of the Worker's server, same w…; HD2:98 Desk grades: Lookup (seconds, no model), Question (1–3 min, short too…; HD2:100 Speculative research: the planner writes each card's open questions a…; HD2:101 At project open, prefetch each package's `llms.txt`/doc sitemap into…; HD2:104 Context7 and DeepWiki as optional MCP sources: off by default, untrus…; HD2:106 Plan: sub-questions with a budget each, posted as a decision request…; HD2:108 Everything fetched lands in the corpus index that later stages read; HD2:111 Crawling within a doc site uses an adaptive strategy that stops when…; HD2:120 Crawl4AI warm headless-browser sidecar: JS rendering, question-keyed…; HD2:121 Static-page fast path: HTML to markdown with trafilatura; HD2:122 PDFs: pypdfium2 by default, Docling for scanned or table-heavy pages;…; HD2:127 Persistent project corpus over dependency docs, refreshed when the ma…; HD2:128 Per-question corpus for each deep run, so synthesis can quote a sourc…; HD2:144 Answers from external MCP research services are untrusted like fetche…; HD2:148 The Planner additionally sees `plan_research(card)`; HD2:149 Research playbooks as Agent Skills (library upgrade, CVE triage, comp…; HD2:150 Deep Research evaluated on DeepResearch Bench RACE and FACT plus exec…; HD2:151 Desk measured on latency per grade and on how often an answer reachin…; HD2:152 Cache TTL by mutability: pinned SHA indefinite; pinned-version docs i…; HD2:153 A stale cache entry is served immediately and revalidated in the back…; INV:X9 Doc cache TTLs.

**integrations** (19) — HD1:156 Still deferred: remote control from mobile beyond notifications; HD1:157 Still deferred: team chat entry points; HD2:51 Forgejo as the offline-friendly self-hosted sync target: issues, depe…; HD2:63 CI as a gate source: existing CI checks declared as gates, run locall…; HD2:72 `issue_comment.created` with `/plan`, `/split`, `/estimate`,…; HD2:75 `workflow_dispatch` enqueues a local card run within declared hours; HD2:83 Review comments create repair subtasks scoped to line ranges; the Wor…; HD2:85 Release card: aggregate accepted cards since the last tag,…; PMFE:187 Jira and Linear live sync (OS keychain token); PMFE:189 Microsoft Teams; PMFE:190 Slack replies; PMFE:191 Sentry, Datadog, PagerDuty as card sources (bug-card proposals); PMFE:192 Notion and Confluence publishing (plans, run reports, decision logs;…; INV:Y11 Forgejo adapter; INV:Y17 Release cards; INV:Y18 CI via `act`; INV:O84 git-cliff changelog + semver on a release card; INV:O85 `act` for GitHub Actions as gates; INV:O89 `resolveReviewThread`; auto-merge; merge queue.

**extensibility** (16) — HD1:155 Still deferred: plugin marketplace; HD1:165 Plugin isolation and third-party versioning deferred past v1; HD2:62 An editor-protocol surface so external editors can drive a card; HD2:157 Skills are project- or user-scoped and versioned, and…; HD2:161 Commands: Markdown templates expanding into a card template or planne…; HD2:164 ACP lets VS Code, JetBrains and Neovim open a card, stream steps, ins…; HD2:171 Plugin API: register services, tools, gates, hooks, sync adapters or…; HD2:172 Plugin signing and compatibility contracts deferred until the kernel…; HD2:243 Open Agent Skills format; pull from the ecosystem…; HD2:245 Skill sources: Anthropic official (Skill Creator, document skills, fr…; HD2:246 Per-skill pull/adapt/build decisions (19 rows, e.g. brainstorming → i…; HD2:251 Every skill ships with at least one eval card; HD2:451 Open: plugin isolation and third-party signing; INV:K10 Reversible plugin manager; INV:H14 ACP editor surface; INV:O60 Every skill ships an eval card.

**dashboard** (14) — HD1:144 Rewind from card view: "rewind to step N", truncates nothing, invalid…; HD1:188 UI offers an explicit override (drag past a gate) recorded as a human…; HD2:312 A native wrapper is optional and deferred; HD2:329 Diffs grouped by conceptual intent ("Core Interface Definition", "Han…; PMFE:288 Saved-view sync waits for `/api/views`; PMFE:308 Goal view: burn-up, criteria, risk register; PMFE:503 Fonts: system fallback must look right; WOFF2 bundling optional; PMFE:534 Later: `POST /cards/:id/run` (Retry with planner); PMFE:537 Later: dependency lines overlay; PMFE:538 Later: bundled fonts; PMFE:540 Later: master board, Registry, Goals; PMFE:541 Later: difftastic intent grouping; INV:U17 Pan-and-zoom DAG; INV:U21 `IBoardUIState`.

**planner-pm** (14) — HD1:397 Terminal is default conversation surface; `sekhemet` opens it; board…; HD1:398 [RESEARCH] Calibrate ask-vs-assume on ClarEval; symmetric failure mod…; HD1:445 Steer: free text delivered at next step boundary as `card/steer`, no…; HD1:446 Scope amendment mid-card; Worker told; HD1:448 Steer cannot relax gate, widen permission, accept; HD1:449 Steer recorded before delivery; steered outcome flagged, excluded fro…; HD1:450 Steering not required for correctness; HD1:451 Card state decides: attached human answers in seconds while Worker ho…; HD1:475 Human cmd: Reroute (force model or arm for a card); HD1:476 Human cmd: Explain evidence behind estimate, route or decision; HD1:484 `/goal <statement>` opens intake: restate, criteria, budget, assumpti…; HD1:497 Goal view: statement, criteria, burn-up, strategy graph, risk registe…; HD1:498 Goal with no state change in a configurable window is highlighted; HD2:489 C6: the tuner's 12-step cap (keeps 17 of 18 passes, cuts time 38%) is….

**context** (9) — HD1:26 Tree-sitter symbol-level support is v2; HD1:217 Line-level pruning with SWE-Pruner on gate host; HD1:236 MLX path: unified memory reuse, MTPLX native MTP heads; HD1:247 Learned line pruning (SWE-Pruner Pro); HD1:271 0.6B skimmer strips 40–60% of code lines; HD1:281 Exemplar source: accepted cards…; HD1:599 Offline optimiser in idle hours with planner as reflection engine; ke…; INV:C3 SWE-Pruner line pruning; INV:E9 Loop 3 prompt evolution.

**review-git** (9) — HD2:199 On acceptance, checkpoints squashed into…; HD2:205 Review comments on the PR flow back into the card thread; HD2:210 Squash policy per project (keep checkpoint history on main); HD2:334 A human edit in the worktree is a commit by a human actor (…; HD2:335 Gates re-run on a human-edited tree; HD2:336 The evidence bundle keeps the Worker's diff and the human's separately; HD2:337 The competence row records `passed_with_human_edit`, never an unatten…; HD2:338 Partial accept takes a subset of hunks; the rest becomes a new card w…; INV:S14 CoW worktrees + linked deps.

**worker-loop** (8) — HD1:267 Worker applies sketch mechanically via symbol replacement; HD1:276 Parallel pass@k on L/XL or overnight; k ∈ [2,4], T ∈ [0.4,0.7]; HD1:301 `repo`: tree, file at a ref, code search, releases between two versio…; HD2:15 N is capped, and the cap is per hardware tier; HD2:147 Worker research tools are read-only and never include `search`/…; HD2:256 `read` passes images and PDFs through to the vision path; HD2:263 Structural rewrite fallback with ast-grep for languages without a lan…; INV:O97 ast-grep fallback without a language server.

**gates** (5) — HD1:519 Evidence `structuralDiff` (difftastic); HD2:17 Local verifier to rank passing attempts / triage failing ones; only i…; HD2:220 Go and Java/Kotlin templates as Phase 3, with Java's slower LSP start…; HD2:297 hyperfine as the benchmark gate runner for performance criteria; HD2:298 typos as a source-code spelling gate in the hygiene layer.

**security** (4) — HD1:93 Air-gap kit with local package mirrors (npm, devpi, crates) + byte-id…; HD2:41 Restricted mode: read-only AST inspection, static analysis (typecheck…; HD2:229 Package mirrors (verdaccio, devpi, a crates mirror) pre-seeded from t…; HD2:242 Open: mirror seeding for transitive dependencies not in any lockfile.

**runtime** (3) — HD2:187 Overnight prompt optimiser when enabled; HD2:406 Request bodies: `split { strategy }`, `run { budgetOverride }`; HD2:438 Phase 4 deferred: the compliance pack.

**SPINE** (2) — HD1:150 IDE extension (VS Code over ACP) and TUI; HD2:437 Phase 4 deferred: RBAC and SSO, extra tracker adapters, multi-machine….

**models** (2) — HD1:80 Inference: llama.cpp / MLX, zero telemetry; HD2:449 Open: whether a local verifier earns its place on XL.

**DEC-03** (1) — HD1:41 Claim: cloud models after v1, plug into a role, never a requirement.

**OPEN_QUESTIONS** (1) — HD1:218 [BENCH] pruner CPU latency on 4-core host.

**measurement** (1) — HD1:616 IRT calibration against SWE-bench per-instance results (~10⁵).

**surface** (1) — HD2:226 Convention extraction combining `crag` linter/CI parsing with….

## 4. Deliberate changes

164 items changed on purpose. The last column says where each reason is recorded.

| Row | Old | Item | Reason recorded in |
| --- | --- | --- | --- |
| HD1:11 | HD:29 | Feature not traceable to the six paragraphs is a candidate for deletion | SPINE §Where the edge is (the test is now "serves one of the three edges"; DEC-01) |
| HD1:13 | HD:36 | Locked: target user = solo developer running local models | DEC-01 |
| HD1:28 | HD:60 | Non-goals v1: teams, multi-user boards, RBAC, SSO | DEC-06 (company-server minimum in v1; RBAC and SSO stay out) |
| HD1:78 | HD:214 | Parity claim: matches top five except cloud scale and cloud latency | specs/README "Where the old design went" (dated competitor columns removed) |
| HD1:119 | HD:291 | TypeScript SDK with async-iterator event streams | extensibility rule 28, §8 Q1 ("changed from the old design's shipped SDK") |
| HD1:122 | HD:307 | Headless LSP expansion stage | context rule 28, §9 |
| HD1:123 | HD:307 | Masking tool outputs older than 2 steps with 15-token pointers | context rule 3; DEC-24 |
| HD1:124 | HD:315 | Per-card worktrees with copy-on-write cloning | DEC-21 (plain worktrees) |
| HD1:125 | HD:315 | Checkpoint commits on every passing step | review-git rule 3, §9 (every step that changed files; R1) |
| HD1:136 | HD:329 | EvidenceBundle with difftastic enabling "5-second human acceptance" | review-git rule 2, §9 (a decision in under a minute); structural diff rule 6 (partial, S5) |
| HD1:158 | HD:362 | Every capability is a plugin claiming a service key (Cordis) | extensibility rule 29, §7 (plugin API later), §8 Q2 (container cut in B0 (DEC-29 O4)); SPINE packages |
| HD1:163 | HD:398 | Turn-flow events: card/start, step/start, context/assembled, model/request, model/response, tool/call, tool/r… | kernel §3 closing note (never the code's; mapped) |
| HD1:196 | HD:505 | Edge Review→InProgress on human change request | review-git §2.4, §9; DEC-24 (send back to Ready) |
| HD1:200 | HD:518 | InProgress entry: plan exists; acceptance tests written and failing (types-only card red on typecheck); scope… | kernel rule 27, §8 Q6 (decided: no "plan exists" condition (DEC-29; kernel K-N5-8)) |
| HD1:216 | HD:550 | LSP expansion stage, headless servers pooled per project | context rule 28, §9; pool backs tools (worker-loop 12) |
| HD1:221 | HD:563 | Zone 4 = card spec, criteria, scope, open TODOs, latest observation, re-injected goal | context rule 8, §9 (M8) |
| HD1:226 | HD:573 | `run` routes commands through the RTK binary | context rule 17 (native condenser; binary on no v1 path) |
| HD1:232 | HD:590 | llama.cpp: `--cache-ram` 8–16 GiB, `--ctx-checkpoints 32`, `--checkpoint-min-step 8192` | context rule 6, §9; DEC-24 |
| HD1:233 | HD:590 | Slot prefix similarity `-sps` | context rule 6; DEC-24 |
| HD1:248 | HD:620 | Zone caps: Z1 ≤0.12W, Z2 ≤0.10W, Z3 ≤0.50W, Z4 remainder ≥0.20W; shrink map, drop symbols, fail Ready | context rule 10; DEC-27 (Zone 1 fixed in tokens, ≤ 2,400 incl. schemas; the other zones as fractions of W − 2,400) |
| HD1:249 | HD:626 | Observation masking: older than last two replaced in place | context rule 3; DEC-24 |
| HD1:254 | HD:631 | Reasoning traces stripped between steps unless model registered as benefiting | context rule 4, §9; DEC-24 |
| HD1:265 | HD:683 | Localization stage 2: LSP expands defs/refs/signatures for declared scope | context rule 28, §9 |
| HD1:272 | HD:701 | Observation masking older than 2 steps | context rule 3; DEC-24 |
| HD1:286 | HD:734 | 2026 cache flags (8–16 GiB, 32 checkpoints, 8192 min-step, -sps) | context rule 6; DEC-24 |
| HD1:287 | HD:735 | Native MTP 1.6×–2.6× decode speed-up | models rule 13, §9 (1.6–2.6× claim withdrawn; ~1.28× decode with a prefill penalty measured) |
| HD1:312 | HD:782 | Both terminate the turn immediately | worker-loop rule 18, §9 |
| HD1:321 | HD:794 | Six is the vocabulary; new conditions are details, not new members | worker-loop rule 31, §9; DEC-24 (23 stored reasons in one table, seven failure classes and one success class) |
| HD1:325 | HD:802 | Rung 3: narrow scope or escalate one model tier (competence model chooses); re-decomposition only at rung 4 | worker-loop rule 34.3, §7, §9 |
| HD1:329 | HD:809 | Prior reasoning stripped between steps unless registry notes benefit | context rule 4; DEC-24 |
| HD1:332 | HD:821 | Winner = best pass rate for wall-clock, same build/model, ≥2 runs | measurement rule 12, §8 Q1, §9 (paired; the cheaper arm wins a tie) |
| HD1:348 | HD:854 | Edit: unique match; `replace_all` for renames; exact whitespace/line endings | worker-loop rule 12, §9 |
| HD1:367 | HD:898 | SPIDR Interface = type contracts/schemas first | planner-pm §2.2, §9 |
| HD1:370 | HD:904 | INVEST pre-flight before Planning → In Progress | planner-pm §2.4, §9; DEC-24 |
| HD1:375 | HD:912 | Small: pack ≤25% of tier working context; step budget ≤40 | planner-pm §2.4, §9; DEC-24 (INVEST Small: 25% of the resolved Worker's window, 4,096 of 16,384; P1 PM-12, PM-13) |
| HD1:379 | HD:923 | Estimates in tokens, seconds, steps; never story points | planner-pm §2.6, §9 |
| HD1:394 | HD:956 | Conversation never evicts a running Worker; reply waits for step boundary | planner-pm §2.8.6, §9 |
| HD1:395 | HD:957 | Conversation has no memory of its own; no user profile | planner-pm §2.13.3, §9 |
| HD1:412 | HD:1020 | Riskiest assumption scheduled first regardless of backbone | design-stage §9; planner-pm §2.2.4 |
| HD1:444 | HD:1105 | Format interactions for rapid "5-second approvals" | review-git rule 2, §9 (a decision in under a minute, not 5 seconds) |
| HD1:454 | HD:1134 | Durable resume on answer (UI, CLI, notification webhook): `decision/answered`, rehydrate context, resume | planner-pm §2.10.3, §9; DEC-24 (a late answer returns the card to Ready, or to Backlog or Planning if parked from there) |
| HD1:456 | HD:1142 | Questions batched into one decision request per planning pass | planner-pm §2.10.1, §9 |
| HD1:457 | HD:1142 | >3 questions → spec rejected as under-specified | planner-pm §9; DEC-24 |
| HD1:493 | HD:1291 | Signal: ≥3 gate failures in one file → pause implementation, route to Planner to re-split on Interface/Data | planner-pm §2.12, §9 |
| HD1:593 | HD:1607 | System prompt short; <1,000 tokens; tool interface <2,000 | context rule 10; DEC-27 (system prompt ≤ 700, tool interface ≤ 1,700 tokens) |
| HD1:618 | HD:1702 | One mechanism: signal → bounded proposal → suite → pinned → auto-rollback if pass rate drops… | measurement rule 18(3), §9; DEC-24 (paired rollback) |
| HD1:623 | HD:1737 | Guardrail 3: atomic rollback over moving ten-card window | measurement rule 18; DEC-24 |
| HD1:637 | HD:1763 | `sekhemet dev audit` command | measurement rule 24, §9 (dev audit's function in doctor and qualify) |
| HD1:639 | HD:1765 | Context debt: >300 Zone-2 tokens without significant ≥+3% gain | measurement rule 24; DEC-28 (context debt judged on paired credit or a "not established" A/B; the 3-point test cannot be resolved on 30 cards) |
| HD1:644 | HD:1782 | Rung 3 narrowed scope or escalated model, chosen by competence model | worker-loop rule 34.3, §7, §9 |
| HD2:21 | HD:1837 | Linux: user namespaces + Landlock path restrictions + seccomp-bpf syscall filters | security rule 17; DEC-21 (bubblewrap; Landlock and seccomp as hardening) |
| HD2:29 | HD:1845 | Worktrees made by copy-on-write cloning (APFS, reflink on Btrfs/XFS) | security rule 24a; DEC-21 (plain worktrees) |
| HD2:49 | HD:1891 | Shared-field conflicts: last-writer-wins by timestamp, loser kept in card history | integrations §2.4 |
| HD2:64 | HD:1911 | Externally edited issue mid-card: non-scope fields reconciled on completion; a scope/criteria change pauses t… | integrations §2.5, §9 (R6), INT-11a |
| HD2:67 | HD:1921 | Private keys and tokens in the OS keychain, never written to disk or config files | integrations §2.10; security item 35 |
| HD2:154 | HD:2186 | Every extension mechanism is a plugin on the kernel | extensibility rule 29, §7, §8 Q2 (O4); DEC-09 correction |
| HD2:170 | HD:2226 | A TypeScript SDK exposes these operations, with the event log as an async iterator | extensibility rule 28, §8 Q1 ("changed from the old design's shipped SDK"; publish or cut is owner decision O4) |
| HD2:177 | HD:2252 | Checkpoints: the Worker commits after every gate-passing step and every masked-observation boundary | review-git rule 3, §9 (R1); runtime rule 11 links to it |
| HD2:211 | HD:2344 | Onboarding step 1: build the tree-sitter repo map and cache it | surface rule 9; DEC-20 (map from the TypeScript compiler; tree-sitter later, surface §7) |
| HD2:274 | HD:2496 | Parse gate wraps tree-sitter | gates §9; DEC-20 |
| HD2:278 | HD:2504-2507 | Console/network/DOM and layout-bounds checks over Playwright; screenshot diff with Playwright + pixelmatch; a… | gates §9, §8 Q1 (the in-house client stays the gate; Playwright and axe-core approved for development only, DEC-29 O5; axe-core in the product gate is owner decision O27, default no — was pending the owner, R16; behaviours kept rule 29) |
| HD2:299 | HD:2578-2579 | mise (pinned toolchain environments) and lefthook (git hooks manager) | PROVENANCE (mise, lefthook: not used, the repository's own `.githooks/` instead) |
| HD2:300 | HD:2542-2543, 2572 | DevDocs and Kiwix as offline documentation services; Dozzle as a container log viewer | PROVENANCE (DevDocs, Kiwix, Dozzle: not used — the kit's own docs bundle, no containers in v1) |
| HD2:307 | HD:2615 | kWh computed from hardware TDP and GPU utilisation | runtime rule 18, §7, §9 |
| HD2:313 | HD:2625 | Three views are the product (Review, Board, Card); the rest appear when they have something to say | dashboard §9 (five primary views always, for three audiences) |
| HD2:317 | HD:2635 | Machine appears when a run is active, or from the status line | dashboard §9 (always in the System menu) |
| HD2:319 | HD:2640 | Insights appears only after enough cards for a trend (the competence model's threshold) | dashboard §9 (teaching empty state) |
| HD2:320 | HD:2641 | Integrations appears when one is configured, or from settings | dashboard §9 (always listed) |
| HD2:333 | HD:2662 | Every return reason automatically feeds candidate playbook rules | review-git §2.4, §9 (only an actionable note becomes a candidate; arXiv 2502.02757) |
| HD2:339 | HD:2676 | Headless dual-axis virtualisation via `@tanstack/virtual` | dashboard §9 (own windowing, no build step) |
| HD2:343 | HD:2683 | Card steps stream over a local WebSocket `ws://127.0.0.1:4040/stream` | runtime rule 25, §9 |
| HD2:350 | HD:2707-2723 | Colour token table: 15 roles with hex values per theme and APCA/WCAG figures | dashboard §2.13.1, §9 (values only in `tokens.ts`, held by the contrast test) |
| HD2:357 | HD:2759 | Card tile: title, class chip, difficulty, budget bar (tokens/seconds), one box per gate,… | dashboard §9 (professional tile) |
| HD2:366 | HD:2782 | No environment-variable layer: only `SEKHEMET_CONFIG_DIR` and `SEKHEMET_MODELS_DIR` are honoured | surface rule 27 (about 45 variables classified; only the two bootstrap ones shown to users) |
| HD2:372 | HD:2801 | `fetch_allow = ["nodejs.org"]` default | surface rule 23 (fetch_allow starts empty, with the reason) |
| HD2:373 | HD:2804 | `[overnight] hours = "18:00-08:00"`: when unattended runs may use the machine | surface rule 23 ([machine] reserved_hours replaces [overnight] hours, with the reason) |
| HD2:377 | HD:2815 | Actor set of seven: human, planner, worker, reviewer, researcher, gate, system | kernel rule 19, §9 |
| HD2:388 | HD:2925 | `cards.priority REAL` holds the WSJF score | planner-pm §2.7, §9 |
| HD2:397 | HD:3047 | `[project] languages = [...]` key | gates §3 (`languages` dropped: detected from manifests, recorded in evidence) |
| HD2:407 | HD:3119 | M0 spike: ≥ 90% valid-and-correct tool execution across 30 seeded tasks (3 runs each, budgets 50 and 150) und… | measurement rule 28 (M0 bar historical; protocol in `sekhemet m0`) |
| HD2:419 | HD:3164-3345 | Package interface contracts (IEventLog, IProjectionEngine, IServiceContainer, IBoardEngine, IDependencyDAG, I… | specs/README "Where the old design went" (interfaces replaced by the code's types in each Contract) |
| HD2:424 | HD:3352 | Synthetic git fixtures across TS, Python and Rust; `createTestWorktree()` clones one in under 10 ms | DEFINITION_OF_DONE §2D.3 (the < 10 ms target assumed in-memory SQLite; real repositories required); multi-language fixtures later, measurement §7 |
| HD2:425 | HD:3353 | All unit and integration tests on in-memory SQLite (`:memory:`), setup under 5 ms per file | DEFINITION_OF_DONE §2A (real on-disk SQLite) |
| HD2:426 | HD:3354 | The whole monorepo unit suite runs in under 3 seconds | DEFINITION_OF_DONE §2D.4 (the 3 s target kept as history; speed never bought with mocks) |
| HD2:428 | HD:3372-3380 | Phase 0 spike: 30 tasks × 3 runs × 3 arms at budgets 50/150; go ≥ 90%, rework 70–90%, pivot < 70% (narrow to… | measurement rule 28 (the pivot rule is owner decision O20, default: a standing decision) — was: §8 Q4 (pivot rule proposed as a standing decision, owner) |
| HD2:436 | HD:3412 | Phase 4 deferred: teams and multi-user | DEC-06 |
| HD2:439 | HD:3416 | Scoping rule: anything not feeding the gates → failure data → decomposition/routing → reproducibility loop is… | SPINE §Where the edge is; DEC-01 |
| HD2:473 | IR:114-117 | B1: on the benchmark nothing learned reaches the Worker (fresh `events.db`; approval needed; only playbook.to… | measurement rule 6, §9; ruling R12 (isolation in measurement runs; production probation in context rule 24f) |
| HD2:513 | IR:226 | Suggestion 8: in-run probation for executable-verified learning (a config constraint, a remedy keyed to an er… | context rule 24f, measurement rule 6, §9; ruling R12 (probation in production only); NEW-context-4 (CX-N4-7) |
| HD2:520 | IR:234-239 | Batch sequence on 24 GB: Worker pass → Researcher (every unexplained struggle, with card and code) → Seshat (… | review-git §2.3.2, §9 (Reviewer once per queue pass, after retries, before Review); swap order models rule 20a |
| PMFE:4 | PM:20 | Priority glyph language: bars High/Med/Low, boxed exclamation Urgent, three dashes for none | dashboard §9 |
| PMFE:11 | PM:22 | Epics appear as swimlanes, filter and table column, never as a separate hierarchy screen | dashboard §9 (story map is a view of the cards) |
| PMFE:47 | PM:62 | Panel header always shows Seshat · Project manager · dirk-27b so the user sees the correct model | dashboard §8.3, §9; R15 |
| PMFE:49 | PM:64 | Worker, when quoted, uses the same avatar shape with "W"; You use your git initial | dashboard §2.4.4, §9; NAMING; R10 (roles no avatar; a person keeps an initials monogram) |
| PMFE:67 | PM:157 | Full view `#/pm` on chord `g a` | dashboard §2.3.1, §9 |
| PMFE:87 | PM:201 | Idle cost line Seshat runs locally on dirk-27b. Replies take about a minute. | dashboard §2.7.6, §9; R15 |
| PMFE:124 | PM:292 | Tile row 1: priority · kind · labels (max 2, +n) · points · id | dashboard §9 |
| PMFE:125 | PM:300 | Priority glyph in a fixed 12 px slot at the far left so priorities scan as a column | dashboard §9 (List view scans priority) |
| PMFE:149 | PM:353 | Rails still collapse empty columns board-wide | dashboard §9 (chips) |
| PMFE:170 | PM:390 | Integrations `#/integrations` on `g s` | dashboard §2.3.1, §9; R17 (`g n`) |
| PMFE:194 | PM:420 | Integrations 404: sections still render from the catalogue; Now cards Not available on this server yet, no… | dashboard §9 |
| PMFE:198 | PM:440 | Insights `#/insights` on `g f` | dashboard §2.3.1, §9 |
| PMFE:217 | PM:485 | Everything learned is context not weights, from gate results and human actions, on the ledger,… | planner-pm §2.13.3, §8.1 (profile statements: owner decision O24, default used at once; rules need approval; was awaiting the owner) |
| PMFE:234 | PM:505-510 | Seshat's review (`card/review`) between Gates and Failures; count title; advice, not a gate line;… | review-git §2.3.5, §9 (the Reviewer, not Seshat; shown first); advisory line and order kept in dashboard §2.5.3 |
| PMFE:250 | PM:536 | Four roles: Worker; Seshat · PM; Adversarial reviewer (different family); Researcher (Apodex-1.1-mini, cites… | models rule 21; DEC-05 (roles are Worker, Planner, Reviewer, Researcher; Seshat is the persona on the Planner's weights) |
| PMFE:259 | PM:554 | `#/pm` on `g a` | dashboard §2.3.1, §9 |
| PMFE:261 | PM:557-558 | `g f` Insights, `g s` Integrations | dashboard §2.3.1, §9; R17 |
| PMFE:314 | FE:60 | Tile: class chip, difficulty, token/second budget bars, dependency badge | dashboard §9 |
| PMFE:343 | FE:147 | Runs `#/runs[/:runId]` on `g q` | dashboard §2.3.1; R17 (`g u`) |
| PMFE:345 | FE:150 | Playbook on `g p` | dashboard §2.3.1; R17 (`g k`) |
| PMFE:346 | FE:151 | Inbox `#/inbox` `g i`, hidden until `/api/decisions` returns 200 | dashboard §2.2.1, P11 (merged into Review › Needs you; §9 records the chord change, not a separate reason for the merge) |
| PMFE:352 | FE:162 | 1024–1279 px: 52 px icon rail, tooltips, count badges | dashboard §9 |
| PMFE:353 | FE:163 | < 768 px: bottom tabs Review, Board, Runs; single-column board with switcher; Evidence only; 48 px one-ta… | dashboard §9 |
| PMFE:359 | FE:183-190 | Kind mapping Interface→Contract, Data→Storage, Path→Flow, Rule→Rules, Spike→Research, Visual→UI, Integration→… | DEC-26 (one kind map in NAMING; SPIDR is the split axis, R9); dashboard §2.12.4 |
| PMFE:360 | FE:191-199 | Column names Backlog, Ready, Planning, Working, Checking, Review, Done, Parked (visible), Closed (only if non… | dashboard §2.4.1, §8.2; NAMING |
| PMFE:376 | FE:247 | Empty Review copy ends with the command `sekhemet queue` | dashboard §2.5.13, §9 |
| PMFE:414 | FE:368 | Empty columns collapse to 36 px rails (after 5 min empty; Done below 1600 px) | dashboard §9 |
| PMFE:425 | FE:388 | Empty board: No cards yet + `sekhemet plan …` and the fixture seed command | dashboard §2.4.10, §9 |
| PMFE:430 | FE:407 | Tabs 32 px with a 2 px `--accent` underline on the active tab | dashboard §2.6, §9 (underline in --text-primary; gold kept to four places) |
| PMFE:459 | FE:504 | Row 1 kind tag · short id | dashboard §9 |
| PMFE:462 | FE:516 | Ready: Ready · 32-step budget | dashboard P3, §9 |
| PMFE:463 | FE:517 | Blocked: link icon in `--state-blocked`, Waits on X, title in `--text-secondary` | dashboard §2.4.4, §9; R11 |
| PMFE:471 | FE:529 | Difficulty diamond on the tile in comfortable density | dashboard §9 |
| PMFE:485 | FE:586 | Disabled = 40% opacity; reason in adjacent text, never only a tooltip | dashboard §2.13.2, §9 |
| PMFE:492 | FE:635-643 | Key additions: `g q`, `g l`, `g p`, `1–5`, `[ ]`, `u`, `n/N`, `f`, `t` theme, `z`, `/` | dashboard §2.3, §9 |
| INV:K9 | FI:53 / R2:79 | Service container | extensibility rule 29, §8 Q2 (container is reachable; trust-gated until the owner decides the cut, O4) |
| INV:K17 | FI:61 / R2:87 | `steps` table incl. `repo_state_hash`, `success`, `tokens_condensed` | kernel rule 6 (not stored, with the reason) |
| INV:S3 | FI:84 / R2:106 | Linux namespaces + Landlock + seccomp | DEC-21; security rule 17 |
| INV:Y3 | FI:108 / R2:126 | Commit after every gate-passing step and every masking boundary | review-git rule 3, §9 (R1) |
| INV:Y20 | FI:125 / R2:143 | Mid-card external-edit reconciliation | integrations §2.5, §9 (R6) |
| INV:M17 | FI:151 / R2:165 | Prompt-cache configuration | context rule 6; DEC-24 |
| INV:G1 | FI:169 / R2:179 | `gates.toml` parser and keys | gates §3 (schedule, threshold, languages each dropped or renamed with the reason) |
| INV:C5 | FI:211 / R2:215 | System < 1,000 tokens, tools < 2,000 | context rule 10; DEC-27 (≤ 700 / ≤ 1,700 tokens) |
| INV:C6 | FI:212 / R2:216 | Masking with ~15-token pointers + EvidenceRef | context rule 3; DEC-24 |
| INV:C18 | FI:224 / R2:228 | Reasoning traces stripped between steps | context rule 4; DEC-24 |
| INV:P2 | FI:310 / R2:293 | INVEST six checks, 25%, ≤ 40, > 7 | planner-pm §2.4; DEC-24 (Small sized to the resolved Worker's window; other checks unchanged) |
| INV:P8 | FI:316 / R2:299 | Assume/Ask/Spike; batch; > 3 questions rejects | planner-pm §2.10.1, §9; DEC-24 |
| INV:P11 | FI:319 / R2:302 | Pause & persist, VRAM released, rehydrate | planner-pm §2.10.2–3, §9; DEC-24 |
| INV:E1 | FI:343 / R2:322 | Pass@1 harness under the real loop; M0 protocol | measurement rule 28 (M0 protocol built, `m0.ts`; the ≥ 90% bar recorded as historical with the reason); pivot rule §8 Q4 |
| INV:E13 | FI:355 / R2:334 | Loop 7 variant archives | DEC-25 R31 (variant archive cut as dead code under DEC-09) |
| INV:E15 | FI:357 / R2:336 | Loop 9 tool synthesis | worker-loop §9 (register R6 triaged, not in v1); security §8 Q1 (recommend cutting `--validate-tools`) |
| INV:E17 | FI:359 / R2:338 | Guardrails; rollback over 10-card window | measurement rule 18, §9; DEC-24 |
| INV:U3 | FI:373 / R1:369 | Basalt/Sand exact values, light theme | dashboard §2.13.1, §9 |
| INV:U13 | FI:383 / R1:379 | Card tile components | dashboard §9 |
| INV:H13 | FI:413 / R2:358 | SDK with async iterator | extensibility rule 28, §8 Q1 (O4) |
| INV:H25 | FI:425 / R2:370 | Offline installers, first-run wizard | DEC-21 (source installer); DEC-29 O9 (npm package and container image approved) |
| INV:X7 | FI:441 / R1:431 | Research note; embeddings only here | design-stage §2.7.8, §9; DEC-22 |
| INV:X21 | FI:455 / R1:445 | Fixture generator, `createTestWorktree` < 10 ms | DEFINITION_OF_DONE §2D.3 (the < 10 ms target assumed in-memory SQLite; real repositories required) |
| INV:X25 | FI:459 / R1:449 | Suite under 3 s | DEFINITION_OF_DONE §2D.4 |
| INV:X27 | FI:461 / R1:451 | Chronicle fixture and scorecard | measurement rule 28 (Chronicle bars kept as diagnostics, with the reason) |
| INV:X28 | FI:462 / R1:452 | Showcase Trifecta and its targets | measurement rule 28 (Trifecta targets superseded, with the reason) |
| INV:X29 | FI:463 / R1:453 | CHRONICLE `llama-server` profile | models rule 3a (Chronicle profile recorded and superseded by the DEC-04 Worker on 8098) |
| INV:O6 | FI:476 | Traces stripped unless registry flag | context rule 4; DEC-24 |
| INV:O15 | FI:485 | INVEST-S ≤ 25% and ≤ 40 steps | planner-pm §2.4; DEC-24 (25% of the resolved Worker's window, ≤ 40 steps) |
| INV:O17 | FI:487 | > 3 questions rejects the spec | planner-pm §9; DEC-24 |
| INV:O30 | FI:500 | Checkpoint at gate passes and masking boundaries | review-git rule 3, §9 (R1) |
| INV:O43 | FI:513 | CoW cloning + symlinked `node_modules`/`.venv` | DEC-21 (plain worktrees); security rule 24 (node_modules and `.venv` links) |
| INV:O44 | FI:514 | llama.cpp cache flags from the machine profile | context rule 6; DEC-24 |
| INV:O54 | FI:524 | Rollback on a moving 10-card window | measurement rule 18; DEC-24 |
| INV:O56 | FI:526 | Loop 9 signal: repeated bash chains | worker-loop §9 (register R6 triaged, not in v1) |
| INV:O72 | FI:542 | `[context] map_tokens = 1024`, `mask_after_observations = 2` | surface rule 25; context §9 ([context] keys removed) |
| INV:O73 | FI:543 | `[loop] default_step_budget = 40`, `stall_window = 3`, `max_rungs = 4` | surface rule 25 (step budget 40 kept; stall_window and max_rungs removed); worker-loop §9 |
| INV:O83 | FI:553 | Every return reason becomes a candidate rule | review-git §2.4, §9 |
| INV:O92 | FI:562 | LWW by timestamp, loser in history | integrations §2.4 |

## 5. Every row, by source

Columns: row key · old location · item (shortened) · status when first traced · final status · where it lives now.

### 5.1 `HARNESS_DESIGN.md`

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| HD1:1 | HD:17 | Mission: spec → diff surviving checks nobody could edit; records enough that next attempt is cheaper | carried | carried | SPINE §What Sekhemet is, spine 1–2 |
| HD1:2 | HD:19 | A card owns one worktree, branch, declared scope, deterministic context, budget, attempt, evidence bundle, measured out… | carried | carried | SPINE spine 3; kernel §2 |
| HD1:3 | HD:19 | Same card + same repo → byte-identical prompt (prefix cache + honest measurement) | carried | carried | context §2.1 rule 1; CX-1 |
| HD1:4 | HD:21 | Event log is the only durable channel; model-visible means logged, enforced at runtime | carried | carried | SPINE spine 2; kernel rule 15 |
| HD1:5 | HD:21 | Board, replay, fork, audit trail, competence model are projections of the one stream | carried | carried | SPINE spine 2; kernel rule 14 |
| HD1:6 | HD:23 | Every column boundary is an entry condition decided by an executable gate, never the model | carried | carried | SPINE spine 1; kernel rule 21 |
| HD1:7 | HD:23 | Failure → one typed shape; top few reach the model, rest in evidence by reference | carried | carried | gates rules 19–20 |
| HD1:8 | HD:25 | Human is the rate limiter: review minutes → Review WIP → back-pressures Verify → Worker | carried | carried | SPINE spine 4; review-git §2.2 |
| HD1:9 | HD:27 | Learning only from recorded signals; spent only in the stable prompt zone at a card boundary | carried | carried | SPINE consequence 1; context rule 23 |
| HD1:10 | HD:27 | Imported prior never admitted as a change; only sets a starting value the first local signal overrules | carried | carried | measurement rule 22 |
| HD1:11 | HD:29 | Feature not traceable to the six paragraphs is a candidate for deletion | carried-weaker | deliberate | SPINE §Where the edge is (the test is now "serves one of the three edges"; DEC-01) |
| HD1:12 | HD:35 | Locked: 100% local inference in v1 | carried | carried | DEC-03; SPINE Locked |
| HD1:13 | HD:36 | Locked: target user = solo developer running local models | contradicted | deliberate | DEC-01 |
| HD1:14 | HD:37 | Locked: hardware 16–128 GB self-calibrating | carried | carried | SPINE Locked; models §2 rule 8 |
| HD1:15 | HD:38 | Locked: four roles as registry entries, never agents/personas; swapped small, co-loaded large | carried | carried | SPINE §Roles; models rules 21–22; DEC-05 |
| HD1:16 | HD:39 | Locked: fresh context per card; no long-running session | carried | carried | SPINE Locked; runtime rule 1 |
| HD1:17 | HD:40 | Locked: done = executable gates only; agent never certifies own work | carried | carried | SPINE Locked ("gates and a person's acceptance") |
| HD1:18 | HD:41 | Locked: offline by default; git remotes and GitHub sync opt-in adapters | carried | carried | SPINE Locked; security rule 29 |
| HD1:19 | HD:42 | Locked: TypeScript throughout v1 | carried | carried | SPINE Locked; DEC-20 |
| HD1:20 | HD:43 | Rejected on evidence: Scrum-role agents, parallel same-file writers, self-refine, debate, unbounded best-of-N, embeddin… | carried | carried | DEC-22 (all nine present) |
| HD1:21 | HD:51 | Substitution: bubblewrap on Linux instead of Landlock+seccomp; isolation level recorded per card | carried | carried | DEC-21; security rules 8, 17 |
| HD1:22 | HD:52 | Substitution: plain git worktrees instead of copy-on-write clones | carried | carried | DEC-21; security 24a |
| HD1:23 | HD:53 | Substitution: keyword heuristic pruner; SWE-Pruner deferred behind random-dropping null baseline, else row removed | carried | carried | DEC-21; context Later; measurement rule 16, MS-T7-6 |
| HD1:24 | HD:54 | Substitution: source installer instead of packaged offline installers | carried | carried | DEC-21; security rule 45 |
| HD1:25 | HD:56 | Python/Rust/Go degrade to flat map + unchecked parse, stated on card and evidence; functional gate templates kept | carried | carried | DEC-20; surface rule 30, SUR-33 |
| HD1:26 | HD:56 | Tree-sitter symbol-level support is v2 | later | later | context §7; DEC-20 |
| HD1:27 | HD:56 | Harness may do less for a language but never claim to have checked | carried | carried | SPINE consequence 2 |
| HD1:28 | HD:60 | Non-goals v1: teams, multi-user boards, RBAC, SSO | contradicted | deliberate | DEC-06 (company-server minimum in v1; RBAC and SSO stay out) |
| HD1:29 | HD:60 | Non-goals v1: compliance pack; Azure DevOps connector | carried-weaker | carried | SPINE "Not in v1"; runtime §7; integrations §7 |
| HD1:30 | HD:60 | Non-goals v1: Jira/Linear connectors | carried | carried | SPINE Not in v1 (live two-way sync); integrations rule 19 (export/import only) |
| HD1:31 | HD:60 | Non-goals v1: multi-machine inference pooling, any cloud model path | carried | carried | SPINE Not in v1; models Later |
| HD1:32 | HD:68 | Voice: plain, exact, calm; never "done" for "I think so"; verbs and numbers; no exclamation; name the gate | carried | carried | SPINE §Voice |
| HD1:33 | HD:72 | Naming: Workspace, Project/Card/Subtask, Gates, Evidence, Playbook, four roles, Inbox | carried | carried | NAMING.md (referenced); dashboard §nav (Inbox merged into Review › Needs you) |
| HD1:34 | HD:112 | Claims table: machine built / server partial (127.0.0.1 only, writer = "human", gate host certs localhost) | carried | carried | SPINE claims table (server "not built"); DEC-06; integrations |
| HD1:35 | HD:113 | Claim: whole process built with gaps (Worker method, story map, burn-up) | carried | carried | SPINE claims; dashboard P3 |
| HD1:36 | HD:114 | Claim: fits PM practice partial (Jira/Linear CSV, GitHub JSON export, Slack; no live sync; no familiar card anatomy) | carried | carried | SPINE claims; integrations rule 17; dashboard P3 |
| HD1:37 | HD:115 | Claim: teaching beginners not built; Learn layer planned | gap | gap | dashboard §2.9, P4 |
| HD1:38 | HD:116 | Claim: non-devs talk to PM partial; start-by-conversation not built | gap | gap | planner-pm §2.9, P2; design-stage P2 |
| HD1:39 | HD:117 | Claim: choose each role's model, managed llama-server or any Ollama tag | carried | carried | models rules 14, 26; MD-N4-3 |
| HD1:40 | HD:118 | Claim: frozen suite and bake-off built; SWE-rebench not integrated | carried | carried | SPINE claims; measurement Later (SWE-rebench mining) |
| HD1:41 | HD:119 | Claim: cloud models after v1, plug into a role, never a requirement | later | later | DEC-03; models §7 |
| HD1:42 | HD:123 | Pillar 1: zero telemetry, offline-capable install | carried | carried | runtime rules 31, RUN-33; security air-gap |
| HD1:43 | HD:124 | Pillar 2: automatic model selection, scheduled swaps, overnight mode | carried | carried | models rules 20, 26; runtime rule 17 |
| HD1:44 | HD:125 | Pillar 3: tolerant tool interface, symbol edits, parse gate, assembled context, fresh per card, planner/Worker cascade | carried | carried | models rule 28 (arm B); worker-loop rules 12, 14; context §2 |
| HD1:45 | HD:126 | Pillar 4: nested boards, decomposition to competence envelope, dependency scheduling, token/time accounting, WIP tied t… | carried | carried | planner-pm §2.4–2.6; kernel rules 3, 23 |
| HD1:46 | HD:127 | Pillar 5: per-column gates with status rollup and evidence bundle | carried | carried | kernel rules 21, 24; gates rule 35 |
| HD1:47 | HD:128 | Pillar 6: git-native, GitHub and Forgejo sync, AGENTS.md/CLAUDE.md, MCP and ACP, existing CI as gate source | carried | carried | integrations; surface rules 5.3, 9; extensibility |
| HD1:48 | HD:132 | Structural advantage: compute accounting (tokens, time) | carried | carried | runtime rules 18, 32; planner-pm §2.6 |
| HD1:49 | HD:136 | Claims not to make: frontier parity on ambiguous work, guaranteed correctness, unmeasured benchmarks, nonexistent compl… | carried | carried | SPINE §Never claim |
| HD1:50 | HD:140 | Simplicity bar = Claude Code (one command, conversation, permission prompt, unread project file) | carried | carried | surface §1 |
| HD1:51 | HD:146 | Six day-one concepts: card, accept/send back, gates, evidence, model pair, repository | carried | carried | surface rule 1 ("the models" replaces "model pair") |
| HD1:52 | HD:150 | Gates derived from project scripts, seen but not written on day one | carried | carried | surface rules 1, 5.3 |
| HD1:53 | HD:155 | Everything else exported to the user is a defect until defaulted or progressive | carried | carried | surface rule 2 |
| HD1:54 | HD:159 | First run: resolve profile, derive gates, verify model files, print one paragraph, one confirmation, open board | carried | carried | surface rule 5, SUR-2/3 (gap P10) |
| HD1:55 | HD:163 | First-run text names "14 GB to fetch" and `--models-dir` | carried | carried | surface rule 5 example |
| HD1:56 | HD:168 | No file written by the user before the first card; config/gates/hooks/mcp/skills/tiers/rosters/stop reasons exist, none… | carried | carried | surface rule 8 |
| HD1:57 | HD:174 | Four verdicts per surface item: Day one, Default, Progressive (trigger named; empty view hidden), Developer (`dev` name… | carried | carried | surface rule 2 |
| HD1:58 | HD:181 | Eight front-door commands; research question is not a command | carried | carried | surface rules 13, 15 |
| HD1:59 | HD:185 | `sekhemet` opens board (first run sets up) | carried | carried | surface rule 13 table |
| HD1:60 | HD:186 | `sekhemet "<spec>"` plans and runs in one verb | carried | carried | surface rule 13 |
| HD1:61 | HD:187 | `sekhemet run [card]` absorbs queue/run/resume | carried | carried | surface rule 13 |
| HD1:62 | HD:188 | `sekhemet review` opens next card waiting on a person | carried | carried | surface rule 13 |
| HD1:63 | HD:189 | `accept`, `send-back <card> "<reason>"`, `park`/`unpark` | carried | carried | surface rule 13; review-git §2.4 |
| HD1:64 | HD:190 | `sekhemet board` the board in the terminal | carried | carried | surface rule 13 (`--terminal` for text) |
| HD1:65 | HD:191 | `sekhemet doctor` checks install incl. weights exist | carried | carried | surface rule 13; models rule 5 |
| HD1:66 | HD:192 | `sekhemet dev <x>`; listed only by `dev --help` | carried | carried | surface rule 13 |
| HD1:67 | HD:194 | New user-facing command must displace one | carried | carried | surface rule 14 |
| HD1:68 | HD:194 | A `--profile`-style flag rewriting other flags is an unchosen default | carried | carried | surface rule 14 |
| HD1:69 | HD:194 | Every destructive action reachable from UI is reachable from CLI with its undo | carried | carried | surface rule 14; review-git §2.4 |
| HD1:70 | HD:196 | Moved means unlisted, not removed (calls without `dev` still run) | carried | carried | surface rule 13, SUR-31 |
| HD1:71 | HD:200 | Single non-command word refused with suggestion (`reveiw`→`review`) | carried | carried | surface rule 15 (edit distance 2), SUR-28 |
| HD1:72 | HD:201 | `run` with no card runs the queue; with a card runs or resumes it | carried | carried | surface rule 13 |
| HD1:73 | HD:202 | `review` shows oldest Review card, gates, diff size, three deciding commands | carried | carried | surface rule 13 |
| HD1:74 | HD:202 | send-back reason required; becomes next attempt's instruction and playbook candidate; shares implementation with board… | carried | carried | surface rule 16; review-git §2.4 |
| HD1:75 | HD:204 | One list of commands feeds parser and dispatcher (six unrouted handlers incl. `overnight` found) | carried | carried | surface rule 17, T4 |
| HD1:76 | HD:208 | A wrong default fails loudly, naming the file to edit | carried | carried | surface rule 3, SUR-12 |
| HD1:77 | HD:210 | A parsed config key must be read, else deleted from schema | carried | carried | surface rule 4, SUR-21 |
| HD1:78 | HD:214 | Parity claim: matches top five except cloud scale and cloud latency | carried-weaker | deliberate | specs/README "Where the old design went" (dated competitor columns removed) |
| HD1:79 | HD:220 | Primary interface: board-native nested kanban; CLI/TUI secondary | carried | carried | SPINE; surface Later (TUI later); dashboard §1 |
| HD1:80 | HD:221 | Inference: llama.cpp / MLX, zero telemetry | contradicted | later | models rule 14, §7 (MLX only a label; R3) |
| HD1:81 | HD:222 | Core architecture: Cordis-inspired TS kernel + SQLite WAL event log | carried | carried | kernel; PROVENANCE techniques |
| HD1:82 | HD:223 | Tools: symbol-scoped AST tools + LSP + RTK sandboxed bash | carried | carried | worker-loop rule 12 (TS language service); context rule 17 |
| HD1:83 | HD:224 | Permissions: 3-tier Allow/Ask/Deny + OS sandbox + scope write confinement | carried | carried | security rules 4–17, 25 |
| HD1:84 | HD:225 | Hooks: 10-point waterfall across loop, gate, sync events | carried | carried | extensibility rule 4 |
| HD1:85 | HD:226 | Skills: open Agent Skills (`SKILL.md`) + tiered rules + doctor diagnostics | carried | carried | extensibility rules 10–17 |
| HD1:86 | HD:227 | MCP: dual client and server (boards, cards, gates, evidence exposed) | carried | carried | extensibility rules 18–24 |
| HD1:87 | HD:228 | Session: fresh deterministic context per card; replay, fork, rewind from SQLite WAL | carried | carried | runtime rules 1, 11–14 |
| HD1:88 | HD:229 | Subagents: nested board DAG + SPIDR + branch-and-return isolation | carried | carried | planner-pm §2.7.9; context rule 18 |
| HD1:89 | HD:230 | Context: AST repo map + RTK (60–90%) + SWE-Pruner Pro (40–60%) + masking | carried-weaker | carried | context rule 17, §9 (R2 ≥ 60%); pruner DEC-21 |
| HD1:90 | HD:231 | Git: per-card worktrees, checkpoint commits, squash-on-accept Conventional Commits, stacked branches, difftastic | carried | carried | review-git §2.5–2.6 |
| HD1:91 | HD:232 | DoD: Static, Functional, Robustness, Security, Visual, Hygiene; agent never certifies | carried | carried | gates rule 3 |
| HD1:92 | HD:233 | Hardware self-calibration S/M/L/XL + memory pressure watchdog with dynamic throttling | carried | carried | models rules 7–9, 19 |
| HD1:93 | HD:234 | Air-gap kit with local package mirrors (npm, devpi, crates) + byte-identical prompt caching | carried-weaker | later | security §7 (mirror services); lockfile allowlist in v1 |
| HD1:94 | HD:244 | `read` line-numbered 1-based, byte-budgeted | carried | carried | worker-loop rule 12 (start/end; outline over 200 lines) |
| HD1:95 | HD:244 | `edit` exact replacement with uniqueness constraint | carried | carried | worker-loop rule 12 |
| HD1:96 | HD:244 | `grep` over ripgrep with three modes (files, content, counts) | carried-weaker | carried | worker-loop rule 12 (built) |
| HD1:97 | HD:244 | `glob` mtime-sorted | carried-weaker | carried | worker-loop rule 12 |
| HD1:98 | HD:244 | `run` sandboxed bash with RTK condensing | carried | carried | worker-loop rule 12 `run_cmd`; context rule 17 |
| HD1:99 | HD:244 | AST tools `replace_symbol_body`, `insert_after_symbol`, `read_symbol`, `find_references` backed by an LSP client pool | carried | carried | worker-loop rule 12 (TS language service; adds `go_to_definition`) |
| HD1:100 | HD:244 | Search and fetch tools segregated to research cards | carried | carried | worker-loop rule 12; design-stage §2.7.10, v1 acceptance |
| HD1:101 | HD:252 | Three-tier permission model, Deny always wins | carried | carried | security rule 25 |
| HD1:102 | HD:252 | OS sandbox macOS Seatbelt; Linux namespaces + Landlock + seccomp | carried | carried | security rules 9–17 (bubblewrap per DEC-21; Landlock/seccomp hardening) |
| HD1:103 | HD:252 | Writes outside `filesTouched` denied | carried | carried | worker-loop rule 14; security rule 25 |
| HD1:104 | HD:252 | gates.toml, gate tests, loop control, sandbox configs permanently denied without human override | carried | carried | security rule 25; gates rules 2, 7 |
| HD1:105 | HD:252 | Untrusted content tagged; triggers elevated restrictions | carried | carried | security rule 42 |
| HD1:106 | HD:260 | Ten hook events: card/start, pre-step, pre-tool, post-tool, pre-gate, post-gate, card/end, review/return, playbook/prop… | carried | carried | extensibility rule 4 |
| HD1:107 | HD:260 | Hooks run outside the sandbox with user privileges (formatters, lint fixers, notifications) | carried | carried | extensibility §2 table; rule 6 adds fail-closed for pre-* events |
| HD1:108 | HD:268 | Skills under `.sekhemet/skills/<name>/` with SKILL.md, scripts, references, regression evals | carried | carried | extensibility rule 10 |
| HD1:109 | HD:268 | Manifest lines budgeted into Zone 2; full instructions load only when card class matches triggers | carried | carried | extensibility rules 11–12, 14; context rule 8 |
| HD1:110 | HD:268 | Doctor benchmarks each skill on held-out tasks, prunes context-bloat rules | carried | carried | extensibility rule 16; measurement rule 24 |
| HD1:111 | HD:277 | MCP client: servers declared in `config.toml`; discovered tools budgeted and exposed to planner and Worker | carried | carried | extensibility rules 22–23 (declared in `mcp.json`; Worker only via `worker_tools`) |
| HD1:112 | HD:278 | MCP server exposes workspace, boards, cards, gates, evidence bundles, model registry to IDEs/CLI/CI | carried | carried | extensibility rule 18 (evidence and registry read-only: NEW-extensibility-3 gap) |
| HD1:113 | HD:286 | Append-only SHA-256 hash-chained event log | carried | carried | kernel rules 7–10 |
| HD1:114 | HD:287 | Resume: reconstruct board state, restore worktree to last checkpoint, resume | carried | carried | runtime rule 10 |
| HD1:115 | HD:288 | Fork at step N with modified model route, prompt version or budget | carried | carried | runtime rule 13, RUN-27 |
| HD1:116 | HD:289 | Rewind: reset worktree to step N checkpoint, record event, invalidate later gate passes | carried | carried | runtime rule 12; kernel rule 26, K-S7-8 |
| HD1:117 | HD:290 | Replay against pinned configurations for A/B | carried | carried | runtime rule 14 |
| HD1:118 | HD:291 | Headless CLI `sekhemet run <card>` | carried | carried | surface rule 18; extensibility rule 27 |
| HD1:119 | HD:291 | TypeScript SDK with async-iterator event streams | carried-weaker | deliberate | extensibility rule 28, §8 Q1 ("changed from the old design's shipped SDK") |
| HD1:120 | HD:299 | Nested board is the subagent system; subtasks inherit project context, isolated sub-context, return structured summary… | carried | carried | planner-pm §2.7.9; context rule 18 |
| HD1:121 | HD:307 | Context: Aider AST repo map + PageRank | carried | carried | context rule 13 |
| HD1:122 | HD:307 | Headless LSP expansion stage | contradicted | deliberate | context rule 28, §9 |
| HD1:123 | HD:307 | Masking tool outputs older than 2 steps with 15-token pointers | contradicted | deliberate | context rule 3; DEC-24 |
| HD1:124 | HD:315 | Per-card worktrees with copy-on-write cloning | later | deliberate | DEC-21 (plain worktrees) |
| HD1:125 | HD:315 | Checkpoint commits on every passing step | contradicted | deliberate | review-git rule 3, §9 (every step that changed files; R1) |
| HD1:126 | HD:315 | Squash-on-accept into Conventional Commits | carried | carried | review-git §2.5.4 |
| HD1:127 | HD:315 | Stacked branches for decomposed feature chains | carried | carried | review-git §2.6.2, §2.5.5 |
| HD1:128 | HD:315 | Structural diffs (difftastic) | carried | carried | review-git §2.6.6 (partial, S5); gates Later for the bundle field |
| HD1:129 | HD:315 | Opt-in GitHub App adapter managing the PR lifecycle | carried | carried | integrations rule 10; review-git §2.5.7 (gap P9/S5) |
| HD1:130 | HD:323 | Gates run on an isolated gate host | carried | carried | gates rule 11 (separate host when configured, else local sandbox; T1 gap) |
| HD1:131 | HD:324 | Static: in-memory AST parse, `tsc --noEmit`, linter | carried | carried | gates rule 3; worker-loop rule 14 |
| HD1:132 | HD:325 | Functional: unit, integration, acceptance tests that must fail before implementation | carried | carried | gates rules 3, 5–6 |
| HD1:133 | HD:326 | Robustness: diff-scoped mutation (Stryker / cargo-mutants) | carried | carried | gates rule 32 (own diff-scoped step; PROVENANCE) |
| HD1:134 | HD:327 | Security: gitleaks, existence/slopsquatting checks, osv-scanner | carried | carried | gates rules 3, 15; security rule 44; GT-10 |
| HD1:135 | HD:328 | Visual: Playwright DOM assertions, layout bounding boxes, pixelmatch element screenshots, axe-core | carried-weaker | gap | gates rule 29, NEW-gates-4 (GT-N4-6); libraries still proposals (R16) |
| HD1:136 | HD:329 | EvidenceBundle with difftastic enabling "5-second human acceptance" | contradicted | deliberate | review-git rule 2, §9 (a decision in under a minute); structural diff rule 6 (partial, S5) |
| HD1:137 | HD:335 | Omitted: cloud routing and fallback (data leakage, hides competence limits) | carried | carried | DEC-03; models rule 1 ("never a silent fallback") |
| HD1:138 | HD:336 | Omitted: continuous conversational accumulation (context rot) | carried | carried | runtime rationale "Why no sessions"; DEC-23 |
| HD1:139 | HD:337 | Omitted: lossy model summarization of context | carried | carried | context rule 28 |
| HD1:140 | HD:338 | Omitted: multi-agent debate | carried | carried | DEC-22 |
| HD1:141 | HD:339 | Omitted: simulated Scrum role agents | carried | carried | DEC-22, DEC-05 |
| HD1:142 | HD:340 | Omitted: parallel agents writing same files; overlapping siblings serialized | carried | carried | DEC-22; kernel rule 4 |
| HD1:143 | HD:341 | Omitted: embedding RAG as code context | carried | carried | DEC-22; context rule 28 |
| HD1:144 | HD:347 | Rewind from card view: "rewind to step N", truncates nothing, invalidates later gate pass | later | later | dashboard §7 (CLI built) |
| HD1:145 | HD:348 | Dynamic tool loading: deferred tools by name, `tool_search` loads schema into volatile zone | carried | carried | worker-loop rule 11 and M2 A/B; worker-loop OQ2, context OQ2 (append as message, never edit tools array) |
| HD1:146 | HD:348 | MCP servers with many tools usable without prefill cost | carried-weaker | gap | worker-loop rule 11a, NEW-worker-loop-8 |
| HD1:147 | HD:349 | External review cards on PRs not created by the harness; never edits; findings as evidence / review comments | carried | carried | review-git §2.7; integrations rule 13 |
| HD1:148 | HD:350 | Scheduled (cron) and triggered (webhook, file change, dependency release) recurring cards cloned from template; declare… | carried | carried | runtime rule 21 |
| HD1:149 | HD:351 | Agent-driven browser `browse` (navigate, a11y tree, click, type, screenshot); reads free, writes need URL allowlist; sc… | carried | carried | security rule 42a; worker-loop rule 12 |
| HD1:150 | HD:352 | IDE extension (VS Code over ACP) and TUI | later | later | SPINE "Not in v1"; dashboard §7 |
| HD1:151 | HD:353 | Implementation previews: 2–3 approach previews in decision requests | carried | carried | planner-pm §2.10.2 (previewSketch) |
| HD1:152 | HD:354 | Skill and playbook diagnostics (net gain, prune bloat) | carried | carried | measurement rule 24; extensibility rule 16 |
| HD1:153 | HD:355 | Memory watchdog: disable speculative decoding, shed observation caches, throttle parallel worktrees at 85–90% | carried-weaker | gap | models rule 19 (owner, R27), NEW-models-2 (the 0.90 stage) |
| HD1:154 | HD:356 | Restricted mode: no `run`, read-only AST inspection, static gates only | carried | carried | worker-loop rule 13; security rule 43 |
| HD1:155 | HD:358 | Still deferred: plugin marketplace | later | later | extensibility §7 |
| HD1:156 | HD:358 | Still deferred: remote control from mobile beyond notifications | later | later | integrations §7; dashboard §7 |
| HD1:157 | HD:358 | Still deferred: team chat entry points | later | later | integrations §7 |
| HD1:158 | HD:362 | Every capability is a plugin claiming a service key (Cordis) | contradicted | deliberate | extensibility rule 29, §7 (plugin API later), §8 Q2 (container cut in B0 (DEC-29 O4)); SPINE packages |
| HD1:159 | HD:366 | Invariant: model-visible means logged, runtime assertion enforces it | carried-weaker | carried | kernel rule 17, §4 (built), K-9 |
| HD1:160 | HD:370 | Service keys ctx.events … ctx.sync and what each owns | carried | carried | SPINE package table (renamed to packages) |
| HD1:161 | HD:387 | Processes: board UI, core host, inference host, gate runner (Linux sandbox), SQLite store; same machine on single box | carried | carried | SPINE §How the parts fit |
| HD1:162 | HD:398 | Step = one model request + tool calls; turn = steps for one card attempt | contradicted | carried | DEC-26; worker-loop §3 Terms (a step is one model request and its tool calls; "turn" is only the code's synonym) |
| HD1:163 | HD:398 | Turn-flow events: card/start, step/start, context/assembled, model/request, model/response, tool/call, tool/result, ste… | carried-weaker | deliberate | kernel §3 closing note (never the code's; mapped) |
| HD1:164 | HD:400 | Waterfall extension points: pre-step (inject checkpoints/questions), pre/post-tool (permissions, parse gate, secret sca… | carried | carried | extensibility rules 4–6 |
| HD1:165 | HD:402 | Plugin isolation and third-party versioning deferred past v1 | later | later | extensibility §7 |
| HD1:166 | HD:406 | Four-level hierarchy capped; deeper nesting rejected at creation | carried | carried | kernel rule 1, K-3 |
| HD1:167 | HD:412 | Workspace: id, name, machine profile, active project cap (default 3) | carried | carried | kernel rule 2 |
| HD1:168 | HD:413 | Project: repo path, gate contract, conventions ref, stage, playbook ref | carried-weaker | carried | kernel rule 6 |
| HD1:169 | HD:414 | Card key fields (parent, spec, criteria, state, difficulty, budgets, actuals, route, deps, evidence ref) | carried | carried | kernel rule 6 (`CardRecord`); planner-pm §2.1.5 |
| HD1:170 | HD:416 | ContextPack: id, card ref, sections, token counts, prefix hash | carried-weaker | carried | kernel rule 6; context rule 29 |
| HD1:171 | HD:417 | EvidenceBundle entity fields | carried | carried | gates rule 35 |
| HD1:172 | HD:418 | Attempt: model, quant, step budget, stop reason, cost | carried | carried | kernel rule 6 (`AttemptRecord`); gates rule 35 settings |
| HD1:173 | HD:419 | GateResult: name, status, typed failures, duration, artifacts | carried | carried | gates Contract (`GateResult`) |
| HD1:174 | HD:420 | Goal sits above projects | carried | carried | planner-pm §2.11 |
| HD1:175 | HD:433 | Card difficulty 1..10, planner-assigned | carried | carried | planner-pm §2.4 Estimable; K-S7-1 |
| HD1:176 | HD:434 | Card budget and actuals: steps, tokens, seconds | carried | carried | planner-pm §2.1.5; worker-loop rule 21 |
| HD1:177 | HD:444 | Card route: planner and worker model ids | carried | carried | planner-pm §2.1.5 ("routing") |
| HD1:178 | HD:448 | dependsOn DAG, cycle-checked on write | carried | carried | kernel rule 3 |
| HD1:179 | HD:449 | filesTouched declared scope; writes outside fail the card | carried | carried | worker-loop rules 14, 16 (typed refusal; `scope_violation`) |
| HD1:180 | HD:452 | externalRef {system github/forgejo, id, url} | carried | carried | integrations rule 8 (adds jira, linear) |
| HD1:181 | HD:463 | Eligible only when every dependency done; overlapping siblings serialized | carried | carried | kernel rules 3–4 |
| HD1:182 | HD:467 | SQLite WAL, single writer | carried | carried | kernel rule 27 |
| HD1:183 | HD:467 | Hash chain over (seq, ts, actor, type, cardId, payloadHash, prevHash) — one definition | carried | carried | kernel rule 8 (one formula in code; timestamp coverage is NEW-kernel-1 gap) |
| HD1:184 | HD:467 | Board state is a projection, rebuildable | carried | carried | kernel rule 13 |
| HD1:185 | HD:467 | Context packs and evidence on disk under `.sekhemet/`, referenced by hash | carried | carried | kernel rule 15 |
| HD1:186 | HD:469 | Retention: packs and raw observations pruned 30 days after close; evidence, final diff, gate pass events kept forever | carried | carried | runtime rule 33 |
| HD1:187 | HD:473 | Columns are states; each transition has an entry gate | carried | carried | kernel rules 17, 21 |
| HD1:188 | HD:473 | UI offers an explicit override (drag past a gate) recorded as a human decision | carried-weaker | later | dashboard §7; kernel rule 28 (CLI, API) |
| HD1:189 | HD:477 | Nine states, one name each across storage, column, error, docs | carried | carried | kernel rule 17 |
| HD1:190 | HD:481 | State table: backlog, ready, planning, in_progress, verify, review, done, parked, rejected with meanings | carried | carried | kernel rule 17 |
| HD1:191 | HD:491 | Working/Checking/Closed retired | carried | carried | kernel OQ1 (NAMING.md still conflicts; recommendation to fix) |
| HD1:192 | HD:493 | parked→ready and rejected→ready reachable from CLI | carried | carried | kernel rule 19, K-S4-7 (gap S4/S5) |
| HD1:193 | HD:498 | Edge Backlog→Ready (deps met, context fits) | carried | carried | kernel rule 21 table |
| HD1:194 | HD:499 | Edge Ready→Planning (planner claims); Planning→InProgress (plan + criteria approved) | carried-weaker | carried | kernel rule 25 |
| HD1:195 | HD:503 | Edge Verify→Planning on gate fail (replan) | carried-weaker | carried | kernel rule 25 |
| HD1:196 | HD:505 | Edge Review→InProgress on human change request | contradicted | deliberate | review-git §2.4, §9; DEC-24 (send back to Ready) |
| HD1:197 | HD:507 | Edge InProgress→Parked on stall or budget | carried | carried | code table; worker-loop rule 34.4 |
| HD1:198 | HD:516 | Ready entry: deps done; context pack assembles within budget; criteria present | carried | carried | kernel rule 21; context rule 10, CX-N2-2 |
| HD1:199 | HD:517 | Planning entry: planner model available; difficulty scored | missing | gap | kernel rule 27, NEW-kernel-5 |
| HD1:200 | HD:518 | InProgress entry: plan exists; acceptance tests written and failing (types-only card red on typecheck); scope declared | carried-weaker | deliberate | kernel rule 27, §8 Q6 (decided: no "plan exists" condition (DEC-29; kernel K-N5-8)) |
| HD1:201 | HD:519 | Verify entry: Worker stopped with recorded stop reason | carried | carried | kernel rule 21, K-S4-6 (gap S4) |
| HD1:202 | HD:520 | Review entry: every required gate passed; evidence complete | carried | carried | kernel rule 21; gates rule 9 |
| HD1:203 | HD:521 | Done entry: human acceptance recorded | carried | carried | kernel rule 21 |
| HD1:204 | HD:522 | Parked entry: stall, budget exhaustion, capability ceiling | carried-weaker | gap | kernel rule 27, NEW-kernel-5 |
| HD1:205 | HD:523 | Rejected: closed unmerged; reopen → Ready | carried | carried | review-git §2.4 |
| HD1:206 | HD:527 | Rollup: parent done only if all children done AND parent integration gate passes on merged result | carried | carried | kernel rule 24, K-7 |
| HD1:207 | HD:527 | Project status is rollup of top-level cards | carried-weaker | gap | kernel rule 6, NEW-kernel-5 (K-N5-3) |
| HD1:208 | HD:531 | Regression protection: evidence snapshotted at Review; revision must re-pass every gate | carried | carried | kernel rule 25 |
| HD1:209 | HD:531 | A revision regressing a previously passing gate is rejected; card returns to Planning with the regression named | carried-weaker | gap | kernel rule 31, NEW-kernel-5 |
| HD1:210 | HD:538 | ReviewWIP = floor(reviewMinutesPerDay / medianReviewMinutesPerCard) | carried | carried | review-git §2.2.1 |
| HD1:211 | HD:541 | When Review full, no card may enter Verify | carried | carried | kernel rule 23; review-git §2.2.4 |
| HD1:212 | HD:545 | Context assembled deterministically per card, never accumulated | carried | carried | context rule 1 |
| HD1:213 | HD:549 | Repo map: tag extraction, file graph, personalized PageRank seeded to scope, binary-search fit | carried | carried | context rule 13 (TS compiler, not Tree-sitter; budget 1,200) |
| HD1:214 | HD:549 | Aider edge-weight multipliers: mentioned and well-named identifiers up, in-scope files highest | carried-weaker | gap | context rule 13, NEW-context-5 |
| HD1:215 | HD:549 | Repo map cached by path and mtime plus content hash | carried-weaker | gap | context rule 13, NEW-context-5 |
| HD1:216 | HD:550 | LSP expansion stage, headless servers pooled per project | contradicted | deliberate | context rule 28, §9; pool backs tools (worker-loop 12) |
| HD1:217 | HD:551 | Line-level pruning with SWE-Pruner on gate host | later | later | context §7; DEC-21 |
| HD1:218 | HD:551 | [BENCH] pruner CPU latency on 4-core host | later | later | OPEN_QUESTIONS benchmark 8 (deferred with the pruner) |
| HD1:219 | HD:552 | Budget fit to tier working budget, below window | carried | carried | context rule 10 |
| HD1:220 | HD:558 | Four-zone prompt layout and stability | carried | carried | context rule 8 (Zone 3 now per attempt incl. spec; Zone 4 per turn) |
| HD1:221 | HD:563 | Zone 4 = card spec, criteria, scope, open TODOs, latest observation, re-injected goal | contradicted | deliberate | context rule 8, §9 (M8) |
| HD1:222 | HD:565 | Zone 2 versioned, updated only between cards | carried | carried | context rules 8, 24; CX-5 |
| HD1:223 | HD:569 | Masked pointer example (~15 tokens with EvidenceRef) | carried | carried | context rule 3 (`recall(ref)`) |
| HD1:224 | HD:569 | Full observations remain in log/disk, retrievable by reference | carried | carried | context rules 3, 17 |
| HD1:225 | HD:569 | Goal and open TODOs re-injected at tail every step | carried | carried | context rule 8 |
| HD1:226 | HD:573 | `run` routes commands through the RTK binary | carried-weaker | deliberate | context rule 17 (native condenser; binary on no v1 path) |
| HD1:227 | HD:574 | RTK four strategies: filtering, grouping, truncation, deduplication | carried | carried | context rule 17 |
| HD1:228 | HD:579 | RTK tracks savings statistics | missing | gap | context rule 17, NEW-context-5 |
| HD1:229 | HD:579 | read/grep/glob native condensing; lossless for repair data; raw output saved to evidence | carried | carried | context rule 17, CX-3 |
| HD1:230 | HD:581 | [BENCH] condensing reduction on real command mix, dropped strings | carried | carried | OPEN_QUESTIONS #13 |
| HD1:231 | HD:585 | Subtask branching: child seeded from parent zones 1–2 + own scope; returns summary + evidence ref | carried | carried | context rule 18, CX-4 |
| HD1:232 | HD:590 | llama.cpp: `--cache-ram` 8–16 GiB, `--ctx-checkpoints 32`, `--checkpoint-min-step 8192` | contradicted | deliberate | context rule 6, §9; DEC-24 |
| HD1:233 | HD:590 | Slot prefix similarity `-sps` | missing | deliberate | context rule 6; DEC-24 |
| HD1:234 | HD:590 | `cache_prompt: true` on every request | carried | carried | context rule 6 |
| HD1:235 | HD:591 | Zero silent cache invalidation; volatile data banned from prefix | carried | carried | context rule 5 |
| HD1:236 | HD:592 | MLX path: unified memory reuse, MTPLX native MTP heads | later | later | context §7; models §7 |
| HD1:237 | HD:593 | Prefix-cache hit rate recorded per step; <85% on tool-result steps is a defect | carried | carried | context rule 7 (median over turns after first) |
| HD1:238 | HD:593 | Low hit rate alerts the operator | carried-weaker | gap | context rule 7, M8 |
| HD1:239 | HD:599 | Planner declares scope by bounded search before Ready, outside Worker budget | carried | carried | context rule 22 (gap P1) |
| HD1:240 | HD:601 | Step 1: identifiers looked up in symbol table | carried | carried | context rule 22, CX-P1-1 |
| HD1:241 | HD:602 | Step 2: lexical search ranked defs>refs, source>tests>generated | carried | carried | context rule 22, CX-P1-4 |
| HD1:242 | HD:603 | Step 3: one-hop graph expansion | carried | carried | context rule 22, CX-P1-3 |
| HD1:243 | HD:604 | Step 4: cap 12 tool calls and one Planner turn; else decision request asking which files | carried | carried | context rule 22, CX-P1-2 |
| HD1:244 | HD:606 | filesTouched is a declaration: may read outside, may not write outside | carried | carried | context rule 22 |
| HD1:245 | HD:606 | [BENCH] scope precision/recall vs human-named files decides the cap | missing | gap | context rule 22, P1 (CX-P1-5 precision and recall) |
| HD1:246 | HD:616 | Decompose to fit with headroom; unfittable card is a planning failure | carried | carried | planner-pm §2.4 Small; context rule 10 |
| HD1:247 | HD:619 | Learned line pruning (SWE-Pruner Pro) | later | later | context §7 |
| HD1:248 | HD:620 | Zone caps: Z1 ≤0.12W, Z2 ≤0.10W, Z3 ≤0.50W, Z4 remainder ≥0.20W; shrink map, drop symbols, fail Ready | carried | deliberate | context rule 10; DEC-27 (Zone 1 fixed in tokens, ≤ 2,400 incl. schemas; the other zones as fractions of W − 2,400) |
| HD1:249 | HD:626 | Observation masking: older than last two replaced in place | contradicted | deliberate | context rule 3; DEC-24 |
| HD1:250 | HD:627 | Graduated pressure 70/80/85/90%; 95% ends step `budget_exhausted` | carried | carried | context rule 12, CX-2 |
| HD1:251 | HD:628 | Goal re-injection at tail (lost-in-the-middle) | carried | carried | context rule 8 |
| HD1:252 | HD:629 | Placement: immutable front, task end, nothing important mid-block | carried | carried | context rule 9 |
| HD1:253 | HD:630 | Typed failures, not logs | carried | carried | context rule 16 |
| HD1:254 | HD:631 | Reasoning traces stripped between steps unless model registered as benefiting | contradicted | deliberate | context rule 4, §9; DEC-24 |
| HD1:255 | HD:637 | Branch and return | carried | carried | context rule 18 |
| HD1:256 | HD:638 | Fresh context on rungs 2 and 3 | carried | carried | context rule 19 |
| HD1:257 | HD:639 | Stall detection ends turn before context fills | carried | carried | worker-loop rules 17–18 |
| HD1:258 | HD:640 | Step budgets by class as a ceiling on generated context | carried | carried | worker-loop rule 21 |
| HD1:259 | HD:644 | No model-written trajectory summaries | carried | carried | context rule 28 |
| HD1:260 | HD:645 | No embedding compression of code | carried | carried | context rule 28; DEC-22 |
| HD1:261 | HD:646 | No large windows; larger tier buys co-residency and parallel cards | carried | carried | context rule 28; models rule 8 |
| HD1:262 | HD:650 | Measurement per step (zone tokens, masked count, hit rate) and per card (peak, steps to first pass, pass vs pack size);… | carried | carried | context rule 29 |
| HD1:263 | HD:656 | Target envelope: 3B-active MoE or ~30B class with 16k–32k working context, bounded verifiable cards | carried | carried | models rules 2, 8 |
| HD1:264 | HD:682 | Localization stage 1: tag queries + PageRank rank symbols | carried | carried | context rule 13 |
| HD1:265 | HD:683 | Localization stage 2: LSP expands defs/refs/signatures for declared scope | contradicted | deliberate | context rule 28, §9 |
| HD1:266 | HD:688 | Edit sketch from Planner: target AST symbols, preconditions, invariant contracts, diff sketch without boilerplate | carried-weaker | carried | planner-pm §2.1.9, P1 |
| HD1:267 | HD:689 | Worker applies sketch mechanically via symbol replacement | carried-weaker | later | worker-loop §7 |
| HD1:268 | HD:692 | Format tax: grammar constraints degrade small-model reasoning 15–30% | carried | carried | models rule 28; DEC-22 |
| HD1:269 | HD:693 | Constraints help on terminal payloads, hurt on reasoning and selection | carried | carried | models rule 28 |
| HD1:270 | HD:695 | Tri-arm A/B/C qualified per model; winner pinned [BENCH] | carried | carried | models rule 28, NEW-models-5; OPEN_QUESTIONS #1 |
| HD1:271 | HD:700 | 0.6B skimmer strips 40–60% of code lines | later | later | context §7 |
| HD1:272 | HD:701 | Observation masking older than 2 steps | contradicted | deliberate | context rule 3; DEC-24 |
| HD1:273 | HD:706 | Symbol replacements cannot match twice, no offset arithmetic, whitespace-immune | carried | carried | worker-loop rule 12 |
| HD1:274 | HD:707 | Every edit passes in-memory parse gate before disk; syntax errors abort without burning steps | carried | carried | worker-loop rule 14, WL-3 |
| HD1:275 | HD:711 | Ban ungrounded self-reflection loops | carried | carried | worker-loop rule 3; DEC-22 |
| HD1:276 | HD:712 | Parallel pass@k on L/XL or overnight; k ∈ [2,4], T ∈ [0.4,0.7] | carried-weaker | later | worker-loop §7 |
| HD1:277 | HD:713 | Each sample verified in isolated ephemeral worktree; first to pass selected | carried | carried | worker-loop rule 37 |
| HD1:278 | HD:719 | GateFailure example with location/expected/actual/minimalRepro | carried | carried | gates rule 19 |
| HD1:279 | HD:721 | Only top 3 topologically ordered failures reach the model | carried | carried | gates rule 20 |
| HD1:280 | HD:722 | 4-rung ladder enforces fresh context | carried | carried | worker-loop rule 34 |
| HD1:281 | HD:726 | Exemplar source: accepted cards and fixing commits from repo's own git history | carried-weaker | later | context §7 |
| HD1:282 | HD:727 | 1–2 accepted trajectories of same class into Zone 2 | carried | carried | context rules 8, 25 (as diff hunks) |
| HD1:283 | HD:731 | Up to 40% of tool-call failures from template bugs | carried-weaker | carried | models rule 12 (templates pinned by SHA-256); the 40% figure is rationale only |
| HD1:284 | HD:732 | Vendor-exact Jinja templates SHA-256 pinned; change invalidates qualification | carried | carried | models rule 12, MD-2 |
| HD1:285 | HD:733 | KV 8-bit; 4-bit prohibited for tool-calling models | carried | carried | models rule 10, MD-1 |
| HD1:286 | HD:734 | 2026 cache flags (8–16 GiB, 32 checkpoints, 8192 min-step, -sps) | contradicted | deliberate | context rule 6; DEC-24 |
| HD1:287 | HD:735 | Native MTP 1.6×–2.6× decode speed-up | contradicted | deliberate | models rule 13, §9 (1.6–2.6× claim withdrawn; ~1.28× decode with a prefill penalty measured) |
| HD1:288 | HD:735 | Draft-model speculative decoding (`-md`) qualified per machine | missing | gap | models rule 13, NEW-models-8 (draft-model `-md` qualified with prefix caching) |
| HD1:289 | HD:739 | SPIDR sizing: scope 1–3 files, <200 lines diff | carried | carried | gates rule 12; planner-pm §2.1.4 |
| HD1:290 | HD:740 | Sandbox blocks writes outside scope | carried | carried | worker-loop rule 14 |
| HD1:291 | HD:747 | Worker: single writer, one card at a time | carried | carried | worker-loop rule 4 |
| HD1:292 | HD:751 | Tool arm chosen per model by measurement; registry records winner | carried | carried | models rule 28 |
| HD1:293 | HD:755 | Tool set flat, no nested objects or unions | carried-weaker | carried | worker-loop rule 10a, WL-17 |
| HD1:294 | HD:756 | `read` line-numbered byte-budgeted | carried | carried | worker-loop rule 12 |
| HD1:295 | HD:757 | `read_symbol`, `find_references` | carried | carried | worker-loop rule 12 |
| HD1:296 | HD:758 | `replace_symbol_body`, `insert_after_symbol` | carried | carried | worker-loop rule 12 |
| HD1:297 | HD:759 | `edit` fallback with uniqueness | carried | carried | worker-loop rule 12 |
| HD1:298 | HD:760 | `run` sandboxed with RTK | carried | carried | worker-loop rule 12 |
| HD1:299 | HD:761 | `docs` version-pinned documentation across knowledge tiers | carried | carried | worker-loop rule 12 |
| HD1:300 | HD:762 | `deps_source` installed dependency source at resolved version | carried | carried | worker-loop rule 12 (`dependencies`) |
| HD1:301 | HD:763 | `repo`: tree, file at a ref, code search, releases between two versions | carried-weaker | later | worker-loop §7 (R4) |
| HD1:302 | HD:764 | `ask` non-blocking question answered at a later step boundary | contradicted | gap | worker-loop rule 12, NEW-worker-loop-4 (R2) |
| HD1:303 | HD:765 | `note` writes to card thread or posts a decision request | carried | carried | worker-loop rule 12 |
| HD1:304 | HD:767 | Code-mode single script when registry marks Worker script-capable | carried | carried | worker-loop rule 12 `run_script`, WL-M2-4 |
| HD1:305 | HD:772 | Write path 1: scope check | carried | carried | worker-loop rule 14 |
| HD1:306 | HD:773 | Write path 2: Tree-sitter AST parse | carried | carried | worker-loop rule 14 (compiler for TS/JS; other languages where a checker exists) |
| HD1:307 | HD:774 | Write path 3: gitleaks-pattern secret scan | carried | carried | worker-loop rule 14 |
| HD1:308 | HD:775 | Failure aborts write, typed error, disk untouched | carried | carried | worker-loop rule 14, WL-3 |
| HD1:309 | HD:779 | Rolling window of (tool, argumentHash, repoStateHash) | carried | carried | worker-loop rule 17 |
| HD1:310 | HD:780 | Two identical signatures, unchanged repo → stall | carried | carried | worker-loop rule 18 |
| HD1:311 | HD:781 | A-B-A → oscillation | carried | carried | worker-loop rule 18 |
| HD1:312 | HD:782 | Both terminate the turn immediately | contradicted | deliberate | worker-loop rule 18, §9 |
| HD1:313 | HD:782 | Step budgets set dynamically per card class by the planner | carried | carried | worker-loop rule 21 (p80×1.25, ±15%, ≥4) |
| HD1:314 | HD:787 | Stop reason `done_pending_gates` | carried | carried | worker-loop rule 33 (meaning refined) |
| HD1:315 | HD:788 | Stop reason `budget_exhausted` | carried | carried | worker-loop OQ1 class |
| HD1:316 | HD:789 | Stop reason `no_progress` | carried | carried | worker-loop rule 19 |
| HD1:317 | HD:790 | Stop reason `scope_violation` | carried | carried | worker-loop rule 32 |
| HD1:318 | HD:791 | Stop reason `capability_ceiling` | carried | carried | worker-loop rule 34.4 |
| HD1:319 | HD:792 | Stop reason `human_abort` | carried | carried | worker-loop rule 32 (hook veto separated) |
| HD1:320 | HD:794 | Stop reasons never collapsed; core competence signal | carried | carried | worker-loop rule 30 |
| HD1:321 | HD:794 | Six is the vocabulary; new conditions are details, not new members | carried-weaker | deliberate | worker-loop rule 31, §9; DEC-24 (23 stored reasons in one table, seven failure classes and one success class) |
| HD1:322 | HD:796 | Every stop reason names the next action (vacuous tests named; scope file named with widen offer; ceiling names escalati… | carried | carried | worker-loop rules 31–32, WL-11 |
| HD1:323 | HD:800 | Rung 1: typed feedback, same context, max 2 | carried | carried | worker-loop rule 34.1 |
| HD1:324 | HD:801 | Rung 2: fresh pack, same plan, max 1 | carried | carried | worker-loop rule 34.2 |
| HD1:325 | HD:802 | Rung 3: narrow scope or escalate one model tier (competence model chooses); re-decomposition only at rung 4 | contradicted | deliberate | worker-loop rule 34.3, §7, §9 |
| HD1:326 | HD:803 | Rung 4: park with a question naming tried/failed/suspected; re-decomposition an answer | carried | carried | worker-loop rule 34.4 |
| HD1:327 | HD:805 | Worker never re-reads its prior reasoning across rungs; each rung rebuilds from clean pack | carried | carried | worker-loop rule 35 |
| HD1:328 | HD:809 | Reasoning suppressed for mechanical steps; raised for planning or after rung-1 failure | carried | carried | worker-loop rule 24 (policy table) |
| HD1:329 | HD:809 | Prior reasoning stripped between steps unless registry notes benefit | contradicted | deliberate | context rule 4; DEC-24 |
| HD1:330 | HD:811 | Finding: Worker never planned; default profile disabled reasoning | carried | carried | worker-loop §9 / OQ16 context (narrative) |
| HD1:331 | HD:816 | Thinking policy off / surgical / all, `SEKHEMET_THINKING`, recorded in evidence | carried | carried | worker-loop rules 24, 27 |
| HD1:332 | HD:821 | Winner = best pass rate for wall-clock, same build/model, ≥2 runs | contradicted | deliberate | measurement rule 12, §8 Q1, §9 (paired; the cheaper arm wins a tie) |
| HD1:333 | HD:825 | Every habit enforced by structure, never a prompt sentence | carried | carried | worker-loop rule 1 |
| HD1:334 | HD:831 | Broken edit never lands (parse + secret scan before disk) | carried | carried | worker-loop rule 14 |
| HD1:335 | HD:832 | Done means proven: `finish_card` refused while last check failed (strict) | carried | carried | worker-loop rule 26 |
| HD1:336 | HD:833 | Don't repeat what failed: re-running same command with no file change refused; trimming-only variants are the same | carried | carried | worker-loop rule 26, NEW-worker-loop-1 |
| HD1:337 | HD:834 | Acceptance test inline; imported signatures shown before any write; `edit` preferred over whole-file rewrite | carried | carried | worker-loop rule 12; context rules 14–15; planner-pm §2.1.6 |
| HD1:338 | HD:834 | Data contract (interface fields, CREATE TABLE) in the map; files with nothing to build on dropped | carried | carried | context rules 13–14, M5 |
| HD1:339 | HD:835 | Think on first turn and after a failed check | carried | carried | worker-loop rule 24 |
| HD1:340 | HD:836 | Short views, recent history in full, failures cut to the assertion | carried | carried | worker-loop rule 29 (100-line window A/B); context rules 3, 16 |
| HD1:341 | HD:837 | After a failure the next edit states which assertion it addresses (A/B) | carried | carried | worker-loop rule 29 (`hypothesis`) |
| HD1:342 | HD:839 | Fingerprint hashes working-tree content via throwaway index | carried | carried | worker-loop rule 17, WL-1 |
| HD1:343 | HD:839 | Data contract as own section appended to whichever map is used | carried | carried | context rule 14 (gap M5) |
| HD1:344 | HD:839 | Surgical thinking also after a failed automatic re-check | carried | carried | worker-loop rule 24, WL-7 |
| HD1:345 | HD:841 | No planning/todo tool for the Worker; planning upstream | carried | carried | worker-loop rule 28 |
| HD1:346 | HD:843 | Every behaviour-changing mechanism ships behind a switch, admitted by the frozen suite | carried | carried | worker-loop rule 1 |
| HD1:347 | HD:853 | Read semantics: paginated, byte-budgeted; read-before-edit precondition | carried | carried | worker-loop rule 12 |
| HD1:348 | HD:854 | Edit: unique match; `replace_all` for renames; exact whitespace/line endings | contradicted | deliberate | worker-loop rule 12, §9 |
| HD1:349 | HD:855 | Write discouraged for existing files | carried | carried | worker-loop rule 12 |
| HD1:350 | HD:856 | Grep regex, three modes, context lines, head limit, gitignore-aware | carried-weaker | carried | worker-loop rule 12 (regex, three modes, context lines, capped, gitignore-aware) |
| HD1:351 | HD:858 | Bash with timeout and description field | carried-weaker | carried | worker-loop rule 12 (`run_cmd` timeout and description) |
| HD1:352 | HD:863 | Incremental discovery; fewer tools per agent (reviewer: read/grep/glob; implementer + edit/bash; researcher + fetch) | carried-weaker | carried | worker-loop rule 10 |
| HD1:353 | HD:869 | Line numbers 1-based start/end, not offsets | carried | carried | worker-loop rule 12 |
| HD1:354 | HD:870 | Symbol edits + exact-replace fallback with parse gate before write | carried | carried | worker-loop rules 12, 14 |
| HD1:355 | HD:871 | Grep capped, gitignore-aware; repo map answers first | carried | carried | worker-loop rule 12; context rule 13 |
| HD1:356 | HD:872 | Glob identical semantics | carried-weaker | carried | worker-loop rule 12 (`find_files` newest first) |
| HD1:357 | HD:873 | `run` denies raw `cat`/`grep`/`sed` when structured equivalent exists | carried | carried | worker-loop rule 12, WL-5 |
| HD1:358 | HD:874 | Explore, Plan, Implement as card classes with fixed tool lists | carried | carried | worker-loop rule 10; models rule 31 (kinds renamed: spike/interface/implement/data/rule/review/research) |
| HD1:359 | HD:875 | Todo = subtask list + open TODOs in volatile tail | carried | carried | context rule 8 |
| HD1:360 | HD:876 | Ask user = `note` with question and options into card thread and inbox | carried | carried | worker-loop rule 12 (`ask`/`note`) |
| HD1:361 | HD:880 | Deterministic map first, budgeted search second; read-before-edit and uniqueness enforced mechanically; mask and end st… | carried | carried | worker-loop rules 12, 14; context rules 3, 12 |
| HD1:362 | HD:884 | Planner rejects Scrum role-play; deterministic scheduling + automated decomposition | carried | carried | planner-pm §2.7.4; DEC-05 |
| HD1:363 | HD:888 | Responsibilities: decomposition, criteria, difficulty, DAG, prioritisation, budgets, routing, replanning, status from g… | carried | carried | planner-pm §2.1–2.7 |
| HD1:364 | HD:892 | Split until every leaf satisfies tier context and step budget | carried | carried | planner-pm §2.4 Small |
| HD1:365 | HD:896 | SPIDR Spike: research/spike card writing notes and a toy test | carried | carried | planner-pm §2.2 table |
| HD1:366 | HD:897 | SPIDR Path: happy path first | carried | carried | planner-pm §2.2 table |
| HD1:367 | HD:898 | SPIDR Interface = type contracts/schemas first | contradicted | deliberate | planner-pm §2.2, §9 |
| HD1:368 | HD:899 | SPIDR Data: single entity/basic payload first | carried | carried | planner-pm §2.2 |
| HD1:369 | HD:900 | SPIDR Rules: relax validation/auth/rate limits first | carried | carried | planner-pm §2.2 (with hard-invariant exception) |
| HD1:370 | HD:904 | INVEST pre-flight before Planning → In Progress | contradicted | deliberate | planner-pm §2.4, §9; DEC-24 |
| HD1:371 | HD:908 | Independent: zero scope overlap with active cards; DAG acyclic; overlap → serialize | carried | carried | planner-pm §2.4 |
| HD1:372 | HD:909 | Negotiable: criteria not line-by-line syntax; reject → goal criteria | carried | carried | planner-pm §2.4 |
| HD1:373 | HD:910 | Valuable: links to project gate or goal criterion; reject orphans | carried | carried | planner-pm §2.4 (adds epic behaviour) |
| HD1:374 | HD:911 | Estimable: difficulty maps to throughput envelope; >7 forces re-split | carried | carried | planner-pm §2.4 |
| HD1:375 | HD:912 | Small: pack ≤25% of tier working context; step budget ≤40 | carried-weaker | deliberate | planner-pm §2.4, §9; DEC-24 (INVEST Small: 25% of the resolved Worker's window, 4,096 of 16,384; P1 PM-12, PM-13) |
| HD1:376 | HD:913 | Testable: failing test committed before handoff | carried | carried | planner-pm §2.4; gates GT-P1-1 |
| HD1:377 | HD:918 | WSJF = (value + time criticality + risk reduction)/(estimated steps × difficulty) | carried | carried | planner-pm §2.7.2 |
| HD1:378 | HD:919 | RICE for idea-stage repos; weights in config.toml; planner never invents weights | carried | carried | planner-pm §2.7.2 |
| HD1:379 | HD:923 | Estimates in tokens, seconds, steps; never story points | contradicted | deliberate | planner-pm §2.6, §9 |
| HD1:380 | HD:924 | EstimatedTokens = BasePackTokens + Difficulty × HistoricalTokensPerDifficulty[Class]; actuals write back | carried | carried | planner-pm §2.6.1 |
| HD1:381 | HD:929 | ReviewWIP from project's accepted-card history, floored at 1 | carried | carried | review-git §2.2.1–2.2.3 (per project; 15-min prior; gap S6) |
| HD1:382 | HD:929 | Planner opens no more work toward Review than allowed; prefers splitting to keep diffs small | carried | carried | planner-pm §2.7.5 |
| HD1:383 | HD:933 | Routing: difficulty <4 direct with plan; 4–7 edit sketch; >7 split | carried | carried | planner-pm §2.5 |
| HD1:384 | HD:933 | Rung-3 failure or context exceeds tier budget at max decomposition → `capability_ceiling`, escalate with diagnostic | carried | carried | planner-pm §2.5 |
| HD1:385 | HD:937 | Process profiles Kanban / Scrum (sprint goals, reviews, retros) / Shape Up (appetite, betting table); execution always… | carried | carried | planner-pm §2.7.3 |
| HD1:386 | HD:937 | Retros analyse gate failures and synthesise playbook candidates | carried | carried | planner-pm §2.7.4 |
| HD1:387 | HD:941 | Conversation is the main input surface; board is the state; nothing durable in transcript | carried | carried | planner-pm §2.8.3–2.8.5 |
| HD1:388 | HD:943 | Ambiguity resolved in conversation is cheapest; Planner talkative here | carried | carried | design-stage §2.2 |
| HD1:389 | HD:947 | Holds the whole workspace; answers from event log across projects | carried | carried | planner-pm §2.8.5 |
| HD1:390 | HD:948 | Asks before assuming on scope/invariant ambiguity; decides when conventions answer | carried | carried | planner-pm §2.10.1 |
| HD1:391 | HD:948 | Asking about something the playbook already settles is a defect | missing | gap | planner-pm §2.10.1 (a question already settled is a defect), P2 |
| HD1:392 | HD:949 | Proposes; board records; editing in conversation edits cards | carried | carried | planner-pm §2.8.3 |
| HD1:393 | HD:950 | Reports from evidence; never characterises work as going well | carried | carried | planner-pm §2.8.2, §2.8.14 |
| HD1:394 | HD:956 | Conversation never evicts a running Worker; reply waits for step boundary | contradicted | deliberate | planner-pm §2.8.6, §9 |
| HD1:395 | HD:957 | Conversation has no memory of its own; no user profile | contradicted | deliberate | planner-pm §2.13.3, §9 |
| HD1:396 | HD:958 | Conversation cannot accept, override a gate, or mark done | carried | carried | planner-pm §2.8.4 |
| HD1:397 | HD:962 | Terminal is default conversation surface; `sekhemet` opens it; board chat panel is same conversation | later | later | planner-pm §7 |
| HD1:398 | HD:964 | [RESEARCH] Calibrate ask-vs-assume on ClarEval; symmetric failure modes ("you should have known" questions; send-backs… | later | later | planner-pm §7 |
| HD1:399 | HD:970 | Six things: problem, outcome, non-goals, constraints, riskiest assumption, first slice; infer most, say so | carried | carried | design-stage §2.1, §2.3 |
| HD1:400 | HD:972 | Never announce steps; never say "requirements", "phase", "let me gather" | carried | carried | design-stage §2.2.6 |
| HD1:401 | HD:976 | Propose and proceed (calculator example) | carried | carried | design-stage §2.2.1 |
| HD1:402 | HD:982 | Ask only when uncertain and expensive to get wrong | carried | carried | design-stage §2.2.2 |
| HD1:403 | HD:984 | One question at a time, the one that most changes the backlog | carried | carried | design-stage §2.2.3 |
| HD1:404 | HD:986 | A question whose answers produce the same cards is not asked | carried | carried | design-stage §2.2.3; planner-pm §2.10.1 |
| HD1:405 | HD:988 | "Just build it" and silence are complete answers; never re-offered | carried | carried | design-stage §2.2.4 |
| HD1:406 | HD:990 | Nothing blocked on the conversation; question left open on board | carried | carried | design-stage §2.2.5 |
| HD1:407 | HD:994 | Brief at `.sekhemet/brief.md`, versioned, amendable | carried | carried | design-stage §2.3 |
| HD1:408 | HD:998 | Brief sections: Problem (incl. "today instead"), Outcome, Non-goals, Constraints, Prior art (cited, Researcher), Riskie… | carried | carried | design-stage §2.3 |
| HD1:409 | HD:1010 | Prior art researched by the Researcher with sources, not recalled from weights | carried | carried | design-stage §2.5.7 (gap P7) |
| HD1:410 | HD:1016 | Backbone of user activities; thinnest slice through all becomes first cards | carried | carried | design-stage §2.3; planner-pm §2.2.5 |
| HD1:411 | HD:1018 | Narrow and complete over one part deep; unbuilt shape visible | carried | carried | design-stage §2.3; planner-pm §2.2.5 |
| HD1:412 | HD:1020 | Riskiest assumption scheduled first regardless of backbone | contradicted | deliberate | design-stage §9; planner-pm §2.2.4 |
| HD1:413 | HD:1026 | Every slice carries a behaviour with concrete values; model asked for it | carried | carried | planner-pm §2.3.1 |
| HD1:414 | HD:1026 | Without a model, behaviour = spec's own words | carried-weaker | carried | planner-pm §2.1.2, P1 |
| HD1:415 | HD:1026 | Hard invariants ("never", "twice", "exactly once", "idempotent") scheduled right after contract | carried | carried | planner-pm §2.2.3 |
| HD1:416 | HD:1026 | Riskiest assumption planned even if unwritten (billing gets a charge-twice card second in line) | carried | carried | planner-pm §2.2.4 |
| HD1:417 | HD:1030 | Assumptions recorded with defaults, visible on board, outcome recorded when contradicted; measures default quality | carried | carried | design-stage §2.2.9; planner-pm §2.10.4 |
| HD1:418 | HD:1036 | Proportion table: --json flag / calculator / S3 sync / billing | carried | carried | design-stage §2.1 |
| HD1:419 | HD:1043 | Brief written only when worth reading later; otherwise assumptions on cards | carried | carried | design-stage §2.1.2 |
| HD1:420 | HD:1051 | Proportion chosen by rules before any model is loaded | carried | carried | design-stage §2.1.2 |
| HD1:421 | HD:1053 | Brief when money/identity/personal data; never overwrite existing brief; riskiest assumption named | carried | carried | design-stage §2.1.2, v1 acceptance |
| HD1:422 | HD:1054 | At most two questions on hard-to-change external contracts | carried | carried | design-stage §2.1.2 |
| HD1:423 | HD:1055 | One sentence for new project or large change | carried | carried | design-stage §2.1.2 |
| HD1:424 | HD:1056 | Nothing for small change to existing project | carried | carried | design-stage §2.1.2 |
| HD1:425 | HD:1058 | Quality words become constraints with defaults, not cards | carried | carried | design-stage §2.2.8 |
| HD1:426 | HD:1058 | Every default an assumption on every card and on the epic; request phrasing dropped | carried | carried | design-stage §2.2.8–9 |
| HD1:427 | HD:1062 | Reuse survey whenever design stage says anything | carried | carried | design-stage §2.5 |
| HD1:428 | HD:1064 | Registries (npm; PyPI by name) and GitHub, one short keyword query per need; only keywords leave | carried | carried | design-stage §2.5.1–2 (gap P7/S8) |
| HD1:429 | HD:1065 | Literature only for algorithmic work | carried | carried | design-stage §2.5.1 |
| HD1:430 | HD:1067 | Relevance: ≥2 need words in name/description; kind words dropped from query | carried | carried | design-stage §2.5.3 |
| HD1:431 | HD:1067 | Popularity: ≥1,000 weekly downloads or 20 stars | carried | carried | design-stage §2.5.3 |
| HD1:432 | HD:1067 | Licences: permissive recommended; weak copyleft flagged; GPL/AGPL named in exclusions; no licence dropped silently | carried | carried | design-stage §2.5.3 |
| HD1:433 | HD:1069 | "May already cover this", never "already does this"; Worker told to read one before depending | carried | carried | design-stage §2.5.4 (Researcher reads README first; OQ2) |
| HD1:434 | HD:1069 | Archived or untouched 2 years not recommended | carried | carried | design-stage §2.5.3 |
| HD1:435 | HD:1069 | Unreachable source reported as not searched | carried | carried | design-stage §2.5.5 |
| HD1:436 | HD:1071 | Results to person (one line), brief Prior art, each card's dossier with depend-or-note instruction; Worker never search… | carried | carried | design-stage §2.5.6 |
| HD1:437 | HD:1073 | `--offline` / `SEKHEMET_OFFLINE=1` plans without looking and says so | carried | carried | design-stage §2.6.1 |
| HD1:438 | HD:1075 | Not built: riskiest-assumption scheduling, model phrasing, deep Researcher before planning | gap | gap | planner-pm P1; design-stage NEW-design-stage-1, P7 |
| HD1:439 | HD:1081 | New TS project has static layer from first file | carried | carried | design-stage §2.4.1 |
| HD1:440 | HD:1087 | Card zero runs ecosystem generator (`cargo new`, `uv init`, `pnpm create vite`, `npm init`) | carried | carried | design-stage §2.4.1 (gap P2) |
| HD1:441 | HD:1089 | Template library rejected; generator + version recorded in brief | carried | carried | design-stage §2.4.1, §9 Rejected |
| HD1:442 | HD:1093 | Card one: failing test exists, runs, fails for stated reason | carried | carried | design-stage §2.4.2 |
| HD1:443 | HD:1101 | Novel architecture: "talk it through with me, then I will cut the cards" | carried | carried | design-stage §2.4.3 |
| HD1:444 | HD:1105 | Format interactions for rapid "5-second approvals" | contradicted | deliberate | review-git rule 2, §9 (a decision in under a minute, not 5 seconds) |
| HD1:445 | HD:1113 | Steer: free text delivered at next step boundary as `card/steer`, no restart, no prefix invalidation, lands in volatile… | later | later | planner-pm §7 |
| HD1:446 | HD:1114 | Scope amendment mid-card; Worker told | later | later | planner-pm §7 |
| HD1:447 | HD:1115 | Abort with a reason → stop detail + playbook candidate | carried | carried | planner-pm §2.14 |
| HD1:448 | HD:1119 | Steer cannot relax gate, widen permission, accept | later | later | planner-pm §7 |
| HD1:449 | HD:1120 | Steer recorded before delivery; steered outcome flagged, excluded from unattended stats | later | later | planner-pm §7 |
| HD1:450 | HD:1121 | Steering not required for correctness | later | later | planner-pm §7 |
| HD1:451 | HD:1127 | Card state decides: attached human answers in seconds while Worker holds its slot; 60 s single timeout | later | later | planner-pm §7 |
| HD1:452 | HD:1127 | Unattached/deadline: `safe_default` takes recommendation, `default_deny` parks | carried | carried | planner-pm §2.10.3 |
| HD1:453 | HD:1132 | Pause & Persist: card to Parked/Planning, compute and VRAM fully released, scheduler loads next card | carried-weaker | carried | planner-pm §2.10.3 (`default_deny`) |
| HD1:454 | HD:1134 | Durable resume on answer (UI, CLI, notification webhook): `decision/answered`, rehydrate context, resume | carried-weaker | deliberate | planner-pm §2.10.3, §9; DEC-24 (a late answer returns the card to Ready, or to Backlog or Planning if parked from there) |
| HD1:455 | HD:1139 | Question policy: Assume / Ask / Spike | carried | carried | planner-pm §2.10.1 |
| HD1:456 | HD:1142 | Questions batched into one decision request per planning pass | contradicted | deliberate | planner-pm §2.10.1, §9 |
| HD1:457 | HD:1142 | >3 questions → spec rejected as under-specified | contradicted | deliberate | planner-pm §9; DEC-24 |
| HD1:458 | HD:1147 | DecisionRequest shape: options (label, consequence, effortDelta, riskNote, previewSketch), recommendation, policy, defa… | carried | carried | planner-pm §2.10.2; Contract `DecisionRequest` |
| HD1:459 | HD:1171 | previewSketch: files touched, candidate symbol changes, blast radius | carried | carried | planner-pm §2.10.2 |
| HD1:460 | HD:1176 | safe_default for low-risk choices → `decision/default_applied`, proceeds | carried | carried | planner-pm §2.10.3 |
| HD1:461 | HD:1177 | default_deny for overriding gates, deleting files, untrusted deps, DB schema; parks and notifies; never auto-approve de… | carried | carried | planner-pm §2.10.3 |
| HD1:462 | HD:1183 | Session Intake | carried | carried | planner-pm §2.7.8 |
| HD1:463 | HD:1184 | Session Planning: plans, acceptance tests, budgets, one batched decision request | carried | carried | planner-pm §2.7.8 (at most two questions) |
| HD1:464 | HD:1185 | Session Standup: passed, parked, waiting on you, wait times | carried | carried | planner-pm §2.7.8 |
| HD1:465 | HD:1186 | Session Review: accept, return with reason, or split | carried | carried | planner-pm §2.7.8, §2.14 |
| HD1:466 | HD:1187 | Session Retrospective: end of sprint or every N cards | carried | carried | planner-pm §2.7.8 (`retroEveryCards`) |
| HD1:467 | HD:1188 | Session Replan: rung-3 failure, scope change, capacity change; diff vs previous plan | carried | carried | planner-pm §2.7.8 |
| HD1:468 | HD:1192 | Status derived from gates and log, never freehand | carried | carried | planner-pm §2.8.14 |
| HD1:469 | HD:1192 | Standup lists cards by state, decisions waiting, then the machine's plan for the next window | carried-weaker | gap | planner-pm §2.7.8, P6 |
| HD1:470 | HD:1192 | Estimates always show range and basis | carried | carried | planner-pm §2.6.3 |
| HD1:471 | HD:1196 | Escalate on capability_ceiling, external dependency, gate failing for credentials/env drift, budget forecast over cap;… | carried | carried | planner-pm §2.5 |
| HD1:472 | HD:1202 | Human cmd: Accept, Return with reason, Split | carried | carried | planner-pm §2.14 |
| HD1:473 | HD:1203 | Human cmd: Park, Unpark, Reprioritize (recomputes schedule) | carried | carried | planner-pm §2.14 |
| HD1:474 | HD:1204 | Human cmd: Override gate with recorded reason, never security | carried | carried | planner-pm §2.14; kernel rule 22 |
| HD1:475 | HD:1205 | Human cmd: Reroute (force model or arm for a card) | later | later | planner-pm §7 |
| HD1:476 | HD:1206 | Human cmd: Explain evidence behind estimate, route or decision | later | later | planner-pm §7 |
| HD1:477 | HD:1207 | Human cmd: Pause project | missing | gap | runtime §2.17a, NEW-runtime-10 |
| HD1:478 | HD:1207 | Human cmd: Set hours | carried | carried | surface rule 23 `reserved_hours`; runtime rule 17 |
| HD1:479 | HD:1211 | Trust calibration: override rate moves assume→ask, accepted recommendations ask→assume; thresholds visible and adjustab… | carried | carried | planner-pm §2.10.4 |
| HD1:480 | HD:1213 | Override rate >15% shifts category to Ask | carried | carried | planner-pm §2.10.4, v1 acceptance |
| HD1:481 | HD:1217 | Goal: outcome with criteria pursued until met or reported impossible; runs continuously | carried | carried | planner-pm §2.11 |
| HD1:482 | HD:1222 | Goal record fields (workspaceId, projectIds, statement, criteria kind/check/status, budget tokens/hours/deadline, strat… | carried | carried | planner-pm Contract (`Goal` in goals.ts) |
| HD1:483 | HD:1247 | Criteria semantics gate / metric / human; all-human flagged unverifiable | carried | carried | planner-pm §2.11.1 |
| HD1:484 | HD:1251 | `/goal <statement>` opens intake: restate, criteria, budget, assumptions; nothing runs until approved | carried-weaker | later | planner-pm §7 |
| HD1:485 | HD:1251 | Strategy versioned so replans can be diffed | carried | carried | planner-pm §2.11.2–3 |
| HD1:486 | HD:1266 | Criteria re-evaluated on every card close and on a timer | carried-weaker | gap | planner-pm §2.11.3, NEW-planner-pm-4 |
| HD1:487 | HD:1266 | Replan triggers: rung-3 fail, regression of met criterion, budget over cap, dependency or environment change, card adva… | carried-weaker | gap | planner-pm §2.11.3, NEW-planner-pm-4 |
| HD1:488 | HD:1266 | Replan posted to the goal thread with diff and one-paragraph reason | carried-weaker | gap | planner-pm §2.11.3 (posted in Seshat's thread with diff and reason), NEW-planner-pm-4 |
| HD1:489 | HD:1287 | Signal: burn-up vs scope (two curves) → forecast ETA | carried | carried | planner-pm §2.12 |
| HD1:490 | HD:1288 | Signal: scope drift >20% → halt auxiliary cards; decision request | carried | carried | planner-pm §2.12 |
| HD1:491 | HD:1289 | Signal: column p95 > 2.5× p50 → flag congestion, adjust step budget, flag model degradation | carried-weaker | gap | planner-pm §2.12, NEW-planner-pm-5 |
| HD1:492 | HD:1290 | Signal: blocker >12 h (2 h during active work) → top of inbox, batch decisions | carried | carried | planner-pm §2.12 |
| HD1:493 | HD:1291 | Signal: ≥3 gate failures in one file → pause implementation, route to Planner to re-split on Interface/Data | carried-weaker | deliberate | planner-pm §2.12, §9 |
| HD1:494 | HD:1292 | Signal: Review backlog ≥ ReviewWIP → hard back-pressure | carried | carried | planner-pm §2.12 |
| HD1:495 | HD:1293 | Signal: RAID risk register; high-risk assumption >24 h → verification spike | carried | carried | planner-pm §2.12 (proposed spike) |
| HD1:496 | HD:1295 | Responses automatic within visible preset bounds, else decision request | carried | carried | planner-pm §2.12 (automatic only when no person-owned field changes) |
| HD1:497 | HD:1299 | Goal view: statement, criteria, burn-up, strategy graph, risk register, forecast range, filtered inbox | later | later | planner-pm §7; dashboard §7 |
| HD1:498 | HD:1299 | Goal with no state change in a configurable window is highlighted | missing | later | planner-pm §7 (goal view) |
| HD1:499 | HD:1303 | Multiple goals by WSJF; one may be sole active; scheduler explains per window | carried | carried | planner-pm §2.11.4 |
| HD1:500 | HD:1307 | Goal met only when all criteria met and verified; blocked with diagnosis; never partial as done | carried | carried | planner-pm §2.11.5 |
| HD1:501 | HD:1311 | gates.toml versioned, Worker cannot modify; tampering detected by hash fails the card | carried | carried | gates rule 2, GT-1 |
| HD1:502 | HD:1317 | Layer Static (parse, format, lint, typecheck) on gate host | carried | carried | gates rule 3 |
| HD1:503 | HD:1318 | Layer Functional incl. acceptance tests first | carried | carried | gates rule 3 |
| HD1:504 | HD:1319 | Layer Robustness: mutation score, coverage delta; nightly for large diffs | carried-weaker | gap | gates rule 3, NEW-gates-5 (GT-N5-5 nightly beyond mutation_max); coverage delta later §7 |
| HD1:505 | HD:1320 | Layer Security: secret scan, dependency existence + allowlist, vuln scan | carried | carried | gates rule 3 |
| HD1:506 | HD:1321 | Layer Visual on gate host with a browser | carried | carried | gates rules 3, 29 |
| HD1:507 | HD:1322 | Layer Hygiene: changelog, no debug output, commit trailers (Agent-Model, Agent-Harness, Agent-Role, Co-authored-by) on… | carried | carried | gates rules 3, 17; review-git §2.5.4 |
| HD1:508 | HD:1323 | Layer Human: review with evidence on the board | carried | carried | gates rule 3 |
| HD1:509 | HD:1327 | Planner writes acceptance tests first; they must fail; Worker cannot edit gate test patterns | carried | carried | gates rules 5–7 |
| HD1:510 | HD:1333 | Visual 1: runtime exceptions, HTTP ≥400, unhandled rejections | carried | carried | gates rule 29 |
| HD1:511 | HD:1334 | Visual 2: bounding boxes: overlap, zero size, off-screen, horizontal overflow | carried | carried | gates rule 29 |
| HD1:512 | HD:1335 | Visual 3: element screenshots, masking, animations off, maxDiffPixelRatio 0.01 | carried | carried | gates rule 29 |
| HD1:513 | HD:1336 | Visual 4: axe-core at 1280 and 375 px, zero critical | carried | carried | gates rule 29 |
| HD1:514 | HD:1337 | Visual 5: atomic yes/no checklist at temperature 0 | carried | carried | gates rule 30 (gap NEW-gates-4) |
| HD1:515 | HD:1339 | Vision model can fail but never pass; baselines need human approval; blocks nothing until false-pass measured | carried | carried | gates rules 30–31; OPEN_QUESTIONS #10 |
| HD1:516 | HD:1343 | Mutation diff-scoped, advisory then blocking per project, never 100% | carried | carried | gates rule 32 |
| HD1:517 | HD:1347 | Secrets gate scans what the branch adds, excluding staged acceptance tests | carried | carried | gates rule 15, GT-4 |
| HD1:518 | HD:1349 | Evidence contents: diff, gate results, test output, screenshots, scan reports, stop reason, tried-and-abandoned | carried | carried | gates rule 35 |
| HD1:519 | HD:1357 | Evidence `structuralDiff` (difftastic) | later | later | gates §7 (structural diff in the bundle) |
| HD1:520 | HD:1370 | Evidence `trajectoryRef` = SHA-256 of event-log slice | carried-weaker | gap | gates rule 35, T1 (GT-T1-9 trajectory hash) |
| HD1:521 | HD:1380 | Reachability: export reachable if production imports it or contract asks for it (tests wherever, spec, criteria) | carried | carried | gates rule 24 |
| HD1:522 | HD:1382 | Card's own unit tests don't make code reachable; only card-added exports judged; entry points public | carried | carried | gates rule 24 |
| HD1:523 | HD:1386 | Rejected: "no production caller fails the card" | carried | carried | gates §9 (not to be re-proposed) |
| HD1:524 | HD:1387 | Rejected: fixture-layout-only acceptance tests | carried | carried | gates §9, GT-P1-3 |
| HD1:525 | HD:1388 | Errs toward reachable: name in any import clause counts; word in card text counts | carried | carried | gates rule 24 |
| HD1:526 | HD:1390 | Remedy: wire in, un-export, or `note` naming a later card — each one edit | carried | carried | gates rule 24, GT-5 |
| HD1:527 | HD:1396 | Regression: failures of tests on main restated as regressions listing changed files | carried | carried | gates rule 25 |
| HD1:528 | HD:1396 | Refuses removed or emptied tests from main | carried | carried | gates rule 25 |
| HD1:529 | HD:1398 | Judges against main, never card's own tests; outside git judges nothing | carried | carried | gates rules 15–16 (integration branch, not hard-coded main) |
| HD1:530 | HD:1400 | Only code files count as tests; file empty on main can't be emptied | carried | carried | gates rule 25 |
| HD1:531 | HD:1400 | Failure carries test content from main so restoring is one write | carried | carried | gates rule 21, GT-6 |
| HD1:532 | HD:1400 | A test too long to carry is reported with `note` instead | missing | carried | gates rule 21, GT-12 (built) |
| HD1:533 | HD:1404 | Architecture gate reads brief Invariants on every verification | carried | carried | gates rule 26 |
| HD1:534 | HD:1406 | Form `A/` does not import `B` (trailing `/` = directory) | carried | carried | gates rule 26 |
| HD1:535 | HD:1407 | Form `Name` is defined only in `path` | carried | carried | gates rule 26, GT-T2-2 |
| HD1:536 | HD:1409 | Judges only changed files; remedies single edit (remove import / delete duplicate and import original) | carried | carried | gates rules 15, 21, GT-7 |
| HD1:537 | HD:1409 | No brief or no invariants → enforces nothing | carried | carried | gates rule 26 |
| HD1:538 | HD:1411 | Unmatched line is "not enforced" and said so; showing on board not built | gap | gap | gates rule 26, NEW-gates-1 |
| HD1:539 | HD:1413 | All three project gates wrap every card's gate run regardless of gates.toml | carried | carried | gates §Project gates intro |
| HD1:540 | HD:1421 | Arithmetic: 4 rungs × 4 samples = 16 gate runs; gates dominate cost | carried | carried | gates rule 33 |
| HD1:541 | HD:1423 | Impacted tests first, short-circuit; full suite once before Review | carried | carried | gates rule 33, GT-N3-2 (gap) |
| HD1:542 | HD:1424 | Verdict cached by tree hash + gate's pinned hash | carried | carried | gates rule 33, GT-N3-1 (gap) |
| HD1:543 | HD:1425 | Static before functional, ordered by cost | carried | carried | gates rule 33, GT-N3-3 (gap) |
| HD1:544 | HD:1426 | Each gate has a timeout; timeout = failure with own repair procedure | carried | carried | gates rule 33 |
| HD1:545 | HD:1432 | Flaky: re-run failing tests once on unchanged tree before first rung; quarantine, report with both runs | carried | carried | gates rule 34, GT-N3-4 (gap) |
| HD1:546 | HD:1433 | Wrong gate: Worker stops with a stop reason naming gate and reason; human decides | carried | carried | gates rule 18, GT-M6-5 (`gate_suspected`, gap) |
| HD1:547 | HD:1434 | Gate that cannot run: needs declared in gates.toml; unavailable stated in evidence, never silently skipped | carried | carried | gates rules 9–10, GT-T1-7 |
| HD1:548 | HD:1438 | Harness never asks user to pick model or context size | carried | carried | surface rule 2 (Default); models rule 7 |
| HD1:549 | HD:1446 | Named defaults fetchable and hash-verified from a source in the component register | gap | gap | models rule 4, NEW-models-7 (explicit fetch, hash-verified; R7) |
| HD1:550 | HD:1447 | doctor verifies weights exist, readable, hash before anything green | carried | carried | models rule 5, MD-6 (hash: NEW-models-7) |
| HD1:551 | HD:1448 | One override `--models-dir` + config equivalent; per-model env vars not a surface | carried | carried | models rule 6; surface rule 27 |
| HD1:552 | HD:1450 | No shipped model path outside user config (absolute, external volume, author dirs) | carried | carried | models rule 6, MD-N7-3 |
| HD1:553 | HD:1454 | Calibration: memory budget, bandwidth, prefill/decode per context length; sweep batch and offload one step back from cl… | carried | carried | models rule 7, NEW-models-1 |
| HD1:554 | HD:1458 | Tier table S/M/L/XL (budget, planner, worker, co-load, working context, parallel cards) | carried | carried | models rule 8 (identical) |
| HD1:555 | HD:1465 | Model names absent; registry fills from measurement; larger tiers buy co-residency not prompt | carried | carried | models rule 8 |
| HD1:556 | HD:1469 | Throughput floors: overnight 40/10 ~70 s; interactive 100/20 ~30 s; recommended 300/40 ~12 s | carried | carried | models rule 9 (identical) |
| HD1:557 | HD:1475 | Below overnight floor refuse cards and say why; below 16 GB unsupported | carried | carried | models rule 9, MD-N2-1 (gap) |
| HD1:558 | HD:1479 | KV 8-bit; lower only if model qualifies with it | carried | carried | models rule 10 |
| HD1:559 | HD:1479 | Flash attention on; prefill batch swept; expert offload only when needed | carried | carried | models rule 10 |
| HD1:560 | HD:1479 | Speculative decoding via MTP or qualified draft models where bandwidth permits | carried-weaker | gap | models rule 13, M7/M11, NEW-models-8 |
| HD1:561 | HD:1481 | Sampling per model in registry, not global | carried | carried | models rule 11, MD-N4-2 |
| HD1:562 | HD:1481 | Templates pinned per build with SHA-256 | carried | carried | models rule 12 |
| HD1:563 | HD:1485 | Engine adapter: llama.cpp baseline; MLX on Apple Silicon; choose by measurement weighting cache retention | carried | carried | models rule 14 (MLX status contradicted, see HD:221) |
| HD1:564 | HD:1485 | [BENCH] engine choice on 24 GB M4 | carried | carried | OPEN_QUESTIONS #3 |
| HD1:565 | HD:1490 | Watchdog polls OS pressure and VRAM every 2 s | carried | carried | models rule 19 |
| HD1:566 | HD:1491 | 85%: suspend speculative decoding | carried | carried | models rule 19 (elevated, 0.85), MD-M11-3 |
| HD1:567 | HD:1492 | 90%: throttle parallel cards to 1, trim LSP symbol caches, cascade observation pointers across older turns | carried-weaker | gap | models rule 19 (high level: parallel cards to one, LSP caches, forced masking), NEW-models-2 |
| HD1:568 | HD:1493 | 94%: pause active turns gracefully and persist state to SQLite WAL | carried | carried | models rule 19 (critical 0.94 pauses; emergency unloads) |
| HD1:569 | HD:1497 | Declared hours; backlog worked outside; swaps batched by project; planning in scheduled blocks when co-loading impossib… | carried | carried | models rule 20, NEW-models-3 (gap) |
| HD1:570 | HD:1505 | Four roles and their jobs; Reviewer from a different family | carried | carried | models rule 21 |
| HD1:571 | HD:1507 | Roles are `ModelEntry.roles` values, not agents; no simulated conversation | carried | carried | models rule 22; DEC-05 |
| HD1:572 | HD:1509 | One model may hold several roles; never co-reside below 32 GB | carried | carried | models rule 22 |
| HD1:573 | HD:1509 | Absent role degrades to named fallback (no Reviewer → unreviewed and card says so; no Researcher → repo only) | carried | carried | models rule 23, MD-5 |
| HD1:574 | HD:1511 | Fifth role only when an existing one cannot be qualified | carried | carried | models rule 24 |
| HD1:575 | HD:1516 | ModelEntry fields (family, quant, size, window, template, sampling, reasoning, toolArm, scriptCapable, throughput per b… | carried | carried | models rule 25 (vision now a capability, not a role) |
| HD1:576 | HD:1551 | Qualification suite: own tool schemas, deterministic scoring; schema validity, selection, arguments, multi-turn recover… | carried | carried | models rule 27 |
| HD1:577 | HD:1553 | Worker bar internal, not comparable to public leaderboards; multi-turn below single-turn accounted | carried | carried | models rule 27 |
| HD1:578 | HD:1557 | Bake-off: closed issues + fixing commits → fail-to-pass; recent commits → reconstruction; run under real harness | carried | carried | models rule 30 |
| HD1:579 | HD:1559 | Every result recorded with full settings; number without settings inadmissible | carried | carried | models rule 30; models §1 |
| HD1:580 | HD:1566 | cardClass = "<kind>:<ext>" | carried | carried | models rule 31 |
| HD1:581 | HD:1569 | Seven closed kinds; ext from primary scope extension or `none` | carried | carried | models rule 31 |
| HD1:582 | HD:1573 | Class properties: predictable, knowable before run, coarse enough to fill | carried | carried | models rule 31 |
| HD1:583 | HD:1577 | Tool sets by kind; budgets, routes, exemplars by whole class | carried | carried | models rule 31 |
| HD1:584 | HD:1581 | Competence row: class, files, difficulty, model, arm, step budget, stop reason, gate failures | carried | carried | models rule 32 |
| HD1:585 | HD:1583 | Prediction, decision, outcome as three separate fields | gap | gap | models rule 32, NEW-models-6 |
| HD1:586 | HD:1585 | [RESEARCH] task synthesis: closed PRs, fail-to-pass invariant, scrubbed paths | carried | carried | OPEN_QUESTIONS research gaps row 1 |
| HD1:587 | HD:1587 | [BENCH] card size vs pass rate sets decomposition granularity | carried | carried | OPEN_QUESTIONS #6 |
| HD1:588 | HD:1591 | Every prompt change A/B tested against the card eval before shipping | carried-weaker | gap | context rule 21a, NEW-context-6 (CX-N6-2); measurement rule 16c |
| HD1:589 | HD:1597 | Guidance: scoped, dated, attributed, retired, delivered in stable zone at card boundary | carried | carried | context rule 23 |
| HD1:590 | HD:1599 | Measurements keyed by class and settings | carried | carried | context rule 23 |
| HD1:591 | HD:1601 | Fetched bytes content-addressed, expire by mutability, safe to delete | carried | carried | context rule 23 (expiry schedule in design-stage Later) |
| HD1:592 | HD:1603 | A fourth store is a design error; one location and one writer per kind | carried | carried | context rule 23; DEC-22 ("seventh durable store" row — numbering odd but intent kept) |
| HD1:593 | HD:1607 | System prompt short; <1,000 tokens; tool interface <2,000 | carried | deliberate | context rule 10; DEC-27 (system prompt ≤ 700, tool interface ≤ 1,700 tokens) |
| HD1:594 | HD:1609 | Positive concrete instructions; no persona; tags not JSON reasoning | carried | carried | context rule 21 |
| HD1:595 | HD:1613 | Playbook per project, versioned, zone 2, grows by delta | carried | carried | context rule 24 |
| HD1:596 | HD:1615 | Entries from gate failures and retros, deduplicated, applied at card boundaries, with origin, retirable | carried | carried | context rule 24 |
| HD1:597 | HD:1618 | Playbook TOML fields: id, originCard, triggerGate, pattern, instruction, effectiveDate, evalPassRateDelta | carried | carried | context rule 24 (id, origin card, trigger gate, instruction, effective date, evidence; pattern → scope) |
| HD1:598 | HD:1631 | Exemplars: 1–2 from own history; no generic examples | carried | carried | context rule 25 |
| HD1:599 | HD:1635 | Offline optimiser in idle hours with planner as reflection engine; keep only if clears threshold; drop if <5% | later | later | context §7 |
| HD1:600 | HD:1639 | Prompts, playbooks, tool schemas versioned together; change invalidates qualification and triggers a re-run | carried-weaker | gap | context rule 27, NEW-context-6 |
| HD1:601 | HD:1643 | Reviewer answers "does this change do what the card asked?" | carried | carried | review-git §2.3.1 |
| HD1:602 | HD:1647 | Trigger: every card entering Review with a diff; research/no-diff skip | carried | carried | review-git §2.3.2 |
| HD1:603 | HD:1649 | Inputs: spec, criteria, diff, gate results; not the transcript | carried | carried | review-git §2.3.3 |
| HD1:604 | HD:1651 | Procedure: per criterion met/unmet with hunk; three failure modes gates miss | carried | carried | review-git §2.3.4 |
| HD1:605 | HD:1656 | ReviewFinding shape | carried | carried | review-git §2.3.5 |
| HD1:606 | HD:1664 | Authority none | carried | carried | review-git §2.3.6 |
| HD1:607 | HD:1666 | Different family enforced; unfilled role said in Review | carried | carried | review-git §2.3.7 (gap P8) |
| HD1:608 | HD:1668 | Acceptance: flags more seeded defects than empty list; FP low enough that a human reads by card 20 | carried | carried | review-git P8, OQ2 |
| HD1:609 | HD:1676 | Frozen suite 20–40 tasks, versioned; no edits to improve results; hash recorded with every result | carried | carried | measurement rules 1–2 |
| HD1:610 | HD:1678 | One number (tasks passed) with cost (wall-clock, tokens, repair-rung cards); non-improving change is not an improvement | carried | carried | measurement rule 4 |
| HD1:611 | HD:1680 | Suite doesn't measure planning; planning measure beside it (fail-before/pass-after reference; end-to-end share) | carried | carried | measurement rule 14 (gap T7) |
| HD1:612 | HD:1684 | Suite gates the self-improvement loop | carried | carried | measurement rule 17 |
| HD1:613 | HD:1685 | Suite qualifies registry models | carried | carried | models rule 27 |
| HD1:614 | HD:1686 | Suite gates asserted-not-measured components (pruner) | carried | carried | measurement rule 16 |
| HD1:615 | HD:1690 | Null baselines at equal budget; random line dropping; 31 of 60; delete if not beaten | carried | carried | measurement rule 16; context §9 |
| HD1:616 | HD:1696 | IRT calibration against SWE-bench per-instance results (~10⁵) | later | later | measurement §7 (IRT calibration against SWE-bench) |
| HD1:617 | HD:1698 | Limits: Python-heavy; scaffold dominates (16.7% vs 47.9%); only pass/fail matrix importable, not patches | carried | carried | measurement Later; models rule 32 |
| HD1:618 | HD:1702 | One mechanism: signal → bounded proposal → suite → pinned → auto-rollback if pass rate drops over next ten cards | contradicted | deliberate | measurement rule 18(3), §9; DEC-24 (paired rollback) |
| HD1:619 | HD:1722 | Six inlets with signals, proposals, bounds (1 rule/retro; ≤15%/cycle; 1 skill; 2/class; revert-and-fail; advisory tests) | carried | carried | measurement rule 17 (identical) |
| HD1:620 | HD:1731 | Seventh inlet justified by signal size, not paper | carried | carried | measurement rule 17 |
| HD1:621 | HD:1735 | Guardrail 1: measured signal; subjective self-assessment rejected everywhere incl. research prose | carried | carried | measurement rule 18; design-stage §2.7.5 |
| HD1:622 | HD:1736 | Guardrail 2: bounded change; whole-system rewrites blocked | carried | carried | measurement rule 18 |
| HD1:623 | HD:1737 | Guardrail 3: atomic rollback over moving ten-card window | contradicted | deliberate | measurement rule 18; DEC-24 |
| HD1:624 | HD:1738 | Guardrail 4: grounded admission (100% / 34.5% / 6.2%); skills and tests admitted by execution as GateResults | carried | carried | measurement rule 18(4); §9 |
| HD1:625 | HD:1742 | Volume thresholds below which inlets report insufficient data | carried | carried | measurement rule 20 |
| HD1:626 | HD:1746 | Playbook: 3 occurrences | carried | carried | measurement rule 20 |
| HD1:627 | HD:1747 | Budgets/routes: MIN_ARM_TRIALS per arm, Wilson excludes incumbent | carried | carried | measurement rule 20 (MIN_ARM_TRIALS = 5) |
| HD1:628 | HD:1748 | Skills: 3 instances and checks pass | carried | carried | measurement rule 20 |
| HD1:629 | HD:1749 | Exemplars: 5 accepted cards in class | carried | carried | measurement rule 20 |
| HD1:630 | HD:1750 | Synthesized tasks and generated tests: no minimum | carried | carried | measurement rule 20 |
| HD1:631 | HD:1753 | Difficulty prior from SWE-bench Verified annotations (1,699, 3 annotators), scale only | carried | carried | measurement rule 22 |
| HD1:632 | HD:1753 | Pre-filter calibrated from public pairs by monotone correction, gated on minimum trials | carried | carried | measurement rules 21–22 |
| HD1:633 | HD:1753 | Exemplars, playbook rules, routing local-only | carried | carried | measurement rule 22; context rule 25; DEC-22 |
| HD1:634 | HD:1757 | Weight updates excluded in v1; fine-tuning deferred until in-context plateaus | carried | carried | measurement rule 23; DEC-22 |
| HD1:635 | HD:1757 | Loop driver, gate runner, sandbox boundaries, permission tables permanently excluded from self-modification | carried | carried | measurement rule 23 |
| HD1:636 | HD:1759 | [BENCH] inlet gains; each enabled only after beating baseline | carried | carried | OPEN_QUESTIONS #15 |
| HD1:637 | HD:1763 | `sekhemet dev audit` command | carried-weaker | deliberate | measurement rule 24, §9 (dev audit's function in doctor and qualify) |
| HD1:638 | HD:1764 | Net gain per skill/rule vs bare baseline on the suite | carried | carried | measurement rule 24 (gap NEW-measurement-2) |
| HD1:639 | HD:1765 | Context debt: >300 Zone-2 tokens without significant ≥+3% gain | carried | deliberate | measurement rule 24; DEC-28 (context debt judged on paired credit or a "not established" A/B; the 3-point test cannot be resolved on 30 cards) |
| HD1:640 | HD:1766 | Conflicting/redundant/obsolete rules flagged; retire with a single keystroke | carried | carried | measurement rule 24 ("one action") |
| HD1:641 | HD:1774 | No self-critique; extra compute to bounded repeated sampling with gate selection; applies to code, plans, research prose | carried | carried | worker-loop rule 3; design-stage §2.7.5 |
| HD1:642 | HD:1780 | Ladder rung 1 same context typed failure | carried | carried | worker-loop rule 34.1 |
| HD1:643 | HD:1781 | Rung 2 fresh context discarding the polluted conversation | carried | carried | worker-loop rule 34.2 |
| HD1:644 | HD:1782 | Rung 3 narrowed scope or escalated model, chosen by competence model | contradicted | deliberate | worker-loop rule 34.3, §7, §9 |
| HD1:645 | HD:1783 | Rung 4 park with a decision request; never silent | carried | carried | worker-loop rule 34.4 |
| HD1:646 | HD:1785 | A rung that does not change inputs is not a rung | carried | carried | worker-loop rule 35 |
| HD1:647 | HD:1785 | Three failures with different contexts → route to Planner for decomposition, not a fourth attempt | carried | carried | worker-loop rule 36 |
| HD1:648 | HD:1787 | Every stop reason names next action; `vacuous_tests`, `rebase_conflict`, `integration_failed` carry remedy | carried | carried | worker-loop rules 31–32; OQ1 environment class |
| HD1:649 | HD:1794 | GateFailure shape: gate, location, expected, actual, minimalRepro, suggestedAction | carried | carried | gates rule 19, GT-M6-6 |
| HD2:1 | HD:1804 | Raw logs never pasted into context; kept in the evidence bundle, retrievable by reference | carried | carried | gates.md §2.19; context.md §2.16 |
| HD2:2 | HD:1804 | At most three failures per repair attempt | carried | carried | gates.md §2.20, GT-T1-4 (cap applied once, after all gates) |
| HD2:3 | HD:1804 | Failures chosen in topological dependency order (fixing the first often clears the rest) | carried | carried | gates.md §2.20 (parse, typecheck, test, bounds, lint; most-referenced file first) |
| HD2:4 | HD:1808-1810 | A suggestedAction must be completable in one step; the information a remedy depends on belongs in the failure | carried | carried | gates.md §2.21; worker-loop.md §2.2 |
| HD2:5 | HD:1810 | Missing export: failure lists the module's real exports inline and says there is no need to re-read | gap | gap | gates rule 21, M6 (GT-M6-3) |
| HD2:6 | HD:1810 | Unknown member: failure lists the type's real members, from project types and Node's wherever the package manager keeps… | carried | carried | gates.md §2.21 |
| HD2:7 | HD:1812 | No reply the Worker receives is a dead end: if a call cannot do what was asked, the reply names the call that can | carried | carried | worker-loop.md §2.2 |
| HD2:8 | HD:1812 | A `tool_search` query that names files answers with the files themselves: at most 3 files, from inside the worktree, ea… | missing | carried | worker-loop rule 12, WL-13 |
| HD2:9 | HD:1812 | A `tool_search` query naming code symbols (e.g. `ChronicleEvent`, `GENESIS_HASH`) loads `read_symbol` and names the cal… | missing | gap | worker-loop rule 12, M2 |
| HD2:10 | HD:1814-1816 | Gate failure, scope denial and stall are all refusals under the repair contract: typed, with the action attached | carried | carried | worker-loop.md §2.16 |
| HD2:11 | HD:1818 | Scope denial names what the card may modify; if the change belongs elsewhere, stop and report rather than retry | carried | carried | worker-loop.md §2.16 |
| HD2:12 | HD:1819 | Stall: the first repetition on an unchanged tree is a warning; only a repeat after the warning ends the card | carried | carried | worker-loop.md §2.18, WL-2 |
| HD2:13 | HD:1819 | The warning belongs to a stall episode, not the card; a non-stall turn ends the episode | carried | carried | worker-loop.md §2.18, WL-2 |
| HD2:14 | HD:1823 | Repeated sampling: N independent attempts from the same context pack, each gated, first to pass taken | carried | carried | worker-loop.md §2.37 (`pass_at_k`, samples 2..k at temperatures 0.4–0.7) |
| HD2:15 | HD:1823 | N is capped, and the cap is per hardware tier | carried-weaker | later | worker-loop §7 |
| HD2:16 | HD:1823 | Sampling without gate selection is never used | carried | carried | worker-loop.md §2.37 |
| HD2:17 | HD:1825 | Local verifier to rank passing attempts / triage failing ones; only if it beats gate-only selection at equal wall-clock | later | later | gates §7 (second verifier only if it beats gate-only selection) |
| HD2:18 | HD:1829 | Cross-validation: each attempt's implementation run against the others' tests; disagreement routes to the planner, not… | carried | carried | worker-loop.md §2.38, WL-9 |
| HD2:19 | HD:1833 | Fails closed: if isolation cannot be established, the card does not run | gap | gap | security rule 7, S3b (SEC-20) |
| HD2:20 | HD:1837 | macOS: `sandbox-exec` with a generated Seatbelt profile; writes only to the worktree and tmp | carried | carried | security.md §2.9 (a private scratch directory, not the system tmp) |
| HD2:21 | HD:1837 | Linux: user namespaces + Landlock path restrictions + seccomp-bpf syscall filters | contradicted | deliberate | security rule 17; DEC-21 (bubblewrap; Landlock and seccomp as hardening) |
| HD2:22 | HD:1837 | Missing or failing sandbox capabilities abort execution immediately | gap | gap | security rule 7, S3b |
| HD2:23 | HD:1839 | The sandbox is an interface with one macOS implementation; containment tests fail loudly if `sandbox-exec` changes | carried | carried | security.md §2.13 |
| HD2:24 | HD:1839 | Migrating off deprecated `sandbox-exec` is recorded as a known liability | carried-weaker | carried | security rule 13 (recorded known liability, §8 Q4) |
| HD2:25 | HD:1839 | The bubblewrap fallback is recorded in the evidence bundle, so a card's isolation level is visible | carried | carried | security.md §2.8 (`seatbelt`/`bubblewrap`/`none` on every card and in `doctor`) |
| HD2:26 | HD:1841 | Network denied inside the sandbox by default | carried | carried | security.md §2.29 |
| HD2:27 | HD:1841 | An allowlisting proxy outside the sandbox mediates dependency installs; every request logged with its SHA-256 payload h… | carried | carried | security.md §2.30 (`card/egress` event; plus loopback/private/port refusals, S3) |
| HD2:28 | HD:1845 | Each card gets its own git worktree | carried | carried | security.md §2.24a |
| HD2:29 | HD:1845 | Worktrees made by copy-on-write cloning (APFS, reflink on Btrfs/XFS) | contradicted | deliberate | security rule 24a; DEC-21 (plain worktrees) |
| HD2:30 | HD:1845 | Symlinked, gitignored dependency directories (`node_modules`, `.venv`) shared into the worktree | carried-weaker | carried | security rule 24 (node_modules links; `.venv` linked whole, read-only) |
| HD2:31 | HD:1849 | Three permission tiers Allow / Ask / Deny; Deny wins | carried | carried | security.md §2.25 |
| HD2:32 | HD:1850 | Allow: reads inside the repo; writes inside declared scope | carried | carried | security.md §2.25 |
| HD2:33 | HD:1851 | Ask: destructive git operations; network to allowlisted domains; external binaries | carried | carried | security.md §2.25 (enumerates the destructive commands) |
| HD2:34 | HD:1852 | Deny: writes outside scope, non-allowlisted network, gate files, gate test paths, harness loop, sandbox configs; perman… | carried | carried | security.md §2.25 (adds `.git`, extension files, `.sekhemet/` state) |
| HD2:35 | HD:1856 | Supply chain: the package must exist in the registry before it is added | carried | carried | security.md §2.44, SEC-41 |
| HD2:36 | HD:1856 | Check the package's age and download profile | carried | carried | security.md §2.44 (younger than 30 days needs a person; weekly downloads recorded) |
| HD2:37 | HD:1856 | Levenshtein distance against existing dependencies to catch typosquats | carried | carried | security.md §2.44 (distance 2, or 1 for ≤4 characters; separators; popular packages as well) |
| HD2:38 | HD:1856 | Vulnerability scanning offline with `osv-scanner` | carried | carried | security.md §2.44 |
| HD2:39 | HD:1860-1861 | Restricted mode: the `run` (bash) tool is stripped | carried | carried | security.md §2.43; worker-loop.md §2.13, WL-6 |
| HD2:40 | HD:1862 | Restricted mode: all egress blocked at the OS sandbox layer | carried | carried | security.md §2.43 |
| HD2:41 | HD:1863 | Restricted mode: read-only AST inspection, static analysis (typecheck, lint) and structural diff preview | carried-weaker | later | security rule 43; gates §7 (structural diff preview joins with difftastic) |
| HD2:42 | HD:1867 | Issue text, PR comments, file contents and synced data are untrusted data, never instructions | carried | carried | security.md §2.1 (threat model), §2.42 |
| HD2:43 | HD:1867 | Wrapped as `<untrusted_content source="…">` with a system contract that instructions inside cannot issue tool calls | carried | carried | security.md §2.42 |
| HD2:44 | HD:1867 | Tool calls from a step whose context holds untrusted content fall under strict permission policies | carried | carried | security.md §2.42, SEC-40 (no Ask-tier or network commands in that step) |
| HD2:45 | HD:1869 | Prompt-injection defence by architectural containment: sandbox, `filesTouched` writes, egress denial, human gate for ir… | carried | carried | security.md §2.42b, 42c |
| HD2:46 | HD:1873 | Works fully offline; every integration is an opt-in adapter; none is load-bearing | carried | carried | integrations.md §2.1 |
| HD2:47 | HD:1878-1888 | `SyncAdapter` interface: `pull(since)`, `push(card)`, `update(ref, patch)`, capabilities (hierarchy, dependencies, webh… | carried | carried | integrations.md §2.7 |
| HD2:48 | HD:1891 | The board owns card state, gate results and budgets; the tracker owns title, description, assignee and labels | carried | carried | integrations.md §2.4 |
| HD2:49 | HD:1891 | Shared-field conflicts: last-writer-wins by timestamp, loser kept in card history | contradicted | deliberate | integrations §2.4 |
| HD2:50 | HD:1897 | Git adapter always on: branches, worktrees, commits, local remotes | carried | carried | review-git.md §2.6 |
| HD2:51 | HD:1898 | Forgejo as the offline-friendly self-hosted sync target: issues, dependencies, boards, webhooks | carried-weaker | later | integrations §7, §8 Q4 |
| HD2:52 | HD:1899 | GitHub adapter: issues, sub-issues, projects, pull requests, check runs | carried | carried | integrations.md §2.10-16 |
| HD2:53 | HD:1901 | GraphQL is needed for sub-issues/projects and has a separate rate budget from REST | gap | gap | integrations §2.11a, P9 |
| HD2:54 | HD:1901 | Adapter prefers webhooks over polling | missing | gap | integrations §2.11a, P9 |
| HD2:55 | HD:1901 | Adapter batches nested GraphQL queries | missing | gap | integrations §2.11a, P9 |
| HD2:56 | HD:1901 | Idempotency keys per synced entity | gap | gap | integrations §2.11a, P9 |
| HD2:57 | HD:1901 | Back off on secondary rate limits | gap | gap | integrations §2.11, P9 |
| HD2:58 | HD:1901 | Hierarchy depth clamped to the shallower of the harness's four levels and the target's | carried | carried | integrations.md §2.7 |
| HD2:59 | HD:1905 | Reads `AGENTS.md` and `CLAUDE.md` when present and folds them into project conventions in prompt Zone 2 | carried-weaker | carried | context rule 8, CX-8 |
| HD2:60 | HD:1905 | Exposes an MCP server over board and card operations | carried | carried | extensibility.md §2.18-21 |
| HD2:61 | HD:1905 | Consumes MCP tools a project declares | carried | carried | extensibility.md §2.22-24 |
| HD2:62 | HD:1905 | An editor-protocol surface so external editors can drive a card | later | later | extensibility §7 (card-level editor protocol) |
| HD2:63 | HD:1909 | CI as a gate source: existing CI checks declared as gates, run locally through `act` or native runners, results uniform | later | later | integrations §7 |
| HD2:64 | HD:1911 | Externally edited issue mid-card: non-scope fields reconciled on completion; a scope/criteria change pauses the card an… | contradicted | deliberate | integrations §2.5, §9 (R6), INT-11a |
| HD2:65 | HD:1915 | GitHub integration never requires personal access tokens | carried | carried | integrations.md §2.10 |
| HD2:66 | HD:1920 | App signs RS256 JWTs and exchanges them at `POST /app/installations/{id}/access_tokens` for 1-hour installation tokens | carried | carried | integrations.md §2.10 |
| HD2:67 | HD:1921 | Private keys and tokens in the OS keychain, never written to disk or config files | contradicted | deliberate | integrations §2.10; security item 35 |
| HD2:68 | HD:1922 | App permissions: Contents, Issues, PRs, Checks, Commit statuses, Security events R/W; Metadata R | carried | carried | integrations.md §2.10 |
| HD2:69 | HD:1923 | GHES via configurable `api_url`/`graphql_url` with a custom CA bundle | carried | carried | integrations.md §2.10 |
| HD2:70 | HD:1927 | Webhooks verified with HMAC-SHA256 (`X-Hub-Signature-256`) before processing | carried | carried | integrations.md §2.12, INT-10 |
| HD2:71 | HD:1931 | `issues.labeled` with `sekhemet` creates a card, converts sub-issues to subtasks and links the issue URL | carried | carried | integrations.md §2.12, INT-32 |
| HD2:72 | HD:1932 | `issue_comment.created` with `/plan`, `/split`, `/estimate`, `/review`: dispatch against the linked card and reply in t… | later | later | integrations §7 |
| HD2:73 | HD:1933 | `pull_request.labeled` with `sekhemet:review` creates an external review card, runs gates on a checkout and posts a rev… | carried | carried | integrations.md §2.12-13, INT-34; review-git.md §2.7 |
| HD2:74 | HD:1934 | `pull_request.opened` by Dependabot/Renovate creates a verification card that runs full gates and auto-merges if policy… | gap | gap | integrations §2.12, P9 |
| HD2:75 | HD:1935 | `workflow_dispatch` enqueues a local card run within declared hours | later | later | integrations §7 |
| HD2:76 | HD:1937 | Inbound issue text and comments treated as untrusted and wrapped in prompt tags | carried | carried | integrations.md §2.3; INT-32 |
| HD2:77 | HD:1941-1942 | Every gate execution becomes a Check Run: `queued` → `in_progress` → `completed` with `success`/`failure` | carried | carried | integrations.md §2.14 |
| HD2:78 | HD:1943-1954 | Typed failures become Check Run annotations (path, start/end line, level, message, title, raw_details) | carried | carried | integrations.md §2.14 (redacted first; `raw_details` not listed, minor) |
| HD2:79 | HD:1955 | Checks can be required status checks in branch protection | carried | carried | integrations.md §2.14 |
| HD2:80 | HD:1959 | SARIF v2.1.0 from gitleaks, Semgrep and osv-scanner; gzip + base64; `POST …/code-scanning/sarifs` | carried | carried | integrations.md §2.14 |
| HD2:81 | HD:1974 | On acceptance, a draft PR with the evidence summary (gates, diff stats, coverage, abandoned attempts) | gap | gap | integrations §2.15, P9 |
| HD2:82 | HD:1975 | PR marked ready when all checks succeed; reviewers from CODEOWNERS | gap | gap | integrations §2.15, P9 |
| HD2:83 | HD:1976 | Review comments create repair subtasks scoped to line ranges; the Worker repairs, pushes, replies, and resolves the thr… | later | later | integrations §7; review-git §7 |
| HD2:84 | HD:1977 | Merge per repo policy: `enablePullRequestAutoMerge`, the merge queue, or a person | gap | gap | integrations §2.15, P9 |
| HD2:85 | HD:1981 | Release card: aggregate accepted cards since the last tag, `git-cliff` changelog, semver bump, publish a GitHub Release… | later | later | integrations §7; planner-pm §2.15.8 |
| HD2:86 | HD:1985 | Research answers from local sources first, web second; web is opt-in, off in air-gap, and all fetched content is untrus… | carried | carried | design-stage.md §2.6, §2.7.2, §2.7.6 |
| HD2:87 | HD:1989-1995 | Two research modes, Research Desk and Deep Research (serves; trigger; latency ms–3 min vs minutes–overnight; model; out… | later | later | design-stage §7 (Desk); Deep research §2.7.3 |
| HD2:88 | HD:2003 | Research fetching uses the same egress proxy under the allowlist, logged and hashed; no second network path | carried | carried | design-stage.md §2.6.3, §2.7.1; security.md §2.32 |
| HD2:89 | HD:2004 | Claim execution is a gate: gate command, gate host sandbox, `GateResult` in the evidence bundle | carried | carried | design-stage.md §2.7.1, §2.7.4 |
| HD2:90 | HD:2005 | Model selection is the router; the Researcher is a registry role, loaded and evicted by the same swap policy | carried | carried | design-stage.md §2.7.1; models.md §2.21 |
| HD2:91 | HD:2006 | Research remembers only through the three stores (guidance, measurements, fetched bytes) | carried | carried | context.md §2.23; design-stage.md §2.7.1 |
| HD2:92 | HD:2008 | Needing a second sandbox, scheduler, cache or permission model is evidence the feature does not belong | carried | carried | design-stage.md §2.7.1 |
| HD2:93 | HD:2012 | Hardware envelope: 24 GB M4; ~16 GB for weights; roles do not co-reside; quality from passes, retrieval and verificatio… | carried | carried | design-stage.md §2.7.9; models.md §2.22 |
| HD2:94 | HD:2014 | The Researcher's gathering and synthesis modes are one registry entry used two ways, chosen by the bake-off, not by rep… | carried | carried | design-stage.md §2.7.9 |
| HD2:95 | HD:2016 | The Desk loads no model: a second slot of the Worker's server, same weights, no additional memory | later | later | design-stage §7 |
| HD2:96 | HD:2020-2023 | Knowledge tiers in lookup order: repo and installed deps at the exact version incl. source; docsets + `llms.txt`/… | carried | carried | design-stage.md §2.7.2 (`llms-full.txt` not named; minor) |
| HD2:97 | HD:2022 | Research cache: pages stored as extracted markdown with URL, fetch date and content hash, indexed lexically | carried-weaker | carried | design-stage §2.7.2, §3 |
| HD2:98 | HD:2027-2031 | Desk grades: Lookup (seconds, no model), Question (1–3 min, short tool loop), Deep (promoted to a research card; the as… | later | later | design-stage §7 |
| HD2:99 | HD:2035 | `ask` posts a non-blocking decision request answered by the Researcher, delivered at the next step boundary; `note` wit… | contradicted | gap | worker-loop rule 12, NEW-worker-loop-4; Researcher path later (design-stage §7) |
| HD2:100 | HD:2036 | Speculative research: the planner writes each card's open questions and the Desk answers them before the card starts | later | later | design-stage §7 |
| HD2:101 | HD:2038 | At project open, prefetch each package's `llms.txt`/doc sitemap into the corpus, pinned to the installed version | later | later | design-stage §7 |
| HD2:102 | HD:2042-2050 | Repository reading tools on `git`/`gh`: dependency source at the resolved version; tree/file at any ref; code search in… | carried | carried | design-stage.md §2.7.10 |
| HD2:103 | HD:2052 | Repository results cached by commit SHA, permanently | carried | carried | design-stage.md §2.7.10 |
| HD2:104 | HD:2054 | Context7 and DeepWiki as optional MCP sources: off by default, untrusted, weighted below primary sources, never the sol… | later | later | design-stage §7 |
| HD2:105 | HD:2074 | Deep research brief: restate the question, success criteria, out of scope; ambiguity resolved or raised to the user, no… | carried | carried | design-stage.md §2.7.3 ("raise to the user" is implicit only) |
| HD2:106 | HD:2076 | Plan: sub-questions with a budget each, posted as a decision request (approve / edit / narrow) with deadline and safe d… | later | later | design-stage §7 |
| HD2:107 | HD:2078 | Gather: a supervisor delegates sub-questions to sub-agents with isolated contexts; findings come back with citations, n… | carried | carried | design-stage.md §2.7.3 |
| HD2:108 | HD:2078 | Everything fetched lands in the corpus index that later stages read | later | later | design-stage §7 |
| HD2:109 | HD:2080 | Research stops on coverage of the sub-questions, not a turn count | carried | carried | design-stage.md §2.7.3 |
| HD2:110 | HD:2080 | A sub-question closes when it has independent sources of sufficient tier; open ones are re-dispatched with different qu… | missing | gap | design-stage §2.7.3, NEW-design-stage-4 |
| HD2:111 | HD:2080 | Crawling within a doc site uses an adaptive strategy that stops when the question is answered | later | later | design-stage §7 |
| HD2:112 | HD:2084 | Effort `quick`/`standard`/`exhaustive` sets the number of sub-questions, pages per sub-question and verification depth;… | carried-weaker | gap | design-stage §2.7.3, NEW-design-stage-4 |
| HD2:113 | HD:2084 | Revision needs no effort setting; it stops when no candidate lowers measured risk | carried | carried | design-stage.md §2.7.5 |
| HD2:114 | HD:2088 | Self-hosted SearXNG: no API keys, no query logging to third parties; a separate service to keep its copyleft licence ou… | carried-weaker | carried | design-stage §2.7.11; PROVENANCE |
| HD2:115 | HD:2088 | Queries are 1–6 terms | carried | carried | design-stage.md §2.7.11 |
| HD2:116 | HD:2088 | Every query and its result set is recorded in the event log | gap | gap | design-stage §2.6.3, S8 |
| HD2:117 | HD:2088 | Rank primary sources (official docs, source repos, standards bodies, papers) above aggregators | carried | carried | design-stage.md §2.7.11 |
| HD2:118 | HD:2088 | Recency is a first-class search parameter | carried | carried | design-stage.md §2.7.11 |
| HD2:119 | HD:2092 | Fetches go through the proxy with a per-project domain allowlist and denylist | carried-weaker | gap | design-stage §2.6.3, NEW-design-stage-4 |
| HD2:120 | HD:2092 | Crawl4AI warm headless-browser sidecar: JS rendering, question-keyed content filter, link scoring | later | later | design-stage §7 |
| HD2:121 | HD:2092 | Static-page fast path: HTML to markdown with trafilatura | later | later | design-stage §7 |
| HD2:122 | HD:2094 | PDFs: pypdfium2 by default, Docling for scanned or table-heavy pages; PyMuPDF4LLM never default or distributed, but a u… | later | later | design-stage §7 |
| HD2:123 | HD:2096 | Extracted content chunked by heading and deduplicated by content hash rather than URL | carried-weaker | carried | design-stage §2.7.8 |
| HD2:124 | HD:2100 | Lexical retrieval: BM25 over heading chunks, merged with the source-authority preference | carried | carried | design-stage.md §2.7.8 |
| HD2:125 | HD:2102 | Dense index rejected on this machine's terms; if a measurement shows it pays, it goes in its own cache DB and nothing e… | carried | carried | design-stage.md §2.7.8; DEC-22 |
| HD2:126 | HD:2104 | Code context stays deterministic; prose retrieval may become lexical+dense, code may not | carried | carried | context.md §2.28; DEC-22 |
| HD2:127 | HD:2108 | Persistent project corpus over dependency docs, refreshed when the manifest changes | later | later | design-stage §7 |
| HD2:128 | HD:2109 | Per-question corpus for each deep run, so synthesis can quote a source long after it left context | later | later | design-stage §7 |
| HD2:129 | HD:2111 | Research never enters the Worker raw: a research note (short, cited, fixed budget) outside the byte-stable prefix | carried | carried | design-stage.md §2.7.6 |
| HD2:130 | HD:2119 | Executable claims: install the package at the stated version, run the claim script as a gate with no network; a failing… | carried | carried | design-stage.md §2.7.4 (striking a failed claim is not mentioned; minor) |
| HD2:131 | HD:2120 | Citational claims verified against text actually read, by URL or by normalised title | carried-weaker | gap | design-stage §2.7.4, NEW-design-stage-2 |
| HD2:132 | HD:2121 | Contested claims: both positions with tiers and dates; name the better-supported one and why; never flatten | gap | gap | design-stage §2.7.4–5, NEW-design-stage-2 |
| HD2:133 | HD:2122 | Temporal claims carry the date of their newest supporting source | carried | carried | design-stage.md §2.7.4 |
| HD2:134 | HD:2124 | Every claim carries a confidence and the verification it survived | carried | carried | design-stage.md §2.7.4 |
| HD2:135 | HD:2126 | The claim gate is a functional-layer gate declared in `gates.toml` and hash-pinned; it fails the card when a claim is n… | carried-weaker | gap | design-stage §2.7.4; gates 27a, NEW-gates-5; NEW-design-stage-2 |
| HD2:136 | HD:2132 | Grounded risk vector: bad citations, open sub-questions, unreproduced executable claims, grounding confidence; a revisi… | gap | gap | design-stage §2.7.5, NEW-design-stage-2 |
| HD2:137 | HD:2134 | The critique loop's stopping condition: stop when no candidate revision lowers risk | gap | gap | design-stage §2.7.5, NEW-design-stage-2 |
| HD2:138 | HD:2136 | No separate citation-repair turn; the report reaches Review when every executable claim has a verdict and no revision c… | carried-weaker | gap | design-stage §2.7.5, NEW-design-stage-2 |
| HD2:139 | HD:2140 | Reproducible research run: corpus, queries, fetches with hashes, plan, model and prompt versions recorded; re-run again… | carried | carried | design-stage.md §2.7.7 |
| HD2:140 | HD:2146 | Fetched content wrapped as untrusted; instructions inert; stricter permissions for a step holding it | carried | carried | design-stage.md §2.7.6; security.md §2.42 |
| HD2:141 | HD:2147 | Robots directives respected; per-domain rate limits enforced | carried | carried | design-stage.md §2.6.3 |
| HD2:142 | HD:2148 | Package names found on the web never installed without passing the supply-chain gate | carried | carried | design-stage.md §2.7.6 |
| HD2:143 | HD:2149 | Claim execution inherits the gate host sandbox: no network, no repository write access; scripts are untrusted input | carried-weaker | gap | design-stage §2.7.4, NEW-design-stage-2 |
| HD2:144 | HD:2150 | Answers from external MCP research services are untrusted like fetched pages | later | later | design-stage §7 |
| HD2:145 | HD:2151 | No credentials ever sent; authenticated fetches unsupported in v1 | carried | carried | design-stage.md §2.7.6 |
| HD2:146 | HD:2155 | Researcher tools: `search`, `fetch`, `docs`, `scholar`, `paper`, `repo`, `deps`, plus project MCP tools | carried | carried | design-stage.md §2.7.10 |
| HD2:147 | HD:2157 | Worker research tools are read-only and never include `search`/`fetch`: `docs(symbol or package, version)`,… | carried-weaker | later | worker-loop §7; design-stage §9 (R4) |
| HD2:148 | HD:2157 | The Planner additionally sees `plan_research(card)` | contradicted | later | design-stage §7 (`plan_research`, owned there per R5); extensibility table links to it |
| HD2:149 | HD:2161 | Research playbooks as Agent Skills (library upgrade, CVE triage, comparing implementations, paper technique), supplying… | later | later | design-stage §7 |
| HD2:150 | HD:2165 | Deep Research evaluated on DeepResearch Bench RACE and FACT plus executable-claim pass rate and disagreement recall; ta… | later | later | design-stage §7 (targets kept) |
| HD2:151 | HD:2165 | Desk measured on latency per grade and on how often an answer reaching a Worker was later contradicted by the code | later | later | design-stage §7 |
| HD2:152 | HD:2169-2180 | Cache TTL by mutability: pinned SHA indefinite; pinned-version docs indefinite (evicted by size); unversioned docs 90 d… | later | later | design-stage §7 (values identical) |
| HD2:153 | HD:2182 | A stale cache entry is served immediately and revalidated in the background | later | later | design-stage §7 |
| HD2:154 | HD:2186 | Every extension mechanism is a plugin on the kernel | contradicted | deliberate | extensibility rule 29, §7, §8 Q2 (O4); DEC-09 correction |
| HD2:155 | HD:2190-2197 | Skill directory: `SKILL.md`, `scripts/`, `references/`, `evals/` | carried | carried | extensibility.md §2.10 |
| HD2:156 | HD:2198 | Only the manifest line in Zone 2; the body loads only when matched to the card class | carried | carried | extensibility.md §2.11, EXT-32 |
| HD2:157 | HD:2198 | Skills are project- or user-scoped and versioned, and declare any gates they add | carried-weaker | later | extensibility §7 (a skill that declares its gates; reason: skills never change gate files) |
| HD2:158 | HD:2202 | Hook events: card/start, pre-step, pre-tool, post-tool, pre-gate, post-gate, card/end, review/return, playbook/propose | carried | carried | extensibility.md §2.4 (adds `turn-stopping` and board events) |
| HD2:159 | HD:2202 | A hook can observe, block with a reason, or inject messages | carried | carried | extensibility.md §2.6 |
| HD2:160 | HD:2202 | Hooks run outside the sandbox with user permissions | carried | carried | extensibility.md §2 table, §9 rationale |
| HD2:161 | HD:2206 | Commands: Markdown templates expanding into a card template or planner instruction (`/onboard`, `/research`, `/split`,… | later | later | extensibility §7 (user-defined commands) |
| HD2:162 | HD:2210 | MCP client: tools offered to the planner and, where the registry permits, the Worker; tool descriptions strictly budget… | carried | carried | extensibility.md §2.23 |
| HD2:163 | HD:2211 | MCP server exposes boards, cards, gates, evidence bundles and the model registry | gap | gap | extensibility rule 18, NEW-extensibility-3 (evidence and registry read-only) |
| HD2:164 | HD:2215 | ACP lets VS Code, JetBrains and Neovim open a card, stream steps, inspect gates, approve or return | later | later | extensibility §7 (ACP card surface; v1 ACP is Seshat's chat) |
| HD2:165 | HD:2220 | `sekhemet run <card-id>` runs one card unattended | carried | carried | surface.md §2.13, §2.18 |
| HD2:166 | HD:2221 | `sekhemet plan "<spec>"` decomposes into cards without executing | carried | carried | planner-pm.md §3 CLI; design-stage.md §3 |
| HD2:167 | HD:2222 | `sekhemet gate <card-id>` runs gates only | carried | carried | gates.md §3, GT-T1-1 |
| HD2:168 | HD:2223 | `sekhemet bake-off [--models]` qualifies and benchmarks models on the repo | carried | carried | models.md §2.30 |
| HD2:169 | HD:2224 | `sekhemet replay <card-id> [--as <config>]` | carried-weaker | carried | runtime rule 14 (other configs are a fork from step 0) |
| HD2:170 | HD:2226 | A TypeScript SDK exposes these operations, with the event log as an async iterator | carried-weaker | deliberate | extensibility rule 28, §8 Q1 ("changed from the old design's shipped SDK"; publish or cut is owner decision O4) |
| HD2:171 | HD:2230 | Plugin API: register services, tools, gates, hooks, sync adapters or UI panels through a typed manifest; fully reversib… | later | later | extensibility §7 (plugin API) |
| HD2:172 | HD:2232 | Plugin signing and compatibility contracts deferred until the kernel API stabilises | later | later | extensibility §7; security §7 |
| HD2:173 | HD:2236 | No chat sessions; a card attempt is the unit of execution | carried | carried | runtime.md §2.1 |
| HD2:174 | HD:2240 | Resume after a crash: rebuild board state, discard the partial step, restore the worktree to the last checkpoint, re-en… | gap | gap | runtime rule 10, NEW-runtime-3 |
| HD2:175 | HD:2244 | Fork at a step: same pack and trajectory, then a different model, prompt version or budget; a new attempt with a parent… | carried | carried | runtime.md §2.13, RUN-27 |
| HD2:176 | HD:2248 | Replay against a pinned configuration diffs trajectory and evidence; deterministic stages reproduce exactly | carried | carried | runtime.md §2.14, RUN-28 |
| HD2:177 | HD:2252 | Checkpoints: the Worker commits after every gate-passing step and every masked-observation boundary | contradicted | deliberate | review-git rule 3, §9 (R1); runtime rule 11 links to it |
| HD2:178 | HD:2256 | Background processes: registered to the card, sandboxed, output captured with observation masking, killed at card end u… | carried | carried | runtime.md §2.15 (promotion: later §7) |
| HD2:179 | HD:2256 | Port allocation so parallel cards do not collide | carried | carried | runtime.md §2.15 (own loopback `PORT`) |
| HD2:180 | HD:2260 | Interactive terminals: a persistent shell with its transcript logged as observations, same permissions as `run` | carried | carried | runtime.md §2.16 |
| HD2:181 | HD:2264 | Push to self-hosted ntfy or Gotify when a card reaches Review, parks, exceeds a budget or needs a decision | carried | carried | integrations.md §2.20-21 |
| HD2:182 | HD:2264 | Approving or parking from a phone needs nothing cloud-hosted | carried | carried | integrations.md §2.23 |
| HD2:183 | HD:2264 | (new-doc consistency) Budget on unsolicited notifications | contradicted | gap | planner-pm §2.8.15, integrations §2.23a (now 3/5 in both, R8); P6, P9 |
| HD2:184 | HD:2268 | Outside declared hours the scheduler works the backlog in project batches | gap | gap | models rule 20, NEW-models-3 |
| HD2:185 | HD:2268 | Outside declared hours the scheduler keeps caches warm | missing | gap | runtime rule 17, NEW-runtime-5 (RUN-18a) |
| HD2:186 | HD:2268 | Nightly gate jobs: full mutation and a full vulnerability scan | gap | gap | runtime rule 20, NEW-runtime-5 |
| HD2:187 | HD:2268 | Overnight prompt optimiser when enabled | later | later | runtime §7 |
| HD2:188 | HD:2268 | A morning summary: what reached Review, what parked, and why | carried | carried | runtime.md §2.20 (Seshat's standup via the notifier) |
| HD2:189 | HD:2272 | Git is the file system of record: every card a branch, every checkpoint a commit, no board state git cannot reconstruct | carried | carried | review-git.md §2.6.1 |
| HD2:190 | HD:2278 | Scope declared and enforced: cards with intersecting `filesTouched` never run together; a scope violation is a stop rea… | carried | carried | review-git.md §2.6.4; kernel.md §2.4 |
| HD2:191 | HD:2278 | The second card rebases before Verify, not after Review, while the Worker still has budget | carried | carried | review-git.md §2.6.4 (every card rebases) |
| HD2:192 | HD:2278 | A rebase conflict produces `rebase_conflict` with the card returned to Planning | carried | carried | review-git.md §2.6.4 resolves the old document's own Planning-vs-In-Progress inconsistency: a conflict inside scope returns to the Worker with typed hunks, one outside s… |
| HD2:193 | HD:2280 | A conflict the Worker cannot resolve is a decision request against both cards, shown as a pair | carried | carried | review-git.md §2.6.4 |
| HD2:194 | HD:2280 | The harness never resolves a semantic conflict by preferring one side | carried | carried | review-git.md §2.6.4 |
| HD2:195 | HD:2282 | Concurrency capped by review capacity, not cores | carried | carried | review-git.md §2.2.4 |
| HD2:196 | HD:2286 | Branch `sekhemet/<project>/<card-id>-<slug>`, from the parent card's branch or the integration branch | carried | carried | review-git.md §2.6.2 |
| HD2:197 | HD:2286 | Subtask branches stack on the parent; the parent's integration gate runs on the merged stack; disjoint siblings on inde… | carried | carried | review-git.md §2.6.2 |
| HD2:198 | HD:2290-2301 | Checkpoint commit trailers: Card, Step, Agent-Model, Agent-Harness, Agent-Role, GateStatus, Co-authored-by | carried | carried | review-git.md §2.6.3 |
| HD2:199 | HD:2302 | On acceptance, checkpoints squashed into one or more intent-grouped Conventional Commits attributing every collabor… | carried-weaker | later | review-git §7 (squash policy incl. several intent commits); v1 one squash, body intent-grouped |
| HD2:200 | HD:2313 | Raw checkpoints preserved at `refs/sekhemet/checkpoints/<card-id>` | carried | carried | review-git.md §2.5.5 |
| HD2:201 | HD:2317 | Before Verify, rebase onto the current integration branch; a clean rebase proceeds | carried | carried | review-git.md §2.6.4 |
| HD2:202 | HD:2317 | Conflict hunks become typed failures; the Worker resolves inside scope only; conflicts outside scope park the card | carried | carried | review-git.md §2.6.4 and v1 acceptance |
| HD2:203 | HD:2317 | Merge order across sibling cards follows the DAG, then WSJF | carried | carried | review-git.md §2.6.4 |
| HD2:204 | HD:2321 | PR description: gates passed, tests added, screenshots, what was tried and abandoned | carried-weaker | gap | review-git §2.5.7, S5 (RG-S5-18 screenshots in the PR body) |
| HD2:205 | HD:2321 | Review comments on the PR flow back into the card thread | later | later | review-git §7; integrations §7 |
| HD2:206 | HD:2321 | Without an adapter, the same summary goes into the merge commit | carried | carried | review-git.md §2.5.7 |
| HD2:207 | HD:2325 | Stacked cards: accepting a lower card rebases the cards above and re-runs their gates | carried | carried | review-git.md §2.5.5 |
| HD2:208 | HD:2329 | Monorepos: scope and gates per package; a card touching two packages runs both gate sets; cross-repo work is two cards… | carried | carried | review-git.md §2.6.5 |
| HD2:209 | HD:2333 | The review view offers difftastic's syntax-aware diff alongside the line diff | carried | carried | review-git.md §2.6.6; dashboard.md §2.5.6 |
| HD2:210 | HD:2335 | Squash policy per project (keep checkpoint history on main) | later | later | review-git §7 |
| HD2:211 | HD:2344 | Onboarding step 1: build the tree-sitter repo map and cache it | carried-weaker | deliberate | surface rule 9; DEC-20 (map from the TypeScript compiler; tree-sitter later, surface §7) |
| HD2:212 | HD:2345 | Onboarding step 2: start headless language servers and record which succeed | gap | gap | surface rule 9 (servers confined, after trust), S3a, S9 |
| HD2:213 | HD:2346 | Onboarding step 3: detect build, test, lint and format commands from manifests and CI configs | gap | gap | surface rule 5, P10 (SUR-8) |
| HD2:214 | HD:2347 | Onboarding step 4: propose a `gates.toml` from the detected toolchains | gap | gap | surface rule 10, P10 (SUR-7) |
| HD2:215 | HD:2348 | Onboarding step 5: extract conventions (naming, layout, error patterns, test style) into a draft playbook with evidence… | carried | carried | surface.md §2.9 (broader list) |
| HD2:216 | HD:2349 | Onboarding step 6: generate or update `AGENTS.md` and `CLAUDE.md` | gap | gap | surface rules 9–10, P10 (SUR-9 idempotent AGENTS.md) |
| HD2:217 | HD:2350 | Onboarding step 7: run the qualification suite on this repo's code | carried | carried | surface.md §2.11 (offered, not run silently; deliberate) |
| HD2:218 | HD:2351 | The user reviews proposed gates and playbook before anything is enforced | carried | carried | surface.md §2.10 |
| HD2:219 | HD:2355-2362 | Gate templates by language: TS/JS (tsc, eslint, prettier / vitest, jest, playwright / Stryker); Python (pyright, ruff /… | missing | gap | gates rule 23a (per-language template table, R14), NEW-gates-5 (format and mutation tools) |
| HD2:220 | HD:2360-2361 | Go and Java/Kotlin templates as Phase 3, with Java's slower LSP startup noted | missing | later | gates rule 23a (Go template built; Java/Kotlin later, its language server starts slowly) |
| HD2:221 | HD:2364 | Full language support needs a grammar, a working headless language server and a gate template; missing any degrades to… | carried | carried | surface.md §2.30, SUR-33 ("a parser" instead of a tree-sitter grammar) |
| HD2:222 | HD:2366 | TypeScript-first map and parse gate; others get a flat map with no PageRank and an unchecked parse; the degradation is… | carried | carried | DEC-20; context.md §7 |
| HD2:223 | HD:2370 | Cards accept images, saved to the evidence bundle; the vision model returns a structured description and an atomic visu… | carried | carried | surface.md §2.28-29, SUR-32 (adds a 10 MB cap) |
| HD2:224 | HD:2370 | Without a co-loaded vision model, images are processed during a scheduled batch swap | carried | carried | surface.md §2.29 |
| HD2:225 | HD:2374 | Convention drift: re-evaluated nightly against recent commits, diffed against the playbook, reported as a planner note | gap | gap | surface rule 12, P10 (SUR-10) |
| HD2:226 | HD:2376 | Convention extraction combining `crag` linter/CI parsing with `codebase-md` AST pattern discovery | later | later | surface §7 (crag, codebase-md) |
| HD2:227 | HD:2376 | Generated AGENTS.md and playbook drafts need human sign-off at onboarding | carried | carried | surface.md §2.10 |
| HD2:228 | HD:2380 | An air-gapped machine can install, calibrate, work cards, add dependencies and look up docs | carried | carried | security.md §2.45 (calibrate not named; minor) |
| HD2:229 | HD:2384 | Package mirrors (verdaccio, devpi, a crates mirror) pre-seeded from the lockfile allowlist plus a curated set | later | later | security §7 (mirror services incl. the curated set) |
| HD2:230 | HD:2384 | The supply-chain gate resolves against the mirror, so an unmirrored package cannot be installed | carried | carried | security.md §2.46 |
| HD2:231 | HD:2388 | Model weights are never downloaded by the harness | contradicted | gap | security rule 47, models rule 4 (now agree: never on its own; explicit hash-verified download, R7), NEW-models-7 |
| HD2:232 | HD:2388 | Signed manifest lists approved models with checksums, quantisations, template checksums and… | carried-weaker | gap | security rule 47 (template checksum and tier in the manifest), NEW-security-2 (not checked today) |
| HD2:233 | HD:2388 | Weights copied in by the user, verified against the manifest, then registered | carried | carried | security.md §2.47 |
| HD2:234 | HD:2388 | The qualification suite still runs locally, because qualification does not transfer between machines | carried | carried | models.md §2.27 (qualification is per machine) |
| HD2:235 | HD:2392 | Offline docsets and `llms.txt` snapshots at the locked versions packaged with the kit | carried-weaker | gap | security rule 48, NEW-security-5 (SEC-44 llms.txt at pinned versions) |
| HD2:236 | HD:2392 | Documentation bundles refreshed when lockfiles change | missing | gap | security rule 48, NEW-security-5 (SEC-45 stale on lockfile change) |
| HD2:237 | HD:2392 | The research cache can be exported from a connected machine and imported to the air-gapped one | missing | carried | security rule 48, §4 built (research-cache export and import) |
| HD2:238 | HD:2396 | Updates by signed bundle, applied manually, each with an event-log schema compatibility note | carried | carried | security.md §2.49 (`ssh-keygen -Y`, namespace `sekhemet-update`) |
| HD2:239 | HD:2396 | An update never migrates the log in place without a backup | carried | carried | security.md §2.49; SEC-42 |
| HD2:240 | HD:2396 | Plugin and skill updates travel the same signed-bundle route | missing | gap | security rule 49, NEW-security-5 (SEC-46 signed skill updates) |
| HD2:241 | HD:2400 | Air-gap self-test: no outbound attempt during a full card run (at the proxy), all gates runnable, all models loadable,… | gap | gap | security rule 50, NEW-security-2 (SEC-33) |
| HD2:242 | HD:2402 | Open: mirror seeding for transitive dependencies not in any lockfile | later | later | security §7 (transitive-dependency seeding kept as the open policy question) |
| HD2:243 | HD:2406 | Open Agent Skills format; pull from the ecosystem and publish back to it | carried-weaker | later | extensibility §7 (publishing skills back) |
| HD2:244 | HD:2406 | Skills are procedure, not capability: enter context only when matched, never widen the tool set | carried | carried | extensibility.md §2.12, §2.17 |
| HD2:245 | HD:2410-2416 | Skill sources: Anthropic official (Skill Creator, document skills, frontend design); Superpowers; Codex catalogue (scop… | later | later | extensibility §7 (the skill catalogue; Codex admin and system scopes) |
| HD2:246 | HD:2420-2440 | Per-skill pull/adapt/build decisions (19 rows, e.g. brainstorming → intake questions as decision requests; TDD enforced… | later | later | extensibility §7 (per-skill mapping table kept in full) |
| HD2:247 | HD:2446 | `SKILL.md` YAML front matter (name, description, triggers, tools) plus a Markdown body | carried | carried | extensibility.md §2.10 (adds `budget_tokens`) |
| HD2:248 | HD:2447 | A skill's `scripts/` run inside the sandbox | gap | gap | extensibility §2 table (`scripts/` in the sandbox), S9 (EXT-5) |
| HD2:249 | HD:2452 | Trigger classes let the planner attach a skill deterministically | gap | gap | extensibility rule 12, NEW-extensibility-4 |
| HD2:250 | HD:2452 | A skill declares its required tools; if the card lacks them, the skill is omitted | carried | carried | extensibility.md §2.12 |
| HD2:251 | HD:2452 | Every skill ships with at least one eval card | later | later | extensibility §7 (an eval card for every skill) |
| HD2:252 | HD:2456 | Pulled skills pinned by commit hash, audited on import, diffed on update | carried | carried | extensibility.md §2.15, §2.17 |
| HD2:253 | HD:2456 | A skill touching gate files, the loop driver or sandbox configuration is rejected at import | carried | carried | extensibility.md §2.15, EXT-27 |
| HD2:254 | HD:2466 | Worker `read`: 1-based line ranges | carried | carried | worker-loop.md §2.12 |
| HD2:255 | HD:2466 | `read` enforces a byte budget | carried-weaker | carried | worker-loop rule 12, WL-12 |
| HD2:256 | HD:2466 | `read` passes images and PDFs through to the vision path | missing | later | worker-loop §7 |
| HD2:257 | HD:2467 | `grep` wraps ripgrep: three output modes, gitignore-aware, capped | carried-weaker | carried | worker-loop rule 12 |
| HD2:258 | HD:2468 | `glob`: an mtime-sorted file listing over a gitignore matcher | carried-weaker | carried | worker-loop rule 12 |
| HD2:259 | HD:2469 | `edit`: exact replace with a uniqueness rule | carried | carried | worker-loop.md §2.12 |
| HD2:260 | HD:2469 | `edit` is CRLF-aware | carried | carried | worker-loop.md §2.12 ("line endings normalised") |
| HD2:261 | HD:2469 | AST parse gate before any write | carried | carried | worker-loop.md §2.14, WL-3 |
| HD2:262 | HD:2470 | Symbol tools (`replace_symbol_body`, `insert_after_symbol`, `read_symbol`, `find_references`) over an LSP server pool (… | carried-weaker | carried | worker-loop rule 12; other languages §7 |
| HD2:263 | HD:2471 | Structural rewrite fallback with ast-grep for languages without a language server | later | later | worker-loop §7 |
| HD2:264 | HD:2472 | `run`: sandbox, timeout, command allowlist, description field, RTK output condensing | carried-weaker | carried | worker-loop rule 12; security permission table; context 17 |
| HD2:265 | HD:2473 | `docs` tool: tiered lookup served from the project corpus | carried-weaker | carried | worker-loop rule 12; corpus later (design-stage §7) |
| HD2:266 | HD:2477 | `note`: thread and inbox communication | carried | carried | worker-loop.md §2.12 |
| HD2:267 | HD:2478 | Script execution (code-mode): a sandboxed runner exposing the tools as JS/TS functions | carried | carried | worker-loop.md §2.12 (`run_script`, only for script-capable models), WL-M2-4 |
| HD2:268 | HD:2484 | Planner repo-map query: tree-sitter, PageRank, binary-search budget fit (Aider reference) | carried | carried | context.md §2.13 (TypeScript compiler; tree-sitter later); extensibility.md tool table |
| HD2:269 | HD:2485 | Dependency and impact analysis over LSP references, for scope and DAG inference | carried | carried | extensibility.md tool table; context.md §2.22 (one hop along the reference graph) |
| HD2:270 | HD:2486 | Task decomposition built from Taskmaster's patterns, not its code (Commons Clause) | carried | carried | extensibility.md tool table; PROVENANCE |
| HD2:271 | HD:2487 | Difficulty scoring from scope, symbols, tests and history | carried | carried | extensibility.md tool table; planner-pm.md §2.5 |
| HD2:272 | HD:2488 | Search and fetch (SearXNG, trafilatura, Crawl4AI) for research cards only, never the Worker | carried | carried | extensibility.md tool table; design-stage.md §6 |
| HD2:273 | HD:2490 | Board operations: create, split, link, budget | carried | carried | extensibility.md tool table |
| HD2:274 | HD:2496 | Parse gate wraps tree-sitter | contradicted | deliberate | gates §9; DEC-20 |
| HD2:275 | HD:2497-2498 | Format, lint and typecheck wrap per-language toolchains; tests wrap per-language runners with a parser to `GateFailure` | gap | gap | gates rules 23, 23a, M6 (GT-M6-2) |
| HD2:276 | HD:2499 | Mutation wraps Stryker, mutmut, cargo-mutants and PIT, with diff scoping built where lacking | contradicted | gap | gates rule 23a (each language's tool when installed, R14), NEW-gates-5 (GT-N5-2) |
| HD2:277 | HD:2500-2503 | Secret scan (gitleaks), dependency existence/typosquat over registry and mirror, osv-scanner offline, Semgrep CE with c… | carried | carried | gates.md §2.3, §3; security.md §2.44 |
| HD2:278 | HD:2504-2507 | Console/network/DOM and layout-bounds checks over Playwright; screenshot diff with Playwright + pixelmatch; accessibili… | contradicted | deliberate | gates §9, §8 Q1 (the in-house client stays the gate; Playwright and axe-core approved for development only, DEC-29 O5; axe-core in the product gate is owner decision O27, default no — was pending the owner, R16; behaviours kept rule 29) |
| HD2:279 | HD:2508 | Vision checklist over a local vision model at temperature 0 | gap | gap | gates rule 30, NEW-gates-4 (GT-N4-2) |
| HD2:280 | HD:2509 | Hygiene: changelog verification and a debug-output scanner | carried | carried | gates.md §2.3, §2.17 |
| HD2:281 | HD:2515 | Inference wraps the llama.cpp server; MLX as an Apple Silicon adapter | carried | carried | models.md §2.14 (MLX later: context.md §7, extensibility.md tool table) |
| HD2:282 | HD:2516 | Model swapping wraps llama-swap or builds a minimal equivalent | carried | carried | extensibility.md tool table (a minimal router) |
| HD2:283 | HD:2517 | Constrained decoding (XGrammar or llguidance) behind the tool-arm interface | carried | carried | extensibility.md tool table; models.md §2.28 (a per-model measured choice; PROVENANCE marks it not used yet) |
| HD2:284 | HD:2518-2519 | Sandbox built over platform facilities; worktrees over git and COW cloning | carried | carried | extensibility.md tool table (Seatbelt, bubblewrap, git; COW per DEC-21) |
| HD2:285 | HD:2520-2522 | Notifications wrap ntfy/Gotify; structural diff wraps difftastic; event log and hash chain over SQLite WAL | carried | carried | extensibility.md tool table |
| HD2:286 | HD:2523 | Output condensing: RTK for `run`; native condensers for read, grep, glob | carried | carried | extensibility.md tool table; context.md §2.17 (native reimplementation of RTK's four strategies) |
| HD2:287 | HD:2524 | Goal monitoring built on event-log queries with threshold evaluation | carried | carried | planner-pm.md §2.12 |
| HD2:288 | HD:2528 | Every component's licence verified against its primary repository licence file at the pinned version | carried | carried | PROVENANCE.md (Licences footnote) |
| HD2:289 | HD:2528, 2586 | Copyleft (AGPL/GPL) components run as separate processes reached over a socket, never linked into the harness, and repl… | missing | carried | PROVENANCE rule 1 (copyleft out of process) |
| HD2:290 | HD:2587 | Components marked "reference" are read for their approach and reimplemented in TypeScript; no code copied | carried | carried | PROVENANCE.md (Techniques preamble; "Reimplemented in TypeScript") |
| HD2:291 | HD:2588 | Every component has an owner section in the design that says what happens if it is removed | missing | carried | PROVENANCE (every component row says what happens if it is removed; R21) |
| HD2:292 | HD:2532 | Register row: llama.cpp (MIT; subprocess over HTTP), the v1 inference engine | missing | carried | PROVENANCE (llama.cpp row) |
| HD2:293 | HD:2568 | Register row: ntfy (Apache-2.0 and GPL-2.0; separate service) and Gotify (MIT) | missing | carried | PROVENANCE (ntfy, Gotify rows) |
| HD2:294 | HD:2535 | Register row: SearXNG (AGPL-3.0; separate service, never embedded) | missing | carried | PROVENANCE (SearXNG row) |
| HD2:295 | HD:2537 | Register row: Crawl4AI (Apache-2.0, attribution required; separate service) | missing | carried | PROVENANCE (Crawl4AI row, attribution kept) |
| HD2:296 | HD:2536-2582 | Remaining register rows: llama-swap, MLX/mlx-lm, trafilatura, pypdfium2, Docling, PyMuPDF4LLM (AGPL, not distributed),… | missing | carried | PROVENANCE (a row for every named component, R21) |
| HD2:297 | HD:2580 | hyperfine as the benchmark gate runner for performance criteria | missing | later | gates §7 (hyperfine benchmark gate, proposal) |
| HD2:298 | HD:2581 | typos as a source-code spelling gate in the hygiene layer | missing | later | gates §7 (typos spelling gate, proposal) |
| HD2:299 | HD:2578-2579 | mise (pinned toolchain environments) and lefthook (git hooks manager) | missing | deliberate | PROVENANCE (mise, lefthook: not used, the repository's own `.githooks/` instead) |
| HD2:300 | HD:2542-2543, 2572 | DevDocs and Kiwix as offline documentation services; Dozzle as a container log viewer | missing | deliberate | PROVENANCE (DevDocs, Kiwix, Dozzle: not used — the kit's own docs bundle, no containers in v1) |
| HD2:301 | HD:2592 | All observability local; no outbound telemetry path at all | carried | carried | runtime.md §2.31, RUN-33 (OTLP export only when the person asks, once; deliberate refinement) |
| HD2:302 | HD:2596 | Audit: monotonic seq and SHA-256 over content plus the previous hash; tampering found by walking the chain from genesis… | carried | carried | runtime.md §2.29; kernel.md §2.8-9, K-1 |
| HD2:303 | HD:2600 | OpenTelemetry agent conventions: agent span per card, model span per request with token counts, tool span per call | carried | carried | runtime.md §2.30 |
| HD2:304 | HD:2600 | Traces stored locally in SQLite and viewable in the UI | carried | carried | runtime.md §2.30 (`.sekhemet/traces.db`) |
| HD2:305 | HD:2604-2611 | Metrics that matter: pass rate by class/model; prefix-cache hit per step; tokens and seconds estimate vs actual; gate-f… | carried | carried | runtime.md §2.32 |
| HD2:306 | HD:2615 | Budgets per card and per project in tokens, seconds and kWh | carried | carried | runtime.md §2.19 |
| HD2:307 | HD:2615 | kWh computed from hardware TDP and GPU utilisation | contradicted | deliberate | runtime rule 18, §7, §9 |
| HD2:308 | HD:2615 | Circuit breakers park a card at its cap; a project cap stops the scheduler | carried | carried | runtime.md §2.19 |
| HD2:309 | HD:2615 | Cost reported in machine time and energy, not API dollars | carried | carried | runtime.md §2.19 |
| HD2:310 | HD:2619 | Every card records model, quant, template checksum, prompt-set version, playbook version, tool-schema version and engin… | carried-weaker | gap | models MD-M4-5 (seven-field reproducibility record), M4; runtime §8 Q2 points to it |
| HD2:311 | HD:2623 | The UI is a local web app on loopback, so it works over SSH and on a headless box | carried-weaker | carried | runtime rule 23 |
| HD2:312 | HD:2623 | A native wrapper is optional and deferred | later | later | dashboard §7 |
| HD2:313 | HD:2625 | Three views are the product (Review, Board, Card); the rest appear when they have something to say | contradicted | deliberate | dashboard §9 (five primary views always, for three audiences) |
| HD2:314 | HD:2631 | Review view: gate strip, intent-grouped structural diffs, test summaries, screenshot diffs | carried | carried | dashboard.md §2.5 (intent grouping later) |
| HD2:315 | HD:2633 | Card view: five tabs, Evidence (default), Plan, Steps, Thread, Files | carried | carried | dashboard.md §2.6 |
| HD2:316 | HD:2634 | Inbox appears when a decision request is open | carried | carried | dashboard.md §2.2.1 (merged into Review › Needs you; `#/inbox` opens it) |
| HD2:317 | HD:2635 | Machine appears when a run is active, or from the status line | contradicted | deliberate | dashboard §9 (always in the System menu) |
| HD2:318 | HD:2636-2639 | Runs after the first completed run; Playbook at the first proposed rule; Graph when a card has `dependsOn`; Registry af… | carried | carried | dashboard.md §2.2.1 |
| HD2:319 | HD:2640 | Insights appears only after enough cards for a trend (the competence model's threshold) | contradicted | deliberate | dashboard §9 (teaching empty state) |
| HD2:320 | HD:2641 | Integrations appears when one is configured, or from settings | contradicted | deliberate | dashboard §9 (always listed) |
| HD2:321 | HD:2642 | Workspace appears on the second project | carried | carried | dashboard.md §2.2.1 |
| HD2:322 | HD:2644 | A nav item for an empty view is hidden, not empty | carried | carried | dashboard.md §2.2.1, P11 |
| HD2:323 | HD:2650 | Navigation and triage keys: j/k, h/l, Enter, Space peek, a/r/p, ?, Esc | carried | carried | dashboard.md §2.3 |
| HD2:324 | HD:2651 | Command palette Cmd+K; a palette entry is the default home for a new action | carried | carried | dashboard.md §2.3.1 |
| HD2:325 | HD:2652 | `g` chords: one per visible view, first letter of the view's name | gap | gap | dashboard §2.3.1, P11 |
| HD2:326 | HD:2654 | No destructive or surprising action has a bare single-key binding (e.g. theme) | gap | gap | dashboard §2.3.2, P11 |
| HD2:327 | HD:2654 | The cheat sheet is the specification | carried | carried | dashboard.md §2.3.3 |
| HD2:328 | HD:2659 | Gate strip: one box per configured gate in execution order; hover shows typed errors; click goes to logs | carried | carried | dashboard.md §2.5.4 (`gates.toml` order; grouping beyond six gates) |
| HD2:329 | HD:2660 | Diffs grouped by conceptual intent ("Core Interface Definition", "Handler Implementation", "Acceptance Tests") with dif… | later | later | dashboard §7 |
| HD2:330 | HD:2660 | Non-semantic whitespace hidden by default | carried | carried | dashboard.md §2.5.6 |
| HD2:331 | HD:2661 | Inline visual artifacts: screenshot comparisons with animated slider diffs and pixelmatch heatmaps | carried | carried | dashboard.md §2.5.7 (slider plus pixel-difference overlay) |
| HD2:332 | HD:2662 | Single-keystroke A (accept and squash), R (return with reason), P (park) | carried | carried | dashboard.md §2.5.9 |
| HD2:333 | HD:2662 | Every return reason automatically feeds candidate playbook rules | contradicted | deliberate | review-git §2.4, §9 (only an actionable note becomes a candidate; arXiv 2502.02757) |
| HD2:334 | HD:2668 | A human edit in the worktree is a commit by a human actor (`card/human_edit`), never folded into the model's attempt | later | later | review-git §7 (human edits) |
| HD2:335 | HD:2669 | Gates re-run on a human-edited tree | later | later | review-git §7 |
| HD2:336 | HD:2670 | The evidence bundle keeps the Worker's diff and the human's separately | later | later | review-git §7 |
| HD2:337 | HD:2671 | The competence row records `passed_with_human_edit`, never an unattended pass | later | later | review-git §7 |
| HD2:338 | HD:2672 | Partial accept takes a subset of hunks; the rest becomes a new card with the reviewer's reason | later | later | review-git §7 (partial accept) |
| HD2:339 | HD:2676 | Headless dual-axis virtualisation via `@tanstack/virtual` | contradicted | deliberate | dashboard §9 (own windowing, no build step) |
| HD2:340 | HD:2677 | Horizontal virtualiser: off-screen columns cost no DOM | carried | carried | dashboard.md §2.4.9 ("windowed columns and cards") |
| HD2:341 | HD:2678 | Vertical virtualiser via `translateY()` with an overscan buffer of 3 cards | carried-weaker | carried | dashboard §2.4.9 |
| HD2:342 | HD:2679 | Performance target: 60 FPS scrolling and < 50 MB DOM memory on boards of 500+ cards | carried-weaker | carried | dashboard §2.4.9, §6 |
| HD2:343 | HD:2683 | Card steps stream over a local WebSocket `ws://127.0.0.1:4040/stream` | contradicted | deliberate | runtime rule 25, §9 |
| HD2:344 | HD:2683 | Reloading the page re-streams the log from genesis or a checkpoint, reproducing byte-identical state | missing | carried | dashboard §2.4.8, P3; runtime 25a |
| HD2:345 | HD:2687 | Decision requests appear in the card thread and in a single inbox, with options and a recommendation | carried | carried | dashboard.md §2.5.14, §2.6 Thread |
| HD2:346 | HD:2687 | Nothing blocks silently: any card waiting on a human shows on the master board with its wait time | carried | carried | dashboard.md §2.5.2 (Needs you, longest wait first), §2.11 Workspace rollup with wait times |
| HD2:347 | HD:2689 | Mobile: read-only board inspection plus one-tap Accept/Return/Park | carried | carried | dashboard.md §2.2.2, §2.15.3 (extends it) |
| HD2:348 | HD:2693-2701 | Design principles: state is colour; density; evidence first; keyboard-complete; both themes first-class, dark default,… | carried | carried | dashboard.md §2.1 |
| HD2:349 | HD:2705 | Surface ladder: depth by luminance steps, not drop shadows; both themes native | carried | carried | dashboard.md §2.13.1 |
| HD2:350 | HD:2707-2723 | Colour token table: 15 roles with hex values per theme and APCA/WCAG figures | carried-weaker | deliberate | dashboard §2.13.1, §9 (values only in `tokens.ts`, held by the contrast test) |
| HD2:351 | HD:2725 | Contrast exceeds WCAG 2.1 AA: 4.5:1 for interactive text, 7:1 for body copy | carried-weaker | carried | dashboard §2.14.1, P12 |
| HD2:352 | HD:2725 | State always carried by icons and badges as well as colour | carried | carried | dashboard.md §2.1.2, §2.14.1 |
| HD2:353 | HD:2729-2745 | Typography: Inter / JetBrains Mono with system fallbacks; 11/12.5/13/15/18/22 px; leading 1.25/1.45/1.55 | carried | carried | dashboard.md §2.13.4 (exact fallback stacks left to `tokens.ts`) |
| HD2:354 | HD:2747 | Tabular numerals on every metric and timestamp | carried | carried | dashboard.md §2.13.4 |
| HD2:355 | HD:2751-2754 | Spacing 2–32 px; radius 4/6/0; elevation by surface shift and 1 px hairlines, no shadows; motion 120 ms ease-out, strea… | carried | carried | dashboard.md §2.13.5 |
| HD2:356 | HD:2758 | Board column: name, WIP counter (`3/4`), progress indicator, virtualised viewport, h/j/k/l | carried | carried | dashboard.md §2.4.3 |
| HD2:357 | HD:2759 | Card tile: title, class chip, difficulty, budget bar (tokens/seconds), one box per gate, dependency count badge | contradicted | deliberate | dashboard §9 (professional tile) |
| HD2:358 | HD:2760-2762 | Card view tabs; gate strip hover/click; diff viewer split/unified, structural, inline gate annotations | carried | carried | dashboard.md §2.5.4-6, §2.6 |
| HD2:359 | HD:2763 | Decision request: radio options with consequences and effort deltas, highlighted recommendation, expiry countdown | carried | carried | dashboard.md §2.5.14 |
| HD2:360 | HD:2764 | Inbox: blocked decision requests sorted by wait time, longest first | carried | carried | dashboard.md §2.5.2 |
| HD2:361 | HD:2765 | Machine panel: VRAM utilisation, active tier, loaded models, throughput sparklines, cache hit rate | carried-weaker | gap | dashboard §2.11 (sparklines built); tier NEW-dashboard-2 |
| HD2:362 | HD:2766 | Command palette (Cmd+K / Ctrl+K): fuzzy navigation across cards, projects, commands and settings | carried | carried | dashboard.md §2.15.4 |
| HD2:363 | HD:2770 | A single-weight 1.5 px line icon set; no illustrations, mascots or lioness; the brand lives in the name, palette and gl… | carried | carried | dashboard.md §2.13.6 |
| HD2:364 | HD:2774 | Tokens published as CSS custom properties and JSON, consumed by the UI and plugin panels; the source of truth; componen… | carried | carried | dashboard.md §2.13.1, §2.15.2 (`/vocab.json` for plugin panels) |
| HD2:365 | HD:2782 | Settings resolve: defaults → user → project → card overrides → CLI flags | carried | carried | surface.md §2.21 |
| HD2:366 | HD:2782 | No environment-variable layer: only `SEKHEMET_CONFIG_DIR` and `SEKHEMET_MODELS_DIR` are honoured | contradicted | deliberate | surface rule 27 (about 45 variables classified; only the two bootstrap ones shown to users) |
| HD2:367 | HD:2784 | Every key is read by something; a parsed-but-unread key is deleted from the schema | gap | gap | surface rule 4, T10 (SUR-21) |
| HD2:368 | HD:2788-2791 | `[models]` worker/planner/reviewer/researcher = "auto"; reviewer "off" disables review and the card says so | carried | carried | surface.md §2.23 (adds `vision`) |
| HD2:369 | HD:2794 | `[loop] default_step_budget = 40` | carried | carried | surface.md §2.23 |
| HD2:370 | HD:2797 | `[review] review_minutes_per_day = 60` derives the Review WIP limit | carried | carried | surface.md §2.23; review-git.md §2.2 |
| HD2:371 | HD:2800 | `[network] mode = "offline" / "allowlist" / "open"` | carried | carried | surface.md §2.23 |
| HD2:372 | HD:2801 | `fetch_allow = ["nodejs.org"]` default | contradicted | deliberate | surface rule 23 (fetch_allow starts empty, with the reason) |
| HD2:373 | HD:2804 | `[overnight] hours = "18:00-08:00"`: when unattended runs may use the machine | contradicted | deliberate | surface rule 23 ([machine] reserved_hours replaces [overnight] hours, with the reason) |
| HD2:374 | HD:2805 | `power_budget_kwh_day = 0` means unlimited | carried | carried | surface.md §2.23 (under `[machine]`) |
| HD2:375 | HD:2808 | `fetch_allow` (Researcher page reads) and `network_allow` (sandbox commands) are distinct, and each file's comment name… | carried | carried | surface.md §2.24 |
| HD2:376 | HD:2810 | Keys removed because nothing read them: `machine.tier`, `[context]`, `loop.stall_window`, `loop.max_rungs`,… | carried | carried | surface.md §2.25 (identical list) |
| HD2:377 | HD:2815 | Actor set of seven: human, planner, worker, reviewer, researcher, gate, system | contradicted | deliberate | kernel rule 19, §9 |
| HD2:378 | HD:2817-2829 | Event fields: seq (1-based monotonic), ts, actor, type, cardId, attemptId, stepId, payload, payloadHash (canonical JSON… | carried | carried | kernel.md §2.6-8 (shapes by reference to `types.ts`) |
| HD2:379 | HD:2828 | The chain hash covers (seq, ts, actor, type, cardId, payloadHash, prevHash) | gap | gap | kernel rule 9, NEW-kernel-1 |
| HD2:380 | HD:2825 | Large payload blobs stored under `.sekhemet/artifacts/` | carried | carried | kernel.md §2.15 (content-addressed blobs referenced by hash) |
| HD2:381 | HD:2832-2866 | Example payloads: CardStart (budget steps/tokens/seconds), StepStart (contextPackHash, activeZoneBudget), ToolCall (arg… | carried | carried | kernel.md §3 (retired in favour of the types in `types.ts`) |
| HD2:382 | HD:2869 | Events are immutable; corrections are appended as new events | carried | carried | kernel.md §2.7 (plus an UPDATE/DELETE refusal, NEW-kernel-1) |
| HD2:383 | HD:2878-2881 | PRAGMAs: journal_mode WAL, synchronous NORMAL, foreign_keys ON, busy_timeout 5000 | carried | carried | kernel.md §2.27 |
| HD2:384 | HD:2884-2901 | `events` table with an actor CHECK, a unique hash and indexes on card, attempt, type, seq | carried | carried | kernel.md §2.6 (SQL by reference to `schema.ts`) |
| HD2:385 | HD:2903 | Projections derived deterministically from the log and rebuildable from scratch | carried | carried | kernel.md §2.13, K-2 |
| HD2:386 | HD:2904-2913 | `projects` table (tier default 'auto', review_minutes_per_day default 60, unique root_path) | carried | carried | kernel.md §2.6 (by reference) |
| HD2:387 | HD:2915-2933 | `cards` table: 9-state CHECK; difficulty 1–10; step_budget 40; token_budget 32000; assigned_tier; blocked_reason; order… | carried | carried | kernel.md §2.6, §2.17 (by reference to `schema.ts`; K-S7-1 refuses difficulty 11). The defaults are not restated in any spec |
| HD2:388 | HD:2925 | `cards.priority REAL` holds the WSJF score | contradicted | deliberate | planner-pm §2.7, §9 |
| HD2:389 | HD:2938-2942 | `card_dependencies` table; the dependency DAG | carried | carried | kernel.md §2.3 |
| HD2:390 | HD:2944-2957 | `attempts`: rung 1–4, tool_arm A/B/C, status (running, done_pending_gates, passed, failed, halted), stop_reason, tokens… | carried | carried | kernel.md §2.6; worker-loop.md §2.34 (4 rungs); models.md §2.28 (arms) |
| HD2:391 | HD:2961-2974 | `steps`: tool, arguments, argument_hash, repo_state_hash, success, result_summary, tokens_condensed, duration | carried | carried | kernel.md §2.6; worker-loop.md §2.17 |
| HD2:392 | HD:2978-2987 | `gate_results` with a layer CHECK and status pass/fail | carried | carried | kernel.md §2.6; gates.md §2.9 adds `unavailable` |
| HD2:393 | HD:2991-3003 | `evidence_bundles`: diff, structural diff, gate summary, passed/failed checks, abandoned hypotheses, trajectory ref | gap | gap | gates rule 35, T1 (GT-T1-8); structural diff later §7 |
| HD2:394 | HD:3005-3022 | `decision_requests`: options {label, consequence, effortDelta, riskNote}, recommendation, answerer human/researcher, bl… | carried-weaker | gap | planner-pm §2.10.2, P2; non-blocking `ask` NEW-worker-loop-4 |
| HD2:395 | HD:3024-3038 | `competence_entries`: repo, class, files touched, difficulty, model, arm, step budget, stop reason, passed, tokens, sec… | gap | gap | models rule 32, NEW-models-6 |
| HD2:396 | HD:3043 | `.sekhemet/gates.toml` derived on first run from the project's scripts; edited only when a derived gate is wrong | carried | carried | gates.md §2.36; surface.md §2.5.3 |
| HD2:397 | HD:3047 | `[project] languages = [...]` key | missing | deliberate | gates §3 (`languages` dropped: detected from manifests, recorded in evidence) |
| HD2:398 | HD:3048 | Default `protected` includes `tests/acceptance/**` and `.sekhemet/gates.toml` | carried | carried | gates.md §3 (`DEFAULT_PROJECT_CONFIG`, a superset) |
| HD2:399 | HD:3050-3081 | Worked `gates.toml` example: tsc typecheck; vitest unit; stryker mutation with `blocking = false`, `timeout_s = 1800`;… | carried-weaker | carried | gates rule 36 (copyable example incl. 1,800 s mutation timeout, gitleaks args) |
| HD2:400 | HD:3086 | The key is `id`, not `name`; `blocking` (default true), not `required` | carried | carried | gates.md §3 |
| HD2:401 | HD:3087 | `command` and `args` are separate | carried | carried | gates.md §3 |
| HD2:402 | HD:3088 | `rung`, `layer` and `timeout_s` inferred from `id` and `parser` unless stated | gap | gap | gates §3 inference, T1 (GT-T1-6) |
| HD2:403 | HD:3090 | The file's SHA-256 verified on every card start; an unauthorised change aborts | carried | carried | gates.md §2.2, GT-1 (also re-checked before every verification) |
| HD2:404 | HD:3094 | REST and WebSocket served on loopback `http://127.0.0.1:4040` | carried | carried | runtime.md §2.23 |
| HD2:405 | HD:3096-3115 | REST route table (workspace, board, cards CRUD, split, run, gate, accept, return, park, rewind, evidence, events?since,… | carried | carried | runtime.md §3 ("superseded by the routes above; the code is the contract"). Every function has an `/api` route |
| HD2:406 | HD:3102-3103 | Request bodies: `split { strategy }`, `run { budgetOverride }` | carried-weaker | later | runtime §7 (budget override); split body §3 |
| HD2:407 | HD:3119 | M0 spike: ≥ 90% valid-and-correct tool execution across 30 seeded tasks (3 runs each, budgets 50 and 150) under the win… | later | deliberate | measurement rule 28 (M0 bar historical; protocol in `sekhemet m0`) |
| HD2:408 | HD:3120 | M1 kernel: hash-chained log in SQLite WAL; byte-identical projection rebuild; reversible plugin mount/unmount | carried | carried | kernel.md K-1, K-2 (plugins cut: DEC-09) |
| HD2:409 | HD:3121 | M2 context: deterministic assembly; byte-identical prompts; prefix-cache hit > 85% on tool-result steps | gap | gap | context rules 1, 7; M8 |
| HD2:410 | HD:3122 | M3 Worker: Ready → Verify unattended; stall/oscillation detector aborts within 3 steps; stop reason logged | carried | carried | worker-loop.md §2.18, WL-2, §2.30; MVP_PATH step 6 |
| HD2:411 | HD:3123 | M4 gates: static, functional and security gates sandboxed on the gate host; typed `GateFailure`; tampering with test fi… | carried | carried | gates.md §2.2, §2.7, §2.11, §2.19 |
| HD2:412 | HD:3124 | M5 board: master and project boards; Review presents evidence; one real card accepted end to end on the founder's repo | carried | carried | MVP_PATH steps 6–7; dashboard.md |
| HD2:413 | HD:3125 | M6 PM: nested boards with rollup; SPIDR fitted to tier; Review WIP back-pressures Verify; retry ladder; playbook v1 | carried | carried | kernel.md §2.24; planner-pm.md §2.2; review-git.md §2.2; worker-loop.md §2.34; context.md §2.24 |
| HD2:414 | HD:3126 | M7 depth: visual, mutation and dependency gates; bake-off matrix; GitHub App PR with check runs and annotations | carried | carried | gates.md; models.md §2.30; integrations.md §2.14-15 |
| HD2:415 | HD:3127 | M8 self-improvement: each inlet beats its frozen baseline on held-out evals before enablement; a variant archive keeps… | carried | carried | measurement.md §2.17-19 (variant archive in §3 contract) |
| HD2:416 | HD:3135 | TypeScript on Node throughout; inference over HTTP, never in-process; language servers, formatters and scanners as sand… | carried | carried | SPINE "How the parts fit"; models.md §2.14; security.md §2.4 |
| HD2:417 | HD:3137 | Rust or Python components only later, where profiling proves a bottleneck (repo map first, pruner second) | missing | carried | DEC-20 (harness stays TypeScript; repo map first, pruner second) |
| HD2:418 | HD:3141-3158 | Repository layout: packages kernel, board, context, models, loop, planner, gates, sandbox, sync, ui, eval; apps/harness… | carried-weaker | carried | SPINE packages; CLAUDE.md layout; multi-language fixtures later, measurement §7 |
| HD2:419 | HD:3164-3345 | Package interface contracts (IEventLog, IProjectionEngine, IServiceContainer, IBoardEngine, IDependencyDAG, IRepoMapBui… | contradicted | deliberate | specs/README "Where the old design went" (interfaces replaced by the code's types in each Contract) |
| HD2:420 | HD:3243 | `IInferenceAdapter.measureThroughput` (prefill/decode tok/s) and `healthCheck` | carried | carried | models.md §2.7, §2.9, §2.15 |
| HD2:421 | HD:3276-3277 | `IGoalMonitor`: burn-up, replan trigger with scope-delta %, failure Pareto hotspots | carried | carried | planner-pm.md §2.12 (scope drift > 20%; ≥ 3 failures in one file) |
| HD2:422 | HD:3340-3344 | CLI: `daemon` (HTTP/WS on 4040), `board` (opens browser), `calibrate` (writes ~/.sekhemet/config.toml), `run`, `gate` | carried | carried | runtime.md §2.5, §3; models.md §2.7 (calibrate writes the machine profile, not config.toml) |
| HD2:423 | HD:3351 | `MockInferenceAdapter`: scripted token streams and pattern-matched tool calls, for offline tests of the loop, stall det… | carried-weaker | carried | DEFINITION_OF_DONE §2D.2 (scripted adapter) |
| HD2:424 | HD:3352 | Synthetic git fixtures across TS, Python and Rust; `createTestWorktree()` clones one in under 10 ms | missing | deliberate | DEFINITION_OF_DONE §2D.3 (the < 10 ms target assumed in-memory SQLite; real repositories required); multi-language fixtures later, measurement §7 |
| HD2:425 | HD:3353 | All unit and integration tests on in-memory SQLite (`:memory:`), setup under 5 ms per file | contradicted | deliberate | DEFINITION_OF_DONE §2A (real on-disk SQLite) |
| HD2:426 | HD:3354 | The whole monorepo unit suite runs in under 3 seconds | missing | deliberate | DEFINITION_OF_DONE §2D.4 (the 3 s target kept as history; speed never bought with mocks) |
| HD2:427 | HD:3358-3368 | Build pipeline: pnpm workspaces; composite `tsc -b`; Biome; scripts build, test, test:unit, test:integration, typecheck… | carried-weaker | carried | DEFINITION_OF_DONE §2D.1 (test:unit, test:integration, pnpm dev); CLAUDE.md commands |
| HD2:428 | HD:3372-3380 | Phase 0 spike: 30 tasks × 3 runs × 3 arms at budgets 50/150; go ≥ 90%, rework 70–90%, pivot < 70% (narrow to planning a… | later | deliberate | measurement rule 28 (the pivot rule is owner decision O20, default: a standing decision) — was: §8 Q4 (pivot rule proposed as a standing decision, owner) |
| HD2:429 | HD:3384 | The frozen suite is written before the features it judges; a phase is complete only when its result is recorded against… | carried | carried | measurement.md §2.1-4 (the ordering rationale is history) |
| HD2:430 | HD:3388-3390 | Phase 1 MVP: a card goes Ready → Review unattended with an evidence bundle on the founder's repository | carried | carried | MVP_PATH.md (done) |
| HD2:431 | HD:3394 | Phase 2 PM-layer list (nested boards, decomposition, DAG, WIP, ladder, masking, RTK, playbook, hooks/skills/commands, r… | carried | carried | Each item carried in the owning spec (see its rows) |
| HD2:432 | HD:3398 | Work sized in cards under 200 lines across 1–3 files | carried | carried | planner-pm.md §2.1.4; gates.md §2.12 |
| HD2:433 | HD:3398-3400 | Some mechanisms are packages, not cards (Deep Research, the GitHub App adapter, the LSP pool, the seccomp-BPF assembler… | missing | carried | planner-pm §2.1.10, P1 |
| HD2:434 | HD:3404 | Depth before reach: the core (loop, gates, context, review, measurement) is held to the full bar; SDK, editor protocol,… | carried-weaker | carried | MODERNIZATION_PLAN "Depth before reach" |
| HD2:435 | HD:3408 | Phase 3 list (visual gates, multimodal, mutation/security gates, bake-off, prompt optimisation, sync + PRs, overnight,… | carried | carried | Each item carried or Later in its owning spec (Go/Java templates missing: see the language-template rows) |
| HD2:436 | HD:3412 | Phase 4 deferred: teams and multi-user | contradicted | deliberate | DEC-06 |
| HD2:437 | HD:3412 | Phase 4 deferred: RBAC and SSO, extra tracker adapters, multi-machine pooling, local verifier | later | later | SPINE "Not in v1"; DEC-06; integrations §7; models §7 |
| HD2:438 | HD:3412 | Phase 4 deferred: the compliance pack | missing | later | runtime §7 (compliance pack) |
| HD2:439 | HD:3416 | Scoping rule: anything not feeding the gates → failure data → decomposition/routing → reproducibility loop is a candida… | carried-weaker | deliberate | SPINE §Where the edge is; DEC-01 |
| HD2:440 | HD:3416 | Adopted techniques capped at two per phase | missing | gap | measurement rule 26, NEW-measurement-3 |
| HD2:441 | HD:3424-3440 | Benchmarks 1–15 on the founder's hardware, each with what it blocks | carried | carried | OPEN_QUESTIONS.md (all 15 plus #16, with states) |
| HD2:442 | HD:3444 | Task synthesis from git history: mine closed PRs; fail-to-pass (C₋₁ fails, C₀ passes); scrub paths from problem stateme… | carried-weaker | gap | measurement rule 17 (ephemeral worktree per task), T8 (MS-T8-12) |
| HD2:443 | HD:3445 | Clarify vs assume: an ambiguity-entropy threshold θ_ambig; an override rate > 15% in a category converts it to a decisi… | carried | carried | planner-pm.md §2.10.4, OPEN_QUESTIONS.md (15%; θ_ambig and ClarEval moved to later, planner-pm.md §7) |
| HD2:444 | HD:3446 | Prompt-injection defence by architectural containment | carried | carried | OPEN_QUESTIONS.md; security.md §2.42b |
| HD2:445 | HD:3447 | Layout defects: `boundingBox()` overlaps, zero-size containers, negative coordinates, scroll overflow; element screensh… | carried | carried | gates.md §2.29 (off-screen position covers negative coordinates) |
| HD2:446 | HD:3448 | Long-horizon reliability: SPIDR cards (1–3 files, < 200 LOC), fresh packs per card, Pass@k with gate verification | carried | carried | OPEN_QUESTIONS.md; planner-pm.md; worker-loop.md §2.37 |
| HD2:447 | HD:3452 | Open: retention of packs and trajectories, 30 days vs indefinite | carried | carried | runtime.md §2.33 (30 days after close; evidence and ledger kept) |
| HD2:448 | HD:3453 | Open: gate runner as a separate mTLS daemon or in-process | carried | carried | OPEN_QUESTIONS.md; runtime.md §7 (gate host on 127.0.0.1:7443) |
| HD2:449 | HD:3455 | Open: whether a local verifier earns its place on XL | later | later | models §7 (local verifier, with an anchor set) |
| HD2:450 | HD:3456 | Open: keyboard bindings and mobile viewport limits | carried | carried | dashboard.md §2.3, §2.15.3 (answered) |
| HD2:451 | HD:3457 | Open: plugin isolation and third-party signing | later | later | extensibility §7; security §7 |
| HD2:452 | HD:3461 | Founder decisions: name, licence, business model, network boundary (GitHub sync opt-in), defence go-to-market | carried | carried | DECISIONS.md founder section; SPINE "Locked for v1" Network row |
| HD2:453 | HD:3469-3487 | Rejected techniques (19 rows: Scrum roles, parallel writers, self-certification, self-refine, debate, unbounded best-of… | carried | carried | DEC-22 (all 19; "politeness" dropped from the persona row, minor) |
| HD2:454 | HD:3491 | Non-goals: not a chat assistant, IDE, CI system or tracker replacement; not aiming at frontier parity; slower per card | carried | carried | DEC-23 |
| HD2:455 | HD:3499 | PROVENANCE maps every adopted technique to a public source; never leaked code or verbatim prompts | carried | carried | PROVENANCE.md Techniques |
| HD2:456 | HD:3503-3513 | Technique rows (11) with dates verified | carried | carried | PROVENANCE.md (identical plus 2 rows) |
| HD2:457 | HD:3517-3533 | Licence register rows (15) with their "Use" | carried | carried | PROVENANCE.md Licences (several "Use" values changed to "Not used"; see the mutation and visual-tool rows) |
| HD2:458 | HD:3535 | Every licence verified against the root LICENSE file at the pinned release | carried | carried | PROVENANCE.md |
| HD2:459 | HD:3539 | RESEARCH_REGISTER.md tracks each technique spotted → triaged → shortlisted → benched → adopted/rejected, with evidence… | carried | carried | measurement.md §2.26, MS-2 |
| HD2:460 | HD:3539 | MODEL_MATRIX.md holds bake-off results by hardware tier, with full settings | missing | carried | models §3, §4 |

### 5.2 `INTEGRATION_REVIEW.md`

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| HD2:461 | IR:55 | Worker request budget: 16,384 − 4,096 − 256 = 12,032 tokens | carried | carried | worker-loop.md §2.22 (more precise: the thinking cap is also subtracted, giving 9,984) |
| HD2:462 | IR:57-61 | A1: no single allocator; `buildPrompt` reduces only 4 of 14 sources (repo map, scope files, history, tests); rules, ski… | carried-weaker | gap | context rule 10a, NEW-context-3 |
| HD2:463 | IR:63-66 | A2: tools described twice per turn (text interface in Zone 1 and native JSON schemas, rendered again by the template),… | missing | carried | context rule 10b, CX-7 |
| HD2:464 | IR:68-72 | A3: the same fact reaches the prompt from up to four places (seeded rule, explore rule, `remedyFor`, struggle candidate… | missing | gap | context rule 24c, NEW-context-4 |
| HD2:465 | IR:74-81 | A4: `activeFor` ignores `errorPattern`; empty `pathPattern`, `scope: {}` and `"src/"` match every card; `triggerGate` O… | carried-weaker | gap | context rule 24b, NEW-context-4 |
| HD2:466 | IR:83-86 | A5: `executeCard` → `playbook.addRule` → `save()` writes every active learned rule into `.sekhemet/playbook.toml` (comm… | missing | carried | context rule 24a, CX-9 |
| HD2:467 | IR:88-93 | A6: contradictory re-read directives (fresh-context rung vs pinned "do not read_file" vs `completedWork` "do not re-rea… | carried | carried | context.md CX-M1-1; worker-loop.md WL-M1-2/3 |
| HD2:468 | IR:94 | A6: the repair plan says "Follow it exactly", but `planRepair` never sees active rules, explored constraints or API hin… | missing | gap | worker-loop rule 34.3, NEW-worker-loop-5 |
| HD2:469 | IR:96-98 | A7: the rung directive is unshifted into Zone 2 rules and `triggerGate` rules change mid-card, so the system prompt cha… | carried-weaker | gap | context rule 8 (static blocks before scope files; rung directive in the tail), NEW-context-3 (CX-N3-4, -5) |
| HD2:470 | IR:100-102 | A8: `WorkingMemory.seed` keeps the first 6 lines, so Seshat's appended answer is dropped; `lines()` cuts at 10 with see… | missing | gap | context rule 26, NEW-context-3 |
| HD2:471 | IR:104-106 | A9: `run_cmd` output goes through a head/tail clamp that can cut error lines; the condenser that protects them is used… | carried | carried | context.md §2.17, CX-3 (condensing lossless for repair data; state "built") |
| HD2:472 | IR:108-110 | A10: prompts for Seshat, the Reviewer and the Researcher have no budget; `planRepair` inlines tests and scope files up… | missing | gap | context rule 10c, NEW-context-3 |
| HD2:473 | IR:114-117 | B1: on the benchmark nothing learned reaches the Worker (fresh `events.db`; approval needed; only playbook.toml and… | contradicted | deliberate | measurement rule 6, §9; ruling R12 (isolation in measurement runs; production probation in context rule 24f) |
| HD2:474 | IR:119-121 | B2: `reflectWithManager` runs before the retries, so every input has `retryPassed: false` and the prompt falsely says t… | carried-weaker | carried | planner-pm §2.8.13 (built) |
| HD2:475 | IR:123-126 | B3: helpful/harmful counters credit every rule in the prompt, so they track the overall pass rate;… | carried-weaker | gap | measurement rule 16b (rotation, paired credit), T8; context rule 24e, NEW-context-4 |
| HD2:476 | IR:128-131 | B4: three outcome stores disagree; evidence hard-codes `attempt: 1` and no model filter, inflating the capability model… | carried-weaker | gap | worker-loop rule 39, NEW-worker-loop-5 |
| HD2:477 | IR:134 | B5: the Worker's `note("Assumed: …")` lives only in memory; "so the reviewer sees it" is false | missing | carried | worker-loop rule 5a (built) |
| HD2:478 | IR:135 | B5: Reviewer findings reach only the dashboard, not Seshat's snapshot, a retry or learning | missing | gap | review-git §2.3.5, P8 (RG-P8-9 findings to the dossier and Seshat's snapshot) |
| HD2:479 | IR:136 | B5: a send-back note is not seen by the returned card's next attempt | carried | carried | review-git.md §2.4 ("it is what the Worker is told next (dossier)") |
| HD2:480 | IR:137 | B5: `manager` rules: the role exists in the type, but nothing produces or reads them | missing | gap | context rule 24d, NEW-context-4 |
| HD2:481 | IR:138 | B5: user-profile decay is specified in PM_CONTRACT §6 and not implemented | carried | carried | planner-pm.md §2.13.3 (decay kept as behaviour; not flagged in its state table) |
| HD2:482 | IR:139 | B5: `lessonsByCard` lives in memory and is lost when the queue restarts | missing | carried | kernel rule 20 (`card/lesson` on the ledger, built) |
| HD2:483 | IR:142-144 | B6: the Researcher gets only the error text and a hard-coded "TypeScript project"; it runs after the repair plans; its… | missing | gap | design-stage NEW-design-stage-5 |
| HD2:484 | IR:148-151 | C1: `askResearcher` swaps researcher ↔ manager per question: 10 evictions where 4 are needed, at 40–120 s each (4–12 mi… | missing | gap | models rule 20a (per-role queues, swaps ordered by the residency plan), NEW-models-9 |
| HD2:485 | IR:153-156 | C2: `askTeam` during an escalated retry: `isResident("manager")` is true for the escalation model (shared id), so the r… | missing | gap | models rule 20a (never two large models; questions during an escalated retry wait), NEW-models-9 |
| HD2:486 | IR:158-160 | C3: manager (num_ctx 8192), escalation (12288) and PM (8192) are separate adapters on the same weights; Ollama reloads… | missing | gap | models NEW-models-9 (MD-N9-1) |
| HD2:487 | IR:162-164 | C4: the dashboard's `kick` loads Seshat and the Researcher (as an Ollama model) with no router and no footprint check;… | carried-weaker | gap | runtime rule 4, NEW-runtime-6; models NEW-models-9 |
| HD2:488 | IR:166-168 | C5: deferred cards run after the only manager batch, so a failing deferred card never gets a plan or retry;… | missing | gap | NEW-planner-pm-8 (dependency inference) and NEW-worker-loop-5 (deferred cards' repair chances); deferred cards' repair chances are gap NEW-worker-loop-5 (rule 40), but no spec bounds dependency inference (`inferDependencies`, `planner/src/impact.ts`, still makes ca… |
| HD2:489 | IR:170-173 | C6: the tuner's 12-step cap (keeps 17 of 18 passes, cuts time 38%) is never applied; the queue uses the 40-step budget;… | carried-weaker | later | planner-pm §7 |
| HD2:490 | IR:173 | C6: each verification starts 5 extra `biome` processes (autofix plus one per style rule); fix: one… | missing | gap | gates rule 34b, NEW-gates-3 (GT-N3-5) |
| HD2:491 | IR:178 | D1: the Worker's questions are appended to the human's chat as `actor: "human"` | carried | carried | integrations.md §2.25, INT-25; kernel.md §2.16 |
| HD2:492 | IR:179 | D1: Seshat answers all queued questions in one reply and `collectAnswers` attaches that whole reply (first 400 chars) t… | missing | carried | kernel rule 20, K-10 (each answer threaded under the question it names, built) |
| HD2:493 | IR:181-189 | D2: no single place holds what the team knows about a card (plan on the ledger, lessons and answers in memory, research… | carried-weaker | carried | kernel rule 20 (dossier, built) |
| HD2:494 | IR:194 | E1: card kind parsed from the title with `/\(SPIDR:…/` in 4 places; Seshat's cards become "Other" | carried | carried | planner-pm.md P1 (kind from labels everywhere) |
| HD2:495 | IR:195 | E1: the error-code regex is duplicated (index.ts, reflect.ts) | missing | gap | context rule 24c (one `errorCode()` helper), NEW-context-4 |
| HD2:496 | IR:196 | E1: `<think>` stripped 8 times although the adapter already strips reasoning; `/\{[\s\S]*\}/` JSON extraction in 4 plac… | missing | gap | models MD-N4-8, NEW-models-4 |
| HD2:497 | IR:197 | E1: two similarity measures (`store.similarity` and `askObservation`'s ad-hoc overlap) | missing | gap | context rule 24c (one similarity function), NEW-context-4 |
| HD2:498 | IR:198 | E1: `session.ts` has four verification paths, each updating state differently | gap | gap | worker-loop rule 9, T3 |
| HD2:499 | IR:199 | E1: `moduleApiSummary` wrapped three times (API hints, curriculum, the Researcher's `module_api`) | carried | carried | gates.md GT-T2-3 (one AST index answers exports for every consumer) |
| HD2:500 | IR:200 | E1: two playbook stores and two sinks for send-backs | carried-weaker | gap | kernel K-S7-6, S7; one store built (context 24a) |
| HD2:501 | IR:203 | E2: configuration spread over nine places (17 flags, 9 env vars, repos/.json, global_playbook.json, gates.toml, playbo… | carried | carried | surface.md §2.21-27 (one resolution order, one user directory, an environment inventory) |
| HD2:502 | IR:204 | E2: `config.ts` is read only by `server.ts` | gap | gap | surface SUR-11, SUR-21 (P10, T10) |
| HD2:503 | IR:205 | E2: model profiles written inline in index.ts, pm_api.ts and pm/service.ts with magic names | gap | gap | models NEW-models-4 (one profile record, one construction path) |
| HD2:504 | IR:208 | E3: dead code: `pressure.ts`, `DefaultContextEngine`, `FileEvidenceStore`, `RulePerformance`/`auditContextDebt`, the RT… | carried-weaker | carried | context CX-M1-8, §4, rule 24e (`FileEvidenceStore` is reachable from `execute.ts`) |
| HD2:505 | IR:209 | E3: the benchmark command runs with `--explore`, `--review`, `--reviewer`, `--researcher`, `--escalate-retries` and… | carried-weaker | gap | measurement rule 9 (product roles and policies on), M9 (MS-M9-4) |
| HD2:506 | IR:219 | Suggestion 1: reorder the manager batch by residency; remove the per-question `router.use("manager")`; `askTeam` return… | missing | gap | models rule 20a, NEW-models-9 |
| HD2:507 | IR:220 | Suggestion 2: loop pass → manager batch → retry until nothing changes (cap 2 batches), so deferred cards get plans; ref… | missing | gap | worker-loop rule 40, NEW-worker-loop-5; reflection after retries built (planner-pm §2.8.13) |
| HD2:508 | IR:221 | Suggestion 3: `errorPattern` only while that code stands; `triggerGate` as AND; `addRule` in memory only; key facts and… | carried-weaker | gap | context rules 24a (built), 24b–c, NEW-context-4 |
| HD2:509 | IR:222 | Suggestion 4: describe tools once; rung directive out of Zone 2 into the volatile tail; static per-card blocks before t… | carried-weaker | gap | context rule 10b (built), rule 8, NEW-context-3 |
| HD2:510 | IR:223 | Suggestion 5: apply the tuned stopping policy by default from a global report; one biome call | missing | gap | gates rule 34b, NEW-gates-3 (one biome call); tuned policy by default later, planner-pm §7 |
| HD2:511 | IR:224 | Suggestion 6: a card dossier on the ledger: typed events `card/lesson`, `card/note`, `card/question` (actor worker),… | missing | carried | kernel rule 20 (built); worker-loop 5a |
| HD2:512 | IR:225 | Suggestion 7: one context allocator replaces `buildPrompt`'s levels and `pressure.ts`, for every role | carried-weaker | gap | context rule 10a, NEW-context-3 |
| HD2:513 | IR:226 | Suggestion 8: in-run probation for executable-verified learning (a config constraint, a remedy keyed to an error code,… | contradicted | deliberate | context rule 24f, measurement rule 6, §9; ruling R12 (probation in production only); NEW-context-4 (CX-N4-7) |
| HD2:514 | IR:227 | Suggestion 9: one attempt record `card/attempt_finished` (attempt number, role, model, rules in the prompt, turns, toke… | missing | gap | worker-loop rule 39, NEW-worker-loop-5 (attempt/finished read by every consumer) |
| HD2:515 | IR:228 | Suggestion 10: a scheduler that owns residency and work queues: adapters keyed by weights with the largest `num_ctx`; p… | missing | gap | models NEW-models-9; runtime NEW-runtime-6 |
| HD2:516 | IR:229 | Suggestion 11: shared helpers: a `kind` field on CardRecord, `errorCode()`, `extractJson()`, one `verify()`, one simila… | carried-weaker | gap | stored kind NEW-kernel-9 (models rule 31); errorCode and similarity NEW-context-4; extractJson NEW-models-4 (MD-N4-8); one verify T3 |
| HD2:517 | IR:230 | Suggestion 12: one resolved `RunProfile` (config, then flags); `--profile benchmark` turns on explore, escalation, the… | contradicted | gap | surface rule 14, NEW-surface-5 (one recorded RunProfile; --settings allowed, --profile refused per R13); measurement M9; roster from the registry (models rule 26) |
| HD2:518 | IR:231 | Suggestion 13: delete or merge dead code (`pressure.ts` into the allocator, `RulePerformance` into the attempt record,… | carried-weaker | gap | context CX-M1-8 (DefaultContextEngine cut, M1), rule 24e (RulePerformance derived); JSONL sink S5/S7; pressure.ts kept dormant |
| HD2:519 | IR:232 | Suggestion 14: an adversarial Reviewer: check the diff against the spec and criteria, list untested behaviour, read the… | carried-weaker | gap | review-git §2.3.3–5, P8 (RG-P8-8 assumptions, RG-P8-9 dossier); the likely_send_back retry later §7 with its reason |
| HD2:520 | IR:234-239 | Batch sequence on 24 GB: Worker pass → Researcher (every unexplained struggle, with card and code) → Seshat (plans usin… | contradicted | deliberate | review-git §2.3.2, §9 (Reviewer once per queue pass, after retries, before Review); swap order models rule 20a |
| HD2:521 | IR:245-252 | Target: one card dossier, with the ledger as the only channel; every role writes typed events (Worker lessons/notes/que… | missing | carried | kernel rule 20 (one dossier, `getDossier`, built) |
| HD2:522 | IR:253 | Target: the PM chat becomes a view showing the human conversation plus Worker questions labelled as the Worker's | carried-weaker | carried | dashboard §2.7.3; kernel rule 19 |
| HD2:523 | IR:255 | Target: one context allocator for every role: typed sections with priority, token cap and fact key; deduplicate keys; f… | carried-weaker | gap | context rules 10a–c, 24c; NEW-context-3, -4 |
| HD2:524 | IR:256-265 | Target Worker priority order: laws/tools once; contract and acceptance tests; the standing failure with excerpt and one… | carried-weaker | gap | context rule 10a, NEW-context-3; rule count §8.3 |
| HD2:525 | IR:267 | Target: the goal is always restated at the tail | carried | carried | context.md §2.8 ("the tail restates the goal in one line") |
| HD2:526 | IR:270-274 | Target learning signals from four sources (gate transitions, attempt records, human actions incl. edits, model synthese… | carried-weaker | gap | measurement rule 17 (source and verification tags), T8 (MS-T8-9) |
| HD2:527 | IR:275 | Target: one Curator turns signals into keyed facts, deduplicates against seeded rules and `remedyFor` by key, and scope… | missing | gap | context rule 24c (one curator), NEW-context-4 |
| HD2:528 | IR:276 | Target lifecycle: candidate → probation (in-run; executable-verified facts only) → active (human-approved; project or g… | contradicted | gap | context rule 24f, NEW-context-4 (R12) |
| HD2:529 | IR:277 | Target: rule outcomes come from the attempt record, with rotation giving a with/without comparison | missing | gap | measurement rule 16b, T8; context rule 24e, NEW-context-4 |
| HD2:530 | IR:278 | Target consumers: the Worker's allocator, Seshat's snapshot (manager rules and profile), the Reviewer; the tuner and ca… | carried-weaker | gap | context rule 24d, NEW-context-4 (PM rules in Seshat's snapshot); worker-loop rule 39, NEW-worker-loop-5 (one attempt record) |
| HD2:531 | IR:281 | Target scheduler: adapters keyed by weights, not role; roles on the same weights share one adapter with the largest con… | missing | gap | models rule 20a (adapters keyed by weights), NEW-models-9 |
| HD2:532 | IR:282 | Target scheduler: work enters per-role queues (plans, questions, reviews, research, chat) | missing | gap | models rule 20a (per-role queues), NEW-models-9 |
| HD2:533 | IR:283 | Target scheduler: drain a queue whenever its model is resident; order swaps by waiting queues and the residency plan; o… | missing | gap | models rule 20a (queues drain when resident; 128 GB node needs no code change), NEW-models-9 |
| HD2:534 | IR:284 | Target: one scheduler for all callers; the dashboard asks it through the runner lease instead of loading models itself | carried-weaker | gap | runtime rule 4, NEW-runtime-6 |
| HD2:535 | IR:285 | Target: one `RunProfile` from config (flags override) says which roles exist and which policies are on, so the benchmar… | contradicted | gap | surface NEW-surface-5; measurement rule 9a, M9 (MS-M9-4) |

### 5.3 `PM_DESIGN.md`

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| PMFE:1 | PM:5 | Every PM surface degrades to an honest empty or "not on this server" state while its endpoint 404s | carried | carried | dash §2.12.3 ("X isn't on this server yet", endpoint in a details line) |
| PMFE:2 | PM:6 | Mockups pm/board-v2/insights are static snapshots; `t` switches theme in them | carried | carried | dash §9 (mockups listed); bare `t` removed from the product (dash §2.3.2) — mockup-only |
| PMFE:3 | PM:20 | Priority 0..4 on Linear's scale (0 none, 1 Urgent … 4 Low) | carried | carried | ppm §2.7.1; PMC §2 |
| PMFE:4 | PM:20 | Priority glyph language: bars High/Med/Low, boxed exclamation Urgent, three dashes for none | contradicted | deliberate | dashboard §9 |
| PMFE:5 | PM:20 | Sort 1,2,3,4 then 0 | carried | carried | ppm §2.7.1 |
| PMFE:6 | PM:21 | Fibonacci points 1,2,3,5,8 shown as `3 pts` | carried | carried | ppm §2.6.2; NEW-planner-pm-1 |
| PMFE:7 | PM:21 | Nothing larger than 8; an 8 is a card the Planner should split, and the PM says so | carried | carried | ppm §2.6.2, NEW-planner-pm-1 |
| PMFE:8 | PM:21 | Points summed per column, cycle and epic | carried-weaker | carried | dashboard §2.4.3, P3 |
| PMFE:9 | PM:22 | `epicId` → card with `tier: "epic"` | carried | carried | PMC §2 |
| PMFE:10 | PM:22 | Epic progress from `/api/board` `epics[]` | carried | carried | PMC §3 |
| PMFE:11 | PM:22 | Epics appear as swimlanes, filter and table column, never as a separate hierarchy screen | contradicted | deliberate | dashboard §9 (story map is a view of the cards) |
| PMFE:12 | PM:23 | Cycle header: goal, dates, days left, one progress bar split done/in progress/not started by points | carried | carried | dash §2.4.13 |
| PMFE:13 | PM:23 | Planning a cycle is a conversation ending in proposals | carried | carried | ppm §2.7.7 |
| PMFE:14 | PM:24 | Group by Epic, Assignee, Priority, Cycle; lane header count, points, epic progress | carried | carried | dash §2.4.14 |
| PMFE:15 | PM:25 | Filter bar = clickable chips + typed query in GitHub Projects syntax; views save query and grouping | carried | carried | dash §2.4.11–12 |
| PMFE:16 | PM:26 | List view `#/board/list`, toggled with `v`, same filter/grouping | carried | carried | dash §2.4.15, §2.3 |
| PMFE:17 | PM:27 | Field keys ⇧P ⇧E ⇧L ⇧C ⇧A and `.` on focused card or selection; uppercase so they never collide with a/r/p | carried | carried | dash §2.3 keymap |
| PMFE:18 | PM:28 | `x` selects; ⇧J/⇧K and shift-click extend; bulk bar docks at the bottom | carried | carried | dash §2.3, §2.4.16 |
| PMFE:19 | PM:28 | Each bulk change is its own PATCH; one ledger event per card | carried | carried | ppm §2.14 ("one event per card") |
| PMFE:20 | PM:34 | WIP limits as `n / limit` headers and capacity bars | carried | carried | dash §2.4.3 |
| PMFE:21 | PM:34 | Review limit derived from review minutes per day | carried | carried | rg §2.2.1 |
| PMFE:22 | PM:35 | Classes of service: Urgent = Expedite, `dueDate` = Fixed date; no new field | carried | carried | ppm §2.7.6 |
| PMFE:23 | PM:35 | Saved view Urgent and high shows the expedite lane; Seshat flags Expedite when it is not rare | carried | carried | dash §2.4.11; ppm §2.7.6 (threshold: more than a WIP limit's worth of Urgent cards) |
| PMFE:24 | PM:36 | Cycle time scatter with 50/85/95 percentile lines | carried | carried | dash §2.10.2 |
| PMFE:25 | PM:36 | SLE sentence 85% of cards finish within 6.2 hours | carried | carried | dash §2.10.1 |
| PMFE:26 | PM:36 | Percentiles, not averages, because flow data is skewed | carried-weaker | carried | dashboard §2.10 |
| PMFE:27 | PM:37 | Throughput bars with 7-day average line | carried | carried | dash §2.10.2 |
| PMFE:28 | PM:38 | Cumulative flow: stacked bands Backlog→Done over 30 days | carried | carried | dash §2.10.2 (7/30/90 selectable) |
| PMFE:29 | PM:39 | Aging WIP: dot per unfinished card at its age against 50th/85th bands | carried | carried | dash §2.10.2 |
| PMFE:30 | PM:39 | Dot above 85th flagged in words Older than 85% of finished cards | carried-weaker | carried | dashboard §2.10.2 |
| PMFE:31 | PM:39 | Aging WIP is the first chart | carried | carried | dash §2.10.2 ("first") |
| PMFE:32 | PM:40 | Cycle planning asks appetite (points to bet), not capacity to the brim | carried | carried | ppm §2.7.7 |
| PMFE:33 | PM:40 | Leave 15–20% of a cycle unplanned by default | carried | carried | ppm §2.7.3, §2.7.7 |
| PMFE:34 | PM:41 | Standup: Done since yesterday · In flight · Needs you, each line a card chip | carried | carried | ppm §2.7.8 table; P6 (since the previous standup) |
| PMFE:35 | PM:41 | Standup posted to Slack when connected | carried | carried | ppm §2.7.8; int INT-18 |
| PMFE:36 | PM:47 | PM is a named team member with an avatar and a presence line | carried-weaker | carried | dashboard §2.7.2 |
| PMFE:37 | PM:47 | PM messages cite cards and runs | carried | carried | dash §2.7.4 |
| PMFE:38 | PM:47 | Avoid: an agent that edits issues without asking | carried | carried | ppm §2.8.3 |
| PMFE:39 | PM:48 | The proposal: a plan as concrete field changes you edit, apply or discard | carried | carried | ppm §2.8.3; edits recorded as preference pairs ppm §2.13.3 |
| PMFE:40 | PM:49 | Thread typography: prose first; tool use and reasoning as quiet, expandable detail; long work shows progress | carried-weaker | carried | dashboard §2.7.3, §2.7.8 |
| PMFE:41 | PM:49 | Avoid bubbles on both sides, avatars on every line, decoration | carried | carried | dash §2.7.3 |
| PMFE:42 | PM:50 | Field diffs with Apply/Discard per change and for all | carried | carried | dash §2.7.7 |
| PMFE:43 | PM:50 | `y`/`n` (git add -p keys), `⇧Y` apply all; Apply all states how many cards it touches | carried | carried | dash §2.3, §2.7.7 |
| PMFE:44 | PM:52 | Reply takes 40–120 s; explain the wait as steps with times | carried | carried | ppm §2.8.6, §2.8.14; dash §2.7.8 |
| PMFE:45 | PM:60 | Name Seshat and its rationale | carried | carried | NAMING themed names |
| PMFE:46 | PM:62 | Seshat runs on the manager model (`dirk-27b`), never the Worker | carried | carried | ppm §2.8.1 (Planner role's model); models §2.3 (Dirk-Qwen3.8-27B default) |
| PMFE:47 | PM:62 | Panel header always shows Seshat · Project manager · dirk-27b so the user sees the correct model | contradicted | deliberate | dashboard §8.3, §9; R15 |
| PMFE:48 | PM:64 | Avatar: 24 px rounded square, `--bg-overlay`, single letter at 600 weight in `--text-primary`; no gold, face, gradient | carried-weaker | carried | dashboard §2.7.2 |
| PMFE:49 | PM:64 | Worker, when quoted, uses the same avatar shape with "W"; You use your git initial | contradicted | deliberate | dashboard §2.4.4, §9; NAMING; R10 (roles no avatar; a person keeps an initials monogram) |
| PMFE:50 | PM:70 | Voice: answer first, then evidence | carried | carried | ppm §2.8.2 |
| PMFE:51 | PM:71 | Numbers with a basis | carried | carried | ppm §2.8.2 |
| PMFE:52 | PM:72 | Every card mentioned is an `@card` chip | carried | carried | ppm §2.8.2; dash §2.7.4 |
| PMFE:53 | PM:73 | Proposes, never does; says "I've proposed…", never "I've changed…" | carried | carried | ppm §2.8.3 (the phrasing rule is lost; the behaviour is kept) |
| PMFE:54 | PM:74 | Says what it doesn't know; guesses marked My read (not verified): | carried | carried | ppm §2.8.2, §2.8.11 |
| PMFE:55 | PM:75 | Most replies under 120 words; long answers use the three-heading standup shape | carried-weaker | carried | planner-pm §2.8.2 |
| PMFE:56 | PM:76 | No flattery, filler, exclamation, emoji, sign-off | carried | carried | ppm §2.8.2 |
| PMFE:57 | PM:84-94 | Sample exchange: standup (sections, pace sentence, Based on: board time · run · ledger #) | carried-weaker | carried | planner-pm §2.8.17 |
| PMFE:58 | PM:96-110 | Sample: "why did the ledger card fail?" — stop reason, step, repeated action, upstream protected-test cause, send-back… | carried-weaker | carried | planner-pm §2.8.17 |
| PMFE:59 | PM:112-122 | Sample: "split this card" — over the 3-file bound, split along routes,… | carried-weaker | carried | planner-pm §2.8.17, §2.3.3 |
| PMFE:60 | PM:124-136 | Sample: "plan next cycle" — bet below the average with the basis, goal sentence, in/out deliberately, asks appetite on… | carried | carried | ppm §2.7.7; P6 (bet ≤ 85% of the mean of the last three cycles) |
| PMFE:61 | PM:138-149 | Sample: "what's at risk?" — aged card vs 85th pct, Review full, explicit Not at risk line, priority proposal | carried-weaker | carried | planner-pm §2.8.2, §2.8.17 |
| PMFE:62 | PM:153 | Seshat in two places sharing one thread | carried | carried | dash §2.7.1 |
| PMFE:63 | PM:155 | Panel: persistent right dock, 400 px, `⌘J` from any view | carried | carried | dash §2.7.1 |
| PMFE:64 | PM:155 | ≥1280 px dock: view narrows, columns relax to 184 px min, board scrolls with Working beside pinned Review and Parked | carried | carried | dash §2.7.1 |
| PMFE:65 | PM:155 | 1024–1279 px: overlay at 380 px; board keeps its width | carried | carried | dash §2.7.1 (old §4.2 said 360; the new spec settles on 380) |
| PMFE:66 | PM:155 | Open/closed remembered per browser; hidden on `#/pm` and below 768 px | carried | carried | dash §2.7.1, §3 per-browser settings |
| PMFE:67 | PM:157 | Full view `#/pm` on chord `g a` | contradicted | deliberate | dashboard §2.3.1, §9 |
| PMFE:68 | PM:157 | Full view: 720 px reading column, 288 px rail with Open proposals, Worker (state, step, paused), What Seshat can see (b… | carried | carried | dash §2.7.1 |
| PMFE:69 | PM:181 | Your messages: `--bg-raised`, right-aligned, max 85%, time in 11 px secondary | carried-weaker | carried | dashboard §2.7.3 |
| PMFE:70 | PM:182 | Seshat's replies: full-width prose, no bubble, one-line header (avatar, name, time) | carried | carried | dash §2.7.3 |
| PMFE:71 | PM:183 | System messages: one centred 11 px secondary line | carried | carried | dash §2.7.3 |
| PMFE:72 | PM:184 | Markdown limited to paragraphs, lists, bold, code, fenced code, `###` | carried | carried | dash §2.7.3 |
| PMFE:73 | PM:184 | Pure escape-first renderer (`renderPmMarkdown`), unit-tested; model text never injects markup | carried | carried | dash §2.7.3, S3c |
| PMFE:74 | PM:184 | Raw links render as text | carried | carried | dash §2.7.3 |
| PMFE:75 | PM:188 | `@card_id` chip: state icon, short id in mono, title truncated at 32 chars | carried | carried | dash §2.7.4 (id → key) |
| PMFE:76 | PM:188 | Click chip peeks; ⌘-click opens card view | carried | carried | dash §2.7.4 |
| PMFE:77 | PM:189 | Unknown ids render as plain mono text | carried | carried | dash §2.7.4, §6 |
| PMFE:78 | PM:190 | `@` in composer opens fuzzy card picker; `↵` inserts the chip token | carried | carried | dash §2.7.4, §2.3 |
| PMFE:79 | PM:191 | Cites under the reply as Based on: chips for cards, runs (→ `#/runs/<id>`) and evidence (→ the card's evidence tab) | carried-weaker | carried | dashboard §2.7.4 |
| PMFE:80 | PM:193 | Context chip Looking at: Board · Cycle 12 · 2 filters / @hasher | carried | carried | dash §2.7.5 |
| PMFE:81 | PM:193 | Sent as `context: { cardId?, view }`; `✕` drops it for the next message; it returns when you move | carried | carried | dash §2.7.5; PMC §3 |
| PMFE:82 | PM:193 | Why the chip exists (silent context feels like surveillance; none makes you repeat yourself) | carried-weaker | carried | dashboard §2.7.5 |
| PMFE:83 | PM:197 | Composer grows 1–8 lines; `↵` send, `⇧↵` newline, `Esc` returns focus without closing the panel | carried | carried | dash §2.7.6, §2.3 |
| PMFE:84 | PM:198 | Starter prompts when thread empty or idle 12 h (Standup, What's at risk, Plan the next cycle) + contextual (Why did @x… | carried | carried | dash §2.7.6 (+ *Start a new project*) |
| PMFE:85 | PM:199 | Cost line under the composer, 11 px secondary, says what sending does | carried | carried | dash §2.7.6 |
| PMFE:86 | PM:200 | Worker-running cost line names the step (step 5 of 32) and the ETA (about 40s) | carried-weaker | carried | dashboard §2.7.6 |
| PMFE:87 | PM:201 | Idle cost line Seshat runs locally on dirk-27b. Replies take about a minute. | contradicted | deliberate | dashboard §2.7.6, §9; R15 |
| PMFE:88 | PM:202 | Read-only cost line + composer disabled | carried | carried | dash §2.7.6 |
| PMFE:89 | PM:204 | A reply with `proposals[]` ends in a proposal group | carried | carried | dash §2.7.7 |
| PMFE:90 | PM:207 | Group header Proposed changes · 3 open, Discard all, Apply all ⇧Y | carried | carried | dash §2.7.7 |
| PMFE:91 | PM:224 | Field diff row: label (secondary, 96 px), before struck on `--tint-fail`, arrow, after (primary, 500 weight) on… | carried-weaker | carried | dashboard §2.7.7 |
| PMFE:92 | PM:224 | Values as people read them (glyph+word, `3 pts`, names, Worker/You, `Sep 29`, None) | carried | carried | dash §2.7.7 |
| PMFE:93 | PM:224 | Labels diff as a set (`+ security − later`) | carried | carried | dash §2.7.7 |
| PMFE:94 | PM:224 | Colour never the only signal in a diff (arrow, strike, words) | carried | carried | dash §2.1.2, §2.14 |
| PMFE:95 | PM:225 | Create/split: numbered new cards with title, kind, points, waits on 1 | carried | carried | dash §2.7.7 |
| PMFE:96 | PM:226 | Reorder shows Position 7 → 2 in Ready; move shows Ready → Backlog | carried-weaker | carried | dashboard §2.7.7 |
| PMFE:97 | PM:227 | Park and unpark proposals show the reason | carried | carried | dash §2.7.7 ("park shows the reason") |
| PMFE:98 | PM:229-232 | Proposal states Open / Applied (pass check, by you at 09:05) / Discarded (struck line) / Stale (amber rule, reason in… | carried | carried | dash §2.7.7, §6 |
| PMFE:99 | PM:233 | Apply all copy Apply 3 changes to 5 cards; in order; stops at first failure with Applied 2 of 3… | carried | carried | dash §2.7.7; ppm §2.8.3, §6 |
| PMFE:100 | PM:233 | Applied changes are ledger events with actor You | carried | carried | ppm §2.8.3 (PMC §3 event name `pm/proposal_applied` vs code `pm/proposal_state` — ppm §8.2) |
| PMFE:101 | PM:234 | Proposal keys y / n / ⇧Y / j,k when focused | carried | carried | dash §2.3 |
| PMFE:102 | PM:235 | Import uses the same component; never silent; Import from Jira CSV · 42 cards | carried | carried | dash §2.7.7, §2.11 |
| PMFE:103 | PM:239 | The wait is a visible procedure driven by `PmStatus.phase` | carried | carried | dash §2.7.8; PMC §3 |
| PMFE:104 | PM:241 | Pending reply block under Seshat's header where the reply will land | carried | carried | dash §2.7.8 |
| PMFE:105 | PM:249-251 | Block's explanation (Only one model fits in memory… continues from step 6… You can keep working; the reply lands here.… | missing | carried | dashboard §2.7.8 |
| PMFE:106 | PM:256 | `waiting_for_step`: Pausing the Worker after step 5 (step from `detail` or `step`); Waiting for step 5 to finish. Th… | carried | carried | dash §2.7.8; PMC §3 |
| PMFE:107 | PM:257 | `loading_pm`: about 40s; 2 px lapis bar to the ETA (`detail`'s `~40s` or `etaSeconds`); past the ETA the bar stops an… | carried | carried | dash §2.7.8; PMC §3 |
| PMFE:108 | PM:258 | `thinking`: elapsed only; after 90 s Long answers can take up to two minutes on this machine. | carried | carried | dash §2.7.8 |
| PMFE:109 | PM:259 | `resuming_worker`: Reloading the Worker; step 6 starts next.; the reply is usually already above | carried | carried | dash §2.7.8 |
| PMFE:110 | PM:260 | `idle`: block removed | carried-weaker | carried | dashboard §2.7.8 (`idle`: block removed) |
| PMFE:111 | PM:263-265 | Row states: completed = pass check + duration; current = lapis ring + running timer (tabular, ticks once a second, noth… | carried-weaker | carried | dashboard §2.7.8 |
| PMFE:112 | PM:266 | No runner lease → Worker rows omitted (Loading the PM → Thinking) | carried | carried | dash §2.7.8 |
| PMFE:113 | PM:267 | Header timer = total since your message was queued | carried | carried | dash §2.7.8 ("total timer") |
| PMFE:114 | PM:268 | Panel header repeats the current phase in one line with its time | carried | carried | dash §2.7.2 |
| PMFE:115 | PM:269 | Shell bar (lowest priority) while `workerPaused`: Worker paused after step 5 while Seshat replies. +… | carried-weaker | carried | dashboard §2.2.4 |
| PMFE:116 | PM:270 | Running tile reads Paused for Seshat · step 5 of 32 | carried | carried | dash §2.7.8 |
| PMFE:117 | PM:271 | Second message during a wait: Queued · Seshat answers in order | carried | carried | dash §2.7.8 |
| PMFE:118 | PM:272 | Error state: Seshat couldn't reply. + server text verbatim + `Retry` (same text and context) | carried | carried | dash §2.7.8 |
| PMFE:119 | PM:273 | Offline freezes timers, disables composer with Offline. Your message would not reach Seshat. | carried | carried | dash §2.7.8 (copy lost, behaviour kept) |
| PMFE:120 | PM:279 | Thread 404: Seshat isn't on this server yet + how to fix; composer disabled with reason; nav item stays | carried | carried | dash §2.7.9 |
| PMFE:121 | PM:280 | First conversation: local intro paragraph (not sent), then starters | carried | carried | dash §2.7.9 |
| PMFE:122 | PM:281 | Loading: three skeleton lines | carried | carried | dash §2.7.9 |
| PMFE:123 | PM:282 | Thread 5xx: Couldn't load the conversation. The server returned 500. `Retry` | carried | carried | dash §2.7.9 ("thread error with Retry") |
| PMFE:124 | PM:292 | Tile row 1: priority · kind · labels (max 2, +n) · points · id | contradicted | deliberate | dashboard §9 |
| PMFE:125 | PM:300 | Priority glyph in a fixed 12 px slot at the far left so priorities scan as a column | carried-weaker | deliberate | dashboard §9 (List view scans priority) |
| PMFE:126 | PM:302 | Low/Med/High = 1–3 of three rising bars; unlit bars `--border-strong` | carried-weaker | carried | dashboard §2.4.4 |
| PMFE:127 | PM:303-304 | Urgent: rounded square with exclamation; glyph `--text-secondary`, Urgent `--text-primary`; shape, not colour | carried | carried | dash §2.4.4 |
| PMFE:128 | PM:305 | Labels: 11 px secondary in 1 px `--border-subtle` outline, at most two, then `+n` | carried | carried | dash §2.4.4 |
| PMFE:129 | PM:306 | Points `3 pts`, omitted when unset | carried | carried | dash §2.4.4, P3 |
| PMFE:130 | PM:307 | Tile height stays 88 px because windowing depends on it | carried | carried | dash §2.4.4 (88 px; reason lost) |
| PMFE:131 | PM:311 | View bar 40 px under the topbar on `--bg-base` with a hairline | carried | carried | dash §2.4.11 (colour lost) |
| PMFE:132 | PM:317 | Board / List segmented control, `v` | carried | carried | dash §2.4.11, §2.3 |
| PMFE:133 | PM:318 | Named views (All cards default, Current cycle, Needs you, Urgent and high, Unestimated) + saved; query in mono | carried | carried | dash §2.4.11 |
| PMFE:134 | PM:319 | Filter chips (click to edit, `✕`); `+ Filter` fields Priority, Label, Epic, Cycle, Assignee, Kind, State | carried | carried | dash §2.4.11 |
| PMFE:135 | PM:320-329 | Query terms incl. `cycle:current\|none`, `is:blocked\|needs-you\|running\|unestimated`, free words, `-` negation | carried | carried | dash §2.4.12 (+ AND/OR semantics) |
| PMFE:136 | PM:331 | Chips and text are one filter object (`parseQuery`/`formatQuery`, unit-tested) | carried | carried | dash §2.4.12; tests `pm.spec.ts` (§4) |
| PMFE:137 | PM:332 | Group None/Epic/Assignee/Priority/Cycle; `⇧S` cycles | carried | carried | dash §2.4.11, §2.3 |
| PMFE:138 | PM:333 | Save view only when the filter differs; saves `{ name, query, group, layout }` | carried-weaker | carried | dashboard §2.4.11, §3 |
| PMFE:139 | PM:333 | Saved in this browser until `/api/views`; menu footer says so | carried | carried | dash §2.4.11; server views in dash §7 |
| PMFE:140 | PM:335 | Cycle "in force" = marked active, or a planned cycle whose dates contain today,… | carried-weaker | carried | dashboard §2.4.13 |
| PMFE:141 | PM:342 | Bar segments: done `--state-pass`, in progress `--state-running`, not started `--bg-overlay`, sized by points | carried-weaker | carried | dashboard §2.4.13 |
| PMFE:142 | PM:343 | Tick at the linear pace (elapsed ÷ total days) | carried | carried | dash §2.4.13 |
| PMFE:143 | PM:344 | < 2 days left and < 70% done → amber, tooltip Behind the linear pace by 5 pts | carried | carried | dash §2.4.13 |
| PMFE:144 | PM:345 | Unestimated cards count as 1 pt; header says how many | carried | carried | dash §2.4.13 |
| PMFE:145 | PM:346 | Plan next cycle with Seshat opens the panel with the prompt filled in, not sent | carried | carried | dash §2.4.13 |
| PMFE:146 | PM:350 | Lane: 32 px header (chevron, name, count, points) and a row of the same columns | carried | carried | dash §2.4.14 |
| PMFE:147 | PM:351 | Epic lanes show epic progress (`done / total` cards) | carried | carried | dash §2.4.14 (basis lost) |
| PMFE:148 | PM:352 | Always a No epic / No assignee / No cycle / No priority lane, last | carried | carried | dash §2.4.14 |
| PMFE:149 | PM:353 | Rails still collapse empty columns board-wide | contradicted | deliberate | dashboard §9 (chips) |
| PMFE:150 | PM:354-355 | Lane collapses with its chevron; `j/k` cross lanes, `h/l` stay | carried | carried | dash §2.4.14, §2.3 |
| PMFE:151 | PM:356 | Lanes not windowed (filtered views); ungrouped board virtualized for 500+ | carried | carried | dash §2.4.9 |
| PMFE:152 | PM:360 | List shares filter, grouping and selection with the board | carried | carried | dash §2.4.15 |
| PMFE:153 | PM:362 | List columns (checkbox, Priority, ID, Title+kind, State, Epic, Cycle, Points, Labels, Assignee, Due, Updated) | carried | carried | dash §2.4.15 (ID → Key) |
| PMFE:154 | PM:366 | Rows 36 px; title fluid, others fixed, numeric right-aligned | carried-weaker | carried | dashboard §2.4.15 |
| PMFE:155 | PM:367 | Group header 32 px with count and points; `Space` collapses | carried | carried | dash §2.4.15, §2.3 |
| PMFE:156 | PM:368 | Sort: headers are buttons (Tab-reachable); second click reverses; stable, priority tiebreak | carried-weaker | carried | dashboard §2.4.15 |
| PMFE:157 | PM:369 | Inline edit by click or key (⇧P ⇧E ⇧L ⇧C ⇧A `.`) on Priority/Epic/Cycle/Points/Labels/Assignee/Due | carried | carried | dash §2.4.15, §2.3 |
| PMFE:158 | PM:370 | Anchored menu with number keys | carried | carried | dash §2.3 (`1–9`) |
| PMFE:159 | PM:371 | Labels menu is a checkable list with a Create label "…" row | missing | carried | dashboard §2.4.15 |
| PMFE:160 | PM:372 | Due offers Today, End of this week, End of the current cycle, No due date | missing | carried | dashboard §2.4.15 |
| PMFE:161 | PM:373 | Optimistic edit → `PATCH /api/cards/:id`; on failure revert + toast with the reason | carried | carried | dash §2.4.15; ppm §2.14 |
| PMFE:162 | PM:374 | Selection `x`, ⇧J/⇧K, ⌘A, Esc, shift-click | carried | carried | dash §2.3 |
| PMFE:163 | PM:375 | List keys follow the board (`Enter` open, `Space` peek) | carried | carried | dash §2.3 |
| PMFE:164 | PM:379 | Bulk bar bottom-centre, 48 px, `--bg-overlay`, 1 px `--border-strong` | carried-weaker | carried | dashboard §2.4.16 |
| PMFE:165 | PM:382 | Bulk bar contents: count · points, field actions with key hints, Park, Ask Seshat, ✕ Esc | carried | carried | dash §2.4.16 |
| PMFE:166 | PM:385 | Field actions reuse the inline-edit menus and apply to all selected | carried | carried | dash §2.4.16 |
| PMFE:167 | PM:386 | Park asks one reason, one park per card | carried | carried | dash §2.4.16 |
| PMFE:168 | PM:387 | Ask Seshat: selection as mentions, not sent (context carries one card) | carried | carried | dash §2.4.16 |
| PMFE:169 | PM:388 | One toast reports the result, including partial failures | carried | carried | dash §2.4.16 |
| PMFE:170 | PM:390 | Integrations `#/integrations` on `g s` | contradicted | deliberate | dashboard §2.3.1, §9; R17 (`g n`) |
| PMFE:171 | PM:392 | Every integration card says what leaves the machine; nothing connected by default | carried | carried | dash §2.11; int Principles 1 |
| PMFE:172 | PM:392 | Page in three sections Now / Next / Later following the roadmap | contradicted | carried | dashboard §2.11 (by API `tier`), NEW-dashboard-2 |
| PMFE:173 | PM:398 | GitHub card: status, Last synced (`lastSyncAt`), last result counts, linked `owner/repo#n` in list view | carried | carried | dash §2.11, §2.4.15; int item 8 |
| PMFE:174 | PM:398 | Pull / Push / Sync both; Syncing with GitHub… while running; errors verbatim | carried-weaker | carried | dashboard §2.11 |
| PMFE:175 | PM:398 | GitHub leaves: titles, specs, priority, points, cycle, state; uses `gh` login; no stored token | carried | carried | dash §2.11 |
| PMFE:176 | PM:399 | PR on Accept switch (`PUT /api/integrations/github-pr`), current behaviour stated; leaves branch, diff, gate results | carried | carried | dash §2.11; int item 15, §3 |
| PMFE:177 | PM:400 | Jira CSV columns (Summary, Issue Type, Priority, Story Points, Sprint, Epic Link, Labels, Description); Export/Import;… | carried | carried | int item 17, INT-31; dash §2.11 |
| PMFE:178 | PM:401 | Linear: same in Linear's fields | carried | carried | int item 17 |
| PMFE:179 | PM:402 | Slack: standup, needs-you, run reports; host in mono, last message, delivered (`pm/notify ok`) | carried | carried | dash §2.11; int items 20–22 |
| PMFE:180 | PM:402 | Slack controls: webhook field, Connect, Send test message, Disconnect | carried | carried | dash §2.11; PMC §5 |
| PMFE:181 | PM:402 | Webhook URL is a credential: `~/.config/sekhemet/repos/…`, mode 0600, never in repo or ledger | carried | carried | dash §2.11; int INT-30; PMC §5 |
| PMFE:182 | PM:404 | Import sheet: format picker (Jira CSV, Linear CSV, GitHub JSON, Sekhemet JSON), file chooser, paste box | carried | carried | dash §2.11 |
| PMFE:183 | PM:404 | Preview → `/api/import` → proposals headed Import from Jira CSV · 42 proposed changes; apply one, some or all; never… | carried | carried | dash §2.11; int item 18 |
| PMFE:184 | PM:404 | Server posts the preview into Seshat's thread (`messageId`); the sheet says so | carried-weaker | carried | dashboard §2.11, §3 |
| PMFE:185 | PM:404 | Export `/api/export?format=…` names the file `sekhemet-<project>-<format>.csv\|json` | carried | carried | dash §2.11; PMC §3 |
| PMFE:186 | PM:406 | Next tier: quiet cards with name, one sentence, Planned, no button | carried-weaker | carried | dashboard §2.11 (Next and Later quiet, *Planned*, no button) |
| PMFE:187 | PM:408 | Jira and Linear live sync (OS keychain token) | later | later | integrations §7 |
| PMFE:188 | PM:409 | GitHub Actions gate mirror | carried | carried | int item 14 (gate runs as Check Runs, built) |
| PMFE:189 | PM:410 | Microsoft Teams | later | later | integrations §7 |
| PMFE:190 | PM:411 | Slack replies | later | later | integrations §7 |
| PMFE:191 | PM:415 | Sentry, Datadog, PagerDuty as card sources (bug-card proposals) | later | later | integrations §7 |
| PMFE:192 | PM:416 | Notion and Confluence publishing (plans, run reports, decision logs; read linked specs) | later | later | integrations §7 |
| PMFE:193 | PM:418 | Later rows still state the data they would send | carried-weaker | carried | dashboard §2.11 (still state the data they would send) |
| PMFE:194 | PM:420 | Integrations 404: sections still render from the catalogue; Now cards Not available on this server yet, no controls | contradicted | deliberate | dashboard §9 |
| PMFE:195 | PM:424 | Tier rationale (Stack Overflow 2025: GitHub 81%, Jira 46%, GitLab 36%; JetBrains 2025: Actions 33%) | carried | carried | PMC §5; int §3 |
| PMFE:196 | PM:424 | UI copy keyed on ids; unknown id renders from the server's `name` and `detail` | carried-weaker | carried | dashboard §2.11 |
| PMFE:197 | PM:426-438 | Roadmap table: ids and what leaves the machine per integration | carried | carried | PMC §3 (ids), §5 (table) |
| PMFE:198 | PM:440 | Insights `#/insights` on `g f` | contradicted | deliberate | dashboard §2.3.1, §9 |
| PMFE:199 | PM:442 | `/api/metrics/flow?days=30`, 7/30/90 selectable | carried | carried | dash §2.10; PMC §3 |
| PMFE:200 | PM:444-449 | Headline: cycle time 85th pct, throughput, WIP (with how many over 85th), oldest in progress | carried | carried | dash §2.10.1 |
| PMFE:201 | PM:453-456 | Aging WIP: columns Ready→Review on x, age on y, bands, amber above 85%, hover shows the card, click peeks | carried | carried | dash §2.10.2 (hover weaker) |
| PMFE:202 | PM:457-459 | Cycle time: dashed percentile lines labelled `50% 2.1h` etc.; subtitle sentence | carried | carried | dash §2.10.2 |
| PMFE:203 | PM:460-461 | Throughput: daily bars + 7-day moving average | carried | carried | dash §2.10.2 |
| PMFE:204 | PM:462-465 | CFD: Backlog bottom → Done top; band colours by state role (running = Working, parked = Review as the human queue, pass… | carried-weaker | carried | dashboard §2.10.2 |
| PMFE:205 | PM:467-472 | Chart rules: token classes, tabular, baseline + percentile rules only, `figcaption` | carried | carried | dash §2.10.5 |
| PMFE:206 | PM:474 | Worker capability section (`GET /api/capability`) under the flow charts | carried | carried | dash §2.10.3; rt routes |
| PMFE:207 | PM:476 | Per-kind row: point on 0–100% track, 95% Wilson bar, 16 of 18 passed · 89% (67–97%) | carried | carried | dash §2.10.3 |
| PMFE:208 | PM:476 | Rows ordered by attempts (best-evidenced first) | missing | carried | dashboard §2.10.3 |
| PMFE:209 | PM:477 | < 10 attempts: Too few attempts to trust in amber, hollow point, secondary label | carried | carried | dash §2.10.3 |
| PMFE:210 | PM:477 | Caption counts rough rows (2 of 5 kinds have fewer than 10 attempts; treat those rates as rough); a wide bar explaine… | missing | carried | dashboard §2.10.3 |
| PMFE:211 | PM:478 | Pass rate by change size with 80% line; horizon sentence (`horizon80Lines`) | carried | carried | dash §2.10.3 |
| PMFE:212 | PM:478 | Size buckets with < 10 attempts faded and labelled | missing | carried | dashboard §2.10.3 |
| PMFE:213 | PM:478 | The server's `note` shown verbatim under the section | missing | carried | dashboard §2.10.3 |
| PMFE:214 | PM:479 | Capability states: 404 names the endpoint; `sampleSize` 0 → No finished attempts yet; renders independently of flow m… | carried-weaker | carried | dashboard §2.10.3 |
| PMFE:215 | PM:481 | Under 3 finished cards: Not enough finished cards… need at least 3; you have 1. | carried | carried | dash §2.10.5 |
| PMFE:216 | PM:481 | Flow 404 message naming `/api/metrics/flow` | carried | carried | dash §2.12.3 (generic) |
| PMFE:217 | PM:485 | Everything learned is context not weights, from gate results and human actions, on the ledger,… | contradicted | deliberate | planner-pm §2.13.3, §8.1 (profile statements: owner decision O24, default used at once; rules need approval; was awaiting the owner) |
| PMFE:218 | PM:485 | Plain names (Playbook, rules, What Seshat has learned about you, Stopping policy) | carried | carried | dash §2.11, §2.10.4; NAMING |
| PMFE:219 | PM:487 | Playbook lede (learned from gates and your actions, never a model grading itself; on this machine; on the ledger; takes… | missing | carried | dashboard §2.11 |
| PMFE:220 | PM:489 | Needs your approval: candidates newest first; Approve (primary), Edit, Retire | carried-weaker | carried | dashboard §2.11 |
| PMFE:221 | PM:490 | Active: retirement proposals (≥ 3 more harmful than helpful) first, amber rule, sentence with the counts,… | carried-weaker | deliberate | DEC-28 retirement, now in dashboard §2.11; was: dashboard §2.11 still lists "retirement proposals — at least 3 more harmful than helpful uses" (and PM_CONTRACT §6 the same rule), while DEC-28, measurement §2.16a–b and… |
| PMFE:222 | PM:491 | Retired collapsed | carried-weaker | carried | dashboard §2.11 |
| PMFE:223 | PM:494 | Rule audience For the Worker / For Seshat | carried | carried | dash §2.11 ("audience") |
| PMFE:224 | PM:495 | Source in words (four sources) and its age | carried-weaker | carried | dashboard §2.11 |
| PMFE:225 | PM:496 | Scope chips (Kind, Files, Error, Applies to every card) | carried | carried | dash §2.11 |
| PMFE:226 | PM:497 | Signed value bar relative to the page's largest \|value\|, red when negative; helpful/harmful counts with icons | carried-weaker | carried | dashboard §2.11 (signed bar, helpful/harmful counts); the counts' meaning is DEC-28's paired credit — see PMFE:221 |
| PMFE:227 | PM:498 | Evidence as `@card` chips with quoted note; first two shown, rest n more signals | carried-weaker | carried | dashboard §2.11 |
| PMFE:228 | PM:501 | Inline edit: textarea, `⌘↵` saves, `Esc` cancels | carried-weaker | carried | dashboard §2.11 |
| PMFE:229 | PM:501 | Every learning action optimistic, reverts on failure, states the result (Approved. The rule is given to the Worker fro… | missing | carried | dashboard §2.11 |
| PMFE:230 | PM:501 | `/api/learning` 404 → keep seeded rules and send-back suggestions from `/api/playbook` under a banner naming the endpoi… | missing | carried | dashboard §2.11 |
| PMFE:231 | PM:503 | Approve opens a reach picker This project (1) / All projects (2), sent as `{ reach: "global" }`; footer names… | carried-weaker | carried | dashboard §2.11 |
| PMFE:232 | PM:503 | Active rules carry a reach chip; all-projects rules drawn stronger | carried-weaker | carried | dashboard §2.11 (reach chip; all projects drawn stronger) |
| PMFE:233 | PM:503 | Seeded rules from `.sekhemet/playbook.toml` shown as active, read-only (Edit in playbook.toml) when the store lacks t… | missing | carried | dashboard §2.11 |
| PMFE:234 | PM:505-510 | Seshat's review (`card/review`) between Gates and Failures; count title; advice, not a gate line;… | contradicted | deliberate | review-git §2.3.5, §9 (the Reviewer, not Seshat; shown first); advisory line and order kept in dashboard §2.5.3 |
| PMFE:235 | PM:512 | Retries run on the escalation model excluded from capability rates and said so | carried | carried | dash §2.10.3 |
| PMFE:236 | PM:514 | What Seshat has learned about you is a Playbook section `#/playbook/profile` | carried | carried | dash §2.11 |
| PMFE:237 | PM:516 | Profile lock line (stays on this machine; edit to correct; dismiss and Seshat stops using it) | carried-weaker | carried | dashboard §2.11 |
| PMFE:238 | PM:517 | Active statements grouped by category, strongest first | carried-weaker | carried | dashboard §2.11 |
| PMFE:239 | PM:518 | Strength bar + word (Strong ≥ 0.7, Moderate ≥ 0.4, Weak), source, dated evidence, Edit, Dismiss | carried | carried | dash §2.11 |
| PMFE:240 | PM:519 | Dismissed statements collapsed at the end | missing | carried | dashboard §2.11 |
| PMFE:241 | PM:521 | `#/pm` rail: three strongest statements, See all 4 and edit them in Playbook, Stays on this machine | carried-weaker | carried | dashboard §2.7.1 |
| PMFE:242 | PM:523 | Stopping policy under Worker capability when `/api/learning` returns `tuning` | carried | carried | dash §2.10.4 |
| PMFE:243 | PM:525 | Headline sentence (cap, minutes saved, passes kept) | carried | carried | dash §2.10.4 |
| PMFE:244 | PM:526 | Current vs recommended table: step budget, failed checks allowed, minutes, first-try passes, eventual passes | carried-weaker | carried | dashboard §2.10.4 |
| PMFE:245 | PM:527 | Copyable `sekhemet queue --max-turns 12` | carried | carried | dash §2.10.4 |
| PMFE:246 | PM:528 | Note when the failed-check limit differs, because it has no flag yet | missing | carried | dashboard §2.10.4 |
| PMFE:247 | PM:529 | Caveat: replay only stops earlier, never credits a pass, cannot say whether a looser cap would rescue a failure | carried-weaker | carried | dashboard §2.10.4 |
| PMFE:248 | PM:530 | Full replay grid behind a disclosure | missing | carried | dashboard §2.10.4 |
| PMFE:249 | PM:532 | When the current policy is already best, say so and offer no command | missing | carried | dashboard §2.10.4 |
| PMFE:250 | PM:536 | Four roles: Worker; Seshat · PM; Adversarial reviewer (different family); Researcher (Apodex-1.1-mini, cites sources) | contradicted | deliberate | models rule 21; DEC-05 (roles are Worker, Planner, Reviewer, Researcher; Seshat is the persona on the Planner's weights) |
| PMFE:251 | PM:538 | Machine › Models (`GET /api/models`): fixed role order; model id in mono; state dot Resident / Swapped out / Not c… | carried-weaker | carried | dashboard §2.11 |
| PMFE:252 | PM:538 | A note every role shares (No run in progress) said once in the footer | carried-weaker | carried | dashboard §2.11 |
| PMFE:253 | PM:539-541 | Footer memory model: 24 GB one model resident; swaps about 40 seconds each; `coResident` → room for all four, nothin… | carried-weaker | carried | dashboard §2.11 |
| PMFE:254 | PM:542 | Roster 404 message naming the endpoint | carried | carried | dash §2.12.3 |
| PMFE:255 | PM:543 | Researcher web access Now card: switch `PUT /api/integrations/research-web`; server `detail` names provider or how to s… | carried | carried | dash §2.11; design-stage §3 |
| PMFE:256 | PM:543 | Provider line: SearXNG, or Brave/Tavily key; papers, page reads, GitHub need none | carried | carried | design-stage §2.11 |
| PMFE:257 | PM:543 | Leaves: search queries and page URLs; private/local addresses never fetched | carried | carried | dash §2.11; design-stage §2.3 |
| PMFE:258 | PM:544 | Research cites `{ url?, label }` → numbered Sources list (http/https only, new tab, `noopener noreferrer`, host in… | carried-weaker | carried | dashboard §2.7.4, §3 |
| PMFE:259 | PM:554 | `#/pm` on `g a` | contradicted | deliberate | dashboard §2.3.1, §9 |
| PMFE:260 | PM:555-556 | `⌘J` panel; `#/board` `g b`, `v` | carried | carried | dash §2.3 |
| PMFE:261 | PM:557-558 | `g f` Insights, `g s` Integrations | contradicted | deliberate | dashboard §2.3.1, §9; R17 |
| PMFE:262 | PM:562-567 | Field keys, select/extend/all/clear, `/` `v` `⇧S`, field menu `1–9 ↑↓ ↵`, composer and proposal keys | carried | carried | dash §2.3 |
| PMFE:263 | PM:571 | No new colour roles: fifteen roles plus derived tints | carried | carried | dash §2.13.1; tokens.ts (dash adds `--border-control`, not yet in tokens.ts — gap P12) |
| PMFE:264 | PM:573-588 | New icons: priority-none/low/medium/high/urgent, chat, insights, plug, split, arrow-right, list, filter, cycle, layers,… | carried | carried | All defined in `packages/ui/src/icons.ts` (dash §3 names it as the source) |
| PMFE:265 | PM:590 | Priority bars thickened in CSS (`stroke-width: 3`), unlit class `off`, icon test still holds | carried-weaker | carried | dashboard §2.4.4 |
| PMFE:266 | PM:594 | Panel sizes: 400 (360 at 1024–1279), header 52, composer min 44, padding 16, message gap 24 | carried-weaker | carried | dashboard §2.7.1, §2.13.7 |
| PMFE:267 | PM:595 | Proposal group: `--bg-surface`, 1 px `--border-subtle`, radius 6, header 36, proposal padding 12/16, diff rows 24 | carried-weaker | carried | dashboard §2.7.7 |
| PMFE:268 | PM:596 | Pending block: rows 24, icons 12, times 11 right-aligned tabular, ETA bar 2 | carried-weaker | carried | dashboard §2.7.8 |
| PMFE:269 | PM:597 | View bar 40, padding 16, gaps 8 | carried-weaker | carried | dashboard §2.4.11 |
| PMFE:270 | PM:598 | Cycle header 56, two lines, progress bar 6 px | carried-weaker | carried | dashboard §2.4.13 (56 px, two lines, 6 px bar) |
| PMFE:271 | PM:599-600 | Lane header 32; table row 36, group header 32 | carried | carried | dash §2.13.7, §2.4.15 |
| PMFE:272 | PM:601 | Bulk bar 48, bottom 16, centred, radius 6 | carried-weaker | carried | dashboard §2.4.16 |
| PMFE:273 | PM:602 | Chart panel `--bg-surface`, 1 px hairline, 16 padding, 240 plot | carried-weaker | carried | dashboard §2.10.2 |
| PMFE:274 | PM:606 | Panel is a `complementary` landmark labelled Seshat, project manager | carried-weaker | carried | dashboard §2.14.3 |
| PMFE:275 | PM:607 | Thread `role="log"`, `aria-live="polite"`, only final replies announced, not timer ticks | carried | carried | dash §2.14.3 |
| PMFE:276 | PM:608 | Pending block's current row `aria-busy="true"` | missing | carried | dashboard §2.14.3 |
| PMFE:277 | PM:609 | Proposals a list of labelled groups; Apply/Discard names include the summary | carried | carried | dash §2.14.3 |
| PMFE:278 | PM:610 | Field diffs as `dl` (Priority: Medium, changes to Urgent) | carried | carried | dash §2.14.3 |
| PMFE:279 | PM:611 | Charts: `figcaption` + hidden data table | carried | carried | dash §2.10.5 |
| PMFE:280 | PM:612 | List is a real `table` with `aria-sort` on sorted headers and `aria-selected` on rows | carried-weaker | carried | dashboard §2.14.3 |
| PMFE:281 | PM:613 | Bulk bar `role="toolbar"` announcing 3 selected | carried | carried | dash §2.14.3 |
| PMFE:282 | PM:617 | Every item checked in both themes at 1440 and 1024 | carried | carried | dash §2.15.5 (widths now 1440/1100/400) |
| PMFE:283 | PM:619-627 | `src/pm.ts` pure logic served as `/app/lib/pm.js` (priority, diffs, markdown, filter, grouping, cycle progress, flow ma… | carried | carried | dash §2.15.1, §3 |
| PMFE:284 | PM:628-636 | Web modules list | carried | carried | dash §3 |
| PMFE:285 | PM:640 | Backend endpoints for PM, PATCH, cycles, flow, integrations, export, import | carried | carried | rt §3 routes; PMC §3 |
| PMFE:286 | PM:640 | UI checked against a contract-shaped fixture server and a server with the endpoints absent | carried-weaker | carried | dashboard §2.15.5 (fixture server and a server with endpoints absent) |
| PMFE:287 | PM:640 | Optional contract fields used when present: `PmStatus.since/step/etaSeconds`, `cycleTime[].doneAt`, thread `model`,… | carried-weaker | carried | dashboard §3 (optional fields); PM_CONTRACT §3 (`pointsDone`, `model`) |
| PMFE:288 | PM:642 | Saved-view sync waits for `/api/views` | later | later | dashboard §7 |
| PMFE:289 | PM:642 | No drag and drop; moves explicit and recorded | carried | carried | dash §2.4.5 (reorder within a column now allowed; between columns still gated) |
| PMFE:290 | PM:642 | No Undo for applied proposals; Applied is final and says so | carried | carried | dash §2.7.7; undo in dash §7 (later) |

### 5.4 `FRONTEND_DESIGN.md`

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| PMFE:291 | FE:4 | Mockups board/review/card/runs, `t` toggles theme in them | carried | carried | dash §9 |
| PMFE:292 | FE:30 | Triage endpoints need UI (accept/return/park) | carried | carried | dash §2.5.9–12; rg §3 |
| PMFE:293 | FE:31 | Parked and rejected cards must be visible ("nothing blocks silently") | carried | carried | dash §2.4.1 (On hold column; Won't do filter) |
| PMFE:294 | FE:32 | `canvas.ts` `COLUMN_ORDER` disagrees with the page | carried | carried | canvas.ts cut (DEC-09); `BOARD_COLUMN_ORDER` in vocabulary (dash §3) |
| PMFE:295 | FE:33 | Model-authored labels (tier, `(SPIDR: …)`, raw stop enums) must not leak | carried | carried | dash §2.12; ppm P1 (kind from labels) |
| PMFE:296 | FE:34 | Gate strip must not invent gates: no fixed P T U L B, no synthesised `parse: pass` | carried-weaker | carried | dashboard §2.4.4, NEW-dashboard-1 |
| PMFE:297 | FE:34 | `bounds` must not count staged acceptance-test lines | missing | carried | gates rule 12, GT-11 (built); staged tests outside tests/ P1 (GT-P1-4) |
| PMFE:298 | FE:35 | Diff separates staged protected tests; `suggestedFixFiles` must not point at protected tests | carried | carried | dash §2.5.6; gates §7, GT-3 |
| PMFE:299 | FE:36 | `gatesConfigSha256` = empty-string hash: UI flags it and the backend must hash the real `gates.toml` | carried-weaker | gap | gates T1 (GT-T1-10, GT-T1-13) |
| PMFE:300 | FE:37 | Contrast defects (muted 2.6–3.3:1, fail on raised 3.92:1, border-strong 1.26–1.85:1 unfit for focus) | carried | carried | dash §2.13.2, §2.14, P12 |
| PMFE:301 | FE:46 | Master board: multi-project rollup, hardware load, cards blocked on you with wait time | carried-weaker | carried | dashboard §2.11 Workspace; beyond rollup later §7 |
| PMFE:302 | FE:47 | Project board columns, WIP counters, DAG lines, budget bars | carried | carried | dash §2.4; dependency lines later (dash §7) |
| PMFE:303 | FE:48 | Card view with 5 tabs | carried | carried | dash §2.6 |
| PMFE:304 | FE:49 | Review as the primary surface | carried | carried | dash §2.5 |
| PMFE:305 | FE:50 | Machine: VRAM, active tier, loaded models, throughput sparklines, cache hit rate | carried-weaker | gap | dashboard §2.11 (cache-hit sparkline built); active tier NEW-dashboard-2 |
| PMFE:306 | FE:51 | Registry: models, qualification, bake-off matrix | carried | carried | dash §2.11 |
| PMFE:307 | FE:52 | Decision inbox sorted by wait time | carried | carried | dash §2.5.2 (Review › Needs you) |
| PMFE:308 | FE:53 | Goal view: burn-up, criteria, risk register | later | later | dashboard §7, planner-pm §7 |
| PMFE:309 | FE:54 | Runs with history (not overwritten) | carried | carried | dash §2.11; rt routes `runs` |
| PMFE:310 | FE:55 | Ledger in sentences, filterable, linked to the card, paged beyond 200 | carried | carried | dash §2.11 (paging: see row 452) |
| PMFE:311 | FE:56 | Playbook view | carried | carried | dash §2.11 |
| PMFE:312 | FE:57 | Mobile: read-only board + one-tap Accept/Return/Park | carried | carried | dash §2.15.3 |
| PMFE:313 | FE:59 | Column: name, WIP `3/4`, progress, virtualized, h/j/k/l; empty state explains the column | carried | carried | dash §2.4.2–3, §2.4.10 |
| PMFE:314 | FE:60 | Tile: class chip, difficulty, token/second budget bars, dependency badge | contradicted | deliberate | dashboard §9 |
| PMFE:315 | FE:61 | Gate strip in execution order, typed-error hover, click to log; `gates.toml` served | carried | carried | dash §2.5.4; `/api/gates` (dash §3) |
| PMFE:316 | FE:62 | Diff: split/unified, structural, inline annotations | carried | carried | dash §2.5.6 |
| PMFE:317 | FE:63 | Evidence: criteria, plain stop reason, abandoned hypotheses, attempt history | carried | carried | dash §2.5.3 |
| PMFE:318 | FE:64 | Triage A/R/P; returns feed the playbook | carried | carried | dash §2.5; rg §2.4 |
| PMFE:319 | FE:65 | Decision request component | carried | carried | dash §2.5.14 |
| PMFE:320 | FE:66 | Palette: fuzzy cards, projects, commands, settings | carried | carried | dash §2.15.4 |
| PMFE:321 | FE:67 | Keyboard map | carried | carried | dash §2.3 |
| PMFE:322 | FE:68 | Cheat sheet | carried | carried | dash §2.3.3 |
| PMFE:323 | FE:69 | Live streaming with step-level events; replay from genesis | carried-weaker | carried | runtime 25, 25a; dashboard §3 |
| PMFE:324 | FE:70 | Toasts | carried | carried | dash §2.13.7 |
| PMFE:325 | FE:71 | Single-weight 1.5 px icon set | carried | carried | dash §2.13.6 |
| PMFE:326 | FE:72 | Virtualized board, 500+ cards, overscan 3, no full re-render per frame | carried-weaker | carried | dashboard §2.4.9 |
| PMFE:327 | FE:74-81 | States: loading, empty, error/offline, running, review full, memory pause, read-only, ledger broken | carried | carried | dash §2.2.4, §2.4.10 |
| PMFE:328 | FE:83 | Tokens 15 roles × 2 themes as CSS variables + JSON; add `--on-accent`, tints, `--scrim` | carried | carried | dash §2.13.1; tokens.ts defines all |
| PMFE:329 | FE:84 | Inter/JetBrains Mono, 6-step scale, tabular numbers; fonts not bundled | carried | carried | dash §2.13.4; vendoring later (dash §7) |
| PMFE:330 | FE:85 | Spacing/radius/no shadows/120 ms; `--space-5` undefined | carried | carried | dash §2.13.5; tokens.ts SPACING has 24px at index 5 |
| PMFE:331 | FE:86 | Both themes first-class; no `prefers-color-scheme` default | missing | carried | dashboard §2.1.3 |
| PMFE:332 | FE:87 | Brand glyph and favicon | carried | carried | dash §2.13.6 |
| PMFE:333 | FE:89-94 | API: evidence by attempt; accept returns sha; return → Ready; events/stream; decisions; machine + calibrate; run/gate/s… | carried | carried | rt §3 route list; rg §2.4 (rewind from UI later, dash §7) |
| PMFE:334 | FE:102-108 | Stance: What needs me? Can I trust it? What do I do? — sets IA, default route, hierarchy | carried | carried | dash §2.1.1 |
| PMFE:335 | FE:112 | No all-caps; headings sentence case 12.5/600 primary | carried | carried | dash §2.1.4, §2.13.4 |
| PMFE:336 | FE:113 | Gold in exactly four places | carried | carried | dash §2.1.4 |
| PMFE:337 | FE:114 | Chips rare; status in the sidebar footer as text + one dot | carried | carried | dash §2.2.3 |
| PMFE:338 | FE:115-117 | Units and basis on every number; nothing generic; chrome neutral, state is colour + icon + words | carried | carried | dash §2.1.2, §2.1.5 |
| PMFE:339 | FE:122-139 | Sidebar: project switcher (Chronicle ▾), count badges on nav items, footer (live · ledger · memory bar · model state… | carried-weaker | carried | dashboard §2.2.1 |
| PMFE:340 | FE:144 | Review is default when the queue is non-empty; `g r` | carried | carried | dash §2.2.5 (for *I write code*), §2.2.1 |
| PMFE:341 | FE:145 | Board default otherwise; `g b` | carried | carried | dash §2.2.1, §2.2.5 |
| PMFE:342 | FE:146 | Card route; `Enter` | carried | carried | dash §2.6 |
| PMFE:343 | FE:147 | Runs `#/runs[/:runId]` on `g q` | contradicted | deliberate | dashboard §2.3.1; R17 (`g u`) |
| PMFE:344 | FE:148-149 | Ledger `g l`; Machine `g m` | carried | carried | dash §2.2.1 |
| PMFE:345 | FE:150 | Playbook on `g p` | contradicted | deliberate | dashboard §2.3.1; R17 (`g k`) |
| PMFE:346 | FE:151 | Inbox `#/inbox` `g i`, hidden until `/api/decisions` returns 200 | contradicted | deliberate | dashboard §2.2.1, P11 (merged into Review › Needs you; §9 records the chord change, not a separate reason for the merge) |
| PMFE:347 | FE:152 | Settings `#/settings` `g ,`: theme, density, review minutes per day, read-only config (Later) | missing | gap | dashboard §2.11, NEW-dashboard-4 (R18) |
| PMFE:348 | FE:153 | Workspace, Registry, Goals deferred | carried | carried | Registry, Workspace in dash §2.11; goals later |
| PMFE:349 | FE:155 | Log drawer leaves the board; integrity in the footer | carried | carried | dash §2.2.3, §2.11 |
| PMFE:350 | FE:157 | Review landing rationale; empty Review says Nothing to review. 4 cards are ready to run. | carried | carried | dash §2.5.13 |
| PMFE:351 | FE:161 | ≥ 1280 px sidebar 216 px | carried | carried | dash §2.2.2 |
| PMFE:352 | FE:162 | 1024–1279 px: 52 px icon rail, tooltips, count badges | contradicted | deliberate | dashboard §9 |
| PMFE:353 | FE:163 | < 768 px: bottom tabs Review, Board, Runs; single-column board with switcher; Evidence only; 48 px one-tap triage | contradicted | deliberate | dashboard §9 |
| PMFE:354 | FE:167 | Voice: plain, exact, calm; verbs and numbers; name the gate | carried | carried | SPINE Voice |
| PMFE:355 | FE:167 | Naming conventions (Workspace, Project, Card, Subtask, Gates, Evidence, Playbook, Worker, Planner, Library) | carried | carried | NAMING keep list |
| PMFE:356 | FE:171-175 | Principles: outcome first; sentence case, no !/emoji; enums only in mono where greppable; quote errors verbatim; actor… | carried | carried | dash §2.12.2 |
| PMFE:357 | FE:181 | Tier label removed; hierarchy by breadcrumb and a 3 subtasks badge | carried-weaker | carried | dashboard §2.6 (breadcrumb with *3 subtasks*) |
| PMFE:358 | FE:182 | Strip `(SPIDR: …)` suffix; planner stores the slice as a field | carried | carried | ppm P1 (kind from labels) |
| PMFE:359 | FE:183-190 | Kind mapping Interface→Contract, Data→Storage, Path→Flow, Rule→Rules, Spike→Research, Visual→UI, Integration→Wiring; to… | carried-weaker | deliberate | DEC-26 (one kind map in NAMING; SPIDR is the split axis, R9); dashboard §2.12.4 |
| PMFE:360 | FE:191-199 | Column names Backlog, Ready, Planning, Working, Checking, Review, Done, Parked (visible), Closed (only if non-empty) | contradicted | deliberate | dashboard §2.4.1, §8.2; NAMING |
| PMFE:361 | FE:200 | 3 of 6 first try; Runs headline Passed on the first try; `Pass@1` only as a mono secondary label | carried-weaker | carried | dashboard §2.11 Runs |
| PMFE:362 | FE:201 | `passAfterEscalation` → Passed after a planner retry | missing | carried | dashboard §2.12.4 |
| PMFE:363 | FE:202 | `modelSwaps` → Model swaps | carried | carried | dash §2.11 Runs |
| PMFE:364 | FE:203-213 | Eleven stop-reason labels and sentences; `memory_pressure` amber, not red | carried | carried | dash §2.12.4 (tones explicit) |
| PMFE:365 | FE:214-219 | Gate labels with ids in mono; Types shows its command; Size sentence 2 files, +11 −0 (limit 3 files, 200 lines) | carried-weaker | carried | dashboard §2.12.4 |
| PMFE:366 | FE:220 | Gate states; Skipped vs Not run definitions | carried | carried | dash §2.12.4 |
| PMFE:367 | FE:221 | Noun Gates; 4 of 4 gates passed | carried | carried | dash §2.12.4 |
| PMFE:368 | FE:222 | Back-pressure copy | carried | carried | dash §2.2.4 |
| PMFE:369 | FE:223 | Integrity: Ledger intact · 13 entries / Ledger altered at entry #7 + An entry no longer matches its hash. Stop and… | carried-weaker | carried | dashboard §2.2.3–4 |
| PMFE:370 | FE:224 | Stream copy Live / Reconnecting… / Offline since … | carried | carried | dash §2.2.3–4 |
| PMFE:371 | FE:225-227 | Nav words Ledger, Machine / Health checks, Suggested rules | carried | carried | dash §2.2.1, §2.11 (Suggested rules → *Needs your approval*) |
| PMFE:372 | FE:228-230 | Triage labels, sentences and keys | carried | carried | dash §2.12.4 |
| PMFE:373 | FE:231-242 | Card-fact vocabulary (steps, tokens, May edit, Done when, Protected, Waits on/Unblocks, Difficulty, Why it stopped, Che… | carried | carried | dash §2.12.4, §2.5.8 |
| PMFE:374 | FE:243 | Actors executor/planner/human → Worker/Planner/You | carried | carried | dash §2.12.2 |
| PMFE:375 | FE:244-246 | Ledger sentence patterns | carried | carried | dash §2.11 Ledger |
| PMFE:376 | FE:247 | Empty Review copy ends with the command `sekhemet queue` | contradicted | deliberate | dashboard §2.5.13, §9 |
| PMFE:377 | FE:248 | Empty copy for each of eight columns | carried-weaker | carried | dashboard §2.4.10 |
| PMFE:378 | FE:249 | Empty evidence: No attempts yet… Budget: 32 steps. | carried | carried | dash §2.5.13 |
| PMFE:379 | FE:250-253 | Errors: what, why, action; 409 verbatim; 400 prevented client-side; 403 copy | carried | carried | dash §2.12.4, §6 |
| PMFE:380 | FE:254 | Read-only copy | carried | carried | dash §2.2.4 |
| PMFE:381 | FE:262 | Loading: skeleton of real geometry, no spinner; after 3 s Connecting… | carried | carried | dash §2.2.4 |
| PMFE:382 | FE:263-264 | Live green dot; Reconnecting amber, content stays, mutations enabled 10 s | carried | carried | dash §2.2.4 |
| PMFE:383 | FE:265 | Offline: > 10 s and `/api/meta` fails; bar (`--bg-raised`, 1 px parked border); Retry; triage disabled with Offline;… | carried | carried | dash §2.2.4, §6 (bar styling lost) |
| PMFE:384 | FE:266 | Read-only: triage replaced by a note; `a/r/p` toast the same copy | carried | carried | dash §2.2.4 |
| PMFE:385 | FE:267 | Review full amber bar with `Open review` | carried | carried | dash §2.2.4 |
| PMFE:386 | FE:268 | Memory pause trigger (critical, or last queue entry `memory_pressure`); copy; `Machine` action; running tile flips | carried-weaker | carried | dashboard §2.2.4 |
| PMFE:387 | FE:269 | Ledger altered: red, not dismissible; Accept disabled everywhere | carried | carried | dash §2.2.4, NEW-dashboard-2 |
| PMFE:388 | FE:271 | One bar at a time; ledger > offline > memory > review full | carried | carried | dash §2.2.4, §6 |
| PMFE:389 | FE:275 | Review goal: decide in under a minute without reading the trajectory | carried | carried | rg §2.1.2 |
| PMFE:390 | FE:280-295 | Review layout at 1440 | carried | carried | dash §2.5.1 |
| PMFE:391 | FE:298-301 | Queue: Ready for review oldest first; Need you (parked, failed after ladder, decisions) longest wait first | carried | carried | dash §2.5.2 |
| PMFE:392 | FE:303 | Row 56 px; title 13/500 one line; meta 11 secondary; selected = 2 px `--text-primary` bar + `--bg-overlay`; wait amber… | carried-weaker | carried | dashboard §2.5.2 |
| PMFE:393 | FE:305 | Evidence column fluid, min 560 | carried | carried | dash §2.5.1 |
| PMFE:394 | FE:307 | Breadcrumb; attempt selector disabled when there is only one attempt | carried-weaker | carried | dashboard §2.5.3 |
| PMFE:395 | FE:308-313 | Title 18/600; outcome line; gates strip; failures by gate; grouped changes; What the Worker tried | carried | carried | dash §2.5.3 |
| PMFE:396 | FE:317 | Done when neutral bullets; with all gates passing: All gates passed. Criteria are checked by the acceptance tests. | carried-weaker | carried | dashboard §2.5.8 |
| PMFE:397 | FE:318-320 | Run facts; Scope; Provenance with Copy | carried | carried | dash §2.5.8 |
| PMFE:398 | FE:322 | Triage bar sticky, 52 px, `--bg-surface`, top hairline | carried | carried | dash §2.5.9 |
| PMFE:399 | FE:324 | Accept enabled only in review, blocking gates passed, triage on, ledger intact; reason inline | carried | carried | dash §2.5.9 (+ permission) |
| PMFE:400 | FE:325-326 | Send back secondary; Park ghost | carried | carried | dash §2.5.9 |
| PMFE:401 | FE:327 | Right-aligned hint `j k` · `Space` · `?` in the triage bar | missing | carried | dashboard §2.5.9 |
| PMFE:402 | FE:328 | Need-you cards: Retry with planner once `POST …/run` exists; until then Send back and Park | carried | carried | dash §2.5.9; later dash §7 |
| PMFE:403 | FE:332 | Accept: Merging…, 3 s grace toast with Undo Z, then POST; success toast with sha + Copy; row leaves, focus next; 40… | carried | carried | dash §2.5.10, §6 |
| PMFE:404 | FE:333-338 | Send back composer: inline; required textarea; quick notes from failures; Suggest as a playbook rule on (informationa… | carried | carried | dash §2.5.11; rg §2.4 (candidate only when actionable) |
| PMFE:405 | FE:339 | Park popover: optional reason, three presets, `↩` confirms | carried | carried | dash §2.5.12 |
| PMFE:406 | FE:340 | Keys `j/k`, `o`/`Enter`, `[ ]`, `f`, `u` | carried | carried | dash §2.3 |
| PMFE:407 | FE:344-346 | Data: board `display` + `enteredColumnAt`; evidence; attempts endpoint | carried | carried | dash §2.15.2; rt routes |
| PMFE:408 | FE:352 | Loading evidence: 4 gate boxes + 3 diff-line skeletons; queue interactive | carried | carried | dash §2.5.13 |
| PMFE:409 | FE:353 | Empty queue: 24 px glyph in `--text-muted`, copy, Ready count, right rail hidden | carried-weaker | carried | dashboard §2.5.13 |
| PMFE:410 | FE:354-357 | No evidence (only Park); inline error with retry; state-change notice with Reload; offline/read-only | carried | carried | dash §2.5.13 |
| PMFE:411 | FE:359 | 1024: Facts disclosure, queue 248; mobile queue full screen, file list tap-to-diff, bottom bar, send back in a sheet | carried | carried | dash §2.5.1, §2.15.3 |
| PMFE:412 | FE:365 | Board topbar: filter chips, `Dependencies` toggle, density toggle | carried-weaker | carried | dashboard §2.4.11 (view bar, density toggle), §2.4.18 (Dependencies view) |
| PMFE:413 | FE:367 | Columns fluid min 200, max 300, gap 8, board padding 16 | carried | carried | dash §2.4.2 (padding 16 lost) |
| PMFE:414 | FE:368 | Empty columns collapse to 36 px rails (after 5 min empty; Done below 1600 px) | contradicted | deliberate | dashboard §9 |
| PMFE:415 | FE:369 | Parked full column far right with amber count; Closed only when non-empty | carried | carried | dash §2.4.1 (On hold; Won't do filter) |
| PMFE:416 | FE:370 | > 6 columns → horizontal windowing; Review and Parked pinned | carried | carried | dash §2.4.2, §2.4.9 |
| PMFE:417 | FE:372 | Column header 36; name · count; WIP `1 / 3` + 2 px bar; secondary/amber/red; derivation tooltip; `⋯` menu (sort, collap… | carried | carried | dash §2.4.3 |
| PMFE:418 | FE:374 | In-column order by `orderKey`; Review and Parked sort by wait time, longest first | carried-weaker | carried | dashboard §2.4.2, P3 |
| PMFE:419 | FE:378 | `h/l` keep the row index clamped; `j/k` | carried | carried | dash §2.3 |
| PMFE:420 | FE:379 | Peek drawer 480 px with triage keys; `Enter` opens card | carried | carried | dash §2.4.6 |
| PMFE:421 | FE:380 | `c` creates once `POST /cards` exists, else a toast with the CLI | gap | gap | dashboard §2.4.7, P3 |
| PMFE:422 | FE:381 | No drag and drop in v1; moves via recorded triage | carried | carried | dash §2.4.5 (within-column reorder now allowed) |
| PMFE:423 | FE:382 | Click selects; `Space` or double-click peeks | carried-weaker | carried | dashboard §2.3 (`Space` or double-click) |
| PMFE:424 | FE:384 | SSE patches only changed tiles; keeps scroll/focus/drawer;… | carried-weaker | carried | dashboard §2.4.8, P3 |
| PMFE:425 | FE:388 | Empty board: No cards yet + `sekhemet plan …` and the fixture seed command | contradicted | deliberate | dashboard §2.4.10, §9 |
| PMFE:426 | FE:389-392 | Empty column copy at top; filter no-match + Clear filter; review full + Holding for review; memory pause | carried | carried | dash §2.4.10 |
| PMFE:427 | FE:394 | 1024: column min 220, horizontal scroll, pins; mobile switcher, tap → Evidence, no create/batch | carried | carried | dash §2.15.3 |
| PMFE:428 | FE:396 | Board data: `display`, `/api/wip` merged, stream; `card/step` for the running status line | carried-weaker | carried | dashboard §2.15.2, §3 |
| PMFE:429 | FE:400-407 | Card view header 96 px: breadcrumb, title+kind, state pill + sentence, triage, `⋯` (Copy id, Open worktree path, View i… | carried | carried | dash §2.6 |
| PMFE:430 | FE:407 | Tabs 32 px with a 2 px `--accent` underline on the active tab | carried-weaker | deliberate | dashboard §2.6, §9 (underline in --text-primary; gold kept to four places) |
| PMFE:431 | FE:409-420 | Evidence tab; Plan tab (spec, criteria, scope, three budgets, difficulty meter + routing, waits/unblocks, rationale, re… | carried | carried | dash §2.6 |
| PMFE:432 | FE:420 | Persist the Planner's repair plan into evidence or the ledger | carried-weaker | gap | worker-loop rule 34.3, NEW-worker-loop-5 (WL-N5-5: the re-plan recorded as `card/repair_plan`, kernel rule 20 / §3); dashboard §2.6 reads it |
| PMFE:433 | FE:422-429 | Steps tab: tool calls with observation summaries, gate results, tokens/time right-aligned, loop annotation, stop row, l… | carried | carried | dash §2.6 |
| PMFE:434 | FE:433-437 | Thread tab (quotes for notes); Files tab; no-data tab states | carried | carried | dash §2.6 |
| PMFE:435 | FE:443 | Runs list 240 px (date, time, model, `3/6`, duration) | carried | carried | dash §2.11 (width lost) |
| PMFE:436 | FE:445-450 | Headline blocks: Passed first try, Passed after retry, Total time, Tokens; deltas vs previous run | carried-weaker | carried | dashboard §2.11 |
| PMFE:437 | FE:451 | Timeline: segments proportional to duration, filled by outcome, labelled by short id | carried-weaker | carried | dashboard §2.11 |
| PMFE:438 | FE:452 | Cards table columns (title, attempt, result, why stopped, steps, time, tokens, accepted sha), sortable | carried-weaker | carried | dashboard §2.11 |
| PMFE:439 | FE:453-454 | Stops by reason, each linked; run settings | carried | carried | dash §2.11 |
| PMFE:440 | FE:456 | `writeQueueReport` also writes `.sekhemet/runs/<startedAt>.json` | carried-weaker | gap | runtime rule 34b, NEW-runtime-9 (RUN-56: `queue/reported` event; the files are derived caches) |
| PMFE:441 | FE:459 | No runs yet + `sekhemet queue --auto-accept` | carried | carried | Superseded: Runs is hidden until the first run (dash §2.2.1) |
| PMFE:442 | FE:460 | Run in progress: Running · 2 of 6 cards · 4m; timeline grows live | carried | carried | dash §2.11 ("grows live"; copy lost) |
| PMFE:443 | FE:464 | Ledger columns seq, time, actor, type, hash (8 chars); prev-hash tooltip | carried | carried | dash §2.11 |
| PMFE:444 | FE:466-469 | Filters card/actor/type; `Enter` detail with payload, payload hash, hash, prev; integrity header with verified time; fi… | carried | carried | dash §2.11 |
| PMFE:445 | FE:475 | Memory gauge: used/total GB, level Normal/Warning/Critical, swap in use, 85/90/94% ticks, a sentence each | carried-weaker | carried | dashboard §2.11 |
| PMFE:446 | FE:476 | Model: worker id, resident, endpoint, keep-alive; tokens/s sparklines later | carried-weaker | carried | dashboard §2.11 |
| PMFE:447 | FE:477-479 | Health checks with icon, name, plain detail, fix hint; sandbox mode; worktrees | carried | carried | dash §2.11 |
| PMFE:448 | FE:480 | Re-run checks bypasses the 15 s cache with `?fresh=1` | carried-weaker | carried | dashboard §2.11 |
| PMFE:449 | FE:482 | `GET /api/machine` shape; pushed on SSE as `event: machine` every 5 s | carried-weaker | carried | dashboard §2.11, §3 |
| PMFE:450 | FE:658 (+FE:396, 431, 8… | `card/step` ledger event per turn `{ id, turn, calls, gate?, usage }` from `card_runner` `onProgress`; drives the runni… | carried-weaker | carried | dashboard §3; kernel §3 |
| PMFE:451 | FE:657 | Transcript endpoint shape `{ attempt, file, steps: [...] }` | carried-weaker | carried | dashboard §3 |
| PMFE:452 | FE:471, 659 | `GET /api/events?since=&card=&limit=&order=desc` → `{ events, verification, nextCursor }`, paged newest first | carried-weaker | carried | runtime 25a; dashboard §3 |
| PMFE:453 | FE:486 | Playbook rules table: instruction (2-line clamp), trigger gate, teaching card, since, pattern | carried | carried | Superseded by the learning view (dash §2.11); fields in context §24 |
| PMFE:454 | FE:487 | Suggested rules with Promote (editor, pick trigger gate) and Dismiss | carried | carried | dash §2.11 (*Needs your approval*: Approve, Edit, Retire) |
| PMFE:455 | FE:488 | Empty Playbook copy | carried | carried | Superseded: Playbook hidden until the first rule (dash §2.2.1) |
| PMFE:456 | FE:490, 661 | `GET /api/playbook` shape `{ rules, candidates }` | carried-weaker | carried | dashboard §3 |
| PMFE:457 | FE:494 | Inbox: nav hidden until the endpoint exists; never a dead link | carried | carried | dash §2.2.1 |
| PMFE:458 | FE:500 | Tile compact: 264 px wide, 8/12 padding, 4 px gap | carried-weaker | carried | dashboard §2.4.4; width follows fluid columns §2.4.2 |
| PMFE:459 | FE:504 | Row 1 kind tag · short id | contradicted | deliberate | dashboard §9 |
| PMFE:460 | FE:505-508 | Title 13/500 2-line clamp; pips + status line; budget bar only when started | carried | carried | dash §2.4.4 |
| PMFE:461 | FE:512 | The status line is the card's current truth, derived per state | carried | carried | dash §2.4.4 |
| PMFE:462 | FE:516 | Ready: Ready · 32-step budget | contradicted | deliberate | dashboard P3, §9 |
| PMFE:463 | FE:517 | Blocked: link icon in `--state-blocked`, Waits on X, title in `--text-secondary` | contradicted | deliberate | dashboard §2.4.4, §9; R11 |
| PMFE:464 | FE:518 | Planning: pencil, Planner is writing the plan | carried | carried | dash §2.4.1 (*Being planned*) |
| PMFE:465 | FE:519 | Working: pulsing lapis dot, step line, 2 px running rule, lapis budget | carried | carried | dash §2.4.4, §2.13.3, §2.13.5 |
| PMFE:466 | FE:520-521 | Checking: running pip ring; Failed-will-retry: red pips, rung line, fail rule | carried | carried | dash §2.4.1, §2.13.3 |
| PMFE:467 | FE:522-524 | Review waiting (amber after 2 h); Parked (pause, amber, rule); Done (check-circle, secondary, no bars, sha + age) | carried | carried | dash §2.4.1, §2.4.4 |
| PMFE:468 | FE:526 | Gate pips: 12×12 per configured gate in order; glyphs; glyph on fill; not-run 1 px outline; no letters; popover | carried | carried | dash §2.4.4; `--on-state` in tokens.ts |
| PMFE:469 | FE:527 | Budget bar 2 px; secondary/lapis/amber ≥ 75%/red 100%; tokens and seconds as a second line in comfortable density | carried | carried | dash §2.4.4 |
| PMFE:470 | FE:528 | Dependency badge: link icon + count, tooltip lists titles | carried | carried | Replaced by the blocker flag with cause (dash §2.4.4, P3) |
| PMFE:471 | FE:529 | Difficulty diamond on the tile in comfortable density | contradicted | deliberate | dashboard §9 |
| PMFE:472 | FE:531-536 | Tile states (hover, focus ring offset −1, selected border + checkbox, both); heights 88/112 | carried | carried | dash §2.4.4 |
| PMFE:473 | FE:540 | Column header variants incl. at-capacity tooltip Full. The Worker holds finished cards until you clear one. | carried-weaker | carried | dashboard §2.4.3 |
| PMFE:474 | FE:544 | Gates segment `[icon] Name duration`, 32 px, hairlines, `--bg-surface`; failed = 2 px fail top rule + count | carried | carried | dash §2.5.4 |
| PMFE:475 | FE:546 | Popover (max 420 px): id and command, exit code, first 3 typed failures, Show all | carried | carried | dash §2.5.4 (420 lost) |
| PMFE:476 | FE:547 | Click on a passed gate opens its raw log once stored; until then No output recorded for passed gates. | carried-weaker | carried | dashboard §2.5.4 |
| PMFE:477 | FE:548-549 | Order + derived Size; skipped with reason; empty-contract amber segment + tooltip | carried | carried | dash §2.5.4 |
| PMFE:478 | FE:555-561 | Failure block: header, excerpt, Expected/Actual, repro + copy, Suggested, protected-file warning, fail rule, grouping | carried | carried | dash §2.5.5 |
| PMFE:479 | FE:565 | Diff groups incl. Other; identical-to-`acceptance/<name>` note | carried | carried | dash §2.5.6 |
| PMFE:480 | FE:566-571 | Sticky 32 px file header; 40 px gutters (muted allowed); tints; hunk headers secondary on raised; sign kept | carried | carried | dash §2.5.6 |
| PMFE:481 | FE:572 | Annotation rows: 2 px fail rule, gate icon, message; `role="note"`, focusable; `n/N` | carried-weaker | carried | dashboard §2.5.6 |
| PMFE:482 | FE:573-574 | Unified/split `u`; whitespace toggle; > 400 lines collapse; lockfiles/generated collapsed | carried | carried | dash §2.5.6 |
| PMFE:483 | FE:580-584 | Button variants: primary (accent / `--on-accent`), secondary (raised, primary, border-subtle), ghost | carried-weaker | carried | dashboard §2.13.7 |
| PMFE:484 | FE:586 | Buttons 32 px high, 4 px radius, 12 px padding, `kbd` hint inside, 11 px mono | carried-weaker | carried | dashboard §2.13.7 |
| PMFE:485 | FE:586 | Disabled = 40% opacity; reason in adjacent text, never only a tooltip | contradicted | deliberate | dashboard §2.13.2, §9 |
| PMFE:486 | FE:592-597 | Decision request: question 15/600 + category; options with consequence, effort, risk, Preview; Recommended (neutral) +… | carried | carried | dash §2.5.14; ppm §2.10 |
| PMFE:487 | FE:601 | Scorecard block: label 11 secondary, value 22/600 tabular, delta 11 in state colour + arrow icon | carried-weaker | carried | dashboard §2.11 |
| PMFE:488 | FE:605-607 | Machine components: 6 px gauge with ticks; check row sizes; sparkline 120×24 (later) | carried-weaker | carried | dashboard §2.11, §2.13.7 |
| PMFE:489 | FE:611-617 | Palette: 600 px at 12vh, raised + strong border, `--scrim`; 48 px/15 px input; groups; fuzzy highlight; shortcuts; `>`/… | carried | carried | dash §2.15.4, §2.3 |
| PMFE:490 | FE:621-625 | Toasts: bottom-left 16 px, max 3, 360 px, overlay + strong border, icon, one line, action; 4 s / errors stay;… | carried-weaker | carried | dashboard §2.13.7 |
| PMFE:491 | FE:629-631 | Cheat sheet: 720 px modal, four columns; dimmed inapplicable keys; reachable from the sidebar footer | carried | carried | dash §2.3.3, §2.2.1 (Keys) |
| PMFE:492 | FE:635-643 | Key additions: `g q`, `g l`, `g p`, `1–5`, `[ ]`, `u`, `n/N`, `f`, `t` theme, `z`, `/` | contradicted | deliberate | dashboard §2.3, §9 |
| PMFE:493 | FE:645 | Keys ignored in text fields except `Esc` and `⌘↩` | carried | carried | dash §2.3.4 |
| PMFE:494 | FE:653 | `card.display` shape (title, kinds enum, shortId, stateLabel, statusLine, tone enum, stopLabel, enteredColumnAt, waitsO… | carried-weaker | carried | dashboard §2.15.2, §3 |
| PMFE:495 | FE:654 | `GET /api/gates` → `{ gates[], protected, maxFiles, maxDiffLines, sha256, empty }` | carried-weaker | carried | dashboard §3 |
| PMFE:496 | FE:655-656 | `GET /api/cards/:id` with attempts; `evidence?attempt=` | carried | carried | dash §3; rt §3 |
| PMFE:497 | FE:660 | `GET /api/runs[/:id]` | carried | carried | rt §3 |
| PMFE:498 | FE:663 | `/api/meta` adds `project, repoPath, triage, reviewMinutesPerDay, version, gitUser` | carried-weaker | carried | dashboard §3 |
| PMFE:499 | FE:664 | `POST /api/cards/:id/run` returns `{ attemptId }` | carried | carried | rt RUN-4 (response returns the log path) |
| PMFE:500 | FE:665 | `GET /api/decisions`, answer endpoint | carried | carried | rt §3; ppm §2.10 |
| PMFE:501 | FE:667-676 | Vocabulary functions in `vocabulary.ts`; server calls them; `/vocab.json`; browser never re-derives a label | gap | gap | dashboard §2.12.1, NEW-dashboard-2 |
| PMFE:502 | FE:684-692 | Token additions `--on-accent`, `--on-state`, `--scrim`, tints (12% / 10%), `--sidebar-w`/`--rail-w`/`--topbar-h` | carried | carried | dash §2.13.1; tokens.ts defines every one |
| PMFE:503 | FE:694 | Fonts: system fallback must look right; WOFF2 bundling optional | later | later | dashboard §7 |
| PMFE:504 | FE:698-710 | Type usage table | carried | carried | dash §2.13.4 (wordmark tracking −0.01em and the `kbd` style lost) |
| PMFE:505 | FE:714-727 | Spacing per component (sidebar item padding/gaps/footer, topbar 16/12, column body 8, evidence 24 gap / 8 heading, fail… | carried-weaker | carried | dashboard §2.13.7 and inline |
| PMFE:506 | FE:729-763 | Icon set (names and drawings) | carried | carried | `packages/ui/src/icons.ts` defines every one |
| PMFE:507 | FE:765 | No filled icons, duotone, emoji, Unicode ✓ ✗ | carried | carried | dash §2.13.6 |
| PMFE:508 | FE:767-776 | Colour application per tone | carried | carried | dash §2.13.3 |
| PMFE:509 | FE:780-783 | Motion rules | carried | carried | dash §2.13.5, §6 |
| PMFE:510 | FE:787 | Focus: 2 px accent outline, offset 1, `:focus-visible`; replaces `--border-strong` which fails | carried | carried | dash §2.14.5 |
| PMFE:511 | FE:788-789 | Selection: overlay + strong border, or a 2 px `--text-primary` left bar in lists; focus and selection distinct | carried-weaker | carried | dashboard §2.4.4, §2.4.15 |
| PMFE:512 | FE:793-797 | Brand: pylon glyph path, wordmark, favicon 32 px on 6 px rounded bg-base; no tagline, mascot, lion | carried | carried | dash §2.13.6 |
| PMFE:513 | FE:801-805 | Contrast rules (secondary ≥ 5.3, muted decorative, state text only on base/surface, state icons ≥ 3:1) + unit test | gap | gap | dashboard §2.14.1, P12 |
| PMFE:514 | FE:806-813 | Colour never alone; landmarks; board listbox roles; gates strip list; tabs; modal dialogs; one live region; Review focu… | carried | carried | dash §2.14.3–4 |
| PMFE:515 | FE:814-815 | Targets 24×24 / 44×44; 200% zoom | gap | gap | dashboard §2.14.5, P12 |
| PMFE:516 | FE:823 | Static build-free ES modules under `/app/`; no framework/CDN; air-gapped; React/TanStack rejected; own virtualization | carried | carried | dash §2.15.1, §9 resolved drift |
| PMFE:517 | FE:825-831 | Verification recipe: seed, serve, three viewports, both themes, compare mockups, keyboard only, empty error console | carried | carried | dash §2.15.5 (viewports now 1440×900, 1100×800, 400×812) |
| PMFE:518 | FE:837 | Vocabulary covers every `ExecutionStopReason` and fixture suffix; an unknown reason falls back to the humanised enum | carried-weaker | carried | dashboard §2.12.1, NEW-dashboard-2 |
| PMFE:519 | FE:838 | Contrast test thresholds (secondary ≥ 4.5 all surfaces; state ≥ 4.5 on base/surface, ≥ 3 on raised; accent ≥ 3; on-acce… | gap | gap | dashboard §2.14.1, P12 |
| PMFE:520 | FE:839 | Icon test: 24 viewBox, 1.5 stroke, no fill except `dot` | carried | carried | dash §2.13.6; `icons.spec.ts` |
| PMFE:521 | FE:840 | Static serving: `..` refused (path traversal), correct MIME types, every served `.js` passes `node --check`,… | missing | carried | runtime rule 23a, RUN-49 (traversal refused, MIME types; built); dashboard §2.15.2 (/vocab.json), §4 (syntax checks) |
| PMFE:522 | FE:841 | Shell page about 60 lines | carried | carried | dash §2.15.1 ("a small shell") |
| PMFE:523 | FE:847 | Board enrichment: gate list from evidence rung results in execution order, no synthetic `parse`; hasher example values | carried-weaker | carried | dashboard §2.4.4; gates rule 35 (no synthetic parse) |
| PMFE:524 | FE:848 | Killing the server: Reconnecting, then Offline within 10 s, actions disabled | carried | carried | dash §6 |
| PMFE:525 | FE:849 | No uppercase text on screen; pips have `aria-label`s | carried | carried | dash §2.1.4, §2.14.3 |
| PMFE:526 | FE:850 | Parking via curl appears in Parked within 1 s with scroll preserved; 500 cards, no task > 50 ms | carried-weaker | carried | dashboard §2.4.8, §6 |
| PMFE:527 | FE:851-853 | Keys work with the mouse unplugged; peek `Esc` returns focus to the tile; palette ranking and `>acc` | carried | carried | dash §2.1.3, §2.3; palette §2.15.4 |
| PMFE:528 | FE:859 | `/api/gates` returns gates in order; `empty: true` for `e3b0c442…` | carried-weaker | gap | gates §3 (/api/gates empty), T1 (GT-T1-10) |
| PMFE:529 | FE:862-863 | Diff parser test; triage acceptance (A merges, empty R blocks, note → candidate, Z within 3 s sends nothing) | carried | carried | dash §6; rg §2.4 |
| PMFE:530 | FE:870-871 | Transcript returns 8 steps with `stopReason`; one `card/step` per turn, chain valid | carried-weaker | carried | dashboard §3 (transcript, card/step) |
| PMFE:531 | FE:873-876 | Card view acceptance (Enter opens evidence tab, 1–5, live steps, return note as a quote, running tile) | carried | carried | dash §2.6, §2.4.4 |
| PMFE:532 | FE:881-886 | Runs history rows; Ledger tamper disables Accept; memory level at 0.85; Playbook view | carried | carried | dash §2.11, NEW-dashboard-2; models (classifyMemoryPressure) |
| PMFE:533 | FE:890 | Later: Inbox and decision requests | carried | carried | Built, in Review › Needs you (dash §2.5.2, §2.5.14) |
| PMFE:534 | FE:891 | Later: `POST /cards/:id/run` (Retry with planner) | later | later | dashboard §7 |
| PMFE:535 | FE:892 | Later: promoting playbook candidates | carried | carried | Approve in Playbook (dash §2.11) |
| PMFE:536 | FE:893 | Later: mobile triage polish | carried | carried | dash §2.15.3 |
| PMFE:537 | FE:894 | Later: dependency lines overlay | later | later | dashboard §7 |
| PMFE:538 | FE:895 | Later: bundled fonts | later | later | dashboard §7 |
| PMFE:539 | FE:896 | Later: sparklines | later | carried | dashboard §2.11, §6 (built) |
| PMFE:540 | FE:897 | Later: master board, Registry, Goals | later | later | dashboard §7; Registry built |
| PMFE:541 | FE:898 | Later: difftastic intent grouping | later | later | dashboard §7 |
| PMFE:542 | FE:900-901 | Planner stores `slice` on the card; fixture titles drop `(SPIDR: …)` | carried | carried | ppm P1 (kind from labels; five parsers fixed) |
| PMFE:543 | FE:902 | `gatesConfigSha256` must hash the real `gates.toml` | carried-weaker | gap | gates T1 (GT-T1-13) |
| PMFE:544 | FE:903 | `suggestedFixFiles` must not point at protected tests | carried | carried | gates §7, GT-3 |
| PMFE:545 | FE:904 | `bounds` must exclude staged acceptance tests | missing | carried | gates rule 12, GT-11 |
| PMFE:546 | FE:905 | `COLUMN_ORDER` should include planning and parked | carried | carried | canvas.ts cut (DEC-09) |

### 5.5 The three `FEATURE_INVENTORY` files

**Kernel (FI K rows; R2 status)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:K1 | FI:45 / R2:71 | SHA-256 hash-chained append-only log, genesis, immutable | carried | carried | kernel §2.7-8, §4 built — R2 BUILT, agree |
| INV:K2 | FI:46 / R2:72 | Verification names first broken seq | carried | carried | kernel §2.9, K-1; runtime §2.29, RUN-32 — agree (adds incremental verify, NEW-kernel-1) |
| INV:K3 | FI:47 / R2:73 | Separate `payload_hash`, canonical JSON | carried | carried | kernel §2.8 — agree |
| INV:K4 | FI:48 / R2:74 | Typed card/attempt/step columns + indexes | carried-weaker | carried | kernel rule 7 |
| INV:K5 | FI:49 / R2:75 | Actor enum CHECK | carried | carried | kernel §2.16 (`EVENT_ACTORS`, CHECK + append; 13 actors; principal separate, NEW-kernel-2) — agree |
| INV:K6 | FI:50 / R2:76 | `subscribe(filter, cb)` | carried-weaker | carried | kernel rule 18 |
| INV:K7 | FI:51 / R2:77 | `getRange(since, limit)` | carried-weaker | carried | kernel rule 18; runtime 25a |
| INV:K8 | FI:52 / R2:78 | Projection rebuild, byte-identical | carried | carried | kernel §2.13, K-2, §4 built — agree |
| INV:K9 | FI:53 / R2:79 | Service container | later | deliberate | extensibility rule 29, §8 Q2 (container is reachable; trust-gated until the owner decides the cut, O4) |
| INV:K10 | FI:54 / R2:80 | Reversible plugin manager | later | later | extensibility §7 (plugin API); cut pending O4 |
| INV:K11 | FI:55 / R2:81 | Model-visible means logged, runtime assertion | carried-weaker | carried | kernel rule 17, §4 (built), K-9 |
| INV:K12 | FI:56 / R2:82 | 10-event waterfall hooks (observe, block, inject), outside sandbox | carried | carried | extensibility §2.3-6, §4 built — R2 SHALLOW; **DISAGREE**, code emits `playbook/propose` (`learning/store.ts:190`): spec right |
| INV:K13 | FI:57 / R2:83 | 4-level hierarchy cap | carried | carried | kernel §2.1, K-3 (`MAX_CARD_DEPTH = 2`) built — agree |
| INV:K14 | FI:58 / R2:84 | `projects` table | carried | carried | kernel §2.2, §2.6 `ProjectRecord`; built — agree |
| INV:K15 | FI:59 / R2:85 | Dependencies DAG, cycle refusal, eligibility | carried | carried | kernel §2.3, §4 built — agree |
| INV:K16 | FI:60 / R2:86 | `attempts` table incl. `rung`, `tool_arm` | carried-weaker | carried | kernel rule 6, §4 |
| INV:K17 | FI:61 / R2:87 | `steps` table incl. `repo_state_hash`, `success`, `tokens_condensed` | carried-weaker | deliberate | kernel rule 6 (not stored, with the reason) |
| INV:K18 | FI:62 / R2:88 | `gate_results` table | carried | carried | kernel §2.6, §2.13 — agree |
| INV:K19 | FI:63 / R2:89 | `evidence_bundles` table fields | carried-weaker | gap | gates rule 35, T1 |
| INV:K20 | FI:64 / R2:90 | `decision_requests` table | carried | carried | kernel §2.6; planner §2.10, §4 built — agree |
| INV:K21 | FI:65 / R2:91 | Competence entries driving budgets/routes | carried | carried | models §2.32, §4 partial (NEW-models-6: prediction/decision/outcome) — spec-stricter |
| INV:K22 | FI:66 / R2:92 | Full card record shape | carried | carried | kernel §2.6 types; planner §2.1.5; PM_CONTRACT §2 — agree |
| INV:K23 | FI:67 / R2:93 | `busy_timeout = 5000` (with a test) | carried | carried | kernel §2.27, tests `pragmas.spec.ts` — R2 SHALLOW; code test exists (`pragmas.spec.ts:34`), R2 stale |
| INV:K24 | FI:68 / R2:94 | Column enum incl. Planning | carried | carried | kernel §2.17 nine states, §4 built — agree |
| INV:K25 | FI:69 / R2:95 | Difficulty 1..10 | carried | carried | planner §2.4; K-S7-1 (difficulty 11 refused) — agree |
| INV:K26 | FI:70 / R2:96 | Packs/evidence under `.sekhemet/` by hash | carried | carried | kernel §2.15; §4 "ledger only durable channel" partial S7 — agree |
| INV:K27 | FI:71 / R2:97 | 30-day retention | carried | carried | runtime §2.33, NEW-runtime-4 partial — R2 BUILT, spec-stricter |
| INV:K28 | FI:72 / R2:98 | Checkpoint DB record with attribution | carried-weaker | carried | review-git rule 3 (checkpoint database record with attribution), §4 built |

**Sandbox (S)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:S1 | FI:82 / R2:104 | Seatbelt profile, writes only to worktree/tmp | carried | carried | security §2.9-13, §4 built — agree |
| INV:S2 | FI:83 / R2:105 | Commands run under `sandbox-exec` | carried | carried | security §2.13 — agree |
| INV:S3 | FI:84 / R2:106 | Linux namespaces + Landlock + seccomp | later | deliberate | DEC-21; security rule 17 |
| INV:S4 | FI:85 / R2:107 | Fail closed when confinement missing | carried | carried | security §2.7, §4 not-built S3b — R2 BUILT; **DISAGREE** (see table: gates opt out) |
| INV:S5 | FI:86 / R2:108 | Network denied; allowlist proxy; request log with payload hash | carried | carried | security §2.28-33; proxy built, hardening S3 — spec-stricter |
| INV:S6 | FI:87 / R2:109 | Timeout SIGTERM → 500 ms → SIGKILL | carried | carried | runtime §2.7, §4 built — agree |
| INV:S7 | FI:88 / R2:110 | Buffer cap / OOM detection | carried-weaker | carried | runtime rules 8, 8a |
| INV:S8 | FI:89 / R2:111 | Allow/Ask/Deny, Deny wins, protected paths incl. loop/gates/sandbox | carried | carried | security §2.25-27, §4 built — agree (Ask approval path: Needs attention 45) |
| INV:S9 | FI:90 / R2:112 | `<untrusted_content>` tagging, stricter step policy | carried | carried | security §2.42, SEC-40, §4 built — agree |
| INV:S10 | FI:91 / R2:113 | Supply chain: existence, age, download profile, Levenshtein | carried-weaker | carried | security rule 44, SEC-41, SEC-43a (age 30 days, distance 2/1, own registry; download profile advisory with the reason) |
| INV:S11 | FI:92 / R2:114 | `osv-scanner` offline | carried | carried | security §2.44 — agree |
| INV:S12 | FI:93 / R2:115 | Restricted mode | carried | carried | security §2.43, worker-loop §2.13, §4 partial S3a — R2 BUILT, spec-stricter |
| INV:S13 | FI:94 / R2:116 | Worktree manager (create/cleanup) | carried | carried | security §2.24a; review-git §2.6.2 built — agree |
| INV:S14 | FI:95 / R2:117 | CoW worktrees + linked deps | later | later | review-git §7 (copy-on-write); DEC-21; linked deps security rule 24 |
| INV:S15 | FI:96 / R2:118 | Per-card env allowlist | carried | carried | security §2.6, §4 built — agree |

**Sync and git (Y)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:Y1 | FI:106 / R2:124 | Branch `sekhemet/<project>/<card-id>-<slug>` from parent branch | carried | carried | review-git §2.6.2, §4 built — agree |
| INV:Y2 | FI:107 / R2:125 | Checkpoint commit trailers; `refs/sekhemet/checkpoints/<card-id>` | carried | carried | review-git §2.6.3, §2.5.5, §4 built — agree |
| INV:Y3 | FI:108 / R2:126 | Commit after every gate-passing step and every masking boundary | contradicted | deliberate | review-git rule 3, §9 (R1) |
| INV:Y4 | FI:109 / R2:127 | Squash into intent-grouped Conventional Commits | carried | carried | review-git §2.5.4; real trailers S5 — agree |
| INV:Y5 | FI:110 / R2:128 | Injection-safe git | carried | carried | security §2.18-20 (absolute path, pinned env, hardened config) — agree |
| INV:Y6 | FI:111 / R2:129 | Rebase before Verify; typed conflicts; out-of-scope parks | carried-weaker | gap | review-git §4 corrected, NEW-review-git-1 |
| INV:Y7 | FI:112 / R2:130 | Stacked branches; accept restacks and re-runs gates | carried-weaker | gap | review-git §4 corrected, NEW-review-git-2 |
| INV:Y8 | FI:113 / R2:131 | difftastic structural diff | carried | carried | review-git §2.6.6 partial S5; gates §7 (in bundle later) — spec-stricter |
| INV:Y9 | FI:114 / R2:132 | Head sha, diff generation | carried | carried | implied by review-git §2.2 (repo-state hash) and gates §2.35 (diff) — agree |
| INV:Y10 | FI:115 / R2:133 | `SyncAdapter` pull/push/update/capabilities; conflict rule | carried | carried | integrations §2.7 (three-way merge, not LWW), §4 partial P9 — spec-stricter |
| INV:Y11 | FI:116 / R2:134 | Forgejo adapter | carried-weaker | later | integrations §7 (beyond issues) |
| INV:Y12 | FI:117 / R2:135 | GitHub App RS256 JWT, 1-h tokens, keychain, 7 scopes, GHES, no PAT | carried | carried | integrations §2.10, §4 built — agree |
| INV:Y13 | FI:118 / R2:136 | HMAC webhook + 5 triggers | carried-weaker | gap | integrations §2.12, P9 |
| INV:Y14 | FI:119 / R2:137 | Check Runs with annotations | carried | carried | integrations §2.14, §4 built — agree (`raw_details` lost, O90) |
| INV:Y15 | FI:120 / R2:138 | SARIF v2.1.0 gzip then base64 | carried | carried | integrations §2.14 — agree |
| INV:Y16 | FI:121 / R2:139 | PR lifecycle draft→checks→ready→CODEOWNERS→auto-merge, merge queue | carried | carried | integrations §2.15 partial P9; threads Later — agree |
| INV:Y17 | FI:122 / R2:140 | Release cards | later | later | integrations §7 |
| INV:Y18 | FI:123 / R2:141 | CI via `act` | later | later | integrations §7 |
| INV:Y19 | FI:124 / R2:142 | Monorepo per-package gates; cross-repo = two cards | carried-weaker | gap | review-git §2.6.5, NEW-review-git-3 |
| INV:Y20 | FI:125 / R2:143 | Mid-card external-edit reconciliation | contradicted | deliberate | integrations §2.5, §9 (R6) |

**Models (M)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:M1 | FI:135 / R2:149 | HTTP adapter (llama.cpp, MLX, Ollama) | carried | carried | models §2.14, §4 built — agree |
| INV:M2 | FI:136 / R2:150 | Token streaming | missing | carried | models rule 14a, §4 (token streaming built); runtime 25b; dashboard NEW-dashboard-3 (page listener) |
| INV:M3 | FI:137 / R2:151 | `measureThroughput` prefill/decode | carried | carried | models §2.7 (per context length), §2.9 — agree |
| INV:M4 | FI:138 / R2:152 | `healthCheck` | carried-weaker | carried | models rule 14b, §4 (healthCheck built) |
| INV:M5 | FI:139 / R2:153 | Qwen3.8-27B code + planning sampling profile | carried-weaker | carried | models rule 3a (Qwen code and planning profiles, values verbatim) |
| INV:M6 | FI:140 / R2:154 | Per-request reasoning control | carried | carried | worker-loop §2.24-25 (`reasoning.ts`), built — agree |
| INV:M7 | FI:141 / R2:155 | Tolerant tool-call parser (arm B) | carried | carried | models §2.28 — agree |
| INV:M8 | FI:142 / R2:156 | Arm A grammar-constrained decoding | carried | carried | models §2.28 + DEC-22 (per-model measured, never default); NEW-models-5 — agree |
| INV:M9 | FI:143 / R2:157 | Arm C search/replace patches | carried | carried | models §2.28; §4 "tool arm measured" not-built — R2 BUILT (qualify measures); spec-stricter for the Worker |
| INV:M10 | FI:144 / R2:158 | Mock adapter contract | missing | carried | DEFINITION_OF_DONE §2D.2 (scripted adapter); models §4 adapter_contract.spec.ts |
| INV:M11 | FI:145 / R2:159 | Model registry fields | carried | carried | models §2.25, §4 not-built NEW-models-4 — R2 BUILT, spec-stricter |
| INV:M12 | FI:146 / R2:160 | Template SHA-256 pin invalidates qualification | carried | carried | models §2.12, MD-2, built — agree |
| INV:M13 | FI:147 / R2:161 | Hardware calibration procedure | carried | carried | models §2.7 (Metal limit ⅔ ≤36 GB, ¾ above; sweep; one step back) partial NEW-models-1 — agree |
| INV:M14 | FI:148 / R2:162 | Tier profiles S/M/L/XL | carried | carried | models §2.8 table identical, partial — agree |
| INV:M15 | FI:149 / R2:163 | Throughput floors 40/10, 100/20, 300/40; refuse; <16 GB unsupported | carried | carried | models §2.9 identical, §4 not-built — R2 BUILT; **DISAGREE** (code: queue prelude calls it) |
| INV:M16 | FI:150 / R2:164 | 8-bit KV; 4-bit refused for tool calling | carried | carried | models §2.10, MD-1 built — agree |
| INV:M17 | FI:151 / R2:165 | Prompt-cache configuration | contradicted | deliberate | context rule 6; DEC-24 |
| INV:M18 | FI:152 / R2:166 | Cache hit telemetry; < 85% on tool-result steps = defect + alert | carried-weaker | gap | context rule 7, M8 |
| INV:M19 | FI:153 / R2:167 | Speculative decoding / MTP by measurement; draft model | carried-weaker | gap | models rule 13, NEW-models-8 (`-md`), M7/M11 |
| INV:M20 | FI:154 / R2:168 | Memory watchdog 2 s, 85/90/94% actions | carried-weaker | gap | models rule 19 (0.90 stage restored), NEW-models-2 |
| INV:M21 | FI:155 / R2:169 | Model swapping | carried | carried | models §2.17, §2.20; extensibility tools table — agree |
| INV:M22 | FI:156 / R2:170 | Qualification suite, deterministic scoring | carried | carried | models §2.27, §4 built — agree |
| INV:M23 | FI:157 / R2:171 | Per-repo bake-off on history tasks, full settings | carried | carried | models §2.30, §4 partial (settings only) — history gap unowned (Needs attention 64) |
| INV:M24 | FI:158 / R2:172 | Engine selection by measurement incl. cache retention | carried | carried | models §2.14, §2.26 (NEW-models-4) — agree |
| INV:M25 | FI:159 / R2:173 | Declared hours, batched swaps | carried | carried | models §2.20, NEW-models-3; runtime §2.17 — R2 BUILT, spec-stricter |

**Gates (G)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:G1 | FI:169 / R2:179 | `gates.toml` parser and keys | carried-weaker | deliberate | gates §3 (schedule, threshold, languages each dropped or renamed with the reason) |
| INV:G2 | FI:170 / R2:180 | Hash verified on every card start | carried | carried | gates §2.2, GT-1 — agree |
| INV:G3 | FI:171 / R2:181 | Six layers + runs-on hosts | carried-weaker | carried | gates rule 3 (layers with runs-on hosts); per-layer host later §7 |
| INV:G4 | FI:172 / R2:182 | Runner executes declared commands, per-gate timeout | carried | carried | gates §2.8, §2.33, §4 built — agree |
| INV:G5 | FI:173 / R2:183 | Full-layer run, not short-circuit | carried | carried | gates §2.8 (rank once at end), GT-T1-2; §2.33 scoped short-circuit for functional only — agree |
| INV:G6 | FI:174 / R2:184 | In-memory parse gate before write | carried | carried | worker-loop §2.14 (TS/JS; others where a checker exists), DEC-20 — agree |
| INV:G7 | FI:175 / R2:185 | Write path scope→parse→secret→atomic | carried | carried | worker-loop §2.14, WL-3, built — agree |
| INV:G8 | FI:176 / R2:186 | Typed `GateFailure`; top 3 by topological order; no raw logs | carried-weaker | gap | gates rules 19–20, M6 (GT-M6-7 import-graph order) |
| INV:G9 | FI:177 / R2:187 | Parser registry per tool | carried | carried | gates §2.23, §3; pytest/cargo/go M6 — agree |
| INV:G10 | FI:178 / R2:188 | Bounds ≤ 3 files, ≤ 200 lines | carried | carried | gates §2.12, GT-2 — agree |
| INV:G11 | FI:179 / R2:189 | Evidence bundle shape | carried-weaker | gap | gates rule 35, T1 (GT-T1-8, -9) |
| INV:G12 | FI:180 / R2:190 | Acceptance tests first; red before work; protected | carried | carried | gates §2.5-7, P1; §4 fixtures built, every card not-built — spec-stricter |
| INV:G13 | FI:181 / R2:191 | Diff-scoped mutation, advisory then blocking, never 100% | carried | carried | gates §2.32, §4 built; tools replaced by own step (PROVENANCE); non-TS "reported" (MS-M10-3) — agree |
| INV:G14 | FI:182 / R2:192 | Secret scan (gitleaks) | carried | carried | gates §2.3, §2.15; worker-loop §2.14 — agree |
| INV:G15 | FI:183 / R2:193 | Dependency existence/typosquat gate | carried-weaker | carried | security rule 44 |
| INV:G16 | FI:184 / R2:194 | Semgrep CE community rules | carried-weaker | gap | gates §4, NEW-gates-5 (GT-N5-4 bundled offline rules) |
| INV:G17 | FI:185 / R2:195 | Visual: console, rejections, HTTP ≥ 400 | carried | carried | gates §2.29, §4 built — agree |
| INV:G18 | FI:186 / R2:196 | Visual: overlap, zero size, off-screen, overflow | carried-weaker | gap | gates §4 corrected (overlap not built), NEW-gates-4 (GT-N4-4) |
| INV:G19 | FI:187 / R2:197 | Screenshot diff 0.01, masked, animations off | carried-weaker | gap | gates §4 corrected, NEW-gates-4 (GT-N4-5) |
| INV:G20 | FI:188 / R2:198 | axe-core at 1280 / 375, zero critical | carried | carried | gates §2.29, OQ1 (in-house subset; axe proposal) — agree |
| INV:G21 | FI:189 / R2:199 | Vision checklist fail-only; human-approved baselines | gap | gap | gates rules 30–31, NEW-gates-4 |
| INV:G22 | FI:190 / R2:200 | Hygiene: changelog, debug output, trailers | carried | carried | gates §2.3, §2.17, §2.27; NEW-gates-2 (changelog in scope) — agree |
| INV:G23 | FI:191 / R2:201 | Regression protection on re-entering Review → Planning | carried-weaker | gap | kernel rule 31, NEW-kernel-5 |
| INV:G24 | FI:192 / R2:202 | Gate host separation over mTLS | carried | carried | gates §2.11, §4 built; T1 built-ins on host — agree |
| INV:G25 | FI:193 / R2:203 | Pass@k with gate selection | carried-weaker | carried | worker-loop rule 37; parallel §7 |
| INV:G26 | FI:194 / R2:204 | Cross-validation of attempts | carried | carried | worker-loop §2.38, WL-9 — agree |
| INV:G27 | FI:195 / R2:205 | Gate templates by language | carried-weaker | gap | gates rule 23a, NEW-gates-5 |

**Context (C)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:C1 | FI:207 / R2:211 | Repo map, PageRank, budget fit, cache | carried-weaker | gap | context rule 13, NEW-context-5 |
| INV:C2 | FI:208 / R2:212 | Headless LSP client pool | contradicted | carried | worker-loop rule 12, §4 (built) |
| INV:C3 | FI:209 / R2:213 | SWE-Pruner line pruning | later | later | context §7; DEC-21 |
| INV:C4 | FI:210 / R2:214 | Four zones, byte-stable prefix | carried | carried | context §2.8-10, §4 partial M8 — R2 BUILT; DISAGREE (spec newer) |
| INV:C5 | FI:211 / R2:215 | System < 1,000 tokens, tools < 2,000 | carried | deliberate | context rule 10; DEC-27 (≤ 700 / ≤ 1,700 tokens) |
| INV:C6 | FI:212 / R2:216 | Masking with ~15-token pointers + EvidenceRef | contradicted | deliberate | context rule 3; DEC-24 |
| INV:C7 | FI:213 / R2:217 | Pressure 70/80/85/90, stop at 95% | carried | carried | context §2.12, CX-2, built (dormant) — agree |
| INV:C8 | FI:214 / R2:218 | RTK four strategies, lossless | carried | carried | context §2.17, CX-3, built — agree |
| INV:C9 | FI:215 / R2:219 | Agent Skills registry, progressive disclosure | carried | carried | extensibility §2.10-14, partial NEW-extensibility-4 — agree |
| INV:C10 | FI:216 / R2:220 | Skill trust: pin, audit, diff, reject protected-touching | carried | carried | extensibility §2.15, §2.17, EXT-27; partial S9 — agree |
| INV:C11 | FI:217 / R2:221 | Playbook: delta, card boundary, retire | carried | carried | context §2.24, §4 built — agree |
| INV:C12 | FI:218 / R2:222 | Context-debt audit > 300 tokens / ≥ +3% | carried | carried | measurement §2.24, MS-N2-2 partial — agree |
| INV:C13 | FI:219 / R2:223 | Exemplar store top-2, same class, this repo | carried | carried | context §2.25; M1 (diff hunks, structural filter) — spec-stricter |
| INV:C14 | FI:220 / R2:224 | Context pack assembly | carried | carried | context §2.1-15, contract `buildWorkerPrompt` — agree |
| INV:C15 | FI:221 / R2:225 | Byte-identical prompt for identical inputs | carried | carried | context §2.1, CX-1 built — agree |
| INV:C16 | FI:222 / R2:226 | Subtask branch-and-return | carried | carried | context §2.18, CX-4 built — agree |
| INV:C17 | FI:223 / R2:227 | Fresh context on rung change | carried | carried | context §2.19; worker-loop §2.34, M1 partial — spec-stricter |
| INV:C18 | FI:224 / R2:228 | Reasoning traces stripped between steps | contradicted | deliberate | context rule 4; DEC-24 |
| INV:C19 | FI:225 / R2:229 | Dynamic tool loading via `tool_search` | carried | carried | worker-loop §2.11, M2 A/B; context OQ2 — R2 SHALLOW; DISAGREE, code sets `progressiveTools: true` (`execute.ts:476`): spec right |
| INV:C20 | FI:226 / R2:230 | Per-step and per-card context metrics | carried-weaker | carried | context rule 29 |
| INV:C21 | FI:227 / R2:231 | Joint versioning invalidates qualification | carried-weaker | gap | context §4 (corrected), NEW-context-6 |
| INV:C22 | FI:228 / R2:232 | AGENTS.md / CLAUDE.md in Zone 2 | carried | carried | context §2.8 (project conventions) — agree |

**Loop (L)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:L1 | FI:240 / R2:238 | Turn driver | carried | carried | worker-loop §2.5, §4 built — agree |
| INV:L2 | FI:241 / R2:239 | Prompt from the pack | carried | carried | context §2.8; worker-loop §2.5 — agree |
| INV:L3 | FI:242 / R2:240 | Tool set with schemas | carried | carried | worker-loop §2.10-12, `TOOL_CATALOG` — agree |
| INV:L4 | FI:243 / R2:241 | `read`: ranges, byte budget, numbering, image/PDF | carried-weaker | carried | worker-loop rule 12; images §7 |
| INV:L5 | FI:244 / R2:242 | `edit` unique, CRLF, parse gate | carried | carried | worker-loop §2.12, §2.14 — agree |
| INV:L6 | FI:245 / R2:243 | `grep` modes, context, gitignore, capped | carried-weaker | carried | worker-loop rule 12 |
| INV:L7 | FI:246 / R2:244 | `glob` mtime-sorted, gitignore | carried-weaker | carried | worker-loop rule 12 |
| INV:L8 | FI:247 / R2:245 | `run`: sandbox, timeout, description, deny raw cat/grep/sed, condensing | carried | carried | worker-loop §2.12, WL-5; context §2.17 — agree (`description` unstated) |
| INV:L9 | FI:248 / R2:246 | Symbol tools over LSP | carried | carried | worker-loop §2.12 (TS language service) — see C2 |
| INV:L10 | FI:249 / R2:247 | Tiered `docs` | carried | carried | worker-loop §2.12; design-stage §2.7.2 — agree |
| INV:L11 | FI:250 / R2:248 | `note` to the card thread | carried | carried | worker-loop §2.12 — agree |
| INV:L12 | FI:251 / R2:249 | Code mode (`run_script`) | carried | carried | worker-loop §2.12, WL-M2-4 — agree |
| INV:L13 | FI:252 / R2:250 | Stall `(tool, argHash, repoStateHash)`; 2 = stall; A-B-A | carried | carried | worker-loop §2.17-20, WL-2 built (warn then stop) — R2 SHALLOW (threshold 3, A-B-A-B); spec redefines the episode; A-B-A vs A-B-A-B not re-checked |
| INV:L14 | FI:253 / R2:251 | Six stop reasons, never collapsed | carried | carried | worker-loop §2.30-33, OQ1 (18 stored, 7 classes), T3 — agree |
| INV:L15 | FI:254 / R2:252 | Ladder 2/1/1, park with diagnostic | carried | carried | worker-loop §2.34-36, WL-8 built — agree |
| INV:L16 | FI:255 / R2:253 | `validateWrite` contract | carried | carried | worker-loop §2.14 — agree |
| INV:L17 | FI:256 / R2:254 | Read-before-edit | carried | carried | worker-loop §2.12, WL-4 — agree |
| INV:L18 | FI:257 / R2:255 | Tool sets per card class | carried | carried | worker-loop §2.10, M2 not-built — R2 BUILT, spec-stricter |
| INV:L19 | FI:258 / R2:256 | search/fetch only on research cards | carried | carried | worker-loop §2.12; design-stage §2.7.10 — agree |
| INV:L20 | FI:259 / R2:257 | `browse` sandboxed browser | carried | carried | worker-loop §2.12; security §2.42a (click/type need URL allowlist) — agree |
| INV:L21 | FI:260 / R2:258 | Planner-set step budgets | carried | carried | worker-loop §2.21 (p80 × 1.25, ≤ 15%, ≥ 4), WL-10 — agree |
| INV:L22 | FI:261 / R2:259 | Token/seconds/kWh budgets, park at cap | carried-weaker | gap | runtime rule 19, NEW-runtime-7 |
| INV:L23 | FI:262 / R2:260 | Background processes per card, ports | carried | carried | runtime §2.15, §4 built — agree |
| INV:L24 | FI:263 / R2:261 | Interactive terminals | carried | carried | runtime §2.16 — agree |
| INV:L25 | FI:264 / R2:262 | `abort(reason)` → `human_abort` | carried | carried | planner §2.14; worker-loop §3 CLI `abort`; hook veto → `hook_veto` (WL-T3-4) — agree |
| INV:L26 | FI:272 / R2:263 | Symlink-aware path confinement | carried | carried | worker-loop §2.14; security §4 built — agree |
| INV:L27 | FI:273 / R2:264 | CRLF/EOL utilities | carried | carried | worker-loop §2.12 "line endings normalised" — agree |
| INV:L28 | FI:274 / R2:265 | Real glob engine | carried | carried | implied (`find_files`, protected globs) — agree |
| INV:L29 | FI:275 / R2:266 | Observation contract + 2,400/1,200 clamp | carried-weaker | carried | worker-loop §3, §4 |
| INV:L30 | FI:276 / R2:267 | `ToolExecutor` returning observations; ask escalation | carried | carried | worker-loop §3 contract — agree |
| INV:L31 | FI:277 / R2:268 | Symbol spans | carried | carried | worker-loop §2.12 — agree |

**Board (B)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:B1 | FI:287 / R2:274 | Legal edges, entry conditions, override logged | carried | carried | kernel §2.19-22, §4 built — agree |
| INV:B2 | FI:288 / R2:275 | Planning column incl. Verify→Planning | carried-weaker | carried | kernel rule 25 |
| INV:B3 | FI:289 / R2:276 | ReviewWIP from own history | carried | carried | review-git §2.2 (floor 1, per project, 15-min prior until 5 reviews), S6 partial — R2 BUILT, spec-stricter |
| INV:B4 | FI:290 / R2:277 | Back-pressure blocks entry to Verify | carried | carried | kernel §2.23, K-6 built — agree |
| INV:B5 | FI:291 / R2:278 | Dependency DAG | carried | carried | kernel §2.3 — agree |
| INV:B6 | FI:292 / R2:279 | Overlapping scopes serialised | carried | carried | kernel §2.4, K-8 — agree |
| INV:B7 | FI:293 / R2:280 | Parent rollup with integration gate | carried | carried | kernel §2.24, K-7 — agree |
| INV:B8 | FI:294 / R2:281 | Project-scoped board | carried | carried | kernel `ProjectRecord`; review-git S6 per project; dashboard Workspace — agree |
| INV:B9 | FI:295 / R2:282 | `createCard` | carried | carried | kernel `CardStore` — agree |
| INV:B10 | FI:296 / R2:283 | WIP evaluation | carried | carried | kernel §2.21, §3 defaults (planning 3, in_progress 5, verify 5, review 3) — agree |
| INV:B11 | FI:297 / R2:284 | Fractional `order_key` | carried-weaker | carried | kernel rule 15 |
| INV:B12 | FI:298 / R2:285 | Human commands; override never on security | carried | carried | planner §2.14; kernel §2.22, K-5 built; Reroute/Explain Later — R2 SHALLOW, DISAGREE (spec cites a test) |
| INV:B13 | FI:299 / R2:286 | Active project cap 3 | carried | carried | kernel §2.2 — agree |

**Planner (P)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:P1 | FI:309 / R2:292 | SPIDR five heuristics, split until it fits | carried | carried | planner §2.1-2.2 (Cohn's SPIDR; old "Interface = types first" becomes the Contract enabler card), P1 model-first — agree |
| INV:P2 | FI:310 / R2:293 | INVEST six checks, 25%, ≤ 40, > 7 | carried | deliberate | planner-pm §2.4; DEC-24 (Small sized to the resolved Worker's window; other checks unchanged) |
| INV:P3 | FI:311 / R2:294 | WSJF / RICE from config | carried | carried | planner §2.7.2 — agree |
| INV:P4 | FI:312 / R2:295 | Estimation formula; actuals write back | carried | carried | planner §2.6.1 (points added for people — Resolved drift) — agree |
| INV:P5 | FI:313 / R2:296 | Difficulty scoring | carried | carried | planner §2.4-2.5; extensibility tools table — agree |
| INV:P6 | FI:314 / R2:297 | Routing < 4 / 4–7 / > 7; capability_ceiling escalation | carried | carried | planner §2.5 (+ max split depth 4) — agree |
| INV:P7 | FI:315 / R2:298 | Edit-sketch cascade | carried | carried | planner §2.1.7, §2.5; worker-loop §2.28 — agree |
| INV:P8 | FI:316 / R2:299 | Assume/Ask/Spike; batch; > 3 questions rejects | contradicted | deliberate | planner-pm §2.10.1, §9; DEC-24 |
| INV:P9 | FI:317 / R2:300 | `DecisionRequest` full shape | carried | carried | planner §2.10.2 (default deadline 12 h), built — agree |
| INV:P10 | FI:318 / R2:301 | `safe_default` / `default_deny` | carried | carried | planner §2.10.3, built — agree |
| INV:P11 | FI:319 / R2:302 | Pause & persist, VRAM released, rehydrate | contradicted | deliberate | planner-pm §2.10.2–3, §9; DEC-24 |
| INV:P12 | FI:320 / R2:303 | Six planner sessions | carried | carried | planner §2.7.8 table — agree (standup builders P6) |
| INV:P13 | FI:321 / R2:304 | Status from gate results with ranges | carried | carried | planner §2.6.3, §2.8.14 — agree |
| INV:P14 | FI:322 / R2:305 | Escalation diagnostics, smallest human action | carried | carried | planner §2.5 — agree |
| INV:P15 | FI:323 / R2:306 | Trust calibration 15% | carried | carried | planner §2.10.4, §4 built — R2 DEAD; DISAGREE, code has `sekhemet assume` (`wave2.ts:665`): spec right |
| INV:P16 | FI:324 / R2:307 | Process profiles | carried-weaker | carried | planner-pm §2.7.3 (not in §4) |
| INV:P17 | FI:325 / R2:308 | `Goal` record | carried | carried | planner §2.11.1, §3 events — agree |
| INV:P18 | FI:326 / R2:309 | `/goal` intake, approval first | carried | carried | planner §2.11.2 — agree |
| INV:P19 | FI:327 / R2:310 | Goal loop, replan triggers | carried-weaker | gap | planner-pm §4 (partial), NEW-planner-pm-4 |
| INV:P20 | FI:328 / R2:311 | Seven signals and responses | carried-weaker | gap | planner-pm §4 (partial), NEW-planner-pm-5 |
| INV:P21 | FI:329 / R2:312 | Multiple goals, WSJF, per-window explanation | carried | carried | planner §2.11.4 — agree |
| INV:P22 | FI:330 / R2:313 | Stopping honestly | carried | carried | planner §2.11.5 — agree |
| INV:P23 | FI:331 / R2:314 | Board operations tool | carried | carried | planner §2.8.3 — agree |
| INV:P24 | FI:332 / R2:315 | Impact analysis over language-server references | carried | carried | extensibility tools table; context §2.22 (P1 not-built) — agree |
| INV:P25 | FI:333 / R2:316 | Implementation previews | carried | carried | planner §2.10.2 `previewSketch`, built — agree |

**Eval (E)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:E1 | FI:343 / R2:322 | Pass@1 harness under the real loop; M0 protocol | carried-weaker | deliberate | measurement rule 28 (M0 protocol built, `m0.ts`; the ≥ 90% bar recorded as historical with the reason); pivot rule §8 Q4 |
| INV:E2 | FI:344 / R2:323 | Git task synthesis, fail-to-pass, scrub paths | carried | carried | models §2.30; measurement §2.17 inlet; OPEN_QUESTIONS research gap — agree |
| INV:E3 | FI:345 / R2:324 | Full-settings recording | carried | carried | gates §2.35; models §2.30, M4; measurement §2.5 — spec-stricter |
| INV:E4 | FI:346 / R2:325 | `MODEL_MATRIX.md` | carried-weaker | carried | models §3, §4 |
| INV:E5 | FI:347 / R2:326 | Frozen suite gates every learning loop | carried | carried | measurement §2.17-19, T8 — agree |
| INV:E6 | FI:348 / R2:327 | Qualification scoring | carried | carried | models §2.27 — agree |
| INV:E7 | FI:349 / R2:328 | Loop 1 playbook deltas (1 per retro) | carried | carried | measurement §2.17 table; context §2.24 — agree |
| INV:E8 | FI:350 / R2:329 | Loop 2 budgets ≤ 15% | carried | carried | measurement §2.17; worker-loop §2.21 — agree |
| INV:E9 | FI:351 / R2:330 | Loop 3 prompt evolution | later | later | context §7 |
| INV:E10 | FI:352 / R2:331 | Loop 4 skill distillation | carried | carried | measurement §2.17; extensibility §2.17a, EXT-27a/b — agree |
| INV:E11 | FI:353 / R2:332 | Loop 5 exemplars top-2 | carried | carried | measurement §2.17 (two per class, min 5 cards) — agree |
| INV:E12 | FI:354 / R2:333 | Loop 6 task synthesis | carried | carried | measurement §2.17 — agree |
| INV:E13 | FI:355 / R2:334 | Loop 7 variant archives | carried-weaker | deliberate | DEC-25 R31 (variant archive cut as dead code under DEC-09) |
| INV:E14 | FI:356 / R2:335 | Loop 8 SIFT pre-filter | carried | carried | measurement §2.13, §2.21, MS-T8-7 — agree |
| INV:E15 | FI:357 / R2:336 | Loop 9 tool synthesis | later | deliberate | worker-loop §9 (register R6 triaged, not in v1); security §8 Q1 (recommend cutting `--validate-tools`) |
| INV:E16 | FI:358 / R2:337 | Loop 10 mutants → tests | carried-weaker | gap | measurement rule 17 (demoted on rollback), T8 (MS-T8-10) |
| INV:E17 | FI:359 / R2:338 | Guardrails; rollback over 10-card window | contradicted | deliberate | measurement rule 18, §9; DEC-24 |
| INV:E18 | FI:360 / R2:339 | Permanent self-modification exclusions | carried | carried | measurement §2.23; security §2.25 — agree |
| INV:E19 | FI:361 / R2:340 | Doctor net gain, bloat, pruning | carried | carried | measurement §2.24, NEW-measurement-2; extensibility §2.16 — agree |

**Dashboard (U; latest R1)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:U1 | FI:371 / R1:367 | Loopback 127.0.0.1:4040 | carried | carried | runtime §2.23 — agree |
| INV:U2 | FI:372 / R1:368 | Tokens as CSS variables and JSON | carried | carried | dashboard §2.13.1 — agree |
| INV:U3 | FI:373 / R1:369 | Basalt/Sand exact values, light theme | carried-weaker | deliberate | dashboard §2.13.1, §9 |
| INV:U4 | FI:374 / R1:370 | Typography, tabular numerals | carried | carried | dashboard §2.13.4 identical — agree |
| INV:U5 | FI:375 / R1:371 | Spacing, radius, elevation, motion | carried | carried | dashboard §2.13.5 identical — agree |
| INV:U6 | FI:376 / R1:372 | Dual-axis virtualization | carried-weaker | carried | dashboard §2.4.9 |
| INV:U7 | FI:377 / R1:373 | Six views | carried | carried | dashboard §2.2, §2.11 (Registry, Workspace); master board Later — agree |
| INV:U8 | FI:378 / R1:374 | Review view | carried | carried | dashboard §2.5, §4 built; intent grouping Later — agree |
| INV:U9 | FI:379 / R1:375 | Live stream, replay from genesis | carried-weaker | carried | runtime rule 25a |
| INV:U10 | FI:380 / R1:376 | Keyboard system | carried | carried | dashboard §2.3 (redefined chords), P11 — agree |
| INV:U11 | FI:381 / R1:377 | Command palette | carried | carried | dashboard §2.3, §2.15.4, built — agree |
| INV:U12 | FI:382 / R1:378 | Decision inbox by wait time | carried | carried | dashboard §2.5.2 *Needs you* — agree |
| INV:U13 | FI:383 / R1:379 | Card tile components | contradicted | deliberate | dashboard §9 |
| INV:U14 | FI:384 / R1:380 | Column header `N / limit` | carried | carried | dashboard §2.4.3, P3 — spec-stricter |
| INV:U15 | FI:385 / R1:381 | Decision Request component with countdown | carried | carried | dashboard §2.5.14 — no State row; R1 MISSING, code `decision.js` now exists |
| INV:U16 | FI:386 / R1:382 | Diff viewer | carried | carried | dashboard §2.5.6 built — agree |
| INV:U17 | FI:387 / R1:383 | Pan-and-zoom DAG | carried-weaker | later | dashboard §7 (layered layout built) |
| INV:U18 | FI:388 / R1:384 | Sparklines | contradicted | carried | dashboard §2.11, §4 (R23) |
| INV:U19 | FI:389 / R1:385 | Icons 1.5 px, no lioness | carried | carried | dashboard §2.13.6 — agree |
| INV:U20 | FI:390 / R1:386 | Mobile read-only + one-tap triage | carried | carried | dashboard §2.2.2, §2.15.3, P11 — agree |
| INV:U21 | FI:391 / R1:387 | `IBoardUIState` | missing | later | dashboard §7 |

**Harness app (H)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:H1 | FI:401 / R2:346 | `daemon` with PID file, detach | carried | carried | runtime §2.5, NEW-runtime-1 partial — spec-stricter |
| INV:H2 | FI:402 / R2:347 | `board` opens the web UI | carried | carried | surface §2.5.6, §2.13 — agree |
| INV:H3 | FI:403 / R2:348 | `calibrate` writes machine config | carried | carried | models §2.7, NEW-models-1 — agree |
| INV:H4 | FI:404 / R2:349 | `run <card>` unattended | carried | carried | surface §2.13, §2.18 — agree |
| INV:H5 | FI:405 / R2:350 | `plan "<spec>"` | carried | carried | planner §2.1; surface `sekhemet "<spec>"` — agree |
| INV:H6 | FI:406 / R2:351 | `gate <card>` in the card's worktree | carried | carried | gates §2.8, T1 — R2 BUILT, DISAGREE (spec newer) |
| INV:H7 | FI:407 / R2:352 | `bake-off` qualifies and benchmarks on the repo | carried | carried | models §2.30, surface §2.11 — agree |
| INV:H8 | FI:408 / R2:353 | `replay --as`, diff trajectories | carried | carried | runtime §2.14, RUN-28 — agree |
| INV:H9 | FI:409 / R2:354 | `doctor` real probes | carried | carried | surface §2.13; models §2.5 — agree |
| INV:H10 | FI:410 / R2:355 | MCP server tools incl. evidence and registry | carried | carried | extensibility §2.18-21, NEW-extensibility-3 — agree |
| INV:H11 | FI:411 / R2:356 | MCP client budgeted to planner/executor | carried | carried | extensibility §2.22-24 (Worker only via `worker_tools`) — agree |
| INV:H12 | FI:412 / R2:357 | REST API | carried | carried | runtime §3 route list (old table superseded) — agree |
| INV:H13 | FI:413 / R2:358 | SDK with async iterator | carried-weaker | deliberate | extensibility rule 28, §8 Q1 (O4) |
| INV:H14 | FI:414 / R2:359 | ACP editor surface | later | later | extensibility §7 |
| INV:H15 | FI:415 / R2:360 | `config.toml` chain incl. card overrides | carried | carried | surface §2.21-25 (keys removed by decision) — R2 SHALLOW; DISAGREE on card layer |
| INV:H16 | FI:416 / R2:361 | Slash commands (`/onboard` … `/goal`) | carried | carried | extensibility §2.26; planner §2.8.7; templates Later — agree |
| INV:H17 | FI:417 / R2:362 | Session resume from the log | carried | carried | runtime §2.10, NEW-runtime-3 — spec-stricter |
| INV:H18 | FI:418 / R2:363 | Fork at step N | carried | carried | runtime §2.13, RUN-27 — agree |
| INV:H19 | FI:419 / R2:364 | Rewind to step N, invalidate passes | carried | carried | runtime §2.12, kernel §2.26, K-S7-8 — spec-stricter |
| INV:H20 | FI:420 / R2:365 | ntfy/Gotify notifications | carried | carried | integrations §2.20-23 — agree |
| INV:H21 | FI:421 / R2:366 | Idle/overnight scheduler, nightly jobs, morning summary | carried | carried | runtime §2.17-20, NEW-runtime-5 — agree |
| INV:H22 | FI:422 / R2:367 | OTel spans incl. tool spans, in UI | carried-weaker | gap | runtime §4 (corrected, R23), NEW-runtime-9 |
| INV:H23 | FI:423 / R2:368 | Compute governance kWh, breakers | carried | carried | runtime §2.18-19 (watts × time replaces TDP × GPU utilisation) — agree |
| INV:H24 | FI:424 / R2:369 | Reproducibility record per card | carried | carried | runtime OQ2 → models M4, gates §2.35 — agree |
| INV:H25 | FI:425 / R2:370 | Offline installers, first-run wizard | later | deliberate | DEC-21 (source installer); DEC-29 O9 (npm package and container image approved) |
| INV:H26 | FI:426 / R2:371 | Memory daemon 2 s | carried | carried | models §2.19 — agree |
| INV:H27 | FI:427 / R2:372 | Restricted-mode wiring | carried | carried | see S12 |

**Cross-cutting (X; latest R1)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:X1 | FI:435 / R1:425 | `/onboard` seven steps; review before enforcement | carried | carried | surface §2.5, §2.9-11, P10 — spec newer |
| INV:X2 | FI:436 / R1:426 | Nightly convention drift report | carried | carried | surface §2.12; runtime §2.20 — spec newer |
| INV:X3 | FI:437 / R1:427 | Multimodal card input via vision model | carried | carried | surface §2.28-29, SUR-32, built — spec newer |
| INV:X4 | FI:438 / R1:428 | Four-tier research knowledge | carried | carried | design-stage §2.7.2 — agree |
| INV:X5 | FI:439 / R1:429 | SearXNG; 1–6 terms; logged; primary sources | carried | carried | design-stage §2.7.11, §2.6.3, S8 — agree |
| INV:X6 | FI:440 / R1:430 | Fetch & extraction pipeline | carried-weaker | carried | design-stage §2.6.3, §2.7.2, §2.7.8; libraries §7 |
| INV:X7 | FI:441 / R1:431 | Research note; embeddings only here | contradicted | deliberate | design-stage §2.7.8, §9; DEC-22 |
| INV:X8 | FI:442 / R1:432 | Research safety | carried | carried | design-stage §2.6.3, §2.7.6; security §2.42 — agree |
| INV:X9 | FI:443 / R1:433 | Doc cache TTLs | later | later | design-stage §7 |
| INV:X10 | FI:444 / R1:434 | Air-gap package mirrors | carried | carried | security §2.46 (allowlist); services Later — agree |
| INV:X11 | FI:445 / R1:435 | Signed model manifest | carried | carried | security §2.47, SEC-34 — agree |
| INV:X12 | FI:446 / R1:436 | Doc bundles | carried | carried | security §2.48 — agree |
| INV:X13 | FI:447 / R1:437 | Signed update bundles, log backup | carried | carried | security §2.49, SEC-42 — agree |
| INV:X14 | FI:448 / R1:438 | Air-gap self-test at the proxy | carried | carried | security §2.50, NEW-security-2 — agree |
| INV:X15 | FI:449 / R1:439 | External review cards, never edit | carried | carried | review-git §2.7; integrations §2.13 — spec newer |
| INV:X16 | FI:450 / R1:440 | Scheduled and recurring cards; hours respected unless urgent | carried | carried | runtime §2.21, RUN-31 — spec newer |
| INV:X17 | FI:451 / R1:441 | `PROVENANCE.md` | carried | carried | `docs/reference/PROVENANCE.md` (13 technique rows) — spec newer |
| INV:X18 | FI:452 / R1:442 | `RESEARCH_REGISTER.md` with pre-set thresholds | carried | carried | measurement §2.26, MS-2 — spec newer |
| INV:X19 | FI:453 / R1:443 | `MODEL_MATRIX.md` | carried-weaker | carried | models §3, §4 |
| INV:X20 | FI:454 / R1:444 | Licence register enforcement rules | carried-weaker | carried | PROVENANCE; gates rule 27 |
| INV:X21 | FI:455 / R1:445 | Fixture generator, `createTestWorktree` < 10 ms | missing | deliberate | DEFINITION_OF_DONE §2D.3 (the < 10 ms target assumed in-memory SQLite; real repositories required) |
| INV:X22 | FI:456 / R1:446 | No in-memory SQLite for kernel/board (DoD §2.A.1) | carried | carried | planner P1 criterion; DoD §2A; kernel K-1 on disk — agree (still open) |
| INV:X23 | FI:457 / R1:447 | `test:unit` / `test:integration` | missing | carried | DEFINITION_OF_DONE §2D.1 |
| INV:X24 | FI:458 / R1:448 | `pnpm dev` | missing | carried | DEFINITION_OF_DONE §2D.1 |
| INV:X25 | FI:459 / R1:449 | Suite under 3 s | missing | deliberate | DEFINITION_OF_DONE §2D.4 |
| INV:X26 | FI:460 / R1:450 | Trailer enforcement as a gate | carried | carried | gates §2.27 (trailer gate); review-git §2.5.4 refused squash — agree |
| INV:X27 | FI:461 / R1:451 | Chronicle fixture and scorecard | carried-weaker | deliberate | measurement rule 28 (Chronicle bars kept as diagnostics, with the reason) |
| INV:X28 | FI:462 / R1:452 | Showcase Trifecta and its targets | carried-weaker | deliberate | measurement rule 28 (Trifecta targets superseded, with the reason) |
| INV:X29 | FI:463 / R1:453 | CHRONICLE `llama-server` profile | contradicted | deliberate | models rule 3a (Chronicle profile recorded and superseded by the DEC-04 Worker on 8098) |

**The 108 "most likely to be overlooked" items (FI:471–578)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:O1 | FI:471 | Binary-search budget fit for the repo map | carried | carried | context §2.13 |
| INV:O2 | FI:472 | Aider edge-weight multipliers; PPR seeded on scope | carried-weaker | gap | context rule 13, NEW-context-5 |
| INV:O3 | FI:473 | Repo-map cache key path + mtime + content hash | carried-weaker | gap | context rule 13, NEW-context-5 |
| INV:O4 | FI:474 | Pressure 70/80/85/90, `budget_exhausted` at 95 | carried | carried | context §2.12 |
| INV:O5 | FI:475 | Goal re-injected at the tail of every step | carried | carried | context §2.8 (tail restates the goal) |
| INV:O6 | FI:476 | Traces stripped unless registry flag | contradicted | deliberate | context rule 4; DEC-24 |
| INV:O7 | FI:477 | Pointer carries a retrievable EvidenceRef | carried | carried | context §2.3 (`recall(ref)`, blob store) |
| INV:O8 | FI:478 | RTK four named strategies | carried | carried | context §2.17 |
| INV:O9 | FI:479 | Lossless for repair data | carried | carried | context §2.17, CX-3 |
| INV:O10 | FI:480 | Stall signature includes repoStateHash | carried | carried | worker-loop §2.17 |
| INV:O11 | FI:481 | Rung caps 2/1/1 | carried | carried | worker-loop §2.34 |
| INV:O12 | FI:482 | ≤ 3 failures by topological order | carried-weaker | gap | gates rule 20, M6 (GT-M6-7) |
| INV:O13 | FI:483 | `minimalRepro` exact command | carried | carried | gates §2.19, §2.22 |
| INV:O14 | FI:484 | Routing < 4 / 4–7 (edit sketch) / > 7 | carried | carried | planner §2.5 |
| INV:O15 | FI:485 | INVEST-S ≤ 25% and ≤ 40 steps | carried | deliberate | planner-pm §2.4; DEC-24 (25% of the resolved Worker's window, ≤ 40 steps) |
| INV:O16 | FI:486 | INVEST-E difficulty > 7 forces re-split | carried | carried | planner §2.4 |
| INV:O17 | FI:487 | > 3 questions rejects the spec | contradicted | deliberate | planner-pm §9; DEC-24 |
| INV:O18 | FI:488 | Assume→Ask shift at 15% override | carried | carried | planner §2.10.4 |
| INV:O19 | FI:489 | `policy` safe_default/default_deny; never auto-approve destructive | carried | carried | planner §2.10.3 |
| INV:O20 | FI:490 | `decision/default_applied` distinct event | carried | carried | planner §2.10.3, §3 |
| INV:O21 | FI:491 | Scope drift > 20% halts auxiliary creation | carried | carried | planner §2.12 (execution unbuilt, Needs attention 19) |
| INV:O22 | FI:492 | p95 > 2.5 × p50 (vs 2× conflict) | carried | carried | planner §2.12 (2.5× chosen) |
| INV:O23 | FI:493 | Blocked 12 h / 2 h active | carried | carried | planner §2.12 |
| INV:O24 | FI:494 | ≥ 3 failures in one file → re-split Interface/Data | carried | carried | planner §2.12 |
| INV:O25 | FI:495 | RAID > 24 h → verification spike | carried | carried | planner §2.12 |
| INV:O26 | FI:496 | ReviewWIP floored at 1, from own history | carried | carried | review-git §2.2.1-3 |
| INV:O27 | FI:497 | Back-pressure blocks Verify, not Review | carried | carried | kernel §2.23 |
| INV:O28 | FI:498 | Rollup needs the parent's integration gate | carried | carried | kernel §2.24 |
| INV:O29 | FI:499 | Regression → Planning with regression named | carried-weaker | gap | kernel rule 31, NEW-kernel-5 |
| INV:O30 | FI:500 | Checkpoint at gate passes and masking boundaries | contradicted | deliberate | review-git rule 3, §9 (R1) |
| INV:O31 | FI:501 | `refs/sekhemet/checkpoints/<card-id>` | carried | carried | review-git §2.5.5 |
| INV:O32 | FI:502 | Branch naming from parent | carried | carried | review-git §2.6.2 |
| INV:O33 | FI:503 | Accepting a lower card restacks and re-runs gates | carried | carried | review-git §2.5.5 (code gap: Needs attention 17) |
| INV:O34 | FI:504 | Conflict hunks typed; out-of-scope parks | carried | carried | review-git §2.6.4 (code gap: Needs attention 16) |
| INV:O35 | FI:505 | Vision fail-only; baselines need a person | carried | carried | gates §2.30-31, NEW-gates-4 |
| INV:O36 | FI:506 | axe-core at 1280 and 375, zero critical | carried | carried | gates §2.29 (subset; axe proposal OQ1) |
| INV:O37 | FI:507 | `maxDiffPixelRatio` 0.01, masked, no animation | carried | carried | gates §2.29 (code gap: Needs attention 14) |
| INV:O38 | FI:508 | Four layout predicates | carried | carried | gates §2.29 (code gap: overlap) |
| INV:O39 | FI:509 | Mutation diff-scoped, never 100%, advisory first | carried | carried | gates §2.32 |
| INV:O40 | FI:510 | Levenshtein typosquat | carried | carried | security §2.44 (distance 2; 1 for ≤ 4 chars) |
| INV:O41 | FI:511 | Proxied requests logged with SHA-256 payload hash | carried | carried | security §2.30 |
| INV:O42 | FI:512 | `<untrusted_content source>` wrapper + contract | carried | carried | security §2.42 |
| INV:O43 | FI:513 | CoW cloning + symlinked `node_modules`/`.venv` | later | deliberate | DEC-21 (plain worktrees); security rule 24 (node_modules and `.venv` links) |
| INV:O44 | FI:514 | llama.cpp cache flags from the machine profile | contradicted | deliberate | context rule 6; DEC-24 |
| INV:O45 | FI:515 | 4-bit KV prohibited for tool calling | carried | carried | models §2.10, MD-1 |
| INV:O46 | FI:516 | Hit < 85% on tool-result steps is a defect + operator alert | carried-weaker | gap | context rule 7, M8 |
| INV:O47 | FI:517 | Template checksum change invalidates qualification | carried | carried | models §2.12 |
| INV:O48 | FI:518 | Pass@k k 2–4, T 0.4–0.7, isolated worktrees, first pass wins | carried-weaker | carried | worker-loop rule 37; parallel §7 |
| INV:O49 | FI:519 | Cross-validation routes to the planner | carried | carried | worker-loop §2.38 |
| INV:O50 | FI:520 | Exemplars top-2 per class from this repo | carried | carried | context §2.25 |
| INV:O51 | FI:521 | Playbook by delta, at card boundaries | carried | carried | context §2.24, CX-5 |
| INV:O52 | FI:522 | Context debt: > 300 tokens and ≥ +3% (both halves) | carried | carried | measurement §2.24, MS-N2-2 |
| INV:O53 | FI:523 | Prompt optimiser kill switch < 5% | carried | carried | context §7 (Later, "kept only if ≥ 5%") |
| INV:O54 | FI:524 | Rollback on a moving 10-card window | contradicted | deliberate | measurement rule 18; DEC-24 |
| INV:O55 | FI:525 | Loop driver, gates, sandbox, permissions excluded from self-modification | carried | carried | measurement §2.23 |
| INV:O56 | FI:526 | Loop 9 signal: repeated bash chains | later | deliberate | worker-loop §9 (register R6 triaged, not in v1) |
| INV:O57 | FI:527 | Loop 10 demoted to advisory on rollback | carried-weaker | gap | measurement rule 17, T8 (MS-T8-10) |
| INV:O58 | FI:528 | Skill manifest line only; omitted when tools lacking | carried | carried | extensibility §2.11-12, EXT-32 |
| INV:O59 | FI:529 | Skills pinned, audited, diffed; reject protected-touching | carried | carried | extensibility §2.15, §2.17, EXT-27 |
| INV:O60 | FI:530 | Every skill ships an eval card | later | later | extensibility §7 |
| INV:O61 | FI:531 | `skills/<name>/{SKILL.md, scripts/, references/, evals/}` | carried | carried | extensibility §2.10 |
| INV:O62 | FI:532 | Hooks outside the sandbox with user rights | carried | carried | extensibility §2 table, §9 |
| INV:O63 | FI:533 | Hook observe / block / inject | carried | carried | extensibility §2.6 |
| INV:O64 | FI:534 | `tool_search` loads a schema into the volatile zone | carried | carried | worker-loop §2.11 (A/B); context OQ2 (append as a message) |
| INV:O65 | FI:535 | Subtask returns summary + evidence ref only | carried | carried | context §2.18 |
| INV:O66 | FI:536 | Background processes killed at card end; ports | carried | carried | runtime §2.15 (promotion Later) |
| INV:O67 | FI:537 | Rewind invalidates passes; log never truncated | carried | carried | runtime §2.12; kernel §2.26 |
| INV:O68 | FI:538 | Replay reproduces deterministic stages exactly | carried | carried | runtime §2.14 |
| INV:O69 | FI:539 | Reload re-streams from genesis/checkpoint | missing | carried | runtime rule 25a; dashboard §2.4.8 |
| INV:O70 | FI:540 | Config order includes card overrides | carried | carried | surface §2.21 |
| INV:O71 | FI:541 | `[machine] hours`, `power_budget_kwh_day` | carried | carried | surface §2.23 (`reserved_hours`) |
| INV:O72 | FI:542 | `[context] map_tokens = 1024`, `mask_after_observations = 2` | contradicted | deliberate | surface rule 25; context §9 ([context] keys removed) |
| INV:O73 | FI:543 | `[loop] default_step_budget = 40`, `stall_window = 3`, `max_rungs = 4` | contradicted | deliberate | surface rule 25 (step budget 40 kept; stall_window and max_rungs removed); worker-loop §9 |
| INV:O74 | FI:544 | `[network] mode` tri-state | carried | carried | surface §2.23 |
| INV:O75 | FI:545 | `protected` glob list in gates.toml | carried | carried | gates §3 `DEFAULT_PROJECT_CONFIG` |
| INV:O76 | FI:546 | Per-gate `parser`; `baseline_approval = "human"` | carried | carried | gates §3 keys; GT-N4-1 |
| INV:O77 | FI:547 | gates.toml hash every card start | carried | carried | gates §2.2 |
| INV:O78 | FI:548 | `order_key` fractional index | carried-weaker | carried | kernel rule 15 |
| INV:O79 | FI:549 | `payload_hash` separate from `hash` | carried | carried | kernel §2.8 |
| INV:O80 | FI:550 | Blobs under `.sekhemet/` referenced from payload | carried | carried | kernel §2.15 |
| INV:O81 | FI:551 | Process profiles change cadence only | carried | carried | planner §2.7.3 |
| INV:O82 | FI:552 | Retrospectives are functional | carried | carried | planner §2.7.4 |
| INV:O83 | FI:553 | Every return reason becomes a candidate rule | contradicted | deliberate | review-git §2.4, §9 |
| INV:O84 | FI:554 | git-cliff changelog + semver on a release card | later | later | integrations §7 |
| INV:O85 | FI:555 | `act` for GitHub Actions as gates | later | later | integrations §7 |
| INV:O86 | FI:556 | GraphQL separate budget, webhooks over polling, batching, idempotency keys, secondary backoff | carried-weaker | gap | integrations §2.11, §2.11a, P9 |
| INV:O87 | FI:557 | Hierarchy depth clamped to the tracker's | carried | carried | integrations §2.7 |
| INV:O88 | FI:558 | GHES `api_url`/`graphql_url` + CA bundle | carried | carried | integrations §2.10 |
| INV:O89 | FI:559 | `resolveReviewThread`; auto-merge; merge queue | later | later | integrations §7; merge policy §2.15 (P9) |
| INV:O90 | FI:560 | Check Run annotation shape incl. `raw_details` | carried-weaker | carried | integrations §2.14 |
| INV:O91 | FI:561 | SARIF gzip then base64 | carried | carried | integrations §2.14 |
| INV:O92 | FI:562 | LWW by timestamp, loser in history | contradicted | deliberate | integrations §2.4 |
| INV:O93 | FI:563 | Per-class tool sets named | carried-weaker | carried | worker-loop rule 10 |
| INV:O94 | FI:564 | `run` denies raw cat/grep/sed | carried | carried | worker-loop §2.12, WL-5 |
| INV:O95 | FI:565 | Read before edit, mechanically | carried | carried | worker-loop §2.12, WL-4 |
| INV:O96 | FI:566 | Search/fetch only on research cards | carried | carried | worker-loop §2.12; design-stage §2.5.6 |
| INV:O97 | FI:567 | ast-grep fallback without a language server | later | later | worker-loop §7, context §7 |
| INV:O98 | FI:568 | Missing parser/LSP/template → parse-only with visible warning | carried | carried | surface §2.30, SUR-33 |
| INV:O99 | FI:569 | Qwen `min_p = 0.0` mandatory over server default 0.05 | carried-weaker | carried | models rule 3a (min_p 0 mandatory, overrides the server's 0.05) |
| INV:O100 | FI:570 | MTP off on M4 because measured 21% slower | carried | carried | models §2.13 (off until measured) |
| INV:O101 | FI:571 | Bracketed placeholders banned in prompt templates | missing | gap | context rule 21, M1 (CX-M1-12) |
| INV:O102 | FI:572 | Single-model serialisation on 24 GB | carried | carried | models §2.22 (no co-residence below 32 GB); planner §2.8.6 |
| INV:O103 | FI:573 | Test immutability is role-scoped | carried | carried | gates §2.7; worker-loop §2.15; planner test-author step |
| INV:O104 | FI:574 | `suspended-quota`, `relay-finisher` protocol values | missing | deliberate | DEC-25 R29; `suspended-quota` is kept (CLAUDE.md GateStatus); `relay-finisher` is gone with no recorded reason (DEC-25's R28 row records only test infrastructure) — owner: DECISIONS |
| INV:O105 | FI:575 | DoD §2.A no in-memory SQLite | carried | carried | planner P1 criterion; DoD §2A |
| INV:O106 | FI:576 | DoD §2.B two negatives per happy path; bit-flip tamper test | carried-weaker | carried | DEFINITION_OF_DONE §2B; kernel K-1; gates §8 Q2 |
| INV:O107 | FI:577 | DoD §2.C no sole `toBeDefined` assertions | carried | carried | DEFINITION_OF_DONE.md:37 (kept document) |
| INV:O108 | FI:578 | `edit` exactly once, CRLF-tolerant | carried | carried | worker-loop §2.12 |

**REAUDIT defects (R1:71-78; all "Fixed" in R2:56-63)**

| Row | Old | Item | Traced | Final | Now in |
| --- | --- | --- | --- | --- | --- |
| INV:D1 | R1:71 | Held card instead of a crash when Review is full | carried | carried | kernel §2.18, §2.23, NEW-kernel-3 |
| INV:D2 | R1:72 | Checkpoints written to the DB | carried-weaker | carried | review-git rule 3 (checkpoint database record) |
| INV:D3 | R1:73 | Restricted mode confines the Worker's tools | carried | carried | security §2.43, worker-loop §2.13 |
| INV:D4 | R1:74 | Ask tier asks someone (decision approver) | carried-weaker | carried | security rule 25a, SEC-47–49 (who answers an Ask) |
| INV:D5 | R1:75 | `gates.toml` protected globs reach the permission engine | carried | carried | security §2.25 ("test globs the project protects") |
| INV:D6 | R1:76 | Planned cards keep their contract | carried | carried | planner §2.1.5 |
| INV:D7 | R1:77 | MCP offers no DB-refused tier | carried | carried | extensibility §2.19-20 (server-side validation) |
| INV:D8 | R1:78 | Card actuals written on finish | carried | carried | kernel §2.6 `CardRecord` (runner write not a stated behaviour) |

