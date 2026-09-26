# Reuse survey: what's left to build in B4

*2026-09-25. Research only; nothing installed. Under DEC-40, every item marked **reuse** still needs the owner's yes before it is added, except the items DEC-08 already approves.*

**Sources.** The capabilities come from §5 of gates, surface, design-stage (including NEW-design-stage-6, *Take over a project*), planner-pm, dashboard, review-git, teams and measurement. They were read for the plan rows B4.0b, B4.1, B4.3, B4.4, B4.5, B4.6, B4.7, B4.8 and B4.11.

**What is already there.** I checked every `package.json` and DEC-08, DEC-29 and DEC-38 to DEC-43:
- **Installed:** `typescript`, `valibot`, `@huggingface/gguf`, `@anthropic-ai/sandbox-runtime`, `ipaddr.js`, `request-filtering-agent`, `@modelcontextprotocol/sdk`, `@simplewebauthn/server` and `openid-client`. As development dependencies: `axe-core`, `playwright-core`, `vitest` and Biome.
- **Approved but not installed:** `spdx-expression-parse`, `spdx-satisfies`, `spdx-correct`, `@octokit/*`, `jira.js`, `@linear/sdk`, Slack Bolt, `fast-check`, gitleaks (optional subprocess), the SecLists password list, and vLLM.

**Already built in the code:**
- a TOML parser (`kernel/toml.ts`);
- the exact statistics (`eval/stats.ts`, kept by DEC-42);
- a PNG decoder and pixel diff (`gates/visual.ts`);
- secret rules modelled on gitleaks (`gates/secrets.ts`);
- the osv-scanner, semgrep and gitleaks wrappers (`gates/builtin.ts`);
- a built-in TS mutator;
- a ranked repo map (`context/ranked_repo_map.ts`);
- LSP (`context/lsp.ts`);
- CODEOWNERS (`codeowners.ts`);
- the SSE stream and a WebSocket adapter (`server.ts`, `ws.ts`);
- a framework-free dashboard (`packages/ui/web`, with no CDN and no build step). It already has:
  - SVG charts (`insights.js`: CFD, cycle, throughput, aging, plus `sparkline.js`);
  - a DAG layout (`dag.js`, `graph.js`);
  - a diff parser and viewer (`diff_parse.js`, `diff.js`, `structure.js`);
  - a small markdown renderer (`lib/pm.js renderPmMarkdown`).
- `node:sqlite` on Node v26.0.0 has **FTS5** (checked on this host).

**How candidates were checked.** Licence, version and date come from the npm registry (`/latest`, with the date the registry metadata was last modified) or from the GitHub API (`license.spdx_id`, latest release), checked 2026-09-25. "dl/wk" is npm downloads in the last week. Every subprocess tool listed ships macOS and Linux builds.

