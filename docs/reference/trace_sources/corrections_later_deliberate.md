# Trace corrections: the later and deliberate rows

*Full re-verification of every `later` and `deliberate` row of [DESIGN_TRACE.md](../DESIGN_TRACE.md), 2026-09-25, after the [trace audit](../reviews/design_trace_audit.md). Applied to the trace and the specs by the lead.*


*Scope: the 131 `later` and 166 `deliberate` rows of DESIGN_TRACE §5 (297 rows), parsed from the working tree on top of `20dc4eb`. For each row the old text was read at its `HD:`/`IR:`/`PM:`/`FE:`/`FI:`/`R1:`/`R2:` line in the `fb59ba2` files, and the new text at every location the row names (and, where the row's location did not hold it, the rest of the design). Criteria are DESIGN_TRACE §1 as restated in the brief. "Split" means the row holds several items with different honest statuses; the new status given is the status of the part the row's key should carry, and the note names the rest. A row that is correct is not listed.*

## Trace corrections

### A. `later` rows

| Row | Old status | New status | New location | Note |
| --- | --- | --- | --- | --- |
| HD1:80 | later | carried (split) | models rule 14 (llama.cpp baseline); runtime rule 31 ("There is no background telemetry"); models §7 and context §7 (MLX) | Two of the three claims are v1 and stated: llama.cpp and zero telemetry. Only the MLX path is Later. Re-mark `carried`, naming MLX as the Later part. |
| HD1:93 | later | carried (split) | security §Air-gap kit rules 45–49 (the kit); context rule 1 (byte-identical prompt); security §7 (mirror services) | The air-gap kit is v1 (security §"Air-gap kit") and byte-identical prompts are context rule 1. Only the registry mirrors are Later. |
| HD1:271 | later | later | context §7 (learned line pruner) | Lost precision: "0.6B skimmer" and "40–60% of non-essential code lines" appear nowhere in the design. Restore (see Spec restorations, context §7). |
| HD1:276 | later | later (split) | worker-loop rule 37 (`pass_at_k` 1–4, samples 2..k at 0.4, 0.55, 0.7, each from the same starting tree, first passing sample taken; v1, built); worker-loop §7 (parallel samples, per-tier cap) | The k range and the temperature range are v1 (sequential, any tier) and should be named as carried. Only *parallel* sampling, each sample in its own ephemeral worktree, on tiers L/XL or overnight, is Later. |
| HD1:301 | later | deliberate | worker-loop rule 12 (`list_dir`, `grep_search`, `git_history` over this repository), §7 "Release notes between two versions" (reason); design-stage §2.7 rule 10 (the Researcher's `repo`: any repository, any ref, code search across GitHub, release diffs) | Tree, file at a ref and code search are v1, but for this repository only; other repositories and release diffs moved to the Researcher on purpose, with the reason in worker-loop §7 ("an `upgrade` card receives the changelog entries … from the Researcher"). That is a deliberate change of owner, not a deferral. |
| HD1:445 | later | later | planner-pm §7 (steering) | Lost precision: the old steer is delivered "as a first-class turn, ahead of tool results" and "does not rebuild the context pack". Restore (planner-pm §7). |
| HD1:446 | later | later | planner-pm §7 (steering) | Lost precision: a scope amendment is "adding or removing a file from `filesTouched` mid-card". Restore (planner-pm §7). |
| HD1:449 | later | later | planner-pm §7 (steering) | Lost precision: a steered card's outcome "is still written to the competence model, flagged as steered". §7 keeps only the exclusion. Restore (planner-pm §7). |
| HD1:475 | later | later | planner-pm §7 (Reroute); runtime §3 (the `reroute` route exists in code) | Reason missing: Explain has one ("Seshat already explains on request"), Reroute has none. Precision: the old command forces "a model **or arm**". Add the reason and "or arm" (planner-pm §7). |
| HD1:484 | later | carried (split) | planner-pm §2.11 rule 2 (`sekhemet goal` drafts restated outcome, criteria, budget from the competence model, assumptions; nothing runs until a person approves; versioned strategy); planner-pm §7 (the `/goal` chat command) | The intake itself is v1 through the CLI and API, with every old element. Only the chat command is Later. |
| HD1:497 | later | later | planner-pm §7; dashboard §7 | Wrong location in the new text: planner-pm §7 says "the dashboard shows burn-up and criteria only ([dashboard])", but dashboard has no goal criteria and no goal burn-up (its burn-up is per cycle or project: rule 13, DB-P3-14, DB-P5-1). Either add the goal summary to dashboard or correct planner-pm §7 (see Spec restorations). Also no reason for the goal view itself; FE's old reason ("once their models exist") is stale, since planner-pm §2.11 has goals. |
| HD2:41 | later | carried (split) | security rule 43 (read-only inspection, static checks by the harness, nothing from the repository executes); the structural diff preview is the Later part | Rule 43 carries restricted mode itself. Its Later clause is inconsistent: "A structural diff preview joins when difftastic does ([gates] §7)", yet review-git rule 6 already offers difftastic in v1 Review and security SEC-19a already allowlists it. The honest reason is that the difftastic read path still writes to the repository (review-git §4, RG-S5-19). Fix rule 43's sentence (see Spec restorations). |
| HD2:51 | later | carried (split) | integrations rule 8 (`forgejo` external refs), §4 "GitHub/Forgejo adapter — partial, P9", §8 Q4; integrations §7 "Forgejo beyond issues" | The Forgejo issues adapter is v1 (built, partial, P9). Only dependencies, boards and webhooks are Later. |
| HD2:72 | later | later (split) | integrations rule 12 webhook table (`/review` on a PR, v1); integrations §7 (`/plan`, `/split`, `/estimate`) | `/review` is v1 and should be named as carried. Reason missing for the other three commands. Add one (integrations §7). |
| HD2:75 | later | later | integrations §7 (`workflow_dispatch`) | Reason missing. Add one (integrations §7). |
| HD2:83 | later | later | integrations §7; review-git §7 | Reason missing in both bullets ("`openThreads`/`resolveThread` are cut until then" says what, not why). Add one (integrations §7). |
| HD2:85 | later | gap (split) | review-git §2.6 rule 7 (version from Conventional Commits, 0.y.z rule, changelog built in or by git-cliff, tag on `--confirm`), NEW-review-git-4 (RG-N4-1); planner-pm §2.15.8 (release per slice, P13); integrations §7, planner-pm §7, review-git §7 (publishing a GitHub Release) | Same finding as the audit's #124 for INV:O84. Aggregation since the last tag, the git-cliff changelog and the semver bump are v1 (partial, with change IDs). Only publishing the GitHub Release is Later. |
| HD2:104 | later | later | design-stage §7 (hosted MCP sources) | Reason missing: §7 says what (off by default, untrusted) but not why Later. The old text had the reason ("they send queries off the machine and do not exist in air-gapped mode"). Precision: Context7 was "a version-pinned documentation service … for tier 2" and DeepWiki "for public repositories". Restore (design-stage §7). |
| HD2:108 | later | carried | design-stage §2.7 rule 2 (the research cache stores each fetched page as extracted text with URL, fetch date and content hash, indexed lexically), rule 8 (BM25 retrieval over it) | Everything fetched already lands in an index that later stages read. The *persistent project corpus* and *per-question corpus* are the Later parts, and they have their own rows (HD2:127, HD2:128). |
| HD2:111 | later | later | design-stage §7 (Crawl4AI, adaptive crawl) | Reason missing. Add one (design-stage §7, Crawl4AI bullet). |
| HD2:120 | later | carried (after restoration) | design-stage §2.7 (to add: pages are read through Crawl4AI when it is installed, else the built-in polite fetcher); PROVENANCE "Page crawler (Crawl4AI)" row; design-stage §7 keeps only the adaptive crawl and question-keyed filter | Built code listed as Later, against DEC-25 R23: `apps/harness/src/research/crawl4ai.ts` runs Crawl4AI as a warm sidecar from a private venv, and `research/cli.ts:27` says "Web pages are read with Crawl4AI when installed"; PROVENANCE calls it "a separate, user-installed service" in use. design-stage §2 never states it, so it must be added there (see Spec restorations) and the §7 bullet narrowed. |
| HD2:122 | later | later | design-stage §7 (PDF extraction) | Reason missing for pypdfium2 and Docling (only trafilatura says "a proposal needing the owner's yes"). Add one (design-stage §7). |
| HD2:144 | later | later | design-stage §7 (hosted MCP sources) | Reason missing (same bullet as HD2:104). |
| HD2:147 | later | carried | worker-loop rule 12 (`docs`, `dependencies`, `git_history`, `ask`; "Web search and fetch are never Worker tools"); design-stage §2.5 rule 6 ("The Worker never searches"); gap NEW-worker-loop-4 (the non-blocking `ask`); worker-loop §7 (release diffs) | The Worker's read-only research set and its exclusion of search and fetch are v1 and stated. The non-blocking `ask` is a gap with a change ID; only the release diff is Later. |
| HD2:149 | later | later | design-stage §7 (research skills) | Reason missing. Add one (design-stage §7). |
| HD2:152 | later | later | design-stage §7 (cache expiry) | Reason missing (the audit's #122, same item as INV:X9). Precision: the old table gives a pinned commit SHA "Indefinite" and pinned-version docs "Indefinite, evicted by size"; §7 merges them so "evicted by size" reads as applying to both. Restore (design-stage §7). |
| HD2:153 | later | later | design-stage §7 (cache expiry) | Reason missing (same bullet as HD2:152). |
| HD2:157 | later | carried (split) | extensibility rule 13 (project and user scopes), rules 15 and 17 (pinned by SHA-256 and commit hash, diffed on update); extensibility §7 (a skill that declares its gates) | Scoping and versioning are v1. Only "declare any gates they add" is Later, with its reason. |
| HD2:161 | later | later | extensibility §7 (user-defined commands); extensibility rule 26 (the fixed slash commands, incl. `/research`) | Reason missing. Precision: the old commands were "invoked from the board or CLI"; `/research` dropped from §7's list because it is a built-in (rule 26), which should be said. Restore (extensibility §7). |
| HD2:205 | later | later | review-git §7; integrations §7 | Reason missing (same as HD2:83). |
| HD2:220 | later | carried (split) | gates rule 23a (Go template, built with `go build`, `go vet`, `go test`); gates §7 (Java/Kotlin template) | The audit's #108, not yet applied: the Go half is v1; Java/Kotlin is Later but gates §7 has no bullet for it (only index adapters). Add the bullet (gates §7), and in trace §3 name only the Java/Kotlin half under gates. |
| HD2:243 | later | carried (split) | extensibility rule 10 (open Agent Skills format), rule 17 (pull, pin, diff); extensibility §7 (publishing back) | The format and pulling are v1. Only publishing back is Later, with its reason. |
| HD2:245 | later | later | extensibility §7 (the skill catalogue) | Reason missing: §7 lists the sources and the mapping but never says why the catalogue is Later (the Codex admin and system scopes have their own reason). Add one (extensibility §7). |
| HD2:246 | later | later | extensibility §7 (the skill catalogue table) | The audit's #109, not yet applied. The eight *Build* rows are merged into one and their notes lost; "Frontend design guidance" lost "Sekhemet UI"; the row's "kept in full" is false. Restore the rows verbatim (extensibility §7) and add the catalogue's reason. |
| HD2:312 | later | later | dashboard §7 (native wrapper) | Reason missing. The old sentence gave it: the interface is a local web app on loopback, which runtime rule 23 still states. Add it (dashboard §7). |
| HD2:338 | later | later | review-git §7 (partial accept) | Lost precision: the remainder becomes a new card "with the rejected hunks as its spec", "rather than being discarded or silently reverted". Restore (review-git §7). |
| HD2:406 | later | deliberate (split) | runtime §3 request-body row (`cards/:id/split` takes `{parts: [{title, …}]}`, "the SPIDR strategy is the planner's"); runtime §7 (per-run budget override) | `split { strategy }` is not deferred: it was replaced on purpose by explicit parts, with the reason in runtime §3. Only `run { budgetOverride }` is Later, with its reason. |
| PMFE:308 | later | later | dashboard §7 (goal view); planner-pm §7 | Same planner-pm §7 sentence as HD1:497 (the dashboard does not show goal criteria or a goal burn-up). Reason for the goal view missing; FE's "once their models exist" is stale. |
| PMFE:534 | later | later | dashboard §7 (Retry with planner); dashboard §2.5 rule 9 (v1: only Send back and Park) | The audit called the reason weak but acceptable. `POST /cards/:id/run` itself is a v1 route (runtime §3, "`cards/:id/run` takes none"); only the Review button is Later. Add a one-line reason (dashboard §7). |
| PMFE:540 | later | later (split) | dashboard §2.16 Configuration (Registry, built: carried); dashboard §7 (master board, goal view) | Registry is v1 and should be named `carried`. Goals: reason missing (as PMFE:308). |
| INV:K10 | later | later | extensibility §7 (a plugin API designed fresh, after v1); extensibility rule 29 (plugins cut in B0, DEC-29 O4) | The audit's #120, not yet applied: the note "cut pending O4" is stale — O4 is decided (DEC-29). |
| INV:Y11 | later | carried (split) | integrations rule 8, §4 (GitHub/Forgejo adapter, partial, P9), §8 Q4; integrations §7 "Forgejo beyond issues" | R2 records the adapter as BUILT (`ForgejoIssuesAdapter`). Issues are v1; dependencies, boards and webhooks are Later. Same as HD2:51. |
| INV:Y17 | later | gap (split) | review-git §2.6 rule 7, NEW-review-git-4; planner-pm §2.15.8 (P13); integrations §7 (publishing a GitHub Release) | As HD2:85. R2 notes "Releases are a command, not a card that goes through the board and a human accept" — planner-pm §2.15.8 (release proposed per slice) is the v1 answer. |
| INV:C3 | later | later | context §7 | Lost precision, as HD1:271 (0.6B skimmer, 40–60%, on the gate host). |
| INV:X9 | later | later | design-stage §7 | The audit's #122, not yet applied: reason missing. |
| INV:O84 | later | gap | review-git §2.6 rule 7, NEW-review-git-4 (RG-N4-1); planner-pm §2.15.8 (P13); integrations §7 (publishing only) | The audit's #124, not yet applied. `gap`, not `carried`: the version rule is unbuilt (NEW-review-git-4) and releases are not tied to slices (P13). |
| INV:O89 | later | carried (split) | integrations rule 15 ("merging follows the repository's policy (auto-merge, merge queue, or a person)"); integrations §7 (`resolveReviewThread`) | Auto-merge and merge-queue awareness are v1. Only `resolveReviewThread` is Later — and its reason is missing (as HD2:83). |


### B. `deliberate` rows

| Row | Old status | New status | New location | Note |
| --- | --- | --- | --- | --- |
| HD1:78 | deliberate | deliberate | SPINE §What we claim ("**Never claim** parity with frontier models on ambiguous work…"); DEC-23 ("It does not aim to beat frontier models on ambiguous, long-horizon or novel design work, and it is slower per card than cloud tools. These trades are deliberate."); specs/README "Where the old design went" | Wrong location for the reason: the README row says only *what* was removed ("the dated competitor columns"), not why the parity claim went. The reason is in SPINE and DEC-23; cite them. |
| HD1:226 | deliberate | deliberate | context rule 17; PROVENANCE "Output condensing (RTK)" row | Reason missing: rule 17 and PROVENANCE say the binary "is never required" / "never called", not why. Add one (context rule 17, see Spec restorations). |
| HD1:375 | deliberate | deliberate | planner-pm §2.4 Small row, §9; DEC-27 (one number for card size, N5); DEC-24 | Stale note (in §4 and §5): "INVEST Small: 25% of the resolved Worker's window, 4,096 of 16,384" is no longer the rule. Now: the card's Zone 3 content fits 0.50 × (W − 2,400) = **3,792 tokens** on the reference Worker, **and** step budget ≤ 40 (`INVEST_MAX_STEPS`). |
| HD1:637 | deliberate | deliberate | measurement rule 24, §9; surface §7 | The audit's #87, not yet applied: measurement §9 still says only where the function went ("lives in `sekhemet doctor`'s playbook check and `qualify`"), not why. surface §7 also lists `sekhemet dev audit` under Later although nothing is deferred. Add the reason (measurement §9) and move the surface bullet to surface §9 (see Spec restorations). |
| HD2:170 | deliberate | deliberate | extensibility rule 28 (cut in B0, DEC-29 O4, NEW-extensibility-5), §8 Q1 (decided) | Stale note: "publish or cut is owner decision O4" — O4 is decided (cut). |
| HD2:299 | deliberate | deliberate | PROVENANCE rows "Toolchain version manager (mise)" and "Toolchain and hook managers (mise; lefthook)" | Reason missing for mise, and PROVENANCE contradicts itself: one row calls mise "a proposal for pinning toolchains per project", the other "Not used" with a reason that fits only lefthook ("Sekhemet's own git never runs hooks"). Merge the rows and give mise its reason (see Spec restorations). |
| HD2:300 | deliberate | deliberate | PROVENANCE "Container log viewer (Dozzle)" row | Stale reason: "no container runs in v1" — DEC-29 O9 approved a container image for the team server in v1 (runtime §7, surface NEW-surface-4). DevDocs and Kiwix are fine. Replace Dozzle's reason (see Spec restorations). |
| HD2:428 | deliberate | deliberate | measurement rule 28 (M0 row) and rule 28a (the pivot rule, O20), §8 Q4 | Location and residue: the pivot rule is rule **28a**, not 28, and the note still ends "— was: §8 Q4 (pivot rule proposed as a standing decision, owner)". Clean the note. |
| PMFE:221 | deliberate | deliberate | dashboard §2.11 Playbook (*Active*: rules whose paired credit is falling first); DEC-28; measurement rule 16b | Note residue: after "now in dashboard §2.11" the note keeps the pre-fix text "was: dashboard §2.11 still lists … while DEC-28 … and…". Also missing from trace §4's table (§4 has 164 rows, §1 counts 166 `deliberate`). |
| PMFE:346 | deliberate | deliberate | dashboard §2.2 rule 1 ("**Inbox** is merged into Review's *Needs you* group (its route stays and opens it)"); P11 | Reason missing, and the row says so itself ("§9 records the chord change, not a separate reason for the merge"). Add one to dashboard §9 (see Spec restorations). |
| INV:K9 | deliberate | deliberate | extensibility rule 29 (cut in B0, DEC-29 O4; no trust gate needed), §8 Q2 (decided) | The audit's #101, not yet applied, in both §4 (line 208) and §5 (line 2016): "container is reachable; trust-gated until the owner decides the cut, O4" is stale. |
| INV:E15 | deliberate | deliberate | worker-loop §9 (register R6 triaged, not in v1); security rule 4a, §8 Q1 (decided: `--validate-tools` kept and confined) | Stale note: "security §8 Q1 (recommend cutting `--validate-tools`)" — §8 Q1 is decided the other way (keep it, confined; R6 stays `triaged`, so a validated candidate never becomes a Worker tool). |
| INV:O15 | deliberate | deliberate | planner-pm §2.4 Small row; DEC-27 N5; DEC-24 | Stale note, as HD1:375: "25% of the resolved Worker's window, ≤ 40 steps" → "the card's Zone 3 content fits 0.50 × (W − 2,400), 3,792 tokens on the reference Worker, and ≤ 40 steps". |
| INV:O104 | deliberate | deliberate | DEC-25 R29 (the `relay-finisher` role dropped with the Gemini relay protocol; `suspended-quota` kept) | Stale note: "`relay-finisher` is gone with no recorded reason … — owner: DECISIONS" — R29 now records it (trace §2 says so). Also missing from trace §4's table. |

### C. The trace file itself (no spec change)

- **§3 (Moved to Later).** Rows re-marked above leave the Later list or stay only for their Later half: HD1:80, HD1:93, HD1:301, HD1:484, HD2:41, HD2:51, HD2:85, HD2:108, HD2:120, HD2:147, HD2:157, HD2:220, HD2:243, HD2:406, INV:Y11, INV:Y17, INV:O84, INV:O89. Where a row is split, either split its key (e.g. `HD2:220a` Go / `HD2:220b` Java-Kotlin) or keep one key with the status of the part the row names and say the rest in the Now-in cell — one convention for all of them. §1's totals table and §3's per-document counts change with them.
- **§4 (Deliberate changes).** It says 164 items and lists 164; §1 counts 166. Add PMFE:221 and INV:O104 (resolved in §2 but never added), and add HD1:301 and HD2:406 if they are re-marked `deliberate` as proposed.
- **§4 and §5 stale Now-in cells:** HD1:375, HD2:170, HD2:428, PMFE:221, INV:K9, INV:E15, INV:O15, INV:O104 (texts in table B).

## Spec restorations

Proposed reasons are marked *(proposed)*: they are the reviewer's reading of the design, for the owning spec's author to confirm or replace, never to be pasted unexamined. Restored old text is marked *(old text)* and is given verbatim or near-verbatim, numbers unchanged.

### context.md

**§7, "A learned line pruner" bullet** — HD1:271, INV:C3 (also HD1:217). After "**A learned line pruner** (SWE-Pruner / SWE-Pruner Pro)" insert *(old text)*:
> — the old design's task-aware skimmer, a 0.6B model that strips 40–60% of non-essential code lines from large files and observations while preserving syntactic structure, run on the gate host —

**Rule 17, "The RTK binary is never required:"** — HD1:226. Add the reason after "never required" *(proposed)*:
> — a native condenser needs no second binary installed and kept in step on every host, runs inside the harness's own tests, and records its savings per tool (below), which the binary tracked for the old design —

### planner-pm.md

**§7, "Steering a running card"** — HD1:445, HD1:446, HD1:449. Replace the parenthesis and the last sentence with *(old text, restored)*:
> **Steering a running card** (a steer: free text delivered at the next step boundary as a first-class turn, ahead of tool results, recorded as `card/steer` with its text; it does not restart the card, rebuild the context pack or invalidate the prefix — it lands in the volatile tail. A scope amendment: adding or removing a file from the card's scope mid-card, with the Worker told what changed — the intervention that saves a card which is correct but boxed in.) Abort-with-reason and send-back cover v1, and steering is never required for correctness. When built: a steer is recorded before delivery, so the transcript stays reconstructible; it cannot relax a gate, widen a permission or accept work; and a steered card's outcome is still written to the competence model, flagged as steered, and excluded from unattended pass-rate statistics.

**§7, "Reroute … and Explain"** — HD1:475. Replace "**Reroute** (force a model per card)" with "**Reroute** (force a model or arm for a card)" and append *(proposed)*:
> Reroute waits for something to route to: v1 has one qualified Worker and one fixed tool set per card class (worker-loop M2), so it returns with a second qualified Worker ([worker-loop](worker-loop.md) §7, *Escalating the model*). The `reroute` route exists in code only ([runtime](runtime.md) §3).

**§7, "Master board across workspaces and a goal view"** — HD1:497, PMFE:308, PMFE:540. Replace "Goals are CLI and API in v1; the dashboard shows burn-up and criteria only ([dashboard](dashboard.md))." — the dashboard spec shows no goal criteria and no goal burn-up — with *(proposed)*:
> Goals are CLI and API in v1 (`sekhemet goal`, `goal status`; §2.11); the dashboard shows no goal yet — its burn-up is per cycle and per project ([dashboard](dashboard.md) rule 13, §2.8). The view waits until goals are created from the dashboard: v1's non-developer home is Status, which already shows the proven slices, the burn-up and *Needs you*.

(Alternative: add a goal summary — statement, each criterion with its check and status — to dashboard §2.8 Status with an EARS criterion, and keep planner-pm's sentence.)

### design-stage.md

**§2.7 rule 2 (or a new rule after it)** — HD2:120. Add *(built behaviour, not yet in the spec)*:
> Pages are read through **Crawl4AI** when it is installed — a warm headless-browser sidecar started from a private virtual environment (`research/crawl4ai.ts`, port 11235 by default, `SEKHEMET_CRAWL4AI_HOME`), which renders JavaScript; Apache-2.0, its required credit carried with its output (PROVENANCE rule 4) — and otherwise through the built-in polite fetcher, without rendered pages.

Add a matching row to §4 (built, `crawl4ai.ts`, `research/cli.ts:27`).

**§7, "Crawl4AI" bullet** — HD2:111, HD2:120. Narrow it to what is not built, with a reason *(proposed)*:
> **Crawl4AI's question-keyed content filter, link scoring and adaptive crawl** (within a documentation site, stopping when the gathered pages answer the question rather than at a fixed depth). v1 reads the pages its sub-questions name and stops on coverage of the sub-questions (§2.7 rule 3); an adaptive crawl is admitted when the golden set shows it closes sub-questions a plain fetch leaves open.

**§7, "Cache expiry by mutability"** — HD2:152, HD2:153, INV:X9. Replace the bullet with *(old values, unchanged; reason proposed, as the audit's #122)*:
> **Cache expiry by mutability**, not by file type: a repository file or tree at a pinned commit SHA — indefinite; official API documentation at a pinned package version — indefinite, evicted by size; official API documentation at an unversioned URL — 90 days; `llms.txt` and documentation sitemaps — 30 days; papers and preprints — 30 days; blog posts, forums and issue threads — 14 days; package registry metadata — 1 day; search result sets — 1 day. A stale entry is served at once and revalidated in the background, so a stale-but-present answer never costs a build a round trip. v1 keeps the research cache without expiry: every entry carries its fetch date and content hash (§2.7 rule 2) and a person can clear it; expiry arrives with the persistent project corpus, whose lookups it serves.

**§7, "Hosted MCP sources"** — HD2:104, HD2:144. Append *(old text for the reason and the two services' roles)*:
> — off by default because they send queries off the machine and do not exist in air-gapped mode. Context7 is a version-pinned documentation service (the documentation tier); DeepWiki answers questions about public repositories; both would be wired through the MCP client as ordinary tools ([extensibility](extensibility.md) item 22). v1 reads documentation from the installed dependency and the research cache first (§2.7 rule 2).

And in PROVENANCE, row "Documentation lookup services (Context7, DeepWiki)": replace "Named by design-stage as sources; reached over the network only when the network policy allows" with "Not used: design-stage Later (hosted MCP sources)", since no code reaches either service.

**§7, "PDF extraction … trafilatura … SearXNG"** — HD2:122. Append a reason for pypdfium2 and Docling *(proposed)*: "— proposals needing the owner's yes (PROVENANCE: 'Not used: proposed'); each is a Python package, so it would run as a separate process (PROVENANCE rule 1)". Also remove "and **SearXNG** as a self-hosted provider (optional today)": §2.7 rule 11 already makes a self-hosted SearXNG a v1 provider the person configures, so listing it as Later contradicts §2.

**§7, "Research skills"** — HD2:149. Append *(proposed)*: "— a research playbook is a skill, and v1 ships the skill mechanism without a catalogue ([extensibility](extensibility.md) §7); until one exists, deep research decomposes each brief itself (§2.7 rule 3)."

### extensibility.md

**§7, "User-defined commands"** — HD2:161. Replace with *(old text plus proposed reason)*:
> **User-defined commands** as Markdown templates expanding into a card template or a planner instruction, invoked from the board or the CLI (`/onboard`, `/retro`, `/split`, `/bake-off`, `/goal`; the old list's `/research` is already a built-in, item 26). v1's commands are item 26's fixed set, which shares one implementation with the board's buttons and the CLI; a template language arrives when a person needs a command the fixed set lacks.

**§7, "The skill catalogue"** — HD2:245, HD2:246. After the sources sentence add a reason *(proposed)*:
> Later because v1 ships the skill mechanism (items 10–17) but no catalogue: every pulled skill must be read, pinned and approved by a person (item 15) and should carry an eval (EXT-27a), and none has been yet.

In the table, change the *Frontend design guidance* row's third cell to "For Sekhemet's own UI and user projects with a UI" *(old text)*, and replace the merged *Build* row with the old eight rows *(old text)*:

| Skill | Decision | What it becomes |
| --- | --- | --- |
| Repository onboarding | Build | No existing skill handles gate detection and convention extraction |
| Research card procedure | Build | Tiered lookup, citation format, budget |
| Gate authoring | Build | How to write acceptance tests the Worker cannot game |
| Card splitting (SPIDR) | Build | Encodes the decomposition rules |
| Retrospective to playbook | Build | Failure pattern to playbook entry |
| Model bake-off | Build | Runs the eval and writes the matrix |
| Visual acceptance | Build | From a mock or screenshot to a checklist of atomic checks |
| Repair from a typed failure | Build | Per gate type, a concrete repair procedure for the Worker |

### gates.md

**§7, new bullet** — HD2:220 (the audit's #108). Add:
> **A Java/Kotlin gate template** (static: javac, checkstyle; functional: JUnit; mutation: PIT when installed) — rule 23a lists it as not built. Later: its language server starts slowly, and no v1 target is a JVM project ([DEC-20](../DECISIONS.md#dec-20)).

### security.md

**Rule 43, last sentence** — HD2:41. Replace "A structural diff preview joins when difftastic does ([gates](gates.md) §7)." — difftastic already runs in v1 Review (review-git rule 6; SEC-19a) — with *(proposed)*:
> A structural diff preview joins once review-git's difftastic path writes nothing to the repository (RG-S5-19): today it can run `git add -A` or `checkout` in the repository root when the worktree is gone (review-git §4), which an audit of an untrusted repository must never do.

### integrations.md

**§7, "Comment commands … `workflow_dispatch`"** — HD2:72, HD2:75. Append *(proposed)*:
> `/plan`, `/split` and `/estimate` act on a linked card from outside the board, so they wait for one identity per item on every path and the accepter rules of a team server (items 8, 24–28); v1 takes `/review` (item 12), which creates a card rather than acting on one. `workflow_dispatch` needs a self-hosted GitHub runner on the person's machine beside the Worker's sandbox; v1 starts unattended work only from its own queue, within the declared hours ([runtime](runtime.md)).

**§7, "Review comments → repair subtasks"** — HD2:83, HD2:205, INV:O89. Append *(proposed)*:
> A repair subtask that pushes and resolves a thread would let the Worker change a PR after a person accepted the card; in v1 a person answers a PR comment by sending the card back with a note ([review-git](review-git.md) §2.4), and the card is Done only when the PR merges (item 15).

(review-git §7's "Pull-request review comments flowing back into the card thread" bullet should point to this reason.)

### review-git.md

**§7, "A human edits the work … Partial accept"** — HD2:338. Replace "**Partial accept** takes a subset of hunks and turns the rest into a new card with the reviewer's reason." with *(old text)*:
> **Partial accept** takes a subset of hunks; the remainder becomes a new card with the rejected hunks as its spec and the reviewer's reason attached, rather than being discarded or silently reverted.

### dashboard.md

**§7, "A native wrapper, an IDE extension, a TUI …"** — HD2:312. Append *(old reason, restated)*:
> The dashboard is a local web app on loopback, so it already works over an SSH tunnel and on a headless box ([runtime](runtime.md) item 23); a native wrapper adds packaging, not capability. The IDE extension and TUI are SPINE's "Not in v1".

**§7, "Retry with planner"** — PMFE:534. Append *(proposed)*: "— in v1 Send back returns the card to Ready with the person's note in the next attempt's dossier ([review-git](review-git.md) §2.4), which is the retry; a second retry path from Review would re-run without the note that makes the retry measurable. The `run` route itself is v1 ([runtime](runtime.md) §3)."

**§7, "goal view"** — HD1:497, PMFE:308, PMFE:540. Append the same reason as planner-pm §7 above, and note that Registry is built as Configuration (§2.16).

**§9, "Resolved drift and deliberate reversals"** — PMFE:346. Add *(proposed)*:
> Inbox is merged into Review's *Needs you* (its route stays and opens it) — an open decision, a parked card and a card failed after the ladder are all waiting on a person's move, and one queue sorted by wait is the list a reviewer works through; the flat navigation had 14 items (P11).

### measurement.md and surface.md

**measurement §9, "Changed on purpose"** — HD1:637 (the audit's #87). Replace "the old `sekhemet dev audit` command's function lives in `sekhemet doctor`'s playbook check and `qualify` (rule 24);" with *(the audit's wording)*:
> the old `sekhemet dev audit` command's function lives in `sekhemet doctor`'s playbook check and `qualify` (rule 24) — one fewer command at the front door (surface rule 13), and `doctor` already reads the playbook;

**surface §7, "`sekhemet dev audit`" bullet** — HD1:637. Nothing is deferred: move it to surface §9 as a deliberate change, pointing at measurement §9 for the reason.

### PROVENANCE.md

**"Toolchain version manager (mise)" and "Toolchain and hook managers (mise; lefthook)" rows** — HD2:299. Merge into one row *(reason proposed for mise, grounded in gates rule 23a)*:
> | Toolchain and hook managers (mise; lefthook) | MIT; MIT | Not used. lefthook: Sekhemet's own git never runs hooks (security item 23), and the repository's own `.githooks/` serve its development. mise: gates run a project's own tools as they are, with the team's own configuration (gates rule 23a), so the harness does not pin toolchains for a project. If removed: nothing |

**"Container log viewer (Dozzle)" row** — HD2:300. Replace "no container runs in v1" (stale since DEC-29 O9 approved a container image) with *(proposed)*: "Not used: named by the old design for container logs on service hosts; v1 runs one container on a team server (DEC-29 O9), whose logs `docker logs` already shows. If removed: nothing".

## Totals

- **Rows checked:** 297 — every `later` row (131) and every `deliberate` row (166) in DESIGN_TRACE §5, each against its old line at `fb59ba2` and its named new location.
- **Rows corrected:** 61 — 47 `later` rows and 14 `deliberate` rows. A row can have more than one fault; each is counted once below by its main fault.
  - `later`, **status wrong (18):** 13 become `carried` (HD1:80, HD1:93, HD1:484, HD2:41, HD2:51, HD2:108, HD2:120, HD2:147, HD2:157, HD2:220, HD2:243, INV:Y11, INV:O89), 3 become `gap` (HD2:85, INV:Y17, INV:O84), 2 become `deliberate` (HD1:301, HD2:406). Most are splits whose Later half stays in §7.
  - `later`, **status right but a carried half unnamed (3):** HD1:276, HD2:72, PMFE:540.
  - `later`, **reason missing (15):** HD1:497, HD2:75, HD2:83, HD2:111, HD2:122, HD2:144, HD2:149, HD2:153, HD2:161, HD2:205, HD2:245, HD2:312, PMFE:308, PMFE:534, INV:X9 (HD2:72, HD2:104, HD2:152, HD2:246, HD1:475, PMFE:540 and INV:O89 also lack one).
  - `later`, **lost precision (10):** HD1:271, HD1:445, HD1:446, HD1:449, HD1:475, HD2:104, HD2:152, HD2:246, HD2:338, INV:C3.
  - `later`, **stale note (1):** INV:K10.
  - `deliberate`, **reason missing or cited in the wrong place (5):** HD1:78, HD1:226, HD1:637, HD2:299, PMFE:346; **stale reason (1):** HD2:300; **stale or residual note (8):** HD1:375, HD2:170, HD2:428, PMFE:221, INV:K9, INV:E15, INV:O15, INV:O104. No `deliberate` row needs a status change.
- **Rates:** 47 of 131 `later` rows (36%) and 14 of 166 `deliberate` rows (8%), in line with the audit's sampled 25% (95% interval 8.7–49.1%) and 10% (1.2–31.7%). Seven of the audit's fixes in this scope are still unapplied in the tree: #87 HD1:637, #101 INV:K9, #108 HD2:220, #109 HD2:246, #120 INV:K10, #122 INV:X9, #124 INV:O84.
- **Restorations needed:** 27 — context 2, planner-pm 3, design-stage 6, extensibility 2, gates 1, security 1, integrations 2 (plus a pointer from review-git §7), review-git 1, dashboard 4, measurement 1, surface 1, PROVENANCE 3. Of these, 10 put back old text or numbers (pruner 0.6B/40–60%; steering; Reroute "or arm"; cache TTL table; hosted-MCP reason and roles; user-defined commands; the eight *Build* skill rows; Java/Kotlin template; partial accept; native-wrapper reason), 1 adds built behaviour the spec omits (Crawl4AI in design-stage §2.7), and 16 add or correct a reason or a pointer — all but the audit's wording for HD1:637 are proposals for the owning spec's author to confirm. Trace-file edits (§1 totals, §3 list, §4 list and stale cells) are listed in section C.
