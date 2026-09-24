# Provenance and licence register

Two registers the build maintains. This file is canonical; the design links here rather than keeping a copy. This file is read by code, not only by people:

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
| Browser automation (playwright) | Apache-2.0 | Not a dependency: the visual gate drives a local headless Chromium directly, and uses a Playwright-cached Chromium if one is installed; adding the library was **approved 2026-09-24** (DEC-29 O5); not yet added. If removed: nothing |
| Accessibility engine (axe-core) | MPL-2.0 | Not used: **approved 2026-09-24** (DEC-29 O5) as an unmodified development dependency, not yet added; use inside the product's visual gate is owner decision O27 (default: not in v1) (weak copyleft, file-level; unmodified use keeps it out of scope of rule 1). If removed: the in-house accessibility subset remains |
| Image diffing (pixelmatch) | ISC | Not used: proposed for the visual gate's element screenshots, awaiting the owner (ruling R16). If removed: the in-house PNG comparison remains |
| Mutation testing tools (Stryker, mutmut, cargo-mutants, PIT) | Apache-2.0 / BSD-3-Clause / MIT / Apache-2.0 | Not used today: the harness's own diff-scoped mutation step covers TypeScript, and the Python, Rust and Go gate templates (`packages/gates/src/templates.ts`) name no mutation tool. Running each language's tool as an optional subprocess when installed, with the evidence saying when it was not, is a gap owned by gates (ruling R14). If removed: that language has no mutation score and the evidence says so |
| Secret scanner (gitleaks) | MIT | Subprocess over the changed files when installed, beside the built-in scanner (`packages/gates/src/builtin.ts:193-200`). If removed: the built-in scanner alone |
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
| MCP SDK (`@modelcontextprotocol/sdk`) | MIT and Apache-2.0 (in transition; new code Apache-2.0) | Approved (DEC-08) for the MCP server and client (extensibility NEW-extensibility-3); not yet a dependency. If removed: the hand-rolled JSON-RPC |
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

Licences were re-checked on 2026-09-22 against each project's licence file, through GitHub's licence API and, where it could not classify the file (Serena, bubblewrap, jq, Gotify, pypdfium2, devpi, the MCP SDK, MADR, Taskmaster), by reading the file itself; rows marked "not re-checked" keep their 2026-09-17 value. The four dependencies of this repository are also checked against their installed `package.json` by the test above.
