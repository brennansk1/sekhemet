---
spec: integrations
status: partial
audiences: [developer, non-developer]
code:
  - packages/sync/src/types.ts
  - packages/sync/src/remote.ts
  - packages/sync/src/github_app.ts
  - packages/sync/src/webhook.ts
  - apps/harness/src/integrations.ts
  - apps/harness/src/wave2_github.ts
  - apps/harness/src/wave2_server.ts
  - apps/harness/src/external_review.ts
  - apps/harness/src/notify.ts
  - apps/harness/src/execute.ts
  - apps/harness/src/github_transport.ts
  - apps/harness/src/codeowners.ts
tests:
  - packages/sync/tests/remote.spec.ts
  - packages/sync/tests/github_one.spec.ts
  - packages/sync/tests/sync.spec.ts
  - packages/kernel/tests/identity_links.spec.ts
  - apps/harness/tests/github_first.spec.ts
  - apps/harness/tests/wave2_github.spec.ts
  - apps/harness/tests/wave2_server.spec.ts
  - apps/harness/tests/external_review.spec.ts
  - apps/harness/tests/notify.spec.ts
  - apps/harness/tests/pm_api.spec.ts
  - packages/loop/tests/untrusted.spec.ts
  - packages/loop/tests/runner_depth.spec.ts
  - packages/context/tests/worker_prompt.spec.ts
changes: [P9, S3c, NEW-integrations-1, NEW-integrations-2, NEW-integrations-3]
---

# Integrations: GitHub, Jira, Linear, notifications, and identity in the Team setup

## 1. Purpose

