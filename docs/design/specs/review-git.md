---
spec: review-git
status: partial
audiences: [developer, beginner]
code: [apps/harness/src/accept.ts, apps/harness/src/evidence_summary.ts, apps/harness/src/execute.ts, apps/harness/src/triage.ts, apps/harness/src/learning/review.ts, apps/harness/src/external_review.ts, apps/harness/src/wave2_github.ts, packages/sync/src/git_adapter.ts, packages/sync/src/repo_tools.ts, packages/board/src/board_service.ts, packages/loop/src/card_runner.ts]
tests: [packages/sync/tests/accept_plumbing.spec.ts, packages/board/tests/review_wip.spec.ts, apps/harness/tests/accept_safe.spec.ts, apps/harness/tests/restack_gates.spec.ts, apps/harness/tests/evidence_summary.spec.ts, apps/harness/tests/send_back_comments.spec.ts, packages/sync/tests/git_wave2.spec.ts, packages/sync/tests/sync.spec.ts, packages/board/tests/entry_conditions.spec.ts, packages/board/tests/runner_backpressure.spec.ts, apps/harness/tests/triage_cli.spec.ts, apps/harness/tests/review.spec.ts, apps/harness/tests/trailer_gate.spec.ts, apps/harness/tests/external_review.spec.ts, packages/loop/tests/runner_depth.spec.ts, packages/loop/tests/c_integration.spec.ts]
changes: [S5, S6, P8, NEW-review-git-1, NEW-review-git-2, NEW-review-git-3, NEW-review-git-4, NEW-review-git-5]
---

# Review, Accept and the git workflow

## 1. Purpose

Review is where a person decides whether a card is done, and git is the file system of record that makes the decision safe and reversible. This spec owns three spine rules at the point they meet a person: **the model never certifies its own work** (the Reviewer advises, a person accepts), **the human is the rate limiter** (measured review capacity back-pressures the machine), and **a card is the unit of work** (one branch, one worktree, one squashed commit). It serves developers (review in minutes, not archaeology), beginners (it teaches what "done" means) and teams (who may accept whose work). How the Review view looks is [dashboard.md](dashboard.md); the card state machine and its entry conditions are [kernel.md](kernel.md); gates are [gates.md](gates.md).

## 2. Behaviour

### 2.1 What a person reviews

1. A card enters Review only when every blocking gate passed and the project gates passed ([gates](gates.md)) — **whoever built it**: a card a person built (`builtBy: person`, [kernel](kernel.md)) meets the same entry conditions, the same gates and the same Reviewer as one the Worker built, and gets no bypass except the recorded `override:` reason that already exists. What the person sees, in order: the Reviewer's findings with its coverage, the gates, typed failures if any, the diff grouped into *Implementation* (in scope, **ordered by risk**: files with failures, then files with unmet or unclear findings, then by changed lines — never alphabetically), *Acceptance tests* (protected, staged by Sekhemet, not written by the Worker, collapsed under a one-line summary of what they assert, with each **superseded** base test and its new version listed, and the approval state of each test the depth profile requires a person to approve — [planner-pm §2.16–2.17](planner-pm.md)) and *Outside scope*, the acceptance criteria as *Done when*, and the run facts (steps, time, tokens, model, settings, provenance, and who built it).
2. The goal is a decision in under a minute without reading the trajectory. The evidence bundle is the record the decision is made on; its repository-state hash identifies exactly what was reviewed. **No model's confidence and no model's claim that the change is complete is ever shown**: only gate results and criterion verdicts.

### 2.2 Review capacity sets the pace

1. **ReviewWIP = ⌊reviewMinutesPerDay ÷ median review minutes per card⌋**, floored at 1, computed **per project** and recomputed after every human decision. `reviewMinutesPerDay` is the project's `[review] review_minutes_per_day`, **60 by default** ([surface](surface.md) item 23; `config.ts:43`). Worker-built and person-built cards consume the same review minutes and both count. A card held `awaitingMerge` (§2.5.7) is not in the Review count.
2. **Only human decisions count.** A review's duration runs from `review/opened` (the evidence was shown to a person) to `review/decided` (accept, send back, park, reject) by a human principal. Exits from Review by `harness` (`--auto-accept`), `system` or any other non-human actor are excluded.
3. **Until five human reviews exist, the median is a prior of 15 minutes per card**; after that it is measured. The prior applies **from the first card, before any human review**: at the default 60 minutes a day it gives ReviewWIP = 4. An unset value is the default 60. **The kernel's static Review limit of 3 (`board_service.ts:19`) is never used for Review**: `review_minutes_per_day` must be greater than 0 — a value of 0 or less is refused where it is set (a configuration file that sets it is refused on load, naming the key; the [dashboard](dashboard.md)'s Configuration page refuses the field) — so ReviewWIP always comes from the formula of §2.2.1 and its floor of 1. Today the code falls back to that static 3 whenever no review has been measured (`board_service.ts:209-213`); S6 replaces the fallback with the prior.
4. When the cards in Review reach ReviewWIP, finished cards are **held in Verify** ("Holding for review") and released in order as soon as a review completes. The planner does not start more work toward Review than this allows, and parallel Workers are capped by it: running more than review can absorb produces diffs nobody reads.
5. **Review is recorded as reading, not clicking.** `review/opened` carries `{ principal, filesShown }`; `review/decided` carries `{ principal, decision, linesReviewed, minutes, acknowledgedFindings }`. The review rate (changed lines ÷ minutes) is recorded for every human decision; a decision faster than **500 changed lines an hour** is marked *fast review* and reported separately in Insights and beside the ReviewWIP derivation. It is never blocked. The ≤ 200-line card is the review-size budget.

### 2.3 The Reviewer

1. The Reviewer is a registry role, not a persona, and it answers one question: **does this change do what the card asked?** Gates answer "is it correct by the project's standards"; they cannot see a diff that passes by deleting an assertion, meeting the letter not the intent, or solving a different problem well.
2. **Trigger:** every card with a diff, **after gates pass (and after the run's retries), before the card is shown in Review and before any auto-accept**. Research cards and cards with no diff skip it. On a host where roles do not co-reside, cards that passed wait in Verify (*Waiting for the Reviewer*) and the Reviewer loads once per queue pass for all of them, after the Worker's retries, so it loads a single time (`index.ts:1886-1896` already loads it once, at the end).
3. **Inputs:** the card's spec, its acceptance criteria, the full diff (never silently truncated; a diff over the model's budget is reviewed per file and the finding list says which files were not read), the staged acceptance tests with the criterion each proves, the gate results, the Worker's recorded assumptions (its `note("Assumed: …")` entries in the card's dossier), and the project's active code-style statements and approved rules. **Not** the Worker's transcript: it judges the work, not the reasoning that produced it. Its prompt budget is [context](context.md)'s.
4. **Procedure:** for each acceptance criterion, decide met, unmet or unclear, citing the `file:line` of the hunk that decides it; check that every criterion has a test case that exercises it (spec-to-test fidelity — a **fail-only** finding: it can report a criterion with no exercising test, never certify one); then look for the three failures gates miss — the letter not the intent; changes outside what the card asked; tests that pass without exercising the behaviour; check each recorded assumption against the diff; then check the diff against the stated preferences and rules.
5. **Output**, appended to the evidence bundle and to the card's dossier (so Seshat, a retry and learning read it — [worker-loop](worker-loop.md) owns the dossier reader), shown first in Review, attributed to *Reviewer* and its model (never to Seshat). Findings are **reminders tied to a criterion and a location that name the class of problem** (*criterion 2 unmet: no test exercises the empty-input case*), not verdicts on the whole change, and come with a **coverage line**: *Reviewer read 3 of 3 files; 41 of 58 changed lines are cited by no finding.*

