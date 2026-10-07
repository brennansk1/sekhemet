# Project status and roadmap

Where Sekhemet stands, how it is measured, and what comes next. Moved here from the [README](../../README.md) on 2026-10-07. The newest state is always the Executive Status Summary and the latest entry of [DEV_LOG.md](../../DEV_LOG.md); the plan is [FINISH_LINE_PLAN.md](FINISH_LINE_PLAN.md).

## Where things stand (2026-10-07)

- **Not published.** No npm package and no server image exist yet; Sekhemet installs from source ([INSTALL.md](INSTALL.md)). The public pre-release 0.9.0, the first with an npm package, comes after C5 and its pre-publication pass ([FINISH_LINE_PLAN.md](FINISH_LINE_PLAN.md), *The path to 1.0*).
- **Committed since Phase B:** C2a (the core surfaces), C2b (the team process), C2c (CLI, trust and Linux), C3 (models: the shipped set, resumable downloads, *Get the inference engine*), C4 (reliability: backups, restore, a full disk as a named stop), research like an engineer ([DEC-59](../design/DECISIONS.md#dec-59--research-like-an-engineer-notes-are-ledger-events-and-cited-data)), RG-P8-18 (the Review model's reply decoded against its JSON schema) and C2d (entry-point tests).
- **The latest gate** on a committed tree (C2d, DEV_LOG Entry 82): `tsc -b` clean, `biome check .` clean, 7,072 tests passed and 71 skipped in 911 files.
- **Entry-point tests:** of 742 criteria marked built, 36 are still reached only by unit tests, each listed with its reason in [ENTRY_POINTS.md](ENTRY_POINTS.md).
- **Models:** Coding and Planning qualified; Research recommended, not yet qualified; Review unfilled because no candidate reached the admission bar ([MODELS.md](MODELS.md)).

**Next:** C5 (install, docs and the user journeys), C6 (checks for the software Sekhemet builds) and C7 (the release candidate), with the rest of the Review model's bake-off when the machine's memory allows.

## Milestones

Each runner writes an evidence file; a verdict is PASS only when every check passed. From [MILESTONES.md](MILESTONES.md):

| Milestone | What the owner can see | Verdict |
| --- | --- | --- |
| B1 | The Coding model cannot leave its sandbox, on macOS and Linux | PASS (2026-10-05): the containment suite on macOS and on Linux (Ubuntu 24.04 in a Lima VM), and the live injection run 14 of 14 held. A later change to the Worker's tools (DEV_LOG Entry 81) means the injection run is repeated on the release candidate |
| B2.5 | A recorded, reproducible baseline | NOT RUN (every check passes but the planning measure, which waits on confirmed golden briefs) |
| B3 | Accept, undo and send back on a real repository; the log survives a crash and an upgrade | PASS |
| B4.4 | A non-developer starts or takes over a project by conversation | NOT RUN (needs live models) |
| B4.10 | A team shares one server, with access levels, the Accept rule and fair turns | PASS |
| B4.11 | A team of five takes a project from a conversation to an accepted release | NOT RUN (needs a live run after C5) |
| C | v1: the Definition of Done on one release commit | NOT RUN |

```bash
pnpm milestone <id>
```

## How it is measured

"Better" is a measured claim, never a feeling. One trial at non-zero temperature is not a finding.

**The frozen suite.** 30 issues across four fixture projects (Chronicle, Onyx, Basalt Canvas, Vanguard), each with contract-first acceptance tests, run through the product's own queue from clean repositories. A run compares only with runs of the same suite hash.

```bash
node scripts/run_suite.mjs --worker cyber-tiel --out <file>
```

**The shipped Coding model** (R-tune, 2026-09-29/30, build `e53e408`): nail-mtp with thinking off passed 22 and 21 of 30 in two rounds; thinking set to surgical made no difference the suite can resolve, so it ships with thinking off. Each run of 30 issues took 3.6 to 4.5 hours on the 24 GB reference Mac, sharing the machine with other work ([SUITE_RUNS.md](SUITE_RUNS.md)).

**The B2.5 baseline** (frozen 2026-09-29): six arms, two rounds each, on build `5937e83`, with Cyber-Tiel-Coder-35B-A3B as the Coding model. Suite 1.0.0, hash `d70f689d`. Each arm changes one switch from the reference.

| Arm | Switch | Round 1 | Round 2 | Passed of 60 |
| --- | --- | --- | --- | --- |
| ref | — | 20 | 18 | 38 |
| thinking-surgical | thinking = surgical | 22 | 21 | 43 |
| thinking-all | thinking = all | 21 | 21 | 42 |
| strict | working method = strict | 18 | 20 | 38 |
| fixed-tools | tool arm = fixed | 18 | 20 | 38 |
| evidence-gate | evidence gate = on | 18 | 19 | 37 |

No arm differs from ref by a margin the suite can resolve. Every one of the 124 failures is named with its stop reason. The full RunProfile is in [SUITE_RUNS.md](SUITE_RUNS.md).

**The regression pair** (2026-09-28): nail-mtp on two builds, the same 30 issues and sampling. Paired on the 26 issues measured on both: 20 and 21 passed, one discordant issue, median tokens per issue unchanged. Verdict: no clear difference, and no regression.

**The capstone comparison (planned; no results yet).** A freshly written timesheet and overtime-rules app, with a mid-project California change request, scored by a sealed hidden suite of 112 tests tagged Must, Should and Could. Every arm gets byte-identical input. The result is a grid:

| | nail-mtp | Qwen3.8-27B | Opus 5.5 | Sonnet 5 | Haiku 4.5 |
| --- | --- | --- | --- | --- | --- |
| **One shot** (one request, no tools) | planned | planned | planned | planned | planned |
| **With its harness** | Sekhemet | — | Claude Code | Claude Code | Claude Code |

Rows show the harness effect; columns show the model effect. One Web-Bench project (`fastify`) is a second, external comparison. The protocol, runner and scorer are built; the runs have not started, and results will be published with their protocol whatever they show. The protocol is in [CAPSTONE_SELECTION_2026-09.md](../research/CAPSTONE_SELECTION_2026-09.md).

## The path to 1.0

Since C1 (2026-10-01) the plan runs as design first, then the C-sprints ([DEC-56](../design/DECISIONS.md#dec-56--the-release-order-after-c1)): D1, C2a to C2d, C3 and C4 are done; C5, C6 and C7 remain. The table in [FINISH_LINE_PLAN.md](FINISH_LINE_PLAN.md) gives each sprint's scope and exit.

**Exit criteria for "published"** (§G of the plan), all on one release commit: the release gate green on macOS and Linux; no open critical or high security issue; the frozen suite measured with an exact interval and compared, paired, with the baseline; every role admitted or shipped unfilled and saying so; the audience tasks passing as end-to-end tests; WCAG 2.2 AA; the performance budgets; a clean-machine install to a first accepted issue on macOS and Ubuntu; the claims, the README and the specs agreeing with the code; a user guide, CLI reference, SECURITY.md and CHANGELOG; an SBOM and provenance; the capstone and Web-Bench results published; no dead control on any page.

**v1.** A release candidate (`1.0.0-rc.N`) is cut when `pnpm release-gate` passes on macOS and Linux, the frozen suite is measured on the candidate with every failure named, the release security review finds no critical or high issue, the claims-table test passes and the tree is clean. `1.0.0` is tagged by a person.

### The earlier workflow table (as of 2026-09-29)

Kept for the record. The C-sprints above replaced this order on 2026-10-01; each workflow's scope now lives in a C-sprint.

| Workflow | Purpose | State on 2026-09-29 |
| --- | --- | --- |
| W1 | Security hardening: the dashboard guard, Linux secret masks, the Linux secret store, process-level errors | Done |
| W2 | Capstone preparation: the brief, the frozen prompt, the seed, the sealed hidden suite, the runner and scorer | Done |
| W2b | The Sekhemet arm's driver, long messages to Seshat, the Web-Bench runner, the hidden suite on an encrypted image | In progress |
| W4 | Spec truth and the v1 scope: every row re-marked against the code | Next |
| W16 | Completeness audit: hollow controls and missing features | To do |
| W5 | UI/UX audit: heuristics, walkthroughs, the design system | To do |
| W3 | Docs, install and CLI: a user guide, a CLI reference, per-command help, CHANGELOG, SECURITY.md | To do |
| W6 | UI fixes and accessibility: tokens, visual baselines, axe on every page | To do |
| W8 | Reliability and upgrade: fault injection, crash reports, upgrade tests | To do |
| W7 | Supply chain: OSV, an SBOM, provenance (CI deferred) | To do |
| W9 | Performance budgets for the board, issue page and Review | To do |
| W11 | Models for new users: a default set per hardware tier, `models fetch` | To do |
| W18 | Model settings per role, *Find best settings*, the benchmark built out | To do |
| W10 | End-to-end tests of the audience tasks and the first run | To do |
| W17 | Vibe-gap checks for the software Sekhemet builds | To do |
| W12 | The Phase B report and the Phase C proposal | To do |
| W13 | An independent release security review | To do |
| W15 | Cut the release | To do |

The model-run stream of that date, on frozen snapshot builds beside the workflows: R-tune (done: nail-mtp ships with thinking off); the admissions of the Review model (done: the role ships unfilled), Seshat old against new, and the reuse query; Linux containment (done: B1 PASS); the capstone runs (not started).

## After v1: proposals, not commitments

Each needs its own decision.

- Make Anthropic's `sandbox-runtime` (srt) the default sandbox engine once it passes on both platforms and a suite run shows no clear difference ([DEC-39](../design/DECISIONS.md#dec-39--reuse-an-existing-sandbox-engine-instead-of-extending-our-own)). Both engines exist today behind `SEKHEMET_SANDBOX_ENGINE`.
- Preview URLs for the apps Sekhemet builds, so a person can try an issue's work before accepting it.
- A vision role for screenshots and UI checks (a `vision` capability flag exists in the registry; no role uses it yet).
- Windows through WSL2.
- Continuous integration on macOS and Ubuntu (deferred by the owner).
- Outside betas (deferred by the owner).
- Cloud models per role, as an option, never a dependency.
- Fine-tuning, only once the failure history is large and in-context methods plateau.
- The checks v1 does not run on the software it builds ([DEC-47](../design/DECISIONS.md#dec-47--the-finish-line-decisions) O-13): internationalisation, a complexity or code-smell gate, API-level deprecation beyond the project's own lint, load testing, metrics and crash reporting, deployment and rollback of your services, similarity search for reproduced code, and a dead-control crawl of your web apps.
