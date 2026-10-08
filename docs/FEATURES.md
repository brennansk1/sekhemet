# Sekhemet's features

The full feature catalogue, moved here from the [README](../README.md) on 2026-10-07 and brought up to date with [MILESTONES.md](reference/MILESTONES.md) and the [DEV_LOG](../DEV_LOG.md). The per-capability truth is in each specification's *State today* table ([specs/](design/specs/README.md)); where this page and a spec disagree, the spec wins.

Status marks: no mark means built and tested; **(partial)** means built in part, or built but not yet proven with a live model.

## Why Sekhemet

Most coding assistants give you a chat window and a diff. Whether the result has a plan, tests, reviewable increments and a definition of done depends on you. That works for someone who already practises software engineering. For everyone else it produces code that is hard to bring into a team's workflow.

Sekhemet runs the process itself. The professional move is the easy one because the tools, the loop, the refusals and the checks are built that way, not because a prompt asks the model to be careful.

| Audience | What they get |
| --- | --- |
| **Professional developers** | A board with familiar columns, issue types and keys (`CHR-7`); issues with their checks and activity; review in minutes |
| **Juniors learning the practice** | *Tips* that explain the practice where it happens (what a WIP limit is for, why a story is sliced thin, what done means), and that experts switch off |
| **Non-developers** | A conversation with Seshat to start a project and to ask how it is going, and a Status page in plain words |

**Local and private.** Every model runs on your machine or your team's server. The network is off by default; research, git remotes and sync are opt-in and logged. Sekhemet sends no telemetry.

## How it works, in detail

1. **Seshat and the brief.** Seshat asks only what the request needs: a calculator needs no consultation, a payments service does. The brief lists requirements as *Must have*, *Should have* and *Could have*, and *Later* for what is out of the release.
2. **The plan and the board.** The planner turns the brief into epics and thin vertical stories. Each issue traces to a requirement, has checkable acceptance criteria and red-first acceptance tests, and appears on the board.
3. **The Coding model works each issue.** One issue owns one git worktree, one branch, one declared file scope and one budget. The model finds, edits and verifies in small steps inside an OS sandbox, with a context assembled fresh for that issue.
4. **Checks.** Tests, types, lint, security scans and, for web projects, visual and accessibility checks. They are declared in `.sekhemet/gates.toml`, hash-pinned, and the model cannot edit them. Failures come back typed: location, expected, actual, and the command that reproduces them.
5. **The repair ladder.** A failed check escalates by strategy, not by temperature: direct repair, then a fresh context, then a written edit sketch, then a stop that asks a person.
6. **AI review.** The Review model gives one finding per acceptance criterion, with a verdict and a checked `file:line`. A criterion it skipped is *unclear*, never *met*. The Review role ships unfilled in v1 until a model passes admission (see [MODELS.md](reference/MODELS.md)); until then a change reaches you without an AI review, and its issue says so.
7. **A person accepts.** Accept squash-merges to `main` without touching your working copy, and can be undone. Request changes (formerly *send back*) returns the issue with its reason.
8. **Releases.** Accepted requirements roll up into releases ("Release 1 · 5 of 11 requirements done") with SemVer versions and a changelog. A release is proven when every Must-have requirement has passing tests on `main`, and done when a person accepts it.

Every step is an event in one hash-chained log. The board, the audit trail, replay and every measurement are projections of it.

## The PM: Seshat

- A conversation that starts a project and answers questions about it (partial: the live, model-backed start of a project waits on the B4.4 milestone run).
- A brief with Must/Should/Could requirements, a depth profile (*Prototype*, *Internal tool*, *Production*, *Regulated*), comparables and a user-journey walkthrough.
- A reuse survey before planning: existing libraries and repositories, with an SPDX licence classifier.
- Taking over an existing repository: trust first, an offline history secret scan, an as-built inventory and an evidenced backlog.
- Suggestions, not orders: triage comes as *Suggested / Why / Apply / Dismiss*, and a dismissed suggestion is not raised again. Seshat never assigns people or sets a project's health.
- Standups, sprint forecasts and weekly update drafts, written from the event log for a person to edit and post.

## The board and dashboard

- A board with familiar columns and issue types (Story, Bug, Task, Spike, Epic).
- **Status:** health set by a person, requirements by Must/Should/Could, a forecast as 50% and 85% dates, risks and *Needs you*.
- **Projects**, **Review** (evidence, the diff and AI review findings), **Insights**, a **story map** and a **burn-up** chart.
- Sprints (start, complete, carry-over), intake and triage, full-text search, retrospectives, and Won't do, Reopen and Revert from the dashboard (C2b).
- **Tips**, the teaching layer for juniors, which experts switch off (partial: the first-run role question and its default route).
- **Configuration:** model folders scanned, roles recommended, the benchmark, *Get the inference engine*.
- A terminal board for the command line.

## Checks and containment

