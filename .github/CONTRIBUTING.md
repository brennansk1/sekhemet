# Contributing to Sekhemet

Thank you for your interest. Sekhemet is built in the open, one workstream at a time, and this page says what you can contribute today and how the work is done.

## What is welcome now

From the public pre-release 0.9.0:

- **Bug reports,** through the bug form in [Issues](https://github.com/brennansk1/sekhemet/issues/new/choose), with the folder `sekhemet doctor --report` writes ([SUPPORT](SUPPORT.md)).
- **Questions and ideas,** in [Discussions](https://github.com/brennansk1/sekhemet/discussions).
- **Benchmarks:** your run profile and the frozen suite's hash, in Discussions.
- **Corrections to the docs and to the comparison table** in the README, as an issue.

Vulnerabilities are reported privately, never in an issue: [SECURITY](SECURITY.md).

## Code contributions: not yet

Pull requests from outside the project cannot be accepted yet. Sekhemet is licensed under the Functional Source License (FSL-1.1-ALv2), which is source-available, not open source, and the licensor keeps the commercial rights it reserves. Accepting outside code needs a contributor licence agreement that lets the licensor keep those rights, and the maintainer is taking legal advice on its text first. Until it exists, please describe the change you would make in an issue or a discussion instead; a good description is often all a fix needs. This page will say when code contributions open, and how.

## How the work is done

Whoever writes the code — the maintainer or an AI agent working for them — follows the same rules. They are in [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md), and the [Definition of Done](../DEFINITION_OF_DONE.md) says what finished means.

- **Gates decide completion; the model never certifies its own work.** Nothing is done until its checks pass and a person accepts it.
- **Tests first.** Write the failing test, see it fail, then implement. Tests for the kernel, the board, the sandbox and sync use real SQLite files, real subprocesses and real git; new behaviour gets a test through a door a person uses (the built command, HTTP against a real server, a browser).
- **The design stays the truth.** A change starts from its specification in [docs/design/specs/](../docs/design/specs/README.md) and updates it in the same commit: behaviour, status and contract together. Every settled decision is in [DECISIONS.md](../docs/design/DECISIONS.md).
- **Smallest change that removes the failure,** triggered by evidence (a failing issue, a replay, a measurement or a review finding), which the commit names.
- **Never make a result look better by redefining it.** No check is loosened, no test weakened, and the frozen suite is never edited.
- **An independent review** of each workstream before it is committed.
- **`pnpm gate` green** (`tsc -b`, Biome and Vitest) on the exact tree committed.

## Working on the code

```bash
git clone https://github.com/brennansk1/sekhemet.git
cd sekhemet
pnpm install
pnpm build
pnpm gate
```

`pnpm test -- <filter>` runs a subset; `pnpm format` formats. The packages, in dependency order, are `kernel`, `sandbox`, `sync`, `models`, `gates`, `context`, `loop`, `board`, `planner`, `eval`, `ui` and `apps/harness`; each resolves the others through their built `dist/`, so run `pnpm build` after changing one.

**Documentation.** Every document under `docs/` is listed in [docs/README.md](../docs/README.md), and a test fails for one that is not. Parts of the user guide are generated from the product's own tables: after changing a command, a `doctor` check, a host Sekhemet contacts or an editor snippet, run `node scripts/gen_docs.mjs`.

**Words.** Sekhemet uses the industry's words — issue, Assignee, Request changes, Activity log, Put on hold — as [NAMING.md](../docs/design/NAMING.md) lists them. It is *source-available* and *Fair Source*, never *open source*.

**Commits** end with trailers naming the issue or workstream, the model and harness that wrote it, its role and the gate's status:

```
Card: <issue or workstream id>
Agent-Model: <exact model id, or "human">
Agent-Harness: <the tool, or "none">
Agent-Role: lead-driver | implementer | reviewer
GateStatus: pass | fail | partial
```

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
