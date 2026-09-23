# Domain 7: Planner and PM (Seshat): Phase A review

Read-only review, 2026-09-22. Paths are relative to the worktree. I checked the planner's behaviour by running the built `packages/planner/dist` on six specs from a scratch script (probe outputs are quoted below). I also ran `behaviour.spec.ts` and `design_stage.spec.ts`, and both pass.

## 1. Positioning

**Professional teams.** The PM surface is strong: a Linear-style priority scale, Fibonacci points, cycles, WIP, aging WIP, percentile cycle time, and a Monte Carlo forecast given as a range (`pm/service.ts:215-219`). Changes arrive as proposals with a stale check (`pm/apply.ts:74-86`). Status answers need no model (`pm/agent.ts:569-604`). A professional PM would recognise all of that. They would not recognise the backlog the Planner writes. Probe results with the default (heuristic) path:

- *"Let users log in with email and password, and reset a forgotten password by email"* produces the cards **"Email: happy path"** and **"Password: happy path"**. The splitter cuts clauses on `and`/`with` (`text.ts:26`).
- *"…dashboard…maybe with React or Vue"* produces the cards **"Maybe: happy path"** and **"React or Vue: happy path"**, plus a decision request whose options are "Maybe with React" and "Vue".
- *"Add a --json flag"*: the design says this "is a card", but the planner makes two (types, then a happy path).
- *"build me a calculator"* makes two cards, and neither mentions the four operations the design's own example says it should infer.
- The multi-tenant billing service gets no tenant-isolation card and no persistence slice.

Estimation does not reach the board. `persistPlan` writes no `estimate` (`persist.ts:173-189`), so every planned card is "unestimated", and the cycle header counts each one as 1 point.

**Beginners.** Some of the teaching text is good: `rationaleFor` (`spidr.ts:233-246`) explains *why* the happy path ships alone, and INVEST is shown in the plan report. But the *pattern* a beginner would learn is wrong. Every feature becomes "types and contracts first" followed by "happy path". In Cohn's SPIDR the **I is the user Interface**, not TypeScript types. A types-only card is a horizontal technical slice that fails INVEST-Valuable. Contract-first has real engineering merit for a small Worker, but it should be labelled an enabler task, not presented as SPIDR story slicing.

**Non-developers.** Status by conversation works (`/status`, the ledger standup, `/forecast`). Starting a project does not. No PM tool reaches `designStage` or `planCommand`: `pm/` never imports them. `/plan` is rewritten into a free-text request to the model (`pm/slash.ts:84-89`). The standup prints raw codes such as `stopped on gate_failed` and card ids in backticks (`pm/agent.ts:595`), which is jargon for this audience. The PM also cannot see goals, open decisions, the brief or assumptions (`buildSnapshot`, `pm/service.ts:195-232`), so "what did you assume?" and "what's our goal?" cannot be answered.

## 2. Drift

| Design says | Code or other doc says |
|---|---|
| "Estimates … strictly in tokens … never arbitrary story points" (HARNESS_DESIGN "Estimation") | Points 1-8 everywhere in PM_DESIGN, and the Seshat prompt (`agent.ts:61`); the planner writes no points, only token and time budgets, into the dossier |
| The conversation "never evicts a running Worker"; "no profile of the user" (HARNESS "What the conversation may not do", 1–2) | PM_CONTRACT §4 unloads the Worker; §6 plus `agent.ts:110-113` build a user profile. The newer documents are right; HARNESS_DESIGN is stale |
| "Talking to the Planner" is one conversation | The code has **two planners**: the heuristic SPIDR pipeline (CLI `plan`) and Seshat's model tool calls. They share nothing, and Seshat's cards skip INVEST, scope selection, step budgets and staged tests (`apply.ts:45-50`) |
| The design stage: "Nothing is blocked on the conversation" | `ambiguity.ts` decisions hold every story in `planning` until answered (`persist.ts:162-165`), so there are two question systems with opposite blocking rules |
| "The Planner's model is kept for the conversation" / "model-assisted" | `models.planner = "auto"` (`config.ts:40`), which means **no model**, so the heuristic path is what users actually get (`index.ts:689-696`) |
| Seshat "proposes and never does" | `queuePrelude` silently sets blockers to Urgent (`wave2.ts:349-352`), which inflates the Expedite class the PM_DESIGN says must stay rare |
| A standup is "Done since yesterday · In flight · Needs you" | `ledgerStandup` reports the lifetime done count, not what was done since yesterday (`agent.ts:600`) |

**The AGENTS.md ban on "simulated Scrum personas".** The ban's *intent* is correct and is backed by the literature: ChatDev- and MetaGPT-style agents role-playing a Product Owner, a Scrum Master and developers in meetings with *each other* add coordination cost without adding correctness. Seshat is something else. It is one model, serving a human, with no authority, reporting from the ledger. The rule should be reworded, not deleted:

