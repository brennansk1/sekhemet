# Provenance and licence register

Three registers the build maintains. This file is canonical; the design links here rather than keeping a copy. This file is read by code, not only by people:

- `sekhemet register check` and `apps/harness/tests/registers.spec.ts` fail when a table below is malformed, a technique has no public source, or a dependency of this repository has a licence that is neither permissive nor listed under **Licences**.
- The `licenses` gate (`apps/harness/src/license_gate.ts`) runs beside every card's gates. A card that adds a dependency whose licence is not permissive fails verification unless that component is listed under **Licences** with its licence.

Keep the table headers exactly as they are; add rows, never columns. A cell never contains a pipe character.

## Techniques

Every adopted technique maps to a public source. Patterns learned from proprietary tools are reimplemented from published engineering writing and public analyses. Leaked code and verbatim prompts are never used.

| Technique | Public source | Date verified |
| --- | --- | --- |
| Micro-kernel agent architecture | DeepSeek AI, DeepSeek Harness (`dsh`) and the Cordis architecture (Aug 2026) | 2026-09-17 |
| Exact edit tool semantics | Anthropic Claude Code documentation and public engineering posts | 2026-09-17 |
| Sandbox and the `AGENTS.md` context standard | OpenAI Codex CLI (`openai/codex`), open repository | 2026-09-17 |
| Agent Skills manifest and progressive disclosure | Anthropic Agent Skills standard (`SKILL.md` format) | 2026-09-17 |
| Repo map via PageRank over AST tags | Aider repository map implementation (Apache-2.0) | 2026-09-17 |
| Command output condensing | RTK (Rust Token Killer, Apache-2.0, `rtk-ai/rtk`) | 2026-09-17 |
| Query-aware context pruning | SWE-Pruner (arXiv:2601.16746) and SWE-Pruner Pro (arXiv:2607.18213) | 2026-09-17 |
| Format tax and constrained decoding pitfalls | Wang et al., *Format Tax: Structured Outputs on Reasoning* (arXiv:2408.02442) | 2026-09-17 |
| Variant archive evolution | *Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents* (arXiv:2505.22954) | 2026-09-17 |
| On-the-fly tool synthesis | *Live-SWE-agent: Can Software Engineering Agents Self-Evolve on the Fly?* (arXiv:2511.13646) | 2026-09-17 |
| Demonstration-guided evolution | *DemoEvolve: Overcoming Sparse Feedback in Harness Evolution* (arXiv:2605.24539) | 2026-09-17 |
| AI reviewer before the human | AutoDev (Microsoft, arXiv:2403.08299) | 2026-09-19 |
| Evolving playbook with helpful and harmful counters | *Agentic Context Engineering* (ACE, arXiv:2510.04618) | 2026-09-19 |

## Licences

Components the harness depends on, reimplements, calls as a separate program, or names in a spec as a proposal or as Later. "Use" says how — which is what makes a non-permissive licence acceptable — and, after "If removed:", what happens without it.

**Rules.**

1. **Copyleft stays out of process.** A component under a copyleft licence (GPL, AGPL, LGPL, MPL where it would be modified) runs as a separate process reached over a socket, HTTP or its command line, is never linked into or bundled with the harness, and is replaceable by configuration. This is what makes SearXNG, Forgejo, Kiwix, ntfy's GPL option, semgrep and bubblewrap acceptable.
2. **Every row says what happens if the component is removed.** No component may be load-bearing without the design saying so; a component whose removal leaves no fallback is named as such.
3. **A proposal is not a dependency.** A row marked "proposal" or "Later" needs the owner's yes before it is added ([DEC-08](../design/DECISIONS.md#dec-08) lists what is approved); listing it here records its licence so the decision does not have to be researched again.
4. **Attribution travels with use.** Where a licence adds an attribution requirement beyond the licence text (Crawl4AI), the harness carries the credit wherever it presents that component's output.

