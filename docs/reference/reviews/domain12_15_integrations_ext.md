# Phase A review — Domain 12 (Integrations) and Domain 15 (Extensibility)

*Read-only review, 2026-09-22, at 468f67f. Paths are relative to the worktree root. I checked two findings (marked **[probed]**) with a scratch script run against the built `dist/` in a throwaway in-memory database. The three related spec files pass (28 tests). Anything I did not check is marked as uncertain.*

---

## Domain 12 — Integrations

### 1. Positioning: could a professional team plug this in today?

**What works (with real code behind it):**
- **Export** of the board as Jira CSV, Linear CSV, GitHub JSON or raw JSON (`apps/harness/src/integrations.ts:289-392`). **Import** of CSV/JSON as PM proposals, never applied silently (`:413-475`, `:805-838`). CSV follows RFC 4180 (`:240-268`).
- **GitHub Issues sync through the `gh` CLI**, started by hand (`POST /api/integrations/github/sync`, `:496-638`). Pull brings in up to 200 *open* issues (`:536-549`). Push opens issues and closes or reopens them. Titles and bodies are never updated in either direction.
- **PR on accept**: `git push origin`, then `gh pr create` or a draft PR through the GitHub App, with a check run per gate, line annotations and a SARIF upload (`execute.ts:1321-1342`, `:1534-1600`; `wave2_github.ts:84-131`; `packages/sync/src/github_app.ts:248-309`). The queue moves the PR to ready, requests CODEOWNERS reviewers and enables auto-merge (`wave2.ts:384-393`).
- **External review cards**: a `sekhemet:review` label or a `/review` comment runs the gates and a review on someone else's PR (`external_review.ts`, wired at `index.ts:1518`).
- **Push notifications (ntfy/Gotify)**, driven by the ledger (`notify.ts:186-214`), which is the right design. **Slack** is an incoming webhook (`integrations.ts:202-230`).

**Export-only:** Jira and Linear. Imported cards get no `externalRef`, and the key/ID columns are ignored (`:413-475`), so an export followed by an import duplicates every card and no link survives. `ExternalRef.system` is only `"github" | "forgejo"` (`packages/kernel/src/types.ts:101`).

**Missing or broken for a team:**
- Slack "standup" and "needs you" are declared (`integrations.ts:205`, PM_CONTRACT §5) but never sent. The only caller is the queue's run report (`index.ts:1932`).
- Accepting with PR-on-accept moves the card to **Done when the PR is opened** (`execute.ts:1323-1329`). A PR that is rejected or left unmerged still shows as Done on the board.
- Webhooks cannot reach the server. It binds to `127.0.0.1` only (`server.ts:1190`), and no document mentions a tunnel. `/plan`, `/split`, `/estimate` and `workflow_dispatch` are recorded as events that nothing reads (`wave2_server.ts:94-112`, `:136-145`). Nobody replies in the comment thread.
- The "company server" does not exist. The dashboard is loopback-only, and its trust model is a custom header plus a loopback Origin (`server.ts:115-126`). Every write is recorded as actor `"human"`, so there is no user identity. The gate host listens only on 127.0.0.1, its certificates cover only localhost and 127.0.0.1 (`gate_host.ts:36-39`, `:225`), the CLI has no `--host` (`index.ts:831`), and it assumes a shared filesystem path (`:131-137`).
- CI can serve as a gate only as a manual command (`sekhemet ci`, `wave2.ts:795-807`). No gate rung runs it.

**Verdict for the selling point:** a team can hand work to GitHub through PRs. It cannot yet run its backlog in Jira, Linear or GitHub Issues alongside Sekhemet, and it cannot host Sekhemet for several people. The claims table understates part of the gap ("Partial — … no live two-way sync") and overstates another: "Runs on your server — Built" is true only on a single machine.

### 2. Drift (design vs code)

