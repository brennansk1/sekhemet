# Capstone selection: the showcase project and how it is compared (2026-09-28)

**Decision (owner, 2026-09-28):**
- **Capstone:** a private, freshly written **shift timesheet and overtime-rules app** with a manager web UI.
- **Second run:** **one Web-Bench project**, reused unchanged, as an external comparison.

Both are given to Sekhemet with a local Coding model and to Claude models (Claude Code with Opus, Sonnet and Haiku), comparing time to completion and quality. Only the choice is made here. The brief, the scripted stakeholder conversation and the hidden tests are written and frozen before any run.

## Why these

What makes a comparison credible:
- **Hidden, freshly written tests.** SWE-bench Verified was retired for contamination and flawed tests ([OpenAI](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)). Models recall popular repositories' paths far better than others' (76% against 53%, [arXiv 2506.12286](https://arxiv.org/abs/2506.12286)).
- **Mergeability, not only test passes.** METR found 38% of agent pull requests passed the tests and none were mergeable ([METR](https://metr.org/blog/2025-08-12-research-update-towards-reconciling-slowdown-with-time-horizons/)).
- **Change requests with regression checks,** as in Vibe Code Bench 1-100 ([vals.ai](https://www.vals.ai/benchmarks/vcb-1-100)).
- **Integration realism.** Most failures in SaaSBench are at system integration ([arXiv 2605.17526](https://arxiv.org/abs/2605.17526)).
- **Harness-and-model pairs, not model names.** The harness alone moved tokens per solved task by up to 40× ([arXiv 2607.22585](https://arxiv.org/abs/2607.22585)). This is the claim the showcase tests: the harness is more than the sum of its parts.

To avoid:
- Widely cloned apps (todo, Tetris, URL shortener, Markdown parser). This is an inference: no study measures it for these apps.
- One-run comparisons scored by feel ([TechCrunch](https://techcrunch.com/2025/01/24/people-are-benchmarking-ai-by-having-it-make-balls-bounce-in-rotating-shapes)).

### The capstone: timesheets and overtime rules

- **Deterministic and hard to fake.** The money arithmetic is exact, and the rules are real and citable:
  - Release 1: US federal weekly overtime over 40 hours ([DOL](https://www.dol.gov/agencies/whd/overtime)).
  - **The mid-project change request:** California's daily overtime past 8 hours, double time past 12, and the seventh-day rule ([CA DIR](https://www.dir.ca.gov/dlse/faq_overtime.htm)).
- **Edge cases where the checks earn their keep:**
  - shifts crossing midnight;
  - daylight-saving days;
  - rounding;
  - correcting an approved timesheet;
  - stacked rules counting the same hours twice (the known trap for a small model).
- **It exercises the whole process:**
  - a stakeholder conversation with Seshat;
  - Must/Should/Could requirements and re-planning after the change;
  - two or three releases (a changed CSV export forces a major version);
  - a timesheet grid for the visual and accessibility checks;
  - manager and employee roles.
- **Size:** about 20–30 issues in TypeScript on Node, with no external services or secrets.

### The second run: one Web-Bench project

Web-Bench: 50 TypeScript/web projects of 20 dependent tasks each, hidden Playwright end-to-end tests, a published baseline (Claude 3.7 Sonnet at 25.1%), and a permissive licence. The repository says Apache-2.0 and the paper says CC BY 4.0: check the licence before use. Sources: [arXiv](https://arxiv.org/html/2505.07473), [GitHub](https://github.com/bytedance/web-bench).

- **It gives:** comparability outside our own spec.
- **Its limits:**
  - public since May 2025, so it may be contaminated;
  - its task-by-task prompts bypass Sekhemet's brief and PM stage;
  - no change requests.

  It is the secondary result, not the capstone.

### Considered and not chosen

- **Meeting-room booking with RFC 5545 recurrence.** Daylight-saving recurrence arithmetic is likely too hard for the local model to finish.
- **A community tool library.** A good fit, but its correctness edges are weaker than payroll's.
- **Existing benchmark specs as the capstone:**
  - Commit0: Python, with visible tests ([arXiv 2412.01769](https://arxiv.org/abs/2412.01769)).
  - ProjDevBench: mostly C++ ([arXiv 2602.01655](https://arxiv.org/abs/2602.01655)).
  - Vibe Code Bench: needs external services and is partly private.

## Protocol (to freeze before any run)

- **Frozen inputs:**
  - one written brief;
  - one scripted stakeholder conversation, including the California change at a fixed point;
  - one empty seed repository with a pinned toolchain.
- **A hidden acceptance suite,** written in advance, never shown to any contestant, and published only after every run.
- **Arms:**
  1. Sekhemet with the local Coding model;
  2. Claude Code alone on the same brief (Opus 5.5, Sonnet 5, Haiku 4.5);
  3. optionally, Claude Code given Sekhemet's planned backlog, which separates planning's value from coding's.

  Report each as a harness-and-model pair. Run each arm 2–3 times: one trial at non-zero temperature is not a finding.
- **Metrics:**
  - hidden-test pass rate by Must/Should/Could;
  - regressions after the change request;
  - wall-clock time and the person's hands-on minutes;
  - tokens or cost;
  - mutation score of each contestant's own tests;
  - type, lint, security and accessibility findings;
  - requirements delivered;
  - releases tagged;
  - a blind review of mergeability.
- **The capstone doubles as B4.11's milestone:** a team takes a project from a stakeholder's conversation to an accepted release.

## Not verified by the research

- DevBench's exact implementation pass rate.
- Whether ProjDevBench's tests are hidden.
- Which Vibe Code Bench split is public.
- App-Bench's grading method.
