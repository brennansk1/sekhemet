# Domain 6: Gates and definition of done (Phase A review)

Read-only review at `7944e9f`. "Reproduced" means I ran it in a scratch repository under the scratchpad against `dist/` compiled from this source. The three project-gate specs pass (23 tests; I ran them).

## Part 1

### 1. Positioning: would a professional team trust these gates?

The core would earn trust. Specifically: the runner executes declared commands in the sandbox (`runner.ts:142-186`); `gates.toml` is re-verified by hash on every run (`config.ts:225-231`); failures inside protected tests are redirected to the implementation (`runner.ts:269-280`); and bounds are exact (`runner.ts:40-88`). **The pipeline around that core would not earn it yet.** It has more false positives of the same kind as `.gitkeep` and the staged-test secret, plus several fail-open paths.

**False positives (the gate fails correct work):**

| # | Finding | Evidence |
|---|---|---|
| F1 | The architecture gate treats `import { type X }`, comments, and local variables as a second definition. Its own remedy, "import it from its home", can trip it. **Reproduced.** | `architecture_gate.ts:85-90` |
| F2 | The reachability gate ignores `export * from` barrels and `import * as ns` namespace uses. A new export used as `ns.b` and re-exported from `index.ts` is flagged as dead. **Reproduced.** | `reachability_gate.ts:77-114` |
| F3 | The changelog check requires an edit to `CHANGELOG.md`. Nothing in the planner or the loop puts that file in scope, so every source card in a project that keeps a changelog can never pass. This is the same shape as run 5. | `builtin.ts:927-946`; the grep for CHANGELOG in planner, loop and harness finds nothing |
| F4 | osv scans the whole lockfile and gitleaks scans whole files. Both judge what `main` already holds, which is the `.gitkeep` class. | `builtin.ts:804-852`, `194-243` |
| F5 | `sekhemet gate <card>` builds its own pipeline. It passes no `harnessOwned`, so the run-5 false positive is still live on the path people use. It also skips the reachability, regression and architecture gates, so it can disagree with the card's own verdict. | `index.ts:709-814` vs `session.ts:1704-1717` |
| F6 | Some remedies are dead ends. The blocking-mutation remedy says "Add a test", but implementers are denied test writes. Reachability and architecture say "say so with note", but `note` does not clear the gate. | `builtin.ts:1141`; `permissions.ts:303-317`; `session.ts:1394` |

**False negatives (the gate passes what it should fail):**

| # | Finding | Evidence |
|---|---|---|
| F7 | `runBuiltinGates(...).catch(() => undefined)`: any exception silently drops the secrets, dependencies, hygiene and visual layers, with no failure and no outcome recorded. | `session.ts:1704-1718` |
| F8 | osv and semgrep crashes with empty stdout parse as `"{}"` and count as a pass. For gitleaks, the comment says an unparseable report "is still a finding", but the catch does nothing. | `builtin.ts:815`, `865`, `239-241` |
| F9 | The red-first check calls a card vacuous only if the *whole* run passes, so any other failure hides a vacuous acceptance test. Cards without `acceptanceTests` skip the check entirely, and planner-persisted cards set only `acceptanceCriteria`. Staging only copies from `acceptance/`. On planner-made cards the spec tells the Worker to "write acceptance tests first", which it is denied. **DoD §5.1 is enforced only on suite fixtures.** Confirm with domain 7. | `card_runner.ts:772-786, 855-857`; `persist.ts:185, 239-244`; `execute.ts:511-525` |
| F10 | Every project gate hard-codes `main`. On a `master` repository, git fails and the gates judge nothing. | `reachability_gate.ts:165`, `regression_gate.ts:88`, `architecture_gate.ts:120`, `trailer_gate.ts:44`, `index.ts:752` |
| F11 | The project gates list files with `git diff --name-only`, which skips untracked files. They also run before `git add -A`. Uncertain: checkpoints may usually commit first. | `session.ts:1642` vs `1651`; `reachability_gate.ts:117-131` |
| F12 | `pnpm release-gate --skip-gate` records rungs 1–5 as passed and prints "Releasable". Rung 4's "0 skipped" is never checked. | `release_gate.mjs:35-37, 136-139` |

