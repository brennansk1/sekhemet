# CLAUDE.md — working on Sekhemet

Sekhemet is **a coding harness for professional teams**: it runs the whole professional process — a brief, a planned backlog on a board teams already know, cards built by a local model against executable gates, and a person's acceptance — on your own machine. It teaches beginners the practice, and non-developers can simply talk to its PM. TypeScript, pnpm monorepo, local models only in v1.

**Read first, every session:** the Executive Status Summary at the top of `DEV_LOG.md`, then `docs/reference/MODERNIZATION_PLAN.md` (what we are doing now and in what order), then `DEFINITION_OF_DONE.md`. The design starts at `docs/design/SPINE.md`, with one specification per subsystem in `docs/design/specs/` and every settled decision in `docs/design/DECISIONS.md`; `docs/README.md` indexes every document.

## The spine — fixed; ask the owner before changing any of it

- Gates decide completion; the model never certifies its own work.
- The event log is the only durable channel (content erased by a recorded `ledger/erased` event is named as a gap on replay).
- A card is the unit of work.
- The human is the rate limiter.

## How to work here

- **Evidence first.** A change is triggered by a failing card, a replay, a measurement or a review finding, and its commit names that evidence.
- **The design stays the truth.** A workstream starts from its specification in `docs/design/specs/` and updates it in the same commit as the code — behaviour, status and contract together (DEFINITION_OF_DONE §5.2–5.4).
- **Smallest change that removes the failure.** Split a large file only when you are already working inside it, behind tests (strangler fig, never a big-bang rewrite).
- **Never make a result look better by redefining it.** Loosening a gate, weakening a test or editing the frozen suite are not improvements.
- **Tests first** for new behaviour: write the failing test, see it fail, then implement.
- **Builders do not grade themselves.** Get an independent review of each workstream before committing it.
- **Context hygiene.** Send wide code reading to subagents and keep their digests; at most three agents at once (the lead and two helpers, plus a short-lived reviewer), on disjoint files; keep judgement work yourself. One workstream per session.
- **Sanity-check every number.** A 0% has been a URL typo, a 100% eleven easy cases, identical hashes a hashed constant, and an "exit 0" the exit code of `tail`. One trial at non-zero temperature is not a finding. Withdraw claims the evidence does not support.
- **End every session by saying where the cards stop**, and record it in `DEV_LOG.md`.

## Speed, quality and cost — the balance the owner set (2026-09-25)

The goal is the fastest route to a professional product. Quality has a fixed floor; speed and token cost are optimised above it.

- **The quality floor never moves:**
  - tests first;
  - the spec updated in the same commit;
  - **one full independent review per workstream**;
  - `pnpm gate` on the exact tree committed;
  - the frozen suite untouched;
  - no gate loosened.
- **Speed: never idle.**
  - Run disjoint streams in parallel.
  - Model runs use a frozen snapshot build (`git worktree` at a commit, own `dist/`), so later workstreams proceed on main while a measurement runs.
  - The machine and its memory are the bottleneck, not agents.
- **Token cost:**
  - **A fresh helper per workstream**; never resume a helper for unrelated work.
  - Briefs of about 15 lines citing spec change ids; digests of about 10 lines.
  - Re-review only a fixed blocker; the lead fixes minors without another review round.
  - A cheaper model for mechanical work (doc rows, narrow confirmation checks, formatting); the strongest model for design, implementation and the main review.
  - **A fresh lead session after each workstream commit**, resuming from `DEV_LOG.md`.
  - Little narration between steps.
- **Memory (24 GB):**
  - While a model is loaded, tests run with `--pool=forks --poolOptions.forks.maxForks=1` on changed files only.
  - Never run `vitest run` with an empty file list: it runs the whole suite.
  - Full gates run on a snapshot, in a gap between model runs or with at most two workers.
- **Commit from the gated tree:** build the commit from the snapshot the gate passed (plus `DEV_LOG.md`), so edits made meanwhile never slip in, then fast-forward main (DEC-10).

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

Packages in dependency order: `kernel` → `sandbox` → `sync` → `models` → `gates` → `context` → `loop` → `board` → `planner` → `eval` → `ui` → `apps/harness`. Node 26 (22.13+ supported: the built-in `node:sqlite` without a flag), `node:sqlite` in WAL mode, Biome, Vitest. Tests for `kernel`, `board`, `sandbox` and `sync` use real SQLite files, real subprocesses and real git worktrees (DEFINITION_OF_DONE §2A). Workspace packages resolve each other through `dist/`, so a change in one package is seen by another only after `tsc -b`.

## Operations

The procedure for model runs, memory checks, the frozen suite, experiment switches and the Linux VM is in `docs/reference/DEVELOPING.md`, parameterised by `$SEKHEMET_MODELS_DIR` and `$LIMA_HOME`. This machine's own values — its memory, the Worker's folder, its Lima home, its shell — are in `CLAUDE.local.md`, which git ignores (DEC-54 c2) and which is imported here when it exists:

@CLAUDE.local.md
