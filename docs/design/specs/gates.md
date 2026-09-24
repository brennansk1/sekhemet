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
changes: [T1, T2, M6, M10, P1, NEW-gates-1, NEW-gates-2, NEW-gates-3, NEW-gates-4, NEW-gates-5, NEW-gates-6, NEW-gates-7, NEW-gates-8]
---

# Gates: the definition of done

## 1. Purpose

Gates are how Sekhemet knows a card is done: declared, executable checks that the Worker cannot edit, run against what the card wrote, with failures returned in a shape a small model can act on. They are the first spine rule made concrete — **gates decide completion; the model never certifies its own work** — and they teach a beginner the professional definition of done: tests first, a small diff, nothing broken that already worked, and evidence a reviewer can read.

## 2. Behaviour

### What "done" means

1. A card may enter Review only when every blocking gate passed on its latest attempt and an evidence bundle exists ([kernel.md](kernel.md) holds the entry condition). A person then accepts it ([review-git.md](review-git.md)).
2. The gates are declared per project in `.sekhemet/gates.toml`. The Worker can never write it, nor any path matching `protected`. Its SHA-256 is pinned when a card starts and re-checked before every verification; a change aborts the run with `GatesConfigTamperError`.
3. The gates run in layers, each on a declared host:

   | Layer | Checks | Runs on |
   | --- | --- | --- |
   | Static | Parse, format, lint, typecheck | Gate host |
   | Functional | Unit, integration and end-to-end tests; the card's acceptance tests, written before implementation; a research card's claim gate (rule 27a) | Gate host |
   | Robustness | Diff-scoped mutation scores (suite and acceptance-test, rule 32), coverage delta | Gate host; a diff with more mutants than `mutation_max` runs its full campaign in the nightly run ([runtime.md](runtime.md)) |
   | Security | Secret scan, dependency existence, typosquat and allowlist, vulnerability scan, static analysis | Gate host |
   | Visual | Console and network errors, DOM assertions, layout bounds, element screenshot diff, accessibility, a vision checklist that can only fail | Gate host with a browser |
   | Hygiene | Changelog entry when in scope, no debug output, commit trailers | This machine (the core host) |
   | Human | Review of the evidence bundle | A person |

   "Gate host" is the configured `[gate_host]` when there is one, else this machine's sandbox (rule 11).

4. A security-layer failure is never overridden, by anyone ([kernel.md](kernel.md) rule 28).

### Acceptance tests come first (red-first)

5. Every card that changes behaviour carries acceptance-test files, staged into its worktree before the first step. A planner-made card gets them from a test-author step ([planner-pm.md](planner-pm.md)); a card with none cannot start. Every staged test case names the acceptance criterion it proves, in a form the index can read (a title prefix or tag), so strength can be reported per criterion ([planner-pm.md](planner-pm.md) PM-TQ-1).
6. **Red for the right reason.** Before any work, the runner stages a **stub of the card's declared interface** (every declared export present, bodies throwing "not implemented") and runs the acceptance tests against it, judging **their own results**: the card is red only if every acceptance test fails **at an assertion**. A failure at import, compilation, collection or setup is not red — it stops the card with `tests_not_red_for_reason`, naming the test and the error, because a test with a broken import is "red" for ever and "green" as soon as the file exists, whatever the code does. A types-only (`interface`) card is red on the test runner *or* the typechecker, because `import type` and `expectTypeOf` erase at runtime. If the acceptance tests already pass, the card stops with `vacuous_tests`, naming them — except where the card's `change` says green on base is its proof (rule 6b).
6a. **Can this test fail? — checked before the Worker starts.** After red, the runner runs the acceptance tests against trivial implementations of the declared interface: a body returning the return type's default (`0`, `""`, `false`, `[]`, `{}`, `undefined`) and a body returning its first argument unchanged. The card's tests must fail against every one. A test set that some trivial stub satisfies stops the card with `vacuous_tests` naming the stub and the passing tests where the depth profile makes stub-kill blocking (rule 32a), and is recorded as advisory otherwise. It costs two or three runs of the card's acceptance tests, before any of the Worker's budget is spent. The runner also turns on the test runner's own "a test must assert" switch for the acceptance run where one exists (Vitest `expect.requireAssertions`), and a **test-smell lint** over the staged tests refuses a test with no executed assertion, an expected value computed by calling the code under test, an assertion comparing two constants, an assertion inside a `catch` or an unreachable branch, and `.skip`/`.only`.
6b. **The card's `change` selects the red/green rule.** Every card has one `change` — what it does to existing code — assigned when it is planned ([planner-pm.md](planner-pm.md)) and stored on the card ([kernel.md](kernel.md) rule 6). It is a separate field from `kind`, which selects tools ([DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run); §8 Q3, decided). Whether `characterize`, `refactor` and `upgrade` ship in v1 is owner decision [O10](../../reference/OPEN_QUESTIONS.md#owner-decisions); its default is yes:

    | `change` | Red/green rule |
    | --- | --- |
    | `feature` | Acceptance tests red at an assertion on the base; green after |
    | `fix` | A reproduction test red at an assertion on the base; green after |
    | `characterize` | Tests **green** on the base — they pin today's behaviour, their expected values recorded by running the code (snapshot assertions need no new dependency); a characterization test that fails on the base is refused, and green on base is the card's proof, never `vacuous_tests` |
    | `refactor` | No new behaviour tests; the characterization and existing tests pass on the base **and** on the change, and the scope files' exported surface (from the source index) is identical unless the card declares the surface change |
    | `upgrade` | The version change is a tool step by the package manager, not the model; the gates then run, and each failing site becomes a child `fix` card ([planner-pm.md](planner-pm.md)) |

    A card planned on a new project is a `feature`. Without these kinds, every refactor and characterization card would stop with `vacuous_tests` and brownfield work could not be planned at all.
7. The Worker cannot edit acceptance tests or anything matching `protected`. A failure located inside a protected test is redirected to the implementation it exercises; the protected file is never offered as the place to fix it.

### One pipeline

8. Every gate — declared, bounds, config integrity, built-in layers and project gates — runs through one pipeline with one result shape, and the pipeline ranks and caps failures **once, at the end**. The card run, `check`, `sekhemet gate <card>`, rollup, MCP's `sekhemet_run_gates` and the gate host all use it, so they give the same verdict on the same tree.
9. **Fail closed.** A gate that throws, crashes, times out without a result, or produces output its parser cannot read is an `unavailable` outcome, never a pass. An unavailable blocking gate blocks Review on its layer, and the evidence bundle states it with its reason: a card that passed four gates because two could not run must not look like a card that passed six.
10. A gate declares what it needs to run (a service, a port, credentials); the gate host provides it or marks the gate unavailable.
11. The pipeline runs on a separate gate host when `[gate_host]` names one (mutual TLS), including the built-in and project gates; otherwise in this machine's sandbox ([security.md](security.md) owns confinement, including the visual gate's dev server).
12. **Bounds.** A card's diff may touch at most `max_files` files (default 3) and `max_diff_lines` changed lines (default 200), exactly. Staged acceptance-test files do not count (`session.ts:1672-1683`). Lines applied by a declared mechanical tool — a language-service rename, a codemod — are recorded as **tool-applied** and counted against a separate bound, and a card with tool-applied lines must pass the typecheck and the full suite (NEW-gates-7).
13. **Integrity.** Passing a gate by switching it off is a failure: on the lines the card added (staged acceptance tests excluded), the integrity gate refuses `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error`, `as any` and `: any`, lint suppressions (`biome-ignore`, `eslint-disable`), skipped tests (`.skip`, `.todo`, `xit`), focused tests (`.only`, `fit`) and vacuous assertions (`expect(true).toBe(true)`), each with the honest fix.
14. **Autofix before judging.** Formatter and style-fix commands declared in `autofix`, `style_fix` and `style_fix_rules` run on the card's changed files before the static gates (never in restricted mode), so formatting alone never fails a card.

