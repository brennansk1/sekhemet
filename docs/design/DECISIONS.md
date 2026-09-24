# Decisions

*Every settled decision in one place: what was decided, why, and what would reopen it. A decision is re-proposed only with the new evidence its "Reopen if" names — not with a new argument. Newest first within each group. The specifications cite these by number.*

## Product decisions

### DEC-01
**A coding harness for professional teams.** *Owner, 2026-09-22. Supersedes the 2026-09-17 target user, "a solo developer already running local models".*
Sekhemet runs the whole professional process — brief, planned backlog on a familiar board, cards built against executable gates, a person's acceptance — for three audiences: developers, beginners and non-developers ([SPINE](SPINE.md#what-sekhemet-is)).
- **Why:** agent output that skips the practice is hard to bring into a team; the practice itself is the product.
- **Reopen if:** the owner changes the positioning.

### DEC-02
**The spine.** *Owner; restated 2026-09-22.* Gates decide completion and the model never certifies its own work; the event log is the only durable channel; a card is the unit of work; the human is the rate limiter.
- **Why:** each is what makes the output trustworthy and the measurement honest. Phase A found places where the code does not yet keep them (COVERAGE S4–S7); the fix is the code, not the rule.
- **Reopen if:** only the owner.

### DEC-03
**Local inference in v1; cloud models per role after v1.** *Owner, 2026-09-22. Rewords the 2026-09-17 "100% local; no cloud models", which read as permanent.*
- **Why:** privacy and cost are part of the edge; a later cloud option must be something a person plugs into one role, never a dependency.
- **Reopen if:** v1 meets its Definition of Done (then cloud per role is planned, not reopened).

### DEC-04
**The Worker stays Cyber-Tiel-Coder-35B-A3B MTP (IQ3_XXS).** *Owner, 2026-09-22 (D1).*
- **Context:** it is an uncensored re-quantization of an abliterated Ornith-1.5, whose own model card says it is "not an ordinary coding agent" and requires OS-level sandboxing. The project's earlier research preferred the guardrailed Tiel-Coder; the published comparison between the two rests on 25 tasks and cannot separate them ([research, group D](../research/WEB_RESEARCH_2026-09.md)).
- **Consequence:** the sandbox, the permission engine and fail-closed confinement are the Worker's only guardrails. COVERAGE S3, S3a, S3b and S3c are v1-blocking, and security tests run against this model's behaviour, not a polite one's.
- **Reopen if:** a destructive action escapes the sandbox in any run; or a paired run of at least 30 tasks shows another local model of the same size ahead by 20 points or more.

### DEC-05
**One persona, for people; no ceremonies between agents.** *Owner, 2026-09-22 (D3). Rewords the rule "no simulated Scrum personas (no fake standups or product owners)".*
- Agents never role-play a team: the Worker, Planner, Reviewer and Researcher are registry roles with no names, voices or conversations with each other.
- Standups, retrospectives and status are **reports for people**, written from the event log by one persona, *Seshat, the project manager*, whom people talk to.
- **Why:** role-played multi-agent teams fail on coordination and cost (see the rejected list below); a named, plain-spoken PM is what non-developers asked for.
- **Reopen if:** the owner changes it.

### DEC-06
**A company-server mode is in v1, at a minimum.** *Owner, 2026-09-22 (D7). Removes "teams and multi-user boards" from the v1 non-goals.*
v1 includes: binding to a non-loopback address safely; an identity for each person, taken from an identity-aware proxy or a local account; one permission beyond reading — who may Accept; and every event attributed to its person. Not in v1: roles beyond that, SSO integrations beyond the proxy, multi-tenant boards.
- **Why:** the positioning names "your company's server"; without identity, every writer is "human" and anyone who can reach the port can accept.
- **Reopen if:** the owner narrows v1.

### DEC-07
**A ceiling run with a frontier model only after local v1 is done.** *Owner, 2026-09-22 (D6).*
- **Why:** it separates harness defects from model limits, but only means something once the local product is complete; it costs API money.
- **Reopen if:** v1 meets its Definition of Done.

