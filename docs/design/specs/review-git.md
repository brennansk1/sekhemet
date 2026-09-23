---
spec: review-git
status: partial
audiences: [developer, beginner]
code: [apps/harness/src/execute.ts, apps/harness/src/triage.ts, apps/harness/src/learning/review.ts, apps/harness/src/external_review.ts, packages/sync/src/git_adapter.ts, packages/board/src/board_service.ts, packages/loop/src/card_runner.ts]
tests: [packages/sync/tests/git_wave2.spec.ts, packages/sync/tests/sync.spec.ts, packages/board/tests/entry_conditions.spec.ts, packages/board/tests/runner_backpressure.spec.ts, apps/harness/tests/triage_cli.spec.ts, apps/harness/tests/review.spec.ts, apps/harness/tests/trailer_gate.spec.ts, apps/harness/tests/external_review.spec.ts, packages/loop/tests/runner_depth.spec.ts, packages/loop/tests/c_integration.spec.ts]
changes: [S5, S6, P8]
---

# Review, Accept and the git workflow

## 1. Purpose

Review is where a person decides whether a card is done, and git is the file system of record that makes the decision safe and reversible. This spec owns three spine rules at the point they meet a person: **the model never certifies its own work** (the Reviewer advises, a person accepts), **the human is the rate limiter** (measured review capacity back-pressures the machine), and **a card is the unit of work** (one branch, one worktree, one squashed commit). It serves developers (review in minutes, not archaeology) and beginners (it teaches what "done" means). How the Review view looks is [dashboard.md](dashboard.md); the card state machine and its entry conditions are [kernel.md](kernel.md); gates are [gates.md](gates.md).

## 2. Behaviour

### 2.1 What a person reviews

1. A card enters Review only when every blocking gate passed and the project gates passed ([gates](gates.md)). What the person sees, in order: the Reviewer's findings, the gates, typed failures if any, the diff grouped into *Implementation* (in scope), *Acceptance tests* (protected, staged by Sekhemet, not written by the Worker) and *Outside scope*, the acceptance criteria as *Done when*, and the run facts (steps, time, tokens, model, settings, provenance).
2. The goal is a decision in under a minute without reading the trajectory. The evidence bundle is the record the decision is made on; its repository-state hash identifies exactly what was reviewed.

### 2.2 Review capacity sets the pace

1. **ReviewWIP = ⌊reviewMinutesPerDay ÷ median review minutes per card⌋**, floored at 1, computed **per project** and recomputed after every human decision.
2. **Only human decisions count.** A review's duration runs from `review/opened` (the evidence was shown to a person) to `review/decided` (accept, send back, park, reject) by a human principal. Exits from Review by `harness` (`--auto-accept`), `system` or any other non-human actor are excluded.
3. **Until five human reviews exist, the median is a prior of 15 minutes per card**; after that it is measured.
4. When the cards in Review reach ReviewWIP, finished cards are **held in Verify** ("Holding for review") and released in order as soon as a review completes. The planner does not start more work toward Review than this allows, and parallel Workers are capped by it: running more than review can absorb produces diffs nobody reads.

### 2.3 The Reviewer

1. The Reviewer is a registry role, not a persona, and it answers one question: **does this change do what the card asked?** Gates answer "is it correct by the project's standards"; they cannot see a diff that passes by deleting an assertion, meeting the letter not the intent, or solving a different problem well.
2. **Trigger:** every card with a diff, **after gates pass and before the card is shown in Review and before any auto-accept**. Research cards and cards with no diff skip it.
3. **Inputs:** the card's spec, its acceptance criteria, the full diff (never silently truncated; a diff over the model's budget is reviewed per file and the finding list says which files were not read), the gate results, and the project's active code-style statements and approved rules. **Not** the Worker's transcript: it judges the work, not the reasoning that produced it.
4. **Procedure:** for each acceptance criterion, decide met, unmet or unclear, citing the `file:line` of the hunk that decides it; then look for the three failures gates miss — the letter not the intent; changes outside what the card asked; tests that pass without exercising the behaviour; then check the diff against the stated preferences and rules.
5. **Output**, appended to the evidence bundle and shown first in Review, attributed to *Reviewer* and its model (never to Seshat):