| Design says | Code does |
|---|---|
| One `SyncAdapter`; GitHub as a GitHub App (HARNESS_DESIGN "Integrations…", "GitHub integration") | **Three** ways an issue becomes a card, each with a different ID: the `gh` CLI (`owner/repo#n`, `integrations.ts:551`), the App/Forgejo adapter (`n`, `remote.ts:137`), and the webhook (`n`, card id `card_gh<n>`, tier `story`, title `GitHub #n`, `wave2_server.ts:72-91`). Switching paths creates duplicates. PM_CONTRACT §2 fixes the ID as `owner/repo#n`. |
| Last-writer-wins per shared field, with history | LWW compares the tracker's `updated_at` against the **whole card's** `updatedAt` (`remote.ts:68`). Any board activity, such as a status move, makes the board "win" a title it never edited. A board win is also never pushed back, so the two sides stay diverged and a `sync/conflict` event is logged on every sync (`wave2_github.ts:304-311`). |
| "Reconcile on completion" for non-scope edits made mid-card | **[probed]** The edit is lost. The snapshot is overwritten on every sync (`wave2_github.ts:314`), so after the card finishes the snapshot equals the item, `reconcileExternalEdit` returns `none`, and the title stays old ("Old title" before and after completion). |
| Review comments become repair subtasks; threads are resolved | `openThreads` and `resolveThread` exist (`github_app.ts:395-443`), but nothing calls them. |
| Branch protection, merge policy | The PR base is hardcoded to `"main"` in both paths (`wave2_github.ts:97`, `execute.ts:1593`), and the remote to `origin` (`:1544`). |
| GraphQL "backs off on secondary limits" | Only REST backs off (`github_app.ts:159-169`). GraphQL does not (`:176-194`), and neither does the token exchange (`:113-133`). |
| Pull uses webhooks, batches, idempotency keys | Pull is a manual REST poll of `per_page=100` with **no pagination** (`remote.ts:130-133`). There are no idempotency keys, and webhook deliveries are not deduplicated (`webhook.ts:171-175`). |
| Notifications through ntfy/Gotify | Matches. Slack runs as a second pipeline that does not read the ledger. |

### 3. Dead and duplicated code

