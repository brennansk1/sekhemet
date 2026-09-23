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
tests:
  - packages/sync/tests/remote.spec.ts
  - packages/sync/tests/sync.spec.ts
  - apps/harness/tests/wave2_github.spec.ts
  - apps/harness/tests/wave2_server.spec.ts
  - apps/harness/tests/external_review.spec.ts
  - apps/harness/tests/notify.spec.ts
  - apps/harness/tests/pm_api.spec.ts
changes: [P9, S3c]
---

# Integrations: GitHub, Jira, Linear, notifications, and people on a company server

## 1. Purpose

Sekhemet sits beside the tracker and the code host a team already uses; it does not replace them ([DEC-23](../DECISIONS.md#dec-23--what-the-harness-is-not)). This spec covers how cards reach GitHub, Jira and Linear, how people are told when they are needed, and — for the company-server mode ([DEC-06](../DECISIONS.md#dec-06)) — who each person is and who may Accept. It serves developers (the board fits their workflow) and non-developers (they are notified and can act without a terminal); the spine rule it guards is that the human, and the right human, decides.

## 2. Behaviour

### Principles

1. **Every integration is opt-in and off until connected.** Connecting one is consent to send card content to that service; every request it makes is logged on the ledger ([security](security.md) item 33). The harness works fully offline with none connected.
2. **Tokens and webhook URLs never enter the repository or the ledger.** They live in the user directory or the OS keychain ([security](security.md) item 35).
3. **External text is untrusted.** Issue bodies, comments and synced fields enter prompts wrapped as untrusted content ([security](security.md) item 42).
4. **Ownership of fields.** The board owns what the harness decides — status, gate results, budgets, evidence. The tracker owns what people write there — title, description, assignee, labels. A shared field changed on both sides is resolved per field by a three-way merge against the snapshot taken at the last sync; the losing value is kept in the card's history.
5. **Mid-card edits.** An external edit to a non-scope field while a card runs is applied when the card completes. An external edit to the scope or the acceptance criteria pauses the card and posts a decision request.
6. **Owner and delegate.** A person stays the card's owner (assignee) and remains responsible for it; the Worker is the delegate that does the work — the convention Linear, Jira and GitHub have settled on for agents. Synced assignees are people, never "worker"; the delegate is shown separately.
6a. **The column does not move itself.** Trackers now let a column transition hand a ticket to an agent. Sekhemet's difference is that a synced card cannot reach Review until its gates pass and cannot reach Done until a person accepts, whatever the tracker's workflow does; a tracker-side move to Done on a card that has not passed is reported back as a conflict, not applied.

### One adapter interface

7. Every tracker is a `SyncAdapter` with `pull(since)`, `push(card)`, `update(ref, patch)` and declared capabilities (hierarchy, dependencies, webhooks, maximum depth). Hierarchy depth is clamped to the shallower of the board's levels and the tracker's.
8. One external identity per item: `ExternalRef { system, id, url }`, `system` ∈ `github`, `forgejo`, `jira`, `linear`. For GitHub the `id` is `owner/repo#n` on every path (PM_CONTRACT §2).
9. Sync is idempotent: pulling twice creates nothing the second time; an item already linked by `externalRef` is updated, never duplicated, whichever transport brought it.

### GitHub (first)

10. **One adapter, two transports.** The user's own `gh` login, or a GitHub App installed per repository. The App signs RS256 JWTs and exchanges them at `POST /app/installations/{installation_id}/access_tokens` for 1-hour installation tokens. Private keys come from the OS keychain, or an environment/file source on Linux. GitHub Enterprise Server uses configured `api_url` and `graphql_url` with a custom CA bundle. The App asks for: Contents, Issues, Pull requests, Checks, Commit statuses and Security events read/write; Metadata read-only. No personal access tokens are required.
11. **Pull and push.** Issues are pulled with pagination until exhausted (never one page), sub-issues become subtasks, and board wins on shared fields are pushed back so the two sides converge. REST, GraphQL and the token exchange all back off on primary and secondary rate limits.
12. **Webhooks.** Verified by HMAC-SHA256 (`X-Hub-Signature-256`) before anything is parsed; each `X-GitHub-Delivery` is processed at most once. Intake:

| Event | Condition | Action |
| --- | --- | --- |
| `issues.labeled` | label `sekhemet` | create a card linked to the issue; sub-issues become subtasks |
| `issue_comment.created` | `/review` on a pull request | an external review card (below) |
| `pull_request.labeled` | label `sekhemet:review` | an external review card |
| `pull_request.opened` | author Dependabot or Renovate | a verification card that runs the full gates; auto-merge only if the project's policy allows |
| `pull_request.closed` | a PR the harness opened | moves its card as item 15 says |

13. **External review cards.** A review card targets a PR the harness did not open: it runs the Reviewer procedure and the gates on a checkout, never edits, and posts its findings as a review.
14. **Checks.** Each gate run on a card with a PR becomes a Check Run (`queued` → `in_progress` → `completed`, `success` or `failure`); typed gate failures become line annotations (path, lines, level, message, title), redacted first; security gates upload SARIF v2.1.0 (gzip, base64) to code scanning. Checks can be made required in branch protection.
15. **PR on Accept, merge-aware.** When PR-on-accept is on, Accept pushes the card branch to the configured remote and opens a draft PR against the repository's default branch, with the evidence summary (gates, diff stats, coverage, abandoned attempts) as its body; it becomes ready when its checks pass and CODEOWNERS reviewers are requested; merging follows the repository's policy (auto-merge, merge queue, or a person). **The card is Done only when the PR is merged.** A PR closed unmerged returns the card to Review with the closure recorded. How "awaiting merge" appears on the board is [review-git](review-git.md)'s and [kernel](kernel.md)'s.
16. **The queue's own `--auto-accept`** (actor `harness`, used by the frozen suite) always merges locally and never opens a PR.
16a. **Agent status on the issue.** A card linked to a GitHub issue shows its state on the issue and the project board in the four statuses GitHub uses for agent sessions — *queued* (Ready), *working* (Planning, In Progress, Verify), *waiting for review* (Review), *completed* (Done) — as the Projects status field, and through GitHub's agent-session surface where it is open to third-party apps. The issue's assignee stays the person.

### Jira and Linear (v1: export and import)

17. **Export** writes the board in each tool's own import format: Jira CSV (Summary, Issue Type, Priority, Story Points, Sprint, Epic Link, Labels, Description), Linear CSV/JSON (title, priority 0–4, estimate, cycle, project, labels), GitHub JSON, or raw JSON. CSV follows RFC 4180. The file carries each card's key.
18. **Import** reads those formats and returns PM proposals — never applied silently. A row whose key or identifier matches an `externalRef` updates that card's proposal instead of creating a card, so export followed by import duplicates nothing.
19. Live two-way sync with Jira or Linear is not in v1 (SPINE, "Not in v1").

### Notifications (one notifier)

20. One notifier tails the ledger and sends what needs a person, through channels the user connected: ntfy or Gotify (push), and Slack incoming webhooks; Microsoft Teams webhooks later. Slack is a channel of the same notifier, not a second pipeline.
21. Kinds: `review` (a card passed its gates and waits), `parked`, `budget` (parked by a budget), `question` (the Worker asked), `decision` (a decision request waits), `standup` (Seshat's daily report), `needs_you` (anything waiting on a person, summarised), `run_report` (a queue run finished). The user chooses kinds per channel.
22. It starts after the current last event (no replay of history), polls every 5 s, and never sends the same (kind, card) twice within 10 minutes. Every send is recorded as `pm/notify` with `{ channel, kind, ok }`.
23. Push notifications go to the user's own ntfy or Gotify server; `ntfy.sh` only if the user chooses it. Approving or parking from a phone needs nothing cloud-hosted beyond what the user picked.
23a. **A budget on interruptions.** Unsolicited messages to one person are capped at 5 a day by default (configurable per channel); past the cap, notices wait for the next `needs_you` digest. A notice offers the action ("3 cards wait for review — open Review"), it does not nag, and none repeats a notice the person has already acted on. Replies to something the person asked for are not counted.

### People on a company server (identity and Accept)

24. In company-server mode ([runtime](runtime.md) owns binding and sessions) every request is made by a **person**. Identity comes from one of two sources, set in the server's user configuration, never the repository's:
   - an identity-aware proxy's user header, trusted only when the request arrives from an address in `trusted_proxies`;
   - local accounts, each with its own token, stored hashed.
25. Every event a person causes records who they are; no person-caused event is recorded as an anonymous `human`, and no model role's event (a Worker question, a Seshat reply) is ever attributed to a person.
26. **One permission beyond reading: Accept.** People listed as accepters may accept, send back, park and unpark, override, revert, run cards and apply PM proposals. Every authenticated person may read the board and evidence and talk to Seshat; their messages may create proposals, which an accepter applies.
27. A refused decision is answered with who may make it; it changes nothing and is recorded.
28. On a single machine bound to loopback, the one local user is the only person and an accepter; nothing above changes their experience.

## 3. Contract

| Item | Source |
| --- | --- |
| `SyncAdapter`, `ExternalItem`, `FieldConflict` | `packages/sync/src/remote.ts` |
| `ExternalRef` | `packages/kernel/src/types.ts:101` (`system`) |
| `GitHubClient`, `loadPrivateKey`, `GitHubEndpoints`, `PullRequestLifecycle` | `packages/sync/src/github_app.ts` |
| `verifySignature`, `intentFor`, `WebhookIntent`, `githubWebhookHandler` | `packages/sync/src/webhook.ts` |
| `ForgejoIssuesAdapter`, `mergeLastWriterWins` (to become a three-way merge) | `packages/sync/src/remote.ts` |
| Integration settings (`~/.config/sekhemet/repos/<repo>-<hash>.json`), export/import, Slack | `apps/harness/src/integrations.ts` |
| `startNotifier`, `noticeFor`, `sendPush`, `PushSettings` | `apps/harness/src/notify.ts` |
| HTTP: `GET /api/integrations`; `POST /api/integrations/github/sync`; `GET /api/export?format=`; `POST /api/import`; `PUT /api/integrations/github-pr`; `PUT` and `DELETE /api/integrations/slack`, `POST …/slack/test`; `PUT /api/integrations/push`, `POST …/push/test`; `POST /webhooks/github` | shapes in [PM_CONTRACT.md §3 and §5](../PM_CONTRACT.md); routes in `integrations.ts:652-841`, `wave2_server.ts:158` |
| Events: `sync/conflict`, `github/command`, `pm/notify`, `card/accepted` | `wave2_github.ts:304`, `wave2_server.ts:105`, `notify.ts:125`, `execute.ts:1332` |
| Env (developer and CI use): `SEKHEMET_GITHUB_APP_ID`, `_INSTALLATION_ID`, `_APP_KEYCHAIN`, `_APP_KEY_PATH`, `_HOST`, `_REPO`, `_AUTOMERGE`, `_WEBHOOK_SECRET`, `SEKHEMET_FORGEJO_*` | inventory in [surface](surface.md) |
| Company-server identity keys (new): `[identity] source = "proxy" \| "tokens"`, `user_header`, `trusted_proxies`, `accepters` | this spec; server user config |

The integration tiers (now, next, later) and the reasons for GitHub first (Stack Overflow 2025: GitHub 81%, Jira 46%) are in [PM_CONTRACT.md §5](../PM_CONTRACT.md); this spec overrides its "Jira/Linear live sync: next" only by keeping it out of v1.

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Export Jira CSV, Linear CSV, GitHub JSON, JSON (RFC 4180) | built | `integrations.ts:240-392`; `pm_api.spec.ts` | — |
| Import as PM proposals | partial | `integrations.ts:413-475`; keys ignored, `externalRef` not set, re-import duplicates | NEW-integrations-1 |
| GitHub sync through `gh` | partial | `integrations.ts:496-638`: up to 200 open issues, titles and bodies never updated; untested | P9 |
| GitHub/Forgejo adapter | partial | `remote.ts`; no pagination (`:130-133`); LWW on the whole card's `updatedAt` (`:68`); board wins never pushed | P9 |
| Webhook intake | partial | `webhook.ts`; no delivery dedupe (`:171-175`); `/plan`, `/split`, `/estimate`, `workflow_dispatch` recorded and never read (`wave2_server.ts:94-145`); card id `card_gh<n>`, id `n` (`:72-91`) | P9 |
| Three ID formats | not-built (one ID) | `integrations.ts:551` (`owner/repo#n`), `remote.ts:137` (`n`), `wave2_server.ts:84` (`n`) | P9 |
| Mid-card edit reconciled on completion | not-built | probed: the snapshot is overwritten each sync, edit lost (`wave2_github.ts:314`) | P9 |
| Scope edit pauses the card | built | `wave2_github.spec.ts:164` | — |
| App JWT, installation tokens, GHES endpoints | built | `github_app.ts`; `remote.spec.ts`, `wave2_github.spec.ts:67` | — |
| Backoff: REST only | partial | `github_app.ts:159-169`; GraphQL `:176-194` and token exchange `:113-133` do not | P9 |
| Check runs, annotations, SARIF | built | `wave2_github.spec.ts:87`; annotations unredacted | S3c |
| PR on Accept | partial | Done at PR open (`execute.ts:1323-1329`); base `"main"` and remote `origin` hard-coded (`wave2_github.ts:97`, `execute.ts:1544,1593`); `gh pr create` path untested | P9 |
| Review threads → repair subtasks | not-built | `openThreads`/`resolveThread` reachable only from tests (`github_app.ts:395-443`) | Later |
| External review cards | built | `external_review.ts`, wired `index.ts:1518`; `external_review.spec.ts` | — |
| Dependency-bot verification cards | partial | intent and card (`webhook.ts:122`, `wave2_server.ts:113`); auto-merge policy unverified | P9 |
| Notifier: ntfy/Gotify from the ledger | built | `notify.ts:186-214`; `notify.spec.ts` | — |
| Agent status mirrored on the issue and Projects board | not-built | the queue moves PRs to ready and requests CODEOWNERS (`wave2.ts:384-393`); no issue status | P9 |
| Interruption budget | not-built | the notifier sends every matching event, deduplicated only per 10 minutes (`notify.ts:186-214`) | P9 |
| Slack as a channel; standup, needs_you, decision | not-built | Slack is a separate pipeline called only for the run report (`index.ts:1936`) | P9 |
| Tokens stored safely | not-built | plaintext JSON, 0600 only at creation (`integrations.ts:57-67`) | S3c |
| Company-server identity and Accept role | not-built | server binds loopback (`server.ts:1190`); every write is actor `"human"` | P9 (DEC-06) |
| `githubCache` keyed by repository | not-built | module global (`integrations.ts:106`) | P9 |

## 5. Changes for v1

### P9 — GitHub first, one notifier, then people on a company server

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

**Merge-aware Accept.**
- **INT-12** WHEN a card is accepted with PR-on-accept THE SYSTEM SHALL open a PR against the repository's default branch on the configured remote and SHALL NOT mark the card Done.
- **INT-13** WHEN that PR is merged THE SYSTEM SHALL mark the card Done and record the merge commit.
- **INT-14** WHEN that PR is closed without merging THE SYSTEM SHALL return the card to Review and record who closed it.
- **INT-15** WHEN `gh` is not installed or not logged in THE SYSTEM SHALL say which, and SHALL leave the card in Review.
- **INT-16** WHEN a dependency-bot PR passes every gate and the project's policy does not allow auto-merge THE SYSTEM SHALL leave it for a person.

**One notifier.**
- **INT-17** WHEN a card enters Review and Slack is connected with the `review` kind THE SYSTEM SHALL post once to Slack and record `pm/notify` with `channel: "slack"`.
- **INT-18** WHEN Seshat's daily standup is due and a channel accepts `standup` THE SYSTEM SHALL send it through that channel.
- **INT-19** WHEN a decision request is created THE SYSTEM SHALL send a `decision` notice to channels that accept it.
- **INT-20** WHEN Slack answers 4xx or times out THE SYSTEM SHALL record `ok: false` and continue.
- **INT-20a** WHEN a sixth unsolicited notice for one person is due on the same day under the default budget THE SYSTEM SHALL hold it for the next `needs_you` digest and send nothing now.
- **INT-20b** WHEN a card linked to a GitHub issue moves from Ready to In Progress to Review to Done THE SYSTEM SHALL set the issue's project status to queued, working, waiting for review and completed in turn, and leave the issue's assignee unchanged.
- **INT-20c** WHEN a tracker moves a linked card to Done before it has passed its gates and been accepted THE SYSTEM SHALL keep the card's board state and record a `sync/conflict`.

**People on a company server.**
- **INT-21** WHEN identity comes from a proxy and a request carrying the user header arrives from an address outside `trusted_proxies` THE SYSTEM SHALL answer 401.
- **INT-22** WHEN a person who is not an accepter asks to accept a card THE SYSTEM SHALL answer 403, change nothing, and record the refusal with the person's identity.
- **INT-23** WHEN an accepter accepts a card THE SYSTEM SHALL record their identity on the `card/accepted` event.
- **INT-24** WHEN a person who is not an accepter talks to Seshat THE SYSTEM SHALL answer, and any proposal the conversation creates SHALL wait for an accepter to apply it.
- **INT-25** WHEN the Worker asks a question THE SYSTEM SHALL record it as the Worker's, never as a person's.
- **INT-26** WHEN the `accepters` key appears in a repository's `.sekhemet/config.toml` THE SYSTEM SHALL ignore it.

### NEW-integrations-1 — idempotent import
*Justification: export followed by import duplicates every card and loses every link; SPINE makes export/import the whole v1 Jira and Linear story.*
- **INT-27** WHEN a Jira or Linear export is imported back THE SYSTEM SHALL propose no new cards, and each row SHALL carry `externalRef.system` `jira` or `linear` with the row's key.
- **INT-28** WHEN a CSV has an unterminated quote THE SYSTEM SHALL reject the file and name the line.

### S3c — secrets in integrations
- **INT-29** WHEN a gate excerpt containing a seeded fake key is posted as an annotation THE SYSTEM SHALL post only the redacted form.
- **INT-30** WHEN a Slack webhook URL is saved THE SYSTEM SHALL keep it out of the ledger, the repository and every API response except as a masked value.

## 6. v1 acceptance

INT-1 to INT-30 (including the lettered criteria), plus these built behaviours kept under test:
- **INT-31** WHEN the board is exported to Jira CSV THE SYSTEM SHALL write exactly the Jira import columns listed in item 17.
- **INT-32** WHEN an issue labelled `sekhemet` arrives by a signed webhook THE SYSTEM SHALL create a Backlog card linked to it, with the issue text as untrusted content.
- **INT-33** WHEN a card's scope or acceptance criteria are edited externally while it runs THE SYSTEM SHALL pause it and post a decision request.
- **INT-34** WHEN a PR carries the `sekhemet:review` label THE SYSTEM SHALL create an external review card that never writes to the PR's branch.
- **INT-35** WHEN a notifier starts on a ledger with history THE SYSTEM SHALL send nothing for events before its start.

The `gh` transport and `gh pr create` are tested against a fake `gh` on `PATH`, and GitHub payloads in tests are recorded ones, not hand-made.

## 7. Later

- **Jira and Linear live sync** through `jira.js` and `@linear/sdk` (approved in [DEC-08](../DECISIONS.md#dec-08) for when the workstream arrives).
- **Octokit** in place of the hand-rolled client (approved, DEC-08) — may land with P9 if it is the cheaper route to INT-2/INT-8.
- **Review comments → repair subtasks**, thread replies and `resolveReviewThread`; `openThreads`/`resolveThread` are cut until then (reachable only from tests).
- **Comment commands** `/plan`, `/split`, `/estimate`, with a reply in the thread; **`workflow_dispatch`** enqueuing a local run within the declared hours.
- **Slack replies** (talk to Seshat from a thread; Bolt Socket Mode needs no public ingress), **Microsoft Teams**; **Sentry, Datadog, PagerDuty** as bug-card proposals; **Notion, Confluence** publishing (PM_CONTRACT §5 "next" and "later").
- **CI as a gate source** — `sekhemet dev ci` runs a workflow through `act` by hand; a gate rung that runs it, or reads the PR's existing check runs, is later ([gates](gates.md)).
- **Releases** — `sekhemet dev release` proposes a version and changelog (git-cliff, Conventional Commits) and tags on `--confirm`; publishing a GitHub Release is later.
- **Roles beyond Accept, SSO beyond one proxy, multi-tenant boards** (DEC-06).
- **Remote control from a phone beyond notifications** (acting on a card from the notification itself), and team-chat entry points other than Slack replies.
- **Webhook ingress on a laptop** (smee-client, cloudflared) — proposals needing the owner's yes; in company-server mode the endpoint is reachable directly.

## 8. Open questions

1. **What may a non-accepter do?** DEC-06 grants "one permission beyond reading". *Recommendation:* item 26 — talking to Seshat counts as reading (non-developers must be able to ask), every board decision needs the Accept permission.
2. **Where does a person's identity live in the event?** The `actor` column is a checked enum (`packages/kernel/src/types.ts:325-339`). *Recommendation:* a nullable `principal` column in the envelope, covered by the hash chain, added in [kernel](kernel.md)'s S7 migration; `actor` stays `human`.
3. **Can a third-party App appear in GitHub's agent-session surface?** The research confirms the surface for Copilot, Claude and Codex, not its openness. *Recommendation:* ship the Projects status field (INT-20b) in v1 and add the session surface when GitHub documents it for Apps.
4. **Forgejo.** The design listed it as the offline-friendly self-hosted target; the adapter exists and is the only tested pull path. *Recommendation:* keep it behind the same adapter interface; not a v1 promise beyond what its tests cover.

## 9. Evidence and rationale

- Review: [domains 12 and 15](../../reference/reviews/domain12_15_integrations_ext.md) — three ID formats, the lost-edit probe, Done at PR open, the company-server minimum.
- Contract: [PM_CONTRACT.md §5](../PM_CONTRACT.md) — tiers, Slack endpoints, `pm/notify`.
- Research, [group C §6](../../research/WEB_RESEARCH_2026-09.md#6-competitive-landscape): Linear's delegation model (a person stays the assignee, the agent is a delegate) → item 6; Jira assigning agents by column transition, with no acceptance or DoD enforcement documented → item 6a, INT-20c; GitHub showing agent sessions on issues and Projects as queued / working / waiting for review / completed (2026-03-26) → item 16a, INT-20b; Linear Agent's non-developer chat → why the edge is gating and locality, not chat.
- Research, [PM_RESEARCH_SYNTHESIS.md](../../research/PM_RESEARCH_SYNTHESIS.md) finding 10: at most 3–5 unsolicited pings a day, offering beats nagging (preferred 90% vs 47%, CHI 2025), ~23 minutes to recover from an interruption → item 23a, INT-20a.
- Decisions: [DEC-06](../DECISIONS.md#dec-06) (company-server minimum), [DEC-08](../DECISIONS.md#dec-08) (official clients), [DEC-23](../DECISIONS.md#dec-23--what-the-harness-is-not).
- **Why the card is not Done at PR open:** the PR is where a team decides a change is done; a board that says Done for a rejected PR teaches people to distrust the board.