```typescript
interface ReviewFinding {
  criterion: string;          // the acceptance criterion verbatim, or "preference: …"
  verdict: "met" | "unmet" | "unclear";
  evidence: string;           // file:line of the deciding hunk
  note: string;               // one sentence, only when unmet or unclear
}
```

6. **Authority: none.** It cannot accept, reject, park or gate a card; it changes no durable state beyond its findings.
7. **A different family, enforced.** The registry refuses to fill the Reviewer role with a model of the Worker's family. When no other family is available the role is unfilled and Review says *"No Reviewer: no model outside the Worker's family is configured"* instead of showing an empty list.

### 2.4 The human decisions

Every decision is one implementation shared by the CLI and the dashboard (`triage.ts`), recorded with the person who made it ([integrations](integrations.md) supplies identity), and has an undo.

| Decision | From | To | Rules |
| --- | --- | --- | --- |
| **Accept** | Review | Done | §2.5. Requires the Accept permission in company-server mode |
| **Send back** | Review, Parked | Ready | A reason is required: it is what the Worker is told next (dossier). It becomes a playbook candidate **on the ledger** only when it names something actionable (a file, symbol, gate or error pattern) |
| **Park** / **Unpark** | any open state / Parked | Parked / its previous state | Optional reason; presets *Waiting on me*, *Needs a decision*, *Not now* |
| **Reject** | Review, Parked, Ready, Backlog | Rejected | A reason is required |
| **Reopen** | Rejected, Done | Ready | For Done, only through Revert accept |
| **Revert accept** | Done | Ready | A revert commit of the card's squash on the integration branch, then the transition; recorded as `card/reverted` with both shas |

The MCP actor can read and propose but cannot accept ([kernel](kernel.md)). Model actors cannot take any of these decisions.

### 2.5 Accept, safely

1. **Preconditions, all checked before anything moves:** the card's *stored* state is Review; every blocking gate in its latest evidence passed; the ledger verifies; the card branch's head equals the evidence bundle's repository-state hash (what was reviewed is what merges); the person holds the Accept permission; no other accept for this project is in progress (a lock).
2. **Merge with plumbing, never in the person's working copy:** `git merge-tree --write-tree` of the integration branch and the card branch, `commit-tree` with the squash message, then `update-ref refs/heads/<integration> <new> <expected-old>`. The person's `HEAD`, index and working tree are untouched. If the integration branch moved since the preview, or the merge conflicts, nothing is written and the card stays in Review with the reason.
3. **Then transition and record, as one step:** the board transition to Done and `card/accepted { sha, principal }` are committed together ([kernel](kernel.md) S7). If the transition is refused after the ref moved, the ref is restored to its expected-old value and the refusal is reported. A failure at any step leaves nothing half-done.
4. **The squash commit** is a Conventional Commit, intent-grouped in its body, with trailers:

```
feat(ledger): append-only hash-chained writer

Card: card_8f21
Agent-Model: cyber-tiel-coder-35b-a3b-mtp
Agent-Harness: sekhemet
Agent-Role: implementer
GateStatus: pass | fail | partial        (from the evidence, never hard-coded)
Accepted-by: Jane Doe <jane@example.com> (or "sekhemet --auto-accept")
Ledger-Head: 212:9f3a…                    (seq and hash at accept)
Co-authored-by: <every model that contributed a checkpoint>
```

A squash missing a required trailer is refused before any ref moves.
5. **After Accept:** the card's worktree is removed; cards held on back-pressure are released; stacked children rebase onto the integration branch and re-run their gates (a child that conflicts is reported, never forced); raw checkpoints stay at `refs/sekhemet/checkpoints/<card-id>`.
6. **Auto-accept** (`sekhemet queue --auto-accept`, for the benchmark and unattended runs) is the harness's verdict, recorded with actor `harness` and `Accepted-by: sekhemet --auto-accept`. It runs only after the Reviewer, is never counted as a human review, and is refused in company-server mode.
7. **Pull request on Accept** (when enabled, [integrations](integrations.md)): Accept pushes the card branch and opens a pull request whose body is the evidence summary (gates, tests added, diff stats, what was tried and abandoned). The card records `card/accepted { pr }` and reaches Done when the pull request merges; until then it shows *Accepted · PR #n open* and does not count toward ReviewWIP. Without an adapter, the same summary is written into the squash commit body.

### 2.6 The git workflow

