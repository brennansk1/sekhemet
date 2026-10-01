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
  - apps/harness/src/doctor.ts          # pluginsCheck: EXT-28; hooksCheck: EXT-10
  - apps/harness/src/board_hooks.ts
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
  - apps/harness/tests/cuts_b0.spec.ts  # EXT-28, EXT-28a
  - apps/harness/tests/hooks_visible.spec.ts
  - apps/harness/tests/board_hooks.spec.ts
  - packages/context/tests/skills_format.spec.ts
  - apps/harness/tests/skills_scopes.spec.ts
  - apps/harness/tests/skill_admission.spec.ts
  - apps/harness/tests/mcp_hardening.spec.ts
changes: [S9, S4, NEW-extensibility-1, NEW-extensibility-2, NEW-extensibility-3, NEW-extensibility-4, NEW-extensibility-5]
---

# Extensibility: hooks, skills, MCP, ACP, commands and headless use

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
| MCP server, ACP | started by the user | inside the harness, as actor `mcp` (MCP) or the PM chat (ACP) | — |
| ~~Plugins~~ — **cut in B0** ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O4, item 29) | nothing is loaded from `.sekhemet/plugins/` | — | — |

Workspace trust therefore gates exactly three things a repository can supply: project hooks, the project `mcp.json`, and skills (whose approval is by content hash).

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
6. **Result.** Exit 0 continues; a JSON object on stdout with `message` (or `inject: [...]`) adds text to the next model step. Exit 2 blocks the action and stderr is the reason the model is told. Any other exit, a crash, or a timeout: `pre-step`, `pre-tool` and `pre-gate` fail **closed** (a broken guard must not become a silent allow); every other event fails open and records the error.
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
15a. **A skill is project data, not a harness change.** A project or user skill is listed on every pack that loads it but lies outside the context version, so approving, revoking or changing one never invalidates a model's qualification and never needs a frozen-suite A/B ([DEC-28](../DECISIONS.md#dec-28--one-rule-for-admitting-what-the-system-learns); confirmation review N1). A skill Sekhemet itself ships is part of the harness and is admitted by DEC-28's harness-change row.
16. **Diagnostics.** `sekhemet doctor` reports, per skill and playbook rule: its token cost against the stable-zone budget, whether it triggered on recent cards, and its measured net gain (pass rate with it minus without, from recorded outcomes). A skill that costs context and shows no gain is proposed for removal; it is never removed automatically.
17. **Sourcing.** Skills are procedure, not capability. Aggregators and marketplaces are for discovery only; a pulled skill is pinned by commit hash, read before approval, and diffed on update.
17a. **Verify before admitting.** A skill with an `evals/` directory — and every skill candidate the harness distils from trajectories (`.sekhemet/skill-candidates/`) — has its evals run in the sandbox with no network before a person is asked to approve it; the approval prompt shows the result, and a skill whose evals fail cannot be approved. The admission record keeps the evidence, the checks run and the gaps left open. This is one instance of the rule that nothing durable is admitted unless a signal measured outside the generated text improves ([measurement](measurement.md) owns the rule; more skills can hurt, so gain is measured, item 16).

### MCP server

18. `sekhemet mcp` serves the board to MCP clients (editors, other agents, CI) over stdio: list, get, create and update cards (team fields only), move a card among `ready`, `backlog` and `parked`, run gates, ask Seshat and read the PM thread, the capability report, learning rules, events and `doctor`; plus the evidence bundle and the model registry, read-only (NEW-extensibility-3). Tool names use the product's vocabulary ([NAMING.md](../NAMING.md)): the PM tool is `sekhemet_ask_seshat` (`sekhemet_ask_merit` until B3.3, the persona's name before 2026-09-18).
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

### Headless use

27. Everything the board can do is available headless from the CLI with meaningful exit codes ([surface](surface.md)): run one card unattended, plan without executing, run gates only, bake off models, replay a card against a pinned configuration. Programs drive a running server through the MCP server (items 18–21) or the HTTP API and live stream ([runtime](runtime.md)).
28. **There is no SDK package in v1.** `@sekhemet/sdk` is cut in B0 ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O4, NEW-extensibility-5): its only consumer was its own test, and its types were copies of the kernel's. *Changed from the old design's shipped SDK.* An SDK returns only when an integration needs one, built from the kernel's types (§7).

