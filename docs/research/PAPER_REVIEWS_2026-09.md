# Paper reviews, September 2026

*Six new papers and one model release, each read and judged against the design by a separate reviewer on 2026-09-22; the recommendations were folded into the design at the time and now live in the specs. Kept close to verbatim.*

## Batch 1: arXiv 2609.02749, 2609.02750, 2609.03430

All three IDs resolved. Here's the review.

---

### Paper 1 — arXiv 2609.02749, "Repo-To-Skill: Distilling GitHub Repositories Into AI4AI Skills" (DisCo / AREX-Skill)

**What it is.** A pipeline (`anchor → scope → ground → construct → verify`) that distils GitHub repos and papers into agent skills in exactly our directory shape: `SKILL.md` as the interface, `references/` as substrate, `scripts/` as executable wrappers. It ships the AREX-Skill Library: 5,000+ skills from 1,000 ML repos, organised into 20 areas and 178 capability families behind a router skill.

**Claimed result and evidence strength.** Weak for us. Everything was measured with GPT-5.5 / GPT-5.6-sol at "xhigh" reasoning, in the Codex harness, at ~$40 of hosted frontier inference per repo distilled. MLE-bench 72.89% vs 31.11% (the headline +134.3% is a relative delta on a low base), PaperBench 39.59 vs 29.45 (20 papers), FrontierCS 77.14 vs 70.63 (188 tasks), PassNet +14.0% (200 samples). Typically 3 runs with standard errors. **No ablations at all** — the paper cannot say whether the gain comes from scoping, grounding, construction, or verification. The domain is ML research engineering (Kaggle-shaped pipelines), not scoped repository edits. The paper itself reports retrieval-precision failures where skills *distracted* the agent from strategies it would have found unaided. Paper licence is **CC BY-NC-SA 4.0** — non-commercial and share-alike, which is a live problem for ingesting the artefact itself.

**Verdict: ADAPT, narrowly** — take the verification stage as an admission rule; reject the library, the taxonomy, and the distiller.

**Integration point.** Self-improvement **Loop 4, skill distillation** (`packages/eval/src/loops.ts:259`, `distillSkill`), plus the skill spec under "### Skills", which already declares `evals/  # verification cards proving skill efficacy`, and `sekhemet doctor`'s Net Gain Measurement. Today `distillSkill` writes a candidate to `.sekhemet/skill-candidates/` from successful trajectories and nothing executes the `evals/` before a human is asked to approve it — the directory is specified but not enforced. The paper's contribution that survives frontier-only evidence is a *policy*, not a model capability: a skill is not admissible until its repo-native checks have been run, and the construction record retains the evidence, the checks performed, and the unresolved gaps. Wire skill-candidate `evals/` through the claim-execution path the research section already owns ("the claim is turned into a script, the package is installed at the stated version in the sandbox with no network, and the script is run... `claim/executed: pass`"). Same sandbox, same evidence-bundle rung, no new machinery.

**What it deletes / simplifies.** Makes `sekhemet doctor`'s expensive per-skill run of the frozen regression suite a second-stage check rather than the only check — the skill's own `evals/` become the cheap pre-filter, which is Loop 8 (SIFT proposal pre-filtering) applied to Loop 4 instead of a separate path. It also removes the current ambiguity about what `evals/` is *for*.

**Risk under our constraints.** Low, if scoped to the admission rule. High if scoped to anything else: distilling at $40/repo of hosted frontier reasoning is a critical-path API dependency and is out; the 5,000-skill library is NC-SA and is out; and the 20-area/178-family taxonomy with a router skill is a **second retrieval subsystem** sitting beside the sqlite-vec + Qwen3-Embedding corpus index, which is an accumulation defect by the user's own standard. The corpus index wins — it already does hybrid BM25 + dense with a reranker, and progressive disclosure is already in the design ("Only the manifest line is in prompt Zone 2 by default. The body loads only when matched to a card class").

**Size.** 1 card, possibly 2.

---

### Paper 2 — arXiv 2609.02750, "Bilevel Coordinated Reflection" (SRMA)

**What it is.** Models orchestrator–worker interaction as a bilevel coordination game, then proves an information-theoretic impossibility: **no gate that observes only the generated transcript can improve uniformly over text-indistinguishable environments, whereas an environment-grounded gate can.** SRMA is the corresponding algorithm — a candidate memory is committed only when a grounded verifier risk *strictly decreases*.

