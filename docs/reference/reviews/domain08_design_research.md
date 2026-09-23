# Domain 8: Design stage, new projects, and research (Phase A review)

*Read-only review, 2026-09-22. Paths are relative to the worktree root. "Live" means I ran `reuse.ts` and `pm/libraries.ts` unmodified against registry.npmjs.org today, from copies in the scratchpad under Node 26 type-stripping. `design_stage.spec` and `reuse_survey.spec` both pass (16/16).*

## 1. Positioning

**The design stage is proportional in shape, but it does not yet show a senior PM's judgement.** The four levels exist and are wired in: `designStage` (`packages/planner/src/design_stage.ts:135-207`) is called from `planCommand` (`apps/harness/src/wave2.ts:221`). Defaults are recorded as assumptions on the epic (`wave2.ts:255-265`), and a calculator gets one sentence. Four problems show where the judgement is missing:

- **Risk comes from keyword regexes, and they misfire both ways.** I checked them in node. "a CLI that shows my laptop charging status" gets a billing brief whose riskiest assumption is "never charge a customer twice", because `charg\w*` matches (`:77`). "a static blog with author pages" and "a password generator CLI" get the auth brief ("a session cannot be forged"), because `auth\w*` and `password` match (`:82`). "a health check endpoint" is treated as personal data (`:87`). The reverse also happens: "a recipe website where people can sign up and save favourites" gets no brief, because only `sign[- ]?in` is matched.
- **The proportion runs backwards at the top end.** For a brief, the `say` lines drop the questions entirely (`:190-195`), and a billing spec that names no database or API matches no `EXTERNAL` rule. So the sync CLI is asked two questions and the billing service is asked none. The design promises "the full six, a real conversation" for billing (HARNESS_DESIGN:1039).
- **The brief is a form letter.** Problem, Outcome and Non-goals are fixed templates ("someone needs X… was not stated", `:217-224`). A PM's brief earns its place with who, what they do today instead, and the non-goals, and none of those are elicited.
- **The stack is forced.** Every greenfield spec assumes "TypeScript on Node 20" (`:126,161,182`), so "a Python script that renames photos" is told it will be TypeScript.

**The reuse survey still recommends the wrong things.** The 2026-09-22 relevance and popularity filters (`reuse.ts:177-185`) remove the specific failures they were fitted to. Today, live, they still recommend:

- `sms-segments-calculator`, `@ant-design/colors` and `media-engine` for "a calculator";
- `amazon-order-reports-api` (an Amazon scraper) for "handles refunds";
- `@emulators/stripe` (a test emulator) for "a billing service that charges customers monthly";
- `screwdriver-notifications-email` for "sends email".

Only "parses csv files" → `@fast-csv/parse` was right. Three root causes:

1. **It searches clause fragments by keyword, not capabilities.** A senior engineer would say "use Stripe Billing; don't build a billing engine", or "a calculator needs no library". Keyword overlap on a five-letter stem (`reuse.ts:65,81-87`) cannot make that call.
2. **The licence classifier is wrong for common licences** (`pm/libraries.ts:24-62`). Live, it returns *not usable* for MIT-0, Zlib, BlueOak-1.0.0, BSL-1.0, "MIT AND Apache-2.0", "Apache 2.0" and "BSD", and it classifies LGPL-3.0-or-later as "not permissive" rather than weak copyleft. **nodemailer, the standard Node mailer, is MIT-0**, so production would list it as "excluded for its licence". The same classifier drives the licence *gate* (`license_gate.ts:162`), so a card that adds nodemailer fails verification.
3. **It only searches npm.** `liveReuseDeps` hard-codes npm (`wave2.ts:175`), so a Python project is offered npm packages. PyPI is looked up by the first word only (`libraries.ts:78`).

**A non-developer cannot start a project.**