1. **Git is the file system of record.** Every card is a branch, every checkpoint a commit, and the board holds no state git cannot reconstruct. Every git call runs hardened ([security](security.md) S1).
2. **Branches:** `sekhemet/<project>/<card-id>-<slug>`, created from the parent card's branch when one exists, otherwise from the project's **integration branch** (configurable; default `main`). Each card has its own worktree. Subtask branches stack on their parent, so a parent's gates run on the merged stack; siblings with disjoint scope run on independent branches.
3. **Checkpoints:** a commit every 5 steps when files changed (`checkpointEvery`), and before Verify, each with trailers `Card`, `Step`, `Agent-Model`, `Agent-Harness`, `Agent-Role`, `GateStatus`. Every checkpoint is a rewind point.
4. **Two cards at once.** Cards whose `filesTouched` intersect are never scheduled concurrently; a scope violation is a stop reason, not a merge-time surprise. **Every card rebases onto the integration branch before Verify**, so a conflict is found while the Worker still has budget: a conflict inside scope returns the card to the Worker with the hunks as typed failures (`rebase_conflict`); a conflict outside scope parks it. A conflict the Worker cannot resolve is a decision request against both cards, shown as a pair. The harness never resolves a semantic conflict by preferring one side. Merge order across siblings follows the dependency graph, then WSJF.
5. **Monorepos and multi-repo projects.** Scope and gates are declared per package; a card touching two packages runs both gate sets. A cross-repository change is two cards with a dependency edge, never one card with two worktrees.
6. **Structural diffs.** When difftastic is installed, Review offers its syntax-aware diff beside the line diff, so moved functions and renames read as one change. Producing any diff never writes to the person's working copy or index.

### 2.7 External review cards

A card may target a pull request Sekhemet did not create. It fetches the head into `refs/sekhemet/review/<n>`, runs the gates and the Reviewer on a checkout, never edits, and posts its findings as an evidence bundle (and as review comments when a tracker adapter is on). It moves through the board's transition law like any card ([kernel](kernel.md) S4); failing gates are findings on the card, not a pass.

## 3. Contract

