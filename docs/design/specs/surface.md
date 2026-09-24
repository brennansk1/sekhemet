---
spec: surface
status: partial
audiences: [developer, beginner, non-developer]
code:
  - apps/harness/src/front_door.ts
  - apps/harness/src/index.ts
  - apps/harness/src/init.ts
  - apps/harness/src/onboard.ts
  - apps/harness/src/doctor.ts
  - apps/harness/src/config.ts
  - apps/harness/src/config_apply.ts
  - apps/harness/src/triage.ts
  - apps/harness/src/attachments.ts
  - packages/gates/src/templates.ts
tests:
  - apps/harness/tests/front_door.spec.ts
  - apps/harness/tests/triage_cli.spec.ts
  - apps/harness/tests/init.spec.ts
  - apps/harness/tests/onboard.spec.ts
  - apps/harness/tests/config_apply.spec.ts
  - apps/harness/tests/doctor_weights.spec.ts
  - apps/harness/tests/attachments.spec.ts
  - apps/harness/tests/cli_gate.spec.ts
  - apps/harness/tests/cli_kernel.spec.ts
  - apps/harness/tests/docs.spec.ts
changes: [P10, S10, T4, T10, NEW-surface-1, NEW-surface-2, NEW-surface-3, NEW-surface-4, NEW-surface-5, NEW-surface-6, NEW-models-3]   # NEW-models-3: the reserve and release commands only (item 20a)
---

# Surface: the command line, the first run, configuration, and onboarding a repository

## 1. Purpose

The surface is what a person meets before the board: one command that sets Sekhemet up in their repository, a handful of verbs, and a configuration they rarely need to open. The simplicity bar is Claude Code's — one command, a conversation, a permission prompt when something risky happens, and a project file most people never open — even though Sekhemet also holds a board, runs gates, produces evidence and chooses its own models. It serves all three audiences: developers adopt it in minutes, beginners are never shown a decision they cannot make yet, and non-developers are handed to the dashboard and Seshat rather than left at a prompt.

## 2. Behaviour

### What a person must know on day one

1. Six concepts, and no more: **card** (the unit of work and of review), **accept / send back** (the human decision is the product), **gates** (what "passed" means — seen from day one, derived rather than written), **evidence** (the diff and gate results review reads), **the models** (one line naming the models in use and whether their weights are present), and **the repository** (the working directory).
2. Every other command, flag, config key, view and word carries exactly one verdict, stated where it is specified:
   - **Day one** — one of the six.
   - **Default** — the mechanism stays, the decision goes; if the harness can compute a better answer than the person can supply, it does not ask.
   - **Progressive** — met only when something makes it relevant, with the trigger named; a view with nothing in it is hidden, not empty.
   - **Developer** — for whoever builds the harness (benchmarks, qualification, bake-offs, fixtures, provenance, telemetry export): under `sekhemet dev`, absent from user help.
3. **A wrong default fails loudly.** A gate derived from the wrong script stops the run and names the file to edit; a silently wrong default is worse than a question.
4. **A config key that is parsed is read.** A key with no reader is deleted from the schema, not documented.

### The first run: one path for everyone

5. `sekhemet` with no arguments, in a repository, is the product. On first run — no `.sekhemet/config.toml` — it:
   1. checks the machine (memory, chip) and the toolchain (Node.js and git; the Node.js floor is item 5a), naming the fix for anything missing;
   2. resolves the roster once from the model registry for this machine's tier — Worker, Planner (Seshat runs on it), Reviewer, Researcher — and says which weights are present, how much a download would be, and that the Configuration page (item 5b) finds weights the person already has;
   3. derives the gates with **one deriver** from the project's own scripts and CI: the package manager from the lockfile or the `packageManager` field (npm when neither says), a typecheck gate when TypeScript is a dependency, the project's lint and test scripts, CI steps including multi-line `run: |` blocks, and the protected test globs;
   4. treats an existing team repository as onboarding (items 9–12);
   5. prints one paragraph — the machine, the models, the gates, how to ask for work — and asks **one confirmation**;
   6. on confirmation writes `.sekhemet/config.toml`, `.sekhemet/gates.toml` and one marked `.gitignore` block, then serves the board and opens it in a browser — on the Configuration page instead when no model is set up (item 5b). The block ignores `.sekhemet/` **by default** and re-includes only the files a team shares — `config.toml`, `gates.toml`, `hooks.toml`, `mcp.json`, `skills/` and `playbook.toml` — so that evidence bundles, transcripts, artifacts, research pages, observations, live token files, tuning data, traces, runs, blobs, the ledger and its WAL, the daemon files, the gate host's keys and `queue_report.json` are never committable, including any state directory added later ([security](security.md) item 34a). A person who wants another file tracked edits the block; the first run never removes a line a person wrote.
