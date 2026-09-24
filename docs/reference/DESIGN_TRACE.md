# Design trace: the 2026-09-17 design into design v3

*The check that design v3 kept everything from the 2026-09-17 design (`HARNESS_DESIGN.md`), its companions (`PM_DESIGN.md`, `FRONTEND_DESIGN.md`, `INTEGRATION_REVIEW.md`) and the three feature inventories. The old files are at `fb59ba2`: read them with `git show fb59ba2:docs/design/HARNESS_DESIGN.md`. Checked against the specs at `c8cd903`.*

> **Status: incomplete.** The four trace files this record is built from (`trace_hd1.md`, `trace_hd2.md`, `trace_pm_fe.md`, `trace_inv.md`: 2,148 items) were kept in a session scratch directory, and that directory was wiped when the session restarted on 2026-09-24. Before the wipe, 476 of the 723 rows that were not `carried` had been checked against the specs, and those results are below. The remaining 247 rows, along with every originally `carried` row, have to come from the trace files again, either restored or re-run. Until then §5 holds only the rows that were checked.

## 1. What this is, and how it was checked

**Method.** Four traces went through each old source from top to bottom and classified every normative item (a capability, behaviour, mechanism, number, threshold, field, command, UI state or edge case) as `carried`, `carried-weaker`, `gap`, `later`, `contradicted` or `missing` against the new documents. A fix pass then worked on every row that was not `carried`, following the lead's 28 rulings (R1–R28). This verification re-read the spec text for each of those rows; the fix pass's own report was not relied on. Each row gets one final status:

- `carried` — the spec states the item with its original precision;
- `gap` — carried as a capability that is not built yet, with a change ID and acceptance criteria;
- `deliberate` — changed on purpose, with the reason written in the spec's §9, in DECISIONS (DEC-24 lists the reversals) or in a ruling;
- `later` — in a spec's §7 Later, with a reason;
- `still-missing` / `still-weaker` — the fix pass did not resolve it.

**Row keys.** `HD1:n` and `HD2:n` are rows of the two `HARNESS_DESIGN.md` traces (HD2 also covers `INTEGRATION_REVIEW.md`). `PMFE:n` covers `PM_DESIGN.md` (`PM:line`) and `FRONTEND_DESIGN.md` (`FE:line`). `INV:<unit>` covers the inventories (`FI:line` in `FEATURE_INVENTORY.md`, `R1`/`R2` the re-audits); `O` rows are the original inventory's "features most likely to be overlooked". Rule numbers are §2 item numbers in the named spec.

**Totals.** "Checked" counts rows re-read against the specs; the status columns give their final status. A trace's originally `carried` rows are not re-checked and are not counted here.

| Source | Items traced | Not `carried` in the trace | Checked | `carried` | `gap` | `deliberate` | `later` | `still-weaker` | `still-missing` | Not yet checked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HARNESS_DESIGN (1–1800) | 649 | 136 | 105 | 16 | 21 | 35 | 33 | 0 | 0 | 31 |
| HARNESS_DESIGN (1801–end) and INTEGRATION_REVIEW | 535 | 264 | 129 | 27 | 50 | 17 | 35 | 0 | 0 | 135 |
| PM_DESIGN and FRONTEND_DESIGN | 546 | 197 | 170 | 119 | 7 | 29 | 13 | 2 | 0 | 27 |
| Feature inventories ×3 | 418 | 126 | 72 | 28 | 15 | 16 | 12 | 1 | 0 | 54 |
| **All** | 2,148 | 723 | 476 | 190 | 93 | 97 | 93 | 3 | 0 | 247 |

## 2. Still open

Rows the fix pass did not resolve. More may turn up among the 247 rows that have not been checked yet.

- **PMFE:432** (FE:420) — Persist the Planner's repair plan: dashboard §2.6 reads the re-plan "from the card's dossier", but kernel rule 20's dossier kinds (lesson, note, question, answer, research, review, send_back) have no repair-plan entry, and worker-loop rule 34.3 does not say where the plan is written. **Owner: worker-loop (with kernel).**
- **PMFE:440** (FE:456) — Run reports in `.sekhemet/runs/<startedAt>.json`: no spec says where queue run reports are kept (`.sekhemet/runs/<startedAt>.json`, which the Runs view reads), or squares that file with kernel rule 16 (nothing durable outside the ledger). **Owner: runtime.**
- **INV:X21** (FI:455) — Fixture generator, `createTestWorktree` < 10 ms: DEFINITION_OF_DONE §2D.3 keeps a cheap fixture-repository helper but drops the `createTestWorktree` < 10 ms target, and gives no reason. **Owner: DEFINITION_OF_DONE (ruling R28).**

## 3. Moved to Later (for the owner to confirm)

Each of these is in the named spec's §7 with a reason. Grouped by the spec it now sits in.

**DEC-03** — HD1:41 Cloud models after v1, per role.

**SPINE** — HD1:150 IDE extension and TUI.

**context** — HD1:26 Tree-sitter symbol support in v2; HD1:217 SWE-Pruner line pruning; HD1:236 MLX path; HD1:247 Learned line pruning; HD1:271 0.6B skimmer; HD1:281 Exemplars from fixing commits; HD1:599 Offline prompt optimiser; INV:C3 SWE-Pruner; INV:E9 Prompt evolution loop.

**dashboard** — HD1:144 Rewind from the card view to step N; HD2:312 Native wrapper optional, deferred; HD2:329 Diffs grouped by intent with difftastic; PMFE:288 Saved views on the server; PMFE:308 Goal view; PMFE:503 Bundled fonts; PMFE:534 Retry with planner; PMFE:537 Dependency lines; PMFE:538 Bundled fonts; PMFE:540 Master board, Registry, Goals; PMFE:541 Difftastic intent grouping; INV:U17 Pan-and-zoom DAG; INV:U21 `IBoardUIState`; HD1:188 UI override past a gate.

**design-stage** — HD2:87 Research Desk and Deep Research; HD2:95 Desk on a second slot, no memory; HD2:98 Desk grades; HD2:100 Speculative research (`plan_research`); HD2:101 Prefetch `llms.txt` at project open; HD2:104 Context7, DeepWiki as MCP sources; HD2:106 Deep-research plan approval; HD2:108 Everything fetched lands in the corpus; HD2:111 Adaptive crawl; HD2:120 Crawl4AI sidecar; HD2:121 trafilatura fast path; HD2:122 PDF extraction tools; HD2:127 Persistent project corpus; HD2:128 Per-question corpus; HD2:144 External MCP research answers untrusted; HD2:149 Research playbooks as skills; HD2:150 DeepResearch Bench targets; HD2:151 Desk latency and contradiction measures; HD2:152 Cache TTL by mutability; HD2:153 Stale served, revalidated; INV:X9 Doc cache TTLs.

**extensibility** — HD1:155 Plugin marketplace; HD1:165 Plugin isolation and versioning.

**integrations** — HD1:156 Remote control from a phone; HD1:157 Team-chat entry points; HD2:51 Forgejo: dependencies, boards, webhooks; HD2:63 CI as a gate source; HD2:72 Comment commands; HD2:75 `workflow_dispatch`; HD2:83 Review comments → repair subtasks; HD2:85 Release cards; PMFE:187 Jira and Linear live sync; PMFE:189 Microsoft Teams; PMFE:190 Slack replies; PMFE:191 Sentry, Datadog, PagerDuty; PMFE:192 Notion, Confluence; INV:Y11 Forgejo adapter; INV:Y17 Release cards; INV:Y18 CI via `act`; INV:O84 git-cliff and semver; INV:O85 `act` as gates; INV:O89 `resolveReviewThread`, auto-merge, merge queue.

**models** — HD1:80 llama.cpp / MLX inference.

**planner-pm** — HD1:498 Goal with no state change in a window highlighted; HD1:397 Terminal is the default conversation surface; HD1:398 ClarEval calibration; two failure-mode measures; HD1:445 Steer at the next step boundary; HD1:446 Mid-card scope amendment; HD1:448 Steer cannot relax a gate; HD1:449 Steer recorded; excluded from stats; HD1:450 Steering not needed for correctness; HD1:451 Attached human answers while the Worker holds its slot; HD1:475 Reroute; HD1:476 Explain; HD1:484 `/goal` chat command; HD1:497 Goal view; HD2:489 C6: tuned cap never applied; fresh repos inherit.

**runtime** — HD2:187 Overnight prompt optimiser; HD2:406 `split { strategy }`, `run { budgetOverride }`.

**security** — HD1:93 Air-gap mirrors (npm, devpi, crates).

**worker-loop** — HD1:267 Sketch applied mechanically; HD1:276 Parallel pass@k on L/XL; HD1:301 `repo` incl. releases between versions; HD2:15 Sample cap per hardware tier; HD2:147 Worker research tools incl. `repo`; HD2:256 Images and PDFs to a vision path; HD2:263 ast-grep fallback; INV:O97 ast-grep fallback.

## 4. Deliberate changes

Each of these was changed on purpose, and its reason is recorded where the last column says.

