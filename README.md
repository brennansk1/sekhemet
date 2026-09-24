# Sekhemet — a coding harness for professional teams

Sekhemet runs the whole professional process on your own machine: a brief, a
planned backlog on a board teams already know, cards built by a **local** model
against executable gates, and a person's acceptance. Developers get a familiar
board with evidence on every card; beginners learn the practice as they go;
non-developers talk to the project manager, Seshat, to start a project and ask
how it is going.

> **Status, 2026-09-22.** The core runs end to end and is tested (1,164 tests,
> all green), but v1 is **not done**: the Opus 5.5 review found safety, spine and
> measurement gaps that come first. What is built, per subsystem, is in the
> status table of [`docs/design/SPINE.md`](docs/design/SPINE.md); what done means
> is [`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) §6; the latest measurement
> is in [`docs/reference/SUITE_RUNS.md`](docs/reference/SUITE_RUNS.md).

## Start

```bash
sekhemet                    # set up on first run, then open the board
sekhemet "<what you want>"  # plan the work and run it
sekhemet run [card]         # run a card, resume a stopped one, or run the queue
sekhemet review             # the next card waiting on you
sekhemet accept <card>      # accept and merge (also: send-back, park, unpark)
sekhemet board              # the board (--terminal for text)
sekhemet doctor             # check the install, including the model weights
sekhemet dev <command>      # everything for developing the harness itself
```

From a checkout, `sekhemet` is `node apps/harness/dist/index.js` (or `pnpm sekhemet`).

## How a card runs

1. **Worktree.** The card gets its own git worktree and branch
   (`sekhemet/<project>/<card>-<slug>`); dependencies are symlinked in and build
   output is excluded from its diff.
2. **Contract first.** The card's acceptance tests are staged into the worktree
   before the first turn, so its gate measures that card and nothing else.
3. **Closed loop.** Each turn the model sees the card's spec and numbered
   acceptance criteria, the repository map, the pinned acceptance tests and scope
   files, what it has already written and read, and the typed failure from the
   last gate run. Tools return observations it acts on next turn.
4. **Gates.** `finish_card` runs every blocking gate declared in
   `.sekhemet/gates.toml` (hash-pinned; a changed file aborts verification).
   Failures come back typed: location, expected, actual, and the exact command
   that reproduces them.
5. **Repair ladder.** Failed verification escalates by strategy, not temperature:
   direct repair (2 attempts), fresh context (1), a written edit sketch (1), then
   stop for a human. With a manager model configured, failed cards are reviewed
   in one batch and retried with a repair plan.
6. **Evidence.** Every attempt writes an evidence bundle (diff, per-gate results,
   failures, turns, tokens, model settings) and a full transcript. A passing card
   moves to Review — the harness verifies, a person accepts.

## Safety model

These are enforced, and each is covered by tests that attempt the violation:

- **OS sandbox.** On macOS every command runs under `sandbox-exec` with a
  generated Seatbelt profile: writes only inside the worktree and a private
  scratch directory, never to its git metadata or the linked dependencies;
  network egress denied. Git runs with hooks and fsmonitor disabled. The
  parent environment is not inherited (an allowlist is passed instead).
  `sekhemet doctor` proves confinement with a live escape attempt.
- **Permission tiers.** Deny always wins: path traversal (symlink-resolved),
  writes outside the card's declared scope, edits to protected paths (tests for
  the implementer role, `gates.toml`, the harness's own loop, gate and sandbox
  sources). Destructive and network commands need an approver.
- **Parse gate.** A write that would turn a parseable source file unparseable is
  refused before it reaches disk, with the exact location.
- **Memory guard.** A turn is refused once swap exceeds 3 GB or grows 2 GB within
  a card; the card stops with a resumable reason instead of taking the machine
  down. Models are unloaded on every exit path.

## Models

One model is resident at a time; `ModelRouter` unloads before it loads.

| Role | Default | Notes |
|---|---|---|
| Worker | `--worker cyber-tiel` | Cyber-Tiel-Coder 35B-A3B MTP (IQ3_XXS) under a harness-managed llama-server with its MTP head; 26–32 tok/s on an M4 / 24 GB |
| Worker (alt) | any Ollama tag | e.g. `nail-35b-a3b-ctx` |
| Manager | `--manager <ollama model>` | Reviews failed cards in one batch and writes repair plans |

Tool calls use the server's native tool schema, with text parsing (JSON, fenced
JSON, `name(key="value")` call syntax, SEARCH/REPLACE patches) as a fallback.
Reasoning is suppressed and stripped before parsing. See `docs/research/MODEL_CANDIDATES.md`
for the model research, with every benchmark number sourced.

## Quickstart

Requirements: Node 22.13+ (tested on 26), pnpm, git, and a local inference server
(Ollama, or llama.cpp's `llama-server`).

```bash
pnpm install
pnpm build
pnpm test
node apps/harness/dist/index.js doctor
```

`doctor` probes real state and can fail; for example, on the reference machine:

```
  ✓ Unified memory: 11.1 GB free of 24.0 GB (54% used, normal)
  ✓ Local inference socket: http://127.0.0.1:11434 reachable — 22 model(s): …
  ✓ Git worktree isolation: 2 worktree(s) registered
  ✓ Sandbox confinement: seatbelt active — escape probe refused (exit 1)
  ✓ Node runtime: v26.0.0
```

## Every command

The front door above covers daily use; these are the underlying commands, run as `node apps/harness/dist/index.js <command> [--repo <path>]`.

| Command | What it does |
|---|---|
| `doctor` | Probe memory, inference server, worktrees, sandbox containment, toolchain |
| `board` / `log` | Terminal board; the SHA-256 hash-chained event log |
| `plan <spec>` | Decompose a spec into cards |
| `run <card>` | Execute one card end to end |
| `queue [--auto-accept] [--worker m] [--manager m]` | Run every Ready card on one warm model; escalate failures to a manager |
| `accept <card>` | Squash-merge a reviewed card to `main` |
| `gate` | Run the verification gates in the current repository |
| `bake-off --workers a,b [--fixture f] [--manager m]` | Run a release-gate fixture once per worker and compare scorecards |
| `serve` | Dashboard on http://127.0.0.1:4040 (board, evidence, review triage) |
| `mcp` | stdio MCP server: `sekhemet_list_cards`, `sekhemet_create_card`, `sekhemet_get_events`, `sekhemet_doctor` |

## Release gates

`fixtures/` holds target projects the harness must build autonomously, each with
contract-first acceptance tests. `scripts/run_gate.sh <fixture> [queue args]`
runs one from a clean scratch repository.

- **Chronicle** — a cryptographic event ledger, 6 cards. Bar: at least 5 of 6 pass
  on the first attempt, repairs within 3 rungs, zero test mutation, zero
  out-of-scope writes, under 18 minutes. Specified in
  `docs/benchmarks/CHRONICLE_SPEC.md`.
- **Showcase Trifecta** — Onyx, Basalt Canvas, Vanguard; 24 cards. Specified in
  `docs/benchmarks/SHOWCASE_TRIFECTA_SPEC.md`.

## Repository

| Path | Contents |
|---|---|
| `packages/kernel` | Event log (hash chain, canonical JSON), card store, lifecycle hooks, TOML |
| `packages/sandbox` | Seatbelt executor, permission engine, globs |
| `packages/sync` | Worktrees, checkpoints, diffs, squash-merge |
| `packages/models` | Inference adapters, tool-call parsing, model router, memory guard |
| `packages/gates` | gates.toml, gate runner, typed failure parsers, evidence bundles |
| `packages/context` | Prompt zones, repo map, output condensing, playbook, skills |
| `packages/loop` | Tool executor, parse gate, session, repair ladder, card runner, manager |
| `packages/board`, `planner`, `eval`, `ui` | Board rules, decomposition, benchmarks, design tokens |
| `apps/harness` | CLI, dashboard server, MCP server |

Design and process documents: the design starts at `docs/design/SPINE.md`, with
one specification per subsystem in `docs/design/specs/`; `DEFINITION_OF_DONE.md`,
`AGENTS.md`, `DEV_LOG.md`; `docs/README.md` indexes everything.

## License

MIT
