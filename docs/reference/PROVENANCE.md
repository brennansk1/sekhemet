# Provenance and licence register

Two registers the build maintains. This file is canonical; the design links here rather than keeping a copy. This file is read by code, not only by people:

- `sekhemet register check` and `apps/harness/tests/registers.spec.ts` fail when a table below is malformed, a technique has no public source, or a dependency of this repository has a licence that is neither permissive nor listed under **Licences**.
- The `licenses` gate (`apps/harness/src/license_gate.ts`) runs beside every card's gates. A card that adds a dependency whose licence is not permissive fails verification unless that component is listed under **Licences** with its licence.

Keep the table headers exactly as they are; add rows, never columns.

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

Components the harness depends on, reimplements, or calls as a separate program. "Use" says how, which is what makes a non-permissive licence acceptable.

| Component | Licence | Use |
| --- | --- | --- |
| Harness architecture reference (dsh, Cordis) | MIT | Architectural patterns only; pre-stable API |
| Repo-map algorithm reference (Aider) | Apache-2.0 | Reimplemented in TypeScript |
| LSP symbol tooling reference (Serena, multilspy) | MIT | Reimplemented in TypeScript |
| Line pruner (SWE-Pruner / Pro) | MIT | Not adopted: deferred behind its null baseline (DECISIONS DEC-21); a keyword heuristic is used |
| Grammar-constrained decoding (XGrammar / llguidance) | Apache-2.0 / MIT | Not used: tool calls rely on the inference server; hard schema constraints are a per-model choice (DEC-22) |
| Browser automation (playwright) | Apache-2.0 | Not a dependency: the visual gate drives a local headless Chromium directly, and uses a Playwright-cached Chromium if one is installed; adding the library is a proposal awaiting the owner |
| Accessibility engine (axe-core) | MPL-2.0 | Not used: proposed as an unmodified development dependency, awaiting the owner (weak copyleft) |
| Image diffing (pixelmatch) | ISC | Not used |
| Mutation testing tools (Stryker, mutmut, cargo-mutants, PIT) | Apache-2.0 / BSD / MIT | Not used: the harness runs its own diff-scoped mutation step |
| Secret scanner (gitleaks) | MIT | Subprocess |
| Vulnerability scanner (osv-scanner) | Apache-2.0 | Subprocess, offline database |
| Static analysis engine (semgrep) | LGPL-2.1 | Binary called as a subprocess; community rules only |
| Output condensing (RTK) | Apache-2.0 | Strategies reimplemented; binary optional behind `run` |
| Git forge integration (Forgejo) | GPL-3.0-or-later | Separate service over its HTTP API |
| PM reference implementation (Taskmaster) | MIT + Commons Clause | Reference patterns only; no code copied |
| TypeScript compiler (typescript) | Apache-2.0 | Build and the parse gate |
| Test runner (vitest) | MIT | Development dependency |
| Linter and formatter (@biomejs/biome) | MIT OR Apache-2.0 | Development dependency |
| Node type definitions (@types/node) | MIT | Development dependency |

Every licence above is verified against the project's root `LICENSE` file at the pinned release; the four dependencies of this repository are also checked against their installed `package.json` by the test above.
