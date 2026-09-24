---
spec: design-stage
status: partial
audiences: [developer, beginner, non-developer]
code: [packages/planner/src/design_stage.ts, apps/harness/src/wave2.ts, apps/harness/src/init.ts, apps/harness/src/research/reuse.ts, apps/harness/src/pm/libraries.ts, apps/harness/src/research/service.ts, apps/harness/src/research/researcher.ts, apps/harness/src/research/apodex_loop.ts, apps/harness/src/research/web.ts, apps/harness/src/research/polite.ts, apps/harness/src/research/docs.ts, apps/harness/src/research/cards.ts, apps/harness/src/research/claims.ts, apps/harness/src/research/cli.ts]
tests: [packages/planner/tests/design_stage.spec.ts, apps/harness/tests/reuse_survey.spec.ts, apps/harness/tests/wave2_wiring.spec.ts, apps/harness/tests/libraries.spec.ts, apps/harness/tests/researcher.spec.ts, apps/harness/tests/apodex_research.spec.ts, apps/harness/tests/web_research.spec.ts, apps/harness/tests/research_service.spec.ts, apps/harness/tests/research_cards.spec.ts, apps/harness/tests/research_claims.spec.ts]
changes: [P2, P7, P14, S8, NEW-design-stage-5, NEW-design-stage-1, NEW-design-stage-2, NEW-design-stage-3, NEW-design-stage-4]
---

# The design stage, new projects, and research

## 1. Purpose

Before a request has cards it has a shape, and deciding that shape is what a good project manager is for. This subsystem decides **how much** conversation a request deserves — usually none — holds that conversation the way a professional PM would, and, before any card is written, **looks for what already exists**: legally usable libraries and repositories, and the literature when the work is an algorithm. It serves the non-developer ("tell it what you want"), the beginner (a brief is what a professional writes first), and the spine: research is a role with no privileges of its own, and nothing it finds is trusted without a gate. The backlog it hands on is [planner-pm.md](planner-pm.md)'s.

## 2. Behaviour

### 2.1 Proportion: most work needs almost none of this

1. **Proportion is the default behaviour, not an escape hatch**, and the small case is the common one. The failure to design against is not an under-planned calculator; it is a person who wanted a calculator and got interviewed about success metrics. *You don't need a consultation to build a calculator.*

| The request | The design stage is |
| --- | --- |
| "Add a `--json` flag" (a small change to an existing project) | Nothing. It is a card. |
| "Build me a calculator" | One sentence saying what is about to be built, then it starts. No brief, no question. |
| "A CLI that syncs my notes to S3" | At most two questions, each about something hard to change later, each with the default that will be used. No brief: the answers are assumptions on the cards. |
| "A multi-tenant billing service" | The six things in §2.3, a real conversation, a brief, and a question about whether it is two projects. |

2. The level is chosen **before any model is loaded**, in this order: **a brief** when being wrong is expensive (money, identity or personal data at stake); **questions** when the request names an external contract hard to change once code depends on it (sync conflict rules, storage credentials, the database, the calling protocol); **one sentence** for a new project or a change large enough to restate; **nothing** for a small change to an existing project. It errs toward less.
3. The rules only *decide* the level. The Planner role's model *phrases* what is said, classifies risk (the rules are its fallback), and writes the brief's prose (NEW-design-stage-1).

### 2.2 Propose and proceed, rather than ask and wait

