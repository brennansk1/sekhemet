# Phase A review: domains 2 (kernel and lifecycle) and 9 (review and decisions)

*Read-only review, 2026-09-22, worktree `harness-definition-done-4d9161` at 468f67f. I checked the claims marked **[probe]** by running scripts from the scratchpad against the built `packages/{kernel,board}/dist` and a real on-disk WAL database. The scripts are in `scratchpad/phaseA/probe/`. I did not change any repository file. Spec runs: `log.spec.ts` and `entry_conditions.spec.ts` pass (13/13).*

## Domain 2: Kernel and lifecycle

### 1. Positioning

The structure is right. It has an append-only ledger, projections that can be rebuilt, `verifyProjections` (card_store.ts:1331), typed refusals, and a recorded override. A professional team would recognise it. It is **not yet trustworthy as a system of record**, for four reasons:

- **Poison events [probe].** Every writer appends the event in its own transaction (log.ts:160–194) and then projects it *outside* that transaction (card_store.ts:399–407, 500–514, 563–570). Nothing validates the payload against the projection's CHECK constraints first. The probe ran `createCard({difficulty: 11})` and `updateCardStatus(id, "bogus")`. Both threw, but both events stayed in the ledger. After that, `rebuildProjections()` and `verifyProjections()` **throw on every call**: "CHECK constraint failed: difficulty…". One bad write permanently breaks the "state derives from the log" promise. The dashboard's override endpoint passes an unvalidated `body.toStatus` as `to as never` (server.ts:988–994), so an HTTP request can plant the status variant of this poison event.
- **The state machine can be bypassed [probe].** `transitionCard` checks the edge table against the **caller-supplied** `t.fromStatus`, not `card.status` (board_service.ts:272). If `from === to`, it writes with no check at all (board_service.ts:267–270). In the probe, `{from:"done", to:"done"}` moved a Backlog card to **Done**, and `{from:"review", to:"done", actor:"human"}` did the same. Separately, 11 production call sites skip the board entirely and call `cardStore.updateCardStatus`: research/cards.ts:84,128–136; external_review.ts:141,244,252; planner/decisions.ts:123,209,236; planner/sessions.ts:160; pm/slash.ts:119; recurring.ts:175. Research and external-review cards therefore enter Review without the back-pressure check and without the entry condition. External-review cards enter Review even when their gates fail (external_review.ts:244–247).
- **The audit trail is tamper-evident only against naive edits [probe].** The hash does not cover `created_at` (log.ts:95–105). An edited timestamp still verifies as `valid: true`, and the timestamps are exactly what review-time and WIP are measured from. Deleting the tail also verifies as valid until the next append. If `sqlite_sequence` is reset as well, it verifies as valid after the append too. The schema has no external anchor and no `BEFORE UPDATE/DELETE` trigger (schema.ts:100–113).
- **"human" is not a person.** Actors are a closed enum of role names (types.ts:325–339). The design expects a team, but no event records *which* person accepted, overrode or answered. `answerDecision(…, answeredBy)` accepts any string (records.ts:537–556).

**Is the human the rate limiter? No [probe].** `measuredReviewMinutes` (board_service.ts:230–247) counts every exit from Review, whoever the actor. Under `queue --auto-accept`, the harness moves review→done in under a second (index.ts:1635–1641). I reproduced the calculation. Five sub-second automated reviews at 60 min/day give a limit of **8,977**. The live figure is 7,708 (≈0.47 s median, 60 min/day). Four more problems compound it:
- The limit is calibrated once at process start (index.ts:547) and on an hours change (server.ts:936). It never updates after a decision.
- The Review count is global, not per project (board_service.ts:315).
- The bypassing writers listed above never meet the limit.
- There is no floor or prior, so a single fast review sets the limit.

So back-pressure exists in code (board_service.ts:314–324, and it is tested), but on real ledgers it is effectively off.

### 2. Drift

