# Local model candidates for the Sekhemet harness (M4 / 24 GB)

Research date: 2026-09-18. Scope: open-weight models on the Hugging Face Hub, plus the peculiar-ragdoll repos (section 2) and prism-ml Ternary-Bonsai-2-27B (section 4.1). This was read-only research; no model files were downloaded.
Every benchmark number below has a source URL (see [Sources](#sources)). Labels:
- **[V]**: reported by the model's own vendor on its model card or blog.
- **[3P-vendor]**: measured by a *different* model vendor, which may be a competitor, and published on that vendor's card. It is not neutral, but it is at least a second measurement.
- **[Q]**: measured by the quantizer/repackager (peculiar-ragdoll). These are small-n numbers from community tooling.
- **[I]**: independent, from Artificial Analysis.
- **n/f**: not found. **No benchmark number in this report is estimated.**

Estimates (memory, tok/s) are marked **est.** and are computed, not measured.

---

## 1. Hardware summary and estimation method

| Item | Value |
|---|---|
| Machine | Mac mini M4 (Mac16,10), 10-core CPU (4P+6E), 10-core GPU, Metal 4 |
| Memory | 24 GB unified, ~120 GB/s. Metal working set ~16-18 GB. OS and apps use ~4-6 GB |
| **Practical budget** | **weights + KV + compute buffers ≤ ~14-15 GB**, one model resident. We already hit an OOM with a 13.7 GB model at 32k context |
| Disk | 3.3 GB/s SSD, **~26 GB free**, so at most one ~13 GB download at a time |
| Runtimes | llama.cpp b10809, Ollama 0.34.2, MLX |

**Resident memory at 8k context (est.)** = GGUF file + KV cache at 8k (f16) + ~0.8 GB of compute buffers and overhead. KV per token:
- Qwen3.5/3.6/Ornith/KAT 35B-A3B hybrids have only 10 of 40 blocks as attention. KV is ~21.9 KiB/token (measured, Nail card), so **~0.18 GB at 8k**.
- Qwen3.6/3.8-27B dense: 86.5 KiB/token (measured, Dagger card), so **~0.7 GB at 8k**.
- Other models are computed from their configs: Devstral 24B ≈ 160 KiB/token (~1.3 GB), Granite-4.2-30B ≈ 256 KiB/token (~2.1 GB), Gemma-4-26B-A4B ≈ 0.3-0.5 GB (sliding window; rough). Nemotron and LFM2 hybrids are small.

**Decode tok/s (est.).** The rule of thumb is `0.85 × 120 GB/s ÷ active-weight bytes`, where active bytes = active params × (file size ÷ total params).
- The raw formula **overestimates MoE decode about 3×** on this box. For Qwen3.6-35B-A3B at IQ3_S it predicts ~87 tok/s against ~29.5 measured, because routing, expert gather and the attention/SSM layers are not bandwidth-bound in the same way.
- It fits dense models well: ~9.0 predicted vs 6.6-8.7 measured for a 27B at IQ3_S.
- So each table shows **formula / calibrated**. Calibrated = formula × 0.34 for MoE and × 0.85 for dense, fitted to your two measurements. Treat the calibrated value as the realistic number.

---

## 2. peculiar-ragdoll models (author of the current worker "Nail")

The account has 28 repos (https://huggingface.co/api/models?author=peculiar-ragdoll). Everything they publish is **a quant, a re-template, or both. There is no gradient fine-tuning in any of these repos.** The recipe is always the same: an upstream model (sometimes someone else's fine-tune or abliteration) plus their own imatrix/Unsloth-Dynamic-style quant plus the **"Sharp" chat template**, which is froggeric's Qwen-Fixed-Chat-Templates with a **force-appended terseness system prompt**.

### 2.1 Key findings for our observed Nail problems

1. **Nail is not a fine-tune.** The card says it is *"Unsloth's UD-Q4_K_XL quant of Qwen3.6-35B-A3B with an improved chat template"*. Weights are stock Qwen3.6-35B-A3B. So "general fine-tune with unreliable JSON" really means **stock Qwen3.6-35B-A3B behaviour plus the template**.
2. **Nail's GGUFs embed the old v1 template** (`qwen3.6-froggeric-v21.3`, archived at `Qwen-Sharp-Chat-Templates/archive/v1-...`). The current Sharp template is **v22.5.0**. Between v1 and v22.5 the author fixed several things that match our symptoms:
   - **Thinking-off tool path (v22.3.1).** With tools offered and thinking off, the old template still told the model to reason in `<think>` and to emit the call "IMMEDIATELY after thinking". That contradiction is a plausible cause of leakage.
   - **Two tool-call protocols at once (v22.4.1).** When a runtime injected its own tool protocol, the model got two contradictory protocols and followed one at random: 2/6 calls parsed, the rest leaked as raw text.
   - **Serialization (v22.2+ upstream).** Booleans and nulls were emitted as Python `True`/`None`; they now go through `tojson`.
   - **Parallel tool calls (v22.4.0).** Parallel-call whitespace was fixed so the KV prefix cache stays valid.
3. **Tool-call format is controllable.** Both v1 and v22.5 default to `tool_call_format='xml'`, which is Qwen3-Coder style: `<tool_call><function=write_file><parameter=path>…`.
   - You can switch to JSON inside `<tool_call>` with `chat_template_kwargs: {"tool_call_format": "json"}`. Thinking can be disabled with `{"enable_thinking": false}`. The terseness block can be removed with `{"terse": false}` (v22.3.2+ only; **not** in Nail's embedded v1).
   - The `write_file(path=..., content=...)` output we see is what Qwen3.5/3.6 do when the harness asks for JSON in plain prompt text instead of passing `tools` through the OpenAI API with llama-server's `--jinja` native parser. The Qwen issue tracker confirms the failure is real on 35B-A3B (*"consistently fails JSON generation"*, QwenLM/Qwen3.8#125, status badcase-confirmed).
   - llama.cpp also has an open bug where the lazy grammar lets malformed XML tool calls through (duplicate `</parameter>`, ~1 in 128 requests; ggml-org/llama.cpp#24807). A second bug covers tool calls emitted *inside* the thinking block (#20837).
   - **Action:** run `llama-server --jinja --chat-template-file <Sharp v22.5.0 chat_template.jinja>`, pass tools via the API, and send `chat_template_kwargs: {"enable_thinking": false, "tool_call_format": "json"}` on worker turns. Keep a repair/retry path for the ~1% malformed calls.
4. **Newer and coder releases exist.**
   - **Tiel-Coder-35B-A3B** (2026-08-19, updated 2026-09-10) is the author's coder build. It is based on **Ornith-1.5-35B-A3B**, a coding/agentic RL fine-tune of the Qwen3.5/3.6-35B-A3B architecture.
   - **Cyber-Tiel** is an abliterated Tiel. Not recommended for us.
   - **Nail-GGUF-MTP** is Nail plus an MTP head for speculative decoding.
5. **Better-fitting quants than Nail IQ3_S (13.7 GB):**
   - Tiel `UD-IQ3_XXS` **13.2 GB**; Tiel `UD-Q2_K_XL` 12.3 GB (the author calls it the "last resort").
   - Nail-MTP `UD-IQ3_XXS` 14.1 GB. This is larger because it includes the MTP head; don't use it.
   - Stock Unsloth Qwen3.6-35B-A3B `UD-IQ3_XXS` 13.2 GB.

### 2.2 Repo survey

Sizes are GB (10^9), from the Hub API. Context for all 35B-A3B builds: 262,144 native.

| Repo | Base | Target | Params (total/active) | Quants ≤ 15 GB (size) | Benchmarks published (source: card) | Notes / known issues |
|---|---|---|---|---|---|---|
| [Nail-Qwen3.6-35B-A3B-GGUF](https://huggingface.co/peculiar-ragdoll/Nail-Qwen3.6-35B-A3B-GGUF) | Qwen/Qwen3.6-35B-A3B (Unsloth UD quant, unmodified weights) | General / "token-efficient", agentic coding | 35B / ~3B (card says 3.4B) | UD-IQ3_S 13.7 (others 20.9-31.8) | [Q] Claw-Eval multi_turn avg **60.5** vs Qwen3.6-27B 55.4, Dagger 58.8. [Q] 10-problem SE set: 100% at **58 s/solve** vs 184 s for Qwen3.6-27B. All measured on MLX on an M2 Ultra, **not on this GGUF** (card says so). | v1 template embedded. Sampling: temp 1.0, top_p 0.95, top_k 20, min_p 0, no penalties. Always-on terseness prompt; cannot be disabled in the v1 template. Thinking on by default. |
| [Nail-Qwen3.6-35B-A3B-GGUF-MTP](https://huggingface.co/peculiar-ragdoll/Nail-Qwen3.6-35B-A3B-GGUF-MTP) | Unsloth MTP GGUF of Qwen3.6-35B-A3B | same | same | UD-IQ3_XXS 14.1 | same as Nail | The Sharp card names MTP speculative decoding as the "leading suspect" for a stray mid-answer `</think>` tag. |
| [Tiel-Coder-35B-A3B-GGUF](https://huggingface.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF) | ornith-ai/Ornith-1.5-35B-A3B | **Agentic coding** | 35.95B / ~3B | **UD-IQ3_XXS 13.2**, UD-Q2_K_XL 12.3 | [Q] SWE-bench-Live, 25 tasks, 1 run: **Tiel 12/25** (8.6 min median). Ornith 8, Nail 9, stock Qwen3.6-35B-A3B 8, Qwen3.8-27B 16 (50.2 min), Dirk 15 (20.1 min), Opus 4.6 medium 12. [Q] Claw-Eval multi-turn **67.2** vs Ornith 65.3, Nail 60.5. [Q] MMLU-Pro 73.7 vs Nail 84.0 | Own code-weighted imatrix. Sampling: temp 1.0 / top_p 0.95 / top_k 20; **temp 0.6 for agentic coding**. Carries the Sharp template (version not stated). No MTP head. Weak on trivia/knowledge. |
| [Tiel-Coder-35B-A3B-GGUF-MTP](https://huggingface.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP) | same + trained MTP head (fixed upstream 2026-08-23) | same | same | UD-IQ3_XXS 13.6, UD-Q2_K_XL 12.7 | same | Only useful if you use speculative MTP. Costs +0.4 GB. |
| [Cyber-Tiel-Coder-35B-A3B-GGUF](https://huggingface.co/peculiar-ragdoll/Cyber-Tiel-Coder-35B-A3B-GGUF) (+ MTP) | huihui-ai abliterated Ornith-1.5 | Coding + offensive security, **abliterated** | same | UD-IQ3_XXS 13.2 | [Q] SWE-bench-Live and Cybench 15/43 (images only), HarmBench 0% refusals | **Not recommended.** The author themselves insists on OS-level sandboxing; abliteration and prompt injection is a bad mix for an autonomous harness. |
| [Unsloth-Ornith-1.5-35B-A3B](https://huggingface.co/peculiar-ragdoll/Unsloth-Ornith-1.5-35B-A3B) | Ornith-1.5-35B-A3B | Community reproduction of an Unsloth UD quant, **with Ornith's own template** | same | UD-IQ3_XXS 13.2, UD-Q2_K_XL 12.3 | n/f (refers to Ornith vendor numbers) | Clean A/B control against Tiel's Sharp template. |
| [Dirk-Qwen3.8-27B-GGUF](https://huggingface.co/peculiar-ragdoll/Dirk-Qwen3.8-27B-GGUF) | Qwen/Qwen3.8-27B (UD quants plus ISTA-DASLab GSQ-RCO quants) | General / hard tasks | 27.8B dense | GSQ-RCO IQ2_XS 8.8, IQ2_S 9.6, IQ3_XXS 10.4, **IQ3_S 12.1**, UD-Q3_K_XL 13.1, UD-IQ4_XS 14.3 | [Q] SWE-bench-Live **15/25** (stock 3.8-27B 16/25) at 2.5× stock's speed. [Q] MMLU-Pro 85.3%. [Q] Claw-Eval answer tokens −59% | GSQ-RCO tiers carry Sharp v22.4.1; UD tiers carry an older version. Effort via `chat_template_kwargs.reasoning_effort` (low/medium/xhigh). `enable_thinking:false` supported. |
| [Dagger-Qwen3.6-27B-GGUF](https://huggingface.co/peculiar-ragdoll/Dagger-Qwen3.6-27B-GGUF) / [-MTP](https://huggingface.co/peculiar-ragdoll/Dagger-Qwen3.6-27B-GGUF-MTP) | bottlecapai/ThinkingCap-Qwen3.6-27B (a real fine-tune that shortens thinking) | Long single sessions | 27B dense | MTP Q3_K_M 13.5 only (non-MTP starts at Q4_K_M 17.8) | [Q] Claw-Eval multi_turn 58.8. [Q] 10-problem SE set 100% at 168 s/solve | Superseded by Dirk (3.8) for our use. |
| [Occult-Nail-1.0-35B-A3B-GGUF](https://huggingface.co/peculiar-ragdoll/Occult-Nail-1.0-35B-A3B-GGUF) | Heretic-abliterated Qwen3.6-35B-A3B | Abliterated Nail | 35B / 3B | UD-Q2_K_XL 12.3 | [Q] MMLU-Pro 84.0 | Not recommended (abliterated). |
| [Qwen-Sharp-Chat-Templates](https://huggingface.co/peculiar-ragdoll/Qwen-Sharp-Chat-Templates) | froggeric/Qwen-Fixed-Chat-Templates v22.5 | Template only | n/a | n/a | [Q] "about as many issues fixed as stock template, 2.7× faster median" | **Most useful artifact here.** Use v22.5.0 with any Qwen3.5/3.6/3.8 or Ornith GGUF via `--chat-template-file`. Knobs: `tool_call_format` xml\|json, `enable_thinking`, `reasoning_effort`, `preserve_thinking`, `terse`, `suppress_tool_instructions`. |
| MLX builds (Nail-MLX, Tiel/Dirk/Cyber-Tiel oQ4e/oQ6e) | as above | as above | as above | Smallest Tiel oQ4e ≈ 21 GB | as above | **All MLX builds are about 20 GB or more and do not fit.** |

---

## 3. WORKER candidates (fast tool-calling MoE)

Sorted roughly by recommendation. SWE-V = SWE-bench Verified, TB = Terminal-Bench, LCB = LiveCodeBench v6. AA II = Artificial Analysis Intelligence Index (independent; site snapshot 2026-09-18). Resident memory and tok/s are est.

| Model (repo + quant) | Total / active | Disk GB | Resident @8k (est.) | tok/s formula / **calibrated** (est.) | SWE-V | TB | Other agentic / tool-use | LCB | License | Fit / issues |
|---|---|---|---|---|---|---|---|---|---|---|
| **Tiel-Coder-35B-A3B** `peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF` UD-IQ3_XXS | 35.95B / 3B | 13.2 | ~14.2 | 90 / **~31** | base Ornith-1.5: **79.0 [V]** | base: TB2.1 67.8 (Terminus-2) / 68.5 (Claude Code) **[V]** | [Q] SWE-bench-Live 12/25. Base: MCP-Atlas 70.2, Toolathlon-V 48.7, Claw-Eval 72.5 **[V]** | n/f | MIT | Fits (tight). Reasoning model, thinking on by default; turn it off for worker turns. Knowledge (MMLU-Pro) regresses. |
| **Ornith-1.5-35B-A3B** (stock template) `peculiar-ragdoll/Unsloth-Ornith-1.5-35B-A3B` UD-IQ3_XXS, or `mudler/Ornith-1.5-35B-A3B-APEX-GGUF` I-Mini (13.5) | 35.95B / 3B | 13.2 | ~14.2 | 90 / **~31** | **79.0 [V]**. Ornith-1.0 was measured at 55.8 by Kwaipilot [3P-vendor] | 67.8 / 68.5 [V]. Ornith-1.0: 35.98 [3P-vendor] | SWE Pro 59.6, NL2Repo 46.2, MCP-Atlas 70.2 [V]. [Q] SWE-bench-Live 8/25 | n/f | MIT | Fits. Vendor says the *"Qwen chat template needs to be modified"* for its evals; use vLLM parser `qwen3_coder`. **Official ornith-ai GGUF is Q4_K_M 21.7 GB only; does not fit.** bartowski's smallest IQ3 is 15.3 GB, which is too big. |
| **KAT-Coder-V2.5-Dev** `mradermacher/KAT-Coder-V2.5-Dev-i1-GGUF` i1-IQ3_XXS | 34.7B / 3B | 13.6 | ~14.6 | 87 / **~30** | **69.4** [V], measured in Claude Code harness. Kwaipilot measures Qwen3.6-35B-A3B at 64.4 in the same setup | TB2.1 **41.0** avg (Terminus-2 32.6 / Claude Code 49.4) [V] | SWE Pro 45.96, SWE Multi 63.0, PinchBench 93.4 [V]. RL cut *"abnormal tool labels 9.34% → 0.28%"* [V] | n/f | Apache-2.0 | Borderline fit. Explicitly RL-tuned against empty or failed tool calls and runaway parallel calls, which targets our failure mode. Thinks by default and can be disabled. bartowski's smallest is IQ3_XXS 14.9, too big. |
| Qwen3.6-35B-A3B (stock) `unsloth/Qwen3.6-35B-A3B-GGUF` UD-IQ3_XXS (baseline; Nail's weights) | 35B / 3B | 13.2 (Nail IQ3_S 13.7) | ~14.2 (14.7) | 90 / ~31; **measured 29-30** | **73.4 [V]**; 64.4 [3P-vendor, Kwaipilot]; 70.12 [3P-vendor, NVIDIA] | TB2.0 **51.5 [V]**; TB2.1 52.5 / 49.2 [3P-vendor, Ornith]; 32.0 [3P-vendor, Kwaipilot] | TAU3 67.2, MCPMark 37.0, MCP-Atlas 62.8, Claw-Eval 68.7 [V]. [Q] SWE-bench-Live 8/25. **AA II: 19 [I] on the model page vs 32 [I] in AA's Nemotron-3.5 launch article (different index versions; both shown)** | **80.4 [V]** | Apache-2.0 | Baseline. JSON/XML tool-call failures are documented upstream (QwenLM/Qwen3.8#125, llama.cpp#24807). |
| Gemma-4-26B-A4B-it `unsloth/gemma-4-26B-A4B-it-GGUF` UD-IQ4_XS (or UD-IQ3_S 11.3) | 25.8B / 3.8B | 13.6 (11.3) | ~14.8 (~12.5) | 50 / **~17** (60 / ~20) | **Conflicting:** 17.4 [3P-vendor, Qwen]; 35.8 [3P-vendor, Kwaipilot]; 57.40 [3P-vendor, NVIDIA]. Google: n/f | TB2.0 34.2 [3P-vendor, Qwen]; TB2.1 37.22 [3P-vendor, NVIDIA] | **Tau2 68.2 [V]**. AA II 17 (AA marks it an *estimate*) [I] | 77.1 [V] | Apache-2.0 | Fits. Slower (4B active, needs a larger quant). Kwaipilot saw hallucinated MultiEdit tool calls and context overflow. Different (Gemma) tool format, which adds diversity. |
| Qwen3-Coder-30B-A3B-Instruct `unsloth/...-GGUF` UD-IQ3_XXS (on hand as IQ4_XS 15.6: **too big**) | 30.5B / 3.3B | 12.8 | ~13.8 | 74 / ~25 | 51.6 [V] (OpenHands, per HF discussion); 31.8 [3P-vendor, Kwaipilot] | 13.5 [3P-vendor, Kwaipilot] | n/f | n/f | Apache-2.0 | Fits at IQ3_XXS. Superseded by the newer A3B models. Your IQ4_XS (15.6 GB) exceeds the budget. |
| GLM-4.7-Flash `unsloth/GLM-4.7-Flash-GGUF` UD-IQ3_XXS | 31.2B / ~3B | 12.9 | ~13.9 | 82 / ~28 | 59.2 [V] | n/f | τ²-Bench 79.5 [V]. AA II 15 (estimate) [I] | 64.0 [V] | MIT | Fits. Older generation (Jan 2026). |
| LFM2-24B-A2B `bartowski/LiquidAI_LFM2-24B-A2B-GGUF` IQ4_XS | 23.8B / 2.3B | 12.7 | ~13.7 | 84 / ~28 | n/f | n/f | n/f (card has no coding/agentic benchmarks) | n/f | LFM Open v1.0 (restrictive) | Fits, but **32k context max**. Emits **Pythonic calls** `[fn(a="x")]` by default. No coding evidence. Not recommended. |
| gpt-oss-20b `unsloth/gpt-oss-20b-GGUF` (MXFP4 native) | 21B / 3.6B | 11.6 | ~12.6 | 51 / ~17 | 34.0 [3P-vendor, Z.ai] | n/f | τ²-Bench 47.7 [3P-vendor, Z.ai]. AA II 9 [I] | 61.0 [3P-vendor, Z.ai] | Apache-2.0 | Fits, but clearly weaker than the 2026 A3B models. Uses the Harmony format. |
| Ornith-1.5-9B `ornith-ai/Ornith-1.5-9B-GGUF` Q4_K_M (dense) | 9B / 9B | 5.8 | ~7 | 17.6 / ~15 | **70.6 [V]** | TB2.1 46.2 / 47.0 [V] | MCP-Atlas 54.2, Toolathlon-V 41.2 [V] | n/f | MIT | Fits easily and leaves room for large context, but is ~2× slower than the A3B MoEs. Low-memory fallback. |
| K2-Horizon-MoVA-36B-A4B `NANI-Nithin/K2-Horizon-MoVA-36B-A4B-GGUF` IQ2_M | 37.4B / 4B | 12.5 (IQ3_XXS 14.6) | ~13.5 | 76 / ~26 | n/f | TB2.1 58.6 [V] | tau3-Banking 26.8 [V] | n/f | Apache-2.0 | **Do not use yet.** Needs the **MBZUAI-IFM llama.cpp fork**; upstream support is not merged as of Sept 2026. Also needs a custom `k2_horizon` tool parser, and only a 2-bit quant fits. |
| Nemotron-3.5-Lightning-30B-A3B (on hand) | 31.6B / 3.6B | **≥ 18.9** (Unsloth IQ1_M is 19.4) | > 19 | n/a | 51.56 [V] | TB2.1 24.58 [V]; 24% [I] (AA) | τ³-Banking 9.28 [V]. **AA II 24 [I]**, ~670 tok/s on GPUs | n/f | NVIDIA Open Model | **Does NOT fit.** Every GGUF is ≥ 18.9 GB. |
| Qwen-AgentWorld-35B-A3B | 34.7B / 3B | IQ3_XXS 13.7 | ~14.7 | ~30 | n/f as an agent | n/f | Card table covers 7 "world-model" domains (e.g. SWE 65.63, Term 53.96) [V] | n/f | Apache-2.0 | **Wrong tool for the job.** It is a *language world model* that simulates environment responses. It is not an executor. |
| Qwen3-Coder-Next (80B-A3B) | 79.7B / 3B | ≥ ~30 at usable quants | — | — | — | — | — | — | Apache-2.0 | **Does NOT fit.** |

## 4. MANAGER candidates (quality and structured output; called rarely)

| Model (repo + quant) | Params | Disk GB | Resident @8k (est.) | tok/s formula / **calibrated** (est.) | SWE-V | SWE Pro | TB | IFBench / tool / other | AA II [I] | License | Fit / issues |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Qwen3.8-27B**: `peculiar-ragdoll/Dirk-Qwen3.8-27B-GGUF` GSQ-RCO-IQ3_S (on hand) or `unsloth/Qwen3.8-27B-GGUF` UD-IQ3_XXS | 27.8B dense | 12.1 (10.9) | ~13.6 (~12.4) | 8.4 / **~7.2** (9.4 / ~8.0); measured 6.6-8.7 | n/f (card reports Pro instead) | **61.7 [V]** | TB2.1 **73.0 [V]** | IFBench **79.5**, LCB 90.3, DeepSWE 42.2 [V]. [Q] SWE-bench-Live 16/25 stock, 15/25 Dirk | **34** (the page says "#1/142" in class). A VentureBeat snippet claims 52; that is unverified and may be a different index version | Apache-2.0 | Fits. Strongest local model found. Thinking on by default with `preserve_thinking` on, which costs context. UD-IQ4_XS (14.3) is too tight with KV. |
| **Ornith-1.5-35B-A3B / Tiel-Coder** (same file as the worker, UD-IQ3_XXS) | 35.95B / 3B | 13.2 | ~14.2 | ~31 | **79.0 [V]** | **59.6 [V]** | 67.8 [V] | GPQA-D 89.2, HLE 25.6, Toolathlon-V 48.7 [V] | n/f | MIT | Fits. **Removes model swaps entirely** because one resident model serves both roles; use high reasoning effort for manager calls. Weaker world knowledge. |
| **Muse-Glimmer-30B** `unsloth/Muse-Glimmer-30B-GGUF` UD-IQ3_XXS | 29.8B dense (incl. 1.8B vision) | 13.1 | ~14.5+ (KV size n/f) | 7.8 / ~6.6 | **76.0 [V]** | **51.2 [V]** | TB2.1 51.7 [V] | IFBench 77.0 [V] | **35** (AA Nemotron launch article) | Apache-2.0 | **Tight.** Test at ≤8k context with q8_0 KV. Card: *"Reliable Tool Use… Failure Recovery"*. Reasoning strength is set in the system prompt. |
| **Ternary-Bonsai-2-27B** `prism-ml/Ternary-Bonsai-2-27B-gguf` **PQ2_0** (PTQ1_0 5.95) | 27.36B dense, ternary derivative of Qwen3.8-27B (~75% linear attention) | **7.21** | **~8.5** (KV 64 KiB/token f16, per Bonsai-demo KV-CACHE.md) | 14.1 / ~12 by formula. **Realistic est. ~8-12 decode, ~55-65 prefill** (see 4.1) | **60.8 [V]** (whitepaper; Qwen3.8-27B FP16 measured at 80.6 in the same setup) | n/f | TB2.1 **52.8 [V]** (Qwen3.8-27B FP16: 69.7, same setup) | BFCL v3 74.92 (FP16 76.74), τ²-Bench 80.22 (FP16 82.73), IFEval 91.31, IFBench 74.00, LCB v6 90.07, HumanEval+ 95.12 [V] | n/f | Apache-2.0 | Fits with a lot of headroom. **Needs the PrismML-Eng llama.cpp fork**; stock llama.cpp and Ollama reject PQ2_0/PTQ1_0. **Frees ~4-5 GB** vs Qwen3.8-27B IQ3_S. Keeps ~75% of FP16 agentic scores (TB2.1, SWE-V). See 4.1. |
| Qwen3.6-27B `unsloth/Qwen3.6-27B-GGUF` UD-IQ3_XXS | 27B dense | 12.0 | ~13.5 | 8.5 / ~7.2 | **77.2 [V]** | 53.5 [V] | TB2.0 59.3 [V]; TB2.1 63.4 [3P-vendor, Qwen3.8 card] | SkillsBench 48.2, Claw-Eval 72.4 [V] | 22 | Apache-2.0 | Fits, but dominated by Qwen3.8-27B at the same size. |
| Devstral-Small-2-24B-Instruct-2512 `unsloth/...-GGUF` IQ4_XS (Q3_K_M 11.5) | 24B dense | 12.8 | ~14.9 (Q3_K_M ~13.6) | 8.0 / ~6.8 | 68.0 [V] | n/f | TB2 22.5 [V] | n/f | 8 (non-reasoning), 135 tok/s | Apache-2.0 | Fits at Q3_K_M. No thinking, so structured output is predictable, but it is weak for its size. Low-risk fallback only. |
| Granite-4.2-30B `bartowski/granite-4.2-30b-GGUF` IQ3_XXS | 30B dense | 11.7 | ~14.6 (KV ~2.1 GB) | 8.7 / ~7.4 | 57.0 [V] | 33.29 [V] | TB2.1 29.24 [V] | **BFCL v4 61.39** [V], τ³ 68.05, IFBench 77.17, LCB 75.77 [V] | n/f | Apache-2.0 | Fits only with a short context (large KV). The only candidate with a BFCL number. Coding is weaker. |
| Gemma-4-12B / Qwen3-14B / Mistral-Small-3.2 / Ministral-3-8B / qwen2.5-coder:14b / Qwythos-9B (on hand) | — | — | — | — | not collected in detail (older/weaker tier) | — | — | — | — | — | Not competitive with the 2026 27B/A3B models above for either role. |

### 4.1 Ternary-Bonsai-2-27B (prism-ml): verification and assessment as manager

**Verification against the whitepaper** (`bonsai-2-27b-whitepaper.pdf` in PrismML-Eng/Bonsai-demo; downloaded and read):
- Every number you were given matches the whitepaper's Table 10 and the HF card: BFCL v3 74.92 (FP16 76.74), LiveCodeBench v6 90.07, HumanEval+ 95.12, IFEval 91.31. All are **[V]** and in thinking mode at xhigh.
- The "84.78 vs 86.32" figure is the **card's 14-benchmark** average. The whitepaper's **20-benchmark** average is **83.9 vs 85.4**. Both are 98.2% retention.
- **These are not measurements of the GGUF you're downloading.** Every quality benchmark was run through **EvalScope + vLLM on H100** (tensor-parallel 2 × data-parallel 4). None was run on the llama.cpp fork or the PQ2_0/PTQ1_0 packs.
- **BFCL v3 was run in prompt-based mode**: schemas in the system prompt, calls parsed from text. That mode is actually close to how a harness that parses text would see it.
- **The whitepaper also reports agentic scores the card omits.** On TB2.1 (Terminus-2, JSON) Bonsai scores **52.8** against **69.7** for Qwen3.8-27B FP16. On SWE-V (mini-swe-agent) it scores **60.8** against **80.6**. The whitepaper itself calls this *"roughly three quarters of the full-precision performance"*.
  - Note the conflict with Qwen's own card, which gives TB2.1 **73.0** for Qwen3.8-27B (Terminus) against the whitepaper's 69.7.
- **Throughput figures differ slightly between sources.**
  - M4 Pro: **18.0 TG128 / 125 PP512** in both the card and whitepaper Table 6. The whitepaper says these come from the *"earlier pre-rotation build"* and should be read only as scaling indicators.
  - M5 Pro: 28.1 / 387 (card main table), 27.7 / 397 (whitepaper Tables 5 and 6), 28.7 / 393 (card, pre-rotation table).

**Independent evaluations:**
- **None found for Bonsai 2.** It was released 2026-09-16.
- For the **predecessor Ternary-Bonsai-27B** (Qwen3.6-27B base, Q2_0, fork):
  - Astezelex/bonsai-27b-16gb-bench (RTX 5060 Ti) [I]: AIME26 0.867 at a 60k budget vs 0.633 for Qwen3.6-27B UD-IQ2_XXS. LiveCodeBench n=50 **0.520 vs 0.300**. MMLU-Redux 0.871 vs 0.860 (a statistical tie). Its key finding is that low-bit models mostly fail by *not converging within the thinking budget*, not by being wrong.
  - MiaAI-Lab tool-eval-bench v2.0.6 [I]: **85/100**, 84 scenarios, 8 trials. Pass^8 76.2% with a 0.0 pp reliability gap. Tool selection, parameter precision, error recovery and instruction following all 100%. Median turn 1.7 s (GPU).
  - Bonsai-demo community benchmarks [I, community]: **base M4 24 GB, MLX 2-bit: 12.7 tok/s decode, 65 tok/s prefill, peak memory 8.8 GB.** M4 Pro llama.cpp: 19.0 / 116. M3 Pro: 12.6 / 78.6.

**Estimates for our base M4** (all **est.**; nobody has measured Bonsai 2 PQ2_0 on llama.cpp on a base M4):
- **Decode ~8-12 tok/s, center ~10.**
  - Bandwidth-scaling the M4 Pro figure (18.0 × 120/273) gives 7.9. Scaling the M3 Pro figure (12.6 × 120/150) gives 10.1. The raw formula (0.85 × 120/7.21) gives 14.1, or ~12 after dense calibration. The measured predecessor on this exact chip under MLX gives 12.7.
  - Compare Qwen3.8-27B IQ3_S at a **measured** 6.6-8.7. So roughly 1.2-1.5× faster decode.
- **Prefill ~55-65 tok/s.** It is compute-bound and the base M4 has half the M4 Pro's GPU cores: 125 × 10/20 ≈ 62, and the M3 Pro scaled by core count gives ≈ 56.
  - **This is the real cost:** an 8k-token manager prompt would take roughly 2-2.5 minutes to prefill (est.). Use prompt caching and keep manager prompts short.
  - Measure `llama-bench -p 512 -n 128` for both Bonsai and Qwen3.8-27B IQ3_S before deciding; we have no prefill number for the IQ3_S on this box.
- **Memory ~8.5 GB at 8k** (7.21 file + ~0.5 GB KV + ~0.8 GB overhead). The predecessor peaked at 8.8 GB on MLX on a base M4.
  - That frees ~4-5 GB against Qwen3.8-27B IQ3_S (~13.6 GB resident). The headroom buys a **32k-64k manager context** at ~10-12 GB resident, or q4 KV (`BONSAI_KV4=1`, ~18 KiB/token).
  - It does **not** allow co-residency with a 13 GB worker: 8.5 + 14.2 is well over budget.

**Fork and tool calling** (from Bonsai-demo `start_llama_server.sh`, `TOOLS.md` and `AGENTS.md`):
- `start_llama_server.sh` runs the fork's llama-server with **`--jinja`**. `/v1/chat/completions` then accepts the OpenAI `tools` array and returns structured **`tool_calls`**. The vendor says this is *"verified with full tool round-trips"*. Thinking goes to `reasoning_content`.
- Thinking is **on by default at xhigh**. Cap it with `--reasoning-budget N` or per request with `thinking_budget_tokens`. **`low` effort is not supported**: it behaves like xhigh.
- The fork is **rebased on mainline** (release tags `prism-b10658+`), so it probably also runs ordinary GGUFs. That would let one binary serve both roles, but **verify it** before relying on it.
- **Do not use Ollama**: the vendor says Ollama and stock llama.cpp either reject these packs or produce garbage.
- The Metal speculative-decoding path (`BONSAI_SPECULATIVE=1`) is experimental. A community M4 Pro run slowed to 6.83 tok/s with it on.

**Verdict for the manager role:**
- Bonsai-2 is a credible **memory-saving manager**, not a quality upgrade.
- On the agentic benchmarks that matter most for decomposition and repair sketches, the vendor's own numbers put it at about 75% of Qwen3.8-27B FP16 (SWE-V 60.8 vs 80.6; TB2.1 52.8 vs 69.7).
- No agentic numbers exist for our Qwen3.8-27B IQ3_S (n/f), so the head-to-head can't be settled from published data.
- Bonsai wins on memory (−4-5 GB), decode (~1.2-1.5× est.), instruction following (IFEval 91.3, IFBench 74.0 [V]) and structured tool-call reliability (predecessor: 85/100, Pass^8 76.2% [I]).
- Bonsai loses on long-horizon agentic quality and very probably on prefill speed, and it adds a second, forked llama.cpp binary.
- **Recommendation:** keep Qwen3.8-27B IQ3_S as the primary manager. Run Bonsai-2 PQ2_0 as the A/B candidate on your own repair-sketch evals. Prefer it if (a) the Qwen3.8 IQ3_S keeps pushing memory into swap at the manager context you need, or (b) its sketches score within noise of Qwen3.8's on your cards.

---

## 5. Recommendations

### WORKER: top 3

1. **Tiel-Coder-35B-A3B, `peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF`, file `Tiel-Coder-35B-A3B-UD-IQ3_XXS.gguf` (13.2 GB).**
   - Same author and same architecture as Nail, so it is a drop-in swap that is 0.5 GB smaller.
   - The base Ornith-1.5 has the best vendor agentic-coding numbers in the 3B-active class: SWE-V 79.0 vs 73.4 and TB2.1 67.8 vs 52.5 for Qwen3.6-35B-A3B.
   - The only head-to-head from the same harness is the quantizer's own SWE-bench-Live (n=25): Tiel 12 vs Nail 9.
   - Serve it with `--jinja --chat-template-file` pointing at **Sharp v22.5.0**, `-c 8192`–`16384`, `--cache-type-k q8_0 --cache-type-v q8_0`.
   - Per-request: `chat_template_kwargs: {"enable_thinking": false, "tool_call_format": "json", "terse": false}`. Sampling temp 0.6, top_p 0.95, top_k 20.
2. **KAT-Coder-V2.5-Dev, `mradermacher/KAT-Coder-V2.5-Dev-i1-GGUF`, file `KAT-Coder-V2.5-Dev.i1-IQ3_XXS.gguf` (13.6 GB).**
   - Its RL explicitly targeted tool-call pathologies: abnormal tool labels fell from 9.34% to 0.28%, and empty or failed calls were penalised.
   - SWE-V 69.4 in a Claude Code harness, where the same lab measured Qwen3.6-35B-A3B at 64.4.
   - Borderline on memory, so keep context at ≤ 8k.
3. **Ornith-1.5-35B-A3B with its own template, `peculiar-ragdoll/Unsloth-Ornith-1.5-35B-A3B`, file `UD-IQ3_XXS` (13.2 GB).**
   - This is the A/B control that isolates what the Sharp template adds on our harness.
   - If you want a non-Qwen-lineage alternative instead, try `unsloth/gemma-4-26B-A4B-it-GGUF` `UD-IQ3_S` (11.3 GB). It has the most headroom and a vendor Tau2 of 68.2, but it runs at roughly 17-20 tok/s (est.) and third-party SWE-V numbers conflict wildly (17-57).

   *Disk:* only ~26 GB is free, so delete the Nail file or the Qwen3-Coder-30B IQ4_XS (15.6 GB, which doesn't fit anyway) before pulling a second 13 GB file.

### MANAGER: top 3

1. **Qwen3.8-27B: keep `peculiar-ragdoll/Dirk-Qwen3.8-27B-GGUF` `Dirk-Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf` (12.1 GB).**
   - If memory is tight, use `unsloth/Qwen3.8-27B-GGUF` `UD-IQ3_XXS` (10.9 GB) instead.
   - It has the best numbers of anything that fits: TB2.1 73.0 [V], SWE Pro 61.7 [V], IFBench 79.5 [V], and the highest AA index in its class (34 [I]).
   - Use `reasoning_effort: "xhigh"` for decomposition and repair sketches, and `enable_thinking: false` plus JSON tool format for strict structured-output calls.
   - Re-embed Sharp v22.5.0 with `--chat-template-file`. The UD tiers carry an older template.
2. **Ornith-1.5 / Tiel as both worker and manager (single resident model).**
   - Vendor SWE-V 79.0 and SWE Pro 59.6 are close to Qwen3.8-27B, at about 4× the decode speed (est.).
   - It never swaps. A 12 GB reload at 3.3 GB/s is ≥ 4 s plus warmup on every escalation.
   - Worth benchmarking head-to-head against #1 on your repair-sketch task before committing to two models.
3. **Ternary-Bonsai-2-27B, `prism-ml/Ternary-Bonsai-2-27B-gguf` `Ternary-Bonsai-2-27B-PQ2_0.gguf` (7.21 GB), run on the PrismML-Eng llama.cpp fork.**
   - This is the memory-saving manager: ~8.5 GB resident at 8k (est.), which frees ~4-5 GB for a longer manager context.
   - Vendor numbers: BFCL v3 74.92, IFEval 91.31, IFBench 74.0.
   - Its agentic scores are about 75% of Qwen3.8-27B FP16's (SWE-V 60.8 vs 80.6; TB2.1 52.8 vs 69.7), all [V].
   - Estimated ~8-12 tok/s decode but only ~55-65 tok/s prefill. Details in 4.1.
   - Alternates:
     - **Muse-Glimmer-30B** `unsloth/Muse-Glimmer-30B-GGUF` UD-IQ3_XXS (13.1 GB). SWE-V 76.0 [V], IFBench 77.0 [V], AA 35 [I]. A different model family, so its failure modes would differ from the Qwen worker's, which helps review. The fit is tight.
     - **Devstral-Small-2** Q3_K_M (11.5 GB). No thinking, but weak: SWE-V 68, AA 8.

### Do not spend time on
- Nemotron-3.5-Lightning: every GGUF is ≥ 18.9 GB.
- Qwen3-Coder-30B IQ4_XS (15.6 GB).
- Any MLX 4-bit 35B build (≥ 20 GB).
- Qwen3-Coder-Next (80B).
- K2-Horizon-MoVA: needs a llama.cpp fork and only fits at 2-bit.
- Qwen-AgentWorld: a world model, not an executor.
- LFM2-24B-A2B: 32k context, Pythonic calls, no coding evidence.
- Cyber-Tiel and Occult-Nail: abliterated.
- Ornith official GGUF (21.7 GB) and bartowski Ornith/KAT IQ3 tiers (≥ 14.9 GB).
- Granite-4.2-30B beyond a BFCL curiosity (it is dense and slow with a large KV).

---

## Sources

Model cards (vendor [V] numbers, and [3P-vendor] numbers printed on another vendor's card):
- Ornith-1.5-35B-A3B: https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B. Also has Qwen3.6-35B-A3B, Gemma-4-31B and Muse-Glimmer comparison columns. Mirrored without attribution at https://benchlm.ai/models/ornith-1-5-35b-a3b
- Ornith-1.5-9B: https://huggingface.co/ornith-ai/Ornith-1.5-9B
- KAT-Coder-V2.5-Dev: https://huggingface.co/Kwaipilot/KAT-Coder-V2.5-Dev. Also has columns for Qwen3.6-35B-A3B, Qwen3.5-27B, Gemma4-26B-A4B, Ornith-1.0, Qwen3-Coder-30B.
- Qwen3.6-35B-A3B: https://huggingface.co/Qwen/Qwen3.6-35B-A3B. Also has a Gemma4-26B-A4B column.
- Qwen3.6-27B: https://huggingface.co/Qwen/Qwen3.6-27B
- Qwen3.8-27B: https://huggingface.co/Qwen/Qwen3.8-27B. Also has Qwen3.6-27B and Muse-Glimmer columns.
- Qwen-AgentWorld-35B-A3B: https://huggingface.co/Qwen/Qwen-AgentWorld-35B-A3B
- Qwen3-Coder-30B-A3B SWE-V 51.6 discussion: https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/discussions/30
- Gemma-4-26B-A4B-it: https://huggingface.co/google/gemma-4-26B-A4B-it
- Nemotron-3.5-Lightning-30B-A3B: https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16. Also has columns for Qwen3.6-35B-A3B, Gemma-4-26B-A4B, GPT-OSS-20B.
- Devstral-Small-2-24B: https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512
- Granite-4.2-30B: https://huggingface.co/ibm-granite/granite-4.2-30b
- GLM-4.7-Flash (also has a GPT-OSS-20B column): https://huggingface.co/zai-org/GLM-4.7-Flash
- LFM2-24B-A2B: https://huggingface.co/LiquidAI/LFM2-24B-A2B
- gpt-oss-20b: https://huggingface.co/openai/gpt-oss-20b
- Muse-Glimmer-30B: https://huggingface.co/meta-models/Muse-Glimmer-30B
- K2-Horizon-MoVA-36B-A4B: https://huggingface.co/IFM/K2-Horizon-MoVA-36B-A4B. llama.cpp fork note: https://huggingface.co/NANI-Nithin/K2-Horizon-MoVA-36B-A4B-GGUF

Independent [I]:
- AA Qwen3.8-27B (II 34): https://artificialanalysis.ai/models/qwen3-8-27b
- AA Qwen3.6-35B-A3B (II 19): https://artificialanalysis.ai/models/qwen3-6-35b-a3b
- AA Qwen3.6-27B (II 22): https://artificialanalysis.ai/models/qwen3-6-27b
- AA Gemma-4-26B-A4B (II 17, estimate): https://artificialanalysis.ai/models/gemma-4-26b-a4b
- AA gpt-oss-20b (II 9): https://artificialanalysis.ai/models/gpt-oss-20b
- AA Devstral Small 2 (II 8): https://artificialanalysis.ai/models/devstral-small-2
- AA GLM-4.7-Flash (II 15, estimate): https://artificialanalysis.ai/models/glm-4-7-flash
- AA Nemotron 3.5 Lightning launch article (Lightning 24; Qwen3.6-35B-A3B 32; Muse Glimmer 35; TB2.1 24%): https://artificialanalysis.ai/articles/nemotron-3-5-lightning-launch

peculiar-ragdoll [Q] and template:
- https://huggingface.co/api/models?author=peculiar-ragdoll
- https://huggingface.co/peculiar-ragdoll/Nail-Qwen3.6-35B-A3B-GGUF. Chart images: `assets/card_official_score.png`, `assets/card_se_sprint.png`.
- https://huggingface.co/peculiar-ragdoll/Nail-Qwen3.6-35B-A3B-GGUF-MTP
- https://huggingface.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF
- https://huggingface.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP
- https://huggingface.co/peculiar-ragdoll/Cyber-Tiel-Coder-35B-A3B-GGUF
- https://huggingface.co/peculiar-ragdoll/Unsloth-Ornith-1.5-35B-A3B
- https://huggingface.co/peculiar-ragdoll/Dirk-Qwen3.8-27B-GGUF
- https://huggingface.co/peculiar-ragdoll/Dagger-Qwen3.6-27B-GGUF-MTP
- https://huggingface.co/peculiar-ragdoll/Occult-Nail-1.0-35B-A3B-GGUF
- https://huggingface.co/peculiar-ragdoll/Qwen-Sharp-Chat-Templates. Current template: `chat_template.jinja`; Nail's v1: `archive/v1-qwen3.6-froggeric-v21.3/`.

Ternary-Bonsai-2-27B:
- Model card [V]: https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf
- Whitepaper [V] (Tables 6, 8, 10 and Appendix B; TB2.1 and SWE-V in section 4): https://github.com/PrismML-Eng/Bonsai-demo/blob/main/bonsai-2-27b-whitepaper.pdf
- Run scripts and tool calling: https://github.com/PrismML-Eng/Bonsai-demo (`scripts/start_llama_server.sh`, `TOOLS.md`, `AGENTS.md`, `KV-CACHE.md`, `SPECULATIVE.md`)
- Fork: https://github.com/PrismML-Eng/llama.cpp
- Community Apple benchmarks of the predecessor Ternary-Bonsai-27B [I, community]:
  - https://github.com/PrismML-Eng/Bonsai-demo/blob/main/community-benchmarks/ternary-bonsai/mlx-m4-24gb-macos.md
  - https://github.com/PrismML-Eng/Bonsai-demo/blob/main/community-benchmarks/ternary-bonsai/metal-m4-pro-64gb-macos.md
  - https://github.com/PrismML-Eng/Bonsai-demo/blob/main/community-benchmarks/ternary-bonsai/metal-m3-pro-macos.md
- Independent evaluations of the predecessor [I]:
  - https://github.com/Astezelex/bonsai-27b-16gb-bench
  - https://github.com/MiaAI-Lab/Ternary-Bonsai-27B-tool-eval-bench-results

Known issues:
- Qwen3.5/3.6 XML-instead-of-JSON tool calls: https://github.com/QwenLM/Qwen3.8/issues/125
- llama.cpp malformed tool-call XML (~1/128): https://github.com/ggml-org/llama.cpp/issues/24807
- llama.cpp tool calls inside the thinking block: https://github.com/ggml-org/llama.cpp/issues/20837
- vLLM tool calls lost inside `<think>`: https://github.com/vllm-project/vllm/issues/39056

GGUF file sizes: Hub API `https://huggingface.co/api/models/<repo>/tree/main` for each repo listed in the tables:
- unsloth: Qwen3.6-35B-A3B, Qwen3.6-27B, Qwen3.8-27B, gemma-4-26B-A4B-it, NVIDIA-Nemotron-3.5-Lightning, Devstral-Small-2, GLM-4.7-Flash, Qwen3-Coder-30B-A3B, gpt-oss-20b, Muse-Glimmer-30B, Qwen-AgentWorld
- bartowski: Ornith-1.5-35B-A3B, Kwaipilot_KAT-Coder-V2.5-Dev, LiquidAI_LFM2-24B-A2B, granite-4.2-30b
- mradermacher: KAT-Coder-V2.5-Dev-i1, Ornith-1.5-35B-A3B-i1
- mudler: Ornith-1.5-35B-A3B-APEX, KAT-Coder-V2.5-Dev-APEX
- AtomicChat: Ornith-1.5-35B-A3B-GGUF
- ggml-org: NVIDIA-Nemotron-3.5-Lightning-GGUF
- ornith-ai: Ornith-1.5-35B-A3B-GGUF, Ornith-1.5-9B-GGUF
- NANI-Nithin: K2-Horizon-MoVA
- ibm-granite: granite-4.2-30b-GGUF
