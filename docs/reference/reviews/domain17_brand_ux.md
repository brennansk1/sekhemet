# Domain 17: Brand, visual and interaction design (Phase A review)

*Read-only, 2026-09-22, @ 468f67f. `serve` on a throwaway copy of `suite/chronicle` (4 done, 1 Ready, 1 in Planning after failing Types). Headless Chrome over CDP captured all 14 routes at 1440/1100/400px in Basalt and Sand, plus palette, cheat sheet, focus and `c`, with an in-page contrast/label/target audit on 30 renders. Screenshots (`ux_shots/`, 4.2 MB) were not committed; the filenames cited below are from that session and can be regenerated with FRONTEND_DESIGN Part 4. Builds on domain 13; doesn't repeat it.*

**Verdict: refactor.** The visual system underneath is disciplined and above average: tokens, a quiet surface ladder, plain copy, reduced motion, focus rings and a sound review surface. What fails the positioning is the **shell**:
- navigation that treats 14 operator views as equals;
- no phone navigation at all;
- every "start something" path ends in a terminal command;
- teaching that exists only in hover tooltips.

---

## 1. Brand

**Name.** "Sekhemet" is a variant spelling of Sekhmet, the goddess of war, plague and healing (HARNESS_DESIGN "Name and brand").
- *Against:*
  - People will type and search "Sekhmet".
  - Nobody knows how to say it, and its best-known association is plague.
  - Next to **Seshat** in the same header, two Egyptian "Se-" names compete. A newcomer can't tell which one is the product and which is the PM (`pm_1440_dark.png`: "Sekhemet" wordmark above "Seshat · Project manager").
- *For:* it is distinctive and ownable, and NAMING.md's restraint keeps it from becoming a costume.
- **Keep the name, but pair it with a descriptor wherever the product introduces itself.** For example, a first-run and README line "Sekhemet — an AI delivery board for teams", plus a pronunciation note. NAMING's rules are exemplary. The audit found no themed renames of functional nouns anywhere in `packages/ui/web`.

**Seshat.** Seshat is a good choice: a keeper of records and measurement fits the role. But rule 4 ("pair with the function") is applied name-first. Non-developers scan for the function, so the nav item should read **Project manager** with *Seshat* as the secondary text. Nothing is lost.

**Voice.** Plain, exact and calm, and mostly delivered ("Nothing waiting for you.", "Ledger intact · 236"). The slips are operator language on user surfaces:
- `GET /api/learning returned 404` (`learning_view.js:158`, `pm_view.js:71`);
- "Sending pauses it at the next step while Seshat loads (about 40s)" (`pm_thread.js:246`);
- "Seshat runs locally on dirk-27b" (`pm_thread.js:248`). The name is also a hard-coded fallback at `pm_client.js:13`;
- "Ready · 40-step budget";
- "Memory normal · 99% used" (contradictory, `board_1440_dark.png`).

**Mark.** The pylon-gate-with-sun-disc glyph (`icons.ts:12`) is the best brand asset. It means "gate", the product's core idea, and it reads without any mythology. Keep it.

**Colour and type.** Warm charcoal (Basalt) and warm paper (Sand) set it apart from Linear's cool grey without looking themed. Both read as a serious tool. The problem is **gold**: the CTA/brand accent `#C8952A` and the warning/parked amber `#B08A3E` share one hue (40.6° vs 40.0°; in Sand, 40° vs 40.8°). "Primary action" and "needs attention" become the same colour. The footer is permanently amber on this machine ("Memory warning 98%"), which trains users to ignore amber.

Type is Inter and JetBrains Mono, unbundled. It falls back to SF, Segoe or Roboto, so the product looks different on each OS. 11px carries most of the board's text (36 of 67 text nodes), which is dense for a beginner and small on a phone.

**Does it read as a trustworthy professional tool?** At 1440px, on Review, Card, Insights and Ledger: yes. On the board and the phone: not yet (see §2–3).

## 2. Visual design

