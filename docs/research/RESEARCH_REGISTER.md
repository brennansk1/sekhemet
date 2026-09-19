# Research register

Each candidate technique moves through a fixed lifecycle, with its evidence and an adoption threshold set **before** it is benched, so a result cannot move the bar it is judged against (design, "Register files").

`sekhemet register advance <id> <state> --evidence "..."` moves an entry and refuses an illegal move. `sekhemet register check` and `apps/harness/tests/registers.spec.ts` fail the build when an entry breaks a rule below.

**Lifecycle.** `spotted` → `triaged` → `shortlisted` → `benched` → `adopted` or `rejected`. An entry may be `rejected` from any state. Nothing skips a state on the way to `adopted`.

**Rules.**
1. From `shortlisted` on, the entry has an adoption threshold and the date it was set.
2. `benched`, `adopted` and `rejected` entries carry evidence: a measurement, a commit, a test or a cited source.
3. The threshold date is on or before the date of the entry's last move, so the bar came first.

Entries adopted before this register existed (2026-09-19) say so in their evidence; their thresholds were written down on that date and still await a bench run.

Keep the header exactly as it is.

| ID | Technique | Source | State | Threshold | Threshold set | Evidence | Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Repo map via PageRank over AST tags | Aider repository map | adopted | Top-10 ranked files contain the edited file on at least 70% of Chronicle cards | 2026-09-19 | Adopted by the design before this register; built in a5cf84a (packages/context/tests/context_units.spec.ts). Not yet benched against this threshold | 2026-09-19 |
| R2 | Native output condensing (four strategies) | RTK (`rtk-ai/rtk`) | adopted | At least 60% fewer tool-output tokens with no rise in repair turns | 2026-09-19 | Adopted by the design before this register; packages/context/tests/condenser.spec.ts. Not yet benched against this threshold | 2026-09-19 |
| R3 | Query-aware line pruning | SWE-Pruner (arXiv:2601.16746) | shortlisted | At least 20% fewer context tokens at no Pass@1 loss on Chronicle | 2026-09-19 | A heuristic pruner is built (packages/context/src/pruner.ts); the neural skimmer needs the gate host | 2026-09-19 |
| R4 | Per-model tool-call format (flat, JSON, constrained) | Format Tax (arXiv:2408.02442) | adopted | The chosen arm beats the others by 5 points of tool-call validity for that model | 2026-09-19 | Adopted by the design before this register; arms measured per model (packages/models/tests/registry_calibration.spec.ts) | 2026-09-19 |
| R5 | Variant archive for self-improvement | Darwin Gödel Machine (arXiv:2505.22954) | shortlisted | A kept variant beats the incumbent by 2 cards on the frozen fixtures with no guardrail regression | 2026-09-19 | packages/eval/src/archive.ts is built; not benched on a live model | 2026-09-19 |
| R6 | On-the-fly tool synthesis | Live-SWE-agent (arXiv:2511.13646) | triaged | | | | 2026-09-19 |
| R7 | Demonstration-guided harness evolution | DemoEvolve (arXiv:2605.24539) | spotted | | | | 2026-09-19 |
| R8 | AI reviewer against the lead's preferences | AutoDev (arXiv:2403.08299) | adopted | At least one send-back reason in five caught before the human sees the card | 2026-09-19 | Adopted by the design before this register; apps/harness/tests/review.spec.ts. Not yet benched against this threshold | 2026-09-19 |
| R9 | Self-refine loops for code quality | Design, "Rejected approaches" | rejected | Beats equal-cost repeated sampling | 2026-09-19 | Measurably worse than repeated sampling at these model scales (design, rejected approaches) | 2026-09-19 |
| R10 | Multi-agent debate | Design, "Rejected approaches" | rejected | Beats a single agent at equal cost | 2026-09-19 | Fails to beat a single agent while costing far more (design, rejected approaches) | 2026-09-19 |
| R11 | Embedding RAG as the primary context mechanism | Design, "Rejected approaches" | rejected | Beats structure-aware retrieval on code | 2026-09-19 | Structure-aware retrieval beats it on code (design, rejected approaches) | 2026-09-19 |
