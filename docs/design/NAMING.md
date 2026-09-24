# Naming

Status: rule from the user, 2026-09-18; state names reconciled with the code and the board, 2026-09-22 · Applies to the product, the dashboard, the CLI, docs and model prompts.
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
| Views | Status · Project manager · Review · Board · List · Story map · Insights · Runs · Dependencies · Playbook · Integrations · Machine · Ledger · Registry · Workspace · Settings. *Inbox* is retired as a view; its route opens Review › *Needs you* |
| Work | Card · Subtask · Epic · Cycle · Label · Priority (Urgent, High, Medium, Low, No priority) · Points · Due date · Backlog |
| Card states, stored (CLI, errors, ledger, pipeline view) | Backlog · Ready · Planning · In Progress · Verify · Review · Done · Parked · Rejected — one name per state, the same in the column heading of pipeline view, the stored value's label, an error message and the design (`vocabulary.ts` `COLUMN_LABELS`) |
| Board columns (the default board, and the Jira export) | Backlog · To do (Ready, Planning) · In progress (In Progress, Verify) · In review (Review) · Done · On hold (Parked, shown only when non-empty) · Won't do (Rejected, a filter, not a column) |
| Card kinds | Contract · Storage · Flow · Rules · Research · UI · Wiring; for existing code Feature · Fix · Characterize · Refactor · Upgrade |
| The Worker's run | **Step**: one model call and the tool calls it makes — the step budget counts steps, and the code's turn index counts the same thing, so a "turn" in the code is a step ([worker-loop](specs/worker-loop.md) Contract defines it). **Attempt**: one run of a card to a stop. **Sample**: one of several attempts compared by the gates. The old design's use of *turn* for all the steps of an attempt is retired. **Change kind**: what a card does to existing code — build, characterize, refactor, upgrade ([gates](specs/gates.md)) — separate from its card kind |
| Quality | Gates · Evidence · Parse · Types · Tests · Lint · Size · Acceptance tests · Done when · May edit · Findings (the Reviewer's) |
| Delivery | Requirement · Must-have · Nice-to-have · Slice · Walking skeleton · Appetite · Release · Depth profile (Prototype, Internal tool, Production, Regulated); requirement states Proven · Passing, strength unmet · Planned · Unplanned · Suspect · Cut |
| Actions | Accept · Send back · Park · Unpark · Reject · Reopen · Revert accept · Acknowledge · Approve · Apply · Discard · Apply all · Import · Export · Sync · Pull · Push |
| Flow | WIP limit · Cycle time · Throughput · Cumulative flow · Aging work in progress · Work item age · Swimlane · Saved view |
| Machine | Memory · Model · Health checks · Worktrees · Sandbox |

*Working*, *Checking* and *Closed* are **retired**: they were a third vocabulary for the same states (neither the stored names nor the board's), and a person who read `verify` in an error could not find a column called *Checking*.

## Themed names (the complete list)

| Name | What it names | Why it earns a name | How it appears first on a surface |
|---|---|---|---|
| **Sekhemet** | The product | Products have names. | The wordmark next to the pylon glyph. |
| **Seshat** | The project-manager persona, which runs on the Planner role's model | The user asked to talk to it "like a real project manager you hired", and chose the name (renamed from Merit, 2026-09-18). Seshat is the Egyptian goddess of writing, measurement and records, "mistress of the house of books", who kept the royal annals and measured out the foundations of temples: a keeper of plans and records, which is what a project manager is. It reads as a name, not a costume, and needs no explanation. | Navigation: *Project manager*, with *Seshat* as secondary text — people scan for the function (Phase A UX review, 2026-09-22). Panel header: *Seshat · Project manager*, without the model's name (the model's id is in the header's details and on Machine). `#/pm` topbar: *Seshat · Project manager*. Palette: *Talk to Seshat, the project manager*. Tools and APIs use the name in lower case (`sekhemet_ask_seshat`). |
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
| Panel header | *Seshat / Project manager · dirk-27b*. | The model id leaves the header (ruling R15): *Seshat · Project manager*, with the model in the header's details and on Machine. |
| Palette | *Go to Seshat (full conversation)*. | Now *Go to Seshat, the project manager*. |
| Cheat sheet | Section titled *Seshat*. | Now *Seshat · Project manager*. |
| Integrations | Slack card titled *Slack for the PM*. | Kept: the product name is intact and the function is plain. |
| Board columns and states | NAMING listed *Working*, *Checking*, *Closed*; the code says In Progress, Verify, Rejected (`vocabulary.ts:92-102`); the board shows five professional columns. *Checking* and *Working* still leak into copy (`shell.js:243`, `evidence.js:98`). | Keep list reconciled above; the leaks are removed under dashboard NEW-dashboard-2. |
| Tile | The dashboard design put a *W* badge on tiles the Worker builds. | A text chip *Worker* (ruling R10). |
| MCP tool | `sekhemet_ask_merit` carried the persona's old name. | Renamed `sekhemet_ask_seshat` ([extensibility](specs/extensibility.md)). |
| Everything else | Views, fields, states, gates and actions all use keep-list words. No themed renames were found. | None. |
