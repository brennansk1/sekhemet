---
spec: teams
status: not-built
audiences: [developer, beginner, non-developer]
code: []
tests: []
changes: [NEW-teams-1, NEW-teams-2, NEW-teams-3, NEW-teams-4, NEW-teams-5, NEW-teams-6, NEW-teams-7, NEW-teams-8, NEW-teams-9, NEW-teams-10, NEW-teams-11]
---

# Teams: Solo and Team setups, accounts, access, and working together

## 1. Purpose

Sekhemet serves one person on their own machine and a team sharing one install on its own hardware, with the same board, issues, checks and acceptance ([DEC-35](../DECISIONS.md#dec-35--one-product-two-setups-solo-and-team)). This spec covers what changes when there is more than one person: accounts and sign-in, the workspace and its projects, access levels, how people and the AI teammates work on the same issues ([DEC-36](../DECISIONS.md#dec-36--the-ai-is-a-teammate-that-proposes-people-decide)), the inbox, presence, the audit view and project updates. It serves the spine's fourth rule: with several people, each person is a rate limiter on their own work, and the product must never let the AI take their decisions.

It builds on rules already specified elsewhere and does not restate them:
- a principal on every event, and `on_behalf_of` on the Agent's events: [kernel](kernel.md) rule 19 and NEW-kernel-10;
- owner, delegate and accepter: [kernel](kernel.md) rule 21 and [integrations](integrations.md) item 6;
- the independence rule for Accept: [review-git](review-git.md) O11;
- binding, TLS and sessions: [runtime](runtime.md) items 26–27;
- the fair model queue: [runtime](runtime.md) item 4a;
- the notifier and its budget: [integrations](integrations.md) items 20–23 and [planner-pm](planner-pm.md) item 15;
- the credential store: [security](security.md) item 35a.

## 2. Behaviour

### 2.1 The two setups

1. **Solo** is the default for `npm install -g sekhemet`. The server binds loopback; there is no sign-in screen, no invite, no access-level UI, no presence and no audit page. The operating-system user is the only principal and holds every permission. The account menu (bottom of the sidebar) shows the name, "This computer", Profile, Notifications, Keyboard shortcuts and Theme. Nothing a team needs is asked of one person: health and the weekly update are optional, and nothing is ever shown as missing (items 28–29).
2. **Team** is the default for the container image ([surface](surface.md) SUR-42). On the first start Sekhemet writes a one-time **setup token** to a file of mode 0600 in the data directory and prints only that file's path to the console, so container logs never hold the token. The token is valid for 24 hours; `sekhemet serve --new-setup-token` writes a new one, voiding the old, while no Admin exists. Presenting it on the sign-in page creates the first Admin and voids the token. There is no "first sign-up wins".
3. A person can switch a Solo install to Team from Configuration. The event log is kept, and the Solo principal becomes the first Admin. Nothing is migrated or rewritten.
4. The sidebar is the same in both setups: Projects, Inbox and (Team only) My issues at the top; the current project's pages under a project switcher; the account at the bottom.

### 2.2 Workspace, projects and access

5. A Team install holds one **workspace** (for example *Northwind*) containing any number of projects. The **Projects** page lists each project with:
   - its health and current release, with progress;
   - the forecast range and the target;
   - what is waiting on you;
   - what the Agent is doing;
   - the lead.

   Above the list it shows the workspace's totals, and beside it the models on the server with their load. A **New project** action opens the start-a-project conversation (item 21); with no projects, the page shows only *Start your first project*, which opens the same conversation ([dashboard](dashboard.md) §2.11). Both setups have the page.
6. Every person has one **access level** for the workspace. An Admin or the project lead can override it for a single project, raising it or lowering it.

   | Level | Can |
   | --- | --- |
   | **Admin** | everything a Member can; manage members, invites and levels; Configuration, models and the queue's caps; the audit view; turn on Seshat's auto-apply per project and property (item 20) |
   | **Member** | create, edit, move and assign issues; delegate an issue to the Agent, guide it, pause it and take it over (DEC-34); start queue and overnight runs; review; approve plans and apply Seshat's proposals; set a project's health and post its update if they lead it |
   | **Stakeholder** | file issues; comment; talk to Seshat and start a project conversation; ask the Agent through its owner (item 19a); answer questions addressed to them. Cannot start the Agent, change scope or priority, apply proposals or accept |
   | **Viewer** | read everything in the projects they can see; comment; ask Seshat questions, which it answers with no proposals (item 19a) |

   Project and workspace actions:

   | Action | Who |
   | --- | --- |
   | Create a project | a Member or an Admin; a Stakeholder sends a plan for approval (item 21) |
   | Archive a project | an Admin or the project lead |
   | Name or change a project's lead | an Admin |
   | Edit a project's Accept rule and settings (required resolved threads, item 25) | an Admin or the project lead |
   | Turn on auto-apply for a property (item 20) | an Admin |
   | Override a person's level for one project | an Admin or the project lead |
   | Connect an integration; create or revoke its tokens and webhooks | an Admin |
   | Approve a Playbook rule with *This project* reach | a Member the project's Accept rule names |
   | Approve a Playbook rule with *All projects* reach | an Admin |
   | Start a queue or overnight run | a Member; an Admin sets the caps (item 30) |
   | Create or revoke one's own personal access token | every level (item 15) |

   A change to a project's Accept rule, required resolved threads, lead or auto-apply is recorded as `project/settings_changed`; a per-project level override as `member/level_changed` with the project (§3).
7. **Accept is a per-project rule**, not a level. It is held by named Members, with required reviewers from CODEOWNERS ([review-git](review-git.md) NEW-review-git-5) and the independence rule (O11). This replaces the `accepters` list of [integrations](integrations.md) item 24 with "the project's Accept rule".
8. **Profile labels** — Product owner, Project manager, Developer, Reviewer, Researcher, Designer, or a label an Admin adds — appear next to a person's name and set their home page and notification defaults:
   - a Product owner or Stakeholder lands on Status;
   - a Developer lands on the Board, or on My issues when they have any.

   A label grants nothing.
9. A refusal names what is missing and who can grant it: "You're a Stakeholder on Chronicle. A Member can start the Agent on this issue." It answers 403 over HTTP and is recorded (integrations INT-22).

### 2.3 Accounts and sign-in (Team)

10. People join through **invite links** that an Admin creates. Each link is single-use, expires after 7 days by default, carries an access level and, optionally, a project. Opening the link (`GET /api/invites/:id`) only shows the invite: the workspace, the level and who sent it. Accepting is a separate `POST /api/invites/:id/accept` from that page, so a link unfurler or mail scanner that fetches the link cannot consume it. Open sign-up is off. When an Admin turns it on for an email domain, new accounts are *pending* until an Admin approves them.
11. **Local accounts** sign in with an email and a password:
    - 15 characters minimum, no composition rules, no forced rotation;
    - refused when it contains the person's own name or email or the workspace name, and — once the owner chooses the list (O30) — when it is on a bundled, offline list of common and breached passwords; never checked by an online lookup;
    - hashed with scrypt from `node:crypto`, and kept in the credential store (item 16).

    A password reset is a single-use link an Admin issues, or an email if a mail relay is configured. Issuing it and using it are recorded (`password/reset_issued`, `password/changed`).
12. **Passkeys** (WebAuthn) and **company SSO** (OIDC, with PKCE, a claim-to-level mapping and strict mode) are designed here. They wait for the owner's approval of their libraries (O28, O29).
    - When built, a level set inside Sekhemet is never silently overwritten by the identity provider, unless the Admin chose "levels managed by the identity provider".
    - The first Admin is always created by the setup token, never by the first SSO sign-in.
13. The trusted identity proxy of DEC-06 is kept. The user header is read only from addresses in `trusted_proxies`; a user header from any other address is ignored, and the request is unauthenticated, so a protected endpoint answers 401 (the same rule as [integrations](integrations.md) INT-21). Sekhemet enforces CSRF protection itself rather than leaving it to the proxy. A person first seen through the proxy is created *pending* and can do nothing until an Admin approves them, unless an invite for their email exists, in which case they join at the invite's level.
14. **Sessions** use a `__Host-` cookie that is Secure, HttpOnly and SameSite=Strict, with at least 128 bits of entropy. A new session id is issued at sign-in and on any change of level. Sessions end after 1 hour idle and 24 hours in total, both enforced on the server. Removing a person, resetting their password or lowering their level ends every session they hold; removing them also revokes their personal access tokens. Every sign-in and sign-out is recorded; failures are recorded as the summaries of item 14b.

    14a. **Attempts are limited**, per account and per source address, following NIST SP 800-63B-4:
    - exponential back-off between failed attempts;
    - after 10 consecutive failures, that account and address pair is locked for 15 minutes;
    - an account never takes more than 100 consecutive failures: at 100 it is locked until an Admin unlocks it (`account/locked`, `account/unlocked`);
    - a successful sign-in resets the account's count.

    The same limits apply to setup-token and invite attempts, counted per token or invite and per address.

    14b. **Refusals cannot grow the ledger without bound.** Failed attempts from callers who are not signed in are counted in memory and written as at most one `session/refused {reason, count}` summary per account — per address for an unknown account — per 15-minute window, at the window's end or at shutdown. On start-up the per-account count toward item 14a's 100 is rebuilt from those summaries, so a restart does not reset it.
15. **Personal access tokens** are for the CLI and MCP clients: named, scoped to a level no higher than the person's, shown once, revocable, expiring (90 days by default, one year at most), and recorded when used (`token/used`, at most once per token per hour). A token acts at the lower of its scope and the person's current level, so lowering a person's level lowers every token they hold.
16. **Credentials are secrets, not project state.** Password hashes, passkey public keys and token hashes live in the **credential store** ([security](security.md) item 35a): a file of mode 0600 outside `events.db`, included in backups and never exported. The event log records that a credential was added, used, reset or revoked, never the credential itself.

### 2.4 People and the AI teammates on an issue

17. Every issue has one human **owner**. It may be **delegated** to the Agent, or to another person (kernel rule 21). The issue page shows the owner, the delegate, the reviewers, the watchers, and who is viewing now.
18. Seshat and the Agent are **AI identities**, shown with an "AI" badge next to their names. They appear in assignee and mention pickers under "AI teammates" and never under "Members". They hold no access level. The Agent acts with the permissions of the person who started it, and each Agent event records that person as `on_behalf_of` ([kernel](kernel.md) rule 19, NEW-kernel-10).
19. People reach them the way they reach a colleague: by delegating an issue to the Agent, or by writing `@Agent` or `@Seshat` in a comment. The harness, not the model, acknowledges within 10 seconds by setting the AI's state, because loading Seshat's model alone can take 40–120 s ([planner-pm](planner-pm.md) §2.8.14):

    | State | Meaning |
    | --- | --- |
    | *queued* | waiting its turn, with its place in the queue and an estimate |
    | *working* | running |
    | *needs you* | waiting on a question, and naming whom it waits on |
    | *paused* | stopped by a person |
    | *done* | finished |
    | *failed* | stopped with a diagnosis |

    The same state shows on the card, the issue and the inbox.

    19a. **Access levels apply to what people ask the AI.**
    - An `@Agent` from a Stakeholder or a Viewer does not start the Agent. It becomes a request to the issue's owner — or to the project lead, when the owner cannot start the Agent either — in their Inbox under *Needs you*: "Dana asked the Agent to … — Start it?" The Agent starts only when a Member presses *Start*, and then acts on that Member's behalf (item 18).
    - Every level may ask `@Seshat` questions. A Viewer gets answers only: Seshat offers a Viewer no proposal and no suggestion. A Stakeholder's messages may create proposals, which a Member applies.
    - Seshat answers each person only from the projects and issues that person can see ([planner-pm](planner-pm.md) §2.8.5).
    - Chat slash commands ([planner-pm](planner-pm.md) §2.8.7: `/plan`, `/ready`, `/park`, `/backlog` …) are checked against the caller's level exactly as the matching endpoint is, and refused the same way (item 9).
20. **Seshat proposes; people decide** (DEC-36). Seshat never assigns an issue to a person, never edits another person's issue, and never sets a project's health. A change the planner would make on its own to an issue someone else owns reaches that owner as a suggestion ([planner-pm](planner-pm.md) §2.18.6).
    - **Triage suggestions** (assignee, labels, duplicate, priority, a split) appear on the issue as "Suggested: … Why: …", with *Apply* and *Dismiss*.
    - A dismissed suggestion is not raised again for that issue: the same property with the same value on the same issue.
    - **Auto-apply** can be turned on only by an Admin, per project and per property, and only for labels, the duplicate link, priority and a split. It never covers the assignee or health. Each auto-applied change records as its principal the Admin who turned the rule on (the automation rule of [kernel](kernel.md) rule 19), shows "applied by <Admin>'s rule", and can be undone in one action.
21. **A stakeholder can start a project.** The conversation and the draft plan are theirs. Applying the plan needs a Member or an Admin: the stakeholder presses *Send for approval* and names an approver. The approver can approve, ask a question, or edit. Nothing is created before approval ([design-stage](design-stage.md) §2.9). The issues an approved plan creates are owned by the approver by default; the owner can be changed. In Solo the button is *Create project*.

### 2.5 Working together

22. **Subscriptions.** A person is subscribed to an issue automatically when they create it, own it, are delegated or mentioned on it, comment on it, or are asked to review it. The issue has a *Watch* toggle. A watcher gets every change on the issue in their Inbox; what is pushed to them by email or chat stays within their notification budget (3 a day by default, [planner-pm](planner-pm.md) §2.8.15), and posted project updates count against it. A mention is a single notification.
23. **@mentions** reach people as well as issues. The picker lists the members of the project, then the AI teammates. A mention of someone who cannot see the project asks the author whether to invite them, and sends nothing until they answer.
24. **The Inbox** lists what reached you, grouped by reason:
    - *Needs you*: a question, a review, an approval or a decision waiting on you, including a request to start the Agent (item 19a);
    - *Mentioned*;
    - *Review requested*;
    - *Watching*;
    - *Agent finished*: the Agent finished an issue you started.

    Opening an item marks it read. Each item can be marked *Done*, *Snoozed* until a time, or *Saved*; each of these, and reading, is recorded (§3). Items that reach no one are not shown. Email or chat digests contain only items still unread, and stay within the notification budget.
25. **Review verdicts** follow the ones teams already use:
    - *Accept* (held by the Accept rule);
    - *Send back* (with line comments, DEC-34);
    - *Comment*.

    An accept is dismissed when new commits land on the issue's branch. A project can require every review thread to be resolved before Accept.
26. **Presence** is light and never recorded:
    - the avatars of the people viewing an issue;
    - a marker on a card that someone is editing or dragging;
    - a green dot on a member who was active in the last 5 minutes.

    Presence is not durable state and never enters the event log.
27. **The audit view** (Admins only) reads the event log. It lists actor, action, target and time, can be filtered by person, action and project, and exports to CSV or JSON. It includes every sign-in, refusal summary, lock, level change, invite, token, password reset, model change and configuration change — including a change made to `config.toml` outside Sekhemet, which is recorded at the next start as `config/changed_outside {keys}`, naming the keys and never their values. Nothing here is a second store: the page is a read of the event log.

### 2.6 Project health and updates

28. The project lead, or any Member who leads a release, sets **health** to *On track*, *At risk* or *Off track*. It shows with their name and the date. A model never sets it. In Solo health is optional, and when none is set nothing is shown.
29. **Project updates**:
    - Seshat drafts a weekly update in five parts: status, done, next, risks, asks.
    - A person edits it and posts it.
    - The update is shown on Status and sent to the project's watchers, within each watcher's notification budget (item 22), and to the configured channel.
    - In the Team setup, when 7 days pass since the last posted update — or since the current release started, if none was posted — Status shows *Update missing* to the lead. In Solo the update is optional and never shown as missing.

### 2.7 The shared models

30. Fairness belongs to Sekhemet's queue, not the engine ([runtime](runtime.md) item 4a):
    - each person's share is costed in input and output tokens;
    - Seshat's interactive replies go ahead of Agent steps, with aging so no request starves;
    - an Admin sets a per-person cap on concurrent Agent issues, 1 by default until qualification shows the slots allow more.
31. People can see where they stand: "2nd in queue, about 6 minutes"; "Priya's issue is running; yours starts next".
32. The number of slots comes from qualification on that machine. On llama.cpp the context is divided between the slots, so adding slots can shrink the context an issue needs. The Configuration page shows that trade-off before it is applied. On vLLM, the priority maps to the request's `priority` field.

## 3. Contract

- **Config** (user config only; the repo config is ignored, INT-26):
  - `[team] mode = "solo" | "team"`;
  - `[identity] sources = ["accounts", "proxy", "oidc"]`, `user_header`, `trusted_proxies`, `open_signup_domains`, `invite_ttl_days = 7`;
  - `[sessions] idle_minutes = 60`, `absolute_hours = 24`;
  - `[tokens] default_days = 90`, `max_days = 365`;
  - `[queue] agent_issues_per_person = 1`.

  The sign-in limits of item 14a and the setup token's 24 hours are fixed, not configurable.
- **Events** (every event carries the principal, kernel rule 19). A person's name and email are never in an event's payload: they live in the private, erasable `person/*` record (kernel rule 19; DEC-29 O1). Comment bodies, update text and suggestion reasons are personal free text: they are stored in the event's private part and fall under erasure and the 90-day retention of personal free text (O14, DEC-29 O1).
  - members: `member/invited {level, project?, expires}`, `member/joined {principal, level, via: "setup" | "invite" | "signup" | "proxy", pending}`, `member/approved`, `member/level_changed {principal, level, project?}`, `member/label_changed`, `member/removed`;
  - sign-in: `session/started`, `session/ended {reason}`, `session/refused {reason, count}` (the window summary of item 14b), `account/locked {until?}`, `account/unlocked`;
  - credentials: `token/created {expires}`, `token/used`, `token/revoked`, `password/reset_issued`, `password/changed`;
  - configuration: `config/changed_outside {keys}`, recorded at start-up when the user `config.toml` differs from the last recorded state;
  - issues: `issue/watched`, `issue/unwatched`, `review/commented`, `review/accept_dismissed {reason: new_commits}`;
  - inbox: `inbox/read`, `inbox/done`, `inbox/snoozed {until}`, `inbox/saved`;
  - AI teammates: `agent/start_requested {requested_by}` (item 19a);
  - suggestions: `suggestion/proposed {kind, value, why}`, `suggestion/applied {auto: boolean}`, `suggestion/dismissed`;
  - projects: `project/created`, `project/archived`, `project/settings_changed {accept_rule?, require_resolved_threads?, lead?, auto_apply?}` (only the fields that changed), `project/health_set {health}`, `project/update_posted`, `plan/sent_for_approval {approver}`, `plan/approved`.
- **Endpoints:**
  - sign-in: `POST /api/session` (sign in), `DELETE /api/session`, `POST /api/setup` (setup token);
  - members: `GET/POST /api/members`, `POST /api/members/:id/unlock` (Admin), `POST /api/members/:id/password-reset` (Admin), `POST /api/invites`, `GET /api/invites/:id` (shows the invite; consumes nothing), `POST /api/invites/:id/accept`;
  - tokens: `POST /api/tokens`, `DELETE /api/tokens/:id`;
  - `GET /api/inbox`;
  - `POST /api/issues/:key/watch`;
  - `GET /api/audit` (Admin);
  - projects: `POST /api/projects`, `POST /api/projects/:id/archive`, `PATCH /api/projects/:id/settings`, `POST /api/projects/:id/health`, `POST /api/projects/:id/updates`;
  - `GET /api/presence` (a server-sent stream, not stored).

  Each write endpoint, and each chat slash command, checks the level and answers 403 with the missing permission named.
- **CLI:** `sekhemet serve --new-setup-token` (item 2): a flag on the existing command, not a new one ([surface](surface.md) rule 14).
- **Pages** ([dashboard](dashboard.md)): Sign in, Projects, Inbox, My issues, Members (Admin), Audit (Admin), the account menu, and the project update editor on Status.

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Solo setup: loopback, one principal | partial | the server binds loopback (`server.ts:1190`); every write is actor `"human"`, no principal ([integrations](integrations.md) §4) | NEW-teams-1 |
| Workspace, Projects page, access levels, per-project override, project settings | not-built | — | NEW-teams-2 |
| Setup token, invites, passwords, sessions, sign-in limits, personal tokens, the credential store | not-built | [runtime](runtime.md) items 26–27 specify binding and a token sign-in only | NEW-teams-3 |
| Passkeys and OIDC | not-built | waiting for O28, O29 | NEW-teams-4 |
| AI teammates: identities, states, `@Agent`/`@Seshat` by level, `on_behalf_of` | not-built | the delegate exists in the design (kernel rule 21) | NEW-teams-5 |
| Seshat's suggestions instead of assignments; stakeholder plan approval | not-built | — | NEW-teams-6 |
| Subscriptions, watch, @mentions of people, Inbox | not-built | `@` mentions cards only ([dashboard](dashboard.md) item on the composer) | NEW-teams-7 |
| Review verdicts: Comment, stale accept dismissal, resolved threads | not-built | Accept and Send back only ([review-git](review-git.md)) | NEW-teams-8 |
| Presence | not-built | — | NEW-teams-9 |
| Audit view and export | not-built | the ledger holds the data; `sekhemet log` reads it | NEW-teams-10 |
| Project health set by a person; project updates; the fair-queue additions of §2.7 | not-built | — | NEW-teams-11 |

## 5. Changes for v1

**NEW-teams-1 — the two setups.** *Problem: the product has one mode, and a team server is only sketched.*
- **TEAM-1** WHEN Sekhemet starts in Solo mode THE SYSTEM SHALL bind loopback only, show no sign-in page, and attribute every event to the operating-system user's principal.
- **TEAM-2** WHEN Sekhemet starts in Team mode for the first time THE SYSTEM SHALL write a single-use setup token, valid for 24 hours, to a file of mode 0600 in the data directory, print only that file's path to the console, create the first Admin only from that token, and refuse every other sign-in until an Admin exists.
- **TEAM-3** WHEN a Solo install is switched to Team THE SYSTEM SHALL keep the event log unchanged and make the Solo principal the first Admin.
- **TEAM-31** WHEN a setup token is presented more than 24 hours after it was written THE SYSTEM SHALL refuse it; WHEN `sekhemet serve --new-setup-token` runs while no Admin exists THE SYSTEM SHALL write a new token and void the previous one; WHEN an Admin exists THE SYSTEM SHALL refuse the command and write nothing.

**NEW-teams-2 — workspace, projects and access levels.**
- **TEAM-4** WHEN a person without the needed level calls a write endpoint THE SYSTEM SHALL answer 403 naming the permission and a level that has it, and record the refusal.
- **TEAM-5** WHEN a Stakeholder asks to start the Agent, change scope or priority, apply a proposal or accept THE SYSTEM SHALL refuse and offer to ask a Member.
- **TEAM-6** WHEN an Admin overrides a person's level for one project THE SYSTEM SHALL apply the override to that project only, and record `member/level_changed` with the project.
- **TEAM-7** WHEN a profile label changes THE SYSTEM SHALL change no permission.
- **TEAM-32** WHEN a person the action table of item 6 does not name edits a project's Accept rule or settings, archives a project, names a lead, turns on auto-apply, connects an integration, approves a Playbook rule, or starts a queue or overnight run THE SYSTEM SHALL refuse it as in TEAM-4; WHEN an allowed person changes a project's Accept rule, required resolved threads, lead or auto-apply THE SYSTEM SHALL record `project/settings_changed` naming only the changed fields.

**NEW-teams-3 — accounts and sessions.**
- **TEAM-8** WHEN an invite link is used a second time, or after it expires, THE SYSTEM SHALL refuse it and create no account.
- **TEAM-9** WHEN a password shorter than 15 characters, or one containing the person's name or email or the workspace name, is set THE SYSTEM SHALL refuse it and say which rule failed, without composition rules; once O30 is decided, a password on the bundled list SHALL be refused the same way, and no password SHALL be sent off the server to be checked.
- **TEAM-10** WHEN a person signs in or their level changes THE SYSTEM SHALL issue a new session id; WHEN a session is idle for `idle_minutes` or older than `absolute_hours` THE SYSTEM SHALL end it on the server.
- **TEAM-11** WHEN a credential is created, used, reset or revoked THE SYSTEM SHALL record the event without the credential or its hash in the event log, and SHALL keep the hash only in the credential store (mode 0600, outside `events.db`, in every backup, in no export).
- **TEAM-12** WHEN a request carries the user header from an address outside `trusted_proxies` THE SYSTEM SHALL ignore the header and treat the request as unauthenticated, so that a protected endpoint answers 401 (the same rule as [integrations](integrations.md) INT-21).
- **TEAM-33** WHEN an invite link is fetched with `GET` THE SYSTEM SHALL show the invite and consume nothing; only `POST /api/invites/:id/accept` SHALL create the account.
- **TEAM-34** WHEN an account and source address pair has failed 10 consecutive sign-ins THE SYSTEM SHALL refuse that pair for 15 minutes, with exponential back-off before that; WHEN an account reaches 100 consecutive failures THE SYSTEM SHALL lock it until an Admin unlocks it and record `account/locked`; the same limits SHALL apply to setup-token and invite attempts.
- **TEAM-35** WHEN callers who are not signed in fail any number of sign-ins within a 15-minute window THE SYSTEM SHALL write at most one `session/refused` summary per account (per address for an unknown account) for that window, and after a restart SHALL resume each account's count toward 100 from those summaries.
- **TEAM-36** WHEN a person is removed, their password is reset or their level is lowered THE SYSTEM SHALL end every session they hold; WHEN a person is removed THE SYSTEM SHALL also revoke their personal access tokens.
- **TEAM-37** WHEN a personal access token is used after its expiry (90 days by default, never more than one year) THE SYSTEM SHALL refuse it; WHEN a valid token is used THE SYSTEM SHALL act at the lower of the token's scope and the person's current level.
- **TEAM-38** WHEN a person is first seen through the trusted proxy and no invite for their email exists THE SYSTEM SHALL create them *pending* and allow them nothing until an Admin approves them; WHEN an invite for their email exists THE SYSTEM SHALL join them at the invite's level.

**NEW-teams-4 — passkeys and company SSO** (after O28/O29).
- **TEAM-13** WHEN the identity provider's claim maps to no level and strict mode is on THE SYSTEM SHALL refuse the sign-in and name the missing mapping.
- **TEAM-14** WHEN levels are managed in Sekhemet THE SYSTEM SHALL NOT change a person's level from an identity-provider claim.

**NEW-teams-5 — AI teammates.**
- **TEAM-15** WHEN an issue is delegated to the Agent or a comment mentions `@Agent` or `@Seshat` THE SYSTEM SHALL set and show the AI's state on the issue within 10 seconds, from the harness and without waiting for a model to load or reply.
- **TEAM-16** WHEN the Agent acts THE SYSTEM SHALL record `on_behalf_of` as the person who started it, and SHALL refuse any action that person could not take.
- **TEAM-17** WHEN a picker lists people THE SYSTEM SHALL list Seshat and the Agent separately, as AI teammates, with an "AI" badge.
- **TEAM-39** WHEN a Stakeholder or a Viewer writes `@Agent` on an issue THE SYSTEM SHALL NOT start the Agent, SHALL put a request naming that person and what they asked in the *Needs you* of the issue's owner (or of the project lead, when the owner is below Member), and SHALL start the Agent only when a Member presses *Start*, on that Member's behalf.
- **TEAM-40** WHEN a Viewer writes `@Seshat` THE SYSTEM SHALL answer and SHALL create no proposal and no suggestion; WHEN a chat slash command is typed THE SYSTEM SHALL check the caller's level as for the matching endpoint and refuse it as in TEAM-4.

**NEW-teams-6 — Seshat proposes; people decide.**
- **TEAM-18** WHEN Seshat would change an assignee, label, priority, duplicate link or split THE SYSTEM SHALL post a suggestion with its reason and change nothing until a person applies it, unless an Admin turned on auto-apply for that property on that project; auto-apply SHALL NOT be available for the assignee or health.
- **TEAM-19** WHEN a suggestion is dismissed THE SYSTEM SHALL NOT propose the same change on that issue again, where the same change is the same property with the same value.
- **TEAM-20** WHEN a Stakeholder finishes a project conversation THE SYSTEM SHALL offer *Send for approval* instead of *Create project*, and create nothing until a Member or Admin approves.
- **TEAM-41** WHEN a suggestion is applied automatically THE SYSTEM SHALL record as its principal the Admin who turned the rule on, show "applied by <Admin>'s rule" on the issue, and undo it in one action.
- **TEAM-42** WHEN an approved stakeholder plan creates issues THE SYSTEM SHALL make the approver their owner, and SHALL let the owner be changed afterwards.

**NEW-teams-7 — subscriptions, mentions and the Inbox.**
- **TEAM-21** WHEN a person creates, owns, is delegated, is mentioned on, comments on, or is asked to review an issue THE SYSTEM SHALL subscribe them to it.
- **TEAM-22** WHEN a comment mentions a person who cannot see the project THE SYSTEM SHALL ask the author whether to invite them and notify no one until they answer.
- **TEAM-23** WHEN an inbox item is read, or marked Done, Snoozed or Saved, THE SYSTEM SHALL record it, and a digest SHALL contain only items still unread.
- **TEAM-43** WHEN a watched issue changes THE SYSTEM SHALL add the change to each watcher's Inbox, and SHALL push it by email or chat only within that watcher's notification budget, counting posted project updates against the same budget.

**NEW-teams-8 — review verdicts.**
- **TEAM-24** WHEN new commits land on an accepted issue's branch before merge THE SYSTEM SHALL dismiss the accept and record why.
- **TEAM-25** WHEN a project requires resolved threads and one is open THE SYSTEM SHALL disable Accept and name the open thread.

**NEW-teams-9 — presence.**
- **TEAM-26** WHEN people view the same issue THE SYSTEM SHALL show their avatars within 5 seconds and SHALL write nothing about it to the event log.

**NEW-teams-10 — the audit view.**
- **TEAM-27** WHEN an Admin opens Audit THE SYSTEM SHALL list every sign-in, refusal summary, lock, level change, invite, token, password reset, model change and configuration change from the event log, filterable and exportable, and refuse the page to anyone else.
- **TEAM-44** WHEN Sekhemet starts and the user `config.toml` differs from the last recorded state THE SYSTEM SHALL record `config/changed_outside` naming the changed keys, and SHALL NOT record their values.

**NEW-teams-11 — health, updates and the shared queue.**
- **TEAM-28** WHEN health is set THE SYSTEM SHALL record the person and show their name and date; a model SHALL NOT set health.
- **TEAM-29** WHEN, in the Team setup, 7 days pass since a project's last posted update — or since its current release started, if none was posted — THE SYSTEM SHALL show *Update missing* to the project's lead.
- **TEAM-30** WHEN a person reaches the per-person cap of concurrent Agent issues THE SYSTEM SHALL queue their next issue, show its place and an estimate, and run other people's issues first.
- **TEAM-45** WHEN Sekhemet runs in Solo THE SYSTEM SHALL treat health and the weekly update as optional, and SHALL show neither *Update missing* nor *No health set*.

## 6. v1 acceptance

TEAM-1 to TEAM-45 pass, except TEAM-13 and TEAM-14, which apply only once O28 and O29 are approved, and TEAM-9's list check, which applies once O30 is decided. The spec is `built` when a Team install, with five people at four levels, runs one project from a stakeholder's conversation to an accepted release, and every write in that run is attributed and permitted.

## 7. Later

- SCIM provisioning and directory groups: one team on one server can live with invites and OIDC.
- Several workspaces on one install (multi-tenant): Later, as in DEC-06.
- Per-person ReviewWIP and review assignment by load ([review-git](review-git.md) Later).
- Live cursors and co-editing an issue's description.
- Guest access across organisations.

## 8. Open questions

- **O28** Passkeys in v1 with SimpleWebAuthn (MIT)? *Recommendation: yes.* Passkeys resist phishing and are what NIST allows at AAL2.
- **O29** Company SSO (OIDC) in v1 with `openid-client` (MIT)? *Recommendation: yes.* Enterprise teams expect it, and the proxy route asks every team to run oauth2-proxy.
- **O30** Which common-password list to bundle, under which licence ([OPEN_QUESTIONS](../../reference/OPEN_QUESTIONS.md#owner-decisions))? *Recommendation:* a bundled, offline list with a permissive licence, never an online lookup, which would break air-gapped installs and the egress rules. Until decided, item 11 checks length and the person's own name, email and the workspace name.

## 9. Evidence and rationale

- [DESIGN_RESEARCH_COLLABORATION.md](../../research/DESIGN_RESEARCH_COLLABORATION.md): roles, AI as a teammate, non-directive language, collaboration mechanics, sign-in, shared inference, status.
- [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) §2.1: owner and delegate, CODEOWNERS, independent accept.
- [DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md): engine adapter, fair share, interactive-first, aging.
- Sign-in limits, password rules and session lifetimes: NIST SP 800-63B-4 (rate limiting to at most 100 consecutive failures per account; length over composition; no forced rotation).
- Decisions: [DEC-06](../DECISIONS.md#dec-06), [DEC-34](../DECISIONS.md#dec-34), [DEC-35](../DECISIONS.md#dec-35--one-product-two-setups-solo-and-team), [DEC-36](../DECISIONS.md#dec-36--the-ai-is-a-teammate-that-proposes-people-decide), [DEC-37](../DECISIONS.md#dec-37--status-serves-the-stakeholder-and-the-team-from-the-same-data).
