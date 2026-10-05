# Model settings per role — research digest (W18 G0, C3-3)

*2026-10-04. The lead's G0 digest for W18 (FINISH_LINE_PLAN row W18): what the local model apps expose, which parameters matter per role for agentic coding, and how to tune fast on one machine. It feeds [models](../design/specs/models.md) NEW-models-21 and [dashboard](../design/specs/dashboard.md) NEW-dashboard-27. Grades: (V) read on the source's own page this session; (S) seen in search results, not opened; (R) this repository's own measurement or decision.*

## 1. What the local apps expose

| App | Where settings live | What a person can set | What we take |
| --- | --- | --- | --- |
| **LM Studio** | Per-model defaults on *My Models* (gear icon), used whenever the model loads, including `lms load`; a load-time change can be saved as the model's default (V: [per-model settings](https://lmstudio.ai/docs/app/advanced/per-model)). Presets bundle a system prompt and inference values (S). | Load: GPU offload, context length, flash attention (V); KV cache quantisation, mmap, seed, threads (S). Inference: temperature, top-p, top-k, min-p, repeat penalty, structured output (S). JIT loading with an idle TTL (V: [TTL and auto-evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict), via SMART_SWAP_RESEARCH). The model picker grades fit as *Full GPU offload possible / Partial / Likely too large* (SMART_SWAP_RESEARCH). | Settings belong to a **model**, applied wherever it loads; the load/inference split; a fit label beside the context control. |
| **Ollama** | The Modelfile's `PARAMETER` lines, baked into a model tag; per request in `options` (S: [Modelfile guides](https://mljourney.com/ollama-parameters-guide-temperature-context-memory-and-gpu-settings/), [DeepWiki](https://deepwiki.com/ollama/ollama/4.1-modelfiles)). | `num_ctx` (small default, the most common silent truncation), `temperature`, `top_k` (40), `top_p`, `min_p` (0.0), `repeat_penalty` (1.1), `repeat_last_n`, `seed`, `num_predict`, `stop`, `num_gpu`, `num_thread` (S). | A default that is wrong for agents (a 2–4K window, repeat penalty 1.1) is why the harness sets every value itself and shows where each came from. |
| **Jan** | Per-model *Model Settings* plus the llama.cpp engine page (S: [model parameters](https://www.jan.ai/docs/desktop/model-parameters), [llama.cpp engine](https://www.jan.ai/docs/desktop/local-engine/llama-cpp)). | `ctx_len`, `ngl` (GPU layers), `cont_batching`, `n_parallel`, `n_batch`, flash attention, KV cache type, and the sampling values (S). Fit is shown as *Fits / May be slow / Won't fit* with no download (SMART_SWAP_RESEARCH). | Engine values in one place, named as the engine names them, with the fit in words. |
| **Msty** | Per-model *Advanced configs* (JSON: `contextConfig`, `samplingConfig`) and per-conversation overrides (S: [advanced configs](https://docs.msty.ai/studio/managing-models/advanced-configs), [local models](https://docs.msty.ai/studio/managing-models/local-models)). | `num_ctx`/max tokens, temperature, top-p, top-k, frequency and presence penalties, threads (S). | Settings can be exported as text and moved between machines. |
| **Open WebUI** | Three levels: an admin's per-model presets in the Workspace (system prompt, tools, knowledge and parameter overrides on top of a base model), a person's own settings, and per-chat controls; `DEFAULT_MODEL_PARAMS` as the server-wide baseline (S: [Models](https://docs.openwebui.com/features/workspace/models/), [chat parameters](https://docs.openwebui.com/features/chat-conversations/chat-features/chat-params/)). A per-chat or per-request value wins over the model's. | Temperature, top-p, top-k, min-p, repeat and presence penalties, seed, max tokens, `num_ctx`, reasoning effort, function calling native or prompt-based (S). | In a team server, the **admin** owns the model's settings; a person's own chat does not change them. |

**What none of them does**, and Sekhemet must: say whether a value was **measured on this machine**, taken **from the model card**, **estimated**, or a **default**; tie a changed value to a re-check of tool calls before the agent uses it; and keep the qualified combination's settings fixed so a result names the settings that produced it (models rule 27a).

## 2. Which parameters matter, per role (agentic coding)

**Sampling.** Model makers publish role-relevant values, and they differ by mode:
- Qwen3-Coder: temperature 0.7, top-p 0.8, top-k 20, repetition penalty 1.05; Qwen3-Coder-Next for agentic tool calling: temperature 1.0, top-p 0.95, top-k 40, min-p 0.01, repetition penalty off (S: [Unsloth's Qwen3-Coder-Next guide](https://unsloth.ai/docs/models/qwen3-coder-next), [LM Studio preset](https://lmstudio.ai/wobondar/qwen3-coder-30b-a3b-recommended)). Qwen3 thinking mode for precise coding: 0.6 / 0.95 / 20 / min-p 0 / presence 0 (S: [Qwen3 report and cards](https://arxiv.org/pdf/2505.09388)). The 3.6 cards differ between the 27B and the 35B-A3B (S: [HF discussion](https://huggingface.co/Qwen/Qwen3.6-27B/discussions/10)).
- gpt-oss: temperature 1.0, top-p 1.0; reasoning effort low / medium / high, with fewer reasoning tokens at lower effort (S: [gpt-oss repository](https://github.com/openai/gpt-oss), [llama.cpp guide #15396](https://github.com/ggml-org/llama.cpp/discussions/15396)).
- `min_p = 0` must be sent explicitly: llama-server's default is 0.05 (R: models rule 3a). Ollama's repeat penalty of 1.1 by default penalises the repeated identifiers code needs (S; R: the Worker runs 1.0 or a presence penalty instead).

**Per role**, from those sources and our measurements:
| Role | What matters most | Why |
| --- | --- | --- |
| Coding (Worker) | the context window (the card's Zone 3 is sized from it, rule 11), KV type (4-bit KV raises tool-name hallucination, rule 10), the tool arm (R4), MTP (speed only, decided by A/B, rule 13), the step budget and working method | tool calls are the only interface; a wrong window silently refuses cards (live-test PM-13, B3's −304 cap) |
| Planning (and Seshat) | temperature split by purpose (code 0.2 / planning 0.7, rule 3a), context, reasoning off for chat latency | Seshat answers a person who waits (rule 20f) |
| Review | reasoning level and its thinking cap (R3c: gpt-oss-20b at medium with a larger cap), temperature 0, KV type, the model's family | a reviewer that runs out of thinking returns a cut-off reply (live-test F25) |
| Research | context and slots (two slots so extractions do not evict the conversation, rule 3a), temperature from the card | long sources, prefix reuse |

**Reasoning.** Effort trades tokens for accuracy; the cap must cover what the template thinks even when asked for none (live-test F25: gpt-oss thought 1,072 tokens on a request for none). So level, cap and the template's floor are three values, and the floor is a fact of the model, not a preference.

**Engine.** Flash attention and KV type change memory and, slightly, numerics; GPU layers, load mode and slot count change speed and memory only. Prefix caching with speculative decoding has corrupted tool calls in vLLM (#47194, via NEW-models-8), so every value that can change what the model emits is an element of the qualified combination.

## 3. Tuning fast on one machine

- **A small hard screening set, paired.** The quick benchmark's screening cards are scored on the same items for every candidate, and two settings are compared with the paired sign test (R: measurement rules 10 and 35; PROMPT_STANDARD 35.4). Interval overlap decides nothing.
- **Successive halving.** Give every candidate setting the same small budget, keep the best 1/η, double the budget, repeat (S: [Hyperband, JMLR 18](https://www.jmlr.org/papers/volume18/16-558/16-558.pdf); [DEHB](https://arxiv.org/pdf/2105.09821)). On one machine the budget unit is a screening card; the cost unit is a model load, so candidates are grouped by weights and context to load each once (R: Smart Swap's C_pair).
- **A warm start from the card.** A budget-matched study found that an LLM advisor's gain came from starting at a good default, not from the model (S: [arXiv 2606.21641](https://arxiv.org/html/2606.21641)): start from the model card's values, which are the *From its makers* (the model card's values; DEC-31 keeps *card* for a board's tile, so the page says *makers*) grade.
- **Resampling** each item twice cuts variance by about a third (R: WEB_RESEARCH_2026-09 §measurement), and one trial at non-zero temperature is not a finding (CLAUDE.md).
- **Adoption** only on a significant paired gain, else *No clear difference* (R: PROMPT_STANDARD 35.4; dashboard §2.16 item 2). This is G3's *Find best settings*; G0–G2 (this workstream) only record, grade, apply and re-verify settings.

## 4. Decisions this digest supports (written into the specs)

1. Settings are per **(model, role)** in the registry, applied by the roster wherever that model runs that role (LM Studio's per-model defaults; Open WebUI's per-model presets) — NEW-models-21.
2. Every value carries one of four grades, *Measured*, *From its makers*, *Estimated*, *Default*, or says who set it; *Reset* returns it to its graded value.
3. A change to a value that can change what the model emits marks the role **Needs verifying** with **Verify now** (rule 27a's check), and the agent does not use the role until it passes (MD-N8-1).
4. Hints never block, except the standing refusals: 4-bit KV (rule 10), the Review model's family (rule 3), a value that does not fit this machine (rule 4b), and Ollama cloud models (rule 14c).
5. In the Team setup the settings are the Admin's (Open WebUI's admin presets); export and import move one role's settings as a small JSON file (Msty).
6. Three layers on the page: the simple setup card, *Customize* per role with five tabs, and every value graded — NEW-dashboard-27.