> *No agent-to-agent ceremonies or role-play. Ceremonies exist only as artefacts for people: a standup is derived from the ledger and delivered to a person; a retrospective is a function over gate failures that proposes playbook rules. The PM is one role with bounded authority: it proposes; it never decides, approves or edits the board.*

The first paragraph of HARNESS_DESIGN's Planner section needs the same edit.

## 3. Dead and duplicated code

- **`decision.ts` vs `decisions.ts` is not a duplicate.** The first *builds* requests (pure); the second is the ledger-backed *store*. The only problem is the names. Rename them `decision_request.ts` and `decision_store.ts`.
- **The real duplication is three standup builders:** `planner/sessions.ts:250` `standupReport`, `pm/agent.ts:580` `ledgerStandup`, and `wave2.ts:1054` `plannerStandupSection`, which glues the first onto the second. `standupReport` also computes a value it throws away (`sessions.ts:286`, `void waiting`).
- **There are two question policies:** `design_stage.ts` EXTERNAL (non-blocking, with defaults) and `ambiguity.ts` ClarEval, which parks the cards.
- **Two planning paths.** The heuristic path and the model path are both in `spidr.ts`, and Seshat's `propose_create_card` is a third, with no contract.
- **Card kind is parsed from a `(SPIDR: X)` title suffix in five places** (`pm/capability.ts:50`, `learning/reflect.ts:14`, `learning/store.ts:241`, `kernel/card_class.ts:98`, `ui/vocabulary.ts:44`). The planner no longer writes that suffix; it writes a `labels: [slice]` field (`persist.ts:186`). As a result `pm/capability.ts` puts **every planner-made card in "Other"**, so the Worker-capability-by-kind evidence the PM plans with is empty for real projects. Only the kernel reads labels.
- **Keyword-list NLP is spread across modules:** `spidr.ts` (4 lists and INVARIANT), `design_stage.ts` (REQUEST, MODAL, QUALITIES, HIGH_RISK, EXTERNAL), `ambiguity.ts` RULES, `decision.ts` DESTRUCTIVE, `goals.ts` GATE_WORDS and METRIC. Each splits clauses its own way: `design_stage.ts:139` splits on `[;,]` while `text.ts:25` splits on sentences.
- **Unused exports:** `inferDependenciesByImpact` (`impact.ts:164`) and `hasPhrase` (`text.ts:143`). My reachability scan found no other dead planner exports, but it is partial: it did not follow dynamic imports.
- **`percentile` is implemented three times:** `signals.ts:59`, `ui/pm.ts:830`, and `estimation.ts:69` (`quantile`).

## 4. Complexity hotspots

- **`spidr.ts` (911 lines).** Slicing, riskiest-assumption injection, scope, splitting, the model prompt and a JSON scanner all live in one file. `buildStory`/`splitStory` thread 14 parameters through.
- **`ui/pm.ts` (1,338 lines, 92 exports).** Priority, proposals, markdown, the query language, cycles, flow maths, PM phases, capability, learning, tuning and the roster in one module. Split it by concern.
- **`wave2.ts` `queuePrelude` (`:303-408`).** One function runs decisions, signals, automatic mutations, ceremonies, the goal loop, GitHub PR advancement and ordering. `planCommand` lives in a file named after a build wave.
- **`pm_api.ts` `createPmApi`.** A single closure of about 400 lines (`:59-458`). I did not read it line by line.
- **`ambiguity.ts` (568 lines).** Weighted trigger words are behind a "ClarEval" name, but I found no calibration against ClarEval in the code, only the override-rate shift.

## 5. Test quality (DEFINITION_OF_DONE §2)

**Coverage.** There are 6 spec files for 26 source files, and some pipeline functions have no direct test: `validateInvest` (the pre-flight), `splitStory` (the split loop and capability ceilings), `proposeSlicesWithModel` and `extractJsonObject`.

**Negative cases (§2B).** There are none for malformed model JSON, truncated output, a wrong `kind`, or an empty `slices` array, even though this is exactly the parser that faces untrusted model output.

**Real storage (§2A).** The persistence, goals and impact tests use `DatabaseSync(":memory:")` (`persistence.spec.ts:25`, `goals.spec.ts:24`). §2A requires real on-disk SQLite for database persistence.

**Weak assertions (§2C):**
- `behaviour.spec.ts:24` only checks that an assertion *does not match* the old tautology. The new tautology, *"X: a test calls the exported API and observes it happen, as the spec states it"*, passes it.
- `planner.spec.ts` uses `toBeDefined` and `>=` counts.
- The replan test (`persistence.spec.ts:324-339`) hand-edits the spec and loops over `parkedRemoved`, which may be empty.
- `design_stage.spec.ts`'s billing spec leaves out the sentence that triggers the bug in §6.

