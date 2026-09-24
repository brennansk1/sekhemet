# Design v3 — independent review

*Reviewer: a separate Claude Opus 5.5 instance whose only job was critique (brief: `review_brief.md`). Read-only against the code; no pnpm/tsc/vitest run. The review began while COVERAGE, the plan and SPINE were still being edited (they changed at 23:47 on 2026-09-22); the tree was then committed as `c8cd903`, and each finding was re-checked against the committed text. Line numbers are as of `c8cd903`.*

*Scope: SPINE, DECISIONS, NAMING, PM_CONTRACT, the fifteen specs, DEFINITION_OF_DONE v3, MODERNIZATION_PLAN, COVERAGE, OPEN_QUESTIONS; spot-checks of `built` claims against the code; the research files named in the brief.*

Severity: **blocker** — the design is not ready for spec-driven development (DoD §5.2 or the plan's A.5 exit) until it is fixed; **major** — a contradiction or gap a workstream would trip over, or a criterion that cannot become a failing test; **minor** — wording, numbering, staleness.

---

## Blockers

### B1. `DESIGN_TRACE.md` does not exist, so "nothing lost" is unproven
- **Evidence:** `specs/README.md` rule 6 ("Anything left out is recorded in [DESIGN_TRACE.md](../../reference/DESIGN_TRACE.md)"); MODERNIZATION_PLAN A.5 exit 4 ("DESIGN_TRACE.md traces every capability … of the old design, its companions and the three feature inventories"). `ls docs/reference/` at `c8cd903` has no such file; `find . -name "DESIGN_TRACE*"` finds nothing. The trace material exists only in the lead's session scratchpad (`trace_hd1.md`, `trace_hd2.md`, `trace_inv.md`, `trace_pm_fe.md`), which is not in the repository and will be lost with the session.
- **Why it blocks:** the owner's condition for this stage ("nothing lost and nothing shallower") and the plan's exit 4 both rest on this file. Specs cite its rows as evidence ("trace hd1 146", "traces hd1 214, 215, 228", "trace hd2 rows 110, 112, 119", "inventory G16", "inventory H15" — in context, gates, kernel, worker-loop, surface, runtime, dashboard, design-stage, planner-pm, measurement), so those citations resolve to nothing.
- **Fix:** commit the trace as `docs/reference/DESIGN_TRACE.md` (one row per old-design/inventory item: source, where it now lives, carried / carried-weaker / later / cut, and the owner's decision for anything not carried), and make every "trace hdN row" / "inventory Xn" citation an anchor into it. Until then the A.5 exit is not met.

### B2. The "rulings" R1–R27 that specs cite as authority are not in the repository
- **Evidence:** specs cite "ruling R1" … "ruling R27" at least 30 times (e.g. R6 in integrations §2 item 5 and OPEN_QUESTIONS; R7 in security §9 "Why the weights rule changed"; R12 in measurement §9 and context NEW-context-4; R13 in surface item 14; R14/R16 in extensibility; R15 in dashboard §8 Q3; R20 in worker-loop, context, models; R23 in runtime and context). They are defined only in the lead's scratchpad (`rulings.md`, headed "Lead's rulings for the fix pass"), not in DECISIONS.md or anywhere under `docs/`.
- **Why it blocks:** specs/README rule 1 says decisions live in DECISIONS.md, and DoD §5.2.4 requires each spec to contradict no decision record. Several rulings *are* decisions that change earlier design or even owner-visible behaviour — R6 (mid-card external edits never pause a card), R7 (weights downloadable by explicit command, reversing "never downloaded"), R12 (probation in production, isolation in measurement), R13 (no flag rewrites flags), R15 (model id out of the PM header, which the owner once asked to see) — and a reader cannot tell which were the lead's and which the owner's.
- **Fix:** add a "Lead rulings of 2026-09-22" section to DECISIONS.md (or DEC-25 with a table), one row per ruling with its decision, reason and "reopen if"; mark the ones that need the owner's confirmation (at least R7 and R15) and list those in OPEN_QUESTIONS.

### B3. Three vocabularies for "card kind", and the change-kind field is named three ways
- **Evidence:**
  - NAMING.md:25 — "Card kinds | Contract · Storage · Flow · Rules · Research · UI · Wiring; for existing code Feature · Fix · Characterize · Refactor · Upgrade".
  - NAMING.md:26 — "**Change kind**: what a card does to existing code — build, characterize, refactor, upgrade … separate from its card kind".
  - models.md rule 31 and the code (`packages/kernel/src/card_class.ts:34-41`) — "`kind` is one of seven, closed: `spike`, `interface`, `implement`, `data`, `rule` (the SPIDR five) and `review`, `research`"; worker-loop rule 10 selects tools on these.
  - planner-pm §2.2.1 — "SPIDR … **I**nterface (the *user* interface)"; §2.2.2 "A contract card (types, interfaces, schema) is an *enabler task*, labelled `Contract`, not presented as a SPIDR story"; §9 "SPIDR *Interface* is the user interface … type contracts are a `Contract` enabler card". But the kernel's `interface` kind is "a type, signature or contract" and gates GT-8 treats an `interface` card as types-only.
  - planner-pm §2.16.1 calls `feature`/`fix`/`characterize`/`refactor`/`upgrade` "Card kinds for code that already exists … every planned card has one kind"; §3 "card kinds `feature`, `fix` …"; gates rule 6b and §8 Q3 call the same values a **change kind**, "a separate field from `cardKind`", field name `change` pending the owner. NAMING says the change kinds are "build, characterize, refactor, upgrade" (no `feature`, no `fix`).
- **Why it blocks:** the kind selects the Worker's tools (worker-loop WL-M2-1 refuses a class with no `CLASS_TOOLS` entry), the red/green rule (gates NEW-gates-8) and rule scoping (context CX-N4-2). Three incompatible enumerations mean the first workstream to touch any of them must invent the answer — the "three incompatible partitions" defect `card_class.ts` itself warns about.
- **Fix:** one table in NAMING with two fields: `kind` (the seven code values, with display names; say explicitly whether SPIDR "Interface" is the UI slice or the `interface` type-contract kind, and rename one) and `change` (`feature`, `fix`, `characterize`, `refactor`, `upgrade`). Update NAMING:25–26, planner-pm §2.2 and §2.16, and remove "Contract · Storage · Flow · Rules · UI · Wiring" or map each to a stored value. Decide gates §8 Q3 now (it is a field name, not a behaviour).

### B4. Terminology of the run itself contradicts between NAMING and worker-loop
- **Evidence:** NAMING.md:26 — "**Step**: one model call … a 'turn' in the code is a step … **Sample**: one of several attempts compared by the gates. The old design's use of *turn* for all the steps of an attempt is retired." worker-loop.md §3 Terms — "A **turn** is one model request … the code also stores it as a *step* … A **sample** is one session of turns … An **attempt** is one recorded run of the card, holding one sample, or up to k with `pass_at_k`. The old design used *step* for one request and *turn* for a whole attempt; that meaning is retired (NAMING keeps the pair)."
- NAMING makes *step* canonical and a sample one of several attempts; worker-loop makes *turn* canonical and an attempt contain samples — the containment is inverted, and each says the other's old meaning is retired. The step budget, `attempt/finished`, pass@k statistics (measurement rule 10: pass@k and pass^k per card) and every EARS criterion that says "turn" or "attempt" depend on this.
- **Fix:** pick one hierarchy (recommend: attempt ⊃ sample ⊃ step, with "turn" as a code-only synonym of step) and state it once in NAMING; make worker-loop §3 link to it; sweep specs for "turn" in criteria (WL-2, WL-M3-*, CX-M8-*, context rule 3).

### B5. The core's context budget is arithmetically infeasible
- **Evidence:** context rule 10 — "Zone 1 ≤ 0.12W … The system prompt stays under 1,000 tokens and the tool interface under 2,000", and rule 10b — native tool schemas "count against Zone 1". worker-loop rule 22 — W for the Worker is "9,984 tokens" (16,384 − 4,096 − 2,048 − 256). 0.12 × 9,984 = 1,198 tokens, but the two sub-caps allow 3,000, and COVERAGE M2 measured the tool index alone at 14% of the prompt (~1,400 tokens) before schemas. At the reference host's W the Zone-1 assertion that CX-N2-1 makes mandatory "at any W" will fail on every prompt, or the sub-caps are meaningless.
- **Why it blocks:** B2.1 is the first measured workstream and NEW-context-2 turns this into a hard assertion on the live path.
- **Fix:** derive the zone budgets from the reference W: either raise Zone 1 to a fixed token budget (e.g. ≤ 2,400 tokens including native schemas, asserted) or cap the tool interface at ~700 tokens (twelve flat tools, WL-M2-3) and system prompt at ~500. State the numbers for W = 9,984 as a worked example in context rule 10, and add a criterion that the assertion holds for the reference Worker's real prompts.

### B6. Self-improvement admission cannot fire, and the specs disagree on who admits a rule
- **Evidence:**
  - measurement rule 11 — "the 30-card suite claims only effects of **at least 20 points**"; rule 19 / MS-T8-2 — admission "only if a one-sided exact test rejects 'no gain' at 0.05" over two paired runs; rule 17 — "every proposal, whatever produced it, is scored against the frozen suite before it takes effect".
  - context rule 24 — "A rule starts as a candidate and is in force only when a person approves it"; rule 24f / CX-N4-7 — execution-verified lessons applied **on probation** in production without that approval; planner-pm §2.13.2 — "a rule is promoted only when … its A/B on held-out fixtures … *and* a person approves"; PM_CONTRACT §6 — "a candidate becomes active only after human approval"; measurement rule 24 / MS-N2-2 — context debt flagged unless a "significant gain of at least 3 points".
  - A project playbook rule is scoped to this repository's paths, kinds and error codes ("this reviewer, on this repository", context rule 25); the frozen suite's fixtures cannot exercise it, so "scored against the frozen suite" measures nothing for it, and a 3-point significant gain is undetectable on 30 cards by measurement's own rule 11.
- **Why it blocks:** four documents give four admission rules for the same object, and the stated one can never admit anything. This is the core's learning mechanism (measurement, context), not supporting surface.
- **Fix:** write one admission table (in measurement §2) by object: *project playbook rule* — person's approval, then paired credit on this project's attempt records with rotation (CX-N4-6) and automatic retirement; *harness change* (prompt, tool, budget policy, skill) — frozen-suite paired A/B with the 20-point floor, and an explicit rule for inconclusive results (e.g. "inconclusive → the cheaper arm, recorded as not established"); *in-run probation* — production only. Replace "significant gain of at least 3 points" (MS-N2-2, measurement rule 24) with a measurable threshold, and correct planner-pm §2.13.2 and PM_CONTRACT §6 to point at the table.

### B7. The spine's rule 2 is changed by the specs before the owner has decided
- **Evidence:** SPINE rule 2 — "Anything a model saw can be reconstructed from it — *model-visible means logged*". kernel rule 17 already states the exception ("except content erased by a recorded `ledger/erased` event"); kernel §8 Q5 says the spine amendment is an owner decision and "Until the owner decides, erasure (NEW-kernel-7) is built". Separately, runtime rule 33 prunes context packs and transcripts of closed cards after 30 days with **no** `ledger/erased` record — so after pruning, replay of what a model saw is impossible and K-N7-6/K-N7-8 would report the blob as missing, not erased.
- **Why it blocks:** CLAUDE.md and DEC-02: the spine changes only with the owner. The plan schedules NEW-kernel-7 in B3.1 and retention in B3.3 without the decision.
- **Fix:** put "spine rule 2 wording for erasure and retention" at the top of OPEN_QUESTIONS as an owner decision that blocks B3.1; until decided, specify retention pruning as a recorded erasure (`ledger/erased {reason: "retention", blobIds}`, as runtime 34a already does for private fields) so replay names the gap. Add a criterion to runtime NEW-runtime-4: "WHEN retention prunes a context pack THE SYSTEM SHALL record it in a `ledger/erased` event and replay SHALL name the gap".

---

## Major

### M1. Stop reasons proliferate outside the one stop-reason table
worker-loop rule 31 says "no other list of reasons exists … v1 adds `gate_suspected` … and `tests_not_red_for_reason`". Other specs add more: `hook_veto` (worker-loop rule 32, WL-T3-4), `git_metadata_tampered` (security SEC-2), `crashed` (runtime rule 10, RUN-9). `gate_passed` and `oscillation_detected` (in `CARD_STOP_REASONS`, `kernel/src/types.ts:72-91`) are assigned to none of the seven classes in rule 31, yet WL-T3-9 requires every stored reason to have exactly one. **Fix:** put the full v1 list (18 + 5 = 23) in worker-loop rule 31 with class, `parks`, `resumable` and next action for each; give `gate_passed` a "success" class or state that the seven classes are failure classes and `gate_passed` is outside them; add a criterion that SEC-2 and RUN-9 reasons appear in the table.

### M2. NEW-* changes are scheduled but the workstream sizes and order were not revised
The plan's Phase B table (MODERNIZATION_PLAN) still sizes B2.1 "M" and B2.3 "S–M", but COVERAGE (lines 119–212) now puts NEW-context-1…6 and NEW-worker-loop-1…8 in B2.1 (18 change sets with M1/M3/M5/M8), and NEW-gates-1…8 in B2.3 (9 with M6). B2.3's NEW-gates-6 (stub of the declared interface, exported surface "from the source index") and GT-T2/IX criteria need T2, which the plan puts in B5 "never on its own"; NEW-gates-6's test-strength record needs the depth profile (P14, B4.4) and the test-author step (P1, B4.3). NEW-review-git-4 (SemVer per slice) is put in B4.3 though it is review-git's. **Fix:** re-size and split B2.1 (prompt coherence and M8 first — they gate the baseline; the allocator, curator, LSP tenants, rename tool and MCP index after B2.5) and B2.3; move T1 and the T2 index into named workstreams before the gates changes that depend on them; add a dependency column to the Phase B table.

### M3. The plan has no owner-decision queue, although many acceptance criteria wait on one
Criteria that cannot be built until the owner says yes: spine wording (B7); `container.ts`/plugins (M8 below); Playwright and axe-core (DoD §6.4–6.5 audience and accessibility tests, dashboard §8 Q4, P12's "accessibility check over every route" — needs a browser driver); fast-check/hypothesis for NEW-planner-pm-7's property tests; `web-tree-sitter` for IX-6; Zod/Valibot (kernel §8 Q4); the SDK cut (extensibility §8 Q1); install artefacts (surface Q4, SUR-41/42); gates §8 Q3–Q7; schedule.ts wire-or-cut (models §8 Q1); change kinds in v1. **Fix:** a table in the plan — decision, which workstream it blocks, recommended default, needed-by date — and a rule that a workstream does not start with an unresolved decision in its path.

### M4. Acceptance depends on evaluation assets nobody is scheduled to build
Criteria cite datasets that do not exist and have no change ID or workstream: the ~40-need labelled reuse set (P7), the 25-question research golden set (NEW-design-stage-2), ≥10 golden briefs with annotated implicit requirements (measurement T7, P14), a held-out acceptance suite for premature completion, the seeded-defect set for the Reviewer (P8), ~20 scripted PM conversations with a rubric (P6), five greenfield specs driven by a scripted non-developer (P2), injection fixtures (NEW-security-4), reference solutions per fixture card (MS-T7-2). **Fix:** one change ID (e.g. T11 "evaluation assets") with a row per asset, its owner spec, size and the workstream that builds it before the criteria that use it.

### M5. Several criteria are not failing tests: no threshold, or a stochastic "same"
- P6 (planner-pm): "score each of about 20 conversations against the rubric … and record the score" — no pass mark.
- P8 (review-git): "P8 is done only if recall is higher than the empty list's" — the empty list's recall is 0, so one catch passes.
- WL-T3-6 and SUR-19: "replay the frozen suite with the same stop-reason distribution" / "score the same on the frozen suite" — with a model at temperature > 0, "the same" is untestable and measurement rule 11 cannot resolve under 20 points.
- CX-N4-6/CX-N4-7: "comparable cards", "shows cards with it doing worse" — undefined comparison and statistic.
- GT-N4-2: the vision checklist blocks "with a measured false-pass rate recorded" — no acceptable rate.
- MS-N2-2: "a significant gain of at least 3 points" — undetectable (B6).
- CX-N6-2: "a check in the release gate fails otherwise" — no mechanism named for how the gate knows a template changed without an A/B.
- WL-M2-5, NEW-design-stage-2 last criterion, GT-T2-4: process steps ("the losing arm SHALL be removed", "recorded run, not a pass condition"), not system behaviour.
**Fix:** give each a number or a deterministic proxy (e.g. P6 "≥ 16 of 20 conversations meet every rubric item"; P8 "recall ≥ 0.3 on ≥ 20 seeded defects with ≤ 1 false positive per card"; WL-T3-6 "a scripted-adapter replay of recorded trajectories produces the same stop reason on every one", which is deterministic; CX-N6-2 "the release gate compares the context version stamped in the latest `SUITE_RUNS.md` A/B with the built one").

### M6. EARS criteria without IDs in review-git, planner-pm, design-stage and parts of measurement
review-git §5 (S5, S6, P8, NEW-review-git-1…5), planner-pm §5 (every change) and design-stage §5 (every change) have no criterion IDs; measurement's two planning-measure criteria after MS-T7-6 and security's difftastic criterion under S3a have none either. DoD §5.3.2 requires each criterion be written as a test first, and COVERAGE rows are "marked done with its commit" — without IDs a test cannot cite its criterion. **Fix:** number them in the style of the other specs (RG-S5-1…, PM-P1-1…, DS-P2-1…).

### M7. `unpark` returns a card to "its previous state", which the state machine forbids
review-git §2.4 table — "**Park** / **Unpark** | any open state / Parked | Parked / its previous state". kernel rule 25 — `parked` → `ready`, `planning`, `backlog`, `rejected` only; planner-pm §2.10.3 — a late `default_deny` answer "resumes the card to the state it was parked from, or Ready". A card parked from `in_progress`, `verify` or `review` has no legal edge back. **Fix:** say unpark returns to Ready (or Planning) unless the prior state was Backlog/Planning, and correct planner-pm §2.10.3 and its v1 criterion; or add the edges to `LEGAL_TRANSITIONS` with the reason.

### M8. `default_deny` parks at the request (planner-pm) or at the deadline (DEC-24, kernel)
DEC-24 — "a `default_deny` question parks at its deadline". kernel rule 27/K-N5-2 — Parked entry allows "a `default_deny` decision past its deadline". planner-pm §2.10.3 — "`default_deny` … keeps the card parked from the request until it is answered … at the deadline it records `decision/parked`". **Fix:** choose one; planner-pm's reading (park at once, release memory) is safer for destructive options, so amend DEC-24 and kernel rule 27 to "parked from the request".

### M9. Plugins: cut (extensibility) versus owner-pending (DEC-09) versus trust-gated (security)
DEC-09 correction — `container.ts` is reachable; "cutting reachable code is a new decision: **the owner decides** … Until then it stays, gated by workspace trust (S9)". extensibility §2 item 29 — "There is no plugin API in v1. `container.ts` is cut ([DEC-09])"; EXT-28 makes the cut a v1 acceptance criterion. security item 38 lists `.sekhemet/plugins/` as trust-gated (i.e. still loadable) and item 49 says "plugins are cut". **Fix:** until the owner decides, extensibility and security should both say "trust-gated (S9); cut pending the owner (extensibility §8 Q2)", and EXT-28 moves to Open questions.

### M10. A PR-on-accept card has no state
review-git §2.5.7 — the card "reaches Done when the pull request merges; until then it shows *Accepted · PR #n open* and does not count toward ReviewWIP". integrations INT-12/INT-14 — "SHALL NOT mark the card Done … closed without merging … return the card to Review". kernel has no state or typed field for "accepted, awaiting merge": if the card stays `review` it counts toward ReviewWIP and blocks back-pressure (kernel rule 29); if it leaves `review` there is no legal target except `done`. **Fix:** add a typed field in kernel like `held` (`awaitingMerge {pr, since}`), excluded from the Review count, with `card/pr_opened` / `card/pr_closed` events and a criterion; kernel owns it.

### M11. INVEST "Small" uses a 32k working context; the Worker has 16k
planner-pm §2.4 — "Context pack ≤ 25% of the tier's **working context** (`workingContextTokens`, 32,768 by default)" and the v1 criterion "on a 32,768-token tier … refuse a card whose pack exceeds 8,192 tokens" (code: `planner/src/constants.ts:60`). models rule 2 — the Worker's context is 16,384; models rule 8 puts the reference host in tier M (16–24k). A card sized to 8,192 tokens of pack on the reference Worker leaves under 2k for history against a 9,984 prompt budget. **Fix:** read `workingContextTokens` from the resolved Worker's registry window (NEW-models-4) and make the criterion "on the reference Worker (16,384) refuse a pack over 4,096 tokens"; record the default change as a DEC-24 row.

### M12. Project "complete" is derived from cards in the kernel and from requirements everywhere else
kernel K-N5-3 — "WHEN every top-level card of a project is `done` THE SYSTEM SHALL derive the project's status as complete", while kernel rule 6 allows only `active`, `paused`, `archived`. DEC-11 and planner-pm §2.15.5 — "A project is done when the slices the person chose are done", done meaning proven by requirements *and* accepted by a person. A project whose cards are all Done but whose must-haves are unplanned would read "complete". **Fix:** kernel's rollup yields `active`/`idle`, never "complete"; project done is planner-pm's computation (P13); add `done` to the status enum only as set by a person's slice acceptance.

### M13. The Reviewer may be unfillable on the reference host
review-git §2.3.7 — "The registry refuses to fill the Reviewer role with a model of the Worker's family"; models rule 3 names defaults for Planner (Dirk-Qwen3.8-27B) and Researcher (Apodex-1.1-mini) but none for the Reviewer; COVERAGE D1 notes Cyber-Tiel derives from Ornith-1.5, and no document records its family or the Planner's (Qwen) against it. If the only other resident candidates share a family, P8 cannot be demonstrated on the reference machine, and DoD §6.1 requires review-git built. **Fix:** models rule 3 names the Reviewer default and its family, with the family of each default recorded in the registry; if none qualifies, record the decision to ship with the Reviewer unfilled and what P8's acceptance then means.

### M14. Configuration key names for network access disagree
surface item 23 — `[network] fetch_allow` is where the Researcher may read pages; item 25 renames `network.allow` → `fetch_allow`; the v1 schema has no `deny`. design-stage §2.6.3 — "a per-project domain **allowlist** (`config.toml [network] allow` …) **and denylist**"; design-stage §3 Config — "`[network] allow` and (new) `deny`"; NEW-design-stage-4 — "a domain in the project's `[network] deny` list". surface item 26 and security item 28 — a project `config.toml` cannot widen the network policy. **Fix:** one schema in surface: `[network] mode`, `fetch_allow`, `fetch_deny` (user file authoritative; project may add to `fetch_deny` and narrow `fetch_allow`), and change design-stage to those names.

### M15. PM_CONTRACT is stale against the specs it is the contract for
- §2 `assignee: "worker" | "human" | string` — kernel NEW-kernel-6 retires it for `owner`/`delegate`/`accepter`; planner-pm §3 says "to become `owner` and `delegate`". PM_CONTRACT's own rule is "Change this file first if a shape must change."
- §3 "All mutating endpoints require the existing `X-Sekhemet-Action: 1` header" — security item 37 and dashboard §2.15.6 replace it with a per-start/per-session token.
- §2 `externalRef.system: "github" | "forgejo"` — integrations item 8 adds `jira`, `linear`.
- §3 `/api/metrics/flow` `cfd: {backlog, ready, working, checking, review, done}` — NAMING retires *Working* and *Checking*.
- §4.3 "If no runner holds the lease, the server answers directly with the manager model" — runtime rule 4 / RUN-36 loads only through the residency scheduler.
- §5 Slack URL stored in `~/.config/sekhemet/…` — surface NEW-surface-1 makes `~/.sekhemet` the one user directory.
- §6 "approved by a human before it takes effect" and "a passing first attempt counts helpful" — context rules 24e–24f (credit from attempt records with rotation; probation) and planner-pm §8 Q1 (profile statements used at once) disagree; planner-pm Q1 itself says "correct PM_CONTRACT §6".
**Fix:** revise PM_CONTRACT in one pass with a "v3 changes" note; mark each shape as current or target with the change ID that moves it.

### M16. DEFINITION_OF_DONE v3 still carries v1 rules the specs reverse
- §3C.2 — "Turn history older than 2 steps must mask verbose tool outputs … `[Output of read_file from Turn 2 preserved in WAL …]`" — context rule 3 (five most recent kept, masked in batches; DEC-24), rule 20 ("no internal jargon ('WAL')").
- §3B.2 — "Ask tier: Network commands (`curl`, `fetch`) when running in offline mode" — security item 29 (offline: no route out at all) and item 25 (Ask only for allowlisted hosts).
- §3B.1 — "Modifying `gates.toml`, test files (for implementers) …" is right, but omits the extension files security item 25 adds.
- §2B — "at least two negative or boundary test cases" per happy path — gates §8 Q2 recommends making it risk-based "and record that in the DoD", not done.
**Fix:** rewrite §3B–§3D to cite the owning specs instead of restating mechanisms (context rule 3, security items 25–29, extensibility item 4), and decide gates §8 Q2.

### M17. `IX-6` (a Python index adapter) is a v1 criterion while Python adapters are Later
gates §5 T2 includes IX-6 ("WHEN a Python file is indexed with the Python adapter enabled … from tree-sitter-python"); gates §6 makes all of §5 v1 acceptance. gates §8 Q7 recommends adding `web-tree-sitter` "with the Python adapter", context §7 puts the multi-language map in Later "when a Python adapter is built", and DEC-20 keeps Python at a flat map in v1. **Fix:** move IX-6 to §7 Later with the interface requirement kept (IX-1 already fixes the schema).

### M18. Research-backed Worker mechanism neither carried nor rejected: evidence-gated commit (ECLoop)
PROJECT_DONE_AND_DEPTH §1 reports ECLoop (arXiv 2607.28815): deterministic "observe before edit/submit" preconditions tracked from the trajectory, +11.8 points on the weaker model, fewer tokens — the strongest measured Worker-level result in the research set, and aimed at exactly this Worker's failure (53% of failures still localising, worker-loop rule 6). The design cites it only as evidence for project-level done; worker-loop's find phase, strict method and A/B candidates (rules 6, 26, 29) do not mention it, and nothing rejects it. **Fix:** add it to worker-loop rule 29's A/B candidates (a finish/write precondition set: scope test read, callers of a changed export read, related test run) behind a switch, with a register entry and threshold.

### M19. The core has no stated defaults for the budgets it enforces
worker-loop rule 21 defines calibration of the step budget but not the default before three passing attempts (surface item 23 says `default_step_budget = 40`; worker-loop §9 mentions "32-step budgets"; dashboard tiles show "Step 5 of 32"; `vocabulary.ts:615` "40-step budget" is flagged as a defect). The token and seconds budgets (rule 21), the find-phase share (rule 6, WL-T3-8), the masking interval k (context §8 Q1: "start at k = 8"), `max_tool_applied_lines` (gates rule 12) and the gate timeout default have no values. **Fix:** a defaults table in worker-loop §3 and gates §3 with each value and its source (measured, prior, or to be measured by a named benchmark in OPEN_QUESTIONS).

### M20. Auto-accept is recorded two ways, and sits awkwardly with the spine
review-git §2.5.6 — auto-accept "is the harness's verdict, recorded with actor `harness` and `Accepted-by: sekhemet --auto-accept`". kernel rule 19 — a principal is required "on any event a person caused through a machine actor (… an auto-accept a person switched on)"; kernel §8 Q3 recommends keeping `harness` as an accepting actor only "for an auto-accept switch that a named person turned on, recorded as that person's standing decision". DoD §5.1.5 — "a person accepted it". **Fix:** review-git §2.5.6 records the principal who enabled auto-accept on every `card/accepted` it writes; DoD §5.1.5 says "a person accepted it, or it was auto-accepted under a person's recorded standing decision (never in company-server mode)".

### M21. `unavailable` gates: any, or only blocking ones, keep a card out of Review
kernel rule 27 `review` entry — "every blocking gate passed; no gate was unavailable". gates rule 9 — "An unavailable **blocking** gate blocks Review on its layer"; GT-T1-7 — "while that gate is blocking". An unavailable advisory gate (e.g. a CI step needing a secret, surface item 9b) would block Review under kernel. **Fix:** kernel rule 27 says "no blocking gate was unavailable".

---

## Minor

- **m1.** worker-loop §2 rules are numbered 37, 39, 40, 38 (cross_validate after 40); GT-T1-13 precedes GT-T1-12. Renumber.
- **m2.** context §8 Q1 — "with the 8,192 default `--checkpoint-min-step` only about two spaced checkpoints survive" — rule 6 now sets 512–1,024; the sentence describes the old value. CX-M8-3 forces masking at the 85% tier while rule 12 tightens masking from 70%; say which tier forces an out-of-schedule masking point.
- **m3.** kernel §8 Q1 still asks NAMING to drop *Working, Checking, Closed*; NAMING already did (NAMING:33). Close it. integrations §8 Q2 proposes the `principal` column that kernel NEW-kernel-2 already specifies; close it.
- **m4.** kernel rule 23 writes the columns "Backlog, To Do, In Progress, In Review, Done"; NAMING and dashboard use sentence case "To do, In progress, In review" (dashboard §2.1.4 "Sentence case everywhere").
- **m5.** DEC-24 row "Six stop reasons → Eighteen stored" is out of date with M1's additions.
- **m6.** COVERAGE's decision table still shows the pre-decision recommendations (D1: "the guardrailed model is the safer default") directly under "Decided by the owner"; mark each row with its outcome to avoid a reader taking the recommendation for the decision. M9/M10 exist only as a footnote under the Tier 1 table; give them rows.
- **m7.** MODERNIZATION_PLAN says "Sixteen domains" (Phase A) and "Review done (17 domains)" (Status).
- **m8.** surface item 5.1 requires "Node.js 22 or newer"; CLAUDE.md says "Node 26 (20+ supported)".
- **m9.** planner-pm §7 Later says "`sekhemet \"<spec>\"` plans"; surface item 13 says it plans **and runs** ("one verb, not `plan` then `queue`").
- **m10.** design-stage NEW-design-stage-1 — "WHEN the level is brief THE SYSTEM SHALL ask exactly one question" — against §2.1's "a real conversation" for the billing service and planner-pm P2's "at most two open questions per planning pass". State that one is the first question, not the cap.
- **m11.** planner-pm §2.5 "Maximum split depth is 4" (`DEFAULT_MAX_SPLIT_DEPTH`) against kernel's two-level card/subtask nesting (`MAX_CARD_DEPTH = 2`); say split children are siblings (the parent goes to *Won't do*, §2.3.3), so depth counts re-splits, not nesting.
- **m12.** review-git's default ReviewWIP: kernel §3 "review 3 (before calibration)" (`board_service.ts:19`) versus review-git §2.2.3 "Until five human reviews exist, the median is a prior of 15 minutes" (60 min/day → 4). State which applies before the first review and that `reviewMinutesPerDay` defaults to 60 (surface item 23).
- **m13.** runtime §8 Q1 says `retention.ts` is already wired; COVERAGE "Cuts needing sign-off" still lists it as "Unused — wire in or cut". Update COVERAGE.
- **m14.** SPINE's package table lists `sdk` as a package while extensibility §8 Q1 recommends cutting it; mark it "pending".
- **m15.** The "regulated" depth profile (design-stage §2.8) sits next to SPINE's "a compliance pack or any compliance claim" being out of v1; add one line that the profile claims no compliance.
- **m16.** PM_CONTRACT §1 names "dirk-27b" as the manager model and "Only one model is ever resident (24 GB host)"; models rule 20a allows co-residency on larger tiers. Drop the model name from the contract (NAMING R15 intent) or mark it as the reference host's default.


---

## Research coverage (brief item 3)

Every file named in the brief is cited by at least one spec. Checked recommendation by recommendation for the design-research files and against the ranked lists of the others:

| Research file | Accepted recommendations | Carried? |
| --- | --- | --- |
| DESIGN_RESEARCH_TESTS_BROWNFIELD | Decisions 1–14; EARS PM-TQ-1…8, PM-BF-1…5, GT-TQ/BF/IX, CX-IX, SUR-BF-1…4 (as SUR-35…38), WL-BF-1 (NEW-worker-loop-6), WL-IX-1/2 (NEW-worker-loop-7), IX-1…6, MS-TQ-1…3 | All carried and cited. IX-6 is carried into v1 although the research put the Python adapter later (M17). |
| DESIGN_RESEARCH_TEAMS_DATA_CHANGE | Decisions 1–17 | All carried (kernel 1, 2, 5–7, 11, 12; review-git 3, 4, 13, 16, 17; runtime 9, 10; design-stage 14; security/surface 15). Decision 8 is an owner spine decision still open (B7). |
| DESIGN_RESEARCH_TEAM_SERVER | Engine as adapter; batch size a host property; MTP qualified per engine; one fair scheduler; per-slot lease; one artefact per audience; forward-only migrations; adoption by bake-off | All carried (models NEW-models-8/10, context rule 6, runtime NEW-runtime-6/8, surface NEW-surface-4, kernel NEW-kernel-4). |
| PROJECT_DONE_AND_DEPTH | Requirement graph, reasoning is not evidence, appetite and circuit breaker, no orphan cards, four coverage sources, depth profile, Kano, story map; two planning-measure items | Carried in planner-pm P13, design-stage P14, dashboard P13, measurement T7. **Not carried or rejected:** ECLoop's evidence-gated commit at Worker level (M18). measurement and dashboard carry its items without citing it — add the citation. |
| WORKER_METHOD_LITERATURE | Implications 1–10 | Carried (worker-loop rules 6, 12, 14–19, 24–29, the strict method, the hypothesis A/B candidate). Implication 3's escalation "fail over or resample" became "stop the card" — a deliberate change; say so in worker-loop §9. |
| PM_RESEARCH_SYNTHESIS | §1 rows 1–14; §2 steps 1–7 | Carried, except **§2 step 2 / row 13 — separate quantisation damage from scaffolding** (run the suite at a higher quant of the same Worker): no spec, benchmark row or change carries it, though it is the evidence DEC-04's "reopen if" would need and the cheapest way to attribute the 25–40% failure rate. **Fix:** add it to OPEN_QUESTIONS benchmarks with what it blocks (DEC-04) and to measurement rule 27. |
| PAPER_REVIEWS_2026-09 | SRMA (grounded admission), Repo-To-Skill verify stage, random null baseline, NeoHorse instrumentation and structural filter, WMRL anchors; Spark-X2.5-4B "ADOPT as the gatherer, displacing Apodex" (via bake-off, 3 cards) | Carried, except Spark-X2.5-4B, downgraded to models §7 Later ("proposed; decided by one bake-off") with no change ID. The review's argument is memory on the reference host (Apodex ~16 GB forces the swap and the 16k research window). **Fix:** either a change ID for the bake-off in B2.2/B4.4 or a DEC-22-style line saying why it waits. |
| PUBLIC_DATA_SURVEY | Five verdicts; do-not-import list; review datasets as evaluation sets | Carried as measurement rule 22 and §8 Q3, context rule 25, review-git §8 Q3. The survey's "single best import" (`nebius/SWE-rebench-V2`) is not adopted; measurement Q3's recommendation narrows it without saying why — add one line. |
| WEB_RESEARCH_2026-09 | Group A Q1–Q4 (cache, MTP, thinking, tool count), group B (sandbox, egress, git), group C (landscape, Kanban practice, criteria recipe), group D (Cyber-Tiel, benchmarks, statistics, quantisation, abliteration) | Carried and well cited (context, models, worker-loop, security, dashboard, planner-pm, measurement). |

---

## Readiness per spec against DoD §5.2 (brief item 2)

Built claims were spot-checked read-only against the code at `c8cd903`; every one checked held (list at the end). The failures are in §5.2.3–4 (criteria and contradictions), not in §5.2.1.

| Spec | §5.2.1 state vs code (spot-checks) | §5.2.2 gaps have IDs | §5.2.3 EARS testable | §5.2.4 no contradiction; open questions recommended | Ready? |
| --- | --- | --- | --- | --- | --- |
| worker-loop | 6/6 held | yes | WL-T3-6, WL-M2-5 (M5) | B4, M1, M19 | no |
| context | 6/6 held | yes | CX-N4-6/7, CX-N6-2 (M5) | B5, B6, M16, m2 | no |
| gates | 5/5 held | yes | GT-N4-2, GT-T2-4 (M5) | B3, M17, M21 | no |
| kernel | 6/6 held | yes | yes | B7, M7, M8, M10, M12, m3 | no |
| models | 5/5 held | yes | yes | B3 (cardClass), M13 | nearly |
| measurement | 4/4 held | yes | MS-N2-2; two unnumbered criteria (M5, M6) | B6 | no |
| planner-pm | 4/4 held | yes | P6 (M5); no IDs (M6) | B3, M7, M8, M11, M12 | no |
| design-stage | 2/2 held | yes | no IDs (M6) | M14, m10 | no |
| review-git | 5/5 held | yes | P8 (M5); no IDs (M6) | M7, M10, M20 | no |
| dashboard | 2/2 held | yes | yes, but P12 and the §6.4 walks need an unapproved browser driver (M3) | m4 | nearly |
| security | 4/4 held | yes | one unnumbered S3a criterion | M9 | nearly |
| integrations | 1/1 held | yes | yes | M10; m3 | nearly |
| extensibility | 2/2 held | yes | yes | M9 | nearly |
| runtime | 3/3 held | yes | yes | B7 (retention pruning) | no |
| surface | 1/1 held | yes | SUR-19 (M5) | M14, m8, m9 | nearly |

"Nearly" means only minor or cross-spec fixes owned elsewhere stand between the spec and §5.2.

---

## The spine and the decisions (brief item 4)

- **Gates decide; the model never certifies.** No spec lets a model accept, gate or declare done: the Reviewer has no authority (review-git §2.3.6), Seshat cannot accept or declare a slice done (planner-pm §2.8.4, P13), the vision checklist can only fail (gates rule 30), MCP cannot move a card past Review (EXT-6, K-S4-5). The one soft spot is auto-accept (M20).
- **The event log is the only durable channel.** Kept, with two exceptions to resolve: erasure and retention pruning (B7), and generated project documents, which design-stage §2.3 correctly makes one-way exports with proposals back. Integration settings and trust records live in files outside the ledger by design (security items 35, 39); say in kernel rule 16 that user-directory configuration is not "durable project state".
- **A card is the unit of work.** Kept; the only multi-card mechanisms (rollup, slices, releases) are projections.
- **The human is the rate limiter.** Kept in review-git S6; the PR-awaiting-merge state (M10) is where it can leak, because a card leaving Review before merge frees WIP while a person has not yet decided at the tracker.
- **Local in v1 (DEC-03).** No spec plans cloud inference; hosted MCP research sources are Later and off by default (design-stage §7).
- **One persona (DEC-05).** Kept; the Reviewer's code prompt still says "You are Seshat" (`apps/harness/src/learning/review.ts:25`) — review-git §9 already records that this changes under P8.
- **Libraries (DEC-08).** No spec adds an unapproved library as a v1 requirement except by implication: property-based tests (NEW-planner-pm-7, `fast-check` a proposal), IX-6 (`web-tree-sitter`), the browser checks of DoD §6.4–6.5 and P12 (Playwright, axe-core). See M3.

---

## Plan and Definition of Done (brief item 5)

- **Change IDs.** Every S/M/P/T ID in COVERAGE is carried by a spec (T6 and T9 are process items, as COVERAGE says). All 95 NEW-* IDs in the specs' front matter appear in COVERAGE's "Changes added by the specifications" with a workstream (COVERAGE:119–212). The Phase B table names only Phase A IDs and points to COVERAGE for the rest; acceptable, but the sizes and order no longer match what is carried (M2).
- **DoD §6 against the specs' v1 acceptance.** §6.1 (every spec built) follows from the fifteen §6 sections. §6.2 follows from security and kernel (SEC-37a is the "Worker that tries to leave" test). §6.3 follows from measurement §6. §6.4 is carried as the last criterion of dashboard P3, P4 and P5. §6.5 is dashboard P12 and §2.14. §6.6 is runtime P9 and integrations INT-21…26. **§6.7 ("from a fresh clone and an empty repository, one documented first run leads to a card built and gated, on the reference machine") has no single criterion**: surface P10 covers the first run, design-stage P2 the greenfield conversation, models NEW-models-7 the weights; nothing tests the whole path. Add one end-to-end criterion to surface.
- **What a senior engineering manager would say is missing from the plan to reach v1:**
  1. *Effort and a critical path.* Sizes are S/M/L per workstream with no card counts or elapsed-time estimate, no dependency graph (M2), and no statement of what can run in parallel. The rule "a package is not a card" is stated but no workstream is broken into packages.
  2. *Machine time as the bottleneck.* Every workstream that touches the loop, context, gates, models, sandbox or runner must re-run the frozen suite (DoD §5.3.4), paired and at least twice for admission (MS-T8-2), on one 24 GB machine that cannot build while a suite runs. At ~1 hour per 14 cards that is several machine-days; the plan does not budget it or say which runs can be batched.
  3. *An owner-decision queue* with needed-by dates (M3).
  4. *Evaluation assets* as scheduled work (M4).
  5. *Risk register:* `sandbox-exec` removal (security §8 Q4), an unfillable Reviewer (M13), the Worker failing the injection fixtures (SEC-37a) with DEC-04's reopen condition, the 24 GB memory envelope with LSPs, the Planner and the Reviewer swapping, and the final suite coming in below the B2.5 baseline — Phase C says what is compared but not what happens if v1 is worse.
  6. *Intermediate milestones the owner can see:* e.g. "after B3, a person can safely accept and revert on a real repository"; "after B4.4, a non-developer starts a project on the reference machine". Today the first user-visible end-to-end proof is Phase C.
  7. *A definition of the B2.5 baseline's frozen settings* (which thinking arm, which tool arm, which method) so later workstreams compare against one recorded object, not "the baseline".

---

## Depth of the core (brief item 6)

The core is specified in depth — worker-loop, context, gates and measurement are the most detailed specs, with real mechanisms, numbers and typed failures. The thin places, all in the core:

1. **Defaults the loop enforces are missing** (M19): the pre-calibration step, token and seconds budgets; the find-phase share; masking interval k; the tool-applied line bound; gate timeouts.
2. **Context budgets do not add up at the reference W** (B5).
3. **Learning admission is specified four ways and cannot fire** (B6). Measurement's statistics are honest about the suite's power, but nothing downstream is designed around that honesty: context rule 21a (every prompt change needs a suite A/B), MS-N2-2 (3-point gains), extensibility item 16 (skill net gain) all assume effects the suite cannot resolve. Specify what happens on "inconclusive".
4. **The Reviewer's quality bar is trivial** (P8, M5) and its model is unassigned (M13), so review — one of the five core areas — has no working definition of "good enough" for v1.
5. **No Worker-level evidence gate** (M18) although the loop's own measurements (53% of failures still localising; oscillation after a shown remedy in 2 of 4 baseline failures) point at it.
6. **The repair ladder's rung-3 Planner** is specified in inputs (NEW-worker-loop-5) but not in its output contract: what a re-plan may change (scope narrowing is allowed, rule 34.3), how the Worker is told, and how the plan is measured. Add the plan's shape (target files, steps, what not to touch) and a criterion that the Worker's next prompt contains it in the static card block (CX-N3-5).
7. **Gate-host verdict caching and impacted-tests-first** (NEW-gates-3) depend on a "tests reachable from the card's scope" computation that only T2 can supply; the spec does not say what happens before T2 (run everything).

---

## Built claims spot-checked (read-only, at `c8cd903`)

All held:
- worker-loop: 28 tools in `TOOL_CATALOG`; `CLASS_TOOLS` has entries for spike/review/research only and `implement` falls through to the full catalog (`tool_catalog.ts:453-499`); `PROGRESSIVE_CORE_TOOLS` five tools (`session.ts:67`); `MAX_READ_BYTES` 512 KB (`tools.ts:108`); prompt budget = window − maxTokens − 256 (`session.ts:921`) and literal 2,048 thinking under `all` (`session.ts:537`); `clampObservation` 2,400/1,200 (`observation.ts:16-34`); `RepairPlanInput` is card, stop reason, failures, files (`manager.ts:5-11`); budget floor 4 (`budget.ts:36`).
- context: `cacheProfileForHost` 2,048/6, 4,096/8, 8,192/16 (`llama_server.ts:46-51`); `-sps` only with >1 slot (`:305-307`); `MIN_ASSERTED_WORKING_BUDGET = 12_288` skip (`zones.ts:149,165`); estimators `/3.2` and `/4` (`allocator.ts:114`, `tokens.ts:12`); Jaccard ≥ 0.8 (`store.ts:155-158`); `CACHE_ALERT_THRESHOLD = 0.85` (`telemetry.ts:33`).
- gates: unknown layer → `functional`, unknown rung → `test` (`config.ts:100-107`); defaults hash `hashGatesConfig("")` (`config.ts:144`); `CARRY_LIMIT = 4000` (`regression_gate.ts:35`); `baselineApproval` defaults `auto` (`visual.ts:77`); built-in gates' base `"main"` default (`session.ts:1710`).
- kernel: default WIP planning 3 / in_progress 5 / verify 5 / review 3 (`board_service.ts:13-19`); same-status bypass (`:267-270`); `MAX_CARD_DEPTH = 2`, `DEFAULT_ACTIVE_PROJECT_CAP = 3`; 13 actors; 18 stop reasons (`types.ts:72-91`).
- review-git: hard-coded `"main"` and `GateStatus: "pass"` (`execute.ts:1344-1353`); `checkout`/`merge --squash`/`commit` in the repository (`git_adapter.ts:536-538`); Reviewer returns `[]` without preferences and cuts the diff at 12,000 characters (`review.ts:23,28`); `sendBack` transitions from any status and appends `playbook_candidates.jsonl` (`triage.ts:49-68`).
- security: stray `LOGSEQ_TEST` in the environment allowlist (`executor.ts:74`); gate sandboxes built with `requireConfinement: ctx.restrictedMode` (`execute.ts:315,426,1051`; `index.ts:733`); bubblewrap re-binds only existing `.git` paths (`bubblewrap.ts:43`); five-line `.gitignore` (`init.ts:348-354`).
- planner-pm: `INVEST_CONTEXT_FRACTION` 0.25, `INVEST_MAX_STEPS` 40, `workingContextTokens` 32,768, `DEFAULT_MAX_SPLIT_DEPTH` 4, 12-hour deadline, 15% override shift (`constants.ts`); `DecisionStore.request` parks by default (`decisions.ts:104-131`).
- measurement: `compareRuns` reports any non-zero delta as improved (`suite.ts:186-193`); `MIN_ARM_TRIALS = 5` (`registry.ts:81`); `M0_DEFAULTS` 3 runs, budgets 50/150, 30 tasks (`m0.ts:46`).
- models: Worker profile 16,384 context, `mtp: true`, 4,096 answer cap, sampling 0.6/0.95/20/0 (`llama_server.ts:530-534`); `isQualified` has no production caller (`registry.ts:192`).
- runtime: `RETENTION_DAYS = 30` and retention wired through `execute.ts:195` (so COVERAGE's "unused" is stale, m13).
- integrations: one page of 100 issues, no pagination loop (`remote.ts:130-133`).
- extensibility: `sekhemet_ask_merit` and fixed protocol `2024-11-05` (`mcp.ts:207,277`).
- surface: `main().catch(console.error)` exits 0 on a thrown error (`index.ts:2084`).
- dashboard: `LIMIT_SHOWN = 20` hides larger limits (`board.js:37,108`); bare `t` bound (`keys.js:91`).
- design-stage: `RUNTIME` forces TypeScript for greenfield (`design_stage.ts:126,161`).

---

## Summary

| Severity | Count |
| --- | --- |
| Blocker | 7 |
| Major | 21 |
| Minor | 16 |

The blockers, in the order to fix them: B1 commit the design trace; B2 move the lead's rulings into DECISIONS; B3 one card-kind and change-kind vocabulary; B4 one step/sample/attempt hierarchy; B5 context zone budgets that fit the reference Worker's window; B6 one learning-admission rule that can actually fire; B7 the owner's decision on spine rule 2 before erasure and retention are built.