- **No first card and no generator.** There is no card zero (the ecosystem-generator step the design describes) and no generator call anywhere (grep finds nothing in `apps/` or `packages/`).
- **`init` stops at an empty directory.** It says "No gates found: add typecheck, lint and test scripts" (`init.ts:380`), which is a developer instruction.
- **Seshat cannot start one either.** It can `find_library` and `propose_create_card` (`pm/agent.ts:143-251`), but it has no plan or new-project tool.

**Compared with a senior engineer researching themselves,** the harness is more consistent: it always looks, keeps "not searched" apart from "nothing found" (`reuse.ts:159-166`), and records its findings in the brief and on each card. It is worse at judgement: build versus buy, reading a README first, ecosystem knowledge, and knowing when *not* to recommend anything. Today the Worker is told to "depend on one, or say with note why none fits" (`reuse.ts:238`) when the candidate is an SMS-segment calculator.

## 2. Drift

| Design says | Code does |
| --- | --- |
| Riskiest assumption "not yet scheduled" (HARNESS_DESIGN:1075). The design is also inconsistent with itself: "first regardless" at :1020 and "second in line" at :1026 | Scheduled right after the contract (`spidr.ts:351-371`; tested in `wave2_wiring.spec.ts`). The :1075 note is stale. |
| Web access is opt-in and off in air-gapped mode (:1985); fetching goes through the one egress path, and every request is logged (:2003, :2088) | **`plan` searches npm, GitHub, Hugging Face, arXiv and OpenAlex by default.** It checks only `--offline` and `SEKHEMET_OFFLINE` (`index.ts:699`) and ignores `config.toml [network] mode = "offline"` and the project's research-web switch, both of which `researchSources` honours (`service.ts:113-126`). It uses raw `fetch`, not `polite.ts`, and logs no queries. |
| "Only the keywords leave the machine" | `queryFor(need) \|\| need` (`reuse.ts:157`) sends the whole clause when no keyword survives. |
| A literature source that could not be reached is "not searched" | `searchPapers` swallows every error and returns `[]` (`web.ts:94-198`), so a failed literature search is reported as "nothing suitable found". |
| The first slice is a thin path through the whole backbone | `firstSlice = functional[0]`, the first comma clause (`design_stage.ts:154`). |
| Worker `ask` posts a non-blocking decision request to the Researcher; speculative Desk research fills dossiers | `ask` answers only from the card's contract (`tool_catalog.ts:362-367`, `session.ts:450`). The Desk and inbox are unwired (see §3). |
| Claim gate: executable claims are *run* on the gate host | Nothing runs claims. `runResearchCard` calls `reviewEligible(claims, new Map())` (`cards.ts:100`), so **any note with an "executable" sentence (code in backticks plus a verb like "returns") is parked**, and cannot be un-parked. |
| Static pages go through trafilatura; PDFs through pypdfium2; a BM25 corpus index; DeepResearch Bench evaluation | Static pages go through a regex `htmlToText` (`web.ts:200-216`). BM25 exists only inside `docs.ts:273`. There is no corpus, PDF path or research evaluation. |
| Research memory caches by how mutable the content is (:2180 table) | One global `~/.config/sekhemet/research/memory.jsonl`, matched on question similarity over 30 days, not scoped to repository or package version (`service.ts:50-86`). |

## 3. Dead and duplicated code