| Component | Licence | Use |
| --- | --- | --- |
| Harness architecture reference (dsh, Cordis) | MIT | Architectural patterns only; pre-stable API; no code. If removed: nothing. (Not re-checked 2026-09-22.) |
| Repo-map algorithm reference (Aider) | Apache-2.0 | Reimplemented in TypeScript; no code copied. If removed: nothing |
| LSP symbol tooling reference (multilspy; Serena's SolidLSP) | MIT (multilspy, Serena's SolidLSP); GPL-3.0-or-later (the Serena application) | Patterns reimplemented in TypeScript; no Serena application code is used or copied, which keeps its GPL out (the 2026-09-17 row said MIT for all of Serena; its licence file is per component). If removed: nothing |
| Line pruner (SWE-Pruner / Pro) | MIT | Not adopted: deferred behind its null baseline (DECISIONS DEC-21); a keyword heuristic is used. If removed: nothing. (Not re-checked 2026-09-22.) |
| Grammar-constrained decoding (XGrammar / llguidance) | Apache-2.0 / MIT | Not used: tool calls rely on the inference server; hard schema constraints are a per-model choice (DEC-22). If removed: nothing |
| Browser automation (playwright) | Apache-2.0 | Development dependency: `playwright-core` 1.61.1 pinned (B4.2, DEC-29 O5), driving the cached Chromium build for the accessibility and sign-in checks (`a11y.spec.ts`, `signin_ui.spec.ts`); no browser is downloaded. The product's visual gate still drives a local headless Chromium directly. If removed: those two checks |
| Accessibility engine (axe-core) | MPL-2.0 | Development dependency, unmodified: `axe-core` 4.13.0 pinned (B4.2, DEC-29 O5), run by the gate's accessibility check (`apps/harness/tests/a11y.spec.ts`, DB-P12-6); use inside the product's visual gate is owner decision O27 (default: not in v1) (weak copyleft, file-level; unmodified use keeps it out of scope of rule 1). If removed: the in-house accessibility subset remains |
| Passkeys (`@simplewebauthn/server`) | MIT | Dependency, 14.0.3 pinned (B4.10, DEC-38 O28): WebAuthn registration and sign-in for the Team setup's local accounts. If removed: password sign-in only |
| Company SSO (`openid-client`) | MIT | Dependency, 6.8.8 pinned (B4.10, DEC-38 O29): OIDC with PKCE, nonce and a state cookie. If removed: no company sign-in |
| Common-password list (SecLists `xato-net-10-million-passwords-100000.txt`) | MIT (list from Mark Burnett's public-domain release) | Bundled data, `apps/harness/data/common-passwords.txt` with its licence beside it (B4.10, DEC-43; O30): checked offline, never looked up online. If removed: the length and name rules still apply, and the server warns at start |
| SPDX licence expressions (`spdx-expression-parse`, `spdx-satisfies`, `spdx-correct`) | MIT / MIT / Apache-2.0 | Dependencies of `@sekhemet/gates`, 5.0.0, 6.0.0 and 3.2.0 pinned (B4.5, DEC-08): the one licence classifier (`packages/gates/src/licence.ts`) parses, corrects and compares licence expressions. Their data comes with them: `spdx-license-ids` (CC0-1.0), `spdx-exceptions` (CC-BY-3.0) and `spdx-ranges` (MIT AND CC-BY-3.0), SPDX License List data, Copyright The Linux Foundation, attributed in NOTICE. If removed: every licence is unknown, so the survey recommends nothing and the licence gate fails every new dependency |
| Licence categories (ScanCode LicenseDB) | CC-BY-4.0 | Bundled data, `packages/gates/data/scancode-licensedb/categories.json` with its source, hashes, changes and attribution in the README beside it (B4.5, DEC-08; retrieved 2026-09-27 with the owner's approval), attributed in NOTICE: a category for each SPDX id. ScanCode's "Permissive" also covers licences some teams avoid (Beerware, CC-BY-4.0, WTFPL), which the gate now passes; JSON's "Good, not Evil" is ruled proprietary over it (lead ruling, review of B4.5: a field-of-use restriction, not OSI-approved), excluded and named. If removed: every licence is unknown, as above |
| History secret scanner (gitleaks) | MIT | The program is not a dependency: **approved 2026-09-25** (DEC-43) as an optional separate program for taking over a project (NEW-design-stage-6). Its **rule file** is bundled data: `packages/gates/data/gitleaks/gitleaks.toml`, gitleaks v8.30.1's default configuration (222 rules), unmodified, with its `LICENSE` and a README recording source, date and hashes beside it (DEC-44; retrieved 2026-09-27 with the owner's approval; `gitleaks_vendored.spec.ts`), attributed in NOTICE, as the bundled offline rule set: `packages/gates/src/gitleaks_rules.ts` reads it and rewrites its Go patterns for JavaScript with no RegExp modifier group (all 222 run on Node 22.13 and later, V8 12.4 included; a rule that cannot be rewritten is named as not run), and `secrets.ts` scans with it everywhere — the diff gate (G14), the write check (G7), redaction (SEC-22) and the history scan when gitleaks is not installed; when it is installed, the program runs with this same file as its `--config` — so every path reports gitleaks' rule ids (`gitleaks_rules.spec.ts`); rebuilt by `vendor.mjs` beside it. TruffleHog's live verification is not used. If removed: the bundled scan has no rules and every secret check stops (the module fails to load), so the file must ship |
| Semantic versions (`semver`) | ISC | Dependency of `@sekhemet/sync` and the harness, 7.8.5 pinned (DEC-44; compliance C1): every version read, compared and bumped — a release's next version with SemVer's 0.y.z rule (review-git RG-N4-1), a slice's release version, an upgrade's changelog range, a repository's releases between two versions. If removed: hand-written version arithmetic, which ignored prereleases |
| Markdown parser (`marked`) | MIT | Dependency of the harness, 18.0.14 pinned (DEC-44; compliance C1): the one parser for project documents read back — requirements, the brief, decision records (design-stage DS-N3-2), the brief's invariants (the architecture gate), the design stage's brief sections and the registers' tables (`apps/harness/src/markdown.ts`); it reads only, nothing is rendered. If removed: line-by-line parsing that read code blocks as structure |
| YAML parser (`yaml`) | ISC | Dependency of the harness, 2.9.1 pinned (DEC-44; compliance C2): the one reader of a repository's CI files (`apps/harness/src/ci_files.ts`) — GitHub Actions workflows and GitLab CI, block scalars, flow-style steps, anchors, merges and `extends:` — for the gate deriver, onboarding and a take-over's recon; a file that is not YAML is listed as unreadable (`ci_files.spec.ts`). If removed: an indentation reader and a `run:` regex that missed multi-line steps and GitLab CI |
| Image diffing (pixelmatch) | ISC | Not used: proposed for the visual gate's element screenshots, awaiting the owner (ruling R16). If removed: the in-house PNG comparison remains |
| Mutation testing tools (Stryker, mutmut, cargo-mutants, PIT) | Apache-2.0 / BSD-3-Clause / MIT / Apache-2.0 | Not used today: the harness's own diff-scoped mutation step covers TypeScript, and the Python, Rust and Go gate templates (`packages/gates/src/templates.ts`) name no mutation tool. Running each language's tool as an optional subprocess when installed, with the evidence saying when it was not, is a gap owned by gates (ruling R14). If removed: that language has no mutation score and the evidence says so |
| Secret scanner (gitleaks) | MIT | Subprocess over the changed files when installed, beside the built-in scanner, which runs gitleaks' own vendored rules (`packages/gates/src/builtin.ts` `secretsGate`). If removed: the built-in scanner alone, with the same rule ids |
| Vulnerability scanner (osv-scanner) | Apache-2.0 | Subprocess, offline database. If removed: the osv check is recorded as skipped, not passed silently |
| Static analysis engine (semgrep) | LGPL-2.1 | Binary called as a subprocess, never linked; community rules only. If removed: the semgrep check is recorded as skipped |
| Output condensing (RTK) | Apache-2.0 | Strategies reimplemented natively (context owns condensing); the RTK binary is never called. If removed: nothing |
| Git forge integration (Forgejo) | GPL-3.0-or-later | Separate service over its HTTP API. If removed: the Forgejo adapter has no target; GitHub is unaffected. (Not re-checked 2026-09-22.) |
| PM reference implementation (Taskmaster) | MIT + Commons Clause | Reference patterns only; no code copied. If removed: nothing |
| TypeScript compiler (typescript) | Apache-2.0 | Build, the parse gate and the repo map's facts (DEC-20). If removed: no build; there is no fallback |
| Test runner (vitest) | MIT | Development dependency |
| Linter and formatter (@biomejs/biome) | MIT OR Apache-2.0 | Development dependency |
| Node type definitions (@types/node) | MIT | Development dependency |
| Schema validation (valibot) | MIT | **Approved 2026-09-24** (DEC-29 O7) for event-payload validation; not yet added. If removed: hand-written validators per event type |
| Property-based testing (fast-check) | MIT | **Approved 2026-09-24** (DEC-29 O6) for acceptance tests derived from EARS criteria; not yet added. If removed: example-based tests only |
| Inference server for teams (vLLM) | Apache-2.0 | **Approved 2026-09-24** (DEC-29 O8) as an optional separate process over its OpenAI-compatible API; not yet used. If removed: llama.cpp serves every host |
| Inference benchmark (llama-bench, part of llama.cpp) | MIT | Pending owner decision O21, as a measurement tool run as a separate process. If removed: throughput measured from the harness's own records |
| Inference engine (llama.cpp, `llama-server`) | MIT | Separate process over its OpenAI-compatible HTTP API; the v1 Worker's engine (models). If removed: no local inference until another engine is qualified behind the same adapter |
| Inference engine (Ollama) | MIT | Separate process over HTTP; an optional engine behind the same adapter (`packages/models/src/http_adapter.ts`). If removed: llama-server serves every role |
| Apple Silicon inference (MLX, mlx-lm) | MIT | Not used: an engine label only (`packages/models/src/bakeoff.ts:17`); an adapter is Later (ruling R3). If removed: nothing |
| Model swapping proxy (llama-swap) | MIT | Not used: a minimal router is built instead (models). If removed: nothing |
| Server inference engine (SGLang) | Apache-2.0 | A proposal for a multi-user NVIDIA team server, as a separate process over an OpenAI-compatible API (DESIGN_RESEARCH_TEAM_SERVER); awaiting the owner (vLLM, above, is approved). If removed: vLLM or llama-server |
| Linux sandbox (bubblewrap, `bwrap`) | LGPL-2.1 (licence file) | Called as a separate program, never linked; the Linux confinement mechanism (security, DEC-21). If removed: Linux has no confinement and cards fail closed |
| Headless browser (Chromium) | BSD-3-Clause | A separate process driven over the DevTools protocol by the visual gate and the `browse` tool, confined (security item 4). If removed: visual checks cannot run and the card says so |
| Push notifications (ntfy) | Apache-2.0 and GPL-2.0 (dual) | The user's own separate service, reached over HTTP; never embedded (rule 1 covers the GPL option). If removed: Gotify or Slack, or no push |
| Push notifications (Gotify) | MIT | The user's own separate service, reached over HTTP. If removed: ntfy or Slack, or no push |
| Slack client (Slack Bolt, `@slack/bolt`) | MIT | Approved (DEC-08), not yet a dependency: Slack incoming webhooks are plain HTTP today; Bolt comes with Slack replies (integrations Later). If removed: webhooks only |
| GitHub client (`@octokit/*`) | MIT | Approved (DEC-08), not yet a dependency; may replace the hand-rolled client with P9. If removed: the hand-rolled client |
| MCP SDK (`@modelcontextprotocol/sdk`) | MIT and Apache-2.0 (in transition; new code Apache-2.0) | Approved (DEC-08) for the MCP server and client (extensibility NEW-extensibility-3); a dependency of `apps/harness` since B3.3 (1.30.x): the client's stdio and Streamable HTTP transports (`mcp_client.ts`); the server is still the hand-rolled JSON-RPC. If removed: the hand-rolled stdio client, no Streamable HTTP |
| Jira client (jira.js) and Linear client (`@linear/sdk`) | MIT | Approved (DEC-08) for live sync, which is Later; export and import need neither. If removed: export and import only |
| Web search (SearXNG) | AGPL-3.0 | A self-hosted separate service reached over HTTP, never embedded; research cards and the Researcher only, never the Worker. If removed: another configured provider, or no web search |
| Page crawler (Crawl4AI) | Apache-2.0, with an attribution requirement | A separate, user-installed service (`apps/harness/src/research/crawl4ai.ts`); its required credit is carried as `CRAWL4AI_CREDIT` (`research/cli.ts:8-9`). If removed: the built-in polite fetcher, without rendered pages |
| Text extraction (trafilatura) | Apache-2.0 | Not used: a proposed extractor (design-stage Later). If removed: nothing |
| PDF extraction (pypdfium2) | Apache-2.0 / BSD-3-Clause | Not used: proposed (design-stage Later). If removed: nothing |
| Document conversion (Docling) | MIT | Not used: proposed (design-stage Later). If removed: nothing |
| PDF to Markdown (PyMuPDF4LLM) | AGPL-3.0 | Not used and never distributed; only ever as a separate, user-installed process (rule 1). If removed: nothing |
| Offline documentation service (DevDocs) | MPL-2.0 | Not used: the old air-gap kit named it; the kit's own docs bundle is used instead (security item 48). If removed: nothing |
| Offline documentation service (Kiwix, kiwix-tools) | GPL-3.0 | Not used: as above; a separate service only, if ever (rule 1). If removed: nothing |
| Documentation lookup services (Context7, DeepWiki) | MIT (Context7); DeepWiki is a hosted service with no code used | Not used: design-stage Later (hosted MCP sources); no code reaches either service. If removed: nothing |
| Parser generator (tree-sitter, `web-tree-sitter`) | MIT | Not used in v1 (DEC-20); the proposed parser for languages other than TypeScript. If removed: TypeScript-only facts |
| Structural search (ast-grep) | MIT | Not used: a proposed structural search and codemod tool (Later in worker-loop and context). If removed: nothing |
| Text search (ripgrep) | Unlicense OR MIT | Not called: `grep_search` is implemented in the harness. If removed: nothing |
| Research agent references (Open Deep Research; DeepResearch Bench) | MIT; Apache-2.0 | Patterns and an evaluation reference only; no code used. If removed: nothing |
| Structural diff (difftastic, `difft`) | MIT | Subprocess when installed, for the review diff (`packages/sync/src/git_adapter.ts:704-721`). If removed: the plain git diff |
| Changelog generation (git-cliff) | MIT OR Apache-2.0 | Subprocess when installed, for `sekhemet dev release` (`packages/sync/src/repo_tools.ts:92`). If removed: the built-in grouping |
| Local CI runner (nektos act) | MIT | Subprocess for `sekhemet dev ci`; typed `unavailable` when missing (`repo_tools.ts:204-215`). If removed: CI runs only in CI |
| Package registry mirrors (verdaccio; devpi) | MIT; MIT | Not used: mirror services are Later (security §7); v1 ships the lockfile allowlist. If removed: nothing |
| Container log viewer (Dozzle) | MIT | Not used: named by the old design for container logs on service hosts; v1 runs one container on a team server (DEC-29 O9), whose logs `docker logs` already shows. If removed: nothing |
| Minimal agent reference (mini-SWE-agent) | MIT | Reference only; no code used. If removed: nothing |
| Toolchain and hook managers (mise; lefthook) | MIT; MIT | Not used. lefthook: Sekhemet's own git never runs hooks (security item 23), and the repository's own `.githooks/` serve its development. mise: gates run a project's own tools as they are, with the team's own configuration (gates rule 23a), so the harness does not pin toolchains for a project. If removed: nothing |
| Benchmark and spelling tools (hyperfine; typos) | MIT OR Apache-2.0 | Not used: the old design's benchmark gate runner and spelling hygiene check; neither gate exists in gates today. If removed: nothing |
| JSON and YAML query (jq; yq) | MIT; MIT | Not used by the harness. If removed: nothing |
| Continuous SQLite replication (Litestream) | Apache-2.0 | Proposal for a company server's backups (runtime §7); single machines use `node:sqlite` backup. If removed: the built-in backup |
| Decision records and event envelope (MADR 4.0; CloudEvents 1.0 spec) | MIT OR CC0-1.0; Apache-2.0 | Formats only, no code: MADR for exported decision records (design-stage, a proposal), CloudEvents as the field mapping of the ledger export (runtime item 37). If removed: our own format |
| Sandbox and egress proposals (sandbox-runtime; Smokescreen; nsjail; landrun) | Apache-2.0; MIT; Apache-2.0; MIT | Not used: proposals from the security review (security §7), awaiting the owner. If removed: nothing |
| Secret and keychain proposals (secretlint; `@napi-rs/keyring`) | MIT; MIT | Not used: proposals (security §7). If removed: the built-in scanner; a 0600 file where no keychain exists |
| Runtime proposals (proper-lockfile; tree-kill; pino) | MIT; MIT; MIT | Not used: proposals (runtime §7). If removed: nothing |
| CLI and docs proposals (`@clack/prompts`; execa; Vale; markdownlint) | MIT; MIT; MIT; MIT | Not used: proposals (surface §7). If removed: nothing |
| Webhook tunnels (smee-client; cloudflared) | ISC; Apache-2.0 | Not used: proposals for webhook ingress on a laptop (integrations §7). If removed: webhooks only on a reachable server |

Licences were re-checked on 2026-09-22 against each project's licence file, through GitHub's licence API and, where it could not classify the file (Serena, bubblewrap, jq, Gotify, pypdfium2, devpi, the MCP SDK, MADR, Taskmaster), by reading the file itself; rows marked "not re-checked" keep their 2026-09-17 value. The dependencies of this repository are also checked against their installed `package.json` by the test above.

## Model weights and engine

The shipped models' weights and the engine images the Team server runs ([models](../design/specs/models.md) rules 3, 4, 8a and 26a; [DEC-47](../design/DECISIONS.md#dec-47--the-finish-line-decisions) O-5). Each row was verified on 2026-10-04 (C3): a model's SHA-256 and size from the hub's tree API (the file's LFS hash), its licence from the model card (`cardData.license`), and the hash cross-checked against the reference host's registry or its copy; an image's digest from its registry's manifest. The source table in code (`SHIPPED_MODELS`, `packages/models/src/shipped_models.ts`) holds the same values, and `apps/harness/tests/registers.spec.ts` fails when a row is missing or differs. The weights are downloaded only on a person's explicit ask (`sekhemet models fetch`, **Download…**), never bundled.