```typescript
interface ReviewFinding {
  criterion: string;          // the acceptance criterion verbatim, or "preference: …", "assumption: …", "no test: …"
  verdict: "met" | "unmet" | "unclear";
  evidence: string;           // file:line of the deciding hunk
  note: string;               // one sentence, only when unmet or unclear
}
```

6. **Authority: none.** It cannot accept, reject, park or gate a card; it changes no durable state beyond its findings. Its findings are advice, not a gate.
7. **A different family, enforced.** The registry refuses to fill the Reviewer role with a model of the Worker's family. When no other family is available the role is unfilled and Review says *"No Reviewer: no model outside the Worker's family is configured"* instead of showing an empty list.

### 2.4 The human decisions

Every decision is one implementation shared by the CLI and the dashboard (`triage.ts`), recorded with the person who made it ([integrations](integrations.md) supplies identity), and has an undo.

| Decision | From | To | Rules |
| --- | --- | --- | --- |
| **Accept** | Review | Done (with pull-request-on-accept: stays in Review, held `awaitingMerge`, until the pull request merges, §2.5.7) | §2.5. Requires the Accept permission — in the Team setup, being named in the project's Accept rule ([teams](teams.md) item 7) — and, on a team project, an accepter who neither built nor delegated the card (§2.4.1) |
| **Send back** | Review, Parked | Ready | A reason is required: it is what the Worker is told next (dossier). It becomes a playbook candidate **on the ledger** only when it names something actionable (a file, symbol, gate or error pattern) |
| **Park** / **Unpark** | any open state / Parked | Parked / Ready, or Backlog or Planning when it was parked from that state | Optional reason; presets *Waiting on me*, *Needs a decision*, *Not now*. Unpark follows [kernel](kernel.md)'s legal edges (`parked` → `ready`, `planning`, `backlog`, `rejected`): a card parked from In progress, Verify or Review returns to Ready, re-queued rather than resumed mid-attempt, as a send-back is |
| **Reject** | Review, Parked, Ready, Backlog | Rejected | A reason is required |
| **Reopen** | Rejected, Done | Ready | For Done, only through Revert accept |
| **Revert accept** | Done | Ready | A revert commit of the card's squash on the integration branch, then the transition; recorded as `card/reverted` with both shas |

The MCP actor can read and propose but cannot accept ([kernel](kernel.md)). Model actors cannot take any of these decisions.