**Claimed result and evidence strength.** The strongest of the three, and it is strong in the right place. The headline 72.2% vs 70.8% is **not** apples-to-apples and the authors say so — 70.8% is a public leaderboard reference, not a controlled run. The controlled comparison is the one that matters: on all 500 SWE-bench instances with a fixed Kimi K2.5 backbone, free-form multi-agent reflection 58.4% → grounded SRMA 72.2%. Table 3 is the real finding: harmful memory proposals accepted at 100% (free-form), 34.5% (self-gated), **6.2% (grounded)**. Toy environments (Resource Contest, Overcooked, 5 seeds) carry the theory; SWE-bench carries the practice. Limitations are stated honestly, including that monotonicity is guaranteed only for verifier risk, not true task utility, under incomplete test suites.

Crucially, **the mechanism is harness logic, not a model capability**. The backbones are large MoEs we cannot run, but SRMA's gain comes from *refusing* bad memory, and a smaller model self-gates worse, not better. This is the rare result that should transfer *better* downward.

**Verdict: ADOPT** — as the formal justification for a position the design already holds, plus one narrow fix where the design currently violates its own position.

**Integration point.** Two places.

First, a citation. "Repair contracts and self-correction policy" states, without support: *"The model does not judge its own output. Correction is driven by external signal"* and *"Self-critique and reflection loops are not used as a quality mechanism; at the model scales this harness runs, they measure worse than simply sampling again and checking externally."* SRMA's impossibility theorem is exactly the citation that paragraph lacks. Likewise the ten-loop **Guardrail 1** ("Every modification must be triggered by an objective, recorded signal... Subjective self-assessment is rejected") is already SRMA-compliant — nothing to change there, and the review should say so rather than invent work.

Second, the fix. The **Deep Research Critique stage** currently contradicts that policy: *"the synthesist re-reads its own report adversarially against the corpus... and revise"*, and *"on contested claims the pass may be run more than once and the results compared, because repetition is free."* That is a text-only self-gate with no stopping rule — precisely the configuration the theorem says cannot uniformly improve, and empirically the 34.5%-harmful-acceptance regime. Make critique an accept/reject over a grounded risk vector we already compute, rather than a free rewrite:

- executable-claim pass rate (already a rung: `claim/executed: pass`),
- `badCitations` from `verifyReferences` (`apps/harness/src/research/apodex_loop.ts:294`) — a pure function, no model,
- coverage / `groundingConfidence` from `sources.ts` — also model-free.

A revision is committed only if no component of that vector worsens. Otherwise the prior draft stands.

**What it deletes / simplifies.** Deletes "the pass may be run more than once and the results compared" as an unspecified hand-wave, and replaces it with a monotone accept rule that has a natural stopping condition: stop when no candidate revision lowers risk. That removes an open question, removes an unbounded loop from an overnight pipeline, and makes the critique stage consistent with the repair-contract policy instead of in tension with it.

**Risk under our constraints.** One real one: the risk vector must be cheap to recompute per candidate revision. Re-executing every claim per critique iteration is not cheap. Mitigation is available and should be written in: recompute the citation and coverage terms every iteration (both are model-free and near-instant), and re-execute claims once at the end or only for claims the revision touched. No extra model, no co-residency, air-gap safe. Code licence CC BY 4.0 — but we are reimplementing an accept rule in TypeScript, not vendoring, so it is a reference-only row.

**Size.** 1 card for the gated critique; design-doc citations are free.

---

### Paper 3 — arXiv 2609.03430, "Random Attention: Rethinking KV Cache Eviction for Efficient Reasoning"

**What it is.** A KV-cache eviction method: protect the entire prefill absolutely (score +∞, never evicted), then assign every remaining cached position an i.i.d. uniform random score and let each KV head keep its top-K independently. No scoring pass at all — the point is that learned importance signals are worth ~nothing once the prompt is safe.

**Claimed result and evidence strength.** Internally credible, externally irrelevant to us. Qwen3-4B/14B/32B and Phi-4-reasoning-14B on MATH500, GPQA-D, LiveCodeBench, AIME, HMMT at ~4× compression. It matched or beat the strongest baseline (TriAttention) in **31 of 60** comparisons — a coin flip, which is the paper's actual claim (signals add nothing), not a win. Throughput 1.6–2.7× full attention, 32–43% over TriAttention — measured on an **H200 at batch 128 with 32k-token generations in vLLM**. Explicitly **not tested on MoE models**, not on models below 4B, not on non-reasoning tasks.

