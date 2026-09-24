# Design research: test quality, existing codebases, and multi-language groundwork

*Research for the design stage, 2026-09-22. Scope: (1) test quality as the foundation of "done" ([gates](../design/specs/gates.md), [planner-pm](../design/specs/planner-pm.md), [measurement](../design/specs/measurement.md)); (2) working on existing codebases ([surface](../design/specs/surface.md), [planner-pm](../design/specs/planner-pm.md), [context](../design/specs/context.md), [worker-loop](../design/specs/worker-loop.md)); (3) multi-language groundwork for the AST source index, COVERAGE T2 ([context](../design/specs/context.md), [gates](../design/specs/gates.md)). The spine is taken as fixed. Every library named here is a **proposal** needing the owner's yes ([DEC-08](../design/DECISIONS.md#dec-08)).*

*Source marks: a claim from an abstract or page that was opened is cited by link; **[search]** means seen only in a search-result snippet; **uncertain** means not verified. Measurements marked **[measured here]** were run on this machine (Apple Silicon, Node 26.0.0) on 2026-09-22 in the scratchpad, against this repository's own 422 TypeScript source files (3.74 MB); one run each, repeated once, so they are orders of magnitude, not benchmarks.*

---

## 1. What the design must decide now

| # | Decision | Recommendation | Evidence | Lands in | What breaks later if not decided |
| --- | --- | --- | --- | --- | --- |
| 1 | **Is a planner-written acceptance test trusted as the oracle of "proven"?** | No. A requirement is *proven* only when its tests pass **and** carry a test-strength record that meets the depth profile's rule (§3.1). Otherwise the requirement shows *passing, strength unmet*, never *proven*. | LLM oracles often encode the wrong expectation ([2410.21136](https://arxiv.org/abs/2410.21136)); weak tests let one in five "solved" SWE-bench patches through ([SWE-ABS, 2603.00520](https://arxiv.org/abs/2603.00520)); 77% of SWE-bench instances admit a surviving wrong variant ([2604.01518](https://arxiv.org/abs/2604.01518)). The audit's reason for not measuring test strength ("the Worker never writes the acceptance tests") overlooks that the **Planner, a model, does** ([IMPLEMENTATION_AUDIT §2](IMPLEMENTATION_AUDIT.md)) | planner-pm §2.15, gates, measurement | P13's "proven" count becomes a count of tests that passed, including tests that cannot fail; DEC-11 then certifies projects on a model's word one level removed |
| 2 | **Red for the right reason** | Red-first counts only when the acceptance tests fail **at an assertion** against a harness-generated stub of the card's declared interface, not at import, compile or setup | Practitioners report agents treating compiler errors as a satisfied red step ([anthropics/claude-code#94753](https://github.com/anthropics/claude-code/issues/94753) [search]); the gates spec judges only pass/fail (gates §2 rule 6) | gates (P1), planner-pm (P1 interface) | A test with a broken import is "red" for ever and "green" as soon as the file exists, whatever the code does |
| 3 | **A pre-build "can this test fail?" check** | Run the staged tests against a few trivial implementations of the declared interface (throw, type-default return, identity). The card's test set must fail against every one; a criterion whose tests pass a trivial stub is flagged | Extreme mutation finds pseudo-tested methods at a fraction of the cost of full mutation ([Descartes, 1811.03045](https://arxiv.org/abs/1811.03045); [pseudo-tested methods study, 1807.05030](https://arxiv.org/abs/1807.05030)) | gates (P1), planner-pm | The only strength check left is post-build mutation, after the Worker's budget is spent; a vacuous test costs a whole card before anyone notices |
| 4 | **Two mutation numbers, not one** | Keep the suite-level diff mutation score (robustness). Add an **acceptance-test mutation score**: mutants of the card's diff run against the card's acceptance tests only. The second one feeds "proven"; its survivors go to the test author, never to the Worker | Diff-based mutation at code review works at scale ([Google, 2102.11378](https://arxiv.org/abs/2102.11378)); survivors are turned into test work, not code work ([Meta ACH, 2501.12862](https://arxiv.org/abs/2501.12862)); gates GT-M6-4 already forbids asking the Worker for tests | gates rule 32, measurement M10 | "Proven" and "robust" stay conflated: a requirement can count as proven because some unrelated old test killed the mutants |
| 5 | **Criterion-to-test traceability in the test file** | Every acceptance test names the criterion id(s) it proves, in a form the index can read (test title prefix or tag). Behaviour tests are written as **example tables** (`it.each` / `pytest.mark.parametrize`) with one row per concrete case | Kiro links criteria to properties ([kiro.dev, 2025-11-17](https://kiro.dev/blog/property-based-testing/)); traceability both ways is already required (planner-pm §2.15.2) but stops at the card, not the test | planner-pm P1/P13, dashboard | The requirement graph cannot say *which* test proves *which* criterion; a person cannot review tests quickly; stub-kill and mutation cannot be reported per criterion |
| 6 | **Who approves what** | A person always approves **criteria**. Tests are approved by a person according to the depth profile: never for *prototype* and *internal tool*; the example tables of must-have requirements for *production*; every acceptance-test file and every mutation waiver for *regulated*. An approved test that changes loses its approval | Tests used as intent clarification lowered programmers' cognitive load and raised correct evaluation of AI code ([TiCoder user study, 15 programmers, 2404.10100](https://arxiv.org/abs/2404.10100)); LLMs are better at writing oracles than judging them ([2410.21136](https://arxiv.org/abs/2410.21136)), so a model reviewer cannot replace the person where the stakes are high | planner-pm, design-stage §2.8, dashboard | Either every test waits for a person (the human is the rate limiter, and the Review WIP collapses) or none does (regulated work is proven by unreviewed model oracles) |
| 7 | **Card kinds for existing code** | Four kinds with different red/green rules: `feature` (red on base), `fix` (reproduction test red on base at an assertion), `characterize` (tests **green** on base — they pin today's behaviour), `refactor` (no new behaviour tests; characterization and existing tests stay green; public surface unchanged per the index). Plus `upgrade` for dependencies | Characterization tests are the standard legacy route (Feathers); LLM tests follow *actual* behaviour ([2410.21136](https://arxiv.org/abs/2410.21136)) and stay anchored to the original program (>99% of failing tests after a semantic change pass on the original, [2603.23443](https://arxiv.org/abs/2603.23443)) — a weakness for oracles, a strength for characterization | gates P1 (`vacuous_tests`), planner-pm §2.1–2.3 | GT-P1-1/-2 as written refuse every refactor and every characterization card (their tests pass on the untouched code and would stop with `vacuous_tests`); brownfield work cannot be planned at all |
| 8 | **Superseded expectations** | A card that changes existing behaviour declares which base tests it **supersedes**; the test author stages their new version; the regression gate accepts exactly those, and a person sees each supersession in Review | Gates rule 25 restates any base-test failure as a regression and `protected` covers `**/*.spec.ts` (gates §3) | gates rule 25, planner-pm | In a team repository every behaviour change that contradicts an existing test is unbuildable: the Worker may not edit the test, and the gate refuses its failure |
| 9 | **A diagnostic baseline at onboarding** | Onboarding records the pre-existing type, lint and test failures (keyed by file, rule and a line-insensitive fingerprint) as events; gates report only diagnostics not in the baseline; the baseline only shrinks automatically | basedpyright's baseline reports "only errors on new or modified code" ([docs](https://docs.basedpyright.com/latest/benefits-over-pyright/baseline/)); gates rule 15 already says "judge what the card wrote" but only for secrets, osv, semgrep and mutation | surface (onboarding), gates rule 15 | On any legacy repository with existing type or lint errors, every card fails its static gates on its first run, and the repair ladder spends its rungs on other people's errors |
| 10 | **Mechanical edits are tool-applied and bounded differently** | A rename or codemod is executed by a deterministic tool (language-service rename, a structural rewrite) and verified by the typecheck and tests; its lines are recorded as tool-applied and counted against a separate bound | Agents solve 22% of RefactorBench's multi-file refactors against a human's 87% ([2503.07832](https://arxiv.org/abs/2503.07832)); at Google, LLM migration worked inside a pipeline that located change sites and was reviewed by people ([2504.09691](https://arxiv.org/abs/2504.09691)) | gates rule 12, worker-loop tools | A rename touching 14 files cannot fit 3 files / 200 lines, so it is split into 14 cards that each leave the build broken |
| 11 | **Workspace packages are first-class** | The source index, scope declaration, impact test selection and gate execution know the workspace graph (pnpm/npm/yarn workspaces, TS project references; uv workspaces for Python later). A card's scope should sit in one package where it can | `pnpm --filter "...[origin/master]"` selects changed packages and their dependents ([pnpm](https://pnpm.io/filtering)); `vitest --changed <ref>` runs tests related to changed files ([vitest](https://vitest.dev/config/changed)) | context, gates NEW-gates-3, surface | Impact-first testing (GT-N3-2) and per-package gates have to be retrofitted into an index that thinks in files only |
| 12 | **The source index's shape (T2)** | One language-neutral fact schema (files, packages, module specifiers, imports by kind, exports, re-exports, top-level declarations, references, parse status, parser provenance); per-language **adapters** for parsing and for module resolution; a derived cache keyed by content hash and parser version, rebuildable, never a durable store | The Aider repo map runs on tree-sitter tag queries for many languages ([aider](https://aider.chat/2023/10/22/repomap.html)); grammar packages ship `.wasm` files and `queries/tags.scm` **[measured here]** | gates T2, context §13, worker-loop | Python arrives as a second, parallel index; eight regex parsers become sixteen |
| 13 | **Do not bind the index to the `typescript` JS API** | Keep the in-process TypeScript parser only inside the TypeScript adapter, pinned to 5.9/6.0 (`@typescript/typescript6` re-exports the 6.0 API); nothing outside the adapter imports `typescript` | **TypeScript 7.0 (2026-07-08) ships no API**; "7.1 [is expected] to ship with a new (and different) API" ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)); `typescript@latest` is 7.0.2 and its package exports only `unstable/*` entry points **[measured here, npm registry]**. Sekhemet pins `typescript ^5.7.3` and calls `ts.createSourceFile`, `ts.createScanner` and the language service in-process (`parse_gate.ts`, `builtin.ts:1008`, `ts_service.ts`) | gates T2, context, worker-loop | When 7.1's API lands (or new syntax outruns the 6.0 parser), every gate, the repo map, the parse gate and the mutation operators change at once |
| 14 | **Parse status is part of every fact** | A file parsed with errors, or in a language without an adapter, yields facts marked `recovered` or `unsupported`; any gate that relies on them reports `partial` or `unavailable`, never `pass` | tree-sitter-typescript 0.23.2 left error nodes in 6 of this repo's 422 files (4 from literal NUL bytes in strings, 2 genuine grammar gaps: an `import("x").T[]` type in a property and a property named `abstract?`) where the TypeScript parser reported none **[measured here]** | gates rule 9 (fail closed), SPINE "never claims more" | A recovering parser silently drops an export, and reachability or architecture passes on a file it could not read |

---

## 2. Findings

### 2.1 Test quality as the foundation of "done"

**How good LLM-written tests are**

- LLM test generators tend to write oracles that capture the program's **actual** behaviour rather than the **expected** behaviour; LLMs are better at generating oracles than at classifying which one is correct; meaningful names help; LLM oracles still detect more faults than EvoSuite's. 24 Java repositories. ([Konstantinou et al., 2410.21136](https://arxiv.org/abs/2410.21136), 2024-10)
  - *Implication:* Sekhemet writes tests **before** the code exists, so there is no actual behaviour to copy — the failure mode moves to *wrong expected values* invented from the criterion. A second model asked "is this oracle right?" is the weaker check; executed evidence and a person are the stronger ones.
- Oracles generated from natural-language business requirements on 10 Defects4J bugs, 5 models (including Mistral-7B, Qwen-3): "non-trivial generalization but with substantial bug- and model-level variance"; oracles aligned more with the requirement than with the system under test; the authors call it preliminary. ([Ma & Eisty, 2607.10277](https://arxiv.org/abs/2607.10277), 2026-07)
  - *Implication:* requirement-first oracles are feasible for small open models but not reliable enough to certify alone; the variance argues for per-test strength evidence rather than a per-model trust setting.
- On 3,909 complex, uncontaminated Python functions, LLM-generated tests averaged 41.32% accuracy, 45.10% statement coverage, 30.22% branch coverage and a 40.21% mutation score; on the older, simpler TestEval the same measures were 91.79/92.18/82.04/49.69%. ([Huang et al., ULT, 2508.00408](https://arxiv.org/abs/2508.00408), 2025-08)
  - *Implication:* test quality falls steeply with code complexity; card-sized behaviours (≤ 200 lines) are the regime where it is best, which is one more reason to keep cards small.
- Meta's TestGen-LLM: 75% of generated test cases built, 57% passed reliably, 25% increased coverage; 73% of its recommendations were accepted by engineers — *after* a filter pipeline of build, pass and coverage gain. ([Alshahwan et al., 2402.09171](https://arxiv.org/abs/2402.09171), 2024-02)
  - *Implication:* industrial use of model-written tests rests on executable filters before a person sees them — the same shape as the checks proposed here.
- LLM-generated tests consistently show smells such as Assertion Roulette and Magic Number Test; 20,505 class-level suites from four LLMs including Mistral 7B; patterns depend on prompting, context length and model size. ([Ouédraogo et al., 2410.10628](https://arxiv.org/abs/2410.10628), TOSEM)
  - *Implication:* a test-smell lint on the Planner's staged tests is cheap and catches the most common defects; the integrity gate today checks only the Worker's added lines, excluding staged tests (gates rule 13).
- When the Worker writes its own tests, value-revealing prints appear far more often than assertions, and the tests barely change success while costing 33–49% more input tokens. ([2602.07900](https://arxiv.org/abs/2602.07900), already in [WORKER_METHOD_LITERATURE](WORKER_METHOD_LITERATURE.md) §4)
  - *Implication:* confirms the design's choice that the harness, not the Worker, supplies tests — and therefore the harness owns their strength.

**Weak tests make false "proven"**

- On SWE-bench Verified, 29.6% of plausible patches behave differently from the developer's patch; 28.6% of those are certainly incorrect; 7.8% of patches pass while failing the full developer suite; resolution rates inflated by 6.2 points. ([PatchDiff, 2503.15223](https://arxiv.org/abs/2503.15223v2), ICSE 2026)
- UTBoost found 36 SWE-bench tasks with insufficient tests and 345 wrongly passed patches, changing 40.9% of Lite and 24.4% of Verified leaderboard entries. ([2506.09289](https://arxiv.org/abs/2506.09289), 2025-06)
- SWE-ABS: after coverage- and mutation-driven test strengthening, "one in five 'solved' patches from the top-30 agents are semantically incorrect"; the top agent fell from 78.80% to 62.20%. ([2603.00520](https://arxiv.org/abs/2603.00520), 2026-02, ICML 2026)
- Program-variant probing: 77% of instances admit at least one surviving variant; 1,014 added tests cut the top-10 agents' resolved rates by 4.2–9.0%. ([2604.01518](https://arxiv.org/abs/2604.01518), 2026-04)
  - *Implication (all four):* human-written tests on real projects already let 8–20% of wrong patches through. Model-written tests will not do better. "Proven" must be conditioned on a measured strength, and the planning measure's premature-completion rate (measurement §5, T7) is the right end-to-end check.

**Mutation testing as a test-strength gate**

- Google runs mutation testing incrementally on changed code during code review, limiting mutants per line and per review and filtering unproductive ("arid") mutants — "orders of magnitude fewer mutants" — for more than 24,000 developers on more than 1,000 projects. ([Petrović et al., 2102.11378](https://arxiv.org/abs/2102.11378), 2021)
  - *Implication:* the gates spec's diff-scoped, capped mutation (rule 32; `mutation_max` 8 today) matches the only practice proven at scale. Keep it; add the arid-line filter (logging, debug output, pure constants).
- Trivial Compiler Equivalence: compiling each mutant and comparing object code identifies 7.4% (C) and 5.7% (Java) of all mutants as equivalent and a further 21% / 5.4% as duplicates — about half of the known equivalent mutants for Java. ([Papadakis et al., ICSE 2015](http://web4.cs.ucl.ac.uk/staff/Y.Jia/resources/papers/PapadakisJHT2015.pdf))
  - *Implication:* for TypeScript, the cheap analogue is to transpile each mutant and drop those whose emitted JavaScript is identical to the original's, and to drop mutants that fail the typecheck ("stillborn"). This is a proposal and unmeasured for TypeScript.
- Meta ACH: an LLM equivalent-mutant detector with precision 0.79 and recall 0.47, rising to 0.95 and 0.96 with simple pre-processing; 9,095 mutants, 571 tests, 73% of tests accepted by engineers. ([Foster et al., 2501.12862](https://arxiv.org/abs/2501.12862), FSE 2025 industry)
  - *Implication:* equivalent mutants are the reason the design refuses a 100% threshold (rule 32); a model-based equivalence judge is viable but costs a model load — on the 24 GB host, run it only on survivors, and only for *production* and *regulated*.
- The correlation of coverage and mutation scores with real-bug detection is "highly context-dependent" for LLM-generated suites. ([Zhao et al., 2607.22880](https://arxiv.org/abs/2607.22880), 2026-07)
  - *Implication:* mutation score is a floor detector (it proves a test *can* fail), not a proof of correctness. Use it to flag weakness, never to certify.
- Extreme mutation (replace a whole method body with a default return) finds *pseudo-tested* methods — covered, yet no test fails when the body is removed — with far fewer mutants than classic operators. ([Descartes, 1811.03045](https://arxiv.org/abs/1811.03045), ASE 2018; [study, 1807.05030](https://arxiv.org/abs/1807.05030))
  - *Implication:* the same idea runs **before** the build: the card's declared interface (planner-pm P1) is exactly the set of bodies to stub. Stub-kill is extreme mutation applied to a not-yet-written implementation, costing a handful of test runs.
- StrykerJS (Apache-2.0, v10.0.0, 2026-08) supports line-range mutation (`--mutate src/app.js:5-7`) and an incremental mode that reuses results; its limits include not detecting changes outside mutated and test files and not tracking environment or snapshot changes. ([docs](https://stryker-mutator.io/docs/stryker-js/incremental/))
  - *Implication:* Sekhemet's in-house single-token mutator (`builtin.ts:1008`) already does diff-line mutation without a dependency; Stryker is worth adopting only if its operator set measurably kills more real faults on the suite. Python has mutmut (BSD-3-Clause) when Python gates arrive.

**Property-based tests derived from criteria**

- Kiro turns spec acceptance criteria into "for any …" properties and then into Hypothesis tests run by pytest; it calls this "significantly stronger evidence of correctness than example-based testing alone" and states that PBT "can't guarantee your program is absent of bugs". ([kiro.dev, 2025-11-17](https://kiro.dev/blog/property-based-testing/))
- With the best model and prompt, a valid and sound property-based test took 2.4 samples on average; GPT-4 synthesised correct PBTs for 21% of the properties extractable from API documentation. 40 Python API methods. ([Vikram et al., 2307.04346](https://arxiv.org/abs/2307.04346), 2023/2024)
- PBT-Bench: 100 problems, 40 Python libraries, 365 bugs, 8 models: bug recall 42.1–83.4% with hypothesis-guided prompting against 31.4–76.7% open-ended; the structured prompt helped mid-capability models by over 20 points and sometimes hurt the strongest. ([Jing et al., 2605.15229](https://arxiv.org/abs/2605.15229), 2026-05)
  - *Implication:* PBT is the natural test form for the planner's *hard invariants* ("never", "exactly once", "idempotent", round-trip), which the planner already schedules early (planner-pm §2.2.3). A structured prompt (name the property kind: invariant, round-trip, idempotence, oracle comparison, metamorphic) is what small models need. fast-check (MIT, v4.10.2, 2026-09) for TypeScript; Hypothesis (MPL-2.0) for Python. Fix the seed and record it, so a property run replays exactly (spine rule 2).

**Differential and metamorphic testing**

- Differential patch testing exposes behaviour differences between two patches (PatchDiff above); CodeT's "dual execution agreement" ranks code samples by consistency with generated tests *and* agreement with other samples (HumanEval pass@1 65.8%, +18.8 points). ([2503.15223](https://arxiv.org/abs/2503.15223v2); [CodeT, 2207.10397](https://arxiv.org/abs/2207.10397))
  - *Implication:* two cheap differential uses fit Sekhemet. (a) **Refactor cards:** the base branch is the oracle — run the characterization and existing tests on base and on the change; any difference fails. (b) **Oracle cross-check:** for must-have criteria in *production*/*regulated*, sample the expected values of each example row twice, independently; a disagreement becomes a `DecisionRequest` to the person rather than a silent choice. The audit's reason for rejecting differential testing ("needs a human oracle patch") does not apply to (a), whose oracle is the base.
- Metamorphic relations (e.g., sorting is permutation-invariant; adding an item then removing it restores the total) are properties by another name and use the same PBT machinery. No local-model evidence found; **uncertain** whether small models write valid relations reliably.
  - *Implication:* treat metamorphic relations as one property kind in the structured PBT prompt, not as a separate mechanism.

**Human approval of tests versus criteria**

- TiCoder: 15 programmers who clarified intent through generated tests were "significantly more likely to correctly evaluate AI generated code" and reported "significantly less task-induced cognitive load"; the 45.97% absolute pass@1 gain came from an **idealised simulated user**, not from the people. ([Fakhoury et al., 2404.10100](https://arxiv.org/abs/2404.10100), TSE 2024)
  - *Implication:* approving *examples* is a cheap, effective human act; approving code is not the same act. Render each behaviour test as its example table (given → expected) for approval.
- Böckeler's experiments on TDD inside agent loops found no clear difference between TDD and non-TDD workflows, 3–8.5× the tokens for TDD, no meaningful mutation-score difference, and now recommend mutation testing for regression quality and human-approved scenarios. ([martinfowler.com](https://martinfowler.com/articles/exploring-gen-ai/tdd-in-the-agent-loop.html); date **uncertain**, 2026)
  - *Implication:* the value of red-first here is not the ritual but the **harness-owned oracle**; its strength must be checked by execution (stub-kill, mutation), and the person's time is best spent on scenarios.
- LLMs judge acceptance criteria well against a rubric even though they write them less well than people (Quattrocchi et al., 2507.15157, already cited in planner-pm §9).
  - *Implication:* an independent model can check **spec-to-test fidelity** (does every criterion have a test that exercises it?) as a fail-only advisory, the same way the vision checklist can fail but never pass (gates rule 30).

### 2.2 Working on existing codebases

**Issue to card: localisation for small models**

- Agentless localises in stages (file, then class/function, then edit location); showing a file skeleton instead of full files raised localisation accuracy from 53.67% to 58.33% at a seventh of the cost; skipping straight to the edit location was worse. ([2407.01489](https://arxiv.org/abs/2407.01489), in [WORKER_METHOD_LITERATURE](WORKER_METHOD_LITERATURE.md) §2)
- LocAgent turns a repository into a graph of files, classes and functions with import, call and inheritance edges; up to 92.7% file-level accuracy; a fine-tuned Qwen2.5-Coder-32B was comparable to proprietary models at about 86% lower cost. ([2503.09089](https://arxiv.org/abs/2503.09089), 2025-03)
- SweRank's retrieve-and-rerank beat agent-based localisation with Claude-3.5 on SWE-Bench-Lite and LocBench at lower cost ([2505.07849](https://arxiv.org/abs/2505.07849), ICLR 2026); its successor reports a 0.6B embedding reranker nearly matching an 8B one **[search]** ([2512.20482](https://arxiv.org/html/2512.20482)).
- Role-aware file summaries reached up to 40% Hit@5 with a representation 10.4–20.9× smaller than raw code; raw code was better but far costlier. ([Caumartin et al., 2607.11046](https://arxiv.org/abs/2607.11046), 2026-07)
- Repository guidance tuned by probing with synthetic bug fixes lifted **Qwen3.5-35B-A3B** — the same size class as the Worker — from 25.5% (no guidance) and 28.3% (static knowledge base) to 33.0% on SWE-bench Verified, entirely through better *coverage* (finding the right files: +14.5 points more evaluable patches) with per-patch precision unchanged; a smaller Nemotron-3-Nano-30B-A3B gained less. ([Shepard & Albrecht, 2606.20512](https://arxiv.org/abs/2606.20512), 2026-06)
- 72–81% of failed agent runs still found the right file; failures happen after localisation ([2511.00197](https://arxiv.org/abs/2511.00197), in WORKER_METHOD_LITERATURE §5).
  - *Implication (all):* localisation belongs to the Planner's scope declaration, outside the Worker's budget, as context §22 already says — and it should be **structural and staged**: package → file (by symbol table, reference graph and lexical search over identifiers) → symbol outline. Embedding retrieval stays rejected (DEC-22); its measured advantage is for large rerankers, and a resident embedder costs the Worker's memory. A deterministic one-line *role* per file (its exports and first doc comment, from the index) is the cheap analogue of role-aware summaries; model-written summaries are a Later A/B. Guidance that improves *which files are found* is what helps a 35B-A3B model, so onboarding's playbook should hold location facts ("HTTP handlers live in `src/routes/`"), not style prose.
- When a failing test exists (a bug report with a reproduction), spectrum-based fault localisation ranks lines by how often failing versus passing tests execute them; AutoCodeRover used it alongside AST search ([2404.05427](https://arxiv.org/abs/2404.05427), in WORKER_METHOD_LITERATURE §2).
  - *Implication:* for `fix` cards, V8's built-in coverage (`NODE_V8_COVERAGE`, no dependency) over the reproduction test and the passing suite gives a ranked suspect list for scope declaration. Proposal; unmeasured here.

**Legacy code without tests**

- Characterization (golden-master) tests record what a system does today before it is changed (M. Feathers, *Working Effectively with Legacy Code*, 2004; [overview](https://understandlegacycode.com/blog/characterization-tests-or-approval-tests/)).
- LLM tests follow actual behaviour ([2410.21136](https://arxiv.org/abs/2410.21136)); after a semantic change, over 99% of the LLM tests that fail still pass on the original program ([Haroon et al., 2603.23443](https://arxiv.org/abs/2603.23443), 2026-03).
  - *Implication:* the tendency that makes model oracles risky for new behaviour makes them good at **characterization**: the base is the oracle, so a characterization test's expected values can be *recorded by running the code*, not invented. Vitest's snapshot assertions (`toMatchSnapshot`, `toMatchFileSnapshot`) and pytest's plain equality on recorded values need no new dependency. A characterization card is green on base by definition, which the red-first rule must allow (decision 7).
- "Assured LLM-based software engineering" frames refactoring as candidate generation filtered by regression tests ([2402.04380](https://arxiv.org/abs/2402.04380)).
  - *Implication:* a `refactor` card's gate is "the same tests pass before and after, and the public surface is unchanged" — both checkable without a new oracle.

**Fitting large repositories into a 16k window**

- The design already caps the repo map at 1,200 tokens by PageRank seeded on the card's scope (context §13) and keeps Zone 3 ≤ 0.50W; SWE-agent found 100-line windows best and whole files worst (WORKER_METHOD_LITERATURE §1).
- Multi-subsystem changes suffer from linear exploration; domain-scoped exploration helped a small (Haiku-class) model most, while multi-agent consultation added tokens without better localisation. ([2606.11976](https://arxiv.org/abs/2606.11976), 2026-06)
  - *Implication:* in a large repository or monorepo, rank at two levels: a **package map** (one line per workspace package: name, role, dependencies) when the repository has more packages than fit, then the file PageRank inside the packages the scope touches. Do not add agents; add structure.

**Monorepos and workspaces**

- pnpm selects packages changed since a ref and their dependents with `--filter "...[origin/master]"` ([pnpm](https://pnpm.io/filtering)); `vitest --changed <ref>` runs tests related to changed files through the module graph, with config and `package.json` changes forcing a full run ([vitest](https://vitest.dev/config/changed)); Nx and Turborepo do the same by project graph **[search]**.
  - *Implication:* GT-N3-2's "tests reachable from the card's scope first" can be computed from the index's import graph plus the workspace graph without a new tool; the project's own runner flags are a fallback. The index must know package boundaries, entry points (`exports` maps) and TS project references.
- Sekhemet's own layout (workspace packages resolving each other through `dist/`, CLAUDE.md) is itself the case: a change in one package is seen by another only after a build.
  - *Implication:* a card whose scope crosses a package boundary needs the build step as a gate before dependents' tests; the gate runner must know the build order.

**Respecting a team's conventions**

- Repository context files (AGENTS.md and similar) did **not** generally improve task success, whether LLM-generated or developer-written, and raised inference cost by over 20%; agents follow their instructions well; "repository overviews … are not helpful"; the authors advise minimal requirements only. ([Gloaguen et al., 2602.11988](https://arxiv.org/abs/2602.11988), 2026-02)
  - *Implication:* onboarding's convention extraction (surface §9) should turn conventions into **gates** where possible (the team's linter and formatter config run as-is) and into short, evidence-linked location facts otherwise; the drafted AGENTS.md block should be minimal. Prose conventions in the Worker's Zone 2 must earn their place by the playbook A/B (context §24).
- basedpyright's baseline suppresses existing errors and reports new ones, matching by file, rule and column, and shrinks automatically as errors are fixed ([docs](https://docs.basedpyright.com/latest/benefits-over-pyright/baseline/)).
  - *Implication:* decision 9 — generalise gates rule 15 into a recorded diagnostic baseline for every static gate.
- CI as a gate source is already specified (surface §9, SUR-8); CI steps needing services, secrets or matrix entries map onto gates' `needs` (GT-T1-7) and become `unavailable`, not failures.
  - *Implication:* no new mechanism; the deriver must record *why* each CI step was or was not turned into a gate, so a person can see the coverage gap.
- The default `protected` globs (`**/*.spec.ts`, `**/*.test.ts`, gates §3) protect every existing test in a team repository.
  - *Implication:* decision 8 (supersession) is required for any behaviour change in a tested codebase.

**Refactoring cards and dependency upgrades**

- RefactorBench: 100 multi-file refactoring tasks; agents solved 22% with base instructions against 87% for a time-limited human; conditioning on a representation of state improved the agent by 43.9%. ([2503.07832](https://arxiv.org/abs/2503.07832), 2025-03)
  - *Implication:* multi-file mechanical changes are where small models fail; make them tool work (language-service rename, structural rewrite), verified by typecheck and tests (decision 10).
- Google: across 39 migrations, 74.45% of code changes and 69.46% of edits were LLM-generated, with an estimated 50% time saving, inside a workflow that found change locations first and was reviewed by developers. ([Ziftci et al., 2504.09691](https://arxiv.org/abs/2504.09691), 2025-04)
- DEPBENCH: 203 real dependency-upgrade repair tasks across five ecosystems; the best configuration solved 104 (51.2%). ([Luo et al., 2608.30300](https://arxiv.org/abs/2608.30300), 2026-08)
- BreakGuard: LLM-generated client tests detected about 30% of 89 real breaking changes, more reliably crashes than behavioural changes. ([Raj et al., 2608.20167](https://arxiv.org/abs/2608.20167), 2026-08)
  - *Implication:* an `upgrade` card should be a pipeline, not a prompt: the version bump and lockfile change are done by the package manager (a tool, not the model); the gates run; each failing site becomes a child `fix` card with the changelog diff the Researcher already produces (design-stage §2.7 rule 10). Characterization tests on the client code that calls the upgraded library are the cheap guard for behavioural breakage, which generated tests miss most often. Renovate (AGPL-3.0) must not be embedded; its and Dependabot's PRs can be imported as cards (integrations).

### 2.3 Multi-language groundwork

**The TypeScript situation changed in July 2026**

- TypeScript 7.0 (native Go port) was released 2026-07-08; "it does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API"; `@typescript/typescript6` provides `tsc6` and re-exports the 6.0 API; TS 7 uses 6–26% less memory than 6.0 on the tested codebases. ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/))
- npm registry, 2026-09-22 **[measured here]**: `typescript` dist-tag `latest` = 7.0.2; its `exports` are `./lib/version.cjs` plus `./unstable/{ast,sync,async,fs,proto,…}`; `@typescript/typescript6` 6.0.2 (Apache-2.0). The staging repo `microsoft/typescript-go` is archived and lists "API: not ready", "Language service (LSP): in progress".
- TS 7's language server is started as `tsc --lsp --stdio` **[search]**; `typescript-language-server` 6.0.0 (Apache-2.0, 2026-08-20) still wraps `tsserver` from TS ≤ 6.
  - *Implication:* the harness's own parsing must be isolated behind the index (decision 13). The project gates can keep running the **project's** `tsc` (7 or earlier) as a CLI — that is unaffected. The Worker's symbol tools (`ts_service.ts`) should talk LSP so they can use either `typescript-language-server` or TS 7's native server.

**Tree-sitter**

- `tree-sitter` core, `web-tree-sitter` 0.27.0 (2026-08-30), `node-tree-sitter` 0.25.1, `tree-sitter-typescript` 0.23.2 (2024-11), `tree-sitter-python` 0.25.0 (2025-09): all MIT **[measured here, npm and GitHub]**. The grammar packages ship native prebuilds for six platforms **and** `.wasm` builds **and** `queries/tags.scm` (definition and reference captures — what a repo map needs).
- **[measured here]** Parsing this repository's 422 TypeScript files (3.74 MB): TypeScript 5.9 `createSourceFile` 243 ms, +111 MB RSS; `web-tree-sitter` parse only 395 ms (with tags query 511 ms), +45 MB RSS; `@ast-grep/napi` 0.45.3 parse plus one `findAll` 286 ms, +127 MB RSS (trees retained). The tags query produced 9,912 captures.
  - *Implication:* WASM is about 1.6× slower than the TypeScript parser here and costs less memory; all three are negligible beside the 13 GB Worker and are cacheable by content hash. Native bindings would be faster (a general 1.75–2.5× native-over-WASM figure is **[search]** only) but would give Sekhemet its first native runtime dependency — today its only runtime dependency is `typescript` **[measured here]**. WASM keeps installs free of build tools and ABI breaks on Node upgrades.
- **[measured here]** tree-sitter-typescript 0.23.2 left error nodes in 6/422 files that the TypeScript parser accepted: four files containing a literal NUL character inside a string, `priorHistory?: import("@sekhemet/context").TurnHistoryItem[]` (`packages/loop/src/types.ts:262`), and a property named `abstract?:` (`apps/harness/src/research/web.ts:162`).
  - *Implication:* tree-sitter recovers and keeps going, which is right for a repo map and wrong for a gate that must not miss an export. For TypeScript, keep the exact compiler parser for gate facts; use tree-sitter where approximation is acceptable (repo map) and for languages without an exact in-process parser. Every fact carries its parse status (decision 14).
- **[measured here]** On a small Python sample (relative import, class, method with a `match` statement, function), `tree-sitter-python`'s shipped `tags.scm` returned class and function definitions and call references with no parse error, and flagged a broken `def f(:` as an error. It captured **no import statements**.
  - *Implication:* the grammars' tags queries are enough for the repo map (definitions and references), but the gates' facts — imports by kind, exports, re-exports — need queries written per adapter, plus a per-language module resolver (Python's relative imports, `src/` layouts, namespace packages; TypeScript's `paths`, project references and `exports` maps). That resolver, not the parser, is the larger share of a language adapter's work, which is why IX-2 makes it a separate part of the interface.
- The parse gate's needs are narrower than the index's: parse candidate content in memory, before writing, and return the first error's line and column (worker-loop parse gate, `parse_gate.ts`). Today Python is checked by spawning `python3 -c "import ast…"`, which is exact for the interpreter installed (syntax differs between Python versions) but absent when Python is not installed.
  - *Implication:* keep the exact checker where it exists (TypeScript's parser, the project's `python3`) and use tree-sitter's error and missing nodes as the fallback, stating in the evidence which one ran.

**ast-grep**

- ast-grep (MIT, CLI and `@ast-grep/napi` 0.45.3, 2026-08): structural search and rewrite on tree-sitter grammars; the napi package ships native prebuilt binaries per platform; JavaScript-family languages are built in; Python needs `@ast-grep/lang-python` (ISC) registered with `registerDynamicLanguage`, which requires allowing its install build script under pnpm 10+. ([docs](https://ast-grep.github.io/guide/api-usage/js-api.html))
  - *Implication:* ast-grep is a **tool** (structural search for the Worker and Planner; codemods for decision 10), not the index's foundation: it adds native binaries and a build step for Python, and its value is rewriting, which the index does not need.

**Language servers**

- pyright 1.1.414 (MIT, 2026-09); basedpyright 1.40.1 (MIT, 2026-09-22) adds the baseline feature and Pylance-like features; Astral's `ty` and Meta's `pyrefly` (both MIT, active) are newer and moving fast **[measured here, GitHub/npm metadata]**.
- pyright's language server is reported to exhaust a 2–4 GB Node heap on large projects, often because a virtual environment inside the project is analysed ([pyright#7157](https://github.com/microsoft/pyright/issues/7157), [#3239](https://github.com/microsoft/pyright/issues/3239), [discussion #4941](https://github.com/microsoft/pyright/discussions/4941)) **[search]**.
  - *Implication:* on the 24 GB reference host with a 13 GB Worker, a language server is a memory tenant: start it lazily, cap its heap (`--max-old-space-size`), exclude virtual environments, count it in the memory guard, and never make a gate depend on it being up. Gates read the index; LSPs serve the Worker's symbol tools and the type-check gate runs the project's checker as a CLI. `lsp.ts` already defaults to `pyright-langserver`; basedpyright is a drop-in with the baseline (decision 9) for Python.

**SCIP and stack graphs**

- Sourcegraph's SCIP indexers (e.g. `scip-typescript`, Apache-2.0, active) produce precise cross-reference indexes by running the compiler **[measured here, GitHub metadata]**.
  - *Implication:* a precise-index format is heavier than the gates need (exports, imports, top-level declarations). Not now; revisit only if cross-repository navigation becomes a requirement.

---

## 3. Proposed requirements (EARS)

Numbering is provisional (`NEW-…`); each lands in the named spec's §5.

### 3.1 The test-strength rule by depth profile

| Check | prototype | internal tool | production | regulated |
| --- | --- | --- | --- | --- |
| Criterion lint and criterion → test trace | blocking | blocking | blocking | blocking |
| Test-smell lint on staged tests (no assertion, tautology, assertion only on a constant, swallowed exception, conditional in test) | advisory | blocking | blocking | blocking |
| Red at an assertion against the interface stub | blocking | blocking | blocking | blocking |
| Stub-kill (the card's tests fail every trivial implementation) | advisory | blocking | blocking | blocking |
| Property test for hard-invariant criteria | — | advisory | blocking | blocking (every quantified criterion) |
| Oracle cross-check (two independent samples of expected values) | — | — | must-have requirements | every requirement |
| Acceptance-test mutation score on the card's diff | — | advisory | blocking at the project threshold | blocking at the project threshold; every survivor waived by a person |
| Person approves | criteria | criteria | criteria + example tables of must-haves | criteria + every acceptance-test file + waivers |

Thresholds are **not** set here: the first blocking mutation threshold is proposed from the planning measure's per-card "mutants killed" (measurement MS-T7-5) on the fixtures, and recorded with its date before it is used (the register rule, measurement §26). Until then "blocking" means "reported as *strength unmet* and not counted as proven", which the person can accept explicitly.

**Detecting a test that cannot fail**, cheapest first — each layer catches what the one before cannot:

1. **Static** (test-smell lint over the index's facts for the staged test): no assertion; an assertion comparing two literals; the expected value computed by calling the code under test; an assertion inside a `catch` or a branch the test cannot reach; `.skip`/`.only`. Cost: none.
2. **Executed assertions:** the runner fails a test that ran no assertion (Vitest `expect.requireAssertions`, [docs](https://vitest.dev/config/expect)). Cost: none.
3. **Red at an assertion** against the interface stub on the base (GT-TQ-1). Catches tests that are red only because a file or export is missing. Cost: one run, already paid by red-first.
4. **Stub-kill** against trivial implementations (GT-TQ-2). Catches tests that any placeholder satisfies. Cost: two or three runs of the card's acceptance tests, before the Worker starts.
5. **Acceptance-test mutation** after the build (GT-TQ-3). Catches tests too loose to pin the implementation actually written. Cost: one acceptance-test run per non-equivalent mutant, capped (`mutation_max`, 8 today); the seconds per mutant are owed by the "mutation cost" benchmark.
6. **Premature-completion measure** (measurement T7): held-out tests never shown to the planner. Catches what all five miss, in aggregate only.

A test that passes layers 1–5 can still assert the wrong value; that residue is what oracle cross-checks and a person's approval of example tables are for.

### 3.2 planner-pm

- **PM-TQ-1** WHEN the planner stages an acceptance test THE SYSTEM SHALL record, for each test case, the id of the acceptance criterion it proves, and SHALL refuse a staged test that proves no criterion of its card.
- **PM-TQ-2** WHEN a card's criterion has no staged test case THE SYSTEM SHALL keep the card in Planning and name the criterion.
- **PM-TQ-3** WHEN a behaviour criterion has concrete example values THE SYSTEM SHALL stage it as a table of cases (one row per example, each row naming the criterion) in the project's own test framework and test location.
- **PM-TQ-4** WHEN a criterion contains "never", "always", "exactly once", "idempotent", "for any" or a round-trip AND the depth profile is production or regulated THE SYSTEM SHALL stage a property-based test for it with a fixed seed recorded in the card's evidence.
- **PM-TQ-5** WHEN the depth profile is production or regulated THE SYSTEM SHALL sample the expected values of each must-have example row a second time, independently of the first, and WHEN the two disagree THE SYSTEM SHALL post a `DecisionRequest` showing both values instead of choosing one.
- **PM-TQ-6** WHEN the depth profile is production THE SYSTEM SHALL present the example tables of must-have requirements to a person for approval before their cards leave Planning; WHEN it is regulated, every staged acceptance-test file.
- **PM-TQ-7** WHEN an approved acceptance test's content hash changes THE SYSTEM SHALL mark its approval void and require it again before the card leaves Planning.
- **PM-TQ-8** WHEN a requirement's tests pass on `main` but its test-strength record does not meet the profile's rule THE SYSTEM SHALL show it as *passing, strength unmet* and SHALL NOT count it as proven.
- **PM-BF-1** WHEN a card is planned in a repository with history THE SYSTEM SHALL give it one kind of `feature`, `fix`, `characterize`, `refactor` or `upgrade`, and the kind SHALL select its red/green rule.
- **PM-BF-2** WHEN a `feature` or `fix` card's scope files have no test that executes them on the base THE SYSTEM SHALL plan a `characterize` card for those files before it.
- **PM-BF-3** WHEN a card changes behaviour that a test on the base asserts THE SYSTEM SHALL list that test as superseded on the card and stage its new version through the test-author step.
- **PM-BF-4** WHEN an `upgrade` card is planned THE SYSTEM SHALL plan the version change as a tool step and the adaptations as child `fix` cards created from the failing gates, each citing the changelog entries between the installed and proposed versions.
- **PM-BF-5** WHEN scope declaration runs for a `fix` card with a reproduction test THE SYSTEM SHALL rank candidate lines by spectrum-based suspiciousness from the failing and passing tests' coverage and record the ranking with the scope.

### 3.3 gates

- **GT-TQ-1** WHEN red-first runs THE SYSTEM SHALL run the acceptance tests against a stub of the card's declared interface, and SHALL count the card as red only if every acceptance test fails at an assertion; a failure at import, compilation, collection or setup SHALL stop the card with `tests_not_red_for_reason`, naming the test and the error.
- **GT-TQ-2** WHEN a behaviour card's acceptance tests pass against any trivial implementation of its interface (a body returning the return type's default value — `0`, `""`, `false`, `[]`, `{}`, `undefined` — or returning its first argument unchanged) THE SYSTEM SHALL stop the card with `vacuous_tests` naming the stub and the passing tests, when the profile makes stub-kill blocking, and record it as advisory otherwise.
- **GT-TQ-3** WHEN the mutation gate runs THE SYSTEM SHALL report two scores: the diff's mutants killed by the whole suite, and the diff's mutants killed by the card's acceptance tests alone, each over non-equivalent mutants.
- **GT-TQ-4** WHEN a mutant fails the typecheck, or its transpiled output is identical to the original's THE SYSTEM SHALL exclude it from both scores and count it as stillborn or equivalent.
- **GT-TQ-5** WHEN a mutant survives the acceptance tests THE SYSTEM SHALL route it as a test gap to the test-author step or to a person, and SHALL NOT present it to the Worker as a failure.
- **GT-TQ-6** WHEN the test-smell lint finds an acceptance test with no executed assertion, an assertion whose expected value is computed by the code under test, or an assertion on two constants THE SYSTEM SHALL fail it at every profile above prototype; WHEN the test runner offers `requireAssertions` (Vitest `expect.requireAssertions`) THE SYSTEM SHALL enable it for the acceptance-test run.
- **GT-TQ-7** WHEN a `characterize` card's tests fail on the base THE SYSTEM SHALL refuse them; WHEN they pass on the base THE SYSTEM SHALL treat that as the card's green-on-base proof and SHALL NOT stop it with `vacuous_tests`.
- **GT-TQ-8** WHEN a `refactor` card is verified THE SYSTEM SHALL require the characterization and existing tests to pass on the base and on the change, and the index's exported surface of the scope files to be identical, unless the card declares the surface change.
- **GT-BF-1** WHEN a test on the base fails after a card and the card lists that test as superseded, with its new version staged THE SYSTEM SHALL not restate it as a regression, and SHALL list the supersession in the evidence bundle.
- **GT-BF-2** WHEN onboarding completes THE SYSTEM SHALL record the pre-existing static diagnostics and failing tests as a baseline event, keyed by file, rule and a fingerprint that survives line moves; WHEN a gate runs THE SYSTEM SHALL report only diagnostics absent from the baseline, and SHALL shrink the baseline when a baselined diagnostic disappears.
- **GT-BF-3** WHEN a card's diff contains edits applied by a declared mechanical tool (rename, codemod) THE SYSTEM SHALL record those lines as tool-applied, count them against a separate bound, and require the typecheck and the full suite to pass.
- **GT-BF-4** WHEN a card's changed files belong to a workspace package THE SYSTEM SHALL run first the tests of that package and of its dependents, in build order.
- **GT-IX-1** WHEN a project gate reads facts from a file whose parse status is `recovered` or `unsupported` THE SYSTEM SHALL report the gate's outcome on that file as `partial` with the reason, never `pass`.

### 3.4 context

- **CX-IX-1** WHEN the repository has more workspace packages than fit a tenth of the repo-map budget THE SYSTEM SHALL render a package map (one line per package: name, role line, dependencies) and rank files only inside the packages the scope touches.
- **CX-IX-2** WHEN the repo map or scope declaration needs a file's role THE SYSTEM SHALL derive a one-line role from the index (its exports and first documentation comment), and SHALL NOT call a model for it.
- **CX-IX-3** WHEN the repo map is built for a language with a tags query THE SYSTEM SHALL build it from the index's definitions and references with the same ranking as for TypeScript, and the card SHALL state which parser produced it.

### 3.5 surface (onboarding)

- **SUR-BF-1** WHEN onboarding derives gates from CI THE SYSTEM SHALL list every CI step with the gate it became or the reason it did not (needs a service, a secret, a matrix entry, an unknown tool).
- **SUR-BF-2** WHEN onboarding finds the team's linter and formatter configurations THE SYSTEM SHALL use the team's tools and configurations for the static gates and autofix, and SHALL NOT apply Sekhemet's own.
- **SUR-BF-3** WHEN onboarding drafts the AGENTS.md block THE SYSTEM SHALL limit it to commands, locations and rules that are not already enforced by a gate.
- **SUR-BF-4** WHEN onboarding runs the existing test suite THE SYSTEM SHALL run it twice and record failing and flaky tests in the baseline (GT-BF-2).

### 3.6 worker-loop

- **WL-BF-1** WHEN a card needs a rename across files THE SYSTEM SHALL offer a rename tool backed by the language service, whose edits are recorded as tool-applied (GT-BF-3).
- **WL-IX-1** WHEN the Worker's symbol tools run THE SYSTEM SHALL reach the language service through the LSP client, so that `typescript-language-server` and TypeScript 7's native server are interchangeable.
- **WL-IX-2** WHEN a language server is started THE SYSTEM SHALL cap its heap, exclude virtual-environment and dependency directories, and count its memory in the memory guard.

### 3.7 The source index (gates T2, shared by context and worker-loop)

- **IX-1** WHEN any consumer (project gates, parse gate, repo map, scope declaration, symbol tools, mutation operators) needs imports, exports, re-exports, top-level declarations or references THE SYSTEM SHALL obtain them from one `SourceIndex` interface whose facts carry `language`, `parser` and `parserVersion`, and `parseStatus` (`ok`, `recovered`, `unsupported`).
- **IX-2** WHEN a module specifier is resolved THE SYSTEM SHALL use the language adapter's resolver, returning a file, an external package or `unresolved`, and never a guess.
- **IX-3** WHEN a file's content hash and parser version are unchanged THE SYSTEM SHALL serve its facts from the cache; the cache SHALL be deletable at any time without changing any gate verdict.
- **IX-4** WHEN the codebase is searched THE SYSTEM SHALL find no import of `typescript` outside the TypeScript adapter (a search test, extending GT-T2-3).
- **IX-5** WHEN a workspace is indexed THE SYSTEM SHALL record its packages, their entry points (`exports` maps) and their dependency graph as facts.
- **IX-6** WHEN a Python file is indexed with the Python adapter enabled THE SYSTEM SHALL produce the same fact kinds as for TypeScript, from tree-sitter-python and its tags query, with `parseStatus` set from error and missing nodes.

### 3.8 measurement

- **MS-TQ-1** WHEN the planning measure runs THE SYSTEM SHALL report, per generated card, red-at-assertion, stub-kill, the acceptance-test mutation score and the oracle cross-check disagreement rate, beside the existing fail-at-seed, pass-on-reference and mutants-killed figures.
- **MS-TQ-2** WHEN the first blocking acceptance-test mutation threshold is proposed THE SYSTEM SHALL derive it from at least one planning-measure run and record it in the register with its date before any project uses it.
- **MS-TQ-3** WHEN mutation cost is benchmarked on the reference machine (OPEN_QUESTIONS "mutation cost") THE SYSTEM SHALL record seconds per mutant for acceptance-test-only runs and for suite runs separately.

---

## 4. Proposals (libraries and tools)

Nothing here is added without the owner's yes. Licences verified 2026-09-22 from the repository licence file or npm metadata.

| Proposal | Licence | Maintenance signal | Adds or replaces | When |
| --- | --- | --- | --- | --- |
| `web-tree-sitter` | MIT | 0.27.0, 2026-08-30; tree-sitter core 27k stars, pushed 2026-09-22 | The parser for non-TypeScript languages and the multi-language repo map; replaces the flat file map of DEC-20 | T2 (interface now, Python adapter when Python is a target) |
| `tree-sitter-python` (its `.wasm` and `tags.scm`) | MIT | 0.25.0, 2025-09; repo pushed 2026-09-13 | Python facts for the index and repo map | With the Python adapter |
| `tree-sitter-typescript` (its `.wasm` and `tags.scm`) | MIT | 0.23.2, 2024-11 (old); repo pushed 2026-09-17 | A second TypeScript parser for the repo map only, if the owner wants one code path for maps; **not** for gate facts (6/422 files recovered with errors here) | Optional |
| `@typescript/typescript6` | Apache-2.0 | 6.0.2, 2026-07-06, published by the TypeScript team | Pins the 6.0 JS API for the TypeScript adapter while projects move to TS 7 | T2 |
| `fast-check` | MIT | 4.10.2, 2026-09-19; 5.1k stars | Property-based acceptance tests for TypeScript hard invariants | With PM-TQ-4 |
| `hypothesis` | MPL-2.0 (file-level copyleft; used as a test dependency of the user's project, not linked into Sekhemet) | pushed 2026-09-20; 9.0k stars | Property-based tests for Python projects | With Python gates |
| `basedpyright` | MIT | 1.40.1, 2026-09-22 | Python language server and type-check gate with a built-in baseline | With Python gates; drop-in for `pyright-langserver` in `lsp.ts` |
| `@stryker-mutator/core` | Apache-2.0 | 10.0.0, 2026-08-14; repo pushed 2026-09-21 | A fuller TypeScript mutation operator set than the in-house scanner | Only if a suite A/B shows it kills more real faults at acceptable cost |
| `mutmut` | BSD-3-Clause | pushed 2026-09-12 | Python mutation | With Python gates |
| `@ast-grep/napi` (+ `@ast-grep/lang-python`, ISC) | MIT | 0.45.3, 2026-08-31; 16k stars | Structural search and codemods for the Worker and Planner (decision 10) — native binaries; Python needs an install build step | Later, as a tool, not the index |
| `typescript-language-server` | Apache-2.0 (parts MIT) | 6.0.0, 2026-08-20 | Already the `lsp.ts` default for TS ≤ 6; TS 7's own `tsc --lsp --stdio` **[search]** is the alternative | Keep; add TS 7 as a configured alternative |

**No new dependency needed** for: stub-kill (generated stubs from the card interface), TCE-style equivalent-mutant filtering (`transpileModule` on the mutant), test-smell lint (index facts over the staged test), snapshot-based characterization (Vitest built-in), `expect.requireAssertions` (Vitest config), impact-first tests (index import graph; `vitest --changed`, `pnpm --filter`), spectrum-based fault localisation (`NODE_V8_COVERAGE`).

**Not to embed:** Renovate (AGPL-3.0) — import its PRs as cards instead.

---

## 5. Later, with reasons

| Later | Reason |
| --- | --- |
| A model-based equivalent-mutant judge (ACH-style) | Needs a model load on a 24 GB host; the TCE-style filter comes first; only for production/regulated survivors, and only if waivers turn out frequent |
| Model-written file summaries for localisation | Role-aware summaries help ([2607.11046](https://arxiv.org/abs/2607.11046)), but deterministic role lines are free; admit summaries only if they beat role lines on the Chronicle localisation threshold (register R1) |
| Probe-and-refine tuning of repository guidance | The only evidence on a 35B-A3B model is positive ([2606.20512](https://arxiv.org/abs/2606.20512)), but it needs synthetic bug-fix probes per repository — fits the "synthesised tasks" inlet (measurement §17) once that inlet exists |
| Metamorphic relations as a separate mechanism | No local-model evidence; covered as one property kind inside PBT |
| An embedding reranker for localisation (SweRank-style) | DEC-22 rejects a resident embedder; revisit only if structural localisation misses the R1 threshold |
| SCIP or stack-graph precise indexes | Heavier than the gates' needs; useful only for cross-repository navigation |
| ast-grep as the Worker's structural search and codemod tool | Native binaries and a Python build step; decision 10's rename via the language service covers v1's commonest mechanical edit |
| Rust and Go adapters | Same interface; DEC-20 keeps their functional gates meanwhile |
| TypeScript 7.1's new API as the TypeScript adapter | Not released; revisit when it is, behind the same interface |
| Coverage-guided test augmentation (SWE-ABS / UTBoost style) on user projects | Strong on benchmarks, but it generates tests against the Worker's implementation (actual behaviour); acceptable only as test-gap proposals for a person |

---

## 6. What the owner must choose

1. **Stub-kill blocking from *internal tool* up, or only from *production*?** Recommendation: from *internal tool*; it costs a few test runs and catches the commonest vacuous test.
2. **Person approval of tests at *production*: example tables of must-haves only (recommended), or every test file?**
3. **Card kinds `characterize`, `refactor`, `upgrade` in v1?** Without them, brownfield planning conflicts with GT-P1 (decision 7). Recommendation: yes; they are rule changes, not new machinery.
4. **Pin `@typescript/typescript6` for the harness's parser (proposal)** or stay on `typescript` 5.9 until 7.1's API ships.
5. **`web-tree-sitter` now for the interface and repo map, or only when Python becomes a target?** Recommendation: fix the interface and fact schema in T2 now, with the TypeScript adapter only; add `web-tree-sitter` when the Python adapter is built.