| Item | Where |
| --- | --- |
| `acceptCard(ctx, card, actor)` (to move into `triage.ts`) | `apps/harness/src/execute.ts` |
| `sendBack`, `park`, `unpark` (and new `reject`, `reopen`, `revertAccept`) | `apps/harness/src/triage.ts` |
| `ReviewFinding` (one declaration, the shape in §2.3) | `apps/harness/src/learning/review.ts` today; `execute.ts:1438` and `external_review.ts` declare others, to be removed |
| `computeReviewWip`, `measuredReviewMinutes`, `calibrateReviewWip`, `backpressureActive` | `packages/board/src/board_service.ts` |
| `branchNameFor`, `squashAndMerge`, `rebaseOntoIntegration`, `restackChildren`, `structuralDiff`, checkpoint refs | `packages/sync/src/git_adapter.ts` |
| Events | `card/accepted { sha \| pr, principal }`, `card/reverted` (new), `review/opened` (new), `review/decided` (new), `card/review` (Reviewer findings), `playbook/candidate` (new; replaces `.sekhemet/playbook_candidates.jsonl`) |
| CLI | `sekhemet review`, `accept <card>`, `send-back <card> "<reason>"`, `park <card> [reason]`, `unpark <card>`; new `reject <card> "<reason>"`, `reopen <card>`, `revert <card>`; `queue --auto-accept [--review]` |
| Endpoints (owned by [runtime](runtime.md)) | `POST /api/cards/:id/{accept,return,park,unpark}`; new `reject`, `reopen`, `revert` |
| Config | `reviewMinutesPerDay`; the integration branch (new); `github-pr` switch ([integrations](integrations.md)) |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Send back (reason required), park, unpark shared by CLI and dashboard | built | `triage.ts:10-80`; `triage_cli.spec.ts` | — |
| Send back only from Review or Parked | not-built | `sendBack` transitions from any status (`triage.ts:49-55`) | S5 |
| Playbook candidates on the ledger | not-built | Appended to `playbook_candidates.jsonl` (`triage.ts:63-68`) | S5 |
| Accept checks the board before merging | not-built | `squashAndMerge` runs before `transitionCard` (`execute.ts:1344-1362`) | S5 |
| Accept never touches the working copy | not-built | `checkout`, `merge --squash`, `commit` in `repoRoot` (`git_adapter.ts:536-538`); no conflict cleanup, no lock | S5 |
| What merges is what was reviewed | not-built | No head-versus-evidence check | S5 |
| Real `GateStatus`, `Accepted-by`, `Ledger-Head` trailers | not-built | `GateStatus: "pass"`, `Agent-Role: "implementer"` hard-coded (`execute.ts:1349-1353`) | S5 |
| Unattributed squash refused | built | `missingTrailers` (`git_adapter.ts`); `git_wave2.spec.ts` | — |
| Reject, reopen, revert accept | not-built | No verbs; Rejected reachable only by override or MCP | S5 |
| Integration branch configurable | not-built | `"main"` hard-coded (`execute.ts:1346, 1378`) | S5 |
| PR on accept reaches Done only on merge | not-built | Moves to Done when the PR opens (`execute.ts:1319-1333`) | S5 |
| ReviewWIP formula, back-pressure, held cards released | partial | `board_service.ts:207-222, 454`; `entry_conditions.spec.ts`, `runner_backpressure.spec.ts` — but counts automated exits (live limit 7,708), global not per project, calibrated once at start (`index.ts:547`), no prior | S6 |
| Reviewer runs before Review and before auto-accept | not-built | Runs at the end of the queue pass (`index.ts:1576-1605`), after `--auto-accept` merged (`index.ts:1639`) | P8 |
| Reviewer judges criteria with citations | not-built | Checks preferences only; returns `[]` without learned preferences (`review.ts:23`); diff cut at 12,000 chars (`review.ts:28`) | P8 |
| Different-family Reviewer enforced; unfilled role shown | not-built | `family` exists in the registry (`registry.ts:44`), nothing reads it | P8 |
| Branch naming, per-card worktrees, stacked branches, restack on accept | built | `git_adapter.ts:201-238`, `execute.ts:1378`; `runner_depth.spec.ts`, `sync.spec.ts` | — |
| Checkpoint commits with trailers and checkpoint refs | built | `git_adapter.ts:447-479`, `card_runner.ts:141`; `git_wave2.spec.ts` | — |
| Rebase before Verify, `rebase_conflict` with typed hunks | built | `card_runner.ts:1281-1283`, `git_adapter.ts:552`; `c_integration.spec.ts` | — |
| Structural diff (difftastic) | partial | Served by `wave2_server.ts:361`; the read path runs `git add -A` / `checkout` in `repoRoot` when the worktree is gone (`git_adapter.ts:698-709`) | S5 |
| External review cards | partial | `external_review.ts:121-310`, run from the queue (`index.ts:1522`); enter Review even when gates fail and bypass the board (`external_review.ts:141, 244-252`) | S4 ([kernel](kernel.md)) |

## 5. Changes for v1

### S5 — Safe, reversible Accept
*Accept merges before the board agrees, in the person's own checkout, with a hard-coded `GateStatus: pass`, and cannot be undone.*

Tests use real repositories (DEFINITION_OF_DONE §2A).
- WHEN a card is accepted THE SYSTEM SHALL leave the person's `HEAD`, index and working-tree files byte-identical to before.
- WHEN the person's checkout is dirty or on another branch THE SYSTEM SHALL still accept without touching it.
- WHEN the board refuses the transition to Done THE SYSTEM SHALL leave the integration branch at its previous commit and the card in Review.
- WHEN the integration branch moved and the squash conflicts THE SYSTEM SHALL write no commit, leave no conflict markers anywhere, and report the conflicting files.
- WHEN two accepts for the same project run at once THE SYSTEM SHALL complete one and refuse or queue the other, and the integration branch SHALL contain both changes or exactly one, never a lost update.
- WHEN the card branch's head differs from the evidence bundle's repository-state hash THE SYSTEM SHALL refuse the accept and say the card changed after it was reviewed.
- WHEN a card is accepted THE SYSTEM SHALL write `GateStatus` from the evidence, `Accepted-by` naming the person (or `sekhemet --auto-accept`), and `Ledger-Head` with the seq and hash at accept.
- WHEN a person reverts an accepted card THE SYSTEM SHALL add a revert commit of its squash to the integration branch, move the card to Ready, and record `card/reverted` with both shas.
- WHEN a person rejects a card THE SYSTEM SHALL require a reason and move it to Rejected; WHEN they reopen it THE SYSTEM SHALL move it to Ready.
- WHEN send-back is requested for a card in In progress or Verify THE SYSTEM SHALL refuse it and name `abort`.
- WHEN a card is sent back THE SYSTEM SHALL record the playbook candidate as a ledger event and write no file under `.sekhemet/`.
- WHEN the integration branch is configured as `develop` THE SYSTEM SHALL branch from and merge into `develop`.
- WHEN pull-request-on-accept is on THE SYSTEM SHALL keep the card out of Done until the pull request is merged, and SHALL NOT count it toward ReviewWIP meanwhile.
- WHEN a structural diff is requested for a card whose worktree is gone THE SYSTEM SHALL compute it without writing to the person's repository.

