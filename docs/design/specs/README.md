# Specifications: one per subsystem

*The design below [SPINE.md](../SPINE.md). Each file says what one subsystem must do, what it does today, and what is left before v1 is done. A workstream starts from its spec; the spec changes in the same commit as the code.*

## Rules

1. **One source of truth per fact.** Behaviour lives in the spec; shapes live in the TypeScript types the spec names (`PM_CONTRACT.md` for the PM's HTTP shapes); vocabulary lives in [NAMING.md](../NAMING.md); decisions live in [DECISIONS.md](../DECISIONS.md); measurements live in `docs/reference/SUITE_RUNS.md`. A spec links to these; it does not copy them.
2. **Status is stated, never implied.** The front matter's `status` and the per-capability table under "State today" must agree with the code. `built` means reachable from a command a user runs and covered by a test that would fail without it; code reachable only from tests is `not-built`.
3. **Every gap has an owner.** Each capability that is `partial` or `not-built` names a change ID from `docs/reference/COVERAGE.md` (S, M, P, T) and has at least one acceptance criterion.
4. **Acceptance criteria are checkable.** Written as `WHEN <condition> THE SYSTEM SHALL <observable behaviour>` (EARS), each one specific enough to become a failing test before any code is written. No criterion says "should", "appropriately" or "robust".
5. **Drift is resolved, not recorded.** Where the old design and the code disagreed, the spec states the intended behaviour and says which side changes. A contradiction that needs the owner goes to "Open questions" with a recommendation.
6. **Nothing lost, nothing padded.** Every capability, mechanism, number, threshold and edge case the old design specified is kept — as behaviour, or as a gap with a change ID. Only prose and duplication are compressed: rationale stays where it stops someone re-proposing a rejected idea, and evidence is a link, not a retelling. Anything left out is recorded in [DESIGN_TRACE.md](../../reference/DESIGN_TRACE.md) with its reason and the owner's decision.

## Front matter

```yaml
---
spec: worker-loop              # the file name without .md
status: partial                # built | partial | not-built  (the subsystem as a whole)
audiences: [developer]         # developer | beginner | non-developer — who touches it directly
code: [packages/loop/src/session.ts]      # the main modules, repo-relative
tests: [packages/loop/tests/session.spec.ts]
changes: [M1, M3, M8]          # COVERAGE ids this spec carries
---
```

## Sections, in this order

1. **Purpose** — two or three sentences: what it is for, and which spine rule or audience it serves.
2. **Behaviour** — the normative description, as numbered statements.
3. **Contract** — the types, events, commands, config keys and endpoints, each pointing at its source file.
4. **State today** — a table: capability · `built` / `partial` / `not-built` · evidence (`file:line` or test) · change ID.
5. **Changes for v1** — per change ID: the problem in one line, then its acceptance criteria.
6. **v1 acceptance** — the criteria that, all passing, make this spec `built`. Usually the union of §5 plus any behaviour in §2 not yet under test.
7. **Later** — what is deliberately out of v1, and why.
8. **Open questions** — each with a recommendation.
9. **Evidence and rationale** — links to research, reviews, runs and decisions.

## The specifications

| Spec | Subsystem |
| --- | --- |
| [surface.md](surface.md) | The CLI, first run, configuration, onboarding an existing repository |
| [kernel.md](kernel.md) | Event log, projections, card lifecycle and its state machine |
| [worker-loop.md](worker-loop.md) | The Worker's loop, tools, stop reasons, repair ladder, working method |
| [context.md](context.md) | Context assembly, scope, context-rot defence, prompt layout and the playbook |
| [gates.md](gates.md) | Gate layers, project gates, `gates.toml`, gate economics |
| [models.md](models.md) | Hardware calibration, the model registry, inference servers, bake-off |
| [measurement.md](measurement.md) | The frozen suite, the planning measure, statistics, self-improvement |
| [planner-pm.md](planner-pm.md) | The planner, the PM (Seshat), goals, human collaboration |
| [design-stage.md](design-stage.md) | The design stage, new projects, research and reuse |
| [review-git.md](review-git.md) | The Reviewer, Accept, the git workflow |
| [dashboard.md](dashboard.md) | The web dashboard: board, review, status, Learn layer, visual system |
| [security.md](security.md) | Sandboxing, permissions, egress, secrets, workspace trust, air-gap |
| [integrations.md](integrations.md) | GitHub, Jira, Linear, notifications, identity sources for the Team setup |
| [teams.md](teams.md) | Solo and Team setups, accounts and sign-in, access levels, AI teammates, inbox, presence, audit, project updates |
| [extensibility.md](extensibility.md) | Hooks, skills, MCP, ACP (plugins and the SDK are cut, DEC-29) |
| [runtime.md](runtime.md) | Daemon, runner lease, sessions, the HTTP API, audit, telemetry, retention |

## Where the old design went

The design of 2026-09-17 (`HARNESS_DESIGN.md`, 3,539 lines) and its companions were dissolved into the documents below on 2026-09-22 and deleted; git keeps them. To read the old text, for example where a code comment cites an old section:

```bash
git show fb59ba2:docs/design/HARNESS_DESIGN.md
```

| Old section or document | Now in |
| --- | --- |
| Purpose, scope and locked decisions; Name and brand; Product definition; System architecture | [SPINE.md](../SPINE.md), [DECISIONS.md](../DECISIONS.md) |
| Capability parity audit | Each capability it required is carried into the spec that owns it; only the dated competitor columns were removed (the current landscape is research group C in [WEB_RESEARCH_2026-09.md](../../research/WEB_RESEARCH_2026-09.md)) |
| The surface the user touches; configuration schema; repository onboarding and language support | [surface.md](surface.md) |
| Data model; card lifecycle; event and database schemas | [kernel.md](kernel.md) |
| Small-model leverage; Worker loop; top-model tool semantics; repair contracts; tool catalog (Worker tools) | [worker-loop.md](worker-loop.md) |
| Context assembly; from a specification to a scope; context-rot defence; prompt architecture and the playbook | [context.md](context.md) |
| Definition of Done gate layers; project gates; gate economics; `gates.toml` | [gates.md](gates.md) |
| Hardware calibration; model registry and bake-off | [models.md](models.md) |
| Measuring the harness; recursive self-improvement; benchmarks on the founder's hardware | [measurement.md](measurement.md), [OPEN_QUESTIONS.md](../../reference/OPEN_QUESTIONS.md) |
| Planner; human collaboration; goals; `PM_DESIGN.md` Parts 1, 2 and 4 | [planner-pm.md](planner-pm.md) (HTTP shapes stay in [PM_CONTRACT.md](../PM_CONTRACT.md)) |
| The design stage; starting a new project; web research | [design-stage.md](design-stage.md) |
| The Reviewer; git workflow | [review-git.md](review-git.md) |
| User interface; frontend design system; `FRONTEND_DESIGN.md`; `PM_DESIGN.md` Part 3 | [dashboard.md](dashboard.md) |
| Security and sandboxing; air-gap kit | [security.md](security.md) |
| Integrations and sync; GitHub | [integrations.md](integrations.md) |
| Extensibility; skills catalog; tool catalog (other tools) | [extensibility.md](extensibility.md) |
| Sessions and runtime; audit, telemetry and compute governance; REST and WebSocket API | [runtime.md](runtime.md) |
| Integrated open-source component register; provenance and licence register | [PROVENANCE.md](../../reference/PROVENANCE.md) |
| Implementation stack and repository layout | [SPINE.md](../SPINE.md#how-the-parts-fit) and `CLAUDE.md`; the rest contradicted the code and the Definition of Done |
| Build phases and MVP cut line | [MVP_PATH.md](../../reference/MVP_PATH.md) (historical) |
| Open questions, benchmarks and research gaps | [OPEN_QUESTIONS.md](../../reference/OPEN_QUESTIONS.md) |
| Rejected techniques and non-goals | [DECISIONS.md](../DECISIONS.md) (DEC-22, DEC-23) |
| `INTEGRATION_REVIEW.md` (2026-09-18) | A dated review, moved to [reviews/integration_review_2026-09-18.md](../../reference/reviews/integration_review_2026-09-18.md); its findings are folded into the specs |
| `FEATURE_INVENTORY*.md` (three files) | Deleted ([DEC-09](../DECISIONS.md#dec-09)); status now lives in each spec's front matter |