- Checks per issue: tests, types and lint; security (a bundled gitleaks secret scan, plus semgrep and osv-scanner when they are installed); and visual and accessibility checks in a local headless Chromium, with an axe-style rule subset.
- Three project checks: reachability, regression and architecture.
- A parse check that refuses a write which would make a source file unparseable.
- An OS sandbox for every command the model runs: Seatbelt on macOS, bubblewrap on Linux. The containment suite passed on both in the B1 milestone (2026-10-05; [MILESTONES.md](reference/MILESTONES.md)).
- Home-directory secrets masked from the sandbox: one shared table feeds both platforms, plus agent and Docker sockets.
- A per-issue egress proxy with its requests logged; the network is denied unless a policy opens it.
- A prompt-injection suite of 14 fixtures across four channels, run against the real Coding model (14 of 14 held on 2026-10-05; a later change to the Worker's tools means it is re-run on the release candidate).
- *Limit in v1:* a check that needs a database, a cache or another service is always *unavailable*, never a pass, because nothing provides services to checks yet ([DEC-53](design/DECISIONS.md#dec-53--design_gaps-c-decided) c9).

## Models

- Local models only in v1, served by llama.cpp's `llama-server`.
- Four roles, each assigned a model you choose: the **Coding**, **Planning**, **Review** and **Research** models.
- Qualification: a model is *verified on this machine* per engine, host, settings and prompt version before a role uses it.
- **Smart Swap:** a residency scheduler that decides when to load and unload models on a machine that cannot hold them all, with every load recorded and slow loads flagged.
- A reasoning floor per model architecture, so a model that cannot turn thinking off is given room to think.
- A recommended set per hardware tier, downloaded on your yes and verified by its published hash (`models fetch --recommended`).
- A benchmark (`sekhemet benchmark`) and a bake-off to compare model combinations on your own machine.
- Research like an engineer ([DEC-59](design/DECISIONS.md#dec-59--research-like-an-engineer-notes-are-ledger-events-and-cited-data)): installed dependencies read at their installed version in npm, Python, Go and Rust, docs at the pinned version, short excerpts focused on the question, and durable research notes (partial: not yet measured on the research golden set).

The detail is in [MODELS.md](reference/MODELS.md).

## Teams

One product, two setups ([DEC-35](design/DECISIONS.md#dec-35--one-product-two-setups-solo-and-team)):

- **Solo** is one person on their own machine. The dashboard binds loopback, and there is no sign-in and no roles screen.
- **Team** is one install on your team's server. People sign in at one of four access levels, and each project's Accept rule decides who may accept. A project moves from Solo to Team without migration. A Team server needs a TLS-terminating proxy in front of it.

The AI is a teammate that proposes, and people decide ([DEC-36](design/DECISIONS.md#dec-36--the-ai-is-a-teammate-that-proposes-people-decide)).

- Four access levels (Admin, Member, Stakeholder, Viewer) and a per-project Accept rule.
- Invites, passwords, passkeys and company sign-in (OIDC).
- `@Agent` and `@Seshat` as labelled AI teammates; the Agent acts with the permissions of the person who started it.
- Inbox, My issues, @mentions, review threads with a *Comment* verdict, presence, and an Admin audit log that can be exported.
- A fair model queue, shared by tokens, with a per-person Agent cap.

**State (partial).** The Team setup is built and tested on a real server: the B4.10 milestone passes with five people at four levels. The full team journey, from a stakeholder's conversation to an accepted release (B4.11), has not yet run with live models. Details: [teams.md](design/specs/teams.md).

## Reliability

- Backups outside the repository, per workspace, verified before they are kept; `restore` refuses a set that does not verify (C4).
- The event log survives `kill -9` and an upgrade (B3: 5 of 5 kills recovered; a schema 0 to 21 upgrade kept 46 of 46 events).
- A full disk is a named stop; the machine is kept awake while a runner works.

## Integrations

- GitHub: one adapter, merge-aware, with owner and delegate mapped.
- An MCP server over stdio, and an MCP client for outside tool servers.
- Export and import for Jira and Linear boards (no live two-way sync in v1).
- *Limit in v1:* Sekhemet's commits are unsigned, so a branch that requires signed commits refuses them ([DEC-53](design/DECISIONS.md#dec-53--design_gaps-c-decided) c13).

## Documentation and help

- A [user guide](guide/index.md): install on macOS and Ubuntu, first run, models, Solo and Team, a Team administrator's guide, concepts mapped to Jira and Linear, an FAQ, and what Sekhemet does not do.
- Pages generated from the product and checked by the build: the [CLI reference](guide/cli-reference.md) from the command registry, [troubleshooting](guide/troubleshooting.md) from `doctor`'s checks, [privacy and network](guide/privacy-and-network.md) from the network policy's host catalogue (a test fails when the code names a host the page does not list), and the [editor snippets](guide/editors.md).
- `sekhemet <command> --help` for every command, with its synopsis and an example; `sekhemet --help` names where to get help.
- [SECURITY](../.github/SECURITY.md) with the supported versions and private reporting, [CONTRIBUTING](../.github/CONTRIBUTING.md), a Code of Conduct, [SUPPORT](../.github/SUPPORT.md), and issue forms.

## Measurement

- The frozen suite: 30 issues across four fixture projects, run through the product's own queue.
- A recorded, frozen baseline (B2.5) and paired comparisons against it.
- Milestone runners that produce evidence files (`pnpm milestone <id>`).

The numbers are in [STATUS.md](reference/STATUS.md) and [SUITE_RUNS.md](reference/SUITE_RUNS.md).
