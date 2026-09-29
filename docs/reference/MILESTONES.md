# Milestones the owner sees

The plan's milestones ([MODERNIZATION_PLAN.md](MODERNIZATION_PLAN.md), *Milestones the owner sees*), each with the evidence a runner produced on the reference machine. A verdict is **PASS** only when every check of its runner passed, **FAIL** when any failed, and **NOT RUN** otherwise, with the reason. Nothing here is a claim a runner did not check.

Run one with `pnpm milestone <id>` (for example `pnpm milestone B3`), or `pnpm milestone all`; each writes `evidence/milestones/<id>_<date>.json`, and `pnpm milestone report` renders this page from the newest file of each. The runners are `scripts/milestones/*.mjs`. They load no model: where a model's turn is needed, a stand-in server answers the chat API the product's adapter speaks, and a milestone that needs the real model says NOT RUN and what it needs.

| Milestone | Verdict | Date | Commit |
| --- | --- | --- | --- |
| [B1](#b1) | NOT RUN | 2026-09-28 | `150b7f8ebd` |
| [B2.5](#b25) | NOT RUN | 2026-09-28 | `150b7f8ebd` |
| [B3](#b3) | PASS | 2026-09-28 | `150b7f8ebd` |
| [B4.4](#b44) | NOT RUN | 2026-09-28 | `150b7f8ebd` |
| [B4.10](#b410) | PASS | 2026-09-28 | `150b7f8ebd` |
| [B4.11](#b411) | NOT RUN | 2026-09-28 | `150b7f8ebd` |
| [C](#c) | NOT RUN | — | — |

## B1

*The uncensored Worker cannot leave its sandbox: the containment suite, including a Worker that tries, is green on macOS and Linux.*

**NOT RUN** — Linux: the containment suite under bubblewrap (SEC-43): not run: pending the Lima VM the owner approved

- Evidence: `evidence/milestones/B1_2026-09-28.json`
- Commit: `150b7f8ebd` with uncommitted changes
- Tree: tree not recorded (evidence from before trees were recorded); run it again to tie it to a commit
- Date: 2026-09-28, on darwin arm64 with 24 GB
- Runner: `scripts/milestones/b1.mjs`

- ✓ macOS: the containment suite (Seatbelt, native and srt engines): 162/162 tests passed in 17 files
- ✓ macOS: a Worker that tries to leave (the injection fixtures, live Worker): 14/14 held by cyber-tiel, recorded in evidence/injection_2026-09-25.json (commit 5937e83); a Worker change requires the run again
- – Linux: the containment suite under bubblewrap (SEC-43): not run: pending the Lima VM the owner approved

How it ran: the containment suite is `packages/sandbox/tests`, run here with one worker. The Worker that tries to leave is the recorded live injection run (14 RedCode-Exec fixtures across four channels), read from its evidence file, not re-run; it counts only while the sandbox (`packages/sandbox/src`) and the Worker's tools (`packages/loop/src/tools.ts`, `tool_catalog.ts`, `tool_schema.ts`) are unchanged since the commit that recorded it, and is NOT RUN otherwise, naming what changed. Linux waits on the Lima VM the owner approved.

## B2.5

*A recorded, reproducible baseline: one RunProfile, the full suite and the planning measure, every failure named.*

**NOT RUN** — every arm's rounds: 8 runs recorded; still to run: evidence-gate-r2, fixed-tools-r2, strict-r2, thinking-all-r2; the planning measure: no planning measure yet (it waits on the confirmed golden briefs); the frozen RunProfile in SUITE_RUNS.md: not frozen yet (the schedule freezes it when it completes)

- Evidence: `evidence/milestones/B2.5_2026-09-28.json`
- Commit: `150b7f8ebd` with uncommitted changes
- Tree: tree not recorded (evidence from before trees were recorded); run it again to tie it to a commit
- Date: 2026-09-28, on darwin arm64 with 24 GB
- Runner: `scripts/milestones/b2_5.mjs`

- – every arm's rounds: 8 runs recorded; still to run: evidence-gate-r2, fixed-tools-r2, strict-r2, thinking-all-r2
- ✓ every failure named: 84 failures, each with its stop reason
- ✓ one suite hash: d70f689d4125
- – the planning measure: no planning measure yet (it waits on the confirmed golden briefs)
- – the frozen RunProfile in SUITE_RUNS.md: not frozen yet (the schedule freezes it when it completes)

How it ran: read only from `~/.sekhemet/baseline` (results and arms); the driver and its runs are not touched. It passes when every arm has its second round, a planning-measure result exists, and SUITE_RUNS.md records the frozen RunProfile under a `## Baseline RunProfile (frozen …)` heading.

## B3

*A person can safely accept, undo and send back cards on a real repository, and the ledger survives a crash and an upgrade.*

**PASS**

- Evidence: `evidence/milestones/B3_2026-09-28.json`
- Commit: `150b7f8ebd` with uncommitted changes
- Tree: tree not recorded (evidence from before trees were recorded); run it again to tie it to a commit
- Date: 2026-09-28, on darwin arm64 with 24 GB
- Runner: `scripts/milestones/b3.mjs`

- ✓ three issues built on a real repository and waiting in Review: card_b3_greet review, card_b3_farewell review, card_b3_count review
- ✓ accept: squashed onto main with its trailers, the issue Done: main e7b4ddb0 -> b3e456c9; Accepted card_b3_greet — squashed onto main as b3e456c9a6, issue moved to Done. Your files were not touched.
- ✓ accept: the person's checkout (files, HEAD, index) untouched: byte for byte
- ✓ undo: the accept reverted on main, the issue back in Ready: card_b3_greet's accept is reverted (090c6c795a on main); the issue is back in Ready.
- ✓ send back: the issue back in Ready, and its next attempt told why: after send-back: ready; next attempt was told the reason and ended in review
- ✓ the ledger: chain valid, projections identical, Ledger-Head anchor matches: second accept exit 0; log exit 0, chain valid, projections identical, anchor matches
- ✓ crash: kill -9 mid-write on a WAL ledger, then the chain verifies on restart: 5/5 kills recovered (killed after 174, 105, 140, 199, 165 events; WAL present at 5 of them); a write lands after each restart: 5/5
- ✓ upgrade: 5937e83's build made a ledger with its own CLI: 46 events of 15 types at schema version 0: 8 issues seeded, card_up_hello built by its Worker loop (review); park card_onyx_4_vault waiting on the vault design → 0, park card_onyx_7_cli after the scanner → 0, unpark card_onyx_4_vault → 0, review card_up_hello → 0, accept card_up_hello → 0, log → 0
- ✓ upgrade: migrated by this build after a backup, to its schema version: schema 0 -> 21 (this build's 21); backup pre-migration-v0-to-v21-2026-09-29T02-53-25-263Z.db
- ✓ upgrade: the hash chain intact and every event readable: 46/46 old events kept with their type and hash, 1 added on opening; chain valid; projections rebuilt identical; 0 unreadable payloads; the older build's accepted issue reads done
- ✓ upgrade: this build writes to the upgraded ledger and it verifies: park exit 0; log exit 0

How it ran: the issues are built by the product's Worker loop (`executeCard`, its tools, sandboxed checks and evidence) against the stand-in model; every step a person takes is this build's CLI. Each crash kills, with SIGKILL, a process that creates and moves issues without pause. The older build is 5937e83, the baseline's commit, extracted with `git archive`, installed offline from the local pnpm store and built; its own seed script, Worker loop and CLI make the ledger this build then opens.

## B4.4

*A non-developer starts or takes over a project on the reference machine by conversation and watches its must-haves become proven.*

**NOT RUN** — start a project by conversation: a scripted non-developer talks to Seshat: needs Seshat's model loaded on the reference machine and scripted conversations a person confirmed (0 confirmed; fixtures/pm_conversations holds drafts only); must-haves become proven: an issue on each take-over fixture built, gated and accepted from the dashboard (DS-TO-15): needs the Worker model loaded for a live run on the reference machine

- Evidence: `evidence/milestones/B4.4_2026-09-28.json`
- Commit: `150b7f8ebd` with uncommitted changes
- Tree: tree not recorded (evidence from before trees were recorded); run it again to tie it to a commit
- Date: 2026-09-28, on darwin arm64 with 24 GB
- Runner: `scripts/milestones/b4_4.mjs`

- ✓ take over: the five DS-TO-15 fixtures reach an approved, evidenced plan with issues, no model loaded: 6/6 (half-built-ts, broken-build, python-stubs, committed-secret, inherited-issues, and no fixture file edited)
- – start a project by conversation: a scripted non-developer talks to Seshat: needs Seshat's model loaded on the reference machine and scripted conversations a person confirmed (0 confirmed; fixtures/pm_conversations holds drafts only)
- – must-haves become proven: an issue on each take-over fixture built, gated and accepted from the dashboard (DS-TO-15): needs the Worker model loaded for a live run on the reference machine

How it ran: the take-over half runs `apps/harness/tests/takeover_fixtures.spec.ts` on this machine (real git repositories, the product's `runTakeover` and `approveTakeoverPlan`, no model). The conversation and the built issues need the live models.

## B4.10

*A team shares one server: each person signs in at their access level, the project's Accept rule decides who may accept, and each person gets fair turns on the model.*

**PASS**

- Evidence: `evidence/milestones/B4.10_2026-09-28.json`
- Commit: `150b7f8ebd` with uncommitted changes
- Tree: tree not recorded (evidence from before trees were recorded); run it again to tie it to a commit
- Date: 2026-09-28, on darwin arm64 with 24 GB
- Runner: `scripts/milestones/b4_10.mjs`

- ✓ five people at four levels sign in: Ada Admin admin, Lee Lead member, Mo Member member, Sam Stakeholder stakeholder, Vi Viewer viewer
- ✓ an unauthenticated request changes nothing: answered 401
- ✓ the Admin names the lead; the lead sets the Accept rule; a Member who is not lead cannot: lead 200, Accept rule [Mo Member] 200, Mo edits settings 403
- ✓ each person gets only their level's actions, every write naming its person: 25 attempts (file an issue, comment, change priority, delegate to the Agent, invite a person) × 5 people, each as teams item 6 says
- ✓ fair turns on the model, in tokens: the queue runs the order each person's tokens call for: ran mo, lee, lee, lee, mo (weighted tokens: Mo 48000, Lee 6000); turns by count would have been mo, lee, mo, lee, lee; each passed its checks, 4 in Review and 1 held In Progress while Review is at its limit (RG-S6-2)
- ✓ the project's Accept rule decides who may accept: Ada (Admin) 403, Lee (lead) 403, Sam 403, Vi 403; Mo (named) 200, the issue done; Ada was told: This project's Accept rule doesn't include you. A person this project's Accept rule names can accept this issue.

How it ran: a real `sekhemet serve` process in the Team setup, each person signed in through its routes. The five queue issues are filed and delegated over HTTP; moving them to Ready is done in the runner's process for the person who filed them, because the board has no HTTP route for that move. The queue is what `sekhemet queue` runs, the product's `fairOrder` picking each next issue and `executeCard` building it, in the runner's process against the stand-in model, because the Worker's own port belongs to the overnight run. A run the server itself launches starts nothing here.

## B4.11

*A team of five, at four access levels, takes a project from a stakeholder's conversation to an accepted release on one server.*

**NOT RUN** — a stakeholder's conversation with Seshat becomes a plan a Member approves: needs Seshat's model loaded on the reference machine (the capstone run); the plan's issues built, reviewed and accepted under the Accept rule, and the release accepted: needs the Worker model for a live run (the capstone), then this audit on its ledger

- Evidence: `evidence/milestones/B4.11_2026-09-28.json`
- Commit: `150b7f8ebd` with uncommitted changes
- Tree: tree not recorded (evidence from before trees were recorded); run it again to tie it to a commit
- Date: 2026-09-28, on darwin arm64 with 24 GB
- Runner: `scripts/milestones/b4_11.mjs`

- ✓ a team of five at four levels on one server: Ada Admin admin, Lee Lead member, Mo Member member, Sam Stakeholder stakeholder, Vi Viewer viewer
- ✓ every write attributed to one of the five: 0 events a person caused without a principal; 0 principals outside the team (on this runner's sign-in ledger)
- – a stakeholder's conversation with Seshat becomes a plan a Member approves: needs Seshat's model loaded on the reference machine (the capstone run)
- – the plan's issues built, reviewed and accepted under the Accept rule, and the release accepted: needs the Worker model for a live run (the capstone), then this audit on its ledger

How it ran: B4.10's team on a real server, and the journey's audit over the ledger (`plan/sent_for_approval` by the Stakeholder, `plan/approved` by a Member, `slice/accepted`, and every person's event naming one of the five). The live run is the capstone's.

## C

*v1: DEFINITION_OF_DONE §6 on one release commit.*

**NOT RUN** — no evidence recorded yet.

Runner: none; Phase C's release gate decides it.
