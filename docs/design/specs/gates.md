---
spec: gates
status: partial
audiences: [developer, beginner]
code:
  - packages/gates/src/runner.ts
  - packages/gates/src/config.ts
  - packages/gates/src/parsers.ts
  - packages/gates/src/builtin.ts
  - packages/gates/src/secrets.ts
  - packages/gates/src/visual.ts
  - packages/gates/src/evidence.ts
  - packages/gates/src/gate_host.ts
  - packages/gates/src/templates.ts
  - apps/harness/src/reachability_gate.ts
  - apps/harness/src/regression_gate.ts
  - apps/harness/src/architecture_gate.ts
  - apps/harness/src/trailer_gate.ts
  - apps/harness/src/license_gate.ts
  - packages/loop/src/card_runner.ts
  - packages/loop/src/integrity.ts
tests:
  - packages/gates/tests/gates.spec.ts
  - packages/gates/tests/config.spec.ts
  - packages/gates/tests/bounds.spec.ts
  - packages/gates/tests/builtin.spec.ts
  - packages/gates/tests/protected_redirect.spec.ts
  - packages/gates/tests/remedies.spec.ts
  - packages/gates/tests/supply_chain.spec.ts
  - packages/gates/tests/visual.spec.ts
  - packages/gates/tests/gate_host.spec.ts
  - apps/harness/tests/reachability_gate.spec.ts
  - apps/harness/tests/regression_gate.spec.ts
  - apps/harness/tests/architecture_gate.spec.ts
  - apps/harness/tests/trailer_gate.spec.ts
  - apps/harness/tests/cli_gate.spec.ts
  - packages/loop/tests/integrity.spec.ts
changes: [T1, T2, M6, P1, NEW-gates-1, NEW-gates-2, NEW-gates-3, NEW-gates-4]
---

# Gates: the definition of done

## 1. Purpose

Gates are how Sekhemet knows a card is done: declared, executable checks that the Worker cannot edit, run against what the card wrote, with failures returned in a shape a small model can act on. They are the first spine rule made concrete — **gates decide completion; the model never certifies its own work** — and they teach a beginner the professional definition of done: tests first, a small diff, nothing broken that already worked, and evidence a reviewer can read.

## 2. Behaviour

### What "done" means

1. A card may enter Review only when every blocking gate passed on its latest attempt and an evidence bundle exists ([kernel.md](kernel.md) holds the entry condition). A person then accepts it ([review-git.md](review-git.md)).
2. The gates are declared per project in `.sekhemet/gates.toml`. The Worker can never write it, nor any path matching `protected`. Its SHA-256 is pinned when a card starts and re-checked before every verification; a change aborts the run with `GatesConfigTamperError`.
3. The gates run in layers:

   | Layer | Checks |
   | --- | --- |
   | Static | Parse, format, lint, typecheck |
   | Functional | Unit, integration and end-to-end tests; the card's acceptance tests, written before implementation |
   | Robustness | Diff-scoped mutation score, coverage delta |
   | Security | Secret scan, dependency existence, typosquat and allowlist, vulnerability scan, static analysis |
   | Visual | Console and network errors, layout bounds, element screenshot diff, accessibility, a vision checklist that can only fail |
   | Hygiene | Changelog entry when in scope, no debug output, commit trailers |
   | Human | Review of the evidence bundle |

4. A security-layer failure is never overridden, by anyone ([kernel.md](kernel.md) rule 22).

### Acceptance tests come first (red-first)

5. Every card that changes behaviour carries acceptance-test files, staged into its worktree before the first turn. A planner-made card gets them from a test-author step ([planner-pm.md](planner-pm.md)); a card with none cannot start.
6. Before any work, the runner runs the acceptance tests on the untouched code and judges **their own results**: the card is red only if its acceptance tests fail. A types-only (`interface`) card is red on the test runner *or* the typechecker, because `import type` and `expectTypeOf` erase at runtime. If the acceptance tests already pass, the card stops with `vacuous_tests`, naming them.
7. The Worker cannot edit acceptance tests or anything matching `protected`. A failure located inside a protected test is redirected to the implementation it exercises; the protected file is never offered as the place to fix it.