- **Dead** (reachable only from tests): `PullRequestLifecycle.openThreads` and `resolveThread` (`github_app.ts:395-443`); `ForgejoIssuesAdapter.addDependency` (`remote.ts:259`; the `addDependency` in `index.ts` belongs to the kernel's CardStore); `splitAcrossRepos` (`repo_tools.ts:389`). The `github/command` and `github/dispatch` events are written and never read.
- **Duplicated:** the PR body is built twice (`wave2_github.ts:55-76` and `execute.ts:1570-1590`). The SPIDR title-strip regex appears three times (`integrations.ts:285`, `wave2_github.ts:98`, `execute.ts:1567`). `ownerRepo` is re-implemented at `execute.ts:1547`. Reading `latest-<id>.json` evidence is repeated in `mcp.ts:86`, `wave2_github.ts:44` and `execute.ts:1572`. Issue-to-card creation is written three times. There are two notification pipelines.
- `githubCache` is a module global that is not keyed by repository (`integrations.ts:106`). A server with several repositories would report the wrong repository.

### 4. Complexity hotspots

- `wave2_server.ts:151-387` (`handleWave2Route`, about 235 lines) mixes webhooks, images, telemetry, registry, recurring triggers, decisions, goals, attachments, diff and review. It has no cohesion.
- `wave2_github.ts:204-341` (`syncViaAdapter`, about 140 lines of nested merge, pause and push logic).
- `integrations.ts:496-638` (two sync implementations in one function) and `:652-841` (a 190-line if-chain router).
- `wave2*` names are build-phase labels, not domain names.

### 5. Test quality against DEFINITION_OF_DONE §2

**Good:** the tests use real loopback HTTP fakes instead of mocked `fetch` (`packages/sync/tests/remote.spec.ts:57-84`). The JWT is verified with the real public key, the HMAC is real, and release and act tests run on real temporary git repos. There is one secondary-rate-limit retry test (`:142-167`) and one bad-signature 401 test (`:464`, `wave2_server.spec.ts:142`).

**Gaps (§2B asks for two negative cases per happy path; most integration paths have zero or one):**
- **No tests at all** for the default `gh` CLI sync path or for `gh pr create` on accept. Only the Forgejo adapter path is exercised (`wave2_github.spec.ts:163-207`). A fake `gh` on `PATH` would cover both.
- No tests for: a 401 from the token exchange; retries running out; a 422 on issue create; pagination; GraphQL `errors`; a malformed or oversized webhook (413); a redelivered webhook; `gh` not installed or not logged in (the mapping at `integrations.ts:125-129`); Slack 4xx or timeouts; a CSV with an unterminated quote; a sync conflict round trip (the lost-edit bug above would have been caught).
- Fixtures are minimal hand-made payloads, not recorded GitHub, Forgejo or Jira payloads.
- `wave2_github.spec.ts:59-64` uses `:memory:` SQLite, which contradicts §2A.

### 6. Senior judgement (ranked)

1. **GitHub first, as one adapter.** GitHub comes first because PM_CONTRACT §5 cites 81% usage, most of the machinery already exists (App client, check runs, PR lifecycle, webhooks, external review), and the PR is where a professional team decides a card is done. Jira and Linear sync only mirror the backlog, which is worth less than getting accept → PR → merge right. Concretely:
   - fold the `gh` path into the adapter as a transport/`TokenProvider`;
   - use one canonical `owner/repo#n` ID;
   - paginate;
   - do a three-way merge against the stored snapshot;
   - push the board's wins back;
   - add a card state "awaiting merge" that closes on `pull_request.closed`;
   - wire review threads into repair subtasks.
2. **Company-server minimum.** Five pieces: a configurable bind host behind TLS; authentication through a reverse-proxy OIDC header or per-user tokens, with the ledger actor set to the real user; a role check so only reviewers can accept; a reachable webhook endpoint (documented tunnel or public ingress); and gate-host `--host` plus configurable certificate SANs, and a way to run without the shared-path assumption. Secrets on Linux need an env or file source; the keychain loader is macOS-only (`github_app.ts:43-54`).
3. **One notifier with channels.** Slack and Teams should be channels of the ledger-driven `startNotifier`, which delivers the standup and "needs you" alerts PM_CONTRACT promises.
4. **Jira second, Linear third**, through official clients (see Proposals), each with a real `externalRef.system`.
5. **CI as a gate rung** (act, or reading the PR's existing check runs), not only a manual command.

### 7. Verdicts

| File | Verdict |
|---|---|
| `packages/sync/src/github_app.ts` | **Refactor**: sound pieces; add GraphQL/token backoff and pagination, or replace the client with Octokit |
| `packages/sync/src/remote.ts` | **Rebuild** the merge and reconcile logic (three-way, per-field); keep the adapter interface |
| `packages/sync/src/webhook.ts` | **Keep**; add delivery deduplication and a `pull_request.closed` intent |
| `packages/sync/src/repo_tools.ts` | **Keep**; cut `splitAcrossRepos` pending sign-off |
| `packages/sync/src/git_adapter.ts` | **Keep** (it has no remote operations; the push lives in `execute.ts`) |
| `apps/harness/src/integrations.ts` | **Refactor**: split into export/import, settings, and routes; retire `syncGithub`'s gh branch into the adapter |
| `apps/harness/src/wave2_github.ts` | **Refactor + rename** (`github/pr.ts`, `github/sync.ts`) |
| `apps/harness/src/wave2_server.ts` | **Refactor**: break the grab-bag router up by domain |
| `apps/harness/src/notify.ts` | **Keep**; make it the only notifier |
| `packages/gates/src/gate_host.ts` | **Keep**; add host/SAN configuration and cwd confinement |

---

## Domain 15 — Extensibility

### 1. Positioning: can a team extend Sekhemet without forking?

- **Hooks: yes, and well done.** `.sekhemet/hooks.toml` runs shell commands with Claude Code-style semantics: exit 2 blocks, JSON on stdout injects a message (`user_hooks.ts:12-31`, `:101-146`). pre-* events fail closed and the others fail open (`packages/kernel/src/hooks.ts:34-38`). All ten events are actually emitted (session.ts 1093/1175/1351/1390/1596/1622, card_runner.ts 845/1501, triage.ts:60, learning/store.ts:190). The gap is that hooks cover only the Worker's lifecycle. There is no board-level `card/accepted` or `status_changed` hook, and that is exactly what a team would want in order to call its own Jira or CI.
- **Skills: partially.** SKILL.md files are pinned by SHA-256 and a human approves them (`packages/context/src/skills.ts:190-248`), which is good. They do not follow the Agent Skills format: `triggers:` is a required inline array that ecosystem skills lack; the frontmatter is parsed with regexes, so multi-line YAML breaks (`:251-283`); `scripts/`, `references/` and `evals/` are ignored; and only the project scope is read (`execute.ts:356-357`). Matching is a raw substring test (`:162-178`), so the trigger `ast` fires on "last", "fast" and "past", and `fix` fires on "prefix".
- **MCP server: yes, but local stdio only** (`mcp.ts`). It is hand-rolled, speaks protocol `2024-11-05` with no negotiation (`:277`), has no HTTP transport and no resources, and answers parse errors with `id: 0` where the spec requires `null` (`:343`).
- **MCP client: only the Researcher uses it** (`research/cli.ts:66`). The Planner and Worker never see MCP tools, and there is no HTTP or OAuth transport (`mcp_client.ts:73-77`). A team therefore cannot plug in the hosted GitHub, Atlassian or Linear MCP servers.
- **Plugins:** `.sekhemet/plugins/*/index.mjs` can provide services and hooks only (`packages/kernel/src/container.ts:147-163`). Nothing in the harness resolves plugin-provided services (grep finds no `container.resolve` outside the plugin context), so a plugin **cannot add a tool, gate, sync adapter or UI panel**, which the design promises.
- **Slash commands** are a hardcoded switch (`pm/slash.ts:71-130`). There are no user-defined Markdown commands.
- **ACP** is a chat with the PM only (`acp.ts:7-19`), not "open a card, stream steps, approve".
- **SDK**: a thin REST and WebSocket client (`packages/sdk/src/index.ts`). It cannot run, plan or gate. Its types are duplicated from the kernel (`:15-35`), it has no async-iterator stream, and its only consumer is `sdk.spec.ts`.

### 2. Drift

The design says a plugin can register "tools, gates, sync adapters, UI panels"; the code supports only services and hooks. Its slash commands are Markdown templates; the code has a fixed switch. The MCP client is described as serving the "planner and Worker"; only the Researcher uses it. Skills are described as "project- or user-scoped, with scripts/references/evals, every skill ships an eval card"; the code reads the project scope and SKILL.md only, with no evals. ACP is described as card-level review; the code offers PM chat. The SDK is described as offering "headless run/plan/gate, event log as async iterator"; the code is read-mostly with a callback. The design lists nine hook events; the code has ten (it adds `turn-stopping`).

**Trust drift (security):** skills get hash pinning, but `.sekhemet/hooks.toml`, `.sekhemet/mcp.json` and `.sekhemet/plugins/` from a **cloned repository** run code with the user's rights, with no trust prompt (`user_hooks.ts:56`, `mcp_client.ts:33-36`, `container.ts:196-222`). In a team setting, merging a PR that adds a hook means running that hook on every teammate's machine.

**[probed] Acceptance bypass through MCP.** `sekhemet_move_card` does not validate `to` on the server (the enum exists only in the schema, `mcp.ts:163`) and passes `reason` through unchanged (`:171-177`). With `{to:"done", reason:"override: …"}`, `BoardServiceImpl` turns the "Only a person accepts" entry condition into a recorded override and **moves the card to Done** (`board_service.ts:292-300`). The plain move is refused; the override is allowed. This contradicts the tool's own contract ("Accepting is a human action", `mcp.ts:61-62`).

### 3. Dead and duplicated code

- JSON-RPC over stdio is hand-written three times: the MCP server, the MCP client and ACP.
- `SkillManifest.budgetTokens` appears in every shipped skill, but the parser never reads it.
- Hook load errors are discarded (`execute.ts:377` keeps only `.engine`).
- The SDK is dead by the plan's rule 3, unless it is published as a package.
- `sekhemet_run_gates` builds its working directory from an unchecked `card_id` (`mcp.ts:186-188`). This is path traversal, though low severity because the MCP client is local.

### 4. Complexity hotspots

Low overall. The hotspot is `wave2.ts` (1,318 lines, a CLI switch that includes `skills`, `release`, `ci` and `improve`).

### 5. Test quality

- Hooks: 3 tests that cover block, inject, env/stdin and fail-closed (`user_hooks.spec.ts`). A timeout test is missing, and so is a test for a child exiting before it reads stdin. `child.stdin` has no error handler (`user_hooks.ts:144`), so an EPIPE could crash the harness; this is **uncertain** and needs a test.
- MCP: 10 tests, all happy paths plus one tier check. None checks that moving to `done` is refused, which is the bypass above.
- Skill trust is tested (`context_units.spec.ts`, `wave2_wiring.spec.ts`). Trigger over-matching is not.
- MCP client: a real stdio child, including a broken-server case (good).

### 6. Senior judgement (ranked)

1. Close the MCP acceptance bypass. Enforce allowed transitions per actor in the board service, not in the tool schema.
2. Add a **workspace-trust** gate for repo-supplied hooks, MCP servers and plugins, reusing the skills lock mechanism.
3. Move the MCP client and server onto the official SDK. Add Streamable HTTP and OAuth. Offer MCP tools to the Planner and PM (and to the Worker behind an allow-list). This turns "integrate with Jira or Linear" into configuration.
4. Add **board-level hook events** (`card/status_changed`, `card/accepted`, `pr/opened`), so teams can integrate without forking.
5. Make skills conform to the Agent Skills format: real YAML, description-based selection, word-boundary triggers as a fallback, and user scope.

### 7. Verdicts

| File | Verdict |
|---|---|
| `packages/kernel/src/hooks.ts` | **Keep** |
| `apps/harness/src/user_hooks.ts` | **Keep**; add a stdin error handler, surface load errors, add trust |
| `packages/kernel/src/container.ts` | **Refactor**: either give plugins real tool/gate/adapter extension points, or narrow the claim to what is built |
| `packages/context/src/skills.ts` | **Refactor**: YAML parser, spec conformance, matching |
| `apps/harness/src/mcp.ts` | **Refactor** onto the SDK; fix the bypass now |
| `apps/harness/src/mcp_client.ts` | **Rebuild** on the SDK (HTTP, OAuth) |
| `apps/harness/src/acp.ts` | **Keep** as PM chat; revise the design claim |
| `packages/sdk/src/index.ts` | **Keep** if it will be published; otherwise cut (owner sign-off) |
| `apps/harness/src/pm/slash.ts` | **Keep**; add Markdown user commands later |

---

## Proposals (require the owner's yes)

Licences and maintenance status are from my knowledge as of mid-2026; I did **not** check them against the network. Please verify before adopting.

| Proposal | Licence | Maintenance | Replaces / adds | Why |
|---|---|---|---|---|
| **Octokit** (`@octokit/app`, `@octokit/rest`, `plugin-throttling`, `plugin-retry`, `plugin-paginate-rest`, `@octokit/webhooks`) | MIT | GitHub-official, very active | Replaces the hand-rolled `GitHubClient`, JWT and token exchange, HMAC checks and webhook typing | Adds pagination, GraphQL throttling, secondary-limit handling and typed webhook payloads at once, |
| **@modelcontextprotocol/sdk** (TypeScript) | MIT | Official, very active | Replaces `mcp.ts` and `mcp_client.ts` JSON-RPC | Current protocol versions, Streamable HTTP, OAuth, resources. It unlocks the hosted GitHub MCP server (github/github-mcp-server, MIT), Atlassian's Remote MCP and Linear's MCP as **configuration, not code** |
| **jira.js** | MIT | Community, active (uncertain) | Adds Jira live sync | Typed Jira Cloud and Data Center REST v2/v3 client. Needs `externalRef.system: "jira"` |
| **@linear/sdk** | MIT | Linear-official, active | Adds Linear live sync | Typed GraphQL client with webhooks, cycles and estimates, which map to existing fields |
| **@slack/bolt** (Socket Mode) + **@slack/webhook** | MIT | Slack-official | Adds the "Slack replies" tier | Socket Mode needs **no public ingress**, which fits a loopback-first product |
| **smee-client** (ISC) or documented **cloudflared** (Apache-2.0) | ISC / Apache-2.0 | Probot / Cloudflare | Adds webhook reachability | Makes webhook intake work on a laptop today |
| **oauth2-proxy** (MIT) in front of the server, or **openid-client** (MIT, panva) in it | MIT | Active | Adds company-server authentication | Gives SSO and user identity for the ledger actor without writing an auth system |
| **yaml** (ISC) or **gray-matter** (MIT) | ISC / MIT | Active | Replaces regex frontmatter parsing | Needed for Agent Skills conformance |
| **@agentclientprotocol/sdk** (Zed) | Apache-2.0 (uncertain) | Active | Replaces the hand-written ACP | Would pick up permission requests, which map onto accept and send-back |

---

## Top 5 changes (across both domains)

**1. Close the MCP acceptance bypass**
- **What:** enforce per-actor transition rules in `BoardServiceImpl`, so no override for `mcp` into Done; validate `to` in `mcp.ts`.
- **Why:** **[probed]** `move_card {to:"done", reason:"override: …"}` accepts a card (`mcp.ts:155-180`, `board_service.ts:292-300`).
- **Effort:** S. **Risk:** low.
- **Measure:** new negative tests (plain and override) fail red today and pass after.

**2. One GitHub adapter, with correct sync semantics**
- **What:** one ID (`owner/repo#n`) covering the gh, App and webhook paths; pagination; a three-way per-field merge from the snapshot; push-back of board wins; a fix for the lost apply-on-completion edits; "awaiting merge" until the PR merges.
- **Why:** three ID formats (`integrations.ts:551`, `remote.ts:137`, `wave2_server.ts:84`); **[probed]** lost edit (`wave2_github.ts:314`); no pagination (`remote.ts:132`); Done at PR open (`execute.ts:1323`).
- **Effort:** L (split into 4–5 cards). **Risk:** medium, because this is migration of existing `externalRef`s.
- **Measure:** a contract suite with recorded GitHub payloads: sync twice gives zero changes, zero duplicates across paths, and more than 100 issues are all pulled.

**3. Company-server minimum**
- **What:** a bind host plus TLS behind a proxy; identity from an OIDC header or tokens; the ledger actor is the real user; an accept role; a documented webhook ingress; gate-host `--host` and SANs.
- **Why:** `server.ts:1190` binds loopback; the trust model is a header (`:115-126`); the actor is `"human"` everywhere; the gate host is localhost-only (`gate_host.ts:36-39`, `index.ts:831`). The claims table's "your server — Built" is not true.
- **Effort:** M–L. **Risk:** security-sensitive; needs an independent review.
- **Measure:** an end-to-end test with two users behind a proxy, where only the reviewer can accept; a gate host reached across hosts in CI.

**4. One ledger-driven notifier with a Slack channel**
- **What:** make Slack and Teams channels of `startNotifier`; send the standup and "needs you".
- **Why:** Slack is only called for run reports (`index.ts:1932`), while PM_CONTRACT §5 promises standups and needs-you alerts.
- **Effort:** S–M. **Risk:** low.
- **Measure:** a `pm/notify` event per kind; tests for 4xx and timeouts.

**5. MCP on the official SDK, plus workspace trust**
- **What:** Streamable HTTP and OAuth in the client; tools offered to the Planner and PM; a trust lock (the skills mechanism) for repo-supplied hooks, `mcp.json` and plugins.
- **Why:** the client serves only the Researcher and speaks only stdio (`mcp_client.ts:73`, `research/cli.ts:66`); repo code runs without a prompt (`user_hooks.ts:56`, `container.ts:196-222`). This is the cheapest route to Jira, Linear and GitHub for teams, and the prerequisite for sharing a repository safely.
- **Effort:** M. **Risk:** medium (sending data to vendors must stay opt-in and on the ledger).
- **Measure:** connect to a local Streamable-HTTP test server in a test; a planner card uses an MCP tool; an unapproved `hooks.toml` does not run.
