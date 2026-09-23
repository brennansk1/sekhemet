---
spec: extensibility
status: partial
audiences: [developer]
code:
  - packages/kernel/src/hooks.ts
  - apps/harness/src/user_hooks.ts
  - packages/context/src/skills.ts
  - apps/harness/src/mcp.ts
  - apps/harness/src/mcp_client.ts
  - apps/harness/src/acp.ts
  - apps/harness/src/pm/slash.ts
  - packages/sdk/src/index.ts
  - packages/eval/src/diagnostics.ts
tests:
  - packages/kernel/tests/hooks.spec.ts
  - apps/harness/tests/user_hooks.spec.ts
  - packages/context/tests/context_units.spec.ts
  - packages/context/tests/skills_prompts.spec.ts
  - apps/harness/tests/wave2_wiring.spec.ts
  - apps/harness/tests/mcp.spec.ts
  - apps/harness/tests/mcp_client.spec.ts
  - apps/harness/tests/acp.spec.ts
  - apps/harness/tests/slash.spec.ts
  - apps/harness/tests/sdk.spec.ts
changes: [S9, S4]
---

# Extensibility: hooks, skills, MCP, ACP, commands and the SDK

## 1. Purpose

A team extends Sekhemet without forking it: it runs its own checks at lifecycle points, teaches the Worker its procedures, connects the tools it already uses, and drives the board from its editor or scripts. Every extension point either runs confined or runs only after the user trusts it ([security](security.md) owns the trust mechanism; this spec owns what it gates). No extension may weaken the spine: an extension can observe, add context, or block — never certify a card or move it past a gate.

## 2. Behaviour

### What runs where, and what trust gates

| Extension | Declared in | Runs | Gated by workspace trust (S9) |
| --- | --- | --- | --- |
| Hooks | `.sekhemet/hooks.toml` (project), `~/.sekhemet/hooks.toml` (user) | outside the sandbox, user's rights | project file: yes; user file: no |
| MCP servers (client) | `.sekhemet/mcp.json` (project), `~/.sekhemet/mcp.json` (user) | outside the sandbox, declared environment only | project file: yes |
| Skills | `.sekhemet/skills/<name>/` (project), `~/.sekhemet/skills/<name>/` (user) | body is prompt text; `scripts/` run inside the card's sandbox | every skill: human approval by content hash |
| Slash commands | built in | inside the harness | — |
| MCP server, ACP, SDK | started by the user | inside the harness, as actor `mcp` (MCP) or the PM chat (ACP) | — |

1. A project file that is not trusted is not loaded; the harness says which file waits for trust and what it would run. A user-level file is the user's own configuration and is trusted.
2. When both levels define the same hook event or MCP server name, both hooks run (user first) and the **user's** MCP server definition wins; a project may add servers, not replace the user's.

### Hooks

3. A hook is a shell command bound to a lifecycle event, declared as:
   ```toml
   [[hook]]
   event = "post-tool"      # a lifecycle event
   tool = "write_file"      # optional: pre-tool / post-tool only
   command = "pnpm exec biome format --write $SEKHEMET_TOOL_TARGET"
   timeout_s = 30
   ```