### Judge what the card wrote

15. Every gate judges the card's change, never what the base branch already held: secrets are scanned on added lines only, excluding the acceptance tests the harness staged; vulnerability findings are reported only when new relative to the base; static analysis and mutation are scoped to the diff; project gates judge only files the card changed, including untracked files.
15a. **The onboarding baseline.** Onboarding a repository ([surface.md](surface.md)) records its pre-existing type errors, lint findings and failing or flaky tests (the suite run twice) as one baseline event, keyed by file, rule and a fingerprint that survives line moves. A static gate reports only diagnostics absent from the baseline; the baseline only shrinks, automatically, when a baselined diagnostic disappears; and a card is never asked to fix what it did not write. On a legacy repository with existing errors, every card would otherwise fail its static gates on its first run and spend its repair rungs on other people's errors (NEW-gates-7).
16. The base is the project's integration branch as configured, never a hard-coded `main`; outside a git repository, a diff-based gate judges nothing rather than guess.
17. A gate never demands an edit the Worker cannot make. A changelog entry is required only when `CHANGELOG.md` is in the card's scope (advisory otherwise); a remedy never tells an implementer to add a test it is denied from writing.
18. **A wrong gate.** When the Worker believes a gate is wrong, or encodes an assumption the card is changing, it says so with `note` naming the gate and the reason; the card stops with `gate_suspected` and parks for a person to decide. Grinding repair rungs against such a gate, or working around it, is exactly what gates exist to prevent.

### The repair contract

