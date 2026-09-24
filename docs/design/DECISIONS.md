# Decisions

*Every settled decision in one place: what was decided, why, and what would reopen it. A decision is re-proposed only with the new evidence its "Reopen if" names — not with a new argument. Grouped by kind and numbered in the order they were taken; numbers are never reused, and DEC-12 to DEC-19 do not exist (the engineering group starts at DEC-20). The specifications cite these by number.*

## Product decisions

### DEC-01
**A coding harness for professional teams.** *Owner, 2026-09-22. Supersedes the 2026-09-17 target user, "a solo developer already running local models".*
Sekhemet runs the whole professional process — brief, planned backlog on a familiar board, cards built against executable gates, a person's acceptance — for three audiences: developers, beginners and non-developers ([SPINE](SPINE.md#what-sekhemet-is)).
- **Why:** agent output that skips the practice is hard to bring into a team; the practice itself is the product.
- **Reopen if:** the owner changes the positioning.

### DEC-02
**The spine.** *Owner; restated 2026-09-22.* Gates decide completion and the model never certifies its own work; the event log is the only durable channel; a card is the unit of work; the human is the rate limiter.
- **Why:** each is what makes the output trustworthy and the measurement honest. Phase A found places where the code does not yet keep them (COVERAGE S4–S7); the fix is the code, not the rule.
- **Reopen if:** only the owner.

### DEC-03
**Local inference in v1; cloud models per role after v1.** *Owner, 2026-09-22. Rewords the 2026-09-17 "100% local; no cloud models", which read as permanent.*
- **Why:** privacy and cost are part of the edge; a later cloud option must be something a person plugs into one role, never a dependency.
- **Reopen if:** v1 meets its Definition of Done (then cloud per role is planned, not reopened).

### DEC-04
**The Worker stays Cyber-Tiel-Coder-35B-A3B MTP (IQ3_XXS).** *Owner, 2026-09-22 (D1).*
- **Context:** it is an uncensored re-quantization of an abliterated Ornith-1.5, whose own model card says it is "not an ordinary coding agent" and requires OS-level sandboxing. The project's earlier research preferred the guardrailed Tiel-Coder; the published comparison between the two rests on 25 tasks and cannot separate them ([research, group D](../research/WEB_RESEARCH_2026-09.md)).
- **Consequence:** the sandbox, the permission engine and fail-closed confinement are the Worker's only guardrails. COVERAGE S3, S3a, S3b and S3c are v1-blocking, and security tests run against this model's behaviour, not a polite one's.
- **Reopen if:** a destructive action escapes the sandbox in any run; or a paired run of at least 30 tasks shows another local model of the same size ahead by 20 points or more.

### DEC-05
**One persona, for people; no ceremonies between agents.** *Owner, 2026-09-22 (D3). Rewords the rule "no simulated Scrum personas (no fake standups or product owners)".*
- Agents never role-play a team: the Worker, Planner, Reviewer and Researcher are registry roles with no names, voices or conversations with each other.
- Standups, retrospectives and status are **reports for people**, written from the event log by one persona, *Seshat, the project manager*, whom people talk to.
- **Why:** role-played multi-agent teams fail on coordination and cost (see the rejected list below); a named, plain-spoken PM is what non-developers asked for.
- **Reopen if:** the owner changes it.

