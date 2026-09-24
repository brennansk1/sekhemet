# Naming

Status: rule from the user, 2026-09-18; state names reconciled with the code and the board, 2026-09-22; card kind, change, split and the run hierarchy settled by [DEC-26](DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run), 2026-09-24; *Configuration* named, 2026-09-24 ([DEC-29](DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O2, O3) · Applies to the product, the dashboard, the CLI, docs and model prompts.
Related: [SPINE.md](SPINE.md) (voice), [specs/dashboard.md](specs/dashboard.md) and [specs/planner-pm.md](specs/planner-pm.md) (where these names appear), [DECISIONS.md](DECISIONS.md#dec-05) (one persona).

## The rule

1. **Functional nouns keep their professional names.** If the industry already has a word for a thing (board, review, cycle, epic), or the thing already has a name in Sekhemet, that word stays. A developer from Linear, Jira or GitHub should never have to translate.
2. **Third-party products keep their own names, exactly as their makers write them.** GitHub, GitHub Actions, Jira, Linear, Slack, Microsoft Teams, Sentry, Datadog, PagerDuty, Notion, Confluence, Ollama.
3. **A Sekhemet-themed name is allowed only for something that would take a proper name anyway**: a product, a persona or a theme. It must read as an ordinary name, not a costume. It must never replace the word for what the thing does.
4. **A themed name is always paired with its function the first time it appears on a surface.** Write *Seshat · Project manager*, or *Seshat, the project manager*. After that, *Seshat* alone is fine on that surface.

If you are unsure whether something "takes a name", it doesn't. Use the plain word.

## Keep list (functional names that stay as they are)

| Area | Names |
|---|---|
| Product and roles | Sekhemet · Worker · Planner · Researcher · Reviewer · You · Project |
| People on a card | Owner (the responsible person) · Delegate (who builds it: the Worker or a person) · Accepter · *Assignee* only as the alias for Owner in the query language and in exports to trackers whose field has that name |
| Views | Status · Project manager · Review · Board · List · Story map · Insights · Runs · Dependencies · Playbook · Integrations · Machine · Ledger · Configuration · Workspace. *Inbox* is retired as a view; its route opens Review › *Needs you*. *Registry* and *Settings* are retired as views: both are sections of Configuration, and their routes open them |
| Work | Card · Subtask · Epic · Cycle · Label · Priority (Urgent, High, Medium, Low, No priority) · Points · Due date · Backlog |
| Card states, stored (CLI, errors, ledger, pipeline view) | Backlog · Ready · Planning · In progress · Verify · Review · Done · Parked · Rejected — one name per state, in sentence case, the same in the column heading of pipeline view, the stored value's label, an error message and the design (`vocabulary.ts` `COLUMN_LABELS`, whose `In Progress` becomes *In progress* under [dashboard](specs/dashboard.md) NEW-dashboard-2) |
| Board columns (the default board, and the Jira export) | Backlog · To do (Ready, Planning) · In progress (In progress, Verify) · In review (Review) · Done · On hold (Parked, shown only when non-empty) · Won't do (Rejected, a filter, not a column) |
| Card kind, change and split | The labels in [Card kind, change and split](#card-kind-change-and-split) below — *Contract · Storage · Flow · Rules · Spike · Research · Review*, with *UI* and *Wiring* as display refinements; *Feature · Fix · Characterize · Refactor · Upgrade* for the change |
| The Worker's run | **Attempt ⊃ sample ⊃ step** — defined once in [The run](#the-run) below |
| Quality | Gates · Evidence · Parse · Types · Tests · Lint · Size · Acceptance tests · Done when · May edit · Findings (the Reviewer's) |
| Delivery | Requirement · Must-have · Nice-to-have · Slice · Walking skeleton · Appetite · Release · Depth profile (Prototype, Internal tool, Production, Regulated); requirement states Proven · Passing, strength unmet · Planned · Unplanned · Suspect · Cut |
| Actions | Accept · Send back · Park · Unpark · Reject · Reopen · Revert accept · Acknowledge · Approve · Apply · Discard · Apply all · Import · Export · Sync · Pull · Push |
| Flow | WIP limit · Cycle time · Throughput · Cumulative flow · Aging work in progress · Work item age · Swimlane · Saved view |
| Machine | Memory · Model · Health checks · Worktrees · Sandbox |
| Configuration | **Configuration** is the page where a person sets Sekhemet up, in plain words: which models it uses for each role and where they are kept, the benchmark that compares them, how many minutes a day the person reviews, and the settings in force. Its sections: Models · Benchmark · Review capacity · This browser · Project configuration. Its words: Model folder · Scan · Recommended · Assign · Load · Unload · Download · Benchmark (the quick and the overnight benchmarks of model combinations) · Quick · Overnight · Indistinguishable (two candidates the paired comparison cannot separate) · Morning report · Reserve now · Baseline. Not *Settings*, *Preferences*, *Admin* or *Registry* for the page: *Configuration* is the word the product already uses for `config.toml` ([surface](specs/surface.md)) |

*Working*, *Checking* and *Closed* are **retired**: they were a third vocabulary for the same states (neither the stored names nor the board's), and a person who read `verify` in an error could not find a column called *Checking*.

*Library* (in the naming list of 2026-09-17: *Workspace, Project, Card, Subtask, Gates, Evidence, Playbook, Worker, Planner, Library*) is **retired**: no v3 surface, view or command names anything *Library*, and the old design used it only in that list, never saying what it named, so keeping it would reserve a word for nothing.

## Card kind, change and split

One card has three separate stored fields ([DEC-26](DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)). This table is the only label map for them: the dashboard, Seshat, the CLI and the exports read their words from it (through `vocabulary.ts`), and no second map exists ([dashboard](specs/dashboard.md) NEW-dashboard-2). The stored value appears only in mono, where a developer might grep for it.

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
- **No second persona.** The Worker, the Planner, the Researcher and the Reviewer are roles, not characters. They get no names, avatars or voices. **A role is shown as a text chip** (*Worker*, *Reviewer*), never as an avatar or a letter badge; a person may have an avatar (their initials), a role never does.
- **No renaming third-party products**, and no abbreviating them in the UI (*GH*, *JIRA*). Monogram tiles on the Integrations page are decoration, marked `aria-hidden`, with the full name beside them.
- **No mythological copy.** No taglines, epigraphs or "the goddess watches over your build". The voice stays plain and exact ([SPINE.md](SPINE.md#voice)).
- **No gold or iconography used to make a name look special.** Seshat's avatar is a plain monogram on `--bg-overlay`.

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
| Card kinds | Three vocabularies: the kernel's seven stored kinds (`card_class.ts:34-41`), the dashboard's own `CardKind` of seven labels with no *Spike* or *Review* and `spike` shown as *Research* (`vocabulary.ts:19-43`), and a "card kind" list that mixed in the brownfield change values (design review B3). | One table above, per DEC-26: `kind`, `change` and `split` are separate fields with one label map; the dashboard's `CardKind` is folded into it under NEW-dashboard-2. |
| Run terms | *Turn*, *step*, *sample* and *attempt* were defined two incompatible ways here and in worker-loop (design review B4). | One hierarchy, [The run](#the-run). |
| Everything else | Views, fields, states, gates and actions all use keep-list words. No themed renames were found. | None. |