### Plugins

29. **Plugins are cut in B0** ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O4; [DEC-09](../DECISIONS.md#dec-09); NEW-extensibility-5). Today the loader mounts `.sekhemet/plugins/*/index.mjs` on each card's `ServiceContainer` inside the harness process, unconfined and unprompted (`execute.ts:378-388`, `packages/kernel/src/container.ts`). B0 removes `container.ts`, the `ServiceContainer` and `PluginManager` construction in `execute.ts` and their kernel-barrel exports; after it, nothing is loaded from `.sekhemet/plugins/`, and `doctor` says plugins are not supported and that hooks and MCP servers do the same jobs (EXT-28). A plugin could only add services and hooks — never the tools, gates, sync adapters or UI panels the old design promised — and hooks plus MCP cover that need under workspace trust. Because the cut lands in B0, before workspace trust (S9) is built, plugins never need a trust gate. `.sekhemet/plugins/` stays on the Worker's protected list (item 9), so a repository cannot stage a plugin for a later version.

### Tools outside the Worker

Decisions on what the Planner and the infrastructure use, adopt or build; the owning spec states each one's behaviour and state. The Worker's tools are in [worker-loop](worker-loop.md); the gates' tools are listed with their gates in [gates](gates.md), which owns the per-language gate template table (ruling R14): the parse check through the TypeScript compiler ([DEC-20](../DECISIONS.md#dec-20); tree-sitter for other languages later); tsc, ruff, clippy, eslint; per-language test runners with a parser to `GateFailure`; mutation through each language's own tool (Stryker, mutmut, cargo-mutants, PIT) as an optional subprocess when installed, beside the harness's own diff-scoped TypeScript step; gitleaks; registry existence and typosquat checks; osv-scanner offline; Semgrep CE; the visual gate's console, network, DOM-assertion and layout checks, element screenshot diff and accessibility checks — built on the harness's own headless-Chromium client (Playwright and axe-core are approved as development dependencies by DEC-29 O5; axe-core inside the product gate is owner decision O27; pixelmatch is not used — DEC-25 R16); a local vision checklist at temperature 0; hygiene checks.

| Tool | Decision | Owner |
| --- | --- | --- |
| Repo map query | Build (TypeScript compiler facts, PageRank, binary-search budget fit; reference Aider; tree-sitter for other languages later, DEC-20) | [context](context.md) |
| Dependency and impact analysis | Build over language-server references | [planner-pm](planner-pm.md) |
| Task decomposition | Build; Taskmaster's patterns as reference, no code (Commons Clause) | [planner-pm](planner-pm.md) |
| Difficulty scoring | Build from scope, symbols, tests and history | [planner-pm](planner-pm.md) |
| Search and fetch (SearXNG, trafilatura, Crawl4AI) | Wrap; research cards and the Research Desk only, **never the Worker** | [design-stage](design-stage.md) |
| `plan_research` | Owned and decided by design-stage (ruling R5) | [design-stage](design-stage.md) |
| Board operations (create, split, link, budget) | Build | [planner-pm](planner-pm.md) |
| Inference | Wrap llama.cpp server; MLX as a later Apple Silicon adapter | [models](models.md) |
| Model swapping | Build a minimal router rather than llama-swap | [models](models.md) |
| Constrained decoding | XGrammar or llguidance behind the tool-arm interface, a per-model measured choice ([DEC-22](../DECISIONS.md#dec-22--rejected-techniques)) | [models](models.md) |
| Sandbox, worktrees | Build over Seatbelt, bubblewrap and git | [security](security.md), [review-git](review-git.md) |
| Notifications | Wrap self-hosted ntfy or Gotify | [integrations](integrations.md) |
| Structural diff | Wrap difftastic | [review-git](review-git.md) |
| Event log and hash chain | Build over SQLite WAL | [kernel](kernel.md) |
| Output condensing | RTK's strategies reimplemented natively for command output (the RTK binary is not called); native condensers for read, grep, glob | [context](context.md) |
| Goal monitoring | Build: event-log queries with thresholds | [planner-pm](planner-pm.md) |

## 3. Contract

| Item | Source |
| --- | --- |
| `LifecycleHookEvent`, `LifecycleHookEngine`, `HookHandler`, `HookMessage`, `DEFAULT_FAIL_CLOSED_EVENTS` | `packages/kernel/src/hooks.ts` |
| `hooks.toml` schema, `loadUserHooks`, `hookEngineFor` | `apps/harness/src/user_hooks.ts` |
| `SkillManifest`, `SkillsRegistry`, the skills lock (in the user directory, `skillsLockPath`) | `packages/context/src/skills.ts` |
| `playbookDiagnostics` | `packages/eval/src/diagnostics.ts` |
| MCP tools `sekhemet_*` | `apps/harness/src/mcp.ts:60-270` |
| `McpServerConfig`, `loadMcpConfig`, `McpHub` | `apps/harness/src/mcp_client.ts` |
| ACP (`ACP_PROTOCOL_VERSION = 1`) | `apps/harness/src/acp.ts` |
| Slash commands | `apps/harness/src/pm/slash.ts:71-130` |
| `@sekhemet/sdk`; `ServiceContainer`, `PluginManager` — **cut in B0** (NEW-extensibility-5): no package, no export, nothing loaded from `.sekhemet/plugins/` | `doctor` warns on a plugins directory: `pluginsCheck` in `apps/harness/src/doctor.ts` |
| CLI: `sekhemet mcp`, `sekhemet acp`, `sekhemet dev skills [list] \| approve \| revoke` | `index.ts`, `wave2.ts:756` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Hook engine, ten events, fail-closed `pre-*` | built | `hooks.ts:12-38`; `hooks.spec.ts`; emitted at `session.ts` 1093/1175/1351/1390/1596/1622, `card_runner.ts` 845/1501 | — |
| `hooks.toml`: block, inject, env, stdin | built | `user_hooks.spec.ts` (3 tests) | — |
| Hook load errors, stdin EPIPE, timeout | built (B3.3; raised in C1: every criterion of NEW-extensibility-2 has its test) | `doctor` names each file and error (`hooksCheck`, from `hookEngineFor().errors`, EXT-10); an early-exiting hook's EPIPE is absorbed (EXT-11); a gating hook past `timeout_s` is killed and blocks with "hook timed out" (EXT-12); `hooks_visible.spec.ts`. and on the next card's evidence: `execute.ts` passes `hookEngineFor().errors` to the runner, which records them as `extensions.hookErrors` (`extension_evidence.spec.ts` EXT-10) | NEW-extensibility-2 |
| User-level hooks | built | the person's `hooks.toml` in the user directory, registered before the project's (`loadPersonHooks`, `hookEngineFor`); `hooks_visible.spec.ts` (EXT-13) | NEW-extensibility-2 |
| Board-lifecycle hook events | built | `card/status_changed`, `card/accepted`, `pr/opened` (kernel `LifecycleHookEvent`); `watchBoardHooks` (`board_hooks.ts`) runs each hook once per committed ledger event, from every kernel the CLI and server open (`initLocalKernel`); observe only, an exit 2 or failure recorded as a dossier note; `board_hooks.spec.ts` (EXT-8, EXT-9) | NEW-extensibility-1 |
| Repo hooks, `mcp.json` load only once trusted | built (B3.3; raised in C1) | a project's `.sekhemet/hooks.toml` loads nothing until the person trusts that exact file (`user_hooks.ts:82-85`, `untrusted: true`), and a project's `.sekhemet/mcp.json` starts no server until trusted (`mcp_client.ts:63-66`); trust is by the repository's real path and each file's SHA-256, kept in the user directory ([security](security.md) row *Workspace trust*; `workspace_trust.spec.ts` *SEC-28: a repository opened for the first time runs none of its hooks, MCP servers or skill scripts*, SEC-29 to SEC-31) | S9 |
| Extension files protected from the Worker | not-built | `PROTECTED_SYSTEM_PATTERNS` (`sandbox/src/permissions.ts:43-53`) covers `gates.toml`, `config.toml`, `.sekhemet/(events.db\|checkpoints\|artifacts)`, `.githooks/`, `.git` and the loop, gates and sandbox sources, but not `.sekhemet/hooks.toml`, `.sekhemet/mcp.json` or `.sekhemet/skills/` (EXT-5a has no test; re-checked C1). Workspace trust limits the harm: a file the Worker changes has a new SHA-256 and is inert until trusted again (SEC-29), but the write itself is allowed and reaches Review | S9 |
| Skills: SHA-256 pin, approve/revoke, audit | partial | built: every skill pinned by its SKILL.md's SHA-256, a new or changed one rejected until approved, every decision in the lock's audit trail (`skills.ts:172-200`, `loadFromDirectory`); approve and revoke (`approveSkill`, `revokeSkill`, `sekhemet dev skills`); the lock moved to the user directory, so one the repository ships is never read (`skillsLockPath`, `workspace_trust.ts:282-299`; `workspace_trust.spec.ts` SEC-31). Not yet: trust on first use is still the default — `loadRepoSkills` passes no `trustOnFirstUse: false`, so with no lock yet a repository's skills are pinned and loaded on the first load, against EXT-4 (re-checked C1) | S9 |
| Skills format: regex front matter, required inline `triggers`, substring match, project scope only, `budgetTokens` unread, required `tools` unread, `scripts/`, `references/`, `evals/` ignored | partial | built: front matter in the Agent Skills subset (`parseFrontMatter`: block scalars, lists, maps), selection by description when no triggers, whole-word triggers, `tools` checked against the tools the card is offered (the skill left out, `omitted()`), `budget_tokens` cut at a section boundary (`truncated`), user then project scope (`loadRepoSkills`); `skills_format.spec.ts`, `skills_scopes.spec.ts` (EXT-22, -22a, -23, -24, -25). The omission and the truncation are on the card's evidence as `extensions.skillsOmitted` and `extensions.skillsTruncated` (the session collects them from each prompt, the runner writes them; `extension_evidence.spec.ts`). Not yet: `references/` on demand. The front-matter reader is a subset, not a YAML library (a `yaml` package would need the owner's yes) | NEW-extensibility-4 |
| Skill diagnostics | built (skills); partial (rules) | `doctor`'s "Playbook and skills" check reports, per skill, its token cost, the recent finished cards it triggers on and its net gain (`skillDiagnostics` in eval `diagnostics.ts`; outcomes from the ledger's cards that ran and finished, `recentCardOutcomes` in `wave2.ts`; `skill_doctor.spec.ts`, EXT-26); triggers use the prompt's own selection (whole words), so "never triggered" agrees with it. The ledger does not record which skills a card's prompt carried, so the gain is over the cards today's skills would select. Rules' net gain still gets no outcomes | NEW-extensibility-4 |
| Skill evals run before approval | built | `sekhemet dev skills approve` runs a skill's `evals/checks.json` confined (`checkSkillCandidate`, a person's skill kept on failure) and refuses while one fails (EXT-27a); a distilled candidate's checks run confined when distilled and one with none stays "unchecked" and cannot be approved (MS-T8-5, EXT-27b); a skill whose `scripts/` name a gate file, the loop driver or sandbox configuration is rejected before anything runs (`skillProtectedWrites`, EXT-27); `skill_admission.spec.ts` | NEW-extensibility-4 |
| MCP server tools | built | `mcp.ts`; `mcp.spec.ts` (10 tests, happy paths) | — |
| MCP `move_card` override to Done | built (fix round F3) | Two layers. The server checks `to` itself before the board is asked: anything but `ready`, `backlog` or `parked` — `done`, with or without an `override:` reason, another column, a non-string, none — is a JSON-RPC invalid-params error (-32602) that says in words where a card may go and that accepting is a person's decision on the board, with the card unchanged (`MOVE_CARD_TO`, `sekhemet_move_card` in `mcp.ts`; an `McpError` a handler throws is answered as an error, not as a tool result). The refusal, and nothing else, is recorded — one `mcp/refused` (actor `mcp`: the tool, the column asked for if it is a board column, else `other`, and the card when it exists; never the reason text), so an attempted bypass to Done leaves an audit trace (fix round F3 review: the first fix appended nothing and read EXT-6's "nothing but the refusal" as "nothing"). Behind it, the board the MCP server is given (`initLocalKernel`, entry conditions on) refuses the actor `mcp` Done on its own: only a person accepts (rule 24) and only a named person overrides (rule 28, K-S4-5). `mcp_hardening.spec.ts` (EXT-6, EXT-7, a real SQLite ledger, a card moved into Review by the transition law; the board layer on the kernel `initLocalKernel` opens, as `sekhemet mcp` does, not a board built in the test). The row's earlier "bypass open" was half stale: the production board already refused Done (rule 24's accepting actors), but the tool trusted `to`, so a client could ask for a column outside the three, which the board then judged only by the transition law and its entry conditions — and a board built without entry conditions moved a Review card to Done (probed before the fix: *Moved c_rev to done*) | S4 |
| MCP server: protocol `2024-11-05` fixed, `id: 0` on parse error, unchecked `card_id` path, no evidence/registry tools, PM tool still named `sekhemet_ask_merit`, hand-rolled JSON-RPC | built | on the official SDK's `Server` (`createMcpServer` in `mcp.ts`, item 21): the SDK frames, validates and answers `ping`; the harness supplies the tools and one override, the initialize handler, so a version outside `MCP_PROTOCOL_VERSIONS` gets this server's newest (EXT-14). stdio is the SDK's `StdioServerTransport` inside `ParseErrorStdioServerTransport`, which answers a line the SDK drops with `id: null` — -32700 for non-JSON (EXT-15), -32600 for JSON that is not JSON-RPC — and otherwise delegates; `handleMcpRequest` runs one message through the same server over the SDK's in-memory transport (an `initialize` missing client capabilities or info gets empty ones). `card_id` checked before any path, `sekhemet_get_evidence` (ledger-verified) and `sekhemet_model_registry` read-only, `sekhemet_ask_seshat`; `mcp_hardening.spec.ts` (EXT-14 to -17, -21a), `mcp_sdk_server.spec.ts` (an SDK client's handshake and tool call; the wrapper's parse errors) | NEW-extensibility-3 |
| MCP client: stdio only, full env, Researcher only | partial | on the official SDK's `Client` (`mcp_client.ts`): stdio with the sandbox's allowlist plus the server's declared `env` (`allowlistedEnv`; `mcp_hardening.spec.ts`, EXT-18), and Streamable HTTP for a server declared with `url` (`mcp_transports.spec.ts`, against a local SDK server, EXT-19); tools per role, the Worker only a server's `worker_tools` and a call outside them refused (`toolDefinitions(role)`, `call(..., role)`, EXT-21); the Planner offered them while it sketches a card, within `PLANNER_TOOL_BUDGET_TOKENS` (`plannerToolsOf`, `sketchWithModel` `tools`, `plannerToolsWithinBudget`; `planner_tools.spec.ts`, `mcp_transports.spec.ts`; `sekhemet plan` connects the servers, EXT-20). Not yet: the OAuth transport, Seshat's tools, the registry's permission for Worker tools and a Worker that is offered any (item 23), per-call ledger records (item 24) | NEW-extensibility-3 |
| ACP as PM chat | built | `acp.ts`; `acp.spec.ts` | — |
| Slash commands | built | `slash.ts`; `slash.spec.ts`. A command's move goes through the harness's own board — its Review limit, evidence reader and entry conditions — by every door: `board` is required of `runSlash`, of Seshat's service (`AnswerDeps`), of `sekhemet ask` and of the editor (ACP), and the dashboard, the queue, `ask` and `acp` pass the board their kernel opened; nothing builds a board of its own (fix round F3: until then Seshat's service called `runSlash` without it, and `/ready` built one). `slash_board.spec.ts`: from the dashboard's composer, `sekhemet ask` and ACP, `/ready` reaches the given board, and that board's refusal (a full Ready column) is what the person reads, the card unmoved | — |
| SDK package cut | built (B0) | no `@sekhemet/sdk` in the workspace or `tsconfig.json` (`cuts_b0.spec.ts`) | NEW-extensibility-5 |
| Plugin container and loader cut; `doctor` names hooks and MCP instead | built (B0) | no `ServiceContainer`/`PluginManager` export or import; only `doctor.ts` reads `.sekhemet/plugins/` (`cuts_b0.spec.ts`, EXT-28, EXT-28a) | NEW-extensibility-5 |