- **Dead (reached only from tests; Rule 3):** all of `research/desk.ts` (224 lines: `grade`, `lookup`, `ResearchInbox`), and `claims.ts` `adjudicate`, `renderDisagreements` and `acceptRevision`, roughly 110 lines. Together these hold the design's Desk, disagreement reporting and revision gate. Test suites exist for them (`research_desk`, `research_inbox`, `research_claims`), which is what makes them look done.
- **Library search runs through three callers, and only one filters.** `reuseSurvey` filters; Seshat's `find_library` (`pm/agent.ts:505`) and the Researcher's `find_library` (`researcher.ts:226`) do not. GitHub is searched two ways: REST `searchRepos` (`reuse.ts:108`, licence judged) and the `gh` CLI `githubSearch` (`web.ts:526`, licence a lowercase key that is never judged).
- **Two full research pipelines, chosen by model type:** generic (`research`, `investigate`, `runResearchLoop`; `researcher.ts:516,709`, `loop.ts`) and Apodex (`apodexLoop`, `apodexTeam`; `apodex_loop.ts:582,748`). They have two citation checkers: `checkCitations` only checks that `[n]` is in range (`researcher.ts:483`), while `verifyReferences` checks against the ledger (`apodex_loop.ts:364`).
- **Licence normalisation in four places:** `libraries.ts`, the PyPI classifier mapping (`:90-97`), the `searchRepos` SPDX handling, and `githubSearch`.
- **Trivia:** an orphaned doc comment, "No tracked source yet", sits on `needsOf` (`wave2.ts:105`).

## 4. Complexity hotspots

- **`researcher.ts` (905 lines):** `runResearchTool` is a roughly 210-line `if (call.name === …)` chain over about 20 tools (`:216-430`). `research()` is about 170 lines with two transports (native and flat).
- **`apodex_loop.ts` (918 lines):** `apodexTeam` is about 170 lines and `apodexLoop` about 150.
- **`wave2.ts` (1,318 lines)** is a self-described grab-bag (":73 Kept in one module…"). `planCommand` mixes design, survey, brief writing, planning and dossier linking.
- **`design_stage.ts`** is small, but its behaviour lives in five regex tables with no data or test separation.
- **The dossier link is fragile.** `coversNeed` (`wave2.ts:116`) requires the first four words of a need inside the card title. With a planning model the titles are rephrased ("Charge monthly" against the need "a billing service that charges customers monthly"), so notes never attach. This is inferred from the spec's own model fixture; I did not run it.

## 5. Test quality against DEFINITION_OF_DONE §2

- **Mocked verdicts hide a real failure.** The `reuse_survey.spec.ts` helper takes `usable` as a parameter (`:25-34`), and it feeds nodemailer as `MIT-0, usable: true`. `wave2_wiring.spec.ts` asserts "nodemailer (MIT-0) may already cover this" with `usable: true` set by hand. The production classifier says the opposite. This is the kind of test §2 warns about: it inserts a value that production computes, instead of letting production compute it.
- **Network code is tested against hand-written minimal JSON, not recorded responses.** No fixture has a missing `downloads` field, a missing or object-shaped licence, a `MIT AND`, `-or-later` or MIT-0 licence, a GitHub 403, or a papers outage.
- **Real bug that no test catches:** `libraries.ts:138` drops `weekly: 0`, and the survey lets a missing count through (`reuse.ts:180`), so a package with zero downloads skips the popularity floor.
- **`design_stage.spec.ts` has six happy paths and no negative cases:** no false-positive risk words, non-TypeScript spec, quality-words-only spec or empty spec. Some assertions are weak (`length >= 1 && <= 2`, `default.length > 10`).
- **The research tests are mechanically strong** (robots, pacing, 429, masking, reference verification), **but nothing measures research quality**: there is no golden question with a known answer.

## 6. Senior judgement, ranked

1. **Make the survey recommend the right things, or nothing.** Ask the Planner model (it is already loaded for `--planner`) for 1–3 *capability* queries per need, for example "subscription billing", "payment provider SDK" or "email sending". Enrich each candidate with deps.dev (SPDX licences, advisories, dependents). Rank with the existing BM25 (`docs.ts`) over name, description and keywords, with a popularity prior. Stay silent on "sentence"-level specs unless there is a named capability. Tell the Worker "depend on it" only after the Researcher has read the README. Measure with a labelled set of about 40 needs and their expected packages (precision@1, plus the rate of correctly saying nothing).
2. **Honour network policy and audit it.** Route the survey through `researchSources` and `polite.ts`, and write each query and result set to the event log.
3. **One licence classifier, based on SPDX.** It fixes the survey and the licence gate together.
4. **New projects by conversation.**
   - A Seshat `start_project` tool: `designStage`, then questions posted as board decisions with deadlines and defaults, then `planCommand`.
   - Card zero runs the ecosystem generator (`npm init` with `tsc --init` and vitest, `uv init`, `cargo new`) and derives the gates; card one is a failing test.
   - The runtime is detected from the spec instead of assumed.