**Repair-contract defects:**

- **F13, reproduced on vitest 3.2.7 output:** one failing test becomes two failures. The `×` line gives `location.file = "ledger"` (the describe name) and `-t "appends 3ms"`. **Both `minimalRepro` commands select zero tests and exit 0.** Evidence: `parsers.ts:348-393`.
- **F14:** the top-three cap exists only inside `DeterministicGateRunner` (`runner.ts:286`). Built-in failures are *prepended* (`session.ts:1724`), the wrappers append more, and `check` renders all of them (`session.ts:420`). The result: a changelog or secrets failure can outrank a failing test, which is the ranking bug from Chronicle run 5 coming back.
- **F15:** the fallback remedy for TS2305 is still "Read the module and use its actual export" (`parsers.ts:108`). That is the exact loop documented in SUITE_RUNS run 1; it still fires for non-relative imports. TS2304 and TS2353 have similar remedies.
- **F16:** the Python, Rust and Go templates use the `generic` parser (`templates.ts:105-129`). That parser sets no location, so the regression gate never restates their failures. Reachability and architecture only read `.ts` files.

### 2. Drift

| Design says | Code does |
|---|---|
| Gate economics: run impacted tests first, cache verdicts by content hash, order gates by cost. Written as fact. | None of it exists. Gates run in config order, and a grep for impacted-test or cache logic finds nothing. |
| A suspected-wrong gate stops the card with its own stop reason. | `CardStopReason` has no such member (`kernel/src/types.ts:41-71`). |
| An unavailable gate is "stated … never silently skipped". | Violated by F7 and F8. `gates.toml` has no way to declare what a gate needs. |
| "New or changed baselines always require human approval." | `baselineApproval` defaults to `"auto"` (`visual.ts:78`). |
| Visual checks use Playwright, pixelmatch and axe-core. | The code uses its own CDP client, PNG decoder and an axe-style subset. That is a reasonable choice, but the design does not say so. |
| EvidenceBundle has `artifacts`, `structuralDiff` and `abandonedHypotheses`. | None of these fields exist (`evidence.ts:32-63`). |
| `GateFailure` fields are required; the §7 interfaces are `IGateRunner(worktree, config, layers)`, `registerParser` and an async `compile`. | Fields are optional (`types.ts:23-46`), and none of the three interfaces match the code. |
| The security layer runs on the gate host. | Built-in and project gates run in the harness process even when `[gate_host]` is set (`execute.ts:322-341`). |
| At most three failures per repair attempt. | Violated by F14. |

One section is honest: surfacing unenforced invariants is correctly marked [DESIGN]. The list is computed and then discarded (`architecture_gate.ts:101`).

### 3. Dead and duplicated code

- **Legacy or unreachable:**
  - `parser.ts` (`parseErrorToGateFailure`) is used only by `eval/verifier.ts:166` and the legacy `gates.spec.ts`. It duplicates `genericParser`.
  - The `npmRegistry` alias (`builtin.ts:665`).
  - `FailureParserRegistry.register`, which nothing in production calls.
  - The barrel (`index.ts`, `export *` of 11 modules) leaks about 60 exports that nothing outside the package uses.
- **Import/export parsing, eight or more regex variants:**
  - `parsers.ts:141`
  - `reachability_gate.ts:77`
  - `architecture_gate.ts:76, 85`
  - `loop/symbols.ts:165`
  - `loop/tools.ts:193`
  - `loop/api_surface.ts:174-190`
  - `loop/repo_map.ts:89`
  - `context/pruner.ts:74`

  Meanwhile `builtin.ts` already imports `typescript`, which is also a **phantom dependency**: it is not declared in `packages/gates/package.json`.
- **Three test-file regexes that disagree:** `builtin.ts:894`, `reachability_gate.ts:45`, `regression_gate.ts:27`.
- **Two added-line diff walkers:** `builtin.ts:109` and `secrets.ts:131`.
- **Two mutant generators:** `builtin.ts:1008` and `eval/mutation.ts:40`.
- **Two trailer checks:** built-in hygiene (`builtin.ts:947-978`) and `trailer_gate.ts`.
- **The gate pipeline is assembled in five places:**
  - `runner.ts`
  - `session.ts:1641-1730`
  - the `execute.ts:322` wrappers
  - `index.ts:709` (the CLI)
  - `execute.ts:1049` (rollup)