### One pipeline

8. Every gate — declared, bounds, config integrity, built-in layers and project gates — runs through one pipeline with one result shape, and the pipeline ranks and caps failures **once, at the end**. The card run, `check`, `sekhemet gate <card>`, rollup, MCP's `sekhemet_run_gates` and the gate host all use it, so they give the same verdict on the same tree.
9. **Fail closed.** A gate that throws, crashes, times out without a result, or produces output its parser cannot read is an `unavailable` outcome, never a pass. An unavailable blocking gate blocks Review on its layer, and the evidence bundle states it with its reason: a card that passed four gates because two could not run must not look like a card that passed six.
10. A gate declares what it needs to run (a service, a port, credentials); the gate host provides it or marks the gate unavailable.
11. The pipeline runs on a separate gate host when `[gate_host]` names one (mutual TLS), including the built-in and project gates; otherwise in this machine's sandbox ([security.md](security.md) owns confinement, including the visual gate's dev server).
12. **Bounds.** A card's diff may touch at most `max_files` files (default 3) and `max_diff_lines` changed lines (default 200), exactly.
13. **Integrity.** Passing a gate by switching it off is a failure: on the lines the card added (staged acceptance tests excluded), the integrity gate refuses `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error`, `as any` and `: any`, lint suppressions (`biome-ignore`, `eslint-disable`), skipped tests (`.skip`, `.todo`, `xit`), focused tests (`.only`, `fit`) and vacuous assertions (`expect(true).toBe(true)`), each with the honest fix.
14. **Autofix before judging.** Formatter and style-fix commands declared in `autofix`, `style_fix` and `style_fix_rules` run on the card's changed files before the static gates (never in restricted mode), so formatting alone never fails a card.

### Judge what the card wrote

15. Every gate judges the card's change, never what the base branch already held: secrets are scanned on added lines only, excluding the acceptance tests the harness staged; vulnerability findings are reported only when new relative to the base; static analysis and mutation are scoped to the diff; project gates judge only files the card changed, including untracked files.
16. The base is the project's integration branch as configured, never a hard-coded `main`; outside a git repository, a diff-based gate judges nothing rather than guess.
17. A gate never demands an edit the Worker cannot make. A changelog entry is required only when `CHANGELOG.md` is in the card's scope (advisory otherwise); a remedy never tells an implementer to add a test it is denied from writing.
18. **A wrong gate.** When the Worker believes a gate is wrong, or encodes an assumption the card is changing, it says so with `note` naming the gate and the reason; the card stops with `gate_suspected` and parks for a person to decide. Grinding repair rungs against such a gate, or working around it, is exactly what gates exist to prevent.

### The repair contract

19. Every failure reaches the model in one shape, `GateFailure`: `gate`, `location` (`file:line` or `file#test`), `expected`, `actual` (truncated), `minimalRepro` (the exact command) and `suggestedAction` — all present. Raw logs stay in the evidence bundle, retrievable by reference.
20. At most three failures go to the model per repair attempt, chosen in dependency order (parse, typecheck, test, bounds, lint; within a rung, the most-referenced file first), because fixing the first often clears the rest. The cap is applied once, after every gate has reported.
21. **A remedy is completable in one step.** The failure carries the information its action depends on: a missing export lists the module's real exports and says there is no need to read the file; an unknown member lists the type's real members, from the project's types and from Node's, wherever the package manager keeps them; a regression failure carries the broken test's content from the base so restoring it is one write.
22. A `minimalRepro` selects the failing test and exits non-zero when run. One failing test is one failure.
23. Each parser is tested against captured output of the real tool: `tsc`, `vitest` (JSON reporter), `biome`/`eslint`, and — for the Python, Rust and Go templates — `pytest`, `cargo test` and `go test`, each setting a location.

### Project gates