### S6 — Review WIP from human decisions only
*The human is not the rate limiter: automated sub-second exits make the live limit 7,708.*

- WHEN five sub-second `harness` exits from Review and no human reviews exist THE SYSTEM SHALL compute ReviewWIP from the 15-minute prior (60 min/day gives 4).
- WHEN five human reviews of 20 minutes exist at 60 review minutes a day THE SYSTEM SHALL compute ReviewWIP = 3, whatever automated exits are also in the log.
- WHEN a human decision is recorded THE SYSTEM SHALL recompute ReviewWIP before the next card is released from Verify.
- WHEN two projects share a server THE SYSTEM SHALL compute and enforce each project's ReviewWIP from its own reviews and its own Review count.
- WHEN a person opens a card's evidence in Review THE SYSTEM SHALL record `review/opened`; WHEN they decide THE SYSTEM SHALL record `review/decided` with the principal.

### P8 — The Reviewer rebuilt to the design
*Today it checks style only, never runs on a new project, reads a truncated diff and runs after the merge.*

- WHEN a card with a diff passes its gates THE SYSTEM SHALL produce one `ReviewFinding` per acceptance criterion, each with a verdict and a `file:line`, before the card appears in the Review queue.
- WHEN `--auto-accept` is on THE SYSTEM SHALL run the Reviewer before merging, and record its findings on the card even when it merges.
- WHEN the project has no learned preferences or rules THE SYSTEM SHALL still review the card against its criteria.
- WHEN the diff exceeds the Reviewer's budget THE SYSTEM SHALL review it file by file and list any file it did not read; it SHALL NOT silently truncate.
- WHEN the only configured non-Worker model shares the Worker's family THE SYSTEM SHALL leave the role unfilled and show the reason in Review.
- WHEN the Reviewer's input is assembled THE SYSTEM SHALL exclude the Worker's transcript.
- WHEN findings are shown THE SYSTEM SHALL attribute them to *Reviewer* and its model id.
- WHEN the seeded-defect set (gate-passing defects on frozen-suite cards) is reviewed THE SYSTEM SHALL record the Reviewer's recall against an empty finding list and its false-positive rate per card, and P8 is done only if recall is higher than the empty list's.
- WHEN the Reviewer's preference findings are measured over the project's send-backs THE SYSTEM SHALL record the share of send-back reasons a finding caught before the person saw the card, against the register's adoption threshold of one in five (R8).
- WHEN a send-back note names no file, symbol, gate or error pattern THE SYSTEM SHALL keep it as a dossier note and SHALL NOT propose it as a playbook rule.

## 6. v1 acceptance

All criteria in §5, plus:

- WHEN a send-back has an empty reason THE SYSTEM SHALL refuse it on every surface.
- WHEN a squash message lacks `Card`, `Agent-Model`, `Agent-Harness` or `Agent-Role` THE SYSTEM SHALL refuse it before any ref moves.
- WHEN two cards' `filesTouched` intersect THE SYSTEM SHALL not run them concurrently.
- WHEN a rebase before Verify conflicts only inside the card's scope THE SYSTEM SHALL return the card with `rebase_conflict` and one typed failure per conflicting file; WHEN a conflict is outside scope THE SYSTEM SHALL park the card.
- WHEN a parent card is accepted THE SYSTEM SHALL rebase each stacked child onto the integration branch and re-run its gates, reporting any child that conflicts.
- WHEN cards in Review reach ReviewWIP THE SYSTEM SHALL hold newly finished cards in Verify and release the oldest when a review completes.
- WHEN an external review card's gates fail THE SYSTEM SHALL record the failures as findings and SHALL NOT present the card as passing.

## 7. Later

