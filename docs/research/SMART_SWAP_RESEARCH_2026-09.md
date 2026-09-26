# Smart Swap: research and design notes (2026-09)

The evidence behind [DEC-45](../design/DECISIONS.md) and models NEW-models-14. The specs are authoritative; these notes record how the design was reached: the web research digest, the lead's first draft (v1, with its reuse search and the owner's own measurements on this machine), and the reviewed second draft (v2).

## 1. Research digest

# Smart Swap and model choice: research digest (2026-09-26)
Grades: **P** peer-reviewed · **Pre** preprint · **V** vendor docs/code · **B** blog/community · **D** my own derivation, to be measured.
Host (sysctl): **Apple M4 base, 10-core GPU, 120 GB/s, 24 GB, `iogpu.wired_limit_mb`=20480**. The Worker's drive is a WD My Passport on USB at 5 Gb/s (1.8 TiB, product 0x2626), probably a 5400-rpm HDD at about 120 MB/s (not confirmed).
13 GB in about 300 s is about 43 MB/s, below even an HDD's sequential rate, so mmap page faults are probably seek-bound. The internal disk has 61 GiB free.
## 1. What existing systems keep resident
- **Cluster systems** (none portable as-is): AlpaServe (P, OSDI'23) https://arxiv.org/abs/2302.11665 and MuxServe (P, ICML'24) https://arxiv.org/abs/2404.02015 place models by popularity.
- ServerlessLLM (P, OSDI'24) https://arxiv.org/abs/2401.14351 loads 8.2x faster from a load-optimised format with locality-aware placement, and migrates tokens, not KV.
- BlitzScale (P, OSDI'25) https://arxiv.org/abs/2412.17246 and λScale (Pre) https://arxiv.org/abs/2502.09922 execute while loading over RDMA, which does not apply here.
- Also: Llumnix (P, OSDI'24), Aqua (P, ASPLOS'25) https://arxiv.org/abs/2407.21255 and Prism (Pre) https://arxiv.org/abs/2505.04021. Aegaeon (P, SOSP'25) https://dl.acm.org/doi/10.1145/3731569.3764815 switches models per token with 97% less overhead.
- SwapServeLLM (SC'25 workshop) https://github.com/rst0git/SwapServeLLM relies on CUDA checkpointing, which has no Metal equivalent. Shared lesson: switch cost is **weight reloading, not KV movement** (Pre) https://arxiv.org/abs/2605.19593.
- **Ollama** (V) https://docs.ollama.com/faq: `keep_alive` 5 min and 3 models per GPU. It unloads an idle runner and never preempts a busy one. Memory has been measured since 2025-09 (https://ollama.com/blog/new-model-scheduling), though 0.31.2 regressed by +1.2 GiB (#17099).
- **LM Studio** (V) https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict: JIT loading, idle TTL 60 min, and auto-evict of the previous JIT model.
- **llama-swap** (V, **MIT**, Go) https://github.com/mostlygeek/llama-swap: per-model TTL, groups (swap, exclusive, persistent), a preload hook, and a "swap matrix" solver that picks the valid set with the lowest eviction cost.
- **llama.cpp router mode** (V, MIT, 2025-12) https://huggingface.co/blog/ggml-org/model-management-in-llamacpp: a process per model, `--models-max` 4 with **LRU**, and `--sleep-idle-seconds`; it has a TOCTOU race on the limit (#20137).
- **Verdict:** the products all use LRU plus TTL and ignore any known plan. **Keep Sekhemet's scheduler** and borrow llama-swap's eviction cost and the router's process isolation; a proxy in the path would be a second scheduler.
## 2. Scheduling theory, and rules to adopt
- **Hofri & Ross** (P, 1987) https://dl.acm.org/doi/abs/10.1137/0216029: with setup times, **exhaustive service is optimal**. Switch only when your queue is empty **and** the other queue passes a threshold (a double threshold, i.e. hysteresis).
- Binomial-exhaustive is asymptotically optimal for large switchovers (Pre) https://arxiv.org/abs/2005.08840. Reiman & Wein (P, OR 1998) cover heavy traffic. The cμ rule with setups (P) https://pubsonline.informs.org/doi/10.1287/mnsc.42.6.814: a queue with high enough cμ is top priority.
- **Evict by the plan:** Belady's rule (evict the model used furthest ahead) is optimal. KVFlow (P, NeurIPS'25) https://arxiv.org/abs/2507.07400 applies it by steps-to-execution plus prefetch, for up to 2.19x over LRU.
- Continuum (Pre) https://arxiv.org/abs/2511.02230 sets a TTL from reload cost against queueing, for over 8x faster job completion.
- **Rules** (D; tune on replays; S_X is the measured cold or warm load EWMA):
  - **R1:** the resident Worker serves exhaustively; it leaves only on an empty queue, a hold, or R3.
  - **R2:** swap to another heavy role only when its queued work ≥ (S_role+S_W)/f, with f = 0.2. For S_W = 300 s and S_role = 30 s that is about 27 min; reviews pile up while the Worker takes independent cards. A blocked Worker swaps at once.
  - **R3 (aging bound):** c_i·age_i > A_max forces a swap at the next step boundary. A_max: Reviewer 45 min, Planner 30 min, a person waiting on Seshat 2 min (a small co-resident model answers first).
  - **R4:** minimum residency = the model's own S_load (rent-or-buy, 2-competitive), unless the plan puts its next use beyond the horizon.
  - **R5:** preempt only at a step boundary, and only when the human waiting cost > S_in+S_W.
  - **R6:** eviction score = plan next-use distance × S_load / size (GreedyDual); LRU when there is no plan.
## 3. Making swaps cheaper, ranked by expected gain here
1. **Worker GGUF to the internal SSD:** 5 min becomes seconds to tens of seconds (D). On a slow disk mmap thrashes; `--no-mmap` cut one load from >144 s to about 20 s (B) https://github.com/ggml-org/llama.cpp/discussions/18758. If it stays on USB, test a sequential read (`--load-mode none`, or `cat` into the page cache).
2. **Warm page cache:** Metal uses mmapped pages without a copy, so a warm reload is nearly free, about 10x on macOS (B) https://justine.lol/mmap/. Log cold and warm separately.
3. **Fewer swaps** (R1, R2) beat faster swaps.
4. **KV slot save/restore** (`--slot-save-path`, `/slots/{id}?action=save|restore`, V) for Seshat and Reviewer across swaps; slot files belong to one model.
   - 5K tokens: restore 1.4 s against 9.9 s prefill, 219 MB at 4K tokens (B) https://ai-muninn.com/en/blog/kv-cache-disk-restore-7x.
   - About 4.4 GB at 100K (B) https://github.com/ggml-org/llama.cpp/discussions/20572.
5. **Overlap each load** with gates, tests, the repo map and context assembly.
6. **Prefetch the next file** from the plan, only when free memory ≥ file + margin.
7. **Avoid** `--mlock` (crashes on Mac, uncatchable wired overflow; #18152, #8424), `dio` (warm reloads 10x slower), and `--cache-reuse` on hybrid models.
## 4. Leftover memory and fitting
- The Worker is hybrid Gated-DeltaNet (10 of 40 layers attention), so its KV is small: 5.1 GB at 262K f16 (B).
- A 1–4B co-resident (router, embedder or Seshat front) needs 13+~2.5+KV+~1 ≈ 18 GB of the 20 GB wired limit (D). That is tight: only when ≥60% free and swap < 4 GB (DEC-42).
- MTP drafts were a net loss on Metal in one report (B, single, weak) https://github.com/ggml-org/llama.cpp/issues/23752.
- `--fit` is **on by default** with a 1024 MiB margin and silently shrinks ctx (V) https://github.com/ggml-org/llama.cpp/blob/master/tools/fit-params/README.md.
- Budget = weights + KV(ctx) + compute buffer + `--cache-ram` + 1 GiB. Verify after load against the wired and compressed memory observed.
## 5. Estimating speed before running (area a)
- **Decode** ≈ η·bandwidth / bytes per token. For MoE, count active experts at their quant plus non-expert weights (llmfit's two tiers). llama.cpp reaches 65–80% of roofline (B); llmfit uses η = 0.55 (V).
- **This M4:** 7B Q4_0 (3.56 GB) runs tg 24.1 against a ceiling of 33.7, so **η ≈ 0.72** (V table https://github.com/ggml-org/llama.cpp/discussions/4167, D). Worker: 1.3–1.8 GB per token gives **~40–60 t/s** (D); check against the calibration record.
- **Prefill** ≈ η_c·FLOPS / (2·active params). pp512 of 221 t/s on 7B means about 3.1 TFLOP/s effective (D); MoE falls below. Show a ±30% range until benchmarked.
- Bandwidths (V): M1 68, M2/M3 100, M4 120, M3 Pro 150, M4 Pro 273, M4 Max 546 GB/s.
## 6. Estimators, the picker, the benchmark and combinations (areas b–e)
- **Reuse (all MIT):**
  - `@huggingface/gguf` (approved): range-reads metadata and tensor shapes.
  - gguf-parser-go https://github.com/gpustack/gguf-parser-go: RAM/VRAM by offload, ctx and flash attention, plus max TPS via `--device-metric`; a Go CLI, so a subprocess or a port.
  - llmfit https://github.com/AlexsJones/llmfit (Rust, 37k★): fit, speed, quality and ctx scores with visible inputs; the formula reference.
  - `llama-fit-params` as a second opinion.
- **Picker UX today:** LM Studio has green/yellow/red "Full GPU Offload Possible / Partial / Likely too large" (V/B). Jan shows "Fits / May be slow / Won't fit" with no download (V) https://www.jan.ai/docs/desktop/manage-models. GPT4All shows RAM needed. **None shows drive load time or swap cost — that is our gap.**
- **Our picker:** per model, a fit badge, decode and prefill range, cold and warm load, a slow-drive flag under 500 MB/s, and "copy to internal disk"; per combination, swaps per card and minutes per card.
- **Benchmark:**
  - Speed: `llama-bench -p 512 -n 128 -d <role depth, e.g. 8192,32768> -r 5 -o json` after one warm-up. Accept at stddev ≤ 3%; re-run after a rest if the thermal canary is more than 3% slow (Pre) https://arxiv.org/html/2605.00519v2.
  - Load: time to `/health`, cold and warm, 3 runs each.
  - Quality: a small frozen set per role, at temperature 0 or k ≥ 3.
  - Combine **lexicographically**: the quality floor first, then minimum time per card. Never a weighted sum.
- **Combination cost** (D): card time = Σ_roles(prompt/pp + output/tg) + E[swaps per card]·S, where E[swaps per card] = resident-set transitions per batch cycle ÷ cards per batch.
  - Roles sharing one GGUF (differing only in prompt or per-request `lora`, V) switch for free.
  - The Reviewer (another family) costs a swap unless it co-resides.
## Pitfalls
- **Memory accounting:**
  - A ctx shrunk by `--fit` could be refused as a profile mismatch (MD-M4-1); pin ctx and record the fitted arguments.
  - `--cache-ram` defaults to 8192 MiB of host memory; count or cap it.
  - Ollama's idle `keep_alive` and the owner's Hermes on 8080 hold memory we cannot see.
  - The page cache looks free; measure wired plus compressed memory.
- **Hybrid and SWA models** silently re-process the whole prompt (visible only at `-lv 4`). Tune `--ctx-checkpoints` and `--checkpoint-min-step` (B) https://particula.tech/blog/prompt-reprocessing-swa-hybrid-models-kv-cache.
- **The external drive:** the USB HDD spins down and can disconnect. Every load time is one sample until there is an EWMA of at least 3.
- **Weak evidence, not used:** 2026 blogs on "lazy tensors" and M4 Max MoE t/s.

## 2. First draft (v1)

# Smart Swap — design (lead, 2026-09-26)

Owner's request: switching between roles on one memory-bound Mac so that the whole team (Worker, Planner/Seshat, Reviewer, Researcher, small helpers) gets the most work done. It adapts to measured load times, uses free memory smartly, and helps people pick models and combinations with a professional model page. Research: `smart_swap_research.md` (grades P, Pre, V, B, D; thresholds marked D are ours and are tuned on replays).

## 0. Facts of this machine (measured 2026-09-26)

- Apple M4, 10-core GPU, 120 GB/s, 24 GB; `iogpu.wired_limit_mb` = 20480.
- Worker 13 GB; Planner/Seshat 12.1 GB (shared weights); Reviewer 11.3 GB; Researcher ~16 GB.
- The Worker loads from a USB spinning disk at about 43 MB/s (about 300 s). The internal disk has 61 GiB free.
- One large model at a time (co-residence needs 32 GB usable, rule 22).

## 1. The record (building now: B4.0a part 3, NEW-models-N a/b/e)

- **Every swap on the ledger.** `model/unloaded` and `model/loaded` carry: model, role, volume (internal or external) and its measured read rate, bytes, cold or warm, and the unload, load, health and first-token ms.
- **Prediction.**
  - Per (model, volume, cold/warm): a rolling median and p90.
  - Before any history exists: size ÷ the measured volume read rate, with ±50% shown.
- **The slow-load flag.**
  - It fires when a load takes more than p90 × 1.5, or a first cold load takes over 120 s.
  - It records `model/slow_load` with its cause (external volume; memory pressure; swap in use; the disk spun down) and a fix, surfaced as a notice.

## 2. The cost model (new)

- **L(m):** the predicted load time of model m, warm or cold by its page-cache state.
- **U(m):** the unload time.
- **K(s):** the time to restore a saved KV slot, against R(s), the time to recompute its prompt.
- **Work per role, W(r):** Σ of queued requests' predicted service time. Each request's estimate is its tokens ÷ the measured speed; before a benchmark exists, the roofline estimate: decode ≈ 0.72 × 120 GB/s ÷ active bytes per token, prefill measured by llama-bench.
- **Swap overhead ratio θ:** swap time ÷ total time, over a window. Target θ ≤ 0.2 (D; tuned).

## 3. The policy (new; the scheduler decides at each step boundary, never mid-step)

- **S1. Exhaustive service with a threshold** (Hofri & Ross; polling systems with switchover times):
  - The resident model keeps serving while its queue has work.
  - Another heavy role is loaded only when one of these holds:
    - (a) the resident queue is empty;
    - (b) that role's W ≥ (L_in + L_back) ÷ θ;
    - (c) its aging cap is reached (S2).
- **S2. Latency classes and aging caps** (D; configurable; tuned):
  - interactive (a person waiting on Seshat): 2 min;
  - Planner 30 min; Reviewer 45 min; Researcher 60 min; Worker (background) none.
  - When the swap itself would break the interactive cap, a co-resident quick model answers at once (labelled as a quick answer, S7), and the full answer is queued with its predicted time.
- **S3. Minimum residency** (rent-or-buy): a loaded model stays at least L(m) unless memory pressure (the watchdog) forces it out.
- **S4. Batching from the plan:** the scheduler reads the board and plan to know upcoming role needs. It collects each role's work (reviews at card end, re-plans, research questions) and serves it in one visit, and it never loads a model for one request when the plan shows more coming within its residency.
- **S5. Eviction by next use:** when several models are resident (large hosts, or small models here), evict the one whose next use in the plan is farthest away, weighted by L(m) ÷ size (Belady; KVFlow). Least-recently-used is only the fallback when there is no plan.
- **S6. Overlap:** while a model loads, the harness runs the CPU-side work of queued cards: tests, gates, context assembly, repo map, language servers. A load never idles the machine.
- **S7. Use of free memory (space-aware):**
  - Headroom = usable − (resident weights + KV at their contexts + engine buffers + the prompt cache budget + margin). Usable is measured as wired + compressed plus other processes (the owner's servers, Ollama's `keep_alive`), never the page cache.
  - Headroom may hold small models (a quick answerer for Seshat, a draft model, an embedder) when each fits with the watchdog's `elevated` level untouched.
  - A small model is evicted first under pressure. An unknown footprint is refused (MD-N9-3).
- **S8. Pre-warm:**
  - When idle, and when free memory (not the page cache) allows, the next model the plan needs is warmed by reading its file into the page cache, making its load warm.
  - Overnight, the next card's model is kept (MD-N3-3).
  - It never pre-warms under pressure.
- **S9. KV slots:** when a role with an active session (Seshat's thread, a card mid-attempt) is swapped out, its slot is saved to disk if K(s) < R(s), and restored on return (llama.cpp slot save/restore). The prompt cache budget (`--cache-ram`) is set from the headroom, never the 8 GiB default.
- **S10. Fairness across people:** RUN-34's fair share and aging still hold. S1–S4 choose when to swap, and RUN-34 chooses whose work runs inside a visit.

## 4. Swap-cost reducers the harness recommends (and measures)

1. **Placement:** a model on an external or slow volume gets "copy to internal storage", with the predicted and then measured gain. The copy is one action on the model page, hash-verified; the registry points to the new path; the original stays.
2. **mmap on** (default); `--mlock` off (it crashes on Mac); no direct I/O.
3. **`--fit` guard:** llama.cpp's automatic context shrinking is detected and refused or recorded (MD-M4-1), never silent.
4. **Drive health:** a spun-down or disconnected external disk is detected (read-rate probe, file present) and flagged before a load is attempted.

## 5. The predicted wait

Every queued request carries a predicted start: the resident model's remaining work, plus the swap cost, plus the requests ahead of it. Seshat says it in words ("I'll answer in about 4 minutes: the Worker is finishing a step, and switching takes about 3"). The dashboard shows it on the card and in the queue standing.

## 6. Tuning without guessing: the replay simulator

- A deterministic simulator replays recorded request and swap histories from the ledger (`model/*`, requests, card steps) under a parameter set (θ, caps, minimum residency, S5 weights). It reports swap overhead, waits per latency class, and cards per hour.
- Threshold changes are adopted like any change (DEC-28): paired replays first, then a confirmation on real runs.
- Until real loads are recorded, the simulator runs on fixture histories with the measured load times of this machine.

## 7. Choosing models and combinations: the model page (dashboard, B4.1)

- **Per model, before use:**
  - identity: family, total and active parameters, quantisation, size, maximum context, licence, source and hash;
  - fit per role: weights + KV at the role's context + buffers against usable memory, the headroom, and co-residence;
  - estimated decode and prefill speed (roofline, ±30% until benchmarked, then measured with its spread);
  - load time by volume, cold and warm, with the placement advice;
  - per role: qualification status, quick-benchmark scores, tool-call validity, the record on the person's own projects (from the ledger), and family rules (the Reviewer differs from the Worker);
  - warnings: won't fit, slow drive, unqualified, licence.
- **Per combination (an assignment of models to roles):**
  - expected swaps per card, from the replay of the person's recent work or a typical card mix;
  - time per card = compute + swaps × L; shared weights cost 0; co-resident smalls cost 0;
  - a combined quality score;
  - a speed–quality chart marking the combinations no other beats on both;
  - the recommended combination with its reason: quality floor first, then the least time per card;
  - side-by-side comparison.
- **Benchmark from the page:**
  - quick: one warm-up and five runs at the role's typical depth, accepted at a spread of 3% or less, plus cold and warm load times;
  - full: finalists on the role's qualification cases.
  - Results are stored and the page improves with use.
- **Estimators:**
  - our own, from GGUF metadata via `@huggingface/gguf` (approved) with llmfit's and gguf-parser's formulas as the reference (both MIT; neither added);
  - llama.cpp's `llama-fit-params` as a check when present.

## 8. Reuse decisions

- llama-swap and llama.cpp's router mode are not adopted: they use least-recently-used with a TTL and ignore the plan. We borrow a per-model eviction cost and one process per model.
- llama-bench is used for the benchmark (MIT, ships with llama.cpp).

## 9. Placement

- **B4.0a part 3:** §1, §2, §3 S1–S10 and §5 (the engine) and §6 (the simulator).
- **B4.1:** §4's actions on the model page, and §7.
- **Calibration** of every D threshold needs model loads, the first night they are allowed; the baseline runs feed it.

## 10. Reuse and integration (lead's own search, 2026-09-26)

- **Adopt:**
  - **llama.cpp slot save/restore** (MIT, in llama-server): `--slot-save-path` enables `POST /slots/<id>?action=save|restore`; restore takes about 26 ms against a full re-prefill ([discussion 20572](https://github.com/ggml-org/llama.cpp/discussions/20572); [7x restore](https://ai-muninn.com/en/blog/kv-cache-disk-restore-7x)). It implements S9 and S11.5. llama-swap has no such feature ([issue 1064](https://github.com/mostlygeek/llama-swap/issues/1064)), and this is our edge.
  - **llama-bench** (MIT, ships with llama.cpp): `-p`, `-n` and `-d` (depth), `-r` repetitions, JSON output; the model page's benchmark ([README](https://github.com/ggml-org/llama.cpp/blob/master/tools/llama-bench/README.md)).
  - **gguf-parser-go** (MIT), optional separate program: memory and maximum tokens/s from GGUF metadata, UMA-aware, including a remote Hugging Face or URL file read by chunks without downloading, within about 100 MiB of actual ([repo](https://github.com/gpustack/gguf-parser-go)). The model page uses it for "fits and speed before download". Our own estimator (via `@huggingface/gguf`) is the fallback.
  - **highs** (npm, MIT; HiGHS MIP in WebAssembly): the horizon optimiser of S11.1 when enumeration grows ([highs-js](https://github.com/lovasoa/highs-js)).
  - **Optuna** (MIT, Python, optional, tuning only): multi-objective search over Smart Swap's parameters against the simulator (swap overhead against interactive wait), with a TS random or grid fallback.
- **Not adopted:**
  - SimPy: the simulator runs the real scheduler under a virtual clock instead (the digital twin, §6).
  - llama-swap (MIT): least-recently-used with a TTL; we borrow groups, hooks and per-model eviction cost.
  - OR-Tools/PyJobShop: a Python sidecar is more than the problem needs.
- **Proposal, not adopted:** MLX as a second engine per model. Reports put Ollama's switch at 58 → 112 tokens/s on one Mac ([yage.ai](https://yage.ai/share/mlx-apple-silicon-en-20260331.html); weak evidence) and loads at about 1.7 s. It cannot read IQ3_XXS GGUF. The model page may benchmark an MLX build of a model against the GGUF build, and a bake-off decides (models rule 23).

## 11. More smart features (from 2025–26 multi-agent serving research)

1. **A horizon optimiser.** At each decision point, the next H visits (default 4) are chosen by minimising predicted total time subject to the aging caps: enumerate orders of the roles with work (at most 4! = 24 sequences), with highs when the space grows. S1's threshold is the one-step special case. [Latency-Aware Orchestration, arXiv 2609.03335](https://arxiv.org/html/2609.03335): −36.8% makespan, −25.9% p95.
2. **Near-ready prefetch:** start warming the successor's weights (page cache) while its predecessor still runs, if free memory allows (same paper).
3. **Same-weights fusion:** consecutive requests for the same weights (Planner and Seshat) are one scheduling unit, with no boundary between them (same paper; MD-N9-1).
4. **Cumulative feasibility:** every transition in a plan is checked against weights + active KV + engine state + the prompt cache, not only the end state (same paper).
5. **Prefix-state reuse:** the shared prefixes each role reuses (the system prompt, the repo map, a card's dossier) are saved per model and restored after a swap, so no role re-prefills its stable prefix. [TOPAS, arXiv 2608.25523](https://arxiv.org/html/2608.25523): −39.8% mean JCT.
6. **Workflow prediction:** the next role is predicted from the card's state machine (verify → Reviewer; blocked → Seshat or Planner; a research card → Researcher) and the plan, feeding S4, S5 and 11.2. [Pythia, arXiv 2604.25899](https://arxiv.org/pdf/2604.25899).

## 12. Measured on this machine (the owner's own tests, `~/Desktop/Projects/Qwen 3.8 27B testing`, 2026-09-13)

These override the web research's estimates where they differ.

- **Decode ceiling:** predicted tok/s = efficiency × 120 ÷ weights GB. MLX 3-bit dense 27B (10.96 GB) measured 8.65 tok/s against 8.7 predicted (efficiency 0.85). llama.cpp dense 27B GGUFs of 11.1–14.6 GB measured 5.7–6.6 tok/s tg128 (efficiency about 0.6); pp512 60–63 tok/s. So:
  - the speed estimator carries an efficiency per engine, calibrated per engine on the host;
  - MLX is about 30% faster than llama.cpp at the same size here.
- **MoE against dense:** Nail-35B-A3B (MoE, about 3B active) decodes at 29–30 tok/s against 6–8 for dense 27B. The model page shows this trade plainly; interactive roles favour MoE.
- **Prefill dominates:** about 80% of a 47 s turn was prefill (about 2,450 tokens at about 65 tok/s). Caching the static prefix cut time to first token from 27.66 s to 0.88 s (31.6×). **S9 and §11.5 (saved slots and prefix state) are the first latency lever, ahead of decode speed.**
- **The GPU ceiling is the binding limit:** `iogpu.wired_limit_mb` = 20480. The Metal GPU timed out while macOS showed 88% free. S7's headroom is computed against the GPU wired limit and the OS measure together, the lower of the two. The practical weights line for a dense 27B at working context is stable at 11.9 GB and swap-exhausted at 13.7 GB, and it sets S7's margins until measured per model.
- **A drafter beside a big model fails here:** an 11.8 GB target plus a 3.85 GB drafter gave a Metal command-buffer GPU timeout on the base M4. S7 refuses a co-residence whose combined GPU footprint crosses the calibrated ceiling, and the model page says why.
- **Ollama silently requantises** an IQ3_XXS file (`--allow-requantize`). A model served through Ollama is flagged when its served weights' hash or quantisation differs from the file, and llama-server is preferred for exact weights.
- **Qwen thinking mode:** content lands in `reasoning` with Ollama unless reasoning is off. That is an adapter concern already in models rule 7; noted for the model page's test prompts.
- **MLX is a real candidate engine, not only a proposal:** MLX builds of Qwen 3.8 27B are already on the drive (2-bit, 3-bit, 4-bit, MTP-8bit, DFlash2, Dirk oQ4e). The model page benchmarks engine against engine per model, and a role may use an MLX build after a bake-off (models rule 23). The Worker (Cyber-Tiel, GGUF IQ3_XXS) has no MLX build.
- **Placement:** the Planner and Seshat's GSQ-RCO GGUF already has a copy on the internal disk (`~/AI-Models/llm/Qwen3.8-27B-GSQ-RCO-GGUF`), so the registry should prefer it. The Worker's is external only.

## 3. Second draft (v2, after the expert review)

# Smart Swap — design v2 (lead, 2026-09-26)

v2 merges v1 (`smart_swap_design.md`, whose §10–12 still hold for reuse, the smart features and the owner's measurements) with the independent expert review. Where they differ, **v2 wins**.

- **Goal:** the whole team of roles gets the most accepted work per hour on one memory-bound Mac.
- **How:**
  - swap only when it pays, measured in round-trip cost;
  - keep people answered;
  - use memory to the safe limit;
  - help people choose models, engines, placement and combinations from measured facts.

## A. Placement first (the largest single gain)

- **The problem:** every role's weights sit on the USB disk (`SEKHEMET_MODELS_DIR`): Worker 13 GB, Planner/Seshat 12.1, Reviewer 11.3, Researcher 16. At about 43 MB/s a round trip costs about 10 minutes.
- **Copy to internal, chosen as a knapsack.**
  - A copy's value is swaps per day × (L_ext − L_int) ÷ GB.
  - At least 20 GB of internal free space is kept for swap files and worktrees.
  - On this host, the Worker and the Planner/Seshat weights go first (25 GB). The GSQ-RCO copy already exists internally (`~/AI-Models/llm`), and the registry prefers it.
- **Only a person's click copies.** The copy is hash-verified, the registry points to it, and the original stays.
- **Every threshold below derives from measured cost,** so a move to the SSD re-tunes the policy automatically.

## B. The cost model

- **C_pair(r):** the round trip that serving role r costs the resident role, in both directions. It is the sum of:
  - U_out + L_in, the unload and load;
  - the first-token time above steady state;
  - Σ over live sessions of min(K, R): restoring a saved slot or re-prefilling it;
  - the idle slot-seconds, × N parallel slots (RUN-35).
- **Load time L:** per (model, volume, engine, load mode, cold/warm), from the ledger (`model/loaded`, MD-N14).
  - **Decisions use p90** (fewer swaps); **predicted waits use the median**.
  - A baseline is re-taken after 3 consecutive loads above p90 (the drive changed).
  - With no history: a 256 MB sequential read probe of the volume, plus USB spin-up, gives the estimate, shown as ±50%.
- **Cold or warm is measured, never assumed.**
  - `mincore` over the file before loading (a small trusted helper), or the effective read rate classifies the load after the fact.
  - Page-cache capacity is physical − wired − anonymous memory, so after any large swap on 24 GB the other model is essentially never warm.
- **Work W(r):** Σ of queued requests' predicted service time, which is prefill (the owner's measurements: prefill dominates) plus decode, at each engine's measured speed.
  - The estimate before a benchmark is efficiency × 120 GB/s ÷ bytes read per token (active bytes for MoE). Efficiency is per engine, calibrated on the host: MLX about 0.85 and llama.cpp about 0.6 measured here.
  - Escalated retries count in W(planner), because they run on the Planner's weights.
- **θ, the swap-overhead ratio:** swap time ÷ wall time over a rolling hour, monitored with θ_max = 0.2 (D, tuned).

## C. The policy: one pure function

`decide(snapshot, now) → action` is called at every step boundary. It is shared by the live scheduler and the simulator. The snapshot holds the resident set, queues, holds, costs, memory, presence and the plan. `residency.ts`'s real-time pump and static order rank are refactored behind it.

**Precedence:** watchdog critical > watchdog elevated > holds > Smart Swap. Nothing ever preempts mid-step.

1. **Exhaustive service with a threshold.** The resident model serves while its queue has work. Another role is loaded only when one of these holds:
   - (a) the resident queue is empty;
   - (b) W(r) ≥ C_pair(r) ÷ θ;
   - (c) an aging cap is reached (rule 4).
   Hysteresis: (b) must still hold at the next step boundary.
2. **Tours.** When the Worker must yield, one absence serves every queue past 50% of its cap: shared weights first (Seshat, Planner and escalations), then the Reviewer, then the Researcher. The horizon optimiser (v1 §11.1) orders the tour. Ordering is by next use in the plan (Belady), with least-recently-used only as the fallback.
3. **Rent-or-buy done right.** A visiting model's idle hold and minimum dwell both equal C_pair: the round trip the next request would cost. The watchdog overrides both.
4. **One aging mechanism** (it unifies RUN-34's `max_wait_s` and the caps). Each request class has a cap:
   - interactive 2 min (D);
   - Planner 30, Reviewer 45, Researcher 60 min (D);
   - Worker steps: `max_wait_s`.
   - **Feasibility:** a cap below C_pair cannot be met. It is flagged on the model page, and the person sees the predicted wait instead.
   - **θ above θ_max:** the non-interactive caps stretch (never the interactive one), and the placement notice is raised.
5. **The Worker's guarantee:** while its queue is non-empty, the Worker gets at least (1 − θ_max) of each hour. A chatty conversation cannot starve it.
6. **Presence-aware reviews.**
   - While a person is present (reserved hours or an active dashboard), reviews of finished cards block acceptance and rank first. The human is the rate limiter.
   - Overnight, reviews batch into one tour that ends before the reserved hours start.
7. **Swap-storm cap:** at most θ_max × 3600 ÷ C_pair swaps an hour, which matters on a fast SSD.
8. **Parallel slots (RUN-35):** the Worker's holding cost × N. A swap waits at a drain barrier: no new step is admitted, and every slot reaches its boundary. S-slot saves cover all N slots.
9. **Overlap:** while a model loads, CPU-side work runs for queued cards (tests, gates, context assembly, the repo map, language servers).
10. **Prefetch** (v1 §11.2): warm the successor only from free memory minus a margin, and never under pressure. Pre-warmed cache never counts in the watchdog's used ratio.

## D. Seshat while the Worker runs

In this order:

- **(a) Deterministic answers from the ledger and board, with no model:** status, where the cards stop, what waits on the person, and predicted waits.
- **(b) A quick model, only when measured headroom (§E) allows.** Its answer is labelled a quick answer, is informational only, and **may never create or change cards, plans, proposals or decisions**, because it is not qualified (rule 27a).
- **(c) The full answer,** queued under the interactive cap with its predicted wait stated in words and a hold for the thread. The thread's KV slot is saved on swap-out and restored on return.

## E. Memory: space-aware co-residence

- **Headroom** = the minimum of two measures, both taken at each admission:
  - **GPU:** `iogpu.wired_limit` − Metal in-use system memory (ioreg AGXAccelerator PerformanceStatistics, which counts every process, the owner's included) − 1 GiB − the peak compute buffer;
  - **System:** total − (wired + anonymous + compressor-occupied) − about 3 GB for macOS − the peak of the harness, language servers and tests.
- **Our servers:** measured by their `phys_footprint` (their mmapped weights can hide as file-backed).
- **Admission:** a load is admitted only if the projected used memory stays at or below 0.80 (5 points under `elevated`) and swap does not grow.
- **The owner's own processes** (Hermes on 8080, Ollama) are read by pid and never unloaded. A refusal names them ("Hermes on 8080 holds 9 GB"). For Ollama's `keep_alive`, the scheduler waits for the expiry shown by `ollama ps` rather than refusing.
- **Replacing rule 22:** "roles never co-reside below 32 GB" becomes **"no two large models"**, decided by footprint. `CO_RESIDENT_MIN_BYTES` is derived, not fixed.
- **Measured failure here:** a model beside another whose combined GPU footprint crosses the calibrated ceiling is refused. A drafter plus an 11.8 GB target gave a Metal timeout on this base M4.

## F. Load mechanics, chosen by measurement

- **Load mode per volume:** mmap, `--no-mmap`, or a sequential pre-read then mmap, chosen by an A/B recorded on the ledger. On USB, mmap page faults read below the drive's sequential rate.
- `--mlock` is off (it crashes on Mac); no direct I/O.
- `--fit`'s silent context shrink is detected and refused (MD-M4-1).
- The prompt cache (`--cache-ram`) comes from the headroom, never the 8 GiB default.
- A drive that has spun down or disconnected is detected before a load.
- Ollama requantisation is flagged (the served quantisation or hash differs from the file); llama-server is preferred for exact weights.

## G. KV slots and prefix state: the first latency lever

- **The evidence:** the owner measured time to first token fall from 27.66 s to 0.88 s by caching a static prefix.
- **What is saved:** live sessions (Seshat's thread, a card mid-attempt; all N slots) and each role's stable prefix (system prompt, repo map, dossier), saved per model through llama-server's slot save/restore. On return they are restored when K < R.
- **Caches, never evidence:**
  - files are keyed by (weights hash, engine build, context, KV type, template);
  - they are never read for decisions;
  - a slot file whose prompt text a `ledger/erased` event covers is deleted (the spine: erasure).

## H. The closed-loop replay simulator

- **What it runs:** the real `decide()` under a virtual clock, with fake adapters whose load and first-token delays are sampled with a seed from the recorded distributions, and a fake memory probe.
- **Closed loop:**
  - a card's completion generates its review demand;
  - escalations follow failures as recorded;
  - Seshat arrivals replay as think-times after the previous answer, not as wall-clock stamps;
  - reserved hours and presence replay from the ledger.
- **Metrics:** θ; wait p50, p90 and max per class; accepted cards per hour; maximum age; swaps per hour.
- **Adoption:** a parameter or policy change is adopted by a paired replay across k ≥ 5 distinct recorded days with a pre-registered metric, plus proof that the cards' outputs are unchanged. This is a new DEC-28 admission row for scheduling parameters.
- **Until real loads exist:** fixture histories with this host's measured load times.

## I. Amendments to existing rules

- **RUN-34 and runtime item 4:** "interactive PM replies ahead of Worker steps" holds within a resident visit. Across a swap, the aging caps and tours decide.
- **Models rule 20a:** its fixed plan order is replaced by `decide()`. **Rule 20b:** benchmark blocks bypass C1–C10.
- **Evidence:** every evidence bundle and `RunProfile` records the swap-policy version and parameters.
- **Watchdog:** precedence is stated in §C. Elevated and critical keep-alive override dwell and prefetch.
- **DEC-42's "unload after each run":** it remains for measurement runs. Calibration nights, when the owner permits loads, run the policy as designed, and the protocol is declared in measurement.md.

## J. The model section of Configuration (dashboard §2.16; built in B4.1)

A section of Configuration, not a new view. **Every number carries a grade: measured, estimated, or D.**

- **Per model:**
  - identity: family, total and active parameters, quantisation, engine (GGUF on llama.cpp; MLX), size, maximum context, licence, source and hash;
  - a memory breakdown (weights, KV at the role's context and KV type, compute buffer, prompt cache) against live headroom, with what-ifs for context size and KV type;
  - estimated decode and prefill speed per engine (the efficiency formula, then llama-bench measured: one warm-up, five runs at the role's depth, accepted at a spread of 3% or less), time to first token with and without the prefix cache, and cold and warm load time per volume, with the placement advice;
  - per role: qualification status (the full tuple: engine build, template, MTP), quick-benchmark scores, tool-call validity, and the record on the person's projects;
  - warnings (won't fit; slow drive; unqualified; licence; Ollama requantisation);
  - pre-download estimates: gguf-parser-go reads a remote GGUF's metadata, with our own estimator via `@huggingface/gguf` as the fallback.
- **Per combination** (an assignment of models to roles):
  - hard filters: the family rule (Reviewer ≠ Worker family) and fit;
  - peak memory and co-residence;
  - C_pair per role pair;
  - predicted wait p50 and p90 per class, Seshat's included;
  - time per card = E[attempts] × compute + E[swaps] × C_pair, where E[swaps] comes from a closed-loop replay of the person's last N cards' demand under this combination (median and p90 with N, "estimate" while N < 20; a weaker Worker means more retries, reviews and swaps);
  - accepted cards per night.
  - **Choice:** per-role quality floors, then the least time per card including swaps, then the smaller footprint. There is **no weighted combined score** (rule 4c amended).
- **Whole page:**
  - a placement what-if (copy X to internal: swaps saved, time saved per day);
  - a 24-hour residency timeline with the realised θ;
  - an engine comparison per model (llama.cpp against MLX builds; MLX builds of Qwen 3.8 27B are already on the drive);
  - benchmark runs, quick and full (finalists on the role's qualification cases), stored so the page improves with use.

## K. Placement in the plan

- **B4.0a part 3 (now):** B (costs), C (`decide()` and C1–C10), D (a and c; b wired to headroom), E (the headroom measure and admission), F (load-mode A/B mechanics, detection and guards), G (slots and prefix), H (the simulator) and I (the amendments). The record, prediction and slow-load flag are already built (MD-N14-1..6).
- **B4.1:** A's actions and J (the page), with the benchmark.
- **Calibration** of every D value and load mode needs model loads; the first night the owner allows them, the baseline runs feed it.

## L. Measured 2026-09-26: the Worker's weights copied to internal storage (owner approved)

- **The copy:** `~/AI-Models/llm/Cyber-Tiel-Coder-35B-A3B-GGUF-MTP/Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf`, 13,600,579,904 bytes, SHA-256 `d60adb32…48bd0e`, identical to the USB original, which is kept. Internal free space after the copy: 48 GiB.
- **Read rates:**
  - USB sequential read: 130 s for 13.6 GB (**105 MB/s**);
  - the observed llama-server mmap load from USB: about 300 s (about 43 MB/s effective);
  - so page-fault reads on USB cost more than half the load. **A sequential pre-read, or `--no-mmap`, should roughly halve USB loads even without a copy (§F's A/B).**
  - Internal SSD read (a 2 GB probe of an uncached file): **about 3.4 GB/s**, so the Worker's weights read in about 4 s. A load from internal storage is expected to be dominated by server start-up and Metal buffer setup, not the disk; to be measured on the first permitted load.
- **Registry:** the registry and `SEKHEMET_MODELS_DIR` still point at USB. Repointing is §A's action, a person's choice on the model page (B4.1). Until then, a load can use the internal copy only when the models directory is set to `~/AI-Models/llm`, which holds only the Worker and the Planner/Seshat GSQ-RCO.
