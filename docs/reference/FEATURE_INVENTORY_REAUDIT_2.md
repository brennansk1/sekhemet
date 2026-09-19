# Feature inventory re-audit, pass 1 (2026-09-19)

An independent re-audit of every unit in [FEATURE_INVENTORY_REAUDIT.md](FEATURE_INVENTORY_REAUDIT.md) except the X (cross-cutting) and U (dashboard) units, which another builder is still changing and which get a second pass. It is scored against commit `9edc3e5`, on the gate the user set in [COMPLETION_PLAN.md](COMPLETION_PLAN.md). Builders' reports and commit messages were used only as leads. Every status comes from reading the code on disk, tracing a production caller and finding the test.

## Method

- **The design per unit** is the requirement column of [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md), checked against `docs/design/HARNESS_DESIGN.md` where the column was terse.
- **Reachability.** A TypeScript-AST reachability pass started at `apps/harness/src/index.ts` (every CLI command, the queue, the dashboard server, MCP and ACP) and `packages/sdk`. It flagged the exported symbols nothing in production reaches. Each unit's call chain was then traced by hand. Code reachable only from tests is DEAD. So is a code path that exists in production but is never switched on by any production caller (for example, an option no caller sets).
- **Tests.** One full run of `pnpm exec vitest run` at the start of the audit: **150 files and 947 tests passed in 28.9 s**, exit 0. No model and no llama-server was started. A unit needs a test that exercises its behaviour. A unit with no test proving it is not BUILT (K23 is the only such case).
- **Tags.** BUILT means to depth, reachable and tested. SHALLOW means it exists and is reachable, but part of the design is missing, simplified, or never switched on in production. DEAD means it is implemented but nothing in production reaches it. MISSING means there is no code for it. Nothing is tagged SUPERSEDED: no substitution was signed off. A deliberate deviation (for example, bubblewrap mounts instead of Landlock) is therefore SHALLOW until the user signs it off.
- **The worktree was not clean.** During the audit another builder had uncommitted edits to `server.ts`, `tracing.ts`, `wave2_server.ts`, `ui_html.ts`, `packages/ui/web/*` and four harness specs. Those edits are **not** scored here. H21 and H22 in particular may change when they land.

### Call-chain shorthand

| Shorthand | Chain |
| --- | --- |
| **[KERNEL]** | `index.ts` `main` → `initLocalKernel` → `kernel/src/card_store.ts` `CardStore` / `log.ts` `EventLog` (every command) |
| **[RUN]** | `index.ts` `main` (`run`, `resume`, `queue`, `overnight`, `bake-off` via `scripts/run_gate.sh`) → `execute.ts` `executeCard` → `loop/src/card_runner.ts` `CardRunner.run` |
| **[TURN]** | [RUN] → `loop/src/session.ts` `CardExecutionSessionImpl.executeTurn` |
| **[VERIFY]** | [TURN] → `session.ts` `runVerification` → `runVerificationInner` |
| **[TOOL]** | [TURN] → `loop/src/tools.ts` `ToolExecutor.execute` |
| **[GATE]** | [VERIFY] → `gates/src/runner.ts` `DeterministicGateRunner.runGates` (wrapped by `license_gate.ts` `withLicenseGate` and `trailer_gate.ts` `withTrailerGate`; `RemoteGateRunner` when `[gate_host]` is set) |
| **[BUILTIN]** | [VERIFY] → `gates/src/builtin.ts` `runBuiltinGates` |
| **[QUEUE]** | `index.ts` `main` `queue` (also driven by `overnight` and `run_gate.sh`) |
| **[PRELUDE]** | [QUEUE] → `wave2.ts` `queuePrelude` |
| **[PLAN]** | `index.ts` `plan` → `wave2.ts` `planCommand` → `planner/src/persist.ts` `persistPlan` |
| **[W2 x]** | `index.ts` `main` → `wave2.ts` `runWave2Command` case `x` |
| **[SRV]** | `index.ts` `serve` / `board` / `daemon` → `server.ts` `startDashboardServer` (with `rest_extra.ts`, `wave2_server.ts`, `pm_api.ts`, `integrations.ts` routes) |
| **[ACCEPT]** | `execute.ts` `acceptCard` ← `sekhemet accept`, `queue --auto-accept`, [SRV] `POST /api/cards/:id/accept` |

Test files are written `pkg/name` for `packages/pkg/tests/name.spec.ts` and `harness/name` for `apps/harness/tests/name.spec.ts`.

## Summary (this pass: K, S, Y, M, G, C, L, B, P, E, H)

| Package | Units | BUILT | SHALLOW | DEAD | MISSING |
| --- | --- | --- | --- | --- | --- |
| kernel (K) | 28 | 21 | 7 | 0 | 0 |
| sandbox (S) | 15 | 12 | 3 | 0 | 0 |
| sync (Y) | 20 | 14 | 6 | 0 | 0 |
| models (M) | 25 | 19 | 6 | 0 | 0 |
| gates (G) | 27 | 14 | 12 | 0 | 1 |
| context (C) | 22 | 14 | 8 | 0 | 0 |
| loop (L) | 31 | 27 | 4 | 0 | 0 |
| board (B) | 13 | 11 | 2 | 0 | 0 |
| planner (P) | 25 | 20 | 4 | 1 | 0 |
| eval (E) | 19 | 11 | 7 | 1 | 0 |
| harness app (H) | 27 | 16 | 11 | 0 | 0 |
| **Total** | **252** | **179** | **70** | **2** | **1** |

For the same 252 units, the 2026-09-18 re-audit counted 48 BUILT, 91 SHALLOW, 19 DEAD and 94 MISSING (its totals minus the U and X rows). Most of the new code is real and wired. What remains is mostly depth: a design detail left out, or a feature built and then never switched on by any production caller (constrained decoding, progressive tool loading, speculative-decoding measurement, engine selection). **The gate is not met: 73 of 252 units in this pass are not BUILT.**

### The eight defects from the previous re-audit

| # | Defect | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Queue crashes when Review is full | **Fixed** | `card_runner.ts` `move` catches the board's refusal and holds the card (`lifecycle.hold` → `BoardServiceImpl.holdCard`). `execute.ts` `releaseHeldCards` retries on accept, return and park. Test: `loop/runner_backpressure`, `loop/runner_depth`. |
| 2 | Checkpoints never written to the DB | **Fixed** | `CardRunner.checkpoint` → `store.recordCheckpoint` and `runs.markStepCheckpoint`. Test: `loop/runner_depth`. |
| 3 | Restricted mode leaves the agent's tools unconfined | **Fixed** | `ProcessSandbox` fails closed by default (`requiresConfinement`), and `ToolExecutor` receives `requireConfinement` and `readOnly`. Test: `loop/restricted`, `sandbox/sandbox_wave2`. |
| 4 | The ask tier is always a denial | **Fixed** | `execute.ts` `decisionApprover` → `RunLedger.requestDecision` / `awaitDecision`, answered at `POST /api/decisions/:id`. Test: `harness/runner_wiring`, `harness/server_runs`. |
| 5 | `gates.toml` protected globs ignored | **Fixed** | `CardRunner` passes `protectedGlobs` → session → `new PermissionEngine({protectedGlobs})`. Test: `gates/protected_redirect`, `harness/runner_wiring`. |
| 6 | Planned cards lose their contract | **Fixed** | [PLAN] `persistPlan` writes spec, criteria, difficulty, route, budgets, dependencies, sketch and assumptions. Test: `planner/persistence`, `harness/wave2_wiring`. |
| 7 | MCP advertises the `spike` tier | **Fixed** | `mcp.ts` `TIERS` is `initiative, epic, feature, story, task`. Test: `harness/mcp`. |
| 8 | Card actuals never set | **Fixed** | `CardRunner.finish` writes `stopReason`, `tokensUsed`, `secondsUsed`, `evidenceId`, `stepsUsed`, `contextPackId`. Test: `loop/runner_depth`. |

## Per-unit status

