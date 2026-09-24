# Raw trace: the three FEATURE_INVENTORY files

*Written by the tracing agent on 2026-09-22 (the old files are at `fb59ba2`). Statuses are as first traced, before the fix passes; the verified final status is in [DESIGN_TRACE.md](../DESIGN_TRACE.md).*

# Trace: docs/reference/FEATURE_INVENTORY.md, FEATURE_INVENTORY_REAUDIT.md, FEATURE_INVENTORY_REAUDIT_2.md
Summary: SUMMARY_PLACEHOLDER

Scope and method. Every numbered unit (K1–K28, S1–S15, Y1–Y20, M1–M25, G1–G27, C1–C22, L1–L31, B1–B13, P1–P25, E1–E19, U1–U21, H1–H27, X1–X29 = 302), the original inventory's 108 "features most likely to be overlooked" (O1–O108, each a number or rule that could be lost), and the eight REAUDIT defects (D1–D8) were traced into `docs/design/specs/*.md`, `SPINE.md`, `DECISIONS.md`, `PM_CONTRACT.md`, `docs/reference/OPEN_QUESTIONS.md` and `PROVENANCE.md`. Every candidate section was read, not keyword-matched.

- **Latest inventory status** is REAUDIT_2 (R2, 2026-09-19, commit `9edc3e5`) for K, S, Y, M, G, C, L, B, P, E, H; REAUDIT (R1, 2026-09-18) for U and X, which R2 did not score.
- **Source column:** `FI:n` = FEATURE_INVENTORY.md line n (the requirement text); `R2:n` / `R1:n` = the latest status row.
- **Status column** is about whether the *feature* is carried by the new design (the brief's six values). Whether the spec's *stated state* agrees with the inventory is given in "Now in" as `agree`, `spec-stricter` (the spec found more missing than the inventory, with newer evidence — not a loss), or **`DISAGREE`**; every DISAGREE is also listed in its own section below with a quick code check where one was possible.
- A spec behaviour with no `State today` row and no change ID is marked "status unstated" — the feature is carried but nobody owns closing it (SPEC README rule 3).

## Needs attention (carried-weaker, contradicted, missing)

| # | Source (file:line) | Item | Status | Where it should go / what was lost |
| --- | --- | --- | --- | --- |
| 1 | FI:136 / R2:150 | M2 token streaming (`generate({onToken})` → SSE `tokens` → Steps tab) | missing | No spec mentions token streaming. Code has it (`apps/harness/src/execute.ts:486,683` `liveTokenWriter`; `http_adapter.ts:725` stream decode). Belongs in models §2 (adapter) + runtime §25 (stream) + dashboard §2.6 Steps. |
| 2 | FI:208 / R2:212 | C2 headless LSP client pool (symbol tools for non-TS files) | contradicted | worker-loop §2.12 says symbol tools work "through the TypeScript language service" and §7 puts symbol tools beyond TS/JS in **Later** (tree-sitter/ast-grep proposed); context §2.28 "No LSP expansion". Code wires an LSP pool into the Worker's tools today (`execute.ts:471` `runLspPool` → `loop/src/tools.ts:1163`). The built capability is undocumented and the spec calls it future work. |
| 3 | FI:107,1490 (O30) / R2:126 | Y3 checkpoint cadence | contradicted | Two specs disagree: runtime §2.11 "after every gate-passing step and at every masked-observation boundary" vs review-git §2.6.3 "a commit every 5 steps when files changed (`checkpointEvery`), and before Verify". Code: runner default 5 (`card_runner.ts:1056`), product passes `checkpointEvery: 1` (`execute.ts:422`); no masking-boundary trigger. One spec must change. |
| 4 | FI:125 / R2:143 | Y20 mid-card external edits | contradicted | integrations §2.5 + INT-33: a scope/criteria edit **pauses** the card; OPEN_QUESTIONS "Design questions" row: "Reconcile at the card's end; **never pause** a card for an external edit". Internal contradiction. |
| 5 | FI:210 (C4), FI:224 (C18), O6 / R2:228 | C18 reasoning traces stripped between steps (per-model `reasoning.stripTraces`) | contradicted | Deliberate reversal: context §2.4 preserves earlier thinking (`preserve_thinking`), strips only at masking points. Not recorded as a DECISIONS entry or "Resolved drift"; the per-model registry flag is gone. |
| 6 | FI:212 (C6), O72 / R2:216 | C6 masking window: observations older than the **two** most recent masked | contradicted | context §2.3: the **five** most recent are never masked outside pressure (tiers may cut to two); `[context] mask_after_observations = 2` and `map_tokens = 1024` removed (surface §2.25); map budget now 1,200 (context §2.13). Deliberate but not in DECISIONS. |
| 7 | FI:151, O44 / R2:165 | M17 prompt-cache flags | contradicted | Old: `--cache-ram` 8–16 GiB, `--ctx-checkpoints 32`, `--checkpoint-min-step 8192`, `-sps`. New context §2.6: 2,048/6 (≤32 GB), 4,096/8 (≤64 GB), 8,192/16; min-step 512–1,024 by measurement; no `--cache-reuse`. **`-sps` (slot prefix similarity) dropped with no reason.** |
| 8 | FI:463 / R1:453 | X29 CHRONICLE `llama-server` launch profile (`-t 2 -ngl 999 -fa on -ctk/-ctv q8_0 -np 2 -c 49152 --ctx-checkpoints 6 --cache-ram 2048 --jinja --metrics --no-webui --reasoning off`, 127.0.0.1:8099) | contradicted | Superseded by the DEC-04 Worker on port 8098 (models §2.2). `-np 2`, `-c 49152`, `--metrics`, `--no-webui`, `-t 2` are not carried for any role; `--metrics` is what server-side telemetry would read. |
| 9 | FI:461 / R1:451 | X27 Chronicle scorecard: Pass@1 ≥ 80% (5 of 6 on turn 1), repair within ≤ 3 rungs, zero test mutation, zero out-of-scope writes, all 6 cards < 18 min on an M4 | carried-weaker | measurement §2.1 keeps Chronicle's 6 cards in the frozen suite; every scorecard target is gone (no spec, no DECISIONS entry retiring them). |
| 10 | FI:462 / R1:452 | X28 Showcase Trifecta targets: 24 cards, < 140 LOC per card, ~39 min autonomous, 98%+ slot-0 prompt-cache hit | carried-weaker | measurement §2.1 keeps onyx/vanguard/basalt-canvas (8 each); 39 min, <140 LOC and 98% are gone (context §2.7 uses a 0.85 median instead). |
| 11 | FI:343 / R2:322 | E1 M0 go/no-go: ≥ 90% valid-and-correct tool execution over 30 seeded tasks × 3 runs at step budgets 50 **and** 150 | carried-weaker | measurement §2.9 / M9 keeps "one measurement path" and `sekhemet m0`; the M0 protocol and its 90% bar are not stated anywhere (only "Phase 0's 11/11 establishes ≥ 76%"). |
| 12 | FI:139, O99 / R2:153 | M5 Qwen3.8-27B pinned sampling: code 0.2 / top_p 0.9, planning 0.7 / 0.8, top_k 20, **min_p 0.0 mandatory to override llama-server's 0.05**, presence_penalty 1.5, reasoning off | carried-weaker | models §2.3 names Dirk-Qwen3.8-27B as Planner and §2.11 says sampling lives in the registry; none of the values, the planning/code split or the min_p-override rule survives. |
| 13 | FI:154, O—(§1032) / R2:168 | M20 watchdog graduated thresholds 85 / **90** / 94% | carried-weaker | models §2.19 names only 0.85 and 0.94 and four levels; the 90% level's actions (throttle parallel cards to 1, trim LSP symbol caches, cascade observation pointers) are gone; runtime §2.22 says "85–90%", dashboard §2.11 Machine "85/90/94%" — three different statements. |
| 14 | FI:187-188 (G18/G19), O37-38 / R2:196-197 | Visual layout **overlap** predicate; screenshot **masking** and **animations off** | carried-weaker | Carried as behaviour (gates §2.29) and the state row says "built", but no change ID covers them and code has neither (`gates/src/visual.ts` checks bounds/overflow at :378-385, diff at 0.01 :76; no overlap, mask or animation handling). Needs a gap row (NEW-gates-4 is the natural home). |
| 15 | FI:370 / R2:331 (C21) | C21 a context-version change **invalidates qualification** | carried-weaker | context §2.27 states it; §4 row "Joint prompt/playbook/tool version: built". Code: `computeContextVersion` is only stamped (`context/src/worker_prompt.ts:813`); invalidation happens only on template change (`models/src/registry.ts:132-145`). No change ID. |
| 16 | FI:111 (Y6), O34 / R2:129 | Y6 rebase conflict → back to the Worker with hunks as typed failures; out-of-scope → park | carried-weaker | review-git §2.6.4 and v1 acceptance state it; §4 says **built**. Code sends every `rebase_conflict` to Planning with a one-line reason (`card_runner.ts:1283`, `:1635-1638`); no typed hunks, no park. No change ID. |
| 17 | FI:112 (Y7), O33 / R2:130 | Y7 restacked children **re-run their gates** | carried-weaker | review-git §2.5.5 + v1 acceptance state it; §4 row "restack on accept: built". Code restacks and records `card/restacked` only (`execute.ts:1378-1389`). No change ID. |
| 18 | FI:327 (P19) / R2:310 | P19 goals re-evaluated "on every card close **and on a timer**" | carried-weaker | planner §2.11.3 drops "and on a timer" and its §4 row says built; code calls `runGoalLoop` only from the queue prelude (`apps/harness/src/wave2.ts:371`). No change ID. |
| 19 | FI:328 (P20), O21 / R2:311 | P20 signal responses executed (halt auxiliary cards + decision request on > 20% drift; re-split hotspot; verification spike; step-budget change) | carried-weaker | planner §2.12 table carried with identical numbers; §4 "Live signals with bounds: built". Code acts only on `escalate_blockers` (`wave2.ts:345-353`). NEW-planner-pm-2 covers only "propose, don't mutate"; executing/proposing the other five responses has no change ID. |
| 20 | FI:422 (H22) / R2:367 | H22 OTel: a span per **tool call**, spans **viewable in the UI** | carried-weaker | runtime §2.30 states both; §4 "Local traces, OTLP export on request: built". Code has card, turn and model spans (`execute.ts:531`, `tracing.ts:157`), no tool span, and no web module renders traces. No change ID. |
| 21 | FI:230 (C? L22), FI:261 / R2:259 | L22 token/seconds/kWh budgets; a card at its cap is **parked** | carried-weaker | runtime §2.19 states it; no State row, no change ID. R2: budget stops go to Verify, no per-card kWh (only the nightly breaker). |
| 22 | FI:124 (Y19) / R2:142 | Y19 monorepo per-package gates in card verification; cross-repo change split into two cards with an edge | carried-weaker | review-git §2.6.5 states it; no State row, no change ID. R2: per-package gates only from `sekhemet gate`, `splitAcrossRepos` has no caller. |
| 23 | FI:324 (P16) / R2:307 | P16 process profiles drive ceremonies (functional retrospective on cadence) | carried-weaker | planner §2.7.3–4 states it; no State row. R2: `ceremoniesDue` only prints (`wave2.ts:359`). |
| 24 | FI:193 (G25), O48 | G25 Pass@k: k ∈ [2,4] on tiers L/XL or overnight, each attempt in an **isolated ephemeral worktree**, cap per tier | carried-weaker | worker-loop §2.37: `pass_at_k` 1–4 from gates.toml, sequential from the same starting tree; per-tier cap and per-attempt isolated worktree not stated (parallel samples in Later). |
| 25 | FI:176 (G8), O12 / R2:186 | G8 top-3 failures "chosen by **topological dependency order**" | carried-weaker | gates §2.20 redefines "dependency order" as rung order (parse, typecheck, test, bounds, lint) then most-referenced file — the import-graph order R2 asked for is not required. |
| 26 | FI:171 (G3) / R2:181 | G3 each layer declares its **runs-on host** | carried-weaker | gates §2.3 keeps the layers; §2.11 gate host is project-wide; per-layer `runs_on` is gone. |
| 27 | FI:169 (G1), O76 / R2:179 | G1 `gates.toml` keys `schedule` (e.g. `"nightly"`), `threshold = {score = 60}`, `[project] languages` | carried-weaker | gates §3 key list omits all three (mutation threshold only "once a stable threshold is known"; nightly mutation is runtime §2.20). `name`→`id`, `required`→`blocking` renames are stated. |
| 28 | FI:179 (G11) / R2:189 | G11 evidence bundle `trajectoryRef` = SHA-256 of the event-log slice; `attemptId`; `structuralDiff` | carried-weaker | gates §2.35: "a reference to the trajectory" (hash lost), `attemptId` not named; structural diff moved to Later (§7). |
| 29 | FI:191 (G23), O29 | G23 a revision that regresses a passing gate returns to **Planning with the regression named** | carried-weaker | kernel §2.25 (re-pass every gate) and gates §2.25 (regression vs base) carried; "to Planning, regression named" is not stated. |
| 30 | FI:195 / R2:205 | G27 gate templates by language (TS: tsc, eslint, prettier / vitest, jest, playwright / Stryker; Python: pyright, ruff / pytest / mutmut; Rust: cargo check, clippy, rustfmt / cargo test / cargo-mutants; Go and Java deferred) | carried-weaker | surface §2.30 says "the gate templates per language are in gates", but gates.md lists only parsers (pytest, cargo test, go test, M6). Template contents, format gates (prettier, rustfmt) and the Go/Java deferral are unowned. |
| 31 | FI:192 (G16) / R2:194 | G16 Semgrep with a **bundled offline community rule set** | carried-weaker | gates §2.3 lists static analysis, §4 "built"; PROVENANCE "community rules only"; nothing requires shipping rules. R2: skipped unless `.sekhemet/semgrep.yml` exists. |
| 32 | FI:91 (S10), FI:183 (G15) / R2:113,193 | S10/G15 supply-chain **download-profile** check; PyPI/crates/go registries | carried-weaker | security §2.44: download count only "recorded for the reviewer"; per-ecosystem registry lookup not stated (R2: Python checked against npm). §4 "built". |
| 33 | FI:207 (C1), O2-O3 / R2:211 | C1 Aider edge-weight multipliers; cache key path + mtime + **content hash** | carried-weaker | context §2.13 keeps PageRank seeded on scope and binary-search fit; edge weights not stated; cache key now "paths, sizes and mtimes" (content hash dropped). |
| 34 | FI:243 (L4) / R2:241 | L4 `read`: byte budget (512 KB), binary detection, **image/PDF passthrough to the vision path** | carried-weaker | worker-loop §2.12 keeps 1-based ranges and the outline rule; the byte budget, binary refusal and image/PDF routing are not stated (X3's attachment path covers cards, not reads). |
| 35 | FI:245-246 (L6, L7) / R2:243-244 | L6 grep three output modes + context lines; L7 glob sorted by **mtime** | carried-weaker | worker-loop §2.12 says only "capped and ignore what git ignores"; modes, context lines and mtime order are unstated (a files+counts mode is an A/B candidate, §2.29). |
| 36 | FI:275 (L29) | L29 observation clamp 2,400 head + 1,200 tail chars; denial text tells the model not to retry | carried-weaker | worker-loop §2.16 keeps "stop and report, not retry"; the clamp sizes are gone (superseded by condensing, context §2.17, but not said). |
| 37 | FI:288 (B2) / R2:275 | B2 edge **Verify → Planning on gate fail** | carried-weaker | kernel §2.17 keeps `planning`; the ladder (worker-loop §2.34) re-plans at rung 3 and parks on stop — the old edge is replaced but no spec says so. |
| 38 | FI:297 (B11), O78 | B11 `order_key` is a lexicographic fractional index | carried-weaker | kernel §2.14 "order keys" resolved before append; dashboard §2.4.5 reorder built; the data structure is not named. |
| 39 | FI:48 (K4) / R2:74 | K4 typed `card_id`, `attempt_id`, `step_id` columns with indexes | carried-weaker | kernel §2.8 "its association columns" only; not named; no State row. |
| 40 | FI:60-61 (K16-K17) / R2:86-87 | K16 attempts `rung` 1..4 and `tool_arm` A/B/C; K17 steps `repo_state_hash`, `success`, `tokens_condensed` | carried-weaker | kernel §2.6 names `AttemptRecord`/`StepRecord` only; worker-loop WL-M3-4 adds finish_reason/token fields to the step record. Code now has `rung`/`tool_arm` (`kernel/src/schema.ts:124-125,320-321`), so R2's K16 finding is stale; `repo_state_hash` per step is still unstated. |
| 41 | FI:72 (K28) / R2:98 | K28 checkpoint **record** in the DB (card, step, git_ref, gate_status, agent_model/harness/role) | carried-weaker | review-git §2.6.3 carries checkpoint commits with trailers and refs; the ledger/DB record `sekhemet replay` reads is not stated. |
| 42 | FI:55 (K11) / R2:81 | K11 "model-visible means logged" runtime assertion (prompt blob stored before `generate`; refuse the request if the store fails) | carried-weaker | SPINE spine rule 2 states it; no spec behaviour, State row or test reference. |
| 43 | FI:50 (K6), FI:51 (K7) / R2:76-77 | K6 `subscribe(filter, cb)`; K7 `getRange(since, limit)` | carried-weaker | runtime §2.25 (stream carries ledger appends) and the route list (`events?since=`); the subscription API and card/type filter are not stated. |
| 44 | FI:88 (S7) / R2:110 | S7 output buffer cap (10 MB, truncation marker) | carried-weaker | runtime §2.8 carries memory cap/OOM (4096 MB, 250 ms sampling); the output buffer cap is gone. |
| 45 | FI:89 (S8), D4 | Ask tier: **how an ask is approved** (decision request answered at `/api/decisions`) | carried-weaker | security §2.25 defines the Ask tier; no spec says who approves an Ask-tier command or how (R1 defect 4 was exactly this). |
| 46 | FI:106-107 (Y13) / R2:136 | Y13 webhook triggers `/plan`, `/split`, `/estimate`, `workflow_dispatch` | later (partial) | Moved to integrations §7 Later (listed in "Moved to Later"); the carried table adds `pull_request.closed`. Listed here because the trigger set shrank. |
| 47 | FI:122 (Y17), FI:123 (Y18) | Release cards; `act` as a gate source | later | integrations §7 (listed below). |
| 48 | FI:346 (E4), FI:453 (X19) / R2:325 | `MODEL_MATRIX.md` bake-off matrix by tier with full settings | carried-weaker | No document names the file; dashboard §2.11 Registry shows "the bake-off matrix". R2: `writeBakeOffMatrix` writes it. Either name the artifact or record its retirement. |
| 49 | FI:355 (E13) / R2:334 | E13 variant archive (DGM, sample parents by performance, restore previous variant pointer) | carried-weaker | measurement §3 contract lists `archive.ts` (register R5) only; not one of the six inlets; no behaviour, State row or decision (OQ2 cuts "the rest" of loops 3,4,5,8,9 — loop 7 not named). |
| 50 | FI:358 (E16), O57 | E16 generated tests **demoted to advisory on rollback** | carried-weaker | measurement §2.17 "advisory until a person promotes it"; the rollback demotion is not stated. |
| 51 | FI:359 (E17), O54 | E17 automatic rollback when pass rate drops over a **moving 10-card window** | contradicted | measurement §2.18 and §4 replace it with a paired comparison (deliberate; §4 explains the 10-card window is noise). Not in DECISIONS. |
| 52 | FI:316 (P8), O17 | P8 questions batched into **one** decision request; a spec with > 3 questions is **rejected** | contradicted | planner §2.10.1: at most two open questions per pass, spec never refused (Resolved drift in planner §9 records it). |
| 53 | FI:319 (P11) | P11 durable async HITL: card parks, compute and VRAM released, context rehydrated on the answer | contradicted | planner §2.10.2: work proceeds on the recommended default meanwhile (only `default_deny` parks). The release-and-rehydrate mechanism is not stated. Deliberate but not recorded as drift. |
| 54 | FI:373 (U3) | U3 fifteen exact Basalt hex values + Sand theme + documented contrast per token | carried-weaker | dashboard §2.13.1 lists the 15 roles and says "the values are in `tokens.ts`, not here"; values changed (Resolved drift, P12 copper). Every hex value now lives only in code. |
| 55 | FI:376 (U6) / R1:372 | U6 virtualization: dual-axis, overscan 3, `translateY`, 60 FPS and < 50 MB DOM at 500+ cards | carried-weaker | dashboard §2.4.9: windowed columns, 500 cards with no main-thread task > 50 ms; horizontal windowing, overscan, 60 FPS and 50 MB DOM dropped (`@tanstack/virtual` rejected — Resolved drift). No State row. |
| 56 | FI:379 (U9), O69 / R1:375 | U9 reload re-streams the log from genesis or a checkpoint for byte-identical state | missing | runtime §2.25 has SSE and WS; replay-from-genesis on reload is not stated anywhere. |
| 57 | FI:383 (U13) | U13 tile: difficulty indicator, token/seconds budget bars, 5-box gate strip | contradicted | dashboard §2.4.4 professional anatomy: difficulty moves to the peek drawer, budget bars removed, gate pips per configured gate (Resolved drift). |
| 58 | FI:387 (U17) / R1:383 | U17 pan-and-zoom DAG canvas, critical path, Sugiyama layering | carried-weaker | dashboard §2.4.18 `#/graph` (built); pan/zoom and critical path not stated; "dependency lines over the board" is Later. |
| 59 | FI:388 (U18) / R1:384 | U18 telemetry sparklines (memory, tok/s, cache hit) | contradicted | dashboard §7 puts "Sparklines of tokens/s on Machine" in **Later**, but `packages/ui/web/sparkline.js` ("U18: memory, decode speed and prefix-cache hit rate") is used by `machine.js`. Spec lists a built feature as future. |
| 60 | FI:391 (U21) | U21 `IBoardUIState` client state (active project, selection, pending decisions, telemetry stream) | missing | dashboard §3 lists per-browser settings and `store.js` only by module list; no client-state contract. Low impact. |
| 61 | FI:144 (M10) / R2:158 | M10 mock inference adapter contract (prompt-pattern rules, exhaustion mode, history) | missing | Not in any spec (test infrastructure). Low impact. |
| 62 | FI:138 (M4) / R2:152 | M4 adapter `healthCheck()` contract | carried-weaker | models §2.15 carries server identity via `/props` (M4 not-built); a health-check contract per adapter is not stated. |
| 63 | FI:155-157? (M19), O—(§574) | M19 draft-model (`-md`) speculative decoding qualified per machine | carried-weaker | models §2.13 keeps MTP-by-measurement with two draft tokens; draft-model speculation is gone. |
| 64 | FI:157 (M23) / R2:171 | M23 bake-off on **tasks from the repo's own history** | carried-weaker (status) | models §2.30 states it; the §4 row "Bake-off under the real harness: partial" names only the settings defect; R2's main gap (it runs `--fixture chronicle`) has no change ID. |
| 65 | FI:454 (X20) | X20 licence rule: AGPL/GPL components run as a **separate process over a socket, replaceable by configuration**; every component has an owner section saying what happens if removed | carried-weaker | PROVENANCE's "Use" column and the licence gate carry enforcement; the separate-process rule and the per-component "if removed" owner section are not stated as rules. |
| 66 | FI:455 (X21) / R1:445 | X21 `fixtures/` generator: TS, Python and Rust miniature repos; `createTestWorktree()` < 10 ms | missing | Nothing in the new docs. |
| 67 | FI:457 (X23) | X23 `pnpm test:unit` / `test:integration` split | missing | Nothing in the new docs. |
| 68 | FI:458 (X24) | X24 `pnpm dev` (`tsx apps/harness/src/index.ts daemon`) | missing | Nothing in the new docs. |
| 69 | FI:459 (X25) | X25 whole-monorepo suite under 3 s | missing | Nothing in the new docs (R2 measured 28.9 s; if retired, say so). |
| 70 | FI:441 (X7) | X7 research embeddings: Qwen3-Embedding + lexical + reranker, "appropriate only here" | contradicted | design-stage §2.7.8: retrieval is lexical BM25; dense index rejected (DEC-22). Deliberate, recorded. |
| 71 | FI:440 (X6) / R1:430 | X6 fetch pipeline: trafilatura / Docling / Playwright fallback; **deduplicated by hash** | carried-weaker | design-stage §2.6.3 one polite path; extractors in Later (§7); heading-sized chunks kept (§2.7.8); hash dedup not stated. |
| 72 | O101 (CHRONICLE §5 gotcha 1) | Bracketed placeholders banned from prompt templates (Qwen copies them verbatim); use numbered requirements + empty file skeletons | missing | Not in context §2.20-21 or anywhere. |
| 73 | O104 (AGENTS §2) | `GateStatus: suspended-quota` and `Agent-Role: relay-finisher` as protocol values for the quota-wall handoff | missing | Not in any spec (DoD:169 keeps `suspended-quota` for human/agent commits; `relay-finisher` nowhere). Retire explicitly or carry. |
| 74 | O86 (§1302) | GitHub GraphQL has a **separate rate budget**; prefer webhooks over polling; batch nested queries; idempotency keys per synced entity | carried-weaker | integrations §2.9 (idempotent sync) and §2.11 (backoff on primary/secondary limits) carried; separate budget, batching and webhook preference not stated. |
| 75 | O90 (§1346-1354) | Check Run annotation `raw_details` | carried-weaker | integrations §2.14 lists "path, lines, level, message, title"; `raw_details` dropped. Minor. |
| 76 | O92 (§1292), FI:115 (Y10) | Conflicts: last-writer-wins by timestamp, losing value in history | contradicted | integrations §2.4: per-field three-way merge against the last-sync snapshot, losing value kept (INT-4..6). Deliberate improvement. |
| 77 | O93 (§663, §674) | Card class → tool set: reviewer = read/grep/glob; implementer adds edit/bash; researcher = read/fetch | carried-weaker | worker-loop §2.10 keeps `CLASS_TOOLS` per class; the per-class sets are not stated (M2 decides the implement set). |
| 78 | O83 (§820, §1859) | **Every** review return reason becomes a candidate playbook rule | contradicted | review-git §2.4 / planner §2.13.2: only when it names a file, symbol, gate or error pattern. Deliberate narrowing, with evidence. |
| 79 | O73 (§2012-2014) | `[loop] stall_window = 3`, `max_rungs = 4` as config | contradicted | surface §2.25 removes both ("not a tunable"); worker-loop §2.20 thresholds fixed. `default_step_budget = 40` kept. Deliberate. |
| 80 | O106 (DoD §2.B) | At least two negative/boundary cases per happy path | carried-weaker | DoD §2.B (line 30) keeps it; gates OQ2 recommends making it risk-based ("aspirational elsewhere"). Flag for the owner. |
| 81 | FI:410 (H10) / R2:355 | H10 MCP tool still named `sekhemet_ask_merit` (persona is Seshat) | carried-weaker | extensibility §2.18 lists tools but not the rename. Minor. |
| 82 | FI:419 (H19) / R2:364 | H19 rewind "invalidate subsequent gate passes" | carried | kernel K-S7-8 (not-built S7) — listed only because the inventory said BUILT and the spec found the evidence path still honours stale evidence (spec-stricter, not a loss). |

## Status disagreements (spec "State today" vs latest inventory)

Only real disagreements are listed; where the spec found *more* missing than the inventory with newer, file-cited evidence, it is `spec-stricter` in the full trace, not here, unless the code contradicts the spec.

| Unit | Inventory (latest) | Spec says | Quick code check | Which is right |
| --- | --- | --- | --- | --- |
| S4 fail closed | R2 BUILT | security §4 not-built (S3b) | `execute.ts:315`, `:1051`, `index.ts:733` pass `requireConfinement: ctx.restrictedMode` (explicit `false` when not restricted) to the **gate** sandboxes; the Worker's tool sandbox defaults closed (`loop/src/tools.ts:218`, `sandbox/src/executor.ts:130-134`) | Spec, for gates; R2 for Worker tools |
| M15 throughput floors | R2 BUILT | models §4 not-built ("no production caller") | `wave2.ts:322` queue prelude → `assertModelRunnable` → `assertThroughputFloor` (`calibration.ts:666`) | R2 (queue path only; `run` has no check) — spec's evidence line is wrong |
| M18 cache hit alert | R2 BUILT | context §4 "acted on: not-built" | `PrefixCacheMonitor(CACHE_ALERT_THRESHOLD)` in the queue report (`telemetry.ts:222`, `index.ts:1261`) | Both partly: an alert in the queue report exists; nothing acts per the new "median after first turn" rule |
| K12 hooks (`playbook/propose`) | R2 SHALLOW | extensibility §4 built | emitted at `apps/harness/src/learning/store.ts:190` | Spec (R2 stale) |
| K16 attempts `rung`/`tool_arm` | R2 SHALLOW | kernel silent | `kernel/src/schema.ts:124-125` | Code has them (R2 stale); spec should name them |
| K23 `busy_timeout` test | R2 SHALLOW (no test) | kernel lists `pragmas.spec.ts` | `kernel/tests/pragmas.spec.ts:34` asserts 5000 | Spec (R2 stale) |
| P15 trust calibration | R2 DEAD | planner §4 built (`sekhemet assume`) | `wave2.ts:665` `assume` verb; `rest_extra.ts:267` → `recordAssumptionOutcome` | Spec (R2 stale) |
| C19 progressive tools | R2 SHALLOW (never switched on) | worker-loop §2.11 CLI path uses progressive loading | `execute.ts:476` `progressiveTools: true` | Spec (R2 stale) |
| C4 four zones / byte-stable | R2 BUILT | context §4 partial (M8) | not checked | Spec (newer review with 120 real prompts) |
| C21 context version invalidates qualification | R2 SHALLOW | context §4 built | invalidation only on template change (`registry.ts:132-145`) | **R2** — spec overclaims |
| G18 overlap / G19 mask, animations | R2 SHALLOW | gates §4 "bounds, screenshot diff: built" | none of the three in `gates/src/visual.ts` | **R2** — spec overclaims |
| G16 Semgrep | R2 SHALLOW | gates §4 security layer built | not checked (R2: skipped without project rules) | R2 on depth |
| S10/G15 supply chain | R2 SHALLOW | security §4 built | not checked | R2 on depth (download floor, PyPI/crates) |
| S12/H27 restricted | R2 BUILT | security §4 partial (visual gate still runs) | not checked | Spec (newer evidence `session.ts:1710`) |
| Y6 rebase conflict | R2 SHALLOW | review-git §4 built | `card_runner.ts:1283`, `:1635-1638` → Planning, no typed hunks | **R2** — spec overclaims |
| Y7 restack re-runs gates | R2 SHALLOW | review-git §4 built | `execute.ts:1378-1389` no gate run | **R2** — spec overclaims |
| Y20 mid-card edits | R2 BUILT | integrations §4 not-built (probe: snapshot overwritten) | `reconcileExternalEdit` wired (`wave2_github.ts:246`); the probe's defect not re-checked | Spec (probe is newer) |
| Y10 SyncAdapter | R2 BUILT | integrations §4 partial | not checked | Spec-stricter (no pagination, whole-card LWW) |
| M11 registry | R2 BUILT | models §4 not-built (values hard-coded in five factories; keyed by host; test leakage) | not checked | Spec (newer evidence) |
| L18 class tool sets | R2 BUILT | worker-loop §4 not-built (`implement` falls through, `tool_catalog.ts:498`) | not checked | Spec (newer evidence) |
| P19 goal loop | R2 SHALLOW | planner §4 built | `runGoalLoop` only at `wave2.ts:371` | **R2** — spec overclaims |
| P20 signals | R2 SHALLOW | planner §4 built | only `escalate_blockers` acted (`wave2.ts:345-353`) | **R2** — spec overclaims |
| B12 override on security gate | R2 SHALLOW | kernel §4 "Security gate never overridden: built" | not checked (spec cites `board_service.ts:282`, `entry_conditions.spec.ts:93`) | Spec (R2 stale, probably) |
| H6 `gate <card>` | R2 BUILT | gates §4 T1 not-built (CLI skips project gates) | not checked | Spec (newer F5, F14) |
| H15 config chain | R2 SHALLOW (card layer unused) | surface §4 "Config layers and `--set`: built" | `config_apply.ts:47` accepts `card.configOverrides`; no caller supplying them checked | R2 on the card layer |
| H22 OTel | R2 SHALLOW | runtime §4 built | no tool span; no traces view in `packages/ui/web` | **R2** — spec overclaims |
| H17/K27 retention, resume | R2 BUILT | runtime §4 partial | not checked | Spec-stricter |
| U15 decision component | R1 MISSING | dashboard §2.5.14 behaviour, **no State row** | `packages/ui/web/decision.js` exists | Code built since R1; spec should add a row |
| U17 DAG | R1 MISSING | dashboard §4 Dependencies built | `packages/ui/web/dag.js`, `graph.js` | Spec (R1 stale) |
| U18 sparklines | R1 MISSING | dashboard §7 Later | `packages/ui/web/sparkline.js` used by `machine.js` | Code built; **spec wrong** to call it Later |
| M2 streaming | R2 BUILT | absent | `execute.ts:486,683` | Code built; spec missing |
| C2 LSP pool | R2 BUILT | Later / "no LSP stage" | `execute.ts:471`, `tools.ts:1163` | Code built; spec contradicts |

## Moved to Later (for the owner)

| # | Source | Item | Now in |
| --- | --- | --- | --- |
| 1 | FI:53 (K9) | Service container | Cut: extensibility §2.29, DEC-09 (OQ2 corrects the reason) |
| 2 | FI:54 (K10) | Plugin manager (tools, gates, sync adapters, UI panels), reversible mount | extensibility §7 Later; EXT-28 (v1 loads nothing) |
| 3 | FI:84 (S3) | Landlock + seccomp as the Linux mechanism | DEC-21 substitution (bubblewrap); security §2.17 (hardening layers on top) |
| 4 | FI:95 (S14), O43 | Copy-on-write worktrees (APFS clonefile, reflink) | DEC-21; review-git §7 |
| 5 | FI:122 (Y17), O84 | Release cards: git-cliff changelog, semver bump, publish GitHub Release | integrations §7 (`sekhemet dev release` proposes and tags; publishing later) |
| 6 | FI:123 (Y18), O85 | CI as a gate source via `act` | integrations §7 |
| 7 | FI:118 (Y13 part) | Webhook comment commands `/plan`, `/split`, `/estimate`; `workflow_dispatch` | integrations §7 |
| 8 | FI:121 (Y16 part), O89 | Review threads → repair subtasks, `resolveReviewThread` | integrations §7 (`openThreads`/`resolveThread` cut until then) |
| 9 | FI:209 (C3) | SWE-Pruner learned line pruning | context §7, DEC-21 (keyword heuristic), measurement §2.16 null baseline |
| 10 | FI:351 (E9), O53 | Loop 3 prompt evolution (≥ +5% or drop) | context §7, measurement §7 (GEPA), runtime §7 (overnight optimiser) |
| 11 | FI:357 (E15), O56 | Loop 9 on-the-fly tool synthesis (repeated bash chains) | Register R6 "triaged, not in v1" (worker-loop §9; extensibility §9); security OQ1 recommends cutting `--validate-tools` |
| 12 | FI:414 (H14) | ACP card-level editor surface (open card, stream steps, approve/return) | extensibility §7 (ACP is PM chat in v1) |
| 13 | FI:416 (H16 part) | User-defined slash commands as Markdown templates (`/onboard`, `/retro`, `/split`, `/bake-off`, `/goal`) | extensibility §7 |
| 14 | FI:425 (H25) | Packaged offline installers per platform | DEC-21 (source installer); security §2.45 |
| 15 | FI:443 (X9) | Documentation cache TTLs (old: official 90 d, blogs 14 d) | design-stage §7 (new: unversioned docs 90 d, llms.txt/papers 30 d, blogs/forums/issues 14 d, registry/search 1 d) |
| 16 | FI:444 (X10 part) | Mirrors as services (verdaccio, devpi, crates) | security §7 (v1: lockfile allowlist) |
| 17 | FI:377 (U7 part) | Master multi-project board; goal view with strategy graph | dashboard §7, planner §7 |
| 18 | FI:378 (U8 part) | Intent-grouped diffs by difftastic | dashboard §7 (v1 groups by scope) |
| 19 | FI:179 (G11 part), FI:113 (Y8 part) | Structural diff inside the evidence bundle | gates §7 |
| 20 | FI:298 (B12 part) | Reroute and Explain as board commands | planner §7 |
| 21 | FI:260 (L? parallel) , G25 | Parallel pass@k samples | worker-loop §7 |
| 22 | O60 (§1678) | Every skill ships at least one eval card | extensibility §7 (v1 runs the evals a skill has) |
| 23 | O97 (§1697) | ast-grep / tree-sitter structural tools for languages without a language server | worker-loop §7, context §7 (proposals) |
| 24 | FI:211 (C1 part) | Multi-language repo map | context §7, DEC-20 |
| 25 | FI:390? (U18) | Sparklines on Machine | dashboard §7 — **but already built** (see Needs attention 59) |
| 26 | FI:419 (H19 part) | Rewind from the card view | dashboard §7 (CLI and HTTP rewind are v1) |
| 27 | FI:452 (—) | Promoting a background process to a project service | runtime §7 |
| 28 | FI:231 (C? L? ) | Symbol tools beyond TS/JS | worker-loop §7 — **contradicts built LSP pool** (Needs attention 2) |
| 29 | FI:348 | Calibrating ask-vs-assume against ClarEval | planner §7 (override-rate shift is v1) |

## Full trace

### Kernel (FI K rows; R2 status)

| # | Source | Item | Status | Now in (file § or :line) |
| --- | --- | --- | --- | --- |
| K1 | FI:45 / R2:71 | SHA-256 hash-chained append-only log, genesis, immutable | carried | kernel §2.7-8, §4 built — R2 BUILT, agree |
| K2 | FI:46 / R2:72 | Verification names first broken seq | carried | kernel §2.9, K-1; runtime §2.29, RUN-32 — agree (adds incremental verify, NEW-kernel-1) |
| K3 | FI:47 / R2:73 | Separate `payload_hash`, canonical JSON | carried | kernel §2.8 — agree |
| K4 | FI:48 / R2:74 | Typed card/attempt/step columns + indexes | carried-weaker | kernel §2.8 "association columns"; no row — R2 BUILT, status unstated |
| K5 | FI:49 / R2:75 | Actor enum CHECK | carried | kernel §2.16 (`EVENT_ACTORS`, CHECK + append; 13 actors; principal separate, NEW-kernel-2) — agree |
| K6 | FI:50 / R2:76 | `subscribe(filter, cb)` | carried-weaker | runtime §2.25 (stream of ledger appends) — R2 BUILT; API/filter unstated |
| K7 | FI:51 / R2:77 | `getRange(since, limit)` | carried-weaker | runtime §3 routes `events?since=` — R2 BUILT; no behaviour statement |
| K8 | FI:52 / R2:78 | Projection rebuild, byte-identical | carried | kernel §2.13, K-2, §4 built — agree |
| K9 | FI:53 / R2:79 | Service container | later | cut: extensibility §2.29, DEC-09 — R2 SHALLOW |
| K10 | FI:54 / R2:80 | Reversible plugin manager | later | extensibility §7, EXT-28 — R2 SHALLOW |
| K11 | FI:55 / R2:81 | Model-visible means logged, runtime assertion | carried-weaker | SPINE rule 2 only — R2 BUILT, status unstated |
| K12 | FI:56 / R2:82 | 10-event waterfall hooks (observe, block, inject), outside sandbox | carried | extensibility §2.3-6, §4 built — R2 SHALLOW; **DISAGREE**, code emits `playbook/propose` (`learning/store.ts:190`): spec right |
| K13 | FI:57 / R2:83 | 4-level hierarchy cap | carried | kernel §2.1, K-3 (`MAX_CARD_DEPTH = 2`) built — agree |
| K14 | FI:58 / R2:84 | `projects` table | carried | kernel §2.2, §2.6 `ProjectRecord`; built — agree |
| K15 | FI:59 / R2:85 | Dependencies DAG, cycle refusal, eligibility | carried | kernel §2.3, §4 built — agree |
| K16 | FI:60 / R2:86 | `attempts` table incl. `rung`, `tool_arm` | carried-weaker | kernel §2.6 `AttemptRecord` only — R2 SHALLOW; code now has both columns (`schema.ts:124-125`), R2 stale; spec silent |
| K17 | FI:61 / R2:87 | `steps` table incl. `repo_state_hash`, `success`, `tokens_condensed` | carried-weaker | kernel §2.6 `StepRecord`; worker-loop WL-M3-4 (M3) — R2 SHALLOW; fields unstated |
| K18 | FI:62 / R2:88 | `gate_results` table | carried | kernel §2.6, §2.13 — agree |
| K19 | FI:63 / R2:89 | `evidence_bundles` table fields | carried-weaker | kernel §2.13; gates §2.35 (T1 partial) — R2 SHALLOW, agree |
| K20 | FI:64 / R2:90 | `decision_requests` table | carried | kernel §2.6; planner §2.10, §4 built — agree |
| K21 | FI:65 / R2:91 | Competence entries driving budgets/routes | carried | models §2.32, §4 partial (NEW-models-6: prediction/decision/outcome) — spec-stricter |
| K22 | FI:66 / R2:92 | Full card record shape | carried | kernel §2.6 types; planner §2.1.5; PM_CONTRACT §2 — agree |
| K23 | FI:67 / R2:93 | `busy_timeout = 5000` (with a test) | carried | kernel §2.27, tests `pragmas.spec.ts` — R2 SHALLOW; code test exists (`pragmas.spec.ts:34`), R2 stale |
| K24 | FI:68 / R2:94 | Column enum incl. Planning | carried | kernel §2.17 nine states, §4 built — agree |
| K25 | FI:69 / R2:95 | Difficulty 1..10 | carried | planner §2.4; K-S7-1 (difficulty 11 refused) — agree |
| K26 | FI:70 / R2:96 | Packs/evidence under `.sekhemet/` by hash | carried | kernel §2.15; §4 "ledger only durable channel" partial S7 — agree |
| K27 | FI:71 / R2:97 | 30-day retention | carried | runtime §2.33, NEW-runtime-4 partial — R2 BUILT, spec-stricter |
| K28 | FI:72 / R2:98 | Checkpoint DB record with attribution | carried-weaker | review-git §2.6.3 commits/refs only — R2 BUILT; DB record unstated |

### Sandbox (S)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| S1 | FI:82 / R2:104 | Seatbelt profile, writes only to worktree/tmp | carried | security §2.9-13, §4 built — agree |
| S2 | FI:83 / R2:105 | Commands run under `sandbox-exec` | carried | security §2.13 — agree |
| S3 | FI:84 / R2:106 | Linux namespaces + Landlock + seccomp | later | DEC-21 (bubblewrap), security §2.14-17, §4 partial S1/S3 — agree |
| S4 | FI:85 / R2:107 | Fail closed when confinement missing | carried | security §2.7, §4 not-built S3b — R2 BUILT; **DISAGREE** (see table: gates opt out) |
| S5 | FI:86 / R2:108 | Network denied; allowlist proxy; request log with payload hash | carried | security §2.28-33; proxy built, hardening S3 — spec-stricter |
| S6 | FI:87 / R2:109 | Timeout SIGTERM → 500 ms → SIGKILL | carried | runtime §2.7, §4 built — agree |
| S7 | FI:88 / R2:110 | Buffer cap / OOM detection | carried-weaker | runtime §2.8 (tree memory, 4096 MB, 250 ms); 10 MB output cap lost — R2 BUILT |
| S8 | FI:89 / R2:111 | Allow/Ask/Deny, Deny wins, protected paths incl. loop/gates/sandbox | carried | security §2.25-27, §4 built — agree (Ask approval path: Needs attention 45) |
| S9 | FI:90 / R2:112 | `<untrusted_content>` tagging, stricter step policy | carried | security §2.42, SEC-40, §4 built — agree |
| S10 | FI:91 / R2:113 | Supply chain: existence, age, download profile, Levenshtein | carried-weaker | security §2.44 (30 days, distance 2/1, separators; downloads recorded only), §4 built — R2 SHALLOW; DISAGREE on depth |
| S11 | FI:92 / R2:114 | `osv-scanner` offline | carried | security §2.44 — agree |
| S12 | FI:93 / R2:115 | Restricted mode | carried | security §2.43, worker-loop §2.13, §4 partial S3a — R2 BUILT, spec-stricter |
| S13 | FI:94 / R2:116 | Worktree manager (create/cleanup) | carried | security §2.24a; review-git §2.6.2 built — agree |
| S14 | FI:95 / R2:117 | CoW worktrees + linked deps | later | DEC-21, review-git §7; linked `node_modules` in security §2.24 (`.venv` unnamed) — agree |
| S15 | FI:96 / R2:118 | Per-card env allowlist | carried | security §2.6, §4 built — agree |

### Sync and git (Y)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| Y1 | FI:106 / R2:124 | Branch `sekhemet/<project>/<card-id>-<slug>` from parent branch | carried | review-git §2.6.2, §4 built — agree |
| Y2 | FI:107 / R2:125 | Checkpoint commit trailers; `refs/sekhemet/checkpoints/<card-id>` | carried | review-git §2.6.3, §2.5.5, §4 built — agree |
| Y3 | FI:108 / R2:126 | Commit after every gate-passing step and every masking boundary | contradicted | runtime §2.11 vs review-git §2.6.3 (every 5 steps); code `checkpointEvery: 1` (Needs attention 3) |
| Y4 | FI:109 / R2:127 | Squash into intent-grouped Conventional Commits | carried | review-git §2.5.4; real trailers S5 — agree |
| Y5 | FI:110 / R2:128 | Injection-safe git | carried | security §2.18-20 (absolute path, pinned env, hardened config) — agree |
| Y6 | FI:111 / R2:129 | Rebase before Verify; typed conflicts; out-of-scope parks | carried-weaker | review-git §2.6.4, §4 built — R2 SHALLOW; **DISAGREE**, code supports R2 |
| Y7 | FI:112 / R2:130 | Stacked branches; accept restacks and re-runs gates | carried-weaker | review-git §2.5.5, §4 built — R2 SHALLOW; **DISAGREE**, code supports R2 |
| Y8 | FI:113 / R2:131 | difftastic structural diff | carried | review-git §2.6.6 partial S5; gates §7 (in bundle later) — spec-stricter |
| Y9 | FI:114 / R2:132 | Head sha, diff generation | carried | implied by review-git §2.2 (repo-state hash) and gates §2.35 (diff) — agree |
| Y10 | FI:115 / R2:133 | `SyncAdapter` pull/push/update/capabilities; conflict rule | carried | integrations §2.7 (three-way merge, not LWW), §4 partial P9 — spec-stricter |
| Y11 | FI:116 / R2:134 | Forgejo adapter | carried-weaker | integrations OQ4 (kept, "not a v1 promise"), `ExternalRef.system` — R2 BUILT |
| Y12 | FI:117 / R2:135 | GitHub App RS256 JWT, 1-h tokens, keychain, 7 scopes, GHES, no PAT | carried | integrations §2.10, §4 built — agree |
| Y13 | FI:118 / R2:136 | HMAC webhook + 5 triggers | carried-weaker | integrations §2.12 (dedupe added; 2 triggers to Later; `pull_request.closed` added), §4 partial P9 — spec-stricter |
| Y14 | FI:119 / R2:137 | Check Runs with annotations | carried | integrations §2.14, §4 built — agree (`raw_details` lost, O90) |
| Y15 | FI:120 / R2:138 | SARIF v2.1.0 gzip then base64 | carried | integrations §2.14 — agree |
| Y16 | FI:121 / R2:139 | PR lifecycle draft→checks→ready→CODEOWNERS→auto-merge, merge queue | carried | integrations §2.15 partial P9; threads Later — agree |
| Y17 | FI:122 / R2:140 | Release cards | later | integrations §7 — R2 SHALLOW |
| Y18 | FI:123 / R2:141 | CI via `act` | later | integrations §7 — R2 SHALLOW |
| Y19 | FI:124 / R2:142 | Monorepo per-package gates; cross-repo = two cards | carried-weaker | review-git §2.6.5; status unstated — R2 SHALLOW |
| Y20 | FI:125 / R2:143 | Mid-card external-edit reconciliation | contradicted | integrations §2.5 vs OPEN_QUESTIONS (never pause); §4 not-built P9 — R2 BUILT, **DISAGREE** |

### Models (M)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| M1 | FI:135 / R2:149 | HTTP adapter (llama.cpp, MLX, Ollama) | carried | models §2.14, §4 built — agree |
| M2 | FI:136 / R2:150 | Token streaming | missing | — (code built; Needs attention 1) |
| M3 | FI:137 / R2:151 | `measureThroughput` prefill/decode | carried | models §2.7 (per context length), §2.9 — agree |
| M4 | FI:138 / R2:152 | `healthCheck` | carried-weaker | models §2.15 `/props` identity (M4 not-built) |
| M5 | FI:139 / R2:153 | Qwen3.8-27B code + planning sampling profile | carried-weaker | models §2.3, §2.11; values lost |
| M6 | FI:140 / R2:154 | Per-request reasoning control | carried | worker-loop §2.24-25 (`reasoning.ts`), built — agree |
| M7 | FI:141 / R2:155 | Tolerant tool-call parser (arm B) | carried | models §2.28 — agree |
| M8 | FI:142 / R2:156 | Arm A grammar-constrained decoding | carried | models §2.28 + DEC-22 (per-model measured, never default); NEW-models-5 — agree |
| M9 | FI:143 / R2:157 | Arm C search/replace patches | carried | models §2.28; §4 "tool arm measured" not-built — R2 BUILT (qualify measures); spec-stricter for the Worker |
| M10 | FI:144 / R2:158 | Mock adapter contract | missing | — (test infrastructure) |
| M11 | FI:145 / R2:159 | Model registry fields | carried | models §2.25, §4 not-built NEW-models-4 — R2 BUILT, spec-stricter |
| M12 | FI:146 / R2:160 | Template SHA-256 pin invalidates qualification | carried | models §2.12, MD-2, built — agree |
| M13 | FI:147 / R2:161 | Hardware calibration procedure | carried | models §2.7 (Metal limit ⅔ ≤36 GB, ¾ above; sweep; one step back) partial NEW-models-1 — agree |
| M14 | FI:148 / R2:162 | Tier profiles S/M/L/XL | carried | models §2.8 table identical, partial — agree |
| M15 | FI:149 / R2:163 | Throughput floors 40/10, 100/20, 300/40; refuse; <16 GB unsupported | carried | models §2.9 identical, §4 not-built — R2 BUILT; **DISAGREE** (code: queue prelude calls it) |
| M16 | FI:150 / R2:164 | 8-bit KV; 4-bit refused for tool calling | carried | models §2.10, MD-1 built — agree |
| M17 | FI:151 / R2:165 | Prompt-cache configuration | contradicted | context §2.6 (new sizes; `-sps` lost), §4 partial M8 |
| M18 | FI:152 / R2:166 | Cache hit telemetry; < 85% on tool-result steps = defect + alert | carried-weaker | context §2.7 (median < 0.85 after first turn, in evidence), §4 measured built / acted not-built — R2 BUILT, DISAGREE (partial both) |
| M19 | FI:153 / R2:167 | Speculative decoding / MTP by measurement; draft model | carried-weaker | models §2.13 (MTP off until measured, 2 draft tokens), M7/M11 — agree; `-md` lost |
| M20 | FI:154 / R2:168 | Memory watchdog 2 s, 85/90/94% actions | carried-weaker | models §2.18-19 (levels; 0.85/0.94), partial NEW-models-2 — 90% level lost |
| M21 | FI:155 / R2:169 | Model swapping | carried | models §2.17, §2.20; extensibility tools table — agree |
| M22 | FI:156 / R2:170 | Qualification suite, deterministic scoring | carried | models §2.27, §4 built — agree |
| M23 | FI:157 / R2:171 | Per-repo bake-off on history tasks, full settings | carried | models §2.30, §4 partial (settings only) — history gap unowned (Needs attention 64) |
| M24 | FI:158 / R2:172 | Engine selection by measurement incl. cache retention | carried | models §2.14, §2.26 (NEW-models-4) — agree |
| M25 | FI:159 / R2:173 | Declared hours, batched swaps | carried | models §2.20, NEW-models-3; runtime §2.17 — R2 BUILT, spec-stricter |

### Gates (G)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| G1 | FI:169 / R2:179 | `gates.toml` parser and keys | carried-weaker | gates §3 keys (`schedule`, `threshold`, `languages` lost) — R2 SHALLOW |
| G2 | FI:170 / R2:180 | Hash verified on every card start | carried | gates §2.2, GT-1 — agree |
| G3 | FI:171 / R2:181 | Six layers + runs-on hosts | carried-weaker | gates §2.3 (runs-on lost) — R2 SHALLOW |
| G4 | FI:172 / R2:182 | Runner executes declared commands, per-gate timeout | carried | gates §2.8, §2.33, §4 built — agree |
| G5 | FI:173 / R2:183 | Full-layer run, not short-circuit | carried | gates §2.8 (rank once at end), GT-T1-2; §2.33 scoped short-circuit for functional only — agree |
| G6 | FI:174 / R2:184 | In-memory parse gate before write | carried | worker-loop §2.14 (TS/JS; others where a checker exists), DEC-20 — agree |
| G7 | FI:175 / R2:185 | Write path scope→parse→secret→atomic | carried | worker-loop §2.14, WL-3, built — agree |
| G8 | FI:176 / R2:186 | Typed `GateFailure`; top 3 by topological order; no raw logs | carried-weaker | gates §2.19-20 (rung order, not topological), M6 partial — R2 SHALLOW |
| G9 | FI:177 / R2:187 | Parser registry per tool | carried | gates §2.23, §3; pytest/cargo/go M6 — agree |
| G10 | FI:178 / R2:188 | Bounds ≤ 3 files, ≤ 200 lines | carried | gates §2.12, GT-2 — agree |
| G11 | FI:179 / R2:189 | Evidence bundle shape | carried-weaker | gates §2.35 (trajectory hash, attemptId lost; structural diff Later), T1 partial — agree |
| G12 | FI:180 / R2:190 | Acceptance tests first; red before work; protected | carried | gates §2.5-7, P1; §4 fixtures built, every card not-built — spec-stricter |
| G13 | FI:181 / R2:191 | Diff-scoped mutation, advisory then blocking, never 100% | carried | gates §2.32, §4 built; tools replaced by own step (PROVENANCE); non-TS "reported" (MS-M10-3) — agree |
| G14 | FI:182 / R2:192 | Secret scan (gitleaks) | carried | gates §2.3, §2.15; worker-loop §2.14 — agree |
| G15 | FI:183 / R2:193 | Dependency existence/typosquat gate | carried-weaker | security §2.44 (see S10) — R2 SHALLOW, DISAGREE on depth |
| G16 | FI:184 / R2:194 | Semgrep CE community rules | carried-weaker | gates §2.3; PROVENANCE — R2 SHALLOW, DISAGREE on depth |
| G17 | FI:185 / R2:195 | Visual: console, rejections, HTTP ≥ 400 | carried | gates §2.29, §4 built — agree |
| G18 | FI:186 / R2:196 | Visual: overlap, zero size, off-screen, overflow | carried-weaker | gates §2.29 (all four), §4 built — R2 SHALLOW; **DISAGREE**, code has no overlap |
| G19 | FI:187 / R2:197 | Screenshot diff 0.01, masked, animations off | carried-weaker | gates §2.29, §4 built — R2 SHALLOW; **DISAGREE**, code has no mask/animation handling |
| G20 | FI:188 / R2:198 | axe-core at 1280 / 375, zero critical | carried | gates §2.29, OQ1 (in-house subset; axe proposal) — agree |
| G21 | FI:189 / R2:199 | Vision checklist fail-only; human-approved baselines | gap | NEW-gates-4 (GT-N4-1/2); gates §2.30-31 — agree |
| G22 | FI:190 / R2:200 | Hygiene: changelog, debug output, trailers | carried | gates §2.3, §2.17, §2.27; NEW-gates-2 (changelog in scope) — agree |
| G23 | FI:191 / R2:201 | Regression protection on re-entering Review → Planning | carried-weaker | kernel §2.25; gates §2.25 — R2 BUILT; "to Planning, named" lost |
| G24 | FI:192 / R2:202 | Gate host separation over mTLS | carried | gates §2.11, §4 built; T1 built-ins on host — agree |
| G25 | FI:193 / R2:203 | Pass@k with gate selection | carried-weaker | worker-loop §2.37, WL-9 — agree (per-tier cap, isolated worktrees lost) |
| G26 | FI:194 / R2:204 | Cross-validation of attempts | carried | worker-loop §2.38, WL-9 — agree |
| G27 | FI:195 / R2:205 | Gate templates by language | carried-weaker | surface §2.30 → gates (contents absent); parsers M6 — R2 SHALLOW |

### Context (C)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| C1 | FI:207 / R2:211 | Repo map, PageRank, budget fit, cache | carried-weaker | context §2.13 (1,200 tokens; edge weights and content-hash key lost); multi-language Later — agree (TS/JS only) |
| C2 | FI:208 / R2:212 | Headless LSP client pool | contradicted | context §2.28; worker-loop §2.12, §7 — R2 BUILT; **DISAGREE** (code wires it) |
| C3 | FI:209 / R2:213 | SWE-Pruner line pruning | later | context §7, DEC-21 — agree |
| C4 | FI:210 / R2:214 | Four zones, byte-stable prefix | carried | context §2.8-10, §4 partial M8 — R2 BUILT; DISAGREE (spec newer) |
| C5 | FI:211 / R2:215 | System < 1,000 tokens, tools < 2,000 | carried | context §2.10, CX-M1-3, not-built — agree |
| C6 | FI:212 / R2:216 | Masking with ~15-token pointers + EvidenceRef | contradicted | context §2.3 (pointer + `recall`; five recent kept, not two), M8 — R2 BUILT |
| C7 | FI:213 / R2:217 | Pressure 70/80/85/90, stop at 95% | carried | context §2.12, CX-2, built (dormant) — agree |
| C8 | FI:214 / R2:218 | RTK four strategies, lossless | carried | context §2.17, CX-3, built — agree |
| C9 | FI:215 / R2:219 | Agent Skills registry, progressive disclosure | carried | extensibility §2.10-14, partial NEW-extensibility-4 — agree |
| C10 | FI:216 / R2:220 | Skill trust: pin, audit, diff, reject protected-touching | carried | extensibility §2.15, §2.17, EXT-27; partial S9 — agree |
| C11 | FI:217 / R2:221 | Playbook: delta, card boundary, retire | carried | context §2.24, §4 built — agree |
| C12 | FI:218 / R2:222 | Context-debt audit > 300 tokens / ≥ +3% | carried | measurement §2.24, MS-N2-2 partial — agree |
| C13 | FI:219 / R2:223 | Exemplar store top-2, same class, this repo | carried | context §2.25; M1 (diff hunks, structural filter) — spec-stricter |
| C14 | FI:220 / R2:224 | Context pack assembly | carried | context §2.1-15, contract `buildWorkerPrompt` — agree |
| C15 | FI:221 / R2:225 | Byte-identical prompt for identical inputs | carried | context §2.1, CX-1 built — agree |
| C16 | FI:222 / R2:226 | Subtask branch-and-return | carried | context §2.18, CX-4 built — agree |
| C17 | FI:223 / R2:227 | Fresh context on rung change | carried | context §2.19; worker-loop §2.34, M1 partial — spec-stricter |
| C18 | FI:224 / R2:228 | Reasoning traces stripped between steps | contradicted | context §2.4 (preserved; M8) — R2 BUILT |
| C19 | FI:225 / R2:229 | Dynamic tool loading via `tool_search` | carried | worker-loop §2.11, M2 A/B; context OQ2 — R2 SHALLOW; DISAGREE, code sets `progressiveTools: true` (`execute.ts:476`): spec right |
| C20 | FI:226 / R2:230 | Per-step and per-card context metrics | carried-weaker | context §2.29; runtime §2.32 — R2 SHALLOW; per-card metrics status unstated |
| C21 | FI:227 / R2:231 | Joint versioning invalidates qualification | carried-weaker | context §2.27, §4 built — R2 SHALLOW; **DISAGREE**, code supports R2 |
| C22 | FI:228 / R2:232 | AGENTS.md / CLAUDE.md in Zone 2 | carried | context §2.8 (project conventions) — agree |

### Loop (L)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| L1 | FI:240 / R2:238 | Turn driver | carried | worker-loop §2.5, §4 built — agree |
| L2 | FI:241 / R2:239 | Prompt from the pack | carried | context §2.8; worker-loop §2.5 — agree |
| L3 | FI:242 / R2:240 | Tool set with schemas | carried | worker-loop §2.10-12, `TOOL_CATALOG` — agree |
| L4 | FI:243 / R2:241 | `read`: ranges, byte budget, numbering, image/PDF | carried-weaker | worker-loop §2.12 — R2 SHALLOW (see Needs attention 34) |
| L5 | FI:244 / R2:242 | `edit` unique, CRLF, parse gate | carried | worker-loop §2.12, §2.14 — agree |
| L6 | FI:245 / R2:243 | `grep` modes, context, gitignore, capped | carried-weaker | worker-loop §2.12 — R2 BUILT |
| L7 | FI:246 / R2:244 | `glob` mtime-sorted, gitignore | carried-weaker | worker-loop §2.12 — R2 BUILT |
| L8 | FI:247 / R2:245 | `run`: sandbox, timeout, description, deny raw cat/grep/sed, condensing | carried | worker-loop §2.12, WL-5; context §2.17 — agree (`description` unstated) |
| L9 | FI:248 / R2:246 | Symbol tools over LSP | carried | worker-loop §2.12 (TS language service) — see C2 |
| L10 | FI:249 / R2:247 | Tiered `docs` | carried | worker-loop §2.12; design-stage §2.7.2 — agree |
| L11 | FI:250 / R2:248 | `note` to the card thread | carried | worker-loop §2.12 — agree |
| L12 | FI:251 / R2:249 | Code mode (`run_script`) | carried | worker-loop §2.12, WL-M2-4 — agree |
| L13 | FI:252 / R2:250 | Stall `(tool, argHash, repoStateHash)`; 2 = stall; A-B-A | carried | worker-loop §2.17-20, WL-2 built (warn then stop) — R2 SHALLOW (threshold 3, A-B-A-B); spec redefines the episode; A-B-A vs A-B-A-B not re-checked |
| L14 | FI:253 / R2:251 | Six stop reasons, never collapsed | carried | worker-loop §2.30-33, OQ1 (18 stored, 7 classes), T3 — agree |
| L15 | FI:254 / R2:252 | Ladder 2/1/1, park with diagnostic | carried | worker-loop §2.34-36, WL-8 built — agree |
| L16 | FI:255 / R2:253 | `validateWrite` contract | carried | worker-loop §2.14 — agree |
| L17 | FI:256 / R2:254 | Read-before-edit | carried | worker-loop §2.12, WL-4 — agree |
| L18 | FI:257 / R2:255 | Tool sets per card class | carried | worker-loop §2.10, M2 not-built — R2 BUILT, spec-stricter |
| L19 | FI:258 / R2:256 | search/fetch only on research cards | carried | worker-loop §2.12; design-stage §2.7.10 — agree |
| L20 | FI:259 / R2:257 | `browse` sandboxed browser | carried | worker-loop §2.12; security §2.42a (click/type need URL allowlist) — agree |
| L21 | FI:260 / R2:258 | Planner-set step budgets | carried | worker-loop §2.21 (p80 × 1.25, ≤ 15%, ≥ 4), WL-10 — agree |
| L22 | FI:261 / R2:259 | Token/seconds/kWh budgets, park at cap | carried-weaker | runtime §2.19; worker-loop §2.21 — status unstated (R2 SHALLOW) |
| L23 | FI:262 / R2:260 | Background processes per card, ports | carried | runtime §2.15, §4 built — agree |
| L24 | FI:263 / R2:261 | Interactive terminals | carried | runtime §2.16 — agree |
| L25 | FI:264 / R2:262 | `abort(reason)` → `human_abort` | carried | planner §2.14; worker-loop §3 CLI `abort`; hook veto → `hook_veto` (WL-T3-4) — agree |
| L26 | FI:272 / R2:263 | Symlink-aware path confinement | carried | worker-loop §2.14; security §4 built — agree |
| L27 | FI:273 / R2:264 | CRLF/EOL utilities | carried | worker-loop §2.12 "line endings normalised" — agree |
| L28 | FI:274 / R2:265 | Real glob engine | carried | implied (`find_files`, protected globs) — agree |
| L29 | FI:275 / R2:266 | Observation contract + 2,400/1,200 clamp | carried-weaker | worker-loop §2.16; context §2.17 — clamp sizes lost |
| L30 | FI:276 / R2:267 | `ToolExecutor` returning observations; ask escalation | carried | worker-loop §3 contract — agree |
| L31 | FI:277 / R2:268 | Symbol spans | carried | worker-loop §2.12 — agree |

### Board (B)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| B1 | FI:287 / R2:274 | Legal edges, entry conditions, override logged | carried | kernel §2.19-22, §4 built — agree |
| B2 | FI:288 / R2:275 | Planning column incl. Verify→Planning | carried-weaker | kernel §2.17; worker-loop §2.34 — R2 SHALLOW |
| B3 | FI:289 / R2:276 | ReviewWIP from own history | carried | review-git §2.2 (floor 1, per project, 15-min prior until 5 reviews), S6 partial — R2 BUILT, spec-stricter |
| B4 | FI:290 / R2:277 | Back-pressure blocks entry to Verify | carried | kernel §2.23, K-6 built — agree |
| B5 | FI:291 / R2:278 | Dependency DAG | carried | kernel §2.3 — agree |
| B6 | FI:292 / R2:279 | Overlapping scopes serialised | carried | kernel §2.4, K-8 — agree |
| B7 | FI:293 / R2:280 | Parent rollup with integration gate | carried | kernel §2.24, K-7 — agree |
| B8 | FI:294 / R2:281 | Project-scoped board | carried | kernel `ProjectRecord`; review-git S6 per project; dashboard Workspace — agree |
| B9 | FI:295 / R2:282 | `createCard` | carried | kernel `CardStore` — agree |
| B10 | FI:296 / R2:283 | WIP evaluation | carried | kernel §2.21, §3 defaults (planning 3, in_progress 5, verify 5, review 3) — agree |
| B11 | FI:297 / R2:284 | Fractional `order_key` | carried-weaker | kernel §2.14; dashboard §2.4.5 — agree on state |
| B12 | FI:298 / R2:285 | Human commands; override never on security | carried | planner §2.14; kernel §2.22, K-5 built; Reroute/Explain Later — R2 SHALLOW, DISAGREE (spec cites a test) |
| B13 | FI:299 / R2:286 | Active project cap 3 | carried | kernel §2.2 — agree |

### Planner (P)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| P1 | FI:309 / R2:292 | SPIDR five heuristics, split until it fits | carried | planner §2.1-2.2 (Cohn's SPIDR; old "Interface = types first" becomes the Contract enabler card), P1 model-first — agree |
| P2 | FI:310 / R2:293 | INVEST six checks, 25%, ≤ 40, > 7 | carried | planner §2.4 identical, built — agree |
| P3 | FI:311 / R2:294 | WSJF / RICE from config | carried | planner §2.7.2 — agree |
| P4 | FI:312 / R2:295 | Estimation formula; actuals write back | carried | planner §2.6.1 (points added for people — Resolved drift) — agree |
| P5 | FI:313 / R2:296 | Difficulty scoring | carried | planner §2.4-2.5; extensibility tools table — agree |
| P6 | FI:314 / R2:297 | Routing < 4 / 4–7 / > 7; capability_ceiling escalation | carried | planner §2.5 (+ max split depth 4) — agree |
| P7 | FI:315 / R2:298 | Edit-sketch cascade | carried | planner §2.1.7, §2.5; worker-loop §2.28 — agree |
| P8 | FI:316 / R2:299 | Assume/Ask/Spike; batch; > 3 questions rejects | contradicted | planner §2.10.1 (≤ 2 questions, never refuse; Resolved drift), P2 — agree on state |
| P9 | FI:317 / R2:300 | `DecisionRequest` full shape | carried | planner §2.10.2 (default deadline 12 h), built — agree |
| P10 | FI:318 / R2:301 | `safe_default` / `default_deny` | carried | planner §2.10.3, built — agree |
| P11 | FI:319 / R2:302 | Pause & persist, VRAM released, rehydrate | contradicted | planner §2.10.2 (proceed on default) — R2 BUILT |
| P12 | FI:320 / R2:303 | Six planner sessions | carried | planner §2.7.8 table — agree (standup builders P6) |
| P13 | FI:321 / R2:304 | Status from gate results with ranges | carried | planner §2.6.3, §2.8.14 — agree |
| P14 | FI:322 / R2:305 | Escalation diagnostics, smallest human action | carried | planner §2.5 — agree |
| P15 | FI:323 / R2:306 | Trust calibration 15% | carried | planner §2.10.4, §4 built — R2 DEAD; DISAGREE, code has `sekhemet assume` (`wave2.ts:665`): spec right |
| P16 | FI:324 / R2:307 | Process profiles | carried-weaker | planner §2.7.3 — status unstated |
| P17 | FI:325 / R2:308 | `Goal` record | carried | planner §2.11.1, §3 events — agree |
| P18 | FI:326 / R2:309 | `/goal` intake, approval first | carried | planner §2.11.2 — agree |
| P19 | FI:327 / R2:310 | Goal loop, replan triggers | carried-weaker | planner §2.11.3 (timer dropped), §4 built — **DISAGREE**, code supports R2 |
| P20 | FI:328 / R2:311 | Seven signals and responses | carried-weaker | planner §2.12 (numbers identical; 2.5× chosen), §4 built — **DISAGREE**, code supports R2 |
| P21 | FI:329 / R2:312 | Multiple goals, WSJF, per-window explanation | carried | planner §2.11.4 — agree |
| P22 | FI:330 / R2:313 | Stopping honestly | carried | planner §2.11.5 — agree |
| P23 | FI:331 / R2:314 | Board operations tool | carried | planner §2.8.3 — agree |
| P24 | FI:332 / R2:315 | Impact analysis over language-server references | carried | extensibility tools table; context §2.22 (P1 not-built) — agree |
| P25 | FI:333 / R2:316 | Implementation previews | carried | planner §2.10.2 `previewSketch`, built — agree |

### Eval (E)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| E1 | FI:343 / R2:322 | Pass@1 harness under the real loop; M0 protocol | carried-weaker | measurement §2.9, M9 (not-built) — agree; M0 bar lost |
| E2 | FI:344 / R2:323 | Git task synthesis, fail-to-pass, scrub paths | carried | models §2.30; measurement §2.17 inlet; OPEN_QUESTIONS research gap — agree |
| E3 | FI:345 / R2:324 | Full-settings recording | carried | gates §2.35; models §2.30, M4; measurement §2.5 — spec-stricter |
| E4 | FI:346 / R2:325 | `MODEL_MATRIX.md` | carried-weaker | dashboard §2.11 Registry only |
| E5 | FI:347 / R2:326 | Frozen suite gates every learning loop | carried | measurement §2.17-19, T8 — agree |
| E6 | FI:348 / R2:327 | Qualification scoring | carried | models §2.27 — agree |
| E7 | FI:349 / R2:328 | Loop 1 playbook deltas (1 per retro) | carried | measurement §2.17 table; context §2.24 — agree |
| E8 | FI:350 / R2:329 | Loop 2 budgets ≤ 15% | carried | measurement §2.17; worker-loop §2.21 — agree |
| E9 | FI:351 / R2:330 | Loop 3 prompt evolution | later | context §7; measurement §7 — agree |
| E10 | FI:352 / R2:331 | Loop 4 skill distillation | carried | measurement §2.17; extensibility §2.17a, EXT-27a/b — agree |
| E11 | FI:353 / R2:332 | Loop 5 exemplars top-2 | carried | measurement §2.17 (two per class, min 5 cards) — agree |
| E12 | FI:354 / R2:333 | Loop 6 task synthesis | carried | measurement §2.17 — agree |
| E13 | FI:355 / R2:334 | Loop 7 variant archives | carried-weaker | measurement §3 contract only — status unstated |
| E14 | FI:356 / R2:335 | Loop 8 SIFT pre-filter | carried | measurement §2.13, §2.21, MS-T8-7 — agree |
| E15 | FI:357 / R2:336 | Loop 9 tool synthesis | later | register R6; security OQ1 — agree |
| E16 | FI:358 / R2:337 | Loop 10 mutants → tests | carried-weaker | measurement §2.17, §2.25 (rollback demotion lost) — R2 BUILT |
| E17 | FI:359 / R2:338 | Guardrails; rollback over 10-card window | contradicted | measurement §2.18 (paired), T8 — R2 BUILT |
| E18 | FI:360 / R2:339 | Permanent self-modification exclusions | carried | measurement §2.23; security §2.25 — agree |
| E19 | FI:361 / R2:340 | Doctor net gain, bloat, pruning | carried | measurement §2.24, NEW-measurement-2; extensibility §2.16 — agree |

### Dashboard (U; latest R1)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| U1 | FI:371 / R1:367 | Loopback 127.0.0.1:4040 | carried | runtime §2.23 — agree |
| U2 | FI:372 / R1:368 | Tokens as CSS variables and JSON | carried | dashboard §2.13.1 — agree |
| U3 | FI:373 / R1:369 | Basalt/Sand exact values, light theme | carried-weaker | dashboard §2.13.1-2 (values delegated to `tokens.ts`) — agree on state |
| U4 | FI:374 / R1:370 | Typography, tabular numerals | carried | dashboard §2.13.4 identical — agree |
| U5 | FI:375 / R1:371 | Spacing, radius, elevation, motion | carried | dashboard §2.13.5 identical — agree |
| U6 | FI:376 / R1:372 | Dual-axis virtualization | carried-weaker | dashboard §2.4.9 (redefined target) — status unstated |
| U7 | FI:377 / R1:373 | Six views | carried | dashboard §2.2, §2.11 (Registry, Workspace); master board Later — agree |
| U8 | FI:378 / R1:374 | Review view | carried | dashboard §2.5, §4 built; intent grouping Later — agree |
| U9 | FI:379 / R1:375 | Live stream, replay from genesis | carried-weaker | runtime §2.25 (SSE + WS); genesis replay missing |
| U10 | FI:380 / R1:376 | Keyboard system | carried | dashboard §2.3 (redefined chords), P11 — agree |
| U11 | FI:381 / R1:377 | Command palette | carried | dashboard §2.3, §2.15.4, built — agree |
| U12 | FI:382 / R1:378 | Decision inbox by wait time | carried | dashboard §2.5.2 *Needs you* — agree |
| U13 | FI:383 / R1:379 | Card tile components | contradicted | dashboard §2.4.4 (Resolved drift), P3 |
| U14 | FI:384 / R1:380 | Column header `N / limit` | carried | dashboard §2.4.3, P3 — spec-stricter |
| U15 | FI:385 / R1:381 | Decision Request component with countdown | carried | dashboard §2.5.14 — no State row; R1 MISSING, code `decision.js` now exists |
| U16 | FI:386 / R1:382 | Diff viewer | carried | dashboard §2.5.6 built — agree |
| U17 | FI:387 / R1:383 | Pan-and-zoom DAG | carried-weaker | dashboard §2.4.18, built — R1 stale |
| U18 | FI:388 / R1:384 | Sparklines | contradicted | dashboard §7 Later vs code `sparkline.js` |
| U19 | FI:389 / R1:385 | Icons 1.5 px, no lioness | carried | dashboard §2.13.6 — agree |
| U20 | FI:390 / R1:386 | Mobile read-only + one-tap triage | carried | dashboard §2.2.2, §2.15.3, P11 — agree |
| U21 | FI:391 / R1:387 | `IBoardUIState` | missing | — |

### Harness app (H)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| H1 | FI:401 / R2:346 | `daemon` with PID file, detach | carried | runtime §2.5, NEW-runtime-1 partial — spec-stricter |
| H2 | FI:402 / R2:347 | `board` opens the web UI | carried | surface §2.5.6, §2.13 — agree |
| H3 | FI:403 / R2:348 | `calibrate` writes machine config | carried | models §2.7, NEW-models-1 — agree |
| H4 | FI:404 / R2:349 | `run <card>` unattended | carried | surface §2.13, §2.18 — agree |
| H5 | FI:405 / R2:350 | `plan "<spec>"` | carried | planner §2.1; surface `sekhemet "<spec>"` — agree |
| H6 | FI:406 / R2:351 | `gate <card>` in the card's worktree | carried | gates §2.8, T1 — R2 BUILT, DISAGREE (spec newer) |
| H7 | FI:407 / R2:352 | `bake-off` qualifies and benchmarks on the repo | carried | models §2.30, surface §2.11 — agree |
| H8 | FI:408 / R2:353 | `replay --as`, diff trajectories | carried | runtime §2.14, RUN-28 — agree |
| H9 | FI:409 / R2:354 | `doctor` real probes | carried | surface §2.13; models §2.5 — agree |
| H10 | FI:410 / R2:355 | MCP server tools incl. evidence and registry | carried | extensibility §2.18-21, NEW-extensibility-3 — agree |
| H11 | FI:411 / R2:356 | MCP client budgeted to planner/executor | carried | extensibility §2.22-24 (Worker only via `worker_tools`) — agree |
| H12 | FI:412 / R2:357 | REST API | carried | runtime §3 route list (old table superseded) — agree |
| H13 | FI:413 / R2:358 | SDK with async iterator | carried-weaker | extensibility §2.28, OQ1 (cut recommended) |
| H14 | FI:414 / R2:359 | ACP editor surface | later | extensibility §7 (card-level); ACP PM chat built — agree |
| H15 | FI:415 / R2:360 | `config.toml` chain incl. card overrides | carried | surface §2.21-25 (keys removed by decision) — R2 SHALLOW; DISAGREE on card layer |
| H16 | FI:416 / R2:361 | Slash commands (`/onboard` … `/goal`) | carried | extensibility §2.26; planner §2.8.7; templates Later — agree |
| H17 | FI:417 / R2:362 | Session resume from the log | carried | runtime §2.10, NEW-runtime-3 — spec-stricter |
| H18 | FI:418 / R2:363 | Fork at step N | carried | runtime §2.13, RUN-27 — agree |
| H19 | FI:419 / R2:364 | Rewind to step N, invalidate passes | carried | runtime §2.12, kernel §2.26, K-S7-8 — spec-stricter |
| H20 | FI:420 / R2:365 | ntfy/Gotify notifications | carried | integrations §2.20-23 — agree |
| H21 | FI:421 / R2:366 | Idle/overnight scheduler, nightly jobs, morning summary | carried | runtime §2.17-20, NEW-runtime-5 — agree |
| H22 | FI:422 / R2:367 | OTel spans incl. tool spans, in UI | carried-weaker | runtime §2.30-31, §4 built — **DISAGREE**, code supports R2 |
| H23 | FI:423 / R2:368 | Compute governance kWh, breakers | carried | runtime §2.18-19 (watts × time replaces TDP × GPU utilisation) — agree |
| H24 | FI:424 / R2:369 | Reproducibility record per card | carried | runtime OQ2 → models M4, gates §2.35 — agree |
| H25 | FI:425 / R2:370 | Offline installers, first-run wizard | later | DEC-21; first run is surface §2.5 — agree |
| H26 | FI:426 / R2:371 | Memory daemon 2 s | carried | models §2.19 — agree |
| H27 | FI:427 / R2:372 | Restricted-mode wiring | carried | see S12 |

### Cross-cutting (X; latest R1)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| X1 | FI:435 / R1:425 | `/onboard` seven steps; review before enforcement | carried | surface §2.5, §2.9-11, P10 — spec newer |
| X2 | FI:436 / R1:426 | Nightly convention drift report | carried | surface §2.12; runtime §2.20 — spec newer |
| X3 | FI:437 / R1:427 | Multimodal card input via vision model | carried | surface §2.28-29, SUR-32, built — spec newer |
| X4 | FI:438 / R1:428 | Four-tier research knowledge | carried | design-stage §2.7.2 — agree |
| X5 | FI:439 / R1:429 | SearXNG; 1–6 terms; logged; primary sources | carried | design-stage §2.7.11, §2.6.3, S8 — agree |
| X6 | FI:440 / R1:430 | Fetch & extraction pipeline | carried-weaker | design-stage §2.6.3, §2.7.8, §7 |
| X7 | FI:441 / R1:431 | Research note; embeddings only here | contradicted | design-stage §2.7.6 (note kept), §2.7.8 (lexical), DEC-22 |
| X8 | FI:442 / R1:432 | Research safety | carried | design-stage §2.6.3, §2.7.6; security §2.42 — agree |
| X9 | FI:443 / R1:433 | Doc cache TTLs | later | design-stage §7 |
| X10 | FI:444 / R1:434 | Air-gap package mirrors | carried | security §2.46 (allowlist); services Later — agree |
| X11 | FI:445 / R1:435 | Signed model manifest | carried | security §2.47, SEC-34 — agree |
| X12 | FI:446 / R1:436 | Doc bundles | carried | security §2.48 — agree |
| X13 | FI:447 / R1:437 | Signed update bundles, log backup | carried | security §2.49, SEC-42 — agree |
| X14 | FI:448 / R1:438 | Air-gap self-test at the proxy | carried | security §2.50, NEW-security-2 — agree |
| X15 | FI:449 / R1:439 | External review cards, never edit | carried | review-git §2.7; integrations §2.13 — spec newer |
| X16 | FI:450 / R1:440 | Scheduled and recurring cards; hours respected unless urgent | carried | runtime §2.21, RUN-31 — spec newer |
| X17 | FI:451 / R1:441 | `PROVENANCE.md` | carried | `docs/reference/PROVENANCE.md` (13 technique rows) — spec newer |
| X18 | FI:452 / R1:442 | `RESEARCH_REGISTER.md` with pre-set thresholds | carried | measurement §2.26, MS-2 — spec newer |
| X19 | FI:453 / R1:443 | `MODEL_MATRIX.md` | carried-weaker | see E4 |
| X20 | FI:454 / R1:444 | Licence register enforcement rules | carried-weaker | PROVENANCE; gates §2.27 |
| X21 | FI:455 / R1:445 | Fixture generator, `createTestWorktree` < 10 ms | missing | — |
| X22 | FI:456 / R1:446 | No in-memory SQLite for kernel/board (DoD §2.A.1) | carried | planner P1 criterion; DoD §2A; kernel K-1 on disk — agree (still open) |
| X23 | FI:457 / R1:447 | `test:unit` / `test:integration` | missing | — |
| X24 | FI:458 / R1:448 | `pnpm dev` | missing | — |
| X25 | FI:459 / R1:449 | Suite under 3 s | missing | — |
| X26 | FI:460 / R1:450 | Trailer enforcement as a gate | carried | gates §2.27 (trailer gate); review-git §2.5.4 refused squash — agree |
| X27 | FI:461 / R1:451 | Chronicle fixture and scorecard | carried-weaker | measurement §2.1 (targets lost) |
| X28 | FI:462 / R1:452 | Showcase Trifecta and its targets | carried-weaker | measurement §2.1 (targets lost) |
| X29 | FI:463 / R1:453 | CHRONICLE `llama-server` profile | contradicted | models §2.2 (8098 Cyber-Tiel) |

### The 108 "most likely to be overlooked" items (FI:471–578)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| O1 | FI:471 | Binary-search budget fit for the repo map | carried | context §2.13 |
| O2 | FI:472 | Aider edge-weight multipliers; PPR seeded on scope | carried-weaker | context §2.13 (seeding kept; weights lost) |
| O3 | FI:473 | Repo-map cache key path + mtime + content hash | carried-weaker | context §2.13 (paths, sizes, mtimes) |
| O4 | FI:474 | Pressure 70/80/85/90, `budget_exhausted` at 95 | carried | context §2.12 |
| O5 | FI:475 | Goal re-injected at the tail of every step | carried | context §2.8 (tail restates the goal) |
| O6 | FI:476 | Traces stripped unless registry flag | contradicted | context §2.4 |
| O7 | FI:477 | Pointer carries a retrievable EvidenceRef | carried | context §2.3 (`recall(ref)`, blob store) |
| O8 | FI:478 | RTK four named strategies | carried | context §2.17 |
| O9 | FI:479 | Lossless for repair data | carried | context §2.17, CX-3 |
| O10 | FI:480 | Stall signature includes repoStateHash | carried | worker-loop §2.17 |
| O11 | FI:481 | Rung caps 2/1/1 | carried | worker-loop §2.34 |
| O12 | FI:482 | ≤ 3 failures by topological order | carried-weaker | gates §2.20 |
| O13 | FI:483 | `minimalRepro` exact command | carried | gates §2.19, §2.22 |
| O14 | FI:484 | Routing < 4 / 4–7 (edit sketch) / > 7 | carried | planner §2.5 |
| O15 | FI:485 | INVEST-S ≤ 25% and ≤ 40 steps | carried | planner §2.4 |
| O16 | FI:486 | INVEST-E difficulty > 7 forces re-split | carried | planner §2.4 |
| O17 | FI:487 | > 3 questions rejects the spec | contradicted | planner §2.10.1, P2 (deliberate) |
| O18 | FI:488 | Assume→Ask shift at 15% override | carried | planner §2.10.4 |
| O19 | FI:489 | `policy` safe_default/default_deny; never auto-approve destructive | carried | planner §2.10.3 |
| O20 | FI:490 | `decision/default_applied` distinct event | carried | planner §2.10.3, §3 |
| O21 | FI:491 | Scope drift > 20% halts auxiliary creation | carried | planner §2.12 (execution unbuilt, Needs attention 19) |
| O22 | FI:492 | p95 > 2.5 × p50 (vs 2× conflict) | carried | planner §2.12 (2.5× chosen) |
| O23 | FI:493 | Blocked 12 h / 2 h active | carried | planner §2.12 |
| O24 | FI:494 | ≥ 3 failures in one file → re-split Interface/Data | carried | planner §2.12 |
| O25 | FI:495 | RAID > 24 h → verification spike | carried | planner §2.12 |
| O26 | FI:496 | ReviewWIP floored at 1, from own history | carried | review-git §2.2.1-3 |
| O27 | FI:497 | Back-pressure blocks Verify, not Review | carried | kernel §2.23 |
| O28 | FI:498 | Rollup needs the parent's integration gate | carried | kernel §2.24 |
| O29 | FI:499 | Regression → Planning with regression named | carried-weaker | kernel §2.25; gates §2.25 |
| O30 | FI:500 | Checkpoint at gate passes and masking boundaries | contradicted | runtime §2.11 vs review-git §2.6.3 |
| O31 | FI:501 | `refs/sekhemet/checkpoints/<card-id>` | carried | review-git §2.5.5 |
| O32 | FI:502 | Branch naming from parent | carried | review-git §2.6.2 |
| O33 | FI:503 | Accepting a lower card restacks and re-runs gates | carried | review-git §2.5.5 (code gap: Needs attention 17) |
| O34 | FI:504 | Conflict hunks typed; out-of-scope parks | carried | review-git §2.6.4 (code gap: Needs attention 16) |
| O35 | FI:505 | Vision fail-only; baselines need a person | carried | gates §2.30-31, NEW-gates-4 |
| O36 | FI:506 | axe-core at 1280 and 375, zero critical | carried | gates §2.29 (subset; axe proposal OQ1) |
| O37 | FI:507 | `maxDiffPixelRatio` 0.01, masked, no animation | carried | gates §2.29 (code gap: Needs attention 14) |
| O38 | FI:508 | Four layout predicates | carried | gates §2.29 (code gap: overlap) |
| O39 | FI:509 | Mutation diff-scoped, never 100%, advisory first | carried | gates §2.32 |
| O40 | FI:510 | Levenshtein typosquat | carried | security §2.44 (distance 2; 1 for ≤ 4 chars) |
| O41 | FI:511 | Proxied requests logged with SHA-256 payload hash | carried | security §2.30 |
| O42 | FI:512 | `<untrusted_content source>` wrapper + contract | carried | security §2.42 |
| O43 | FI:513 | CoW cloning + symlinked `node_modules`/`.venv` | later | DEC-21 (CoW); security §2.24 (`node_modules` links; `.venv` unnamed) |
| O44 | FI:514 | llama.cpp cache flags from the machine profile | contradicted | context §2.6 (new values; `-sps` lost; per-host profile kept) |
| O45 | FI:515 | 4-bit KV prohibited for tool calling | carried | models §2.10, MD-1 |
| O46 | FI:516 | Hit < 85% on tool-result steps is a defect + operator alert | carried-weaker | context §2.7 (median after first turn; no operator alert) |
| O47 | FI:517 | Template checksum change invalidates qualification | carried | models §2.12 |
| O48 | FI:518 | Pass@k k 2–4, T 0.4–0.7, isolated worktrees, first pass wins | carried-weaker | worker-loop §2.37 |
| O49 | FI:519 | Cross-validation routes to the planner | carried | worker-loop §2.38 |
| O50 | FI:520 | Exemplars top-2 per class from this repo | carried | context §2.25 |
| O51 | FI:521 | Playbook by delta, at card boundaries | carried | context §2.24, CX-5 |
| O52 | FI:522 | Context debt: > 300 tokens and ≥ +3% (both halves) | carried | measurement §2.24, MS-N2-2 |
| O53 | FI:523 | Prompt optimiser kill switch < 5% | carried | context §7 (Later, "kept only if ≥ 5%") |
| O54 | FI:524 | Rollback on a moving 10-card window | contradicted | measurement §2.18 (paired) |
| O55 | FI:525 | Loop driver, gates, sandbox, permissions excluded from self-modification | carried | measurement §2.23 |
| O56 | FI:526 | Loop 9 signal: repeated bash chains | later | register R6 (not in v1) |
| O57 | FI:527 | Loop 10 demoted to advisory on rollback | carried-weaker | measurement §2.17 |
| O58 | FI:528 | Skill manifest line only; omitted when tools lacking | carried | extensibility §2.11-12, EXT-32 |
| O59 | FI:529 | Skills pinned, audited, diffed; reject protected-touching | carried | extensibility §2.15, §2.17, EXT-27 |
| O60 | FI:530 | Every skill ships an eval card | later | extensibility §7 |
| O61 | FI:531 | `skills/<name>/{SKILL.md, scripts/, references/, evals/}` | carried | extensibility §2.10 |
| O62 | FI:532 | Hooks outside the sandbox with user rights | carried | extensibility §2 table, §9 |
| O63 | FI:533 | Hook observe / block / inject | carried | extensibility §2.6 |
| O64 | FI:534 | `tool_search` loads a schema into the volatile zone | carried | worker-loop §2.11 (A/B); context OQ2 (append as a message) |
| O65 | FI:535 | Subtask returns summary + evidence ref only | carried | context §2.18 |
| O66 | FI:536 | Background processes killed at card end; ports | carried | runtime §2.15 (promotion Later) |
| O67 | FI:537 | Rewind invalidates passes; log never truncated | carried | runtime §2.12; kernel §2.26 |
| O68 | FI:538 | Replay reproduces deterministic stages exactly | carried | runtime §2.14 |
| O69 | FI:539 | Reload re-streams from genesis/checkpoint | missing | — |
| O70 | FI:540 | Config order includes card overrides | carried | surface §2.21 |
| O71 | FI:541 | `[machine] hours`, `power_budget_kwh_day` | carried | surface §2.23 (`reserved_hours`) |
| O72 | FI:542 | `[context] map_tokens = 1024`, `mask_after_observations = 2` | contradicted | surface §2.25 (removed); context §2.3, §2.13 |
| O73 | FI:543 | `[loop] default_step_budget = 40`, `stall_window = 3`, `max_rungs = 4` | contradicted | surface §2.23 (40 kept), §2.25 (other two removed) |
| O74 | FI:544 | `[network] mode` tri-state | carried | surface §2.23 |
| O75 | FI:545 | `protected` glob list in gates.toml | carried | gates §3 `DEFAULT_PROJECT_CONFIG` |
| O76 | FI:546 | Per-gate `parser`; `baseline_approval = "human"` | carried | gates §3 keys; GT-N4-1 |
| O77 | FI:547 | gates.toml hash every card start | carried | gates §2.2 |
| O78 | FI:548 | `order_key` fractional index | carried-weaker | kernel §2.14 |
| O79 | FI:549 | `payload_hash` separate from `hash` | carried | kernel §2.8 |
| O80 | FI:550 | Blobs under `.sekhemet/` referenced from payload | carried | kernel §2.15 |
| O81 | FI:551 | Process profiles change cadence only | carried | planner §2.7.3 |
| O82 | FI:552 | Retrospectives are functional | carried | planner §2.7.4 |
| O83 | FI:553 | Every return reason becomes a candidate rule | contradicted | review-git §2.4 (actionable only) |
| O84 | FI:554 | git-cliff changelog + semver on a release card | later | integrations §7 |
| O85 | FI:555 | `act` for GitHub Actions as gates | later | integrations §7 |
| O86 | FI:556 | GraphQL separate budget, webhooks over polling, batching, idempotency keys, secondary backoff | carried-weaker | integrations §2.9, §2.11 |
| O87 | FI:557 | Hierarchy depth clamped to the tracker's | carried | integrations §2.7 |
| O88 | FI:558 | GHES `api_url`/`graphql_url` + CA bundle | carried | integrations §2.10 |
| O89 | FI:559 | `resolveReviewThread`; auto-merge; merge queue | later | integrations §7 (threads); §2.15 (auto-merge, merge queue by policy) |
| O90 | FI:560 | Check Run annotation shape incl. `raw_details` | carried-weaker | integrations §2.14 |
| O91 | FI:561 | SARIF gzip then base64 | carried | integrations §2.14 |
| O92 | FI:562 | LWW by timestamp, loser in history | contradicted | integrations §2.4 (three-way merge) |
| O93 | FI:563 | Per-class tool sets named | carried-weaker | worker-loop §2.10 |
| O94 | FI:564 | `run` denies raw cat/grep/sed | carried | worker-loop §2.12, WL-5 |
| O95 | FI:565 | Read before edit, mechanically | carried | worker-loop §2.12, WL-4 |
| O96 | FI:566 | Search/fetch only on research cards | carried | worker-loop §2.12; design-stage §2.5.6 |
| O97 | FI:567 | ast-grep fallback without a language server | later | worker-loop §7, context §7 |
| O98 | FI:568 | Missing parser/LSP/template → parse-only with visible warning | carried | surface §2.30, SUR-33 |
| O99 | FI:569 | Qwen `min_p = 0.0` mandatory over server default 0.05 | carried-weaker | models §2.2 (Cyber-Tiel min_p 0 listed; override rule lost) |
| O100 | FI:570 | MTP off on M4 because measured 21% slower | carried | models §2.13 (off until measured) |
| O101 | FI:571 | Bracketed placeholders banned in prompt templates | missing | — |
| O102 | FI:572 | Single-model serialisation on 24 GB | carried | models §2.22 (no co-residence below 32 GB); planner §2.8.6 |
| O103 | FI:573 | Test immutability is role-scoped | carried | gates §2.7; worker-loop §2.15; planner test-author step |
| O104 | FI:574 | `suspended-quota`, `relay-finisher` protocol values | missing | — (DoD:169 keeps `suspended-quota` only) |
| O105 | FI:575 | DoD §2.A no in-memory SQLite | carried | planner P1 criterion; DoD §2A |
| O106 | FI:576 | DoD §2.B two negatives per happy path; bit-flip tamper test | carried-weaker | kernel K-1 (bit flip kept); gates OQ2 (risk-based) |
| O107 | FI:577 | DoD §2.C no sole `toBeDefined` assertions | carried | DEFINITION_OF_DONE.md:37 (kept document) |
| O108 | FI:578 | `edit` exactly once, CRLF-tolerant | carried | worker-loop §2.12 |

### REAUDIT defects (R1:71-78; all "Fixed" in R2:56-63)

| # | Source | Item | Status | Now in |
| --- | --- | --- | --- | --- |
| D1 | R1:71 | Held card instead of a crash when Review is full | carried | kernel §2.18, §2.23, NEW-kernel-3 |
| D2 | R1:72 | Checkpoints written to the DB | carried-weaker | see K28 |
| D3 | R1:73 | Restricted mode confines the Worker's tools | carried | security §2.43, worker-loop §2.13 |
| D4 | R1:74 | Ask tier asks someone (decision approver) | carried-weaker | security §2.25 (approval path unstated) |
| D5 | R1:75 | `gates.toml` protected globs reach the permission engine | carried | security §2.25 ("test globs the project protects") |
| D6 | R1:76 | Planned cards keep their contract | carried | planner §2.1.5 |
| D7 | R1:77 | MCP offers no DB-refused tier | carried | extensibility §2.19-20 (server-side validation) |
| D8 | R1:78 | Card actuals written on finish | carried | kernel §2.6 `CardRecord` (runner write not a stated behaviour) |