4. **Events.** Card lifecycle: `card/start`, `pre-step` (context injection), `pre-tool` (permission and validation), `post-tool` (parse checks, secret scanning), `pre-gate`, `post-gate`, `card/end`, `review/return`, `playbook/propose`, `turn-stopping` (stall detection). Board lifecycle (NEW-extensibility-1): `card/status_changed`, `card/accepted`, `pr/opened`.
5. **Input.** The event's context as JSON on stdin, and `SEKHEMET_EVENT`, `SEKHEMET_CARD`, `SEKHEMET_TOOL`, `SEKHEMET_TOOL_TARGET` in the environment.
6. **Result.** Exit 0 continues; a JSON object on stdout with `message` (or `inject: [...]`) adds text to the next model turn. Exit 2 blocks the action and stderr is the reason the model is told. Any other exit, a crash, or a timeout: `pre-step`, `pre-tool` and `pre-gate` fail **closed** (a broken guard must not become a silent allow); every other event fails open and records the error.
7. A board-lifecycle hook observes only: it cannot block or reverse a transition that has happened; it can post a message to the card's dossier.
8. A hook's load error (bad TOML, unknown event) is reported by `doctor` and on the next card's evidence, not discarded. A hook that exits before reading its stdin does not crash the harness.
9. A hook never runs handlers built from model output. The Worker cannot edit any extension file: the permission engine denies writes to `.sekhemet/hooks.toml`, `.sekhemet/mcp.json`, `.sekhemet/skills/` and `.sekhemet/plugins/` (today it protects only `gates.toml`, `config.toml` and the ledger), and a project file changed by any route needs trust again ([security](security.md) item 39).

### Skills

10. A skill follows the open Agent Skills format: a directory with `SKILL.md` (YAML front matter — `name`, `description`, optional `triggers`, `tools`, `budget_tokens` — and a Markdown body), optional `scripts/`, `references/` and `evals/`.
11. **Progressive disclosure.** Every approved skill contributes one manifest line to the prompt's stable zone; its body loads only when the skill is selected for the card; `references/` load on demand.
12. **Selection.** The planner attaches skills to a card deterministically: by the card's class and the skill's description, with declared `triggers` matched as whole words (the trigger `ast` does not fire on "last"). A skill whose required `tools` the card lacks is omitted. A skill never widens the card's tool set.
13. **Scopes.** Project, then user; a project skill with the same name overrides the user's for that project.
14. `budget_tokens` is read: a body over its budget is truncated at a section boundary and the card's evidence says so.
15. **Trust.** Each skill is pinned by SHA-256 and loads only after a person approves that content (`sekhemet dev skills approve|revoke <name>`); a changed skill is rejected until re-approved; every decision is audited. There is no trust-on-first-use, and a lock file shipped in the repository does not count ([security](security.md) item 39). A skill whose files would modify gate files, the loop driver or sandbox configuration is rejected when it is imported.
16. **Diagnostics.** `sekhemet doctor` reports, per skill and playbook rule: its token cost against the stable-zone budget, whether it triggered on recent cards, and its measured net gain (pass rate with it minus without, from recorded outcomes). A skill that costs context and shows no gain is proposed for removal; it is never removed automatically.
17. **Sourcing.** Skills are procedure, not capability. Aggregators and marketplaces are for discovery only; a pulled skill is pinned by commit hash, read before approval, and diffed on update.
17a. **Verify before admitting.** A skill with an `evals/` directory — and every skill candidate the harness distils from trajectories (`.sekhemet/skill-candidates/`) — has its evals run in the sandbox with no network before a person is asked to approve it; the approval prompt shows the result, and a skill whose evals fail cannot be approved. The admission record keeps the evidence, the checks run and the gaps left open. This is one instance of the rule that nothing durable is admitted unless a signal measured outside the generated text improves ([measurement](measurement.md) owns the rule; more skills can hurt, so gain is measured, item 16).

### MCP server

