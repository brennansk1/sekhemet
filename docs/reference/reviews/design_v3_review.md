# Design v3 — independent review

*Reviewer: a separate Claude Opus 5.5 instance whose only job was critique (brief: `review_brief.md`). Read-only against the code; no pnpm/tsc/vitest run. Reviewed 2026-09-22 between 23:30 and the time of this file; several documents were being edited while the review ran (COVERAGE, the plan and SPINE changed at 23:47), so every finding below was re-checked against the text as it stood when the finding was written. Line numbers are as of that moment.*

*Scope: SPINE, DECISIONS, NAMING, PM_CONTRACT, the fifteen specs, DEFINITION_OF_DONE v3, MODERNIZATION_PLAN, COVERAGE, OPEN_QUESTIONS; spot-checks of `built` claims against the code; the research files named in the brief.*

Severity: **blocker** — the design is not ready for spec-driven development (DoD §5.2 or the plan's A.5 exit) until it is fixed; **major** — a contradiction or gap a workstream would trip over, or a criterion that cannot become a failing test; **minor** — wording, numbering, staleness.

---

## Blockers

*(written incrementally; see the summary at the end for counts)*