**Model realism.** The PM tests (`apps/harness/tests/pm.spec.ts`) cover plumbing well with a mock adapter. **Nothing measures what Seshat or the Planner actually say with a real model.** The frozen suite cannot see planning, which the plan already acknowledges.

## 6. Senior judgement

### Correctness bugs (confirmed by probe or by reading the code)

1. **The design stage swallows an invariant.** "…scale to many users. A retried charge must never charge a customer twice." becomes a single *quality constraint*, because `design_stage.ts:139` never splits sentences and the pattern `scale…to\s+.+` (`:60`) is greedy. The probe output shows it verbatim ("scale to many users. A retried charge must never … — Assumed: one instance"). The invariant disappears from `buildSpec` and survives only because the HIGH_RISK template happens to re-add it.
2. **Replanning drops the riskiest card, or does nothing.** `replanOnRung3` re-decomposes `epic.spec ?? epic.title` (`wave2.ts:1090`) without `riskiest` and without the model. Because card ids are deterministic, re-planning the same spec returns an identical plan (a no-op); otherwise the "Riskiest assumption" story shows up as *removed* and is parked (`sessions.ts:158-172`). This is inferred from reading the code; I did not execute it.
3. **Seshat's split gives every part the parent's full acceptance tests** (`apply.ts:122`), so each part must pass everything the parent had to pass, which defeats the split.
4. **Split children lose their behaviour** (`spidr.ts:596-602`), so they fall back to the old tautology (`:392-393`).
5. Grammar: "One thing that are hard to change later" (`design_stage.ts:186`).

### The quality of acceptance criteria after the "behaviours" fix

The fix is real but shallow. On the heuristic path, which is the default, a card's criterion is still **its title plus boilerplate**: *"Issues refunds: a test calls the exported API and observes it happen, as the spec states it."* It contains no input, no output and no value, and a stub that exports `issuesRefunds()` could satisfy a test written from it. Hazard slices get no behaviour at all (`spidr.ts:315-321`). The rule card's second criterion is keyword soup, and for idempotency it is semantically *wrong*: *"Input that violates retried duplicated request never charge customer twice is rejected"*, when a retried charge should be accepted and return the original result, not be rejected. The model path is better, because its prompt asks for Given/When/Then with values (`spidr.ts:833`). Even there, the model's rules are never flagged `early` (`:892-904`), and the prompt has no examples, no brief, no non-goals and no constraints. Verdict: **cards still do not reliably say what the code must do** unless a planning model is configured, and none is configured by default.

### How the Planner should use its model

The model should be primary and the rules should be the guard rails, not the other way round:

- Rules decide proportion, cost nothing, and stay (they are testable).
- The model writes the slices and behaviours.
- Deterministic code validates the result: INVEST, three files, the dependency graph, and an **acceptance-criterion lint** (the criterion names a domain noun, an observable, and a concrete value; it does not repeat the title; it is refused if the title alone satisfies it).
- The heuristic runs only when no model is available, and the output then says it is running degraded.

### What a senior-PM prompt or skill should contain

Today it is a 12-line inline string (`agent.ts:53-65`). It should become a versioned skill file that is evaluated. It should cover:

- **Proportionality and the design stage:** propose and proceed; ask one question, and only when it is expensive to get wrong.
- **Slicing:** vertical slices, INVEST, SPIDR as Cohn meant it, and enabler tasks labelled as such.
- **Acceptance-criterion craft:** Given/When/Then with values, plus negative cases.
- **Flow:** WIP, aging against the 85th percentile, Expedite kept rare.
- **Forecasting:** ranges with their basis, never promises.
- **Cycle planning:** appetite with 15–20% slack.
- **Risk:** state the riskiest assumption and schedule it first.
- **Teaching mode:** explain the *why* for beginners and drop jargon for non-developers.
- **Authority limits.**

It also needs few-shot exchanges (the PM_DESIGN §2.3 samples are ready-made) and a tool that calls the real Planner pipeline.

## 7. Verdict per file

