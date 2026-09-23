# Phase A — Domain 1 (product surface) and Domain 16 (the documents)

Read-only review against HEAD `468f67f`. The CLI was run from `apps/harness/dist` (current as of 18:29) in a throwaway git repo under the scratchpad, with `--help`, `dev --help`, typos, `review`, `accept`, `board --terminal`, `log`, `send-back`, `park` and `plan --offline`. Nothing that loads a model was run, and neither was `doctor`. Line numbers are from HEAD. While I worked, another session edited `HARNESS_DESIGN.md`, `MVP_PATH.md` and `PHASE0.md` (the PHASE0 correction). I did not make those edits.

---

## Domain 1 — Product surface

### 1. Positioning: the first ten minutes

**Developer.** The README's Quickstart (`README.md:76-81`) is `pnpm install && pnpm build && pnpm test && node apps/harness/dist/index.js doctor`. It never mentions `scripts/install.sh`, which links a `sekhemet` binary, or bare `sekhemet`, which the design calls "the product" (`HARNESS_DESIGN.md:159`). What I saw when I ran bare `sekhemet` in a fresh npm repo:
- It wrote `.sekhemet/gates.toml` using **pnpm** (`packages/gates/src/templates.ts:85` falls back to pnpm when there is no lockfile) and **no typecheck gate**, although `typescript` is a dependency.
- It did not add `.sekhemet/` to `.gitignore`, so git status showed `?? .sekhemet/`.
- It started the dashboard and opened a browser. There was no confirmation step, and it named no models.

The design's first run promises "the two models it will use… One confirmation" (`HARNESS_DESIGN.md:159-166`). None of that is built. `openHome` (`index.ts:1995-2014`) runs `gates init` and then `board`.

Next, `sekhemet "<spec>"` plans. That step **goes online by default**: npm, GitHub and paper searches through `liveReuseDeps` (`index.ts:699-702`). It then runs the queue on `nail-35b-a3b-ctx:latest` (`index.ts:1558`). That looks like a local custom Ollama tag, and I found no instruction for obtaining it (moderate confidence). A new developer cannot get to a first card that passes the gates.

**Beginner.** The terminal board prints "SEKHEMET DUAL-AXIS KANBAN BOARD", raw state IDs (`IN_PROGRESS`) and limits such as `BACKLOG (0/500)` (`index.ts:291-328`). `plan` prints INVEST jargon, "pack ≤ 8192 tokens" and "~14352 tokens, prior". It also says "Assumed: TypeScript on Node 20", but Node 20 cannot run this tool (see Drift). For a one-line function it made two cards and set the epic to In Progress. Nothing on screen teaches the practice. The claims table's "Teaches beginners — Not built" (`HARNESS_DESIGN.md:115`) is honest.

**Non-developer.** The CLI has no way to talk to the PM. `goal` and `decide` are hidden under `dev` (`index.ts:1985`). Seshat can only be reached through the browser dashboard or ACP. Starting a project by conversation is "Not built" (`:116`).

**Adopt or bounce.** Teams would adopt it for the truthful triage verbs (`review`, `send-back` with a required reason, `park`/`unpark` with an undo message: `index.ts:2021-2077`), the typo guard, and evidence shown in `review`. They would bounce on the three conflicting setup paths, a silent network call on the first spec, a browser opening without being asked, `--version` doing a full setup (below), a Worker that depends on which path you took, and the fact that `accept` has no undo although the design requires one (`HARNESS_DESIGN.md:194`).

**Does the README sell the positioning truthfully?** It does not sell it at all. It still describes "a local-first coding harness" for one person (`README.md:3-6`), with a status block dated 2026-09-18 and the pre-front-door CLI table (`:97-108`, which lists `plan`, `queue`, `gate`, `bake-off` and `serve`, and has no `review`, `send-back` or bare `sekhemet`).

### 2. Drift