| Topic | Design | Code |
|---|---|---|
| Hash chain | `(seq, ts, actor, type, cardId, payloadHash, prevHash)` "repeated verbatim" (HARNESS_DESIGN.md:467, 2828) | `prevHash:seq:actor:type:cardId:attemptId:stepId:payloadHash:id`, **no ts** (log.ts:95–105). FEATURE_INVENTORY.md:45 gives a third version. There are three definitions and none matches the code. |
| Entry into Done | "Accepted and merged" | The PR-on-accept path moves the card to Done before the PR merges (execute.ts:1319–1333). Override can reach Done with no merge (entry condition only checks the actor). |
| Review → change requested | Review → In Progress | `sendBack` → **Ready**, from *any* status (triage.ts:49–55) |
| Rejected → Ready "needs a CLI verb" | Required | There are no reject or reopen verbs on the CLI, dashboard or triage. Rejected is reachable only by override or MCP. |
| Verify → Review on "all gates pass" | Entry condition | Bypassed by the research and external-review writers (see above) |
| ReviewWIP from human review minutes | Formula | Counts automated exits (see above) |
| Events are the only durable channel | Invariant | `sendBack` writes `.sekhemet/playbook_candidates.jsonl` (triage.ts:63–68). Evidence is read from `latest-<card>.json` on disk (execute.ts:1233–1242). |
| Actor set | human, planner, worker, reviewer, researcher, gate, system | Adds executor (the default), harness, sync, github, mcp and manager. "worker" and "executor" both exist. |
| "Held" | Not in the nine-state machine | A hidden tenth state encoded as a `blockedReason` string prefix (board_service.ts:347–403) |

### 3. Dead and duplicated code

- **Dead (no importer outside tests):** `packages/kernel/src/container.ts` (`ServiceContainer`, `PluginManager`, `SERVICE_KEYS`, 224 lines) and `retention.ts` (`pruneRetention`, `RETENTION_DAYS`). The design has a retention policy, so retention should be *wired or cut*. Container should be cut, with the owner's sign-off.
- **Unused exports:** `CARD_KINDS` and `scopeExtension` (card_class.ts).
- **Duplication:** one card column is declared in nine places: schema.ts:27–63 and 287–317, card_store.ts:65–140 (two interfaces), 152–197, 259–305, and 1087–1189 (35 positional `?`s). This is the likeliest source of future replay drift.

### 4. Complexity hotspots

- **`card_store.ts` (1,351 lines)** mixes six concerns: cards, dossier, dependency graph, projects, checkpoints, and replay/verification. The "append, then project" step is hand-repeated about 20 times here and in records.ts, which is the root of the atomicity defect.
- **`schema.ts` migrations** have no `user_version`. They are idempotent only because every step sniffs `sqlite_master` text. `rebuildCardsTableIfStale` silently drops every column not in `LEGACY_CARD_COLUMNS` (schema.ts:333–344, 444). That is safe only for the pre-`planning` era it targets.
- **Hot-path cost:** `verifyHashChain()` re-hashes the **whole ledger on every SSE frame** (server.ts:471) and on three more endpoints. `replayAll` loads every event into memory (card_store.ts:1277). `/api/integrity` holds a `BEGIN IMMEDIATE` write lock while replaying (card_store.ts:1338), which can block the Worker's appends past `busy_timeout = 5000`. `measuredReviewMinutes` issues one query per card (N+1).

### 5. Test quality against DoD §2

- **Strengths:** kernel and board tests use real WAL files (tests/support/disk_db.ts). There are real bit-flip tamper tests naming the seq (log.spec.ts:92–140), a real `SQLITE_BUSY` contention test (pragmas.spec.ts:40) and a second-connection test (board.spec.ts:206). There are no `toBeDefined`/`toBeTruthy` assertions.
- **Missing negative cases (each one reproduced above):**
  - poison events, and replay after a failed projection;
  - a lying or equal `fromStatus`;
  - a `created_at` edit;
  - tail truncation;
  - an unvalidated override target;
  - review minutes from non-human actors. The ReviewWIP test (entry_conditions.spec.ts:121–143) hand-writes only `actor:"human"` events, the one input that hides the 7,708 bug.
- card_store.spec.ts has 6 happy-path tests against DoD §2B's "two negatives per happy path".