The hierarchy is quiet and consistent across views: one topbar pattern (title · crumb · search), the same section-heading style, and empty states with an icon, a sentence and a next step. Both themes are genuinely tuned (`*_light.png` vs `*_dark.png`). My in-page audit found **zero text-contrast failures on 12 of 15 routes**.

**The three worst visual problems**

1. **The gates strip breaks when there are many gates.** It is the product's central evidence element, and with 14 gates it fails:
   - The segments overlap.
   - Four gates are called "Security" and four "Hygiene", so they can't be told apart.
   - At 400px the labels print on top of each other (`card_card_chron_ledger_1440_dark.png`, `…_400_dark.png`).
   - The card's state badge reads **✕ Planning**, which merges a stage with a failure.
2. **The board's face hides the one thing you came for.**
   - The failing card's status line is cut off exactly at its cause, "Types failed · 3 errors · needs a …". The full text, "needs a new plan", only appears in a `title` (`tile.js:171`, `board.css:280-283`).
   - Four columns are drawn as rotated vertical rails (Backlog, Verify, Done, Parked), and about 55% of the canvas is empty (`board_1440_dark.png`).
   - Compare the owner's own mockup (`mockup_board-v2.png`): a cycle header, epic lanes and six upright columns. The build has drifted away from its own design.
3. **Gold is overloaded.** The accent colour is used for:
   - the CTA;
   - the focus ring;
   - the active nav bar;
   - the brand;
   - the Seshat composer border;
   - and, by hue, the warning colour.

   The disabled Accept keeps its gold fill at 40% opacity (`base.css:163`). That gives 2.1:1 in both themes, and it reads as "enabled, but cautionary" rather than "not available" (`card_…_1440_dark.png`). Integrations' disabled "Sync both" has the same problem.

**Nits:** Insights repeats axis ticks ("2m, 2m, 1m, 1m") and says "4 in 1 days" (`insights_1440_dark.png`); Registry lists test models `a` and `b`; Dependencies draws six unconnected boxes (`graph_1440_dark.png`).

## 3. Interaction and information architecture

**The three worst UX problems**

1. **There is no navigation below 768px.**
   - `.side{display:none}` (`shell.css:513-516`), and the specified bottom tab bar (FRONTEND §2.2) was never built.
   - The phone board opens scrolled to an empty Review column, and the other columns can only be reached by swiping sideways (`board_400_dark.png`).
   - Seshat, Review and Board can only be reached by typing a URL, or through a ⌘K button a phone has no key for.
   - The designed mobile job (check an overnight run, triage with one tap) can't be done.
2. **The navigation is a flat list of 14 items with no groups, and between 1024 and 1279px it becomes an unlabelled rail.**
   - Operator views (Machine, Registry, Workspace, Dependencies, Ledger) sit at the same weight as Board and Review (`shell.js:6-28`).
   - Between 1024 and 1279px (a normal laptop split-screen), labels disappear (`shell.css:454-470`).
   - Review and Inbox then share the same tray icon (`icons.ts:13,17`).
   - The footer becomes three unexplained dots (`board_1100_rail_dark.png`).
   - HARNESS_DESIGN's "hidden, not empty" rule is implemented for Inbox only.
   - The keyboard layer breaks the design's own rules:
     - Chords aren't first-letter mnemonics: `g a` Seshat, `g f` Insights, `g s` Integrations, `g e` Registry, `g q` Runs (`keys.js:13-27`).
     - A bare `t` flips the theme (`keys.js:91`), where HARNESS "Keyboard" forbids surprising single-key actions.
   - The cheat sheet overflows a 900px-high window (`cheatsheet_1440_dark.png`, cut off at "Extend selection").
3. **Every "start something" path is a dead end into the terminal.**
   - `c` shows "Create cards from the CLI for now" (`board.js:580`, `board_c_newcard_1440_dark.png`).
   - Review's empty state says `sekhemet queue`, Runs says `sekhemet queue --auto-accept`, and Registry says `sekhemet bake-off`. There are 12 CLI commands in the UI's copy.
   - Typing "new project" in the palette returns "No matches" (`palette_newproject_1440_dark.png`).
   - For the two non-developer audiences, the UI can observe but can't start anything.