5. **Design-stage judgement.**
   - Risk classification by the planner model, with the rules kept as fallback and word boundaries fixed.
   - The brief level asks the one highest-value question.
   - The brief's Problem, Outcome and Non-goals are written from the conversation, not a template.
6. **How research feeds planning and the Worker.** Either wire the Desk (`grade`/`lookup` behind the Worker's `ask`, plus speculative answers to cards' open questions put into dossiers before they start) or cut it with sign-off. For brief-level specs, run one deep Researcher question, "how is X usually built; pitfalls", into Prior art when memory allows.
7. **Verify research quality.**
   - A golden set of 25 software questions with checkable answers (API signatures at pinned versions, licences, release dates), scored for accuracy and citation precision.
   - Replace range-only `checkCitations` with ledger-based `verifyReferences` everywhere.
   - Either implement executable claims on the gate host or stop parking on them (the `cards.ts:100` bug).
8. **Collapse the duplicates:** one pipeline (measure generic against Apodex on the golden set, keep the winner), one GitHub search, and per-repository, per-version research memory.

## 7. Verdicts

| File | Verdict |
| --- | --- |
| `planner/src/design_stage.ts` | **Refactor**: keep the API; rules become data plus a model classifier; fix the false positives, the stack assumption and the missing brief questions |
| `research/reuse.ts` | **Refactor**: capability queries, enrichment, ranking; zero-download bug |
| `pm/libraries.ts` | **Refactor**: SPDX parsing; one classifier shared with the licence gate |
| `wave2.ts` `planCommand` | **Refactor**: extract to a planning or new-project module; replace `coversNeed` with need IDs carried on slices |
| `research/researcher.ts` | **Refactor**: tool dispatch table; pick one pipeline |
| `research/apodex_loop.ts`, `apodex.ts` | **Keep** (running on the model's training distribution is deliberate); split `apodexTeam` |
| `research/loop.ts` | **Keep or cut**, depending on the pipeline decision |
| `research/desk.ts` | **Cut or wire** (owner decision); dead today |
| `research/claims.ts` | **Refactor**: keep `extractClaims`; cut or wire `adjudicate`/`acceptRevision` |
| `research/cards.ts` | **Keep**; fix the claim-gate parking |
| `research/service.ts` | **Keep**; scope memory |
| `research/web.ts` | **Refactor**: report paper outages; better HTML extraction; drop the duplicate GitHub search |
| `sources.ts`, `polite.ts`, `docs.ts`, `deps.ts`, `repo.ts`, `searxng.ts`, `crawl4ai.ts`, `cli.ts` | **Keep** (skimmed only; low confidence) |

## Proposals (for the owner's decision; nothing added)

Maintenance figures are from registry.npmjs.org today.

| Proposal | Licence | Maintenance | Replaces or adds | Why |
| --- | --- | --- | --- | --- |
| `spdx-expression-parse` + `spdx-satisfies` + `spdx-correct` + `spdx-license-ids` | MIT; MIT; Apache-2.0; CC0-1.0 | 41.8M/wk (release 2026-07); 1.3M/wk (2025-01); 31.8M/wk (2023, stable but slow); 37.6M/wk (2026-09) | Replaces the hand-written sets and splitting in `libraries.ts:24-62` | Fixes MIT-0, Zlib, BlueOak, `AND`, `-or-later` and "Apache 2.0" in both the survey and the licence gate |
| deps.dev API v3 (Google Open Source Insights) | Free web API, no key; returned 200 today with MIT-0 for nodemailer | Terms not verified | Adds enrichment: normalised licences, advisories, dependents, repository links for npm, PyPI, Cargo, Go and Maven | Better maintenance and safety signals than stars and `pushedAt`. It is lookup, not search. |
| OpenSSF Scorecard API | Apache-2.0 project; `api.securityscorecards.dev` returned 200 | — | Adds a maintained or abandoned signal | Replaces the two-year `pushedAt` heuristic (`reuse.ts:195`) |
| `@mozilla/readability` + `linkedom` + `turndown` | Apache-2.0; ISC; MIT | 2.5M/wk (2025-03); 3.6M/wk (2026-07); 6.8M/wk (2026-04) | Replaces the regex `htmlToText` | The design's fast static-page path without a Python sidecar (the design names trafilatura, Apache-2.0, as the Python alternative) |
| `repomix` | MIT | 67k/wk, released 2026-09-21 | Adds a way to pack a candidate repository into a digest | For the Researcher's "read one before depending on it". Optional; `gh` plus `repo.ts` may suffice. |
| `uv` (Astral) and the ecosystems' own `create` and `init` | Apache-2.0 / MIT (uv) | Actively released | Card zero | What the design already chose; no template library |
| `minisearch` | MIT | 2.0M/wk (2025-09) | Adds a corpus index | *Only if* the internal BM25 in `docs.ts` cannot be generalised; prefer reusing that |

**Feature proposals:**

- capability-query generation by the planner model;
- a research golden set and a survey golden set, both run as `bake-off`-style measures;
- a Seshat `start_project` flow.

## Top 5 changes

1. **Fix what the survey recommends.**
   - *Why:* live, it recommends a Stripe emulator for billing, an Amazon scraper for refunds and an SMS-segment calculator for a calculator (§1); root causes at `reuse.ts:65-87` and `wave2.ts:175`.
   - *Effort:* M. *Risk:* medium (a model is needed for capability queries; keep a keyword fallback).
   - *Measure:* precision@1 and correct-silence rate on a labelled set of about 40 needs, before and after.
2. **Honour network policy in `plan`, and log the queries.**
   - *Why:* `index.ts:699` ignores the offline and air-gap config that `service.ts:113-126` honours; the design promises every query in the event log.
   - *Effort:* S. *Risk:* low.
   - *Measure:* a test in which `plan` on a project with `mode = "offline"` makes zero fetches, and each survey query appears as an event.
3. **Adopt an SPDX licence classifier, shared by the survey and the licence gate.**
   - *Why:* MIT-0 (nodemailer), Zlib, BlueOak and `AND` expressions are judged "not usable" (live output, `libraries.ts:24-62`, `license_gate.ts:162`); the tests hand-set `usable` to hide this.
   - *Effort:* S. *Risk:* low (needs the owner's approval for the dependencies).
   - *Measure:* a table-driven test over the 50 most common npm licence strings, and fixtures that get their verdict from the classifier rather than setting it.
4. **Start a new project by conversation.**
   - *What:* a Seshat `start_project` tool; design questions posted as board decisions with defaults; card zero via the ecosystem generator; runtime detected from the spec.
   - *Why:* `init.ts:380` dead-ends on an empty directory; there is no generator path; RUNTIME is forced (`design_stage.ts:126`); the claims table lists this as "not built".
   - *Effort:* L. *Risk:* medium.
   - *Measure:* the planning measure run on five greenfield specs (calculator, Python script, sync CLI, billing, recipe site with sign-up): gates green after card one, questions asked per spec, a non-developer transcript with no shell commands.
5. **Make research verifiable, and stop parking it wrongly.**
   - *What:* fix `cards.ts:100` (run executable claims or record them as "documented"); use `verifyReferences` everywhere; wire or cut `desk.ts` and the unused `claims.ts` functions; build a 25-question golden set.
   - *Why:* §2 and §3. The claim gate cannot pass today, and quality is unmeasured.
   - *Effort:* M. *Risk:* low.
   - *Measure:* accuracy and citation precision on the golden set; the share of research cards reaching Review, before and after.