### 6. Senior judgement (ranked)

1. **Make every write one transaction:** validate, then append and project inside the same `BEGIN IMMEDIATE`. If the projection fails, the event rolls back. This removes poison events and crash-window drift in one change.
2. **Move the transition law into the kernel.** `updateCardStatus(id, to, {expectedFrom})` should compare-and-set against the stored status and reject illegal edges. The board then only adds WIP and entry conditions. The 11 bypass sites have to go through it.
3. **Compute ReviewWIP from human decisions only**, per project, with a prior (e.g. 15 min/card until five reviews exist) and a floor. Recompute it on every decision.
4. **Hash chain v3:** include `created_at`, version the formula per row, add append-only triggers, verify incrementally from the last verified seq, and anchor the chain head outside SQLite (see Proposals).
5. **Split `card_store.ts`** along its seams, strangler-style: `CardRepository`, `DependencyGraph`, `DossierStore`, `ProjectStore` and `Projector`. Drive the column list from one table.

### 7. Verdicts

| File | Verdict |
|---|---|
| kernel/log.ts | **Keep**: hash v3, incremental verify |
| kernel/schema.ts | **Refactor**: `user_version`, triggers |
| kernel/card_store.ts | **Refactor** (split and make transactional) |
| kernel/records.ts | **Keep**: adopt the transactional write helper |
| kernel/hooks.ts, types.ts, canonical_json.ts, order_key.ts | **Keep** |
| kernel/container.ts | **Cut** (dead; owner sign-off) |
| kernel/retention.ts | **Wire or cut** (owner decides) |
| board/board_service.ts | **Refactor**: from-status bug, WIP, held-as-state |

## Domain 9: Review and human decisions

### 1. Positioning

The triage verbs share one implementation for the CLI and the dashboard (triage.ts:10–17), send-back requires a reason, and every park has an undo. That is good practice and teaches a beginner the right habit. The Accept decision is the weak point:

- **Accept merges first and asks the board second.** `squashAndMerge` runs (execute.ts:1344–1354) *before* `transitionCard(→done)` (1356–1362). If the board refuses, `main` already holds the merge and the card stays in Review. A security-gate refusal is one such case. There is no rollback.
- **Accept operates on the user's own checkout.** `git checkout main && git merge --squash && git commit` runs in `repoRoot` (git_adapter.ts:543–546). It switches the person's working copy. If there is a conflict (for example, main moved after the rebase), it leaves conflict markers on `main` with no cleanup. There is no lock against two concurrent accepts.
- **The merged content is not tied to what was reviewed.** acceptCard never compares the branch head with the evidence bundle's repo-state hash. *I found no check. Uncertain whether one exists elsewhere.*
- **Accept cannot be reversed.** Done→Ready is a legal edge, but nothing reverts the squash commit.
- **Attribution is incomplete.** The squash trailers hard-code `GateStatus: pass` and `Agent-Role: implementer` (execute.ts:1349–1353). There is no trailer for who accepted (a human or `--auto-accept`) and no link to the ledger. `ACCEPTING_ACTORS` includes `"harness"` (board_service.ts:110), so any path using that actor can reach Done. external_review.ts uses it too.
- `structuralDiff`, a read path, runs `git add -A` in `repoRoot` when the worktree is gone (git_adapter.ts:704–709).

### 2. Drift: the Reviewer

| Design ("The Reviewer") | Code (learning/review.ts, index.ts) |
|---|---|
| Question: "does this change do what the card asked?" | Prompt: "do not re-check correctness… judge only… preferences and rules" (review.ts:26) |
| Inputs: spec, criteria, diff, gate results | Title, diff (**silently cut at 12k chars**), preferences, rules. No criteria, no gate results |
| Per-criterion `{criterion, verdict: met/unmet/unclear, evidence: file:line}` | `{severity: consider/likely_send_back, note}` (review.ts:14) |
| Runs on every card entering Review | **Returns `[]` when there are no learned preferences or rules** (review.ts:23), so it never runs on a new project. When it does run, it is at the end of the queue pass (index.ts:1883–1890), *after* `--auto-accept` has already merged (1635–1641). |
| A different family, enforced by the registry | `family` exists in the registry but nothing reads it. The default reviewer is the manager (index.ts:1598) |
| Unfilled role shown in Review | Not shown |