5a. **Node.js 22.13 or newer** is required, and this is the one place the floor is stated. The ledger is `node:sqlite`, which arrived in Node.js 22.5 behind `--experimental-sqlite` and runs without a flag from 22.13; the harness passes no flag (`apps/harness/src/index.ts:1`), so 22.5–22.12 cannot open the ledger. *Changed from the code:* the first-run check accepts any 22.x (`init.ts:61-64`, `nodeMajor >= 22`); other documents that give another floor point here (P10, SUR-46).
5b. **No models, no dead end.** When no model is set up — no role's weights are found in any model folder the harness knows (`SEKHEMET_MODELS_DIR`, `--models-dir`, or folders named on the page) — `sekhemet` opens the dashboard on the **Configuration page** ([dashboard](dashboard.md) NEW-dashboard-6; [models](models.md) NEW-models-12) instead of the board, on the first run and on every later run until a model is set up. There a person points the harness at the folders where their models live, sees each model found and the recommended model per role with its reason, and may download a recommended model explicitly, hash-verified ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O2; [security](security.md) item 47). Nothing is downloaded before that explicit choice. Under `--yes` or without a browser the first run prints the Configuration page's address instead of the board's.
6. It makes no network request unless `[network] mode` allows one (offline is the default), and it never runs repository code before the person trusts the repository ([security](security.md) S9). Research asks for the network once, when the person first plans a new project, not during setup ([design-stage](design-stage.md) S8; [security](security.md) item 29a; the default of owner decision [O16](../../reference/OPEN_QUESTIONS.md#owner-decisions), pending).
7. `--yes` confirms without asking and never opens a browser (it prints the board's address, or the Configuration page's when no model is set up, item 5b). Without a terminal and without `--yes` it prints the plan, writes nothing and exits 2.
8. Later runs open the board (the Configuration page while no model is set up, item 5b). No file is written by the person before their first card; `config.toml`, `gates.toml`, `hooks.toml`, `mcp.json`, skills, tiers and rosters all exist, and none is met on day one.

```
$ sekhemet
M4, 24 GB. Worker Cyber-Tiel-Coder-35B-A3B, Planner <model> — weights present.
Gates from package.json: typecheck, lint, test.
Set up here? [Y/n]
Ready. Ask for work with: sekhemet "add rate limiting to the API"
```

With no model set up, the paragraph ends differently:

```
M4, 24 GB. No models found yet — recommended: Worker Cyber-Tiel-Coder-35B-A3B, Planner <model> (14 GB).
Gates from package.json: typecheck, lint, test.
Set up here? [Y/n]
Ready. Opening Configuration to find your models or download these.
```

### Onboarding an existing repository

9. For a repository with history, the first run also: builds and caches the repo map (from the TypeScript compiler's facts, [DEC-20](../DECISIONS.md#dec-20); the old design's tree-sitter map is Later); starts the language servers — confined, after trust — and records which work; extracts conventions (naming, layout, error patterns, test style, formatter and linter configs, commit conventions, CODEOWNERS, PR templates, pre-commit hooks, workspace packages) into a **draft** playbook with evidence links; and drafts a Sekhemet section for `AGENTS.md` and `CLAUDE.md` so other agents stay aligned.
9a. **Conventions become gates first.** Where the team has a linter or formatter configuration, the static gates and autofix run the team's own tools with the team's configuration, never Sekhemet's. What cannot be a gate is kept as short, evidence-linked **location facts** ("HTTP handlers live in `src/routes/`"), not style prose. The drafted `AGENTS.md` block holds only commands, locations and rules no gate already enforces — repository overviews in context files did not help agents and cost over 20% more inference.
9b. **CI coverage is shown, not assumed.** The deriver lists every CI step with the gate it became, or the reason it did not: it needs a service, a secret or a matrix entry (it becomes an `unavailable` gate, not a failure, [gates](gates.md)), or it runs a tool the deriver does not know.
9c. **A baseline of what is already broken.** Onboarding records the pre-existing type and lint diagnostics and the failing tests as a baseline event, keyed by file, rule and a fingerprint that survives line moves; it runs the existing test suite **twice** and records failing and flaky tests separately. Gates then report only what is not in the baseline, and the baseline only shrinks on its own ([gates](gates.md) owns the rule) — otherwise every card on a legacy repository fails its first static gate on other people's errors and the repair ladder spends its rungs on them.
9d. **Workspaces are first-class.** Onboarding detects workspace packages — pnpm, npm and yarn workspaces and TypeScript project references (uv workspaces for Python later) — and records each package's name, dependencies and build order, which the source index, scope declaration and per-package gates read ([context](context.md), [gates](gates.md)).
10. Everything is a draft under `.sekhemet/onboard/` until the person accepts it. A proposed `gates.toml` is shown as a **diff** against an existing one and never replaces it without confirmation; the previous file is kept as a backup. The `AGENTS.md` section is one marked block, replaced in place on every run, and holds the team's conventions, not Sekhemet's own limits.
11. The qualification of this machine's models on this repository's code is offered, not run silently ([models](models.md)).
12. **Convention drift** is checked nightly against the playbook, not against a snapshot of the draft; a repository whose conventions did not change reports no drift.

### The command surface

13. Eight commands at the front door (with `ask` in place of `board`, the default of owner decision [O23](../../reference/OPEN_QUESTIONS.md#owner-decisions), pending — NEW-surface-6); every other command keeps its implementation under `dev`, listed only by `sekhemet dev --help`, and still runs when called without `dev` (moved means unlisted, not removed):

| Command | What it does |
| --- | --- |
| `sekhemet` | First run sets everything up and opens the board; later runs open the board (the Configuration page while no model is set up, item 5b) |
| `sekhemet "<spec>"` | Plan the work and run it — one verb, not `plan` then `queue` |
| `sekhemet run [card]` | With a card: run it or resume it. Without: run the queue |
| `sekhemet review` | The oldest card in Review: its gates, its diff size, and the commands that decide it |
| `sekhemet accept <card>` | Accept. Siblings: `send-back <card> "<reason>"`, `park` / `unpark <card>`, and the reversal verbs [review-git](review-git.md) defines |
| `sekhemet ask "<question>"` | Ask Seshat from the terminal — for non-developers and people on SSH; the reply prints here (NEW-surface-6). Replaces `board`, which the bare `sekhemet` already opens; `board --terminal` moves under `dev`. If the owner declines O23, `board` stays in this row |
| `sekhemet doctor` | Check the install: toolchain, model weights, confinement, configuration |
| `sekhemet dev <command>` | Everything for developing the harness itself |

14. **Rules for adding.** A new user-facing command displaces one, or it goes under `dev` or into the dashboard's command palette. A flag that silently rewrites other flags (`--profile`) is a default that has not been chosen, not a command (DEC-25 R13): a run's settings are one resolved `RunProfile` — defaults, config layers, then flags — recorded whole in every evidence bundle, and a named settings file (`--settings <file>`) is allowed because it too is recorded, with its hash ([measurement](measurement.md) M9). **Every destructive action the board offers is on the command line with its undo.**
15. **A spec is a sentence.** A single word that is not a command is refused with a suggestion within edit distance 2 (`reveiw` → `review`), because planning a typo writes cards to the board. A research question is not a command: it is asked in conversation, and the Researcher answers through the decision queue.
16. **The board's decisions are the command line's decisions.** `send-back` requires a reason, which becomes the next attempt's instruction and a playbook candidate; `park` prints its undo; all of them share one implementation with the dashboard's buttons — including who may accept: a solo developer accepts their own cards, and on a project where two or more people hold the Accept permission, `accept` refuses the person who built the card or recorded its latest delegation to the Worker — whoever owns the card now — and names who may accept (owner decision O11, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue); [review-git](review-git.md) §2.4.1 owns the rule).
16a. **`ask` is Seshat's conversation, not a second one.** `sekhemet ask "<question>"` sends the question through the PM's queued-answer path ([PM_CONTRACT.md](../PM_CONTRACT.md)) into the same thread the dashboard and ACP show, waits for the reply and prints it; while the Worker runs, Seshat answers between its steps ([runtime](runtime.md) item 4), and the command says it is waiting. Proposals the reply creates are listed with where to apply them; `ask` applies nothing.
17. **One registry** of commands — name, visibility (front or dev), flags, handler, help — feeds the parser, the dispatcher and both help screens, so a command cannot have a handler the parser never reaches (T4). Flags are parsed once, by `node:util` `parseArgs`, with unknown flags refused.
18. **Exit codes.** 0 success; 1 failure, including any uncaught error; 2 usage error (unknown command, missing argument, missing confirmation). `sekhemet run <card>` exits 0 when the card reached Review or Done and 1 when it stopped without passing, so scripts and CI can use it headless.
19. `--version` / `-v` prints the version and does nothing else; `--help` / `-h` prints the front-door help.
20. `board --terminal` uses the board's vocabulary: column names and card states from [NAMING.md](../NAMING.md), WIP limits shown only where one is set, no internal identifiers.
20a. **Reserving the machine from the terminal.** `sekhemet dev reserve` reserves the machine now — the CLI twin of the dashboard's *Reserve now* ([dashboard](dashboard.md) §2.11) — and `sekhemet dev release` ends the reservation; both share one implementation with the dashboard's control. While reserved, no backlog card starts unattended unless it is urgent and the overnight benchmark neither starts nor continues ([models](models.md) rules 20 and 20b, MD-N3-1, MD-N3-4; [runtime](runtime.md) item 17). `reserve` prints what it held or stopped (a running overnight benchmark stops as MD-N3-5 says) and its undo, `sekhemet dev release`; `release` prints when unattended work may next start (the overnight window, or *now* when it is open). Each is recorded on the ledger with the person's principal. Reserving an already reserved machine, or releasing a free one, changes nothing, says so and exits 0. A reservation ends by a release from either surface, or at its `--until <time>` when one was given (`machine/reserved {principal, until?}`, [runtime](runtime.md) item 17); `reserved_hours` is not changed by either command.

### Configuration

21. Settings resolve in order: built-in defaults → user (`<user dir>/config.toml`) → project (`<repo>/.sekhemet/config.toml`) → card overrides → command line (`--set section.key=value`, repeatable). A malformed layer is skipped and `doctor` names it. A card's overrides are a field of its record, shown on the card and listed in its evidence (NEW-surface-3).
22. **One user directory**: `SEKHEMET_CONFIG_DIR`, else `~/.sekhemet`. It holds `config.toml`, the model registry, the machine profile, integration settings, trust records and learning data (NEW-surface-1).
23. **The v1 schema** (every key has a reader):

```toml
[models]
worker = "auto"            # registry id or "auto" (the tier's qualified choice)
planner = "auto"           # Seshat and the planner run on it
reviewer = "auto"          # "off" disables review, and the card says so
researcher = "auto"
vision = "auto"            # image description for cards with attachments
folders = []               # model folders the Configuration page scans, besides SEKHEMET_MODELS_DIR; the known stores are only suggested on the page and scanned once a person adds them (models 4a, NEW-models-12)

[loop]
default_step_budget = 40   # max steps (model requests) per sample, when no flag overrides

[review]
review_minutes_per_day = 60   # human review capacity; derives the Review WIP limit; must be > 0 (0 or less is refused)

[network]
mode = "offline"           # "offline" | "allowlist" | "open" — card commands and harness requests other than research
research = "ask"           # "ask" | "yes" | "no" — the Researcher's own requests; set by the first-project question (O16); a yes stays inside fetch_allow when it is non-empty (item 24)
fetch_allow = []           # hosts an outbound request may reach (item 24)
fetch_deny = []            # hosts never reached, whatever fetch_allow or mode says

[machine]
reserved_hours = "08:00-18:00 Mon-Fri"   # the person's hours; unattended runs go outside them
# overnight_hours = "22:00-06:00"       # optional: narrows the overnight window (the complement of reserved_hours)
power_budget_kwh_day = 0                 # 0 = unlimited
```

   `[server]` (binding) is in [runtime](runtime.md); `[identity]` in [integrations](integrations.md); both are read only from the user directory.

   Two defaults changed deliberately from the 2026-09-17 design: `fetch_allow` starts empty (the old default was `["nodejs.org"]`) because offline is the default and the person names the first site; and the old `[overnight] hours = "18:00-08:00"` (when unattended runs may use the machine) became `[machine] reserved_hours` (the person's own hours, unattended runs go outside them) — the code's meaning, which reads as the person's promise rather than the machine's.
24. **One network schema, owned here.** Every outbound request — the Researcher's searches and page reads, registry lookups for the supply-chain gate, repository clones, and a card's sandboxed commands through the egress proxy — is decided by `[network]`: `mode` (`offline`: nothing leaves the machine except loopback; `allowlist`: only `fetch_allow` hosts and their subdomains; `open`: any public host), then `fetch_deny`, which wins over both `fetch_allow` and `mode`. **`research`** governs only the Researcher's harness-side requests (search, page reads, repository reading for research): `ask` until the first new project's question is answered, then `yes` or `no`; with `yes`, research may reach the effective `fetch_allow`'s hosts when that list is non-empty, otherwise any public host, and never a host in `fetch_deny` — logged, and whatever `mode` says; **a yes never widens a list the person wrote**. `mode` still governs every card command and every other request — so a person can research freely while their cards stay offline ([security](security.md) item 29a, [design-stage](design-stage.md) §2.6). **The user's `config.toml` is authoritative.** A project's `.sekhemet/config.toml` may only make the policy stricter: it may **add** hosts to `fetch_deny` and **narrow** `fetch_allow` (the effective list is the intersection of the user's and the project's), and it may set `research = "no"` for itself; it may not widen `mode`, set `research = "yes"` where the user's file says `no` or `ask`, add a host to `fetch_allow`, or remove one from `fetch_deny`; a key that tries is ignored and `doctor` names it. A card's sandboxed commands reach, in addition, only the hosts the repository's `gates.toml` `[project] network_allow` names — one more narrowing of the same effective `fetch_allow`, empty by default, so a card's commands reach nothing unless the project lists a host ([security](security.md) items 28–30; the key's placement is [gates](gates.md)'). No other file or key names network access: [design-stage](design-stage.md)'s domain allowlist and denylist are `fetch_allow` and `fetch_deny`.
25. **Removed** because nothing reads them: `machine.tier` (derived from memory), the whole `[context]` section (budgets come from the tier profile), `loop.stall_window` and `loop.max_rungs` (the repair ladder is not a tunable), `models.pruner`, `[sync]` (configured on the Integrations page), `telemetry.store` (one legal value), and `review.wip` (always derived — [review-git](review-git.md) S6). **Renamed**, with the old name read and reported by `doctor` for one release: `models.executor` → `worker`, `network.allow` → `fetch_allow`, `machine.hours` → `reserved_hours`. **New:** `network.fetch_deny`, whose reader is the one network policy (the research fetch path's denylist, [design-stage](design-stage.md) NEW-design-stage-4, and the egress proxy).
26. A project `config.toml` cannot widen the network policy (item 24: it may only add to `fetch_deny`, narrow `fetch_allow` and set `research = "no"`) or set `[server]`/`[identity]` keys ([security](security.md) item 28).
27. **Environment variables** are not a second configuration system. *Changed from the old design's "only `SEKHEMET_CONFIG_DIR` and `SEKHEMET_MODELS_DIR` are honoured":* the code reads about 45 variables, so each is classified below and only the two bootstrap variables are shown to users. Each `SEKHEMET_*` variable is in exactly one class below; a variable in no class is a defect ([docs check](#t10--executable-documentation-checks)).

| Class | Variables | Rule |
| --- | --- | --- |
| Bootstrap (needed before config is read) | `SEKHEMET_CONFIG_DIR`, `SEKHEMET_MODELS_DIR` | the only variables a user is told about |
| Safety opt-outs | `SEKHEMET_ALLOW_UNCONFINED`, `SEKHEMET_AIRGAP`, `SEKHEMET_OFFLINE` | recorded in every evidence bundle when set |
| Experiment switches | `SEKHEMET_THINKING`, `SEKHEMET_WORKER_METHOD`, `SEKHEMET_CANDIDATE_RULE` | recorded in every evidence bundle ([measurement](measurement.md)) |
| Set by the harness for children | `SEKHEMET_EVENT`, `SEKHEMET_CARD`, `SEKHEMET_TOOL`, `SEKHEMET_TOOL_TARGET` (hooks), `SEKHEMET_USER_AGENT` (crawler), `SEKHEMET_GIT_HARDENED` | never read from the user |
| Integration credentials and CI | `SEKHEMET_GITHUB_APP_ID`, `_INSTALLATION_ID`, `_APP_KEYCHAIN`, `_APP_KEY_PATH`, `_HOST`, `_REPO`, `_AUTOMERGE`, `_WEBHOOK_SECRET`; `SEKHEMET_FORGEJO_URL`, `_TOKEN`, `_REPO`; `SEKHEMET_TRIGGER_TOKEN` | secrets never logged; the Integrations page is the user path |
| Developer overrides (`dev` only) | `SEKHEMET_LLAMA_SERVER`, `SEKHEMET_MODEL_REGISTRY`, `SEKHEMET_MACHINE_PROFILE`, `SEKHEMET_MACHINE_WATTS`, `SEKHEMET_SLOT_CACHE`, `SEKHEMET_RESEARCHER`, `SEKHEMET_RESEARCHER_CTX`, `SEKHEMET_RESEARCHER_GGUF`, `SEKHEMET_MAX_COMMAND_MEMORY_MB`, `SEKHEMET_CHROME`, `SEKHEMET_CLI`, `SEKHEMET_SEARXNG_URL`, `SEKHEMET_SEARXNG_PORT`, `SEKHEMET_CRAWL4AI`, `SEKHEMET_CRAWL4AI_HOME`, `SEKHEMET_CRAWL4AI_PORT`, `SEKHEMET_RESEARCH_CACHE`, `SEKHEMET_REPO_CACHE`, `SEKHEMET_CONTACT` | listed in `dev --help`, never in user docs |

### Multimodal input

28. A card accepts images (bug screenshots, mockups, whiteboard photos) up to 10 MB each, from the dashboard or `sekhemet dev attach`; other file types are refused. Images are saved with the card's evidence and put on the ledger.
29. The local vision model sees each image once and returns a structured description and a checklist of atomic visual criteria; text models receive that description through the card's dossier, never raw images. Without a co-loaded vision model, the analysis runs as one batch before the Worker pass (a scheduled swap); cards whose images wait are named.

### Language support

30. TypeScript first ([DEC-20](../DECISIONS.md#dec-20)). A language is fully supported when it has a parser, a working headless language server and a gate template; missing any of the three degrades to parse-only checks (or none), stated with a visible warning on the card, in the evidence bundle and in `doctor`. The gate template table per language — TypeScript, Python, Rust, Go, Java/Kotlin, with each language's mutation tool when installed — is [gates](gates.md)' (DEC-25 R14); `packages/gates/src/templates.ts` holds TypeScript (pnpm, npm, yarn), Python, Rust and Go today.

### Installing

31. **One install path per audience** ([DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md)). A person installs Sekhemet from **one npm package** and meets one first run (items 5–8). A team server is deployed from **one container image** whose documentation names the identity proxy ([integrations](integrations.md) item 24) and the inference engine as a separate container. Both artefacts are approved (owner decision O9, decided 2026-09-24, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)). The source installer of [DEC-21](../DECISIONS.md#dec-21--accepted-substitutions) stays as the route for the air-gap kit and for developing the harness; a single executable is Later (§7).
32. **Upgrades keep a person's data.** An upgrade migrates `config.toml` in the same step as the ledger migration ([runtime](runtime.md) item 38): renamed keys are rewritten after a backup, and `doctor` reports what changed.

## 3. Contract

| Item | Source |
| --- | --- |
| `FRONT_DOOR`, `COMMANDS`, `routeFrontDoor`, `FrontDoorRoute` | `apps/harness/src/front_door.ts` |
| `main`, `parseCliArgs`, `openHome`, `runTriage` | `apps/harness/src/index.ts:361, 193, 1999, 2025` |
| `runInit`, first-run checks, roster | `apps/harness/src/init.ts` |
| `runOnboard`, drift check | `apps/harness/src/onboard.ts` |
| `SekhemetConfig`, `resolveConfig`, `DEFAULT_CONFIG` | `apps/harness/src/config.ts` |
| `effectiveConfig`, `cliOverrides`, `explicitNetworkMode`, `queueDefaults` | `apps/harness/src/config_apply.ts` |
| `sendBack`, `park`, `unpark`, `nextForReview` | `apps/harness/src/triage.ts` |
| `detectGateTemplate`, gate templates | `packages/gates/src/templates.ts` |
| `Attachment`, `VisionDescription`, `visionPrePass`, `MAX_IMAGE_BYTES` | `apps/harness/src/attachments.ts` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Eight front-door commands, `dev` namespace, typo guard | built | `front_door.ts`; `front_door.spec.ts` (routing only; never runs `main`) | — |
| Triage verbs share the board's code; send-back needs a reason | built | `index.ts:2023-2080`; `triage_cli.spec.ts` | — |
| One first run | not-built | bare `sekhemet` runs `gates init` then `board` (`index.ts:1995-2014`): no models, no confirmation, no `.gitignore`, opens a browser; `init` is a separate path (`init.ts`) ending "Next: `sekhemet calibrate`" (`:386`) | P10 |
| One gate deriver | not-built | four: `init.ts:170-270`, `templates.ts:79-90` (pnpm fallback, no typecheck, no `protected`), `onboard.ts:413-415`, bare `sekhemet` | P10 |
| Onboarding | partial | seven steps, drafts under `.sekhemet/onboard/` (`onboard.spec.ts`); CI ignored for gates, `run: \|` missed (`:172`), `--apply` overwrites `gates.toml` (`:506-508`), `AGENTS.md` not idempotent (`:470`), drift fires every run (`:593-599`), language servers before trust (`:388-406`) | P10, S3a, S9 |
| `--version` has no side effects | not-built | routed as home: writes files, opens a browser | S10 |
| Uncaught error exits non-zero | not-built | `main().catch(console.error)` (`index.ts:2084`) | S10 |
| One command registry and parser | not-built | three parsers (`parseCliArgs`, `front_door.split`, per-command `argv.indexOf`); `board` reads `process.argv` (`index.ts:620`); `CliConfig.command` duplicates `COMMANDS` (`:113-150`); `main` is ~1,600 lines, `queue` ~790 | T4 |
| Terminal board vocabulary | not-built | "SEKHEMET DUAL-AXIS KANBAN BOARD", `IN_PROGRESS`, `BACKLOG (0/500)` (`index.ts:291-328`) | NEW-surface-2 |
| Config layers and `--set`: defaults, user, project, command line | built | `config.ts:192`; `config_apply.spec.ts` | — |
| Config layer: card overrides | not-built (was counted in `built`) | `effectiveConfig` accepts `card.configOverrides` (`config_apply.ts:44-55`), but no card record has the field and no caller passes one | NEW-surface-3 |
| One recorded `RunProfile`; `--settings <file>` | not-built | `queue --profile full` pushes `--explore`, `--escalate-retries`, `--review` and a `--max-turns` cap into `argv` and prints them (`index.ts:1181-1197`); the evidence records no single settings object | NEW-surface-5 |
| `.gitignore` keeps personal and secret state out of git | not-built | five lines only (`init.ts:348-354`); `.sekhemet/evidence/`, `transcripts/`, `artifacts/`, `research/`, `live/`, `tuning/`, `traces.db`, `runs/`, `blobs/`, `gate-host/` and `queue_report.json` are committable | P10 |
| Onboarding: team linter/formatter as gates, CI coverage list, diagnostic baseline, workspace graph | not-built | `detectCommands` classifies scripts and CI commands (`onboard.ts:108-190`) but records no step-by-step coverage, no baseline and no flaky run; workspaces are read only for per-package gates (`sync/src/repo_tools.ts:269-290`; pnpm, npm workspaces, Cargo), not recorded at onboarding, and TypeScript project references are not read | P10 |
| One install path per audience: npm package, server container image | not-built | source install only ([DEC-21](../DECISIONS.md#dec-21--accepted-substitutions)) | NEW-surface-4 |
| First run leads to the Configuration page when no model is set up | not-built | bare `sekhemet` opens the board whatever the weights (`index.ts:1995-2014`); no Configuration page exists | P10 |
| `sekhemet ask` | not-built | no such command; `board` is in `FRONT_DOOR` (`front_door.ts:18`) | NEW-surface-6 |
| `sekhemet dev reserve` and `release` | not-built | no such commands; the machine is reserved only by `[machine] hours` | NEW-models-3 |
| Config schema matches its readers | not-built | unread: `machine.tier`, `[context]`, `loop.stall_window`, `loop.max_rungs`, `models.pruner`, `[sync]`, `telemetry.store`; the design's names (`worker`, `fetch_allow`, `[overnight] hours`) differ from the code's (`executor`, `allow`, `[machine] hours`), and the hours mean the opposite; `fetch_deny` has no reader and a project layer can widen `network.allow` (`config.ts:26, 160`) | P10, T10 |
| Node.js floor matches `node:sqlite` | not-built | the check accepts any 22.x (`init.ts:61-64`) | P10 |
| One user directory | not-built | `~/.sekhemet` (`config.ts:195`, `models_dir.ts:25`, `mcp_client.ts:33`) vs `~/.config/sekhemet` (`integrations.ts:44`, `learning/store.ts:91`, `research/service.ts:53`); `config.ts` ignores `SEKHEMET_CONFIG_DIR` | NEW-surface-1 |
| Environment inventory | not-built | 45 `SEKHEMET_*` names read; the design allowed two | T10 |
| Offline first run and `plan` | not-built | `plan` goes online unless `--offline` or `SEKHEMET_OFFLINE` (`index.ts:703`) | S8 ([design-stage](design-stage.md)) |
| Multimodal input | built | `attachments.ts`; `attachments.spec.ts:44-115` | — |
| `doctor`: install, weights, confinement | built | `doctor.ts`; `doctor_weights.spec.ts`, `doctor_probe.spec.ts` | — |
| Docs checks | partial | `docs.spec.ts`: root allowlist, index coverage, relative links; skips `file:` links (`:54`) | T10 |

## 5. Changes for v1

### P10 — one first run, for all three audiences
*Three setup paths and four gate derivers; the first run names no models, asks nothing, and can overwrite a team's hand-tuned gates.*
- **SUR-1** WHEN `sekhemet` runs in a fresh npm repository with `typescript` as a dependency and no lockfile THE SYSTEM SHALL propose gates that use npm and include a typecheck gate.
- **SUR-2** WHEN `sekhemet` runs for the first time THE SYSTEM SHALL print the machine, the four roles' models and whether their weights are present, and the gates, and SHALL write nothing until the person confirms.
- **SUR-3** WHEN the first run is confirmed THE SYSTEM SHALL write `config.toml`, `gates.toml` and each missing `.gitignore` line exactly once.
- **SUR-4** WHEN `sekhemet --yes` runs THE SYSTEM SHALL complete setup without a prompt and SHALL NOT open a browser.
- **SUR-5** WHEN `sekhemet` runs without a terminal and without `--yes` THE SYSTEM SHALL write nothing and exit 2.
- **SUR-6** WHEN the first run happens with no user network setting THE SYSTEM SHALL make no outbound request.
- **SUR-7** WHEN `.sekhemet/gates.toml` already exists and onboarding proposes different gates THE SYSTEM SHALL show the difference, change nothing without confirmation, and on confirmation keep the previous file as a backup.
- **SUR-8** WHEN a CI workflow step uses `run: |` with a test command THE SYSTEM SHALL include that command in the proposed gates.
- **SUR-9** WHEN onboarding is applied three times THE SYSTEM SHALL leave exactly one Sekhemet block in `AGENTS.md`.
- **SUR-10** WHEN no commit changed the repository's conventions THE SYSTEM SHALL report no drift.
- **SUR-11** WHEN the Worker model is not set in config THE SYSTEM SHALL resolve it from the registry for the machine's tier, the same way for `run`, `queue` and the dashboard.
- **SUR-12** WHEN a derived test gate fails to start because its script is missing or wrong THE SYSTEM SHALL stop the run and name the file to edit.
- **SUR-34** WHEN the first run writes `.gitignore` THE SYSTEM SHALL leave `git check-ignore` true for `.sekhemet/evidence/`, `transcripts/`, `artifacts/`, `research/`, `observations/`, `live/`, `tuning/`, `traces.db`, `runs/`, `blobs/`, `gate-host/`, `events.db`, `queue_report.json` and a new directory `.sekhemet/<anything>/`, and false for `.sekhemet/config.toml` and `.sekhemet/gates.toml`.
- **SUR-35** WHEN onboarding derives gates from CI THE SYSTEM SHALL list every CI step with the gate it became or the reason it did not (needs a service, a secret, a matrix entry, an unknown tool).
- **SUR-36** WHEN onboarding finds the team's linter and formatter configurations THE SYSTEM SHALL use the team's tools and configurations for the static gates and autofix, and SHALL NOT apply Sekhemet's own.
- **SUR-37** WHEN onboarding drafts the `AGENTS.md` block THE SYSTEM SHALL limit it to commands, locations and rules that no gate already enforces.
- **SUR-38** WHEN onboarding runs the existing test suite THE SYSTEM SHALL run it twice, record failing and flaky tests separately, and record the pre-existing type and lint diagnostics, in one baseline event keyed by file, rule and a line-insensitive fingerprint ([gates](gates.md) reports against it).
- **SUR-46** WHEN the first run finds Node.js older than 22.13 THE SYSTEM SHALL name the version found and the version required, write nothing and exit 1.
- **SUR-47** WHEN a fresh clone of Sekhemet, installed by the one documented install path, runs the documented first run in an empty git repository on the reference machine — `sekhemet`, then `sekhemet "<spec>"` for a one-sentence spec, with the Worker's weights present or downloaded by a person's explicit choice on the Configuration page ([models](models.md) NEW-models-7, NEW-models-12) — THE SYSTEM SHALL bring at least one card built by the Worker to Review with every blocking gate passed and recorded in its evidence bundle, with no file in either repository edited by hand (DEFINITION_OF_DONE §6.7).
- **SUR-48** WHEN the user's `config.toml` sets `mode = "allowlist"` and `fetch_allow = ["a.example", "b.example"]` and the project's sets `fetch_allow = ["b.example", "c.example"]` and `fetch_deny = ["b.example"]` THE SYSTEM SHALL reach none of `a.example`, `b.example` and `c.example` from that project, and `doctor` SHALL name `c.example` as an ignored widening.
- **SUR-48a** WHEN `[network] research = "yes"`, `mode = "offline"` and `fetch_allow` is empty THE SYSTEM SHALL let the Researcher fetch a public host not in `fetch_deny`, logged, and SHALL give every card command no route out ([security](security.md) SEC-52a).
- **SUR-48c** WHEN `[network] research = "yes"` and the effective `fetch_allow` is `["a.example"]` THE SYSTEM SHALL let the Researcher fetch `a.example` and SHALL refuse, and log, a research fetch to `b.example`, whatever `mode` says; WHEN a project's `config.toml` sets `research = "no"` THE SYSTEM SHALL make no research request for that project; and WHEN a project's file sets `research = "yes"` under a user's `no` THE SYSTEM SHALL ignore it and `doctor` SHALL name it as an ignored widening ([security](security.md) SEC-52b).
- **SUR-48b** WHEN `[review] review_minutes_per_day` is 0 or less THE SYSTEM SHALL refuse to load the configuration, name the key and the value, and keep the previous configuration.
- **SUR-49** WHEN the first run is confirmed and no role's weights are found in any known model folder THE SYSTEM SHALL open the dashboard on the Configuration page instead of the board, SHALL download nothing, and under `--yes` SHALL print the Configuration page's address instead of opening a browser; and WHEN `sekhemet` runs later while still no model is set up THE SYSTEM SHALL open the Configuration page again.
- **SUR-50** WHEN the first run is confirmed and the Worker's and the Planner's weights are present THE SYSTEM SHALL open the board, not the Configuration page.
- **SUR-39** WHEN a repository declares pnpm, npm or yarn workspaces or TypeScript project references THE SYSTEM SHALL record each package's name, dependencies and build order at onboarding, and a card's scope, the source index and per-package gates SHALL read that record.

### S10 — a command line scripts can trust
- **SUR-13** WHEN `sekhemet --version` or `-v` runs THE SYSTEM SHALL print the version, write no file, start no server and exit 0.
- **SUR-14** WHEN any command throws an uncaught error THE SYSTEM SHALL print it and exit 1.
- **SUR-15** WHEN an unknown flag is given THE SYSTEM SHALL name it and exit 2.
- **SUR-16** WHEN `sekhemet run <card>` finishes with the card parked or failed THE SYSTEM SHALL exit 1; with the card in Review or Done, 0.
- **SUR-53** WHEN, on a project where two or more people hold the Accept permission, `sekhemet accept <card>` is run by the person who built the card or recorded its latest `card/delegated` to the Worker — even after its owner changed to someone else — THE SYSTEM SHALL change nothing, print who may accept, and exit 1 ([review-git](review-git.md) RG-N5-8); and WHEN exactly one person holds the Accept permission THE SYSTEM SHALL accept that person's own card and exit 0 (O11).
- (These are tested by spawning the built binary, not by calling functions.)

### NEW-models-3 (the command side) — reserve and release from the terminal
*Justification: [models](models.md) rule 20 and [runtime](runtime.md) item 17 reserve the machine when a person runs `sekhemet dev reserve`, but no spec owned the command or tested it (final check m-h). The change is [models](models.md)' NEW-models-3; this spec carries only the commands (item 20a), and MD-N3-1 and MD-N3-4 test their effect.*
- **SUR-54** WHEN `sekhemet dev reserve` runs on a free machine THE SYSTEM SHALL record the reservation on the ledger with the person's principal, start no backlog card unattended unless it is urgent and start no overnight benchmark until a release, print what it held or stopped and the undo `sekhemet dev release`, and exit 0; WHEN the machine is already reserved THE SYSTEM SHALL change nothing, say so and exit 0.
- **SUR-55** WHEN `sekhemet dev release` runs on a reserved machine THE SYSTEM SHALL record the release with the person's principal, print when unattended work may next start, and exit 0, and the dashboard's *Reserve now* control SHALL show the machine as free; WHEN the machine is not reserved THE SYSTEM SHALL change nothing, say so and exit 0; and neither command SHALL change `[machine] reserved_hours`.

### T4 — `index.ts` as a command registry
*Strangler, one command at a time, only between suite runs; `queue` moves first because it carries the most risk.*
- **SUR-17** WHEN the registry lists a command THE SYSTEM SHALL route to its handler, show it in exactly one help screen, and parse its flags from its own schema — tested for every entry.
- **SUR-18** WHEN `board --terminal` is passed through `openHome` or a test THE SYSTEM SHALL honour it.
- **SUR-19** WHEN `queue` moves into its own module THE SYSTEM SHALL, on a scripted-adapter replay of the frozen suite's recorded trajectories (each model response replayed from the ledger through the scripted adapter, `packages/models/src/mock_adapter.ts`, so the run is deterministic), produce for every card the same stop reason, the same number of steps and the same gate results as the same replay before the move. *Changed from "score the same on the frozen suite":* a live run at temperature above 0 cannot show "the same", and the suite cannot resolve a difference under 20 points ([measurement](measurement.md); design v3 review M5).

### T10 — executable documentation checks
- **SUR-20** WHEN the README's command table and `FRONT_DOOR` differ THE SYSTEM SHALL fail `docs.spec`.
- **SUR-21** WHEN a key in this spec's schema has no reader in `config.ts`, or `config.ts` reads a key not in the schema THE SYSTEM SHALL fail `docs.spec`.
- **SUR-22** WHEN the code reads a `SEKHEMET_*` variable absent from the inventory in item 27 THE SYSTEM SHALL fail `docs.spec`.
- **SUR-23** WHEN a document names a model absent from the registry, or has a `file:` link THE SYSTEM SHALL fail `docs.spec`.
- **SUR-24** WHEN a spec's front-matter `status` differs from its row in SPINE's status table THE SYSTEM SHALL fail `docs.spec`.

### NEW-surface-1 — one user directory
*Justification: user state is split between `~/.sekhemet` and `~/.config/sekhemet`, and `SEKHEMET_CONFIG_DIR` means a different place in different modules; the sandbox must deny reads of one known secret-bearing directory ([security](security.md) item 10).*
- **SUR-25** WHEN `SEKHEMET_CONFIG_DIR` is set THE SYSTEM SHALL read and write user config, the registry, integration settings, trust records and learning data only under it.
- **SUR-26** WHEN files exist in the old `~/.config/sekhemet` location THE SYSTEM SHALL move them once, and `doctor` SHALL report the move.

### NEW-surface-3 — the card layer of the configuration is real or removed
*Justification: the card-override layer is accepted by the resolver and supplied by nobody (inventory H15), which rule 4 forbids for a key.*
- **SUR-40** WHEN a card's record carries `configOverrides` THE SYSTEM SHALL resolve that card's run with them between the project layer and the command line, show them on the card, and list them in its evidence bundle.

### NEW-surface-4 — one install path per audience
*Justification: a second install path appears ad hoc unless one is chosen per audience, as three setup paths did before ([DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md)). The owner approved both artefacts, an npm package and a server container image (O9, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)).*
- **SUR-41** WHEN Sekhemet is installed for one person from the npm package THE SYSTEM SHALL reach the first run of item 5 with no other step.
- **SUR-42** WHEN Sekhemet is installed as a team server THE SYSTEM SHALL be deployable from one container image whose documentation names the identity proxy and the separate inference container.
- **SUR-43** WHEN an upgrade finds renamed config keys THE SYSTEM SHALL back up `config.toml`, rewrite the keys, and have `doctor` report each change.

### NEW-surface-5 — one recorded run profile
*Justification: `queue --profile full` rewrites other flags, the pattern item 14 forbids; a benchmark must measure what ships (DEC-25 R13; integration review suggestion 12). **One `RunProfile`, two shares** (confirmation review N7e): [measurement](measurement.md) MS-M9-4/5 (B2.4) build it for measured runs, and B2.5 freezes the baseline profile; SUR-44/45 (B3.3) are the command line's share — the same object, resolved through the command registry (T4) for every run, never a second profile type.*
- **SUR-44** WHEN a run starts THE SYSTEM SHALL resolve one `RunProfile` from defaults, config layers and flags and record it whole in every card's evidence bundle.
- **SUR-45** WHEN `--settings <file>` is given THE SYSTEM SHALL apply the file as one layer and record its path, SHA-256 and contents in the evidence; and no flag SHALL change the value of another flag.

### NEW-surface-6 — `sekhemet ask`, Seshat from the terminal
*Justification: a non-developer on a headless box or over SSH has no way to talk to Seshat without the dashboard; the front door has room for one command only by displacing one (item 14), and `board` duplicates the bare `sekhemet`. The default of owner decision [O23](../../reference/OPEN_QUESTIONS.md#owner-decisions) (pending; blocks B4.1): approve. If the owner declines, these criteria are withdrawn and `board` stays at the front door.*
- **SUR-51** WHEN `sekhemet ask "<question>"` runs THE SYSTEM SHALL post the question to Seshat's thread as the person's message through the PM's queued-answer path, print Seshat's reply, record both in the same thread the dashboard shows, and exit 0; WHEN no model can answer THE SYSTEM SHALL say why and exit 1; and WHEN the reply creates proposals THE SYSTEM SHALL list them and apply none.
- **SUR-52** WHEN `sekhemet --help` prints THE SYSTEM SHALL list `ask` among the eight front-door commands and not `board`; and WHEN `sekhemet board` or `sekhemet board --terminal` is called THE SYSTEM SHALL still run it, listed under `sekhemet dev --help`.

### NEW-surface-2 — a terminal board in the board's words
*Justification: the terminal board shows internal state IDs and a banner that teach nothing (review of domain 1, the beginner's first ten minutes).*
- **SUR-27** WHEN `board --terminal` prints THE SYSTEM SHALL use the column and state names from NAMING.md and show a WIP limit only where one is set.

## 6. v1 acceptance

SUR-1 to SUR-27 and SUR-34 to SUR-55, SUR-48a and SUR-48c included (SUR-51 and SUR-52 hold O23's default until the owner answers; SUR-47 is DEFINITION_OF_DONE §6.7 and is run last, on the reference machine), plus these built behaviours kept under test:
- **SUR-28** WHEN a single word within edit distance 2 of a front-door command is given THE SYSTEM SHALL suggest that command, write nothing and exit 2.
- **SUR-29** WHEN `send-back` is given no reason THE SYSTEM SHALL refuse and exit 2.
- **SUR-30** WHEN `park` succeeds THE SYSTEM SHALL print its undo command.
- **SUR-31** WHEN a command is called without `dev` that the help lists only under `dev` THE SYSTEM SHALL run it.
- **SUR-32** WHEN a card has an image attachment and a vision model is available THE SYSTEM SHALL give the Worker the description and criteria, never the image bytes.
- **SUR-33** WHEN a card's language has no parser or gate template THE SYSTEM SHALL state the degradation on the card and in its evidence bundle.

## 7. Later

- **A TUI and an IDE extension** (SPINE: not in v1); the dashboard is the primary interface and the CLI the secondary one.
- **`@clack/prompts`** for the confirmation, **`execa`** for end-to-end CLI tests, **Vale** and **markdownlint** for the docs — proposals needing the owner's yes.
- **Onboarding extras** from the old design: automatic convention extraction combining deterministic linter/CI parsing with AST pattern discovery (`crag`, `codebase-md`, licences unverified), and multi-language symbol support through tree-sitter (DEC-20).
- **Probe-and-refine tuning of repository guidance** (synthetic bug-fix probes per repository) — the only evidence on a 35B-A3B model is positive, but it needs the synthesised-task inlet ([measurement](measurement.md)) first; **uv workspaces** for Python — with the Python adapter ([DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) §5).
- **A single-executable build** (Node's `--build-sea`) — still marked "active development" in Node's documentation; a proposal once it is stable.
- **`sekhemet dev audit`** (old design) — retired as a name; its checks live in `doctor`'s playbook check and `qualify` ([measurement](measurement.md)).

## 8. Open questions

1. **`sekhemet ask "<question>"`** — Seshat from the terminal, for non-developers and SSH users, reusing the PM's queued-answer path. Owner decision [O23](../../reference/OPEN_QUESTIONS.md#owner-decisions), pending (blocks B4.1). *Default until decided, written into item 13 and NEW-surface-6:* it joins the front door in place of `board` (which the bare `sekhemet` already opens), with `board --terminal` moving under `dev`.
2. **Should the first run open a browser at all?** The review found an unasked browser off-putting; the old design opened the board. *Recommendation:* item 5.6/7 — yes after an interactive confirmation, never under `--yes` or without a terminal.
3. **Keep the old key names beyond one release?** *Recommendation:* no; `doctor` reports them for one release, then they are removed with the schema check (SUR-21) catching strays.
4. **Which install artefacts ship?** *Decided 2026-09-24 (O9, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)): both* — an npm package for a person and a container image for a team server, with the inference engine in its own container (item 31, NEW-surface-4); a single executable later (§7). They do not reopen DEC-21, which is about offline installers.
5. **The card-override layer: wire or cut?** *Recommendation:* wire it (SUR-40) only when a card needs its own settings — the Planner setting a step budget per card is the first candidate; otherwise cut the layer, as rule 4 cuts an unread key.

## 9. Evidence and rationale

- Review: [domains 1 and 16](../../reference/reviews/domain01_16_surface_docs.md) — the first ten minutes per audience, the setup paths, drift table rows 5 and 6 (config schema, environment variables), the registry split.
- [Gap sweep](../../reference/reviews/gap_sweep.md) — `onboard.ts` as a fourth gate deriver and its four confirmed defects.
- Research, [DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) §2.2 and §3.5: context files did not raise task success and cost over 20% more (Gloaguen et al., 2602.11988) → item 9a, SUR-37; basedpyright's shrinking baseline → item 9c, SUR-38; pnpm filtering and `vitest --changed` over the workspace graph → item 9d, SUR-39; CI steps needing services become `unavailable` → item 9b, SUR-35. The research document's four brownfield surface criteria are carried as SUR-35…38.
- Research, [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 15 (SEC-T1): `init` leaves `.sekhemet/evidence/` and `transcripts/` committable → item 5.6, SUR-34 (widened to deny-by-default because `.sekhemet/` also holds the gate host's keys and state directories the research did not list).
- Research, [DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md): one artefact per audience; `node:sqlite` built in, so no native addon complicates bundling → items 31–32, NEW-surface-4.
- Decisions: [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) (O2 the Configuration page → item 5b, SUR-49/50; O9 both install artefacts → item 31; O11 solo self-accept → item 16, SUR-53, with the delegator read from the latest `card/delegated` (final check F2)); pending O16 (item 6) and O23 (item 13, NEW-surface-6), each with its default written in; [DEC-01](../DECISIONS.md#dec-01) (three audiences), [DEC-20](../DECISIONS.md#dec-20) (TypeScript first), [DEC-21](../DECISIONS.md#dec-21--accepted-substitutions) (source installer).
- **Why "moved means unlisted":** the first plan broke calls to moved commands; building it found the callers were the frozen-suite runner, the harness's tests and the author's habits, and breaking them bought the user nothing — the user's surface is the help.
- **Why no environment layer for settings:** variables that silently outrank a file the person edited are a second configuration system.