### `@sekhemet/kernel`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| K1 | Hash-chained event log | BUILT | [KERNEL] `EventLog.append` ← `CardStore.recordEvent` ← [RUN], [SRV], [PLAN] | kernel/log, harness/e2e_lifecycle | |
| K2 | `verifyHashChain` first broken seq | BUILT | `log.ts` `verifyHashChain` ← `sekhemet log`, [SRV] `/api/integrity`, `/api/events` | kernel/log, harness/execute_events | |
| K3 | `payload_hash` column | BUILT | `canonical_json.ts` `canonicalPayloadHash` ← `EventLog.append` | kernel/records, kernel/log | |
| K4 | Typed card/attempt/step columns | BUILT | `execute.ts` `onTurn` → `recordEvent({attemptId, stepId})`; runner `recordStep` sets them on the turn | kernel/records, harness/runner_wiring | |
| K5 | Actor enum CHECK | BUILT | `schema.ts` actor CHECK over the documented extended enum; `log.ts` validates on append | kernel/records | |
| K6 | `subscribe(filter, cb)` | BUILT | [SRV] `server.ts` `log.subscribe` drives the SSE and WS stream (the timer is the cross-process fallback) | harness/server_runs | |
| K7 | `getRange` | BUILT | `log.ts` `getEvents` ← [SRV] `/api/events?since=`, `pm/metrics.ts` | kernel/log | |
| K8 | Projection rebuild / applyEvent | BUILT | `CardStore.verifyProjections` / `rebuildProjections` ← `sekhemet log [--rebuild]`, [SRV] `/api/integrity` | kernel/records, harness/cli_kernel | |
| K9 | Service container | SHALLOW | `kernel/src/container.ts` `ServiceContainer` ← `execute.ts` `executeCard` (per card, for plugins) | kernel/container, harness/runner_wiring | Only 6 of the 11 keys are ever registered: `ctx.events`, `ctx.context`, `ctx.models`, `ctx.tools`, `ctx.loop`, `ctx.planner` and `ctx.sync` never are. No core component resolves anything from the container: `index.ts` and `executeCard` still construct every service by hand, so the container is a plugin surface only. Wire the kernel, board, runner and sync adapter through it (register once, resolve by key). |
| K10 | Reversible plugin manager | SHALLOW | `container.ts` `PluginManager.loadFromDirectory` ← `executeCard`; `unmountAll` in `finally` | kernel/container, harness/runner_wiring | Plugins can only claim services and lifecycle hooks. The design's plugin API also registers tools, gates, sync adapters and UI panels, but the runner never reads tools or gates from the container, the sync layer never reads adapters from it, and the dashboard has no panel slot. A plugin-registered tool or gate is therefore a no-op. |
| K11 | Model-visible means logged | BUILT | `CardRunner.logPrompt` (`BlobStore.put`) ← session `onPrompt` before `generate`; a failed store throws and the request is not sent | harness/runner_wiring | |
| K12 | 10-event waterfall hooks | SHALLOW | `kernel/src/hooks.ts` `LifecycleHookEngine.emit` ← runner (`card/start`, `card/end`), session (`pre-step`, `pre-tool`, `post-tool`, `pre-gate`, `post-gate`, `turn-stopping`), [SRV] return (`review/return`); `user_hooks.ts` `hookEngineFor` loads `.sekhemet/hooks.toml` | harness/user_hooks, harness/runner_wiring, kernel/hooks | `playbook/propose` is declared but never emitted. `LearningStore.propose` and `learnFromAttempt` never call the engine, so a hook cannot see or veto a proposed rule. |
| K13 | 4-level hierarchy cap | BUILT | `CardStore.createCard` (`MAX_CARD_DEPTH`, `CardStructureError`) ← every create path | kernel/records | |
| K14 | `projects` table | BUILT | `CardStore.ensureProject` ← `index.ts` main (`ensureRepoProject`); [SRV] `/api/projects` | kernel/records, harness/cli_kernel | |
| K15 | `card_dependencies` + DAG | BUILT | `CardStore.addDependency` (cycle check) ← [QUEUE] inferred edges; `waitingOn` ← board entry conditions | kernel/records | |
| K16 | `attempts` table | SHALLOW | `RunLedger.startAttempt` / `finishAttempt` ← `CardRunner.run` / `closeAttempt` | kernel/records, harness/runner_wiring | The design's `rung` (1..4 CHECK) and `tool_arm` (A/B/C CHECK) columns are absent, so an attempt row cannot say which rung or arm produced it. Add both and write them from the ladder and the adapter's arm. |
| K17 | `steps` table | SHALLOW | `RunLedger.recordStep` ← `CardRunner.recordStep` | kernel/records, harness/runner_wiring | `repo_state_hash` exists but is never written: the runner does not pass the session's repo hash. `success` and `tokens_condensed` have no column. Pass `getRepoStateHash` per step and record the condensed-token count from `condenseToolOutput`. |
| K18 | `gate_results` table | BUILT | `RunLedger.recordGateResult` ← `CardRunner.recordStep` | harness/server_runs, kernel/records | |
| K19 | `evidence_bundles` table | SHALLOW | `RunLedger.recordEvidence` ← `CardRunner.closeAttempt` | kernel/records | The row indexes the bundle file by path and SHA-256 only. The design's `structural_diff`, `gate_results_summary`, `passed_checks`, `failed_checks` and `abandoned_hypotheses` exist neither here nor in the bundle (see G11). |
| K20 | `decision_requests` table | BUILT | `RunLedger.requestDecision` ← `decisionApprover` (S8), planner `DecisionStore`; answered at [SRV] `/api/decisions` | kernel/records, harness/server_runs | |
| K21 | Competence entries | BUILT | `RunLedger.recordCompetence` ← `closeAttempt`; `runs.competence` ← `execute.ts` `pullThroughPlanning` (budgets) | kernel/records, loop/budget_calibration | |
| K22 | Full card record | BUILT | `CardRunner.finish` → `store.updateCard` (actuals, stop reason, evidence and pack ids) | harness/runner_wiring, loop/runner_depth | |
| K23 | `busy_timeout = 5000` | SHALLOW | `schema.ts` `KERNEL_PRAGMA_SQL` ← `initSchema` | none | No test asserts the pragma: nothing reads back `PRAGMA busy_timeout` or exercises a lock wait. Add a real-file test with two connections. |
| K24 | Column enum with Planning | BUILT | `schema.ts` `CARD_STATUS_CHECK`; `pullThroughPlanning` moves cards into `planning` | harness/control | |
| K25 | Difficulty scale | BUILT | `pullThroughPlanning` → `scoreDifficulty` → `updateCard({difficulty})`; [PLAN] persists it too | harness/control, planner/persistence | |
| K26 | Packs and evidence by hash | BUILT | `BlobStore.put` (context packs) ← `CardRunner.logPrompt`; `contextPackId` on `card/step` events and step rows | kernel/blobs_retention, harness/runner_wiring | |
| K27 | 30-day retention | BUILT | `execute.ts` `pruneRunData` → `pruneRetention` ← [QUEUE] start | kernel/blobs_retention | |
| K28 | Attributed checkpoint record | BUILT | `CardRunner.checkpoint` → `recordCheckpoint` | loop/runner_depth | |

### `@sekhemet/sandbox`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| S1 | Seatbelt profile | BUILT | `seatbelt.ts` `generateSeatbeltProfile` ← `executor.ts` `ProcessSandbox.wrap` ← [TOOL] `runCmd`, [GATE] | sandbox/containment | |
| S2 | `sandbox-exec` | BUILT | `ProcessSandbox.wrap` ← same | sandbox/containment | |
| S3 | Namespaces + Landlock + seccomp | SHALLOW | `bubblewrap.ts` `bubblewrapArgv` + `seccomp.ts` `seccompProgram` (fd 3) ← `ProcessSandbox.execute` | sandbox/seccomp, sandbox/bubblewrap | No Landlock ruleset. Bubblewrap's mounts stand in for it, a deviation nobody signed off. Either add a Landlock layer (for example `landlock-restrict` or a small helper) or get the substitution signed off. |
| S4 | Fail closed | BUILT | `ProcessSandbox.requiresConfinement` (default true unless `SEKHEMET_ALLOW_UNCONFINED=1`) ← [TOOL], [GATE] | sandbox/containment, sandbox/sandbox_wave2 | |
| S5 | Network denied; allowlist proxy; request log | BUILT | `egress.ts` `EgressProxy` ← `CardRunner.run` when `gates.toml network_allow` is set; `card/egress` events with a payload hash | sandbox/egress, harness/runner_wiring | |
| S6 | Timeout, then SIGTERM, then SIGKILL | BUILT | `ProcessSandbox.execute` | sandbox/containment | |
| S7 | Buffer cap / OOM | BUILT | `ProcessSandbox.execute` (tree memory sampling, tree kill, `oomKilled` with the peak) | sandbox/sandbox_wave2 | |
| S8 | Allow / Ask / Deny | BUILT | `permissions.ts` `PermissionEngine.evaluate` ← [TOOL] `authorize`; ask → `decisionApprover` | sandbox/permissions, sandbox/sandbox_wave2, harness/runner_wiring | |
| S9 | Untrusted-content tagging | BUILT | `untrusted.ts` `tagUntrusted` ← `dossierPromptLines`, session `buildPrompt` (tracker specs); `ToolExecutor.setUntrustedContext` (strict policy) | loop/untrusted, sandbox/sandbox_wave2 | |
| S10 | Supply-chain check | SHALLOW | `builtin.ts` `dependencyGate` ← [BUILTIN] (registry `npmRegistry`/`mirrorRegistry` from `executeCard`) | gates/builtin | No download-profile check, which the design lists. `requirements.txt` additions are looked up in the **npm** registry, the only one wired, and `Cargo.toml`, `pyproject.toml` and `go.mod` are not parsed. Add PyPI and crates.io lookups (and their mirrors) and a download-count floor. |
| S11 | `osv-scanner` | BUILT | `builtin.ts` `osvGate` ← [BUILTIN] when the binary is on PATH (reported as skipped otherwise) | gates/builtin | |
| S12 | Restricted mode | BUILT | `index.ts` `--restricted` → `executeCard` → runner `restricted` (restricted catalog, read-only executor, static gates only) | loop/restricted | |
| S13 | Worktree manager | BUILT | `sync/src/git_adapter.ts` `createWorktree` / `removeWorktree` ← [RUN], [ACCEPT] | sync/sync, harness/e2e_lifecycle | |
| S14 | Copy-on-write worktrees + linked deps | SHALLOW | `git_adapter.ts` `linkDependencies` ← `createWorktree` | sync/sync | No APFS `clonefile` or reflink: a plain `git worktree add` plus symlinks. Use `cp -c` (APFS) or `cp --reflink=auto` for the checkout, or get the substitution signed off. |
| S15 | Per-card env isolation | BUILT | `executor.ts` `buildEnv` (allowlist) ← every sandboxed command | sandbox/containment | |

