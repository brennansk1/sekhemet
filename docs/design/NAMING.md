# Naming

Status: rule from the user, 2026-09-18 · Applies to the product, the dashboard, the CLI, docs and model prompts.
Related: `FRONTEND_DESIGN.md` §2.3 (voice and term table), `PM_DESIGN.md` §2.1 (Merit).

## The rule

1. **Functional nouns keep their professional names.** If the industry already has a word for a thing (board, review, cycle, epic), or the thing already has a name in Sekhemet, that word stays. A developer from Linear, Jira or GitHub should never have to translate.
2. **Third-party products keep their own names, exactly as their makers write them.** GitHub, GitHub Actions, Jira, Linear, Slack, Microsoft Teams, Sentry, Datadog, PagerDuty, Notion, Confluence, Ollama.
3. **A Sekhemet-themed name is allowed only for something that would take a proper name anyway**: a product, a persona or a theme. It must read as an ordinary name, not a costume. It must never replace the word for what the thing does.
4. **A themed name is always paired with its function the first time it appears on a surface.** Write *Merit · Project manager*, or *Merit, the project manager*. After that, *Merit* alone is fine on that surface.

If you are unsure whether something "takes a name", it doesn't. Use the plain word.

## Keep list (functional names that stay as they are)

| Area | Names |
|---|---|
| Product and roles | Sekhemet · Worker · Planner · You · Project |
| Views | Review · Board · List · Runs · Ledger · Playbook · Machine · Insights · Integrations |
| Work | Card · Subtask · Epic · Cycle · Label · Priority (Urgent, High, Medium, Low, No priority) · Points · Assignee · Due date · Backlog · Ready · Planning · Working · Checking · Done · Parked · Closed |
| Quality | Gates · Evidence · Parse · Types · Tests · Lint · Size · Acceptance tests · Done when · May edit |
| Actions | Accept · Send back · Park · Apply · Discard · Apply all · Import · Export · Sync · Pull · Push |
| Flow | WIP limit · Cycle time · Throughput · Cumulative flow · Aging work in progress · Swimlane · Saved view |
| Machine | Memory · Model · Health checks · Worktrees · Sandbox |

## Themed names (the complete list)

| Name | What it names | Why it earns a name | How it appears first on a surface |
|---|---|---|---|
| **Sekhemet** | The product | Products have names. | The wordmark next to the pylon glyph. |
| **Merit** | The project-manager persona that runs on the manager model | The user asked to talk to it "like a real project manager you hired". People you hire have names, and a name makes a conversation feel like one. It comes from Merit-Ptah, the earliest named physician on record, and it is also an ordinary English word. It is short, it is a name rather than a mascot, and it needs no explanation. | Sidebar: *Merit · Project manager*. Panel header: *Merit / Project manager · dirk-27b*. `#/pm` topbar: *Merit · Project manager*. Palette: *Talk to Merit, the project manager*. |
| **Basalt**, **Sand** | The dark and light themes | Themes are named in most tools, and these describe what you see. | The theme toggle's tooltip. |

The brand glyph (a pylon gate with a sun disc) is a mark, not a name, and is never written out.

## Never

- **No pseudo-Egyptian renames of functional nouns.** Examples: *Scribe* for the ledger, *Papyrus* for cards, *Pharaoh* or *Vizier* for the PM's role, *Oracle* for Insights, *Temple* for the board, *Nile* for flow, *Scarab* for bugs, *Ankh* for Accept, *Sphinx* for review, *Obelisk* for epics, *Hieroglyphs* for logs.
- **No themed name without its function** on first appearance. *Merit* alone in a navigation label is not enough; the sidebar says *Merit · Project manager*.
- **No second persona.** The Worker and the Planner are roles, not characters. They get no names, avatars or voices.
- **No renaming third-party products**, and no abbreviating them in the UI (*GH*, *JIRA*). Monogram tiles on the Integrations page are decoration, marked `aria-hidden`, with the full name beside them.
- **No mythological copy.** No taglines, epigraphs or "the goddess watches over your build". The voice stays plain and exact (FRONTEND_DESIGN §2.3).
- **No gold or iconography used to make a name look special.** Merit's avatar is a plain monogram on `--bg-overlay`.

## Audit (2026-09-18)

Checked against the dashboard (`packages/ui/web`), `PM_DESIGN.md` and the mockups.

| Surface | Finding | Change |
|---|---|---|
| Sidebar nav | Showed *Merit* alone. | Now *Merit · Project manager* (the function is secondary text, and the tooltip has the full sentence). |
| `#/pm` topbar | *Merit* with the crumb *Project manager*. | Kept. |
| Panel header | *Merit / Project manager · dirk-27b*. | Kept. |
| Palette | *Go to Merit (full conversation)*. | Now *Go to Merit, the project manager*. |
| Cheat sheet | Section titled *Merit*. | Now *Merit · Project manager*. |
| Integrations | Slack card titled *Slack for the PM*. | Kept: the product name is intact and the function is plain. |
| Everything else | Views, fields, states, gates and actions all use keep-list words. No themed renames were found. | None. |