### DEC-06
**A company-server mode is in v1, at a minimum.** *Owner, 2026-09-22 (D7). Removes "teams and multi-user boards" from the v1 non-goals.*
v1 includes: binding to a non-loopback address safely; an identity for each person, taken from an identity-aware proxy or a local account; one permission beyond reading — who may Accept; and every event attributed to its person. Not in v1: roles beyond that, SSO integrations beyond the proxy, multi-tenant boards.
- **Why:** the positioning names "your company's server"; without identity, every writer is "human" and anyone who can reach the port can accept.
- **Reopen if:** the owner narrows v1.
- Superseded in part by [DEC-35](#dec-35--one-product-two-setups-solo-and-team) (roles, SSO).

### DEC-07
**A ceiling run with a frontier model only after local v1 is done.** *Owner, 2026-09-22 (D6).*
- **Why:** it separates harness defects from model limits, but only means something once the local product is complete; it costs API money.
- **Reopen if:** v1 meets its Definition of Done.

### DEC-08
**Libraries approved to add, when their workstream arrives.** *Owner, 2026-09-22 (D5).* SPDX parsing (`spdx-expression-parse`, `spdx-satisfies`, `spdx-correct`), and the official clients `@octokit/*`, `@modelcontextprotocol/sdk`, `jira.js`, `@linear/sdk` and Slack Bolt. Every other proposal in COVERAGE still needs the owner's yes, one by one. **Added 2026-09-24 (DEC-29):** Playwright and axe-core (development only), fast-check, Valibot, vLLM (a separate process). **Added 2026-09-25 (DEC-38):** SimpleWebAuthn and `openid-client`, and a bundled common-password list with a permissive licence.
- **Why:** they replace hand-rolled code the reviews found wrong (the licence check rejects MIT-0 and "MIT AND …"; three GitHub paths with three ID formats).
- **Reopen if:** a licence or maintenance check at the time of adding fails.

### DEC-09
**Dead code is cut; three modules are wired in or cut by their workstream.** *Owner, 2026-09-22 (D4).* Cut: `packages/ui/src/canvas.ts`, `container.ts` (kernel and sandbox), `buildFullPromptPack` and the context `engine.ts`, the three `FEATURE_INVENTORY` files. Decided by their workstream, recorded in its spec: `retention.ts`, `apps/harness/src/research/desk.ts`, `adjudicate` and `acceptRevision` in `claims.ts`.
- **Why:** code reachable only from tests is dead; it misleads the next reader and the reachability gate.
- **Correction (2026-09-22, platform spec pass):** `container.ts` is not dead — `execute.ts:378-386` builds a `ServiceContainer` and `PluginManager` on every card. The recommendation is still to cut it (plugins add only services and hooks, and run repository code unsandboxed), but cutting reachable code is a new decision: **the owner decides** ([extensibility](specs/extensibility.md) §8). **Decided 2026-09-24 (DEC-29 O4): cut, with the SDK package, in B0.**
- **Done in B0 (2026-09-25):**
  - cut: `canvas.ts`, the kernel `container.ts` (the sandbox copy no longer existed), the SDK package, `buildFullPromptPack`, the context `engine.ts`, `research/desk.ts`, and the loops and archive R31 names;
  - kept: `adjudicate`/`acceptRevision`, wired by NEW-design-stage-2;
  - already gone: the `FEATURE_INVENTORY` files;
  - `apps/harness/tests/cuts_b0.spec.ts` keeps all of these cut.

### DEC-10
**`main` tracks the work.** *Owner, 2026-09-22 (D2).* `main` was fast-forwarded to the working branch at `fb59ba2`, and is fast-forwarded again when each workstream lands with its gate green.
- **Why:** a fresh clone of a stale `main` got the wrong CLAUDE.md and a design 240 commits old.

### DEC-11
**A project's "done" is computed from evidence, like a card's.** *Owner, 2026-09-22.* LLMs are poor judges of when a project is finished and of how much to build; Sekhemet does not ask them. The brief becomes a graph of accepted requirements; a release slice is proven when every must-have requirement has passing tests and the project gates pass on `main`, and done when a person accepts it. Depth comes from a profile, a quality checklist, comparable products and a walkthrough — the model proposes, a person accepts ([research](../research/PROJECT_DONE_AND_DEPTH.md); COVERAGE P13, P14).
- **Why:** agents declare done early (a thinking model did so in 49% of NL2Repo tasks), miss about two thirds of unstated requirements, and add work nobody asked for; the spine's rule for cards is the proven fix, applied one level up.
- **Reopen if:** the implicit-requirement recall or premature-completion measure shows the mechanism no better than the conversation alone.

### DEC-29 — the owner's answers to the decision queue
*Owner, 2026-09-24. The owner's words for the first three items of the list the lead presented (the spine's erasure clause, change kinds in v1, retention of personal text — queue numbers O1, O10 and O14): "1-3 you decide whatever is best". The lead took the recommended option for each; they are marked "lead, delegated" below. Every other row is the owner's own answer.*

| # | Decision | Outcome |
| --- | --- | --- |
| O1 | Spine rule 2 and erasure | **Amended** (lead, delegated): anything a model saw can be reconstructed from the log **except content erased by a recorded `ledger/erased` event, which replay names as a gap**. Erasure (NEW-kernel-7) and retention as recorded erasure proceed in B3 |
| O10 | Change kinds `characterize`, `refactor`, `upgrade` | **In v1** (lead, delegated) |
| O14 | Retention of personal free text on a team server | **90 days** after a card closes, then erased (lead, delegated) |
| O2 | Model weights | **A Configuration page** ([dashboard](specs/dashboard.md), [models](specs/models.md)): a person points the harness at the folders where their models live; it scans them and lists every model it finds as an option to load; it recommends which model to assign to each role, with the reason; a person may download a recommended model from it, explicitly, with the published hash verified; and it runs the benchmark there, to compare the models they have — the harness never downloads on its own |
| O2a | What "benchmark" on the Configuration page means (owner clarification) | **A quick benchmark of model combinations**: each role's candidate models are scored once on a small screening set (the Worker on 6 fast cards graded by the share of each card's tests passing), a combination's score is assembled from its roles plus a short end-to-end check, scores are cached so changing one role re-runs only that role, only models that fit the machine are offered, the time is estimated before it runs (a Worker about 17 minutes with loading, other roles about 5 each, a full combination with nothing cached under about 45 minutes), and candidates are compared paired on the same items — shown as indistinguishable when the paired test cannot separate them. The quick tier resolves speed, fit and large differences; the overnight tier settles close calls. **And an overnight tier** (owner, 2026-09-24): a thorough, paired, repeated comparison of the combinations a person picks (by default the top ones the quick tier could not separate) — the full frozen suite, the planning measure and each role's full evaluation set — run unattended in the machine's overnight window, stopping cleanly at its end and resuming the next night, never while a card runs or the machine is reserved, with a morning report on the Configuration page and in Seshat's standup. A winning combination is applied only by a person's choice ([measurement](specs/measurement.md) NEW-measurement-5) |
| O3 | Seshat's model name | **Moved to the Configuration page**, with every role's model; not in the chat panel |
| O11 | Self-accept | **Solo developers can accept their own cards.** On a project where two or more people hold the Accept permission, the person who built a card, or delegated it to the Worker (the principal of the latest `card/delegated` to the Worker, read from the ledger, never the card's current owner), cannot accept it; a project with one Accept-holder is solo, whether on a laptop or a server |
| O13 | Accept friction | **Light**: one key per unmet or unclear Reviewer finding; each Implementation file shown once |
| O12 | Project documents | **The lead decides, to professional documentation standards** — see DEC-30 |
| O4 | The plugin container and the SDK package | **Cut both** (B0) |
| O5 | Playwright and axe-core | **Approved** as development dependencies (axe-core unmodified; MPL-2.0) |
| O6 | fast-check | **Approved** |
| O7 | Event-payload validation | **Valibot approved** |
| O8 | vLLM | **Approved** as the optional multi-user engine (a separate process); llama.cpp stays the default |
| O9 | Install formats | **Both approved**: an npm package and a container image |
| O16 (default) | Research versus offline | Until the owner answers O16: a separate `[network] research` setting, asked once on the first new project. With yes, research may reach `fetch_allow`'s hosts if that list is non-empty, otherwise any public host, always minus `fetch_deny`; `mode` keeps card commands offline; a project may set research off for itself |
| — | "Plan exists" before In Progress | **No** (the find phase and red tests cover it) |
| — | The Reviewer's default model | **Gemma-4-26B-A4B** (a family other than the Worker's); if it does not qualify on 24 GB, v1 ships the Reviewer unfilled and says so |
| — | The 131 items moved to Later ([DESIGN_TRACE](../reference/DESIGN_TRACE.md) §3) | **Confirmed** as Later |