### `@sekhemet/sync`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| Y1 | Worktree and branch from parent | BUILT | `createWorktree(card.id, base, title, parentId)` ← `CardRunner.run` | sync/git_wave2, loop/c_integration | |
| Y2 | Checkpoint trailers | BUILT | `commitCheckpoint` (model co-author by default) ← `CardRunner.checkpoint` | sync/git_wave2 | |
| Y3 | Commit after every passing / writing step | BUILT | `CardRunner.run` (`checkpointEvery: 1` from `executeCard`, plus every gate pass and suspending stops) | loop/runner_depth, sync/git_wave2 | |
| Y4 | Conventional squash | BUILT | `squashAndMerge` → `conventionalSquashMessage` (type, scope, intent groups, co-authors) ← [ACCEPT] | sync/git_wave2 | |
| Y5 | Injection-safe git | BUILT | `runGit` (`execFileSync`, argv) | sync/sync | |
| Y6 | Rebase before Verify; typed conflicts | SHALLOW | `git_adapter.ts` `rebaseOntoIntegration` ← `CardRunner.run` (`rebase_conflict`, re-verify) | sync/git_wave2, loop/c_integration | The design sends a conflicting card **back to In Progress with the conflict hunks as typed failures**, and parks it when the conflict is outside its scope. The runner instead sends every conflict to Planning with a one-line `blockedReason`. The hunks the adapter returns are dropped, so the next attempt never sees them as a `GateFailure`. |
| Y7 | Stacked branches | SHALLOW | `restackChildren` ← [ACCEPT] | sync/git_wave2 | Children are rebased, but their gates are not re-run, as the design requires ("rebases the cards above it and re-runs their gates"). A restacked child keeps its old passing evidence. Re-verify each restacked child (or mark its evidence stale and send it back to Verify). |
| Y8 | difftastic structural diff | BUILT | `structuralDiff` ← [SRV] `/api/cards/:id/diff` (plain diff when difftastic is absent) | sync/git_wave2, harness/wave2_server | |
| Y9 | Head sha / diff | BUILT | `getHeadSha`, `generateDiff`, `getDiffStats` ← `CardRunner.finish` | sync/sync | |
| Y10 | `SyncAdapter` | BUILT | `sync/src/remote.ts` `SyncAdapter`, `mergeLastWriterWins` ← `integrations.ts` `syncGithub` → `wave2_github.ts` `trackerFromEnv` ← [SRV] `/api/integrations/github/sync` | sync/remote, harness/wave2_github | |
| Y11 | Forgejo adapter | BUILT | `ForgejoIssuesAdapter` ← `trackerFromEnv` (`SEKHEMET_FORGEJO_*`) | sync/remote, harness/wave2_github | |
| Y12 | GitHub App auth | BUILT | `github_app.ts` `createAppJwt`, keychain key loading, installation tokens ← `wave2_server.ts` `githubAppFromEnv` | sync/remote, harness/wave2_github | |
| Y13 | Webhook intake | BUILT | `webhook.ts` `githubWebhookHandler` (HMAC, five triggers) ← [SRV] `POST /webhooks/github` | sync/remote, harness/wave2_server | |
| Y14 | Check runs with annotations | BUILT | `postCheckRun` ← `wave2_github.ts` `openPullRequestViaApp` ← [ACCEPT] `openPullRequest` | sync/remote, harness/wave2_github | |
| Y15 | SARIF upload | BUILT | `uploadSarif` ← same | sync/remote, harness/wave2_github | |
| Y16 | PR lifecycle | SHALLOW | `PullRequestLifecycle.advance` (ready + CODEOWNERS, auto-merge) ← [PRELUDE] `advancePullRequests` | sync/remote, harness/wave2_github | `openThreads` and `resolveThread` have no production caller. Review comments never become repair subtasks and are never resolved. There is no merge-queue awareness. Have the prelude read open threads, create repair subtasks, and resolve the thread when the subtask's gates pass. |
| Y17 | Release cards | SHALLOW | `repo_tools.ts` `planRelease`, `publishRelease` ← [W2 release] | sync/remote, harness/wave2_wiring | `sekhemet release` calls `publishRelease` without a GitHub client, so no GitHub Release is ever published: only a local tag. Releases are a command, not a card that goes through the board and a human accept. |
| Y18 | CI as a gate source via `act` | SHALLOW | `runActGate` ← [W2 ci] only | sync/remote, harness/wave2_wiring | CI runs only as the manual `sekhemet ci` command. It is not a gate source in card verification: `gates.toml` has no `act` gate kind or template, and `parseActOutput` is not in the failure-parser registry. Let `gates.toml` declare `[[gate]] kind = "ci"` (or a template) that `runGates` runs through `runActGate`. |
| Y19 | Monorepo / multi-repo scope | SHALLOW | `repo_tools.ts` `gatesForChange` ← `wave2.ts` `runPackageGates` ← `sekhemet gate <card>` | sync/remote, harness/wave2_github | Per-package gates run only from `sekhemet gate`. Card verification ([VERIFY]) still runs the repository-level gates. `splitAcrossRepos` has no production caller, so a cross-repo scope is never split into two cards with a dependency edge. |
| Y20 | External-edit reconciliation | BUILT | `reconcileExternalEdit` ← `wave2_github.ts` sync ← [SRV] `/api/integrations/github/sync` | sync/remote, harness/wave2_github | |

### `@sekhemet/models`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| M1 | HTTP inference adapter | BUILT | `http_adapter.ts` `HttpInferenceAdapter.generate`, `llama_server.ts` `ManagedLlamaServerAdapter` ← `roster.ts` `ModelRoster.resolve` ← [QUEUE], [RUN] | models/models, models/llama_server | |
| M2 | Token streaming | BUILT | `generate({onToken})` (SSE and NDJSON) ← session ← `executeCard` `liveTokenWriter` → [SRV] SSE `tokens` | models/adapter_contract, harness/server_runs | |
| M3 | `measureThroughput` | BUILT | `telemetry.ts` `ThroughputMeter` ← [QUEUE] run report | models/adapter_contract, models/usage_telemetry | |
| M4 | `healthCheck` | BUILT | adapters' `healthCheck` ← `router.ts` `ModelRouter.use` | models/adapter_contract | |
| M5 | Qwen3.8-27B profile | BUILT | `llama_server.ts` `createQwen38Managed` (code and planning sampling) ← `ModelRoster.resolve("qwen38…")` | models/launch_profiles | |
| M6 | Per-request reasoning | BUILT | `reasoning.ts` `reasoningForStep` ← session (off, on for repair rungs); `manager.ts` `planRepair` (planning) | models/usage_telemetry, loop/prompt_wiring | |
| M7 | Tolerant parser | BUILT | `parser.ts` `parseToolCallsFromText` ← `generate` | models/models | |
| M8 | Arm A constrained decoding | SHALLOW | `http_adapter.ts` `response_format: json_schema` when `constrainedToolCalls === true` | models/adapter_contract | No production profile, roster entry or config sets `constrainedToolCalls`, so every production request uses native tools. Constrained decoding is dead in practice. Enable it per model from the registry's measured arm (or `[models]` config), and fall back on the server's refusal. |
| M9 | Arm C patches | BUILT | `parseArmCTextPatches` ← `generate` when `toolArm === "arm_c_sketch"`; `preferredToolArm` ← `ModelRegistry.armFor` (measured by `sekhemet qualify`) | models/registry_calibration, loop/c_integration | |
| M10 | Mock adapter contract | BUILT | `mock_adapter.ts` `MockInferenceAdapter` (rules, exhaustion modes, history). A test double by definition: its callers are the 21 specs that use it | models/qualification_schedule | Judgement call: counted BUILT because the design specifies it as test infrastructure. |
| M11 | Model registry | BUILT | `registry.ts` `ModelRegistry` ← `wave2.ts` `modelRegistry` ← roster, `qualify`, `calibrate`, `bake-off` | models/registry_calibration | |
| M12 | Template checksum pinning | BUILT | `ModelRegistry.pinTemplate` ← `HttpInferenceAdapter` on first request (invalidates qualification) | models/registry_calibration | |
| M13 | Hardware calibration | SHALLOW | `calibration.ts` `calibrateHardware` ← `calibrate_cmd.ts` `runCalibrate` ← `sekhemet calibrate` | models/registry_calibration, harness/calibrate_cmd | Usable memory is assumed (total minus 4 GB), not measured. There is no memory-bandwidth measurement, and no prefill batch-size or expert-offload sweep "one step back from the memory cliff". It measures throughput per context bucket and the fingerprint only. |
| M14 | Tier profiles S/M/L/XL | SHALLOW | `TIER_PROFILES`, `tierForBudget` ← `calibrateHardware` (the tier is stored and printed) | models/registry_calibration | The tier's working-context range, parallel-card count and co-loading rule are never applied. Nothing sets the context window, the number of parallel cards or planner/executor co-residency from the calibrated tier (`init.ts` recommends a roster from raw RAM instead). |
| M15 | Throughput floors | BUILT | `assertModelRunnable` ← [PRELUDE] (refuses a worker below the overnight floor) | models/registry_calibration | |
| M16 | 8-bit KV; 4-bit refused | BUILT | `kv_policy.ts` `assertKvPolicy` ← `launchArgs`, Ollama path | models/adapter_contract | |
| M17 | Prompt-cache configuration | BUILT | `launchArgs` `--cache-ram`, `--ctx-checkpoints`, `-sps`; `cache_prompt: true` ← roster launches | models/launch_profiles | |
| M18 | Prefix-cache telemetry and alert | BUILT | `telemetry.ts` `PrefixCacheMonitor` (85% on tool-result steps) ← adapters; [QUEUE] report | models/adapter_contract, models/usage_telemetry | |
| M19 | Speculative decoding by measurement | SHALLOW | `ManagedLlamaServerAdapter.mtpEnabled` reads `registry.speculative` | models/registry_calibration | `calibrateSpeculative` and `decideSpeculative` have **no production caller**: `sekhemet calibrate` never measures with and without the MTP head. The registry's `speculative` decision is therefore never written, and MTP falls back to the profile's hard-coded flag. There is no draft-model (`-md`) support. |
| M20 | Memory-pressure watchdog | BUILT | `watchdog.ts` `MemoryWatchdog` (2 s poll, graduated actions) ← [QUEUE]; `executeCard` `memoryProbe` / `onTurn` pause | models/watchdog | |
| M21 | Model swapping | BUILT | `ModelRouter.use` ← [QUEUE] | models/router_swap, models/residency | |
| M22 | Qualification suite | BUILT | `qualification.ts` `runQualification` ← `eval/diagnostics.ts` `qualifyCandidates` ← [W2 qualify] | models/qualification_schedule | |
| M23 | Per-repo bake-off | SHALLOW | `index.ts` `bake-off` → `run_gate.sh` → [QUEUE]; `recordBakeOff` (full settings, `MODEL_MATRIX.md`) | models/qualification_schedule | The bake-off runs a benchmark fixture (`--fixture chronicle`), **not tasks synthesized from the repo's own history**, as the design requires. The history synthesis exists (`sekhemet m0`) but the bake-off does not use it. |
| M24 | Engine selection by measurement | SHALLOW | `selectEngine` ← `calibrate_cmd.ts` → `profile.engine` | models/registry_calibration, harness/wave2_more | The choice is saved and printed but nothing reads `profile.engine` when launching a model. The cache-retention input comes from the calibrate process's own in-memory telemetry, which is always empty, so retention is never weighted. |
| M25 | Declared hours, batched swaps | BUILT | `wave2.ts` `batchBySwaps` ← [PRELUDE]; `overnight.ts` hours windows | models/qualification_schedule, harness/wave2_more | |