- **The card's own tests are identified three ways:**
  - `tests/${t}` (`session.ts:1711`, `card_runner.ts:1514`)
  - a conditional prefix (`session.ts:1647`)
  - basename only (`reachability_gate.ts:177`, `regression_gate.ts:91`)
- **Five `with*Gate` wrappers** repeat the same merge code.

### 4. Complexity hotspots

- **`builtin.ts`, 1,161 lines, eight concerns:**
  - diff parsing
  - secrets glue
  - network clients for five registries
  - four manifest parsers
  - osv and semgrep adapters
  - hygiene
  - mutation, which rewrites the worktree in place
  - orchestration
- **`visual.ts`, 636 lines:** CDP client, PNG decoder, pixel diff, accessibility script, app launcher and orchestration.
- **`parsers.ts`, 507 lines:** it mixes parsers with remedy knowledge. `typeMembers` (`:269-304`) finds type members by counting braces across `node_modules` `.d.ts` files, which is a job for the TypeScript compiler API.
- **`session.ts` verify:** about 150 lines of gate composition living in the loop package.

### 5. Test quality (DEFINITION_OF_DONE §2)

**Strong:**
- real subprocesses (`protected_redirect.spec`)
- real mutual TLS (`gate_host.spec`)
- real git in the project-gate specs
- exact bounds edges (`bounds.spec`)
- the tamper refusal (`config.spec`)

**Gaps:**
- There is **no test of `vitestParser` against real vitest output**, which is why F13 went unnoticed. `gates.spec.ts` tests the legacy parser instead.
- Nothing covers barrels, namespace imports, `import { type X }`, changelog versus scope, whole-lockfile osv, the built-in-exception fail-open, a non-`main` base, or CLI/card parity.
- Only the regression wrapper is tested. The five-gate composition in `execute.ts` is not.
- The negative-to-happy ratio for gates is about 0.6, against the DoD target of 2.

### 6. Senior judgement, ranked

1. Build **one pipeline that fails closed**, with a single ranking-and-cap step at the end (F5, F7, F8, F14).
2. **Judge only what the card wrote**, and never demand an edit the Worker cannot make (F3, F4, F6).
3. Put the project gates on **the TypeScript AST** instead of regexes (F1, F2, the duplication).
4. **Golden-test every parser on real tool output** (F13, F15, F16).
5. **Enforce red-first for every card**, judged on the acceptance tests' own results (F9).
6. Make the design match the code: mark gate economics and the suspected-wrong-gate stop reason as [DESIGN], and default visual baselines to human approval.
7. Harden the release gate so it cannot print "Releasable" after skipping rungs (F12).

### 7. Verdict per file