### DEC-30 — project documents follow professional conventions
*Lead, 2026-09-24, under DEC-29 O12.* Sekhemet writes a project's documents where a professional team expects them, adapts to an existing layout rather than imposing one, and never overwrites a person's file:
- **Architecture decisions** as MADR 4.0 records in `docs/decisions/NNNN-title.md` (MADR's default location), or in the repository's existing ADR folder (`docs/adr/`, `doc/architecture/decisions/`) when one exists.
- **The product brief and its requirements** in `docs/product/` — `brief.md`, and `requirements.md` with each requirement's EARS criteria, Kano class, slice and status — generated from the ledger; edits people make come back as proposals, never silent changes (design-stage §2.3).
- **The changelog** in `CHANGELOG.md` at the root, in the Keep a Changelog format, written from accepted cards and released slices; **release notes** per slice for people, from the requirements proven.
- **Release notes** per slice in `docs/product/releases/<version>.md`.
- **The README** and `CONTRIBUTING.md` are the person's; Sekhemet proposes changes to them, never writes them.
- **Documentation it generates for users** is organised by the Diátaxis framework (tutorials, how-to guides, reference, explanation), so it reads like a professional team's.
- Every generated document is committed through Accept, so it is reviewed like code.

### DEC-31
**The interface speaks the language development teams already use.** *Owner, 2026-09-25.* Apart from the names *Sekhemet* and *Seshat*, every word a person reads in the dashboard, the CLI's output and generated documents is the term Jira, Linear, GitHub and Scrum/Kanban practice use; the product's internal names stay in the code and the specifications, and [NAMING](NAMING.md) holds the map. Supersedes DEC-26's display labels (*Contract*, *Storage*, *Flow*, *Rules*), which were invented.

| Internal (code, specs) | On screen |
| --- | --- |
| card | issue (key `CHR-7`); *card* only for the tile on a board |
| `change` feature / fix / refactor, upgrade, characterize / `kind` spike | Story / Bug / Task / Spike (the standard issue types); *Epic* for an epic |
| gates, gate passed/failed | checks: "All checks passed", "2 checks failed" (GitHub's word) |
| evidence bundle | the issue's *Checks* and *Activity* tabs |
| Worker | *Agent* (as an assignee); *Coding model* (as a model role) |
| Planner, Reviewer, Researcher (roles) | *Planning model*, *Review model*, *Research model*; *AI review* for the Reviewer's findings |
| slice, walking skeleton, must-have proven | release, requirements done ("Release 1 · 5 of 11 requirements done"); *walking skeleton* only in Tips |
| Kano class must-be / performance / attractive; must-have, nice-to-have (`~`) | Must have / Should have / Could have (MoSCoW); *Later* for what is out of the release |
| depth profile prototype / internal tool / production / regulated | the project's *Type*: Prototype, Internal tool, Production, Regulated |
| cycle | sprint |
| step N of budget | "step 14 of 40" in the agent's progress |
| qualified (model) | verified on this machine |
| indistinguishable (benchmark) | no clear difference |
| Learn layer | Tips |
| This browser | Preferences |
| On hold, Won't do | On hold, Won't do (unchanged: Jira's words) |
| points (estimate) | **hidden unless the team turns on estimation** (Preferences → Estimation: off / story points), as in Jira; the machine's own estimates stay internal |

What professional boards do not show is left off the card face: the agent's step counter (it is on the issue, not the tile), internal kind labels, and model names.

- **Why:** the owner's condition that professionals recognise the product at once; invented words make a professional tool read as a toy.
- **Reopen if:** only the owner.

### DEC-32
**The model library: scan, match, suggest, predict.** *Owner, 2026-09-25; extends DEC-29 O2.* On the Configuration page a person gives Sekhemet one or more folders of models:
- **Scan**, optionally **including nested folders**, reading only model file headers (GGUF metadata: architecture, parameters, quantisation, context length, `general.name`/`general.basename`) and file sizes — never loading, running or modifying a file.
- **Protections:** only paths under the chosen folder are read, symbolic links that point outside it are not followed, a depth limit (default 6) and a file-count limit (default 5,000) stop runaway scans, only known model extensions are opened, headers are parsed with size limits so a malformed file cannot exhaust memory, no path or file name ever leaves the machine, and each scan is recorded with its folders and counts.
- **Match with Hugging Face** for the specs a header lacks (model card, total and active parameters, licence, recommended settings), sending only the model's name or published hash — and only when the person has allowed research ([surface](specs/surface.md) `[network] research`); offline, the header's metadata is used and the page says so.
- **Suggest** an assignment for each role: the Planning model (Seshat) reads the specs, the machine's memory and bandwidth, and any benchmark results, and proposes one model per role with its reason; the harness then checks every suggestion deterministically (fits in memory, verified on this machine, the Review model from a different family) and a person applies it. The model proposes; the person decides.
- **Predict speed:** decode tokens per second estimated from the machine's memory bandwidth and the bytes read per token (active parameters × bits per weight), corrected by measured runs on this machine when there are any, shown as "predicted" or "measured", never mixed.
- **Why:** the owner's request; a folder of models is how people keep them, and choosing well needs specs, speed and a recommendation.
- **Reopen if:** only the owner.

### DEC-33
**The owner accepts the recommended defaults for O15–O27.** *Owner, 2026-09-25.* Each open owner decision takes the recommendation in [OPEN_QUESTIONS](../reference/OPEN_QUESTIONS.md#owner-decisions): no in-run probation before approval (O15); research asked once on the first new project (O16); the stand-in check from the *internal tool* profile up (O17); no TypeScript 6 pin yet (O18); `web-tree-sitter` with Python (O19); the M0 pivot rule stands (O20); `llama-bench` approved (O21); the public review datasets approved for evaluation only, credited (O22); `sekhemet ask` replaces `board` in the front door (O23); profile statements used at once, visible and editable (O24); a harmful approved rule retired automatically with a notice and a one-click restore (O25); no import of public benchmark annotations in v1 (O26); axe-core not in the product's gate (O27).

### DEC-34
**Working with the agent on an issue is a v1 feature.** *Owner, 2026-09-25.* A person and the agent collaborate on the same issue, the way a team does on a ticket:
- **Guide it while it works:** a message on the issue reaches the agent at its next step boundary (never mid-step), is recorded in the event log, and appears in the issue's Activity; it can add a hint, narrow the approach, or answer a question. Scope and acceptance criteria change only through an edit the person makes to the issue, which re-plans it if they change.
- **It asks, you answer:** when the agent needs a decision it posts a question with options on the issue (and in Review › Needs you); it continues on the stated default where one is safe, and waits where the default is to stop.
- **Pause, take over, hand back:** a person can pause the agent, take the issue over in their own editor (the agent's work so far stays on the branch), and hand it back with a note; checks run on the person's work the same way.
- **Line comments in review:** sending an issue back can carry comments on specific diff lines, which become the agent's next instructions.
- Reverses the 2026-09-24 product pass's deferral of "steering a running card" to Later ([DESIGN_TRACE](../reference/DESIGN_TRACE.md)).
- **Why:** the owner calls collaboration with the agent a key feature; it is what a professional team does with a colleague on a ticket, and it keeps the person in charge without taking the work off the machine.
- **Reopen if:** only the owner.

### DEC-35 — one product, two setups: Solo and Team
**People work together on projects in v1, the way a team does in Jira.** *Owner direction, 2026-09-25 (quoted). The four access levels, the sign-in design and the rules below are the lead's design under that direction, presented to the owner with the mockups for review, and confirmed by the owner on 2026-09-25 ([DEC-38](#dec-38--the-owner-approves-the-teams-recommendations)). Supersedes DEC-06's "not in v1: roles beyond that, SSO integrations beyond the proxy"; the rest of DEC-06 stands.* The owner asked for a product that "a solo developer who doesn't know much about coding" and "teams with enterprise hardware" can both use, with the account in the corner, a login screen, and several people working on the same projects and issues.
- **Solo** is one person on their own machine. The server binds loopback, there is no sign-in screen and no roles UI, and the operating-system user is the one principal and holds every permission. The account menu still shows who you are.
- **Team** is one install on the team's own server, which can have data-centre GPUs and run stronger open-weight models chosen on Configuration (inference stays local, [DEC-03](#dec-03)). It adds accounts, a workspace holding the projects, access levels, invites, an inbox, @mentions of people, watchers, presence, an audit view, project updates and a fair model queue ([teams](specs/teams.md)).
- A project moves from Solo to Team without migration: the same event log, the same principals.
- **Access levels (workspace-wide, with a per-project override):** *Admin* (members, models, configuration, the queue); *Member* (create, edit and move issues, start and guide the Agent, review, approve plans); *Stakeholder* (file issues, comment, talk to Seshat, answer questions addressed to them; cannot start the Agent, change scope or priority, or accept); *Viewer* (read, comment and ask Seshat questions). Job titles (Product owner, Developer, Reviewer, Researcher, Designer…) are profile labels that set a person's home page and notification defaults, never permissions.
- **Accept stays a per-project rule, not a level:** who may accept, required reviewers from CODEOWNERS, and the independence rule of DEC-29 O11.
- **Sign-in:** none in Solo. In Team: a one-time setup token, written to a 0600 file whose path the server console prints, creates the first Admin; people join by single-use, expiring invite links that carry their level; local accounts use passwords under NIST SP 800-63B-4 rules; sign-in attempts are rate-limited per account and per address; the trusted identity proxy of DEC-06 stays. Passkeys and company SSO (OIDC) are in v1 ([DEC-38](#dec-38--the-owner-approves-the-teams-recommendations)). SCIM provisioning is Later.
- **Why:** the owner's direction (2026-09-25). Research: [DESIGN_RESEARCH_COLLABORATION.md](../research/DESIGN_RESEARCH_COLLABORATION.md) §1, §4, §5 — Jira, Linear, GitHub and Azure DevOps converge on these four tiers; approval is a rule on the work, not a role.
- **Reopen if:** only the owner.

### DEC-36 — the AI is a teammate that proposes; people decide
**Seshat and the Agent work with people without directing them.** *Owner direction, 2026-09-25 (quoted): "collaborating with the PM but not making it feel like an AI is bossing you around". The rules below are the lead's design under that direction, presented to the owner with the mockups for review, and confirmed by the owner on 2026-09-25 ([DEC-38](#dec-38--the-owner-approves-the-teams-recommendations)).*
- Every issue has a human owner; the Agent is only ever its delegate (integrations item 6).
- Seshat and the Agent are labelled AI identities with an "AI" badge. They are not members, hold no access level and take no seat. People reach them the way they reach a colleague: delegate an issue to the Agent, or @mention `@Agent` or `@Seshat` in a comment.
- The harness acknowledges them within seconds, without waiting for a model, and shows one state on the card, the issue and the inbox: *queued*, *working*, *needs you*, *paused*, *done* or *failed*. Stop takes effect at the next step boundary, and nothing resumes until a person re-engages it (DEC-34).
- The Agent acts with the permissions of the person who started it, never more, and every action records that person.
- **Seshat facilitates; it does not manage.** It never assigns work to a person, never edits another person's issue, and never sets a project's health. Triage (assignee, labels, duplicates, priority, a split) comes as a **suggestion with its reason**, accepted or dismissed in one action and not raised again once dismissed. Only an Admin can turn on auto-apply, per project and per property, and only for labels, the duplicate link, priority and a split — never for the assignee or health; each auto-applied change records as its principal the Admin who turned the rule on and shows "applied by <Admin>'s rule" ([teams](specs/teams.md) item 20).
- **Planner rules that change cards directly** — the split before scheduling, holding auxiliary cards on scope drift, the rung-3 and goal re-plans — follow the same rule in the Team setup: when the issue has a human owner other than the person who asked, the change is posted to that owner as a suggestion. In Solo, and for issues still in Planning that no one owns, they are unchanged ([planner-pm](specs/planner-pm.md) §2.18.6).
- A person below Member cannot start the Agent: their `@Agent` becomes a request to the issue's owner. Seshat answers a Viewer's questions with no proposals, and answers each person only from what that person can see ([teams](specs/teams.md) item 19a).
- Reminders ("update due", "3 issues waiting for review") come from the product in neutral text, not in Seshat's voice, and go to the owner of the item.
- The language rules (lead with the answer, say why, name who decides, give alternatives when unsure, no filler or false cheer, never "I've assigned" or "I approved") are in [planner-pm](specs/planner-pm.md) §2.18.
- **Why:** research §2–3 (Linear's agent guidelines, GitLab Pajamas, Microsoft HAX, Google PAIR): authority from evidence and the person's own settings, proposals with reasons, one-click dismissal.
- **Reopen if:** only the owner.

### DEC-37 — Status serves the stakeholder and the team from the same data
**Status is a real project page, not a summary line.** *Owner direction, 2026-09-25 (quoted): the status page "seems shallow" and must serve someone who isn't a software engineer and someone collaborating on the project. The page below is the lead's design under that direction, presented to the owner with the mockups for review, and confirmed by the owner on 2026-09-25 ([DEC-38](#dec-38--the-owner-approves-the-teams-recommendations)).*
- **Health** (*On track*, *At risk*, *Off track*) is set by the project lead, with their name and date. It is never set by a model. Seshat drafts the weekly **project update** (status, done, next, risks, asks), and a person edits and posts it. In the Team setup the page shows *Update missing* when 7 days pass without one; in Solo health and the update are optional and nothing is shown as missing.
- **Forecasts are always a range:** 50% and 85% dates by Monte Carlo over issue throughput (planner-pm §2.6 item 3), with "not enough history yet" below the minimum. Never a single date.
- Status shows:
  - a plain-sentence headline;
  - key numbers: the forecast range, requirements done, issues done, the sprint, and what needs attention;
  - the release burn-up, with a scope line, the forecast range and the target;
  - *Needs you* and *Waiting on others*, each with its owner;
  - requirements by MoSCoW group and state;
  - risks, each with a suggestion and its reason;
  - what was done this week and who accepted it;
  - who is working on what, people and the Agent, current item only;
  - the load on the models;
  - a one-line flow summary that links to Insights.
- **Never shown:** per-person velocity, leaderboards, Agent-versus-person rankings, DORA numbers as targets.
- **Why:** research §6 (Linear project updates, Atlassian's weekly update, the Kanban Guide, DORA's warning against targets).
- **Reopen if:** only the owner.

### DEC-38 — the owner approves the teams recommendations
**The owner accepts every recommendation from the teams review.** *Owner, 2026-09-25: "I approve all your recommendations for the decisions."*
- **O28:** passkeys (WebAuthn) are in v1 for the Team setup's local accounts, with SimpleWebAuthn (MIT).
- **O29:** company SSO over OIDC is in v1, with `openid-client` (MIT): PKCE, a claim-to-level mapping and strict mode.
- **O30:** the password check uses a bundled, offline list of common and breached passwords with a permissive licence, never an online lookup. The list is picked in B4.10 under DEC-08's licence and maintenance check.
- **Confirmed as designed:**
  - the four access levels and the per-project Accept rule (DEC-35);
  - Seshat's rules (DEC-36);
  - the Status design, including *Write update* (DEC-37);
  - the account menu at the bottom of the sidebar.
- **Why:** the owner's answer to the decision list presented with the mockups.
- **Reopen if:** only the owner.

## Engineering decisions

### DEC-25 — the lead's rulings during the design v3 fix pass
*Lead, 2026-09-22. Each settled a conflict between two new documents or between a document and the code; the code's behaviour won unless a reason is given. Rulings marked **owner** change behaviour a person sees and wait for the owner's confirmation ([OPEN_QUESTIONS](../reference/OPEN_QUESTIONS.md#owner-decisions)); until then the ruling is the default.*

| # | Ruling | Owning spec |
| --- | --- | --- |
| R1 | A checkpoint commit after every step that changed files (`execute.ts:422`), and before Verify; the runner's library default of 5 applies to other callers | review-git |
| R2 | The Worker's `ask` answers from the card's contract; if nothing matches and the PM is available, Seshat answers now. A non-blocking decision request is a gap | worker-loop |
| R3 | MLX is an engine label only; an adapter is Later | models |
| R4 | The Worker's research tools are named as the code names them (`git_history`, `dependencies`, `ask`, `recall`) | worker-loop |
| R5 | `plan_research` is owned by design-stage | design-stage |
| R6 | A tracker edit never pauses a running card; at its end, a changed scope or criteria sends it to Planning with the change named | integrations |
| R7 **owner** | Weights are never downloaded on the harness's own initiative; a person may run an explicit download command, and the published hash is verified before use | models, security |
| R8 | Unsolicited messages: 3 a day per person by default, never more than 5 | planner-pm |
| R9 | SPIDR's *Interface* is the user interface; a type contract is a Contract card (see DEC-26) | planner-pm |
| R10 | Roles have no avatars; the assignee is a text chip | dashboard, NAMING |
| R11 | A blocked card shows the fail tone, an icon and the word "Blocked" | dashboard |
| R12 **owner** | Execution-verified lessons may apply in production on probation; never in a measurement run. It reverses the owner's 2026-09-18 rule that nothing learned applies before a person approves it, so it waits for O15; until then approval comes first | measurement, context |
| R13 | A run's settings are one recorded `RunProfile`; a named settings file is allowed, a flag that rewrites other flags is not | surface, measurement |
| R14 | Per-language gate templates in gates.md; a language's mutation tool runs when installed, as a subprocess | gates |
| R15 | *Superseded by DEC-29 O3:* every role's model name, Seshat's included, is on the Configuration page, not in the chat panel | dashboard |
| R16 | Visual-gate libraries stay proposals; the gate's required behaviours are carried regardless | gates |
| R17 | Every view keeps a way in: `g k` Playbook, `g u` Runs, `g n` Integrations, or the palette | dashboard |
| R18 | The Settings view is kept | dashboard |
| R19 | Static file serving refuses `..` and serves correct MIME types | runtime |
| R20 | The integration review's findings (dossier, residency scheduler, role budgets, rule curation, tools described once, retries, one attempt record) are requirements | kernel, worker-loop, context, models |
| R21 | Every named third-party component has a licence row; copyleft runs as a separate process | PROVENANCE |
| R22 | One run hierarchy, defined in NAMING (superseded in detail by DEC-26) | NAMING |
| R23 | A `built` claim the code does not support is corrected, and so is built code listed as Later | all |
| R24 | Deliberate reversals are recorded (DEC-24) | all |
| R25 | The fixtures' recorded bars are kept in measurement | measurement |
| R26 | Sampling values and launch profiles are kept in models or its registry file | models |
| R27 | One memory-watchdog table, owned by models | models |
| R28 | Test infrastructure lives in DEFINITION_OF_DONE §2D | DoD |
| R29 | The `relay-finisher` agent role is dropped with the Gemini relay protocol it served (retired 2026-09-22, AGENTS.md §2); the `suspended-quota` GateStatus stays, for a commit made when a usage limit stops work | AGENTS, CLAUDE |
| R30 | `schedule.ts` is wired, not cut: declared hours are a non-developer's guarantee and the overnight window's source; only its unreached exports are removed, as dead code (DEC-09) | models |
| R31 | In `loops.ts`, `harvestExemplars` and `siftSlice` map to the exemplar inlet and the re-run rule, `distillSkill` to the skill inlet; the other unreached loops and the variant archive (`archive.ts`) are cut as dead code (DEC-09). Register entry R5 stays `shortlisted` as a technique; rebuilding it would start from the register | measurement |
| R32 | `tool_search` stays for roles other than the Worker when their tool count exceeds about 10 (MCP tools for the Planner), with loaded tools appended to the conversation, never edited into the tools array | worker-loop |

### DEC-26 — one vocabulary for the kind of card and the run
*Lead, 2026-09-24, resolving review blockers B3 and B4.*
- **`kind`** (stored, closed, `packages/kernel/src/card_class.ts`) is the truth: `spike`, `interface`, `implement`, `data`, `rule`, `review`, `research`. It selects the Worker's tools, the red-first rule and rule scoping. People see labels from one map in [NAMING](NAMING.md): `interface` → *Contract*, `data` → *Storage*, `implement` → *Flow*, `rule` → *Rules*, `spike` → *Spike*, `research` → *Research*, `review` → *Review*. *UI* and *Wiring* are display refinements of `implement` (the card's scope is UI files; the card only connects finished parts), never stored kinds. The dashboard's separate `CardKind` type in `vocabulary.ts` is folded into this map (NEW-dashboard-2).
- **SPIDR is how a story was split, not what kind of card resulted.** The planner records the axis it split on as `split` (`spike`, `path`, `interface`, `data`, `rules`), where SPIDR's *Interface* means the user interface (Cohn). A type contract is always `kind: interface`, labelled *Contract*.
- **`change`** (stored, closed): what a card does to existing code — `feature`, `fix`, `characterize`, `refactor`, `upgrade`. A new project's cards are `feature`. It is a separate field from `kind` (gates §8 Q3, decided).
- **The run:** an **attempt** is one recorded run of a card to a stop; it holds one **sample**, or up to k under pass@k; a sample is a sequence of **steps**; a step is one model request and the tool calls it makes. "Turn" is the code's synonym for step and is not used in specifications. The step budget counts steps **per sample**; an attempt under pass@k spends at most k times it (decided 2026-09-24).

### DEC-27 — context budgets are fixed in tokens at the reference window
*Lead, 2026-09-24, resolving review blocker B5.* At the reference Worker's prompt budget W = 9,984 tokens (16,384 − 4,096 answer − 2,048 thinking − 256), a fraction 0.12W (1,198 tokens) cannot hold a system prompt and tool interface capped at 3,000. The stable zone is therefore budgeted in tokens: **Zone 1 ≤ 2,400 tokens including native tool schemas**, of which the system prompt ≤ 700 and the tool interface ≤ 1,700 (a fixed, flat tool set per card class, M2); the remaining zones share W − Zone 1 in the proportions [context](specs/context.md) rule 10 gives. On a larger window the token caps stay and the proportional zones grow. The allocator asserts these on the live path for the reference Worker's real prompts.
- **Zone 4 fits by construction** (confirmation review N4). At W = 9,984 with every other zone full, Zone 4 has 3,034 tokens for the step history. It holds: at step 40 of a 40-step card, the five most recent observations, each clamped to 300 tokens (1,500); the latest five tool calls in full (~300); the 34 older steps as one-line summaries with a `recall` pointer (~25 tokens each, ~850); thinking only for the latest step, capped at 300 tokens, older thinking stripped at masking points (DEC-24); and the volatile tail — step counter, unmet criteria, one next action (~60) — about 3,010 tokens right after a masking point. Between masking points, more steps and their reasoning accumulate; the true bound is the one the allocator's projection enforces by forcing an out-of-schedule masking point (context CX-N2-5), which the criteria test on every recorded prompt. When the projected Zone 4 would exceed its budget, the allocator places an out-of-schedule masking point before the prompt is sent, never after. **Honest limit:** with Zones 1–3 at their caps, the worst-case step of a 40-step card fills about 99.7% of W; it fits, but the pressure tiers mask early on such cards, so their late steps may lose the prompt cache. The confirmation review found this; it is measured (context CX-N2-3…5), not assumed away.
- **One number for card size** (N5): INVEST's "Small" means the card's pack fits Zone 3 at the resolved Worker — 3,792 tokens on the reference Worker — checked once, at the `ready` entry condition. There is no second, separate limit.

### DEC-28 — one rule for admitting what the system learns
*Lead, 2026-09-24, resolving review blocker B6. Owned by [measurement](specs/measurement.md) §2; every other document points there.*

| What is learned | Admitted by | Kept or retired by |
| --- | --- | --- |
| A **project playbook rule** (this repository's paths, kinds, error codes) | A person's approval | Paired credit on this project's own attempt records, with rotation. Tested only at fixed looks — after 20, 40 and 80 pairs — and retired automatically when a one-sided exact test on the discordant pairs shows harm at 0.05/3 at a look; never retired below 20 pairs. A person may retire a rule at any time |
| An **execution-verified lesson** during a run | **Pending the owner (O15).** Default until decided: nothing learned is applied before a person approves it (the owner's rule of 2026-09-18). If the owner allows probation: production only, never in a measurement run | At the run's end, a candidate for a person's approval with its evidence |
| A **harness change** (prompt, tool, budget policy, harness skill, context version) | A paired frozen-suite A/B that shows a gain at the suite's resolution (at least 20 points on 30 cards, exact test at 0.05) | **Inconclusive** (the usual case): adopted only if it is **simpler** — deterministically: it removes prompt tokens from the stable zone, a tool, a switch or code, and adds none — or **cheaper** on the one cost measure named before the run (median tokens per card), shown by a one-sided paired Wilcoxon signed-rank test at 0.05; and the paired pass-rate result is not a loss the suite can resolve. Recorded as "not established"; the suite cannot see losses under about 20 points, so an adopted change is watched and rolled back on the first paired loss a later run resolves |

No admission rule relies on an effect the measurement cannot resolve. The context version covers the **harness** only — prompt templates, the copy module, the tool catalog and descriptions, budget policies; a project's approved rules and skills are project data, listed on each pack but outside the context version, so approving or retiring one never invalidates a model's qualification (confirmation review N1).


### DEC-20
**Language support is TypeScript first.** *2026-09-20.* The ranked repo map and the parse gate are TypeScript. Python, Rust and Go degrade to a flat file map and an unchecked parse, stated on the card and in the evidence. Their functional gates (`pytest`, `cargo test`, `go test`) stay, because running the tests is most of a gate's value. Symbol-level support through tree-sitter is later work (a proposal in COVERAGE).
The harness itself stays TypeScript: a Rust or Python component is allowed only where profiling proves a bottleneck — the repo-map builder is the likeliest first candidate, a line pruner the second.
- **Reopen if:** a non-TypeScript project becomes a v1 target.

### DEC-24 — deliberate reversals in design v3
*2026-09-22, each forced by a measurement, research or a review finding; the detail is in the owning spec's §9.*

| Was (design of 2026-09-17) | Now | Why |
| --- | --- | --- |
| Observation masking keeps the last two observations | The five most recent stay full; masking happens in batches | SWE-agent's ablations; masking at every step breaks the prompt cache (research group A) |
| Earlier reasoning is stripped between steps | Earlier thinking is preserved (or stripped only at a masking point) | An edited prefix forces a full re-read on hybrid-attention models (research group A) |
| llama.cpp cache flags 8–16 GiB, 32 checkpoints, min-step 8192, `-sps` | Sized per host (2–8 GiB, 6–16 checkpoints), min-step 512–1,024, `-sps` dropped | Checkpoint placement moved to message boundaries upstream; 16k-window hosts keep only two checkpoints at the old spacing |
| A spec with more than three questions is refused as under-specified | Never refused: propose defaults and proceed | Proportional design stage (owner, 2026-09-22) |
| A card parks and frees memory while its question is open | Work proceeds on the stated default; a `default_deny` question (one whose default is "do not proceed") parks the card **from the request** until it is answered or its deadline passes | The Worker is not idled by a question it can proceed past, and never proceeds past one whose default is to stop |
| Self-improvement rolls back when the pass rate drops over the next ten cards | Rollback on a paired comparison | A ten-card window cannot separate noise from effect (research group D) |
| Six stop reasons | Twenty-three stored in v1 (the 18 in code plus `gate_suspected`, `tests_not_red_for_reason`, `hook_veto`, `git_metadata_tampered`, `crashed`), in one table in [worker-loop](specs/worker-loop.md), shown as seven failure classes (adding "environment") and one success class | Machine failures must never read as the Worker's fault |
| INVEST pre-flight before In Progress | Before Ready | The Worker must never pick up a card that fails it |
| Send back returns a card to In Progress | Send back returns it to Ready | A returned card is re-queued, not resumed mid-attempt |
| INVEST "Small": context pack ≤ 25% of a 32,768-token working context | The pack fits Zone 3 at the resolved Worker — 3,792 tokens on the reference Worker (DEC-27) | The old default sized cards for a window the Worker does not have (review M11) |
| Unpark returns a card to its previous state | Unpark returns it to Ready, or to Backlog or Planning if it was parked from there | The state machine has no edge back into In Progress, Verify or Review, and a parked attempt is not resumed mid-flight |

### DEC-21 — accepted substitutions
*Accepted 2026-09-20; the design's claims were amended to match what is built.*

| Substitution | Instead of | Why | Reopen if |
| --- | --- | --- | --- |
| bubblewrap on Linux | Landlock + seccomp | Works on every kernel we target; the isolation level is recorded per card. Landlock and seccomp become hardening | A bubblewrap escape relevant to our threat model |
| Plain git worktrees | Copy-on-write clones | No correctness difference; portability beats setup speed | Worktree setup dominates card time |
| A keyword heuristic for context pruning | SWE-Pruner, a learned line pruner | Deterministic, free, no resident model; the learned pruner's value here is unmeasured, and published work found a learned scorer no better than random at equal budget | The pruner beats structure-preserving random line dropping on the frozen suite |
| A source installer | Packaged offline installers | Air-gap setup is rare; packaging per platform is recurring work | Air-gapped teams become a target |

### DEC-22 — rejected techniques
*Settled on evidence. Each is reopened only by a measurement on this harness that the "why" did not anticipate.*

| Rejected | Why |
| --- | --- |
| Agents playing Scrum roles to each other | Role-based multi-agent teams fail on coordination; the leading framework in the style folded its roles back together (DEC-05 keeps one persona for people) |
| Parallel agents writing the same files | Conflicting implicit decisions; one writer per file |
| The agent certifying its own work | The spine |
| Self-refine and reflection loops as a quality mechanism | Worse than equal-cost repeated sampling at these model scales |
| Multi-agent debate | Does not beat a single agent, at far higher cost |
| Unbounded best-of-N | Without a verifier it underperforms; with gates it is still capped |
| Hard schema constraints by default | Turns visible format errors into silent reasoning loss on small models; a measured per-model choice instead |
| Persona prompting for quality ("you are a senior engineer") | No evidence of effect on code correctness; seniority is enforced by structure |
| Embedding RAG as the primary code context | Structure-aware retrieval beats it on code |
| Large-context stuffing | Quality falls with length; distractors mislead |
| Continuous-embedding context compression | Fails on multi-step agentic coding |
| A wrapper around proprietary CLIs | The category's commercial graveyard |
| Fine-tuning our own models | Premature until the failure history is large and in-context methods plateau |
| A dense embedding index for documentation | A resident embedder costs memory the Worker needs; BM25 is strongest at this corpus size |
| Public agent trajectories as exemplars | They carry another harness's tool vocabulary into the prompt's stable zone |
| Routing fitted to public benchmark results | Scaffold dominates those results; no public data has our tool dimension |
| KV-cache eviction for throughput | A large-batch gain; this harness runs at batch one |
| A tabular foundation model for the competence model | A second resident model beside a mean that works |
| A seventh durable store | Three kinds exist: guidance, measurements, fetched bytes |

### DEC-23 — what the harness is not
Not a chat assistant (the conversation plans and reports; code is written on cards), not an IDE, not a CI system, and not a replacement for the team's tracker — it fits beside one. It does not aim to beat frontier models on ambiguous, long-horizon or novel design work, and it is slower per card than cloud tools. These trades are deliberate.

## Founder decisions on record

- **Name:** Sekhemet, a deliberate variant spelling, paired with its descriptor where the product introduces itself.
- **Licence:** MIT.
- **Still the owner's:** the business model; whether go-to-market ever targets defence.