These ask whether the project is still coherent after the change. All of them wrap every card's gate run, whatever `gates.toml` declares.

24. **Reachability.** A card may not add an export that nothing uses. An export the card added is reachable when production code imports it (including through `export *` barrels and `import * as ns` namespace use), when an entry point (`index`, `main`, `cli`, `server`, `bin`) exports it, or when the card's contract asks for it — its acceptance tests wherever they live, its spec and its criteria, where a name counts as asked for if it appears as a word. The card's own unit tests do not make code reachable. Only exports the card added are judged. It errs toward reachable. Every remedy is one edit: wire it in, un-export it, or record with `note` that a named later card needs it — and that `note` satisfies the gate.
25. **Regression.** A card may not take away what the base branch guarantees. A failure of a test that exists on the base (other than the card's own acceptance tests) is restated as a regression, listing the files the card changed. A test the base had that the card removed or emptied is refused. Only code files count as tests; a file empty on the base cannot be emptied.
26. **Architecture.** A card may not break an invariant the project brief declares. Two sentence forms are enforced: `` `A/` does not import `B` `` (a trailing `/` names a directory) and `` `Name` is defined only in `path` ``. A type-only import, a comment or a local variable is not a definition. A line in the Invariants section that matches neither form is **not enforced**, and the board shows it when the brief is written so a person can restate it in a checkable form. A project with no brief enforces nothing.
27. **Licence register and trailers.** Every verification also runs the licence register gate (SPDX expressions, [design-stage.md](design-stage.md) owns the classifier) and the commit-trailer contract on the card's branch.
28. All project gates read source through one AST-based index that answers what a file exports, imports (including `export *`, namespaces and `type`) and declares at top level; no gate parses imports with its own regular expression.

### Visual verification

29. Deterministic checks carry the weight: console errors, uncaught exceptions, unhandled rejections and responses with status ≥ 400; layout bounds (overlap, zero size, off-screen position, horizontal overflow `scrollWidth > clientWidth`); element-level screenshot comparison with dynamic content masked, animations off and `maxDiffPixelRatio` 0.01; and an accessibility scan at 1280 px and 375 px with zero critical violations.
30. A local vision model may answer a fixed checklist of yes/no questions at temperature 0. **It can fail a card but never pass one**, and it blocks nothing until its false-pass rate on real project UI has been measured.
31. New or changed screenshot baselines always require a person's approval.

### Mutation

32. Mutation testing is diff-scoped only, advisory at first, and blocking per project (`mutation_blocking`) once a stable threshold is known — never at 100%, because equivalent mutants exist. The unmutated tests must pass before any mutant counts; a change with no mutable lines scores "not applicable", not 1.0.

### Gate economics

33. A card's gates run on entering Verify, after each repair rung and once per sample; four rungs and four samples is sixteen runs, so the gates, not the Worker, set a card's cost. Therefore: static gates run before functional ones, ordered by cost; the functional gate runs the tests reachable from the card's scope first and short-circuits on a failure there, running the full suite once on the attempt about to enter Review; a gate's verdict is cached by the hash of the tree it ran on plus the gate's own definition hash; and every gate has a timeout, whose expiry is a failure with its own remedy.
34. **Flaky tests.** Before the first repair rung is spent, the tests that failed are re-run once on the unchanged tree. A test that fails then passes is quarantined for the card: its result is recorded, it stops blocking, and it is reported to the person as flaky with both runs attached.

### The evidence bundle

35. Every card entering Review carries one bundle: the diff with files and line counts; every gate outcome, including skipped and unavailable gates with reasons; the typed failures; artifacts (test output, screenshots and their diffs, the dependency and secret scan reports); the stop reason; turns, tokens and duration; the settings it ran with (model, quant, engine, sampling, KV, MTP, arm, thinking policy, working method, harness commit); the `gates.toml` hash; advisories that do not fail the card; a short list of what the Worker tried and abandoned; and a reference to the trajectory. Reviewing never requires reading the trajectory.

### `gates.toml`

36. Derived on first run from the project's own scripts and CI ([surface.md](surface.md) owns derivation), and edited only when a derived gate is wrong. A person writing a gate types a command and a parser; the rest is inferred.

## 3. Contract

| Item | Source |
| --- | --- |
| `GateFailure`, `GateResult`, `RungOutcome`, `GateDefinition`, `GateProjectConfig`, `GateRung`, `GateLayer` | `packages/gates/src/types.ts` |
| Loader, defaults, hash, tamper check: `loadGatesConfig`, `DEFAULT_GATES`, `DEFAULT_PROJECT_CONFIG` (`protected` = `**/*.spec.ts`, `**/*.test.ts`, `.sekhemet/gates.toml`, `tests/acceptance/**`; 3 files; 200 lines), `verifyGatesConfig` | `packages/gates/src/config.ts` |
| Runner, bounds, ranking: `DeterministicGateRunner`, `checkBounds`, `rankFailures` | `packages/gates/src/runner.ts`, `parsers.ts` |
| Parsers: `tsc`, `vitest`/`jest`, `biome`/`eslint`, `generic` | `packages/gates/src/parsers.ts:486` |
| Built-in layers: `runBuiltinGates` (`secrets`, `dependencies`, `osv`, `semgrep`, `hygiene`, `mutation`) | `packages/gates/src/builtin.ts:1077` |
| Visual gate and `[visual]` table | `packages/gates/src/visual.ts` |
| Remote gate host and `[gate_host]` table | `packages/gates/src/gate_host.ts` |
| Evidence bundle `EvidenceBundle`, `compileEvidence` | `packages/gates/src/evidence.ts` |
| Project gates `withReachabilityGate`, `withRegressionGate`, `withArchitectureGate`, `withTrailerGate`, `withLicenseGate` | `apps/harness/src/*_gate.ts`; composed at `execute.ts:322` |
| Red-first check `failToPass` | `packages/loop/src/card_runner.ts:761` |
| CLI: `sekhemet gate <card>`, `sekhemet gates init`, `sekhemet gate-host` | `apps/harness/src/index.ts` |

**`gates.toml` keys.** `[[gate]]`: `id`, `command`, `args` (separate from `command`), `parser`, `blocking` (default `true`), `timeout_s`, `rung`, `layer`, `baseline_approval`, and `needs` (new). `[project]`: `protected`, `max_files`, `max_diff_lines`, `autofix`, `style_fix`, `style_fix_rules`, `builtin`, `debug_patterns`, `changelog`, `mutation`, `mutation_max`, `mutation_blocking`, `pass_at_k`, `cross_validate`, `base_branch` (new). `[gate_host]` and `[visual]` tables. `network_allow` moves out of the repository's own file ([security.md](security.md), S3). The key is `id`, not `name`; `blocking`, not `required`. Inference: `rung` defaults to `id` when that is a known rung; `layer` is inferred from the rung and the parser (`gitleaks` → security, `stryker` → robustness, `playwright` → visual); an unknown rung, layer or parser is a warning naming it, never a silent mapping to `test` or `generic`.

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Declared gates run in the sandbox; config hash pinned and re-checked | built | `runner.ts:142-186`; `config.ts:225`; `config.spec.ts` | — |
| Bounds (3 files, 200 lines) exact | built | `runner.ts:40-88`; `bounds.spec.ts` | — |
| Failures in protected tests redirected | built | `runner.ts:269-280`; `protected_redirect.spec.ts` | — |
| Integrity gate (suppressions, skipped/focused tests, vacuous asserts) | built | `loop/src/integrity.ts`; `integrity.spec.ts:14`, `:43` | — |
| Autofix and style-fix before the static gates | built | `session.ts:1636-1650` | — |
| One pipeline, one rank-and-cap; CLI = card verdict | not-built | assembled in five places (`runner.ts`, `session.ts:1641-1730`, `execute.ts:322`, `index.ts:709`, `execute.ts:1049`); built-in failures prepended after the cap (`session.ts:1724`); CLI skips the project gates and `harnessOwned` (F5, F14) | T1 |
| Fail closed; `unavailable` outcome; gates declare needs | not-built | `runBuiltinGates(...).catch(() => undefined)` drops four layers (`session.ts:1704-1718`); osv/semgrep empty output parses as a pass (`builtin.ts:815`, `865`); gitleaks catch does nothing (`:239-241`) | T1 |
| Built-in and project gates on the gate host | not-built | run in the harness process even with `[gate_host]` (`execute.ts:322-341`) | T1 |
| Layer inferred from parser; unknown keys warned | not-built | layer defaults to `functional`, unknown rung to `test` silently (`config.ts:103-107`) | T1 |
| Red-first on fixture cards, incl. typecheck for `interface` | built | `card_runner.ts:761-791` | — |
| Red-first on every card, judged on the acceptance tests' own results | not-built | vacuous only if the whole run passes; cards without `acceptanceTests` skip it; planner cards carry only criteria (F9) | P1 |
| Secrets judged on added lines, staged tests excluded | built | `secrets.ts`; SUITE_RUNS run 5 fix | — |
| Diff-scoped osv, changelog in scope, configurable base, untracked files | not-built | whole lockfile (`builtin.ts:804-852`); changelog always required (`:927-946`); `main` hard-coded in five gates (F10); `git diff --name-only` skips untracked (F11) | NEW-gates-2 |
| `GateFailure` fields required; at most three per attempt | partial | fields optional (`types.ts:23-46`); cap bypassed (F14) | M6 |
| One-step remedies | partial | TS2305 fallback still "Read the module…" (`parsers.ts:108`); blocking-mutation remedy asks for a test the Worker cannot write (`builtin.ts:1141`) | M6 |
| `vitest` parser on real output; repro selects the test | not-built | one failure becomes two; both repros select zero tests and exit 0 (F13, `parsers.ts:348-393`) | M6 |
| Parsers for pytest, cargo, go | not-built | templates use `generic` (`templates.ts:105-129`) | M6 |
| `gate_suspected` stop | not-built | no such stop reason; `note` does not clear or park | M6 |
| Reachability (contract, entry points, errs toward reachable) | built | `reachability_gate.ts`; spec | — |
| Reachability sees barrels and namespaces | not-built | `export *` and `import * as` ignored (F2, reproduced) | T2 |
| Regression gate (restated failures, removed tests, content carried) | built | `regression_gate.ts`; spec | — |
| Architecture gate (two forms) | partial | `import { type X }`, comments and locals count as definitions (F1, reproduced) | T2 |
| Unenforced invariants shown on the board | not-built | list computed then discarded (`architecture_gate.ts:101`) | NEW-gates-1 |
| One AST source index | not-built | eight or more regex parsers (gates review §3) | T2 |
| Visual: console/network, bounds, screenshot diff, a11y subset | built | `visual.ts`; `visual.spec.ts` (needs Chrome) | — |
| Visual baselines require a person | not-built | `baselineApproval` defaults to `auto` (`visual.ts:78`) | NEW-gates-4 |
| Vision checklist (fail-only) | not-built | vision model used for attachments only | NEW-gates-4 |
| Mutation diff-scoped, advisory, blocking per project | built | `builtin.ts:1008`; `mutation_blocking` | — |
| Mutation baseline run; "not applicable" when nothing mutable | not-built | see M10 ([measurement.md](measurement.md)) for the same defect in the improve step | M10 |
| Impacted tests first, verdict cache, cost order, timeouts | partial | timeouts built (`timeout_s`); the rest absent — gates run in config order | NEW-gates-3 |
| Flaky-test quarantine | not-built | — | NEW-gates-3 |
| Evidence bundle | partial | `evidence.ts:32-63`; no `unavailable` reasons, artifacts or abandoned hypotheses | T1 |
| Security layer: secrets, existence/typosquat, osv, semgrep | built | `builtin.ts`; `supply_chain.spec.ts` | — |
| Gate host over mutual TLS | built | `gate_host.ts`; `gate_host.spec.ts` | — |

## 5. Changes for v1

### T1 — one gate pipeline that fails closed

- **GT-T1-1** WHEN the same worktree is verified by the card run and by `sekhemet gate <card>` THE SYSTEM SHALL produce the same pass/fail verdict and the same set of gate outcomes, on every seeded fixture.
- **GT-T1-2** WHEN any gate in the pipeline throws THE SYSTEM SHALL record that gate as `unavailable` with the error, the verdict SHALL be fail if the gate is blocking, and every other gate's outcome SHALL still be recorded.
- **GT-T1-3** WHEN osv, semgrep or gitleaks exits with empty or unparseable output THE SYSTEM SHALL record the gate as `unavailable`, not passed.
- **GT-T1-4** WHEN a verification produces more than three failures across declared, built-in and project gates THE SYSTEM SHALL deliver exactly three to the model, ranked once after all gates reported, and a test failure SHALL outrank a hygiene or changelog failure.
- **GT-T1-5** WHEN `[gate_host]` is configured THE SYSTEM SHALL run the built-in and project gates on the gate host, and no gate process SHALL start on the harness host.
- **GT-T1-6** WHEN `gates.toml` names an unknown rung, layer or parser THE SYSTEM SHALL warn naming the key and the value; WHEN a gate uses parser `gitleaks`, `stryker` or `playwright` without a `layer`, it SHALL be placed in security, robustness or visual.
- **GT-T1-7** WHEN a gate declares `needs` that the host cannot provide THE SYSTEM SHALL mark it `unavailable` with the missing need, and the card SHALL NOT enter Review while that gate is blocking.
- **GT-T1-8** WHEN a card enters Review THE SYSTEM SHALL have written an evidence bundle containing every field of §2 rule 35, including unavailable gates with reasons, artifacts and abandoned hypotheses (possibly empty lists).

### T2 — one AST source index for the project gates

- **GT-T2-1** WHEN a card adds an export used only as `ns.name` through `import * as ns`, or re-exported through `export *` from an entry point THE SYSTEM SHALL judge it reachable.
- **GT-T2-2** WHEN a file contains `import { type X }`, a comment naming X or a local variable named X THE SYSTEM SHALL NOT count it as a second definition of X under an "is defined only in" invariant.
- **GT-T2-3** WHEN the gates, `parsers.ts` export lookup, and the loop's symbol tools need a file's exports, imports or top-level declarations THE SYSTEM SHALL answer from one index module, and no other import/export regular expression SHALL remain in `packages/gates`, `packages/loop` or `apps/harness` (a search test).
- **GT-T2-4** WHEN the reachability gate is run over Sekhemet itself THE SYSTEM SHALL report its findings to the lead for review (a recorded run, not a pass condition).

### M6 — gate feedback proven on real tool output

- **GT-M6-1** WHEN a captured real `vitest --reporter=json` run with one failing test is parsed THE SYSTEM SHALL produce exactly one failure whose `location` is the test file and line, and whose `minimalRepro`, when run, selects at least one test and exits non-zero.
- **GT-M6-2** WHEN captured real output of `tsc`, `biome`, `pytest`, `cargo test` and `go test` is parsed THE SYSTEM SHALL produce failures with a `location` and every `GateFailure` field present.
- **GT-M6-3** WHEN a TS2305, TS2304, TS2339 or TS2353 failure is produced for any import (relative or package) THE SYSTEM SHALL list the real exports or members inline, and no remedy text SHALL tell the model to read a file to find them.
- **GT-M6-4** WHEN a blocking mutation survivor is reported to an implementer card THE SYSTEM SHALL NOT suggest adding a test; it SHALL suggest the code change that the surviving mutant shows is untested, or park for a person.
- **GT-M6-5** WHEN the Worker records with `note` that a named gate is wrong THE SYSTEM SHALL stop the card with `gate_suspected` naming the gate and the reason, and park it for a person.
- **GT-M6-6** WHEN any `GateFailure` reaches the model THE SYSTEM SHALL have all six fields non-empty (type-level required, and a runtime assertion in the pipeline).

### P1 — red-first on every card (the gates' share; the Planner's test-author step is [planner-pm.md](planner-pm.md))

- **GT-P1-1** WHEN a behaviour card has no staged acceptance-test file THE SYSTEM SHALL refuse to start it with `entry_condition` naming what is missing.
- **GT-P1-2** WHEN a card's acceptance tests pass on the untouched code while another test in the run fails THE SYSTEM SHALL still stop the card with `vacuous_tests`.
- **GT-P1-3** WHEN a planner-made card's acceptance tests live outside `acceptance/` THE SYSTEM SHALL stage and judge them from where they are declared.

### NEW-gates-1 — unenforced invariants shown to a person

*Justification:* the architecture gate silently ignores invariant lines it cannot parse; the design already asks for them to be shown.

- **GT-N1-1** WHEN the brief's Invariants section contains a line matching neither enforced form THE SYSTEM SHALL list that line as "not enforced" on the project's board and in the PM's report, with the two forms it could be restated in.

### NEW-gates-2 — judge only what the card wrote

*Justification:* whole-lockfile and whole-file scans, an unconditional changelog check, a hard-coded `main` and ignored untracked files are the `.gitkeep` class of false failure (gates review F3, F4, F10, F11).

- **GT-N2-1** WHEN the base already contains a vulnerable dependency and the card adds none THE SYSTEM SHALL pass the vulnerability gate.
- **GT-N2-2** WHEN `CHANGELOG.md` is not in the card's scope THE SYSTEM SHALL report a missing changelog entry as an advisory, not a failure.
- **GT-N2-3** WHEN the project's integration branch is `master` (or `base_branch` names another) THE SYSTEM SHALL judge the regression, reachability, architecture and trailer gates against it.
- **GT-N2-4** WHEN a card adds a new untracked file that violates an invariant THE SYSTEM SHALL fail the architecture gate on it.

### NEW-gates-3 — gate economics and flaky tests

*Justification:* gates dominate a card's cost and a flaky test can burn four rungs and park the card blaming the Worker; none of the design's economics exists.

- **GT-N3-1** WHEN a gate is run twice on an identical tree hash with an identical gate definition THE SYSTEM SHALL return the cached verdict the second time without starting the process.
- **GT-N3-2** WHEN the functional gate runs on an attempt that is not about to enter Review THE SYSTEM SHALL run the tests reachable from the card's scope first and stop at their first failure; WHEN the attempt is about to enter Review, it SHALL run the full suite.
- **GT-N3-3** WHEN gates run THE SYSTEM SHALL run every static gate before any functional gate.
- **GT-N3-4** WHEN a test fails and then passes on a re-run of only the failing tests on the unchanged tree THE SYSTEM SHALL quarantine it for the card, stop it blocking, and report it to the person as flaky with both runs attached, before the first repair rung is spent.

### NEW-gates-4 — the visual layer to its design

*Justification:* baselines auto-approve, contradicting "a person approves every baseline", and the fail-only vision checklist does not exist.

- **GT-N4-1** WHEN a screenshot baseline is new or changed and `baseline_approval` is unset THE SYSTEM SHALL require a person's approval before it is used.
- **GT-N4-2** WHEN the vision checklist answers "yes" to every question THE SYSTEM SHALL NOT count that as a pass of any gate; WHEN it answers "no" and the layer is blocking with a measured false-pass rate recorded, it SHALL fail the card.
- **GT-N4-3** WHEN the visual gate runs THE SYSTEM SHALL attach its screenshots and diffs to the evidence bundle as artifacts.

## 6. v1 acceptance

This spec is `built` when §5 passes and these stay under test:

- **GT-1** WHEN `gates.toml` changes after a card starts THE SYSTEM SHALL abort the verification with `GatesConfigTamperError`.
- **GT-2** WHEN a diff touches four files or 201 changed lines under the defaults THE SYSTEM SHALL fail the bounds gate; three files and 200 lines SHALL pass.
- **GT-3** WHEN a failure is located in a protected test THE SYSTEM SHALL name the implementation file as the place to fix it.
- **GT-4** WHEN a card adds a secret THE SYSTEM SHALL fail the secrets gate; WHEN only a staged acceptance test contains one, it SHALL pass.
- **GT-5** WHEN a card adds an export that nothing imports and its contract does not name THE SYSTEM SHALL fail reachability with a one-edit remedy; WHEN a `note` names the later card that needs it, the gate SHALL pass.
- **GT-6** WHEN a card breaks or empties a test present on the base THE SYSTEM SHALL fail the regression gate with the test's content from the base.
- **GT-7** WHEN a card imports across a declared boundary THE SYSTEM SHALL fail the architecture gate naming the import.
- **GT-8** WHEN an `interface` card's typecheck fails on the untouched code but its test runner passes THE SYSTEM SHALL treat the card as red.
- **GT-9** WHEN a card's added lines contain `@ts-ignore`, `as any`, `eslint-disable`, `.only` or `.skip` THE SYSTEM SHALL fail the integrity gate naming the line and the honest fix; WHEN the same text is only in a staged acceptance test, it SHALL pass.
- **GT-10** WHEN a dependency name is within edit distance of a popular package and is not on the registry THE SYSTEM SHALL fail the dependency gate naming the likely intended package.

## 7. Later

- **Structural diffs** (difftastic) in the evidence bundle — useful to reviewers, not required for acceptance in v1.
- **Coverage delta** as a robustness check — after mutation is stable per project.
- **Public vision baselines or a second local verifier ranking passing samples** — only if it beats gate-only selection at equal wall-clock ([worker-loop.md](worker-loop.md)).

## 8. Open questions

1. **Playwright, pixelmatch and axe-core versus the in-house CDP client.** The old design named the libraries; the code uses its own CDP client, PNG decoder and an axe-style subset. *Recommendation:* keep the in-house client for the gate (no browser download, works offline) and add `axe-core` for the accessibility check only if the owner approves it (MPL-2.0, dev-only — *proposed*).
2. **DoD §2B's two negative tests per happy path.** No package meets it (gates is at 0.62). *Recommendation:* make it risk-based — required for gates, kernel and security, aspirational elsewhere — and record that in the DoD.

## 9. Evidence and rationale

- Review: [domain06_gates_dod.md](../../reference/reviews/domain06_gates_dod.md) (F1–F16, reproduced false positives and fail-open paths).
- Runs: [SUITE_RUNS.md](../../reference/SUITE_RUNS.md) — run 1 (the one-step remedy rule), run 3 (`tests/.gitkeep` and the regression remedy), run 5 (the staged-test secret).
- The design choices of the reachability gate — not "no production caller" (would fail every leaf card), not the fixture layout alone (failed every repository without `acceptance/`), erring toward reachable — were each forced by a failing run; they are not to be re-proposed without new evidence.
- Grounded over textual gates: arXiv:2609.02750.
- Decisions: [DEC-02](../DECISIONS.md#dec-02) (gates decide; the model never certifies its own work), [DEC-20](../DECISIONS.md#dec-20) (non-TypeScript languages keep their functional gates), [DEC-08](../DECISIONS.md#dec-08) (SPDX libraries approved for the licence gate).
- Integrity gate: ARIS (arXiv:2605.03042), "plausible unsupported success" ([IMPLEMENTATION_AUDIT.md](../../research/IMPLEMENTATION_AUDIT.md) §3). Harness-supplied reproduction tests over agent-written ones: Agentless (arXiv:2407.01489, +5 points) and arXiv:2602.07900, in [WORKER_METHOD_LITERATURE.md](../../research/WORKER_METHOD_LITERATURE.md) §4.