| Model or engine | Role | Repository or image | File or tag | SHA-256 or digest | Licence |
| --- | --- | --- | --- | --- | --- |
| nail-mtp (Nail-Qwen3.6-35B-A3B MTP, UD-IQ3_XXS, 14,069,275,872 bytes) | Coding | `peculiar-ragdoll/Nail-Qwen3.6-35B-A3B-GGUF-MTP` | `Nail-Qwen3.6-35B-A3B-MTP-UD-IQ3_XXS.gguf` | `6275d06c6e1b0d0a4e07a69a5fbdc719dbaeaae87bc48e6c8377f4cd58ec369c` | Apache-2.0 |
| Qwen3.8-27B GSQ-RCO (IQ3_S with MTP head, 12,120,016,960 bytes) | Planning | `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF` | `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` | `58fd826723939933dc86f45b7fe04545cbc2de1c70f6fe2cdd3858c87a98c12f` | Apache-2.0 |
| Apodex-1.1-mini (IQ3_M, 16,022,990,656 bytes; a quantisation of `apodex/Apodex-1.1-mini`, Apache-2.0) | Research | `abenzerps/Apodex-1.1-mini-GGUF` | `Apodex-1.1-mini-IQ3_M.gguf` | `8620c43276492c59be49269b0cce52ca4f6698c73154751274fa73eb831fb38a` | Apache-2.0 |
| Cyber-Tiel-Coder-35B-A3B MTP (UD-IQ3_XXS, 13,600,579,904 bytes) | Measurement baseline (DEC-04), not shipped | `peculiar-ragdoll/Cyber-Tiel-Coder-35B-A3B-GGUF-MTP` | `Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf` | `d60adb32312166b49ceffbd10aed297aee69626b45ec4e720700450ee048bd0e` | MIT |
| llama.cpp server, CUDA (b10818) | Team server engines (default) | `ghcr.io/ggml-org/llama.cpp` | `server-cuda-b10818` | `sha256:e61f29b37c471f956a772f91f4e9952d29f237e5d1a1a748e14421aae090305f` | MIT |
| llama.cpp server, Vulkan (b10818) | Team server engines | `ghcr.io/ggml-org/llama.cpp` | `server-vulkan-b10818` | `sha256:d14e49d20a4baf070cedcafbf32388ab1ff809f52fb7ec950371fba01a13c0bd` | MIT |
| llama.cpp server, CPU (b10818) | Team server engines | `ghcr.io/ggml-org/llama.cpp` | `server-b10818` | `sha256:1394ab6c8e418859b282ff5a38a218ab318b2b4de8848c611b92e92017d6d8e4` | MIT |
| oauth2-proxy v7.15.5 | Team server identity proxy | `quay.io/oauth2-proxy/oauth2-proxy` | `v7.15.5` | `sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916` | MIT |
| Node.js base image (`node:24-bookworm-slim`) | Team server image base | `docker.io/library/node` | `24-bookworm-slim` | `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` | MIT (Node.js); the Debian packages under their own licences |