Sekhemet sits beside the tracker and the code host a team already uses; it does not replace them ([DEC-23](../DECISIONS.md#dec-23--what-the-harness-is-not)). This spec covers how cards reach GitHub, Jira and Linear, how people are told when they are needed, and — for the Team setup ([DEC-06](../DECISIONS.md#dec-06), [DEC-35](../DECISIONS.md#dec-35--one-product-two-setups-solo-and-team)) — where each person's identity comes from and who may Accept. Accounts, access levels, the Inbox and @mentions of people are [teams](teams.md)'s. It serves developers (the board fits their workflow) and non-developers (they are notified and can act without a terminal); the spine rule it guards is that the human, and the right human, decides.

## 2. Behaviour

### Principles

1. **Every integration is opt-in and off until connected.** Connecting one is consent to send card content to that service; every request it makes is logged on the ledger ([security](security.md) item 33). The harness works fully offline with none connected.
2. **Tokens and webhook URLs never enter the repository or the ledger.** They live in the user directory or the OS keychain ([security](security.md) item 35).
3. **External text is untrusted.** Issue bodies, comments and synced fields enter prompts wrapped as untrusted content ([security](security.md) item 42).
4. **Ownership of fields.** The board owns what the harness decides — status, gate results, budgets, evidence. The tracker owns what people write there — title, description, assignee, labels. A shared field changed on both sides is resolved per field by a three-way merge against the snapshot taken at the last sync; the losing value is kept in the card's history. Only a field **both** sides changed since the snapshot is a true conflict, and there the newer value wins (INT-6). *Changed from the old design's whole-card last-writer-wins by timestamp:* a board move no longer overwrites a title a person edited in the tracker.
5. **Mid-card edits** (DEC-25 R6; [OPEN_QUESTIONS](../../reference/OPEN_QUESTIONS.md#design-questions-still-open)). The Worker is never paused for an external edit. An edit to a running card is recorded on the card when the sync sees it; a non-scope field is applied when the card completes. At the card's end its result is re-checked against the edited acceptance criteria and scope: if either changed, the card goes to Planning with the change named, instead of to Review. *Changed from the old design's "a scope or criteria change pauses the card and posts a decision request":* a paused Worker holds its model and worktree for a question the end-of-card check answers anyway.
6. **Owner, delegate and accepter.** A person stays the card's owner (assignee) and remains responsible for it; the Worker is the delegate that does the work — the convention Linear, Jira and GitHub have settled on for agents. Synced assignees are people, never "worker"; the delegate is shown separately. The card's `owner`, `delegate` and `accepter` fields are [kernel](kernel.md)'s (rule 21); on export and sync the owner maps to the tool's assignee and the delegate to the tool's agent field, or to a label where the tool has none (NEW-integrations-2). The **accepter** — the person who accepted the card — is never written to the tool's assignee: it is recorded on `card/accepted` (INT-23) and, with pull-request-on-accept, named in the pull request's body.
6b. **A tracker cannot make a self-accept possible** (owner decision O11, decided 2026-09-24, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)). Solo developers may accept their own cards; on a project where two or more people hold the Accept permission, the person who built a card, or who delegated it to the Worker, may not accept it ([review-git](review-git.md) §2.4.1 owns the rule). Independence is judged from the ledger — the principal who recorded the latest `card/delegated` to the Worker ([kernel](kernel.md) rule 21) and each attempt's `builtBy` (rule 22) — never from the tracker's current assignee or the card's current owner, so reassigning the synced issue to someone else changes the card's owner but not who delegated it: the delegator still may not accept, and the new owner, who neither built nor delegated it, may ([review-git](review-git.md) RG-N5-8). A tracker assignee who maps to no principal on the server leaves the owner unchanged and is recorded as a `sync/conflict`.
6a. **The column does not move itself.** Trackers now let a column transition hand a ticket to an agent. Sekhemet's difference is that a synced card cannot reach Review until its gates pass and cannot reach Done until a person accepts, whatever the tracker's workflow does; a tracker-side move to Done on a card that has not passed is reported back as a conflict, not applied.

### One adapter interface

7. Every tracker is a `SyncAdapter` with `pull(since)`, `push(card)`, `update(ref, patch)` and declared capabilities (hierarchy, dependencies, webhooks, maximum depth). Hierarchy depth is clamped to the shallower of the board's levels and the tracker's.
8. One external identity per item: `ExternalRef { system, id, url }`, `system` ∈ `github`, `forgejo`, `jira`, `linear`. For GitHub the `id` is `owner/repo#n` on every path (PM_CONTRACT §2).
9. Sync is idempotent: pulling twice creates nothing the second time; an item already linked by `externalRef` is updated, never duplicated, whichever transport brought it.

### GitHub (first)

10. **One adapter, two transports.** The user's own `gh` login, or a GitHub App installed per repository. The App signs RS256 JWTs and exchanges them at `POST /app/installations/{installation_id}/access_tokens` for 1-hour installation tokens. Private keys come from the OS keychain, or an environment/file source on Linux. GitHub Enterprise Server uses configured `api_url` and `graphql_url` with a custom CA bundle. The App asks for: Contents, Issues, Pull requests, Checks, Commit statuses and Security events read/write; Metadata read-only. No personal access tokens are required. *(Private keys outside the keychain on Linux: the same fallback as tokens, [security](security.md) item 35.)*
11. **Pull and push.** Issues are pulled with pagination until exhausted (never one page), sub-issues become subtasks, and board wins on shared fields are pushed back so the two sides converge. REST, GraphQL and the token exchange all back off on primary and secondary rate limits, honouring `retry-after`.
11a. **Economy with the API.** Webhooks are preferred over polling: where a webhook route exists, a pull is only a catch-up after missed deliveries or a restart. GraphQL is used where it saves round trips — one query per page fetches issues with their sub-issues and labels, not one call per issue — and GraphQL's point budget is tracked apart from REST's request budget, because GitHub meters them separately. Every synced entity carries an idempotency key (its `externalRef` and the tracker's `updatedAt`), so a retried push or a redelivered webhook changes nothing twice.
12. **Webhooks.** Verified by HMAC-SHA256 (`X-Hub-Signature-256`) before anything is parsed; each `X-GitHub-Delivery` is processed at most once. Intake:

| Event | Condition | Action |
| --- | --- | --- |
| `issues.labeled` | label `sekhemet` | create a card linked to the issue; sub-issues become subtasks |
| `issue_comment.created` | `/review` on a pull request | an external review card (below) |
| `pull_request.labeled` | label `sekhemet:review` | an external review card |
| `pull_request.opened` | author Dependabot or Renovate | a verification card that runs the full gates; auto-merge only if the project's policy allows |
| `pull_request.closed` | a PR the harness opened, matched by its repository and number | moves its card as item 15 says |

13. **External review cards.** A review card targets a PR the harness did not open: it runs the Reviewer procedure and the gates on a checkout, never edits, and posts its findings as a review.
14. **Checks.** Each gate run on a card with a PR becomes a Check Run (`queued` → `in_progress` → `completed`, `success` or `failure`); typed gate failures become line annotations (path, lines, level, message, title, and `raw_details` carrying the error code or the gate rung), redacted first; security gates upload SARIF v2.1.0 (gzip, base64) to code scanning. Checks can be made required in branch protection.
15. **PR on Accept, merge-aware.** When PR-on-accept is on, Accept pushes the card branch to the configured remote and opens a draft PR against the project's configured integration branch ([review-git](review-git.md); [gates](gates.md) rule 16), with the evidence summary (gates, diff stats, coverage, abandoned attempts) as its body; it becomes ready when its checks pass and CODEOWNERS reviewers are requested; merging follows the repository's policy (auto-merge, merge queue, or a person). **The card is Done only when the PR is merged.** Until then the card stays in Review, held `awaitingMerge` ([kernel](kernel.md) rule 24). A PR closed unmerged clears the hold and the card's accepter, so the card is again an undecided card in Review, counted toward the WIP limit, with the closure and who closed it recorded (K-N3-4). How "awaiting merge" appears on the board is [review-git](review-git.md)'s and [kernel](kernel.md)'s; which people are suggested or required as accepters from `CODEOWNERS` is review-git's too.
15a. **Results from someone else's CI name their source.** When the harness reads a check result it did not run — the PR's other checks, deciding "ready when its checks pass" — it records the result with `source: external`, the check's name, its run URL and the head SHA it ran on. An external result is advisory: it never replaces or satisfies a local blocking gate unless the project declares that check blocking, and a result for a SHA other than the card branch's head is not evidence for the card. The `source` field on gate results is [gates](gates.md)'; running CI as a gate rung is Later (§7).
16. **The queue's own `--auto-accept`** (actor `harness`, used by the frozen suite) always merges locally and never opens a PR.
16a. **Agent status on the issue.** A card linked to a GitHub issue shows its state on the issue and the project board in the four statuses GitHub uses for agent sessions — *queued* (Ready), *working* (Planning, In Progress, Verify), *waiting for review* (Review), *completed* (Done) — as the Projects status field, and through GitHub's agent-session surface where it is open to third-party apps. The issue's assignee stays the person.

### Jira and Linear (v1: export and import)

17. **Export** writes the board in each tool's own import format: Jira CSV (Summary, Issue Type, Priority, Story Points, Sprint, Epic Link, Labels, Description), Linear CSV/JSON (title, priority 0–4, estimate, cycle, project, labels), GitHub JSON, or raw JSON. CSV follows RFC 4180. The file carries each card's key.
18. **Import** reads those formats and returns PM proposals — never applied silently. A row whose key or identifier matches an `externalRef` updates that card's proposal instead of creating a card, so export followed by import duplicates nothing.
19. Live two-way sync with Jira or Linear is not in v1 (SPINE, "Not in v1").

### Notifications (one notifier)

20. One notifier tails the ledger and sends what needs a person, through channels the user connected: ntfy or Gotify (push), and Slack incoming webhooks; Microsoft Teams webhooks later. Slack is a channel of the same notifier, not a second pipeline. In the Team setup a notice is addressed to a person: it follows the Inbox's reasons and subscriptions, and an email or chat digest carries only items still unread in their Inbox ([teams](teams.md) items 22–24); each person picks the reasons that reach them under Notifications ([dashboard](dashboard.md) §2.2.6).
21. Kinds: `review` (a card passed its gates and waits), `parked`, `budget` (parked by a budget), `question` (the Worker asked), `decision` (a decision request waits), `standup` (Seshat's daily report), `needs_you` (anything waiting on a person, summarised), `run_report` (a queue run finished). The user chooses kinds per channel.
22. It starts after the current last event (no replay of history), polls every 5 s, and never sends the same (kind, card) twice within 10 minutes. Every send is recorded as `pm/notify` with `{ channel, kind, ok }`.
23. Push notifications go to the user's own ntfy or Gotify server; `ntfy.sh` only if the user chooses it. Approving or parking from a phone needs nothing cloud-hosted beyond what the user picked.
23a. **A budget on interruptions.** Unsolicited messages to one person are capped at 3 a day by default and never more than 5, whatever the configuration ([planner-pm](planner-pm.md) owns the budget; this notifier applies it); past the cap — the fourth, by default — notices are held for the next standup, which carries them in its `needs_you` summary; none is sent while the person is actively using the board. A notice offers the action ("3 cards wait for review — open Review"), it does not nag, and none repeats a notice the person has already acted on. Replies to something the person asked for are not counted.

### People in the Team setup (identity and Accept)

24. In the Team setup ([runtime](runtime.md) owns binding; [teams](teams.md) owns accounts and sessions) every request is made by a **person**. Identity comes from the sources listed in `[identity] sources`, set in the server's user configuration, never the repository's:
   - an identity-aware proxy's user header, trusted only when the request arrives from an address in `trusted_proxies`; from any other address the header is ignored and the request is unauthenticated ([teams](teams.md) item 13);
   - local accounts — email and password, and passkeys (DEC-38) — joined by invite, with personal access tokens (stored hashed) for the CLI and MCP clients ([teams](teams.md) items 10–16; superseded in part by DEC-35: "each with its own token" was the sign-in);
   - company SSO over OIDC (DEC-38) ([teams](teams.md) item 12).

   Who may accept is **the project's Accept rule** ([teams](teams.md) §2.2 item 7), which replaces the `accepters` list (superseded by DEC-35).
25. Every event a person causes records who they are; no person-caused event is recorded as an anonymous `human`, and no model role's event (a Worker question, a Seshat reply) is ever attributed to a person.
26. **Access levels and the Accept rule** (superseded by DEC-35: DEC-06's "one permission beyond reading" became four access levels, [teams](teams.md) item 6). Accept, override and revert are held by the people the project's Accept rule names; send back, park and unpark, run cards and apply PM proposals need the **Member** level. Every signed-in person may read the board and evidence and ask Seshat questions; a Viewer gets answers only, with no proposals, and a **Stakeholder**'s messages may create proposals, which a Member applies ([teams](teams.md) item 19a). Being named in the Accept rule does not make every accept allowed: which cards a person may accept is O11's rule (item 6b).
27. A refused decision is answered with who may make it; it changes nothing and is recorded.
28. On a single machine bound to loopback (the Solo setup, [teams](teams.md) item 1), the one local user is the only person and an accepter; nothing above changes their experience. A project with one person holding Accept is solo, on a laptop or a server, and that person accepts their own cards (O11; recorded `independent: false`, [review-git](review-git.md) §2.4.1).

## 3. Contract

| Item | Source |
| --- | --- |
| `SyncAdapter`, `ExternalItem`, `SyncCard` (`owner`, `delegate`), `FieldConflict`, `SharedFields`, `mergeThreeWay`, `githubIssueId`, `issueNumberOf`, `DELEGATE_LABEL` (`delegate:sekhemet-worker`) | `packages/sync/src/remote.ts` |
| `ExternalRef` | `packages/kernel/src/types.ts:101` (`system`) |
| `GitHubClient` (`rest`, `restPages`, `graphql`; one backoff for REST, GraphQL and the token exchange; a **required** `fetch` — the caller's network policy, never the global one), `ClientOptions`, `FetchLike`, `loadPrivateKey`, `GitHubEndpoints`, `PullRequestLifecycle` | `packages/sync/src/github_app.ts` |
| The two transports behind the one client: `githubTransport` (the App, else `ghTransport`: the `gh` login's token), `GhUnavailableError` (`not_installed`, `not_logged_in`, `no_repository`); `connectedPolicy` (under an allowlist the connected API host and the git host it serves are allowed; `offline` refuses; a denied host stays denied), `integrationFetch(repoPath, record, apiUrl, purpose)` (every request decided and recorded, the request waiting for its record, a refusal naming the setting), `integrationRefusal`, `networkHint`, `decideEgress` (a request not sent through `fetch` — the API host before a push, the `git push` — decided and recorded first), `remoteDestination` (a remote's URL without credentials, and its host), `egressRecorder` (returns the ledger write), `githubRepoOf` and `githubRepoOfUrl` (`owner/repo` from `git remote get-url`, locally: `[review] remote`, then `origin`, then any; never `gh repo view`) | `apps/harness/src/github_transport.ts` |
| Identity links: `CardStore.linkIdentity(principal, system, handle, by)`, `principalForHandle`, `handleOf`; event `person/identity_linked {principal, system}` with the login private | `packages/kernel/src/card_store.ts`, payload registry |
| CODEOWNERS: `readCodeowners(repoPath, branch?)` (`git show <integration branch>:<path>`, never the working tree), `ownersOf`, `suggestedAccepters` | `apps/harness/src/codeowners.ts` |
| `verifySignature`, `intentFor`, `WebhookIntent`, `githubWebhookHandler` (`claimDelivery`) | `packages/sync/src/webhook.ts`; `claimDelivery`, `settleDelivery` in `wave2_server.ts` |
| `GitHubIssuesAdapter(repo, client)`, `ForgejoIssuesAdapter(baseUrl, repo, token, fetch)`; `reconcileExternalEdit` (`apply_on_completion`, or `replan_on_completion` with `change: scope \| criteria`) | `packages/sync/src/remote.ts` |
| `syncViaAdapter(adapter, store, log, since, direction)` (`SyncDirection`: `pull` takes the tracker's changes and sends nothing, `push` sends and changes nothing on the board, `both`; result `{created, updated, scopeChanged, pushed, linked, clamped, errors}`), `findLinkedCard`, `recordSnapshot`, `advancePullRequests`, `advanceOpenPullRequests` (INT-12b on either transport), `forgejoFromEnv(fetchFor)`, `subIssuesLabel` | `apps/harness/src/wave2_github.ts` |
| INT-11a at the card's end: a passing card with a `sync/scope_changed` recorded since its run began moves to Planning, the reason naming the changed fields | `packages/loop/src/card_runner.ts` (`scopeChangedSince`) |
| A linked card's title tagged untrusted in the card contract (its spec in the goal) | `packages/context/src/worker_prompt.ts`; `packages/loop/src/session.ts` |
| Integration settings (`~/.config/sekhemet/repos/<repo>-<hash>.json`), export/import, Slack | `apps/harness/src/integrations.ts` |
| `startNotifier`, `noticeFor`, `sendPush`, `PushSettings` | `apps/harness/src/notify.ts` |
| HTTP: `GET /api/integrations`; `POST /api/integrations/github/sync`; `GET /api/export?format=`; `POST /api/import`; `PUT /api/integrations/github-pr`; `PUT` and `DELETE /api/integrations/slack`, `POST …/slack/test`; `PUT /api/integrations/push`, `POST …/push/test`; `POST /webhooks/github` | shapes in [PM_CONTRACT.md §3 and §5](../PM_CONTRACT.md); routes in `integrations.ts:652-841`, `wave2_server.ts:158` |
| Events, each with a registered payload schema ([kernel](kernel.md) rule 33): `sync/snapshot {ref, updatedAt, itemHash, agreedHash, boardOwner, worker}` with the item and the agreed fields — logins and the issue's text — private and erasable (an erased snapshot is no base); `sync/conflict` (`{fields: [{field, winner, at}]}` with the values private, or `{field: "assignee", reason: "unmapped"}` with the login private); `sync/scope_changed {id, fields, change}` (INT-11a); `sync/clamped {id, ancestor, ref, maxDepth}` (INT-11e); `github/delivery {delivery, intent}` (event id derived from the delivery id); `harness/egress {urlHash, host, purpose, allowed, reason?, status?, payloadHash, at}` with the URL in the private part (its path and query can carry what a person asked; `egress_event.ts`, B4.9 lead review) (purposes `integration:github`, `integration:forgejo`; a push's URL without credentials); `person/identity_linked`; `card/pr_closed {…, mergeCommit?, closedBy?}` (the closer's unlinked login private); `pm/notify`; `card/accepted` | `wave2_github.ts`, `wave2_server.ts`, `github_transport.ts`, `notify.ts`, `accept.ts`; `packages/kernel/src/payload_registry.ts` |
| Env (developer and CI use): `SEKHEMET_GITHUB_APP_ID`, `_INSTALLATION_ID`, `_APP_KEYCHAIN`, `_APP_KEY_PATH`, `_HOST`, `_REPO`, `_AUTOMERGE`, `_WEBHOOK_SECRET`, `SEKHEMET_FORGEJO_*` | inventory in [surface](surface.md) |
| Config: `[review] remote` (default `origin`, the remote pull-request-on-accept pushes to), `[review] require_code_owner_accept` (default false; review-git RG-N5-4) | `apps/harness/src/config.ts` |
| Identity keys (new): `[identity] sources = ["accounts", "proxy", "oidc"]`, `user_header`, `trusted_proxies` (the full list, with sessions and the queue, is [teams](teams.md) §3); `accepters` is replaced by the project's Accept rule (DEC-35) | [teams](teams.md) §3; server user config |

The integration tiers (now, next, later) and the reasons for GitHub first (Stack Overflow 2025: GitHub 81%, Jira 46%) are in [PM_CONTRACT.md §5](../PM_CONTRACT.md); this spec overrides its "Jira/Linear live sync: next" only by keeping it out of v1.

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Export Jira CSV, Linear CSV, GitHub JSON, JSON (RFC 4180) | built | `integrations.ts:240-392`; `pm_api.spec.ts` | — |
| Import as PM proposals | partial | `integrations.ts:413-475`; keys ignored, `externalRef` not set, re-import duplicates | NEW-integrations-1 |
| One adapter, two transports | built (B4.9) | `syncGithub` runs the one `GitHubIssuesAdapter` over the one `GitHubClient`, whose token is the App's or the `gh` login's (`gh auth token`; `gh` runs no other command — the repository is read locally from `git remote get-url`, never `gh repo view`), or Forgejo when configured; the `gh` issue-list path is gone. On the `gh` transport the install's person is linked to the login once (`GET /user`). Every request — GitHub, Forgejo, the external review's poster, the queue's pull-request advance — goes through `integrationFetch`: the network policy, the connected API host allowed under an allowlist, refused offline; each is recorded as `harness/egress`, and a request whose record the ledger cannot write fails. `GitHubClient` takes no request without the caller's `fetch` (`github_first.spec.ts` M5, against a fake `gh` on `PATH` and a local server serving GitHub's documented example payloads) | — |
| Offline by default, said plainly | built (B4.9) | A refused integration request names the setting that would allow it (`[network] mode`, `fetch_allow`, `fetch_deny` in the user's `config.toml`); the Integrations status of a repository the policy cannot reach reads "blocked by network mode" with the same hint (`github_first.spec.ts`) | — |
| Logins and issue text off the chain | built (B4.9) | `sync/snapshot` keeps its ref, the tracker's `updatedAt` and SHA-256 hashes on the chain, the item and agreed fields in the private part; `sync/conflict`, `sync/scope_changed`, `sync/clamped`, `github/delivery` and `harness/egress` are registered, so a login in a payload is refused; erasing the private parts leaves no copy of a login in any table, and the next sync goes on (`github_first.spec.ts` B2) | — |
| Pagination; every issue pulled | built (B4.9) | `GitHubClient.restPages` follows `Link: rel="next"` until exhausted, never off the configured API's origin (`github_one.spec.ts` INT-2) | — |
| Three-way merge of shared fields; board wins pushed | built (B4.9) | `mergeThreeWay` against the `sync/snapshot`'s agreed fields: tracker-only changes come to the board, board-only changes are pushed, only a field both changed is a conflict, newer wins, the other value kept (private) on `sync/conflict` (`github_one.spec.ts` INT-4…6; `github_first.spec.ts` INT-3, INT-4, INT-5) | — |
| Webhook intake | built (B4.9) | Signature before parsing (INT-10); each delivery at most once, across restarts — `github/delivery` on the ledger, an in-flight set between check and record (INT-9); `/plan`, `/split`, `/estimate` and `workflow_dispatch` ignored, not recorded (INT-11); a new card is found or created by its one identity with the issue's labels and records the agreed snapshot with them, so the next sync changes nothing; the board's `sub-issues:` label is never synced or replaced by the tracker's labels (M2); `pull_request.closed` moves only the card whose `card/pr_opened` names the same repository and number (M3); the text is kept as written and tagged untrusted where it reaches the Worker — the title in the card contract, the spec in the goal (INT-32; `github_one.spec.ts`, `github_first.spec.ts`, `wave2_server.spec.ts`, the loop's `untrusted.spec.ts`) | — |
| One ID | built (B4.9) | `owner/repo#n` on the adapter, the webhook and the `gh` transport (`githubIssueId`); a card linked before, by a bare number with the same URL, is found and moved to the one ID on its next sync (`findLinkedCard`; INT-1) | — |
| Mid-card edit reconciled on completion | built (B4.9) | a tracker edit to a running card is not applied; the snapshot keeps the old base, so the sync after the card leaves In progress or Verify applies it (INT-7) | — |
| The sync's direction | built (B4.9) | `pull` takes the tracker's changes and sends nothing — no update, no new issue; `push` sends the board's changes and changes nothing on the board — no card, field or owner — and does not move the pull's `since`; a change a direction does not carry keeps the old base, so the next sync that carries it still sees it (`github_first.spec.ts` M6) | — |
| Labels | built (B4.9) | a push carries the merged labels, so a label the tracker added is kept when the board changes the delegate (M1) | — |
| Hierarchy depth clamped to the tracker's | built (B4.9) | a card nested deeper than the adapter's `capabilities.maxDepth` is not written; it is linked once to its nearest written ancestor (`sync/clamped`) and listed in the sync result's `clamped` (INT-11e; `github_first.spec.ts`). GitHub declares 2, which the board's card-and-subtask nesting never exceeds; Forgejo declares 1 | — |
| Scope or criteria edit on a running card | built (B4.9) | the sync records `sync/scope_changed {fields, change}` on the card once — no decision request, no pause; at the card's end a passing card with one recorded since its run began goes to Planning, the reason naming the changed fields, instead of to Review; the next sync applies the edit (INT-11a; `wave2_github.spec.ts`, `runner_depth.spec.ts`) | — |
| Owner, delegate and accepter mapped on export and sync; independence judged from the ledger | built (B4.9) | People's logins are linked to principals (`person/identity_linked`, the login private and erasable). Sync and push write the owner's login as the assignee and the Worker as the `delegate:sekhemet-worker` label, never "worker" as a user; a tracker reassignment to a linked login changes the owner, and independence stays the ledger's (`accepterCheck`: the delegator still refused, the new owner allowed); an unlinked login leaves the owner, is recorded once as `sync/conflict` and is not pushed over; GitHub JSON writes `assignees`, Jira and Linear CSV the label, raw JSON no derived `assignee`; the accepter is named in the PR body (`github_first.spec.ts` INT-36, INT-39, INT-40, INT-41). Linking a login for a person other than the install's own waits for accounts ([teams](teams.md) NEW-teams-2) | — |
| External check results named as such | not-built | no `source` on gate results | NEW-integrations-3 |
| Webhooks preferred, GraphQL batched, separate budgets, idempotency keys | partial | Idempotency is built (B4.9): an item whose `updatedAt` the snapshot holds, on a card unchanged since, is skipped, and a redelivered webhook is dropped by its delivery id (INT-11d, INT-9). Nothing polls the tracker on a timer — a pull runs only when a person or the PM asks. Not yet: no catch-up pull after a restart, and no gap detection (GitHub's delivery ids are GUIDs, so a gap is visible only through the App's delivery log) (INT-11b); pulls are REST pages, GraphQL serves only review threads, with no point budget (INT-11c) | P9 |
| App JWT, installation tokens, GHES endpoints | built | `github_app.ts`; `remote.spec.ts`, `wave2_github.spec.ts:67` | — |
| Backoff on REST, GraphQL and the token exchange | built (B4.9) | one `sendWithBackoff`: 429, 403 with no remaining quota or a secondary limit, and GraphQL's `RATE_LIMITED` in a 200 body wait `retry-after` (else exponentially) up to `maxRetries`, then report the rate limit (`github_one.spec.ts` INT-8) | — |
| Check runs, annotations (with `raw_details`), SARIF | built | `wave2_github.spec.ts:87`; `github_app.ts:212-236`; annotations unredacted | S3c |
| PR on Accept, merge-aware | built (B4.9) | Accept resolves the transport first (INT-15: `gh` missing or logged out is named and nothing is pushed or moved), then decides the API host and the `[review] remote`'s host by the network policy — offline, or a host the policy refuses, and nothing is pushed, the refusal recorded and naming the setting (B1) — and records the push as `harness/egress` (its URL without credentials) before it runs; it opens a draft against `[review] integration_branch` through the one lifecycle, body the reviewed evidence — gates, diff stats, a Coverage section ("not measured" when no gate measured it), abandoned attempts — and "Accepted by" with the accepter's display name, never their email; check runs and SARIF only on the App transport (a person's token cannot create check runs); the card waits in Review held `awaitingMerge`; the `pull_request.closed` webhook moves it to Done with `mergeCommit` and the merger, or clears the hold and accepter with the closer recorded — `closedBy` when their login is linked, else the login privately (`github_first.spec.ts` INT-12, INT-12a, INT-13, INT-14, INT-15, B1). Ready-when-checks-pass with the reviewers the integration branch's CODEOWNERS names for the card's changed files runs in the queue on either transport (`advanceOpenPullRequests`; INT-12b, `github_first.spec.ts`, `wave2_github.spec.ts`) | — |
| Review threads → repair subtasks | not-built | `openThreads`/`resolveThread` reachable only from tests (`github_app.ts:395-443`) | Later |
| External review cards | partial | `external_review.ts`, wired `index.ts:1518`; `external_review.spec.ts`; cards enter Review even when gates fail and bypass the board (`external_review.ts:141, 244-252`); [review-git](review-git.md) §4 owns them | S4 |
| Dependency-bot verification cards | partial | intent and card (`webhook.ts:122`, `wave2_server.ts:113`); auto-merge policy unverified | P9 |
| Notifier: ntfy/Gotify from the ledger | built | `notify.ts:186-214`; `notify.spec.ts` | — |
| Agent status mirrored on the issue and Projects board | not-built | the queue moves PRs to ready and requests CODEOWNERS (`wave2.ts:384-393`); no issue status | P9 |
| Interruption budget | not-built | the notifier sends every matching event, deduplicated only per 10 minutes (`notify.ts:186-214`) | P9 |
| Slack as a channel; standup, needs_you, decision | not-built | Slack is a separate pipeline called only for the run report (`index.ts:1936`) | P9 |
| Tokens stored safely | not-built | plaintext JSON, 0600 only at creation (`integrations.ts:57-67`) | S3c |
| Identity sources and the Accept rule on a server | not-built | server binds loopback (`server.ts:1190`); every write is actor `"human"` | P9 (DEC-06); accounts, levels and sign-in are [teams](teams.md) NEW-teams-1–4 |
| The repository, per project | built (B4.9) | `githubRepoOf` reads the project's own git remotes locally on each call (`[review] remote`, `origin`, then any) — no cache to go stale, no request; `SEKHEMET_GITHUB_REPO` wins (`github_transport.ts`) | — |
| External review and the queue's PR advance through the policy | built (B4.9) | `reviewPosterFromEnv(repoPath, ledger)` and `advanceOpenPullRequests` take `integrationFetch` (`github_first.spec.ts` M5). GHES on a private address is refused by the policy's `request-filtering-agent` (security item 32) | — |

## 5. Changes for v1

### P9 — GitHub first, one notifier, then people in the Team setup

*Three GitHub paths with three ID formats, no pagination, lost edits, Done before the merge; Slack outside the notifier; no identity.*

**One adapter.**
- **INT-1** WHEN the same issue arrives through `gh`, the App adapter and a webhook THE SYSTEM SHALL hold exactly one card for it, with `externalRef.id = "owner/repo#n"`.
- **INT-2** WHEN a repository has more than 100 open issues THE SYSTEM SHALL pull all of them.
- **INT-3** WHEN a sync runs twice with no change on either side THE SYSTEM SHALL report zero created and zero updated the second time and log no `sync/conflict`.
- **INT-4** WHEN only the tracker changed a card's title since the last snapshot, even if the board moved the card meanwhile, THE SYSTEM SHALL take the tracker's title.
- **INT-5** WHEN only the board changed a shared field since the last snapshot THE SYSTEM SHALL push it to the tracker.
- **INT-6** WHEN both sides changed the same field THE SYSTEM SHALL keep the newer value and record the other in the card's history.
- **INT-7** WHEN a non-scope field is edited externally while the card runs THE SYSTEM SHALL apply the edit when the card completes.
- **INT-8** WHEN GraphQL or the token exchange returns a secondary rate limit THE SYSTEM SHALL wait for the advertised retry time and retry, up to its retry limit, and then report the failure.
- **INT-9** WHEN a webhook delivery ID has already been processed THE SYSTEM SHALL answer 202 and do nothing.
- **INT-10** WHEN a webhook's signature is missing or wrong THE SYSTEM SHALL answer 401 and parse nothing.
- **INT-11** WHEN a comment command other than `/review` arrives THE SYSTEM SHALL ignore it and not record it as an unread command (commands return only when something reads them).
- **INT-11a** WHEN a scope or acceptance-criteria edit arrives from the tracker while the card runs THE SYSTEM SHALL record it on the card, SHALL NOT stop or pause the Worker, and at the card's end SHALL move the card to Planning with the changed field named instead of to Review.
- **INT-11b** WHEN a webhook route is configured and healthy THE SYSTEM SHALL NOT poll the tracker on a timer, and SHALL pull only to catch up after a restart or a gap in delivery IDs.
- **INT-11c** WHEN a page of issues is pulled through GraphQL THE SYSTEM SHALL fetch their sub-issues and labels in the same query, and SHALL track the GraphQL point budget apart from the REST request budget.
- **INT-11d** WHEN the same push is retried or the same webhook is redelivered THE SYSTEM SHALL change nothing the second time, keyed by the entity's `externalRef` and `updatedAt`.
- **INT-11e** WHEN cards are pushed to a tracker whose declared `maxDepth` is shallower than their nesting THE SYSTEM SHALL write no item deeper than `maxDepth`, link each deeper card to its nearest written ancestor, and report the clamp in the sync result.

**Merge-aware Accept.**
- **INT-12** WHEN a card is accepted with PR-on-accept THE SYSTEM SHALL open a PR against the project's configured integration branch on the configured remote, and SHALL keep the card in Review held `awaitingMerge`, not Done — including when the integration branch is not the repository's default branch.
- **INT-12a** WHEN PR-on-accept opens a pull request THE SYSTEM SHALL open it as a draft whose body is the evidence summary: the gates passed, diff stats, coverage and the abandoned attempts.
- **INT-12b** WHEN every check run on that pull request reports `success` THE SYSTEM SHALL mark it ready for review and request the reviewers `CODEOWNERS` names for its changed files.
- **INT-13** WHEN that PR is merged THE SYSTEM SHALL mark the card Done and record the merge commit.
- **INT-14** WHEN that PR is closed without merging THE SYSTEM SHALL clear the card's `awaitingMerge` hold and its accepter, keep it in Review counted toward the WIP limit, and record who closed the PR.
- **INT-15** WHEN `gh` is not installed or not logged in THE SYSTEM SHALL say which, and SHALL leave the card in Review.
- **INT-16a** WHEN a signed `pull_request.opened` webhook arrives for a pull request authored by Dependabot or Renovate THE SYSTEM SHALL create a verification card that runs the project's full gates on the pull request's head; WHEN every gate passes and the project's policy allows auto-merge THE SYSTEM SHALL enable auto-merge on it.
- **INT-16** WHEN a dependency-bot PR passes every gate and the project's policy does not allow auto-merge THE SYSTEM SHALL leave it for a person.

**One notifier.**
- **INT-17** WHEN a card enters Review and Slack is connected with the `review` kind THE SYSTEM SHALL post once to Slack and record `pm/notify` with `channel: "slack"`.
- **INT-18** WHEN Seshat's daily standup is due and a channel accepts `standup` THE SYSTEM SHALL send it through that channel.
- **INT-19** WHEN a decision request is created THE SYSTEM SHALL send a `decision` notice to channels that accept it.
- **INT-20** WHEN Slack answers 4xx or times out THE SYSTEM SHALL record `ok: false` and continue.
- **INT-20a** WHEN a fourth unsolicited notice for one person is due on the same day under the default budget THE SYSTEM SHALL hold it for the next standup and send nothing now; and WHEN a channel is configured above 5 a day THE SYSTEM SHALL still send no more than 5.
- **INT-20b** WHEN a card linked to a GitHub issue moves from Ready to In Progress to Review to Done THE SYSTEM SHALL set the issue's project status to queued, working, waiting for review and completed in turn, and leave the issue's assignee unchanged.
- **INT-20c** WHEN a tracker moves a linked card to Done before it has passed its gates and been accepted THE SYSTEM SHALL keep the card's board state and record a `sync/conflict`.

**People in the Team setup** (superseded in part by DEC-35; accounts, levels and sessions are [teams](teams.md) NEW-teams-2 and NEW-teams-3).
- **INT-21** WHEN identity comes from a proxy and a request carrying the user header arrives from an address outside `trusted_proxies` THE SYSTEM SHALL ignore the header and treat the request as unauthenticated, so that a protected endpoint answers 401 (the same rule as [teams](teams.md) TEAM-12).
- **INT-22** WHEN a person the project's Accept rule does not name asks to accept a card THE SYSTEM SHALL answer 403, change nothing, and record the refusal with the person's identity (wording superseded by DEC-35: "not an accepter"; the general rule is [teams](teams.md) TEAM-4).
- **INT-23** WHEN an accepter accepts a card THE SYSTEM SHALL record their identity on the `card/accepted` event.
- **INT-24** WHEN a Stakeholder talks to Seshat THE SYSTEM SHALL answer, and any proposal the conversation creates SHALL wait for a Member to apply it (superseded by DEC-35: "a person who is not an accepter … an accepter"; see [teams](teams.md) TEAM-5).
- **INT-25** WHEN the Worker asks a question THE SYSTEM SHALL record it as the Worker's, never as a person's.
- **INT-26** WHEN an `[identity]`, `[team]`, `[sessions]` or `[queue]` key, or an Accept rule, appears in a repository's `.sekhemet/config.toml` THE SYSTEM SHALL ignore it (superseded in part by DEC-35: the `accepters` key became the project's Accept rule, [teams](teams.md) §3).

### NEW-integrations-1 — idempotent import
*Justification: export followed by import duplicates every card and loses every link; SPINE makes export/import the whole v1 Jira and Linear story.*
- **INT-27** WHEN a Jira or Linear export is imported back THE SYSTEM SHALL propose no new cards, and each row SHALL carry `externalRef.system` `jira` or `linear` with the row's key.
- **INT-28** WHEN a CSV has an unterminated quote THE SYSTEM SHALL reject the file and name the line.

### NEW-integrations-2 — owner, delegate and accepter on every tracker
*Justification: a free-string `assignee` mixes "worker", "human" and people, so exports and syncs can write "worker" as a user ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 1, INT-T1); and a tracker's assignee must not be able to turn a delegated card into one its delegator may accept (owner decision O11, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)). Depends on [kernel](kernel.md)'s `owner`/`delegate`/`accepter` fields and [review-git](review-git.md)'s independent-accept rule.*
- **INT-36** WHEN a card is exported to or synced with Jira, Linear or GitHub THE SYSTEM SHALL write its owner as the tool's assignee and its delegate to the tool's agent field, or as a label where the tool has none, and SHALL never write "worker" as a user.
- **INT-39** WHEN a synced card is accepted THE SYSTEM SHALL leave the tracker's assignee as the card's owner, and with PR-on-accept SHALL name the accepter in the pull request's body.
- **INT-40** WHEN, on a project where two or more people hold the Accept permission, the tracker reassigns a synced card to another person after its owner delegated it to the Worker THE SYSTEM SHALL change the card's owner, SHALL still refuse an accept by the principal who recorded the latest `card/delegated` to the Worker, naming who may accept, and SHALL allow an accept by the new owner when they neither built nor delegated the card (the rule of [review-git](review-git.md) RG-N5-8).
- **INT-41** WHEN a synced issue's assignee maps to no principal on the server THE SYSTEM SHALL leave the card's owner unchanged and record a `sync/conflict` naming the assignee.

### NEW-integrations-3 — external results name their source
*Justification: evidence on the ledger must say where a result came from before external CI results ever arrive, or they become indistinguishable from local runs (research decision 12, INT-T2, INT-T3; DEC-23: not a CI system).*
- **INT-37** WHEN a result from an external CI check is recorded THE SYSTEM SHALL record `source: external` with the check's name, run URL and head SHA, and SHALL treat it as advisory unless the project declares that check blocking.
- **INT-38** WHEN an external result's head SHA differs from the card branch's head THE SYSTEM SHALL NOT count it as evidence for that card.

### S3c — secrets in integrations
- **INT-29** WHEN a gate excerpt containing a seeded fake key is posted as an annotation THE SYSTEM SHALL post only the redacted form.
- **INT-30** WHEN a Slack webhook URL is saved THE SYSTEM SHALL keep it out of the ledger, the repository and every API response except as a masked value.

## 6. v1 acceptance

INT-1 to INT-30 and INT-36 to INT-41 (including the lettered criteria), plus these built behaviours kept under test:
- **INT-31** WHEN the board is exported to Jira CSV THE SYSTEM SHALL write exactly the Jira import columns listed in item 17.
- **INT-32** WHEN an issue labelled `sekhemet` arrives by a signed webhook THE SYSTEM SHALL create a Backlog card linked to it, with the issue text as untrusted content.
- **INT-33** *(withdrawn by DEC-25 R6: "pause the card and post a decision request" is replaced by INT-11a; the number is not reused.)*
- **INT-34** WHEN a PR carries the `sekhemet:review` label THE SYSTEM SHALL create an external review card that never writes to the PR's branch.
- **INT-35** WHEN a notifier starts on a ledger with history THE SYSTEM SHALL send nothing for events before its start.

The `gh` transport is tested against a fake `gh` on `PATH` that answers only `gh auth token`, and the GitHub payloads in tests are GitHub's documented examples (`packages/sync/tests/fixtures/github/`, from GitHub's webhook and REST documentation), not hand-made and not captured from live traffic.

## 7. Later

- **Jira and Linear live sync** through `jira.js` and `@linear/sdk` (approved in [DEC-08](../DECISIONS.md#dec-08) for when the workstream arrives).
- **Octokit** in place of the hand-rolled client (approved, DEC-08) — may land with P9 if it is the cheaper route to INT-2/INT-8.
- **Review comments → repair subtasks**, thread replies and `resolveReviewThread`; `openThreads`/`resolveThread` are cut until then (reachable only from tests). A repair subtask that pushes and resolves a thread would let the Worker change a pull request after a person accepted the card; in v1 a person answers a PR comment by sending the card back with a note ([review-git](review-git.md) §2.4), and the card is Done only when the PR merges (item 15).
- **Comment commands** `/plan`, `/split`, `/estimate`, with a reply in the thread; **`workflow_dispatch`** enqueuing a local run within the declared hours. `/plan`, `/split` and `/estimate` change a linked card from outside the board, so they need the item's one external identity on every path (item 8, P9) and the commenter mapped to a person who holds the right to change it (items 24–26); v1 takes `/review` (item 12), which creates a card rather than changing one. `workflow_dispatch` was the old design's opt-in event from a self-hosted GitHub runner on the person's machine, beside the Worker's sandbox; v1 starts unattended work only from its own queue, within the declared hours ([runtime](runtime.md)).
- **Slack replies** (talk to Seshat from a thread; Bolt Socket Mode needs no public ingress), **Microsoft Teams**; **Sentry, Datadog, PagerDuty** as bug-card proposals; **Notion, Confluence** publishing (PM_CONTRACT §5 "next" and "later").
- **CI as a gate source** — `sekhemet dev ci` runs a workflow through `act` by hand; a gate rung that runs it, or reads the PR's existing check runs, is later ([gates](gates.md)).
- **Releases** — `sekhemet dev release` proposes a version and changelog (git-cliff, Conventional Commits) and tags on `--confirm`; publishing a GitHub Release is later.
- **SCIM provisioning and several workspaces on one install** ([teams](teams.md) §7). Roles beyond Accept and company SSO, which DEC-06 kept out, are v1 under DEC-35.
- **Remote control from a phone beyond notifications** (acting on a card from the notification itself), and team-chat entry points other than Slack replies.
- **Webhook ingress on a laptop** (smee-client, cloudflared) — proposals needing the owner's yes; in the Team setup (DEC-35) the endpoint is reachable directly.
- **An Azure DevOps connector** — the old design's non-goal for v1, kept out: SPINE puts GitHub first and Jira/Linear as export and import; no user has asked for it.
- **Reading CI check results as blocking gates** (webhooks for `check_suite`, mapping a branch's required checks) — v1 records external results with their source and treats them as advisory (item 15a); making one blocking comes with the CI-as-gate-source work above.
- **Forgejo beyond issues** — the old design's dependencies, boards and webhooks for Forgejo; v1 keeps only what the adapter's tests cover (open question 4).

## 8. Open questions

1. *Superseded by DEC-35:* the four access levels answer it ([teams](teams.md) item 6). **What may a non-accepter do?** DEC-06 grants "one permission beyond reading". *Recommendation:* item 26 — talking to Seshat counts as reading (non-developers must be able to ask), every board decision needs the Accept permission. (Which cards an Accept-holder may accept is decided: O11, item 6b.)
2. **Where does a person's identity live in the event?** *Closed 2026-09-24:* [kernel](kernel.md) rule 19 and NEW-kernel-2 specify it — a `principal` column naming an opaque, stable subject id, covered by the chain hash, required on `human` events and on events a person caused through a machine actor; `actor` stays a closed set and people are never added to it. This spec's identity layer resolves a session or proxy header to that principal (items 24–26).
3. **Can a third-party App appear in GitHub's agent-session surface?** The research confirms the surface for Copilot, Claude and Codex, not its openness. *Recommendation:* ship the Projects status field (INT-20b) in v1 and add the session surface when GitHub documents it for Apps.
4. **Forgejo.** The design listed it as the offline-friendly self-hosted target — issues, dependencies, boards and webhooks; the adapter exists, covers issues only, and is the only tested pull path. *Recommendation:* keep it behind the same adapter interface; not a v1 promise beyond what its tests cover (the rest is in §7).

## 9. Evidence and rationale

- Review: [domains 12 and 15](../../reference/reviews/domain12_15_integrations_ext.md) — three ID formats, the lost-edit probe, Done at PR open, the company-server minimum. [Confirmation review](../../reference/reviews/design_v3_confirmation.md) n16: the PR targets the integration branch, and an unmerged close clears the hold rather than "returning" a card that never left Review (item 15, INT-12, INT-14).
- Contract: [PM_CONTRACT.md §5](../PM_CONTRACT.md) — tiers, Slack endpoints, `pm/notify`.
- Research, [group C §6](../../research/WEB_RESEARCH_2026-09.md#6-competitive-landscape): Linear's delegation model (a person stays the assignee, the agent is a delegate) → item 6; Jira assigning agents by column transition, with no acceptance or DoD enforcement documented → item 6a, INT-20c; GitHub showing agent sessions on issues and Projects as queued / working / waiting for review / completed (2026-03-26) → item 16a, INT-20b; Linear Agent's non-developer chat → why the edge is gating and locality, not chat.
- Research, [PM_RESEARCH_SYNTHESIS.md](../../research/PM_RESEARCH_SYNTHESIS.md) finding 10: at most 3–5 unsolicited pings a day, offering beats nagging (preferred 90% vs 47%, CHI 2025), ~23 minutes to recover from an interruption → item 23a, INT-20a (numbers owned by [planner-pm](planner-pm.md), DEC-25 R8).
- Research, [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md): decision 1 (owner, delegate and accepter as typed roles; Linear's delegate field; Jira's agent in the assignee picker) → item 6, INT-36; decision 12 (gate results name their source; GitHub's combined-status rule) → item 15a, INT-37, INT-38; decision 4 (CODEOWNERS routing) → [review-git](review-git.md); reading CI results as blocking and publishing releases stay Later (§7).
- DEC-25 R6 (2026-09-22): the mid-card edit rule in item 5 settles the contradiction with [OPEN_QUESTIONS.md](../../reference/OPEN_QUESTIONS.md) ("reconcile at the card's end; never pause a card for an external edit").
- Decisions: [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O11 (solo developers may self-accept; on a team, neither the builder nor the delegator may → items 6, 6b, 26, 28, INT-39–41); [DEC-06](../DECISIONS.md#dec-06) (company-server minimum), [DEC-35](../DECISIONS.md#dec-35--one-product-two-setups-solo-and-team) (Solo and Team, access levels, the Accept rule, identity sources; research: [DESIGN_RESEARCH_COLLABORATION.md](../../research/DESIGN_RESEARCH_COLLABORATION.md) §1, §5), [DEC-08](../DECISIONS.md#dec-08) (official clients), [DEC-23](../DECISIONS.md#dec-23--what-the-harness-is-not).
- **Why the card is not Done at PR open:** the PR is where a team decides a change is done; a board that says Done for a rejected PR teaches people to distrust the board.