**Worth keeping:** empty states that say what a view is for; specific offline, ledger-altered and memory-pause bars (`shell.js:196-250`); the grouped palette; `picker.js` (number keys, filter, Create row, focus returned); `pm_client.js` stopping *Apply all* at the first failure.

**Loading and first run.** The skeleton board in `ui_html.ts` is good. There is no first-run experience: a new user lands on Board or Review (`app.js:52`), with no question about who they are and no path to a first card.

## 4. Accessibility

**Contrast of the token pairs in use** (WCAG 2.x; computed from `tokens.ts`, backgrounds are base / surface / raised / overlay):

| Pair | Basalt | Sand | Verdict |
|---|---|---|---|
| text-primary | 15.2 / 14.1 / 13.0 / 11.9 | 15.7 / 17.4 / 14.2 / 12.8 | Pass |
| text-secondary | 7.0 / 6.6 / 6.0 / 5.5 | 6.5 / 7.2 / 5.9 / 5.3 | Pass |
| text-muted | 3.3 / 3.1 / 2.9 / 2.6 | 3.2 / 3.6 / 2.9 / 2.6 | **Fails** where it carries information. It is the colour of every placeholder, and the placeholder is the Seshat composer's only instruction (`pm.css:413`, `shell.css:328`, `board2.css:184`). The tab-key hints "1 2 3 4" are 3.3:1. |
| accent as text | 6.9 / 6.4 / 6.0 / 5.4 | 4.7 / 5.2 / **4.3** / **3.9** | Sand fails on raised and overlay |
| state-pass / fail / running on raised (icons) | 5.2 / 4.3 / 4.7 | 4.1 / 5.3 / 4.2 | Pass as non-text (≥3). Sand pass as text ("+146") is **4.1** |
| border-strong vs surfaces | 1.3–1.6 | 1.4–1.9 | **Fails 1.4.11** (3:1) wherever the border is the only edge of an input: the filter field, selects, the composer at rest |
| on-accent / accent | 6.9 | 5.2 | Pass |

**Focus.** Focus is a 2px accent outline, measured on live DOM at 6.9:1 (Basalt) and 4.7:1 (Sand). It is visible and consistent, and the skip link is present.

**Keyboard.** The board is a roving listbox (`board.js:168`), and dialogs trap and restore focus. Gaps:
- Dependency nodes sit inside `svg role="img"`, which hides them from assistive technology (`graph.js:61`).
- The picker swallows Tab instead of closing (`picker.js:140`).

**Labels.**
- The Integrations PR switch has no accessible name (`integrations.js:230`), while its sibling at `:234` has one.
- Everything else icon-only is labelled or titled (probe: 0 other unlabelled controls).

**Targets.**
- Copy buttons are 14×14 (WCAG 2.2 2.5.8 needs 24).
- On the phone, Board and List are 67×22, against FRONTEND's own 44px rule.

**Hover-only content (1.4.13 / 2.1.1).** WIP-limit reasons, the full status line, gate names and priority meaning live in `title` attributes. Keyboard, touch and magnifier users never see them, and these are exactly the explanations a beginner needs.

**Reduced motion.** Handled fully (`base.css:245,470`, `board.css:382`).

**Phone width.** See §3 problem 1. Also, the gates strip is unreadable at 400px.

## 5. The three audiences

**Developer: "what is blocked, and why?"**
1. On the Board, the only red card is in *Planning*, and its cause is truncated ("needs a …").
2. Nothing says "Blocked". `blockedReason` is never rendered (domain 13), and Dependencies has no edges.
3. Opening the card shows **✕ Planning** · "Failed Types, Tests and Size · Looping on step 18", then a gates strip too crowded to read. The failure blocks below it are excellent: exact TS2375 text, expected vs actual, a remedy.

*Where they get stuck:* decoding "failed, but in Planning", and the gates strip. Three clicks; succeeds.

