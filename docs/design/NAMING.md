# Naming

Status: rule from the user, 2026-09-18; state names reconciled with the code and the board, 2026-09-22; card kind, change, split and the run hierarchy settled by [DEC-26](DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run), 2026-09-24; *Configuration* named, 2026-09-24 ([DEC-29](DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O2, O3); the words for working together added, 2026-09-25 ([DEC-35](DECISIONS.md#dec-35--one-product-two-setups-solo-and-team)–[DEC-37](DECISIONS.md#dec-37--status-serves-the-stakeholder-and-the-team-from-the-same-data)) · the keep list reconciled with [DEC-31](DECISIONS.md#dec-31)'s on-screen words, 2026-09-27 (B4.7 G0) · Applies to the product, the dashboard, the CLI, docs and model prompts.
Related: [SPINE.md](SPINE.md) (voice), [specs/dashboard.md](specs/dashboard.md) and [specs/planner-pm.md](specs/planner-pm.md) (where these names appear), [DECISIONS.md](DECISIONS.md#dec-05) (one persona).

## The rule

**Professional language first ([DEC-31](DECISIONS.md#dec-31)).** Apart from *Sekhemet* and *Seshat*, what a person reads uses the words development teams use in Jira, Linear, GitHub and Scrum/Kanban practice; DEC-31's table maps the internal names to them, and it wins over any display label below.

1. **Functional nouns keep their professional names.** If the industry already has a word for a thing (board, review, cycle, epic), or the thing already has a name in Sekhemet, that word stays. A developer from Linear, Jira or GitHub should never have to translate.
2. **Third-party products keep their own names, exactly as their makers write them.** GitHub, GitHub Actions, Jira, Linear, Slack, Microsoft Teams, Sentry, Datadog, PagerDuty, Notion, Confluence, Ollama.
3. **A Sekhemet-themed name is allowed only for something that would take a proper name anyway**: a product, a persona or a theme. It must read as an ordinary name, not a costume. It must never replace the word for what the thing does.
4. **A themed name is always paired with its function the first time it appears on a surface.** Write *Seshat · Project manager*, or *Seshat, the project manager*. After that, *Seshat* alone is fine on that surface.

If you are unsure whether something "takes a name", it doesn't. Use the plain word.

## Keep list (functional names that stay as they are)

| Area | Names |
|---|---|
| Product and roles | Sekhemet · You · Project. The roles are named on screen as DEC-31 says: **Agent** (the Worker as an assignee) and **Coding model** (its model role) · **Planning model** (the Planner) · **Review model** (the Reviewer; its findings are **AI review**) · **Research model** (the Researcher). *Worker*, *Planner*, *Reviewer* and *Researcher* stay the internal names, in code and specifications |
| People on a card | Owner (the responsible person) · Delegate (who builds it: the *Agent* or a person) · Accepter · *Assignee* only as the alias for Owner in the query language and in exports to trackers whose field has that name |
| Views | Projects · Inbox · My issues · Status · Project manager · Review · Board · List · Story map · Insights · Runs · Dependencies · Playbook · Integrations · Machine · Ledger · Configuration · Sign in · Members · Audit. *Inbox* is a view again (DEC-35: what reached a person, across projects, by reason); Review › *Needs you* stays the project's decision queue. *Workspace* as a view is retired: its rollup became **Projects**, and its route opens it. *Registry* and *Settings* are retired as views: both are sections of Configuration, and their routes open them |
| Work | **Issue** (key `CHR-7`; *card* only for its tile on a board) · Subtask · Epic · **Sprint** (the internal *cycle*; `sprint:` in the query, `cycle:` its alias) · Label · Priority (Urgent, High, Medium, Low, No priority) · Points (shown only when Preferences → Estimation is *Story points*) · Due date · Backlog. Issue types: **Story · Task · Bug · Spike · Epic** |
| Card states, stored (CLI, errors, ledger, pipeline view) | Backlog · Ready · Planning · In progress · Verify · Review · Done · Parked · Rejected — one name per state, in sentence case, the same in the column heading of pipeline view, the stored value's label, an error message and the design (`vocabulary.ts` `COLUMN_LABELS`, whose `In Progress` becomes *In progress* under [dashboard](specs/dashboard.md) NEW-dashboard-2) |
| Board columns (the default board, and the Jira export) | Backlog · To do (Ready, Planning) · In progress (In progress, Verify) · In review (Review) · Done · On hold (Parked, shown only when non-empty) · Won't do (Rejected, a filter, not a column) |
| Card kind, change and split | On screen, a card shows one **issue type** (Story, Task, Bug, Spike, Epic), derived from the three fields below by `issueTypeOf` (DEC-31). The kind labels *Contract · Storage · Flow · Rules* are **retired from every screen**; the stored values stay internal, in mono where a developer greps for them |
| The Worker's run | **Attempt ⊃ sample ⊃ step** — defined once in [The run](#the-run) below |
| Quality | **Checks** (the internal *gates*: "All checks passed", "2 checks failed") · Evidence (on screen, the issue's *Checks* and *Activity* tabs) · Parse · Types · Tests · Lint · Size · Acceptance tests · Done when · May edit · Findings (*AI review*'s) |
| Delivery | Requirement · **Must have · Should have · Could have** (MoSCoW; *Later* for what is out of the release; the internal Kano class and *must-have*, *nice-to-have* never on screen) · **Release** (the internal *slice*: *Release 1 · 5 of 11 requirements done*; *walking skeleton* only inside Tips) · Appetite · the project's **Type** (the internal depth profile: Prototype, Internal tool, Production, Regulated); requirement states **Done** (proven on main) · Passing, strength unmet · Planned · Unplanned · Suspect · Cut |
| Actions | Accept · Send back · Park · Unpark · Reject · Reopen · Revert accept · Acknowledge · Approve · Apply · Discard · Apply all · Import · Export · Sync · Pull · Push |
| Flow | WIP limit · Cycle time (Kanban's measure; not a sprint) · Throughput · Cumulative flow · Aging work in progress · Work item age · Swimlane · Saved view |
| Machine | Memory · Model · Health checks · Worktrees · Sandbox |
| Setups and people ([teams](specs/teams.md)) | **Solo** (one person on their own machine; no sign-in) · **Team** (one install on the team's own server, with accounts) · **Workspace** (what a Team install holds: its projects and members; one per install) · access levels **Admin** · **Member** · **Stakeholder** · **Viewer** (permissions; a level, never a "role", which names a model role here) · **Accept rule** (who may accept on a project; not a level) · **profile labels** Product owner · Project manager · Developer · Reviewer · Researcher · Designer, or one an Admin adds (they set a home page and notification defaults and grant nothing) · Invite link · Setup token · Personal access token · Sign in · Sign out · Account menu · Profile · Notifications |
| Working together | **AI teammate** (Seshat or the Agent, shown with an *AI* badge; never a member) · states *queued* · *working* · *needs you* · *paused* · *done* · *failed* · **Inbox** with reasons *Needs you* · *Mentioned* · *Review requested* · *Watching* · *Agent finished*, and actions *Done* · *Snooze* · *Save* · **Watch** / **Watching** (every change on an issue, in the Inbox) · **mention** (`@name`: one notification) · **Suggested: … Why: …** with *Apply* · *Dismiss* · *applied by <Admin>'s rule* (auto-apply, never for assignee or health) · review verdicts *Accept* · *Send back* · *Comment* (a review with no verdict) · **review threads** with *Reply* · *Resolve conversation* · *Unresolve conversation* (GitHub's) · *Accept dismissed: new commits since it was accepted* · **Send for approval** (a stakeholder's plan to a Member or Admin; *Create project* in Solo) · presence (who is viewing: *Also viewing: …*; who is moving a card) · *Running Tests…* (the check running now) · Audit |
| Project status ([DEC-37](DECISIONS.md#dec-37--status-serves-the-stakeholder-and-the-team-from-the-same-data)) | **Health**: *On track* · *At risk* · *Off track* (set by a person, with their name and date) · **Project update** (weekly: status, done, next, risks, asks) · *Write update* · *Update missing* · Forecast (a range: 50% and 85%) · Target · Waiting on others |
| Configuration | **Configuration** is the page where a person sets Sekhemet up, in plain words: which models it uses for each role and where they are kept, the benchmark that compares them, how many minutes a day the person reviews, and the settings in force. Its sections: Models · Benchmark · Review capacity · **Preferences** (never "This browser"; the theme and the project's **Estimation**: Off or Story points) · Project configuration. Its words: Model folder · Scan · Recommended · Assign · Load · Unload · Download · Benchmark (the quick and the overnight benchmarks of model combinations) · Quick · Overnight · **No clear difference** (two candidates the paired comparison cannot separate; *indistinguishable*, internally) · **Verified on this machine** (a model that passed its check here; *qualified*, internally) · Morning report · Reserve now · Baseline. Not *Settings*, *Admin* or *Registry* for the page (*Preferences* names one of its sections, DEC-31): *Configuration* is the word the product already uses for `config.toml` ([surface](specs/surface.md)) |

*Working*, *Checking* and *Closed* are **retired**: they were a third vocabulary for the same states (neither the stored names nor the board's), and a person who read `verify` in an error could not find a column called *Checking*.

*Admin* is an access level, never the name of a page: Configuration stays *Configuration* even for an Admin.

*Library* (in the naming list of 2026-09-17: *Workspace, Project, Card, Subtask, Gates, Evidence, Playbook, Worker, Planner, Library*) is **retired**: no v3 surface, view or command names anything *Library*, and the old design used it only in that list, never saying what it named, so keeping it would reserve a word for nothing.

## Card kind, change and split

One card has three separate stored fields ([DEC-26](DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)). **Since [DEC-31](DECISIONS.md#dec-31) the kind labels below (Contract, Storage, Flow, UI, Wiring, Rules, Research, Review) are internal names, never shown**: a person sees one issue type — a spike or research card is a *Spike*, a `fix` a *Bug*, a `refactor`, `upgrade` or `characterize` change, a review card or a `task`-tier card a *Task*, an epic an *Epic*, and the rest a *Story* (`issueTypeOf`, `vocabulary.ts`); the change labels (Feature, Fix, …) and the split labels stay for the issue's Plan tab and Tips. This table is the only label map for them: the dashboard, Seshat, the CLI and the exports read their words from it (through `vocabulary.ts`), and no second map exists ([dashboard](specs/dashboard.md) NEW-dashboard-2). The stored value appears only in mono, where a developer might grep for it.

| Field | Stored value | Label people see | What it means |
|---|---|---|---|
| `kind` — what the card is; selects the Worker's tools, the red-first rule and rule scoping ([worker-loop](specs/worker-loop.md), [gates](specs/gates.md), [context](specs/context.md)); closed, `packages/kernel/src/card_class.ts` | `interface` | **Contract** | A type, signature or interface contract, before its implementation (a database schema is Storage). An enabler, not a SPIDR story; never the SPIDR *Interface* slice |
| | `data` | **Storage** | A migration, fixture, schema change or seed |
| | `implement` | **Flow** | The behaviour behind a contract, end to end |
| | `implement`, scope is UI files | **UI** (display refinement) | A Flow card whose scope is the user interface. Not a stored kind |
| | `implement`, only connects finished parts | **Wiring** (display refinement) | A Flow card that joins parts already built. An enabler. Not a stored kind |
| | `rule` | **Rules** | A validation, policy, invariant or edge case |
| | `spike` | **Spike** | A question answered by throwaway code: notes and a probe test |
| | `research` | **Research** | A question answered with sources; no diff |
| | `review` | **Review** | Reading work, not producing it; no diff. Not the *Review* state or view: the card view says *Review card* where the two could be confused |
| `change` — what the card does to existing code; selects its red/green rule ([gates](specs/gates.md)); closed. A new project's cards are all `feature` | `feature` | **Feature** | New behaviour |
| | `fix` | **Fix** | A defect with a reproduction |
| | `characterize` | **Characterize** | Pin today's behaviour before changing it |
| | `refactor` | **Refactor** | Restructure without new behaviour |
| | `upgrade` | **Upgrade** | Move a dependency to a new version |
| `split` — how the story this card came from was split (SPIDR, as Mike Cohn defined it); absent on a card that was not split. Shown in the card's Plan tab and, with Learn on, beside the kind | `spike` | **Spike** | Uncertainty separated from implementation |
| | `path` | **Path** | Happy path first, edge cases later |
| | `interface` | **Interface** (the *user* interface) | Simplest user interface first. Never a type contract |
| | `data` | **Data** | Restricted data variety first |
| | `rules` | **Rules** | Relaxed business rules first |

A tile or row shows at most two kind labels, the first primary (for example *Flow · UI*). *Change kind* and *SPIDR kind* are not used: the three fields are *kind*, *change* and *split*.

## The run

One hierarchy, used by every specification, the dashboard and the CLI ([DEC-26](DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)):

- An **attempt** is one recorded run of a card to a stop. It holds one **sample**, or up to k under pass@k.
- A **sample** is a sequence of steps.
- A **step** is one model request and the tool calls it makes. The step budget counts steps (*8 of 40 steps*).

*Turn* is the code's synonym for step (the `turn` field of `card/step`, the `--max-turns` flag) and is used in no specification, criterion or user-facing text. The old design's use of *turn* for all the steps of an attempt, and of *sample* for one of several attempts, is retired.

## Themed names (the complete list)

| Name | What it names | Why it earns a name | How it appears first on a surface |
|---|---|---|---|
| **Sekhemet** | The product | Products have names. | The wordmark next to the pylon glyph. |
| **Seshat** | The project-manager persona, which runs on the Planner role's model | The user asked to talk to it "like a real project manager you hired", and chose the name (renamed from Merit, 2026-09-18). Seshat is the Egyptian goddess of writing, measurement and records, "mistress of the house of books", who kept the royal annals and measured out the foundations of temples: a keeper of plans and records, which is what a project manager is. It reads as a name, not a costume, and needs no explanation. | Navigation: *Project manager*, with *Seshat* as secondary text — people scan for the function (Phase A UX review, 2026-09-22). Panel header: *Seshat · Project manager*; the chat panel names no model anywhere — the model's name is on Configuration, with every role's (owner decision O3). `#/pm` topbar: *Seshat · Project manager*. Palette: *Talk to Seshat, the project manager*. Tools and APIs use the name in lower case (`sekhemet_ask_seshat`). |
| **Basalt**, **Sand** | The dark and light themes | Themes are named in most tools, and these describe what you see. | The theme toggle's tooltip. |

The brand glyph (a pylon gate with a sun disc) is a mark, not a name, and is never written out.

## Never

- **No pseudo-Egyptian renames of functional nouns.** Examples: *Scribe* for the ledger, *Papyrus* for cards, *Pharaoh* or *Vizier* for the PM's role, *Oracle* for Insights, *Temple* for the board, *Nile* for flow, *Scarab* for bugs, *Ankh* for Accept, *Sphinx* for review, *Obelisk* for epics, *Hieroglyphs* for logs.
- **No themed name without its function** on first appearance. *Seshat* alone in a navigation label is not enough; the navigation says *Project manager* with *Seshat* beside it.
- **No second persona.** The Worker, the Planner, the Researcher and the Reviewer are roles, not characters. They get no names, avatars or voices. **A role is shown as a text chip** (*Agent*, *AI review*), never as an avatar or a letter badge; a person may have an avatar (their initials), a role never does.
- **No renaming third-party products**, and no abbreviating them in the UI (*GH*, *JIRA*). Monogram tiles on the Integrations page are decoration, marked `aria-hidden`, with the full name beside them.
- **No mythological copy.** No taglines, epigraphs or "the goddess watches over your build". The voice stays plain and exact ([SPINE.md](SPINE.md#voice)).
- **No gold or iconography used to make a name look special.** Seshat's avatar is a plain monogram on `--bg-overlay`. The *AI* badge beside Seshat and the Agent ([dashboard](specs/dashboard.md) §2.13.8) marks what they are, not a persona: it is text in a neutral outline, never gold, and never an avatar.

## Audit (2026-09-18; updated 2026-09-22)

Checked against the dashboard (`packages/ui/web`), `PM_DESIGN.md` and the mockups; updated against [specs/dashboard.md](specs/dashboard.md) and the code.

| Surface | Finding | Change |
|---|---|---|
| Sidebar nav | Showed *Seshat* alone. | Now *Project manager*, with *Seshat* as secondary text and the full sentence in the tooltip. |
| `#/pm` topbar | *Seshat* with the crumb *Project manager*. | Kept. |
| Panel header | *Seshat / Project manager · dirk-27b*. | The model id leaves the chat panel (ruling R15, then owner decision O3): *Seshat · Project manager*; Seshat's model is named on Configuration, with every role's. |
| Palette | *Go to Seshat (full conversation)*. | Now *Go to Seshat, the project manager*. |
| Cheat sheet | Section titled *Seshat*. | Now *Seshat · Project manager*. |
| Integrations | Slack card titled *Slack for the PM*. | Kept: the product name is intact and the function is plain. |
| Board columns and states | NAMING listed *Working*, *Checking*, *Closed*; the code says In Progress, Verify, Rejected (`vocabulary.ts:92-102`); the board shows five professional columns. *Checking* and *Working* still leak into copy (`shell.js:243`, `evidence.js:98`). | Keep list reconciled above; the leaks are removed under dashboard NEW-dashboard-2. |
| Tile | The dashboard design put a *W* badge on tiles the Worker builds. | A text chip *Worker* (ruling R10). |
| MCP tool | `sekhemet_ask_merit` carried the persona's old name. | Renamed `sekhemet_ask_seshat` ([extensibility](specs/extensibility.md)). |
| Card kinds | Three vocabularies: the kernel's seven stored kinds (`card_class.ts:34-41`), the dashboard's own `CardKind` of seven labels with no *Spike* or *Review* and `spike` shown as *Research* (`vocabulary.ts:19-43`), and a "card kind" list that mixed in the brownfield change values (design review B3). | One table above, per DEC-26: `kind`, `change` and `split` are separate fields with one label map; the dashboard's `CardKind` is folded into it under NEW-dashboard-2 (done, C5 2026-09-27: `vocabulary.ts` reads the kernel's stored kinds and declares none of its own). |
| Run terms | *Turn*, *step*, *sample* and *attempt* were defined two incompatible ways here and in worker-loop (design review B4). | One hierarchy, [The run](#the-run). |
| Everything else | Views, fields, states, gates and actions all use keep-list words. No themed renames were found. | None. |