1. **Who may accept their own card** (owner decision O11, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)). **A project with one person holding the Accept permission is solo**, whether it runs on a laptop or on a server: that person may accept the cards they built and the cards they delegated to the Worker, and each such accept is recorded `independent: false`. **On a project where two or more people hold the Accept permission** — a team — the person who **built** a card, and the person who **delegated it to the Worker**, may not accept it; another Accept-holder must, and that accept is recorded `independent: true` (GitHub's rule for Copilot's pull requests). **The delegator is the principal who recorded the latest `card/delegated` whose `to` is the Worker** ([kernel](kernel.md) rule 21), read from the ledger — never the card's current `owner`. A change of owner after delegation (`card/owner_changed`, from the dashboard, the CLI or a tracker, [integrations](integrations.md) item 6b) changes neither who built nor who delegated the card: the delegator still may not accept it, and **a later owner who neither built nor delegated it may accept it** like any other Accept-holder. On a solo project the one Accept-holder may always accept. The Accept-holders are counted when the accept is attempted, so a project that gains a second Accept-holder is a team from that moment, and earlier acceptances keep what they recorded. A refused accept names who may accept. No setting lets a builder or delegator accept on a team project. `card/accepted` records `independent: true | false`.
2. **Suggested accepters.** When a card has a declared scope and the repository has a `CODEOWNERS` file (read from `.github/`, then the root, then `docs/`), the card's suggested accepters are computed from the **last matching pattern** for each file in scope (gitignore syntax), shown on the card and in Review. A project may require a code owner's accept; then an accept by a principal who owns none of the card's files is refused, and an accept from **any** owner suffices. The matcher is written in-house against GitHub's documented rules; no matcher library is added.
3. **Accept friction, light** (owner decision O13, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)). Accept is enabled only when, in addition to §2.5.1, every `unmet` or `unclear` finding has been acknowledged (one key each) and every Implementation file has been shown once; the remaining ones are written beside the disabled button ([dashboard](dashboard.md)). Nothing heavier (a forced scroll through every hunk) is required — the strongest forcing designs are the least liked. A heavier level is Later (§7) and would be the owner's decision again.
4. **Review verdicts in the Team setup** ([teams](teams.md) item 25, [DEC-35](../DECISIONS.md#dec-35--one-product-two-setups-solo-and-team)). Beside Accept and Send back (with line comments, DEC-34), a reviewer may leave a **Comment**: a review with no verdict, recorded as `review/commented`. An accept is dismissed when new commits land on the card's branch before merge, recorded as `review/accept_dismissed` ([teams](teams.md) TEAM-24); a project may require every review thread resolved before Accept, which is then disabled naming the open thread (TEAM-25). Both are specified in [teams](teams.md) and not restated here.

### 2.5 Accept, safely

1. **Preconditions, all checked before anything moves:** the card's *stored* state is Review; every blocking gate in its latest evidence passed; the ledger verifies; the card branch's head equals the evidence bundle's repository-state hash (what was reviewed is what merges); the person holds the Accept permission and meets §2.4.1–2; the findings and files of §2.4.3 are acknowledged and shown (recorded on `review/decided`); no other accept for this project is in progress (a lock).
2. **Merge with plumbing, never in the person's working copy:** `git merge-tree --write-tree` of the integration branch and the card branch, `commit-tree` with the squash message, then `update-ref refs/heads/<integration> <new> <expected-old>`. The person's `HEAD`, index and working tree are untouched. If the integration branch moved since the preview, or the merge conflicts, nothing is written and the card stays in Review with the reason.
3. **Then transition and record, as one step:** the board transition to Done and `card/accepted { sha, principal, independent }` are committed together ([kernel](kernel.md) S7). If the transition is refused after the ref moved, the ref is restored to its expected-old value and the refusal is reported. A failure at any step leaves nothing half-done.
4. **The squash commit** is a Conventional Commit, intent-grouped in its body, with trailers:

```
feat(ledger): append-only hash-chained writer

Card: card_8f21
Agent-Model: cyber-tiel-coder-35b-a3b-mtp
Agent-Harness: sekhemet
Agent-Role: implementer
GateStatus: pass | fail | partial        (from the evidence, never hard-coded)
Accepted-by: Jane Doe <jane@example.com> (or "sekhemet --auto-accept (for <the person who enabled it>)")
Ledger-Head: 212:9f3a…                    (seq and hash at accept)
Co-authored-by: <every model that contributed a checkpoint>
```

A squash missing a required trailer is refused before any ref moves. Git trailers keep the person's name, as git authorship already does; the ledger stores an opaque principal id ([kernel](kernel.md)).
5. **After Accept:** the card's worktree is removed; cards held on back-pressure are released; stacked children rebase onto the integration branch and re-run their gates (a child that conflicts is reported, never forced); raw checkpoints stay at `refs/sekhemet/checkpoints/<card-id>`.
6. **Auto-accept** (`sekhemet queue --auto-accept`, for the benchmark and unattended runs) is **a person's recorded standing decision, never the harness's own verdict**. Switching it on is recorded as `review/auto_accept_enabled { principal, run }`, naming the person who ran the command; **every `card/accepted` it writes carries actor `harness`, `auto: true` and that person as `principal`**, and the squash says `Accepted-by: sekhemet --auto-accept (for Jane Doe <jane@example.com>)` ([kernel](kernel.md) rule 19; DEFINITION_OF_DONE §5.1.5: a card is done when a person accepts it, or when it is auto-accepted under a person's recorded standing decision that names them on every acceptance). An auto-accept with no enabling principal is refused. It runs only after the Reviewer and is never counted as a human review. **Auto-accept is never available in the Team setup** (DEC-35): the flag is refused there, and no setting enables it.
7. **Pull request on Accept** (when enabled, [integrations](integrations.md)): Accept pushes the card branch and opens a pull request whose body is the evidence summary — the spec, *Done when*, gates with durations, tests added, diff stats, what was tried and abandoned, and the visual gate's screenshots when there are any. The card records `card/accepted { pr }` and **stays in Review under [kernel](kernel.md)'s `awaitingMerge { pr, since }` hold** (a typed hold, like the back-pressure hold, set by `card/pr_opened` and cleared by `card/pr_closed`; no new state). A held card is **excluded from the Review count**, so it neither counts toward ReviewWIP nor triggers back-pressure, and it shows *Accepted · PR #n open*. When the pull request merges, the card moves to Done; when it is closed without merging, the hold is cleared, the earlier acceptance is recorded as not completed, and the card is back in Review's queue awaiting a new decision — counting toward ReviewWIP again — with who closed it recorded ([integrations](integrations.md) INT-14). Without an adapter, the same summary is written into the squash commit body.

### 2.6 The git workflow

1. **Git is the file system of record.** Every card is a branch, every checkpoint a commit, and the board holds no state git cannot reconstruct. Every git call runs hardened ([security](security.md) S1).
2. **Branches:** `sekhemet/<project>/<card-id>-<slug>`, created from the parent card's branch when one exists, otherwise from the project's **integration branch** (configurable; default `main`). Each card has its own worktree. Subtask branches stack on their parent, so a parent's gates run on the merged stack; siblings with disjoint scope run on independent branches.
3. **Checkpoints.** The product path commits a checkpoint **after every step that changed files** (`execute.ts:422` passes `checkpointEvery: 1`), after every gate-passing step, when a suspending stop (memory pressure, a budget, abort, replan) leaves unsaved writes, and before Verify (`card_runner.ts:1145-1177`); the runner's library default of every 5 steps (`card_runner.ts:1056`) applies only to other callers. Each checkpoint has trailers `Card`, `Step`, `Agent-Model`, `Agent-Harness`, `Agent-Role`, `GateStatus` (and `builtBy` once [kernel](kernel.md) records it), and a database record `{ cardId, step, gitRef, gateStatus, agentModel, agentHarness, agentRole }` that `sekhemet replay`, rewind and resume read (`card_runner.ts:659-671`). Every checkpoint is a rewind point. [runtime](runtime.md) links here for the cadence.
4. **Two cards at once.** Cards whose `filesTouched` intersect are never scheduled concurrently; a scope violation is a stop reason, not a merge-time surprise. **Every card rebases onto the integration branch before Verify**, so a conflict is found while the Worker still has budget: a conflict inside scope returns the card to the Worker with the hunks as typed failures (`rebase_conflict`); a conflict outside scope parks it. A conflict the Worker cannot resolve is a decision request against both cards, shown as a pair. The harness never resolves a semantic conflict by preferring one side. Merge order across siblings follows the dependency graph, then WSJF.
5. **Monorepos and multi-repo projects.** Scope and gates are declared per package; a card touching two packages runs both gate sets during card verification. A cross-repository change is two cards with a dependency edge, never one card with two worktrees.
6. **Structural diffs.** When difftastic is installed, Review offers its syntax-aware diff beside the line diff, so moved functions and renames read as one change. Producing any diff never writes to the person's working copy or index.
7. **Versions and tags.** A release is proposed per accepted slice ([planner-pm §2.15](planner-pm.md)). Its version is computed from the Conventional-Commit squashes since the last tag: `fix` → patch, `feat` → minor, a breaking change → major, **except while the version is `0.y.z`, where a breaking change bumps minor** — 1.0 is a person's decision. The changelog is built in, or by git-cliff when installed (`repo_tools.ts:92`), and is written to `CHANGELOG.md` at the root in the Keep a Changelog format, with release notes per slice, where [design-stage §2.3](design-stage.md) places them ([DEC-30](../DECISIONS.md#dec-30--project-documents-follow-professional-conventions)). A tag is written only on a person's confirmation (`sekhemet release --confirm`), and Sekhemet never deploys; a team already running release-please consumes the squashes unchanged.

### 2.7 External review cards

A card may target a pull request Sekhemet did not create. It fetches the head into `refs/sekhemet/review/<n>`, runs the gates and the Reviewer on a checkout, never edits, and posts its findings as an evidence bundle (and as review comments when a tracker adapter is on). It moves through the board's transition law like any card ([kernel](kernel.md) S4); failing gates are findings on the card, not a pass.

## 3. Contract

| Item | Where |
| --- | --- |
| `acceptCard(ctx, card, actor, { principal?, acknowledgedFindings?, autoRun? })`, `acceptPreconditions`, `accepterCheck`, `acceptFriction`, `revertAccept`, `recordReviewOpened`, `recordDecision`, `enableAutoAccept`, `AcceptRefusedError { code }`, `integrationBranch` | `apps/harness/src/accept.ts` (re-exported by `triage.ts` and `execute.ts`) |
| `sendBack(ctx, card, reason, { comments? })`, `park`, `unpark`, `reject`, `reopen` | `apps/harness/src/triage.ts` |
| `evidenceSummary(card, evidence, abandoned)` — the pull request's body and the squash body (§2.5.7) | `apps/harness/src/evidence_summary.ts`; `prBody` delegates to it |
| `restackAfterAccept`, `regateRestackedChild` (NEW-review-git-2) | `apps/harness/src/execute.ts` |
| `ReviewFinding` (one declaration, the shape in §2.3) | `apps/harness/src/learning/review.ts` today; `execute.ts:1438` and `external_review.ts` declare others, to be removed |
| `computeReviewWip(minutes?, projectId?)`, `measuredReviewMinutes(projectId?)`, `reviewRate(projectId?)`, `calibrateReviewWip`, `backpressureActive`, `REVIEW_MINUTES_PRIOR` (15), `FAST_REVIEW_LINES_PER_HOUR` (500); `CardTransition.with` (events committed with the move) | `packages/board/src/board_service.ts` |
| `branchNameFor`, `squashAndMerge(…, { expectedOld?, body? })` (plumbing), `MergeConflictError { files }`, `restoreRef`, `revertSquash`, `withAcceptLock`, `withScratchCheckout`, `cardBranch`, `rebaseOntoIntegration` (with `otherCards`), `stageRebaseConflict`, `restackChildren`, `structuralDiff`, checkpoint refs | `packages/sync/src/git_adapter.ts` |
| Accept-holders and delegator: `CardStore.mayAccept`, `acceptHolders`, `delegatorOf`, `buildersOf`; `EventLogOptions.acceptHolders` (read at each attempt) | `packages/kernel/src/card_store.ts`, `log.ts` |
| `CheckpointRecord` | `packages/loop/src/card_runner.ts:659-671`, stored through the card store |
| `planRelease`, `nextVersion`, `publishRelease` | `packages/sync/src/repo_tools.ts` |
| `prBody` | `apps/harness/src/wave2_github.ts:55` |
| Events | `card/accepted { sha \| pr, principal, independent, gateStatus, integration, auto? }` (`auto: true` only from auto-accept, with the enabling person as `principal`; committed in the move's transaction), `review/auto_accept_enabled { principal, run }` (new), `card/pr_opened { pr, url, headSha }` and `card/pr_closed { pr, merged }` (the `awaitingMerge` hold, [kernel](kernel.md) rule 24; who closed an unmerged pull request is recorded by [integrations](integrations.md) INT-14), `card/reverted { sha, revertSha, principal }` (reason private), `review/opened { principal, evidence, filesShown }`, `review/decided { principal, decision, linesReviewed, minutes, acknowledgedFindings, project? }` — each with a registered payload schema, `card/review` (Reviewer findings), `playbook/candidate` (new; replaces `.sekhemet/playbook_candidates.jsonl`), `release/proposed`, `release/tagged` ([planner-pm](planner-pm.md)) |
| CLI | `sekhemet review [card]` (shows the gates and each Implementation file's diff, and records `review/opened`), `accept <card>`, `send-back <card> "<reason>"`, `park <card> [reason]`, `unpark <card>`, `reject <card> "<reason>"`, `reopen <card>`, `revert <card> [reason]`; `queue --auto-accept [--review]` (records `review/auto_accept_enabled`); `release [--confirm]` |
| Endpoints (owned by [runtime](runtime.md)) | `POST /api/cards/:id/{accept,return,park,reject,revert,opened}` (`accept` takes `acknowledgedFindings`, `return` takes `comments: [{file, line, text}]`, `opened` takes `filesShown`); `unpark`, `reopen` still to add |
| Config | `[review] review_minutes_per_day` (greater than 0; a value of 0 or less is refused, named, and not applied, §2.2.3); `[review] integration_branch` (default `main`); `[team] mode` (user config only; `team` refuses `--auto-accept`); `[review] require_code_owner_accept` (default false, per project; RG-N5-4); `[review] remote` (default `origin`, where pull-request-on-accept pushes); `github-pr` switch ([integrations](integrations.md)). Independent acceptance has no setting: it follows the number of Accept-holders (§2.4.1) |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Send back (reason required), park, unpark shared by CLI and dashboard | built | `triage.ts:10-80`; `triage_cli.spec.ts` | — |
| Send back only from Review or Parked | built | `sendBack` refuses In progress and Verify naming `abort`, and any state but Review or Parked (`triage.ts`); `accept_safe.spec.ts` (RG-S5-12) | — |
| Playbook candidates on the ledger | built | `playbook/candidate` with the note private (B3.1, `triage.ts`); `triage_cli.spec.ts` (RG-S5-13) | — |
| Accept checks the board before merging | built | `acceptPreconditions` (stored state, passing ledger evidence, chain verifies, head, permission, friction) before any ref moves; the move to Done and `card/accepted` in one transaction (`CardTransition.with`), and with pull-request-on-accept `card/pr_opened` and `card/accepted` in one transaction (`acceptWithPullRequest(…, withEvents)`; `awaiting_merge.spec.ts`); a refused move restores the ref (`accept.ts`); a restack that fails after the accept is reported, not swallowed; `accept_safe.spec.ts` (RG-S5-3) | — |
| Accept never touches the working copy | built | `merge-tree --write-tree`, `commit-tree`, compare-and-set `update-ref`; a conflict writes nothing and names the files; one accept lock per repository, a dead holder's lock taken over only under an exclusive takeover lock and only if it is still the stale lock read (`git_adapter.ts` `squashAndMerge`, `withAcceptLock`); the integration branch's head is read before the lock, so an accept that lands meanwhile refuses this one as moved since the preview; the parent rollup gate runs in a scratch checkout of the integration branch; `accept_plumbing.spec.ts`, `accept_safe.spec.ts` (RG-S5-1, -2, -4, -5). A person whose checkout (the main one or a linked worktree) is on the integration branch is told, in one line per checkout, the command that brings its files up to date keeping unsaved edits (`git -C <checkout> read-tree -m -u <old> <branch>`), by `sekhemet accept` and in the dashboard's Accept toast (`checkoutNotice`; `accept_safe.spec.ts`, `dashboard_accept.spec.ts`) | — |
| What merges is what was reviewed | built | The evidence records `repoState` (`<head>:<tree>`, `card_runner.ts` `finish`); Accept refuses a branch whose head and tree differ (`accept.ts`); `accept_safe.spec.ts` (RG-S5-6) | — |
| Real `GateStatus`, `Accepted-by`, `Ledger-Head` trailers | built | `GateStatus` from the evidence (`gateStatusOf`: fail; partial for a skipped gate; pass), `Accepted-by` the person or `sekhemet --auto-accept (for …)`, `Ledger-Head` `seq:hash`, `Agent-Model` from the evidence (`accept.ts`); `accept_safe.spec.ts` (RG-S5-7, -8) | — |
| Unattributed squash refused | built | `missingTrailers` (`git_adapter.ts`); `git_wave2.spec.ts` | — |
| Reject, reopen, revert accept | built | `reject` (reason required; from Review, Parked, Ready, Backlog), `reopen`, `revertAccept` (a plumbing revert commit, Done → Ready, `card/reverted { sha, revertSha }` in the move's transaction), on the CLI and `POST /api/cards/:id/{reject,revert}`; `accept_safe.spec.ts` (RG-S5-10, -11) | — |
| Integration branch configurable | built | `[review] integration_branch`: the runner's base, Accept's target, the pull request's base, the rollup's checkout (`accept.ts` `integrationBranch`); `accept_plumbing.spec.ts`, `accept_safe.spec.ts` (RG-S5-14) | — |
| PR on accept reaches Done only on merge, held `awaitingMerge` and out of the Review count meanwhile | built (B4.9) | The hold, the count and Done-on-merge are B3.1's (`awaiting_merge.spec.ts`); Accept records `card/pr_opened` and `card/accepted { pr, principal, independent }` (`accept.ts`). `card/pr_closed` records the merge commit and who closed the pull request ([integrations](integrations.md) INT-13, INT-14); the `gh` transport is tested end to end against a fake `gh`, a bare remote and a local GitHub API (`github_first.spec.ts`; RG-S5-16) | — |
| Auto-accept names the person who enabled it; never available on a server | built | `queue --auto-accept` records `review/auto_accept_enabled { principal, run }`; each `card/accepted` it writes carries actor `harness`, `auto: true` and that principal; none recorded refuses; `[team] mode = "team"` refuses the flag before any card runs, marker or not (`measure_cmd.ts` `autoAcceptRefusal`); `accept_safe.spec.ts` (RG-S5-8, -9) | — |
| Unpark returns to Ready unless parked from Backlog or Planning | built | `unparkTarget` reads the parked-from state from the ledger (B3.1, `triage.ts`); `triage_cli.spec.ts` (RG-S5-17) | — |
| PR body is the evidence summary | built | `evidenceSummary`: spec, *Done when*, gates with durations (skipped named), tests added, diff stats, earlier attempts' stop reasons, screenshot links; the `gh` and App paths and the squash body use it (`evidence_summary.ts`); `evidence_summary.spec.ts` (RG-S5-18). The bundle has no screenshot field yet: the visual gate writes none into it ([gates](gates.md)) | — |
| ReviewWIP formula, back-pressure, held cards released | built | From human `review/decided` minutes only, per project (its own minutes and Review count), the 15-minute prior with none, computed at each move so a decision counts before the next release; a fixed `[review] wip` is kept; 0 or less refused naming the key (`board_service.ts`, `config.ts`); `review_wip.spec.ts` (RG-S6-1…5, -7, -8) | — |
| Review records with files shown, lines, minutes; review rate | built | `review/opened { filesShown }` from `sekhemet review` and `POST …/opened`, which the dashboard's Review page posts for each expanded diff it shows (`web/opened.js`, `diff_parse.js` `shownFiles`), so Accept works from the dashboard (`opened.spec.ts`, `dashboard_accept.spec.ts`, RG-N5-5); `review/decided { principal, decision, linesReviewed, minutes, acknowledgedFindings }` on accept, and on send back, park and reject from Review; `reviewRate` reports decisions over 500 lines an hour without refusing (`accept.ts`, `board_service.ts`); `accept_safe.spec.ts`, `review_wip.spec.ts` (RG-S6-6, -7) | — |
| Reviewer runs before Review and before auto-accept | not-built | Runs at the end of the queue pass, after the retries (`index.ts:1886-1896`) but after `--auto-accept` merged (`index.ts:1639`) | P8 |
| Reviewer judges criteria with citations, reads assumptions, writes to the dossier, reports coverage | not-built | Checks preferences only; returns `[]` without learned preferences (`review.ts:23`); diff cut at 12,000 chars (`review.ts:28`); findings reach only the dashboard | P8 |
| Different-family Reviewer enforced; unfilled role shown | not-built | `family` exists in the registry (`registry.ts:44`), nothing reads it | P8 |
| Branch naming, per-card worktrees, stacked branches, restack on accept | built | `git_adapter.ts:201-238`, `execute.ts:1378-1389`; `runner_depth.spec.ts`, `sync.spec.ts` | — |
| Restacked children re-run their gates | built | `restackAfterAccept`: children rebase (one with no worktree in a scratch checkout, never the person's), their blocking gates re-run on the rebased branch and are recorded as the child's evidence; a failing child in Review returns to Ready with the failures in its dossier (`execute.ts`, `git_adapter.ts`); `restack_gates.spec.ts` (RG-N2-1, -2) | — |
| Checkpoint commits with trailers, checkpoint refs and database records; every step that changed files | built | `execute.ts:420-422`, `card_runner.ts:615-680, 1145-1177`, `git_adapter.ts:447-479`; `git_wave2.spec.ts` | — |
| Rebase before Verify | built | `card_runner.ts:1278-1290`, `git_adapter.ts:552`; `c_integration.spec.ts` | — |
| Rebase conflict returned with typed hunks; out-of-scope parks | built (B3.2) | Before Verify the card rebases with its scope: a conflict inside it is left in the worktree as a squash of the card's change on the integration tip (the old branch kept under `refs/sekhemet/rebase/<card>/<ms>`) and the Worker continues in the same session within its remaining step, token and time budgets, one typed `rebase` failure per file with its hunk (`stageRebaseConflict`, `returnToWorker`); a file outside the scope parks the card naming the files; markers left when the budget ends park it with one `rebase_conflict` decision request naming both cards (from the integration commits' `Card:` trailers); every conflict is a `card/rebase_conflict` event (`card_runner.ts`, `git_adapter.ts`; `rebase_conflict.spec.ts` RG-N1-1, -2, -3) | — |
| Per-package gates in card verification; cross-repository change as two cards | partial | `runPackageGates` runs only from `sekhemet gate` (`index.ts:782-788`, `wave2.ts:1289`); `splitAcrossRepos` has no caller (`repo_tools.ts:389`) | NEW-review-git-3 |
| Structural diff (difftastic) | built | Served by `wave2_server.ts:361`; with the worktree gone both sides are read from the merge base and the card's branch, and nothing is written (`git_adapter.ts` `structuralDiff`); `accept_plumbing.spec.ts` (RG-S5-19) | — |
| Release: version, changelog, tag on confirmation | partial | `sekhemet release [--confirm]` (`wave2.ts:783-794`); `nextVersion` jumps `0.y.z` to `1.0.0` on a breaking change (`repo_tools.ts:44-50`); not tied to a slice | NEW-review-git-4 |
| Independent accept; light Accept friction | built | One Accept-holder is solo (`independent: false`); two or more a team, where the builder (a person delegated to, a person-built checkpoint or attempt, or a person who took the card over — `buildersOf`) and the latest delegator to the Worker are refused naming who may, and another holder's accept is `independent: true`; counted at the attempt; unacknowledged `unmet`/`unclear` findings and unshown Implementation files refuse on every surface, naming them (`accept.ts` `accepterCheck`, `acceptFriction`); `accept_safe.spec.ts` (RG-N5-1, -2, -5…8). Accept-holders come from `EventLogOptions.acceptHolders` until [teams](teams.md) item 7 records the Accept rule | — |
| Suggested accepters from CODEOWNERS; required code-owner accept | built (B4.9) | `suggestedAccepters` from the last matching pattern for each file in scope (`.github/`, the root, then `docs/`), owners mapped to principals through linked GitHub logins ([integrations](integrations.md) identity links), teams and unlinked logins named as unmapped; served on `GET /api/cards/:id/review` as `suggestedAccepters`. With `[review] require_code_owner_accept = true` an accept by a principal who owns none of the card's files (its evidence's files, else its scope) is refused `not_code_owner`, naming the owners; any owner suffices (`codeowners.ts`, `accept.ts` `codeOwnerCheck`; `github_first.spec.ts` RG-N5-3, RG-N5-4). Not yet: the suggestion shown on the dashboard's card and Review page ([dashboard](dashboard.md)), and a team entry resolved to its members | — |
| External review cards | partial | `external_review.ts:121-310`, run from the queue (`index.ts:1522`); enter Review even when gates fail and bypass the board (`external_review.ts:141, 244-252`) | S4 ([kernel](kernel.md)) |

## 5. Changes for v1

### S5 — Safe, reversible Accept
*Accept merges before the board agrees, in the person's own checkout, with a hard-coded `GateStatus: pass`, and cannot be undone.*

Tests use real repositories (DEFINITION_OF_DONE §2A).
- **RG-S5-1** WHEN a card is accepted THE SYSTEM SHALL leave the person's `HEAD`, index and working-tree files byte-identical to before.
- **RG-S5-2** WHEN the person's checkout is dirty or on another branch THE SYSTEM SHALL still accept without touching it.
- **RG-S5-3** WHEN the board refuses the transition to Done THE SYSTEM SHALL leave the integration branch at its previous commit and the card in Review.
- **RG-S5-4** WHEN the integration branch moved and the squash conflicts THE SYSTEM SHALL write no commit, leave no conflict markers anywhere, and report the conflicting files.
- **RG-S5-5** WHEN two accepts for the same project run at once THE SYSTEM SHALL complete one and refuse or queue the other, and the integration branch SHALL contain both changes or exactly one, never a lost update.
- **RG-S5-6** WHEN the card branch's head differs from the evidence bundle's repository-state hash THE SYSTEM SHALL refuse the accept and say the card changed after it was reviewed.
- **RG-S5-7** WHEN a card is accepted THE SYSTEM SHALL write `GateStatus` from the evidence, `Accepted-by` naming the person (or `sekhemet --auto-accept` with the person who enabled it), and `Ledger-Head` with the seq and hash at accept.
- **RG-S5-8** WHEN auto-accept accepts a card THE SYSTEM SHALL record `card/accepted` with actor `harness`, `auto: true` and, as `principal`, the person recorded by `review/auto_accept_enabled` for that run; WHEN no enabling principal is recorded THE SYSTEM SHALL refuse the accept.
- **RG-S5-9** WHEN `--auto-accept` is requested in the Team setup ([DEC-35](../DECISIONS.md#dec-35--one-product-two-setups-solo-and-team)) THE SYSTEM SHALL refuse it before any card runs, and no configuration SHALL enable it there.
- **RG-S5-10** WHEN a person reverts an accepted card THE SYSTEM SHALL add a revert commit of its squash to the integration branch, move the card to Ready, and record `card/reverted` with both shas.
- **RG-S5-11** WHEN a person rejects a card THE SYSTEM SHALL require a reason and move it to Rejected; WHEN they reopen it THE SYSTEM SHALL move it to Ready.
- **RG-S5-12** WHEN send-back is requested for a card in In progress or Verify THE SYSTEM SHALL refuse it and name `abort`.
- **RG-S5-13** WHEN a card is sent back THE SYSTEM SHALL record the playbook candidate as a ledger event and write no file under `.sekhemet/`.
- **RG-S5-14** WHEN the integration branch is configured as `develop` THE SYSTEM SHALL branch from and merge into `develop`.
- **RG-S5-15** WHEN pull-request-on-accept is on and a card is accepted THE SYSTEM SHALL keep it in Review with the `awaitingMerge` hold, record `card/pr_opened`, keep it out of Done until the pull request is merged, and SHALL NOT count it toward ReviewWIP or back-pressure meanwhile.
- **RG-S5-16** WHEN a held card's pull request merges THE SYSTEM SHALL move it to Done and record `card/pr_closed` with `merged: true`; WHEN it is closed without merging THE SYSTEM SHALL clear the hold, leave the card in Review awaiting a new decision and counted toward ReviewWIP again, and record who closed it.
- **RG-S5-17** WHEN a card parked from In progress, Verify or Review is unparked THE SYSTEM SHALL move it to Ready; WHEN it was parked from Backlog or Planning THE SYSTEM SHALL return it there.
- **RG-S5-18** WHEN a pull request is opened on Accept THE SYSTEM SHALL write into its body the gates with durations, the tests added, the diff stats, the abandoned attempts, and a link to each visual-gate screenshot when there is one.
- **RG-S5-19** WHEN a structural diff is requested for a card whose worktree is gone THE SYSTEM SHALL compute it without writing to the person's repository.

### S6 — Review WIP from human decisions only
*The human is not the rate limiter: automated sub-second exits make the live limit 7,708.*

- **RG-S6-1** WHEN five sub-second `harness` exits from Review and no human reviews exist THE SYSTEM SHALL compute ReviewWIP from the 15-minute prior (60 min/day gives 4).
- **RG-S6-2** WHEN a project has no recorded review at all and sets no `review_minutes_per_day` THE SYSTEM SHALL use 60 review minutes a day and the 15-minute prior, giving ReviewWIP = 4, not the static limit of 3.
- **RG-S6-3** WHEN five human reviews of 20 minutes exist at 60 review minutes a day THE SYSTEM SHALL compute ReviewWIP = 3, whatever automated exits are also in the log.
- **RG-S6-4** WHEN a human decision is recorded THE SYSTEM SHALL recompute ReviewWIP before the next card is released from Verify.
- **RG-S6-5** WHEN two projects share a server THE SYSTEM SHALL compute and enforce each project's ReviewWIP from its own reviews and its own Review count.
- **RG-S6-6** WHEN a person opens a card's evidence in Review THE SYSTEM SHALL record `review/opened` with the files shown; WHEN they decide THE SYSTEM SHALL record `review/decided` with the principal, lines reviewed, minutes and acknowledged findings (research RG-T4).
- **RG-S6-7** WHEN ReviewWIP is computed THE SYSTEM SHALL count Worker-built and person-built cards alike, and SHALL report decisions faster than 500 changed lines an hour separately without refusing them (research RG-T5).
- **RG-S6-8** WHEN `review_minutes_per_day` is set to 0 or less, in a configuration file or on the Configuration page, THE SYSTEM SHALL refuse the value with a message naming the key, and SHALL NOT compute ReviewWIP from the static limit of 3.

### P8 — The Reviewer rebuilt to the design
*Today it checks style only, never runs on a new project, reads a truncated diff and runs after the merge.*

- **RG-P8-1** WHEN a card with a diff passes its gates THE SYSTEM SHALL produce one `ReviewFinding` per acceptance criterion, each with a verdict and a `file:line`, before the card appears in the Review queue.
- **RG-P8-2** WHEN `--auto-accept` is on THE SYSTEM SHALL run the Reviewer before merging, and record its findings on the card even when it merges.
- **RG-P8-3** WHEN several cards pass in one queue pass on a host where roles do not co-reside THE SYSTEM SHALL hold them in Verify, load the Reviewer once after the retries, and review each before any is shown in Review.
- **RG-P8-4** WHEN the project has no learned preferences or rules THE SYSTEM SHALL still review the card against its criteria.
- **RG-P8-5** WHEN the diff exceeds the Reviewer's budget THE SYSTEM SHALL review it file by file and list any file it did not read; it SHALL NOT silently truncate.
- **RG-P8-6** WHEN findings are produced THE SYSTEM SHALL include a coverage line: files read of files changed, and changed lines cited by no finding (research DB-T4).
- **RG-P8-7** WHEN a criterion has no staged test case that exercises it THE SYSTEM SHALL report a finding for it, and the Reviewer SHALL never mark a criterion met on that check alone.
- **RG-P8-8** WHEN the Worker recorded an assumption in the card's dossier THE SYSTEM SHALL give it to the Reviewer, which SHALL report each assumption the diff contradicts.
- **RG-P8-9** WHEN findings are produced THE SYSTEM SHALL write them to the card's dossier as well as the evidence bundle, and Seshat's snapshot of the card SHALL contain them.
- **RG-P8-10** WHEN the only configured non-Worker model shares the Worker's family THE SYSTEM SHALL leave the role unfilled and show the reason in Review.
- **RG-P8-11** WHEN the Reviewer's input is assembled THE SYSTEM SHALL exclude the Worker's transcript.
- **RG-P8-12** WHEN findings are shown THE SYSTEM SHALL attribute them to *Reviewer* and its model id, and SHALL show no model-stated confidence.
- **RG-P8-13** WHEN the seeded-defect set (at least 20 gate-passing defects seeded into frozen-suite cards) is reviewed THE SYSTEM SHALL record the Reviewer's recall and its false positives per card; P8 is done only when **recall is at least 0.3 with no more than 1 false positive per card** (counted on each card, not averaged).
- **RG-P8-14** WHEN the Reviewer's preference findings are measured over the project's send-backs THE SYSTEM SHALL record the share of send-back reasons a finding caught before the person saw the card, against the register's adoption threshold of one in five (R8).
- **RG-P8-15** WHEN a send-back note names no file, symbol, gate or error pattern THE SYSTEM SHALL keep it as a dossier note and SHALL NOT propose it as a playbook rule.

### NEW-review-git-1 — A rebase conflict goes back to the Worker as typed failures
*The spec said `built`; every conflict goes to Planning with one line (inventory Y6, R2 SHALLOW; `card_runner.ts:1282-1283, 1635-1638`).*

- **RG-N1-1** WHEN a rebase before Verify conflicts only inside the card's scope THE SYSTEM SHALL return the card to the Worker with `rebase_conflict` and one typed failure per conflicting file naming its hunks, within the card's remaining budget.
- **RG-N1-2** WHEN a rebase conflict touches a file outside the card's scope THE SYSTEM SHALL park the card with the files named.
- **RG-N1-3** WHEN the Worker's budget ends with the conflict unresolved THE SYSTEM SHALL post one decision request naming both cards.

### NEW-review-git-2 — Restacked children re-run their gates
*The spec said `built`; restack records an event and runs no gate (inventory Y7, R2 SHALLOW; `execute.ts:1380-1389`).*

- **RG-N2-1** WHEN a parent card is accepted and a stacked child rebases cleanly THE SYSTEM SHALL re-run the child's gates on the rebased branch and record the result as the child's evidence.
- **RG-N2-2** WHEN a restacked child's gates fail THE SYSTEM SHALL return it to the Worker with the failures, and SHALL NOT leave it in Review.

### NEW-review-git-3 — Per-package gates in card verification
*Per-package gates run only from `sekhemet gate`, and cross-repository splitting has no caller (inventory Y19, R2 SHALLOW).*

- **RG-N3-1** WHEN a card's diff touches two workspace packages THE SYSTEM SHALL run both packages' gate sets during the card's verification, and the card SHALL enter Review only when both pass.
- **RG-N3-2** WHEN a planned change spans two repositories THE SYSTEM SHALL create two cards with a dependency edge, never one card with two worktrees.

### NEW-review-git-4 — Versions follow SemVer's 0.y.z rule, per slice
*`nextVersion` jumps `0.y.z` to `1.0.0` on a breaking change, and releases are not tied to slices ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 13; RG-T6).*

- **RG-N4-1** WHEN a release is proposed for a slice THE SYSTEM SHALL compute the version from the Conventional-Commit squashes since the last tag, bumping minor (not major) for a breaking change while the version is `0.y.z`.
- **RG-N4-2** WHEN a release is proposed THE SYSTEM SHALL tag only on a person's confirmation, and record `release/tagged` with the tag, the sha and the principal.

### NEW-review-git-5 — Review for a team: who may accept, who should look
*Nothing stops the person who delegated a card from accepting it on a server, the Review queue cannot route work, and review time cannot tell a read from a rubber stamp ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decisions 3, 4, 16, 17; RG-T1…T3).*

- **RG-N5-1** WHEN two or more people hold the Accept permission on a project and the principal accepting built the card, or recorded the latest `card/delegated` of it to the Worker (whoever the card's owner now is), THE SYSTEM SHALL refuse the accept with a message naming who may accept; WHEN another Accept-holder accepts it THE SYSTEM SHALL record `card/accepted` with `independent: true`.
- **RG-N5-2** WHEN exactly one person holds the Accept permission on a project, on a single machine or in the Team setup, THE SYSTEM SHALL allow that person to accept a card they built or delegated to the Worker, and SHALL record `card/accepted` with `independent: false`.
- **RG-N5-3** WHEN a card is created with a declared scope and the repository has a `CODEOWNERS` file THE SYSTEM SHALL compute suggested accepters from the last matching pattern for each file in scope.
- **RG-N5-4** WHEN a project requires code-owner acceptance THE SYSTEM SHALL refuse an accept by a principal who owns none of the card's files.
- **RG-N5-5** WHEN any `unmet` or `unclear` finding is unacknowledged, or any Implementation file has not been shown, THE SYSTEM SHALL refuse the accept on every surface and name which remain.
- **RG-N5-6** WHEN a card was built by a person THE SYSTEM SHALL apply the same entry conditions, gates and Reviewer as for a Worker-built card, and a failing blocking gate SHALL refuse the move to Review without an `override:` reason.
- **RG-N5-7** WHEN a second person is granted the Accept permission on a solo project THE SYSTEM SHALL apply the team rule of RG-N5-1 to every accept attempted after the grant, and SHALL leave every earlier `card/accepted` record unchanged.
- **RG-N5-8** WHEN, on a project where two or more people hold the Accept permission, Alice delegates a card to the Worker and its owner is then changed to Bob (by `card/owner_changed` from any surface or a tracker) THE SYSTEM SHALL refuse an accept by Alice naming who may accept, and SHALL allow an accept by Bob, who neither built nor delegated the card, recording `card/accepted` with `independent: true`; WHEN the card is delegated to the Worker again by Bob THE SYSTEM SHALL treat Bob as the delegator from that event on.

## 6. v1 acceptance

All criteria in §5, plus:

- **RG-1** WHEN a send-back has an empty reason THE SYSTEM SHALL refuse it on every surface.
- **RG-2** WHEN a squash message lacks `Card`, `Agent-Model`, `Agent-Harness` or `Agent-Role` THE SYSTEM SHALL refuse it before any ref moves.
- **RG-3** WHEN two cards' `filesTouched` intersect THE SYSTEM SHALL not run them concurrently.
- **RG-4** WHEN the product path runs a card that writes a file on each of three steps THE SYSTEM SHALL record three checkpoint commits and three checkpoint records.
- **RG-5** WHEN a parent card is accepted THE SYSTEM SHALL rebase each stacked child onto the integration branch and re-run its gates, reporting any child that conflicts.
- **RG-6** WHEN cards in Review reach ReviewWIP THE SYSTEM SHALL hold newly finished cards in Verify and release the oldest when a review completes.
- **RG-7** WHEN an external review card's gates fail THE SYSTEM SHALL record the failures as findings and SHALL NOT present the card as passing.

## 7. Later

- **A human edits the work** (from the dashboard design): a hand edit in the worktree is a commit by a human actor (`card/human_edit`); gates re-run; the evidence keeps the Worker's diff and the human's separately; the competence row records `passed_with_human_edit`, never an unattended pass. **Partial accept** takes a subset of hunks; the remainder becomes a new card with the rejected hunks as its spec and the reviewer's reason attached, rather than being discarded or silently reverted. In v1 a person sends back with a note, which keeps the Worker's measured record clean; `builtBy` per checkpoint ([kernel](kernel.md)) is the schema that makes both measurable later.
- **Squash policy per project** (keep the checkpoint history on the integration branch, or split one card's squash into several intent-grouped Conventional Commits). v1 always squashes into one commit whose body is intent-grouped.
- **Copy-on-write worktree cloning** where the filesystem supports it.
- **Pull-request review comments flowing back into the card thread**, as repair subtasks scoped to the commented lines. Later for the reason in [integrations](integrations.md) §7 (*Review comments → repair subtasks*): a repair subtask that pushes and resolves a thread would let the Worker change a PR after a person accepted the card; in v1 a person answers a PR comment by sending the card back with a note (§2.4).
- **Anchoring the ledger head outside SQLite** beyond the `Ledger-Head` trailer (a `sekhemet log` cross-check against git history) — [kernel](kernel.md).
- **One automatic retry when the Reviewer finds an unmet criterion** (the old integration review's `likely_send_back` → retry). It would let an advisory model gate a card, against §2.3.6; revisit once the acted-on rate of findings (§8.2) is measured.
- **Per-person ReviewWIP and review assignment by load.** v1 computes ReviewWIP per project; the principal on every `review/*` event lets it be derived later without migration.
- **A heavier Accept friction** (for example, scrolling through every hunk), and **uncertainty highlighting in diffs** (the local model's token probabilities are not logged today, and no code-review study of it was verified).
- **Publishing GitHub Releases** and release notes to Slack or Notion; a tag plus notes in the repository is the v1 hand-off.

## 8. Open questions

1. **Should Planning count as Review capacity when a research card's plan awaits approval?** The old design kept research plans in Planning so Review's WIP stays for diffs. *Recommendation:* yes, keep that rule; nothing without a diff enters Review.
2. **What the Reviewer's criterion that a person reads by the twentieth card means in numbers.** *Recommendation:* a finding is *acted on* when a send-back quotes it or the next attempt changes the hunk it cites (the explicit-resolution definition used for review threads in arXiv 2607.21997); if acted-on findings fall below one in five over twenty cards, Review collapses the findings to a count and says why.
3. **Public review data for evaluating the Reviewer and send-back rules.** No public set has TypeScript at scale; the clean, outcome-linked sets are small and mostly Python: c-CRAB (234 test-verified review comments, CC BY 4.0), SWE-PRBench (350 merged PRs with `has_requested_changes`, CC BY 4.0, ~21 TypeScript), CodeReviewQA (900 `old → review → new` triples, MIT). `ronantakizawa/github-codereview` has the right shape but no licence grant and must not be imported. Queued as owner decision [O22](../../reference/OPEN_QUESTIONS.md#owner-decisions) (blocks B4.8; default: approve, for evaluation only and credited). *Recommendation:* with the owner's yes, add c-CRAB and SWE-PRBench as evaluation sets beside the seeded-defect set, and CodeReviewQA as the test of whether induced rules fire on real returns; build a TypeScript set later from permissively licensed repositories.
4. **Self-accept** (research decision 3). *Decided* (owner decision O11, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)), written into §2.4.1: solo developers may accept their own cards; on a project where two or more people hold the Accept permission, neither the builder nor the principal who recorded the latest delegation to the Worker may accept it, whoever owns the card now; a project with one Accept-holder is solo, on a laptop or a server.
5. **Accept friction** (research decision 16). *Decided* (owner decision O13): light — one key per unmet or unclear Reviewer finding and each Implementation file shown once (§2.4.3).

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
- Teams and review ergonomics (§2.1, §2.2.5, §2.4.1–3): the requester of agent work is not an independent approver (GitHub's Copilot rule); CODEOWNERS' last-match rule; files shown last had 64% lower odds of their defect being found (Fregnan et al., ESEC/FSE 2022); LLM-assisted reviewers focus where the LLM pointed (arXiv 2411.11401), hence the coverage line; cognitive forcing reduces over-reliance but is disliked (Buçinca et al., CSCW 2021), hence the light level; under 500 LOC an hour (SmartBear, a vendor source) — [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) §2.1, §2.5, decisions 3, 4, 16, 17. SemVer 0.y.z and the release hand-off (§2.6.7): the same, §2.3, decision 13; git-cliff stays optional, release-please and semantic-release are not dependencies.
- Spec-to-test fidelity as a fail-only Reviewer check, and supersessions and test approvals shown in Review: [DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) §2.1 and decisions 6, 8.
- **Resolved drift and deliberate reversals:**
  - Send back goes to Ready (the code), not In progress — the Worker restarts from the dossier with the note, not mid-attempt.
  - The design's example trailers named `claude-code` as harness — Sekhemet's squashes say `sekhemet`.
  - The Reviewer is a role, so "Seshat's review" in the product becomes "Reviewer" (DEC-05, [NAMING](../NAMING.md)).
  - Review's target is "a decision in under a minute", not "5-second acceptance" — the 5-second figure assumed a diff nobody reads; the minute is what a gated, small card needs.
  - Only an actionable send-back note becomes a playbook candidate, not every return reason — vague review comments poison rule induction (arXiv 2502.02757).
  - Checkpoints after every step that changed files (the product path), not "every 5 steps" nor "at every masking boundary" — rewind and fork must reach any step (`execute.ts:420-422`); there is no masking-boundary trigger in the code, and none is needed once every write is checkpointed.
  - The Reviewer runs once per queue pass on a 24 GB host, not per card — both old rules ("per card before Review" and "once at the end") hold together when passed cards wait in Verify for it.
  - Unpark returns a card to Ready (or to Backlog or Planning if it came from there), not "its previous state" — Parked has no legal edge back to In progress, Verify or Review ([kernel](kernel.md) rule 25), and a card that left a running attempt is re-queued, as a send-back is (review M7).
  - A pull-request-on-accept card waits in Review under a typed `awaitingMerge` hold that the Review count excludes, not in an unnamed "accepted" limbo — kernel has no state for it and none is added (review M10).
  - Auto-accept is a person's recorded standing decision, named on every acceptance, not the harness's own verdict — the spine lets no machine accept, so the only acceptable auto-accept is one a named person turned on (review M20; DEFINITION_OF_DONE §5.1.5).
  - The Reviewer's bar is recall ≥ 0.3 on ≥ 20 seeded defects with ≤ 1 false positive per card, not "better than an empty list", whose recall is 0 (review M5).
  - Self-accept follows the number of people who hold the Accept permission, not whether the project runs on a server, and has no per-project setting — the owner's rule (O11); the earlier `require_independent_accept` setting is dropped, because a team that could switch it off would have no independent acceptance at all.
  - The delegator who may not accept is the principal on the latest `card/delegated` to the Worker, read from the ledger, not the card's current owner — so reassigning a card, on the board or in a tracker, neither lets the delegator accept nor stops a new owner who took no part in it ([integrations](integrations.md) INT-40 builds on RG-N5-8; final check F2).
  - ReviewWIP never falls back to the static limit of 3: a `review_minutes_per_day` of 0 or less is refused where it is set, so the formula's floor of 1 is the only floor (confirmation review n13).