**Beginner: "what is a WIP limit, and why is this column full?"**
- The header shows "Planning 1 / 3" and a hairline bar.
- The only explanation is a hover title, "Limit 3" or "Planning limit 3. Full." (`board.js:106-119`).
- The term "WIP limit" never appears on screen. The cheat sheet covers keys only, and there is no Learn layer.
- The Review limit (5,373 here) is hidden entirely.

*Where they get stuck:* immediately.

**Non-developer: "how is it going?", then "start a new project".**
1. They land on Board or Review: Contract, Wiring, Verify, "40-step budget".
2. They must pick out "Seshat · Project manager" as item 4 of 14. On a phone it is unreachable.
3. `#/pm` is clean, and the **Standup** starter is exactly the right entry.
4. The footer then warns that replies take a minute on "dirk-27b". If the Worker is running, it says sending "pauses it". A cautious non-developer won't press Send.
5. For "start a new project" there is no button, no palette entry and no PM tool (domain 7).

*Where they get stuck:* they get a status answer after about 60 seconds of doubt; starting a project is a dead end.

## 6. Senior judgement: redesign direction (ranked, not a rewrite)

1. **A labelled, grouped, progressive navigation.** Shell only: `shell.js`, `shell.css`, `keys.js`.
   ```
   Status          g s   (new, §6.5; the default for non-developers)
   Project manager g p   Seshat as secondary text
   Review        n g r   absorbs Inbox as its "Needs you" section
   Board           g b
   Insights        g i
   ── More ▾ (collapsed; each item shown only when it has content)
   Runs · Dependencies (when edges exist) · Playbook · Integrations
   ── System (footer menu): Machine · Ledger · Registry · Workspace (≥2 projects) · Theme · Keys
   ```
   - At 1024–1279px, keep the labels: a 176px sidebar, or icon-over-label.
   - Below 768px, a bottom tab bar: **Status · Review · Board · PM**.
   - The theme toggle leaves the single-key map and goes to the palette and footer.
   - Chords become first letters. Playbook and Registry lose their chords and use the palette.
   - Generate the cheat sheet and palette from one keymap, so the cheat sheet stays true to itself (HARNESS "the cheat sheet is the specification").
2. **Card and column anatomy.** Adopt domain 13's five columns and four-row tile, with these design rules:
   - The status line may wrap to 2 lines and **never truncates the cause**. Kind chips move off the tile face.
   - One status pill = icon + colour + words ("✕ Needs a new plan"), never a stage with a failure mark.
   - Collapsed columns become horizontal chips above the board ("Done 4 ›"), not rotated rails.
   - The column header shows: name · `count / limit` · a Learn "?".
   - Gates strip: one segment per gate *name* with a count ("Security 4/4 ✓"), failing gates first, "+6 passed" as an overflow chip. At phone width it becomes a vertical list.
3. **Colour roles.**
   - Move parked/warn to a copper hue clearly apart from the accent, for example ≈ `#C8743A` Basalt / `#9A4F1C` Sand, re-measured.
   - Disabled buttons use neutral fill, not faded gold.
   - Add a `--border-control` token at ≥3:1 for inputs.
   - Muted colour never carries text that has to be read, placeholders included.
   - Show the memory status amber only when it changes behaviour.
4. **The Learn layer, visually.**
   - A labelled **Learn** toggle in the topbar (book icon + word). It sets `data-learn`, adds no layout when off, and is offered at first run ("New to team boards?").
   - When on, key terms (WIP limit, cycle, points, Done, In Review) get a dotted underline and a small "?" button that opens an **accessible popover**, not a `title`. The popover has:
     - two sentences on *what* it is;
     - one line *from your own numbers* (the existing Review-limit arithmetic);
     - one link to the canon.
   - A **Learn sheet** holds 8–10 lessons as a checklist. "Show me" highlights the live element.
   - Neutral chrome and no new colour. The same content module feeds Seshat's explanations.