The Review role has no row: it is unfilled until a model is admitted for it (RG-P8-13). llama.cpp b10818 is the first container build published at or above the shipped set's engine floor (b10809, the build the Coding and Planning models qualified on; it has no container image). The engine release a person downloads on a laptop (*Get the inference engine*, models rule 6b) is pinned separately, with its assets and hashes, in the table below.

The llama.cpp release *Get the inference engine* and `sekhemet engine get` download (models rule 6b, NEW-models-19): the build the shipped set qualified on (b10809, the floor). Each asset's SHA-256 and size are the digests GitHub's release API publishes for the tag `b10809` of `ggml-org/llama.cpp`, read on 2026-10-04 (C3); the source table in code (`ENGINE_PIN`, `packages/models/src/inference_engine.ts`) holds the same values, and `packages/models/tests/engine.spec.ts` fails when a row is missing or differs. Downloaded only on a person's yes, never bundled.

| Engine asset | Platform (backend) | Release | File | SHA-256 | Size (bytes) | Licence |
| --- | --- | --- | --- | --- | --- | --- |
| llama.cpp b10809, macOS | macOS arm64 (Metal) | `ggml-org/llama.cpp` `b10809` | `llama-b10809-bin-macos-arm64.tar.gz` | `7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2` | 11,123,196 | MIT |
| llama.cpp b10809, Linux CPU | Linux x64 (CPU) | `ggml-org/llama.cpp` `b10809` | `llama-b10809-bin-ubuntu-x64.tar.gz` | `5e34434ddc6d03cd1584f403201aff0d4bd1a5793a72ff7e286532dfd1e4b941` | 16,734,586 | MIT |
| llama.cpp b10809, Linux Vulkan | Linux x64 (Vulkan) | `ggml-org/llama.cpp` `b10809` | `llama-b10809-bin-ubuntu-vulkan-x64.tar.gz` | `07f029cef440c82c3cff5310641eb6347e5cbcd865a5d88990215058aa049e93` | 33,799,345 | MIT |