| Topic | One side | The other side |
| --- | --- | --- |
| First run | Design: prints the models and asks for one confirmation (`HARNESS_DESIGN.md:159-166`) | `openHome` never resolves models and never asks (`index.ts:1995`) |
| Setup paths | `install.sh`: "Next, in your project: sekhemet init" | Bare `sekhemet` runs `gates init`, a different gate deriver. `init` ends with "Next: `sekhemet calibrate`" (`init.ts:386`), and `calibrate` is a dev command |
| Gate derivation | `init.ts:170-270`: npm fallback, `npx tsc`, protected test globs, `.gitignore` lines | `templates.ts:79-90`: pnpm fallback, no typecheck, no `protected`, no `.gitignore` |
| Default Worker | README says `nail-35b` via Ollama (`README.md:62`). `queue` agrees (`index.ts:1558`) | CLAUDE.md says the Worker is Cyber-Tiel (`CLAUDE.md:58`). `init` writes `executor = "cyber-tiel"` (`init.ts:343`). Which model runs depends on whether `init` was ever run |
| Node version | README "Node 20+" (`:73`); CLAUDE "20+ supported" (`:53`); the planner assumes "Node 20" | `init.ts:61` and `install.sh` require 22+. `node:sqlite` does not exist on Node 20 |
| Swap guard | README "3 GB" (`:52`) | Code default is 6 GB (`packages/models/src/memory.ts:158`). CLAUDE.md also says 6 GB |
| Offline by default | Locked decision (`HARNESS_DESIGN.md:41`); `init` writes `[network] mode = "offline"` | `plan` ignores `network.mode` and reaches the network unless `--offline` or `SEKHEMET_OFFLINE` is set (`index.ts:699`) |
| Rejecting a card | Design: "`rejected → ready` needs a verb" (`:510`) | The CLI has no reject/reopen verb and no undo for accept |
| Model id | `parseCliArgs` defaults to `ollama/qwen2.5-coder:7b` (`index.ts:216`) | Stale: nothing uses that model |

### 3. Dead and duplicated

- There are two gate derivers (above). One of them should go.
- `CliConfig.command` is a hand-written union (`index.ts:113-150`) that duplicates `COMMANDS` (`front_door.ts:29`).
- `checkMemoryPressure` (`index.ts:161`) duplicates `MemoryWatchdog`'s thresholds. It appears to be reachable only from tests; this should be checked with the reachability gate.
- `serve` and `board` both start the dashboard (`index.ts:617-677`), each with its own banner.
- `init`'s roster (`init.ts:124-153`) recommends the same four models on every memory tier. That includes a 13 GB Worker plus a 27B manager on the "S" (16 GB) tier. The tiering is decorative.

### 4. Complexity hotspots

`main()` runs from `index.ts:361` to `index.ts:1957`, about 1,600 lines. **`queue` alone is about 790 lines** (`index.ts:1166-1956`). It contains the product's orchestration: the roster, router, watchdog, PM lease, askTeam, review, repair passes, notifications and the scorecard. That is the loop's composition root, hidden inside a CLI branch. Flags are parsed three different ways: `parseCliArgs`, `front_door.split`, and per-command `argv.indexOf`. `board` reads `process.argv` instead of its own `argv` (`index.ts:620`), so `--terminal` passed from `openHome` or from a test is ignored.

**Proposed split (strangler, one command per module):**
```
apps/harness/src/cli/
  registry.ts      # one table: name, visibility (front|dev), flags schema, handler, help
  main.ts          # parse → route → handler; top-level error → exitCode 1
  context.ts       # lazily opened kernel (db, log, cardStore, board)
  commands/{home,spec,review,triage,accept,board,doctor,init,plan,gate,gates,
            log,replay,rewind,abort,bake-off,daemon,serve,mcp,acp,research,...}.ts
apps/harness/src/queue/   # (or packages/loop) runQueue(opts): QueueReport — the 790 lines,
  roles.ts  notify.ts  passes.ts  scorecard.ts
```
`front_door.ts` becomes `registry.ts`, extended with handlers so that help, parsing and dispatch cannot drift apart.

### 5. Test quality

- `front_door.spec.ts` is good routing coverage with exact `toEqual` checks. It never runs `main`, though, so every bug above passes it.
- **Missing negative cases:** `--version`, `-v` and `-h` (in practice `--version` is routed as "home", writes files and opens a browser). `main().catch(console.error)` (`index.ts:2080`) **exits 0 on an uncaught error**, and no test checks that. `board --terminal` from `main` is untested.
- `init.spec.ts` tests `runInit` in isolation, but bare `sekhemet` never calls `runInit`.
- No test compares the README's CLI table with `FRONT_DOOR`.
- `cli_gate.spec.ts` and `cli_kernel.spec.ts` use real git and real SQLite on disk, which meets DoD §2A.

### 6. Senior judgement (ranked)