## 5. Changes for v1

### S9 — what workspace trust gates (hooks, `mcp.json`, skills)
- **EXT-1** WHEN an untrusted project `hooks.toml` declares a `pre-tool` hook THE SYSTEM SHALL not run it, and the card SHALL proceed as if no project hook existed, with a note in its evidence.
- **EXT-2** WHEN an untrusted project `mcp.json` declares a server THE SYSTEM SHALL not start it.
- **EXT-3** WHEN a skill's content changes after approval THE SYSTEM SHALL not load it until it is approved again.
- **EXT-4** WHEN a repository has skills and no user-side approval THE SYSTEM SHALL load none of their bodies.
- **EXT-5** WHEN a skill's `scripts/` file runs THE SYSTEM SHALL run it inside the card's sandbox.
- **EXT-5a** WHEN the Worker writes `.sekhemet/hooks.toml`, `.sekhemet/mcp.json` or a file under `.sekhemet/skills/` or `.sekhemet/plugins/` in its worktree THE SYSTEM SHALL deny the write with rule `protected_system`.
- **EXT-5b** *(withdrawn 2026-09-24: it held only while O4 was open; the owner cut plugins ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O4), and EXT-28 — no plugin mounts in any workspace, trusted or not — replaces it. The number is not reused.)*

### S4 — MCP cannot accept
- **EXT-6** WHEN an MCP client calls `sekhemet_move_card` with `to: "done"` (with or without a reason beginning `override:`) THE SYSTEM SHALL refuse, leave the card's status unchanged, and record nothing but the refusal: one `mcp/refused` event (actor `mcp`) naming the tool, the column asked for and the card when it exists, and never the client's reason text.
- **EXT-7** WHEN an MCP client calls `sekhemet_move_card` with a `to` outside `ready`, `backlog`, `parked` THE SYSTEM SHALL answer an invalid-params error.