**Verdict key:**
- **HAVE:** already in the repo or approved; extend it.
- **REUSE:** add the library or tool (needs the owner's yes, or is already approved).
- **BUILD:** small, or domain-specific, or nothing usable exists.
- **ORACLE:** use only in tests or as a reference, not at runtime.

---

## B4.0b — gates: one pipeline (T1), the source index (T2), test strength (NEW-gates-6), existing codebases (NEW-gates-7/8)
*The gates spec's other §5 items (NEW-gates-3/4/5, M6) are not named in a B4 row. They are listed at the end of this section because they share its tools.*

| Capability (spec ids) | Candidates — licence · latest · maintenance · offline/mac/Linux · fit | Verdict |
| --- | --- | --- |
| **AST source index, TS adapter** (IX-1..5, GT-T2-1..3) | **`typescript` compiler API** — Apache-2.0, installed; resolves type-only imports and `tsconfig` paths. [oxc-parser](https://github.com/oxc-project/oxc) — MIT, 0.151.0 (2026-09-21), 1 dep, 50M dl/wk, native napi binding; returns the module record (static imports and exports) directly, 10–50× faster. [ts-morph](https://github.com/dsherret/ts-morph) — MIT, 28.0.0 (2026-04), a wrapper over tsc with no new capability | **HAVE** (tsc). Keep tsc in the one TS adapter (IX-4). Consider oxc-parser only if a measurement shows indexing is too slow on large repos |
| **Module resolver** (IX-2: file, external or `unresolved`; `exports` maps) | `ts.resolveModuleName` (installed). [oxc-resolver](https://github.com/oxc-project/oxc-resolver) — MIT, 11.24.2 (2026-07), 0 deps; enhanced-resolve semantics with tsconfig paths and `exports`/`imports` maps. [enhanced-resolve](https://github.com/webpack/enhanced-resolve) — MIT, 5.25.1 (2026-09), 2 deps | **HAVE** for TS. **REUSE oxc-resolver** only if the JS files or `exports` maps that tsc resolves wrongly are a measured failure |
| **Workspace packages, entry points, dependency graph and build order** (IX-5, SUR-39, GT-BF-4, RG-N3-1) | [@manypkg/get-packages](https://github.com/Thinkmill/manypkg) — MIT, 3.1.0 (2026-02), 2 deps, 5.5M dl/wk; reads pnpm, npm, yarn, lerna, bolt and rush workspaces. [workspace-tools](https://github.com/microsoft/workspace-tools) — MIT, 0.42.2 (2026-08), 6 deps; adds the dependents graph | **REUSE @manypkg/get-packages** to find workspaces. The topological build order is about 20 lines; **BUILD** it |
| **Export reachability through barrels and namespaces** (GT-T2-1, GT-T2-4) | [knip](https://github.com/webpro-nl/knip) — ISC, 6.38.0 (2026-09-23), 13 deps, 13.8M dl/wk. Its plugins load project config files (vite, jest), which **executes repository code**, so it breaks trust-first and one-index. [ts-unused-exports](https://github.com/pzavolinsky/ts-unused-exports) — MIT, 11.0.1 (2024-11), slowing | **ORACLE:** run knip on fixtures to build GT-T2-4's "reachable only through a barrel" list; the gate itself is **BUILD** on the index |
| **Architecture invariants** ("is defined only in", forbidden imports) | [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) — MIT, 18.4.0 (2026-09-20), 18 deps; has its own parser | **BUILD** on the index. A second parser would violate GT-T2-3. dependency-cruiser's rule syntax is worth copying |
| **Gate verdict cache by tree hash** (GT-N3-1) | Plain git (`git write-tree` over a temporary index) and SQLite | **BUILD** (trivial) |
| **Impacted tests first** (GT-N3-2) | The index's import graph, plus the project's own `vitest related` or `jest --findRelatedTests` | **BUILD** on the index; call the runner's related-tests flag when the project has one |
| **Flaky-test detection and quarantine** (GT-N3-4, SUR-38) | [pytest-rerunfailures](https://github.com/pytest-dev/pytest-rerunfailures) — MPL-2.0 (weak copyleft; a project-side plugin at most). Vitest `--retry`. No stand-alone detector exists | **BUILD:** re-run only the failing ids on the unchanged tree. Vitest's `-t` and pytest's node ids are enough |
| **Test-result parsing for all runners** (GT-M6-2, T1) | [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) — MIT, 5.11.1 (2026-08), 6 deps, 74M dl/wk. It parses JUnit XML from pytest `--junitxml`, [gotestsum](https://github.com/gotestyourself/gotestsum) (Apache-2.0, v1.13.0 2025-09), cargo-nextest, surefire and vitest `--reporter=junit`. [go-junit-report](https://github.com/jstemmer/go-junit-report) — MIT, v2.1.0 (2023, quiet) | **REUSE fast-xml-parser.** One JUnit path replaces several per-tool text parsers. It also unblocks the pytest and go parsers that stay partial under DEC-42 |
| **Mutation testing, TS** (GT-TQ-3/4, GT-N5-5) | Built-in mutator (have). [@stryker-mutator/core](https://github.com/stryker-mutator/stryker-js) — Apache-2.0, 10.0.0 (2026-08), **26 deps**, Node ≥ 22; the spec already proposes it, gated on an A/B (§7 1a). Stillborn and equivalent mutants: `ts.transpileModule` output comparison (installed) | **HAVE.** Stryker stays a measured proposal |
| **Mutation testing, other languages** (GT-N5-2) | Python: [mutmut](https://github.com/boxed/mutmut) — BSD-3-Clause, 3.8.0 (2026-09-12), active; [cosmic-ray](https://github.com/sixty-north/cosmic-ray) — MIT, 8.7.0 (2026-08). Rust: [cargo-mutants](https://github.com/sourcefrog/cargo-mutants) — MIT, v27.1.0 (2026-06), has `--in-diff` (exactly diff-scoped). Java: [PIT](https://github.com/hcoles/pitest) — Apache-2.0, 1.30.0 (2026-08). Go: [gremlins](https://github.com/go-gremlins/gremlins) — Apache-2.0 (pushed 2026-06); [avito go-mutesting](https://github.com/avito-tech/go-mutesting) — MIT, v2.3.1 (2025-12). All run offline as subprocesses | **REUSE as optional subprocesses** (the spec's design): mutmut, cargo-mutants (`--in-diff`), PIT. Go is Later |
| **Stub-kill: trivial implementations of an interface** (GT-TQ-1/2/10) | No library; it needs the declared interface from the index | **BUILD** |
| **Test-smell lint**: no executed assertion, an expected value computed by the code under test, constant-vs-constant (GT-TQ-6) | Vitest `expect.requireAssertions` ([docs](https://vitest.dev/config/expect)); covered by the installed vitest. [@vitest/eslint-plugin](https://github.com/vitest-dev/eslint-plugin-vitest) — MIT, 1.6.27 (2026-08); its `expect-expect` and `valid-expect` rules, but it needs ESLint. [SNUTS.js](https://github.com/Jhonatanmizu/SNUTS.js) — **GPL-3.0, unusable**. Python: ruff's `PT` rules (MIT) when the project has ruff | **BUILD** the three rules on the index, and **HAVE** `requireAssertions`. No permissive stand-alone smell detector covers the "computed by the code under test" rule |
| **Diagnostic baseline with fingerprints that survive line moves** (GT-BF-2, SUR-38) | SARIF `partialFingerprints`; [github/codeql-action](https://github.com/github/codeql-action) `src/fingerprints.ts` — MIT, a rolling line-context hash (port about 80 lines with its notice); basedpyright's baseline file as the model | **BUILD**, porting the codeql-action algorithm with attribution |
| **Tool-applied line accounting** (GT-BF-3) | Git diff of the formatter's or codemod's output | **BUILD** |
| **SAST: an offline rule set shipped with Sekhemet** (GT-N5-4) | Engine: semgrep CE / [opengrep](https://github.com/opengrep/opengrep) — **LGPL-2.1**; fine as an unmodified separate process, as today. Rules: [semgrep-rules](https://github.com/semgrep/semgrep-rules) — **Semgrep Rules License v1.0, which forbids redistribution: unusable**. [opengrep-rules](https://github.com/opengrep/opengrep-rules) — **Commons Clause, archived: unusable**. [trailofbits/semgrep-rules](https://github.com/trailofbits/semgrep-rules) — **AGPL-3.0: unusable**. [elttam](https://github.com/elttam/semgrep-rules) — MIT, 81 rules, mostly Java. [0xdea](https://github.com/0xdea/semgrep-rules) — MIT, 50 rules for C. [AikidoSec/opengrep-rules](https://github.com/AikidoSec/opengrep-rules) — MIT, 2 rules. Language-native: [bandit](https://github.com/PyCQA/bandit) (Apache-2.0, 1.9.4 2026-02), [gosec](https://github.com/securego/gosec) (Apache-2.0, v2.29.0 2026-08), [eslint-plugin-security](https://github.com/eslint-community/eslint-plugin-security) (Apache-2.0, rule ideas) | **BUILD** a curated set of about 30 semgrep-format rules for TS/JS/Python, version-stamped. **REUSE** bandit when it is installed. No permissive broad rule set exists for TS/JS/Python |
| **Offline vulnerability DB, diff-scoped** (GT-N2-1; DS-TO-5) | [osv-scanner](https://github.com/google/osv-scanner) — Apache-2.0, v2.6.0 (2026-09-14), **already wrapped**; `--offline` with `--download-offline-databases` keeps per-ecosystem zips in `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY` ([docs](https://google.github.io/osv-scanner/usage/offline-mode/)). The data is mostly CC-BY-4.0 and needs attribution. Alternatives: [grype](https://github.com/anchore/grype) (Apache-2.0, v0.119.0 2026-09) and [trivy](https://github.com/aquasecurity/trivy) (Apache-2.0, v0.74.0 2026-08), each with its own DB | **HAVE:** switch the existing wrapper to offline mode. The download is an explicit, logged action under the research setting |
| **Visual: pixel diff, masks, overlap** (GT-N4-*) | Own PNG decoder and diff (have). [pixelmatch](https://github.com/mapbox/pixelmatch) — ISC, 7.2.0 (2026-04), anti-aliasing aware; with [pngjs](https://github.com/pngjs/pngjs) — MIT, 7.0.0 (2023, stale but stable) | **HAVE.** pixelmatch only if anti-aliasing noise causes false fails |
| **Property-based tests** (PM-N7-1; staged in the gates) | [fast-check](https://github.com/dubzzz/fast-check) — MIT, 4.10.2 (2026-09), **approved (DEC-29 O6)**. Python projects: Hypothesis — MPL-2.0, the project's own test dependency and never vendored | **REUSE** (approved) |

## B4.1 — first run, the Configuration page, take-over part 1 (DS-TO-1..8, SUR-56, SEC-54/55)

| Capability | Candidates | Verdict |
| --- | --- | --- |
| **Secret scan of the whole history, offline** (DS-TO-3) | [gitleaks](https://github.com/gitleaks/gitleaks) — MIT, v8.30.1 (2026-03), **approved (DEC-43)**; `gitleaks git --log-opts=--all`, no network. **Bundled fallback:** vendor gitleaks' own `config/gitleaks.toml` (MIT, about 200 rules), read by the existing TOML parser and run over `git log -p --all`. It gives the same rule ids on both paths. Translate Go RE2 inline `(?i)` to JS flags; V8 supports `(?i:…)` modifiers. Alternatives: [secretlint](https://github.com/secretlint/secretlint) — MIT, 13.0.6 (2026-09-25), Node native, files only; [kingfisher](https://github.com/mongodb/kingfisher) — Apache-2.0, v2.7.0 (2026-09-24), history-aware, `--no-validate`; [detect-secrets](https://github.com/Yelp/detect-secrets) — Apache-2.0, last release 2024-05. [TruffleHog](https://github.com/trufflesecurity/trufflehog) — **AGPL-3.0, and live verification sends secrets off the machine: unusable** (DEC-43 already rejects it) | **REUSE gitleaks** (approved). **REUSE its rule file** as the bundled set, which replaces the hand-copied subset in `secrets.ts` |
| **Manifests, lockfiles and dependency inventory without running anything** (DS-TO-5) | osv-scanner's lockfile extraction (have; `--format json` lists packages). [syft](https://github.com/anchore/syft) — Apache-2.0, v1.52.0 (2026-09-17); static cataloguing of about 20 ecosystems, CycloneDX/SPDX output, runs no project code. [cdxgen](https://github.com/cdxgen/cdxgen) — Apache-2.0, **may invoke package managers, which is unsafe before trust** | **HAVE** (osv-scanner). syft is an optional upgrade if the ecosystem coverage falls short |
| **Dependency age** (DS-TO-5; research on) | [deps.dev API v3](https://docs.deps.dev/api/v3/) — Google, free, no key; `publishedAt` for every version, SPDX licences, advisories and OpenSSF Scorecard for npm, PyPI, Go, Cargo, Maven and NuGet (verified live). [libyear](https://www.npmjs.com/package/libyear) — **LGPL-3.0, flagged** | **REUSE the deps.dev API** (a thin fetch client; **BUILD** the client). Offline: *not checked: offline* |
| **TODO/FIXME locations** (DS-TO-5) | [ripgrep](https://github.com/BurntSushi/ripgrep) — Unlicense/MIT, 15.2.0 (2026-07); **already a system requirement of srt (DEC-39)**; `rg --json`. [leasot](https://github.com/pgilad/leasot) — MIT, 14.4.0 (2024-06), 11 deps | **HAVE** (ripgrep) |
| **Half-done detection**: "not implemented" stubs, `it.skip`/`it.todo`, routes with no handler (DS-TO-8) | [ast-grep](https://github.com/ast-grep/ast-grep) — MIT, 0.45.3 (2026-08-31), 16k★; tree-sitter based, about 25 languages, YAML rules, `ast-grep scan --json`, no code execution; npm [@ast-grep/cli](https://www.npmjs.com/package/@ast-grep/cli) and [@ast-grep/napi](https://www.npmjs.com/package/@ast-grep/napi) with prebuilt binaries. Rules: `throw new Error("not implemented")`, `raise NotImplementedError`, `todo!()` and `unimplemented!()`, `it.skip`/`it.todo`/`@pytest.mark.skip`, `pass`-only bodies. Missing-module imports come from the index resolver (IX-2) | **REUSE ast-grep** for the multi-language patterns. "Schema with no migration" and "route with no handler" are per-framework heuristics: **BUILD** (Prisma, Alembic, Express, FastAPI) |
| **Churn hotspots, last commits, unmerged branches, submodules** (DS-TO-4/5) | Git plumbing (`log --numstat`, `for-each-ref --no-merged`, `config -f .gitmodules`). [code-maat](https://github.com/adamtornhill/code-maat) has no SPDX metadata; skip it | **BUILD** (trivial) |
| **CI steps → gates, including `run: \|`** (SUR-8, SUR-35) | [yaml](https://github.com/eemeli/yaml) — ISC, 2.9.1 (2026-09-11), **0 deps**, 195M dl/wk. `onboard.ts` hand-parses workflows today and misses `run: \|` | **REUSE yaml.** It removes a known bug class |
| **Language and size breakdown for recon** | [scc](https://github.com/boyter/scc) — MIT, v4.1.0 (2026-09); [tokei](https://github.com/XAMPPRocky/tokei) — MIT/Apache-2.0, v15.0.0 (2026-09) | **BUILD** from file extensions (already detected at onboarding); scc is an optional subprocess |
| **Agent configuration inert until its SHA-256 is approved** (DS-TO-2, SEC-54) | none | **BUILD** |
| **Install with scripts off, build and test twice, confined** (DS-TO-6/7) | `npm/pnpm --ignore-scripts`, `uv sync`, srt (have) | **HAVE** (the tools) + **BUILD** (the orchestration) |
| **Model folder scan and GGUF headers** (DEC-29 O2) | `@huggingface/gguf` 0.4.6 (installed) | **HAVE** |
| **Explicit download with hash verification** (DB-N6-7) | [@huggingface/hub](https://github.com/huggingface/huggingface.js) — MIT, 2.17.5 (2026-09), 2 deps. Node `fetch` + `crypto` | **BUILD** with fetch + sha256. The hub client is only worth adding if the LFS pointer/sha lookup gets fiddly |

## B4.3 — one planner, requirement graph, slices and appetite (P1, P13, NEW-planner-pm-1..8)

| Capability | Candidates | Verdict |
| --- | --- | --- |
| **Requirement graph**: versioned ids, dependencies, suspect links, slice proven/unproven (PM-P13-*) | [graphology](https://github.com/graphology/graphology) — MIT, 0.26.0 (2025-01); [@dagrejs/graphlib](https://github.com/dagrejs/graphlib) — MIT, 4.0.5 (2026-08). Requirements tools [StrictDoc](https://github.com/strictdoc-project/strictdoc) and [Doorstop](https://github.com/doorstop-dev/doorstop): Python, no SPDX metadata; reference models only | **BUILD** on the event log with SQLite recursive CTEs. The domain rules (suspect-on-revision, proven-by-strength) are the work; a graph library adds nothing |
| **INVEST, criterion lint, EARS form** (PM-P1-1/5/9) | No maintained permissive EARS or INVEST linter found | **BUILD** — no library |
| **Forecast 50%/85% (Monte Carlo on throughput)** (DS-P2-6, DB-N9-3) | [simple-statistics](https://github.com/simple-statistics/simple-statistics) — ISC, 7.12.0 (2026-09), 0 deps (quantiles); own `stats.ts` | **BUILD** (about 40 lines on `stats.ts`) |
| **Capability model: pass probability against difficulty and size, 80% horizon** (PM-N3-1) | [ml-logistic-regression](https://github.com/mljs/logistic-regression) — MIT, 2.0.0 (**2022, stale**) | **BUILD** (a small IRLS with an interval, tested against scipy values as DEC-42 does) |
| **Spectrum-based fault localisation** (PM-N6-5) | Python: [FauxPy](https://github.com/atom-sw/fauxpy) — MIT (pushed 2026-07, 34★; Tarantula, Ochiai, DStar, mutation-based) with coverage.py dynamic contexts (Apache-2.0). JS/TS: no maintained tool; Node's built-in `NODE_V8_COVERAGE` per test run | **BUILD** Ochiai (about 30 lines) over per-test V8 coverage. FauxPy is an optional subprocess for Python projects |
| **Version bump from Conventional Commits, 0.y.z rule** (RG-N4-1, PM-P13-13) | [semver](https://github.com/npm/node-semver) — ISC, 7.8.5 (2026-09), 0 deps; [conventional-commits-parser](https://github.com/conventional-changelog/conventional-changelog) — MIT, 7.1.2 (2026-07), Node ≥ 22. `sync/repo_tools.ts nextVersion` is hand-rolled | **REUSE semver** (parse and compare correctness). **BUILD** the commit-type split (the squash format is ours) |
| **Property-based test staging** (PM-N7-1) | fast-check (approved) | **REUSE** |

## B4.4 — start or take over by conversation, depth profile, project documents (P2, P14, NEW-design-stage-3/6, NEW-integrations-4)

| Capability | Candidates | Verdict |
| --- | --- | --- |
| **Decision records in MADR 4.0** (DS-N3-1, DS-N3-6) | [adr/madr](https://github.com/adr/madr) template — MIT OR CC0-1.0, 4.0.0 | **REUSE the template** (vendored text with its notice); **BUILD** the generator |
| **CHANGELOG in Keep a Changelog, earlier sections byte-identical** (DS-N3-8) | [keep-a-changelog](https://github.com/oscarotero/keep-a-changelog) npm — MIT, 3.2.0 (2026-09), 2 deps, 11k dl/wk. It re-serialises the whole file, which would break byte identity | **BUILD** (prepend-only insertion); the npm package is at most a validator |
| **Parse generated documents back into proposals** (DS-N3-2/5) | [marked](https://github.com/markedjs/marked) (lexer) — MIT, 18.0.14 (2026-09-22), **0 deps**, 72M dl/wk; [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown) — MIT, 12 deps | **REUSE the marked lexer** (a token stream, 0 deps). The same package serves B4.11 |
| **Depth-profile quality checklist** (DS-P14-2) | [OWASP ASVS](https://github.com/OWASP/ASVS) — **CC-BY-SA-4.0 (share-alike): reference its ids, do not copy its text** | **BUILD** our own checklist and cite ASVS by id — no permissive dataset exists |
| **Comparables and research** (DS-P14-5) | Crawl4AI (Apache-2.0, v0.9.4 2026-09-23) — **have** | **HAVE** |
| **Inherited issues reconciled** (DS-TO-13) | `@octokit/*`, `jira.js`, `@linear/sdk` — approved; the GitHub adapter was built in B4.9 | **HAVE** |
| **Card zero generators** (DS-P2-1/2) | `npm init`, `tsc --init`, Vitest, `uv init` — the ecosystems' own tools | **HAVE** (external tools) |

## B4.5 — reuse survey by capability, one SPDX classifier (P7)

| Capability | Candidates | Verdict |
| --- | --- | --- |
| **SPDX expression parse and correct** (DS-P7-1/2/3) | [spdx-expression-parse](https://github.com/jslicense/spdx-expression-parse.js) — MIT, 5.0.0 (2026-07); [spdx-correct](https://github.com/jslicense/spdx-correct.js) — Apache-2.0, 3.2.0 (2023, stable); [spdx-satisfies](https://github.com/jslicense/spdx-satisfies.js) — MIT, 6.0.0 (2025-01); [spdx-license-ids](https://github.com/jslicense/spdx-license-ids) — CC0, 3.0.24 (2026-09) | **REUSE** (approved in DEC-08; not installed yet). They replace `libraries.ts:24-62`'s hand table |
| **Permissive, weak-copyleft or strong-copyleft category data** | [ScanCode LicenseDB](https://scancode-licensedb.aboutcode.org/) `index.json` — a `category` per licence (Permissive, Copyleft Limited, Copyleft, Commercial…), CC-BY-4.0 data, updated 2026-09; vendor a snapshot of the SPDX ids with attribution. [@blueoak/list](https://www.npmjs.com/package/@blueoak/list) — CC0, v15 (2024-06); permissive ratings only | **REUSE a vendored LicenseDB category snapshot** (one table for both the survey and the licence gate) |
| **Licence, popularity and maintenance signals** (DS-P7-4/5/9) | deps.dev API (licences, `publishedAt`, OpenSSF Scorecard, stars; npm, PyPI, Go, Cargo, Maven). npm downloads API; PyPI JSON by verified name; the GitHub API's `license.spdx_id` (licensee-backed). [askalono](https://github.com/jpeddicord/askalono) — **archived 2024** | **REUSE the deps.dev API** as the main source in research mode; **BUILD** the client |
| **Relevance ranking of candidates** (DS-P7-6/7) | [MiniSearch](https://github.com/lucaong/minisearch) — MIT, 7.2.0 (2025-09), 0 deps (BM25+). SQLite FTS5 (present in `node:sqlite`) | **HAVE** (FTS5 `bm25()`), or **BUILD**. MiniSearch only if client-side search is needed |

## B4.6 / B4.7 — the board, story map, burn-up, Learn, Status, Projects (P3, P4, P5, P13 page side, NEW-dashboard-9)

| Capability | Candidates | Verdict |
| --- | --- | --- |
| **Burn-up with scope line, forecast band, target** (DB-P3-14, DB-N9-1) | Own SVG chart kit (`insights.js`: CFD, cycle, throughput, aging, sparkline; text summaries and data tables). [uPlot](https://github.com/leeoniya/uPlot) — MIT, 1.6.32 (2025-03), 0 deps; [Observable Plot](https://github.com/observablehq/plot) — ISC, 3 deps (d3) | **HAVE:** one more chart in the existing kit keeps the no-CDN, token-coloured, accessible pattern |
| **Story map** (DB-P3-13, DB-P13-1) | A CSS grid of activities × slices; no library needed | **BUILD** |
| **Graph layout** (dependencies, requirement links) | Own `dag.js` (longest-path layering). [@dagrejs/dagre](https://github.com/dagrejs/dagre) — MIT, 3.1.1 (2026-08), 1 dep (crossing reduction). [elkjs](https://github.com/kieler/elkjs) — **EPL-2.0 OR GPL-3.0, weak copyleft, flagged** | **HAVE.** dagre only if edge crossings become a reported problem |
| **Popovers for the Learn layer** (DB-P4-3) | The browser's Popover API and CSS anchor positioning; [@floating-ui/dom](https://github.com/floating-ui/floating-ui) — MIT, 1.8.0 (2026-07), 2 deps | **HAVE** (the platform) |
| **Accessibility checks at 3 widths × 2 themes** (DB-P12-6) | axe-core 4.13.0 + playwright-core 1.61.1 — installed | **HAVE** |
| **Search box** (DB-N9-10) | FTS5 in `node:sqlite` | **HAVE** |

## B4.8 — the senior-PM skill scored, the Reviewer rebuilt (P6, P8, NEW-planner-pm-9)

| Capability | Candidates | Verdict |
| --- | --- | --- |
| **The Reviewer's per-file diff reading and coverage line** (RG-P8-5/6) | Own `diff_parse.js`, `structure.js` | **HAVE** |
| **Structural diff** (RG-S5-19, the reading aid) | [difftastic](https://github.com/Wilfred/difftastic) — MIT, 0.71.0 (2026-09-18); tree-sitter, optional subprocess, JSON output is unstable | **HAVE** (`structure.js`). difftastic is Later |
| **Seeded-defect set, at least 20** (RG-P8-13) | The built-in mutation operators (have) plus hand-picked defects | **BUILD** on the mutator (labels by a person, MS-T11-4) |
| **Scripted-conversation evaluation** (PM-P6-13, PM-N9-4) | Promptfoo — **rejected by DEC-41** | **BUILD** on `packages/eval` |
| **Exact statistics** (MS-M12, MS-N5-4) | Own `stats.ts` (DEC-42 kept it; checked against scipy) | **HAVE** |
| **Syntax highlighting in the Changes tab** (nice to have) | [highlight.js](https://github.com/highlightjs/highlight.js) — BSD-3-Clause, 11.12.0 (2026-08), 0 deps, ESM build that can be vendored; [Shiki](https://github.com/shikijs/shiki) — MIT, 8 deps plus a WASM/regex engine, heavy | **REUSE highlight.js** (vendored core plus about 6 languages), if the owner wants highlighting |

## B4.11 — working together (NEW-teams-5..11, NEW-kernel-10)

| Capability | Candidates | Verdict |
| --- | --- | --- |
| **Presence: avatars within 5 s, nothing in the log** (TEAM-26, DB-N9-20) | The existing SSE stream (`server.ts`) and WebSocket adapter (`ws.ts`); an in-memory map with a heartbeat. y-protocols awareness is overkill | **HAVE** (transport) + **BUILD** (about 60 lines) |
| **Markdown in comments, updates and issues, safely** (DB-S3c-3) | Own `renderPmMarkdown` (escapes by construction). [marked](https://github.com/markedjs/marked) — MIT, 0 deps; [markdown-it](https://github.com/markdown-it/markdown-it) — MIT, 15.0.2 (2026-09), 6 deps; with `html:false` it is safe without a sanitiser. [DOMPurify](https://github.com/cure53/DOMPurify) — MPL-2.0 **OR** Apache-2.0 (take Apache-2.0), 0 deps | **HAVE** for display. **REUSE markdown-it (`html:false`)**, vendored ESM, only if people's comments need GFM (tables, task lists) |
| **@mentions and links** (TEAM-21/22) | [linkify-it](https://github.com/markdown-it/linkify-it) — MIT, 6.1.0 (2026-07) | **BUILD** the mention parsing (a regex over known handles, run before rendering) |
| **Inbox, subscriptions, snooze, digest** (TEAM-21/23/43) | none (domain) | **BUILD** |
| **Email push within the budget** (TEAM-43) | [nodemailer](https://github.com/nodemailer/nodemailer) — **MIT-0**, 10.0.10 (2026-09-14), **0 deps**, Node ≥ 20. It is the survey's own DS-P7-1 test case | **REUSE nodemailer** (SMTP only; chat goes through the existing Slack path) |
| **Audit view: filter and export** (TEAM-27) | [csv-stringify](https://github.com/adaltas/node-csv) — MIT, 6.9.0 (2026-09-25), 0 deps. CSV formula-injection escaping (`=`, `+`, `-`, `@`) is needed either way | **BUILD** (RFC 4180 plus the injection guard, about 30 lines) and JSON Lines |
| **Relative times** ("3 min ago") | `Intl.RelativeTimeFormat` (platform) | **HAVE** |

## Flagged — do not use

| Item | Licence or problem |
| --- | --- |
| TruffleHog | AGPL-3.0; live verification sends secrets out |
| semgrep-rules (the registry) | Semgrep Rules License v1.0: no redistribution |
| opengrep/opengrep-rules | Commons Clause, archived |
| trailofbits/semgrep-rules | AGPL-3.0 |
| SNUTS.js | GPL-3.0 |
| mindedsecurity android rules | GPL-3.0 |
| libyear (npm) | LGPL-3.0 |
| elkjs | EPL-2.0 OR GPL-3.0 |
| OWASP ASVS text | CC-BY-SA-4.0 (cite ids only) |
| askalono | archived |
| ml-logistic-regression | stale since 2022 |
| semgrep / opengrep engine | LGPL-2.1: acceptable only as an unmodified separate process (as today) |
| DOMPurify | pick the Apache-2.0 side of the dual licence |
| Hypothesis, pytest-rerunfailures | MPL-2.0: project-side dependencies only, never vendored |

## Where no good library exists (build)

- A permissively licensed, broad, offline SAST rule set for TS/JS/Python.
- A test-smell lint for "expected value computed by the code under test".
- Stub-kill.
- The requirement graph with suspect links and proven-by-strength.
- The INVEST, EARS and criterion lint.
- SBFL for JS/TS.
- Per-framework half-done heuristics ("route with no handler", "schema with no migration").
- A depth-profile quality checklist with a permissive licence.
- Presence and Inbox semantics.
- Gate caching and flaky quarantine. These are small; no library is needed.
