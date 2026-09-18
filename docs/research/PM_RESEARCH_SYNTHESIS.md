# PM research synthesis: from the two Deep Research reports to a plan

Source material:
1. "Building Sekhemet's PM Agent: Capability-Aware, User-Learning, Self-Improving" (Claude Research, 2026-09-18).
2. "Architectural Mitigations and Infrastructure Strategies for Autonomous Coding Agents" (companion report).

This file records what the reports found, what the harness already does, and what to build next, in order. Figures are cited as each report gave them. Figures marked **(unverified)** came from one report only, or rest on a secondary source, so confirm them before relying on them in a design argument.

## 1. What the evidence says, and whether Sekhemet already does it

| # | Finding | Status in Sekhemet |
|---|---|---|
| 1 | **Line-level localization is the highest-ROI scaffolding**: +4–8 pp absolute solve rate (RGFL 51.6→58.2% SWE-bench Verified; ARISE line R@1 +58% relative). | **Done.** `failureCode()` shows the source at each failing line; the API member lookup names a type's real members (`c77c359`, `8cecd2d`). |
| 2 | **Hazard / half-life law** (Ord 2025; METR time horizon): a 1 h task at 50% implies ~25% at 2 h. 99% reliability needs tasks about 1/70 of the 50% horizon. Split aggressively. | **Partly.** Cards are capped at 3 files / 200 lines. Not yet derived from a measured horizon (see §2, step 3). |
| 3 | **Retries don't grow the solvable set**: pass^k decays (τ-bench GPT-4o 61%→25% at k=8). Cap retries and escalate. | **Partly.** A 2/1/1 repair ladder plus one manager retry. The cap is not yet tied to measured outcomes. |
| 4 | **Reflection needs an executable signal**: "LLMs cannot self-correct reasoning yet" without one. | **Done.** Every repair is anchored to gate results; re-checks run after every edit (`4e7d9a7`). |
| 5 | **Frozen-model self-improvement through context, not weights.** ACE (evolving playbook with helpful/harmful counters, Generator/Reflector/Curator, delta updates) and GEPA (+6% average, up to +20% over GRPO at 35× fewer rollouts). | **Seed only.** The playbook exists, and send-back notes become candidates. No counters, curation or A/B testing yet (§2, step 4). |
| 6 | **Verify-before-persist** for skills and rules (Voyager: −73% without self-verification). More skills can hurt ("Not All Skills Help"). | **Not yet.** Add it to the playbook promotion gate (§2, step 4). |
| 7 | **Context budget**: lost in the middle (>30% mid-context loss); NoLiMa ~30 pp loss by 32k even for frontier models. Qwen3 RULER looks strong but is lexical. | **Partly.** Prompts are budgeted to the window with staged reductions, and the goal goes at the tail. Rules are not yet retrieved top-k per card. |
| 8 | **The capability model comes from the ledger, not benchmarks.** There is no public data for Cyber-Tiel, dirk-27b, Nail or IQ3_XXS at this scale. Use Wilson intervals first, then logistic/IRT difficulty calibration, and Elo across models on shared fixtures. | **Seed only.** `workerRecord()` gives the PM pass rate, median turns and failure reasons. No intervals, calibration or task taxonomy yet (§2, step 3). |
| 9 | **Preference learning**: rule extraction from edits and send-backs, not DPO. Treat edits to PM proposals as preferred/dispreferred pairs; never treat silence as negative. Decay stale rules (Erev-Roth style); scope rules per repo or task type. | **Not yet** (§2, step 5). |
| 10 | **Proactivity**: at most 3–5 unsolicited pings a day; offering beats nagging (preferred 90% vs 47%, CHI 2025); recovering from an interruption costs ~23 min. | **By design so far.** The PM only speaks when asked; the only outbound message is the Slack run report. Keep a budget when standups and alerts land. |
| 11 | **Swap cost is the sharpest hardware pain** (40–120 s). Mitigations: KV/prompt-cache persistence; a static prompt head (dynamic content only at the tail); batching PM work; a small resident triage model for status questions. | **Partly.** Pausing the worker is designed around the swap. There is no cache persistence, and PM status questions still load the 27B. |
| 12 | **MTP / speculative decoding is lossless for quality**, but report 2 says llama.cpp's Metal MTP can be a net throughput loss (−11–24%) **(unverified)**. | **Measure it.** Benchmark Cyber-Tiel with and without `--spec-type draft-mtp` on this machine. |
| 13 | **3-bit on a 3B-active MoE is the riskiest quant.** It needs an imatrix calibrated on code and tool use, and nobody knows how much of the 25–40% failure rate is quantization. | **Open.** Run the ledger fixtures on a Q4/Q5 build of the same model to separate quant damage from scaffolding (§2, step 2). |
| 14 | **Evaluation validity**: n=6 has a 95% Wilson interval of roughly 30–95% at 70% pass. Report 2 says 7.8% of "solved" SWE-bench patches are wrong and 32.7% involve leaked solutions **(unverified)**. Harden fixtures with mutation testing so agents can't pass by weakening tests. | **Partly.** Tests are protected (the permission engine denies edits) and fail-to-pass is proven per card. The suite is too small: 6 Chronicle cards plus 24 Trifecta cards. |