| File | Verdict |
|---|---|
| `planner/spidr.ts` | **Refactor.** Split into slicer (model), fallback slicer, splitter, criterion lint; model first |
| `planner/design_stage.ts` | **Refactor.** Keep the proportion rules; share sentence splitting with `text.ts`; let the model phrase the output |
| `planner/ambiguity.ts` | **Refactor.** Merge with the design-stage questions into one non-blocking policy |
| `planner/decision.ts`, `decisions.ts` | **Keep** (rename) |
| `planner/invest.ts`, `persist.ts` | **Keep.** Add direct tests; persist points |
| `planner/sessions.ts` | **Refactor.** One standup; fix replan |
| `planner/goals.ts`, `signals.ts`, `profiles.ts`, `estimation.ts`, `ordering.ts`, `prioritization.ts`, `calibration*.ts`, `difficulty.ts`, `scope.ts`, `edit_sketch.ts` | **Keep.** `signals` should propose rather than mutate |
| `planner/impact.ts`, `text.ts` | **Keep.** Cut `inferDependenciesByImpact` and `hasPhrase` |
| `pm/agent.ts` | **Refactor.** Prompt becomes a skill; add a plan tool; one standup |
| `pm/service.ts` | **Refactor.** Move the lease out; snapshot adds goals, decisions, brief and assumptions |
| `pm/apply.ts` | **Keep.** Fix the split acceptance-test inheritance; route creates through the planner contract |
| `pm/capability.ts` | **Keep.** Use the kernel's `cardKind` |
| `pm/metrics.ts`, `store.ts`, `slash.ts`, `libraries.ts`, `types.ts` | **Keep** |
| `pm_api.ts` | **Refactor**, when it is next touched |
| `ui/pm.ts` | **Refactor.** Split into 4–5 modules |
| `wave2.ts` `planCommand` / `queuePrelude` | **Refactor.** Move to `planning/`; `queuePrelude` becomes named steps |

Nothing in this domain should be cut or rebuilt from scratch.

## Top 5 changes

**1. One planner, model first, and Seshat uses it.**
- *What:* `/plan`, `propose_create_card`/`split` and a new `start_project` tool all run `designStage → decomposeSpec(model) → INVEST → persist` and return the result as one proposal group. Default the planner model to the manager model.
- *Why:* two contract-free paths and the heuristic default (§2 and §3; `apply.ts:45`, `config.ts:40`); non-developers cannot start a project.
- *Effort:* L. *Risk:* model swap latency on a 24 GB host (run it while the Worker is idle, as the PM already does); model variance.
- *Measured by:* the plan's *planning measure* (fixture specs planned from scratch). Report the share of nonsense cards (such as "Email: happy path") and the share of cards whose staged test fails against a stub export.

**2. An acceptance-criterion contract.**
- *What:* every slice (hazard, split, riskiest included) must carry a behaviour; a deterministic criterion lint rejects title-echo criteria; fix the rule's second criterion; flag model invariants `early`; add few-shot examples to `SLICE_PROMPT`.
- *Why:* see "The quality of acceptance criteria" above; `spidr.ts:315, 397-402, 596, 892`.
- *Effort:* M. *Risk:* the lint may be too strict for the heuristic fallback.
- *Measured by:* the lint's pass rate on the planning measure; the Worker's first-attempt pass rate and send-back rate on planned cards against the baseline.

**3. Fix the five bugs and close the test gaps.**
- *What:* sentence splitting in the design stage, replan carrying `riskiest`/source, split acceptance-test inheritance, split-child behaviours, `capability.cardKind` reading labels. Add direct tests for INVEST, the split loop and ceilings, and malformed-JSON negatives; move the persistence tests to on-disk SQLite.
- *Why:* §5 and §6.
- *Effort:* S–M. *Risk:* low.
- *Measured by:* a red-first regression test per bug; capability-by-kind showing non-"Other" rows on a real project.

**4. Seshat's senior-PM skill, evaluated.**
- *What:* move the prompt into a versioned skill (the contents listed in §6), widen the snapshot (goals, decisions waiting, brief, assumptions, risks), give a plain-language standup mode for non-developers, and add a teaching mode for beginners.
- *Why:* `agent.ts:53-65`, `service.ts:195-232`, the positioning.
- *Effort:* M. *Risk:* prompt growth against the 8k context (`service.ts:30`), so budget the digest.
- *Measured by:* an evaluation of about 20 scripted conversations run on the real dirk-27b and scored against a rubric: answer first, numbers with a basis, no invented ids, proportionality (a calculator gets 0 questions, billing gets a brief), and proposals that pass the INVEST and criterion lints.

**5. Make the documents true and consolidate the duplicates.**
- *What:* reword the AGENTS.md ban (text in §2). Update HARNESS_DESIGN's Planner section on points (human-facing points *derived* from difficulty and history, tokens and time as the machine estimate), preemption and the user profile. Keep one standup builder and one question policy. Have signals *propose* Urgent instead of setting it.
- *Why:* the drift table in §2 and the duplicates in §3.
- *Effort:* S–M. *Risk:* low.
- *Measured by:* the domain-16 claims table; one standup test covering Slack, chat and the CLI; zero `updateCard` calls by the `planner` actor in `queuePrelude`.