19. Every failure reaches the model in one shape, `GateFailure`: `gate`, `location` (`file:line` or `file#test`), `expected`, `actual` (truncated), `minimalRepro` (the exact command) and `suggestedAction` — all present. Raw logs stay in the evidence bundle, retrievable by reference.
20. At most three failures go to the model per repair attempt, chosen in dependency order: by rung (parse, typecheck, test, bounds, lint), then within a rung in the import graph's topological order — a failure in a file others import before a failure in a file that imports it — then the most-referenced file first, because fixing the first often clears the rest. The cap is applied once, after every gate has reported. Today the order within a rung is by reference count only (`parsers.ts:42-63`; M6).
21. **A remedy is completable in one step.** The failure carries the information its action depends on: a missing export lists the module's real exports and says there is no need to read the file; an unknown member lists the type's real members, from the project's types and from Node's, wherever the package manager keeps them; a regression failure carries the broken test's content from the base so restoring it is one write. A test too long to carry (over 4,000 characters, `regression_gate.ts:35`) is reported with the instruction to say so with `note` and finish, never with a command the Worker does not have.
22. A `minimalRepro` selects the failing test and exits non-zero when run. One failing test is one failure.
23. Each parser is tested against captured output of the real tool: `tsc`, `vitest` (JSON reporter), `biome`/`eslint`, and — for the Python, Rust and Go templates — `pytest`, `cargo test` and `go test`, each setting a location.
23a. **Gate templates by language.** Onboarding picks a template from the repository's manifests (`templates.ts:79-90`); the template is the project's own tools, run as-is with the team's own configuration, never Sekhemet's:

    | Language | Static (typecheck, lint, format) | Functional | Mutation (when installed) | State |
    | --- | --- | --- | --- | --- |
    | TypeScript / JavaScript (pnpm, npm, yarn) | the project's `typecheck` or `build` script, else `tsc --noEmit`; its `lint` script (Biome or ESLint); Prettier or Biome format check | the `test` script (Vitest, Jest; Playwright for end-to-end) | the built-in diff mutator; Stryker only if the owner approves it (§8 Q1a) | template built without a format gate (`templates.ts:40-76`) |
    | Python | mypy or pyright, ruff, ruff format | pytest | mutmut | template built with ruff, mypy, pytest; no format or mutation (`templates.ts:105-110`) |
    | Rust | `cargo check --all-targets`, `cargo clippy -- -D warnings`, rustfmt | `cargo test` | cargo-mutants | template built without rustfmt or mutation (`templates.ts:111-123`) |
    | Go | `go build`, `go vet`, staticcheck, gofmt | `go test` | none | template built with `go build`, `go vet`, `go test` (`templates.ts:124-129`) |
    | Java / Kotlin | javac, checkstyle | JUnit | PIT | not built; later (its language server starts slowly) |
    | Anything else | parse only, plus gates a person declares | declared | — | built (declared gates) |

    A mutation tool for a language runs as a subprocess **only when it is installed**; when it is not, the evidence says mutation was not measured for those files and why ([measurement.md](measurement.md) MS-M10-3). Non-TypeScript languages keep their functional gates and an unchecked parse until their index adapter exists ([DEC-20](../DECISIONS.md#dec-20)).

### Project gates

These ask whether the project is still coherent after the change. All of them wrap every card's gate run, whatever `gates.toml` declares.

24. **Reachability.** A card may not add an export that nothing uses. An export the card added is reachable when production code imports it (including through `export *` barrels and `import * as ns` namespace use), when an entry point (`index`, `main`, `cli`, `server`, `bin`) exports it, or when the card's contract asks for it — its acceptance tests wherever they live, its spec and its criteria, where a name counts as asked for if it appears as a word. The card's own unit tests do not make code reachable. Only exports the card added are judged. It errs toward reachable. Every remedy is one edit: wire it in, un-export it, or record with `note` that a named later card needs it — and that `note` satisfies the gate.
25. **Regression.** A card may not take away what the base branch guarantees. A failure of a test that exists on the base (other than the card's own acceptance tests) is restated as a regression, listing the files the card changed. A test the base had that the card removed or emptied is refused. Only code files count as tests; a file empty on the base cannot be emptied. A revision that regresses a gate that passed at Review returns the card to Planning with the regression named ([kernel.md](kernel.md) rule 31).
25a. **Superseded tests.** A card that changes behaviour an existing test asserts declares that test as **superseded** and has its new version staged by the test-author step ([planner-pm.md](planner-pm.md)). The regression gate accepts the failure of exactly the declared superseded tests whose new versions are staged, lists every supersession in the evidence bundle, and a person sees each one in Review. Without this, every behaviour change that contradicts an existing test in a team repository is unbuildable: the Worker may not edit the test and the gate refuses its failure (NEW-gates-7).
26. **Architecture.** A card may not break an invariant the project brief declares. Two sentence forms are enforced: `` `A/` does not import `B` `` (a trailing `/` names a directory) and `` `Name` is defined only in `path` ``. A type-only import, a comment or a local variable is not a definition. A line in the Invariants section that matches neither form is **not enforced**, and the board shows it when the brief is written so a person can restate it in a checkable form. A project with no brief enforces nothing.
27. **Licence register and trailers.** Every verification also runs the licence register gate (SPDX expressions, [design-stage.md](design-stage.md) owns the classifier) and the commit-trailer contract on the card's branch.
27a. **The claim gate.** A research card's report is checked by a claim gate declared in `gates.toml` in the functional layer and hash-pinned with the rest: it fails the card when an executable claim is neither reproduced nor marked unreproducible with a reason. It is a gate, not a rule the research pipeline applies to itself, because a gate that lives in prose is a gate the model can reason around. Claims run in the gate host's sandbox with no network and no write access to the repository. What a claim is and how it is executed is [design-stage.md](design-stage.md)'s (NEW-gates-5).
28. **One source index.** All project gates, the parse gate, the repo map, scope declaration, the Worker's symbol tools and the mutation operators read source facts through one `SourceIndex` interface; no gate parses imports with its own regular expression. Its facts are one language-neutral schema — files, workspace packages and their entry points (`exports` maps) and dependency graph, module specifiers, imports by kind (value, type, namespace, `export *`), exports, re-exports, top-level declarations, references — and every fact carries `language`, `parser`, `parserVersion` and a `parseStatus` of `ok`, `recovered` or `unsupported`. Per-language **adapters** supply the parser and the module resolver (which returns a file, an external package or `unresolved`, never a guess). The facts are a derived cache keyed by content hash and parser version, rebuildable and deletable at any time without changing a verdict — never a durable store.
28a. **The TypeScript API stays inside one adapter.** TypeScript 7.0 (2026-07-08) ships no JavaScript API, and 7.1's will be different; so the in-process TypeScript parser is used only inside the TypeScript adapter, pinned to the 5.x/6.0 API, and nothing outside that adapter imports `typescript`. The project gates keep running the **project's own** `tsc` (7 or earlier) as a command, which the change does not affect. When 7.1's API ships it replaces the adapter's internals behind the same interface.
28b. **A fact the index could not read is never a pass.** A gate that relies on facts from a file whose parse status is `recovered` or `unsupported` reports its outcome on that file as `partial` with the reason. A recovering parser (tree-sitter left error nodes in 6 of this repository's 422 files that the TypeScript parser accepted) would otherwise let reachability or architecture pass on a file it could not read; so for TypeScript the exact compiler parser supplies gate facts, and an approximate parser serves only the repo map.

### Visual verification

29. Deterministic checks carry the weight: console errors, uncaught exceptions, unhandled rejections and responses with status ≥ 400; **DOM assertions** the card declares (an element present, its text, its attribute); layout bounds (overlap, zero size, off-screen position, horizontal overflow `scrollWidth > clientWidth`); element-level screenshot comparison with dynamic content masked, animations off and `maxDiffPixelRatio` 0.01; and an accessibility scan at 1280 px and 375 px with zero critical violations. These behaviours are required whatever library implements them (§8 Q1).
30. A local vision model may answer a fixed checklist of yes/no questions at temperature 0. **It can fail a card but never pass one**, and it blocks nothing until it has been measured on a labelled set of real project screens (an evaluation asset, [measurement.md](measurement.md) T11): at least 60 screens a person approved and at least 30 with a seeded visual defect. It may be made blocking only when both hold: its **wrong-fail rate** (a failing answer on an approved screen, the error that blocks a good card) has an exact one-sided 95% upper bound of at most 5% (on 60 screens that allows no wrong fail; one is allowed from 93 screens) and its **false-pass rate** (no failing answer on a defective screen) is at most 50%, below which the checklist does not repay its run time. Until then it runs, if at all, as an advisory recorded in the evidence (OPEN_QUESTIONS benchmark 10).
31. New or changed screenshot baselines always require a person's approval.

### Mutation

32. Mutation testing is diff-scoped only, capped (`mutation_max`, 8 today), advisory at first, and blocking per project (`mutation_blocking`) once a stable threshold is known — never at 100%, because equivalent mutants exist. The unmutated tests must pass before any mutant counts; a change with no mutable lines scores "not applicable", not 1.0. It reports **two scores**, each over non-equivalent mutants: the **suite score** (the diff's mutants killed by the whole suite — robustness) and the **acceptance-test score** (the diff's mutants killed by the card's own acceptance tests alone — what feeds "proven"), so an unrelated old test killing a mutant never makes a requirement look proven. A mutant that fails the typecheck ("stillborn") or whose transpiled JavaScript is identical to the original's ("equivalent", the cheap analogue of trivial compiler equivalence) is excluded from both and counted; mutants on arid lines — logging, debug output, pure constants — are not generated. A mutant that survives the acceptance tests is a **test gap**: it goes to the test-author step or to a person, and is never presented to the Worker as a failure.
32a. **Test strength is part of "proven".** Every card's evidence carries a **test-strength record**: the criterion → test trace, the test-smell lint, red at an assertion, stub-kill, property-test seeds, oracle cross-check disagreements, and the acceptance-test mutation score. Whether a requirement counts as *proven* ([planner-pm.md](planner-pm.md), P13) needs its tests to pass **and** this record to meet the rule of the project's depth profile:

    | Check | prototype | internal tool | production | regulated |
    | --- | --- | --- | --- | --- |
    | Criterion lint and criterion → test trace | blocking | blocking | blocking | blocking |
    | Test-smell lint on staged tests | advisory | blocking | blocking | blocking |
    | Red at an assertion against the interface stub | blocking | blocking | blocking | blocking |
    | Stub-kill (the tests fail every trivial implementation) | advisory | blocking | blocking | blocking |
    | Property test for hard-invariant criteria | — | advisory | blocking | blocking (every quantified criterion) |
    | Oracle cross-check (two independent samples of expected values) | — | — | must-have requirements | every requirement |
    | Acceptance-test mutation score on the card's diff | — | advisory | blocking at the project threshold | blocking at the project threshold; every survivor waived by a person |
    | A person approves | criteria | criteria | criteria and the example tables of must-haves | criteria, every acceptance-test file, every waiver |

    Thresholds are not set here: the first blocking acceptance-test mutation threshold is derived from the planning measure's per-card "mutants killed" and recorded in the register with its date before any project uses it ([measurement.md](measurement.md) MS-TQ-2). Until then "blocking at the project threshold" means the requirement shows *passing, strength unmet* and is not counted as proven unless a person accepts it explicitly. Model-written tests on real projects let one in five "solved" patches through when strengthened; a test that passes all five checks can still assert the wrong value, which is what oracle cross-checks and a person's approval of example tables are for. Who stages property tests and cross-checks, and who approves, is [planner-pm.md](planner-pm.md)'s.

### Gate economics

33. A card's gates run on entering Verify, after each repair rung and once per sample; four rungs and four samples is sixteen runs, so the gates, not the Worker, set a card's cost. Therefore: static gates run before functional ones, ordered by cost; the functional gate runs the tests reachable from the card's scope first and short-circuits on a failure there, running the full suite once on the attempt about to enter Review; a gate's verdict is cached by the hash of the tree it ran on plus the gate's own definition hash; and every gate has a timeout, whose expiry is a failure with its own remedy. Which tests are reachable from the scope is the source index's to say (T2, rule 28): **until T2 exists, the functional gate runs the full suite on every run** and says so in the evidence ("impacted tests first: no source index"), and the verdict cache, the cost order and the timeouts apply unchanged.
34. **Flaky tests.** Before the first repair rung is spent, the tests that failed are re-run once on the unchanged tree. A test that fails then passes is quarantined for the card: its result is recorded, it stops blocking, and it is reported to the person as flaky with both runs attached.
34a. **Workspaces.** When a card's changed files belong to a workspace package (pnpm, npm or yarn workspaces; TypeScript project references), the functional gate runs that package's tests and its dependents' tests first, in build order, and a card whose scope crosses a package boundary runs the build step as a gate before the dependents' tests — because in a workspace that resolves packages through their built output, a change in one package is seen by another only after a build (NEW-gates-7).
34b. **One process per fix step.** Style fixes run as one invocation of the fixer with every selected rule (`biome lint --write --unsafe` with each `--only`), not one process per rule; today each verification starts one `biome` process per style rule plus the autofix (`card_runner.ts:942-952`) (NEW-gates-3).

### The evidence bundle

35. Every card entering Review carries one bundle: its id, card, attempt number and attempt id; the diff with files and line counts, tool-applied lines separately; every gate outcome, including skipped and unavailable gates with reasons, and each result's **source** (`local` or `external` with its check name, run URL and head sha — an external result is advisory unless the project declares that check blocking, and never counts for a card whose branch head differs from its `headSha`; [kernel.md](kernel.md) rule 37); the typed failures; artifacts (test output, screenshots and their diffs, the dependency and secret scan reports); the test-strength record (rule 32a) and every superseded test (rule 25a); the stop reason; steps, tokens and duration; the settings it ran with (model, quant, engine, sampling, KV, MTP, arm, thinking policy, working method, harness commit); the `gates.toml` hash — or "no `gates.toml`" when the defaults ran, never the hash of an empty string; advisories that do not fail the card; a short list of what the Worker tried and abandoned; and the trajectory reference as the SHA-256 of the card's event-log slice for the attempt, plus the transcript's path. Reviewing never requires reading the trajectory. The evidence never invents an outcome: a gate that did not run is absent or `skipped`, never a synthesised `pass` (no implicit `parse: pass`).

### `gates.toml`

36. Derived on first run from the project's own scripts and CI ([surface.md](surface.md) owns derivation), and edited only when a derived gate is wrong. A person writing a gate types a command and a parser; the rest is inferred. A copyable example, with the values the old design fixed:

    ```toml
    [project]
    protected = ["tests/acceptance/**", ".sekhemet/gates.toml"]
    max_files = 3
    max_diff_lines = 200

    [[gate]]
    id = "typecheck"
    command = "pnpm"
    args = ["exec", "tsc", "--noEmit"]
    parser = "tsc"

    [[gate]]
    id = "unit"
    command = "pnpm"
    args = ["exec", "vitest", "run"]
    parser = "vitest"

    [[gate]]
    id = "secret-scan"
    command = "gitleaks"
    args = ["detect", "--no-git", "-v"]
    parser = "gitleaks"          # layer inferred: security

    [[gate]]
    id = "visual"
    command = "pnpm"
    args = ["exec", "playwright", "test", "tests/visual"]
    parser = "playwright"        # layer inferred: visual
    baseline_approval = "human"
    ```

    A slow gate such as an external mutation tool is declared with `blocking = false` and a long timeout (the old example gave Stryker `timeout_s = 1800`).

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
| Gate templates `GateTemplateId` (`pnpm`, `npm`, `yarn`, `python`, `rust`, `go`), `detectGateTemplate`, `gateTemplate`, `renderGatesToml` | `packages/gates/src/templates.ts` |
| Source index (new): `SourceIndex`, facts with `language`, `parser`, `parserVersion`, `parseStatus`; per-language adapters (parser, resolver) | `packages/gates/src/index/` (T2) |
| The card's `change` field (new): `feature`, `fix`, `characterize`, `refactor`, `upgrade` ([DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run); stored per [kernel.md](kernel.md) NEW-kernel-9); baseline event (new) `project/baseline`; stop reason (new) `tests_not_red_for_reason`, in [worker-loop.md](worker-loop.md)'s stop-reason table | `packages/kernel/src/types.ts` |
| HTTP: `GET /api/gates` → the gates in configured order, `protected`, `maxFiles`, `maxDiffLines`, `sha256`, and `empty` (true when no `gates.toml` exists) — the dashboard's gate list and its empty-contract warning | `apps/harness/src/server.ts`; the API is [runtime.md](runtime.md)'s |
| CLI: `sekhemet gate <card>`, `sekhemet gates init`, `sekhemet gate-host` | `apps/harness/src/index.ts` |

**Defaults the gates enforce.** Each value has one source: measured, a prior (no measurement behind it yet, with what replaces it), or fixed by design.

| Setting | Default | Source |
| --- | --- | --- |
| `max_files`; `max_diff_lines` | 3; 200 changed lines | Fixed by design: the review-size budget ([review-git.md](review-git.md) S6); `DEFAULT_PROJECT_CONFIG` (`config.ts:78-82`) |
| `max_tool_applied_lines` | 500 | Prior (tool-applied lines must also pass the typecheck and the full suite, rule 12); replaced by the distribution of tool-applied lines on the first brownfield cards (B4.0b) |
| Gate timeout (`timeout_s`) | 180 s for a declared gate without one; the default gates: typecheck 180 s, lint 120 s, unit tests 600 s | Prior, the code's values (`config.ts:45-76`, `:118`) |
| `mutation_max` | 8 mutants per card; the rest nightly | Prior (`builtin.ts:1045`); benchmark 9 (mutation cost per card) replaces it |
| `mutation_threshold` | none until measured | Measured: the first value comes from the planning measure ([measurement.md](measurement.md) MS-TQ-2) |
| Regression content carried | up to 4,000 characters | Prior (`regression_gate.ts:35`) |
| Failures shown per repair attempt | 3 | Fixed by design (rule 20) |
| `pass_at_k` | 1 (at most 4) | Prior (`config.ts:185-186`); [worker-loop.md](worker-loop.md) rule 37 |
| Screenshot diff | `maxDiffPixelRatio` 0.01; widths 1280 and 375 px | Fixed by design (rule 29) |
| Vision checklist blocking | wrong-fail upper bound ≤ 5% on ≥ 60 approved screens; false-pass ≤ 50% on ≥ 30 seeded defects | Prior (rule 30); measured by OPEN_QUESTIONS benchmark 10 |

**`gates.toml` keys.** `[[gate]]`: `id`, `command`, `args` (separate from `command`), `parser`, `blocking` (default `true`), `timeout_s`, `rung`, `layer`, `baseline_approval`, `needs` (new), and `external` (new: the name of an external CI check this gate stands for; its result is advisory unless `blocking = true`). `[project]`: `protected`, `max_files`, `max_diff_lines`, `max_tool_applied_lines` (new), `autofix`, `style_fix`, `style_fix_rules`, `builtin`, `debug_patterns`, `changelog`, `mutation`, `mutation_max`, `mutation_blocking`, `mutation_threshold` (new, set only from a recorded measurement, MS-TQ-2), `pass_at_k`, `cross_validate`, `base_branch` (new), `network_allow`. `[gate_host]` and `[visual]` tables. `[project] network_allow` is a **narrowing only**: a card's sandboxed commands may reach only hosts that are in both the user's `fetch_allow` ([surface.md](surface.md)) and the repository's `network_allow`, which is empty by default, so by default they reach none; a repository file can never widen the network policy ([security.md](security.md), S3). The key is `id`, not `name`; `blocking`, not `required`. The old `[project] languages` key is dropped: languages are detected from the manifests and recorded in the evidence. The old per-gate `schedule = "nightly"` is dropped: the nightly run is [runtime.md](runtime.md)'s. The old `threshold = {score = 60}` becomes `mutation_threshold`. Inference: `rung` defaults to `id` when that is a known rung; `layer` is inferred from the rung and the parser (`gitleaks` → security, `stryker` → robustness, `playwright` → visual); an unknown rung, layer or parser is a warning naming it, never a silent mapping to `test` or `generic`.

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Declared gates run in the sandbox; config hash pinned and re-checked | built | `runner.ts:142-186`; `config.ts:225`; `config.spec.ts` | — |
| Bounds (3 files, 200 lines) exact; staged acceptance tests excluded | built | `runner.ts:40-88`; `session.ts:1672-1683`; `bounds.spec.ts` | — |
| Tool-applied lines under a separate bound | not-built | — | NEW-gates-7 |
| Failures in protected tests redirected | built | `runner.ts:269-280`; `protected_redirect.spec.ts` | — |
| Integrity gate (suppressions, skipped/focused tests, vacuous asserts) | built | `loop/src/integrity.ts`; `integrity.spec.ts:14`, `:43` | — |
| Autofix and style-fix before the static gates | built | `session.ts:1636-1650` | — |
| One pipeline, one rank-and-cap; CLI = card verdict | not-built | assembled in five places (`runner.ts`, `session.ts:1641-1730`, `execute.ts:322`, `index.ts:709`, `execute.ts:1049`); built-in failures prepended after the cap (`session.ts:1724`); CLI skips the project gates and `harnessOwned` (F5, F14) | T1 |
| Fail closed; `unavailable` outcome; gates declare needs | not-built | `runBuiltinGates(...).catch(() => undefined)` drops four layers (`session.ts:1704-1718`); osv/semgrep empty output parses as a pass (`builtin.ts:815`, `865`); gitleaks catch does nothing (`:239-241`) | T1 |
| Built-in and project gates on the gate host | not-built | run in the harness process even with `[gate_host]` (`execute.ts:322-341`) | T1 |
| Layer inferred from parser; unknown keys warned | not-built | layer defaults to `functional`, unknown rung to `test` silently (`config.ts:103-107`) | T1 |
| Red-first on fixture cards, incl. typecheck for `interface` | built | `card_runner.ts:761-791` | — |
| Red-first on every card, judged on the acceptance tests' own results | not-built | vacuous only if the whole run passes; cards without `acceptanceTests` skip it; planner cards carry only criteria (F9) | P1 |
| Red at an assertion against an interface stub | not-built | any failure counts as red, including import errors (`card_runner.ts:761-791`) | NEW-gates-6 |
| Stub-kill, test-smell lint, `requireAssertions` | not-built | — | NEW-gates-6 |
| `change` values `characterize`, `refactor`, `upgrade` with their red/green rules | not-built | one rule for every card | NEW-gates-6 |
| Superseded tests accepted by the regression gate | not-built | every base-test failure is a regression (`regression_gate.ts`) | NEW-gates-7 |
| Onboarding baseline of existing diagnostics | not-built | — | NEW-gates-7 |
| Workspace-aware test order and build step | not-built | — | NEW-gates-7 |
| Secrets judged on added lines, staged tests excluded | built | `secrets.ts`; SUITE_RUNS run 5 fix | — |
| Diff-scoped osv, changelog in scope, configurable base, untracked files | not-built | whole lockfile (`builtin.ts:804-852`); changelog always required (`:927-946`); `main` hard-coded in five gates (F10); `git diff --name-only` skips untracked (F11) | NEW-gates-2 |
| `GateFailure` fields required; at most three per attempt | partial | fields optional (`types.ts:23-46`); cap bypassed (F14) | M6 |
| One-step remedies | partial | TS2305 fallback still "Read the module…" (`parsers.ts:108`); blocking-mutation remedy asks for a test the Worker cannot write (`builtin.ts:1141`) | M6 |
| `vitest` parser on real output; repro selects the test | not-built | one failure becomes two; both repros select zero tests and exit 0 (F13, `parsers.ts:348-393`) | M6 |
| Parsers for pytest, cargo, go | not-built | templates use `generic` (`templates.ts:105-129`) | M6 |
| `gate_suspected` stop | not-built | no such stop reason; `note` does not clear or park | M6 |
| Reachability (contract, entry points, errs toward reachable) | built | `reachability_gate.ts`; spec | — |
| Reachability sees barrels and namespaces | not-built | `export *` and `import * as` ignored (F2, reproduced) | T2 |
| Regression gate (restated failures, removed tests, content carried up to 4,000 characters, `note` beyond) | built | `regression_gate.ts:35`, `:105-130`; spec | — |
| Gate templates: TS/JS, Python, Rust, Go | partial | `templates.ts:40-129`; no format gates, no per-language mutation tool, no Java/Kotlin | NEW-gates-5 |
| Claim gate as a declared, hash-pinned functional gate | not-built | claims are checked inside the research pipeline (`research/cards.ts`), not in `gates.toml` | NEW-gates-5 |
| Architecture gate (two forms) | partial | `import { type X }`, comments and locals count as definitions (F1, reproduced) | T2 |
| Unenforced invariants shown on the board | not-built | list computed then discarded (`architecture_gate.ts:101`) | NEW-gates-1 |
| One AST source index with a language-neutral fact schema and parse status | not-built | eight or more regex parsers (gates review §3) | T2 |
| `typescript` imported only by one adapter | not-built | `parse_gate.ts`, `builtin.ts:1008`, `ts_service.ts` and the repo map import it directly | T2 |
| Visual: console/network, bounds (zero size, off-screen, overflow), screenshot diff at 0.01, a11y subset at 1280/375 | built | `visual.ts:15-17`, `:61`, `:76`, `:378-385`; `visual.spec.ts` (needs Chrome) | — |
| Visual: overlap predicate, masking of dynamic content, animations off, declared DOM assertions | not-built | none of the four in `visual.ts` | NEW-gates-4 |
| Visual baselines require a person | not-built | `baselineApproval` defaults to `auto` (`visual.ts:78`) | NEW-gates-4 |
| Vision checklist (fail-only) | not-built | vision model used for attachments only | NEW-gates-4 |
| Mutation diff-scoped, capped, advisory, blocking per project | built | `builtin.ts:1008`; `mutation_blocking`; `mutation_max` 8 | — |
| Mutants beyond the cap run nightly | not-built | mutants past `mutation_max` are dropped | NEW-gates-5 |
| Per-language mutation tools when installed (mutmut, cargo-mutants, PIT) | not-built | TypeScript only; other languages skipped | NEW-gates-5 |
| Two mutation scores; stillborn/equivalent excluded; survivors routed to the test author | not-built | one score; survivors reported to the implementer (`builtin.ts:1141`) | NEW-gates-6 |
| Mutation baseline run; "not applicable" when nothing mutable | not-built | see M10 ([measurement.md](measurement.md)) for the same defect in the improve step | M10 |
| Impacted tests first, verdict cache, cost order, timeouts | partial | timeouts built (`timeout_s`); the rest absent — gates run in config order | NEW-gates-3 |
| Flaky-test quarantine | not-built | — | NEW-gates-3 |
| Evidence bundle | partial | `evidence.ts:32-63`; no `unavailable` reasons, artifacts or abandoned hypotheses; `trajectoryRef` is the transcript path, not a hash (`evidence.ts:61-62`); no gate-result source | T1 |
| "No `gates.toml`" stated rather than the empty-string hash | not-built | the defaults hash `""` (`config.ts:144`) | T1 |
| Style fixes in one process | not-built | one `biome` process per rule plus autofix (`card_runner.ts:942-952`) | NEW-gates-3 |
| Failures ordered by the import graph within a rung | not-built | severity, then reference count (`parsers.ts:42-63`) | M6 |
| Security layer: secrets, existence/typosquat (npm, PyPI, crates, Go registries), osv | built | `builtin.ts`; `supply_chain.spec.ts` | — |
| Static analysis (semgrep) with a bundled offline rule set | partial | skipped unless `.sekhemet/semgrep.yml` exists (`builtin.ts:855-861`); no bundled rules | NEW-gates-5 |
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
- **GT-T1-9** WHEN an evidence bundle is written THE SYSTEM SHALL set its trajectory reference to the SHA-256 of the attempt's event-log slice, and recomputing that hash from the ledger SHALL reproduce it.
- **GT-T1-10** WHEN no `gates.toml` exists and the defaults run THE SYSTEM SHALL record "no `gates.toml`" in the evidence and `empty: true` from `/api/gates`, never the SHA-256 of an empty string as a configuration hash.
- **GT-T1-11** WHEN a gate did not run THE SYSTEM SHALL NOT record a passing outcome for it (no synthesised `parse: pass`), and the gate strip built from the evidence SHALL show only gates that ran or were skipped with a reason.
- **GT-T1-12** WHEN a gate result from an external CI check is recorded for a gate whose `external` check is not declared `blocking = true` THE SYSTEM SHALL list it as advisory; WHEN its head sha differs from the card branch head THE SYSTEM SHALL leave it out of the verdict and say why.
- **GT-T1-13** WHEN the project has a `.sekhemet/gates.toml` THE SYSTEM SHALL record as `gatesConfigSha256` the SHA-256 of that file's bytes as loaded when the card started, and a test SHALL compare it with `sha256sum` of the file.

### T2 — one AST source index for the project gates

- **GT-T2-1** WHEN a card adds an export used only as `ns.name` through `import * as ns`, or re-exported through `export *` from an entry point THE SYSTEM SHALL judge it reachable.
- **GT-T2-2** WHEN a file contains `import { type X }`, a comment naming X or a local variable named X THE SYSTEM SHALL NOT count it as a second definition of X under an "is defined only in" invariant.
- **GT-T2-3** WHEN the gates, `parsers.ts` export lookup, and the loop's symbol tools need a file's exports, imports or top-level declarations THE SYSTEM SHALL answer from one index module, and no other import/export regular expression SHALL remain in `packages/gates`, `packages/loop` or `apps/harness` (a search test).
- **GT-T2-4** WHEN the reachability gate is run over Sekhemet's own repository with every export treated as added THE SYSTEM SHALL finish within the gate's timeout, report each unreachable export with its file, name and one-edit remedy, and report none of the exports that a checked-in fixture list records as reachable only through a barrel (`export *`), a namespace import or an entry point (a test over the real repository).
- **IX-1** WHEN any consumer (project gates, parse gate, repo map, scope declaration, symbol tools, mutation operators) needs imports, exports, re-exports, top-level declarations or references THE SYSTEM SHALL obtain them from one `SourceIndex` interface whose facts carry `language`, `parser`, `parserVersion` and `parseStatus` (`ok`, `recovered`, `unsupported`).
- **IX-2** WHEN a module specifier is resolved THE SYSTEM SHALL use the language adapter's resolver, returning a file, an external package or `unresolved`, and never a guess.
- **IX-3** WHEN a file's content hash and parser version are unchanged THE SYSTEM SHALL serve its facts from the cache; deleting the cache SHALL change no gate verdict.
- **IX-4** WHEN the codebase is searched THE SYSTEM SHALL find no import of `typescript` outside the TypeScript adapter (a search test, extending GT-T2-3).
- **IX-5** WHEN a workspace is indexed THE SYSTEM SHALL record its packages, their entry points (`exports` maps) and their dependency graph as facts.
- **GT-IX-1** WHEN a project gate reads facts from a file whose parse status is `recovered` or `unsupported` THE SYSTEM SHALL report the gate's outcome on that file as `partial` with the reason, never `pass`.

### M6 — gate feedback proven on real tool output

- **GT-M6-1** WHEN a captured real `vitest --reporter=json` run with one failing test is parsed THE SYSTEM SHALL produce exactly one failure whose `location` is the test file and line, and whose `minimalRepro`, when run, selects at least one test and exits non-zero.
- **GT-M6-2** WHEN captured real output of `tsc`, `biome`, `pytest`, `cargo test` and `go test` is parsed THE SYSTEM SHALL produce failures with a `location` and every `GateFailure` field present.
- **GT-M6-3** WHEN a TS2305, TS2304, TS2339 or TS2353 failure is produced for any import (relative or package) THE SYSTEM SHALL list the real exports or members inline, and no remedy text SHALL tell the model to read a file to find them.
- **GT-M6-4** WHEN a mutation survivor is found on an implementer card THE SYSTEM SHALL NOT present it to the Worker as a failure or suggest adding a test; it SHALL route it as a test gap to the test-author step or to a person (GT-TQ-5). *Changed:* the earlier text asked the implementer for a code change instead, which treats a weak test as a code defect.
- **GT-M6-5** WHEN the Worker records with `note` that a named gate is wrong THE SYSTEM SHALL stop the card with `gate_suspected` naming the gate and the reason, and park it for a person.
- **GT-M6-6** WHEN any `GateFailure` reaches the model THE SYSTEM SHALL have all six fields non-empty (type-level required, and a runtime assertion in the pipeline).
- **GT-M6-7** WHEN two failures of the same rung lie in files A and B, and B imports A THE SYSTEM SHALL rank A's failure first.

### P1 — red-first on every card (the gates' share; the Planner's test-author step is [planner-pm.md](planner-pm.md))

- **GT-P1-1** WHEN a behaviour card has no staged acceptance-test file THE SYSTEM SHALL refuse to start it with `entry_condition` naming what is missing.
- **GT-P1-2** WHEN a card's acceptance tests pass on the untouched code while another test in the run fails THE SYSTEM SHALL still stop the card with `vacuous_tests`.
- **GT-P1-3** WHEN a planner-made card's acceptance tests live outside `acceptance/` THE SYSTEM SHALL stage and judge them from where they are declared.
- **GT-P1-4** WHEN a card's staged acceptance tests live anywhere in the repository (not only under `tests/`) THE SYSTEM SHALL exclude exactly those files from the bounds count; today a path is matched only after prefixing `tests/` (`session.ts:1673-1675`), so a staged `src/foo.test.ts` is counted.

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
- **GT-N3-2** WHEN the functional gate runs on an attempt that is not about to enter Review and the source index is available THE SYSTEM SHALL run the tests reachable from the card's scope first and stop at their first failure; WHEN the attempt is about to enter Review, it SHALL run the full suite; WHEN the source index is not available THE SYSTEM SHALL run the full suite on every functional run and record "impacted tests first: no source index" in the evidence.
- **GT-N3-3** WHEN gates run THE SYSTEM SHALL run every static gate before any functional gate.
- **GT-N3-4** WHEN a test fails and then passes on a re-run of only the failing tests on the unchanged tree THE SYSTEM SHALL quarantine it for the card, stop it blocking, and report it to the person as flaky with both runs attached, before the first repair rung is spent.
- **GT-N3-5** WHEN `style_fix_rules` names several rules THE SYSTEM SHALL run the style fixer once with every rule selected, and a verification SHALL start at most one autofix and one style-fix process (integration review C6).

### NEW-gates-4 — the visual layer to its design

*Justification:* baselines auto-approve, contradicting "a person approves every baseline", and the fail-only vision checklist does not exist.

- **GT-N4-1** WHEN a screenshot baseline is new or changed and `baseline_approval` is unset THE SYSTEM SHALL require a person's approval before it is used.
- **GT-N4-2** WHEN the vision checklist answers "yes" to every question THE SYSTEM SHALL NOT count that as a pass of any gate; WHEN it answers "no" THE SYSTEM SHALL fail the card only if the model registry ([models.md](models.md)) records, for this vision model and checklist version, a wrong-fail rate whose exact one-sided 95% upper bound is at most 5% on at least 60 approved screens and a false-pass rate of at most 50% on at least 30 seeded-defect screens (rule 30); otherwise it SHALL record the answer as an advisory and not fail the card.
- **GT-N4-3** WHEN the visual gate runs THE SYSTEM SHALL attach its screenshots and diffs to the evidence bundle as artifacts.
- **GT-N4-4** WHEN two visible elements' layout boxes intersect and the card does not declare the overlap THE SYSTEM SHALL fail the layout check naming both elements.
- **GT-N4-5** WHEN an element screenshot is taken THE SYSTEM SHALL disable CSS animations and transitions and mask the regions the gate declares dynamic, so two runs on an unchanged tree differ by 0 pixels.
- **GT-N4-6** WHEN a card declares a DOM assertion (selector with expected presence, text or attribute) THE SYSTEM SHALL check it in the visual gate and fail naming the selector and the actual value.

### NEW-gates-5 — the gates the old design listed: templates, the claim gate, bundled static-analysis rules

*Justification:* the per-language templates lost their format and mutation tools and Java/Kotlin; the claim gate lives in prose inside the research pipeline; semgrep is skipped on every project without its own rules (traces hd2 135, 219, 276; inventory G16, G27; ruling R14).

- **GT-N5-1** WHEN onboarding detects a TypeScript, Python or Rust project THE SYSTEM SHALL derive a format gate from the project's formatter (Prettier or Biome; ruff format; rustfmt) when its configuration exists.
- **GT-N5-2** WHEN the mutation gate runs on files in a language whose mutation tool (mutmut, cargo-mutants, PIT) is installed THE SYSTEM SHALL run it as a subprocess scoped to the diff; WHEN it is not installed THE SYSTEM SHALL record those files as "mutation not measured: <tool> not installed".
- **GT-N5-3** WHEN a research card is verified THE SYSTEM SHALL run its claim gate from `gates.toml` under the pinned hash, and SHALL fail the card when an executable claim is neither reproduced nor marked unreproducible with a reason.
- **GT-N5-4** WHEN a project has no `.sekhemet/semgrep.yml` THE SYSTEM SHALL run semgrep with a rule set shipped with Sekhemet and usable offline, and the evidence SHALL name the rule set's version.
- **GT-N5-5** WHEN a card's diff yields more mutants than `mutation_max` THE SYSTEM SHALL score the first `mutation_max` in the card's verification, mark the score partial, and run the rest in the next nightly run ([runtime.md](runtime.md)), recording the full score on the card's evidence when it completes.

### NEW-gates-6 — tests that can fail, checked before the build

*Justification:* a planner-written acceptance test is a model's oracle; LLM oracles often encode the wrong expectation, weak tests let one in five "solved" SWE-bench patches through, and a test red only because of a missing import proves nothing. Without these checks "proven" counts tests that cannot fail ([DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) decisions 1–4, 7; §3.1, §3.3).

- **GT-TQ-1** WHEN red-first runs THE SYSTEM SHALL run the acceptance tests against a stub of the card's declared interface, and SHALL count the card as red only if every acceptance test fails at an assertion; a failure at import, compilation, collection or setup SHALL stop the card with `tests_not_red_for_reason`, naming the test and the error.
- **GT-TQ-2** WHEN a behaviour card's acceptance tests pass against any trivial implementation of its interface (a body returning the return type's default value — `0`, `""`, `false`, `[]`, `{}`, `undefined` — or returning its first argument unchanged) THE SYSTEM SHALL stop the card with `vacuous_tests` naming the stub and the passing tests when the profile makes stub-kill blocking, and record it as advisory otherwise.
- **GT-TQ-3** WHEN the mutation gate runs THE SYSTEM SHALL report two scores: the diff's mutants killed by the whole suite, and the diff's mutants killed by the card's acceptance tests alone, each over non-equivalent mutants.
- **GT-TQ-4** WHEN a mutant fails the typecheck, or its transpiled output is identical to the original's THE SYSTEM SHALL exclude it from both scores and count it as stillborn or equivalent.
- **GT-TQ-5** WHEN a mutant survives the acceptance tests THE SYSTEM SHALL route it as a test gap to the test-author step or to a person, and SHALL NOT present it to the Worker as a failure.
- **GT-TQ-6** WHEN the test-smell lint finds an acceptance test with no executed assertion, an assertion whose expected value is computed by the code under test, or an assertion on two constants THE SYSTEM SHALL fail it at every profile above prototype; WHEN the test runner offers `requireAssertions` (Vitest `expect.requireAssertions`) THE SYSTEM SHALL enable it for the acceptance-test run.
- **GT-TQ-7** WHEN a `characterize` card's tests fail on the base THE SYSTEM SHALL refuse them; WHEN they pass on the base THE SYSTEM SHALL treat that as the card's green-on-base proof and SHALL NOT stop it with `vacuous_tests`.
- **GT-TQ-8** WHEN a `refactor` card is verified THE SYSTEM SHALL require the characterization and existing tests to pass on the base and on the change, and the index's exported surface of the scope files to be identical, unless the card declares the surface change.
- **GT-TQ-9** WHEN a card's evidence is compiled THE SYSTEM SHALL include the test-strength record of rule 32a and whether it meets the project's depth profile, and a requirement whose record does not meet it SHALL be reported as *passing, strength unmet*.

### NEW-gates-7 — gates for existing codebases

*Justification:* on a team repository the default `protected` globs protect every existing test, so a behaviour change that contradicts one is unbuildable; existing type and lint errors fail every card's first run; a rename cannot fit three files; and impact-first testing must know package boundaries ([research](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) decisions 8–11; basedpyright's baseline).

- **GT-BF-1** WHEN a test on the base fails after a card and the card lists that test as superseded, with its new version staged THE SYSTEM SHALL not restate it as a regression, and SHALL list the supersession in the evidence bundle.
- **GT-BF-2** WHEN onboarding completes THE SYSTEM SHALL record the pre-existing static diagnostics and failing tests as a baseline event, keyed by file, rule and a fingerprint that survives line moves; WHEN a gate runs THE SYSTEM SHALL report only diagnostics absent from the baseline, and SHALL shrink the baseline when a baselined diagnostic disappears.
- **GT-BF-3** WHEN a card's diff contains edits applied by a declared mechanical tool (rename, codemod) THE SYSTEM SHALL record those lines as tool-applied, count them against `max_tool_applied_lines`, and require the typecheck and the full suite to pass.
- **GT-BF-4** WHEN a card's changed files belong to a workspace package THE SYSTEM SHALL run first the tests of that package and of its dependents, in build order.

### NEW-gates-8 — the `change` field and the test-strength record on the card

*Justification:* the `change` field and the strength record are fields every later format reads (the requirement graph, sync, measurement); fixing them now avoids a migration of every card row ([research](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) decision 7).

- **GT-N8-1** WHEN a card is created in a repository with history THE SYSTEM SHALL store exactly one `change` of `feature`, `fix`, `characterize`, `refactor` or `upgrade`, and SHALL refuse any other value; a card on a new project SHALL default to `feature`.
- **GT-N8-2** WHEN red-first runs THE SYSTEM SHALL apply the red/green rule of the card's `change` from rule 6b, one table in code read by the runner and the gates, and SHALL NOT read `kind` or `split` to choose it.

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
- **GT-11** WHEN a staged acceptance test adds a file THE SYSTEM SHALL NOT count its lines or file against the bounds.
- **GT-12** WHEN a base test removed by a card is longer than 4,000 characters THE SYSTEM SHALL tell the Worker to say so with `note` and finish, and SHALL NOT carry the content.

## 7. Later

- **Structural diffs** (difftastic) in the evidence bundle (`structuralDiff`) — useful to reviewers, not required for acceptance in v1.
- **A model-based equivalent-mutant judge** (ACH-style). It needs a model load on a 24 GB host; the transpile-identity filter comes first, and a judge is considered only for production and regulated survivors, and only if waivers turn out frequent.
- **Coverage-guided test augmentation** (SWE-ABS, UTBoost style) on user projects. It generates tests against the Worker's implementation — actual behaviour — so it is acceptable only as test-gap proposals to a person.
- **A per-layer `runs_on` host.** v1 has one gate host per project (rule 11); splitting layers across hosts waits for a second host.
- **A benchmark gate for performance criteria** (hyperfine: *proposed*) — until a card carries a measurable performance criterion.
- **A spelling gate in the hygiene layer** (typos: *proposed*) — low value against its false positives on identifiers until measured.
- **A Python index adapter** (tree-sitter-python and its tags query, `web-tree-sitter` — a proposal, §8 Q7), with the criterion kept for when it is built: **IX-6** WHEN a Python file is indexed with the Python adapter enabled THE SYSTEM SHALL produce the same fact kinds as for TypeScript, with `parseStatus` set from error and missing nodes. v1 keeps Python at a flat map and an unchecked parse ([DEC-20](../DECISIONS.md#dec-20)); the interface and fact schema IX-1 fixes are what make the adapter an addition, not a redesign.
- **Rust, Go and Java/Kotlin index adapters** — same interface as T2; their functional gates stay meanwhile ([DEC-20](../DECISIONS.md#dec-20)). SCIP or stack-graph precise indexes — heavier than the gates' needs; only for cross-repository navigation.
- **Reading CI results as blocking gates** (webhooks for check suites, mapping required checks). The schema field is fixed now (rule 35, [kernel.md](kernel.md) rule 37); the behaviour comes with the integrations workstream after v1.
- **Coverage delta** as a robustness check — after mutation is stable per project.
- **Public vision baselines or a second local verifier ranking passing samples** — only if it beats gate-only selection at equal wall-clock ([worker-loop.md](worker-loop.md)).

## 8. Open questions

1. **Playwright, pixelmatch and axe-core versus the in-house CDP client.** The old design named the libraries; the code uses its own CDP client, PNG decoder and an axe-style subset. *Recommendation:* keep the in-house client for the gate (no browser download, works offline) and add `axe-core` for the accessibility check only if the owner approves it (MPL-2.0, dev-only — *proposed*).
1a. **Stryker.** Adopt `@stryker-mutator/core` (Apache-2.0) only if a suite A/B shows its operator set kills more real faults than the built-in mutator at acceptable cost — *proposed*.
2. **DoD §2B's two negative tests per happy path.** No package meets it (gates is at 0.62). *Recommendation:* make it risk-based — required for gates, kernel and security, aspirational elsewhere — and record that in the DoD.
3. *Decided* ([DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)). **The field name for what a card does to existing code** is `change`, a separate stored field from `kind`; [NAMING.md](../NAMING.md) holds the pair.
4. **Change kinds in v1 — owner decision [O10](../../reference/OPEN_QUESTIONS.md#owner-decisions).** *Recommendation (O10's default):* yes — without them, brownfield planning conflicts with GT-P1 (every refactor and characterization card stops with `vacuous_tests`); they are rule changes, not new machinery.
5. **Stub-kill blocking from *internal tool* up, or only from *production* (owner decision).** *Recommendation:* from *internal tool*: it costs two or three test runs and catches the commonest vacuous test.
6. **Pin `@typescript/typescript6` for the harness's parser, or stay on `typescript` 5.9 until 7.1's API ships (owner decision; the package is a proposal).** *Recommendation:* stay on 5.9 behind the TypeScript adapter now (no new dependency), and pin `@typescript/typescript6` (Apache-2.0, published by the TypeScript team) only when a target project needs 6.0 syntax the 5.9 parser rejects.
7. **`web-tree-sitter` now, or only when Python becomes a target (owner decision; a proposal).** *Recommendation:* fix the interface and the fact schema in T2 now with the TypeScript adapter only; add `web-tree-sitter` (MIT, WASM, no native build) with the Python adapter.
8. **Person approval of tests at *production*.** Example tables of must-haves only, or every test file? This is [planner-pm.md](planner-pm.md)'s to decide; the table in rule 32a carries the research's recommendation (example tables only).

## 9. Evidence and rationale

- Review: [domain06_gates_dod.md](../../reference/reviews/domain06_gates_dod.md) (F1–F16, reproduced false positives and fail-open paths).
- Runs: [SUITE_RUNS.md](../../reference/SUITE_RUNS.md) — run 1 (the one-step remedy rule), run 3 (`tests/.gitkeep` and the regression remedy), run 5 (the staged-test secret).
- The design choices of the reachability gate — not "no production caller" (would fail every leaf card), not the fixture layout alone (failed every repository without `acceptance/`), erring toward reachable — were each forced by a failing run; they are not to be re-proposed without new evidence.
- Grounded over textual gates: arXiv:2609.02750.
- Research: [DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) — test strength (LLM oracles: arXiv:2410.21136; weak tests and false "solved": PatchDiff arXiv:2503.15223, UTBoost arXiv:2506.09289, SWE-ABS arXiv:2603.00520, arXiv:2604.01518), mutation at review scale (Google arXiv:2102.11378; Meta ACH arXiv:2501.12862; trivial compiler equivalence, ICSE 2015), extreme mutation and pseudo-tested methods (Descartes arXiv:1811.03045, arXiv:1807.05030), characterization tests (arXiv:2603.23443), baselines (basedpyright), workspaces (pnpm filtering, `vitest --changed`), TypeScript 7.0's missing API and the measured tree-sitter recoveries (6/422 files). [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 12 (gate results name their source; external results advisory unless declared).
- *Changed on purpose:* the parse gate uses the TypeScript compiler, not tree-sitter, and other languages pass unchecked until their adapter exists ([DEC-20](../DECISIONS.md#dec-20)) — tree-sitter recovers from errors, which is right for a map and wrong for a gate; the old design's wrapping of Playwright, pixelmatch and axe-core became an in-house CDP client pending the owner (§8 Q1), with every required behaviour kept (rule 29); mutation is the built-in diff mutator for TypeScript, with each language's own tool only when installed (rule 23a).
- Integration review: C6 (one `biome` call).
- Independent review of design v3 ([design_v3_review.md](../../reference/reviews/design_v3_review.md)): B3 (`change` is a separate field, [DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run); §8 Q3 decided), M5 (GT-N4-2's rates, GT-T2-4 as system behaviour), M17 (IX-6 to Later), M19 (the defaults table), m1 (criterion order), depth item 7 (no impacted-tests-first before T2).
- Decisions: [DEC-02](../DECISIONS.md#dec-02) (gates decide; the model never certifies its own work), [DEC-20](../DECISIONS.md#dec-20) (non-TypeScript languages keep their functional gates), [DEC-08](../DECISIONS.md#dec-08) (SPDX libraries approved for the licence gate).
- Integrity gate: ARIS (arXiv:2605.03042), "plausible unsupported success" ([IMPLEMENTATION_AUDIT.md](../../research/IMPLEMENTATION_AUDIT.md) §3). Harness-supplied reproduction tests over agent-written ones: Agentless (arXiv:2407.01489, +5 points) and arXiv:2602.07900, in [WORKER_METHOD_LITERATURE.md](../../research/WORKER_METHOD_LITERATURE.md) §4.