| Row | Item | Reason recorded in |
| --- | --- | --- |
| HD2:313 | Three views are the product; the rest appear when useful | dashboard §9 (five primary views always, for three audiences) |
| HD2:317 | Machine appears only when a run is active | dashboard §9 (always in the System menu) |
| HD2:319 | Insights appears only after enough cards | dashboard §9 (teaching empty state) |
| HD2:320 | Integrations appears when configured | dashboard §9 (always listed) |
| HD2:339 | `@tanstack/virtual` virtualisation | dashboard §9 (own windowing, no build step) |
| HD2:350 | Colour token hex table and APCA figures | dashboard §2.13.1, §9 (values only in `tokens.ts`, held by the contrast test) |
| HD2:357 | Tile: class chip, difficulty, budget bar, dependency count | dashboard §9 (professional tile) |
| PMFE:4 | Three dashes for no priority | dashboard §9 |
| PMFE:11 | Epics never a separate hierarchy screen | dashboard §9 (story map is a view of the cards) |
| PMFE:47 | Model id always in the panel header | dashboard §8.3, §9; R15 |
| PMFE:67 | `#/pm` on `g a` | dashboard §2.3.1, §9 |
| PMFE:87 | Idle cost line names the host model | dashboard §2.7.6, §9; R15 |
| PMFE:124 | Tile row 1 anatomy | dashboard §9 |
| PMFE:125 | Priority glyph at the far left | dashboard §9 (List view scans priority) |
| PMFE:149 | Rails for empty columns | dashboard §9 (chips) |
| PMFE:170 | Integrations on `g s` | dashboard §2.3.1, §9; R17 (`g n`) |
| PMFE:194 | Page-held catalogue on 404 | dashboard §9 |
| PMFE:198 | Insights on `g f` | dashboard §2.3.1, §9 |
| PMFE:314 | Tile class chip, difficulty, budgets | dashboard §9 |
| PMFE:343 | Runs on `g q` | dashboard §2.3.1; R17 (`g u`) |
| PMFE:345 | Playbook on `g p` | dashboard §2.3.1; R17 (`g k`) |
| PMFE:346 | Inbox view on `g i` | dashboard §2.2.1, P11 (merged into Review › Needs you; §9 records the chord change, not a separate reason for the merge) |
| PMFE:352 | 52 px icon rail at 1024–1279 | dashboard §9 |
| PMFE:353 | Phone tabs Review · Board · Runs | dashboard §9 |
| PMFE:359 | Kind mapping incl. Interface → Contract | dashboard §2.12.4; planner-pm §2.2, §9; R9 |
| PMFE:360 | Column names Working/Checking/Closed | dashboard §2.4.1, §8.2; NAMING |
| PMFE:376 | Empty Review ends with `sekhemet queue` | dashboard §2.5.13, §9 |
| PMFE:414 | 36 px rails | dashboard §9 |
| PMFE:425 | Empty board shows CLI commands | dashboard §2.4.10, §9 |
| PMFE:459 | Row 1 kind tag | dashboard §9 |
| PMFE:462 | *Ready · 32-step budget* | dashboard P3, §9 |
| PMFE:463 | Blocked: link icon, dimmed title | dashboard §2.4.4, §9; R11 |
| PMFE:471 | Difficulty on the tile | dashboard §9 |
| PMFE:485 | Disabled at 40% opacity | dashboard §2.13.2, §9 |
| PMFE:492 | Bare `t`, `g q`, `g p` | dashboard §2.3, §9 |
| INV:U3 | Basalt/Sand exact values | dashboard §2.13.1, §9 |
| INV:U13 | Tile components | dashboard §9 |
| HD1:367 | SPIDR Interface = type contracts | planner-pm §2.2, §9 |
| HD1:370 | INVEST before Planning → In Progress | planner-pm §2.4, §9; DEC-24 |
| HD1:379 | Never story points | planner-pm §2.6, §9 |
| HD1:394 | Conversation never evicts a running Worker | planner-pm §2.8.6, §9 |
| HD1:395 | No user profile | planner-pm §2.13.3, §9 |
| HD1:412 | Riskiest assumption first regardless of backbone | design-stage §9; planner-pm §2.2.4 |
| HD1:456 | Questions batched per pass | planner-pm §2.10.1, §9 |
| HD1:457 | > 3 questions rejects the spec | planner-pm §9; DEC-24 |
| HD1:493 | Failure concentration pauses implementation | planner-pm §2.12, §9 |
| HD2:388 | `priority` holds the WSJF score | planner-pm §2.7, §9 |
| PMFE:217 | Everything learned needs approval first | planner-pm §2.13.3, §8.1 (profile statements used at once; rules need approval; awaiting the owner) |
| INV:P8 | Assume/Ask/Spike; batch; > 3 rejects | planner-pm §2.10.1, §9; DEC-24 |
| INV:P11 | Pause & persist | planner-pm §2.10.2–3, §9; DEC-24 |
| INV:X7 | Research note; embeddings only here | design-stage §2.7.8, §9; DEC-22 |
| HD1:122 | LSP expansion stage | context rule 28, §9 |
| HD1:123 | Mask outputs older than 2 steps | context rule 3; DEC-24 |
| HD1:216 | LSP expansion, pooled servers | context rule 28, §9; pool backs tools (worker-loop 12) |
| HD1:221 | Spec and criteria in Zone 4 | context rule 8, §9 (M8) |
| HD1:226 | `run` through the RTK binary | context rule 17 (native condenser; binary on no v1 path) |
| HD1:232 | llama.cpp cache flag values | context rule 6, §9; DEC-24 |
| HD1:233 | `-sps` | context rule 6; DEC-24 |
| HD1:249 | Mask older than the last two | context rule 3; DEC-24 |
| HD1:254 | Traces stripped between steps | context rule 4, §9; DEC-24 |
| HD1:265 | LSP localisation stage | context rule 28, §9 |
| INV:M17 | Prompt-cache configuration | context rule 6; DEC-24 |
| INV:C6 | Masking with pointers | context rule 3; DEC-24 |
| INV:C18 | Traces stripped | context rule 4; DEC-24 |
| INV:O6 | Traces stripped unless flagged | context rule 4; DEC-24 |
| INV:O44 | Cache flags from the machine profile | context rule 6; DEC-24 |
| HD1:162 | Step vs turn terminology | worker-loop §3 Terms; NAMING; R22 |
| HD1:312 | Stall stops at once | worker-loop rule 18, §9 |
| HD1:321 | Six stop reasons | worker-loop rule 31; DEC-24 |
| HD1:325 | Rung 3: narrow or escalate | worker-loop rule 34.3, §7, §9 |
| HD1:348 | `replace_all`, exact whitespace | worker-loop rule 12, §9 |
| HD2:274 | Parse gate on tree-sitter | gates §9; DEC-20 |
| HD1:163 | Turn-flow event names | kernel §3 closing note (never the code's; mapped) |
| HD1:200 | In Progress entry incl. "plan exists" | kernel rule 27, §8 Q6 (recommendation awaiting the owner) |
| HD2:154 | Every extension a kernel plugin | extensibility; DEC-09 |
| HD2:377 | Seven actors | kernel rule 19, §9 |
| INV:K17 | Steps `success`, `tokens_condensed` | kernel rule 6 (not stored, with the reason) |
| HD2:49 | Whole-card last-writer-wins | integrations §2.4 |
| HD2:64 | Mid-card scope edit pauses the card | integrations §2.5, §9 (R6), INT-11a |
| HD2:67 | Keys only in the OS keychain | integrations §2.10; security item 35 |
| INV:Y20 | Mid-card edit reconciliation | integrations §2.5, §9 (R6) |
| INV:O92 | LWW by timestamp | integrations §2.4 |
| HD2:307 | kWh from TDP × utilisation | runtime rule 18, §7, §9 |
| HD2:343 | WebSocket at `/stream` | runtime rule 25, §9 |
| INV:X25 | Suite under 3 s | DEFINITION_OF_DONE §2D.4 |
| HD1:11 | A feature that serves none of the six paragraphs is a candidate for deletion | SPINE §Where the edge is (the test is now "serves one of the three edges"; DEC-01) |
| HD1:13 | Target user: solo developer | DEC-01 |
| HD1:28 | Non-goals: teams, multi-user boards, RBAC, SSO | DEC-06 (company-server minimum in v1; RBAC and SSO stay out) |
| HD1:78 | Parity claim against the top five | specs/README "Where the old design went" (dated competitor columns removed) |
| HD1:119 | TypeScript SDK with async-iterator streams | extensibility rule 28, §8 Q1 ("changed from the old design's shipped SDK") |
| HD1:124 | Copy-on-write worktrees | DEC-21 (plain worktrees) |
| HD1:125 | Checkpoint on every passing step | review-git rule 3, §9 (every step that changed files; R1) |
| HD1:136 | "5-second acceptance" with difftastic | review-git rule 2, §9 (a decision in under a minute); structural diff rule 6 (partial, S5) |
| HD1:158 | Every capability a plugin claiming a service key | extensibility rule 29; DEC-09 (the cut of `container.ts` itself awaits the owner, DEC-09 correction) |
| HD2:177 | Checkpoints at gate passes and masking boundaries | review-git rule 3, §9 (R1); runtime rule 11 links to it |
| INV:Y3 | Commit after gate passes and masking boundaries | review-git rule 3, §9 (R1) |
| INV:O30 | Checkpoint at gate passes and masking boundaries | review-git rule 3, §9 (R1) |

## 5. Checked rows, grouped by the spec that owns them

Columns: row key · old location · item · final status · where it lives now.

### 5.1 Dashboard

| Row | Old | Item | Final | Now in |
| --- | --- | --- | --- | --- |
| HD1:37 | HD:115 | Teaching beginners; Learn layer | gap | dashboard §2.9, P4 |
| HD1:144 | HD:347 | Rewind from the card view to step N | later | dashboard §7 (CLI built) |
| HD1:498 | HD:1299 | Goal with no state change in a window highlighted | later | planner-pm §7 (goal view) |
| HD2:312 | HD:2623 | Native wrapper optional, deferred | later | dashboard §7 |
| HD2:313 | HD:2625 | Three views are the product; the rest appear when useful | deliberate | dashboard §9 (five primary views always, for three audiences) |
| HD2:317 | HD:2635 | Machine appears only when a run is active | deliberate | dashboard §9 (always in the System menu) |
| HD2:319 | HD:2640 | Insights appears only after enough cards | deliberate | dashboard §9 (teaching empty state) |
| HD2:320 | HD:2641 | Integrations appears when configured | deliberate | dashboard §9 (always listed) |
| HD2:325 | HD:2652 | One `g` chord per visible view, first letter | gap | dashboard §2.3.1, P11 |
| HD2:326 | HD:2654 | No bare single-key destructive binding | gap | dashboard §2.3.2, P11 |
| HD2:329 | HD:2660 | Diffs grouped by intent with difftastic | later | dashboard §7 |
| HD2:339 | HD:2676 | `@tanstack/virtual` virtualisation | deliberate | dashboard §9 (own windowing, no build step) |
| HD2:341 | HD:2678 | Overscan of 3 cards | carried | dashboard §2.4.9 |
| HD2:342 | HD:2679 | 500+ cards, < 50 MB DOM | carried | dashboard §2.4.9, §6 |
| HD2:344 | HD:2683 | Reload reproduces state from the log | carried | dashboard §2.4.8, P3; runtime 25a |
| HD2:350 | HD:2707 | Colour token hex table and APCA figures | deliberate | dashboard §2.13.1, §9 (values only in `tokens.ts`, held by the contrast test) |
| HD2:351 | HD:2725 | 7:1 body text | carried | dashboard §2.14.1, P12 |
| HD2:357 | HD:2759 | Tile: class chip, difficulty, budget bar, dependency count | deliberate | dashboard §9 (professional tile) |
| HD2:361 | HD:2765 | Machine: tier, models, sparklines, cache hit rate | gap | dashboard §2.11 (sparklines built); tier NEW-dashboard-2 |
| HD2:460 | HD:3539 | `MODEL_MATRIX.md` bake-off results | carried | models §3, §4 |
| HD2:476 | IR:128 | B4: three outcome stores; attempt hard-coded to 1 | gap | worker-loop rule 39, NEW-worker-loop-5 |
| PMFE:4 | PM:20 | Three dashes for no priority | deliberate | dashboard §9 |
| PMFE:8 | PM:21 | Points summed per column | carried | dashboard §2.4.3, P3 |
| PMFE:11 | PM:22 | Epics never a separate hierarchy screen | deliberate | dashboard §9 (story map is a view of the cards) |
| PMFE:26 | PM:36 | Percentiles because flow data is skewed | carried | dashboard §2.10 |
| PMFE:30 | PM:39 | Aged dots labelled in words | carried | dashboard §2.10.2 |
| PMFE:36 | PM:47 | PM presence line | carried | dashboard §2.7.2 |
| PMFE:40 | PM:49 | Tool use as quiet, collapsed detail | carried | dashboard §2.7.3, §2.7.8 |
| PMFE:47 | PM:62 | Model id always in the panel header | deliberate | dashboard §8.3, §9; R15 |
| PMFE:48 | PM:64 | Avatar 24 px, 600 weight | carried | dashboard §2.7.2 |
| PMFE:67 | PM:157 | `#/pm` on `g a` | deliberate | dashboard §2.3.1, §9 |
| PMFE:69 | PM:181 | Message time in 11 px | carried | dashboard §2.7.3 |
| PMFE:79 | PM:191 | Run and evidence cite targets | carried | dashboard §2.7.4 |
| PMFE:86 | PM:200 | Cost line names the step and ETA | carried | dashboard §2.7.6 |
| PMFE:87 | PM:201 | Idle cost line names the host model | deliberate | dashboard §2.7.6, §9; R15 |
| PMFE:91 | PM:224 | Field diff label 96 px, value 500 weight | carried | dashboard §2.7.7 |
| PMFE:96 | PM:226 | Reorder and move renderings | carried | dashboard §2.7.7 |
| PMFE:105 | PM:249 | Waiting block explanation | carried | dashboard §2.7.8 |
| PMFE:111 | PM:263 | Pending row states, 1 s tick, no motion | carried | dashboard §2.7.8 |
| PMFE:115 | PM:269 | Worker-paused shell bar, `Open Seshat`, lapis | carried | dashboard §2.2.4 |
| PMFE:124 | PM:292 | Tile row 1 anatomy | deliberate | dashboard §9 |
| PMFE:125 | PM:300 | Priority glyph at the far left | deliberate | dashboard §9 (List view scans priority) |
| PMFE:126 | PM:302 | Unlit bars `--border-strong` | carried | dashboard §2.4.4 |
| PMFE:138 | PM:333 | Saved view `{ name, query, group, layout }` | carried | dashboard §2.4.11, §3 |
| PMFE:140 | PM:335 | Cycle "in force" definition, filter suppression | carried | dashboard §2.4.13 |
| PMFE:141 | PM:342 | Cycle bar segment colours | carried | dashboard §2.4.13 |
| PMFE:149 | PM:353 | Rails for empty columns | deliberate | dashboard §9 (chips) |
| PMFE:154 | PM:366 | List row alignment | carried | dashboard §2.4.15 |
| PMFE:156 | PM:368 | Sortable header buttons, reversal | carried | dashboard §2.4.15 |
| PMFE:159 | PM:371 | Labels menu with *Create label* | carried | dashboard §2.4.15 |
| PMFE:160 | PM:372 | Due presets | carried | dashboard §2.4.15 |
| PMFE:164 | PM:379 | Bulk bar geometry and colours | carried | dashboard §2.4.16 |
| PMFE:170 | PM:390 | Integrations on `g s` | deliberate | dashboard §2.3.1, §9; R17 (`g n`) |
| PMFE:172 | PM:392 | Integrations in Now/Next/Later | carried | dashboard §2.11 (by API `tier`), NEW-dashboard-2 |
| PMFE:174 | PM:398 | *Syncing with GitHub…* | carried | dashboard §2.11 |
| PMFE:184 | PM:404 | Import preview posted to the thread; sheet says so | carried | dashboard §2.11, §3 |
| PMFE:194 | PM:420 | Page-held catalogue on 404 | deliberate | dashboard §9 |
| PMFE:198 | PM:440 | Insights on `g f` | deliberate | dashboard §2.3.1, §9 |
| PMFE:204 | PM:462 | CFD band colours | carried | dashboard §2.10.2 |
| PMFE:208 | PM:476 | Capability rows by attempts | carried | dashboard §2.10.3 |
| PMFE:210 | PM:477 | Caption counts rough rows | carried | dashboard §2.10.3 |
| PMFE:212 | PM:478 | Sparse buckets faded | carried | dashboard §2.10.3 |
| PMFE:213 | PM:478 | Server `note` verbatim | carried | dashboard §2.10.3 |
| PMFE:214 | PM:479 | Capability 404, empty, independent | carried | dashboard §2.10.3 |
| PMFE:219 | PM:487 | Playbook lede | carried | dashboard §2.11 |
| PMFE:220 | PM:489 | Candidates newest first | carried | dashboard §2.11 |
| PMFE:221 | PM:490 | Retirement proposals first, Retire promoted, by value | carried | dashboard §2.11 |
| PMFE:222 | PM:491 | Retired collapsed | carried | dashboard §2.11 |
| PMFE:224 | PM:495 | Rule source in words and age | carried | dashboard §2.11 |
| PMFE:226 | PM:497 | Signed value bar | carried | dashboard §2.11 |
| PMFE:227 | PM:498 | First two signals, *n more* | carried | dashboard §2.11 |
| PMFE:228 | PM:501 | Inline edit keys | carried | dashboard §2.11 |
| PMFE:229 | PM:501 | Optimistic actions state the result | carried | dashboard §2.11 |
| PMFE:230 | PM:501 | `/api/learning` 404 fallback | carried | dashboard §2.11 |
| PMFE:231 | PM:503 | Reach picker and footer | carried | dashboard §2.11 |
| PMFE:233 | PM:503 | Seeded rules read-only | carried | dashboard §2.11 |
| PMFE:238 | PM:517 | Profile statements strongest first | carried | dashboard §2.11 |
| PMFE:240 | PM:519 | Dismissed statements collapsed | carried | dashboard §2.11 |
| PMFE:241 | PM:521 | `#/pm` rail link and note | carried | dashboard §2.7.1 |
| PMFE:244 | PM:526 | Stopping-policy table columns | carried | dashboard §2.10.4 |
| PMFE:246 | PM:528 | Failed-check limit note | carried | dashboard §2.10.4 |
| PMFE:247 | PM:529 | Replay caveat incl. looser caps | carried | dashboard §2.10.4 |
| PMFE:248 | PM:530 | Replay grid behind a disclosure | carried | dashboard §2.10.4 |
| PMFE:249 | PM:532 | Already best: no command | carried | dashboard §2.10.4 |
| PMFE:251 | PM:538 | Machine models: order, mono id, state, description | carried | dashboard §2.11 |
| PMFE:252 | PM:538 | Shared note said once | carried | dashboard §2.11 |
| PMFE:253 | PM:539 | Memory model line, `coResident`, ~40 s | carried | dashboard §2.11 |
| PMFE:258 | PM:544 | Sources list; no-URL cite as text | carried | dashboard §2.7.4, §3 |
| PMFE:265 | PM:590 | Priority bars stroke 3 | carried | dashboard §2.4.4 |
| PMFE:266 | PM:594 | Panel sizes, composer ≥ 44 | carried | dashboard §2.7.1, §2.13.7 |
| PMFE:267 | PM:595 | Proposal group styling | carried | dashboard §2.7.7 |
| PMFE:268 | PM:596 | Pending block rows | carried | dashboard §2.7.8 |
| PMFE:269 | PM:597 | View bar 40/16/8 | carried | dashboard §2.4.11 |
| PMFE:274 | PM:606 | Panel landmark label | carried | dashboard §2.14.3 |
| PMFE:276 | PM:608 | `aria-busy` on the current row | carried | dashboard §2.14.3 |
| PMFE:280 | PM:612 | List `table`, `aria-sort` | carried | dashboard §2.14.3 |
| PMFE:288 | PM:642 | Saved views on the server | later | dashboard §7 |
| PMFE:296 | FE:34 | No synthesised `parse: pass` | carried | dashboard §2.4.4, NEW-dashboard-1 |
| PMFE:299 | FE:36 | Hash the real `gates.toml` | gap | gates T1 (GT-T1-10, GT-T1-13) |
| PMFE:301 | FE:46 | Master board with hardware load | carried | dashboard §2.11 Workspace; beyond rollup later §7 |
| PMFE:308 | FE:53 | Goal view | later | dashboard §7, planner-pm §7 |
| PMFE:314 | FE:60 | Tile class chip, difficulty, budgets | deliberate | dashboard §9 |
| PMFE:326 | FE:72 | Overscan 3 | carried | dashboard §2.4.9 |
| PMFE:331 | FE:86 | No `prefers-color-scheme` default | carried | dashboard §2.1.3 |
| PMFE:339 | FE:122 | Project switcher, count badges | carried | dashboard §2.2.1 |
| PMFE:343 | FE:147 | Runs on `g q` | deliberate | dashboard §2.3.1; R17 (`g u`) |
| PMFE:345 | FE:150 | Playbook on `g p` | deliberate | dashboard §2.3.1; R17 (`g k`) |
| PMFE:346 | FE:151 | Inbox view on `g i` | deliberate | dashboard §2.2.1, P11 (merged into Review › Needs you; §9 records the chord change, not a separate reason for the merge) |
| PMFE:347 | FE:152 | Settings view | gap | dashboard §2.11, NEW-dashboard-4 (R18) |
| PMFE:352 | FE:162 | 52 px icon rail at 1024–1279 | deliberate | dashboard §9 |
| PMFE:353 | FE:163 | Phone tabs Review · Board · Runs | deliberate | dashboard §9 |
| PMFE:359 | FE:183 | Kind mapping incl. Interface → Contract | deliberate | dashboard §2.12.4; planner-pm §2.2, §9; R9 |
| PMFE:360 | FE:191 | Column names Working/Checking/Closed | deliberate | dashboard §2.4.1, §8.2; NAMING |
| PMFE:361 | FE:200 | `Pass@1` only as a mono label | carried | dashboard §2.11 Runs |
| PMFE:362 | FE:201 | *Passed after a planner retry* | carried | dashboard §2.12.4 |
| PMFE:365 | FE:214 | Size sentence | carried | dashboard §2.12.4 |
| PMFE:369 | FE:223 | Ledger integrity copy and action | carried | dashboard §2.2.3–4 |
| PMFE:376 | FE:247 | Empty Review ends with `sekhemet queue` | deliberate | dashboard §2.5.13, §9 |
| PMFE:377 | FE:248 | Empty copy per column | carried | dashboard §2.4.10 |
| PMFE:386 | FE:268 | Memory pause `Machine` action | carried | dashboard §2.2.4 |
| PMFE:392 | FE:303 | Review queue row, selected styling | carried | dashboard §2.5.2 |
| PMFE:394 | FE:307 | Attempt selector disabled with one attempt | carried | dashboard §2.5.3 |
| PMFE:396 | FE:317 | *All gates passed…* sentence | carried | dashboard §2.5.8 |
| PMFE:401 | FE:327 | Triage hint | carried | dashboard §2.5.9 |
| PMFE:409 | FE:353 | Empty queue glyph, rail hidden | carried | dashboard §2.5.13 |
| PMFE:414 | FE:368 | 36 px rails | deliberate | dashboard §9 |
| PMFE:418 | FE:374 | Review and Parked by wait time | carried | dashboard §2.4.2, P3 |
| PMFE:421 | FE:380 | `c` creates a card | gap | dashboard §2.4.7, P3 |
| PMFE:424 | FE:384 | Live patches; focus follows | carried | dashboard §2.4.8, P3 |
| PMFE:425 | FE:388 | Empty board shows CLI commands | deliberate | dashboard §2.4.10, §9 |
| PMFE:432 | FE:420 | Persist the Planner's repair plan | **still-weaker** | see §2 |
| PMFE:436 | FE:445 | Runs headline blocks | carried | dashboard §2.11 |
| PMFE:437 | FE:451 | Timeline fill and labels | carried | dashboard §2.11 |
| PMFE:438 | FE:452 | Runs cards table columns | carried | dashboard §2.11 |
| PMFE:445 | FE:475 | Memory gauge details | carried | dashboard §2.11 |
| PMFE:446 | FE:476 | Model endpoint, keep-alive | carried | dashboard §2.11 |
| PMFE:448 | FE:480 | 15 s cache, `?fresh=1` | carried | dashboard §2.11 |
| PMFE:450 | FE:658 | `card/step` event shape | carried | dashboard §3; kernel §3 |
| PMFE:458 | FE:500 | Tile padding and gap (264 px width) | carried | dashboard §2.4.4; width follows fluid columns §2.4.2 |
| PMFE:459 | FE:504 | Row 1 kind tag | deliberate | dashboard §9 |
| PMFE:462 | FE:516 | *Ready · 32-step budget* | deliberate | dashboard P3, §9 |
| PMFE:463 | FE:517 | Blocked: link icon, dimmed title | deliberate | dashboard §2.4.4, §9; R11 |
| PMFE:471 | FE:529 | Difficulty on the tile | deliberate | dashboard §9 |
| PMFE:473 | FE:540 | At-capacity copy | carried | dashboard §2.4.3 |
| PMFE:476 | FE:547 | Passed gate raw log | carried | dashboard §2.5.4 |
| PMFE:481 | FE:572 | Annotation `role="note"` | carried | dashboard §2.5.6 |
| PMFE:483 | FE:580 | Button variants | carried | dashboard §2.13.7 |
| PMFE:484 | FE:586 | Button sizes | carried | dashboard §2.13.7 |
| PMFE:485 | FE:586 | Disabled at 40% opacity | deliberate | dashboard §2.13.2, §9 |
| PMFE:487 | FE:601 | Scorecard block type | carried | dashboard §2.11 |
| PMFE:488 | FE:605 | Machine component sizes | carried | dashboard §2.11, §2.13.7 |
| PMFE:490 | FE:621 | Toast roles | carried | dashboard §2.13.7 |
| PMFE:492 | FE:635 | Bare `t`, `g q`, `g p` | deliberate | dashboard §2.3, §9 |
| PMFE:494 | FE:653 | `card.display` shape | carried | dashboard §2.15.2, §3 |
| PMFE:495 | FE:654 | `/api/gates` shape with `empty` | carried | dashboard §3 |
| PMFE:498 | FE:663 | `/api/meta` fields | carried | dashboard §3 |
| PMFE:501 | FE:667 | One vocabulary module | gap | dashboard §2.12.1, NEW-dashboard-2 |
| PMFE:503 | FE:694 | Bundled fonts | later | dashboard §7 |
| PMFE:505 | FE:714 | Per-component spacing | carried | dashboard §2.13.7 and inline |
| PMFE:511 | FE:788 | Selection vs focus; list left bar | carried | dashboard §2.4.4, §2.4.15 |
| PMFE:513 | FE:801 | Contrast rules and test | gap | dashboard §2.14.1, P12 |
| PMFE:515 | FE:814 | Targets, 200% zoom | gap | dashboard §2.14.5, P12 |
| PMFE:519 | FE:838 | Contrast test thresholds | gap | dashboard §2.14.1, P12 |
| PMFE:526 | FE:850 | API park visible within 1 s | carried | dashboard §2.4.8, §6 |
| PMFE:534 | FE:891 | Retry with planner | later | dashboard §7 |
| PMFE:537 | FE:894 | Dependency lines | later | dashboard §7 |
| PMFE:538 | FE:895 | Bundled fonts | later | dashboard §7 |
| PMFE:539 | FE:896 | Sparklines (was Later) | carried | dashboard §2.11, §6 (built) |
| PMFE:540 | FE:897 | Master board, Registry, Goals | later | dashboard §7; Registry built |
| PMFE:541 | FE:898 | Difftastic intent grouping | later | dashboard §7 |
| INV:E4 | FI:346 | `MODEL_MATRIX.md` | carried | models §3, §4 |
| INV:U3 | FI:373 | Basalt/Sand exact values | deliberate | dashboard §2.13.1, §9 |
| INV:U6 | FI:376 | Virtualisation | carried | dashboard §2.4.9 |
| INV:U13 | FI:383 | Tile components | deliberate | dashboard §9 |
| INV:U17 | FI:387 | Pan-and-zoom DAG | later | dashboard §7 (layered layout built) |
| INV:U18 | FI:388 | Sparklines | carried | dashboard §2.11, §4 (R23) |
| INV:U21 | FI:391 | `IBoardUIState` | later | dashboard §7 |

### 5.2 Planner and PM

| Row | Old | Item | Final | Now in |
| --- | --- | --- | --- | --- |
| HD1:38 | HD:116 | Non-developers start a project by conversation | gap | planner-pm §2.9, P2; design-stage P2 |
| HD1:266 | HD:688 | Edit sketch contents | carried | planner-pm §2.1.9, P1 |
| HD1:367 | HD:898 | SPIDR Interface = type contracts | deliberate | planner-pm §2.2, §9 |
| HD1:370 | HD:904 | INVEST before Planning → In Progress | deliberate | planner-pm §2.4, §9; DEC-24 |
| HD1:375 | HD:912 | Small: ≤ 25% of working context, ≤ 40 steps | carried | planner-pm §2.4, §6 |
| HD1:379 | HD:923 | Never story points | deliberate | planner-pm §2.6, §9 |
| HD1:394 | HD:956 | Conversation never evicts a running Worker | deliberate | planner-pm §2.8.6, §9 |
| HD1:395 | HD:957 | No user profile | deliberate | planner-pm §2.13.3, §9 |
| HD1:397 | HD:962 | Terminal is the default conversation surface | later | planner-pm §7 |
| HD1:398 | HD:964 | ClarEval calibration; two failure-mode measures | later | planner-pm §7 |
| HD1:412 | HD:1020 | Riskiest assumption first regardless of backbone | deliberate | design-stage §9; planner-pm §2.2.4 |
| HD1:414 | HD:1026 | Without a model, the spec's own words | carried | planner-pm §2.1.2, P1 |
| HD1:438 | HD:1075 | Not built: riskiest scheduling, model phrasing, deep research | gap | planner-pm P1; design-stage NEW-design-stage-1, P7 |
| HD1:445 | HD:1113 | Steer at the next step boundary | later | planner-pm §7 |
| HD1:446 | HD:1114 | Mid-card scope amendment | later | planner-pm §7 |
| HD1:448 | HD:1119 | Steer cannot relax a gate | later | planner-pm §7 |
| HD1:449 | HD:1120 | Steer recorded; excluded from stats | later | planner-pm §7 |
| HD1:450 | HD:1121 | Steering not needed for correctness | later | planner-pm §7 |
| HD1:451 | HD:1127 | Attached human answers while the Worker holds its slot | later | planner-pm §7 |
| HD1:453 | HD:1132 | Pause & Persist: park, free memory | carried | planner-pm §2.10.3 (`default_deny`) |
| HD1:454 | HD:1134 | Resume on a late answer | carried | planner-pm §2.10.3, §6 |
| HD1:456 | HD:1142 | Questions batched per pass | deliberate | planner-pm §2.10.1, §9 |
| HD1:457 | HD:1142 | > 3 questions rejects the spec | deliberate | planner-pm §9; DEC-24 |
| HD1:469 | HD:1192 | Standup includes the next window's plan | gap | planner-pm §2.7.8, P6 |
| HD1:475 | HD:1205 | Reroute | later | planner-pm §7 |
| HD1:476 | HD:1206 | Explain | later | planner-pm §7 |
| HD1:477 | HD:1207 | Pause project | gap | runtime §2.17a, NEW-runtime-10 |
| HD1:484 | HD:1251 | `/goal` chat command | later | planner-pm §7 |
| HD1:486 | HD:1266 | Goal criteria re-evaluated on close and on a timer | gap | planner-pm §2.11.3, NEW-planner-pm-4 |
| HD1:487 | HD:1266 | Replan on dependency or environment change | gap | planner-pm §2.11.3, NEW-planner-pm-4 |
| HD1:491 | HD:1289 | Congestion signal flags model degradation | gap | planner-pm §2.12, NEW-planner-pm-5 |
| HD1:493 | HD:1291 | Failure concentration pauses implementation | deliberate | planner-pm §2.12, §9 |
| HD1:497 | HD:1299 | Goal view | later | planner-pm §7; dashboard §7 |
| HD2:388 | HD:2925 | `priority` holds the WSJF score | deliberate | planner-pm §2.7, §9 |
| HD2:394 | HD:3005 | Decision request fields incl. `delivered_at` | gap | planner-pm §2.10.2, P2; non-blocking `ask` NEW-worker-loop-4 |
| HD2:433 | HD:3398 | Some mechanisms are packages, not cards | carried | planner-pm §2.1.10, P1 |
| HD2:474 | IR:119 | B2: reflection ran before the retries | carried | planner-pm §2.8.13 (built) |
| HD2:489 | IR:170 | C6: tuned cap never applied; fresh repos inherit | later | planner-pm §7 |
| PMFE:55 | PM:75 | Long answers use the standup shape | carried | planner-pm §2.8.2 |
| PMFE:57 | PM:84 | Sample exchange: standup | carried | planner-pm §2.8.17 |
| PMFE:58 | PM:96 | Sample: why did it fail | carried | planner-pm §2.8.17 |
| PMFE:59 | PM:112 | Sample: split; parent to Won't do | carried | planner-pm §2.8.17, §2.3.3 |
| PMFE:61 | PM:138 | Sample: what's at risk, incl. *Not at risk* | carried | planner-pm §2.8.2, §2.8.17 |
| PMFE:217 | PM:485 | Everything learned needs approval first | deliberate | planner-pm §2.13.3, §8.1 (profile statements used at once; rules need approval; awaiting the owner) |
| PMFE:237 | PM:516 | Profile lock line | carried | dashboard §2.11 |
| INV:P8 | FI:316 | Assume/Ask/Spike; batch; > 3 rejects | deliberate | planner-pm §2.10.1, §9; DEC-24 |
| INV:P11 | FI:319 | Pause & persist | deliberate | planner-pm §2.10.2–3, §9; DEC-24 |
| INV:P16 | FI:324 | Process profiles | carried | planner-pm §2.7.3 (not in §4) |
| INV:P19 | FI:327 | Goal loop | gap | planner-pm §4 (partial), NEW-planner-pm-4 |
| INV:P20 | FI:328 | Seven signals | gap | planner-pm §4 (partial), NEW-planner-pm-5 |

### 5.3 Design stage and research

| Row | Old | Item | Final | Now in |
| --- | --- | --- | --- | --- |
| HD2:87 | HD:1989 | Research Desk and Deep Research | later | design-stage §7 (Desk); Deep research §2.7.3 |
| HD2:95 | HD:2016 | Desk on a second slot, no memory | later | design-stage §7 |
| HD2:97 | HD:2022 | Research cache record | carried | design-stage §2.7.2, §3 |
| HD2:98 | HD:2027 | Desk grades | later | design-stage §7 |
| HD2:100 | HD:2036 | Speculative research (`plan_research`) | later | design-stage §7 |
| HD2:101 | HD:2038 | Prefetch `llms.txt` at project open | later | design-stage §7 |
| HD2:104 | HD:2054 | Context7, DeepWiki as MCP sources | later | design-stage §7 |
| HD2:106 | HD:2076 | Deep-research plan approval | later | design-stage §7 |
| HD2:108 | HD:2078 | Everything fetched lands in the corpus | later | design-stage §7 |
| HD2:110 | HD:2080 | Sub-question closing and re-dispatch | gap | design-stage §2.7.3, NEW-design-stage-4 |
| HD2:111 | HD:2080 | Adaptive crawl | later | design-stage §7 |
| HD2:112 | HD:2084 | What each effort level controls | gap | design-stage §2.7.3, NEW-design-stage-4 |
| HD2:114 | HD:2088 | SearXNG: no keys, no logging, separate service | carried | design-stage §2.7.11; PROVENANCE |
| HD2:116 | HD:2088 | Every query logged | gap | design-stage §2.6.3, S8 |
| HD2:119 | HD:2092 | Per-project allowlist and denylist | gap | design-stage §2.6.3, NEW-design-stage-4 |
| HD2:120 | HD:2092 | Crawl4AI sidecar | later | design-stage §7 |
| HD2:121 | HD:2092 | trafilatura fast path | later | design-stage §7 |
| HD2:122 | HD:2094 | PDF extraction tools | later | design-stage §7 |
| HD2:123 | HD:2096 | Heading chunks, dedup by content hash | carried | design-stage §2.7.8 |
| HD2:127 | HD:2108 | Persistent project corpus | later | design-stage §7 |
| HD2:128 | HD:2109 | Per-question corpus | later | design-stage §7 |
| HD2:131 | HD:2120 | Citations matched by URL or normalised title | gap | design-stage §2.7.4, NEW-design-stage-2 |
| HD2:132 | HD:2121 | Contested claims reported | gap | design-stage §2.7.4–5, NEW-design-stage-2 |
| HD2:135 | HD:2126 | Claim gate in `gates.toml`, hash-pinned | gap | design-stage §2.7.4; gates 27a, NEW-gates-5; NEW-design-stage-2 |
| HD2:136 | HD:2132 | Grounded risk vector; revision rule | gap | design-stage §2.7.5, NEW-design-stage-2 |
| HD2:137 | HD:2134 | Critique loop stopping rule | gap | design-stage §2.7.5, NEW-design-stage-2 |
| HD2:138 | HD:2136 | No citation-repair turn; Review entry | gap | design-stage §2.7.5, NEW-design-stage-2 |
| HD2:143 | HD:2149 | Claim scripts: no network, no repo writes | gap | design-stage §2.7.4, NEW-design-stage-2 |
| HD2:144 | HD:2150 | External MCP research answers untrusted | later | design-stage §7 |
| HD2:149 | HD:2161 | Research playbooks as skills | later | design-stage §7 |
| HD2:150 | HD:2165 | DeepResearch Bench targets | later | design-stage §7 (targets kept) |
| HD2:151 | HD:2165 | Desk latency and contradiction measures | later | design-stage §7 |
| HD2:152 | HD:2169 | Cache TTL by mutability | later | design-stage §7 (values identical) |
| HD2:153 | HD:2182 | Stale served, revalidated | later | design-stage §7 |
| HD2:493 | IR:181 | D2: no single place for what is known about a card | carried | kernel rule 20 (dossier, built) |
| INV:X6 | FI:440 | Fetch and extraction pipeline | carried | design-stage §2.6.3, §2.7.2, §2.7.8; libraries §7 |
| INV:X7 | FI:441 | Research note; embeddings only here | deliberate | design-stage §2.7.8, §9; DEC-22 |
| INV:X9 | FI:443 | Doc cache TTLs | later | design-stage §7 |

### 5.4 Context

| Row | Old | Item | Final | Now in |
| --- | --- | --- | --- | --- |
| HD1:26 | HD:56 | Tree-sitter symbol support in v2 | later | context §7; DEC-20 |
| HD1:89 | HD:230 | RTK and pruner savings claims | carried | context rule 17, §9 (R2 ≥ 60%); pruner DEC-21 |
| HD1:122 | HD:307 | LSP expansion stage | deliberate | context rule 28, §9 |
| HD1:123 | HD:307 | Mask outputs older than 2 steps | deliberate | context rule 3; DEC-24 |
| HD1:214 | HD:549 | Identifier weighting in the repo map | gap | context rule 13, NEW-context-5 |
| HD1:215 | HD:549 | Content hash in the map cache key | gap | context rule 13, NEW-context-5 |
| HD1:216 | HD:550 | LSP expansion, pooled servers | deliberate | context rule 28, §9; pool backs tools (worker-loop 12) |
| HD1:217 | HD:551 | SWE-Pruner line pruning | later | context §7; DEC-21 |
| HD1:221 | HD:563 | Spec and criteria in Zone 4 | deliberate | context rule 8, §9 (M8) |
| HD1:226 | HD:573 | `run` through the RTK binary | deliberate | context rule 17 (native condenser; binary on no v1 path) |
| HD1:228 | HD:579 | Condensing savings tracked | gap | context rule 17, NEW-context-5 |
| HD1:232 | HD:590 | llama.cpp cache flag values | deliberate | context rule 6, §9; DEC-24 |
| HD1:233 | HD:590 | `-sps` | deliberate | context rule 6; DEC-24 |
| HD1:236 | HD:592 | MLX path | later | context §7; models §7 |
| HD1:238 | HD:593 | Low hit rate alerts the operator | gap | context rule 7, M8 |
| HD1:247 | HD:619 | Learned line pruning | later | context §7 |
| HD1:249 | HD:626 | Mask older than the last two | deliberate | context rule 3; DEC-24 |
| HD1:254 | HD:631 | Traces stripped between steps | deliberate | context rule 4, §9; DEC-24 |
| HD1:265 | HD:683 | LSP localisation stage | deliberate | context rule 28, §9 |
| HD1:271 | HD:700 | 0.6B skimmer | later | context §7 |
| HD1:281 | HD:726 | Exemplars from fixing commits | later | context §7 |
| HD1:599 | HD:1635 | Offline prompt optimiser | later | context §7 |
| HD1:600 | HD:1639 | Version change triggers re-qualification | gap | context rule 27, NEW-context-6 |
| HD2:59 | HD:1905 | Reads `AGENTS.md`/`CLAUDE.md` into Zone 2 | carried | context rule 8, CX-8 |
| HD2:409 | HD:3121 | Deterministic, byte-identical, hit > 85% | gap | context rules 1, 7; M8 |
| HD2:462 | IR:57 | A1: no single allocator | gap | context rule 10a, NEW-context-3 |
| HD2:463 | IR:63 | A2: tools described twice | carried | context rule 10b, CX-7 |
| HD2:464 | IR:68 | A3: one fact from four places | gap | context rule 24c, NEW-context-4 |
| HD2:466 | IR:83 | A5: learned rules written to `playbook.toml` | carried | context rule 24a, CX-9 |
| HD2:470 | IR:100 | A8: working-memory truncation drops Seshat's answer | gap | context rule 26, NEW-context-3 |
| HD2:472 | IR:108 | A10: other roles unbudgeted; front truncation | gap | context rule 10c, NEW-context-3 |
| HD2:480 | IR:137 | B5: PM rules never written or read | gap | context rule 24d, NEW-context-4 |
| HD2:486 | IR:158 | C3: adapters per role on the same weights | gap | models NEW-models-9 (MD-N9-1) |
| HD2:496 | IR:196 | E1: reasoning stripped 8×; JSON regex 4× | gap | models MD-N4-8, NEW-models-4 |
| HD2:504 | IR:208 | E3: dead code list | carried | context CX-M1-8, §4, rule 24e (`FileEvidenceStore` is reachable from `execute.ts`) |
| HD2:512 | IR:225 | Suggestion 7: one allocator for every role | gap | context rule 10a, NEW-context-3 |
| HD2:523 | IR:255 | Target allocator with fact keys | gap | context rules 10a–c, 24c; NEW-context-3, -4 |
| HD2:524 | IR:256 | Target Worker priority order; 3–5 rules | gap | context rule 10a, NEW-context-3; rule count §8.3 |
| HD2:528 | IR:276 | Rule lifecycle with in-run probation | gap | context rule 24f, NEW-context-4 (R12) |
| PMFE:82 | PM:193 | Why the context chip exists | carried | dashboard §2.7.5 |
| INV:M17 | FI:151 | Prompt-cache configuration | deliberate | context rule 6; DEC-24 |
| INV:M18 | FI:152 | Hit-rate defect and alert | gap | context rule 7, M8 |
| INV:C1 | FI:207 | Repo map | gap | context rule 13, NEW-context-5 |
| INV:C2 | FI:208 | LSP client pool | carried | worker-loop rule 12, §4 (built) |
| INV:C3 | FI:209 | SWE-Pruner | later | context §7; DEC-21 |
| INV:C6 | FI:212 | Masking with pointers | deliberate | context rule 3; DEC-24 |
| INV:C18 | FI:224 | Traces stripped | deliberate | context rule 4; DEC-24 |
| INV:C20 | FI:226 | Context metrics | carried | context rule 29 |
| INV:C21 | FI:227 | Version invalidates qualification | gap | context §4 (corrected), NEW-context-6 |
| INV:E9 | FI:351 | Prompt evolution loop | later | context §7 |
| INV:O2 | FI:472 | Aider edge weights | gap | context rule 13, NEW-context-5 |
| INV:O3 | FI:473 | Map cache key with content hash | gap | context rule 13, NEW-context-5 |
| INV:O6 | FI:476 | Traces stripped unless flagged | deliberate | context rule 4; DEC-24 |
| INV:O44 | FI:514 | Cache flags from the machine profile | deliberate | context rule 6; DEC-24 |
| INV:O46 | FI:516 | Hit < 85% is a defect and alert | gap | context rule 7, M8 |

### 5.5 Worker loop

| Row | Old | Item | Final | Now in |
| --- | --- | --- | --- | --- |
| HD1:96 | HD:244 | `grep` three output modes | carried | worker-loop rule 12 (built) |
| HD1:146 | HD:348 | Many MCP tools without prefill cost | gap | worker-loop rule 11a, NEW-worker-loop-8 |
| HD1:162 | HD:398 | Step vs turn terminology | deliberate | worker-loop §3 Terms; NAMING; R22 |
| HD1:267 | HD:689 | Sketch applied mechanically | later | worker-loop §7 |
| HD1:276 | HD:712 | Parallel pass@k on L/XL | later | worker-loop §7 |
| HD1:293 | HD:755 | Flat tool schemas | carried | worker-loop rule 10a, WL-17 |
| HD1:301 | HD:763 | `repo` incl. releases between versions | later | worker-loop §7 (R4) |
| HD1:302 | HD:764 | `ask` non-blocking | gap | worker-loop rule 12, NEW-worker-loop-4 (R2) |
| HD1:312 | HD:782 | Stall stops at once | deliberate | worker-loop rule 18, §9 |
| HD1:321 | HD:794 | Six stop reasons | deliberate | worker-loop rule 31; DEC-24 |
| HD1:325 | HD:802 | Rung 3: narrow or escalate | deliberate | worker-loop rule 34.3, §7, §9 |
| HD1:348 | HD:854 | `replace_all`, exact whitespace | deliberate | worker-loop rule 12, §9 |
| HD1:352 | HD:863 | Fewer tools per role | carried | worker-loop rule 10 |
| HD2:8 | HD:1812 | `tool_search` answers file queries with files | carried | worker-loop rule 12, WL-13 |
| HD2:9 | HD:1812 | `tool_search` symbol queries load `read_symbol` | gap | worker-loop rule 12, M2 |
| HD2:15 | HD:1823 | Sample cap per hardware tier | later | worker-loop §7 |
| HD2:99 | HD:2035 | `ask` answered by the Researcher; one inbox | gap | worker-loop rule 12, NEW-worker-loop-4; Researcher path later (design-stage §7) |
| HD2:147 | HD:2157 | Worker research tools incl. `repo` | later | worker-loop §7; design-stage §9 (R4) |
| HD2:255 | HD:2466 | `read` byte budget | carried | worker-loop rule 12, WL-12 |
| HD2:256 | HD:2466 | Images and PDFs to a vision path | later | worker-loop §7 |
| HD2:257 | HD:2467 | `grep` modes | carried | worker-loop rule 12 |
| HD2:258 | HD:2468 | `glob` newest first | carried | worker-loop rule 12 |
| HD2:262 | HD:2470 | Symbol tools over an LSP pool | carried | worker-loop rule 12; other languages §7 |
| HD2:263 | HD:2471 | ast-grep fallback | later | worker-loop §7 |
| HD2:264 | HD:2472 | `run`: allowlist, description, condensing | carried | worker-loop rule 12; security permission table; context 17 |
| HD2:265 | HD:2473 | `docs` from the project corpus | carried | worker-loop rule 12; corpus later (design-stage §7) |
| HD2:274 | HD:2496 | Parse gate on tree-sitter | deliberate | gates §9; DEC-20 |
| HD2:468 | IR:94 | A6: re-plan never sees rules or API facts | gap | worker-loop rule 34.3, NEW-worker-loop-5 |
| HD2:477 | IR:134 | B5: `note("Assumed…")` lives only in memory | carried | worker-loop rule 5a (built) |
| HD2:498 | IR:198 | E1: four verification paths | gap | worker-loop rule 9, T3 |
| PMFE:518 | FE:837 | Unknown stop reason → humanised enum | carried | dashboard §2.12.1, NEW-dashboard-2 |
| INV:G25 | FI:193 | Pass@k with gate selection | carried | worker-loop rule 37; parallel §7 |
| INV:L4 | FI:243 | `read` ranges, budget, images | carried | worker-loop rule 12; images §7 |
| INV:L6 | FI:245 | `grep` | carried | worker-loop rule 12 |
| INV:L7 | FI:246 | `glob` | carried | worker-loop rule 12 |
| INV:L29 | FI:275 | Observation clamp 2,400/1,200 | carried | worker-loop §3, §4 |
| INV:O48 | FI:518 | Pass@k details | carried | worker-loop rule 37; parallel §7 |
| INV:O93 | FI:563 | Per-class tool sets | carried | worker-loop rule 10 |
| INV:O97 | FI:567 | ast-grep fallback | later | worker-loop §7, context §7 |

### 5.6 Kernel

| Row | Old | Item | Final | Now in |
| --- | --- | --- | --- | --- |
| HD1:163 | HD:398 | Turn-flow event names | deliberate | kernel §3 closing note (never the code's; mapped) |
| HD1:168 | HD:413 | Project record fields | carried | kernel rule 6 |
| HD1:170 | HD:416 | ContextPack fields | carried | kernel rule 6; context rule 29 |
| HD1:188 | HD:473 | UI override past a gate | later | dashboard §7; kernel rule 28 (CLI, API) |
| HD1:194 | HD:499 | Ready → Planning; Planning → In Progress | carried | kernel rule 25 |
| HD1:195 | HD:503 | Verify → Planning on gate failure | carried | kernel rule 25 |
| HD1:199 | HD:517 | Planning entry condition | gap | kernel rule 27, NEW-kernel-5 |
| HD1:200 | HD:518 | In Progress entry incl. "plan exists" | deliberate | kernel rule 27, §8 Q6 (recommendation awaiting the owner) |
| HD1:204 | HD:522 | Parked entry condition | gap | kernel rule 27, NEW-kernel-5 |
| HD1:209 | HD:531 | Regression → Planning, named | gap | kernel rule 31, NEW-kernel-5 |
| HD2:154 | HD:2186 | Every extension a kernel plugin | deliberate | extensibility; DEC-09 |
| HD2:377 | HD:2815 | Seven actors | deliberate | kernel rule 19, §9 |
| HD2:379 | HD:2828 | Chain hash covers the timestamp | gap | kernel rule 9, NEW-kernel-1 |
| HD2:500 | IR:200 | E1: two playbook stores, two send-back sinks | gap | kernel K-S7-6, S7; one store built (context 24a) |
| HD2:511 | IR:224 | Suggestion 6: the card dossier | carried | kernel rule 20 (built); worker-loop 5a |
| HD2:522 | IR:253 | PM chat shows Worker questions as the Worker's | carried | dashboard §2.7.3; kernel rule 19 |
| INV:K4 | FI:48 | Typed association columns | carried | kernel rule 7 |
| INV:K16 | FI:60 | Attempts `rung`, `tool_arm` | carried | kernel rule 6, §4 |
| INV:K17 | FI:61 | Steps `success`, `tokens_condensed` | deliberate | kernel rule 6 (not stored, with the reason) |
| INV:G23 | FI:191 | Regression → Planning, named | gap | kernel rule 31, NEW-kernel-5 |
| INV:B2 | FI:288 | Verify → Planning | carried | kernel rule 25 |
| INV:B11 | FI:297 | Fractional `order_key` | carried | kernel rule 15 |
| INV:O29 | FI:499 | Regression named | gap | kernel rule 31, NEW-kernel-5 |
| INV:O78 | FI:548 | Fractional index | carried | kernel rule 15 |
| INV:O106 | FI:576 | Two negatives per happy path; bit flip | carried | DEFINITION_OF_DONE §2B; kernel K-1; gates §8 Q2 |

### 5.7 Integrations

| Row | Old | Item | Final | Now in |
| --- | --- | --- | --- | --- |
| HD1:156 | HD:358 | Remote control from a phone | later | integrations §7; dashboard §7 |
| HD1:157 | HD:358 | Team-chat entry points | later | integrations §7 |
| HD2:49 | HD:1891 | Whole-card last-writer-wins | deliberate | integrations §2.4 |
| HD2:51 | HD:1898 | Forgejo: dependencies, boards, webhooks | later | integrations §7, §8 Q4 |
| HD2:53 | HD:1901 | Separate GraphQL budget | gap | integrations §2.11a, P9 |
| HD2:54 | HD:1901 | Webhooks over polling | gap | integrations §2.11a, P9 |
| HD2:55 | HD:1901 | Batched GraphQL | gap | integrations §2.11a, P9 |
| HD2:56 | HD:1901 | Idempotency keys | gap | integrations §2.11a, P9 |
| HD2:57 | HD:1901 | Secondary rate-limit backoff | gap | integrations §2.11, P9 |
| HD2:63 | HD:1909 | CI as a gate source | later | integrations §7 |
| HD2:64 | HD:1911 | Mid-card scope edit pauses the card | deliberate | integrations §2.5, §9 (R6), INT-11a |
| HD2:67 | HD:1921 | Keys only in the OS keychain | deliberate | integrations §2.10; security item 35 |
| HD2:72 | HD:1932 | Comment commands | later | integrations §7 |
| HD2:74 | HD:1934 | Dependency-bot verification cards | gap | integrations §2.12, P9 |
| HD2:75 | HD:1935 | `workflow_dispatch` | later | integrations §7 |
| HD2:81 | HD:1974 | Draft PR with evidence on Accept | gap | integrations §2.15, P9 |
| HD2:82 | HD:1975 | PR ready on checks; CODEOWNERS | gap | integrations §2.15, P9 |
| HD2:83 | HD:1976 | Review comments → repair subtasks | later | integrations §7; review-git §7 |
| HD2:84 | HD:1977 | Merge per repository policy | gap | integrations §2.15, P9 |
| HD2:85 | HD:1981 | Release cards | later | integrations §7; planner-pm §2.15.8 |
| HD2:183 | HD:2264 | Unsolicited-message budget (specs disagreed) | gap | planner-pm §2.8.15, integrations §2.23a (now 3/5 in both, R8); P6, P9 |
| PMFE:187 | PM:408 | Jira and Linear live sync | later | integrations §7 |
| PMFE:189 | PM:410 | Microsoft Teams | later | integrations §7 |
| PMFE:190 | PM:411 | Slack replies | later | integrations §7 |
| PMFE:191 | PM:415 | Sentry, Datadog, PagerDuty | later | integrations §7 |
| PMFE:192 | PM:416 | Notion, Confluence | later | integrations §7 |
| PMFE:196 | PM:424 | Copy keyed on id; unknown id fallback | carried | dashboard §2.11 |
| INV:Y11 | FI:116 | Forgejo adapter | later | integrations §7 (beyond issues) |
| INV:Y13 | FI:118 | HMAC webhook and triggers | gap | integrations §2.12, P9 |
| INV:Y17 | FI:122 | Release cards | later | integrations §7 |
| INV:Y18 | FI:123 | CI via `act` | later | integrations §7 |
| INV:Y20 | FI:125 | Mid-card edit reconciliation | deliberate | integrations §2.5, §9 (R6) |
| INV:O84 | FI:554 | git-cliff and semver | later | integrations §7 |
| INV:O85 | FI:555 | `act` as gates | later | integrations §7 |
| INV:O86 | FI:556 | GraphQL budget, webhooks, batching, keys, backoff | gap | integrations §2.11, §2.11a, P9 |
| INV:O89 | FI:559 | `resolveReviewThread`, auto-merge, merge queue | later | integrations §7; merge policy §2.15 (P9) |
| INV:O90 | FI:560 | Annotation shape with `raw_details` | carried | integrations §2.14 |
| INV:O92 | FI:562 | LWW by timestamp | deliberate | integrations §2.4 |

### 5.8 Runtime

| Row | Old | Item | Final | Now in |
| --- | --- | --- | --- | --- |
| HD2:169 | HD:2224 | `replay --as <config>` | carried | runtime rule 14 (other configs are a fork from step 0) |
| HD2:174 | HD:2240 | Crash resume | gap | runtime rule 10, NEW-runtime-3 |
| HD2:185 | HD:2268 | Caches kept warm outside declared hours | gap | runtime rule 17, NEW-runtime-5 (RUN-18a) |
| HD2:186 | HD:2268 | Nightly mutation and vulnerability scan | gap | runtime rule 20, NEW-runtime-5 |
| HD2:187 | HD:2268 | Overnight prompt optimiser | later | runtime §7 |
| HD2:307 | HD:2615 | kWh from TDP × utilisation | deliberate | runtime rule 18, §7, §9 |
| HD2:311 | HD:2623 | Works over SSH and headless | carried | runtime rule 23 |
| HD2:343 | HD:2683 | WebSocket at `/stream` | deliberate | runtime rule 25, §9 |
| HD2:406 | HD:3102 | `split { strategy }`, `run { budgetOverride }` | later | runtime §7 (budget override); split body §3 |
| HD2:487 | IR:162 | C4: `kick` loads models with no footprint check | gap | runtime rule 4, NEW-runtime-6; models NEW-models-9 |
| HD2:515 | IR:228 | Suggestion 10: a residency scheduler | gap | models NEW-models-9; runtime NEW-runtime-6 |
| HD2:534 | IR:284 | One scheduler for all callers | gap | runtime rule 4, NEW-runtime-6 |
| PMFE:323 | FE:69 | Step events; replay from genesis | carried | runtime 25, 25a; dashboard §3 |
| PMFE:440 | FE:456 | Run reports in `.sekhemet/runs/<startedAt>.json` | **still-weaker** | see §2 |
| PMFE:449 | FE:482 | `/api/machine`, pushed every 5 s | carried | dashboard §2.11, §3 |
| PMFE:451 | FE:657 | Transcript shape | carried | dashboard §3 |
| PMFE:452 | FE:471 | `/api/events` paging and filters | carried | runtime 25a; dashboard §3 |
| PMFE:456 | FE:490 | `/api/playbook` shape | carried | dashboard §3 |
| INV:K6 | FI:50 | `subscribe(filter, cb)` | carried | kernel rule 18 |
| INV:K7 | FI:51 | `getRange(since, limit)` | carried | kernel rule 18; runtime 25a |
| INV:S7 | FI:88 | Buffer cap, OOM detection | carried | runtime rules 8, 8a |
| INV:L22 | FI:261 | Token/seconds/kWh budgets | gap | runtime rule 19, NEW-runtime-7 |
| INV:U9 | FI:379 | Live stream, replay from genesis | carried | runtime rule 25a |
| INV:H22 | FI:422 | OTel spans incl. tool spans, in UI | gap | runtime §4 (corrected, R23), NEW-runtime-9 |
| INV:X19 | FI:453 | `MODEL_MATRIX.md` | carried | models §3, §4 |
| INV:X21 | FI:455 | Fixture generator, `createTestWorktree` < 10 ms | **still-weaker** | see §2 |
| INV:X23 | FI:457 | `test:unit` / `test:integration` | carried | DEFINITION_OF_DONE §2D.1 |
| INV:X24 | FI:458 | `pnpm dev` | carried | DEFINITION_OF_DONE §2D.1 |
| INV:X25 | FI:459 | Suite under 3 s | deliberate | DEFINITION_OF_DONE §2D.4 |

### 5.9 Other checked rows (spine, decisions, gates, models, review-git, security, extensibility)

| Row | Old | Item | Final | Now in |
| --- | --- | --- | --- | --- |
| HD1:11 | HD:29 | A feature that serves none of the six paragraphs is a candidate for deletion | deliberate | SPINE §Where the edge is (the test is now "serves one of the three edges"; DEC-01) |
| HD1:13 | HD:36 | Target user: solo developer | deliberate | DEC-01 |
| HD1:28 | HD:60 | Non-goals: teams, multi-user boards, RBAC, SSO | deliberate | DEC-06 (company-server minimum in v1; RBAC and SSO stay out) |
| HD1:29 | HD:60 | Non-goals: compliance pack, Azure DevOps | carried | SPINE "Not in v1"; runtime §7; integrations §7 |
| HD1:41 | HD:119 | Cloud models after v1, per role | later | DEC-03; models §7 |
| HD1:78 | HD:214 | Parity claim against the top five | deliberate | specs/README "Where the old design went" (dated competitor columns removed) |
| HD1:80 | HD:221 | llama.cpp / MLX inference | later | models rule 14, §7 (MLX only a label; R3) |
| HD1:93 | HD:234 | Air-gap mirrors (npm, devpi, crates) | later | security §7 (mirror services); lockfile allowlist in v1 |
| HD1:97 | HD:244 | `glob` newest first | carried | worker-loop rule 12 |
| HD1:119 | HD:291 | TypeScript SDK with async-iterator streams | deliberate | extensibility rule 28, §8 Q1 ("changed from the old design's shipped SDK") |
| HD1:124 | HD:315 | Copy-on-write worktrees | deliberate | DEC-21 (plain worktrees) |
| HD1:125 | HD:315 | Checkpoint on every passing step | deliberate | review-git rule 3, §9 (every step that changed files; R1) |
| HD1:135 | HD:328 | Visual gate: DOM assertions, layout, screenshots, a11y | gap | gates rule 29, NEW-gates-4 (GT-N4-6); libraries still proposals (R16) |
| HD1:136 | HD:329 | "5-second acceptance" with difftastic | deliberate | review-git rule 2, §9 (a decision in under a minute); structural diff rule 6 (partial, S5) |
| HD1:150 | HD:352 | IDE extension and TUI | later | SPINE "Not in v1"; dashboard §7 |
| HD1:153 | HD:355 | Watchdog 85–90% actions | gap | models rule 19 (owner, R27), NEW-models-2 (the 0.90 stage) |
| HD1:155 | HD:358 | Plugin marketplace | later | extensibility §7 |
| HD1:158 | HD:362 | Every capability a plugin claiming a service key | deliberate | extensibility rule 29; DEC-09 (the cut of `container.ts` itself awaits the owner, DEC-09 correction) |
| HD1:159 | HD:366 | Model-visible means logged, enforced at runtime | carried | kernel rule 17, §4 (built), K-9 |
| HD1:165 | HD:402 | Plugin isolation and versioning | later | extensibility §7 |
| HD1:207 | HD:527 | Project status is a rollup of top-level cards | gap | kernel rule 6, NEW-kernel-5 (K-N5-3) |
| HD2:177 | HD:2252 | Checkpoints at gate passes and masking boundaries | deliberate | review-git rule 3, §9 (R1); runtime rule 11 links to it |
| INV:Y3 | FI:108 | Commit after gate passes and masking boundaries | deliberate | review-git rule 3, §9 (R1) |
| INV:O30 | FI:500 | Checkpoint at gate passes and masking boundaries | deliberate | review-git rule 3, §9 (R1) |
| INV:K19 | FI:63 | `evidence_bundles` fields | gap | gates rule 35, T1 |