18. `sekhemet mcp` serves the board to MCP clients (editors, other agents, CI) over stdio: list, get, create and update cards (team fields only), move a card among `ready`, `backlog` and `parked`, run gates, read the PM thread, the capability report, learning rules, events and `doctor`; plus the evidence bundle and the model registry, read-only (NEW-extensibility-3).
19. Every write is recorded with actor `mcp`. Accepting is a person's action: the server validates every argument on the server side, and no argument — including a `reason` beginning `override:` — moves a card to Done, Review or any state outside the tool's list (the kernel enforces it too: [kernel](kernel.md) S4).
20. A `card_id` is validated against the card-id pattern before it is used in a path.
21. The server negotiates the protocol version with the client and answers malformed requests with `id: null`, as JSON-RPC requires. It is built on the official `@modelcontextprotocol/sdk` ([DEC-08](../DECISIONS.md#dec-08)).

### MCP client

22. Servers declared in `mcp.json` (the `mcpServers` format other agents use) are started with only the variables they declare plus the sandbox's allowlist — never the harness's full environment — and the stdio, Streamable HTTP and OAuth transports of the official SDK.
23. Discovered tools are offered to the Researcher, the Planner and Seshat, each tool description counted against the prompt budget. A server's `tools` list narrows what is offered. The Worker gets MCP tools only when a server lists them in `worker_tools` and the model registry permits tools for that Worker; otherwise its tool set stays the fixed per-class set ([worker-loop](worker-loop.md), M2).
24. Every MCP call is logged on the ledger with its server, tool and a hash of its arguments; a server that sends data off the machine is an integration the user connected ([security](security.md) item 33).

### Editor protocol (ACP)

25. `sekhemet acp` speaks the Agent Client Protocol over stdio (`initialize`, `session/new`, `session/prompt`, `session/cancel`). The agent behind it is Seshat: an editor's agent panel becomes a conversation about the board with the same slash commands, and replies stream as `session/update` chunks. Cards still run in the queue; the editor asks, plans and triages.

### Commands in the PM conversation

26. Slash commands in Seshat's chat (dashboard, ACP): `/help`, `/compact`, `/plan`, `/forecast`, `/capability`, `/research`, `/deep`, `/ready`, `/park`, `/backlog`, `/status`, `/standup`. They share one implementation with the board's buttons and the CLI.

### Headless use and the SDK

27. Everything the board can do is available headless from the CLI with meaningful exit codes ([surface](surface.md)): run one card unattended, plan without executing, run gates only, bake off models, replay a card against a pinned configuration.
28. `@sekhemet/sdk` is a typed client for a running server: REST calls and the live event stream. If it ships (open question 1), its types come from the kernel's, not copies, and the event stream is an async iterator.

### Plugins

29. There is no plugin API in v1. `packages/kernel/src/container.ts` is cut ([DEC-09](../DECISIONS.md#dec-09)), and with it the loader that mounted `.sekhemet/plugins/*/index.mjs` on each card (`execute.ts:374-387`). A plugin could only add services and hooks, never the tools, gates, sync adapters or UI panels the old design promised; hooks and MCP cover the need.

### Tools outside the Worker

Decisions on what the Planner and the infrastructure use, adopt or build; the owning spec states each one's behaviour and state. The Worker's tools are in [worker-loop](worker-loop.md); the gates' tools are listed with their gates in [gates](gates.md) (tree-sitter parse; tsc, ruff, clippy, eslint; per-language test runners with a parser to `GateFailure`; Stryker, mutmut, cargo-mutants, PIT; gitleaks; registry existence and typosquat checks; osv-scanner offline; Semgrep CE; Playwright console, network, DOM and layout checks; screenshot diff; axe-core; a local vision checklist at temperature 0; hygiene checks).

| Tool | Decision | Owner |
| --- | --- | --- |
| Repo map query | Build (tree-sitter, PageRank, binary-search budget fit; reference Aider) | [context](context.md) |
| Dependency and impact analysis | Build over language-server references | [planner-pm](planner-pm.md) |
| Task decomposition | Build; Taskmaster's patterns as reference, no code (Commons Clause) | [planner-pm](planner-pm.md) |
| Difficulty scoring | Build from scope, symbols, tests and history | [planner-pm](planner-pm.md) |
| Search and fetch (SearXNG, trafilatura, Crawl4AI) | Wrap; research cards and the Research Desk only, **never the Worker** | [design-stage](design-stage.md) |
| `plan_research` | Build: a card's open questions, answered before it starts | [design-stage](design-stage.md) |
| Board operations (create, split, link, budget) | Build | [planner-pm](planner-pm.md) |
| Inference | Wrap llama.cpp server; MLX as a later Apple Silicon adapter | [models](models.md) |
| Model swapping | Build a minimal router rather than llama-swap | [models](models.md) |
| Constrained decoding | XGrammar or llguidance behind the tool-arm interface, a per-model measured choice ([DEC-22](../DECISIONS.md#dec-22--rejected-techniques)) | [models](models.md) |
| Sandbox, worktrees | Build over Seatbelt, bubblewrap and git | [security](security.md), [review-git](review-git.md) |
| Notifications | Wrap self-hosted ntfy or Gotify | [integrations](integrations.md) |
| Structural diff | Wrap difftastic | [review-git](review-git.md) |
| Event log and hash chain | Build over SQLite WAL | [kernel](kernel.md) |
| Output condensing | RTK for command output; native condensers for read, grep, glob | [worker-loop](worker-loop.md) |
| Goal monitoring | Build: event-log queries with thresholds | [planner-pm](planner-pm.md) |

## 3. Contract

| Item | Source |
| --- | --- |
| `LifecycleHookEvent`, `LifecycleHookEngine`, `HookHandler`, `HookMessage`, `DEFAULT_FAIL_CLOSED_EVENTS` | `packages/kernel/src/hooks.ts` |
| `hooks.toml` schema, `loadUserHooks`, `hookEngineFor` | `apps/harness/src/user_hooks.ts` |
| `SkillManifest`, `SkillsRegistry`, `skills.lock.json` (to move to the user directory) | `packages/context/src/skills.ts` |
| `playbookDiagnostics` | `packages/eval/src/diagnostics.ts` |
| MCP tools `sekhemet_*` | `apps/harness/src/mcp.ts:60-270` |
| `McpServerConfig`, `loadMcpConfig`, `McpHub` | `apps/harness/src/mcp_client.ts` |
| ACP (`ACP_PROTOCOL_VERSION = 1`) | `apps/harness/src/acp.ts` |
| Slash commands | `apps/harness/src/pm/slash.ts:71-130` |
| `@sekhemet/sdk` | `packages/sdk/src/index.ts` |
| CLI: `sekhemet mcp`, `sekhemet acp`, `sekhemet dev skills [list] \| approve \| revoke` | `index.ts`, `wave2.ts:756` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Hook engine, ten events, fail-closed `pre-*` | built | `hooks.ts:12-38`; `hooks.spec.ts`; emitted at `session.ts` 1093/1175/1351/1390/1596/1622, `card_runner.ts` 845/1501 | — |
| `hooks.toml`: block, inject, env, stdin | built | `user_hooks.spec.ts` (3 tests) | — |
| Hook load errors, stdin EPIPE, timeout | partial | errors dropped (`execute.ts:377` keeps only `.engine`); no stdin error handler (`user_hooks.ts:144`); no timeout test | NEW-extensibility-2 |
| User-level hooks | not-built | project path only (`user_hooks.ts:56`) | NEW-extensibility-2 |
| Board-lifecycle hook events | not-built | — | NEW-extensibility-1 |
| Repo hooks, `mcp.json` load without trust | not-built (trust) | `user_hooks.ts:56`, `mcp_client.ts:29-49` | S9 |
| Extension files protected from the Worker | not-built | `PROTECTED_SYSTEM_PATTERNS` covers `gates.toml`, `config.toml`, `.sekhemet/(events.db\|checkpoints\|artifacts)` only (`sandbox/src/permissions.ts:43-54`) | S9 |
| Skills: SHA-256 pin, approve/revoke, audit | partial | `skills.ts`; trust-on-first-use by default and lock in the repo (`skills.ts` `loadFromDirectory`) | S9 |
| Skills format: regex front matter, required inline `triggers`, substring match, project scope only, `budgetTokens` unread, `scripts/`, `references/`, `evals/` ignored | partial | `skills.ts:162-178, 251-283`; `execute.ts:356-357` | NEW-extensibility-4 |
| Skill diagnostics | partial | `diagnostics.ts`; called with no outcomes, skills or cards (`wave2.ts:1111`), so gain and "never triggered" never appear | NEW-extensibility-4 |
| Skill evals run before approval | not-built | candidates written by `distillSkill` (`eval/src/loops.ts:259`, `wave2.ts:908`) reach approval with `evals/` never executed | NEW-extensibility-4 |
| MCP server tools | built | `mcp.ts`; `mcp.spec.ts` (10 tests, happy paths) | — |
| MCP `move_card` override to Done | not-built (bypass open) | probed: `mcp.ts:155-180`, `board_service.ts:292-300` | S4 |
| MCP server: protocol `2024-11-05` fixed, `id: 0` on parse error, unchecked `card_id` path, no evidence/registry tools | partial | `mcp.ts:277, 343, 186-188` | NEW-extensibility-3 |
| MCP client: stdio only, full env, Researcher only | partial | `mcp_client.ts:73-77`; `research/cli.ts:66` | NEW-extensibility-3 |
| ACP as PM chat | built | `acp.ts`; `acp.spec.ts` | — |
| Slash commands | built | `slash.ts`; `slash.spec.ts` | — |
| SDK | not-built (reachable only from its test) | `sdk.spec.ts` is its only consumer; types copied (`sdk/src/index.ts:15-35`) | open question |
| Plugins | to cut | loader live at `execute.ts:374-387` via the kernel barrel | DEC-09 |

## 5. Changes for v1

### S9 — what workspace trust gates
- **EXT-1** WHEN an untrusted project `hooks.toml` declares a `pre-tool` hook THE SYSTEM SHALL not run it, and the card SHALL proceed as if no project hook existed, with a note in its evidence.
- **EXT-2** WHEN an untrusted project `mcp.json` declares a server THE SYSTEM SHALL not start it.
- **EXT-3** WHEN a skill's content changes after approval THE SYSTEM SHALL not load it until it is approved again.
- **EXT-4** WHEN a repository has skills and no user-side approval THE SYSTEM SHALL load none of their bodies.
- **EXT-5** WHEN a skill's `scripts/` file runs THE SYSTEM SHALL run it inside the card's sandbox.
- **EXT-5a** WHEN the Worker writes `.sekhemet/hooks.toml`, `.sekhemet/mcp.json` or a file under `.sekhemet/skills/` in its worktree THE SYSTEM SHALL deny the write with rule `protected_system`.

### S4 — MCP cannot accept
- **EXT-6** WHEN an MCP client calls `sekhemet_move_card` with `to: "done"` (with or without a reason beginning `override:`) THE SYSTEM SHALL refuse, leave the card's status unchanged, and record nothing but the refusal.
- **EXT-7** WHEN an MCP client calls `sekhemet_move_card` with a `to` outside `ready`, `backlog`, `parked` THE SYSTEM SHALL answer an invalid-params error.

### NEW-extensibility-1 — board-lifecycle hooks
*Justification: a team calls its own tracker or CI on "accepted" or "PR opened" without forking; the hook engine covers only the Worker's lifecycle (review of domain 15, senior judgement 4).*
- **EXT-8** WHEN a card is accepted THE SYSTEM SHALL run each `card/accepted` hook once with the card id, the merge commit and the accepting person on stdin.
- **EXT-9** WHEN a `card/status_changed` hook exits 2 THE SYSTEM SHALL keep the transition and record the hook's stderr on the card.

### NEW-extensibility-2 — hooks that fail visibly
*Justification: load errors are discarded and a hook exiting early may crash the harness (review of domain 15, test quality).*
- **EXT-10** WHEN `hooks.toml` has an unknown event or invalid TOML THE SYSTEM SHALL name the file and the error in `doctor` and in the next card's evidence.
- **EXT-11** WHEN a hook exits before reading stdin THE SYSTEM SHALL continue, treating the exit code as usual.
- **EXT-12** WHEN a `pre-tool` hook exceeds `timeout_s` THE SYSTEM SHALL kill it and block the tool call with the reason "hook timed out".
- **EXT-13** WHEN both `~/.sekhemet/hooks.toml` and a trusted project file declare hooks for one event THE SYSTEM SHALL run the user's first, then the project's.

### NEW-extensibility-3 — MCP on the official SDK
*Justification: hand-rolled JSON-RPC three times, a fixed protocol version, stdio only, full environment, and a path built from an unchecked id (review of domain 15, senior judgement 3); the SDK is approved in DEC-08.*
- **EXT-14** WHEN a client offers a newer protocol version THE SYSTEM SHALL negotiate the highest version both support.
- **EXT-15** WHEN a malformed JSON-RPC request arrives THE SYSTEM SHALL answer a parse error with `id: null`.
- **EXT-16** WHEN `sekhemet_run_gates` receives a `card_id` that does not match the card-id pattern THE SYSTEM SHALL refuse it without touching the filesystem.
- **EXT-17** WHEN an MCP client asks for a card's evidence bundle or the model registry THE SYSTEM SHALL return it read-only.
- **EXT-18** WHEN the harness starts an MCP server THE SYSTEM SHALL pass it no variable outside the allowlist and its declared `env`.
- **EXT-19** WHEN `mcp.json` declares a Streamable HTTP server THE SYSTEM SHALL connect to it and list its tools (tested against a local test server).
- **EXT-20** WHEN the Planner plans a card and an approved MCP server offers tools THE SYSTEM SHALL offer those tools to the Planner, within the prompt budget.
- **EXT-21** WHEN a server does not list a tool in `worker_tools` THE SYSTEM SHALL not offer that tool to the Worker.

### NEW-extensibility-4 — skills in the Agent Skills format
*Justification: ecosystem skills fail to load (required inline `triggers`, regex YAML), substring triggers over-match, `budgetTokens` is parsed and never read, and diagnostics run on no data (reviews of domain 15 and the gap sweep).*
- **EXT-22** WHEN a skill has multi-line YAML front matter and no `triggers` THE SYSTEM SHALL load it and select it by its description.
- **EXT-23** WHEN a trigger is `ast` and the card title contains "last" but not the word "ast" THE SYSTEM SHALL not select the skill.
- **EXT-24** WHEN a user-level skill exists and no project skill has its name THE SYSTEM SHALL offer it on that project's cards.
- **EXT-25** WHEN a selected skill's body exceeds `budget_tokens` THE SYSTEM SHALL truncate it at a section boundary and record the truncation.
- **EXT-26** WHEN `doctor` runs on a repository with recorded outcomes THE SYSTEM SHALL report, per skill, its token cost, its trigger count over recent cards and its net gain.
- **EXT-27** WHEN a skill's scripts would write a gate file, the loop driver or sandbox configuration THE SYSTEM SHALL reject the skill at import.
- **EXT-27a** WHEN a skill or a distilled skill candidate has `evals/` THE SYSTEM SHALL run them confined with no network before asking for approval, and SHALL refuse approval while any fails.
- **EXT-27b** WHEN a distilled skill candidate has no `evals/` THE SYSTEM SHALL not offer it for approval.

### DEC-09 — cut the plugin loader
- **EXT-28** WHEN a repository contains `.sekhemet/plugins/` THE SYSTEM SHALL load nothing from it, and `doctor` SHALL say plugins are not supported.

## 6. v1 acceptance

EXT-1 to EXT-28 (including the lettered criteria), plus these built behaviours kept under test:
- **EXT-29** WHEN a `pre-tool` hook exits 2 THE SYSTEM SHALL block the tool call and tell the model the hook's stderr.
- **EXT-30** WHEN a `post-tool` hook throws THE SYSTEM SHALL continue the card and record the error.
- **EXT-31** WHEN a hook prints `{"message": "…"}` and exits 0 THE SYSTEM SHALL add that message to the next model turn.
- **EXT-32** WHEN a skill is not selected for a card THE SYSTEM SHALL include only its manifest line in the prompt.
- **EXT-33** WHEN an editor sends `session/prompt` over ACP THE SYSTEM SHALL stream Seshat's reply as `session/update` chunks.
- **EXT-34** WHEN an MCP client creates a card THE SYSTEM SHALL record the event with actor `mcp`.

## 7. Later

- **A plugin API** (tools, gates, sync adapters, UI panels), with signing and compatibility contracts once the kernel API is stable; a plugin marketplace.
- **Card-level editor protocol and an IDE extension or TUI** — open a card, stream its steps, approve or return it from the editor (SPINE: not in v1).
- **User-defined commands** as Markdown templates expanding into a card template or a planner instruction (`/onboard`, `/retro`, `/split`, `/bake-off`, `/goal`).
- **An MCP server over Streamable HTTP**, for a company server's remote clients.
- **An eval card for every shipped skill**, run by `doctor` (v1 runs the evals a skill has, EXT-27a; v1 does not yet require every skill to have one).
- **The skill catalogue**: pull and adapt Anthropic's official skills and Skill Creator patterns, Superpowers' workflow and test-first skills, gstack's review and QA checklists, and the Codex scope model; build Sekhemet's own for onboarding, research cards, gate authoring, SPIDR splitting, retrospective-to-playbook, bake-off, visual acceptance and repair from a typed failure; security-testing skills are review-only and never auto-remediate.

## 8. Open questions

1. **Publish the SDK or cut it?** Today its only consumer is its own test, which makes it dead by the rule. *Recommendation:* cut it now; rebuild it from the kernel's types when an integration needs it.
2. **DEC-09's premise for `container.ts` is wrong.** It was cut as "reachable only from a test", but `execute.ts:378-386` constructs `ServiceContainer` and `PluginManager` on every card through the kernel barrel. *Recommendation:* cut it anyway — plugins add only services and hooks, run repository code unconfined, and hooks plus MCP cover the need — and record the corrected reason in DEC-09.
3. **Should the Worker ever get MCP tools in v1?** *Recommendation:* no by default (EXT-21); the M2 A/B decides the Worker's tool set, and an MCP tool joins it only through `worker_tools`.

## 9. Evidence and rationale

- Review: [domains 12 and 15](../../reference/reviews/domain12_15_integrations_ext.md) — hooks sound; skills not in the ecosystem format; MCP client for the Researcher only; the probed MCP acceptance bypass; plugins cannot add tools; trust drift.
- [Gap sweep](../../reference/reviews/gap_sweep.md) — `diagnostics.ts` called with no inputs.
- Research, [PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md) batch 1: Repo-To-Skill (arXiv 2609.02749) — adapt only its verify stage as an admission rule (item 17a, EXT-27a/b); reject its AREX-Skill library (CC BY-NC-SA 4.0, frontier-only evidence, no ablations), its taxonomy-plus-router (a second retrieval subsystem) and hosted distillation (not local). SRMA (2609.02750) supplies the general rule that only an environment-grounded signal may admit durable memory.
- Research, [PM_RESEARCH_SYNTHESIS.md](../../research/PM_RESEARCH_SYNTHESIS.md) finding 6: verify before persisting skills (Voyager, −73% without self-verification); more skills can hurt ("Not All Skills Help") → items 16, 17a.
- Research, [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md): R6, on-the-fly tool synthesis, is `triaged`, so the Worker gets no self-made tools and MCP tools reach it only through `worker_tools` (item 23).
- Research: [group B](../../research/WEB_RESEARCH_2026-09.md#group-b-sandbox-and-git-safety) — Gemini CLI GHSA-wpqr-6v78-jr5g (a workspace's agent config trusted automatically in headless runs), the reason trust is never implicit.
- Decisions: [DEC-08](../DECISIONS.md#dec-08) (`@modelcontextprotocol/sdk`), [DEC-09](../DECISIONS.md#dec-09) (cuts).
- **Why hooks run outside the sandbox:** formatters, notifiers and compliance checks confined to one worktree are useless; that is exactly why a repository's hooks need the user's trust first.