1. **One first run.** Merge `init` into bare `sekhemet` with a single gate deriver. Print the machine, the models and the gates, and ask for one confirmation (`--yes` for scripts). Write `.gitignore`. Resolve the Worker once from config. Only open a browser if the user asks.
2. **Make failure loud.** The top-level catch should set `exitCode = 1`. Handle `--version`. Make `plan` obey `network.mode`.
3. **Split `index.ts`** into the registry above. Move `queue` into a `runQueue` module first, because it carries the most risk.
4. **Add a terminal path for non-developers**: `sekhemet ask "<question>"` for the PM (a proposal; see below).
5. **Add reject/reopen and an undo for accept**, sharing code with the board.

### 7. Verdicts

| File | Verdict |
| --- | --- |
| `index.ts` | **Refactor** (strangler into `cli/` plus `queue/`). Nothing is rebuilt at once. |
| `front_door.ts` | **Keep.** It is the right idea; grow it into the registry. |
| `init.ts` | **Refactor.** Fold it into first run and keep one deriver (the project's own scripts). |
| `doctor.ts` | Keep. Not reviewed in depth. |
| `wave2.ts` | Refactor. The name records build history, not a domain; split it by command. |

---

## Domain 16 — The documents

### 1. Positioning

The owner's thesis is in CLAUDE.md:3, AGENTS.md:4 and the design's positioning paragraph (`HARNESS_DESIGN.md:102-106`). **The locked decisions a reader meets first contradict it:**
- "Target user: Solo developer already running local models" (`:36`)
- "Non-goals for v1: Teams, multi-user boards…" (`:60`)
- "The target user is a solo developer" (`:140`)
- "The model pair… two models" (`:152`), although four roles exist (`:38`)

The design mentions **Seshat zero times**, yet it locks model roles as "never as agents or personas" (`:38`) and rejects "Persona and politeness prompting" (`:3475`). The claims table (`:110-119`) is the only honest positioning artefact. The sibling reviews already flagged the problems with "Runs on your server — Built" and with "100% local" reading as permanent.

### 2. Drift, document against document and design against code

| # | Quote A | Quote B |
| --- | --- | --- |
| 1 | AGENTS.md:96 "No simulated Scrum personas (no fake Standups/Product Owners)" | PM_DESIGN.md:41 "The PM's standup is three sections…"; NAMING.md:32 "Seshat… project-manager persona" |
| 2 | HARNESS_DESIGN.md:496 "*Working*, *Checking* and *Closed*… Those names are retired" | NAMING.md:21 keep list: "Planning · Working · Checking · Done · Parked · Closed" |
| 3 | HARNESS_DESIGN.md:9 "Where either disagrees with this document, this document wins" | docs/README.md:3 "nowhere else is the source of truth"; PM_CONTRACT.md:3 "Change this file first if a shape must change" |
| 4 | docs/README.md:9 "Never keep 'v1' and 'v2' side by side" | `FEATURE_INVENTORY.md`, `_REAUDIT.md` and `_REAUDIT_2.md` all live side by side. The first still says "≈3,600 LOC total" |
| 5 | Design config schema (`:2786-2805`): `models.worker`, `fetch_allow`, `[overnight] hours = "18:00-08:00"`; it lists as *removed* `machine.tier`, `[context]`, `loop.max_rungs`, `review.wip`, `[sync]`, `telemetry.store` | `config.ts:11-46` parses exactly those removed keys and uses `executor`, `allow` and `[machine] hours`. `init.ts` writes `hours = "08:00-18:00"` as "Hours reserved for you", which **inverts** the design's meaning |
| 6 | Design `:2782` "no environment-variable layer… only… `SEKHEMET_CONFIG_DIR`, `SEKHEMET_MODELS_DIR`" | 26 `SEKHEMET_*` variables are read, including `SEKHEMET_ALLOW_UNCONFINED` |
| 7 | Accepted substitutions: keyword pruner, bubblewrap (`:51-53`) | Parity matrix: "SWE-Pruner Pro line pruning (40–60%)", "Seatbelt/Landlock", "100% Local only (llama.cpp / MLX)" (`:221-230`); layout "Linux Landlock/seccomp" (`:3151`) |
| 8 | Claims table: gate host "Built" (`:112`) | Open question: "Gate runner as a separate daemon over mutual TLS, or in-process" (`:3453`) |
| 9 | DoD §2A: real SQLite files | Design "In-Memory SQLite WAL (`:memory:`)… Sub-3-Second Test Suite" (`:3353-3354`). Step 0 fixed CLAUDE.md but not the design |
| 10 | Design `:3153` "ui… React / Tailwind"; AGENTS.md:90 "TanStack Virtual canvas" | `packages/ui` depends only on kernel and board; no React, Tailwind or TanStack anywhere |
| 11 | Design `:3342` `calibrate… writes ~/.sekhemet/config.toml`, `board → opens web UI` | Mostly true, but the list omits the front door entirely. `packages/sdk` is missing from every layout list |
| 12 | README.md:137 names "`Board-Native Local-First AI Coding Harness — Design v2.md`" | The file is `docs/design/HARNESS_DESIGN.md` |
| 13 | AGENTS.md:105 links `file:///Users/brennankelley/Desktop/Sekhemet/DEFINITION_OF_DONE.md` | That path is the **main checkout**, where `main` is **240 commits behind** this branch and still holds the old CLAUDE.md (claude-3-7-sonnet, Gemini relay). `docs.spec.ts:54` skips `file:` links |
| 14 | DEV_LOG.md:1-6 "Multi-Agent Relay Ledger… Claude Opus 5… Zero-Loss Quota Relay Protocol" | AGENTS.md:63 says the relay is retired |
| 15 | PROVENANCE.md licences: "pixelmatch — Library adopted"; "Stryker… Adopted per language"; SWE-Pruner "tool and weights adopted" | `grep` finds no pixelmatch or stryker anywhere in the code, and the pruner is deferred (design `:53`) |
| 16 | NAMING.md:32 "renamed from Seshat" | Renamed to Seshat, so this is a self-reference left by an edit |
| 17 | Design `:3461` "Decisions the founder owns: Product name, license…" | The name is settled (`:64`) and the README says MIT (`:142`) |
| 18 | AGENTS.md:49 `Card:` format `card_<hex4>` | Real IDs look like `story_interface_09809a09` and `card_chron_hasher`, and workstreams use their own IDs |

### 3. Dead and duplicated content

- **Features the design describes that do not exist:** the VS Code extension and TUI (`:352`), Cordis-inspired kernel and plugin manager (`:222`), `MODEL_MATRIX.md` (`:3539`), and the React/Tailwind UI.
- **Research gaps "resolved"** by citations such as "Meta-Task (2026)", "ClarEval (2026)" and an automatic 15% override conversion (`:3444-3448`). These read as built. Not verified; mark them as research, not resolutions.
- **The parity matrix** (`:216-234`) names a "DeepSeek Harness (`dsh`)" that I cannot verify. It says Cursor Agent has no hooks, which I believe is out of date. It is a dated competitive snapshot inside a spec.
- **Duplicated:** the provenance and licence register appears both in the design (`:3493-3539`) and in `PROVENANCE.md`, and the two already differ (the reference copy has ACE and AutoDev rows). "Rejected on evidence" appears three times: the locked decisions (`:43`), deliberate omissions (`:331-341`) and rejected techniques (`:3463-3491`). The goal-criteria map (`:82-96`) is scaffolding left from how the document was written. The author line reads "2026-09-17 · @Someone" (`:3`).
- **Stale numbers:** the README's "183 tests" and 2026-09-18 status (`:8`); Phase 0's "one weekend, no product code" (`:3376`), which is history, not spec.

### 4. Complexity hotspots

The design is 3,537 lines in 50 sections and states no status per section. [BENCH], [RESEARCH] and [DESIGN] tags are its only markers of how finished something is. It declares three companion documents subordinate, but in practice they override it: PM_CONTRACT for shapes, NAMING for vocabulary. Three inventory documents plus MVP_PATH plus the claims table each record "what is built" separately. Four sources of truth for status guarantee drift.

### 5. Test quality

`docs.spec.ts` checks the root-file allowlist, that the index covers every file, and that relative links resolve. Those are real guards and they pass. It does **not** catch anything in the drift table:
- no README ↔ `FRONT_DOOR` check;
- no design config-schema ↔ `config.ts` check;
- no env-var inventory;
- no check that model names exist in the registry;
- it skips `file:` links (`:54`), so #13 slips through;
- no stale-date or banned-term check (#2).

The biggest drift classes are mechanically checkable and unchecked.

### 6. Senior judgement: restructure into a spine plus specs

**`docs/design/SPINE.md`** (about 300 lines):
1. Positioning and the three audiences
2. The four fixed spine rules (from CLAUDE.md)
3. A card's journey: brief → backlog → card → gates → review → accept
4. Roles and models; v1 local and cloud after v1, worded as time-boxed
5. The one PM persona, and why it is the exception to "no personas"
6. A status table with one row per spec, generated from front matter
7. Glossary (links to NAMING)
8. Links to decisions

**`docs/design/specs/*.md`**, each with front matter `status: built|partial|not-built`, `code:`, `tests:`, `open:`:

| Spec | Moves in from HARNESS_DESIGN (plus companions) |
| --- | --- |
| `surface.md` | The surface the user touches; config schema; Extensibility › Commands and headless mode |
| `kernel.md` | System architecture; Data model; Card lifecycle; Event and DB schema; Audit log |
| `worker-loop.md` | Worker loop; Top-model tool semantics; Small-model leverage; Tool catalog › Worker; Repair contracts |
| `context.md` | Context assembly; From spec to scope; Context-rot; Prompt architecture and playbook |
| `gates.md` | Definition of Done layers; Project gates; Gate economics; `gates.toml` format |
| `models.md` | Hardware calibration; Model registry and bake-off |
| `planner-pm.md` | Planner; Goals; Human collaboration; PM_DESIGN Part 2; PM_CONTRACT §2-4 |
| `design-stage.md` | Design stage; New projects; Web research |
| `review-git.md` | The Reviewer; Git workflow |
| `measurement.md` | Measuring the harness; Recursive self-improvement |
| `security.md` | Security and sandboxing; Air-gap kit |
| `integrations.md` | Integrations; GitHub; PM_CONTRACT §5 |
| `extensibility.md` | Extensibility; Skills catalog; MCP/ACP/SDK; hooks |
| `runtime.md` | Sessions and runtime; telemetry and governance |
| `dashboard.md` | User interface; Frontend design system; FRONTEND_DESIGN Parts 2-3; PM_DESIGN Part 3 |

**`docs/design/decisions/`** holds ADRs. The locked decisions, each accepted substitution and each rejected technique become one short record apiece, carrying a status, the evidence, and the condition that would reopen it.

**Removed from the design:**
- the parity matrix, dated, moves to `reference/COMPETITIVE_2026-09.md` or is cut;
- the goal-criteria map (cut);
- build phases (→ MVP_PATH, marked historical);
- open questions (→ `reference/OPEN_QUESTIONS.md` with a state per item);
- the provenance register (PROVENANCE.md is canonical);
- implementation stack, testing and layout (cut; they contradict the DoD and the code);
- INTEGRATION_REVIEW (→ `reference/`, as a dated review);
- the three FEATURE_INVENTORY files (→ the spec front matter; delete them, git keeps history).

**Other ranked fixes:**
1. The owner resolves the persona and target-user contradictions in one commit.
2. Merge the branch to `main`, or change the default branch. A clone today gets the wrong CLAUDE.md.
3. Make the drift classes executable (see Top 5).

### 7. Verdicts per document

| Document | Verdict |
| --- | --- |
| HARNESS_DESIGN.md | **Rebuild** as spine plus specs. Keep the content, cut about 25%. |
| FRONTEND_DESIGN.md | Refactor: the gap table and plan go to status; Parts 2-3 go to `dashboard.md` |
| PM_DESIGN.md | Refactor into `planner-pm.md` and `dashboard.md` |
| PM_CONTRACT.md | Keep, and point it at the TypeScript types as the source |
| INTEGRATION_REVIEW.md | Move to `reference/` |
| NAMING.md | Keep; fix #2 and #16 |
| README.md | **Rebuild** its first half: positioning, one install path, current status, front-door CLI |
| AGENTS.md | Refactor: persona rule, absolute links, card-ID format, TanStack |
| CLAUDE.md | Keep |
| DEFINITION_OF_DONE.md | Keep; replace the absolute path on line 3 |
| DEV_LOG.md | Keep; fix the header |
| FEATURE_INVENTORY ×3 | **Cut** once the spec front matter exists |
| MVP_PATH, PHASE0, SUITE_RUNS, PROVENANCE, MODERNIZATION_PLAN | Keep. Correct PROVENANCE's "adopted" rows |

---

## Proposals (the owner decides; nothing is added without a yes)

| Proposal | Licence | Maintenance | Replaces or adds | Why |
| --- | --- | --- | --- | --- |
| **`node:util` `parseArgs`** plus a local registry | Node core | Node core | The three hand-rolled parsers | Typed flags, strict unknown-flag errors, no new dependency. My first choice. |
| `commander` (alternative) | MIT | Very active, the de-facto standard | The same | Built-in help, subcommands, `--version`. Use it only if the owner prefers a library. |
| `@clack/prompts` | MIT | Active (bombshell-dev) | Adds the "one confirmation" first run | A small, accessible TTY confirm and spinner for beginners |
| `execa` | MIT | Active (sindresorhus) | Adds end-to-end CLI tests that spawn the built binary | Catches exit-code bugs such as `--version` and the catch that exits 0 |
| **Vale** | MIT | Active (errata-ai) | Adds a prose linter in the gate | Banned terms (retired state names, "persona" rules, "Design v2.md"), voice rules |
| `markdownlint-cli2` | MIT | Active | Structural lint for the docs | Consistent headings for the specs' front matter |
| **MADR** ADR template | MIT/CC0 (dual; verify) | Maintained | Adds `decisions/` | Locked, substituted and rejected become auditable records with reopen conditions |
| VitePress or Astro Starlight | MIT | Active | Optional rendered docs site | Only after the restructure; renders the status tables |
| **Feature: `sekhemet ask "<q>"`** | — | — | Adds the PM in the terminal | Non-developers and SSH users; it reuses `answerQueued` |
| **Feature: `reject`/`reopen`, `accept --undo`** | — | — | Completes the lifecycle | Design `:194` and `:510` |
| **Feature: `docs.spec` executable checks** | — | — | Extends the existing test | README ↔ `FRONT_DOOR`, config schema ↔ `config.ts`, `SEKHEMET_*` inventory, model names ↔ registry, `file:` links |

---

## Top 5 changes across both domains

| # | What | Why (evidence) | Effort | Risk | How measured |
| --- | --- | --- | --- | --- | --- |
| 1 | **One first run, one gate deriver.** Bare `sekhemet` = check the machine and toolchain, print the models and gates, confirm once, write `.gitignore`, respect `network.mode`; plus `--version` and a catch that exits non-zero | Three setup paths; pnpm and no typecheck on an npm repo; `--version` runs setup and opens a browser; the Worker depends on the path; `plan` goes online; `index.ts:2080` exits 0 on error | M | Low: the scripts call dev commands, which are unchanged | A new e2e spec runs the binary in a temp npm repo and a temp pnpm repo and asserts the files, exit codes and output. Time-to-first-card timed by hand for a new user |
| 2 | **Owner resolves the positioning contradictions, then `main` is updated.** Locked decisions (target user, teams non-goal, "in v1" wording), the persona exception for Seshat in the design, AGENTS and NAMING; NAMING state names | Drift #1, #2, #13; `HARNESS_DESIGN.md:36,38,60,140` | S (owner time) | Low | A Vale rule or docs.spec check for the banned phrases; `git rev-list main..HEAD` = 0 |
| 3 | **Split `index.ts`**: move `queue` into `runQueue()` first, then a command registry | `main()` is ~1,600 lines; `queue` ~790; three parsers; `process.argv` bug at `:620` | L (strangler, 4-6 cards) | Medium: `queue` is the suite's path. Do it only between suite runs, with the frozen suite as characterization | `index.ts` under 150 lines; cognitive complexity per file; frozen-suite score unchanged; tests unchanged |
| 4 | **Design → SPINE.md plus 15 specs with status front matter, plus ADRs.** Delete the three inventories and the duplicated registers | 3,537 lines; four status sources; drift #4-#11, #15 | L (mostly moving text; about 3 sessions) | Medium: link rot (docs.spec catches it) and lost nuance | SPINE ≤ 300 lines; every spec has a status; the claims table is generated; the drift table re-audited to 0 open items |
| 5 | **Make doc drift executable.** Extend `docs.spec.ts` with README ↔ `FRONT_DOOR`, config schema ↔ `config.ts` keys, the `SEKHEMET_*` inventory in `surface.md`, model names ↔ registry, and checked `file:` links; rewrite the README's first half | Drift #5, #6, #12, #13 and the README table; today's spec catches none of them | M | Low | Seed each known drift and confirm the spec fails; afterwards the gate stays green |

*Uncertainty:* I did not run `doctor` or the queue. I could not verify "DeepSeek Harness", "SWE-Pruner Pro", "Meta-Task (2026)" or "qwen3.8-27b" from the repository. I believe the claim that Cursor Agent has no hooks is outdated but did not check it this session. Whether the template's missing `protected` list is covered by the permission engine's defaults was not traced.
