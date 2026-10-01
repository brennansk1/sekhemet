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
**Libraries approved to add, when their workstream arrives.** *Owner, 2026-09-22 (D5).* SPDX parsing (`spdx-expression-parse`, `spdx-satisfies`, `spdx-correct`), and the official clients `@octokit/*`, `@modelcontextprotocol/sdk`, `jira.js`, `@linear/sdk` and Slack Bolt. Every other proposal in COVERAGE still needs the owner's yes, one by one. **Added 2026-09-24 (DEC-29):** Playwright and axe-core (development only), fast-check, Valibot, vLLM (a separate process). **Added 2026-09-25 (DEC-38):** SimpleWebAuthn and `openid-client`, and a bundled common-password list with a permissive licence. **Added 2026-09-25 (DEC-39):** `@anthropic-ai/sandbox-runtime`, `ipaddr.js`, `request-filtering-agent`. **(DEC-40):** `@huggingface/gguf`; the RedCode-Exec payload subset. **(DEC-43):** gitleaks (MIT) as the optional history secret scanner; the common-password list is SecLists' `xato-net-10-million-passwords-100000.txt` (MIT).
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
| Worker | *Agent* (as a delegate, DEC-52); *Coding model* (as a model role) |
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
- Every issue has a human assignee (DEC-52; *owner* until 2026-10-01); the Agent is only ever its delegate (integrations item 6).
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

### DEC-39 — reuse an existing sandbox engine instead of extending our own
**The confinement engine becomes Anthropic's `sandbox-runtime` (srt), behind our `ProcessSandbox`.** *Owner, 2026-09-25: "if there is a repo or something that exists that is usable use it don't reinvent the wheel for the sandbox and isolation"; then approved installing `@anthropic-ai/sandbox-runtime` 0.0.77 (Apache-2.0), `ipaddr.js` 2.5.0 (MIT) and `request-filtering-agent` 3.2.1 (MIT).*
- **What srt replaces:** our Seatbelt, bubblewrap and seccomp profile code (`seatbelt.ts`, `bubblewrap.ts`, `seccomp.ts`).
- **What we keep:**
  - the `ProcessSandbox` chokepoint and its environment allowlist;
  - fail closed (S3b) and `isolation` recording;
  - the harness-side git hardening and preflight (S1);
  - the per-card egress proxy with its ledger records;
  - the policy merge and `NetworkPolicy`.
- `ipaddr.js` and `request-filtering-agent` make our proxy and the harness's own lookups refuse loopback, private, link-local and metadata addresses after resolution (SEC-9).
- **Strangler fig:**
  1. `SEKHEMET_SANDBOX_ENGINE=native|srt`, `native` by default.
  2. The containment tests run against both engines.
  3. The engine is recorded in `settings.isolation`.
  4. srt becomes the default once both platforms pass and a frozen-suite run shows no clear difference.
  5. Our engine code is then deleted, and `security.md` updated in the same commit.
- **System requirements:** ripgrep on both platforms, socat on Linux.
- **Why:** research in [SANDBOX_REUSE.md](../research/SANDBOX_REUSE.md). srt closes gaps ours has: mach-lookup and LaunchServices on macOS, Unix sockets and io_uring on Linux, and resolved-address checks. It is maintained, and it is the sandbox Claude Code uses.
- **Reopen if:** srt fails the containment suite on either platform, or an srt release breaks confinement (we fail closed, so every card would stop).

### DEC-40 — reuse first, at every step
**Every build step first looks for a maintained, permissively licensed library or dataset, and uses it instead of our own.** *Owner, 2026-09-25: "again for each step make sure if there is a usable repo or python library you use it."*
- **Approved the same day:**
  - `@huggingface/gguf` 0.4.6 (MIT). It reads a model's chat template offline for SEC-34a, and serves the model library's header scan (NEW-models-13).
  - A curated subset of RedCode-Exec (github.com/AI-secure/RedCode, MIT), vendored with its licence notice as the payloads of the injection fixtures (NEW-security-4).
- **Not yet approved:** starting Docker Desktop to test containment on Linux. The B1 milestone's Linux half waits for it.
- **How:** each new library is proposed with its licence, size and what it replaces, and installed only on the owner's yes. Approvals are listed in DEC-08.
- **Reopen if:** only the owner.