### NEW-extensibility-5 — cut the plugin container and the SDK (B0)
*Justification: the owner cut both ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O4). The plugin loader runs repository code inside the harness process, unconfined and unprompted, on every card; the SDK's only consumer is its own test. Hooks and MCP cover what either offered.*
- **EXT-28** WHEN a repository contains `.sekhemet/plugins/` THE SYSTEM SHALL load nothing from it, and `doctor` SHALL say plugins are not supported and name hooks and MCP servers as the supported routes.
- **EXT-28a** WHEN the test suite enumerates the workspace's packages and the kernel barrel's exports THE SYSTEM SHALL find no `@sekhemet/sdk` package and no `ServiceContainer` or `PluginManager` export, and no module SHALL import either.

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
- **EXT-21a** WHEN an MCP client lists the server's tools THE SYSTEM SHALL offer the PM tool as `sekhemet_ask_seshat` and no tool named after Merit.

### NEW-extensibility-4 — skills in the Agent Skills format
*Justification: ecosystem skills fail to load (required inline `triggers`, regex YAML), substring triggers over-match, `budgetTokens` is parsed and never read, and diagnostics run on no data (reviews of domain 15 and the gap sweep).*
- **EXT-22** WHEN a skill has multi-line YAML front matter and no `triggers` THE SYSTEM SHALL load it and select it by its description.
- **EXT-22a** WHEN a skill declares `tools` that the card's class set does not include THE SYSTEM SHALL leave the skill's manifest line and body out of that card's prompt, and record the omission in the card's evidence.
- **EXT-23** WHEN a trigger is `ast` and the card title contains "last" but not the word "ast" THE SYSTEM SHALL not select the skill.
- **EXT-24** WHEN a user-level skill exists and no project skill has its name THE SYSTEM SHALL offer it on that project's cards.
- **EXT-25** WHEN a selected skill's body exceeds `budget_tokens` THE SYSTEM SHALL truncate it at a section boundary and record the truncation.
- **EXT-26** WHEN `doctor` runs on a repository with recorded outcomes THE SYSTEM SHALL report, per skill, its token cost, its trigger count over recent cards and its net gain.
- **EXT-27** WHEN a skill's scripts would write a gate file, the loop driver or sandbox configuration THE SYSTEM SHALL reject the skill at import.
- **EXT-27a** WHEN a skill or a distilled skill candidate has `evals/` THE SYSTEM SHALL run them confined with no network before asking for approval, and SHALL refuse approval while any fails.
- **EXT-27b** WHEN a distilled skill candidate has no `evals/` THE SYSTEM SHALL not offer it for approval.

