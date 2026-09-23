# CLAUDE.md — working on Sekhemet

Sekhemet is **a coding harness for professional teams**: it runs the whole professional process — a brief, a planned backlog on a board teams already know, cards built by a local model against executable gates, and a person's acceptance — on your own machine. It teaches beginners the practice, and non-developers can simply talk to its PM. TypeScript, pnpm monorepo, local models only in v1.

**Read first, every session:** the Executive Status Summary at the top of `DEV_LOG.md`, then `docs/reference/MODERNIZATION_PLAN.md` (what we are doing now and in what order), then `DEFINITION_OF_DONE.md`. The design starts at `docs/design/SPINE.md`, with one specification per subsystem in `docs/design/specs/` and every settled decision in `docs/design/DECISIONS.md`; `docs/README.md` indexes every document.

## The spine — fixed; ask the owner before changing any of it

- Gates decide completion; the model never certifies its own work.
- The event log is the only durable channel.
- A card is the unit of work.
- The human is the rate limiter.

## How to work here

- **Evidence first.** A change is triggered by a failing card, a replay, a measurement or a review finding, and its commit names that evidence.
- **The design stays the truth.** A workstream starts from its specification in `docs/design/specs/` and updates it in the same commit as the code — behaviour, status and contract together (DEFINITION_OF_DONE §5.2–5.4).
- **Smallest change that removes the failure.** Split a large file only when you are already working inside it, behind tests (strangler fig, never a big-bang rewrite).
- **Never make a result look better by redefining it.** Loosening a gate, weakening a test or editing the frozen suite are not improvements.
- **Tests first** for new behaviour: write the failing test, see it fail, then implement.
- **Builders do not grade themselves.** Get an independent review of each workstream before committing it.
- **Context hygiene.** Send wide code reading to subagents and keep their digests; at most three agents at once, on disjoint files; keep judgement work yourself. One workstream per session.
- **Sanity-check every number.** A 0% has been a URL typo, a 100% eleven easy cases, identical hashes a hashed constant, and an "exit 0" the exit code of `tail`. One trial at non-zero temperature is not a finding. Withdraw claims the evidence does not support.
- **End every session by saying where the cards stop**, and record it in `DEV_LOG.md`.

## Commits

Run `pnpm gate` before every commit. Every commit ends with:

```
Card: <card or workstream id>
Agent-Model: <exact model id, e.g. claude-opus-5-5>
Agent-Harness: claude-code
Agent-Role: lead-driver | implementer | reviewer
GateStatus: pass | fail | partial | suspended-quota
Co-Authored-By: <the attribution line the harness gives>
```

## Commands

```bash
pnpm install
pnpm gate                 # tsc -b && biome check . && vitest run — before every commit
pnpm release-gate         # gate + doctor + dashboard + MCP — before any release
pnpm test -- <filter>     # targeted tests
pnpm format               # biome check --write .
pnpm sekhemet <command>   # the CLI (node apps/harness/dist/index.js)
node scripts/run_suite.mjs --worker cyber-tiel --out <file>   # the frozen suite
```

## Layout

Packages in dependency order: `kernel` → `sandbox` → `sync` → `models` → `gates` → `context` → `loop` → `board` → `planner` → `eval` → `ui` → `apps/harness`. Node 26 (20+ supported), `node:sqlite` in WAL mode, Biome, Vitest. Tests for `kernel`, `board`, `sandbox` and `sync` use real SQLite files, real subprocesses and real git worktrees (DEFINITION_OF_DONE §2A). Workspace packages resolve each other through `dist/`, so a change in one package is seen by another only after `tsc -b`.

## Operations — this machine

- **24 GB host; the Worker is 13 GB.** Check `ollama ps` and `memory_pressure -Q` before loading a model; unload after. The harness's own memory guard stops a card when swap passes 6 GB.
- **The Worker is Cyber-Tiel-Coder-35B-A3B MTP (IQ3_XXS)** on `/Volumes/My Passport/AI-Models/llm/`. Start its server once — the arguments come from `createCyberTielWorker().launchArgs()`, port 8098, `--spec-type draft-mtp` — and every card attaches to it. Loading from the USB drive takes about five minutes. Set `SEKHEMET_MODELS_DIR` to that directory.
- **Never run `tsc -b` or `pnpm gate` during a suite run**: each card is a fresh process and would load a different build.
- **Experiment switches**, recorded in every evidence bundle: `SEKHEMET_THINKING=off|surgical|all`, `SEKHEMET_WORKER_METHOD=baseline|strict`.
- The shell's `grep` wrapper can hide matches: when a search comes back empty, retry with `/usr/bin/grep -a`. On macOS `/tmp` is `/private/tmp`.