## 2. Plan, in dependency order

Report 2's ordering is right: fix the foundation (measurement, then swap cost) before learning loops, because learning without a valid measure is noise.

1. **Evaluation foundation (next).** Run the three Showcase Trifecta fixtures (24 cards) so every change is judged on 30 cards, not 6. Report pass rates with Wilson intervals in the queue report and Runs view. Add mutation testing (Stryker) as an optional gate on fixtures so a card can't pass by gutting assertions.
2. **Separate quant damage from scaffolding.** Run the fixture suite on the same worker at a higher quant (Q4_K_M, if it fits in 24 GB alongside the KV cache) and at IQ3_XXS. If the higher quant gains more than ~15 pp, the model is the bottleneck, not the harness. Also benchmark MTP on and off.
3. **Capability model v1.** Build a task-type taxonomy from the gate that failed and the card's SPIDR kind (Contract, Storage, Flow, Rules). Compute per-type Wilson intervals from the ledger, and a logistic fit of pass against difficulty and size, giving a personal "80% horizon". Feed it to the PM's snapshot and to the split rule: propose a split when P(pass) < 0.6 or size > the 80% horizon.
4. **ACE-style playbook.** Give every rule helpful/harmful counters driven by gate outcomes. A Reflector proposes rules from failed-then-fixed attempts. A rule is promoted only after it passes an A/B test on held-out fixtures and a human approves. Retrieve the top-k rules for each card, not the whole playbook, and put the critical ones at the prompt edges. Roll back through the ledger.
5. **Preference learning.** Store edits to PM proposals (proposed → applied diff) and send-back notes as preference pairs. Extract scoped rules (per repo or task type) with Erev-Roth decay. Add a "What I've learned" panel with evidence and edit/delete controls.
6. **Swap-cost mitigation.** Keep the PM's prompt head static (the board digest at the tail) so Ollama or llama.cpp can reuse the prefix. Answer status questions from the ledger without loading the 27B (a deterministic standup/status responder). Evaluate a small resident triage model only if memory allows.
7. **PM quality metrics.** Track forecast calibration, proposal acceptance rate, first-attempt pass rate of PM-planned cards, and user corrections over time. The PM must never optimise raw throughput (a Goodhart risk).

## 3. Not doing (per the evidence)

- **Local LoRA fine-tuning.** One user's data is too small and forgetting is too risky. Revisit only with thousands of clean trajectories and flat context-based gains.
- **Trusting public leaderboards** for these fine-tunes. Use the ledger.
- **A chatty PM.** It is silent by default during runs, with a budget on unsolicited messages.