- **A human edits the work** (from the dashboard design): a hand edit in the worktree is a commit by a human actor (`card/human_edit`); gates re-run; the evidence keeps the Worker's diff and the human's separately; the competence row records `passed_with_human_edit`, never an unattended pass. **Partial accept** takes a subset of hunks and turns the rest into a new card with the reviewer's reason. In v1 a person sends back with a note, which keeps the Worker's measured record clean.
- **Squash policy per project** (keep the checkpoint history on the integration branch). v1 always squashes.
- **Copy-on-write worktree cloning** where the filesystem supports it.
- **Pull-request review comments flowing back into the card thread** ([integrations](integrations.md)).
- **Anchoring the ledger head outside SQLite** beyond the `Ledger-Head` trailer (a `sekhemet log` cross-check against git history) — [kernel](kernel.md).

## 8. Open questions

1. **Should Planning count as Review capacity when a research card's plan awaits approval?** The old design kept research plans in Planning so Review's WIP stays for diffs. *Recommendation:* yes, keep that rule; nothing without a diff enters Review.
2. **What the Reviewer's criterion that a person reads by the twentieth card means in numbers.** *Recommendation:* a finding is *acted on* when a send-back quotes it or the next attempt changes the hunk it cites (the explicit-resolution definition used for review threads in arXiv 2607.21997); if acted-on findings fall below one in five over twenty cards, Review collapses the findings to a count and says why.
3. **Public review data for evaluating the Reviewer and send-back rules.** No public set has TypeScript at scale; the clean, outcome-linked sets are small and mostly Python: c-CRAB (234 test-verified review comments, CC BY 4.0), SWE-PRBench (350 merged PRs with `has_requested_changes`, CC BY 4.0, ~21 TypeScript), CodeReviewQA (900 `old → review → new` triples, MIT). `ronantakizawa/github-codereview` has the right shape but no licence grant and must not be imported. *Recommendation:* with the owner's yes, add c-CRAB and SWE-PRBench as evaluation sets beside the seeded-defect set, and CodeReviewQA as the test of whether induced rules fire on real returns; build a TypeScript set later from permissively licensed repositories.

## 9. Evidence and rationale

- Review: [domain02_09_kernel_review.md](../../reference/reviews/domain02_09_kernel_review.md) (Domain 9: Accept ordering, working-copy merge, the Reviewer drift; Domain 2: the 7,708 ReviewWIP probe).
- Plumbing merge: `git merge-tree --write-tree` (git ≥ 2.38) with a compare-and-set `update-ref`; considered and rejected, a state-machine library (the defect is the trusted `fromStatus`, not a missing framework).
- Cross-family review catches errors a same-family model shares (ARIS, cited in `packages/models/src/router.ts:16-17`); an AI reviewer can pre-empt developer mistakes (AutoDev, arXiv 2403.08299).
- A reviewer nobody reads is worse than none, because it looks like coverage — hence the read-rate check in Open question 2.
- Review datasets, their licences and outcome signals; public review comments are substantially vague and non-actionable (arXiv 2502.02757), hence the actionable-note filter on send-back rules: [PUBLIC_DATA_SURVEY.md](../../research/PUBLIC_DATA_SURVEY.md) survey 1 §7 and survey 2.
- The Reviewer's preference check is register entry R8 (AutoDev), adopted with the threshold "one send-back reason in five caught before the human sees the card", not yet benched: [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md).
- Only grounded signals change durable state (SRMA, arXiv 2609.02750): the Reviewer advises and never gates — [PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md).
- About 40% of self-declared completions are wrong even for frontier models (SWE-smith, arXiv 2504.21798), which is why Accept needs gates and a person, never the model's word: [WORKER_METHOD_LITERATURE.md](../../research/WORKER_METHOD_LITERATURE.md) §4.
- "Accepted means proven by gates" is the positioning's edge: Jira and Linear route cards to agents but document no acceptance or definition-of-done enforcement — [WEB_RESEARCH group C §6](../../research/WEB_RESEARCH_2026-09.md#6-competitive-landscape).
- **Resolved drift:** send back goes to Ready (code), not In Progress; the design's example trailers named `claude-code` as harness — Sekhemet's squashes say `sekhemet`; the Reviewer is a role, so "Seshat's review" in the product becomes "Reviewer" (DEC-05, [NAMING](../NAMING.md)).