### `@sekhemet/gates`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| G1 | `gates.toml` parser | SHALLOW | `config.ts` `loadGatesConfig` ← `executeCard`, `CardRunner` constructor, `sekhemet gate` | gates/config | `schedule`, `threshold {score}` and `[project] languages` are not parsed. A nightly gate or a score threshold cannot be declared. |
| G2 | Hash pin on every card start | BUILT | `verifyGatesConfig` ← `runner.ts` `resolveConfig` ← [GATE] | gates/config | |
| G3 | Six layers + runs-on hosts | SHALLOW | Layers implemented: [BUILTIN] security, hygiene, robustness, visual; declared static and functional gates | gates/builtin | The design gives **each layer** a runs-on host. The gate host (G24) is project-wide, so a layer cannot run elsewhere (for example, visual on a machine with a GPU browser). Add `runs_on` per layer in `gates.toml`, and dispatch per layer. |
| G4 | Runner executes declared commands | BUILT | `runGate` ← [GATE] | gates/gates | |
| G5 | Full-layer run | BUILT | `runGates` (`failFast` off) | gates/gates | |
| G6 | Parse gate before write | SHALLOW | `loop/src/parse_gate.ts` `checkSyntax` (TS/JS, JSON, TOML, Python `ast`, `bash -n`) ← [TOOL] `validateWrite` | loop/tools_wave2, loop/parse_gate | No tree-sitter, and Rust, Go and every other language are written unchecked. The harness ships Rust and Go gate templates (G27), so those edits skip the gate. Add tree-sitter (or `rustc --parse-only`-style) checks for the template languages. |
| G7 | Write path | BUILT | `write_contract.ts` `validateWrite` (scope, parse, secret scan) + atomic temp-and-rename ← [TOOL] | loop/tools_wave2 | |
| G8 | Typed failures, top 3 by dependency order | SHALLOW | `parsers.ts` `rankFailures` ← `runGates` | gates/remedies | The ranking is severity, then file-reference weight, **not topological dependency order** (a type error in a file other failures import should come first). Order by the import graph of the failure locations, with severity as the tie-break. |
| G9 | Parser registry | BUILT | `FailureParserRegistry` (tsc, vitest/jest, biome/eslint, generic) ← `runGate`; gitleaks JSON parsed in `builtin.ts` | gates/gates | |
| G10 | Bounds check | BUILT | `checkBounds` ← [VERIFY] (`bounds` from `gates.toml`) | gates/bounds, loop/session_depth | |
| G11 | Evidence bundle | SHALLOW | `evidence.ts` `compileEvidence` ← `CardRunner.finish` → [SRV] `/api/evidence/:id` | loop/runner_depth | The bundle lacks the design's `structuralDiff`, `summary {passedChecks, failedChecks, abandonedHypotheses}` and `attemptId`. `trajectoryRef` is a transcript path, not the SHA-256 of the event-log slice. Y8's structural diff exists but is not put in the bundle. |
| G12 | Acceptance tests first | BUILT | `CardRunner.failToPass` (vacuous tests park the card) ← `CardRunner.run`; staged tests protected | loop/runner_depth | |
| G13 | Diff-scoped mutation testing | SHALLOW | `builtin.ts` `mutationGate` ← [BUILTIN] once gates pass (advisory, `mutation_blocking` opt-in) | gates/builtin | JS/TS only (`/\.[cm]?[jt]sx?$/`). Python and Rust changes get no mutants, although the design names mutmut and cargo-mutants and the harness ships those templates. There is no `threshold {score}` or `schedule` (see G1). |
| G14 | Secret scan | BUILT | `secrets.ts` rules on added lines + gitleaks when installed ← [BUILTIN]; also `validateWrite` | gates/builtin, loop/tools_wave2 | |
| G15 | Dependency existence / typosquat gate | SHALLOW | `dependencyGate` ← [BUILTIN] | gates/builtin | Same gap as S10: Python additions are checked against the npm registry, Cargo and Go manifests are not read, and there is no download profile. |
| G16 | Semgrep | SHALLOW | `semgrepGate` ← [BUILTIN] | gates/builtin | Runs only when the project supplies `.sekhemet/semgrep.yml` and semgrep is installed. It is skipped otherwise, and no community rule pack ships with the harness. Bundle an offline community rule set and use it when the project declares none. |
| G17 | Visual: console and network errors | BUILT | `visual.ts` `runVisualGates` (CDP) ← [BUILTIN] when `[visual]` is declared | gates/visual | |
| G18 | Visual: layout bounds | SHALLOW | `layoutScript` ← `runVisualGates` | gates/visual | Checks visibility, viewport and overflow, but not **element overlap**, one of the design's four predicates. |
| G19 | Visual: screenshot diff | SHALLOW | `pixelDiffRatio` at 1% ← `runVisualGates` | gates/visual | No masking of dynamic content (`mask`) and no disabling of animations, both part of the design. Snapshots of pages with clocks or spinners will flake. |
| G20 | Visual: accessibility | SHALLOW | `A11Y_SCRIPT` at 1280 and 375 px ← `runVisualGates` | gates/visual | A hand-written subset of eight rules, not axe-core, so "zero critical violations" is measured against a small subset. Vendor axe-core (MPL-2.0; check the licence register) and inject it through CDP. |
| G21 | Vision checklist (can fail, never pass) | MISSING | none | none | No gate asks a vision model to check atomic criteria against screenshots. X3 (commit `9edc3e5`) now produces per-image visual criteria and can call the vision model, so the pieces exist. Wire a `visual` sub-gate that sends the snapshot plus the card's criteria at temperature 0, lets a "fail" fail the card, and ignores any "pass". |
| G22 | Hygiene gate | BUILT | `hygieneGate` (debug output, changelog, trailers) ← [BUILTIN]; `trailer_gate.ts` ← [GATE] | gates/builtin, harness/trailer_gate | |
| G23 | Regression protection | BUILT | `CardRunner.regressionAgainstReview` → Planning | harness/control | |
| G24 | Gate host separation | BUILT | `gate_host.ts` `RemoteGateRunner` ← `executeCard` when `[gate_host]` is set; `sekhemet gate-host [init]` | gates/gate_host, harness/runner_wiring | |
| G25 | Pass@k with gate selection | BUILT | `CardRunner.run` samples (`[project] pass_at_k`, temperatures 0.4 to 0.7) | loop/pass_at_k | |
| G26 | Cross-validation of attempts | BUILT | `CardRunner.crossValidate` (`cross_validate`) → `replan_requested` → Planning | loop/pass_at_k | |
| G27 | Gate templates by language | SHALLOW | `templates.ts` ← `sekhemet gates init`, `init.ts`, `onboard` | gates/templates, harness/cli_gate | Templates have typecheck, lint and test only. The design's format gates (prettier, rustfmt) and mutation gates (Stryker, mutmut, cargo-mutants) are missing. Python and Rust output goes through the `generic` parser, with no pytest or cargo parser. An unknown language gets no "parse-gate only" warning. |