| File | Verdict | Reason |
|---|---|---|
| `runner.ts` | keep | Judge by outcome; let non-blocking gates in a requested rung stay non-blocking. |
| `parser.ts` | cut | Duplicates `genericParser`. |
| `parsers.ts` | refactor | Split out the remedies, fix vitest, move type-member lookup to the TS API. |
| `config.ts` | keep | Warn on an unknown rung or parser instead of silently mapping it to `test` / `generic` (`:106`, `:119`). |
| `types.ts`, `gate_host.ts`, `secrets.ts` | keep | `secrets.ts` should share one diff walker with `builtin.ts`. |
| `evidence.ts` | keep | Add an `unavailable` reason, artifacts, and abandoned hypotheses. |
| `builtin.ts` | refactor | Split into supply-chain, scanners, hygiene and mutation (reusing eval's generator); fail closed; diff-scoped. |
| `visual.ts` | refactor | Split out the CDP client and PNG code; default baselines to `human`. |
| `templates.ts` | keep | Add pytest, cargo and go parsers. |
| `index.ts` (gates) | refactor | Replace the barrel with explicit exports. |
| `reachability_gate.ts` | rebuild the core | Keep the policy (it is good); rebuild the parsing on the AST. |
| `regression_gate.ts` | keep | Shared own-tests identity; configurable base branch. |
| `architecture_gate.ts` | refactor | AST-based definition check; surface unenforced lines. |
| `trailer_gate.ts` | keep | Remove the duplicate trailer check from built-in hygiene. |
| `execute.ts` gate wiring | refactor | Move into the pipeline. |
| `release_gate.mjs` | keep | Fix `--skip-gate`; check skipped tests and a clean tree. |

### Top 5 changes

1. **One gate pipeline in `@sekhemet/gates`**
   - **What:** One `GatePipeline` covering declared gates, bounds, integrity, built-ins and project gates. Rank and cap once at the end. Any exception or scanner crash becomes an `unavailable` outcome that blocks.
   - **Why:** F5, F7, F8, F14; the pipeline is built in five places today.
   - **Effort / risk:** M. Risk: cards that currently pass silently may start failing, so land it behind the seeded-fixture check.
   - **Measured by:** the CLI and the card run give identical verdicts on every fixture; at most three failures are delivered; every seeded fixture passes with no card changes.
2. **Diff-scoped judgement**
   - **What:** osv reports only findings new relative to the base; gitleaks runs on added lines only; the changelog check is advisory unless `CHANGELOG.md` is in scope; one `ownTests()` function; a configurable base branch.
   - **Why:** F3, F4, F10; this is the documented false-positive class.
   - **Effort / risk:** S–M. Low risk.
   - **Measured by:** new negative tests for each case; zero gate-caused failures in the next suite run.
3. **An AST-backed source index**
   - **What:** One TS-compiler module answering what a file exports, what it imports (including `export *`, namespaces and `type`), and where it declares things at top level. Reachability, architecture, the `parsers.ts` exports, and the loop's `symbols` and `api_surface` all use it.
   - **Why:** F1, F2, and eight or more duplicate regex parsers.
   - **Effort / risk:** M. Risk: a behaviour shift in the loop's tools, so migrate the gates first.
   - **Measured by:** the reproduced false positives become tests; run the reachability gate over Sekhemet itself (Rule 3) and review what it reports.
4. **Repair contracts proven on real output**
   - **What:** Golden fixtures captured from real tsc, vitest, biome, pytest, cargo and go runs. Vitest parsed via `--reporter=json`, with a `minimalRepro` that selects the failing test. The last "go and read" remedies removed. `note` on a gate failure parks the card as `gate_suspected` for a person.
   - **Why:** F6, F13, F15, F16, and the design's one-step rule.
   - **Effort / risk:** S–M. Low risk.
   - **Measured by:** each failure's repro exits non-zero and selects at least one test; zero duplicate failures per test.
5. **Red-first on every card**
   - **What:** Planner cards carry acceptance-test *files*, staged by a test-author step. The red check reads the acceptance tests' own results. A behaviour card with no staged test cannot start.
   - **Why:** F9. Without this, "the model never certifies its own work" holds only on fixtures.
   - **Effort / risk:** L, spanning domains 3 and 7. Risk: slower planning.
   - **Measured by:** the share of cards with a verified red (target 100%), and the planning measure.

## Part 2: DEFINITION_OF_DONE audit

### a. §2C trivial assertions

There are 29 uses of `toBeDefined()` / `toBeTruthy()` and 11 of `toBeInstanceOf()`. I classified each by its enclosing `it` block.

| Only trivial assertions in the block | Note |
|---|---|
| `models/tests/router_swap.spec.ts:45` | `rejects.toBeInstanceOf(SwapHeadroomError)`: a typed-rejection negative test. It breaks the letter of §2C but is meaningful; add a message check. |
| `models/tests/adapter_contract.spec.ts:224` | Same pattern. |
| `ui/tests/icons.spec.ts:45` | A `toBeTruthy` loop. Weak, although the next test checks the icons' shape. |
| `apps/harness/tests/sdk.spec.ts:87` | `toBeDefined` on a predicate `find`. Rewrite it as `toMatchObject`. |

**Vanity line:** `models/tests/registry_calibration.spec.ts:340`, `expect(new MockInferenceAdapter("x")).toBeDefined()`, is always true. Delete it.

**Alongside exact assertions** (acceptable; tighten when touched):
- board `board.spec:147`
- context `context_units:125`, `tool_output_evidence:106`
- eval `eval.spec:130`
- loop `c_integration:384`, `tools_wave2:156`, `paths:69`, `tools_depth:156`
- models `qualification_schedule:269`, `registry_calibration:340`, `adapter_contract:263`, `launch_profiles:138, 146`
- planner `planner:15`, `persistence:56, 85, 205`
- ui `vocabulary:117`, `pm:99`
- harness `mcp:46`, `runner_wiring:201`, `wave2_more:190`, `forecast:12`, `wave2_wiring:65, 68, 114, 242`, `wave2_github:82`, `reuse_survey:191`, `learning:245`, `config_apply:87`, `pm:120`, `sdk:65`, `wave2_server:111`, `server:165, 210`

### b. §2A real infrastructure

| Package | Status |
|---|---|
| kernel | Compliant. Every storage spec uses on-disk WAL via `tests/support/disk_db.ts`; `hooks.spec` has no database. Tamper tests: `log.spec:42`, `blobs_retention:39`. |
| board | Compliant. Real WAL files (`board.spec:18`, `entry_conditions`, `runner_backpressure`). |
| sandbox | Compliant. Real subprocesses; SIGTERM-ignoring process killed (`containment.spec:115-130`). |
| sync | Compliant. Real `createWorktree` and `refs/sekhemet/checkpoints` (`sync.spec:71-99`, `git_wave2`). `remote.spec` fakes GitHub HTTP, which is acceptable. |

**Violation risk:** several confinement tests are platform-gated with `it.runIf(darwin)` (`containment.spec:52, 66, 77, 175`, `egress.spec:67`), and `visual.spec:87` requires Chrome. On Linux, or without Chrome, they skip, which conflicts with rung 4's "0 skipped". Nothing checks for it.

### c. §2B negative to happy-path ratio

This is a heuristic based on negative wording in test titles. It undercounts negatives asserted inside happy-path tests.

| Package | Tests | Negative | Happy | Ratio (target ≥ 2) |
|---|---|---|---|---|
| sandbox | 38 | 16 | 22 | 0.73 |
| loop | 199 | 81 | 118 | 0.69 |
| gates | 55 | 21 | 34 | 0.62 |
| board | 16 | 6 | 10 | 0.60 |
| sync | 31 | 11 | 20 | 0.55 |
| kernel | 43 | 14 | 29 | 0.48 |
| context | 70 | 22 | 48 | 0.46 |
| apps/harness | 414 | 127 | 287 | 0.44 |
| eval | 37 | 11 | 26 | 0.42 |
| ui | 84 | 23 | 61 | 0.38 |
| planner | 40 | 10 | 30 | 0.33 |
| models | 124 | 30 | 94 | **0.32** |

**No package meets 2:1.** The clearest shortfalls are models, planner, ui and eval. Either the owner makes the rule risk-based (security, kernel and gates first), or it is aspirational and should be recorded as such.

### d. §3A path confinement: confirmed

- **Code:** `loop/src/paths.ts:68-82` resolves the real path of the nearest existing ancestor (closing symlink escapes). It rejects NUL bytes, `../`, and absolute paths outside the worktree.
- **Coverage:** every file tool resolves through it (`tools.ts:233-1289`), and `PathEscapeError` becomes a `denied` observation (`tools.ts:480`).
- **Tests:**
  - `paths.spec.ts:34-50`: every `../` spelling, `/etc/passwd`, absolute paths inside the worktree allowed
  - `paths.spec.ts:53`: symlink
  - `paths.spec.ts:60`: NUL byte
  - `paths.spec.ts:81`: sibling-prefix directory
  - `tool_executor.spec.ts:29-35`: the `read_file` denial
- **Gap:** there is no tool-level traversal test for `write_file`, `edit`, `replace_lines` or `read_symbol`. They share the same resolver, so this is a coverage gap, not a known hole.