### DEC-41 — one prompt standard before any prompt work
**Every prompt, tool description and model-facing message is written and changed under [PROMPT_STANDARD.md](PROMPT_STANDARD.md).** *Owner, 2026-09-25: "Before any prompts are written you should have a prompts doc that details how to best write the prompts." The owner also said the research must not use leaked vendor prompts.*
- **The evidence:** [PROMPT_RESEARCH.md](../research/PROMPT_RESEARCH.md). It uses vendors' published guidance, the literature, and open-source agents under their licences. No leaked or extracted prompt was used, and no prompt text was copied.
- **The standard fixes:**
  - one tag style and one section order;
  - positive, justified rules, at most 12 per template (revised after review: an imperative rule is an item in a template's `<rules>` or `<tool_rules>` section; examples and data do not count);
  - no emphasis devices;
  - one copy module per role;
  - native tool calling with familiar names;
  - a byte-stable prefix;
  - a compression ranking;
  - a four-step change process: lint, golden render tests, a step-replay screen, then the suite A/B, which stays the only admission route (DEC-28).
- **Rejected for code:** token-dropping compressors (the LLMLingua family) and LLM-written summaries of history. Learned code pruners, which need a second resident model, wait for the owner.
- **Approved by the owner on 2026-09-25:**
  - the step-replay screen (new measurement code; it screens and never admits);
  - the two Worker A/B candidates for B2.5: a tool-call example of at most 150 tokens, and a sentence about persisting until the check passes (a third, the sentence that the acceptance test checks behaviour and the solution must be general, was made an A/B candidate after review and approved under DEC-42);
  - rejecting LLMLingua and Promptfoo.
- **Why:** small quantised models are the most sensitive to prompt form, so the rendering is part of what is measured.
- **Reopen if:** only the owner.

### DEC-42 — the owner delegates the outstanding decisions to the lead
**The lead decided every question then open, under the owner's delegation.** *Owner, 2026-09-25: "you have my permission to make all outstanding decisons".* The lead's rulings, each safe by default and reversible:
- **Docker (security SEC-1, DEC-39):** not installed on the owner's machine. Docker Desktop is a heavy install with licence terms of its own. Linux containment is proven on a CI Linux runner instead, the first time the repository runs CI (a push, which stays a per-action approval). Anthropic's `sandbox-runtime` stays behind `SEKHEMET_SANDBOX_ENGINE=srt` until that evidence exists.
- **Statistics (measurement M12):** keep the harness's own exact tests (`packages/eval/src/stats.ts`), checked against scipy by an independent review, rather than add `@stdlib`. It is one dependency fewer, and DEC-40's reuse test is met by the published reference values the tests pin.
- **pytest and go (gates GT-M6-2):** not installed on the owner's machine. Those parsers stay partial until a CI runner records their real output.
- **Golden briefs and held-out acceptance labels (measurement T11):** the lead drafts them. They stay drafts, unregistered, until a person confirms each, because a label from a model alone is refused (MS-T11).
- **Stops the Worker did not cause (worker-loop rule 31):** `error`, `rebase_conflict` and `integration_failed` no longer count in the competence model (`measuresModel: false`), as rule 31 says. The earlier table kept the old behaviour.
- **The third Worker A/B candidate (DEC-41):** approved as a candidate: one positive sentence that the acceptance test checks behaviour, so the solution must be general. It is admitted only by the suite A/B.
- **`--auto-accept` (measurement rule 9):** confirmed. It runs only in a repository carrying the measurement marker, so outside measurement a person always accepts.
- **The E5 rule-approval block (measurement §8 item 5):** its removal is confirmed. DEC-28 is the later ruling.
- **Model loads:** permitted, on the lead's judgement of the host: only with swap under 4 GB and at least 60% of memory free, checked before each load, and unloaded after each run.
- **Addendum, 2026-09-25 (the owner asked that the model card's settings be checked):**
  - The Worker's sampling already matched the Hugging Face card's agentic-coding values (temperature 0.6, top_p 0.95, top_k 20, min_p 0).
  - Qualification had measured at temperature 0, settings the Worker never uses. It now qualifies at the role's own sampling, with 5 samples per case (q1.2), and sampling is part of the combination key.
  - MTP launches with the card's measured draft settings, `--spec-draft-n-max 1 --spec-draft-p-min 0.0`: the author's own sweep supersedes the two-token figure.
  - The card's 262,144-token context is not used: the host sets 16,384 (DEC-27).
  - Its default of thinking on with an unlimited budget is left to B2.5's thinking arms to measure.
- **Reopen if:** only the owner.

### DEC-43 — take over a project
**Sekhemet takes on an unfinished, partly built project, beside starting a new one.** *Owner, 2026-09-25: approved the feature and delegated its details to the lead.* Written as [design-stage](specs/design-stage.md) §2.10 and NEW-design-stage-6, with [integrations](specs/integrations.md) NEW-integrations-4 for the inherited issues. Six steps, in this order:
  1. **Trust first.** Nothing from the repository runs before workspace trust. Its own agent configuration stays inert, untrusted text until a person approves it; that approval is stored as workspace trust is, in the user directory and never in the repository. The full history is scanned offline for secrets. Submodules are not cloned recursively.
  2. **Recon without a model:** manifests, lockfiles, scripts, CI, the ranked repo map, the git history, the docs and the connected tracker's issues.
  3. **Prove what works by running it:** install with scripts off, then build and test confined with no network, twice. "Could not build" is a finding, never a stall. Half-done work is detected.
  4. **A brief as found:** what the project claims, set against what runs, each claim labelled proven, claimed-unproven or contradicted, with citations.
  5. **One PM conversation:** one batch of up to five questions at the start (one or none for a small leftover), in proportion to the project. Each question is a decision request with the `safe_default` policy whose default cites a finding. When the person approves the take-over plan, every unanswered question takes its default, recorded on the ledger; no timer and no deadline decide anything. **This is the later ruling, and an exception for a take-over only** to [design-stage](specs/design-stage.md) §2.2.3's one question at a time, to [planner-pm](specs/planner-pm.md) PM-P2-3's two open questions per pass, and to the reversal recorded in planner-pm §9 (one decision request each, at most two per pass); every other planning pass keeps those rules.
  6. **A backlog with evidence, then approval:** stabilise, finish, defer. Inherited issues are reconciled as proposals. Characterize before change; no rewrite.
- **Approved the same day:**
  - **gitleaks** (MIT) as the optional offline scanner of the history's secrets. When it is not installed, a bundled offline rule set scans instead. TruffleHog's live verification is not used: it sends each candidate secret to its provider, which would break offline-by-default and send a secret off the machine.
  - **The bundled common-password list** of [DEC-38](#dec-38--the-owner-approves-the-teams-recommendations) O30: SecLists' `xato-net-10-million-passwords-100000.txt` (MIT), bundled with its licence notice.
- **Why:** half-finished repositories are the common case, and the professional first move on one is to find out what is true before planning. Repository-supplied agent configuration has run before a trust prompt in another coding agent (Check Point on CVE-2025-59536). Environment setup fails often enough in published benchmarks (EnvBench) that "could not build" must be a finding rather than a stall. Models tend to write code instead of asking (HumanEvalComm), so the questions are asked once, up front, each with a default. Evidence in [design-stage](specs/design-stage.md) §9.
- **Reopen if:** only the owner.

### DEC-44 — what to reuse for the rest of Phase B
**The lead adopts the reuse survey's picks, each added when its workstream arrives.** *Lead, 2026-09-25, under the owner's delegation of every decision (DEC-42, reaffirmed the same day). Survey: [REUSE_SURVEY_2026-09.md](../research/REUSE_SURVEY_2026-09.md), licences and last releases checked against the npm registry and GitHub on 2026-09-25 ([DEC-40](#dec-40--reuse-first-at-every-step)).*
- **Approved to add** (each under DEC-08's licence and maintenance check when added):
  - **gitleaks'** own rule file (MIT), vendored as the bundled offline rule set of DEC-43, so both scan paths report the same rule ids;
  - **osv-scanner** in offline mode (Apache-2.0, already wrapped) with downloaded per-ecosystem databases, for the vulnerability inventory of a take-over;
  - **ast-grep** (MIT), as a separate program, for half-done detection (stubs, `NotImplementedError`, `todo!()`, skipped and todo tests) across languages, before trust as it runs no repository code;
  - **deps.dev** (Google's free API), in research mode only and through the one network policy, for dependency age, licences and advisories;
  - the approved **spdx-*** packages with a vendored **ScanCode LicenseDB** category snapshot (CC-BY-4.0 data, attributed) as the one licence classifier;
  - **yaml** (ISC) for CI files; **fast-xml-parser** (MIT) as one JUnit XML path; **@manypkg/get-packages** (MIT) for workspaces; **semver** (ISC); **nodemailer** (MIT-0) for email in B4.11; **marked** (MIT) for parsing project documents;
  - **mutmut** (BSD-3), **cargo-mutants** (MIT) and **PIT** (Apache-2.0) as optional mutation tools run as separate programs.
- **Models for our own tests only, never dependencies:** knip and dependency-cruiser (both would execute repository configuration or add a second parser against T2's one index).
- **Built by us, because nothing usable exists:** an offline security rule set of about 30 curated rules for TypeScript, JavaScript and Python (Semgrep's registry forbids redistribution; the other sets are AGPL, Commons Clause or other languages), test-smell lint, stub-kill, the requirement graph, criterion lint, fault localisation for JS/TS, per-framework half-done checks, and the small presence, Inbox and gate-cache pieces.
- **Not usable:** TruffleHog (AGPL; live verification sends secrets away), libyear (LGPL-3.0), elkjs (EPL-2.0 or GPL), askalono (archived). The semgrep and opengrep engines (LGPL-2.1) stay acceptable only as unmodified separate programs, as today.
- **Why:** each pick saves a build the plan would otherwise do, under a licence the product can ship; the build list is what remains after the search.
- **Reopen if:** a pick's licence or maintenance changes before it is added, or a workstream finds it does not fit.

### DEC-45 — Smart Swap
**Switching between roles on one memory-bound machine is decided by measured round-trip cost, keeps people answered, uses memory to its safe limit, and helps a person choose models, engines, placement and combinations from measured facts.** *Owner, 2026-09-26: asked for smart switching so the whole team of roles gets the most work done, named it Smart Swap and delegated its details to the lead.* Written as [models](specs/models.md) rules 20c–20k and NEW-models-14 (MD-N14-7–42), with [runtime](specs/runtime.md) item 4 and RUN-34/35, [measurement](specs/measurement.md) rules 16a and 16d (MS-NM14-1–4) and [dashboard](specs/dashboard.md) §2.16 item 1a (DB-NM14-1–9).
- **The policy:**
  - **Cost:** C_pair, the round trip a visit costs in both directions (unloads, loads, first-token excess, each live session's min of restoring or re-prefilling, idle slot time × N). Decisions use each load's p90 and predicted waits the median; cold or warm is measured; work is predicted per engine, prefill included; θ, the swap overhead over a rolling hour, has θ_max = 0.2.
  - **One pure function, `decide()`,** shared by the scheduler and the simulator, with one precedence, highest first — the watchdog (every level), holds, C5, interactive requests (given the quick path and a predicted start when the full answer would break C5), C7 (non-interactive swaps, counted in round trips), C4, C3, C1 — and no preemption mid-step. C1 exhaustive service with a threshold (W ≥ C_pair ÷ θ_max, with hysteresis); C2 tours ordered by a horizon optimiser, eviction by next use; C3 rent-or-buy (dwell and idle hold = C_pair); C4 one aging mechanism (interactive 2 min; Planner 30, Reviewer 45, Researcher 60 min; Worker steps `max_wait_s`), with feasibility; C5 the Worker's guarantee of (1 − θ_max) of each hour; C6 presence-aware reviews; C7 a swap-storm cap; C8 parallel slots with a drain barrier; C9 overlap; C10 prefetch from free memory only.
  - **Seshat while the Worker runs:** deterministic answers first, then a quick model only when headroom allows (labelled, and never able to change cards, plans, proposals or decisions), then the full answer queued with its predicted wait.
  - **Memory:** headroom is the lower of a GPU and a system measure; a load is admitted only when its footprint fits the headroom and the projected used ratio is at or below 0.80 on both measures, with swap not growing, and every transition of a tour is checked, not only its end state; the owner's own processes are named, never unloaded. "Roles never co-reside below 32 GB" becomes **no two large models**, by footprint: a second large model is always refused, and only small models (below a quarter of the GPU wired limit) go through admission. The host's GPU ceiling is pre-seeded from the recorded evidence (15.65 GB timed out; the Worker at 16K, about 14.5 GB, is good) and, until calibration, refuses a combined GPU footprint above the known-good maximum plus 0.5 GB.
  - **Load mechanics by measurement:** the load mode per volume by an A/B of at least three loads per mode; no `--mlock`; `--fit`, drive and Ollama requantisation guards.
  - **KV slots and prefix state** saved and restored as keyed caches, deleted on erasure.
  - **A closed-loop replay simulator,** and a new admission row: a scheduling parameter is adopted by a paired replay across k ≥ 5 recorded days on a pre-registered metric, with proof the cards' outputs are unchanged.
  - **Placement** (B4.1): copy to internal storage as a knapsack, keeping 20 GB free, only on a person's click, hash-verified, the original kept. Combinations are chosen by quality floors, then time per card including swaps, then footprint; **no weighted combined score**.
- **This is the later ruling** and wins over: [models](specs/models.md) rules 3 and 22 (co-residence), 4c (the tie-break), 19 (the watchdog's precedence), 20a (the fixed plan order), 20b (benchmark blocks bypass C1–C10), MD-N9-2, MD-N9-3, MD-N13-3 (efficiency per engine), MD-N14-3 and MD-N14-4 (as amended there); [runtime](specs/runtime.md) item 4, item 4a and RUN-34 (interactive replies first within a resident visit only; one aging mechanism); [review-git](specs/review-git.md) §2.3 item 2 and RG-P8-3 (each passing card's review is queued as the card passes, and the Reviewer loads when `decide()` brings it — at a review's cap (C4), in C2's tours, first while a person is present (C6), within the storm cap (C7) — while the Worker's cards keep it home until then (C1); the run's end drains the rest, not one review batch after the retries). Every evidence bundle and `RunProfile` records the policy's version and parameters. DEC-42's "unloaded after each run" stands for measurement runs; calibration nights run the policy as designed.
- **Reuse** ([DEC-40](#dec-40--reuse-first-at-every-step); each added under DEC-08's check when its workstream arrives):
  - **adopted:** llama.cpp's slot save and restore (MIT, in llama-server; llama-swap has no such feature); **llama-bench** (MIT, ships with llama.cpp) for the model page's benchmark;
  - **optional, separate or tuning only:** **gguf-parser-go** (MIT) for memory and speed from a local GGUF's metadata (`--path` only; amended at B4.1: its `--url` does its own HTTP and would bypass the `[network]` policy, so a remote GGUF is estimated by our own ranged reader over `@huggingface/gguf`); **highs** (npm, MIT; HiGHS in WebAssembly) for the horizon optimiser when enumeration grows; **Optuna** (MIT, Python) for multi-objective tuning against the simulator, with a TypeScript random or grid search as the fallback;
  - **not adopted:** SimPy (the simulator runs the real `decide()` under a virtual clock instead); llama-swap and llama.cpp's router mode (least recently used with a TTL, blind to the plan; we borrow a per-model eviction cost and one process per model); OR-Tools and PyJobShop (a Python sidecar is more than the problem needs);
  - **MLX is a candidate engine per model,** compared on the model page and used for a role only after a bake-off ([models](specs/models.md) rule 30a); the Worker has no MLX build.
- **The owner's measured findings,** which override the web research where they differ:
  - 2026-09-13, `Qwen 3.8 27B testing`: decode ≈ efficiency × 120 GB/s ÷ weights GB, MLX about 0.85 and llama.cpp about 0.6 on this M4 (MLX about 30% faster at the same size); a mixture of experts with about 3B active decodes at 29–30 tok/s against 6–8 for dense 27B; prefill is about 80% of a 47 s turn, and caching the static prefix cut time to first token from 27.66 s to 0.88 s; the GPU wired limit (20,480 MB) binds first — Metal timed out while macOS showed 88% free; an 11.8 GB target beside a 3.85 GB draft model gave a Metal timeout; Ollama silently requantises an IQ3_XXS file.
  - 2026-09-26: the Worker's weights were copied to internal storage with the owner's approval — the hash matches and the USB original is kept; the USB drive reads them sequentially at **105 MB/s** (130 s for 13.6 GB) against an observed mmap load of about **300 s** from it, so a pre-read or `--no-mmap` should roughly halve USB loads (the load-mode A/B); the internal SSD reads about **3.4 GB/s**, so internal placement cuts disk time to seconds. The registry still points at the USB drive until a person repoints it.
- **Why:** on the 24 GB reference host one large model is resident at a time and a round trip from the USB drive cost about ten minutes, so when to swap, where the weights sit and what a person waits for decide how much work the team of roles gets done. Polling systems with switchover times give the threshold; the 2025–26 multi-agent serving work gives the horizon optimiser, prefetch, same-weights fusion and prefix reuse; the owner's measurements set the constants. Every threshold derives from measured cost, so a move to faster storage re-tunes the policy by itself, and every D value is tuned only by the replay admission.
- **Reopen if:** a paired replay across at least five recorded days shows a simpler policy (fixed order with least recently used, or llama-swap's) within the registered metric's resolution of `decide()`; the slot restore proves unsafe (a restored slot changes a card's output); or the calibration nights show the headroom measures admitting loads that then push swap up.

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
| R12 **owner** | Execution-verified lessons may apply in production on probation; never in a measurement run. It reverses the owner's 2026-09-18 rule that nothing learned applies before a person approves it, and O15 was decided against it (DEC-33): approval comes first | measurement, context |
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
| An **execution-verified lesson** during a run | **Decided (O15, DEC-33): no probation.** Nothing learned is applied before a person approves it (the owner's rule of 2026-09-18, kept) | At the run's end, a candidate for a person's approval with its evidence |
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
| bubblewrap on Linux | Landlock + seccomp | Works on every kernel we target; the isolation level is recorded per card. *R9 (2026-09-30):* Ubuntu 24.04 and later refuse its user namespaces unless an AppArmor profile allows them for bwrap (`kernel.apparmor_restrict_unprivileged_userns`); the sandbox detects this, fails closed and names the fix (security item 8b, SEC-17c), and the install guide carries the step. Landlock and seccomp become hardening | A bubblewrap escape relevant to our threat model |
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

### DEC-46 — the licence is Apache-2.0
*Superseded by [DEC-48](#dec-48--the-licence-is-fsl-11-alv2) on 2026-09-29.*
**Sekhemet is licensed under the Apache License 2.0, copyright 2026 Brennan Kelley.** *Owner, 2026-09-28, choosing among the options the lead set out (MIT, Apache-2.0, AGPL-3.0, FSL or BSL, proprietary).*
- `LICENSE` holds the canonical text from apache.org (sha256 `cfc7749b…`). `NOTICE` names the copyright holder and keeps every bundled third party's attribution: Crawl4AI and the Apodex prompts under Apache-2.0; gitleaks, SecLists and RedCode under MIT; the ScanCode LicenseDB categories under CC-BY-4.0. All of these are compatible with Apache-2.0.
- It replaces MIT, whose copyright line ("Sekhemet Contributors") disagreed with NOTICE's.
- **Why:** the licence professional developer tools are adopted under, with an explicit patent grant. Changing it is simple while the owner is the only copyright holder; outside contributions would need their authors' agreement, or a contributor agreement, before any relicensing.
- **Reopen if:** only the owner (for example, FSL for a hosted paid edition).

### DEC-47 — the finish-line decisions
*Lead, 2026-09-28, under the owner's delegation of every finish-line decision ("you can make all decisions for me"; beta users and CI deferred). They answer [FINISH_LINE_PLAN](../reference/FINISH_LINE_PLAN.md) §O. Downloads are still named, with source and size, when made.*
- **CI (O-1):** deferred by the owner. Until then, Linux is proven in a local Lima VM, and the release gate runs on this Mac and in that VM.
- **Linux (O-2):** Lima is approved and installed. If Linux containment is not green by week 4, v1 ships macOS-first, with Linux stated as a preview.
- **Test tools (O-4):** Stryker (Apache-2.0), fast-check (MIT), `@playwright/test` (Apache-2.0) and `@cyclonedx/cyclonedx-npm` (Apache-2.0) may be added when their workflow arrives. cosign waits for CI. A clone detector for users' code is Phase C.
- **Models for new users (O-5):**
  - v1 supports 24 GB and above; 16 GB is not supported in v1, and the claims table and docs say so.
  - The 24 GB tier recommends the qualified set: the Coding model nail-mtp (qualified on the current code), the Planning model Qwen3.8-27B GSQ-RCO, the Research model Apodex mini, and the Review role unfilled until a model is admitted (RG-P8-13).
  - Each model's source, hash and licence go in PROVENANCE (W11).
- **Publication identity (O-6):**
  - Copyright 2026 Brennan Kelley (DEC-46).
  - The npm name is `sekhemet` if free when W15 runs, otherwise a scoped name.
  - GitHub Container Registry and GitHub Issues on the public repository.
  - Every push or publication is still the owner's yes (DEC-42).
- **The comparison's budget (O-7):** the Claude arms run only after the week's build workflow, at most about one 5-hour window a week, with a Haiku 4.5 dry run first.
- **"0 skipped" (O-8):** read as "every test runs on at least one machine of the release matrix, with its tools installed": this Mac and the Lima VM until CI exists.
- **Betas and sessions (O-9):** deferred by the owner. Until outside betas, usability evidence comes from the owner's dogfooding sessions and agent-driven cognitive walkthroughs, and SUS is scored from the owner's sessions.
- **v1 scope (O-10):** the Team setup is in v1, because its milestones (B4.10, B4.11) are the plan's. A W4 row may be deferred only through its own recorded decision.
- **Root documents (O-11):** `CHANGELOG.md`, `SECURITY.md` and `CONTRIBUTING.md` are allowed at the repository root (W3 updates the docs rule and `docs.spec.ts`).
- **Legal posture (O-12):**
  - v1 is published free of charge under FSL-1.1-ALv2 (DEC-48; Apache-2.0 when this was decided) by an individual, with no commercial distribution. Before any paid or commercial offer, including an EU market (the Cyber Resilience Act), the owner takes legal advice.
  - LICENSE, NOTICE and the user guide state that code Sekhemet's models write for a user is the user's, that Sekhemet claims no rights to it, and that the protection of AI-written code varies by jurisdiction.
  - This is a conservative default, not legal advice.
- **What v1 does not check in the software it builds (O-13):**
  - internationalisation;
  - a complexity or code-smell gate;
  - API-level deprecation beyond the project's own lint;
  - load testing;
  - metrics and crash reporting;
  - the deployment and rollback of users' services;
  - similarity search for reproduced code;
  - a dead-control crawl of users' web apps.

  Each is stated in the claims table and the user guide, and each is proposed for Phase C in the Phase B report (W12).
- **Still the owner's, because they need a person's judgement:** confirming Seshat's 20 scripted conversations, the golden briefs, and the capstone's hidden suite.
- **Reopen if:** only the owner.

### DEC-48 — the licence is FSL-1.1-ALv2
**Sekhemet is licensed under the Functional Source License, version 1.1, with Apache-2.0 as the future licence (FSL-1.1-ALv2), copyright 2026 Brennan Kelley.** *Owner, 2026-09-29. It supersedes [DEC-46](#dec-46--the-licence-is-apache-20). The owner chose it among the options the lead set out: keep Apache-2.0, PolyForm Noncommercial, all rights reserved, or FSL.*
- Anyone may use, copy, change and redistribute Sekhemet for any purpose except a **Competing Use**: offering it, or something substantially similar, as a commercial product or service. Internal use, non-commercial education and research, and professional services for a licensee are expressly permitted.
- Each version becomes available under **Apache-2.0 two years after it is made available** (the licence's future grant).
- `LICENSE` holds the canonical template text from fsl.software with the year and licensor filled in. The `license` fields read `FSL-1.1-ALv2`.
- NOTICE's third-party attributions are unchanged. Bundled third-party material keeps its own licences (Apache-2.0, MIT, CC-BY-4.0).
- The repository is private and nothing had been distributed under Apache-2.0, so the change binds no one.
- **Why:** the owner keeps the commercial right to offer Sekhemet, for example a hosted Team edition, while the code stays usable and readable, and opens fully after two years.
- **Reopen if:** only the owner.

### DEC-49 — on Linux, a nested `.git` is refused before git runs, not at creation
**Under bubblewrap (native or srt), a command can create a `.git` below the worktree's root. The preflight refuses it before any Sekhemet git runs there (security item 21, `git_preflight.ts` `nested_git`), and the card fails. Seatbelt keeps refusing the creation itself on macOS.** *Lead, 2026-09-30, under DEC-47; found in R9 (the Lima VM, Ubuntu 24.04).*
- bubblewrap has no rule by name: it binds and masks paths that exist. Landlock cannot express name patterns either.
- The options considered:
  - a seccomp user-notification supervisor refusing `.git` in create, rename and link calls. It needs a native helper, and checks by path race with the calls they check.
  - a FUSE layer filtering the name. Heavy, and a new dependency.
- The file matters only when git reads it. Sekhemet's git always preflights first. Whatever runs inside the sandbox is confined, whatever that config says.
- **Changes:**
  - SEC-1 on Linux is "the card fails with `nested_git` before git runs", tested by running the preflight after the attempt.
  - `.GIT` and `.Git` are not `.git` to git on a case-sensitive file system.
- **Reopen if:** a harness path runs git in a worktree without the preflight, or a supervisor becomes cheap (srt adds one).

### DEC-50 — Linux gets the proxy route and a card's named ports through relays, in C2
**On Linux, a card's egress proxy and its named ports (`localPorts`, a dev server's port) are reached through socat relays across the sandbox's network namespace, as srt already does for its proxy. They are built in the C2 fix sprint.** *Lead, 2026-09-30, under DEC-47; found in R9.*
- **Today on Linux:** bubblewrap ignores `egressProxyPort` and `localPorts`, and srt reaches its proxy but not a card's own ports. It fails closed: a card with the network off has none, and a dev server started with a named port cannot be reached. Four Linux tests stay failing until then:
  - `containment.spec.ts`, the proxy and named-port probe, under both engines;
  - `confined.spec.ts`, "the network is off unless a port is named";
  - `egress.spec.ts`, curl under the native engine.
- **Relays are chosen over the alternatives:**
  - a network namespace per card kept by a holder process, which changes how every card process starts;
  - pasta or slirp4netns, a new dependency;
  - Landlock ABI 4 port rules, which need kernel 6.7 and a native helper, filter by port only, leave abstract sockets open, and are a hardening layer only under DEC-21.

  socat is already required for srt on Linux.
- **Reopen if:** srt's relays cover named ports upstream, making srt the Linux default under DEC-39.


### DEC-51 — C1's K3 list, decided
**The lead decides the twenty K3 items in `docs/reference/FINDINGS_C1.md` under the owner's delegation of 2026-10-01 ("you have my permission to make all my pending decisions").** *Lead, 2026-10-01.*
- **Severities confirmed as the audit rated them:** BRD-01, CLI-01, INS-01, REL-01 and TST-01 are severity 4; SEC-01, REV-01 and REV-02, ISS-01 to ISS-03, ERR-01 and ERR-03, PM-01 and PM-02, SHL-01 to SHL-04, STA-01 to STA-03, and BRD-02 and BRD-04 are as registered. All go to C2 unless the register routes them elsewhere.
- **REL-01:** automatic daily backups outside the repository, on by default, with a `[backup]` setting (DESIGN_GAPS b2).
- **Mockup deviations (item 17):** the approved `dashboard-v3` mockups win where they are more complete than the spec:
  - the Issue page's properties rail;
  - Members' Invites and Access parts;
  - the Start page with a live draft (b25);
  - the Status grid at wide widths (b24);
  - Configuration's cards;
  - the brand mark as drawn in `Logo.dc.html`.
- **Inbox:** two panes at 1100 px and wider, as Linear's inbox does; one list on a phone. The dashboard spec is amended.
- **Primary buttons:** dark ink, not gold. Gold stays the brand accent, and the warning amber gets its own hue, so "primary" and "needs attention" no longer look alike (domain17).
- **v1 scope (item 19), all v1 and built in C2:**
  - the sprint lifecycle (b6);
  - Stakeholder intake and triage (b4);
  - full-text search (b14; SQLite FTS5 in the built-in `node:sqlite`, no library);
  - Reopen and Revert in the dashboard.

  One project per server stays the v1 rule (DEC-53 c3).
- **Release items (item 20):** DEC-54.
- **Reopen if:** the owner.

### DEC-52 — the professional words, NAMING amended
**Where C1's rename table proposed amending NAMING, the industry's words win.** *Lead, 2026-10-01, under the owner's delegation.* NAMING.md and DEC-31's table are amended in the same change; the code keeps its internal names, and CLI aliases keep old commands working.
- **The responsible person is the *Assignee*,** as Jira, Linear and GitHub name the field. An AI teammate working an issue is its *Delegate*, Linear's word for the same split; this replaces DEC-31's use of "assignee" for the agent.
- **Send back → *Request changes*** (GitHub's review verdict); `send-back` stays as a CLI alias.
- **Ledger, event log and audit trail, on screen → *Activity log*.** Code and docs about internals keep `ledger`.
- **Park and Unpark → *Put on hold* and *Take off hold*.** The stored state stays `parked`; the column is already *On hold*.
- **Suspect → *Needs re-checking*; "Passing, strength unmet" → *Tests too weak*; Done when → *Acceptance criteria*; May edit → *Files in scope*.**
- **Error text uses the board's column names** (In review, To do, Done), not stored state ids.
- Every rename row that needed no amendment (card → issue, cycle → sprint, harness → Sekhemet, no spec ids or API paths in product text, Appetite → Size limit) is C2's single pass.
- **Reopen if:** the owner.

### DEC-53 — DESIGN_GAPS (c), decided
**The fifteen "needs the owner's yes" items in `docs/reference/DESIGN_GAPS_C1.md` are decided by the lead under the owner's delegation of 2026-10-01.** *Lead, 2026-10-01.* The smallest proposal in each row is what is built; its spec change is drafted alongside the (b) changes.
- **Yes, in v1:**
  - **c4** a browser notification when work waits in Review (permission asked once);
  - **c5** an opt-in update check that asks first, plus SECURITY.md's supported versions and a *What's new* note from the bundled CHANGELOG;
  - **c6** *Push to remote after Accept and on release*, an opt-in project setting, recorded;
  - **c7** *Get the inference engine*: a pinned llama.cpp release for the platform, hash-verified, downloaded on a person's click as model weights are;
  - **c8** maintenance releases (an open *Next release* collecting accepted issues outside any slice);
  - **c10** `sekhemet daemon start --at-login`;
  - **c11** `--json` on `run`, `status`, `doctor` and `accept`;
  - **c14** the six parity items stay Later. This DEC records them as out of scope: shared saved views, shell completion, a recurring dependency check, a GitLab merge request on Accept, a timeline, and *Open in editor*.
- **Yes, as release items:** c1 and c2, in DEC-54.
- **v1.x, with the limitation stated now:**
  - **c3** many projects per server (v1: one project per server, as teams.md now says; New project says how to start another server);
  - **c9** test services for gates. The claims table says a gate needing a database or another service is *unavailable* in v1; this waits on DEC-50's relays;
  - **c12** nested AGENTS.md and *Rules used*. It is model-facing, so it ships only after its A/B under PROMPT_STANDARD;
  - **c13** signed commits. INSTALL says branches that require signing are not supported in v1.
- **No:** **c15**, an automatic Accept fallback when a member leaves. It would let a person the Accept rule never named accept work, which weakens spine rule 4. Accept stays refused, and the lead and Admins are told, until a person edits the rule (b12).
- **Reopen if:** the owner.

### DEC-54 — publication and contribution
**The public release follows the professional route: a release-only workflow for provenance, a pre-publication pass, and no outside code until a contributor agreement exists.** *Lead, 2026-10-01, under the owner's delegation.*
- **c1, provenance:** one GitHub Actions workflow, triggered only by a version tag. It builds, packs, runs `npm publish --provenance`, writes the CycloneDX SBOM and SHA256SUMS, and pushes the image. It is not CI: `pnpm gate` still runs locally and in Lima before the tag (DEC-47 keeps CI deferred).
- **c2, the pre-publication pass (W15):**
  - gitleaks over the whole history;
  - untrack `.claude/launch.json`;
  - move this machine's operations out of CLAUDE.md into a local file;
  - parameterise the `/Volumes/My Passport` paths.
- **What stays public:** DEV_LOG and the internal reviews stay public, as evidence that the product was built in the open; the pre-publication pass removes machine paths. The author email is not rewritten (the owner, 2026-10-01).
- **Contributions:**
  - Issues and Discussions are open from the public pre-release 0.9.0. No outside beta users are recruited; DEC-47's deferral stands.
  - Code contributions open only with a contributor licence agreement that lets the licensor keep FSL's commercial rights. The owner takes legal advice on its text before the first outside pull request.
  - CONTRIBUTING, CODE_OF_CONDUCT (Contributor Covenant), SUPPORT, and the issue and PR templates ship with 0.9.0, after the pre-publication pass (both in C5).
- **Launch:** follows the zero-spend report's gates (docs, not code). No public launch before the capstone results and a clean install; Show HN at 1.0.0; the words *source-available* and *Fair Source*, never *open source*. The tagline is "Checks decide. People accept." The pronunciation is *SEK-eh-met*.
- **Reopen if:** the owner, or legal advice.

### DEC-55 — working alongside other tools (the ecosystem report)
**The ecosystem report's questions, decided by the lead under the owner's delegation of 2026-10-01.** *Lead, 2026-10-01.*
- **In v1, fixed in C2** (verified defects):
  - Review flags a change to other agents' configuration as code that runs later: `.claude/`, `.cursor/`, `.mcp.json`, `.codex/`, `.windsurf/`, `.continue/`, `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `mise.toml`;
  - Ollama `:cloud` and `-cloud` model tags are refused (DEC-03);
  - the Jira CSV export uses `Issue Id` and `Parent`, and maps issue types to Story, Bug, Task and Spike;
  - the MCP gate-run tool says it is a pre-check, not evidence;
  - Check Run annotations go in batches of 50;
  - documented editor snippets for VS Code, Cursor and Zed.
- **External agents building a card (the gatekeeper play), v1.x:**
  - Allowed only against a local model endpoint, reached through a logging proxy Sekhemet starts for the attempt. Every request and response is recorded on the ledger as the Worker's are, so spine rule 2 holds as written, with no new exception (the narrow check of D1 rejected a recorded-gap reading). An agent that cannot use the proxy is not supported.
  - Aider and Goose come first, then Claude Code and Codex pointed at the local endpoint.
  - An external agent on a cloud model waits for the post-v1 per-role cloud option (DEC-03).
- **v1.x order:**
  1. Slack replies to Seshat (Bolt, approved);
  2. `sekhemet gates --ci`, with JUnit and SARIF output;
  3. pull-only Linear, then Jira, sync (approved SDKs);
  4. the Linear agent app, on a Team server with `public_url` only;
  5. platform checks for prototypes taken over (Supabase RLS, Firebase rules), through the single take-over path;
  6. Sentry as a proposed Bug card.
- **Read-only MCP servers for Seshat** need the tool-description pin (hash, re-approval on change) before use, as skills do.
- **Listings:** the ACP and MCP registries and the editor docs, after 1.0.
- **Never:** a silent cloud fallback; cloud agents as builders; tunnels by default; AI review services as blocking gates; a tracker moving a card (the report's §6).
- **Reopen if:** the owner.

### DEC-56 — the release order after C1
**The path to 1.0 is design first, then the C-sprints rewritten in `FINISH_LINE_PLAN.md`.** *Lead, 2026-10-01.* C1's registers (245 findings, 54 gaps), DEC-51 to DEC-55, the zero-spend report and the ecosystem report are one revision, not three lists. The design update (D1) applies DESIGN_GAPS' 25 drafted changes and the (c) decisions to the specs before any C2 code, so C2 builds against specs that already say what to build.
- **Reopen if:** the owner.


## Founder decisions on record

- **Name:** Sekhemet, a deliberate variant spelling, paired with its descriptor where the product introduces itself.
- **Licence:** FSL-1.1-ALv2, copyright 2026 Brennan Kelley ([DEC-48](#dec-48--the-licence-is-fsl-11-alv2); MIT until 2026-09-28, then Apache-2.0 under DEC-46 until 2026-09-29).
- **Still the owner's:** the business model; whether go-to-market ever targets defence.
