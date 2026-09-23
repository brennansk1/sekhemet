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

### DEC-10
**`main` tracks the work.** *Owner, 2026-09-22 (D2).* `main` was fast-forwarded to the working branch at `fb59ba2`, and is fast-forwarded again when each workstream lands with its gate green.
- **Why:** a fresh clone of a stale `main` got the wrong CLAUDE.md and a design 240 commits old.

### DEC-11
**A project's "done" is computed from evidence, like a card's.** *Owner, 2026-09-22.* LLMs are poor judges of when a project is finished and of how much to build; Sekhemet does not ask them. The brief becomes a graph of accepted requirements; a release slice is proven when every must-have requirement has passing tests and the project gates pass on `main`, and done when a person accepts it. Depth comes from a profile, a quality checklist, comparable products and a walkthrough — the model proposes, a person accepts ([research](../research/PROJECT_DONE_AND_DEPTH.md); COVERAGE P13, P14).
- **Why:** agents declare done early (a thinking model did so in 49% of NL2Repo tasks), miss about two thirds of unstated requirements, and add work nobody asked for; the spine's rule for cards is the proven fix, applied one level up.
- **Reopen if:** the implicit-requirement recall or premature-completion measure shows the mechanism no better than the conversation alone.

## Engineering decisions

### DEC-20
**Language support is TypeScript first.** *2026-09-20.* The ranked repo map and the parse gate are TypeScript. Python, Rust and Go degrade to a flat file map and an unchecked parse, stated on the card and in the evidence. Their functional gates (`pytest`, `cargo test`, `go test`) stay, because running the tests is most of a gate's value. Symbol-level support through tree-sitter is later work (a proposal in COVERAGE).
- **Reopen if:** a non-TypeScript project becomes a v1 target.

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