## 6. v1 acceptance

EXT-1 to EXT-28a (including the lettered criteria; EXT-5b is withdrawn; EXT-28 and EXT-28a land in B0), plus these built behaviours kept under test:
- **EXT-29** WHEN a `pre-tool` hook exits 2 THE SYSTEM SHALL block the tool call and tell the model the hook's stderr.
- **EXT-30** WHEN a `post-tool` hook throws THE SYSTEM SHALL continue the card and record the error.
- **EXT-31** WHEN a hook prints `{"message": "…"}` and exits 0 THE SYSTEM SHALL add that message to the next model step.
- **EXT-32** WHEN a skill is not selected for a card THE SYSTEM SHALL include only its manifest line in the prompt.
- **EXT-33** WHEN an editor sends `session/prompt` over ACP THE SYSTEM SHALL stream Seshat's reply as `session/update` chunks.
- **EXT-34** WHEN an MCP client creates a card THE SYSTEM SHALL record the event with actor `mcp`.

## 7. Later

- **A plugin API** (tools, gates, sync adapters, UI panels), with signing and compatibility contracts once the kernel API is stable; a plugin marketplace. v1 has no plugins at all (item 29); a plugin API would be designed fresh, not grown from the cut `container.ts`.
- **An SDK** (`@sekhemet/sdk`): a typed client for a running server, REST calls and the live event stream as an async iterator, built from the kernel's types rather than copies — only when an integration needs one (item 28).
- **Card-level editor protocol and an IDE extension or TUI** — open a card, stream its steps, approve or return it from the editor (SPINE: not in v1).
- **User-defined commands** as Markdown templates expanding into a card template or a planner instruction, invoked from the board or the CLI (`/onboard`, `/retro`, `/split`, `/bake-off`, `/goal`; the old list's `/research` is already a built-in, item 26). v1's commands are item 26's fixed set, which shares one implementation with the board's buttons and the CLI; a template language would be a second path beside it, so it waits until a person needs a command the fixed set lacks.
- **An MCP server over Streamable HTTP**, for remote clients of a server in the Team setup.
- **An eval card for every shipped skill**, run by `doctor` (v1 runs the evals a skill has, EXT-27a; v1 does not yet require every skill to have one).
- **A skill that declares the gates it adds** (the old design) — v1 skills are procedure only; a gate a skill needs is proposed to `gates.toml` for a person to accept, because a skill may never change gate files (item 15).
- **Publishing skills back to the Agent Skills ecosystem** — v1 pulls and pins; publishing needs a release and licence process for Sekhemet's own skills, which do not exist yet.
- **The Codex admin and system skill scopes** — v1 has project and user scopes only (item 13); an admin scope would follow the Team setup's Admin level ([DEC-35](../DECISIONS.md#dec-35--one-product-two-setups-solo-and-team)), which v1 does not extend to skills.
- **Third-party skill signing** beyond the content-hash approval of item 15, and plugin signing with the plugin API above; air-gapped skill updates already travel signed ([security](security.md) item 49).
- **The skill catalogue** — sources: Anthropic's official skills (Skill Creator, document skills, frontend design, the format and template), Superpowers (workflow and test-first discipline), the Codex catalogue (its scope model), gstack (review and QA checklists); aggregators for discovery only (item 17). Later because v1 ships the skill mechanism (items 10–17) but no catalogue: every pulled skill must be read, pinned and approved by a person (item 15) and should carry an eval (EXT-27a), and no catalogue skill has been through that yet. What each becomes in Sekhemet, kept so the mapping is not re-derived:

| Skill | Decision | What it becomes |
| --- | --- | --- |
| Brainstorming and spec refinement | Pull and adapt | Feeds the intake conversation; its questions become decision requests |
| Write plan, execute plan | Adapt | The planner replaces the execute half; the planning discipline stays |
| Test-driven implementation | Adapt | Enforced by gates, not instruction; teaches red-green-refactor |
| Systematic debugging | Pull | Reproduce, isolate, hypothesise, test — inside one card |
| Code review checklist | Adapt | The Reviewer's procedure and the evidence summary's format |
| Git worktree workflow | Replace | Built into the harness |
| Frontend design guidance | Pull | For Sekhemet's own UI and user projects with a UI |
| Skill Creator | Adapt | The authoring template for distilled skill candidates |
| Document skills (docx, pdf, xlsx) | Pull, optional | For projects that produce documents; not core |
| Language and framework experts | Selective pull | Only where a gate template exists for the language |
| Security testing procedures | Selective pull | Review-only; never auto-remediate |
| Repository onboarding | Build | No existing skill handles gate detection and convention extraction |
| Research card procedure | Build | Tiered lookup, citation format, budget |
| Gate authoring | Build | How to write acceptance tests the Worker cannot game |
| Card splitting (SPIDR) | Build | Encodes the decomposition rules |
| Retrospective to playbook | Build | Failure pattern to playbook entry |
| Model bake-off | Build | Runs the eval and writes the matrix |
| Visual acceptance | Build | From a mock or screenshot to a checklist of atomic checks |
| Repair from a typed failure | Build | Per gate type, a concrete repair procedure for the Worker |

## 8. Open questions

1. **Publish the SDK or cut it?** *Decided 2026-09-24 ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O4): cut in B0* (item 28, NEW-extensibility-5); rebuilt from the kernel's types only when an integration needs it (§7).
2. **Cut the plugin container?** *Decided 2026-09-24 (DEC-29 O4): cut in B0* (item 29, EXT-28, EXT-28a). DEC-09's first reason ("reachable only from a test") was wrong — `execute.ts:378-388` constructs `ServiceContainer` and `PluginManager` on every card — and DEC-09 now records the owner's decision instead.
3. **Should the Worker ever get MCP tools in v1?** *Recommendation:* no by default (EXT-21); the M2 A/B decides the Worker's tool set, and an MCP tool joins it only through `worker_tools`.