**Verdict: REJECT.** Every condition that produces the gain is absent on our machine, and its one documented failure mode is our exact workload.

**Integration point — as a rejection, recorded.** It would attach to "### Inference settings" (KV cache at 8-bit, flash attention, MTP speculative decoding) and the memory-pressure watchdog. It should not. Three independent reasons:

1. **The throughput result does not exist at batch 1.** KV eviction buys concurrency when KV memory caps the batch. We are single-user at batch 1 with a 16–32k working context — KV is a small slice of 24 GB and the binding constraint is weight bandwidth. The 32–43% edge over TriAttention is the saving of a scoring pass we would never run.
2. **Its failure mode is our workload.** The paper's own needle test — "the rare fact stated once and never restated" — is 84% vs 0% passcode retrieval against R-KV, and they dismiss it as infrequent *in reasoning traces*. In a tool-calling coding loop the once-stated fact is the norm: a file path, a test name, an exact error string. The design already legislates against this class of degradation: *"4-bit KV cache is explicitly prohibited for tool-calling models due to severe needle-in-a-haystack attention degradation."* Same hazard, same verdict.
3. **It is not a card-sized change.** Neither llama.cpp nor MLX implements per-head random eviction; it is a vLLM/HF-Transformers research patch. Adopting it means forking our inference engine, which is far past <200 lines across 1–3 files and contradicts "the engine is an adapter."

**What it nevertheless gives us for free — one benchmark, not an integration.** The paper's *negative* result is real evidence that a learned relevance scorer over a long sequence can fail to beat random selection at equal budget. Context pipeline **stage 3** is exactly such a scorer — SWE-Pruner / SWE-Pruner Pro — and it is already flagged **[BENCH]** with unverified CPU latency, sitting beside the design's own principle that *"No embedding-based compression of code context into vectors; it fails on multi-step coding."* Random Attention supplies the null baseline that [BENCH] is currently missing: before shipping stage 3, measure the learned pruner against **structure-preserving random line dropping at the same token budget**. If the learned pruner does not clear it, delete stage 3 and the SWE-Pruner row from the component register. That is a deletion opportunity, and it is the only thing worth taking from this paper.

**Risk.** None, because nothing is integrated. The benchmark risks only that it proves stage 3 earns its place, which is also a useful answer.

**Size.** 0 cards to adopt (rejected). 1 benchmark card for the SWE-Pruner null baseline, plus a one-line entry in "What is deliberately not done."

---

### Synthesis

**Overlaps and conflicts between the three.**

2609.02749 and 2609.02750 are the same claim at two altitudes, and this is the most useful thing to come out of the batch. SRMA proves that only an environment-grounded gate can improve durable agent memory; Repo-To-Skill's verify stage is one instance of that practice (execute repo-native checks before a skill is admitted). They should be integrated as **one policy, not two features**: *nothing durable is admitted unless a signal measured outside the generated text strictly improves.* That single sentence covers Loop 1 (playbook deltas), Loop 4 (skill distillation), Loop 5 (exemplar store), and the Deep Research critique stage, and it replaces four ad-hoc admission rules with one — three of which already comply, so the work is naming the rule and fixing the one that doesn't. That is the composition: **02750 supplies the rule, 02749 supplies the executable check, and the harness already owns the sandbox that runs it.** Neither paper alone gets you there.

2609.02749 conflicts with two existing mechanisms and loses both times: its taxonomy-plus-router retrieval loses to the sqlite-vec corpus index, and any notion of per-dependency "task-oriented skills" loses to the playbook plus the corpus index, because it would be a fourth durable memory store beside playbook, skills, and exemplars.

2609.03430 does not interact with the other two. It sits at the inference layer and is rejected there.

**Recommend explicitly NOT taking.**