Where the Reviewer is right: it has no authority (dossier entries only, execute.ts:1448) and it excludes the Worker's transcript.

Git drift:
- The design wants the squash to target the integration branch or the project's `git_branch`. The code hard-codes `"main"` (execute.ts:1346).
- The design wants intent-grouped commits. The code makes one commit with an intent-grouped body. That is acceptable.
- Checkpoint refs are kept correctly (git_adapter.ts:473–476).

### 3. Dead and duplicated code

`ReviewFinding` is declared twice with different shapes (execute.ts:1438, learning/review.ts:14), plus `ExternalFinding` (external_review.ts), and none matches the design's type. `acceptCard` (execute.ts:1304) lives in a 1,600-line runner file, away from the other decisions in triage.ts. I found no dead code in this domain.

### 4. Complexity hotspots

`acceptCard` has two divergent paths (PR and local), each with its own ordering. `index.ts:1560–1900` interleaves review, auto-accept and learning in the queue loop. `squashAndMerge` (git_adapter.ts:481–547) does trailers, message rewrite and merge in one function.

### 5. Test quality

- **Git tests are real** (real repositories, refs and trailers; git_wave2.spec.ts:211–232 refuses an unattributed squash).
- **Untested:**
  - a squash conflict;
  - accept when the board refuses after the merge;
  - accept with a dirty user checkout;
  - concurrent accepts;
  - Reviewer behaviour, including the empty-preferences early return and truncation;
  - send-back from a non-Review state.

### 6. Senior judgement (ranked)

1. **Make Accept transactional and safe:**
   1. Check the board's preconditions and the evidence head against the branch head.
   2. Merge with plumbing (`git merge-tree --write-tree` → `commit-tree` → `update-ref refs/heads/main <new> <expected-old>`), never touching the user's worktree.
   3. Transition the card.
   4. Record `card/accepted` with the sha.

   A failure at any step leaves nothing half-done.
2. **Rebuild the Reviewer to the design contract:** per-criterion findings with a hunk citation, run before the card is shown in Review (and before auto-accept), and an enforced family check.
3. **Add the missing verbs:** `reject`, `reopen` and `revert-accept` (a revert commit plus Done→Ready), on the CLI, the dashboard and MCP.
4. **Principal plus trailers:** record who decided (`git config user.email`, OS user or dashboard session) on human events, and add `Accepted-by:`, the real `GateStatus` from evidence, and `Ledger-Head: <seq>:<hash>` to the squash commit.
5. **Move `acceptCard` into triage.ts**, collapse the two paths, and write playbook candidates to the ledger instead of JSONL.

### 7. Verdicts

| File | Verdict |
|---|---|
| apps/harness/src/triage.ts | **Keep and extend** |
| execute.ts `acceptCard` | **Refactor**, then move |
| learning/review.ts (the Reviewer) | **Rebuild** to spec |
| sync/git_adapter.ts | **Refactor** `squashAndMerge` and `structuralDiff`; keep the rest |
| external_review.ts | **Keep**; route its moves through the board |

## Proposals (the owner decides; nothing added)