5. **The non-developer Status view** (`#/status`), built on `/api/standup`, `/api/signals` and `/api/goals` (all built, none used):
   - a sentence headline ("On track: 4 of 6 cards done. 1 needs a new plan; Seshat suggests splitting it.");
   - a burn-up;
   - **Needs you**, with plain buttons;
   - **What changed today**, the standup text;
   - **Risks**, the signals;
   - an inline "Ask Seshat…" box;
   - a primary **Start a new project** button, which opens Seshat with a start-project brief (domain 7's P2).

   Plain labels come from a `plainStatus()` next to `statusLine()`: "Being planned", "Being built", "Waiting for review". Make this the default route when there is no developer signal (never accepted a card), and offer it at first run: "I write code / I manage the work / I'm learning".
6. **First slice, one card, under 200 LOC, 3 files:** `shell.js` nav groups and labels, progressive `when` for Dependencies, Workspace and Registry; `shell.css` labelled mid-width rail and phone bottom bar; `keys.js` first-letter chords and no bare `t`. It changes no data and fixes the two worst UX problems.

## 7. Verdict per module and stylesheet

| Module | Verdict | Note |
|---|---|---|
| `src/tokens.ts` | Keep → refactor | Separate warn hue from accent; add `--border-control`; test pairs as used (placeholders, Sand accent on raised) |
| `src/icons.ts` | Keep | Distinguish Inbox from Review, or retire Inbox; glyph stays |
| `src/vocabulary.ts` | Keep → refactor | Domain 13's `statusLine`; add `plainStatus` and Learn glossary |
| `src/pm.ts` | Refactor | As domain 13 |
| `src/canvas.ts` | Cut | Dead (domain 13) |
| `apps/harness/src/ui_html.ts` | Keep | Add bottom-nav slot; preload fonts if bundled |
| `shell.js`, `shell.css` | **Refactor first** | IA, rail labels, phone nav, footer copy |
| `keys.js`, `cheatsheet.js` | Refactor | One keymap source; first-letter chords; fit viewport |
| `palette.js` | Keep | Add "Start a project", "New card", and "Ask Seshat: <query>" as the no-match fallback |
| `learning_view.js` | Keep | Remove API paths from copy |
| `picker.js` | Keep | Close on Tab |
| `pm_client.js`, `pm_panel.js`, `pm_thread.js` | Keep | Drop `dirk-27b` fallback; non-operator footer copy |
| `pm_view.js` | Refactor | Rail content moves to Status |
| `dag.js`, `sparkline.js` | Keep | Pure, tested, good |
| `graph.js` | Refactor | Hide when no edges; nodes out of `role="img"` |
| `board.js`, `tile.js`, `lanes.js` | Refactor | Domain 13 anatomy + no truncated cause + no rails |
| review, evidence, triage, diff | Keep | Gates strip grouping/overflow |
| `insights.js` | Keep | Tick de-duplication, plurals |
| `integrations.js` | Refactor | Label PR switch; "Connected" only for real two-way links (Jira/Linear are export files) |
| `inbox.js` | Merge into Review ("Needs you") | Keep route |
| machine, ledger, runs, playbook, registry, workspace | Keep | Behind "More"/"System"; hide test models |
| 9 stylesheets | Refactor | Per component (domain 13) |

## Proposals (nothing added without the owner's yes; verify licences first)

| Proposal | Licence | Maintenance signal | Replaces / adds | Why |
|---|---|---|---|---|
| **Inter** + **JetBrains Mono** WOFF2, vendored under `web/fonts/` | SIL OFL 1.1 | Both active, widely used | System fallback | Same look on every OS, offline, no CDN |
| **@floating-ui/dom** | MIT | Very active (successor of Popper) | `title=` tooltips | Accessible, keyboard-reachable popovers for Learn, WIP and gate details; ESM, vendorable, build-free |
| **Lucide** icons (optional) | ISC | Very active, 1,500+ icons, 1.5–2px line | Hand-drawn nav/action icons (keep the glyph) | Consistent, recognisable metaphors |
| **axe-core** + **@axe-core/playwright** | MPL-2.0 (**weak copyleft**, dev-only, unmodified) | Deque, very active | Nothing (no DOM a11y check exists) | CI gate: 0 serious violations |
| **Playwright** | Apache-2.0 | Microsoft, very active | Manual visual recipe (FRONTEND Part 4) | Screenshot regression at 400/1100/1440 × 2 themes |
| **Leonardo** (`@adobe/leonardo-contrast-colors`) | Apache-2.0 | Adobe, maintained | Hand-tuned hex | Generate warn, border-control and epic hues to target contrast |
| **Kanban Guide**, **Scrum Guide** | CC BY-SA 4.0 | Maintained by authors | — | Learn links to the canon; quoting requires attribution and share-alike, so link rather than copy |
| Feature: **Status view**, **Start a project** entry, **Learn** | — | — | — | §6.4–6.5 |

## Top 5 changes

**1. Labelled, grouped, progressive navigation, plus the phone bottom bar.**
- *Why:*
  - 14 flat items (`shell.js:6-28`).
  - Unlabelled rail at 1024–1279 with identical Review and Inbox icons (`board_1100_rail_dark.png`).
  - No navigation below 768px (`shell.css:513`, `board_400_dark.png`).
  - Chords and `t` break HARNESS "Keyboard" (`keys.js:13-27,91`).
- *Effort:* S (first slice).
- *Risk:* muscle memory for the old chords. Mitigate by keeping the old chords silently for one release.
- *Measured by:*
  - a first-click test on the three audience tasks (target ≥80% correct);
  - a spec asserting nav items per data state;
  - Playwright at 400px: Review, Board and PM reachable in one tap.

**2. Status home and "Start a new project".**
- *Why:*
  - Non-developers land in jargon.
  - The standup, signals and goals APIs are unused.
  - `c` and the palette dead-end (`board.js:580`, `palette_newproject_1440_dark.png`).
- *Effort:* M (the start-project backend is domain 7's P2).
- *Risk:* a second "home" confuses developers. Default it by role, and let people switch.
- *Measured by:* a scripted non-developer session, "how is it going" answered in under 30 seconds from open, and a project started without a terminal.

**3. The Learn layer on accessible popovers.**
- *Why:* WIP, gate and priority explanations are `title`-only (`board.js:106-119`). The term "WIP limit" never appears, and there is no teaching layer.
- *Effort:* M.
- *Risk:* clutter for experts. Off by default after first run; zero DOM when off, checked by a test.
- *Measured by:* a 5-question comprehension check for beginners with Learn off vs on, and axe showing no hover-only content.

**4. Make the evidence readable.**
- *What:* group the gates strip, never truncate the status cause, fix the "✕ Planning" badge, remove the rotated rails.
- *Why:* `card_card_chron_ledger_1440_dark.png` / `_400_dark.png` and `board_1440_dark.png`; `tile.js:171`, `board.css:280-283`.
- *Effort:* S–M.
- *Risk:* tile height and virtualisation. Keep 88px with a 2-line status and chips off the face.
- *Measured by:* exact-value specs for the strip model (14 gates → 5 groups) and screenshot diffs at three widths.

**5. Colour and contrast fixes, with automated checks.**
- *What:* separate the warn hue from gold; neutral disabled buttons; `--border-control` at ≥3:1; no muted text that has to be read; label the PR switch; 24px copy buttons.
- *Why:*
  - Borders measure 1.3–1.9:1.
  - Placeholders measure 2.6–3.6:1.
  - Gold and amber sit at the same 40° hue.
  - The disabled Accept measures 2.1:1.
  - `integrations.js:230` has no accessible name.
- *Effort:* S (tokens) + S (Playwright + axe harness).
- *Risk:* a small visual shift in both themes. Review with side-by-side screenshots.
- *Measured by:* `tokens.spec.ts` asserting the pairs as used; axe showing 0 serious or critical issues on 15 routes × 2 themes × 3 widths in CI.