### DEC-08
**Libraries approved to add, when their workstream arrives.** *Owner, 2026-09-22 (D5).* SPDX parsing (`spdx-expression-parse`, `spdx-satisfies`, `spdx-correct`), and the official clients `@octokit/*`, `@modelcontextprotocol/sdk`, `jira.js`, `@linear/sdk` and Slack Bolt. Every other proposal in COVERAGE still needs the owner's yes, one by one.
- **Why:** they replace hand-rolled code the reviews found wrong (the licence check rejects MIT-0 and "MIT AND …"; three GitHub paths with three ID formats).
- **Reopen if:** a licence or maintenance check at the time of adding fails.

### DEC-09
**Dead code is cut; three modules are wired in or cut by their workstream.** *Owner, 2026-09-22 (D4).* Cut: `packages/ui/src/canvas.ts`, `container.ts` (kernel and sandbox), `buildFullPromptPack` and the context `engine.ts`, the three `FEATURE_INVENTORY` files. Decided by their workstream, recorded in its spec: `retention.ts`, `apps/harness/src/research/desk.ts`, `adjudicate` and `acceptRevision` in `claims.ts`.
- **Why:** code reachable only from tests is dead; it misleads the next reader and the reachability gate.
- **Correction (2026-09-22, platform spec pass):** `container.ts` is not dead — `execute.ts:378-386` builds a `ServiceContainer` and `PluginManager` on every card. The recommendation is still to cut it (plugins add only services and hooks, and run repository code unsandboxed), but cutting reachable code is a new decision: **the owner decides** ([extensibility](specs/extensibility.md) §8). Until then it stays, gated by workspace trust (S9).

### DEC-10
**`main` tracks the work.** *Owner, 2026-09-22 (D2).* `main` was fast-forwarded to the working branch at `fb59ba2`, and is fast-forwarded again when each workstream lands with its gate green.
- **Why:** a fresh clone of a stale `main` got the wrong CLAUDE.md and a design 240 commits old.

### DEC-11
**A project's "done" is computed from evidence, like a card's.** *Owner, 2026-09-22.* LLMs are poor judges of when a project is finished and of how much to build; Sekhemet does not ask them. The brief becomes a graph of accepted requirements; a release slice is proven when every must-have requirement has passing tests and the project gates pass on `main`, and done when a person accepts it. Depth comes from a profile, a quality checklist, comparable products and a walkthrough — the model proposes, a person accepts ([research](../research/PROJECT_DONE_AND_DEPTH.md); COVERAGE P13, P14).
- **Why:** agents declare done early (a thinking model did so in 49% of NL2Repo tasks), miss about two thirds of unstated requirements, and add work nobody asked for; the spine's rule for cards is the proven fix, applied one level up.
- **Reopen if:** the implicit-requirement recall or premature-completion measure shows the mechanism no better than the conversation alone.

## Engineering decisions

