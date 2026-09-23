# AGENTS.md — Sekhemet Repository Guidelines & Multi-Agent Protocol

Welcome to **Sekhemet**.
This repository is **a coding harness for professional teams**: it runs the professional process — brief, planned backlog, cards built by a local model against executable gates, human acceptance — on the user's own machine, pairing small local models with a kanban teams already know, executable gates and an event-sourced SQLite WAL kernel.

This document defines the mandatory development rules and commit attribution standards for any agent working here. What to work on now is in [docs/reference/MODERNIZATION_PLAN.md](docs/reference/MODERNIZATION_PLAN.md). The design starts at [docs/design/SPINE.md](docs/design/SPINE.md); each subsystem has a specification in `docs/design/specs/`, and a workstream starts from its spec.

---

## 1. Mandatory Git Commit Attribution Standard

Every single commit in this repository—whether an intermediate checkpoint commit or a squashed merge commit—**MUST** include structured Git trailers detailing which LLM performed the work, what harness was used, what role it assumed, and proper co-authorship.

### A. Intermediate Checkpoint Commits
During active card execution, every incremental rung completion or gate attempt must be committed to the card's worktree / checkpoint branch:

```git
checkpoint: step 4 passed lint and typecheck

Card: card_8f21
Step: 4/10
Agent-Model: claude-opus-5-5
Agent-Harness: claude-code
Agent-Role: implementer
GateStatus: pass
Co-authored-by: Claude <claude@anthropic.com>
```

### B. Final Squashed Merge Commits
When a card clears all verification gates and is merged into `main` (or integration branch), it must follow Conventional Commits and explicitly attribute all contributing models:

```git
feat(kernel): implement hash-chained event log writer

Card: card_8f21
Agent-Model: claude-opus-5-5
Agent-Harness: claude-code
Agent-Role: implementer
GateStatus: pass
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Every commit — checkpoint or merge — carries `GateStatus` (DEFINITION_OF_DONE §7, decided 2026-09-22).

### Standard Trailer Schema

| Trailer Key | Allowed Values / Format | Description |
| :--- | :--- | :--- |
| `Card:` | the card's id (e.g. `card_chron_hasher`) or a workstream id (e.g. `modernization-phaseA-record`) | What the commit is for |
| `Step:` | `<index>/<total>` (e.g. `4/10`) | Execution rung index (for checkpoints) |
| `Agent-Model:` | `claude-opus-5-5`, `gemini-2.5-pro`, etc. | Exact model ID that generated the patch |
| `Agent-Harness:` | `claude-code`, `antigravity-cli`, `cursor-agent`, `sekhemet` | Harness/CLI executing the agent |
| `Agent-Role:` | `lead-driver`, `implementer`, `reviewer`, `architect`, `test-author` | Role performed in this specific commit |
| `GateStatus:` | `pass`, `fail`, `partial`, `suspended-quota` | Status of automated gate checks |
| `Co-authored-by:` | `Name <email>` | Standard Git co-author trailer |

---

## 2. Working with several agents

Claude is the lead: it plans, judges, reviews and commits. Other agents — Claude subagents, or Gemini through the Antigravity CLI — may take well-scoped work on **disjoint files**, at most three at once, and their output is verified by the lead (`pnpm gate`, and a read of the diff) before it is committed. Builders do not grade themselves: every workstream gets an independent review before it lands.

The earlier Claude-to-Gemini *relay protocol* (Gemini finishing work when Claude hit a quota) is retired as of 2026-09-22. The handoff between sessions is the Executive Status Summary in `DEV_LOG.md`.

---

## 3. Engineering Invariants & Code Standards

All agents working on Sekhemet must strictly uphold these engineering laws:

1. **Contract-First Card Sizing**:
   - Every card touches at most **1–3 files** and **$<200$ LOC diff**.
   - Acceptance tests are written **first** and must fail before implementation begins.
   - **Test Immutability**: The implementer is strictly forbidden from modifying test fixtures to make tests pass. Only the test author or human may update assertions.
2. **Local Inference in v1**:
   - Every model role runs locally in v1 (Ollama, llama.cpp, MLX). No cloud API dependency at runtime. Cloud models per role are planned after v1 (DEC-03).
3. **Topological Package Dependency Order**:
   All packages must be implemented according to the acyclic dependency graph:
   ```
   kernel (event log, SQLite WAL)
     └── sandbox (process isolation: Seatbelt, bubblewrap; permission engine)
           └── sync (git worktrees, checkpoints, remotes)
                 └── models (local inference adapters, arm selection)
                       └── gates (deterministic verification rungs)
                             └── context (repo map, AST pruning, budgeter)
                                   └── loop (executor, recovery, stall detection)
                                         └── board (kanban state, SPIDR planner)
                                               └── planner (decomposition, estimation, replanning)
                                                     └── eval (the frozen suite, bake-off, statistics)
                                                           └── ui (dashboard tokens, vocabulary, build-free web modules)
                                                                 └── apps/harness (CLI entrypoint)
   ```
4. **Deterministic Gate Verification**:
   - Agent self-certification is rejected. A card only transitions to `Review` when automated verification gates return exit code 0 (`tsc --noEmit`, `vitest run`, `biome check`).
5. **No Prohibited Patterns**:
   - No agents role-playing a team to each other: the Worker, Planner, Reviewer and Researcher are registry roles with no names or conversations. Standups, retrospectives and status are reports for people, written by the one persona, Seshat the project manager (docs/design/DECISIONS.md, DEC-05).
   - No parallel file writes without worktree isolation.
   - No unbounded best-of-N sampling.
   - No vector embedding code RAG (use deterministic Tree-sitter + repo map + LSP).
6. **Anti-Shallow Development & Testing Invariant (`DEFINITION_OF_DONE.md`)**:
   - **Zero Vanity Testing:** No synthetic mocks for core runtime systems (must test against real native SQLite WAL, real OS child processes, real git worktrees).
   - **Mandatory Fault Injection:** Every module must have negative test cases verifying behavior under malformed inputs, permission violations, and disk/hash tampering.
   - **Deep Structural Assertions:** Trivial `toBeDefined()` smoke tests are banned. Tests must assert exact values, complete schemas, and cryptographic hash chains.
   - **Subsystem Completeness:** Zero stubbed or naive implementations; full production enforcement of three-tier permissions, 10 lifecycle hooks, AST symbol tools, and RTK context condensing.
   - All code must pass the binding criteria defined in [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md).

---

## 4. Key Developer Commands

```bash
pnpm install
pnpm gate            # tsc -b && biome check . && vitest run — before every commit
pnpm release-gate    # gate + doctor + dashboard + MCP — before any release
pnpm test -- <filter>
pnpm format
```