## 9. Evidence and rationale

- Review: [domains 12 and 15](../../reference/reviews/domain12_15_integrations_ext.md) — hooks sound; skills not in the ecosystem format; MCP client for the Researcher only; the probed MCP acceptance bypass; plugins cannot add tools; trust drift.
- [Gap sweep](../../reference/reviews/gap_sweep.md) — `diagnostics.ts` called with no inputs.
- Research, [PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md) batch 1: Repo-To-Skill (arXiv 2609.02749) — adapt only its verify stage as an admission rule (item 17a, EXT-27a/b); reject its AREX-Skill library (CC BY-NC-SA 4.0, frontier-only evidence, no ablations), its taxonomy-plus-router (a second retrieval subsystem) and hosted distillation (not local). SRMA (2609.02750) supplies the general rule that only an environment-grounded signal may admit durable memory.
- Research, [PM_RESEARCH_SYNTHESIS.md](../../research/PM_RESEARCH_SYNTHESIS.md) finding 6: verify before persisting skills (Voyager, −73% without self-verification); more skills can hurt ("Not All Skills Help") → items 16, 17a.
- Rulings of 2026-09-22: R5 (`plan_research` is design-stage's), R14 and R16 (the gate-tool list above), R3 (MLX is a later adapter everywhere).
- Research, [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md): R6, on-the-fly tool synthesis, is `triaged`, so the Worker gets no self-made tools and MCP tools reach it only through `worker_tools` (item 23).
- Research: [group B](../../research/WEB_RESEARCH_2026-09.md#group-b-sandbox-and-git-safety) — Gemini CLI GHSA-wpqr-6v78-jr5g (a workspace's agent config trusted automatically in headless runs), the reason trust is never implicit.
- Decisions: [DEC-08](../DECISIONS.md#dec-08) (`@modelcontextprotocol/sdk`), [DEC-09](../DECISIONS.md#dec-09) (cuts), [DEC-28](../DECISIONS.md#dec-28--one-rule-for-admitting-what-the-system-learns) (skills are project data, outside the context version), [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O4 (plugins and the SDK cut in B0).
- **Why hooks run outside the sandbox:** formatters, notifiers and compliance checks confined to one worktree are useless; that is exactly why a repository's hooks need the user's trust first.