### DEC-25 — the lead's rulings during the design v3 fix pass
*Lead, 2026-09-22. Each settled a conflict between two new documents or between a document and the code; the code's behaviour won unless a reason is given. Rulings marked **owner** change behaviour a person sees and wait for the owner's confirmation ([OPEN_QUESTIONS](../reference/OPEN_QUESTIONS.md#owner-decisions)); until then the ruling is the default.*

| # | Ruling | Owning spec |
| --- | --- | --- |
| R1 | A checkpoint commit after every step that changed files (`execute.ts:422`), and before Verify; the runner's library default of 5 applies to other callers | review-git |
| R2 | The Worker's `ask` answers from the card's contract; if nothing matches and the PM is available, Seshat answers now. A non-blocking decision request is a gap | worker-loop |
| R3 | MLX is an engine label only; an adapter is Later | models |
| R4 | The Worker's research tools are named as the code names them (`git_history`, `dependencies`, `ask`, `recall`) | worker-loop |
| R5 | `plan_research` is owned by design-stage | design-stage |
| R6 | A tracker edit never pauses a running card; at its end, a changed scope or criteria sends it to Planning with the change named | integrations |
| R7 **owner** | Weights are never downloaded on the harness's own initiative; a person may run an explicit download command, and the published hash is verified before use | models, security |
| R8 | Unsolicited messages: 3 a day per person by default, never more than 5 | planner-pm |
| R9 | SPIDR's *Interface* is the user interface; a type contract is a Contract card (see DEC-26) | planner-pm |
| R10 | Roles have no avatars; the assignee is a text chip | dashboard, NAMING |
| R11 | A blocked card shows the fail tone, an icon and the word "Blocked" | dashboard |
| R12 | Execution-verified lessons may apply in production on probation; never in a measurement run | measurement, context |
| R13 | A run's settings are one recorded `RunProfile`; a named settings file is allowed, a flag that rewrites other flags is not | surface, measurement |
| R14 | Per-language gate templates in gates.md; a language's mutation tool runs when installed, as a subprocess | gates |
| R15 **owner** | Seshat's model name is not in the panel header; it is in the panel's details and on Machine | dashboard |
| R16 | Visual-gate libraries stay proposals; the gate's required behaviours are carried regardless | gates |
| R17 | Every view keeps a way in: `g k` Playbook, `g u` Runs, `g n` Integrations, or the palette | dashboard |
| R18 | The Settings view is kept | dashboard |
| R19 | Static file serving refuses `..` and serves correct MIME types | runtime |
| R20 | The integration review's findings (dossier, residency scheduler, role budgets, rule curation, tools described once, retries, one attempt record) are requirements | kernel, worker-loop, context, models |
| R21 | Every named third-party component has a licence row; copyleft runs as a separate process | PROVENANCE |
| R22 | One run hierarchy, defined in NAMING (superseded in detail by DEC-26) | NAMING |
| R23 | A `built` claim the code does not support is corrected, and so is built code listed as Later | all |
| R24 | Deliberate reversals are recorded (DEC-24) | all |
| R25 | The fixtures' recorded bars are kept in measurement | measurement |
| R26 | Sampling values and launch profiles are kept in models or its registry file | models |
| R27 | One memory-watchdog table, owned by models | models |
| R28 | Test infrastructure lives in DEFINITION_OF_DONE §2D | DoD |

### DEC-26 — one vocabulary for the kind of card and the run
*Lead, 2026-09-24, resolving review blockers B3 and B4.*
- **`kind`** (stored, closed, `packages/kernel/src/card_class.ts`) is the truth: `spike`, `interface`, `implement`, `data`, `rule`, `review`, `research`. It selects the Worker's tools, the red-first rule and rule scoping. People see labels from one map in [NAMING](NAMING.md): `interface` → *Contract*, `data` → *Storage*, `implement` → *Flow*, `rule` → *Rules*, `spike` → *Spike*, `research` → *Research*, `review` → *Review*. *UI* and *Wiring* are display refinements of `implement` (the card's scope is UI files; the card only connects finished parts), never stored kinds. The dashboard's separate `CardKind` type in `vocabulary.ts` is folded into this map (NEW-dashboard-2).
- **SPIDR is how a story was split, not what kind of card resulted.** The planner records the axis it split on as `split` (`spike`, `path`, `interface`, `data`, `rules`), where SPIDR's *Interface* means the user interface (Cohn). A type contract is always `kind: interface`, labelled *Contract*.
- **`change`** (stored, closed): what a card does to existing code — `feature`, `fix`, `characterize`, `refactor`, `upgrade`. A new project's cards are `feature`. It is a separate field from `kind` (gates §8 Q3, decided).
- **The run:** an **attempt** is one recorded run of a card to a stop; it holds one **sample**, or up to k under pass@k; a sample is a sequence of **steps**; a step is one model request and the tool calls it makes. "Turn" is the code's synonym for step and is not used in specifications. The step budget counts steps.

### DEC-27 — context budgets are fixed in tokens at the reference window
*Lead, 2026-09-24, resolving review blocker B5.* At the reference Worker's prompt budget W = 9,984 tokens (16,384 − 4,096 answer − 2,048 thinking − 256), a fraction 0.12W (1,198 tokens) cannot hold a system prompt and tool interface capped at 3,000. The stable zone is therefore budgeted in tokens: **Zone 1 ≤ 2,400 tokens including native tool schemas**, of which the system prompt ≤ 700 and the tool interface ≤ 1,700 (a fixed, flat tool set per card class, M2); the remaining zones share W − Zone 1 in the proportions [context](specs/context.md) rule 10 gives. On a larger window the token caps stay and the proportional zones grow. The allocator asserts these on the live path for the reference Worker's real prompts.

### DEC-28 — one rule for admitting what the system learns
*Lead, 2026-09-24, resolving review blocker B6. Owned by [measurement](specs/measurement.md) §2; every other document points there.*

| What is learned | Admitted by | Kept or retired by |
| --- | --- | --- |
| A **project playbook rule** (this repository's paths, kinds, error codes) | A person's approval | Paired credit on this project's own attempt records, with rotation; retired automatically when its credit turns negative over its last 10 applications |
| An **execution-verified lesson** during a run | Probation in production only (never in a measurement run) | The same credit; it becomes a candidate for a person's approval at the run's end |
| A **harness change** (prompt, tool, budget policy, skill, context version) | A paired frozen-suite A/B that shows a gain at the suite's resolution (at least 20 points on 30 cards, exact test at 0.05) | **Inconclusive** (the usual case): the change may be adopted only if it is cheaper or simpler and the paired result shows no significant loss, recorded as "not established"; otherwise it is not adopted |

No admission rule relies on an effect the measurement cannot resolve.


### DEC-20
**Language support is TypeScript first.** *2026-09-20.* The ranked repo map and the parse gate are TypeScript. Python, Rust and Go degrade to a flat file map and an unchecked parse, stated on the card and in the evidence. Their functional gates (`pytest`, `cargo test`, `go test`) stay, because running the tests is most of a gate's value. Symbol-level support through tree-sitter is later work (a proposal in COVERAGE).
The harness itself stays TypeScript: a Rust or Python component is allowed only where profiling proves a bottleneck — the repo-map builder is the likeliest first candidate, a line pruner the second.
- **Reopen if:** a non-TypeScript project becomes a v1 target.

### DEC-24 — deliberate reversals in design v3
*2026-09-22, each forced by a measurement, research or a review finding; the detail is in the owning spec's §9.*

| Was (design of 2026-09-17) | Now | Why |
| --- | --- | --- |
| Observation masking keeps the last two observations | The five most recent stay full; masking happens in batches | SWE-agent's ablations; masking every turn breaks the prompt cache (research group A) |
| Earlier reasoning is stripped between steps | Earlier thinking is preserved (or stripped only at a masking point) | An edited prefix forces a full re-read on hybrid-attention models (research group A) |
| llama.cpp cache flags 8–16 GiB, 32 checkpoints, min-step 8192, `-sps` | Sized per host (2–8 GiB, 6–16 checkpoints), min-step 512–1,024, `-sps` dropped | Checkpoint placement moved to message boundaries upstream; 16k-window hosts keep only two checkpoints at the old spacing |
| A spec with more than three questions is refused as under-specified | Never refused: propose defaults and proceed | Proportional design stage (owner, 2026-09-22) |
| A card parks and frees memory while its question is open | Work proceeds on the stated default; a `default_deny` question (one whose default is "do not proceed") parks the card **from the request** until it is answered or its deadline passes | The Worker is not idled by a question it can proceed past, and never proceeds past one whose default is to stop |
| Self-improvement rolls back when the pass rate drops over the next ten cards | Rollback on a paired comparison | A ten-card window cannot separate noise from effect (research group D) |
| Six stop reasons | Twenty-three stored in v1 (the 18 in code plus `gate_suspected`, `tests_not_red_for_reason`, `hook_veto`, `git_metadata_tampered`, `crashed`), in one table in [worker-loop](specs/worker-loop.md), shown as seven failure classes (adding "environment") and one success class | Machine failures must never read as the Worker's fault |
| INVEST pre-flight before In Progress | Before Ready | The Worker must never pick up a card that fails it |
| Send back returns a card to In Progress | Send back returns it to Ready | A returned card is re-queued, not resumed mid-attempt |
| INVEST "Small": context pack ≤ 25% of a 32,768-token working context | ≤ 25% of the resolved Worker's window from the registry — 4,096 tokens on the reference Worker's 16,384 | The old default sized cards for a window the Worker does not have (review M11) |
| Unpark returns a card to its previous state | Unpark returns it to Ready, or to Backlog or Planning if it was parked from there | The state machine has no edge back into In Progress, Verify or Review, and a parked attempt is not resumed mid-flight |

### DEC-21 — accepted substitutions
*Accepted 2026-09-20; the design's claims were amended to match what is built.*

| Substitution | Instead of | Why | Reopen if |
| --- | --- | --- | --- |
| bubblewrap on Linux | Landlock + seccomp | Works on every kernel we target; the isolation level is recorded per card. Landlock and seccomp become hardening | A bubblewrap escape relevant to our threat model |
| Plain git worktrees | Copy-on-write clones | No correctness difference; portability beats setup speed | Worktree setup dominates card time |
| A keyword heuristic for context pruning | SWE-Pruner, a learned line pruner | Deterministic, free, no resident model; the learned pruner's value here is unmeasured, and published work found a learned scorer no better than random at equal budget | The pruner beats structure-preserving random line dropping on the frozen suite |
| A source installer | Packaged offline installers | Air-gap setup is rare; packaging per platform is recurring work | Air-gapped teams become a target |

### DEC-22 — rejected techniques
*Settled on evidence. Each is reopened only by a measurement on this harness that the "why" did not anticipate.*

| Rejected | Why |
| --- | --- |
| Agents playing Scrum roles to each other | Role-based multi-agent teams fail on coordination; the leading framework in the style folded its roles back together (DEC-05 keeps one persona for people) |
| Parallel agents writing the same files | Conflicting implicit decisions; one writer per file |
| The agent certifying its own work | The spine |
| Self-refine and reflection loops as a quality mechanism | Worse than equal-cost repeated sampling at these model scales |
| Multi-agent debate | Does not beat a single agent, at far higher cost |
| Unbounded best-of-N | Without a verifier it underperforms; with gates it is still capped |
| Hard schema constraints by default | Turns visible format errors into silent reasoning loss on small models; a measured per-model choice instead |
| Persona prompting for quality ("you are a senior engineer") | No evidence of effect on code correctness; seniority is enforced by structure |
| Embedding RAG as the primary code context | Structure-aware retrieval beats it on code |
| Large-context stuffing | Quality falls with length; distractors mislead |
| Continuous-embedding context compression | Fails on multi-step agentic coding |
| A wrapper around proprietary CLIs | The category's commercial graveyard |
| Fine-tuning our own models | Premature until the failure history is large and in-context methods plateau |
| A dense embedding index for documentation | A resident embedder costs memory the Worker needs; BM25 is strongest at this corpus size |
| Public agent trajectories as exemplars | They carry another harness's tool vocabulary into the prompt's stable zone |
| Routing fitted to public benchmark results | Scaffold dominates those results; no public data has our tool dimension |
| KV-cache eviction for throughput | A large-batch gain; this harness runs at batch one |
| A tabular foundation model for the competence model | A second resident model beside a mean that works |
| A seventh durable store | Three kinds exist: guidance, measurements, fetched bytes |

### DEC-23 — what the harness is not
Not a chat assistant (the conversation plans and reports; code is written on cards), not an IDE, not a CI system, and not a replacement for the team's tracker — it fits beside one. It does not aim to beat frontier models on ambiguous, long-horizon or novel design work, and it is slower per card than cloud tools. These trades are deliberate.

## Founder decisions on record

- **Name:** Sekhemet, a deliberate variant spelling, paired with its descriptor where the product introduces itself.
- **Licence:** MIT.
- **Still the owner's:** the business model; whether go-to-market ever targets defence.