### `@sekhemet/context`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| C1 | Repo map with PageRank | SHALLOW | `ranked_repo_map.ts` `buildRankedRepoMap` ← session `repoMap` ← [TURN] | context/context_units, loop/c_integration | TypeScript and JavaScript only (`SOURCE_EXT`, the TS compiler). Python, Rust and Go repositories fall back to the flat map with no graph or PageRank. The design's tree-sitter approach is multi-language. |
| C2 | LSP client pool | BUILT | `lsp.ts` `LspPool` ← `execute.ts` `runLspPool` → [TOOL] symbol tools on non-TS files | context/context_units, loop/c_integration | |
| C3 | SWE-Pruner line pruning | SHALLOW | `pruner.ts` `pruneLines` ← `buildWorkerPrompt` | context/worker_prompt_wave2 | A keyword and structure heuristic, not the design's 0.6B skimmer model running on the gate host. Add a model-backed pruner behind the same interface, or get the heuristic signed off. |
| C4 | Four zones, byte-stable prefix | BUILT | `PrefixStabilityGuard` (one per runner) ← `buildWorkerPrompt` ← [TURN] | context/worker_prompt, loop/c_integration | |
| C5 | Budgets: system under 1k, tools under 2k | SHALLOW | Assertions exist only in `zones.ts` `assertSystemZoneBudget`, called from `prompts.ts` `buildFullPromptPack`, **which production no longer calls** | none on the live path | The live `buildWorkerPrompt` never checks the system zone or the tool interface against the 1,000 and 2,000 token budgets, and no test measures the live catalog (30 tools, including `tool_search`, the process tools and `browse`). Assert both in `buildWorkerPrompt` and test the real catalog. |
| C6 | Observation masking with refs | BUILT | `condenser.ts` masking + `FileEvidenceStore` (`useFileEvidenceStore` in `executeCard`) + `recall` ← [TURN] | context/tool_output_evidence | |
| C7 | Pressure tiers, 95% hard stop | BUILT | `buildWorkerPrompt` tiers → `budget_exhausted` ← [TURN] | context/worker_prompt, loop/prompt_wiring | |
| C8 | Lossless command condensing | BUILT | `condenseToolOutput` ← [TOOL] `runCmd`, session `checkObservation` | context/tool_output_evidence, loop/prompt_wiring | |
| C9 | Agent Skills registry | SHALLOW | `skills.ts` `SkillsRegistry.skillsForPrompt` (manifest lines, bodies on match) ← `executeCard` → [TURN] | context/context_units, loop/c_integration | Missing: the declared required tools (a skill is not omitted when the card lacks them), `scripts/`, `references/` and `evals/` directories, the rule that every skill ships an eval card, versioning, and the gates a skill adds. Matching is by trigger substring. |
| C10 | Skill trust | SHALLOW | `SkillsRegistry` lock by SHA-256, audit, reject until approved ← `executeCard`; `sekhemet skills` | context/context_units, harness/wave2_wiring | No content rule that rejects a skill touching gate files, the loop driver or the sandbox (the design's automatic rejection). Pinning is by content hash, not commit. |
| C11 | Playbook | BUILT | `PlaybookRegistry` + `learning/store.ts` `LearningStore` ← `executeCard` → [TURN] | context/playbook, harness/learning | |
| C12 | Context-debt audit | BUILT | `contextDebtRecommendations` ← `eval/diagnostics.ts` `playbookDiagnostics` ← `sekhemet doctor` | context/context_units, harness/wave2_more | Uses the observational gain from E19 (see E19). |
| C13 | Exemplar store | BUILT | `ExemplarStore.topFor(class, 2)` ← [TURN]; `harvestExemplars` ← `executeCard` `learnFromOutcome` | context/context_units, harness/runner_wiring | |
| C14 | Context pack assembly | BUILT | `buildWorkerPrompt` pack record → `turn.contextReport` → `card/step` events | context/worker_prompt_wave2, loop/c_integration | |
| C15 | Byte-identical prompts | BUILT | runtime determinism check in `buildWorkerPrompt` | context/worker_prompt_wave2 | |
| C16 | Subtask branching | BUILT | `subtask.ts` `runSubtask` ← session `subtaskObservation` ← [TURN] | context/context_units, loop/c_integration | |
| C17 | Fresh context on rung change | BUILT | `ladder.ts` `resetContext` → session history reset ← [TURN] | loop/ladder | |
| C18 | Reasoning stripped between steps | BUILT | `parser.ts` `stripReasoning` ← `generate` | models/adapter_contract | |
| C19 | Dynamic tool loading | SHALLOW | `tool_search.ts` `ToolLoader` ← session, **only when `progressiveTools` is set** | context/worker_prompt_wave2, loop/c_integration | No production caller sets `progressiveTools` (`executeCard` and `CardRunner` never pass it). Every schema is therefore sent every turn, and `tool_search` only echoes contracts the model already has. Turn it on in `executeCard` (or from `[context]` config) for the Worker. |
| C20 | Per-step / per-card context metrics | SHALLOW | `buildWorkerPrompt` `metrics` (zone tokens, masked count) → `card/step` | context/worker_prompt_wave2, loop/c_integration | No cache hit rate per step (it is kept per model in telemetry, not joined to the step). None of the per-card metrics exist: peak context, steps to first gate pass, pass rate by pack size. |
| C21 | Joint prompt / playbook / tool versioning | SHALLOW | `versioning.ts` `computeContextVersion` ← `buildWorkerPrompt` (pack record) | context/worker_prompt_wave2 | The version is computed and recorded, but a change does **not invalidate qualification**, as the design requires. Only a template change does (M12). Record the context version with each qualification and treat a mismatch as invalidated. |
| C22 | AGENTS.md / CLAUDE.md into Zone 2 | BUILT | `conventions.ts` `loadProjectConventions` ← session `buildPrompt` | context/context_units, loop/c_integration | |

### `@sekhemet/loop`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| L1 | Turn driver | BUILT | [RUN] loop → [TURN] | loop/loop, loop/session_depth | |
| L2 | Prompt from the pack | BUILT | session `buildPrompt` → `buildWorkerPrompt` | loop/prompt_wiring | |
| L3 | Tool set | BUILT | `tool_catalog.ts` `TOOL_CATALOG` → `toolDefinitions` ← [TURN] | loop/tools | |
| L4 | `read`: ranges, budget, numbering | SHALLOW | [TOOL] `readFile` | loop/tools_depth | No image or PDF passthrough to the vision path. `read_file` on a PNG or PDF returns a binary refusal. X3 now gives `InferenceRequest` an `images` field, so route image reads there. |
| L5 | `edit`: unique, CRLF, parse gate | BUILT | [TOOL] `edit` → `validateWrite` | loop/tool_executor, loop/text | |
| L6 | `grep` | BUILT | [TOOL] `grep_search` (three modes, context, glob, `git ls-files` for gitignore, capped) | loop/tools_depth | Uses JS regex rather than ripgrep, which is behaviourally equivalent. |
| L7 | `glob`: mtime, gitignore | BUILT | [TOOL] `find_files` (git's view, newest first) | loop/tools_wave2 | |
| L8 | `run` | BUILT | [TOOL] `runCmd` (sandbox, timeout, `description`, raw-shell redirection, condensing) | loop/shell_and_check, loop/tools_depth | |
| L9 | Symbol tools | BUILT | `ts_service.ts` language service; `LspPool` for other languages ← [TOOL] | loop/tools_wave2, loop/symbols | |
| L10 | Tiered `docs` | BUILT | [TOOL] `docs` (project, installed version, mirror, `webDocs` ← `workerWebDocs`) | loop/tools_wave2 | |
| L11 | `note` to the thread | BUILT | session `onNote` → `recordDossierEntry` ← runner | harness/runner_wiring | |
| L12 | Code mode | BUILT | [TOOL] `run_script` (Node permission model under the OS sandbox) | loop/tools_wave2b | |
| L13 | Stall detection | SHALLOW | `detector.ts` `OscillationDetector.recordAndCheck` ← [TURN] | loop/loop | The session builds the detector with threshold **3** (`options.oscillationThreshold ?? 3`). The design says two identical signatures is a stall. The oscillation check needs a four-step A-B-A-B, where the design says A-B-A. `[loop] stall_window` in `config.toml` is parsed and ignored (see H15). |
| L14 | Six stop reasons | BUILT | `types.ts` `ExecutionStopReason`; all six produced by session and runner | loop/runner_depth | |
| L15 | Four-rung ladder | BUILT | `ladder.ts` (2/1/1) ← [TURN]; rung 3 → `replan_requested` → `wave2.ts` `replanOnRung3`; rung 4 → park with diagnosis | loop/runner_depth, loop/ladder | |
| L16 | `validateWrite` | BUILT | `write_contract.ts` ← [TOOL] | loop/tools_wave2 | |
| L17 | Read-before-edit | BUILT | [TOOL] (on unless `requireReadBeforeEdit === false`) | loop/tools_depth, loop/tool_executor | |
| L18 | Tool sets per card class | BUILT | `cardClassFor` / `toolsForClass` ← session `catalog` | loop/tools_wave2b | |
| L19 | Web tools only on research cards | BUILT | `CLASS_TOOLS.research` (`browse` on the web); executor web blocked | loop/tools_wave2b | |
| L20 | `browse` | SHALLOW | [TOOL] `browse` → `sandbox/src/browser.ts` `dumpDom` | loop/tools_wave2b | It loads a page and returns its text. The design's click, type, accessibility-tree read, screenshots into evidence, and URL-allowlisted writes are all absent. The CDP client in `gates/src/visual.ts` could back the interactive actions. |
| L21 | Planner-set step budgets | BUILT | `execute.ts` `pullThroughPlanning` → `calibratedStepBudget` (at most 15%) / `stepBudgetForDifficulty` | harness/control, loop/budget_calibration | |
| L22 | Token and time budgets, breakers | SHALLOW | `CardRunner.run` `budgetStop` (`token_budget_exhausted`, `time_budget_exhausted`) | loop/runner_depth | A card that hits its budget goes to Verify, not Parked, as the design requires ("stop a card at its cap and park it"). There is no per-card kWh budget (energy is only a nightly breaker in `overnight.ts`). |
| L23 | Background processes | BUILT | [TOOL] `start_process` / `read_process` / `stop_process` (own `$PORT`, killed at card end via `dispose`) | loop/tools_wave2b | |
| L24 | Interactive terminals | BUILT | [TOOL] `write_process` (stdin), transcript read back as observations | loop/tools_wave2b | |
| L25 | `abort(reason)` | BUILT | `sekhemet abort`, [SRV] `/api/cards/:id/abort` → `card/abort_requested` → `executeCard` `onTurn` → `CardRunner.abort` | harness/control, loop/runner_depth | |
| L26 | Symlink-aware confinement | BUILT | `paths.ts` `resolveInWorktree` ← [TOOL] | loop/paths | |
| L27 | CRLF utilities | BUILT | `text.ts` ← [TOOL] | loop/text | |
| L28 | Glob engine | BUILT | `sandbox/src/glob.ts` ← [TOOL], `PermissionEngine` | loop/tools_wave2 | |
| L29 | `ToolObservation` + clamping | BUILT | `observation.ts` ← [TOOL] | loop/tool_executor | |
| L30 | `ToolExecutor` | BUILT | `tools.ts` ← [TURN] (ask tier wired, see S8) | loop/tool_executor | |
| L31 | Symbol spans | BUILT | `symbols.ts` ← [TOOL] | loop/symbols | |

### `@sekhemet/board`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| B1 | State machine with entry gates | BUILT | `board_service.ts` `transitionCard` + `entryConditionFailure` (entry conditions on in `initLocalKernel`); `card/override` | board/entry_conditions | |
| B2 | Planning column | SHALLOW | `pullThroughPlanning` (Ready → Planning); rung 3, rebase conflict, cross-validation and regression → Planning | harness/control | The design's **Verify → Planning on gate fail** is not followed. A card that ends with failing gates (budget or no progress) stays in Verify, and only a regression against Review goes to Planning. |
| B3 | ReviewWIP from review history | BUILT | `calibrateReviewWip` ← `index.ts` main (per project), [SRV] project hours | board/entry_conditions | |
| B4 | Back-pressure at Verify | BUILT | `transitionCard` (Review count) ← runner `move` (held, not thrown) | loop/runner_backpressure, loop/runner_depth | |
| B5 | Dependency DAG | BUILT | `CardStore.addDependency` / `waitingOn` ← [QUEUE], entry conditions | kernel/records | |
| B6 | Overlapping siblings serialised | BUILT | [QUEUE] defers a card whose files an in-progress card is editing | board/entry_conditions | |
| B7 | Parent rollup with integration gate | BUILT | `execute.ts` `rollupParent` ← [ACCEPT] | harness/control | |
| B8 | Project-scoped board | BUILT | `getBoardState(projectId)` ← [SRV] `/api/projects/:id/board`, `/api/board` | board/entry_conditions, harness/control | |
| B9 | `createCard` | BUILT | `CardStore.createCard` ← [PLAN], [SRV] `POST /api/projects/:id/cards`, MCP, trackers | board/board | |
| B10 | WIP evaluation | BUILT | `checkWipLimits` ← [SRV] `/api/wip` | board/board | |
| B11 | Fractional `order_key` | BUILT | `reorderCard` ← [SRV] `POST /api/cards/:id/reorder` (dashboard drag) | harness/control, ui/reorder | |
| B12 | Human commands | SHALLOW | [SRV] accept, return, park, split, run, override, reroute, explain, rewind, fork, abort, project pause and hours | harness/control | **An override is never refused on a security gate**, although the design requires it ("never on security gates"). `override:` passes any entry condition, including a Review entry whose evidence failed `secrets` or `dependencies`. Refuse an override when the latest evidence's failing gates include a `security`-layer gate. |
| B13 | Active project cap | BUILT | `CardStore.activeProjectCap` ← [QUEUE] refusal, [SRV] project status | kernel/records | |

### `@sekhemet/planner`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| P1 | SPIDR decomposition | BUILT | [PLAN] `repoPlanner` (`codebaseMapFromRepo`) → `decomposeSpec` | planner/persistence, planner/impact_sketch, harness/wave2_wiring | The epic is still created as `in_progress`, a minor wart. |
| P2 | INVEST pre-flight | BUILT | `persistPlan` (rejected stories not created, ceilings parked, overlap serialised) | planner/persistence | |
| P3 | WSJF / RICE ordering | BUILT | `orderReadyCards` ← [PRELUDE] | planner/persistence, harness/wave2_wiring | |
| P4 | Estimation with write-back | BUILT | `EstimationModel.fromCards` (runner actuals) ← `persistPlan` | planner/persistence | |
| P5 | Difficulty scoring | BUILT | `scoreDifficulty` ← [PLAN], `pullThroughPlanning` | planner/persistence | |
| P6 | Difficulty routing | BUILT | `persistPlan` route → `wave2.ts` `roleForCard` ← [QUEUE] | planner/persistence, harness/wave2_wiring | |
| P7 | Edit-sketch cascade | BUILT | `sketchWithModel` (`plan --sketcher`) or template → dossier note → `dossierPromptLines` → [TURN] | planner/impact_sketch | |
| P8 | Assume / Ask / Spike | BUILT | `persistPlan` (`assumption/logged`, one batched decision, more than 3 questions rejects) | planner/persistence | |
| P9 | `DecisionRequest` shape | BUILT | `DecisionStore.request` ← `persistPlan`; [SRV] `/api/planner/decisions`, [W2 decide] | planner/persistence, harness/wave2_server | |
| P10 | `safe_default` / `default_deny` | BUILT | `DecisionStore.sweepDeadlines` ← [PRELUDE] | planner/persistence, harness/wave2_wiring | |
| P11 | Durable async HITL | BUILT | decision parks the card; answer resumes (`/api/decisions`, `sekhemet decide`) | planner/persistence, harness/wave2_server | |
| P12 | Six planner sessions | BUILT | intake [PLAN]; standup `/api/standup`; review `/api/cards/:id/review`; replan `replanOnRung3`; retro `learning/reflect.ts` `reflectWithManager` ← [QUEUE] | planner/persistence, harness/wave2_more | |
| P13 | Status from gate results | BUILT | `standupReport` ← [SRV] `/api/standup`, PM `/status` | planner/persistence, harness/wave2_server | |
| P14 | Escalation diagnostics | BUILT | `diagnoseEscalation` ← `explainCard`, [SRV] review | planner/persistence, harness/wave2_server | |
| P15 | Trust calibration (15% shift) | DEAD | `loadCalibrationLog` ← `repoPlanner` reads `assumption/outcome` events | planner/persistence | **Nothing in production writes `assumption/outcome`.** `recordAssumptionOutcome` has no caller: no CLI verb, route or dashboard action lets a person keep or override a logged assumption. The calibration therefore always starts empty and the 15% shift can never fire. Add `POST /api/assumptions/:id` (kept or overridden) and a CLI verb that call it. |
| P16 | Process profiles | SHALLOW | `processProfileFromConfig`, `ceremoniesDue` ← [PRELUDE] | planner/goals, harness/wave2_wiring | A due ceremony is only printed ("Ceremony due ..."). No retrospective, standup or review session runs from the profile's cadence. The design's functional retrospective (gate failures over the window → candidate rules) is not triggered by it. |
| P17 | `Goal` record | BUILT | `GoalStore` ← [W2 goal], [SRV] `/api/goals` | planner/goals, harness/wave2_server | |
| P18 | `/goal` intake, approval before running | BUILT | `intakeGoal`, `approveGoal` ← [W2 goal] | planner/goals, harness/wave2_wiring | |
| P19 | Goal loop and replan triggers | SHALLOW | `runGoalLoop` ← [PRELUDE] only | planner/goals, harness/wave2_wiring | Criteria are re-evaluated only when a queue pass starts, not "on every card close and on a timer". An accept, a park or the dashboard's minute tick does not re-evaluate goals. Call `runGoalLoop` from [ACCEPT] and the server's recurring tick. |
| P20 | Seven signals with thresholds | SHALLOW | `computeSignals`, `triggeredResponses` ← [PRELUDE]; [SRV] `/api/signals` | planner/goals, harness/wave2_server | Only `escalate_blockers` is acted on. `halt_aux_cards_and_ask` (scope drift over 20%: halt plus a decision request), `adjust_step_budgets`, `resplit_hotspot`, `backpressure_verify` and `dispatch_verification_spike` are printed and never executed. |
| P21 | Multiple goals, goal-level WSJF | BUILT | `rankGoals` ← [PRELUDE] ("Working goal X first: why") | planner/goals | |
| P22 | Honest stopping | BUILT | `goalVerdict` ← `runGoalLoop` | planner/goals, harness/wave2_wiring | |
| P23 | Board operations tool | BUILT | `pm/agent.ts` `PM_TOOLS` → `pm/apply.ts` ← [SRV] `/api/pm/*` | harness/pm | |
| P24 | Impact analysis over references | SHALLOW | `impact.ts` `analyzeImpact` ← `persistPlan` (dossier note) | planner/impact_sketch | `inferDependenciesByImpact` has **no production caller**. DAG inference in the queue is still `execute.ts` `inferDependencies`, which is text matching on scope-file names. The impact result is never used to declare scope or dependencies. |
| P25 | Approach previews | BUILT | `previewSketches` in `DecisionStore` requests → dossier and `/api/planner/decisions` | planner/persistence | |

### `@sekhemet/eval`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| E1 | Pass@1 benchmark harness | SHALLOW | `m0.ts` `runM0Protocol` → `benchmark.ts` `BenchmarkHarness` ← [W2 m0] | eval/wave2 | The benchmark drives `CardExecutionSessionImpl` directly, not `CardRunner`/`executeCard`, so fail-to-pass, pass@k, rebase, checkpoints and the builtin gates' runner wiring are not "the real harness". The M0 report has no valid-and-correct tool-execution rate and no 90% go/no-go verdict. |
| E2 | Git task synthesis | BUILT | `synthesizeTasksFromHistory` ← [W2 m0] | eval/wave2 | |
| E3 | Full-settings recording | BUILT | `candidateSettings` + `harnessCommit` → evidence `settings` ← `CardRunner.finish` | eval/wave2, loop/c_integration | |
| E4 | `MODEL_MATRIX.md` | BUILT | `writeBakeOffMatrix` ← `wave2.ts` `recordBakeOff` ← `bake-off` | eval/wave2 | |
| E5 | Frozen regression suite gating learning | SHALLOW | `runFrozenRegressionGate` ← `wave2.ts` `gateRuleOnFixtures` ← `improve --gate-rule` | eval/wave2, harness/wave2_more | Only a learned rule can be put through the frozen suite, and only when a person runs `improve --gate-rule` (approval is refused only if that run rejected it). Budget changes (`tune --apply`), skill and tool candidates, and prompt changes are never gated on the suite. The design enables each loop "only after beating a frozen baseline". |
| E6 | Qualification scoring | BUILT | `qualifyCandidates` ← [W2 qualify] | eval/wave2 | |
| E7 | Loop 1: playbook deltas | BUILT | `learning/reflect.ts` `learnFromAttempt` ← `executeCard`; `learnFromSendBack` ← [SRV] return | harness/learning | |
| E8 | Loop 2: budgets within 15% | BUILT | `BudgetPolicyStore.apply` ← `tune --apply` (`applyTunedPolicy`); rollback via `LearningGuard` | eval/wave2, harness/wave2_wiring | |
| E9 | Loop 3: prompt evolution | DEAD | `eval/src/loops.ts` `evolvePrompts`, `reflectiveMutator`, `paretoFront` | eval/wave2 | No production caller: `sekhemet improve` never runs prompt evolution, and `overnight` has no prompt-optimizer step. Wire it to an idle-hours command that proposes variants, scores them on the frozen suite, and pins a variant only on at least a +5% gain. |
| E10 | Loop 4: skill distillation | SHALLOW | `distillSkill` ← [W2 improve] | eval/wave2, harness/wave2_wiring | Writes `SKILL.md` only. The design's package also has `scripts/` and `evals/` (an eval card per skill), and a rollback path that deactivates the manifest. |
| E11 | Loop 5: exemplars | BUILT | `harvestExemplars` ← `executeCard` `learnFromOutcome` | eval/wave2, harness/runner_wiring | |
| E12 | Loop 6: task synthesis | BUILT | same as E2 | eval/wave2 | |
| E13 | Loop 7: variant archives | SHALLOW | `VariantArchive.add` ← [W2 improve] | eval/wave2, harness/wave2_wiring | The archive only records the current budget policy as a variant. Nothing samples a parent by performance to try a new variant, and there is no production variant pointer to restore. `configDistance` and the novelty selection are unused in production. |
| E14 | Loop 8: SIFT pre-filter | SHALLOW | `siftSlice` ← [W2 improve] (prints a slice) | eval/wave2 | `siftProposals`, the filter over proposed harness edits, has no production caller. Nothing filters a proposal before the full suite. |
| E15 | Loop 9: tool synthesis | SHALLOW | `mineToolProposals`, `validateToolProposal`, `writeToolCandidate` ← [W2 improve] | eval/wave2, harness/wave2_wiring | "Validation" runs the command once in the repo. It is not tested on a card with gates, and candidates go to `.sekhemet/tool-candidates`, not `scripts/`, with no delete-on-gate-failure rollback. |
| E16 | Loop 10: mutants to tests | BUILT | `mutation_step.ts` `mutateAcceptedCards` ← `improve --mutants`, `overnight` | eval/wave2, harness/mutation_step | |
| E17 | Guardrails and automatic rollback | BUILT | `LearningGuard.observe` (10-card window) ← `executeCard` `learnFromOutcome` | eval/wave2, harness/runner_wiring | |
| E18 | Self-modification exclusions | BUILT | `permissions.ts` `PROTECTED_SYSTEM_PATTERNS` ← [TOOL] | sandbox/permissions | |
| E19 | Doctor skill and playbook diagnostics | SHALLOW | `playbookDiagnostics` ← `doctor.ts` `runDoctor` | eval/wave2, harness/wave2_more | Net gain is observational (board cards with the rule versus without it), not measured against the frozen regression suite with a bare baseline. There is no significance test for the +3% threshold, and no one-keystroke retire from the doctor output. |

### `apps/harness`

| # | Unit | Status | Production caller chain | Tests | What is missing |
| --- | --- | --- | --- | --- | --- |
| H1 | `sekhemet daemon` | BUILT | `daemon.ts` `daemonStart/Stop/Status` (PID file, detach) → [SRV] with `/api/ws` | harness/daemon_ws | |
| H2 | `sekhemet board` opens the UI | BUILT | `index.ts` `board` → [SRV] + `open` / `xdg-open` | harness/harness | |
| H3 | `sekhemet calibrate` | BUILT | `calibrate_cmd.ts` `runCalibrate` | harness/calibrate_cmd | Its measurement depth is M13's. |
| H4 | `sekhemet run <card>` | BUILT | [RUN] | harness/control, harness/execute_events | |
| H5 | `sekhemet plan` | BUILT | [PLAN] | harness/wave2_wiring | |
| H6 | `sekhemet gate <card>` | BUILT | `index.ts` `gate` (card worktree, per-package gates, trailers, licences) | harness/cli_gate | |
| H7 | `sekhemet bake-off` | SHALLOW | `index.ts` `bake-off` → `run_gate.sh` → [QUEUE]; `recordBakeOff` | harness/wave2_wiring | The design's bake-off qualifies **and** benchmarks models **on the repo**. It runs no qualification suite, and it benchmarks a fixture rather than the repository (see M23). |
| H8 | `sekhemet replay [--as]` | BUILT | `replay.ts` (trajectories from step rows, `--diff`, `--as` fork and re-run) | harness/replay | |
| H9 | `sekhemet doctor` | BUILT | `doctor.ts` `runDoctor` ← CLI, [SRV] `/api/doctor`, MCP | harness/harness, harness/doctor_memory | |
| H10 | `sekhemet mcp` server | SHALLOW | `mcp.ts` `runMcpStdioServer` (12 tools) | harness/mcp | The design exposes workspace, boards, cards, gates, **evidence bundles and the model registry**. There is no evidence tool, no registry tool and no workspace or board-projection tool. A tool is still named `sekhemet_ask_merit` (the persona is now Seshat). |
| H11 | MCP client | SHALLOW | `mcp_client.ts` `McpHub` ← `research/cli.ts` (`sekhemet research`) only | harness/mcp_client | MCP tools reach only the CLI Researcher. The dashboard's research service, Seshat (the planner) and the Worker never receive them, and no tool budget in the Worker's catalog accounts for them, as the design requires ("budgeted and exposed to planner and executor"). |
| H12 | REST API (18 endpoints) | BUILT | [SRV] + `rest_extra.ts` (workspace, projects/:id/board and cards, split, run, gate, evidence, calibrate, rewind, decisions) | harness/rest_extra, harness/server | |
| H13 | TypeScript SDK | SHALLOW | `packages/sdk/src/index.ts` `SekhemetClient` | harness/sdk | No async iterator over the event log, which is what the design names. `events()` is a one-shot fetch, and `stream()` takes a callback. Add `async *eventsSince(seq)` over `/api/events` plus the WS stream. |
| H14 | ACP editor surface | SHALLOW | `acp.ts` `runAcpStdio` ← `sekhemet acp` (Seshat's chat) | harness/acp | The design's editor flow is: open a card, stream its steps, inspect gate results, approve or return. ACP offers only Seshat's chat and slash commands, and points proposals to the dashboard. There is no card session, step streaming, gate view, or accept/return from the editor. |
| H15 | `config.toml` chain | SHALLOW | `config.ts` `resolveConfig` + `config_apply.ts` (`queueDefaults`, `reviewLimit`, network mode) | harness/config_apply | `[context] working_budget`, `map_tokens`, `mask_after_observations` and `[loop] stall_window`, `max_rungs` are parsed and ignored (the session hard-codes a map budget of 1200, stall threshold 3 and the ladder). No card ever supplies `configOverrides`, so the card layer is never used. |
| H16 | Slash commands | SHALLOW | `pm/slash.ts` ← [SRV] PM chat, ACP | harness/slash | The design's `/onboard`, `/split`, `/retro`, `/bake-off` and `/goal` are missing. There are no user-defined Markdown templates (`.sekhemet/commands/*.md`), and the commands cannot be invoked from the CLI. |
| H17 | Session resume from the log | BUILT | `CardRunner.resumePoint` / `replayHistory` ← `sekhemet resume`, [QUEUE] | harness/control, loop/runner_depth | |
| H18 | Fork at step N | BUILT | `execute.ts` `forkCard` ← `sekhemet fork`, [SRV] `/api/cards/:id/fork`, `replay --as` | harness/control | |
| H19 | Rewind to step N | BUILT | `rewindCard` ← `sekhemet rewind`, [SRV] `/api/cards/:id/rewind` | harness/control | |
| H20 | Notifications (ntfy / Gotify) | BUILT | `notify.ts` notifier ← [SRV], [QUEUE] | harness/notify | |
| H21 | Idle / overnight scheduler | SHALLOW | `overnight.ts` `runOvernight` ← `sekhemet overnight` | harness/overnight | The design's nightly jobs include a full vulnerability scan and the prompt optimizer. Neither runs: osv-scanner runs only per card, and E9 is dead. Uncommitted work on `overnight.ts`/`overnight.spec.ts` was in progress during this audit and was not scored. |
| H22 | OpenTelemetry spans | SHALLOW | `tracing.ts` `Tracer` / `traced` ← `executeCard`; `sekhemet traces` | harness/tracing, harness/execute_events | Spans exist for the card, each turn and each model call, but there is **no tool span per call**, and spans are not viewable in the UI, only through the CLI. Uncommitted edits to `tracing.ts` and `server.ts` were in progress and were not scored. |
| H23 | Compute governance | BUILT | `governance.ts` (kWh from TDP, breakers) ← `overnight.ts`; `compute/*` ledger events | harness/overnight | |
| H24 | Reproducibility record | SHALLOW | `repro.ts` `buildReproRecord` ← `executeCard` `recordReproducibility` | harness/repro, harness/execute_events | The **chat-template checksum** (pinned in the registry by M12) is not in the record. `promptSha` hashes the constant Zone-1 text, not the prompt-set version (C21's context version). Engine settings (KV type, cache flags, MTP) are left to the evidence's `settings`, not the record. |
| H25 | Offline installers and first-run wizard | SHALLOW | `init.ts` `runInit` ← `sekhemet init`; `scripts/install.sh` | harness/init | `install.sh` builds from source and needs either the network or a pre-filled pnpm store. There are no packaged per-platform installers (macOS arm64, Linux x86_64 and arm64), and no language servers are vendored. |
| H26 | Memory daemon, 2 s poll | BUILT | `MemoryWatchdog` (2 s) ← [QUEUE] | models/watchdog | |
| H27 | Restricted-mode wiring | BUILT | see S12 | loop/restricted | |

## Gaps to close, ranked

Ranked by what they cost the benchmark runs first (Chronicle and the Showcase Trifecta), then by how much of the design they leave hollow. Size: **S** is under a day, **M** is a few days, **L** is a week or more.

| Rank | Unit(s) | Status | What to do | Size |
| --- | --- | --- | --- | --- |
| 1 | C19 | SHALLOW | Turn on `progressiveTools` for the Worker in `executeCard`. Every turn currently carries every schema. | S |
| 2 | C5 | SHALLOW | Assert the system-zone (under 1k) and tool-interface (under 2k) budgets in `buildWorkerPrompt`, and test them on the live 30-tool catalog. The only assertion is in dead code. | S |
| 3 | M8 | SHALLOW | Enable `constrainedToolCalls` per model from the measured arm or config. Arm A is never used in production. | S |
| 4 | L13, H15 | SHALLOW | Stall threshold 2 and A-B-A oscillation per the design. Make `[loop] stall_window`, `max_rungs` and `[context] map_tokens` drive the session. | S |
| 5 | L22, B2 | SHALLOW | Park on budget exhaustion with a diagnosis. Send gate-failing cards Verify → Planning, per the state machine. | S |
| 6 | Y6 | SHALLOW | Rebase conflicts back to In Progress with the hunks as typed `GateFailure`s; park out-of-scope conflicts. | S |
| 7 | M19, M24 | SHALLOW | Call `calibrateSpeculative` from `sekhemet calibrate` and read `profile.engine` at launch. Both decisions are measured and never applied. | S |
| 8 | G11, K19 | SHALLOW | Put `structuralDiff`, `summary {passedChecks, failedChecks, abandonedHypotheses}`, `attemptId` and a hash-based `trajectoryRef` in the bundle and its table row. | S |
| 9 | E1 | SHALLOW | Run M0 through `CardRunner` and report the tool-execution validity rate with the 90% go/no-go verdict. | M |
| 10 | M23, H7 | SHALLOW | Bake-off on tasks synthesized from the repo's history (reuse `synthesizeTasksFromHistory`), plus the qualification suite per candidate. | M |
| 11 | P15 | DEAD | Add a route and CLI verb that record an assumption as kept or overridden (`recordAssumptionOutcome`). | S |
| 12 | E9 | DEAD | Wire prompt evolution into an idle-hours command gated on the frozen suite (+5%), and add it to `overnight`. | M |
| 13 | G21 | MISSING | Vision checklist sub-gate over visual snapshots, using X3's vision model. It can fail a card and never pass one. | M |
| 14 | B12 | SHALLOW | Refuse overrides past failing security-layer gates. | S |
| 15 | K12 | SHALLOW | Emit `playbook/propose` from `LearningStore.propose` and honour a block. | S |
| 16 | K9, K10 | SHALLOW | Resolve the core services through the container, and let plugins contribute tools, gates, sync adapters and panels that the runner and server actually read. | M |
| 17 | K16, K17, K23 | SHALLOW | Add `rung` and `tool_arm` to attempts and write `repo_state_hash` on steps. Add a real-file test for `busy_timeout`. | S |
| 18 | S10, G15 | SHALLOW | PyPI and crates lookups (and mirrors) for new dependencies, plus a download-profile floor. | S |
| 19 | G6, G13, G27, C1 | SHALLOW | Close the non-TypeScript gaps: parse gate, mutation, templates (format and mutation gates, pytest and cargo parsers) and the ranked repo map for Python, Rust and Go. | L |
| 20 | Y16 | SHALLOW | Review threads → repair subtasks → `resolveThread`; merge-queue awareness. | M |
| 21 | Y7, Y18, Y19, Y17 | SHALLOW | Re-verify restacked children; `act` as a declarable gate kind; per-package gates in card verification and `splitAcrossRepos`; publish the GitHub Release. | M |
| 22 | P19, P20, P16, P24 | SHALLOW | Re-evaluate goals on card close and on the server tick; execute the signal responses; run ceremonies from the profile; use `inferDependenciesByImpact` for the DAG. | M |
| 23 | E5, E10, E13, E14, E15, E19 | SHALLOW | Gate every learning loop on the frozen suite; package skills with scripts and evals; sample and restore archive variants; wire `siftProposals`; validate tool candidates on a card; net gain against the suite. | L |
| 24 | C9, C10, C20, C21 | SHALLOW | Skill tool requirements, evals and gates; reject skills touching protected paths; per-step cache hit rate and per-card context metrics; invalidate qualification on a context-version change. | M |
| 25 | G1, G3, G8, G16, G18, G19, G20 | SHALLOW | Parse `schedule` and `threshold`; runs-on per layer; topological failure order; bundled Semgrep rules; overlap predicate; snapshot masking and animation off; axe-core. | M |
| 26 | L4, L20 | SHALLOW | Image and PDF reads to the vision path; interactive `browse` (click, type, accessibility tree, screenshots) over the existing CDP client. | M |
| 27 | M13, M14 | SHALLOW | Measure usable memory and bandwidth, sweep batch size and offload; apply the tier's context, parallel cards and co-loading. | M |
| 28 | H10, H11, H13, H14, H16 | SHALLOW | MCP evidence and registry tools; MCP tools for Seshat and the Worker; SDK async iterator; ACP card sessions; the missing slash commands and Markdown templates. | M |
| 29 | H21, H22, H24 | SHALLOW | Nightly vulnerability scan and prompt optimizer; tool spans and a UI trace view; template checksum and context version in the record. Re-check after the in-flight edits land. | S |
| 30 | S3, S14, C3, H25 | SHALLOW | Landlock, copy-on-write worktrees, a model-backed pruner and packaged offline installers. Each could instead be signed off as a substitution by the user. | L |
