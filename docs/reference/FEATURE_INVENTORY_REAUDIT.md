# Feature inventory re-audit (2026-09-18)

This re-audits every unit in [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) (written 2026-09-17 against about 3,600 lines) against the code as of commit `9731b30` (about 29,000 lines in `packages/*/src` and `apps/harness/src`, plus 16,800 in `packages/ui/web`). It was a read-only audit: no builds or tests were run, and every status comes from reading the implementation and tracing its callers.

## Tags

| Tag | Meaning in this re-audit |
| --- | --- |
| **BUILT** | Implements the design's requirement to depth, and a production path reaches it. Caveats are listed where a secondary detail is missing. |
| **SHALLOW** | Code exists and is reachable, but it is a simplification, a heuristic or a partial version of what the design specifies. |
| **DEAD** | Implemented, but nothing in production calls it (only tests, or nothing), or its output is computed and then discarded. |
| **MISSING** | No code for the unit. |
| **UNDETERMINED** | Cannot be judged without running something (see the last section). |

### Production call chains used as shorthand

| Shorthand | Chain |
| --- | --- |
| **[RUN]** | `packages/loop/src/card_runner.ts` `CardRunner.run` ← `apps/harness/src/execute.ts` `executeCard` ← `apps/harness/src/index.ts` `main` (`sekhemet run <card>` and `sekhemet queue`, which `bake-off` and `scripts/run_gate.sh` also drive) |
| **[TURN]** | `packages/loop/src/session.ts` `CardExecutionSessionImpl.executeTurn` / `runVerification` ← [RUN] |
| **[TOOL]** | `packages/loop/src/tools.ts` `ToolExecutor.execute` ← [TURN] |
| **[GATE]** | `packages/gates/src/runner.ts` `DeterministicGateRunner.runGates` ← [TURN] `runVerification` |
| **[SRV]** | `apps/harness/src/server.ts` `startDashboardServer` ← `index.ts` `sekhemet serve` / `ui` |
| **[WEB]** | a `packages/ui/web/*.js` module imported by `app.js`, served by [SRV] under `/app/` |
| **[ACCEPT]** | `apps/harness/src/execute.ts` `acceptCard` ← `sekhemet accept`, `queue --auto-accept`, and [SRV] `POST /api/cards/:id/accept` |
| **[PM]** | `apps/harness/src/pm/*` (Seshat) ← [SRV] `/api/pm/*` and the queue's `answerPm` |
| **[PLAN]** | `packages/planner/src/planner.ts` `SpidrFeaturePlanner.decomposeFeature` ← `index.ts` `sekhemet plan` (the planner package's only production caller) |

## Summary

| Status | 2026-09-17 (inventory) | 2026-09-18 (this re-audit) | Change |
| --- | --- | --- | --- |
| BUILT | 7 | 59 | +52 |
| SHALLOW | 64 | 109 | +45 |
| DEAD | 21 | 19 | -2 |
| MISSING | 209 | 114 | -95 |
| UNDETERMINED | 1 | 1 | 0 |
| **Total** | **302** | **302** | |

Both columns are counted mechanically from the per-unit table below.

How the old counts were normalised: the inventory has 302 numbered units (K1 to X29). Compound tags were counted once: "DEAD + SHALLOW" and "SHALLOW + DEAD" as DEAD, "SHALLOW (partially BUILT)" and "PARTIAL" as SHALLOW, and "BUILT, however it is DEAD" (G10) as DEAD. The inventory's own headline (about 225 / 45 / 25 / 15) and the brief's figures (232 / 78) were estimates. The column above is an exact recount of its per-unit rows.

### By package

| Package | Units | BUILT | SHALLOW | DEAD | MISSING | Undetermined |
| --- | --- | --- | --- | --- | --- | --- |
| kernel (K) | 28 | 6 | 8 | 4 | 10 | 0 |
| sandbox (S) | 15 | 5 | 7 | 0 | 3 | 0 |
| sync (Y) | 20 | 3 | 5 | 0 | 12 | 0 |
| models (M) | 25 | 3 | 10 | 2 | 10 | 0 |
| gates (G) | 27 | 7 | 4 | 1 | 15 | 0 |
| context (C) | 22 | 4 | 8 | 2 | 8 | 0 |
| loop (L) | 31 | 12 | 12 | 1 | 6 | 0 |
| board (B) | 13 | 3 | 7 | 1 | 2 | 0 |
| planner (P) | 25 | 1 | 11 | 5 | 8 | 0 |
| eval (E) | 19 | 2 | 5 | 3 | 9 | 0 |
| ui (U) | 21 | 9 | 9 | 0 | 3 | 0 |
| harness app (H) | 27 | 2 | 14 | 0 | 11 | 0 |
| cross-cutting (X) | 29 | 2 | 9 | 0 | 17 | 1 |
| **Total** | **302** | **59** | **109** | **19** | **114** | **1** |

### What changed, in one paragraph

The five structural findings of the original audit are fixed. `@sekhemet/context` is wired into the loop. The executor gets a real four-zone prompt with its tool catalog. Commands run under Seatbelt on macOS and bubblewrap on Linux. A card runs a real loop: turns, re-checks, a repair ladder, checkpoints and an evidence bundle. `gates.toml` is parsed, pinned by hash and executed. The new code also covers a lot the design never itemised: Seshat (the PM), learning rules, the Researcher, model swapping, the integrity gate and a much larger dashboard.

What is still thin is everything around that loop. Most of the planner's output is discarded. Several finished modules have no production caller: the condenser, the hook engine, the benchmark harness, task synthesis, the context-pressure tiers and the bounds gate. The whole GitHub App, visual-gate, air-gap and self-improvement surface is still missing. So is anything that lets the dashboard run, rewind or fork a card.

### Defects found while tracing (not inventory units, but they affect them)

1. **The queue will probably crash when Review is full.** `CardRunner.run` calls `lifecycle.transition(card.id, "verify")` without a try/catch. `BoardServiceImpl.transitionCard` throws a back-pressure error when Review already holds 3 cards (the default limit). A `sekhemet queue` run without `--auto-accept` over more than 3 passing cards should therefore abort mid-run with no queue report. The benchmarks use `--auto-accept`, so they are not affected. This is inferred from reading the code, not reproduced.
2. **Checkpoints are never written to the database.** `CardStore.recordCheckpoint` has no production caller. Checkpoint commits exist only as git refs, so `sekhemet replay` always prints zero checkpoints.
3. **Restricted mode confines the gates but not the agent's tools.** `executeCard` passes `requireConfinement` to the gate runner's sandbox only. `ToolExecutor` builds its own `new ProcessSandbox()` without the flag, so on a host with no Seatbelt or bubblewrap the model's `run_cmd` runs unconfined even under `--restricted`.
4. **The ask permission tier is always a denial.** No production caller supplies `onApproval`, so every ask-tier command (destructive git, network commands) is refused without asking anyone.
5. **`gates.toml [project] protected` is ignored by the permission engine.** `ToolExecutor` builds `new PermissionEngine()` with the default globs. The project's declared protected list only affects the gate runner's fix-hint redirection.
6. **Planned cards lose their contract.** `sekhemet plan` persists `story.card` only. That drops the spec, acceptance tests, dependencies, difficulty, routing and edit sketch the planner computed, so a planned card reaches the executor with a title and scope files and nothing else.
7. **The MCP server offers a tier the database rejects.** `sekhemet_create_card` still advertises tier `"spike"`, which the `cards.tier` CHECK constraint refuses.
8. **The card record's actuals are never set.** The runner never writes `stopReason`, `tokensUsed`, `secondsUsed`, `evidenceId` or `contextPackId`. It persists only `stepsUsed`.

## Per-unit status

Test notes follow DEFINITION_OF_DONE §2. "Real" means a real SQLite file, real subprocesses or real git. "Mem" means an in-memory SQLite database, which §2.A.1 forbids for kernel and board tests.

### `@sekhemet/kernel`

| # | Unit | Old | New | Evidence (file:symbol ← caller) | Notes |
| --- | --- | --- | --- | --- | --- |
| K1 | Hash-chained append-only event log | BUILT | BUILT | `kernel/src/log.ts` `EventLog.append` ← `CardStore.recordEvent/createCard` ← [RUN], [PM], [SRV] | The chain now covers the payload hash and the card, attempt and step ids. Tests use in-memory SQLite (log.spec), which DoD §2.A.1 forbids. |
| K2 | `verifyHashChain` reports first broken seq | BUILT | BUILT | `log.ts` `verifyHashChain` ← `sekhemet log`, [SRV] `/api/events` | Tamper test edits a row via SQL (mem), not a bit flip on disk as DoD §2.B asks. |
| K3 | Separate `payload_hash` column, canonical JSON | SHALLOW | BUILT | `kernel/src/canonical_json.ts` `canonicalPayloadHash`; `schema.ts` `payload_hash` ← `EventLog.append` | Legacy rows are still verifiable. |
| K4 | Typed `cardId/attemptId/stepId` columns + indexes | MISSING | SHALLOW | `schema.ts` columns and indexes; `getEventsByCard` ← [SRV] `/api/events?card=` | `card_id` is populated. `attempt_id` and `step_id` are never written by anything, because attempts and steps do not exist as entities. |
| K5 | Actor enum CHECK | SHALLOW | SHALLOW | `schema.ts` `actor TEXT NOT NULL` | Still no CHECK. Production writes actors `github`, `harness`, `human`, `sync` alongside the spec's five. |
| K6 | `subscribe(filter, cb)` | MISSING | DEAD | `log.ts` `EventLog.subscribe` | No production caller. The SSE stream polls with `pump()` on a 1 s timer instead. |
| K7 | `getRange(sinceSeq, limit)` | BUILT | BUILT | `log.ts` `getEvents`, `getEventsByTypes` ← [SRV], `pm/metrics.ts` | |
| K8 | Projection engine rebuild / applyEvent | SHALLOW | DEAD | `card_store.ts` `rebuildProjections` (4 event types) | No production caller. State is still written alongside the event rather than derived from it. |
| K9 | Service container | MISSING | MISSING | — | `index.ts` constructs everything by hand. |
| K10 | Plugin manager with reversible mount | MISSING | MISSING | — | |
| K11 | "Model-visible means logged" | MISSING | SHALLOW | `card_runner.ts` `writeTranscript` ← [RUN] | Per-attempt JSONL of the raw reply, tool calls and observation *summaries*. The prompts themselves are not logged, nothing goes to the hash-chained ledger, and there is no runtime assertion. |
| K12 | Waterfall lifecycle hooks | DEAD | DEAD | `kernel/src/hooks.ts` `LifecycleHookEngine.emit` | Now has real block, inject and fail-closed semantics, but nothing calls `emit`. It is not used by the loop, gates or harness. |
| K13 | 4-level hierarchy cap | MISSING | MISSING | — | 5-tier enum, no depth validation. |
| K14 | `projects` table | MISSING | MISSING | — | Single-project harness. |
| K15 | `card_dependencies` + DAG | MISSING | SHALLOW | `schema.ts` `depends_on JSON`; `execute.ts` `inferDependencies` ← `queue` | No table, no cycle check on write. The queue defers cards until their dependencies are done. Dependencies are inferred from text mentions of scope files. |
| K16 | `attempts` table | MISSING | MISSING | — | Attempts exist only as evidence JSON files. |
| K17 | `steps` table | MISSING | MISSING | — | Steps are `card/step` ledger events (`execute.ts` `stepEventPayload`), not a table. |
| K18 | `gate_results` table | MISSING | MISSING | — | Gate outcomes live in evidence JSON and `card/step` payloads. |
| K19 | `evidence_bundles` table | MISSING | MISSING | — | Bundles are files, see G11. |
| K20 | `decision_requests` table | MISSING | MISSING | — | |
| K21 | `competence_entries` / competence model | MISSING | SHALLOW | `apps/harness/src/pm/capability.ts` (Wilson intervals per SPIDR kind, 80% size horizon) ← [PM] prompt and `/api/capability` | Derived from evidence files, not a table. It informs Seshat's advice, but no budget or route is set from it. |
| K22 | Full card record shape | SHALLOW | SHALLOW | `kernel/src/types.ts` `CardRecord`, `schema.ts` | Every field now exists. The runner writes only `stepsUsed`. `stopReason`, `tokensUsed`, `secondsUsed`, `evidenceId` and `contextPackId` are never set (defect 8). |
| K23 | `busy_timeout = 5000` | MISSING | BUILT | `schema.ts` `KERNEL_PRAGMA_SQL` ← `initSchema` ← `initLocalKernel` | |
| K24 | Column enum incl. Planning | SHALLOW | BUILT | `schema.ts` `CARD_STATUS_CHECK`, migration `rebuildCardsTableIfStale` | `rejected` is kept as an extra status. |
| K25 | Difficulty scale | MISSING | SHALLOW | `schema.ts` `difficulty` 1..10 CHECK | Nothing in production writes it: the planner's score is discarded (defect 6). |
| K26 | Packs and evidence stored under `.sekhemet/` by hash | MISSING | SHALLOW | `card_runner.ts` `writeEvidence` (`ev_<sha>` ids), `writeTranscript` | Evidence and transcripts are on disk. No context packs are stored, and events do not reference blobs by hash. |
| K27 | 30-day retention | MISSING | MISSING | — | |
| K28 | Checkpoint record with attribution | BUILT | DEAD | `card_store.ts` `recordCheckpoint` | No production writer (defect 2). `getCheckpoints` is read by `sekhemet replay` and always returns an empty list. |

### `@sekhemet/sandbox`

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| S1 | Seatbelt profile generation | DEAD | BUILT | `sandbox/src/seatbelt.ts` `generateSeatbeltProfile` ← `executor.ts` `ProcessSandbox.wrap` ← [TOOL] `runCmd`, [GATE] `runGate` | Writes are confined to the worktree, its symlinked dependency directories and a private scratch dir. Network is denied. Tested with real subprocesses (containment.spec). |
| S2 | Commands run under `sandbox-exec` | MISSING | BUILT | `executor.ts` `wrap` (`/usr/bin/sandbox-exec -p`) ← same | `sekhemet doctor` runs a real escape probe. |
| S3 | Linux namespaces + Landlock + seccomp | MISSING | SHALLOW | `sandbox/src/bubblewrap.ts` `bubblewrapArgv` ← `ProcessSandbox` | bubblewrap gives read-only root, a private /tmp, write binds and unshared net/pid/ipc/uts namespaces. There is no Landlock and no seccomp filter. |
| S4 | Fail closed on missing sandbox | MISSING | SHALLOW | `executor.ts` `requireConfinement` | Only the gate runner's sandbox gets the flag, and only under `--restricted`. The agent's own `run_cmd` runs unconfined wherever no mechanism exists (defect 3). |
| S5 | Network denied; allowlisting proxy; request log | MISSING | SHALLOW | Seatbelt `(deny network*)`, bwrap `--unshare-net` | Denial by default is real. There is no allowlist proxy and no per-request log with a payload hash. |
| S6 | Timeout, then SIGTERM, then SIGKILL | BUILT | BUILT | `executor.ts` `execute` | Real-subprocess test. |
| S7 | Buffer cap / OOM detection | SHALLOW | SHALLOW | `executor.ts` | Truncation now leaves a marker. `oomKilled` is still inferred as "SIGKILL and not timed out". |
| S8 | Allow / Ask / Deny permissions | SHALLOW | SHALLOW | `sandbox/src/permissions.ts` `PermissionEngine.evaluate` ← [TOOL] `authorize` | Close to BUILT: glob scopes, and the loop driver, gates runner and sandbox files are on the deny list. Missing: an ask-tier approver (defect 4), the project's protected list (defect 5), a domain allowlist and the external-binary ask tier. |
| S9 | Untrusted-content tagging | MISSING | MISSING | — | Web text the Researcher fetches (`research/web.ts`) is not tagged. |
| S10 | Supply-chain registry/age/typosquat check | MISSING | MISSING | — | `pm/libraries.ts` checks licences for Seshat's library suggestions. That is not an install gate. |
| S11 | `osv-scanner` | MISSING | MISSING | — | |
| S12 | Restricted mode | SHALLOW | SHALLOW | `index.ts` `--restricted` → `execute.ts` `requireConfinement` | `run` is not stripped from the tools, and it does not switch to read-only inspection (defect 3). |
| S13 | Worktree manager contract | MISSING | BUILT | `sync/src/git_adapter.ts` `createWorktree/removeWorktree` ← [RUN], [ACCEPT] | Lives in `@sekhemet/sync` rather than sandbox, a package-boundary deviation only. |
| S14 | Copy-on-write worktrees + linked deps | MISSING | SHALLOW | `git_adapter.ts` `linkDependencies` (symlinks `node_modules`, `.venv`) | No APFS clonefile or reflink: plain `git worktree add`. |
| S15 | Per-card env isolation | SHALLOW | BUILT | `executor.ts` `ENV_ALLOWLIST`, `buildEnv` | |

### `@sekhemet/sync`

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| Y1 | Per-card worktree and branch naming | SHALLOW | SHALLOW | `git_adapter.ts` `branchNameFor` (`sekhemet/<project>/<id>-<slug>`) ← [RUN] | Naming is fixed. Worktrees are always based on `main`, never on a parent card's branch. |
| Y2 | Checkpoint commit with trailers | BUILT | BUILT | `git_adapter.ts` `commitCheckpoint` ← [RUN] | Writes the singular `refs/sekhemet/checkpoints/<id>` ref plus per-step refs. Production passes no `coAuthors`, so `Co-authored-by` is missing from harness commits. |
| Y3 | Commit after every gate-passing step and every masking boundary | MISSING | SHALLOW | `card_runner.ts` `run` → `commitCheckpoint` | A checkpoint is written only when the gates pass, which ends the card. There are none mid-card and none at masking boundaries, so a relay or resume cannot pick up partial work from git. |
| Y4 | Squash on accept into Conventional Commits | SHALLOW | SHALLOW | `git_adapter.ts` `squashAndMerge` ← [ACCEPT] | One `feat(<card-id>): title` commit. No intent grouping and no type or scope derivation. |
| Y5 | Shell-injection-safe git | SHALLOW | BUILT | `git_adapter.ts` `runGit` (`execFileSync`) | |
| Y6 | Rebase before Verify; conflicts as typed failures | MISSING | MISSING | — | |
| Y7 | Stacked branches | MISSING | MISSING | — | |
| Y8 | difftastic structural diff | MISSING | MISSING | — | |
| Y9 | `getHeadSha` / `generateDiff` | MISSING | BUILT | `git_adapter.ts` `getHeadSha`, `generateDiff`, `getDiffStats`, `getRepoStateHash` ← [RUN], [TURN] | Real-git tests (sync.spec). |
| Y10 | Generic `SyncAdapter` interface | MISSING | SHALLOW | `apps/harness/src/integrations.ts` `syncGithub` ← [SRV] `/api/integrations/github/sync` | Two-way GitHub Issues sync through `gh`. No adapter interface, no capabilities, no last-writer-wins history. |
| Y11 | Forgejo adapter | MISSING | MISSING | — | |
| Y12 | GitHub App auth (RS256 JWT) | MISSING | MISSING | — | Uses the user's `gh` login instead. |
| Y13 | Webhook intake | MISSING | MISSING | — | |
| Y14 | Check Runs with annotations | MISSING | MISSING | — | |
| Y15 | SARIF upload | MISSING | MISSING | — | |
| Y16 | PR lifecycle | MISSING | SHALLOW | `execute.ts` `openPullRequest` ← [ACCEPT] when `githubPrOnAccept` is set | A non-draft PR with the spec and gate list as its body. No checks, CODEOWNERS, thread resolution or auto-merge. |
| Y17 | Release cards | MISSING | MISSING | — | |
| Y18 | CI as a gate source via `act` | MISSING | MISSING | — | |
| Y19 | Monorepo / multi-repo scope | MISSING | MISSING | — | |
| Y20 | Mid-card external-edit reconciliation | MISSING | MISSING | — | |

### `@sekhemet/models`

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M1 | HTTP inference adapter | BUILT | BUILT | `models/src/http_adapter.ts` `HttpInferenceAdapter.generate`, `llama_server.ts` `ManagedLlamaServerAdapter` ← [TURN] | Ollama and OpenAI-compatible APIs, plus a harness-managed llama-server. |
| M2 | Token streaming | MISSING | MISSING | — | `stream: false` on both paths. |
| M3 | `measureThroughput` | MISSING | MISSING | — | Per-request `durationMs` only. |
| M4 | `healthCheck` | MISSING | SHALLOW | `llama_server.ts` `healthy()` / `ensureRunning`; `apps/harness/src/doctor.ts` `probeInference` | No adapter-level contract. |
| M5 | Qwen3.8-27B pinned profile (CHRONICLE §2) | DEAD | DEAD | `http_adapter.ts` `createQwen38_27BAdapter` | Never called. Production uses the Nail and Cyber-Tiel profiles. There is still no planning profile (0.7 / 0.8). |
| M6 | Per-request reasoning control | MISSING | SHALLOW | `http_adapter.ts` `disableReasoning` (`reasoning_effort: none`, `enable_thinking: false`) | Always off. Reasoning is never raised for planning or after a Rung 1 failure. |
| M7 | Tolerant tool-call parser | SHALLOW | BUILT | `models/src/parser.ts` `parseToolCallsFromText` (reasoning strip, fences, balanced-brace scan, wrapper shapes, `name(k=v)` syntax, trailing-comma repair) ← `generate` | Truncated-JSON salvage is limited. Native tool calls are preferred when the server returns them. |
| M8 | Arm A grammar-constrained decoding | MISSING | SHALLOW | `generate` sends `tools` (native tool calling) | No `grammar`, `json_schema` or `response_format`. Arms are never measured per model. |
| M9 | Arm C search/replace patches | DEAD | DEAD | `parser.ts` `parseArmCTextPatches` (reached only when `toolArm === "arm_c_sketch"`) | The session hardcodes `arm_a_flat`, and no production caller sets `toolArm`. |
| M10 | Mock adapter contract | SHALLOW | SHALLOW | `models/src/mock_adapter.ts` | Test infrastructure, unchanged: no pattern matching, and the queue still cycles. |
| M11 | Model registry | MISSING | SHALLOW | Named profiles (`NAIL_WORKER_PROFILE`, `createCyberTielWorker`, `createApodexResearcher`), `ModelRouter` roles, [SRV] `/api/models` roster | No registry entries with template checksums, measured arms, qualification or throughput buckets. |
| M12 | Chat-template pinning by checksum | MISSING | MISSING | — | |
| M13 | Hardware calibration | MISSING | MISSING | — | |
| M14 | Tier profiles S/M/L/XL | MISSING | MISSING | `config.ts` `MachineTier` type only | `canCoReside` is a RAM heuristic, not a tier. |
| M15 | Throughput floors, refusal below them | MISSING | MISSING | — | |
| M16 | 8-bit KV; 4-bit prohibited | MISSING | SHALLOW | `llama_server.ts` `launchArgs` `-ctk/-ctv q8_0` default | `kvType` is overridable, with no prohibition check. The Ollama path is not controlled. |
| M17 | Prompt-cache configuration | MISSING | SHALLOW | `http_adapter.ts` `cache_prompt: true` (OpenAI path); `llama_server.ts` slot save/restore across swaps | No `--cache-ram`, `--ctx-checkpoints` or `-sps` in `launchArgs`. |
| M18 | Prefix-cache hit-rate telemetry, alert under 85% | MISSING | MISSING | — | The server's `timings`/`cache_n` are never read. |
| M19 | Speculative decoding / MTP | MISSING | SHALLOW | `llama_server.ts` `--spec-type draft-mtp` for Cyber-Tiel | No draft-model qualification and no per-machine decision. |
| M20 | Memory-pressure watchdog | DEAD | SHALLOW | `models/src/memory.ts` `checkExecutionHeadroom` ← [TURN] (every turn); `router.ts` pressure wait on swaps | No 2 s poller and none of the graduated actions (suspend MTP, trim caches). `index.ts` `checkMemoryPressure` is still dead. |
| M21 | Model swapping | MISSING | BUILT | `models/src/router.ts` `ModelRouter.use` (verified unload, pressure wait, co-residency) ← `queue` | Tests: router_swap.spec (mocked processes). |
| M22 | Qualification suite | MISSING | MISSING | — | |
| M23 | Per-repo bake-off | MISSING | SHALLOW | `index.ts` `bake-off` → `scripts/run_gate.sh` → `queue` | Runs a real fixture per worker. It uses a benchmark fixture, not tasks from the repo's own history, and records model id, Pass@1, minutes and tokens, not quant, arm, context or engine. |
| M24 | Engine selection by measurement | MISSING | MISSING | — | |
| M25 | Declared-hours scheduling | MISSING | MISSING | — | |

### `@sekhemet/gates`

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| G1 | `gates.toml` parser | MISSING | BUILT | `gates/src/config.ts` `loadGatesConfig` (`kernel/src/toml.ts` `parseToml`) ← [RUN], `execute.ts` | `schedule` and `threshold` are not parsed. |
| G2 | Hash verification on every card start | MISSING | BUILT | `config.ts` `verifyGatesConfig` ← `runner.ts` `resolveConfig` (every `runGates` with a pinned hash) ← [GATE] | |
| G3 | Six layers | SHALLOW | SHALLOW | `types.ts` `GateLayer`, carried on `RungOutcome` | Labels only. No robustness, security, visual or hygiene gate exists to run, and there are no runs-on hosts. |
| G4 | Runner executes declared commands | SHALLOW | BUILT | `runner.ts` `runGate` (per-gate command, args, timeout, parser) ← [GATE] | Language-agnostic when a project declares gates. The default set is pnpm. |
| G5 | Full-layer run, not short-circuit | SHALLOW | BUILT | `runner.ts` `runGates` (`failFast` off by default) | |
| G6 | In-memory parse gate before write | MISSING | SHALLOW | `loop/src/parse_gate.ts` `checkSyntax` ← [TOOL] `writeText` | Real for TS/JS through the TypeScript parser. There is no tree-sitter, so other languages are unchecked. |
| G7 | Write path: scope, parse, secret scan, atomic | SHALLOW | SHALLOW | [TOOL] `authorize` + `writeText` | No secret scan. The write is a plain `writeFileSync`, not temp-file-and-rename. |
| G8 | Typed `GateFailure`, top 3 in order | SHALLOW | BUILT | `types.ts` `GateFailure` (location, expected/actual, minimalRepro, suggestedAction); `parsers.ts` `rankFailures` (top 3, severity then references) ← [GATE] | The ordering is severity and file references, not a true topological order. |
| G9 | Parser registry | MISSING | BUILT | `parsers.ts` `FailureParserRegistry` (tsc, vitest/jest, biome/eslint, generic) ← `runGate` | No gitleaks parser, which follows from G14. |
| G10 | Bounds check (3 files, 200 LOC) | DEAD | DEAD | `runner.ts` `checkBounds` | Still never called. `card_runner.ts` computes diff stats for evidence only. The dashboard flags oversize cards (`ui/src/vocabulary.ts`) but nothing blocks them. |
| G11 | Evidence bundle | MISSING | BUILT | `gates/src/evidence.ts` `compileEvidence` ← [RUN] `writeEvidence` → [SRV] `/api/evidence/:id` → [WEB] `evidence.js` | Missing `structuralDiff`, `abandonedHypotheses` and a `trajectoryRef` hash. |
| G12 | Acceptance tests first; fail before work | SHALLOW | SHALLOW | `execute.ts` `onWorktreeReady` stages `acceptance/*`; permission deny; `loop/src/integrity.ts` | The tests are staged and protected, but nothing runs them at card start to confirm they fail. The fixtures were proven fail-to-pass offline. |
| G13 | Diff-scoped mutation testing | MISSING | MISSING | — | Not built by design (IMPLEMENTATION_AUDIT §2). |
| G14 | Secret scan (gitleaks) | MISSING | MISSING | — | |
| G15 | Dependency existence / typosquat gate | MISSING | MISSING | — | |
| G16 | Semgrep | MISSING | MISSING | — | |
| G17 | Visual: console and network errors | MISSING | MISSING | — | |
| G18 | Visual: layout bounds | MISSING | MISSING | — | |
| G19 | Visual: screenshot diff | MISSING | MISSING | — | |
| G20 | Visual: axe-core at 1280 / 375 | MISSING | MISSING | — | |
| G21 | Vision checklist (can fail, never pass) | MISSING | MISSING | — | |
| G22 | Hygiene gate (changelog, debug output, trailers) | MISSING | MISSING | — | The new integrity gate (`integrity.ts`, which rejects suppressions and skipped or focused tests) is a related live gate but covers none of the three hygiene checks. |
| G23 | Regression protection on re-entering Review | MISSING | MISSING | — | |
| G24 | Gate host separation | MISSING | MISSING | — | |
| G25 | Pass@k with gate selection | MISSING | MISSING | — | |
| G26 | Cross-validation of attempts | MISSING | MISSING | — | |
| G27 | Gate templates by language | MISSING | MISSING | — | Only the pnpm defaults. |

### `@sekhemet/context`

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| C1 | Tree-sitter repo map with PageRank | DEAD | SHALLOW | `loop/src/repo_map.ts` `buildRepoMap` → `context/src/repo_map.ts` `extractSymbolOutline` ← [TURN] `buildPromptAt` | Line-prefix TS outline, scope files first, capped at 120 files, byte-stable order. No AST, graph, PageRank, budget binary search or cache key. |
| C2 | LSP client pool | MISSING | MISSING | — | |
| C3 | SWE-Pruner line pruning | MISSING | MISSING | — | |
| C4 | Four-zone layout, byte-stable prefix | DEAD | SHALLOW | `context/src/prompts.ts` `buildFullPromptPack` ← [TURN] | Real zones with the goal at the tail. Zone 2 is not stable within a card: rules matched on `triggerGate` and the active rung's directive enter it after a gate failure. `prefixHash` is computed and discarded. |
| C5 | Budgets: system prompt under 1k, tools under 2k | SHALLOW | BUILT | `zones.ts` `assertSystemZoneBudget`, `tool_interface.ts` budget assert ← `buildFullPromptPack` | |
| C6 | Observation masking with EvidenceRef | DEAD | SHALLOW | `context/src/condenser.ts` `maskOlderObservations`, `compactHistory`; `recall` tool ← [TURN] | Pointers carry refs and `recall` works, but the store is `defaultEvidenceStore` in memory, so refs die with the process. `FileEvidenceStore` is dead. |
| C7 | Graduated masking at 70 / 80 / 85 / 90 / 95% | MISSING | SHALLOW | Live: `session.ts` `buildPrompt` (6 reduction levels when over the window). Dead: `context/src/pressure.ts` `applyContextPressure` | The live path reacts only to overflowing the window. It has no tiers and no `budget_exhausted` at 95%. |
| C8 | RTK four-strategy lossless condensing | DEAD | DEAD | `condenser.ts` `condenseCommandOutput` (filter, group, dedupe, protected-line truncation) | Not called by `run_cmd` or `check`. [TOOL] `runCmd` uses `observation.ts` `clampObservation` (2,400 head + 1,200 tail characters), which can drop a middle error line. That is the lossiness §430 forbids. |
| C9 | Skills registry (Agent Skills) | DEAD | SHALLOW | `context/src/skills.ts` `SkillsRegistry` ← `execute.ts` → [TURN] | Loaded and matched by trigger substring. The full body is always injected (disclosure defaults to `full`). No scripts, references or evals directories, no tool requirements, no versioning. |
| C10 | Skill trust (pinning, audit, rejection) | MISSING | MISSING | — | |
| C11 | Playbook | DEAD | BUILT | `context/src/playbook.ts` `PlaybookRegistry` + `apps/harness/src/learning/store.ts` `LearningStore` (ledger-backed candidate → active → retired, helpful/harmful counts, evidence, Mem0 consolidation) ← `execute.ts` → [TURN] | Grows by delta with origin evidence and needs human approval. Caveat: some rules enter mid-card (see C4). |
| C12 | Context-debt audit (over 300 tokens, under +3%) | DEAD | DEAD | `playbook.ts` `auditContextDebt` | No caller. The live analogue is `LearningStore.retirementCandidates` (harmful minus helpful ≥ 3), which is a different criterion. |
| C13 | Exemplar store | MISSING | MISSING | — | Only `priorLessons` carry over between attempts of one card. |
| C14 | `assembleContextPack` | DEAD | SHALLOW | Inline in `session.ts` `buildPromptAt` / `pinnedFiles` | Real assembly with pinned tests and scope files and window fitting. `context/src/engine.ts` `DefaultContextEngine` is dead, and no pack id or per-zone counts are persisted. |
| C15 | Byte-identical prompt for identical inputs | MISSING | SHALLOW | Sorted skills, rules, map and catalog | Never asserted at runtime. See C4. |
| C16 | Subtask branching | MISSING | MISSING | — | |
| C17 | Fresh context on rung change | MISSING | BUILT | `loop/src/ladder.ts` `resetContext` → `session.ts` (`history.slice(-1)`, map cache cleared) ← [TURN] | |
| C18 | Reasoning traces stripped between steps | MISSING | BUILT | `parser.ts` `stripReasoning` ← `generate`; reasoning disabled per request | |
| C19 | Dynamic tool loading (`tool_search`) | MISSING | MISSING | — | The full 20-tool catalog is sent every turn. |
| C20 | Per-step / per-card context metrics | MISSING | SHALLOW | Token usage per turn in `card/step` events and evidence | Zone token counts (`PromptZoneReport`) are computed and discarded. No cache hit rate, no masked-count metrics. |
| C21 | Joint prompt / playbook / tool versioning | MISSING | MISSING | — | |
| C22 | AGENTS.md / CLAUDE.md folded into Zone 2 | MISSING | MISSING | — | Reachable only through the `docs` tool. |

### `@sekhemet/loop`

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| L1 | Executor turn driver | SHALLOW | BUILT | [RUN] `while (steps < budget) executeTurn()` | Tests: loop.spec with mock models. A live-model run happened on Chronicle (DEV_LOG), not in CI. |
| L2 | Prompt from the context pack | MISSING | BUILT | [TURN] `buildPrompt` → `buildFullPromptPack` | Spec, criteria, pinned tests, failures with the code at each line, goal at the tail. |
| L3 | Tool set as specified | SHALLOW | BUILT | `loop/src/tool_catalog.ts` `TOOL_CATALOG` (20 tools) → `toolDefinitions()` JSON Schema ← [TURN] | |
| L4 | `read`: 1-based, numbered, byte budget | SHALLOW | BUILT | [TOOL] `readFile` | 512 KB limit, binary detection, outline for unranged files over 200 lines. No image or PDF passthrough. |
| L5 | `edit`: unique match, CRLF-aware, parse gate | SHALLOW | BUILT | [TOOL] `edit` | |
| L6 | `grep`: ripgrep, modes, gitignore, capped | SHALLOW | SHALLOW | [TOOL] `grep` | Regex with a literal fallback, capped at 80. One mode, no context lines, not gitignore-aware (only a fixed skip list), and it reads the whole tree in JS. |
| L7 | `glob`: mtime-sorted, gitignore-aware | SHALLOW | SHALLOW | [TOOL] `findFiles` (`sandbox/src/glob.ts`) | Real globs, capped at 300. Sorted by name, not mtime, and not gitignore-aware. |
| L8 | `run`: sandbox, timeout, description, allowlist, condensing | SHALLOW | SHALLOW | [TOOL] `runCmd` | Sandboxed, 120 s timeout, shell lines through `/bin/sh -c`. No `description` field, no structured-tool enforcement (raw `cat`/`grep`/`sed` allowed), no RTK condensing (see C8). |
| L9 | Symbol tools over LSP | SHALLOW | SHALLOW | `loop/src/symbols.ts` `findSymbol` ← [TOOL] | Regex declarations with string- and comment-aware brace matching and preserved indentation. No LSP. `find_references` is a whole-word grep. |
| L10 | `docs`: tiered library lookup | SHALLOW | SHALLOW | [TOOL] `docs` (four root markdown files, matching lines) | Adjacent live tools: `dependencies` (package.json plus install state) and `git_history`. No dependency docs at the installed version, no mirrors, no cache. |
| L11 | `note` to the thread and inbox | SHALLOW | SHALLOW | [TOOL] `note` | In-memory list. Never reaches the card thread, inbox or ledger. |
| L12 | Code-mode scripts | MISSING | MISSING | — | |
| L13 | Stall detection over tool, argHash and repoStateHash | SHALLOW | BUILT | `loop/src/detector.ts` `OscillationDetector.recordAndCheck` (canonical argument hash, repo hash from `getRepoStateHash`, A-B-A-B) ← [TURN] | The session threshold is 3 identical turns; the design says 2. |
| L14 | Six stop reasons | SHALLOW | SHALLOW | `loop/src/types.ts` `ExecutionStopReason` | Has `gate_passed`, `budget_exhausted`, `oscillation_detected`, `no_progress`, `repair_exhausted`, `error`, `memory_pressure`, `quota_suspended` (never produced). Still missing: `done_pending_gates`, `scope_violation` (a denial becomes an observation), `capability_ceiling`, `human_abort`. |
| L15 | Four-rung retry ladder | MISSING | SHALLOW | `ladder.ts` `RepairLadder` (2 / 1 / 1 attempts) ← [TURN] on a failed `finish_card`; the queue's manager `planRepair` retry | Rungs 1 and 2 are real. Rung 3 is an in-context "edit sketch" directive, not a return to the planner for re-decomposition. Rung 4 stops the card in Verify with `repair_exhausted`; it does not park it with a diagnostic. The manager retry is a queue-level second attempt, and only with `--manager`. |
| L16 | `validateWrite` contract | MISSING | SHALLOW | Inline in [TOOL] `authorize` and `writeText` | No distinct contract. See G7. |
| L17 | Read-before-edit enforcement | MISSING | MISSING | [TOOL] tracks `readFiles` for the prompt only | Not enforced. |
| L18 | Tool sets per card class | MISSING | MISSING | `SessionOptions.tools` exists | Production never passes it, so every card gets all 20 tools. |
| L19 | `search`/`fetch` only on research cards | MISSING | SHALLOW | `apps/harness/src/research/researcher.ts` `research` ← `queue` (unexplained struggles), [PM] `ask_researcher` | The executor has no web tools, which is correct. The Researcher runs as a side role, not as research cards. |
| L20 | `browse` tool | MISSING | MISSING | — | |
| L21 | Planner-set dynamic step budgets | SHALLOW | SHALLOW | `planner/src/difficulty.ts` `stepBudgetForDifficulty` (via `plan` only); `queue --max-turns` from `sekhemet tune` | Not set from class history. The schema default is still 50; config says 40. |
| L22 | Token and wall-clock budgets, circuit breaker | MISSING | SHALLOW | Tokens summed into evidence ([RUN]) | `tokenBudget` and `secondsBudget` are never enforced. No kWh, no breaker. |
| L23 | Background processes per card | MISSING | MISSING | — | |
| L24 | Interactive terminals | MISSING | MISSING | — | |
| L25 | `abort(reason)` | SHALLOW | DEAD | `session.ts` `abort` (records the reason and sets `isFinished`) | Nothing in production calls it. There is no human-abort path from the CLI or dashboard. |
| L26 | Symlink-aware path confinement | DEAD | BUILT | `loop/src/paths.ts` `resolveInWorktree` ← [TOOL] | |
| L27 | CRLF / EOL-preserving text utilities | DEAD | BUILT | `loop/src/text.ts` ← [TOOL] | |
| L28 | Real glob engine | DEAD | BUILT | `sandbox/src/glob.ts` ← [TOOL], `PermissionEngine` | |
| L29 | `ToolObservation` + clamping | DEAD | BUILT | `loop/src/observation.ts` ← [TOOL] | |
| L30 | `ToolExecutor` | DEAD | BUILT | `tools.ts` ← [TURN] | The ask-tier handler is never supplied (defect 4). |
| L31 | `symbols.ts` spans | DEAD | BUILT | ← [TOOL] symbol tools | Regex-based by design of this unit. See L9 and G6 for depth. |

### `@sekhemet/board`

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| B1 | State machine with per-transition entry gates | SHALLOW | SHALLOW | `board/src/board_service.ts` `LEGAL_TRANSITIONS` ← `transitionCard` ← [RUN], [ACCEPT], [SRV] | The edge table is real, and an override is a reason prefixed `override:`. No entry conditions are checked (dependencies done, criteria present, tests failing, evidence complete). `onOverride` is never wired. |
| B2 | Planning column | MISSING | SHALLOW | Status and edges exist | No production path ever moves a card into `planning`. Failed cards stay in Verify. |
| B3 | ReviewWIP from review history | SHALLOW | DEAD | `board_service.ts` `computeReviewWip`, `calibrateReviewWip` | No caller. The median it would use is `updatedAt − createdAt`, not review time. The review limit stays at 3. |
| B4 | Back-pressure blocks entry to Verify | SHALLOW | BUILT | `transitionCard` (`toStatus === "verify"` against Review's count) ← [RUN] | Enforced, but the caller does not handle the throw (defect 1). |
| B5 | Dependency DAG (add, eligible, cycle) | MISSING | SHALLOW | `execute.ts` `inferDependencies` + queue `blockedBy` | Eligibility is enforced in the queue. No cycle detection in production (`planner/src/invest.ts` has one, reachable only through `plan`). |
| B6 | Serialize siblings with overlapping files | MISSING | SHALLOW | The queue is strictly sequential | Nothing detects overlap. It holds only because nothing runs in parallel. |
| B7 | Parent rollup with an integration gate | MISSING | MISSING | — | |
| B8 | Project-scoped board with lanes | SHALLOW | SHALLOW | `getBoardState` ← [SRV] `/api/board`; lanes in [WEB] `lanes.js` | Swimlanes exist in the UI. No project scoping. |
| B9 | `createCard` | MISSING | BUILT | `kernel/src/card_store.ts` `createCard` ← [PM] `apply.ts`, MCP, GitHub import, `plan` | Lives in the kernel, not the board engine. |
| B10 | WIP evaluation | SHALLOW | BUILT | `checkWipLimits` (`isAtCapacity`, the off-by-one fixed) ← [SRV] `/api/wip` | |
| B11 | `order_key` fractional index | MISSING | SHALLOW | `kernel/src/order_key.ts` `keyBetween`; lists sorted by `order_key` | Keys are assigned on create. `CardStore.reorderCard` has no caller: Seshat's `reorder` proposal kind is not applied (`apply.ts`), and the UI cannot drag to reorder. |
| B12 | Human commands | MISSING | SHALLOW | [SRV] `POST /api/cards/:id/accept|return|park`, `PATCH /api/cards/:id` (priority and fields), `sekhemet accept`; split and unpark through [PM] proposals | Missing: override gate, reroute, explain, pause project, set hours, rewind. A return reason becomes a candidate rule but is not handed to the next attempt as guidance. |
| B13 | Active project cap | MISSING | MISSING | — | |

### `@sekhemet/planner`

The planner package was rewritten. It is now heuristic and deterministic: spec clauses, then slices, then recursive split, INVEST, difficulty, routing, edit sketches and decision requests. Its only production caller is `sekhemet plan`, which constructs it with no model and no codebase map, and persists only `story.card` (defect 6). In practice Seshat's LLM proposals ([PM]) are how cards get planned. Planner tests: 3 cases in `planner.spec.ts`.

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| P1 | SPIDR decomposition, 5 heuristics, split until it fits | SHALLOW | SHALLOW | `planner/src/spidr.ts` `decomposeSpidr`, `proposeSlices`, `splitStory` ← [PLAN] | Spec-driven now, not a template, with all five kinds. It is keyword classification with no model and no codebase map on the production path, and it discards everything but title, scope and budget. |
| P2 | INVEST pre-flight | MISSING | SHALLOW | `planner/src/invest.ts` `validateInvest` (six checks) ← [PLAN] | Computed, then neither enforced nor shown. `plan` creates the cards whatever the report says. |
| P3 | WSJF prioritisation | MISSING | DEAD | `planner/src/prioritization.ts` `scoreWsjf`, `prioritize` | No caller. Priority is set by hand or by Seshat on Linear's 0–4 scale. |
| P4 | Estimation in tokens, seconds, steps | MISSING | SHALLOW | `scope.ts` `estimatePackTokens` ([PLAN], discarded); `pm/metrics.ts` `monteCarloForecast` ← [PM] | Actuals are not written back per class. |
| P5 | Difficulty scoring | MISSING | SHALLOW | `difficulty.ts` `scoreDifficulty` ← [PLAN] | Never persisted (K25). |
| P6 | Difficulty routing (under 4 / 4–7 / over 7) | MISSING | SHALLOW | `difficulty.ts` `routeByDifficulty` ← [PLAN] | Routing is discarded. The live route is `queue --escalate-retries`, which is capability-based. |
| P7 | Planner-to-executor edit-sketch cascade | MISSING | SHALLOW | `spidr.ts` `editSketchFor` (template text, discarded); `loop/src/manager.ts` `planRepair` (after a failure) ← `queue --manager` | No pre-execution sketch from a model reaches the executor. |
| P8 | Assume / Ask / Spike question policy | SHALLOW | SHALLOW | `planner/src/ambiguity.ts` `ClarEvalAmbiguityClassifier` (dispositions, more than 3 questions rejects) ← [PLAN] | Assumptions are not logged on cards, and questions are not surfaced to anyone. |
| P9 | Full `DecisionRequest` shape | SHALLOW | DEAD | `planner/src/decision.ts` `buildDecisionRequest` (id, options, recommendation, policy, default) | Built inside [PLAN], then discarded. It is never persisted, never shown and never answered. |
| P10 | `safe_default` vs `default_deny` at the deadline | MISSING | DEAD | `decision.ts` `resolveDecisionAtDeadline`, `isDestructiveText` | No caller. |
| P11 | Durable async HITL (pause and persist) | MISSING | MISSING | — | The queue's PM preemption (`holdRunnerLease`, `answerPm`) is chat, not decision parking. |
| P12 | Six planner sessions | MISSING | SHALLOW | [PM] chat; `pm/agent.ts` `ledgerStandup`; `learning/reflect.ts` `reflectWithManager` | Intake, standup and a retro of sorts. No review or replan sessions, and no plan diffs. |
| P13 | Status derived from gate results | MISSING | SHALLOW | `ledgerStandup` ← [PM] (a status question needs no model load) | By state, with a Monte Carlo range. No decisions-waiting section, because there are no decisions. |
| P14 | Escalation diagnostics (smallest unblocking human action) | MISSING | MISSING | — | |
| P15 | Trust calibration (15% override shift) | MISSING | DEAD | `planner/src/calibration.ts` `AssumptionCalibrationLog` | In-memory. `recordAssumptionOutcome` has no caller. |
| P16 | Process profiles | MISSING | SHALLOW | Cycles in [PM] (`/api/cycles`) | No Kanban, Scrum or Shape Up profile switch. |
| P17 | `Goal` record | MISSING | MISSING | — | |
| P18 | `/goal` intake with approval before running | MISSING | MISSING | — | |
| P19 | Goal loop and replan triggers | MISSING | MISSING | — | |
| P20 | Seven live signals with thresholds | MISSING | SHALLOW | `pm/metrics.ts` `flowMetrics` (throughput, cycle time, CFD, WIP age) ← [SRV] `/api/metrics/flow` → Insights | Displayed only. No thresholds, no scope drift, no failure Pareto, no RAID, no automatic actions. |
| P21 | Multiple goals, WSJF per goal | MISSING | MISSING | — | |
| P22 | Honest stopping of goals | MISSING | MISSING | — | |
| P23 | Board operations tool | MISSING | BUILT | `pm/agent.ts` `PM_TOOLS` (create, update, split, move, park, cycles) → `toProposals` → `pm/apply.ts` on human apply ← [PM] | Proposals only, as the PM contract requires. `reorder` is not applied (B11). |
| P24 | LSP-based impact analysis | MISSING | MISSING | — | `inferDependencies` is text matching. |
| P25 | Approach previews (2–3 options) | SHALLOW | DEAD | `decision.ts` `previewSketches` | Built inside [PLAN], discarded. Seshat offers single proposals, not option sets. |

### `@sekhemet/eval`

`@sekhemet/eval` has no production importer. The live benchmark measurement is the queue scorecard (`index.ts` `queue` → `writeQueueReport`), which `bake-off` and `run_gate.sh` drive.

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| E1 | Pass@1 harness under the real loop | SHALLOW | DEAD | `eval/src/benchmark.ts` `BenchmarkHarness` (isolated checkouts, fail-to-pass and pass-to-pass oracles) | Now genuine, but nothing calls it. The M0 protocol (30 tasks, 3 runs, budgets 50 and 150) is not wired. |
| E2 | Git task synthesis (fail-to-pass) | MISSING | DEAD | `eval/src/synthesis.ts` `TaskSynthesizer`, `scrubFilePaths` | No caller. |
| E3 | Full-settings result recording | MISSING | SHALLOW | `gates/src/evidence.ts` `RunSettings` (model, arm, temperature) ← [RUN] | No quant, context, engine or date. `eval/src/settings.ts` is dead. |
| E4 | `MODEL_MATRIX.md` | MISSING | MISSING | — | `docs/research/MODEL_CANDIDATES.md` is research, not a measured matrix. |
| E5 | Frozen regression suite gating self-improvement | MISSING | SHALLOW | `fixtures/` (Chronicle plus the Trifecta) | The suites exist, but nothing gates a learning change on them. |
| E6 | Qualification scoring | MISSING | MISSING | — | |
| E7 | Loop 1: playbook deltas | MISSING | BUILT | `learning/reflect.ts` `learnFromAttempt`, `learnFromSendBack`, `reflectWithManager`, `consolidateWithManager` ← [RUN], [SRV] return, `queue` | Signals are executable. Rollback is by retiring the rule. Bounded by human approval, not by "one rule per retro". |
| E8 | Loop 2: budgets and routing (at most 15%) | MISSING | SHALLOW | `apps/harness/src/tune.ts` `tune` ← `sekhemet tune` | Recommends a stopping policy from replayed runs. It never applies one, and there is no 15% bound or router matrix. |
| E9 | Loop 3: prompt evolution | MISSING | MISSING | — | |
| E10 | Loop 4: skill distillation | MISSING | MISSING | — | |
| E11 | Loop 5: exemplar store | MISSING | MISSING | — | |
| E12 | Loop 6: task synthesis | MISSING | DEAD | Same as E2 | |
| E13 | Loop 7: variant archives | MISSING | MISSING | — | |
| E14 | Loop 8: SIFT pre-filter | MISSING | MISSING | — | |
| E15 | Loop 9: tool synthesis | MISSING | MISSING | — | |
| E16 | Loop 10: DemoEvolve / mutants to tests | MISSING | MISSING | — | |
| E17 | Guardrails (measured, bounded, automatic rollback) | MISSING | SHALLOW | Candidate → approve flow; helpful/harmful counts | No automatic rollback when pass rate drops over a 10-card window. |
| E18 | Self-modification exclusions | MISSING | BUILT | `permissions.ts` `PROTECTED_SYSTEM_PATTERNS` (loop driver, gates runner, sandbox, permissions) ← [TOOL] | |
| E19 | Doctor skill and playbook diagnostics | SHALLOW | SHALLOW | `apps/harness/src/doctor.ts` `runDoctor` | Probes are real now (see H9). None of net gain, context bloat or pruning recommendations. |

### `@sekhemet/ui` (the dashboard)

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| U1 | Loopback web app on 127.0.0.1:4040 | SHALLOW | BUILT | [SRV] `DEFAULT_DASHBOARD_PORT = 4040`, `listen(port, "127.0.0.1")` | |
| U2 | Tokens as CSS variables and JSON | MISSING | BUILT | `ui/src/tokens.ts` `generateTokenCss` → [SRV] `/tokens.css`, `/tokens.json` | No raw hex in `web/`. |
| U3 | Basalt and Sand palettes | SHALLOW | BUILT | `tokens.ts` `BASALT`, `SAND`; toggle in [WEB] `shell.js` | Exact values, light theme, `t` key. |
| U4 | Typography tokens, tabular numerals | MISSING | BUILT | `tokens.ts` `TYPOGRAPHY`; `.tnum` / `tabular-nums` in the CSS | |
| U5 | Spacing, radius, elevation, motion | SHALLOW | BUILT | `tokens.ts` `SPACING`, `RADIUS`, `MOTION` | No drop shadows. |
| U6 | Dual-axis virtualization | DEAD | SHALLOW | [WEB] `board.js` `paintVirtual` (above 60 cards, overscan 3) | Vertical only, and only in the board's column view. No horizontal virtualization. Lanes and list render every card. `ui/src/canvas.ts` `VirtualCanvasManager` is still dead. 60 FPS on 500 cards is unmeasured. |
| U7 | Six views | SHALLOW | SHALLOW | [WEB] `app.js` routes: review, board, card (5 tabs), runs, ledger, machine, playbook, Seshat, insights, integrations | No master multi-project board, no Registry view. |
| U8 | Review view | MISSING | SHALLOW | [WEB] `review.js`, `gates.js`, `diff.js`, `triage.js` | Gate strip and a/r/p triage work. Diffs are grouped by file role, not intent, not structural, and there are no screenshot diffs. |
| U9 | Live stream (WebSocket, replay from genesis) | MISSING | SHALLOW | [SRV] `/api/stream` (SSE) ← [WEB] `app.js` `EventSource` | SSE rather than WebSocket. On reconnect the page re-fetches state; nothing replays the log from genesis or a checkpoint. |
| U10 | Keyboard system | MISSING | BUILT | [WEB] `keys.js` `initKeys` plus per-view `onKey` | Cmd+K, ?, Esc, h/j/k/l, `g` chords, Space, Enter, x and a/r/p are all there. `c` only shows a toast, and there is no `g i`. |
| U11 | Command palette | MISSING | BUILT | [WEB] `palette.js` `fuzzy`, `openPalette` | Cards, navigation, actions, preferences. Single project, so no project search. |
| U12 | Decision inbox by wait time | MISSING | SHALLOW | [WEB] `review.js` "Need you" queue sorted by `waitOf` | Sorted by wait time, but its items are review cards: decision requests do not exist (P9). |
| U13 | Card tile | SHALLOW | SHALLOW | [WEB] `tile.js` `tileHtml` | Kind chip, dependency badge, gate pips and step bar. No difficulty and no token or seconds bars. |
| U14 | Column header WIP `N / limit` | SHALLOW | BUILT | [WEB] `board.js` `limitInfo` | |
| U15 | Decision Request component | MISSING | MISSING | — | |
| U16 | Diff viewer | MISSING | SHALLOW | [WEB] `diff.js` `unifiedHtml`, `splitHtml`; `diff_parse.js` `annotationsByLine` | Split, unified and inline gate annotations. Not structural. |
| U17 | Pan-and-zoom DAG canvas | MISSING | MISSING | — | |
| U18 | Telemetry sparklines | MISSING | MISSING | — | Machine view has a memory gauge only. |
| U19 | Single-weight line icons | SHALLOW | BUILT | `ui/src/icons.ts` `ICONS` (1.5 px stroke) | |
| U20 | Mobile: read-only board, one-tap triage | MISSING | SHALLOW | Breakpoints at 1279 and 767 px; 48 px triage buttons on Review | One-tap triage on the Review screen only. |
| U21 | `IBoardUIState` container | MISSING | SHALLOW | [WEB] `store.js` | No project, pending decisions or telemetry slice. |

### `apps/harness`

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| H1 | `sekhemet daemon` (HTTP and WS) | SHALLOW | SHALLOW | `serve` / `ui` → [SRV] | Right port, SSE instead of WS. Foreground only: no PID file, no detach. |
| H2 | `sekhemet board` opens the web UI | SHALLOW | SHALLOW | `printTerminalBoard` | Still an ASCII board. |
| H3 | `sekhemet calibrate` | MISSING | MISSING | — | |
| H4 | `sekhemet run <card>` | SHALLOW | BUILT | `index.ts` `run` → `executeCard` → [RUN] | Loop, gates, checkpoint, evidence, transitions. The worktree is kept for review. It always uses the Nail worker. |
| H5 | `sekhemet plan "<spec>"` | SHALLOW | SHALLOW | [PLAN] | Spec-driven slices, but the contract is dropped (defect 6), and the epic is created as `in_progress`. |
| H6 | `sekhemet gate <card>` | SHALLOW | SHALLOW | `index.ts` `gate` → `runGates` | Runs the declared gates in `--repo`, still ignoring `<card>` and its worktree. |
| H7 | `sekhemet bake-off` | SHALLOW | SHALLOW | `index.ts` `bake-off` → `run_gate.sh` → `queue` | Real runs now (see M23). |
| H8 | `sekhemet replay <card> [--as]` | SHALLOW | SHALLOW | `getCheckpoints` | Reads a table nothing writes (defect 2). No re-run and no trajectory diff. `sekhemet tune` replays recorded steps for policy tuning, which is a different thing. |
| H9 | `sekhemet doctor` (DoD rung 6) | SHALLOW | BUILT | `doctor.ts` `runDoctor` (memory by kernel pressure, inference socket probe, `git worktree list`, a real sandbox escape probe, node/git/pnpm, skills) ← CLI, [SRV] `/api/doctor`, MCP | Gate runners are checked only as binaries on PATH. The escape-probe message says "seatbelt" even under bubblewrap. |
| H10 | `sekhemet mcp` server | SHALLOW | SHALLOW | `apps/harness/src/mcp.ts` (4 tools) | Unchanged. The `"spike"` tier still violates the CHECK (defect 7). No gates, evidence, registry or card actions. |
| H11 | MCP client | MISSING | MISSING | — | |
| H12 | REST API (18 endpoints) | SHALLOW | SHALLOW | [SRV] plus `pm_api.ts` and `integrations.ts`: board, events (`since`, `card`, `type`), card GET and PATCH, accept, return, park, evidence, gates, machine, runs, doctor, PM, cycles, learning, models, metrics, integrations, import and export | About 30 routes, but the spec's run, gate, split, rewind, decisions, calibrate and `POST /projects/:id/cards` are missing. The dashboard cannot start work. |
| H13 | TypeScript SDK | MISSING | MISSING | — | |
| H14 | ACP editor surface | MISSING | MISSING | — | |
| H15 | `config.toml` resolution chain | MISSING | SHALLOW | `apps/harness/src/config.ts` `resolveConfig` (defaults, user, project) ← [SRV] (reads `review_minutes_per_day` for display only) | Parsed and layered, but the loop, board, models and network ignore it. There is no card-override or CLI layer. |
| H16 | Slash commands | MISSING | MISSING | — | |
| H17 | Session resume from the log | MISSING | SHALLOW | `execute.ts` `useExistingWorktree`; `git_adapter.ts` `createWorktree` re-attach | A retry resumes the worktree. The log is not replayed, and there is no restore to the last checkpoint or re-entry at the last step. |
| H18 | Fork an attempt at step N | MISSING | MISSING | — | |
| H19 | Rewind to step N | MISSING | MISSING | — | |
| H20 | Notifications (ntfy / Gotify) | MISSING | SHALLOW | `integrations.ts` `notifySlack` ← `queue` run report, [PM] notify | A Slack webhook instead of self-hosted push. Nothing fires on review, park, budget or decision. |
| H21 | Idle / overnight scheduler | MISSING | MISSING | — | |
| H22 | OpenTelemetry spans | MISSING | MISSING | — | |
| H23 | Compute governance (kWh, breakers) | MISSING | MISSING | — | |
| H24 | Per-card reproducibility record | MISSING | SHALLOW | Evidence `settings` plus `gatesConfigSha256` | No quant, template checksum, prompt or playbook version, or tool-schema version. |
| H25 | Offline installers and first-run wizard | MISSING | MISSING | — | |
| H26 | Memory daemon polling every 2 s | MISSING | SHALLOW | Per-turn `checkExecutionHeadroom`; SSE machine frames every 5 s | No 2 s poller that acts. |
| H27 | Restricted-mode wiring | MISSING | SHALLOW | See S12 | |

### Cross-cutting

| # | Unit | Old | New | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| X1 | `/onboard` (7 steps) | MISSING | SHALLOW | `apps/harness/src/learning/explore.ts` `exploreProject`, `exploreCurriculum` ← `sekhemet explore`, `queue --explore` | Only a slice of step 5: tsconfig constraints and node module APIs become rules. No map cache, LSP init, command detection, gate proposal, AGENTS.md generation or qualification. |
| X2 | Convention drift detection | MISSING | MISSING | — | |
| X3 | Multimodal card input | MISSING | MISSING | — | |
| X4 | Four-tier research knowledge | MISSING | SHALLOW | `research/researcher.ts` (registry and licences, READMEs, type declarations, git) + `research/web.ts` (papers, pages, GitHub, search) | Tiers 1 and 4 only. No doc mirrors or `llms.txt`, and no research cache. |
| X5 | SearXNG metasearch | MISSING | SHALLOW | `web.ts` `webSearch` (SearXNG, Brave or Tavily by env) | Optional. Queries are not recorded in the event log, and results are not ranked toward primary sources. |
| X6 | Fetch and extraction pipeline | MISSING | SHALLOW | `web.ts` `fetchPage`, `htmlToText` | Not fetched through the sandbox proxy, and no allowlist. A naive HTML-to-text pass, no trafilatura, Docling or Playwright, no chunking or dedupe. |
| X7 | Research card to cited note | MISSING | SHALLOW | `research()` returns `{answer, sources, grounded}` → candidate rule (queue) or [PM] citation | Not a card type. No embeddings or reranker. |
| X8 | Research safety | MISSING | MISSING | — | No untrusted wrapper, robots.txt or per-domain limits. |
| X9 | Doc cache TTLs | MISSING | MISSING | — | |
| X10 | Air-gap package mirrors | MISSING | MISSING | — | |
| X11 | Air-gap model manifest | MISSING | MISSING | — | |
| X12 | Air-gap doc bundles | MISSING | MISSING | — | |
| X13 | Signed update bundles | MISSING | MISSING | — | |
| X14 | Air-gap self-test | MISSING | MISSING | — | |
| X15 | External review cards | MISSING | MISSING | — | |
| X16 | Scheduled and recurring cards | MISSING | MISSING | — | |
| X17 | `PROVENANCE.md` | MISSING | MISSING | — | |
| X18 | `RESEARCH_REGISTER.md` | MISSING | MISSING | — | `docs/research/IMPLEMENTATION_AUDIT.md` covers adoption, but not the register's lifecycle or thresholds. |
| X19 | `MODEL_MATRIX.md` | MISSING | MISSING | — | Same as E4. |
| X20 | Licence register enforcement | MISSING | MISSING | — | |
| X21 | `fixtures/` synthetic repos, fast `createTestWorktree` | MISSING | SHALLOW | `fixtures/{chronicle,onyx,basalt-canvas,vanguard}`, `scripts/seed_*.mjs`, `run_gate.sh` | Benchmark fixtures, TypeScript only. No generator, and no Python or Rust fixtures. |
| X22 | In-memory SQLite tests vs DoD §2.A | SHALLOW | SHALLOW | kernel (`card_store`, `log`, `team_fields`) and board specs use `:memory:` | Still violates DoD §2.A.1. The harness e2e test (`e2e_lifecycle.spec.ts`) uses a real on-disk DB and real git. |
| X23 | `test:unit` / `test:integration` split | MISSING | MISSING | — | |
| X24 | `pnpm dev` | MISSING | MISSING | — | |
| X25 | Whole suite under 3 s | UNDETERMINED | UNDETERMINED | — | Not run (read-only audit). With real subprocess, git and sandbox tests it is very unlikely to be under 3 s. |
| X26 | Commit-trailer enforcement as a gate | MISSING | SHALLOW | `.githooks/commit-msg` (`core.hooksPath` set in this checkout) | A local hook for human and agent commits. It is not a harness gate, and the harness's own squash commits carry no `Co-authored-by`. |
| X27 | Chronicle fixture and runner | MISSING | BUILT | `fixtures/chronicle`, `scripts/seed_chronicle.mjs`, `run_gate.sh` → `queue --auto-accept` scorecard | The runner is built. The scorecard target is **not met**: the best recorded run is 4/6 Pass@1 in about 43 min, against at least 5/6 in under 18 min (DEV_LOG). |
| X28 | Showcase Trifecta fixtures | MISSING | BUILT | `fixtures/{onyx,basalt-canvas,vanguard}/cards.json` with acceptance suites, `seed_project.mjs` | Built, never run end to end. The 98% cache-hit and 39-minute targets are unmeasurable today (M18). |
| X29 | `llama-server` launch profile | MISSING | SHALLOW | `llama_server.ts` `launchArgs` (Cyber-Tiel, port 8098, q8_0 KV, MTP, slot cache) | Not the CHRONICLE §2 profile: no `--ctx-checkpoints`, `--cache-ram`, `--metrics` or `-np 2` on 8099. The Qwen adapter is dead (M5). |

## Remaining gaps, ranked

This section lists every unit still MISSING, SHALLOW or DEAD (242 of 302), in three impact tiers. It also lists two BUILT units with a defect or caveat worth fixing (B4, Y2).

- **(a)** Completing the benchmark projects: Chronicle at 5/6 or better in under 18 min, then the Trifecta's 24 cards at about 39 min with 98% cache hits.
- **(b)** Parity with top coding harnesses (Claude Code, Codex CLI, Aider, OpenHands, Cline).
- **(c)** Everything else in the design.

Within a tier, the order is by impact. Size: **S** is under a day and at most about 200 LOC; **M** is a few days; **L** is a week or more, or a new subsystem.

### (a) Benchmark completion

| Rank | Unit | Status | "Built to depth" requires | Size |
| --- | --- | --- | --- | --- |
| 1 | M18 | MISSING | Read llama-server `timings` (`cache_n` / `prompt_n`) per request, record the hit rate per step, and alert under 85% on tool-result steps. The Trifecta's 98% target cannot be checked without it. | S |
| 2 | C4 | SHALLOW | Keep Zone 2 byte-stable for a whole card: move gate-triggered rules and the rung directive into Zone 4, and assert that `prefixHash` does not change mid-card. | S |
| 3 | M17 | SHALLOW | Launch llama-server with `--cache-ram`, `--ctx-checkpoints` and `-sps` from a machine profile, and send `cache_prompt` on every path. | S |
| 4 | X29 | SHALLOW | A selectable launch profile matching CHRONICLE §2 (8099, `-np 2`, `-c 49152`, `--ctx-checkpoints 6`, `--cache-ram 2048`, `--metrics`) alongside Cyber-Tiel. | S |
| 5 | M5 | DEAD | Wire the Qwen3.8-27B code and planning sampling profiles into the router as selectable workers; add the planning profile. | S |
| 6 | C8 | DEAD | Route `run_cmd` and `check` output through `condenseCommandOutput` so error lines are never elided; keep the raw output in evidence. | S |
| 7 | G10 | DEAD | Call `checkBounds` on the measured diff in `runVerification`, as a blocking hygiene failure with the `gates.toml` limits. | S |
| 8 | L22 | SHALLOW | Enforce per-card token and wall-clock budgets (the 18-minute Chronicle cap), stopping with a recorded reason. | S |
| 9 | L15 | SHALLOW | Rung 3 hands the card to the manager or planner for re-decomposition automatically, not only under `--manager`. Rung 4 parks the card with a diagnostic instead of leaving it in Verify. | M |
| 10 | L14 | SHALLOW | Add `scope_violation`, `capability_ceiling`, `human_abort` and `done_pending_gates`, and persist the stop reason on the card (fixes defect 8). | S |
| 11 | B4 (defect 1) | BUILT, defect | Catch the back-pressure error at the Verify transition and hold the card instead of aborting the queue. | S |
| 12 | M6 | SHALLOW | Raise reasoning per request on repair rungs and for planning, keep it off for mechanical steps, and strip traces between steps. | S |
| 13 | M8 | SHALLOW | Grammar or JSON-schema constrained tool calls on llama-server (Arm A), falling back to the tolerant parser; measure the arm per model. | M |
| 14 | Y3 | SHALLOW | Checkpoint on every passing `check` and at masking boundaries, not only at the final pass, so a halted card resumes mid-way. | S |
| 15 | K28 | DEAD | Call `recordCheckpoint` from the runner so `replay` and the relay protocol see checkpoints. | S |
| 16 | H17 | SHALLOW | Resume a `memory_pressure`-halted card from its last checkpoint and step, not from a fresh attempt. | M |
| 17 | G12 | SHALLOW | Run the staged acceptance tests at card start and refuse to begin unless they fail for the stated reason. | S |
| 18 | C6 | SHALLOW | Use `FileEvidenceStore` so masked observations survive restarts and land in the evidence bundle. | S |
| 19 | C7 | SHALLOW | Wire `applyContextPressure` (70/80/85/90% tiers, `budget_exhausted` at 95%) into `buildPrompt`, replacing the ad-hoc levels. | S |
| 20 | M20 | SHALLOW | Poll pressure every 2 s during a run and apply the graduated actions (suspend MTP, trim caches, pause). | M |
| 21 | M3 | MISSING | `measureThroughput` (prefill and decode tok/s) per model, logged per run, so the time budget can be predicted. | S |
| 22 | L6 | SHALLOW | ripgrep-backed, gitignore-aware grep with files, content and count modes and context lines. It cuts turns spent on navigation. | S |
| 23 | L8 | SHALLOW | A `run` description field, denial of raw `cat`/`grep`/`sed` when a structured tool exists, and condensed output (see C8). | S |
| 24 | L17 | MISSING | Refuse `edit` on a file not read or pinned this card. | S |
| 25 | L9 | SHALLOW | LSP-backed (or at least TS-compiler-API) symbol tools with real references. | M |
| 26 | C1 | SHALLOW | TS-compiler or tree-sitter repo map with reference edges, personalised PageRank seeded on scope, and a binary-searched token budget. | M |
| 27 | L21 | SHALLOW | Step budgets from measured pass rates per class (`pm/capability.ts`) rather than the schema default of 50. | S |
| 28 | K21 | SHALLOW | Persist competence entries per attempt and feed budgets and routes from them. | M |
| 29 | E3 | SHALLOW | Record quant, context, engine, date and harness commit with every result. | S |
| 30 | M23 | SHALLOW | Bake-off records full settings and runs every fixture (Chronicle plus the Trifecta) per candidate. | S |
| 31 | E1 | DEAD | Wire `BenchmarkHarness` for the M0 protocol (30 tasks × 3 runs × budgets 50 and 150), or delete it in favour of the queue scorecard. | M |
| 32 | C9 | SHALLOW | Manifest-line disclosure by default, with the body loaded only on a match, which cuts Zone 2 prefill. | S |
| 33 | L10 | SHALLOW | `docs` reads installed dependency types and READMEs at the exact installed version. | M |
| 34 | G6 | SHALLOW | Parse gate for non-TS files (tree-sitter). Not needed for the TS fixtures. | M |
| 35 | P6 | SHALLOW | Persist difficulty routing and use it to choose worker or escalation up front. | S |
| 36 | M16 | SHALLOW | Refuse 4-bit KV for tool-calling models in every launch path. | S |
| 37 | M19 | SHALLOW | Decide MTP or speculative decoding per machine by measurement (CHRONICLE says MTP is 21% slower on the M4). | S |

### (b) Parity with top coding harnesses

| Rank | Unit | Status | "Built to depth" requires | Size |
| --- | --- | --- | --- | --- |
| 1 | H12 | SHALLOW | Run, gate, create, split, rewind and decision endpoints, so the dashboard can start and steer work. | M |
| 2 | M2 | MISSING | Token streaming end to end (adapter to SSE to the Steps tab). | M |
| 3 | K12 | DEAD | Emit the 10 lifecycle hooks from the runner, session and gates, and load user hooks from `.sekhemet/hooks/`. | M |
| 4 | S8 | SHALLOW | Wire an ask-tier approver (CLI prompt and dashboard), pass the `gates.toml` protected globs, add a domain allowlist and the external-binary tier. | S |
| 5 | S12 / H27 | SHALLOW | Restricted mode removes `run`, confines the tool sandbox and makes the session read-only (fixes defect 3). | S |
| 6 | S4 | SHALLOW | Fail closed for the tool sandbox wherever confinement is missing, not only for gates. | S |
| 7 | P1 | SHALLOW | `plan` persists spec, acceptance tests, dependencies, difficulty and sketch; optionally model-refined with a codebase map (fixes defect 6). | M |
| 8 | P2 | SHALLOW | Enforce the INVEST report (split or refuse) and show it. | S |
| 9 | H11 | MISSING | MCP client for servers declared in config, with tools budgeted into the catalog. | M |
| 10 | H10 | SHALLOW | MCP server exposing gates, evidence, board transitions and run, with the `spike` tier fixed (defect 7). | S |
| 11 | H19 | MISSING | Rewind to step N: reset to that checkpoint, log a rewind event, invalidate later gate passes. | M |
| 12 | H18 | MISSING | Fork an attempt at step N with a different model, prompt or budget. | M |
| 13 | L18 | MISSING | Tool subsets per card class (reviewer, implementer, researcher). | S |
| 14 | C19 | MISSING | `tool_search`: names in the prompt, schemas loaded on demand. | M |
| 15 | C22 | MISSING | Fold AGENTS.md / CLAUDE.md conventions into Zone 2. | S |
| 16 | L7 | SHALLOW | gitignore-aware, mtime-sorted glob. | S |
| 17 | S9 / X8 | MISSING | Wrap fetched web content in `<untrusted_content>`, tighten permissions for steps that saw it, respect robots.txt and rate limits. | S |
| 18 | S5 | SHALLOW | Allowlisting egress proxy with a request log (hash per payload). | M |
| 19 | L25 | DEAD | A human abort from CLI and dashboard that records `human_abort`. | S |
| 20 | L11 | SHALLOW | `note` writes to the card thread on the ledger. | S |
| 21 | H15 | SHALLOW | Config actually drives step budget, stall window, rungs, network mode and WIP, with card and CLI layers. | S |
| 22 | H16 | MISSING | Slash commands as templates (`/plan`, `/split`, `/retro`, `/goal`). | S |
| 23 | Y16 | SHALLOW | Draft PR, then checks, ready, review-thread repair and auto-merge. | M |
| 24 | Y6 | MISSING | Rebase onto the integration branch before Verify, with conflicts as typed failures. | M |
| 25 | Y7 | MISSING | Stacked branches for dependent cards, restacked on accept. | M |
| 26 | G14 | MISSING | gitleaks secret scan in the write path and as a gate. | S |
| 27 | G7 | SHALLOW | Atomic writes (temp file and rename) and a secret scan before disk. | S |
| 28 | G25 | MISSING | Pass@k with gate selection on large tiers, in isolated worktrees. | L |
| 29 | L12 | MISSING | Code mode: a sandboxed script runner over the tool API. | L |
| 30 | L20 | MISSING | Sandboxed `browse` tool. | L |
| 31 | C2 | MISSING | Headless LSP client pool. | L |
| 32 | M11 | SHALLOW | A model registry with template checksum, measured arm, context and qualification. | M |
| 33 | M12 | MISSING | Template checksum pinning that invalidates qualification. | S |
| 34 | M22 / E6 | MISSING | A qualification suite with deterministic scoring. | M |
| 35 | M4 | SHALLOW | Adapter `healthCheck` contract. | S |
| 36 | H13 | MISSING | TypeScript SDK over the event log. | M |
| 37 | H14 | MISSING | ACP editor surface. | L |
| 38 | U9 / H1 | SHALLOW | WebSocket (or SSE with `Last-Event-ID`) replay from a checkpoint; a daemon mode. | M |
| 39 | U7 | SHALLOW | Registry view and master board. | M |
| 40 | U8 / U16 / Y8 | SHALLOW / MISSING | Structural (difftastic) intent-grouped diff in Review. | M |
| 41 | U6 | SHALLOW | Horizontal virtualization and a virtualized list and lanes; measure at 500 cards. | M |
| 42 | U12 / U15 / P9 / P10 / P11 / K20 | SHALLOW / DEAD / MISSING | A decision-request pipeline: persist the planner's requests, answer them in the dashboard, park or default at the deadline. | M |
| 43 | B1 | SHALLOW | Entry conditions per transition, and an override logged as a human decision. | M |
| 44 | B12 | SHALLOW | Override (never on security), reroute, explain, pause, and hand the return reason to the next attempt. | M |
| 45 | K11 | SHALLOW | Log every model request (prompt hash plus a blob) to the ledger, and assert it. | S |
| 46 | K22 | SHALLOW | Write the actuals, stop reason and evidence id on the card (defect 8). | S |
| 47 | H20 | SHALLOW | Push notifications on review, park, budget and decision. | S |
| 48 | H6 | SHALLOW | `gate <card>` runs in that card's worktree. | S |
| 49 | H8 | SHALLOW | Replay a card under a pinned config and diff trajectory and evidence. | M |
| 50 | X1 | SHALLOW | Full `/onboard`: detect commands, propose `gates.toml`, draft playbook and AGENTS.md, qualify. | L |
| 51 | G27 | MISSING | Gate templates for Python and Rust. | M |
| 52 | P7 | SHALLOW | A planner-model edit sketch before execution for difficulty 4–7. | M |
| 53 | P8 | SHALLOW | Surface questions as batched decisions and log assumptions on cards. | S |
| 54 | P5 / K25 | SHALLOW | Persist difficulty. | S |
| 55 | S3 | SHALLOW | Landlock and seccomp on Linux. | M |
| 56 | S14 | SHALLOW | APFS clonefile / reflink worktrees. | S |
| 57 | S7 | SHALLOW | Real OOM detection (cgroup or memory status). | S |
| 58 | C14 | SHALLOW | Persist the context pack (id, per-zone counts, prefix hash) with the attempt. | S |
| 59 | C15 | SHALLOW | Runtime determinism assertion for prompt assembly. | S |
| 60 | C20 | SHALLOW | Per-step zone and cache metrics, stored and shown. | S |
| 61 | H24 | SHALLOW | Full reproducibility record per card. | S |
| 62 | K4 | SHALLOW | Populate `attempt_id` and `step_id` (requires K16 and K17). | S |
| 63 | K16 / K17 / K18 / K19 | MISSING | `attempts`, `steps`, `gate_results` and `evidence_bundles` tables as projections of the ledger. | M |
| 64 | U13 | SHALLOW | Difficulty and token/seconds bars on tiles. | S |
| 65 | U20 | SHALLOW | Read-only mobile board with one-tap triage everywhere. | S |
| 66 | U21 | SHALLOW | Complete client state (decisions, telemetry). | S |

### (c) Everything else

| Unit | Status | "Built to depth" requires | Size |
| --- | --- | --- | --- |
| K5 | SHALLOW | CHECK on actor (or a documented extended enum). | S |
| K6 | DEAD | Drive SSE from `EventLog.subscribe` instead of polling. | S |
| K8 | DEAD | Derive the board from the log (projection engine) and verify byte-identical rebuilds. | M |
| K9 | MISSING | Service container keyed as in §2395. | M |
| K10 | MISSING | Plugin manager with reversible mount and unmount. | L |
| K13 | MISSING | Four-level hierarchy cap enforced at creation. | S |
| K14 | MISSING | `projects` table and project scoping. | M |
| K15 | SHALLOW | Dependency table with a cycle check on every write. | S |
| K26 | SHALLOW | Context packs and blobs stored under `.sekhemet/` by hash and referenced from events. | M |
| K27 | MISSING | 30-day retention and pruning. | S |
| S10 | MISSING | Supply-chain gate (registry existence, age, Levenshtein typosquat). | M |
| S11 | MISSING | `osv-scanner` offline scan. | S |
| Y1 | SHALLOW | Branch from the parent card's branch when one exists. | S |
| Y2 (caveat) | BUILT | Pass `Co-authored-by` on harness commits. | S |
| Y4 | SHALLOW | Intent-grouped Conventional Commits on squash. | M |
| Y10 | SHALLOW | Generic `SyncAdapter` (pull, push, capabilities, last-writer-wins history). | M |
| Y11 | MISSING | Forgejo adapter. | M |
| Y12 | MISSING | GitHub App auth (RS256 JWT, keychain, GHES). | M |
| Y13 | MISSING | Webhook intake with HMAC and the 5 triggers. | M |
| Y14 | MISSING | Check Runs with annotations. | M |
| Y15 | MISSING | SARIF upload (gzip then base64). | S |
| Y17 | MISSING | Release cards (`git-cliff`, semver, GitHub Release). | M |
| Y18 | MISSING | CI as a gate source via `act`. | M |
| Y19 | MISSING | Monorepo and multi-repo scope with gates per package. | M |
| Y20 | MISSING | Mid-card external-edit reconciliation. | M |
| M9 | DEAD | Select Arm C per model by measurement. | S |
| M10 | SHALLOW | Mock adapter with pattern matching and an exhaustion mode. | S |
| M13 | MISSING | `sekhemet calibrate` hardware procedure. | M |
| M14 | MISSING | S/M/L/XL tier profiles. | S |
| M15 | MISSING | Throughput floors, with refusal below the overnight floor. | S |
| M24 | MISSING | Engine selection by measurement. | M |
| M25 | MISSING | Declared-hours scheduling with batched swaps. | M |
| G3 | SHALLOW | Implementations for the robustness, security, visual and hygiene layers, with runs-on hosts. | L |
| G13 | MISSING | Diff-scoped mutation testing, advisory first (currently rejected by design). | M |
| G15 | MISSING | Dependency existence and typosquat gate. | M |
| G16 | MISSING | Semgrep gate. | S |
| G17 | MISSING | Visual gate: console and network errors (Playwright). | M |
| G18 | MISSING | Visual gate: layout-bounds predicates. | M |
| G19 | MISSING | Visual gate: element screenshot diff at 0.01. | M |
| G20 | MISSING | axe-core at 1280 and 375 px. | S |
| G21 | MISSING | Vision checklist that can only fail. | M |
| G22 | MISSING | Hygiene gate (changelog, debug output, trailers). | S |
| G23 | MISSING | Regression protection on re-entering Review. | S |
| G24 | MISSING | Gate host separation (mTLS daemon). | L |
| G26 | MISSING | Cross-validation of attempts. | M |
| C3 | MISSING | SWE-Pruner line pruning. | L |
| C10 | MISSING | Skill trust: pin, audit, diff, reject. | M |
| C12 | DEAD | Context-debt audit with the pass-rate half. | S |
| C13 / E11 | MISSING | Exemplar store (top-2 per class). | M |
| C16 | MISSING | Subtask branching. | L |
| C21 | MISSING | Joint prompt, playbook and tool versioning. | S |
| L16 | SHALLOW | A distinct `validateWrite` contract. | S |
| L19 | SHALLOW | Research cards as a card type. | M |
| L23 | MISSING | Background processes per card with port allocation. | M |
| L24 | MISSING | Interactive terminals. | M |
| B2 | SHALLOW | Route cards through Planning (pull, and after a Verify regression). | S |
| B3 | DEAD | ReviewWIP from measured review minutes; wire `calibrateReviewWip`. | S |
| B5 | SHALLOW | DAG with cycle detection in production. | S |
| B6 | SHALLOW | Overlap detection when parallel execution arrives. | S |
| B7 | MISSING | Parent rollup with an integration gate. | M |
| B8 | SHALLOW | Project-scoped board. | S |
| B11 | SHALLOW | Apply `reorder` proposals and drag-reorder in the UI. | S |
| B13 | MISSING | Active project cap. | S |
| P3 | DEAD | Use WSJF (or RICE) from `config.toml` to order Ready. | S |
| P4 | SHALLOW | Token and second estimates per class with write-back. | M |
| P12 | SHALLOW | Review and replan sessions with plan diffs. | M |
| P13 | SHALLOW | Standup with decisions waiting and estimate bases. | S |
| P14 | MISSING | Escalation diagnostics. | S |
| P15 | DEAD | Feed override outcomes and persist the calibration. | S |
| P16 | SHALLOW | Process profiles. | S |
| P17 | MISSING | Goal record. | M |
| P18 | MISSING | `/goal` intake with approval before running. | M |
| P19 | MISSING | Goal loop and replan triggers. | M |
| P20 | SHALLOW | Signal thresholds with automatic actions. | M |
| P21 | MISSING | Multiple goals, WSJF per goal. | M |
| P22 | MISSING | Honest goal stopping. | S |
| P24 | MISSING | LSP impact analysis. | M |
| P25 | DEAD | Show 2–3 option previews. | S |
| E2 / E12 | DEAD | Wire `TaskSynthesizer` for per-repo tasks. | M |
| E4 / X19 | MISSING | `MODEL_MATRIX.md` from recorded bake-offs. | S |
| E5 | SHALLOW | Gate learning changes on the frozen fixtures. | M |
| E8 | SHALLOW | Apply tuned budgets within ±15%, with rollback. | S |
| E9 | MISSING | Loop 3: prompt evolution. | L |
| E10 | MISSING | Loop 4: skill distillation. | L |
| E13 | MISSING | Loop 7: variant archives. | L |
| E14 | MISSING | Loop 8: SIFT pre-filter. | M |
| E15 | MISSING | Loop 9: tool synthesis. | L |
| E16 | MISSING | Loop 10: DemoEvolve. | L |
| E17 | SHALLOW | Automatic rollback over a 10-card window. | S |
| E19 | SHALLOW | Doctor skill and playbook net-gain and bloat diagnostics. | M |
| U17 | MISSING | Pan-and-zoom dependency DAG. | M |
| U18 | MISSING | Canvas telemetry sparklines (memory, tok/s, cache hit). | S |
| H2 | SHALLOW | `board` opens the browser. | S |
| H3 | MISSING | `sekhemet calibrate`. | M |
| H5 | SHALLOW | See P1. | S |
| H7 | SHALLOW | See M23. | S |
| H21 | MISSING | Idle and overnight scheduler with a morning summary. | M |
| H22 | MISSING | OpenTelemetry spans stored in SQLite. | M |
| H23 | MISSING | kWh governance and circuit breakers. | M |
| H25 | MISSING | Offline installers and first-run wizard. | L |
| H26 | SHALLOW | 2 s memory daemon (see M20). | S |
| X2 | MISSING | Nightly convention drift report. | M |
| X3 | MISSING | Multimodal card input through a vision model. | L |
| X4 | SHALLOW | Doc mirrors, `llms.txt` and a research cache. | M |
| X5 | SHALLOW | SearXNG as the default provider, with queries logged. | S |
| X6 | SHALLOW | Proxy-mediated fetch with a real extractor. | M |
| X7 | SHALLOW | Cited research notes as card output. | M |
| X9 | MISSING | Doc cache TTLs. | S |
| X10 | MISSING | Air-gap package mirrors. | L |
| X11 | MISSING | Air-gap model manifest. | M |
| X12 | MISSING | Air-gap doc bundles. | M |
| X13 | MISSING | Signed update bundles. | M |
| X14 | MISSING | Air-gap self-test. | M |
| X15 | MISSING | External review cards. | M |
| X16 | MISSING | Scheduled and recurring cards. | M |
| X17 | MISSING | `PROVENANCE.md`. | S |
| X18 | MISSING | `RESEARCH_REGISTER.md`. | S |
| X20 | MISSING | Enforced licence register. | S |
| X21 | SHALLOW | Fixture generator for TypeScript, Python and Rust. | M |
| X22 | SHALLOW | Kernel and board tests on real on-disk SQLite, per DoD §2.A.1. | S |
| X23 | MISSING | `test:unit` / `test:integration` split. | S |
| X24 | MISSING | `pnpm dev`. | S |
| X26 | SHALLOW | A trailer validator as a harness hygiene gate. | S |

## Units that could not be fully determined

- **X25 (suite under 3 s):** needs the test suite run, which was out of scope.
- **X27 and X28 outcomes:** the fixtures and runners exist and are marked BUILT, but whether the harness now meets the Chronicle scorecard or completes the Trifecta can only be settled by the planned evaluation run. The latest recorded Chronicle result (DEV_LOG) is 4/6.
- **U6 (performance):** the 60 FPS / under 50 MB target at 500 cards needs a browser measurement.
- **Defect 1 (queue crash when Review is full):** inferred from the code path (`card_runner.ts` → `execute.ts` `transition` → `board_service.ts` `transitionCard` throws). It was not reproduced.
