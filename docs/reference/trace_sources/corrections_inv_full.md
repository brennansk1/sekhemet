# Trace corrections: the inventory rows, full check

*Every remaining inventory row of [DESIGN_TRACE.md](../DESIGN_TRACE.md) checked in full, 2026-09-25.*


*Scope: every row of DESIGN_TRACE.md §5.5 that does not end "(corrected 2026-09-25)" (338 rows), and every §5.3/§5.4 row whose location cites a kernel rule number (1 row, PMFE:432). Checked against the working tree at `01a6d8a` plus the uncommitted spec edits, 2026-09-24. For each row: the old text at its FI/R1/R2 line in `git show fb59ba2:docs/reference/FEATURE_INVENTORY*.md`, the new text at every location the row names, and, for `carried`, the owning spec's §4 State table. No repository file was edited.*

Conventions follow the earlier passes: a capability whose owning §4 row is `not-built` or `partial` with a change ID is `gap`, not `carried` (the precedent of INV:M13, INV:M15, INV:B3, INV:C9, INV:C10 in corrections_hd_inv.md); a rule number is a §2 item of the named spec; kernel numbers use the renumbered kernel.

## Trace corrections

| Row | Old status | New status | New location | Note |
| --- | --- | --- | --- | --- |
| INV:K21 | carried | gap | models rule 32, §4 "Competence rows" partial, NEW-models-6 (MD-N6-1, MD-N6-2) | *Unbuilt, so `gap`.* The row's own note says "§4 partial (NEW-models-6)"; by the precedent of INV:M13/M15, a `partial` §4 row with a change ID is `gap` |
| INV:K22 | carried | deliberate | kernel rule 6 Card bullet (after restoration R2 of corrections_hd_inv.md — not yet applied: kernel rule 6 still has no Card bullet); planner-pm §2.1.5, §2.7.1–2 and §9 (priority is a person's 0–4 field; WSJF only orders Ready); kernel rule 24 (typed holds); PM_CONTRACT §2 | *Wrong status.* Same old record as HD2:387, already `deliberate`: `priority REAL` (WSJF) became a person-owned 0–4 field (planner-pm §9 gives the reason), `blocked_reason` became the typed hold, `assigned_tier` is dropped (R2 says why). "kernel §2.6 types" lists no card fields |
| INV:K27 | carried | gap | runtime rule 33, §4 "Retention of packs, observations, transcripts" partial, NEW-runtime-4 (RUN-13, RUN-54, RUN-57) | *Unbuilt, so `gap`.* §4 says partial: pruning runs with no `ledger/erased` record and is untested through `queue`; the row's own note says "NEW-runtime-4 partial" |
| INV:K28 | carried | carried | review-git §2.6.3 (checkpoint database record with attribution), §4 built | *Location.* review-git numbers its items per subsection; "review-git rule 3" names no item (§2.1.3, §2.2.3 and §2.6.3 all exist). The checkpoint record is §2.6.3 |
| INV:S14 | later | deliberate | DEC-21 (plain worktrees instead of copy-on-write clones, with its reason and reopen condition); security §9; CoW also listed in review-git §7; linked `node_modules`/`.venv` security rule 24 (§4 partial, S2) | *Wrong status.* The same item is `deliberate` in HD1:124, HD2:29 and INV:O43 (DEC-21 is an accepted substitution, a change on purpose); review-git §7's copy-on-write entry gives no reason of its own. Also drop INV:S14 from §3's review-git Later list (9 → 8) |
| INV:Y3 | deliberate | deliberate | review-git §2.6.3, §9 (checkpoints after every step that changed files; R1) | *Location.* "review-git rule 3" is ambiguous (see INV:K28); the cadence is §2.6.3 |
| INV:Y4 | carried | gap | review-git §2.5.4, §4 "Real `GateStatus`, `Accepted-by`, `Ledger-Head` trailers" not-built, S5 (RG-S5-7); several commits per card Later (review-git §7) | *Unbuilt, so `gap`.* The row's own note says "real trailers S5": the squash's attribution (`GateStatus`, `Agent-Role`) is hard-coded today (`execute.ts:1349-1353`) |
| INV:Y5 | carried | carried | security rule 18 (after restoration: git's arguments as an argument vector, never a shell), rules 19–20 | *Lost precision.* The old item is shell-injection safety (`execFileSync("git", args)`, a model-authored commit message or title never reaching a shell). Security rules 18–20 state absolute path, pinned environment and hardened config, none of which is injection safety; no spec says git runs without a shell. Built (`git_adapter.ts:1`, `:182-188`) |
| INV:Y8 | carried | gap | review-git §2.6.6, §4 "Structural diff (difftastic)" partial, S5 (RG-S5-19); in the evidence bundle Later (gates §7) | *Unbuilt, so `gap`.* §4 partial: the read path writes to the person's repository when the worktree is gone |
| INV:Y9 | carried | carried | review-git §2.5.1 (branch head equals the evidence's repository-state hash), §2.6.2 (branches); gates rule 35 (diff) | *Location.* "review-git §2.2" is Review capacity, not the repository-state hash |
| INV:Y10 | carried | gap | integrations rules 4, 7, §4 "GitHub/Forgejo adapter" partial, P9 (INT-2–INT-6) | *Unbuilt, so `gap`.* The row's own note says "§4 partial P9": no pagination, whole-card LWW, board wins never pushed |
| INV:M8 | carried | gap | models rule 28 + DEC-22 (constraints only where measured), §4 "Tool arm measured and pinned" not-built, NEW-models-5 (MD-N5-1) | *Unbuilt, so `gap`.* Constrained decoding exists behind a flag nobody sets; the per-model measurement that would enable it is the same unbuilt row that made INV:M9 `gap` |
| INV:M10 | carried | carried | DEFINITION_OF_DONE §2D.2; models §3 (after restoration: the scripted adapter's contract) | *Lost precision.* DoD §2D.2 says only "a scripted inference adapter replays tool calls". The old contract — responses matched by prompt pattern (RegExp or string), recorded call history, a defined behaviour when the script runs out — is stated nowhere; "models §4 adapter_contract.spec.ts" is the health-check row, not the mock. Built (`mock_adapter.ts`: `MockRule.match`, `callHistory`, `MockExhaustion`) |
| INV:M21 | carried | gap | models rules 17, 20, 20a, §4 "Declared hours, swap batching by project" partial, NEW-models-3 (MD-N3-2) and "One residency scheduler" not-built, NEW-models-9 | *Unbuilt, so `gap`.* The old item includes "swaps batched by project" and single-model serialisation; both §4 rows are unbuilt (INV:M25, the batching, is already `gap`) |
| INV:M24 | carried | gap | models rules 14, 26, §4 "One role enum; one profile record; one construction path" not-built, NEW-models-4 (after restoration: an EARS criterion for applying the measured engine) | *Unbuilt, and no criterion.* R2: `profile.engine` is saved and never read; cache retention is never weighted. No MD-* criterion covers the engine decision being applied |
| INV:G3 | carried | gap | gates rule 3, §4 "Built-in and project gates on the gate host" not-built, T1 (GT-T1-5); a per-layer `runs_on` Later (gates §7) | *Unbuilt, so `gap`.* Rule 3 puts every layer on the gate host; with `[gate_host]` set, built-in and project gates still run in the harness process |
| INV:G20 | carried | deliberate | gates rule 29, §9 (the in-house CDP client with every required behaviour kept), §8 Q1 (Playwright and axe-core approved as development dependencies, DEC-29 O5; axe-core inside the product gate open, O27) | *Wrong status and stale note.* The old item names axe-core; the product runs an eight-rule in-house subset on purpose (gates §9). "axe proposal" predates DEC-29 O5 (same fix as HD1:135) |
| INV:C17 | carried | gap | worker-loop rule 34.2, §4 "Fresh context resets read set, seen marks and lessons; directive shown once" partial, M1 (WL-M1-2, WL-M1-3); context rule 19 | *Unbuilt, so `gap`.* The row's own note says "M1 partial": history is cleared but the read set and directive are kept |
| INV:C19 | carried | gap | worker-loop rules 11, 12 (`tool_search`), §4 "Fixed tool set per class, stable array" not-built and "`tool_search` answers symbol queries" not-built, M2 (WL-M2-2, WL-M2-7); context §8 Q2 (loaded tools appended as a message) | *Unbuilt, so `gap`.* Progressive loading exists, but it edits the tools array mid-card instead of loading into the volatile zone, and symbol queries are not answered |
| INV:C20 | carried | gap | context rule 29 (after restoration: a §4 row and a criterion, proposed CX-N5-4) | *Unbuilt, with no change ID.* No per-card metric exists in code (no peak context, steps to first gate pass or pass rate against pack size); context §4 has no row for rule 29 |
| INV:L9 | carried | gap | worker-loop rule 12, §4 "Symbol tools reach the TypeScript service through LSP" not-built, NEW-worker-loop-7 (WL-N7-1); symbol edits beyond TS/JS Later (worker-loop §7) | *Unbuilt, so `gap`.* The old item is symbol tools **over LSP**; today they call the in-process TypeScript API |
| INV:L14 | carried | deliberate | worker-loop rules 30–31, §9 and DEC-24 (six stop reasons became twenty-three stored reasons in seven failure classes plus success); the table and classes T3 (not built) | *Wrong status and location.* The six reasons were replaced on purpose, with the reason in worker-loop §9; "OQ1" is worker-loop §8 Q1, which is about `tool_search` |
| INV:L20 | carried | gap | security rule 42a, §4 "`browse`" partial, S3a (SEC-17); screenshots to evidence and the accessibility-tree read (after restoration) | *Unbuilt, so `gap`.* `browse` returns page text only (`sandbox/src/browser.ts`: no screenshot, click, type or accessibility tree); rule 42a promises screenshots in the evidence, with no §4 row or criterion, and the old accessibility-tree read is stated nowhere |
| INV:L30 | carried | gap | worker-loop §3 (tool executor); security rule 25a, §4 "Ask answered by a person through a decision request" partial, NEW-security-6 (SEC-47–49) | *Unbuilt, so `gap`.* The item includes the Ask-tier escalation; its approval path is the same partial row that made INV:D4 `gap` |
| INV:P1 | carried | deliberate | planner-pm §2.2 (Cohn's SPIDR: Interface is the user interface; types first became the Contract enabler card, §2.2.2), §2.4 (split until the card fits Zone 3), §9; DEC-26 | *Wrong status.* One of the five heuristics was redefined on purpose; the same item traced from HARNESS_DESIGN (HD1:367) is `deliberate` |
| INV:P4 | carried | deliberate | planner-pm §2.6.1–2, §9 ("Estimates are tokens for the machine and points for people (not 'never points')") | *Wrong status.* The old item says "Never story points"; points for people were added on purpose, with the reason in §9. The formula and write-back are built |
| INV:P13 | carried | gap | planner-pm §2.6.3, §2.7.8 (Standup row), §4 "Plain-language standup; … the next window's plan" partial, P6 (PM-P6-3) | *Unbuilt, so `gap`.* The old item ends with "the machine's plan for the next window"; §4 says there is no next-window section |
| INV:P16 | carried | gap | planner-pm §2.7.3–4, §2.7.8 Retrospective row (after restoration: a §4 row and PM-P6-16) | *Unbuilt, with no change ID.* The row's own note says "not in §4"; R2: `ceremoniesDue` only prints, and no retrospective runs from a profile's cadence |
| INV:P17 | carried | carried | planner-pm §2.11.1 (after restoration: the record's fields); §3 `Goal` | *Lost precision.* The old record (`workspaceId`, `projectIds`, criteria with `check {gateRef, metricQuery}` and status `unmet`/`met`/`unverifiable`, budget `{tokens, hours, deadline}`, versioned strategy, state `draft`/`active`/`blocked`/`met`/`abandoned`) is in `goals.ts` but stated in no document |
| INV:E7 | carried | gap | measurement rules 16a, 17, 20, §4 "Six inlets exist" partial and "Volume thresholds" partial, T8; context NEW-context-4 (CX-N4-6) | *Unbuilt, so `gap`.* §4: one struggle creates a candidate (no 3-occurrence threshold), and retirement by paired credit is not built |
| INV:E10 | carried | gap | measurement rule 17; extensibility rule 17a, §4 "Skill evals run before approval" not-built, NEW-extensibility-4 (EXT-27a, EXT-27b) | *Unbuilt, so `gap`.* EXT-27a/b are §5 change criteria, not built behaviours; `distillSkill` writes `SKILL.md` only |
| INV:E11 | carried | gap | measurement rules 17, 20 (two per class, at least 5 structurally complete cards), §4 "Volume thresholds" partial, T8; context rule 25, §4 "Exemplars as accepted diff hunks" not-built, M1 (CX-M1-7, CX-M1-11) | *Unbuilt, so `gap`.* Exemplars have no minimum today; INV:C13, the same store, is already `gap` |
| INV:E12 | carried | gap | measurement rule 17 (synthesised tasks), §4 "Synthesised tasks install dependencies in an ephemeral worktree" not-built, T8 (MS-T8-12) | *Unbuilt, so `gap`.* `TaskSynthesizer` is unreachable; INV:E2, the item E12 points to, is already `gap` |
| INV:E14 | carried | gap | measurement rules 13, 21, §4 "Calibrated pre-filter" not-built, T8 (MS-T8-7) | *Unbuilt, so `gap`.* `siftProposals` has no production caller; the calibrated pre-filter rule 21 requires is not built |
| INV:U10 | carried | deliberate | dashboard §2.3, §9 ("No bare `t`; chords reassigned (`g p` PM, `g s` Status, `g i` Insights)", with the reason); the new keymap P11 (not built, §4) | *Wrong status.* The old sixteen bindings (`g i` inbox, bare `t`) are changed on purpose; the row's "(redefined chords)" names the change but the status says `carried` |
| INV:U15 | carried | carried | dashboard §2.5.14, §4 "Decision request component" built (`decision.js`, countdown and amber under 15 minutes) | *Stale note.* "no State row; R1 MISSING" — dashboard §4 has the row, and the countdown is built |
| INV:U17 | later | later | dashboard §7 (pan and zoom and the critical path on the dependency graph; after restoration: the reason) | *Missing reason.* The §7 entry says v1 lays the graph out in layers but gives no reason the pan-and-zoom canvas waits, and no condition for its return |
| INV:U20 | carried | gap | dashboard §2.2.2, §2.15.3, §4 "…phone bottom bar…" not-built, P11 | *Unbuilt, so `gap`.* The row's own note names P11; one-tap triage exists on Review only, and the phone's bottom bar and one-column board are not built |
| INV:H1 | carried | gap | runtime rule 5, §4 "Daemon start/stop/status" partial, NEW-runtime-1 (RUN-1) | *Unbuilt, so `gap`.* The row's own note says "NEW-runtime-1 partial": `stop` trusts a bare pid |
| INV:H2 | carried | deliberate | surface rules 5.6 and 13 (the bare `sekhemet` opens the board; `ask` replaces `board` at the front door, `board` still runs under `dev`), NEW-surface-6; owner decision O23 pending, default approve | *Wrong status.* Same change as HD1:64, already `deliberate`: the `board` command leaves the front door under O23's default |
| INV:H3 | carried | gap | models rule 7, §4 "Calibration command and machine profile" partial, NEW-models-1 (MD-N1-3) | *Unbuilt, so `gap`.* Same §4 row as INV:M13, already `gap` |
| INV:H6 | carried | gap | gates rule 8, §4 "One pipeline, one rank-and-cap; CLI = card verdict" not-built, T1 (GT-T1-1) | *Unbuilt, so `gap`.* §4: the CLI skips the project gates and `harnessOwned`, so `sekhemet gate <card>` can give a different verdict from the card run; the row's "DISAGREE (spec newer)" concedes it |
| INV:H7 | carried | gap | models rule 30, §4 "Bake-off under the real harness" partial, NEW-models-4 (MD-N4-7); surface rule 11 | *Unbuilt, so `gap`.* "on the repo": the bake-off runs a fixture, not the repository's history; INV:M23, the same row, is already `gap` |
| INV:H10 | carried | gap | extensibility rules 18–21, §4 "MCP server: … no evidence/registry tools …" partial, NEW-extensibility-3 (EXT-17) | *Unbuilt, so `gap`.* The old item is "incl. evidence and registry"; HD1:86 and HD1:112 (the same tools) are already `gap` |
| INV:H11 | carried | gap | extensibility rules 22–24, §4 "MCP client: stdio only, full env, Researcher only" partial, NEW-extensibility-3 (EXT-18–EXT-21) | *Unbuilt, so `gap`.* The old item is tools "exposed to planner and executor"; only the Researcher receives them |
| INV:H12 | carried | deliberate | runtime §3 ("The design's 2026-09-17 route table … is superseded by the routes above; the code is the contract") | *Wrong status.* Same item as HD2:405, already `deliberate` |
| INV:H16 | carried | later | extensibility §7 (user-defined commands as Markdown templates: `/onboard`, `/retro`, `/split`, `/bake-off`, `/goal`); the built-in slash commands are extensibility rule 26 | *Wrong status.* The old item is the Markdown-template commands, which are in extensibility §7, like HD2:161; the note "templates Later" says so. Add INV:H16 to §3's extensibility list |
| INV:H20 | carried | gap | integrations rules 20–23, §4 "Slack as a channel; standup, needs_you, decision" not-built, P9 (INT-19) | *Unbuilt, so `gap`.* The old item notifies on Review, park, budget **or a decision**; `notify.ts` has no `decision` kind (`NotifyEvent`, `notify.ts:22`) |
| INV:H21 | carried | gap | runtime rules 17–20, §4 "Nightly full vulnerability scan" not-built, NEW-runtime-5 (RUN-17); warm caches models §4 not-built, NEW-models-3 (MD-N3-3); the prompt optimiser Later (runtime §7) | *Unbuilt, so `gap`.* R2 SHALLOW: no nightly vulnerability scan; the row's note names NEW-runtime-5 |
| INV:H23 | carried | gap | runtime rules 18–19, §4 "Per-card kWh budget; per-project caps" not-built, NEW-runtime-7 (RUN-37, RUN-38); energy as watts × time on purpose (rule 18, §7) | *Unbuilt, so `gap`.* The old item includes "project cap stopping the scheduler"; HD2:306 (the same) is already `gap` |
| INV:H24 | carried | gap | models M4 (MD-M4-5), §4 "Per-step provenance…" not-built; gates rule 35; runtime §8 Q2 | *Unbuilt, so `gap`.* The seven-field record is a §5 criterion (MD-M4-5), not built; R2: no template checksum, prompt-set version or engine settings in the record |
| INV:H26 | carried | gap | models rule 19, §4 "Watchdog levels and actions" partial, NEW-models-2 (MD-N2-2) | *Unbuilt, so `gap`.* The 2 s poll runs in `queue` only, not `run` or the daemon; INV:M20 is already `gap` |
| INV:H27 | carried | gap | security rule 43, worker-loop rule 13, §4 "Restricted mode strips tools" partial, S3a (SEC-19) | *Unbuilt, so `gap`.* The row says "see S12"; INV:S12 is `gap` for the same row |
| INV:X1 | carried | gap | surface rules 9–11, §4 "Onboarding" partial, P10, S3a, S9 (SUR-7–SUR-10, SUR-35–SUR-39); qualification offered, not run (rule 11) | *Unbuilt, so `gap`.* The row's own note names P10: `--apply` overwrites `gates.toml`, CI ignored for gates, language servers before trust |
| INV:X2 | carried | gap | surface rule 12, §4 "Onboarding" partial (drift fires every run), P10 (SUR-10); runtime rule 20 | *Unbuilt, so `gap`.* The drift check reports drift on every run (`onboard.ts:593-599`) |
| INV:X4 | carried | gap | design-stage rule 2.7.2; security rule 48, §4 "`llms.txt` snapshots, staleness on lockfile change…" not-built, NEW-security-5 (SEC-44) | *Unbuilt, so `gap`.* Tier 2 (local docs and `llms.txt` per dependency version) is not built; INV:X12 is `gap` for it |
| INV:X6 | carried | gap | design-stage rules 2.6.3, 2.7.2, 2.7.8, §4 "Fetch denylist (`fetch_deny`)…" not-built, NEW-design-stage-4; trafilatura, Docling and Playwright extraction Later (design-stage §7) | *Unbuilt, so `gap`.* The old pipeline has a per-project allowlist **and denylist**; the denylist is not built |
| INV:X15 | carried | gap | review-git §2.7, §4 "External review cards" partial, S4 (kernel K-S4-4; RG-7); integrations rule 13 | *Unbuilt, so `gap`.* The owning spec's §4 says partial: cards enter Review even when gates fail and bypass the board (integrations §4 says built; the two disagree, see restorations) |
| INV:L10 | carried | later | worker-loop rule 12 (the Worker's `docs` reads the repository tier: project docs, a dependency's README and types at the installed version); the tiered corpus design-stage §7 (a persistent project corpus) | *Wrong status.* Rule 12 says the tiered project corpus "is design-stage.md's, Later"; the four-tier `docs` of the old item is not the Worker's in v1. Note: R2 recorded a `webDocs` path in the Worker's `docs` (`workerWebDocs`), which rule 12 ("never the Worker") does not allow — worth a code check |
| INV:O13 | carried | gap | gates rules 19, 22, §4 "`vitest` parser on real output; repro selects the test" not-built, M6 (GT-M6-1) | *Unbuilt, so `gap`.* §4: both repros select zero tests and exit 0 |
| INV:O24 | carried | gap | planner-pm §2.12, §9 (re-split proposed instead of pausing, with the reason), §4 "Signal responses executed as proposals" partial, NEW-planner-pm-5 (PM-N5-2) | *Unbuilt, so `gap`.* The response is printed, not carried out; INV:O21 and INV:P20 are `gap` for the same row |
| INV:O25 | carried | gap | planner-pm §2.12, §4 "Signal responses executed as proposals" partial, NEW-planner-pm-5 (PM-N5-4) | *Unbuilt, so `gap`.* As INV:O24 |
| INV:O26 | carried | gap | review-git §2.2.1–3, §4 "ReviewWIP formula, back-pressure, held cards released" partial, S6 | *Unbuilt, so `gap`.* Same row as INV:B3, already `gap` |
| INV:O35 | carried | gap | gates rules 30–31, §4 "Vision checklist (fail-only)" and "Visual baselines require a person" not-built, NEW-gates-4 (GT-N4-1, GT-N4-2) | *Unbuilt, so `gap`.* INV:G21, the same item, is `gap` |
| INV:O36 | carried | deliberate | as INV:G20 | *Wrong status and stale note*, as INV:G20 |
| INV:O50 | carried | gap | context rule 25, §4 "Exemplars as accepted diff hunks" not-built, M1 (CX-M1-7, CX-M1-11); fixing commits Later (context §7) | *Unbuilt, so `gap`.* Same store as INV:C13, already `gap` |
| INV:O52 | carried | deliberate | measurement rule 24 (the > 300-token overhead kept; the ≥ 3-point gain replaced by the admission record's paired credit, with the reason "which the 30-card suite cannot detect"); §4 "Diagnostics on real inputs" partial, NEW-measurement-2 | *Wrong status.* One of the "both halves" was changed on purpose |
| INV:O58 | carried | gap | extensibility rules 11–12 (EXT-32 built for the manifest line), §4 "Skills format…" partial, NEW-extensibility-4 (after restoration: EXT-22a for the required-tools omission) | *Unbuilt, and no criterion.* `skills.ts` reads no required `tools`, so a skill is never omitted for lacking them (R2 C9 said the same); no EXT criterion covers it |
| INV:O59 | carried | gap | extensibility rules 15, 17, §4 "Skills: SHA-256 pin, approve/revoke, audit" partial, S9; EXT-27 (NEW-extensibility-4) | *Unbuilt, so `gap`.* Same as INV:C10, already `gap`; EXT-27 is a §5 change criterion |
| INV:O61 | carried | gap | extensibility rule 10, §4 "Skills format…" partial, NEW-extensibility-4 | *Unbuilt, so `gap`.* `scripts/`, `references/`, `evals/` are ignored; INV:C9 is `gap` |
| INV:O64 | carried | gap | as INV:C19 | *Unbuilt, so `gap`*, as INV:C19 |
| INV:O71 | carried | deliberate | surface rule 23 (the old `[overnight] hours` became `[machine] reserved_hours`, with the reason), rule 25 (`machine.hours` → `reserved_hours`); `power_budget_kwh_day` kept | *Wrong status.* The hours key was renamed and its meaning inverted on purpose |
| INV:O87 | carried | gap | integrations rule 7 (after restoration: a §4 row and INT-11e) | *Unbuilt, with no change ID.* `capabilities.maxDepth` is declared (`remote.ts:38`, `:104`, `:183`) and read by nothing |
| INV:O93 | carried | gap | worker-loop rule 10, §4 "Fixed tool set per class, stable array" not-built, M2 (WL-M2-1) | *Unbuilt, so `gap`.* `implement` falls through to all 28 tools; INV:L18, the same item, is `gap` |
| INV:O102 | carried | gap | models rules 20a, 22, §4 "One residency scheduler…" not-built, NEW-models-9 (MD-N9-3) | *Unbuilt, so `gap`.* Nothing checks footprints before a load; the escalated retry can load the Worker beside a 12 GB model (integration review C1–C4) |
| INV:D8 | carried | carried | kernel rule 6 Attempt bullet (stop reason, tokens and seconds used, evidence id) and Card bullet (after restorations R2 and below); planner-pm §2.6.1 (actuals written back on acceptance) | *Lost precision.* The row's own note says "runner write not a stated behaviour": `CardRunner.finish` writing the actuals onto the card is stated nowhere |
| INV:O30 | deliberate | deliberate | review-git §2.6.3, §9 (R1) | *Location.* "review-git rule 3" is ambiguous (see INV:K28) |
| INV:D2 | carried | carried | review-git §2.6.3 (checkpoint database record) | *Location.* As INV:K28 |

**Checked and right (no line above):** the other 260 inventory rows, and PMFE:432 — the only §5.3/§5.4 row whose location cites a kernel rule number. Its "kernel rule 20 / §3" was written by a fix pass in the current numbering and is right: rule 20 is the card dossier and names `card/repair_plan`; kernel §4 "Repair-plan dossier entry" is not-built, so `gap` stands. (PMFE:450 cites kernel §3, a section, and is right.) No uncorrected INV row still carries a pre-renumbering kernel rule number: every kernel rule cited (6, 7, 15, 17, 18, 19, 25, 31, §2.1–§2.4) was checked against the current text.

## Spec restorations

Each is exact text to add, tied to the rows above. None is applied; no repository file was edited. Note first: the restorations of corrections_hd_inv.md (R1–R4 on kernel rule 6, among others) are **not applied** in the working tree — kernel rule 6 still has no Card or Gate result bullet — so every row that says "(after restoration)" there still points at missing text.

### `docs/design/specs/kernel.md` — §2 rule 6, Card bullet (INV:D8; extends corrections_hd_inv R2)
Append to R2's Card bullet:
> When an attempt finishes, the runner writes its actuals onto the card — stop reason, tokens used, seconds used, steps used, evidence id and context pack id (`CardRunner.finish`) — so the planner's estimates read the actuals back ([planner-pm.md](../../design/specs/planner-pm.md) §2.6.1).

### `docs/design/specs/security.md` — §2 rule 18 (INV:Y5)
Append:
> Every harness git call passes its arguments as an argument vector (`execFileSync("git", args)`, `runGit` in `packages/sync/src/git_adapter.ts`), never as a shell command line, so a model-authored commit message, card title or branch name never reaches a shell.

### `docs/design/specs/security.md` — rule 42a, §4, §5 S3a (INV:L20)
In rule 42a, replace "it reads and screenshots only" with "it reads a page's text and its accessibility tree, and screenshots it — nothing else". Add a §4 row:
> | `browse` returns the accessibility tree; screenshots stored in the evidence | not-built | `dumpDom` returns page text only (`packages/sandbox/src/browser.ts`); no screenshot or accessibility tree | S3a |

Add after SEC-17a:
> - **SEC-17b** WHEN the `browse` tool opens a page THE SYSTEM SHALL return the page's text and its accessibility tree, and SHALL store every screenshot it takes in the card's evidence bundle.

### `docs/design/specs/models.md` — §3 (INV:M10)
Add a contract row:
> | Scripted adapter for tests and replays `MockInferenceAdapter`: rules tried first, each matched against the request's system prompt, prompt and messages (a string as a substring, a `RegExp`, or a predicate), optionally retired after `times` uses; then queued responses in order; every request kept in `callHistory`; an exhaustion mode when the script runs out — `cycle`, `default`, or `throw` (`MockExhaustedError`) ([DEFINITION_OF_DONE](../../../DEFINITION_OF_DONE.md) §2D.2) | `packages/models/src/mock_adapter.ts` |

### `docs/design/specs/models.md` — §4 and §5 NEW-models-4 (INV:M24)
Add a §4 row:
> | Engine chosen by measurement and applied | not-built | `selectEngine` saves `profile.engine` (`calibrate_cmd.ts`), which nothing reads when a model is launched; its cache-retention input is the calibrate process's own, always empty, telemetry | NEW-models-4 |

Add after MD-N4-10:
> - **MD-N4-11** WHEN the machine profile records an engine choice THE SYSTEM SHALL launch or attach every role's model through that engine's adapter; and WHEN `sekhemet calibrate` chooses the engine THE SYSTEM SHALL weight cross-step prefix-cache retention measured from recorded steps' cached and evaluated prompt tokens, and SHALL say when no steps were recorded.

### `docs/design/specs/context.md` — §4 and §5 NEW-context-5 (INV:C20)
Add a §4 row:
> | Per-card context metrics: peak context, steps to first gate pass, pass rate against pack size | not-built | no such figure is computed or recorded anywhere in the code | NEW-context-5 |

Add after CX-N5-3:
> - **CX-N5-4** WHEN a card's attempt ends THE SYSTEM SHALL record its peak prompt tokens, the step of its first gate pass (or none) and its Zone 3 pack size, and the capability report SHALL give the pass rate by pack-size bucket for each card class.

### `docs/design/specs/planner-pm.md` — §2.11.1 (INV:P17)
Append to item 1:
> The record (`Goal`, `goals.ts`) holds: its id; the workspace and the projects it spans; a one-sentence statement (an outcome, not an activity); its criteria, each with an id, text, kind, a check (a gate reference or a metric query) and a status `unmet`, `met` or `unverifiable`; a budget of tokens and hours with an optional deadline; its strategy (the versioned plan it pursues); and its state — `draft`, `active`, `blocked`, `met` or `abandoned`.

### `docs/design/specs/planner-pm.md` — §4 and §5 P6 (INV:P16)
Add a §4 row:
> | A process profile's ceremonies run on their cadence | not-built | `ceremoniesDue` only prints "Ceremony due" (`wave2.ts:359`); no retrospective runs from a profile | P6 |

Add after PM-P6-15:
> - **PM-P6-16** WHEN a process profile's retrospective falls due — at the end of a cycle, or every `retroEveryCards` cards — THE SYSTEM SHALL run the retrospective session over the window's gate failures and post its proposed playbook rules and budget adjustments as proposals, and SHALL NOT only print that the ceremony is due.

### `docs/design/specs/extensibility.md` — §4 and §5 NEW-extensibility-4 (INV:O58)
In the §4 row "Skills format: …", add "required `tools` unread" to the capability. Add after EXT-22:
> - **EXT-22a** WHEN a skill declares `tools` that the card's class set does not include THE SYSTEM SHALL leave the skill's manifest line and body out of that card's prompt, and record the omission in the card's evidence.

### `docs/design/specs/integrations.md` — §4 and §5 P9 (INV:O87; INV:X15)
*Applied in B4.9 (2026-09-25): the §4 row, INT-11e, and the External review cards row now partial, S4.*

Add a §4 row:
> | Hierarchy depth clamped to the tracker's | not-built | `capabilities.maxDepth` is declared (`remote.ts:38`, `:104`, `:183`) and read by nothing | P9 |

Add after INT-11d:
> - **INT-11e** WHEN cards are pushed to a tracker whose declared `maxDepth` is shallower than their nesting THE SYSTEM SHALL write no item deeper than `maxDepth`, link each deeper card to its nearest written ancestor, and report the clamp in the sync result.

And make §4's "External review cards | built" agree with [review-git](../../design/specs/review-git.md) §4, which owns them: "partial | … enter Review even when gates fail and bypass the board (`external_review.ts:141, 244-252`) | S4".

### `docs/design/specs/runtime.md` — §4 (related to INV:M2)
Replace the row "Token streaming to the Steps tab | built" with:
> | Token streaming to the stream (`tokens` events) | built | `liveTokenWriter` (`execute.ts:484-486, 683`); SSE `tokens` (`server.ts:1145-1170`); the Steps tab has no listener yet ([dashboard](../../design/specs/dashboard.md) §4, NEW-dashboard-3) | — |

(runtime §4 says the Steps tab is built; dashboard §4 says the page has no listener. INV:M2 stays `carried` because the adapter streaming it names is built.)

### `docs/design/specs/dashboard.md` — §7 (INV:U17)
The entry "pan and zoom, and the critical path, on the dependency graph (v1 lays it out in layers)" gives no reason. *Proposed* reason, for the lead to confirm:
> — v1's projects hold tens of cards, which the layered layout shows whole; pan and zoom return when a project's dependency graph no longer fits one screen.

### `docs/reference/DESIGN_TRACE.md` — §1 totals and §3
- Inventory row of the §1 table: `carried` 291 → 225, `gap` 73 → 126, `deliberate` 41 → 53, `later` 13 → 14 (still 418). The *All* row moves by the same amounts.
- §3: remove INV:S14 from review-git (9 → 8); add INV:H16 to extensibility (14 → 15) and INV:L10 to design-stage (20 → 21); 114 → 115 items.

## Totals

| Measure | Count |
| --- | --- |
| Rows checked | **339** — 338 uncorrected §5.5 rows (418 less the 80 ending "(corrected 2026-09-25)") and PMFE:432 |
| Rows corrected | **78** |
| – status changed | 67: `carried` → `gap` 53; `carried` → `deliberate` 11; `later` → `deliberate` 1 (INV:S14); `carried` → `later` 2 (INV:H16, INV:L10) |
| – of the `gap` rows, with no EARS criterion until restored | 5 (INV:C20, INV:M24, INV:O58, INV:O87, INV:P16) plus the screenshot half of INV:L20 |
| – location, precision, note or reason only | 11: location (INV:K28, INV:Y3, INV:Y9, INV:O30, INV:D2), lost precision (INV:Y5, INV:M10, INV:P17, INV:D8), stale note (INV:U15), missing reason (INV:U17) |
| Kernel rule numbers stale | 0 (every kernel citation in scope already uses the current numbering) |
| **Error rate** | **78 / 339 = 23.0%** (status errors alone 67 / 339 = 19.8%) |

The rate is above the sample's 12.9% because this pass applied the `partial` → `gap` rule strictly and consistently with the earlier corrections: 53 of the 78 are rows whose owning §4 row is `partial` or `not-built`, and most of them duplicate an item already corrected to `gap` from another source (for example INV:H10 = HD1:86, INV:O35 = INV:G21, INV:O26 = INV:B3). Excluding that class, 25 / 339 = 7.4%.