| Proposal | Licence | Maintenance signal | Replaces or adds | Why |
|---|---|---|---|---|
| **Zod v4** (or **Valibot**) event-payload registry | MIT (both) | Zod: very active, huge adoption. Valibot: active. | A schema per event type, checked in `append` and on replay. Replaces the `as never` payload casts. | Stops poison events at the source. Makes replay and projection type-safe. |
| **`git merge-tree --write-tree` plumbing** (git ≥ 2.38, no library) | GPL-2 git binary, already a dependency | Upstream git | Replaces checkout plus `merge --squash` in the user's repository | Merge preview without touching the working tree. Compare-and-set `update-ref` prevents lost or racing accepts. |
| **Chain-head anchoring** (feature) | — | — | Adds `Ledger-Head` to every squash commit, plus a `sekhemet log` cross-check against git history | Catches rewrites and tail truncation, which an unanchored in-database chain cannot. Git is already the system of record. |
| **PRAGMA `user_version` migrations** (no library), or **umzug** | umzug: MIT | Active, from the sequelize organisation | Replaces DDL-text sniffing in `migrateSchema` | Numbered, testable migrations. I lean to no library: the need is about 30 lines. |
| **Review-time events** (feature) | — | — | `review/opened` (the dashboard showed the evidence) and `review/decided` (actor, principal) | A real measure of human minutes for ReviewWIP, instead of state-change gaps. |
| *Considered and rejected:* XState v5 (MIT, active) | | | | The edge table is 10 lines and correct. The defect is the trusted `fromStatus`, not a missing framework. |

## Top 5 changes across both domains

1. **Transactional, validated ledger writes.**
   - *What:* one kernel `commit(event, project)` that validates the payload, then appends and projects in a single transaction.
   - *Why:* the probe showed one out-of-range write makes `rebuildProjections`/`verifyProjections` throw permanently (card_store.ts:399–407, 500–514; server.ts:988 exposes it over HTTP).
   - *Effort:* M. *Risk:* medium, because it touches every writer and replay must stay byte-identical. Mitigated by `verifyProjections` on the suite ledgers before and after.
   - *Measured by:* new spec tests for poison events that fail today (red) and then pass (green). `verifyProjections().identical` holds on every existing `.sekhemet/events.db`.
2. **Transition law in the kernel, with compare-and-set.**
   - *What:* check the edge against the stored status. Remove the same-status bypass. Route all 11 direct `updateCardStatus` callers through it.
   - *Why:* the probe moved Backlog→Done via board_service.ts:267–272; research and external cards skip back-pressure.
   - *Effort:* S–M. *Risk:* low to medium, because research and external flows need explicit legal paths.
   - *Measured by:* negative tests (lying from-status, equal status); zero direct callers outside the kernel and board (grep in CI).
3. **ReviewWIP that measures humans.**
   - *What:* count human decisions only, per project, with a prior and a floor; recompute on each decision; add review-time events.
   - *Why:* 7,708 live and 8,977 in the probe (board_service.ts:230–247; index.ts:547, 1635–1641).
   - *Effort:* S. *Risk:* low.
   - *Measured by:* a test with harness auto-accepts mixed in; the live ledger's computed limit falls into single digits; the dashboard shows back-pressure engaging during a queue run.
4. **Safe, reversible Accept.**
   - *What:* check preconditions, then merge with plumbing and CAS, then transition, then record. Add Accepted-by, the real GateStatus and Ledger-Head trailers, and reject, reopen and revert-accept verbs.
   - *Why:* the merge happens before the board check (execute.ts:1344–1362); it runs checkout/merge in the user's tree with no conflict cleanup (git_adapter.ts:543–546); design verbs are missing.
   - *Effort:* M–L. *Risk:* medium (git plumbing edge cases, and the PR path).
   - *Measured by:* real-git tests for a conflict, main having moved, a refused transition, a dirty user checkout and concurrent accepts. The user's `HEAD` and index are unchanged after accept.
5. **Reviewer rebuilt to the design contract.**
   - *What:* per-criterion met/unmet/unclear findings with a file:line citation, from spec, criteria, diff and gates; run before Review and before auto-accept; enforce the family check; say in Review when the role is unfilled.
   - *Why:* the current Reviewer checks style only, never runs without learned preferences (review.ts:23), and runs after the merge.
   - *Effort:* M. *Risk:* low (advisory only).
   - *Measured by:* the design's own criterion. On seeded gate-passing defects in the frozen suite, it flags more than an empty list does, with a false-positive rate tracked per card.

*Uncertainty:* the probes ran against `dist/`, not `src/`. The kernel and board sources were not changed by the last two commits, so I believe `dist` matches, but I did not rebuild it to confirm. I did not trace where the live 7,708 ledger lives. My reproduction matches its magnitude (about 0.47 s median at 60 min/day).
