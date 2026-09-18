# CLAUDE.md — Claude Code Operational Guide for Sekhemet

## Project Overview
Sekhemet is a board-native, local-first AI coding harness written in TypeScript as a pnpm monorepo. It features an event-sourced SQLite WAL kernel, executable verification gates, a TanStack Virtual dual-axis kanban, and 100% local inference support.

For complete multi-agent specifications, read [AGENTS.md](file:///Users/brennankelley/Desktop/Sekhemet/AGENTS.md).

---

## 1. Mandatory Git Commit Trailers
You **must never** commit without multi-agent attribution trailers. Every commit you produce must end with:

```git
<type>(<package>): <concise description>

Card: <card_id>
Agent-Model: claude-3-7-sonnet-20250219
Agent-Harness: claude-code
Agent-Role: lead-driver | implementer | delegator
Co-authored-by: Claude <claude@anthropic.com>
Co-authored-by: Gemini <gemini@antigravity.google>
```

For checkpoints, include `Step: X/Y` and `GateStatus: pass|fail|partial|suspended-quota`.

---

## 2. Collaboration Protocol with Gemini

You are the **Lead Driver & Delegator**. Gemini acts as your **Architect, Test Author, and Relay Finisher**:

1. **Card Planning & Sizing**:
   - Keep cards strictly $<200$ LOC diff across 1–3 files.
   - Decompose features using SPIDR (Spike, Path, Interface, Data, Rule).
2. **Contract-First TDD**:
   - Before writing implementation code in `packages/<name>/src`, verify that interfaces in `types.ts` and failing tests in `tests/*.spec.ts` exist.
   - If tests do not exist, draft them first (or request Gemini generate them) and verify they fail (`RED`).
   - Never modify test assertions to force a passing gate.
3. **The Quota Wall / Rate-Limit Relay Handoff**:
   - If you are approaching rate limits or token exhaustion, commit all work in progress immediately:
     ```git
     checkpoint: card execution suspended due to rate limit

     Card: card_xxxx
     Step: 3/8
     Agent-Model: claude-3-7-sonnet-20250219
     Agent-Harness: claude-code
     Agent-Role: lead-driver
     GateStatus: suspended-quota
     Co-authored-by: Claude <claude@anthropic.com>
     ```
   - Gemini will detect this state, act as **Relay Finisher**, complete the failing test rungs, run gates to green, and create the merge commit.
   - When your quota resets, simply check `git log -n 5` to inspect the relayed work and resume the next card.

---

## 3. Tooling & Commands

```bash
# Workspace setup
pnpm install

# Build & Typecheck
pnpm build
pnpm typecheck

# Testing (Vitest)
pnpm test
pnpm test -- filter-term

# Code Hygiene
pnpm lint          # Biome check
pnpm format        # Biome format --write
```

---

## 4. Architecture & Package Hierarchy
Implementation strictly follows this topological order:
`kernel` -> `sandbox` -> `sync` -> `models` -> `gates` -> `context` -> `loop` -> `board` -> `planner` -> `eval` -> `ui` -> `apps/harness`.

- **Runtime**: Node.js 20+ (current system: Node 26)
- **Package Manager**: pnpm workspaces
- **Database**: `better-sqlite3` with WAL mode (`journal_mode = WAL`, `synchronous = NORMAL`)
- **Linter/Formatter**: Biome (`biome.json`)
- **Test Runner**: Vitest with isolated in-memory SQLite fixtures (`:memory:`)