- **Random Attention as an inference change.** Gains are batch-128 datacentre gains; failure mode is our workload; requires forking the engine.
- **The AREX-Skill Library, its 20-area/178-family taxonomy, and its router skill.** Parallel retrieval subsystem; CC BY-NC-SA 4.0 on the artefact; frontier-only evidence; no ablations.
- **Hosted frontier distillation at ~$40/repo.** Violates 100% local inference and air-gapped mode outright.
- **SRMA's bilevel potential-game formalism.** The design already has a supervisor delegating to isolated sub-agents; the game-theoretic apparatus changes no code. Take the theorem, cite it, leave the model. Adding the formalism to the design doc would be accumulation.

**Total recommended work: 3 cards** — gated Deep Research critique (SRMA), eval-gated skill admission (Repo-To-Skill verify stage into Loop 4), SWE-Pruner null-baseline benchmark (Random Attention's negative result). Two of the three tighten or delete existing mechanisms rather than adding one; none adds a new subsystem, a new model, or a new resident process.

## Batch 2: arXiv 2609.08183, 2609.17488, 2608.12564, and Spark-X2.5-4B

### 1. arXiv 2609.08183 — NeoHorse-1

**What it is.** "NeoHorse-1: Towards Recursive Self-Improvement via Agentic Post-Training with Routing Harness" (TokenRhythm, cs.CL, 8 Sep 2026). A harness that routes requests across four capability tiers (C0–C3), records the resulting trajectories, validates and labels them, and feeds them back as post-training data for 4B/9B agentic models initialised from Qwen3.5.

**Claimed result and evidence strength.** Macro-average over 10 benchmarks rises 58.94 → 64.87 at 4B and 65.60 → 69.04 at 9B. Moderate. The one genuinely useful comparison is Table 3: their harness-generated data beats public Toucan data by +6.26 macro under an identical curriculum — that isolates data provenance, which is the paper's actual claim. Against that: four of the ten benchmarks (QwenClawBench, WorkBuddy, PinchBench, VitaBench) are agent benchmarks the reader cannot independently weight; no error bars; no ablation separating the curriculum staging from the on-policy distillation from the data filtering; and the gain shrinks 5.93 → 3.44 as the model grows, the usual signature of post-training buying format compliance rather than capability. The corpus is 10⁵–10⁶ trajectories — a scale a single repository will never reach. Weights are Apache-2.0 with 12 GGUF quants, 262k native context.

**Verdict: ADAPT** — take the *instrumentation*, reject the training; the design already states "Weight updates are not part of the flywheel in v1," and nothing here argues against that.

**Integration point.** Two attachments, both to existing mechanisms:

1. *Competence model* (§Model registry → Competence model). Today every card writes "card class, files touched, difficulty, model, arm, step budget, stop reason, gate failures" — an outcome row only. NeoHorse's contribution is recording the **router's raw prediction, the policy-adjusted decision, and the tier actually served** as three separate fields. That makes loop 2 ("Budgets & routing") able to measure router *calibration* — was the escalation needed? — instead of only aggregate pass rate. Three columns, not a subsystem.
2. *Loops 4 and 5* (Skill distillation, Exemplar store). Both currently select trajectories on outcome alone ("successful recurring multi-step trajectories", "accepted cards"). NeoHorse's cheap pre-filter is structural: event ordering, tool-call closure, readable payloads, classified internally-complete / partially-recoverable / quarantined. A trajectory that produced a green gate by luck and has an unclosed tool call should not become an exemplar. This is deterministic and needs no model.

**What it simplifies or deletes.** Nothing directly, but the structural filter should prevent loop 5's exemplar index from accumulating junk that `sekhemet doctor` later has to prune — it moves a cost from detection to prevention.

**Risk.** Low. The risk is scope creep: the six-dimension semantic labelling (goal attainment, instruction adherence, tool use, evidence consistency, error recovery, termination) is a model-judge, and the design bans model judgement of own output ("The model does not judge its own output"). Take the structural gate; leave the semantic one.

**Size.** 2 cards (router prediction/action/outcome triple; trajectory structural gate before exemplar or skill admission).

---

### 2. arXiv 2609.17488 — LimiX-2

**What it is.** "LimiX-2: A Contextual Mechanism Network Towards General Structured-Data Intelligence" (cs.AI, 15 Sep 2026). A tabular foundation model, 12.5M–406M parameters, doing in-context classification, regression, imputation, and causal-skeleton discovery without parameter updates.

**Claimed result and evidence strength.** TabArena/TALENT/BCCO Elo of 1935/1506/1432, +117.4 Elo over TabFM+ on TabArena with 4× fewer parameters, beating AutoGluon 1.6 and tree ensembles. Plausible and well-measured *for tabular ML*, and entirely outside this harness's problem domain. The causal-skeleton claim is the most interesting and the least validated. The HF paper page returned no usable content; I read the arXiv abstract and HTML. Weight licence is not stated on either page — only the arXiv paper licence — so licence is **unverified**.

**Verdict: REJECT.** It solves a problem we do not have with a model we would have to keep resident.

**Integration point.** The one place it is tempting is the *Competence model*, which is genuinely a tabular prediction problem: predict pass rate from card class, files touched, difficulty, model, arm, step budget. Reject anyway, for four reasons. (a) At 406M it would be a **second resident model** beside Qwen3-Embedding-0.6B, and a parallel prediction subsystem beside the competence model — precisely the accumulation defect. (b) The competence model's value is that the planner's budget is *readable and defensible* from measured pass rates; a neural tabular predictor is neither, and cannot satisfy guardrail 3's atomic rollback in any meaningful way. (c) Its benchmarks are thousands-of-rows general tabular data; we will have hundreds of card rows per repo. (d) Unverified weight licence.

**What it simplifies or deletes.** Nothing. If per-repo routing ever needs more than a mean, a logistic regression over eight columns is ~30 lines of TypeScript with no weights, no residency, and readable coefficients. That is the right tool, and noting it is worth more than the paper.

**Risk.** N/A — rejected.

**Size.** 0 cards.

---

### 3. arXiv 2608.12564 — WMRL (World Model RL)

**What it is.** "Scaling Automatic Research Agents via World Models" (cs.LG, v1 12 Aug 2026, v3 10 Sep 2026). RL post-training where a learned world model predicts what code execution *would* score, replacing sandbox execution in the RL loop, corrected by Online Debiasing (isotonic regression against an anchor group scored both ways) and Inverse-Variance Denoising (variance-weighted fusion of anchor and world-model gradient streams).

**Claimed result and evidence strength.** 3.1–3.4× training-compute reduction (286 vs 883 A100-hours at 4B; 349 vs 1174 at 9B); MLE-Dojo 16.4 vs 15.2 GRPO at 4B, 21.6 vs 18.8 at 9B; DSBench 28.8 vs 25.7. The compute claim is well-supported and is the paper's real result. The quality deltas are small absolute movements on a percentile metric. The headline "4B beats Kimi-48B (8.1) and Nemotron-120B (20.5)" is a trained agent versus untrained open-weight baselines on an agentic benchmark — a scaffold comparison dressed as a capability one, and I would not cite it. The theory is asymptotic convergence, not a bound on anything we care about. World-model weights are not released. **Important naming trap: "research agent" here means AutoML/Kaggle (MLE-Dojo, DSBench), not literature research. This paper does not touch the Deep Research pipeline.**

**Verdict: REJECT as a system, ADAPT one 40-line idea.** We do no RL, have no A100s, and the design excludes weight updates; but the *anchor-and-debias* discipline applies to a surrogate we already run.

**Integration point.** Loop 8, *Proposal pre-filtering*: "Fast rubric & small-slice test score → Filter proposed harness edits before full eval suite." That is already a cheap surrogate standing in for expensive execution, and it is currently uncalibrated — there is no measurement of how often the fast rubric's ranking agrees with the full eval suite. WMRL's Online Debiasing is exactly the fix: keep an **anchor group** of proposals scored by both the fast rubric and the full suite, fit a monotone isotonic map from surrogate score to real score, and apply it before the filter threshold. The anchor rate becomes the tunable knob. This is a query over an existing table plus a monotone fit; it adds no model and no service.

It also supplies evidence for keeping the deferred item honest: "**[DESIGN]** On larger tiers a small local verifier could rank attempts that all pass… only justified if it beats gate-only selection at equal wall-clock." WMRL is direct evidence that a learned scorer substituting for execution drifts without anchoring. Keep that deferred; build the anchor table first, since it is the cheap half and pays for loop 8 today.

**What it simplifies or deletes.** It lets loop 8 be tuned by a measured threshold instead of a guessed one, which is a precondition for ever deleting the full eval run on obviously-bad proposals.

**Risk.** Low, and self-limiting: with a small anchor set the isotonic fit is noisy, so the calibration must be gated on a minimum anchor count (the registry already has this pattern — `MIN_ARM_TRIALS = 5`). Reuse that constant rather than inventing a second one. Inverse-variance denoising is out entirely: it fuses gradient streams, and there are no gradients here.

**Size.** 1 card, optional. Do it only after loop 8 is running and producing anchor pairs on its own.

---

### 4. XHToken/Spark-X2.5-4B

**What it is.** A 4B Apache-2.0 model from the SparkLLM team, trained on ~20T tokens, using a hybrid attention stack of one full-attention layer per three sliding-window layers, natively 1M context, thinking-mode-on by default and disableable. It is explicitly an agentic on-device model — the repo's own framing, "Pushing the Limits of Agentic Capabilities in On-Device Models," is the same argument the design makes for the gatherer role.

**Claimed result and evidence strength.** Mixed provenance, and the card says so: its own results plus asterisked numbers lifted from other vendors' model cards. Self-reported highlights: BFCL-V4 65.1, MCP-Atlas 54.6, τ³-bench 30.4, Workspace Bench 31.2, BrowseComp 40.9, SWE-Bench Pro 44.4, SWE-Bench Verified 41.6.

Two things matter here:

- **Partial third-party corroboration.** NeoHorse-1 (item 1, a different lab) independently ran Spark-X2.5-4B as a baseline and scores it at **macro-average 62.22 vs Qwen3.5-4B's 58.94** — confirming the direction. But the two tables disagree by 2–3 points on shared benchmarks (τ²-bench 77.72 vs 75.1 self-reported; BFCL 63.71 vs 65.1), which sets the honest error bar on anything on that card.
- **Two numbers to distrust.** BrowseComp 40.9 for a 4B is the most suspicious figure on the card: BrowseComp is scaffold-dominated, no scaffold is specified, and no third party reports it. Do not size any decision on it. And SWE-Bench Verified 41.6 sits *below* SWE-Bench Pro 44.4, which is an inversion of the intended difficulty ordering — that is a reason to distrust the code numbers specifically, and an independent reason not to consider this model for the executor role.

**Verdict: ADOPT, as the gatherer, displacing Apodex-1.1-mini.** It is the right shape for the role the design already defines, and it removes the single biggest memory commitment in the research stack.

**Integration point.** §Web research → The hardware envelope → **Gatherer**: "Runs the tool loop. A tool-use fine-tune is worth more here than raw parameter count, because this stage is search, read, extract, repeat." Spark is that argument's literal instance.

What it displaces is concrete and in code, not just in the design. `packages/models/src/llama_server.ts` pins the researcher to Apodex-1.1-mini IQ3_M with the comment:

> `IQ3_M weights are ~16 GB; a 24 GB host keeps 16k so the KV cache and the toolchain still fit. 32 GB and up take the 32k window research needs.`

That one choice consumes the entire 16 GB ceiling, caps research context at 16k on the reference machine, and is the reason the design needs its swap clause. Spark's official GGUF is **Q4_K_M 2.6 GB / Q8_0 4.38 GB**, and the 3:1 sliding-window ratio makes a long window affordable rather than theoretical. At Q8_0 the gatherer fits *beside* the Cyber-Tiel-Coder 35B-A3B worker and the resident 0.6B embedder.

**What it simplifies or deletes.**

- Deletes `createApodexResearcher()` and the `apodexContextTokens()` host-size branch in `llama_server.ts`, and the `apodex` entry in `MANAGED_MODEL_NAMES` — after bake-off, not before.
- Deletes the design's swap clause: "**[DESIGN]** When the executor is not running, the Desk may hold the gatherer instead; the swap is governed by the model-swap policy." A 4.4 GB gatherer can simply stay loaded. One conditional mechanism removed from the design, not added.
- Downgrades — does not delete — "It runs on a second slot of the server the executor is already using: same weights, a different system prompt, no additional memory." That stops being a necessity and becomes the Tier-S fallback. Keep it for small hosts; stop treating it as the only option.
- Lifts the research context ceiling by roughly an order of magnitude, which makes the per-question corpus index's job easier rather than adding to it.

**Risk under our constraints.**

- **Toolchain floor.** `spark2_5` landed in llama.cpp via PR #27868 and needs **b10828 or later**. The air-gap kit pins toolchains, so this is a version bump that must be mirrored, not a free upgrade. MLX (listed as the Apple Silicon inference path) may have no `spark2_5` support at all — verify before committing, since that would make this llama.cpp-only.
- **Hybrid SWA at long context is where new-architecture bugs live.** Do not trust 1M; the registry's existing qualification suite and `throughput` per context bucket are the correct gate, and they already exist.
- **Thinking mode is on by default** and costs decode tokens on every turn of a tool loop. The registry record already has `reasoning.stripTraces` and the roster already sets `disableReasoning`; wire it, do not add a new flag.
- **Tool arm must be measured, not assumed** — the registry's own rule (`toolArm: "A" | "B" | "C"; // measured, not assumed`). The `spark25` parser is vendor-supplied and unverified here.

**Size.** 3 cards: (1) managed profile + `MANAGED_MODEL_NAMES` + roster case, ~60 LOC across 3 files; (2) qualification suite + per-repo bake-off against the incumbent, recording the result in the registry; (3) design edit — gatherer paragraph, removal of the swap clause, one component-register row (`Spark-X2.5-4B | Gatherer, research tool loop | Apache-2.0 | Model`). Apodex is removed in a fourth card only if the bake-off says so.

---

### Synthesis

**Conflicts and overlaps.**

1. **NeoHorse-1-4B and Spark-X2.5-4B compete for the same slot.** Both Apache-2.0, both 4B, both GGUF. On NeoHorse's own independent table, NeoHorse-1-4B scores 64.87 vs Spark's 62.22, winning τ²-bench, PinchBench, WorkBuddy, HumanEval and LiveCodeBench; Spark wins VitaBench (37.00 vs 32.00) and brings 1M context with 3:1 SWA against NeoHorse's 262k. The gatherer role weights tool-loop stamina and long-window reading over code generation, which makes this far closer than the macro-average suggests. **The design already owns the mechanism for settling this and it is not a table: "Models are qualified, not chosen by reputation."** So the correct proposal is *one* bake-off card that registers both candidates and lets the existing qualification suite and per-repo bake-off decide — not two cards arguing from vendor tables. That is the composition worth having: item 1's weights and item 4's weights, one decision procedure that already exists.
2. **NeoHorse's "recursive self-improvement" overlaps §Recursive self-improvement, and the design wins.** The paper's loop is offline retraining at datacentre scale on 10⁵–10⁶ trajectories; the design's ten loops are bounded, atomically rollback-able, weight-free, and run on a laptop. Adopting the paper's framing would mean adding an eleventh loop that cannot satisfy guardrail 3. Take the router instrumentation into loop 2 and the structural filter into loops 4/5, and change nothing else.
3. **WMRL composes with loop 8 and with the deferred small local verifier.** WMRL's anchor group is the precondition for any learned surrogate being trustworthy. The cheap half (anchor pairs + isotonic recalibration) pays off in loop 8 today; the expensive half (the verifier itself) should stay deferred exactly as written.

**Do not take, explicitly.**

- **LimiX-2, entirely.** A second resident model and a parallel predictor beside the competence model, on a domain it was never measured on, with an unverified weight licence. A logistic regression over eight columns is the right answer if routing ever needs one.
- **WMRL as RL.** 286–349 A100-hours, no released world model, and the design excludes weight updates. Only the debiasing discipline transfers.
- **NeoHorse's OPD/curriculum pipeline and its six-dimension semantic labelling.** The first needs a corpus we will never have; the second is a model-judge, which the design bans.
- **Spark-X2.5-4B as executor or synthesist.** The SWE-Bench Verified/Pro inversion argues against executor; 4B argues against synthesis, and the design's "dense mid-size model" call for the synthesist is correct as written.
- **BrowseComp 40.9 as a decision input.** Uncorroborated and scaffold-dominated.

**One honest negative result.** None of the three papers is about web research, deep research, retrieval, citation verification, or crawling. 2608.12564's "research agents" means AutoML despite the title. **The rewritten "Web research and knowledge system" section survives this batch of literature entirely unchanged** — the only item that touches it is the model, and it touches it by removing a constraint (the 16 GB gatherer) rather than by adding a mechanism. Total recommended work: 2 cards (NeoHorse instrumentation) + 3–4 cards (gatherer swap and bake-off) + 1 optional (loop 8 calibration). Net effect on the design is one deleted swap clause, one downgraded fallback, and no new subsystems.