1. **The default move is a statement, not a question:** what is about to be built, then doing it — *"A calculator — TypeScript, Vitest, the four operations, a CLI. Starting now."* The person can redirect in the next breath.
2. **Ask only when the answer is both uncertain and expensive to get wrong** (the data model, the deploy target, the public interface, anything a second person will build on). The test is "what does being wrong cost", not "am I certain".
3. **One question at a time**, the one that most changes the backlog; then decide whether a second is still worth asking. Never a list. **A question whose answers produce the same cards is not asked**, nor one the playbook, the brief or an earlier answer already settles ([planner-pm §2.10](planner-pm.md#210-questions-and-decisions)).
4. **"Just build it" is always a complete answer, and so is silence.** Every blank takes its default, recorded as an assumption, and work starts. Collaboration is offered, never required, and never re-offered after it is declined.
5. **Nothing is blocked on the conversation.** An unanswered question stays open on the board as a decision with its default ([planner-pm §2.10](planner-pm.md#210-questions-and-decisions)).
6. It is a conversation, not a form: no step is announced, and the words "requirements", "phase" and "let me gather" never appear in what the product says.
7. **The stack is detected, not assumed.** A request that names a language or runtime ("a Python script that renames photos") is planned in it; one that names none gets TypeScript on Node with Vitest, the stack the harness verifies best, stated as an assumption.
8. **Quality words are constraints, not work.** "Fast", "secure", "scalable", "reliable", "easy to use" leave the spec that is decomposed and become constraints with a stated default (for example *secure*: secrets only from the environment, every input validated where it enters). Request phrasing ("build me", "I want") is dropped from what is built.
9. **Every default is an assumption on every card** — in the dossier the Worker reads, and logged on the epic — and its outcome is recorded when a later card keeps or contradicts it.

### 2.3 What it produces: the brief, and the project documents

For the brief level only, a **project brief** is written. Its sections:

| Section | Why it earns its place |
| --- | --- |
| **Problem** | Who it is for, what they are trying to do, **what they do today instead** (the baseline to beat). |
| **Outcome** | What is different when it works, stated so it could be checked. |
| **Non-goals** | What it deliberately does not do; lets the planner refuse scope later without re-asking. |
| **Constraints** | Stack, deploy target, appetite, depth profile (§2.8), anything fixed; the quality constraints with their defaults. |
| **Prior art** | What exists, with licences and links, and how it is usually built (§2.5). |
| **Riskiest assumption** | The thing most likely to make it not work. It becomes the card right after the contract ([planner-pm §2.2](planner-pm.md#22-slicing)). |
| **The first slice** | The thinnest path through the whole backbone that produces something real. |
| **Definition of done** | The gates, agreed here rather than discovered at the first Verify. |
| **Invariants** | Architectural rules in the form the architecture gate enforces (`` `src/db/` does not import `src/cli.ts` ``). Omitted when there are none. |

Problem, Outcome and Non-goals are written from what the person said, and say *"not stated — assumed: …"* where they said nothing; they are never a fixed template. The **backbone** is the activities a user performs, in order; the first slice is narrow and complete through all of them, not one part finished properly.

**Where the project's documents live** ([DEC-30](../DECISIONS.md#dec-30--project-documents-follow-professional-conventions), under owner decision O12). The ledger is canonical for the brief, the requirements ([planner-pm §2.15](planner-pm.md)) and the decision records (spine rule 2). On every accepted change to them, Sekhemet **exports** them as Markdown where a professional team expects them, **adapting to the layout the repository already has rather than imposing one**, and commits every generated document through the Accept path on the integration branch, so it is reviewed like code:

| Document | Where | Format |
| --- | --- | --- |
| The brief | `docs/product/brief.md` | The sections above |
| The requirements | `docs/product/requirements.md` | One `### REQ-7 — title` heading per requirement; under it a line with `version`, `kano`, `must`, `slice`, `status` (proven, passing with strength unmet, planned, unplanned, suspect or cut) and `dependsOn`; its EARS criteria; the ids of the tests that prove it (generated) |
| Architecture decisions | `docs/decisions/NNNN-title.md` (MADR's default location), or the repository's existing ADR folder — `docs/adr/` or `doc/architecture/decisions/` — when one exists, numbered after its highest record | MADR 4.0: context and problem, drivers, options, outcome, consequences, confirmation; front matter `status`, `date` and `decision-makers` (display names resolved at export time) |
| The changelog | `CHANGELOG.md` at the root | Keep a Changelog, written from accepted cards and released slices; a new version's section is added above the earlier ones, which are never rewritten (the release itself is [planner-pm §2.15.8](planner-pm.md) and [review-git §2.6.7](review-git.md)) |
| Release notes, per slice, for people | `docs/product/releases/<version>.md` | Written from the slice's proven requirements in the brief's words ([planner-pm §2.15.8](planner-pm.md)) |
| Documentation for the project's users | The repository's existing documentation folder, else `docs/` | Organised by the Diátaxis framework: tutorials, how-to guides, reference and explanation |

**`README.md` and `CONTRIBUTING.md` are the person's**: Sekhemet proposes changes to them as PM proposals and never writes them. Each generated file starts with *Generated by Sekhemet from ledger seq N; edit through Seshat or by pull request*. Files → ledger is **by proposal only**: when a merged commit changes a generated document, it is parsed, diffed against the ledger, and each difference becomes a PM proposal (the same path as a Jira CSV import, [integrations](integrations.md)); nothing changes in the ledger until a person applies one, and an applied requirement edit is a `requirement/revised` with its impact ([planner-pm §2.15](planner-pm.md)). `--no-names` writes role labels instead of people's names. **A document the person wrote themselves is never overwritten**: a file at that path without the generated header is imported as proposals instead (a person's `CHANGELOG.md` is only extended, as above). Only `config.toml`, `gates.toml` and these exported documents are meant to be tracked from Sekhemet's files ([security](security.md) owns the `.gitignore` block). Today the brief is written once to `.sekhemet/brief.md` and never updated (`wave2.ts:230-235`; NEW-design-stage-3).

### 2.4 A project that does not exist yet

1. **Card zero is the ecosystem's own generator**, never a model and never a template library of ours: `npm init` with `tsc --init` and Vitest for TypeScript, `uv init` for Python, `cargo new` for Rust, `pnpm create vite` for a web front end. Gates are derived from what it produced; the generator and its version are recorded in the brief so the scaffold is reproducible. The static layer (typecheck, lint, build) works from the first file.
2. **Card one is a failing test.** Its acceptance criterion is that the test exists, runs, and fails for the stated reason — at an assertion, not at an import ([gates](gates.md)) — verified by executing it. From card two every card has a functional gate.
3. **The ambiguous hour belongs to the conversation.** For genuinely novel architecture Seshat says *"talk it through with me, then I'll cut the cards"* rather than making a confident autonomous attempt.
4. A non-developer starts all of this with one sentence to Seshat ([planner-pm §2.9](planner-pm.md#29-starting-a-project-by-conversation)); `sekhemet init` on an empty directory offers the same path instead of stopping at "add typecheck, lint and test scripts".

### 2.5 Reuse before rebuild

The most expensive thing an agent does on a new project is write what a maintained, legally usable package already does. Whenever the design stage says anything at all (every level except *nothing*), planning looks first.

1. **What is searched.** For each *capability* the request needs, the planning model writes one to three short capability queries ("subscription billing", "payment provider SDK", "email sending"); the keyword extractor is the fallback. Sources: the package registry of the project's ecosystem — **npm** for JavaScript and TypeScript, **PyPI** for Python — and **GitHub repositories** in that language; **the literature** (arXiv, OpenAlex) only when the need is an algorithm (ranking, matching, scheduling, compression, detection, similarity, forecasting). PyPI has no search API, so Python candidates are names proposed by the model or found on GitHub, each verified against the PyPI JSON API.
2. **Only short queries leave the machine** — never the spec, the code or a whole clause. A need with no keyword left after filtering is not searched.
3. **Filters, applied before anyone sees a result:**
   - *Relevance:* a candidate shares at least two of the need's content words in its name or description; words that say what kind of thing is built ("CLI", "service", "handles") are dropped from queries.
   - *Somebody uses it:* at least 1,000 weekly downloads (npm) or 20 GitHub stars. An unknown count is not a pass.
   - *Maintained:* archived repositories and ones untouched for two years are not recommended.
   - *Licence,* by one SPDX-based classifier shared with the licence gate ([gates](gates.md)): permissive licences are recommended; weak copyleft (LGPL, MPL, EPL) is flagged; strong copyleft (GPL, AGPL) is named under exclusions so the choice is visible; code with no licence is dropped without comment; a licence the classifier cannot read is excluded and named. An `AND` expression is usable only if every part is; an `OR` if any part is.
   - *Correct silence:* when nothing passes — or the need is something no one would depend on a library for, like a calculator's arithmetic — nothing is recommended, and that is said.
4. **Candidates are worth checking, not guaranteed.** People hear *"may already cover this"*, never *"already does this"*. Before the Worker is told to depend on one, the Researcher has read its README (and, for a brief-level project, its API surface).
5. **A source that could not be reached is "not searched", never "nothing found."** The difference between "nobody has built this" and "I did not look" is the whole value of looking.
6. **Where results go.** Seshat says the best candidate per capability in one line; the brief's Prior art lists everything found with licences and links; **each card's dossier** carries what exists for the need it builds, linked by the need's id (not by matching words in its title), with the instruction to depend on it or say with `note` why none fits. **The Worker never searches**: it stays offline in its sandbox, and the choice reaches it as part of its card.
7. **For a brief-level project**, when the Researcher is configured and memory allows, one deep question — *how is this usually built, and what goes wrong* — runs before planning, and its cited answer goes into Prior art. When it cannot run, Prior art says so.

### 2.6 Network policy

1. **Research is opt-in and logged** ([SPINE](../SPINE.md#locked-for-v1): offline by default). The survey and every research fetch run only when `config.toml [network] research = "yes"` — the user's answer to the first-project question (§2.6.2), which a project may turn off for itself (`research = "no"` in its `config.toml`, or its research switch) — and never for a host in `fetch_deny`; `research` is independent of `mode`, which governs card commands and stays `offline` by default ([surface](surface.md) item 24). `--offline` and `SEKHEMET_OFFLINE=1` turn research off too.
2. **Asked once, on the first new project** (the default of owner decision [O16](../../reference/OPEN_QUESTIONS.md#owner-decisions), open; it applies until the owner decides). The first time a new project is planned on this machine with research off, Seshat asks once: *may it search public package registries and GitHub with short keywords (never your spec or code) to avoid building what already exists?* The question names what a yes changes and lists the hosts research would reach: a yes enables only the harness's own research requests, through the one network policy ([surface](surface.md) item 24), and opens nothing for a card's sandboxed commands ([security](security.md) item 29a). **Nothing leaves the machine before the answer**, and the default if unanswered is no. The answer is recorded in the user's `config.toml`, so a yes turns research on for that project and every later one without asking again; a project may still turn it off for itself (a project file may only narrow). When off, planning says *"I did not look for existing packages: research is off"*.
3. Every query and its result set is an event in the log, and every fetch goes through the one polite path (robots respected, per-domain rate limits, private and local addresses never fetched). What may be fetched is [surface](surface.md)'s one network schema: `[network] mode` (`offline`, `allowlist`, `open`), **`fetch_allow`** (domains the Researcher may read; enforced today as the allowlist, `polite.ts:344-402`, under the old key `allow`) and **`fetch_deny`** (domains never fetched, whatever `fetch_allow` or `mode` says). **With `research = "yes"`, research may reach the effective `fetch_allow`'s hosts when that list is non-empty, otherwise any public host, minus `fetch_deny`**, whatever `mode` says — so a yes never widens a list the person wrote ([surface](surface.md) item 24, [security](security.md) item 29a). **The user's `config.toml` is authoritative**; a project's `config.toml` may only add domains to `fetch_deny`, narrow `fetch_allow` and set `research = "no"`, never widen `mode`, `fetch_allow` or `research` ([security](security.md) item 28). There is no second network path ([security](security.md)).

### 2.7 Research: a role with no privileges of its own

1. Research is a registry role and a card type, not a second harness. Fetching uses the one egress path; claim execution is a gate; model selection is the router; remembering uses the event log and the research cache. **Needing a second sandbox, scheduler, cache or permission model is evidence something does not belong here.**
2. **Lookup order:** the repository and its installed dependencies at the installed version (types, READMEs, source); local documentation and `llms.txt` per dependency version; the research cache; the live web — only when the earlier tiers miss and the project allows network. **The research cache** stores each page as extracted text with its URL, fetch date and content hash, indexed lexically; the same bytes under a second URL (a mirror, a redirect target, a versioned alias) resolve to the first URL that carried them, so the corpus holds one copy and one citation (`polite.ts:286-301`). **Each entry's lifetime follows what was cached, not its file type** (`ResearchCache.ttlFor`, `polite.ts:241-258`): a page at a pinned commit SHA or a `pinned:` key never goes stale by class, search result sets and package registry metadata last 1 day, papers, `llms.txt` and documentation sitemaps 30 days, official documentation 90 days, issue threads, forums, blogs and anything unclassified 14 days — every lifetime capped at the cache's 7-day default (`polite.ts:225, 280`), so in v1 no entry is served fresh after 7 days; only fresh entries are served. **Pages are read through Crawl4AI** when it is installed — a warm headless-browser sidecar started from a private virtual environment (`research/crawl4ai.ts`, `SEKHEMET_CRAWL4AI_HOME`, port 11235 by default, bound to loopback; `SEKHEMET_CRAWL4AI=off` turns it off), which renders JavaScript and returns the page as Markdown; Apache-2.0, its required credit carried with its output ([PROVENANCE](../../reference/PROVENANCE.md) rule 4) — and otherwise through the built-in polite fetcher, without rendered pages. Either way the read passes the same robots gate, rate limits and cache (`web.ts:245`, `polite.ts:386`).
3. **Deep research** (a card labelled `research`, or `sekhemet research`): restate the question as a brief (what counts as an answer, what is out of scope); decompose into sub-questions, each with a budget; gather with sub-researchers in isolated contexts that return findings with citations, never raw pages; a sub-question **closes** when it has independent sources of sufficient tier, and one still open is re-dispatched with different queries; stop on coverage of the sub-questions, not a step count; verify; synthesise. **Effort** is `quick`, `standard` or `exhaustive`, and sets the number of sub-questions, the pages read per sub-question and the verification depth; `exhaustive` runs overnight. Today only a `--deep` switch exists (`cli.ts:17`; NEW-design-stage-4).
4. **Verification.** Claims are typed: *executable* (an API exists, has this signature, behaves this way at this version) — run as a gate in the gate host's sandbox with **no network and no repository write access** (claim scripts are untrusted input), or recorded as *documented, not reproduced* with the reason; *citational* — checked against text actually read, matched by URL or by normalised title, through one reference checker against the fetch ledger; *contested* — both positions reported with source tiers and dates, never silently flattened; *temporal* — dated by the newest source. Every claim carries its confidence and the check it survived. **The claim gate is a functional-layer gate declared in `gates.toml` and hash-pinned** like any other ([gates](gates.md)): it fails the card when an executable claim has neither a reproduction nor a recorded reason it could not be reproduced. It is not a rule the pipeline enforces on itself — a gate that lives in prose is a gate the model can reason around.
5. **Revision is gated, never self-graded.** Every draft carries a grounded risk vector measured outside the generated text: citations that point at nothing read (`badCitations`), open sub-questions (coverage), executable claims that did not reproduce, and grounding confidence from the source ledger. In deep mode one critique pass may propose a revision; it is **accepted only when no component worsens and at least one improves** (`acceptRevision`), otherwise the prior draft stands, and the pass stops when no candidate lowers the risk. Citation and coverage terms are recomputed per candidate (model-free); claims are re-run only for the sentences a revision touched. There is **no separate citation-repair pass**: a research report reaches Review when every executable claim has a verdict and no revision can lower its risk. Contested claims are reported with both positions, their source tiers and dates, and which is better supported and why (`adjudicate`, `renderDisagreements`) — never flattened into one confident sentence.
6. **What the Worker sees** is a research note: a short, cited summary with the excerpts the task needs, at a fixed budget, outside the byte-stable prompt prefix. Fetched text is always wrapped as untrusted; instructions inside it are inert. Package names found on the web are never installed without the supply-chain gate. No credentials are sent.
7. **Reproducibility.** Every query, fetch (with content hash), plan, and model and prompt version is recorded, so a run can be re-derived against its cache.
8. **Retrieval is lexical** (BM25 over heading-sized chunks, deduplicated by content hash rather than URL, weighted toward primary sources). A dense index is rejected on this machine's terms: its resident memory is what the Worker needs, the corpora are hundreds of chunks, and questions name exact identifiers ([DEC-22](../DECISIONS.md#dec-22--rejected-techniques)).
9. **The hardware envelope.** On the 24 GB reference host roles do not co-reside; the Researcher is one registry entry used for both gathering (a tool loop) and synthesis, qualified by the bake-off, not chosen by reputation. Quality comes from more passes, better retrieval and executable checks, not a larger model.
10. **Tools.** The Researcher has `search`, `fetch`, `docs`, `scholar`, `paper`, `repo`, `deps` and the project's MCP tools. Repository reading is first-class and deterministic, built on `git` and `gh`: a dependency's own source at the installed version; a repository's tree and any file at any ref; code search in a repository and across GitHub; releases and CHANGELOG entries **diffed between the installed and the proposed version**; issues and pull requests including closed ones; blame for a line range; a shallow clone into the cache when a question needs more than a few files. Results at a commit SHA are cached permanently. **The Worker's read-only research tools** are `docs`, `git_history`, `dependencies`, `ask` and `recall` (`packages/loop/src/tool_catalog.ts`), specified in [worker-loop](worker-loop.md); it never has `search` or `fetch`.
11. **Search** takes 1–6 terms per query, prefers primary sources (official docs, source repositories, standards, papers) over aggregators, and treats recency as a parameter ("the current way" versus "always true"). The web-search provider is one the person configures — a self-hosted **SearXNG** (no API keys, no query logging to a third party; AGPL-3.0, so it runs as a separate service and is never embedded, [PROVENANCE](../../reference/PROVENANCE.md)), or a Brave or Tavily key (whose provider sees the queries, which the Integrations card says); papers, page reads and GitHub work without one.

### 2.8 How deep to build: coverage does not rely on the interview

Models find about a third of the requirements people leave unsaid, and almost none of the "style" ones ([research](../../research/PROJECT_DONE_AND_DEPTH.md), ReqElicitGym). So the requirement graph ([planner-pm §2.15](planner-pm.md)) is filled from four sources, and the conversation is only one of them:

1. **The conversation** — clarifying questions (they beat open probing), each asked only when its answer changes the cards, one at a time, with a proposed default.
2. **A depth profile**, proposed from the request and confirmed with the person: *prototype*, *internal tool*, *production* or *regulated*. The profile selects which rows of a quality checklist built on ISO/IEC 25010:2023 are must-haves — functional suitability, performance, compatibility, interaction capability (including accessibility), reliability (error handling, persistence, recovery), security, maintainability, flexibility, safety — and turns each must-have row into a requirement with a test or a project-gate invariant. A calculator is a *prototype* and gets no questions; a payments service is *production* or *regulated* and gets a short conversation. The profile also sets the default appetite, **the test-strength rule a requirement must meet to count as proven** ([gates](gates.md)), and **which tests a person approves** — none for *prototype* and *internal tool*, the example tables of must-haves for *production*, every acceptance-test file and mutation waiver for *regulated* ([planner-pm §2.17](planner-pm.md)). **The *regulated* profile claims no compliance**: it selects stricter checks and more human approval, and nothing Sekhemet says or exports states that a project meets any standard or regulation — a compliance pack or any compliance claim is out of v1 ([SPINE](../SPINE.md#locked-for-v1)).
3. **Comparable products.** The Researcher finds comparable open-source projects and products (the same search as the reuse survey, §2.5) and lists their features. A feature most comparables share becomes a *must-be* candidate; a rarer one a *performance* or *attractive* candidate. Every candidate carries its sources; a feature with none — one the model imagined — is a proposal only, never a requirement, until a person accepts it.
4. **A walkthrough.** The story map is walked once from each user's point of view (Elicitron-style), and each step where the user would be stuck becomes a candidate requirement.

The person sees the candidates grouped by Kano class with must-be first, accepts, edits or rejects them, and can move the line between slices. Nothing the model proposed enters the graph without that acceptance. Each accepted requirement gets a stable id and version 1; every later accepted edit bumps the version and marks downstream links suspect ([planner-pm §2.15](planner-pm.md)).

## 3. Contract

| Item | Where |
| --- | --- |
| `Proportion`, `DesignQuestion`, `QualityConstraint`, `DesignStageResult`, `designStage(spec, ctx)` | `packages/planner/src/design_stage.ts` |
| `planCommand` (design → survey → brief → plan) | `apps/harness/src/wave2.ts` (to move to a planning module under P1) |
| `ReuseFinding`, `reuseSurvey`, `queryFor`, `needsLiterature`, `dossierNote`, `priorArtLines` | `apps/harness/src/research/reuse.ts` |
| Licence classifier (one, SPDX-based) | `apps/harness/src/pm/libraries.ts` today; shared with `license_gate.ts` |
| `ResearchService`, `researchSources` (network mode, research switch) | `apps/harness/src/research/service.ts` |
| Research answers, claims, reference checks | `researcher.ts`, `apodex_loop.ts`, `claims.ts` |
| Research cache (URL, fetch date, content hash; content-hash index) | `ResearchCache` in `apps/harness/src/research/polite.ts` |
| Brief | `.sekhemet/brief.md` today; `docs/product/brief.md` exported from the ledger (NEW-design-stage-3) |
| Project documents | The layout of §2.3 ([DEC-30](../DECISIONS.md#dec-30--project-documents-follow-professional-conventions)): `docs/product/brief.md`, `docs/product/requirements.md`, `docs/product/releases/<version>.md`, decision records in `docs/decisions/NNNN-*.md` (MADR 4.0) or the existing ADR folder, `CHANGELOG.md`; config keys overriding the product and decisions folders (new) |
| Events | `research/asked`, and (new, S8) `research/query` with `{ source, query, results, ok }`; (new) `docs/exported { seq, files }` |
| CLI | `sekhemet plan "<spec>" [--offline]`, `sekhemet research "<question>" [--deep] [--web\|--offline]` (and new `--effort quick\|standard\|exhaustive`), `sekhemet init`, `sekhemet docs export [--no-names]` (new) |
| Config | `config.toml [network] mode = "offline" \| "allowlist" \| "open"`, `fetch_allow` (the code reads the old name `allow`, renamed under [surface](surface.md) item 25) and (new) `fetch_deny` — the user file authoritative, a project file only narrowing; the research setting — the user's, recorded by the one-time question (§2.6.2), with a project switch that may only turn it off (`PUT /api/integrations/research-web`, or `research = "no"` in the project's `config.toml`); with a yes, research stays inside a non-empty `fetch_allow` (§2.6.3) |
| Seshat tools | `find_library`, `ask_researcher` today; `start_project` ([planner-pm](planner-pm.md)) |
| Dependencies approved (D5) | `spdx-expression-parse`, `spdx-satisfies`, `spdx-correct` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Four proportion levels chosen by rules, wired into `plan` | built | `design_stage.ts:135-207`, `wave2.ts:221`; `design_stage.spec.ts` | — |
| Quality words as constraints; defaults as assumptions on the epic | built | `design_stage.ts:47-72`, `wave2.ts:255-265` | — |
| Risk classification without misfires | not-built | Keyword regexes: "charging status" gets a billing brief, "password generator" an auth brief, "sign up" none (`design_stage.ts:74-91`); greedy `scale…` swallows the next sentence (`:60`, `:139`) | NEW-design-stage-1 |
| Brief asks the highest-value question; prose from the conversation | not-built | Brief level drops its questions (`:190-195`); Problem/Outcome/Non-goals are templates (`:217-224`) | NEW-design-stage-1 |
| Stack detected from the request | not-built | `RUNTIME` forces TypeScript (`design_stage.ts:126`) | NEW-design-stage-1 |
| Model phrases the design stage | not-built | Output is the rules' templates | NEW-design-stage-1 |
| Brief written once, never over an existing one | built | `wave2.ts:230-235` | — |
| Project documents exported from the ledger; edits back as proposals | not-built | The brief is a one-off file under `.sekhemet/`; no requirements or decision export | NEW-design-stage-3 |
| Card zero from the ecosystem generator; card one a failing test | not-built | No generator call anywhere; `init.ts:380` stops at an empty directory | P2 |
| Reuse survey with relevance, popularity, maintenance filters; "not searched" kept apart | partial | `reuse.ts:138-185, 223`; `reuse_survey.spec.ts` — but it recommends an Amazon scraper for refunds and a Stripe emulator for billing (live, domain08 §1); a missing download count passes (`reuse.ts:180`) | P7 |
| Capability queries; PyPI and ecosystem choice | not-built | npm hard-coded (`wave2.ts:175`); PyPI by first word (`libraries.ts:78`) | P7 |
| SPDX licence classifier shared with the licence gate | not-built | MIT-0, Zlib, BlueOak, `AND` rejected (`libraries.ts:24-62`); tests hand-set `usable` | P7 |
| Dossier linked by need id | not-built | `coversNeed` matches the first four words of a title (`wave2.ts:116`) | P7 |
| `plan` honours offline config and the research switch; queries logged | not-built | Only `--offline`/`SEKHEMET_OFFLINE` checked (`index.ts:703`); raw `fetch`; no query events | S8 |
| Only keywords leave the machine | partial | `queryFor(need) \|\| need` sends the whole clause (`reuse.ts:157`) | S8 |
| Fetch allowlist | built | `polite.ts:344-402` | — |
| Fetch denylist (`fetch_deny`), user file authoritative, project file only narrowing | not-built | No deny list in `polite.ts` | NEW-design-stage-4 |
| Research cache with content-hash deduplication | built | `polite.ts:286-315` | — |
| Cache lifetime by mutability (§2.7.2), capped at 7 days | built | `polite.ts:241-258, 280`; `research_desk.spec.ts:124` | — |
| The full expiry table: indefinite and 90- and 30-day lifetimes past the 7-day cap, eviction by size, a stale entry served while revalidating | not-built | Every lifetime is capped at the 7-day default (`polite.ts:225, 280`); no entry is ever evicted; `ResearchCache.entry` returns a stale entry (`polite.ts:265-284`) but nothing serves it or revalidates | Later (§7) |
| Pages read through Crawl4AI when installed, the polite fetcher otherwise | built | `research/crawl4ai.ts`, `web.ts:61, 245`, `research/cli.ts:27`; `research_service.spec.ts:470` | — |
| Crawl4AI's question-keyed filter, link scoring, adaptive crawl | not-built | The sidecar accepts a `query` (`crawl4ai_server.py:40-43`) but the Researcher never passes one (`web.ts:245`); no link scoring or adaptive crawl | Later (§7) |
| Deep research, `sekhemet research`, research cards | built | `researcher.ts`, `apodex_loop.ts`, `cards.ts`; `researcher.spec.ts`, `apodex_research.spec.ts` | — |
| Effort levels; sub-question closing by independent sources and re-dispatch | not-built | `--deep` only (`cli.ts:17`); no closing rule in `apodex_loop.ts` | NEW-design-stage-4 |
| Claim gate | partial | Any "executable" sentence parks the card with no way out (`cards.ts:100`); not a `gates.toml` gate | NEW-design-stage-2 |
| One reference checker against the fetch ledger | partial | Generic pipeline checks only that `[n]` is in range (`researcher.ts:483`) | NEW-design-stage-2 |
| Literature outage reported as not searched | not-built | `searchPapers` swallows errors (`web.ts:94-198`) | S8 |
| Research memory scoped to repository and package version | not-built | One global `memory.jsonl` matched on question similarity (`service.ts:50-86`) | NEW-design-stage-2 |
| Researcher tool set (search, fetch, docs, scholar, paper, repo, deps), robots and rate limits | built | `researcher.ts:216-430`, `polite.ts`, `repo.ts`, `deps.ts`; `web_research.spec.ts` | — |
| Seshat delegates evidence questions to the Researcher | built | `ask_researcher` (`pm/agent.ts:143`) | — |
| Grounded risk vector on every answer | built | `researcher.ts:55-72` (`badCitations`, `confidence`, `risk`) | — |
| Gated critique pass; contested claims reported | not-built | `acceptRevision`, `adjudicate`, `renderDisagreements` (`claims.ts:116-200`) reachable only from tests; no revision stage exists | NEW-design-stage-2 |
| Depth profile, checklist, comparables, walkthrough | not-built | No depth profile in `design_stage.ts` | P14 |
| Research Desk (`grade`, `lookup`, inbox) | not-built | `research/desk.ts` reachable only from tests | — (recommend cut; §7) |

## 5. Changes for v1

### P2 — Start a project by conversation (design side)
*Non-developers cannot start a project; there is no card zero.*

- **DS-P2-1** WHEN a new project's stack is TypeScript THE SYSTEM SHALL make card zero run the ecosystem generator (npm init, `tsc --init`, Vitest), record the generator and its version in the brief, and derive the gates from its output.
- **DS-P2-2** WHEN a new project's stack is Python THE SYSTEM SHALL make card zero run `uv init` and derive the gates from its output.
- **DS-P2-3** WHEN card zero is done THE SYSTEM SHALL make card one a test whose gate passes only when the test runs and fails at an assertion for its stated reason.
- **DS-P2-4** WHEN `sekhemet init` runs in an empty directory THE SYSTEM SHALL offer to start a project by conversation instead of printing only "No gates found".
- **DS-P2-5** WHEN the five greenfield specs (calculator, Python photo renamer, notes-to-S3 sync CLI, billing service, recipe site with sign-up) are started by a scripted non-developer conversation THE SYSTEM SHALL reach green gates after card one on each, with no shell command in the transcript.

### P14 — Depth and coverage: profile, checklist, comparables, walkthrough

Today the design stage produces a brief from the conversation alone; depth is whatever the model thought of ([research](../../research/PROJECT_DONE_AND_DEPTH.md)).

- **DS-P14-1** WHEN a new project or feature brief is started THE SYSTEM SHALL propose a depth profile (prototype, internal tool, production, regulated) with its reason, and SHALL record the person's choice.
- **DS-P14-2** WHEN a depth profile is chosen THE SYSTEM SHALL add a requirement for every quality-checklist row that profile marks must-have, each with an acceptance criterion or a project-gate invariant; a *prototype* SHALL add none.
- **DS-P14-3** WHEN a depth profile is chosen THE SYSTEM SHALL record with it the test-strength rule and the test-approval level it selects (§2.8.2), and every later card of the project SHALL use them.
- **DS-P14-4** WHEN the *regulated* profile is proposed or chosen THE SYSTEM SHALL say that it selects stricter checks and claims no compliance, and no brief, requirement, release note or exported document SHALL state that the project complies with a standard or regulation.
- **DS-P14-5** WHEN research is allowed and the request names a kind of product THE SYSTEM SHALL list comparable projects or products with their sources, and SHALL propose each feature found in at least half of them as a *must-be* candidate citing those sources.
- **DS-P14-6** WHEN a candidate requirement has no source other than a model THE SYSTEM SHALL label it a proposal and SHALL not add it to the requirement graph until a person accepts it.
- **DS-P14-7** WHEN the story map exists THE SYSTEM SHALL walk it once per named user role and SHALL record each step with no supporting requirement as a candidate.
- **DS-P14-8** WHEN the design stage asks a question THE SYSTEM SHALL ask it only if at least two of its answers produce different cards, and SHALL offer a default.
- **DS-P14-9** WHEN research is not allowed THE SYSTEM SHALL say that comparables were not searched, and SHALL not present the checklist and conversation as complete coverage.
- **DS-P14-10** WHEN a person accepts a candidate requirement THE SYSTEM SHALL give it a stable id and version 1, and SHALL never reuse the id.

### NEW-design-stage-1 — Design-stage judgement
*Keyword risk detection misfires both ways, the billing service is asked nothing, the brief is a form letter, and the stack is forced (domain08 §1). No COVERAGE id covers the conversation's quality; P2 covers only the tool.*

- **DS-N1-1** WHEN the request is "a CLI that shows my laptop charging status", "a static blog with author pages", "a password generator CLI" or "a health check endpoint" THE SYSTEM SHALL NOT choose the brief level.
- **DS-N1-2** WHEN the request is "a recipe website where people can sign up and save favourites" THE SYSTEM SHALL choose the brief level with an identity riskiest assumption.
- **DS-N1-3** WHEN the request is "build me a calculator" THE SYSTEM SHALL ask no question and say one sentence naming the four operations.
- **DS-N1-4** WHEN the level is brief THE SYSTEM SHALL ask first the one question that most changes the backlog, with its default, and planning SHALL proceed on that default while it is open; one question is the first, not the cap — WHEN a further question still changes the cards THE SYSTEM SHALL ask it after the first, one at a time, with never more than two open per planning pass ([planner-pm §2.10.1](planner-pm.md#210-questions-and-decisions)).
- **DS-N1-5** WHEN the request is "a Python script that renames photos" THE SYSTEM SHALL plan it in Python and SHALL NOT assume TypeScript.
- **DS-N1-6** WHEN a spec reads "…scale to many users. A retried charge must never charge a customer twice." THE SYSTEM SHALL keep the second sentence in the spec that is decomposed, as a hard invariant.
- **DS-N1-7** WHEN any design-stage text is shown to a person THE SYSTEM SHALL contain none of the words "requirements", "phase" or "let me gather".
- **DS-N1-8** WHEN a brief is written and the person gave no non-goals THE SYSTEM SHALL write "Not stated — assumed:" with the assumed non-goals rather than a template sentence.

### NEW-design-stage-3 — Project documents in the repository, generated from the ledger
*The brief is a one-off file under tooling state, there is no requirements or decision document, and a team cannot review requirements in a pull request or keep its reasoning if it leaves ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 14; DS-T1…T3).*

- **DS-N3-1** WHEN the brief, a requirement or a decision record is accepted or revised THE SYSTEM SHALL regenerate `docs/product/brief.md`, `docs/product/requirements.md` (each requirement with its EARS criteria, Kano class, slice and status) and the decision records as `docs/decisions/NNNN-title.md` (MADR 4.0), each headed with the ledger `seq` it was generated from, and commit them through the Accept path on the integration branch.
- **DS-N3-2** WHEN a merged commit changes a generated project document THE SYSTEM SHALL parse it, diff it against the ledger, and create one PM proposal per difference; it SHALL NOT change the ledger until a person applies a proposal.
- **DS-N3-3** WHEN documents are exported with `--no-names` THE SYSTEM SHALL write role labels instead of people's names.
- **DS-N3-4** WHEN the product or decisions folder is configured to another path THE SYSTEM SHALL export there and nowhere else.
- **DS-N3-5** WHEN a file already exists at an export path without the generated header THE SYSTEM SHALL leave it unchanged and offer its content as proposals.
- **DS-N3-6** WHEN the repository already has an ADR folder (`docs/adr/` or `doc/architecture/decisions/`) and no decisions folder is configured THE SYSTEM SHALL write each new decision record there, numbered after the highest existing record, and SHALL create no `docs/decisions/`.
- **DS-N3-7** WHEN an export would change `README.md` or `CONTRIBUTING.md` THE SYSTEM SHALL offer the change as a PM proposal and SHALL NOT write either file.
- **DS-N3-8** WHEN a release is proposed for a slice THE SYSTEM SHALL propose a section for its version at the top of `CHANGELOG.md` in the Keep a Changelog format, from the slice's accepted cards, and `docs/product/releases/<version>.md` from its proven requirements, both committed through the Accept path before the tag; every earlier section of `CHANGELOG.md` SHALL stay byte-identical.
- **DS-N3-9** WHEN Sekhemet generates documentation for a project's users THE SYSTEM SHALL file each page as one of tutorial, how-to guide, reference or explanation (Diátaxis), in the repository's existing documentation folder when one exists.

### P7 — Reuse survey by capability, with one SPDX licence classifier
*Live, the survey recommends wrong packages, rejects MIT-0 (nodemailer), and offers npm to Python projects.*

- **DS-P7-1** WHEN the licence string is `MIT-0`, `Zlib`, `BlueOak-1.0.0`, `BSL-1.0`, `MIT AND Apache-2.0`, `Apache 2.0` or `BSD-3-Clause` THE SYSTEM SHALL classify it permissive in both the survey and the licence gate.
- **DS-P7-2** WHEN the licence is `LGPL-3.0-or-later` or `MPL-2.0` THE SYSTEM SHALL classify it weak copyleft and flag it; WHEN it is `GPL-3.0-only` or `AGPL-3.0` THE SYSTEM SHALL exclude and name it; WHEN it is absent THE SYSTEM SHALL drop the candidate silently.
- **DS-P7-3** WHEN the survey and licence-gate tests run THE SYSTEM SHALL compute every `usable` verdict with the production classifier, never from a fixture value.
- **DS-P7-4** WHEN a candidate's weekly download count is missing or zero and it has fewer than 20 stars THE SYSTEM SHALL NOT recommend it.
- **DS-P7-5** WHEN the project is Python THE SYSTEM SHALL search PyPI (by verified name) and GitHub in Python, and SHALL NOT query npm.
- **DS-P7-6** WHEN the need is "a calculator" THE SYSTEM SHALL recommend no package and say that none is needed.
- **DS-P7-7** WHEN the labelled set of about 40 needs is run THE SYSTEM SHALL record precision@1 and the correct-silence rate, and both SHALL be no lower than the pre-change baseline recorded on the same set.
- **DS-P7-8** WHEN a planning model rephrases card titles THE SYSTEM SHALL still attach each need's findings to the card built for that need.
- **DS-P7-9** WHEN Seshat's `find_library` or the Researcher's `find_library` returns candidates THE SYSTEM SHALL have applied the same relevance, popularity, maintenance and licence filters as the survey, and SHALL judge GitHub results with the same classifier whichever search path found them.
- **DS-P7-10** WHEN the level is brief, the Researcher is configured and no card is running THE SYSTEM SHALL write one cited deep answer to Prior art; otherwise Prior art SHALL say the deep question did not run and why.

### S8 — `plan` honours offline mode and the research setting, and logs its queries
*The local-first promise.*

- **DS-S8-1** WHEN `config.toml [network] research` is not `yes`, or the project's research switch is off, or `--offline`/`SEKHEMET_OFFLINE=1` is set, THE SYSTEM SHALL make zero network requests during `sekhemet plan` and say that it did not look; WHEN `research = "yes"`, `mode = "offline"` and `fetch_allow` is empty THE SYSTEM SHALL let research fetch a public host not in `fetch_deny` while every card command still has no route out.
- **DS-S8-2** WHEN research is off and the first new project on this machine is planned THE SYSTEM SHALL ask once whether to enable it, naming each host a yes would allow, make no network request before the answer, take no as the default, and record the answer in the user's `config.toml` (O16's default).
- **DS-S8-6** WHEN a person answered yes on an earlier project THE SYSTEM SHALL NOT ask again on a later new project, and its survey SHALL run; WHEN a project's own configuration turns research off THE SYSTEM SHALL make no research request for that project.
- **DS-S8-7** WHEN `research = "yes"` and the effective `fetch_allow` is non-empty THE SYSTEM SHALL fetch for research only from its hosts (and their subdomains) not in `fetch_deny`, and SHALL refuse and log a fetch to any other host, whatever `mode` says ([security](security.md) SEC-52b, [surface](surface.md) SUR-48c).
- **DS-S8-3** WHEN the survey sends a query THE SYSTEM SHALL append a `research/query` event with the source, the query text and the result names, and the query SHALL contain no word that is not in the need's keyword set.
- **DS-S8-4** WHEN a need has no keyword left after filtering THE SYSTEM SHALL NOT send a query for it.
- **DS-S8-5** WHEN the papers source errors THE SYSTEM SHALL report literature as "not searched (unreachable)", never as "nothing found".

### NEW-design-stage-2 — Research that can be verified and does not park wrongly
*The claim gate cannot pass, citation checks differ by pipeline, memory leaks across repositories, and research quality is unmeasured (domain08 §2, §6.7). Not in COVERAGE.*

- **DS-N2-1** WHEN a research answer contains an executable claim that was not run THE SYSTEM SHALL record it as "documented, not reproduced" with the reason and let the card reach Review.
- **DS-N2-2** WHEN an executable claim has neither a reproduction nor a recorded reason THE SYSTEM SHALL fail the claim gate, which SHALL be declared in `gates.toml` and covered by the gate contract's hash.
- **DS-N2-3** WHEN a claim script runs THE SYSTEM SHALL run it in the gate host's sandbox with no network and no write access to the repository.
- **DS-N2-4** WHEN any research pipeline checks citations THE SYSTEM SHALL check each against text actually fetched and recorded, matched by URL or by normalised title, and strike or flag a citation that points at nothing read.
- **DS-N2-5** WHEN a cached answer was recorded for another repository or another installed version of the package in question THE SYSTEM SHALL NOT reuse it.
- **DS-N2-6** WHEN a critique pass proposes a revision that raises `badCitations` or the count of unreproduced executable claims THE SYSTEM SHALL keep the prior draft; WHEN it lowers one component and raises none THE SYSTEM SHALL accept it; WHEN no candidate lowers any component THE SYSTEM SHALL stop.
- **DS-N2-7** WHEN every executable claim in a research report has a verdict and no candidate revision lowers its risk THE SYSTEM SHALL move the card toward Review, with no separate citation-repair pass.
- **DS-N2-8** WHEN two sources disagree on a claim THE SYSTEM SHALL report both positions with their source tiers and dates and name the better-supported one with its reason.
- **DS-N2-9** WHEN the research golden set (25 software questions with checkable answers: API signatures at pinned versions, licences, release dates) runs THE SYSTEM SHALL record accuracy and citation precision per pipeline, versioned with the set's hash; WHEN one pipeline's accuracy is lower than another's by a difference an exact paired test on the set rejects at 0.05 THE SYSTEM SHALL route research questions to the better pipeline by default and mark the other "not recommended" in `doctor` (removing its code is a workstream decision, not system behaviour).

### NEW-design-stage-5 — The Researcher asked early, with the card in hand

The repair batch asks the Researcher with only the error text and a hard-coded "TypeScript project", after the repair plans are written, and keeps 500 characters of its answer as an unscoped candidate ([integration review](../../reference/reviews/integration_review_2026-09-18.md) B6).

- **DS-N5-1** WHEN the Researcher is asked about a failing card THE SYSTEM SHALL pass the card's spec, criteria, scope files, the failing gate's typed failure and the project's detected stack, never a hard-coded language.
- **DS-N5-2** WHEN a repair plan is to be written for a card whose failure prompted research THE SYSTEM SHALL run the research first and give its cited answer to the plan's author.
- **DS-N5-3** WHEN a research answer is recorded for a card THE SYSTEM SHALL store it whole on the card's dossier (`card/research`), scoped to that card, not truncated.

### NEW-design-stage-4 — Deep research that says how hard it looked
*Effort is a single switch, a sub-question has no closing rule, and a project cannot exclude a domain (old design §Web research, trace hd2 rows 110, 112, 119).*

- **DS-N4-1** WHEN `sekhemet research --effort quick|standard|exhaustive` runs THE SYSTEM SHALL record the effort with the answer and use that effort's recorded caps on sub-questions, pages per sub-question and verification depth; `exhaustive` SHALL be refused while a card is running and offered for the overnight window instead.
- **DS-N4-2** WHEN a sub-question has sources from fewer than two independent hosts of primary or secondary tier THE SYSTEM SHALL keep it open and re-dispatch it once with different queries before reporting it as uncovered.
- **DS-N4-3** WHEN a domain is in `[network] fetch_deny` in the user's or the project's `config.toml` THE SYSTEM SHALL refuse every fetch from it and its subdomains, even when it is also in `fetch_allow` or `mode` is `open`, and say which file and rule refused it.
- **DS-N4-4** WHEN a project's `config.toml` adds a domain to `fetch_allow` that the user's `fetch_allow` does not contain, or sets a wider `mode`, THE SYSTEM SHALL ignore that widening, fetch nothing from the domain on its account, and report it.

## 6. v1 acceptance

All criteria in §5, plus:

- **DS-1** WHEN the request is "add a --json flag" to an existing project THE SYSTEM SHALL say nothing and produce exactly one card.
- **DS-2** WHEN the level is brief and a brief the person wrote already exists THE SYSTEM SHALL leave it unchanged.
- **DS-3** WHEN a person answers "just build it" to a question THE SYSTEM SHALL take every remaining default, record each as an assumption, and not ask again in that project.
- **DS-4** WHEN a design-stage question is unanswered THE SYSTEM SHALL still create the cards on the default.
- **DS-5** WHEN a quality word appears in the request THE SYSTEM SHALL create no card for it and record it as a constraint with its default.
- **DS-6** WHEN a survey candidate is shown to a person THE SYSTEM SHALL phrase it "may already cover this".
- **DS-7** WHEN the Worker runs a card THE SYSTEM SHALL offer it no web search or fetch tool; findings reach it only through the dossier.
- **DS-8** WHEN the same page body is fetched under two URLs THE SYSTEM SHALL keep one cache copy and cite the first URL.

- P14: every criterion above passes; on the golden briefs of measurement.md (implicit-requirement recall), recall is recorded against the conversation-only baseline.

## 7. Later

- **The Research Desk** (lookup / question / deep grades on a second slot of the Worker's server, same weights, no additional memory: Lookup in seconds with no model, Question in 1–3 minutes as a short tool loop, Deep promoted to a research card with the asker told; `ask` as a non-blocking request answered by the Researcher at a later step boundary; **`plan_research(card)`**, the Planner's tool that writes a card's open questions and has them answered before the card starts — this spec owns it, [extensibility](extensibility.md) links here; prefetching each package's `llms.txt` or doc sitemap at project open, pinned to the installed version; measuring the Desk on latency per grade and on how often an answer reaching a Worker was later contradicted by the code). `research/desk.ts` is reachable only from tests. **Recommendation: cut it now** (git keeps it) and re-propose it with a measurement once the survey and the golden set exist. In v1 the Worker's `ask` answers from its card's contract (spec, *Done when*, rules), and when nothing there matches and the PM is available, Seshat answers now ([worker-loop](worker-loop.md) owns `ask`); research reaches the Worker through the dossier.
- **Cache expiry by mutability, in full:** a repository file or tree at a pinned commit SHA — indefinite; official API documentation at a pinned package version — indefinite, evicted by size; official API documentation at an unversioned URL — 90 days; `llms.txt` and documentation sitemaps — 30 days; papers and preprints — 30 days; blog posts, forums and issue threads — 14 days; package registry metadata — 1 day; search result sets — 1 day. A stale entry is served at once and revalidated in the background, so a stale-but-present answer never costs a build a round trip. v1 classifies entries this way but caps every lifetime at 7 days and serves only fresh entries (§2.7 rule 2). Later because the lifetimes past 7 days need eviction by size, which the cache does not have (no entry is ever removed), and serving stale while revalidating was written for the Research Desk, which never used it and is recommended for cutting (above); both arrive with the persistent project corpus (below), whose lookups they serve. Until then a person can clear the cache, and every entry carries its fetch date and content hash.
- **Hosted MCP sources** (Context7, DeepWiki), and answers from any external MCP research service: off by default, untrusted like fetched pages, weighted below primary sources, never the only source of a verified claim — off by default because they send queries off the machine and do not exist in air-gapped mode. Context7 is a version-pinned documentation service (the documentation tier); DeepWiki answers questions about public repositories; both would be wired through the MCP client as ordinary tools ([extensibility](extensibility.md) item 22). v1 reads documentation from the installed dependency and the research cache first (§2.7 rule 2).
- **PDF extraction** (pypdfium2 default, Docling for scanned or table-heavy pages; PyMuPDF4LLM never default and never distributed, AGPL, though a person may enable it on their own machine), **trafilatura** or `@mozilla/readability` for static pages (a proposal needing the owner's yes). pypdfium2 and Docling are also proposals needing the owner's yes ([PROVENANCE](../../reference/PROVENANCE.md): *Not used: proposed*), and each is a Python package, so it would run as a separate process (PROVENANCE rule 1). A self-hosted SearXNG is not Later: it is a v1 provider the person configures (§2.7 rule 11).
- **Evaluation on DeepResearch Bench** (RACE, FACT, executable-claim pass rate, disagreement recall), with the old targets kept for when it runs: parity on RACE, above parity on FACT. v1 measures on the 25-question golden set.
- **deps.dev and OpenSSF Scorecard enrichment** — proposed, needs the owner's yes.
- **Research skills**: research playbooks as Agent Skills (evaluating a library upgrade, triaging a CVE, comparing two implementations, checking whether a paper's technique is worth adopting), supplying sub-questions, source preferences and the report's shape ([extensibility](extensibility.md) owns skills) — a research playbook is a skill, and v1 ships the skill mechanism without a catalogue ([extensibility](extensibility.md) §7); until one exists, deep research decomposes each brief itself (§2.7 rule 3).
- **Deep-research plan approval**: the sub-question plan with a budget each, posted as a decision request (approve, edit, narrow) with a deadline and safe default while the card stays in Planning, never Review. v1 runs the plan without that stop.
- **A persistent project corpus** over dependency documentation, refreshed when the manifest changes, and a per-question corpus for each deep run so synthesis can quote a source long after it left context. v1 keeps BM25 inside `docs.ts`.
- **Crawl4AI's question-keyed content filter, link scoring and adaptive crawl** (within a documentation site, stopping when the gathered pages answer the question rather than at a fixed depth). Crawl4AI itself reads pages in v1 (§2.7 rule 2); its sidecar already accepts a question for the filter, but the Researcher does not pass one. v1 reads the pages its sub-questions name and stops on coverage of the sub-questions (§2.7 rule 3); an adaptive crawl is admitted when the golden set shows it closes sub-questions a plain fetch leaves open.
- **Two-way live editing of project documents.** v1 is export plus proposals on merge; a live editor would make files a second writer, against spine rule 2.

## 8. Open questions

1. **Offline by default versus research before building** — owner decision [O16](../../reference/OPEN_QUESTIONS.md#owner-decisions), open. SPINE locks "offline by default; research opt-in"; the code searches by default; the owner wants research before anything is built. *Recommendation, written into §2.6.2 and the default until decided:* ask once, on the first new project; a yes turns research on for every later project, and nothing leaves the machine before it.
2. **Who reads a candidate's README before the Worker is told to depend on it** when no Researcher is configured? *Recommendation:* the planning model reads the README fetched through the same path, and without either the dossier says "unread candidate: check before depending on it".
3. **The project-documents layout, and which branch the exported documents are committed on** (research decision 14; owner decision O12). *Decided* ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O12, [DEC-30](../DECISIONS.md#dec-30--project-documents-follow-professional-conventions)): the professional layout of §2.3, adapting to an existing one, every generated document committed through Accept on the integration branch, so the documents at any commit describe the code at that commit. This replaces the earlier default, `docs/project/`.
4. **Stub-kill blocking from *internal tool* up, or only from *production*** (research TESTS_BROWNFIELD §6.1) is selected by the depth profile here but decided in [gates](gates.md). *Recommendation:* from *internal tool*, as the research recommends.

## 9. Evidence and rationale

- Review: [domain08_design_research.md](../../reference/reviews/domain08_design_research.md) (live survey output, the licence misclassifications, the risk misfires).
- Planner interplay and the invariant bug: [domain07_planner_pm.md §6](../../reference/reviews/domain07_planner_pm.md).
- The competitive landscape: Linear Agent already serves non-technical teammates, and Kiro, GitHub Spec Kit, BMAD and Taskmaster all turn specs into tasks — so the edge here is **proportion** (BMAD alone sizes its loop to the change) and **reuse with licences before building**, on a local model; Backlog.md is the closest local-first card anatomy — [WEB_RESEARCH group C §6](../../research/WEB_RESEARCH_2026-09.md#6-competitive-landscape) and its gap analysis. NN/g on help and empty states (§7) shapes the one-sentence default and the `init` path.
- Project documents in the repository (§2.3): Kiro's `requirements.md`, Spec Kit's `spec.md`, Backlog.md's task files and MADR 4.0 show the category has converged on Markdown in the repo, reviewed in pull requests; ledger → files by generation and files → ledger by proposal keeps spine rule 2 — [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) §2.4, decision 14. MADR is adopted as a text format only (MIT OR CC0); `adr-tools` (GPL-3.0, dormant) is rejected. The layout — `docs/product/`, MADR's default `docs/decisions/` or an existing ADR folder, Keep a Changelog's `CHANGELOG.md`, Diátaxis for user documentation, and `README.md` and `CONTRIBUTING.md` left to the person — is [DEC-30](../DECISIONS.md#dec-30--project-documents-follow-professional-conventions).
- Depth profile selects test strength and approval (§2.8.2): [DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) §3.1 and decision 6.
- Gated revision (§2.7.5): no gate that reads only the generated transcript can improve uniformly; a grounded gate can — SRMA (arXiv 2609.02750) accepted 6.2% harmful memory proposals when grounded, 34.5% when self-gated, 100% free-form; Repo-To-Skill's verify stage as the admission rule for skills — [PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md) batch 1, which also found nothing in batch 2 that changes this section.
- Research techniques move through the [RESEARCH_REGISTER](../../research/RESEARCH_REGISTER.md) lifecycle with a threshold set before benching; a dense index (R11) and self-refine loops (R9) are rejected there. The old design's research embeddings (Qwen3-Embedding with a reranker) are withdrawn for the same reason (DEC-22).
- Proportion was built from a measurement: before it existed a calculator, a sync tool and a billing service all got two to seven identical-shaped cards, including "Secure: happy path" and a calculator titled "Me a calculator".
- **Rejected:** a library of project templates (worse than the ecosystem's own, and rots); a dense retrieval index on a 24 GB host; research with its own sandbox, scheduler or network path.
- **Resolved drift:** the riskiest assumption is scheduled right after the contract (the code), not "first regardless" — the contract fixes the names the riskiest card's test imports; the "not yet scheduled" note was stale. The brief moves from "written once to `.sekhemet/brief.md`, never over an existing one" to a document regenerated from the ledger on every accepted change — a brief that never updates drifts from the requirements it seeds; a person's own file is still never overwritten. The exported documents move from one `docs/project/` folder to the layout a professional team expects (DEC-30, owner decision O12): a folder of our own naming would be one more convention a team has to learn. The Worker's research tools are named as the code names them (`git_history`, `dependencies`), not `deps_source` and `repo`. The Worker's `ask` answers from the contract and Seshat in v1, not the Researcher, because the Desk that would answer it is cut. The network keys are surface's one schema — `[network] mode`, `fetch_allow`, `fetch_deny`, the user's file authoritative — not a design-stage `allow`/`deny` pair; two names for one policy is how a project file widens it by accident (review M14). A brief-level conversation starts with one question and may continue; "exactly one" was a floor misread as a cap (review m10).
