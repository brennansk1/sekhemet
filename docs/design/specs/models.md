---
spec: models
status: partial
audiences: [developer]
code:
  - packages/models/src/llama_server.ts
  - packages/models/src/http_adapter.ts
  - packages/models/src/registry.ts
  - packages/models/src/roster.ts
  - packages/models/src/router.ts
  - packages/models/src/calibration.ts
  - packages/models/src/qualification.ts
  - packages/models/src/bakeoff.ts
  - packages/models/src/memory.ts
  - packages/models/src/watchdog.ts
  - packages/models/src/kv_policy.ts
  - packages/models/src/models_dir.ts
  - packages/models/src/schedule.ts
  - packages/models/src/telemetry.ts
  - packages/eval/src/report.ts
  - packages/kernel/src/card_class.ts
  - apps/harness/src/doctor.ts
  - apps/harness/src/calibrate_cmd.ts
tests:
  - packages/models/tests/llama_server.spec.ts
  - packages/models/tests/llama_server_lifetime.spec.ts
  - packages/models/tests/launch_profiles.spec.ts
  - packages/models/tests/adapter_contract.spec.ts
  - packages/models/tests/registry_calibration.spec.ts
  - packages/models/tests/hardware_tier.spec.ts
  - packages/models/tests/qualification_schedule.spec.ts
  - packages/models/tests/memory.spec.ts
  - packages/models/tests/watchdog.spec.ts
  - packages/models/tests/models_dir.spec.ts
  - packages/models/tests/router.spec.ts
  - packages/models/tests/slot_cache.spec.ts
  - packages/models/tests/residency.spec.ts
  - packages/models/tests/router_swap.spec.ts
  - packages/models/tests/multi_turn.spec.ts
  - apps/harness/tests/doctor_weights.spec.ts
  - apps/harness/tests/calibrate_cmd.spec.ts
changes: [M4, M7, M11, NEW-models-1, NEW-models-2, NEW-models-3, NEW-models-4, NEW-models-5, NEW-models-6, NEW-models-7, NEW-models-8, NEW-models-9, NEW-models-10, NEW-models-11, NEW-models-12]
---

# Models: hardware, the registry and inference

## 1. Purpose

This subsystem runs the local models: it measures the machine, obtains and verifies the weights, launches and supervises the inference server, keeps the machine out of swap, and records which model, on which settings, is qualified for which role. It serves the product's promise that **v1 inference is 100% local**, and the spine rule that a result means something only with the settings that produced it: a number without its settings is not admissible.

## 2. Behaviour

### The v1 models

1. **In v1 every model runs on the user's machine** ([DEC-03](../DECISIONS.md#dec-03)). Cloud models are a planned post-v1 option per role, never a silent fallback.
2. **The Worker is Cyber-Tiel-Coder-35B-A3B MTP at IQ3_XXS** ([DEC-04](../DECISIONS.md#dec-04)): 16,384-token context, 4,096-token answer cap, sampling from its model card (temperature 0.6, top_p 0.95, top_k 20, min_p 0), served by llama-server on port 8098 with `--jinja`, flash attention and KV at `q8_0`. It is uncensored (abliterated); the model's own card demands OS-level sandboxing, so the sandbox and permission layer is the only defence against destructive actions and every security item is v1-blocking ([security.md](security.md)).
3. **The managed defaults for the other roles, and every default's family.** The Reviewer must come from a different model family than the Worker ([review-git.md](review-git.md) §2.3.7), so the registry records a `family` for each default (`registry.ts:44`, read by nothing today) and the roster refuses a Reviewer of the Worker's family:

   | Role | Default | Family | State |
   | --- | --- | --- | --- |
   | Worker | Cyber-Tiel-Coder-35B-A3B MTP (IQ3_XXS) | **Qwen** — an abliterated Ornith-1.5-35B-A3B, itself a fine-tune of the Qwen3.5/3.6-35B-A3B architecture ([MODEL_CANDIDATES.md](../../research/MODEL_CANDIDATES.md)) | managed (`MANAGED_MODEL_FILES.worker`) |
   | Planner (and Seshat) | Dirk-Qwen3.8-27B (GSQ-RCO IQ3_S, 12.1 GB) | **Qwen** (Qwen3.8-27B) | managed |
   | Researcher | Apodex-1.1-mini (IQ3_M, ~16 GB) | not recorded in the research set; NEW-models-4 records it from the model card when the default is registered | managed; a smaller Researcher is NEW-models-11 |
   | Reviewer | **Gemma-4-26B-A4B-it (UD-IQ3_S, 11.3 GB)** — the owner's decided default ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)): the research set's non-Qwen candidate with the most headroom on 24 GB and a different tool format. Muse-Glimmer-30B (UD-IQ3_XXS, 13.1 GB, a tight fit) stays a candidate a person may assign from the Configuration page, not an automatic fallback | **Gemma** | decided, not yet obtained or qualified: no managed file, and `--reviewer` resolves to the Qwen3.8 profile today (`roster.ts:72-78`, `:200-216`), the Worker's family |

   Roles never co-reside below 32 GB (rule 22), so the Reviewer swaps in like the Planner. The Reviewer default becomes a shipped default like any model — an acquisition path and hash (rule 4) and a bake-off on the reference host (rule 30a); a person's first run then assigns it by qualification alone. **If Gemma-4-26B-A4B does not qualify for the Reviewer on the 24 GB reference host** (and no other model outside the Worker's family a person assigns does), that is recorded in the registry, v1 ships with the Reviewer unfilled on that host and says so ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)) (rule 23: the diff reaches the person unreviewed and the card says so), and P8's acceptance is measured on a larger host — the plan's risk "No model of a different family fits the Reviewer on 24 GB" ([MODERNIZATION_PLAN.md](../../reference/MODERNIZATION_PLAN.md#risks)). Shipped source names model **files**, never locations.
3a. **Per-model sampling and launch values live in the registry and the managed profiles, not in prose.** The values the design fixed, so they are not lost: Dirk-Qwen3.8-27B uses a **code** profile (temperature 0.2, top_p 0.9, top_k 20, min_p 0, presence_penalty 1.5) and a **planning** profile (temperature 0.7, top_p 0.8, the rest as for code), with reasoning off; `min_p = 0` is mandatory, because it overrides llama-server's default of 0.05 — a server-default override, not a preference (`QWEN38_CODE_SAMPLING`, `QWEN38_PLANNING_SAMPLING`, `llama_server.ts:592-605`). Apodex-1.1-mini runs with temperature 1.0, top_p 0.95, top_k 20, min_p 0 on two parallel slots — slot 0 for the research conversation, slot 1 for one-off extractions, which otherwise evict the conversation's prefix (live hit rate 55–68% on one slot) (`llama_server.ts:580-590`). Every managed server is launched by `launchArgs()` with `--host 127.0.0.1`, `-ngl` (99 by default), `-fa on`, `--jinja`, `-c`, `-ctk`/`-ctv q8_0` and `-np` (the slot count), plus, per profile, `-t`, the cache flags of [context.md](context.md), `--metrics` (the server-side telemetry the harness reads), `--no-webui`, `--reasoning` and `--spec-type draft-mtp` (`llama_server.ts:273-313`). The earlier Chronicle profile (`-t 2 -np 2 -c 49152 --ctx-checkpoints 6 --cache-ram 2048 --metrics --no-webui --reasoning off` on 127.0.0.1:8099) is superseded by the DEC-04 Worker on port 8098.

### Getting the weights

4. **Named defaults are obtainable, never downloaded on the harness's own initiative.** Each default model has an acquisition source recorded in the component register and a SHA-256. The harness never downloads weights by itself ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O2; [security.md](security.md) item 47). A person may download a registry model in two ways that are **one implementation**: **Download…** on the Configuration page (rule 4c, NEW-models-12) and its terminal form, `sekhemet models fetch <model>` (NEW-models-7). Both are a person's explicit choice, never automatic; both verify the published SHA-256 before the file is used and delete a file whose hash differs; both are harness-side requests under the one network policy, logged on the ledger with their source and **refused in `offline` mode** with the setting named ([security.md](security.md) items 29 and 47). A default with no acquisition path is not a default.

### Finding, fitting and recommending models (NEW-models-12)

*The Configuration page ([dashboard.md](dashboard.md) §2.16, NEW-dashboard-6) is where a person points the harness at their models and chooses one per role ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O2, O3). This spec owns what the page shows about models; [measurement.md](measurement.md) NEW-measurement-5 owns the benchmark it runs.*

4a. **Scan the folders a person names.** The model folders are those a person adds on the Configuration page (kept in the user configuration), plus `--models-dir` and `SEKHEMET_MODELS_DIR` (rule 6). The page **suggests** the likely folders that exist on this machine and are not yet configured — `SEKHEMET_MODELS_DIR`; Ollama's model store; LM Studio's models folder; the Hugging Face hub cache; llama.cpp's cache — each added only when a person chooses it. Each folder is only read, never written, and nothing outside the configured folders is read. Scanning reads metadata only — headers and sizes — and **never loads a model**. A scan walks each folder and **identifies weights by their headers, never by loading them**: a GGUF file's header gives its architecture, name, quantisation (file type), context length, parameter count and, where present, its base model; a split GGUF (`-00001-of-0000N`) is one model; a vision projector (`mmproj`) is a companion of its model, not a model; a safetensors or MLX directory (a `config.json` beside its weight files) is listed with its format and, where no adapter serves that format on this host, the words "no engine here serves this format" (rule 14). A file that cannot be parsed is listed as unreadable with the reason. The SHA-256 is computed in the background after the scan, never blocking it, and a model is *Verified* only when it matches the registry's published hash.
4b. **Fit to this machine.** For each found model, and for each role, the scan computes its footprint — weights plus KV at the role's context and KV type (rule 10) plus the engine's buffers — against usable memory (rule 7), and labels it **fits**, **fits, swaps with the other roles** (it fits alone but not beside the resident roles, rule 22; the swap's time is shown from measured load times), or **needs N GB** (the shortfall, with the reason in words). A model that does not fit is listed, never hidden, and never loaded or benchmarked.
4c. **Recommend one model per role, with its reason.** For each role the recommendation is the best candidate that fits, chosen from (1) **quick-benchmark scores** for that role on this host ([measurement.md](measurement.md) NEW-measurement-5), when they exist for the current cache key, and otherwise (2) the model's **qualification record** (rule 27a) and **the registry** (managed defaults, family, tool arm, measured throughput); the Reviewer's candidates exclude the Worker's family and any model whose family is unknown (rule 3). The reason is one plain sentence naming its evidence (*"Gemma-4-26B-A4B: a different family from the Worker, which the Reviewer needs; it fits at 14 GB; no quick score yet"*). When the two best candidates' quick-benchmark intervals overlap, the recommendation says they are indistinguishable on the quick benchmark and prefers the smaller footprint, then the registry default. "Up to the strongest this machine can run": a registry model not present in any folder is recommended when it fits and beats every present candidate on its evidence, with **Download…** offered (rule 4); the recommendation never assigns, loads or downloads anything by itself.
4d. **Assigning is a person's act.** A person assigns a found model to a role, for their own use, on the strength of the quick benchmark or with no benchmark at all — it is their machine (rule 30a). The assignment needs only the model's qualification for that role on this host (rule 27a), is recorded on the ledger with the principal, and keeps the previous assignment restorable (MD-N10-2).
5. **`doctor` verifies the weights** named by the resolved profiles — existence, readability and hash — before anything else reports green.
6. **Model folders are the only location setting:** the folders named on the Configuration page (rule 4a), `--models-dir` and `SEKHEMET_MODELS_DIR`. No other per-model environment variable is a configuration surface, and no path in shipped source refers to an absolute location, an external volume or an author's directory.

### Calibration and tiers

7. On first run, and on a hardware change or on demand, `sekhemet calibrate` measures the usable memory budget (the Metal wired limit if set, else the driver default: two thirds of memory up to 36 GB, three quarters above; VRAM plus system RAM where expert offload applies), memory bandwidth, and for each candidate model prefill and decode throughput at several context lengths; it sweeps prefill batch size and expert offload and keeps the setting one step back from the memory cliff. The result is the machine profile, keyed by a hardware fingerprint.
8. The tier decides co-residency and parallelism, never a longer prompt:

   | Tier | Budget | Planner | Worker | Co-loaded | Working context | Parallel cards |
   | --- | --- | --- | --- | --- | --- | --- |
   | S | 16 GB | Same model, planning mode | Small MoE (~3B active) | n/a | 12–16k | 1 |
   | M | 24–32 GB | Dense, swapped on schedule | ~30B-A3B MoE | No | 16–24k | 1 |
   | L | 48–64 GB | Dense or mid MoE | ~30B MoE | Yes | 24–32k | 1–2 |
   | XL | 96–128 GB | Large MoE | ~30B MoE | Yes, plus verifier and vision | 32–48k | 2–4 |

   The Budget column is the machine's **installed** memory; usable memory decides what fits within the tier. Model names are absent on purpose: the registry fills them from measurement. Calibration never lowers the Worker's window below the size its measured prompts need.
9. **Throughput floors:**

   | Mode | Prefill | Decode | Seconds per step |
   | --- | --- | --- | --- |
   | Overnight batch | 40 tok/s | 10 tok/s | ~70 |
   | Interactive | 100 tok/s | 20 tok/s | ~30 |
   | Recommended | 300 tok/s | 40 tok/s | ~12 |

   Below the overnight floor the harness refuses to run cards and says why. Below 16 GB usable is unsupported. Vendor and model-card scores are upper bounds, never inputs: a model's fitness here is what this machine measures (the same 35B-A3B family scores 73.4 on SWE-bench Verified by its card and 24.7% on the decontaminated SWE-rebench window).

### Inference settings

10. KV cache at 8 bits (`q8_0` or FP8); 4-bit KV is refused for a tool-calling model, and anything below 8 bits needs a qualification run with it. Flash attention on; prefill batch size swept per machine; expert offload only when the model does not fit, tuned to just below spill. Prompt-cache settings are [context.md](context.md)'s (`--cache-ram`, `--ctx-checkpoints`, `--checkpoint-min-step`, no `--cache-reuse`).
10a. **Batch size is a property of the host.** "One request at a time" holds only on the single-user profile. On a multi-user host the number of concurrent requests an engine serves correctly — its parallel slots or batch capacity — is read from that engine's qualification (rule 27a), never assumed, and cache and memory budgets are set per slot. How many cards run at once (one slot lease per qualified slot), and how model time is shared between people (fair share per person, interactive replies first, aging), is [runtime.md](runtime.md)'s NEW-runtime-6; this spec supplies the qualified capacity.
11. Sampling parameters, context window and reasoning support are stored **per model in the registry** and read from it; factories only supply defaults for an empty registry. Every other component that sizes work by a model's window reads it from the registry entry of the **resolved** model, never from its own constant: in particular INVEST's *Small* is sized to the **resolved** Worker, not to the planner's 32,768 default (`planner/src/constants.ts:60`), which sized cards for a window the Worker does not have: it is one number, **the card's Zone 3 content fits Zone 3's cap at the resolved Worker's prompt budget — 3,792 tokens on the reference Worker** (16,384-token window) — measured once by the context allocator at the `ready` entry condition ([DEC-27](../DECISIONS.md#dec-27--context-budgets-are-fixed-in-tokens-at-the-reference-window); [context.md](context.md) rule 10, CX-N2-2; [kernel.md](kernel.md) rule 27; [planner-pm.md](planner-pm.md) §2.4). The earlier "25% of the window, 4,096 tokens of context pack" was a second number for the same check and is withdrawn (confirmation review N5).
12. Chat templates are pinned per model build by SHA-256; a template change invalidates that model's qualification.
13. **Speculative decoding is off until measured** on this host, per thinking policy — native MTP heads and a separate draft model (`-md`) alike. The measurement is an A/B on the same GGUF and the same server build, speculation on against off, replaying real Worker step prompts, reporting prefill seconds, decode seconds and total seconds per step separately, the draft acceptance rate and tokens per verify step, and the Metal working set. MTP uses two draft tokens (`--spec-draft-n-max 2`). It is enabled only where it lowers seconds per step **and** the qualification's tool-call checks still pass with it on, with prefix caching on as it runs in production — speculation and prefix caching are qualified together, never separately, because the combination has corrupted tool calls on another engine (vLLM issue #47194: prefix caching with MTP-3 on a Qwen3.6 hybrid left 2 of 10 tool calls correct, 0 of 10 needle recalls and 0 of 5 multi-turn tool conversations, while the path without MTP was correct). The decision is recorded in the registry with the engine, the host fingerprint and the thinking policy it was measured under. MTP speeds decode only and slows prefill, and agent steps are mostly prefill, so decode speed-up alone never justifies it.
14. **Engines are adapters, qualified per combination.** Every engine is reached through one OpenAI-compatible adapter. llama.cpp's server over HTTP is the baseline everywhere and the single-user default; Ollama is supported as a client; on a multi-user NVIDIA server **vLLM is the approved optional multi-user engine** ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O8: a separate process over its OpenAI-compatible API, Apache-2.0; llama.cpp stays the default) and the throughput path — SGLang stays *proposed* — because on a team server the engine choice is a throughput choice and on a laptop a memory choice. MLX exists only as an engine label (`bakeoff.ts:17`) with no adapter; an MLX path is Later. Choice is by measurement per machine, weighting cross-step cache retention above raw decode speed. No engine-specific assumption (a single slot, a llama.cpp flag) is allowed outside that engine's adapter.
14a. **Token streaming.** A request with a token callback streams the reply (`stream: true`, with usage in the final chunk for OpenAI-compatible servers) and hands each delta to the caller as it is decoded (`http_adapter.ts:711-725`, `:872-933`, `:956-964`). The runner writes the Worker's deltas to the card's live file, buffered and flushed every 250 ms, restarting the file at each new generation, which the dashboard's Steps view follows (`execute.ts:484-486`, `:683-700`; the stream route is [runtime.md](runtime.md)'s).
14b. **Every adapter answers a health check** (`healthCheck()`, `http_adapter.ts:747`): for an OpenAI-compatible server `/health` answering ok, distinguishing a server that is loading from one that is down, so a healthy machine with a model still loading is never reported as a dead model.
15. **Server identity.** Before adopting a server already listening on a managed port, the adapter reads its `/props` and refuses it unless the loaded model path (and, for the managed Worker, the context size and MTP state) matches the profile. The evidence records the running server's reported settings and build, never the adapter's intended ones.
16. Per step, the adapter records prompt, cached, evaluated, thinking and answer tokens, `finish_reason`, and the draft statistics when speculative decoding is on.
17. The Worker server is started once and every card attaches to it; the harness never unloads a model another card is about to use. A model loaded from a slow external drive takes minutes, so load time is reported separately from card time.

### Memory safety

18. Memory pressure is read from the OS: the kernel pressure level and swap on macOS, PSI on Linux. Before each step the harness checks headroom and refuses the step when swap in use exceeds 6 GB or has grown more than 2 GB since the card started; the card then stops with `memory_pressure`.
19. **One watchdog, one set of thresholds** — this spec owns them; [runtime.md](runtime.md) and [security.md](security.md) link here. It polls every 2 s on every path that runs cards (`run`, `queue`, the daemon) and escalates through levels, each adding actions:

    | Level | Raised by | Actions (cumulative) |
    | --- | --- | --- |
    | **elevated** | kernel warning, or swap grown 0.5 GB since the run started, or used memory ≥ 0.85 | suspend speculative decoding at the next launch (falling back to plain decoding to reclaim KV headroom), stop new worktrees, shorten keep-alive (to 5 minutes), shed masked-observation caches |
    | **high** | kernel warning for 3 consecutive samples, or swap grown 1 GB, or used memory ≥ 0.90 | also throttle parallel cards to one, trim KV and prompt caches (erase the server's slots) and language-server symbol caches, and force the masking of older observations at the next step ([context.md](context.md)) |
    | **critical** | kernel critical, or swap grown 2 GB, or swap in use ≥ 6 GB, or used memory ≥ 0.94 | also pause: no new steps until pressure falls, state persisted to the ledger first (keep-alive 60 s — evicting mid-card forces a full reload) |
    | **emergency** | kernel critical for 3 consecutive samples, or swap grown 3 GB | also unload the models |

    Swap growth is measured from the run's own start, so stale swap from before the run is not its doing. It escalates on the first sample that warrants it and de-escalates only after consecutive calmer samples, so it does not flap. Every action a level lists is either acted on by the queue and the runner or removed from the list; today `stopNewWorktrees` and `shortenKeepAlive` are declared and never acted on, and the 0.90 stage's parallel-card, language-server and forced-masking actions do not exist (`watchdog.ts:43-54`; `memory.ts:20-56` classifies 0.85, 0.90 and 0.94 separately from the levels) (NEW-models-2).

### Scheduling

20. The user declares the hours the machine is theirs, `[machine] reserved_hours`; the machine is also **reserved** while a person has pressed **reserve now** on the dashboard or run it from the CLI, until they release it ([runtime.md](runtime.md), [surface.md](surface.md)). The **overnight window** is the complement of `reserved_hours`, optionally narrowed by `[machine] overnight_hours`, and never includes a reserve-now period. In the overnight window the harness works the backlog, and while it is idle outside them it keeps the next card's model loaded and its prompt cache warm. Model swaps are batched by project to preserve caches, and planning runs in scheduled blocks on tiers where the Planner and Worker cannot be co-loaded. The daemon and `overnight` apply this ([runtime.md](runtime.md)).
20b. **The overnight benchmark is scheduled here.** The overnight tier of the benchmark ([measurement.md](measurement.md) NEW-measurement-5, rule 37) runs only in the overnight window, and never while the machine is reserved — inside `reserved_hours` (not even when the person is idle, which `overnight`'s own idle rule would allow) or during a reserve-now — nor while a card is running: it takes the runner lease ([runtime.md](runtime.md)) only when no card holds it, and while it holds the lease no card starts. By default the night's backlog goes first and the benchmark takes the rest of the window; the person may put the benchmark first when scheduling it. It stops cleanly at the window's end — at the current card's end, or at the window's end if that comes first, keeping every completed card and run — and resumes the next night from the card where it stopped, in the same interleaved order; if the harness build, the context version or a model's qualification changed in between, the interrupted run is discarded and restarted, because a run mixing two builds is not comparable ([measurement.md](measurement.md) rule 5). The residency scheduler (rule 20a) loads each combination's models in the order that minimises swaps.
20a. **One scheduler owns model residency.** Every caller that needs a model — the queue, the PM's chat, the dashboard, the Researcher, the Reviewer, a retry — asks one scheduler, through the runner lease ([runtime.md](runtime.md)), and never loads a model itself:
    - **Adapters are keyed by weights, not by role.** Roles served by the same weights share one adapter, loaded once with the largest context any of them needs; a context-size change never reloads the same weights behind the scheduler's back (Ollama reloads on every `num_ctx` change, invisibly to the swap count).
    - **Work waits in per-role queues** (plans, questions, reviews, research, chat) and a queue drains whenever its model is resident. Swaps are ordered by the waiting queues and the residency plan, not by the order questions arrive: on the 24 GB reference host the plan is a Worker pass, then the Researcher for every unexplained struggle (one load), then the Planner and Seshat for plans, answers and reflection after the retries, then the Worker's retries — four loads where asking per question cost ten, at 40–120 s each. The Reviewer's place in the order is [review-git.md](review-git.md)'s.
    - **Two large models are never resident at once** unless the tier co-loads them (rule 8): before any load the scheduler checks the footprint of what is resident plus what it would load against usable memory, and refuses (queueing the work) when it does not fit or when a footprint is unknown. A question asked during an escalated retry waits for its model's step rather than loading the Worker behind the running session (~13.7 GB + ~12 GB on a 24 GB host is the out-of-memory path).
    - On a machine where everything fits (the 128 GB node), every model is resident and every queue drains as work arrives, with no code path changed.
    - Fair share between people and projects, interactive-first ordering, aging and per-slot leases are [runtime.md](runtime.md)'s (NEW-runtime-6); the scheduler here supplies residency, the per-role queues and the qualified capacity (rule 10a).

### Roles and the registry

21. The harness consults a model in four roles: **Worker** (executes cards), **Planner** (plans, decomposes and answers questions about the board; the PM persona Seshat speaks with the Planner's weights), **Reviewer** (reads a passing diff against its specification, from a different model family than the Worker), and **Researcher** (answers questions with cited sources). `vision` is a capability a model may hold, not a role. There is one role enumeration in code.
22. Roles are routing decisions, not agents or personas; the harness never simulates a conversation between them ([DEC-05](../DECISIONS.md#dec-05): agents never role-play ceremonies with each other; reports for people come from the one PM persona). One model may hold several roles, and on small machines usually does. Roles never co-reside below 32 GB.
23. A role whose model is absent degrades to a named fallback, never a failure: no Reviewer means the diff reaches the person unreviewed and the card says so; no Researcher means questions are answered from the repository alone.
24. A fifth role is added only when an existing one cannot be qualified for the work.
25. **The registry** is the harness's memory of what works on this machine: per model its identity, family, quant, size, context window, engine, template checksum, sampling, reasoning support, measured tool arm (with per-arm measurements), script capability, throughput per context bucket, qualification record and history, speculative decision and roles. It is keyed by host fingerprint, written atomically with a merge that never drops another writer's entry, and never written by tests.
26. **One construction path.** Every command that needs a model (`run`, `queue`, `bake-off`, `plan`, the PM) obtains it from the roster, which applies the registry, the tier cap and the engine decision; there is one `ModelProfile` record per model build.

### Qualification

27. A model is qualified, not chosen by reputation. The qualification suite uses the harness's own tool schemas and deterministic scoring (no model judge) and measures schema validity, tool selection, arguments, multi-step recovery after an injected error, and refusal of an out-of-scope request. A model qualifies as Worker at a set pass rate on this internal suite — a bar not comparable to public leaderboards, set with multi-turn scores below single-turn in mind. An unqualified or invalidated model is not used as Worker without a recorded override.
27a. **Qualification is per combination.** What is qualified is the tuple **(engine, model build, host fingerprint, settings)** — settings meaning the context size, KV type, speculative decoding, prefix caching, parallel slots and chat template. A model assigned to a role on a host is refused until that exact combination has passed, and the suite includes, besides speed, **tool-call validity, a multi-step tool conversation and a recall check** (a fact stated once early in a long context, asked for later), because tool calls are the Worker's only interface and a speed-only qualification would pass a configuration that corrupts them. A change to any element of the tuple — a new engine build, a new template, MTP switched on, a new context version ([context.md](context.md) rule 27) — invalidates the qualification.
28. **Tool arm.** Each model's tool interface is measured across three arms — A (`arm_a_flat`: native, flat tool calls, optionally grammar-constrained per model), B (`arm_b_json`: calls written as JSON in the reply, read by the tolerant parser) and C (`arm_c_sketch`: the tool chosen in natural language, with constraints only on the terminal payload) — and the registry pins the winner once it has at least `MIN_ARM_TRIALS` trials and beats the others by the register's pre-set bar (5 points of tool-call validity, R4). Grammar constraints help on terminal payloads (paths, identifiers, flags) and hurt on reasoning and high-level selection (the "format tax", 15–30% on small models), so hard schema constraints are never a default ([DEC-22](../DECISIONS.md#dec-22--rejected-techniques)); a model gets them only when its measurement says so. Until a model is measured, arm A without constraints is used and the evidence says the arm was not measured.
29. **Quantisation is measured, not assumed.** No public source measures IQ3 against Q4 on agentic coding, and INT4 has raised tool-name hallucination up to 2.5× at unchanged final scores; so every run records tool-call format errors and tool-name errors per step, not only pass/fail.

### Per-repo bake-off

30. `sekhemet bake-off` runs candidate models under the real harness on tasks from the repository's own history: closed issues with their fixing commits become fail-to-pass tasks (a task is kept only if reverting the fix makes its test fail), and recent commits become reconstruction tasks. Every result carries its full settings (model, quant, tool arm, step budget, working context, engine, date), taken from the child run's evidence, not reconstructed afterwards. The results are written as a matrix by hardware tier with full settings, `MODEL_MATRIX.md` (`packages/eval/src/report.ts:133-200`), which the dashboard's Registry shows.
30a. **Who changes a role's model, and on what evidence** (the lead's ruling on the owner's product pass, 2026-09-24):
    - **A person, for their own use:** any **qualified** model (rule 27a) may be assigned to a role on the strength of the quick benchmark ([measurement.md](measurement.md) NEW-measurement-5) or with no benchmark at all. It is their machine. Every card's evidence names the model it ran with (M4), so no result is unattributable.
    - **The recorded baseline and the shipped defaults:** changing the recorded **baseline `RunProfile`** ([measurement.md](measurement.md) rule 9a) or a **shipped default** for a role requires a recorded **bake-off** on that host — the frozen suite for the Worker, the role's full evaluation set for the Planner, the Reviewer and the Researcher, paired under [measurement.md](measurement.md)'s statistics; the overnight benchmark tier runs exactly this. Published numbers are upper bounds, never inputs; model churn in the baseline that nobody measured would silently change every comparison against it.
    - **The shipped defaults need no bake-off at first run**: they are assigned by qualification alone (MD-N4-4).
    - In every case the previous assignment stays restorable with one command (`sekhemet models restore <role>`).

### Card class and the competence model

31. `cardClass = "<kind>:<ext>"`. `kind` is the card's stored kind, one of seven, closed: `spike`, `interface`, `implement`, `data`, `rule`, `review`, `research` ([kernel.md](kernel.md) rule 6, [DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)) — not the SPIDR axis a story was split on (`split`) and not what the card does to existing code (`change`). `ext` is the primary file extension of the declared scope, or `none`. It is knowable before the card runs and coarse enough to fill; tool sets key on `kind` alone, and budgets, routes and exemplars on the whole class. It is defined once, in the kernel; today `cardKind()` derives the kind from the title on every read (`card_class.ts:93-102`), which NEW-kernel-9 replaces with the stored field.
32. Every card outcome writes a competence row: class, files touched, difficulty, model, arm, step budget and steps used, stop reason, gate failures, tokens and wall-clock — and, as three separate fields, the routing **prediction**, the **decision** taken and the **outcome**, so a row can say whether an escalation or a budget was necessary. An attempt a person built (`builtBy.kind = person`, [kernel.md](kernel.md) rule 22) writes no competence row and never counts in pass rate by model, so routing never learns from people's work. Budgets and routes change from these rows only through the inlet rules in [measurement.md](measurement.md). Public outcome data may seed only the **task-difficulty** axis as a prior; the model × arm axis comes only from this machine's ledger, because public data has no tool-arm dimension and its pass rates are dominated by the scaffold that produced them (16.7% versus 47.9% on the same instances under two harnesses). If routing ever needs more than a mean with a Wilson interval, a logistic regression over the row's columns is the tool, not a learned tabular model.

## 3. Contract

| Item | Source |
| --- | --- |
| Managed profiles, `MANAGED_MODEL_FILES`, `createCyberTielWorker`, `launchArgs`, `cacheProfileForHost`, `mtpEnabled` | `packages/models/src/llama_server.ts` |
| HTTP adapter, usage parsing `usageFromLlamaServer`, `REASONING_BUDGET_TOKENS` (high 2,048), token streaming (`onToken`), `healthCheck()` | `packages/models/src/http_adapter.ts:711-964`, `:747` |
| Live token file `liveTokenWriter` | `apps/harness/src/execute.ts:683` |
| Sampling constants `QWEN38_CODE_SAMPLING`, `QWEN38_PLANNING_SAMPLING`; launch arguments `buildLaunchArgs` | `packages/models/src/llama_server.ts:273-313`, `:592-605` |
| Watchdog thresholds `DEFAULT_WATCHDOG_THRESHOLDS` (swap growth 0.5 / 1 / 2 / 3 GB; 6 GB swap; 3 sustained samples); used-memory classes `classifyMemoryPressure` (0.85, 0.90, 0.94) | `packages/models/src/watchdog.ts:69-93`; `memory.ts:20-70` |
| Cache telemetry and alert `PrefixCacheMonitor`, `CACHE_ALERT_THRESHOLD` | `packages/models/src/telemetry.ts` |
| Bake-off matrix `MODEL_MATRIX.md` | `packages/eval/src/report.ts:133-200` |
| Qualification key (new): `(engine, modelBuild, hostFingerprint, settings)`; residency scheduler (new) | `packages/models/src/registry.ts`, `router.ts` |
| Model scan, fit and recommendation (new, NEW-models-12): `scanModelFolders`, `readGgufHeader`, `fitFor(model, role, host)`, `recommendRoles`; the page's shapes `ModelFolder`, `FoundModel`, `RoleAssignment` | `packages/models/src/models_dir.ts` (extended), `registry.ts`; [PM_CONTRACT §3](../PM_CONTRACT.md#3-endpoints) *Configuration* |
| Registry `ModelEntry`, `QualificationRecord`, `SpeculativeDecision`, `RegistryRole` | `packages/models/src/registry.ts` |
| Roles `ModelRole`, router | `packages/models/src/router.ts` |
| Roster (construction path) | `packages/models/src/roster.ts` |
| Tiers, usable memory, `THROUGHPUT_FLOORS`, `assertThroughputFloor`, `calibrateSpeculative` | `packages/models/src/calibration.ts` |
| KV policy `assertKvPolicy` | `packages/models/src/kv_policy.ts` |
| Weights `resolveModelsDir`, `probeModelWeights` | `packages/models/src/models_dir.ts` |
| Headroom (6 GB swap, 2 GB growth) | `packages/models/src/memory.ts:158-190` |
| Watchdog levels and actions, 2 s poll | `packages/models/src/watchdog.ts:23-58` |
| Qualification suite | `packages/models/src/qualification.ts` |
| Bake-off | `packages/models/src/bakeoff.ts` |
| Card class `cardKind`, `cardClass` | `packages/kernel/src/card_class.ts` |
| Competence rows `CompetenceEntry` | `packages/kernel/src/types.ts:520` |
| CLI: `sekhemet calibrate`, `doctor`, `bake-off`, `qualify`, `models fetch <model>` (new, explicit download), `models restore <role>` (new), `--models-dir`; env `SEKHEMET_MODELS_DIR`, `SEKHEMET_LLAMA_SERVER`, `SEKHEMET_SLOT_CACHE` | `apps/harness/src/index.ts`, `wave2.ts` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Worker profile (D1) and managed server on 8098 | built | `llama_server.ts:518-535`; `launch_profiles.spec.ts` | — |
| Weights resolved by `--models-dir`; doctor checks existence and readability | built | `models_dir.ts`; `doctor.ts:197`; `doctor_weights.spec.ts` | — |
| Weights fetchable and hash-verified | not-built | no acquisition path; hash kept only in the air-gap manifest (`models_dir.ts:62`) | NEW-models-7 |
| Model folders scanned; weights identified by header; fit per role; recommendation per role with its reason; explicit download from the page | not-built | one folder resolved (`resolveModelsDir`, `models_dir.ts:25`), probed only for the managed file names (`probeModelWeights`); no scan, header reader, fit or recommendation | NEW-models-12 |
| Overnight benchmark scheduled in the overnight window, stopping and resuming cleanly | not-built | `overnight` runs queue rounds only ([runtime.md](runtime.md) rule 17) | NEW-models-3 (with [measurement.md](measurement.md) NEW-measurement-5) |
| Calibration command and machine profile | partial | `sekhemet calibrate` exists; never run on the reference host (no `~/.sekhemet/machine.json`) | NEW-models-1 |
| Tier of the reference host | not-built | usable ⅔ × 24 GB = 16 GB puts the 24 GB host in tier S (`calibration.ts:296`, `:187`); `roster.tuned()` would cut the window to 12,288 (`roster.ts:150-172`) | NEW-models-1 |
| Throughput floors refuse cards | partial | the queue's prelude refuses (`wave2.ts:322` → `assertModelRunnable` → `assertThroughputFloor`, `calibration.ts:659-666`); `run` has no check | NEW-models-2 |
| KV policy (no 4-bit for tool calling) | built | `kv_policy.ts`; `llama_server.ts:255` | — |
| Template pin and invalidation | built | `registry.ts`; `registry_calibration.spec.ts` | — |
| Sampling, window, reasoning read from the registry | not-built | hard-coded in five factories (`roster.ts:45-78`; `llama_server.ts:534`, `589`, `677`; `http_adapter.ts:1178`) | NEW-models-4 |
| MTP off until measured; two draft tokens; decision per host and policy | not-built | Worker ships `mtp: true` (`llama_server.ts:532`); `calibrateSpeculative` never run | M7, M11 |
| Refuse a foreign server (`/props`) | not-built | adopts anything answering `/health` (`llama_server.ts:374-383`) | M4 |
| Per-step provenance: server settings/build, `finish_reason`, draft stats; real harness commit | not-built | `usageFromLlamaServer` captures none of these (`http_adapter.ts:338`); `harnessCommit(repoRoot)` is the fixture's HEAD (`card_runner.ts:1549`) | M4 |
| Headroom check (6 GB / 2 GB) | built | `memory.ts:158-190`; `memory.spec.ts` | — |
| Watchdog levels and actions | partial | `watchdog.ts`; wired into `queue` only (`index.ts:1298`); `stopNewWorktrees`, `shortenKeepAlive` never acted on | NEW-models-2 |
| The 0.90 stage (parallel cards to one, language-server caches, forced masking) | not-built | no such actions in `ACTIONS_AT` (`watchdog.ts:41-54`) | NEW-models-2 |
| Token streaming to the live Steps view | built | `http_adapter.ts:711-964`; `execute.ts:484-486`, `:683`; `models.spec.ts` | — |
| Adapter health check | built | `http_adapter.ts:747`; `adapter_contract.spec.ts` | — |
| Per-model sampling values (Qwen code/planning; Apodex two slots) | built | `llama_server.ts:580-605`; `roster.ts:45-78` | — (read from the registry: NEW-models-4) |
| Bake-off matrix `MODEL_MATRIX.md` | built | `report.ts:133-200` | — |
| Speculative decoding and prefix caching qualified together, with tool-call checks | not-built | `calibrateSpeculative` measures speed only | NEW-models-8 |
| Draft-model speculative decoding (`-md`) | not-built | only `--spec-type draft-mtp` (`llama_server.ts:310`) | NEW-models-8 |
| Qualification keyed by (engine, model, host, settings), with recall and multi-step tool checks | not-built | qualification is per model id; no recall check (`qualification.ts`) | NEW-models-8 |
| Qualified parallel capacity read per engine | not-built | slot counts are profile constants (`llama_server.ts:270`) | NEW-models-8 |
| One residency scheduler: adapters by weights, per-role queues, footprint check, all callers | not-built | adapters keyed by role (`roster.ts:45-78`: manager 8,192, escalation 12,288, PM 8,192 on the same weights); questions swap per question (`index.ts:1386-1422`); the dashboard's kick loads models without the router | NEW-models-9 |
| Warm caches in the overnight window | not-built | — | NEW-models-3 |
| A person assigns any qualified model; the baseline and shipped defaults change only through a recorded bake-off; one-command restore | not-built | a role's model is changed by editing the profile | NEW-models-10 |
| Person-built attempts excluded from competence | not-built | no `builtBy` ([kernel.md](kernel.md) NEW-kernel-6) | NEW-models-6 |
| Declared hours, swap batching by project | partial | `overnight` runs; `isUserTime`, `nextWorkWindow` unreachable (`schedule.ts`) | NEW-models-3 |
| One role enum; one profile record; one construction path | not-built | three role vocabularies (`registry.ts:13`, `router.ts:20`, the design); `run` builds its adapter inline and an Ollama tag skips the roster (`index.ts:1122-1128`) | NEW-models-4 |
| Registry keyed by host; safe merge; tests isolated | not-built | test entries `"a"`, `"b"` leaked into the real `~/.sekhemet/models.json`; default path is the home directory (`registry.ts:75`) | NEW-models-4 |
| Qualification suite | built | `qualification.ts`; `qualification_schedule.spec.ts`; `sekhemet qualify` | — |
| Qualification gates Worker use | not-built | `isQualified` has no caller (`registry.ts:192`) | NEW-models-4 |
| Tool arm measured and pinned | not-built | registry field exists; no measurement for the Worker; default `arm_a_flat` | NEW-models-5 |
| Bake-off under the real harness | partial | `bakeoff.ts`; settings rebuilt after the child ran (`index.ts:1044-1053`); runs `--fixture chronicle`, not tasks mined from the repository's history (`wave2.ts:1180`) | NEW-models-4 |
| Card class definition | built | `card_class.ts` | — (the kind it reads becomes the stored field: [kernel.md](kernel.md) NEW-kernel-9) |
| Every default's family recorded; a Reviewer of another family | not-built | `family` exists in the registry and nothing sets or reads it (`registry.ts:44`); no managed Reviewer — `--reviewer` falls to the Qwen3.8 profile (`roster.ts:72-78`, `:200-216`) | NEW-models-4 (with P8, [review-git.md](review-git.md)) |
| Working context for card sizing read from the resolved Worker | not-built | the planner uses its own 32,768 (`planner/src/constants.ts:60`) against the Worker's 16,384 | NEW-models-4 |
| A smaller Researcher decided by bake-off | not-built | Apodex-1.1-mini is hard-wired (`llama_server.ts:19`, `:570-590`) | NEW-models-11 |
| Competence rows | partial | `CompetenceEntry` has no prediction/decision/outcome split; no gate failures | NEW-models-6 |
| Watchdog, roster, residency tests on real sockets | built | `watchdog.spec.ts`, `residency.spec.ts`, `router_swap.spec.ts` | — |

## 5. Changes for v1

### M4 — provenance: what produced a result

- **MD-M4-1** WHEN a server already listens on a managed port and its `/props` reports a different model path THE SYSTEM SHALL refuse to adopt it and say which model is loaded; WHEN the model matches but the context size or MTP state differs from the profile, it SHALL refuse the same way.
- **MD-M4-2** WHEN a card's evidence is compiled THE SYSTEM SHALL record the harness repository's commit and dirty flag and a hash of the built `dist` directories — never the target repository's HEAD as the harness commit.
- **MD-M4-3** WHEN a card's evidence is compiled THE SYSTEM SHALL record the running server's reported model, context, KV type, MTP state and build as read from `/props`.
- **MD-M4-4** WHEN a step completes THE SYSTEM SHALL record `finish_reason`, thinking tokens, answer tokens, cached and evaluated prompt tokens, tool-call format errors and unknown-tool-name errors, and, with speculative decoding on, drafted and accepted token counts.
- **MD-M4-5** WHEN a card's evidence is compiled THE SYSTEM SHALL record the seven-field reproducibility record — model, quantisation, chat-template checksum, prompt-set version, playbook version, tool-schema version and engine settings (the prompt-set and tool-schema versions are parts of the context version; the playbook version is the pack's guidance list, outside it, [context.md](context.md) rule 27) — so a card can be replayed and A/B-compared on exactly what produced it.

### M7 and M11 — MTP decided by measurement, on seconds per step

- **MD-M7-1** WHEN no speculative decision is recorded for this model, host fingerprint and thinking policy THE SYSTEM SHALL launch the Worker without `--spec-type draft-mtp`.
- **MD-M7-2** WHEN a recorded decision enables MTP for this host and policy THE SYSTEM SHALL launch with `--spec-type draft-mtp` and `--spec-draft-n-max 2`; WHEN the thinking policy changes, the decision for the new policy SHALL apply.
- **MD-M11-1** WHEN the MTP A/B runs THE SYSTEM SHALL replay recorded Worker step prompts against one GGUF and one server build with MTP on and off, and record per step prefill seconds, decode seconds, total seconds, draft acceptance and the peak Metal working set, for each thinking policy.
- **MD-M11-2** WHEN the A/B's paired total seconds per step is not lower with MTP THE SYSTEM SHALL record `enabled: false` with the measured speed-up and reason.
- **MD-M11-3** WHEN the watchdog reaches `elevated` THE SYSTEM SHALL suspend MTP at the next launch whatever the recorded decision.

### NEW-models-1 — calibrate the reference host and correct its tier

*Justification:* the 24 GB reference host computes as tier S and calibration would shrink the Worker's window below what its prompts need.

- **MD-N1-1** WHEN a machine with 24 GB installed is classified THE SYSTEM SHALL place it in tier M.
- **MD-N1-2** WHEN calibration would set the Worker's working context below the p99 of its recorded prompt sizes plus the answer and thinking caps THE SYSTEM SHALL keep the larger window and say why.
- **MD-N1-3** WHEN `sekhemet calibrate` completes THE SYSTEM SHALL write the machine profile keyed by the hardware fingerprint, and the next run on the same host SHALL read it rather than re-measure.

### NEW-models-2 — floors and the watchdog on every path

*Justification:* the throughput floor never refuses anything, and the watchdog guards `queue` but not `run`.

- **MD-N2-1** WHEN the Worker's measured throughput is below the overnight floor THE SYSTEM SHALL refuse to start a card with a message naming the measured and required prefill and decode rates.
- **MD-N2-2** WHEN `sekhemet run` executes a card THE SYSTEM SHALL run the memory watchdog for the card's duration, and a `critical` level SHALL pause new steps.
- **MD-N2-3** WHEN `sekhemet run` starts a card with a Worker whose measured throughput is below the overnight floor THE SYSTEM SHALL refuse it as the queue does.
- **MD-N2-4** WHEN the watchdog reaches `high` THE SYSTEM SHALL run at most one card at a time, trim the language servers' symbol caches and mask older observations at the next step; WHEN it reaches `elevated`, it SHALL start no new worktree and shorten keep-alive.
- **MD-N2-5** WHEN the watchdog's action list is walked THE SYSTEM SHALL find each action handled by the queue or the runner (a test fails for an action with no handler).

### NEW-models-3 — reserved hours, the overnight window and swap batching

*Justification:* the design's scheduling is half-unreachable (`isUserTime`, `nextWorkWindow`); either it is wired in or cut (owner decides).

- **MD-N3-1** WHEN the machine is reserved (`[machine] reserved_hours`, or a person's reserve-now, rule 20) THE SYSTEM SHALL NOT start a backlog card unattended, unless the card is marked urgent.
- **MD-N3-2** WHEN the queue holds cards from two projects THE SYSTEM SHALL run each project's cards together before swapping models, unless a dependency forces the order.
- **MD-N3-3** WHEN the machine is in the overnight window and idle with cards queued THE SYSTEM SHALL keep the next card's model loaded and SHALL NOT unload it between cards.
- **MD-N3-4** WHEN an overnight benchmark is due and the machine is reserved — inside `[machine] reserved_hours`, outside `[machine] overnight_hours` when that is set, or during a person's reserve-now — or a card holds the runner lease THE SYSTEM SHALL NOT start it, SHALL show it as *Queued* with when it will start, and SHALL start it at the first moment of the overnight window with the lease free; WHILE it holds the lease THE SYSTEM SHALL start no card; WHEN a person reserves the machine now during a run THE SYSTEM SHALL stop the run as at the window's end (MD-N3-5).
- **MD-N3-5** WHEN the overnight window ends during an overnight benchmark THE SYSTEM SHALL stop at the current card's end or at the window's end, whichever comes first, keep every completed card and run, and record where it stopped; WHEN the next window opens THE SYSTEM SHALL resume from that card in the same interleaved order, and WHEN the harness build, the context version or a model's qualification changed in between it SHALL discard the interrupted run and restart it, saying why.

### NEW-models-4 — one profile, one role enum, one construction path, a live registry

*Justification:* three role vocabularies, sampling hard-coded in five places, three construction paths with different settings, and qualification that gates nothing.

- **MD-N4-1** WHEN the source is searched THE SYSTEM SHALL define one role type (`worker`, `planner`, `reviewer`, `researcher`) and one capability flag `vision`, and no other role enumeration.
- **MD-N4-2** WHEN a registry entry sets sampling, window or reasoning for a model THE SYSTEM SHALL use those values in the request, overriding the factory default (a test changes the registry and observes the request).
- **MD-N4-3** WHEN `run`, `queue`, `bake-off`, `plan` or the PM needs a model, including by an Ollama tag THE SYSTEM SHALL obtain it from the roster.
- **MD-N4-4** WHEN the Worker model's qualification is missing, failed or invalidated THE SYSTEM SHALL refuse to run cards with it unless a person recorded an override, and the evidence SHALL say so.
- **MD-N4-5** WHEN tests run THE SYSTEM SHALL write no file under the user's home `.sekhemet`, and a registry write SHALL preserve entries written by another process since it was read.
- **MD-N4-6** WHEN a bake-off child finishes THE SYSTEM SHALL report the settings recorded in the child's evidence.
- **MD-N4-7** WHEN `sekhemet bake-off` runs in a repository with history THE SYSTEM SHALL build its tasks from that repository's closed issues and fixing commits (kept only if reverting the fix fails its test) and recent commits, and SHALL say when too few exist and it fell back to a fixture.
- **MD-N4-8** WHEN a model's reply carries reasoning THE SYSTEM SHALL strip it once, in the adapter, and every caller SHALL read JSON from a reply through one extraction helper (the integration review found `<think>` stripped in eight places and a greedy JSON regex in four).
- **MD-N4-9** WHEN the managed defaults are registered THE SYSTEM SHALL record each one's `family` (Worker and Planner `qwen`, Reviewer `gemma`, Researcher from its model card); WHEN a model of the Worker's family is assigned to the Reviewer role THE SYSTEM SHALL refuse the assignment naming both families, and WHEN no other family is qualified on the host THE SYSTEM SHALL record the Reviewer as unfilled.
- **MD-N4-10** WHEN the planner checks a card's INVEST *Small* bound THE SYSTEM SHALL read the resolved Worker's window from the registry and take the verdict from the context allocator's Zone 3 measurement at that Worker's prompt budget ([context.md](context.md) CX-N2-2); on the reference Worker (16,384) it SHALL refuse a card whose Zone 3 content exceeds 3,792 tokens, and no planner constant SHALL set the window or a second token limit.

### NEW-models-5 — tool-arm qualification

*Justification:* "which tool arm wins" blocks the product thesis and has never been measured for the Worker.

- **MD-N5-1** WHEN `sekhemet qualify` runs a model THE SYSTEM SHALL score arms A, B and C on the same tasks and record per-arm tool-call validity, pass rate and trials, and pin the winner only with at least `MIN_ARM_TRIALS` trials per arm and a lead of at least 5 points of tool-call validity whose interval excludes zero ([measurement.md](measurement.md) statistics).
- **MD-N5-2** WHEN a card runs with an unmeasured arm THE SYSTEM SHALL record `toolArm` with `measured: false` in the evidence.

### NEW-models-6 — competence rows that can improve routing

*Justification:* a row that records only the outcome cannot say whether an escalation or a budget was necessary.

- **MD-N6-1** WHEN a card finishes THE SYSTEM SHALL write a competence row with separate `prediction`, `decision` and `outcome` fields and the card's gate failures.
- **MD-N6-2** WHEN an attempt's `builtBy.kind` is `person` THE SYSTEM SHALL write no competence row for it and SHALL exclude it from pass rate by model.

### NEW-models-7 — weights that a new user can obtain

*Justification:* a local-first harness whose defaults cannot be obtained does not run for anyone but its author.

- **MD-N7-1** WHEN a default model's file is missing THE SYSTEM SHALL say so and name the explicit ways to download it (the Configuration page's **Download…** and `sekhemet models fetch <model>`); WHEN a person runs `sekhemet models fetch <model>` THE SYSTEM SHALL download from the registered source through the same implementation as the page (MD-N12-6) and verify the published SHA-256 before the file is used, and SHALL delete a file whose hash differs; WHEN `[network] mode` is `offline` it SHALL refuse, naming the setting.
- **MD-N7-2** WHEN a weights file's hash differs from the registered one THE SYSTEM SHALL report `doctor` red for that model.
- **MD-N7-3** WHEN the shipped source is searched THE SYSTEM SHALL contain no absolute model path, external-volume path or user-specific directory.
- **MD-N7-4** WHEN no person has run the download command THE SYSTEM SHALL NOT download any weights (a test runs `doctor`, `run` and `queue` with a missing model and observes no network request for weights).

### NEW-models-8 — engines as adapters, qualified per combination

*Justification:* on a team server the engine is a throughput choice and on a laptop a memory choice, so no engine is universal; and a configuration can pass a speed check while corrupting tool calls (vLLM #47194, prefix caching with MTP) — the Worker's only interface ([DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md)).

- **MD-N8-1** WHEN a model is assigned to a role on a host THE SYSTEM SHALL refuse to use it until that (engine, model build, host fingerprint, settings) combination has passed qualification, which includes tool-call validity, a multi-step tool conversation and a recall check as well as speed.
- **MD-N8-2** WHEN speculative decoding (MTP or a draft model) is enabled THE SYSTEM SHALL have qualified that exact combination with prefix caching on, and SHALL disable it, recording why, if the qualification's tool-call checks fail.
- **MD-N8-3** WHEN the host profile is multi-user THE SYSTEM SHALL read the engine's parallel-slot or batch capacity from its qualification and SHALL NOT assume one request at a time.
- **MD-N8-4** WHEN any element of the qualified combination changes (engine build, template, speculative decoding, context size, KV type, slots, context version) THE SYSTEM SHALL mark the qualification invalidated with the changed element as the reason.
- **MD-N8-5** WHEN a draft model is configured for speculative decoding THE SYSTEM SHALL measure and decide it by the same A/B as MTP (MD-M11-1, MD-M11-2), keyed by the draft model as well.

### NEW-models-9 — one scheduler owns residency

*Justification:* the integration review measured ten evictions where four were needed (4–12 minutes a run), an escalated retry that could load the Worker beside a 12 GB model on a 24 GB host, three adapters on the same weights reloading on every `num_ctx` change, and a dashboard path that loads models with no footprint check (C1–C4; suggestions 1 and 10; target scheduler; ruling DEC-25.R20).

- **MD-N9-1** WHEN two roles are served by the same weights THE SYSTEM SHALL construct one adapter for them with the largest context either needs, and a request from either SHALL NOT reload the model.
- **MD-N9-2** WHEN work for a role whose model is not resident arrives THE SYSTEM SHALL queue it, and SHALL swap models in the order the residency plan and the waiting queues give, not per request (a test with four Researcher and four Planner questions interleaved observes at most two swaps per batch).
- **MD-N9-3** WHEN a load would put the resident footprint plus the new model above usable memory, or a footprint is unknown, THE SYSTEM SHALL refuse the load and keep the work queued, naming both footprints.
- **MD-N9-4** WHEN the dashboard, the PM's chat or any other caller needs a model THE SYSTEM SHALL obtain it through the scheduler, and no production code outside it SHALL construct or load a model adapter (a search test).
- **MD-N9-5** WHEN every model fits the host THE SYSTEM SHALL keep them all resident and drain every queue as work arrives.

### NEW-models-10 — the baseline and the defaults change only by measurement; a person's own choice is theirs

*Justification:* published numbers are upper bounds (the same 35B-A3B family scores 73.4 on SWE-bench Verified by its card and 24.7% on SWE-rebench), and model churn in the baseline silently changes every comparison against it ([research](../../research/DESIGN_RESEARCH_TEAM_SERVER.md)); a person choosing a model for their own machine is not churn in the baseline (rule 30a).

- **MD-N10-1** WHEN a change to the recorded baseline `RunProfile`'s model for a role, or to a shipped default, is proposed on a host THE SYSTEM SHALL require a recorded bake-off on that host before it takes effect — on the frozen suite for the Worker, and on the role's full evaluation set for the Planner (the planning measure), the Reviewer (the seeded defects) and the Researcher (the research golden set), which is what the overnight benchmark tier runs ([measurement.md](measurement.md) NEW-measurement-5) — and SHALL refuse it without one; a quick-benchmark score SHALL NOT satisfy it.
- **MD-N10-2** WHEN a role's model is replaced THE SYSTEM SHALL keep the previous assignment, and `sekhemet models restore <role>` SHALL restore it in one command.
- **MD-N10-3** WHEN a person assigns a qualified model to a role for their own use THE SYSTEM SHALL accept it with or without a benchmark, record it on the ledger with the principal, and SHALL NOT change the recorded baseline `RunProfile` or the shipped defaults; WHEN the model is not qualified for that role on this host THE SYSTEM SHALL refuse the assignment, naming the missing qualification (for the Worker, a person's recorded override still applies, MD-N4-4); WHEN the shipped defaults are assigned at first run THE SYSTEM SHALL require no bake-off.

### NEW-models-11 — a smaller Researcher, decided by one bake-off

*Justification:* the Researcher default, Apodex-1.1-mini at IQ3_M, takes ~16 GB — the whole usable budget of the 24 GB reference host — so it forces a swap against the Worker and caps research context at 16k (`llama_server.ts:546-560`). Spark-X2.5-4B (Apache-2.0, Q4_K_M 2.6 GB / Q8_0 4.4 GB, needs llama.cpp b10828 or later) was reviewed as "adopt, as the gatherer, displacing Apodex", and NeoHorse-1-4B is its peer ([PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md) §4); either could stay loaded beside the Worker. A vendor table decides nothing (rule 30a), so the change is one bake-off. **Workstream: B4.4** — the Researcher's work is the design stage's, and the bake-off's task set is the research golden set (25 questions, [measurement.md](measurement.md) T11), built in B4.4 (its first five in B4.1, for the quick benchmark); it needs per-combination qualification (NEW-models-8, B2.2) and adoption by bake-off (NEW-models-10, B4.0a) first.

- **MD-N11-1** WHEN the Researcher bake-off runs THE SYSTEM SHALL run Apodex-1.1-mini, Spark-X2.5-4B and NeoHorse-1-4B on the research golden set on the reference host, each qualified per combination (with the llama.cpp build each needs), and record per model the questions answered correctly under the set's rubric, unverified citations, peak resident memory and seconds per question.
- **MD-N11-2** WHEN a candidate answers more questions correctly than the incumbent by a margin the paired exact test resolves at 0.05 THE SYSTEM SHALL allow its adoption; WHEN the comparison is inconclusive THE SYSTEM SHALL allow it only if its peak resident memory is lower and the paired test shows no significant loss, recording quality as "not established" ([measurement.md](measurement.md) §2); otherwise the Researcher SHALL stay Apodex-1.1-mini.
- **MD-N11-3** WHEN a Researcher is adopted THE SYSTEM SHALL keep the previous assignment restorable with `sekhemet models restore researcher` (MD-N10-2), and SHALL NOT delete the Apodex profile before that adoption is recorded.

### NEW-models-12 — the Configuration page's models: scan, fit, recommend, download

*Justification:* the owner decided that a person points the harness at the folders where their models live, sees every model it finds as an option, gets a recommended model per role with the reason, may download a recommended model explicitly with its hash verified, and compares models there — and that the harness never downloads on its own ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O2, O3). Today the harness knows one folder and only the managed file names in it (`models_dir.ts`).

- **MD-N12-1** WHEN a person adds a folder and scans THE SYSTEM SHALL list every model in it identified from its header without loading it — name, format, quantisation, context length, parameter count, size, family where known — treat a split GGUF as one model and a vision projector as a companion, list an unparseable file as unreadable with the reason, and write nothing in the folder (a test scans a read-only fixture folder holding a GGUF, a split GGUF, an `mmproj` file, a safetensors directory and a truncated file).
- **MD-N12-2** WHEN a scan completes THE SYSTEM SHALL compute each model's SHA-256 in the background without delaying the listing, and SHALL mark a model *Verified* only when the hash matches the registry's published one, *Hash differs* when it does not, and *Not a registry model* otherwise.
- **MD-N12-3** WHEN a found model is fitted for a role THE SYSTEM SHALL compute weights plus KV at the role's context and KV type plus the engine's buffers against usable memory, and SHALL label it *fits*, *fits, swaps with the other roles* (with the measured swap time) or *needs N GB*; a model labelled *needs N GB* SHALL be listed and SHALL NOT be loaded, benchmarked or recommended.
- **MD-N12-4** WHEN roles are recommended THE SYSTEM SHALL recommend for each role a model that fits, using that role's quick-benchmark scores on this host when they exist for the current cache key ([measurement.md](measurement.md) MS-N5-2) and otherwise the qualification record and the registry; SHALL give the reason as one sentence naming its evidence; SHALL exclude from the Reviewer every model of the Worker's family or of unknown family; and WHEN the two best candidates' quick intervals overlap SHALL say they are indistinguishable on the quick benchmark rather than name one as better.
- **MD-N12-5** WHEN a recommendation is computed THE SYSTEM SHALL NOT assign, load or download any model; a test computes recommendations with a missing recommended model and observes no network request and no change to any role.
- **MD-N12-6** WHEN a person confirms **Download…** for a recommended model on the Configuration page, or runs `sekhemet models fetch <model>` THE SYSTEM SHALL use one download implementation for both: fetch only from the model's registered source into a folder the person named, verify the published SHA-256 before the file is used, delete a file whose hash differs and report it, and record the download on the ledger with its source and principal; WHEN the model has no registered source and hash, or `[network] mode` does not allow the source host (including `offline`) THE SYSTEM SHALL refuse, naming the reason ([security.md](security.md) item 47).
- **MD-N12-7** WHEN no person has confirmed a download THE SYSTEM SHALL download no weights on any path — scan, recommendation, first run, `doctor`, `run`, `queue`, the quick or overnight benchmark (a test with every model missing observes no request for weights).
- **MD-N12-8** WHEN the Configuration page lists suggested folders THE SYSTEM SHALL suggest, among `SEKHEMET_MODELS_DIR`, Ollama's model store, LM Studio's models folder, the Hugging Face hub cache and llama.cpp's cache, exactly those that exist on this machine and are not yet configured, and SHALL scan none of them until a person adds it.

## 6. v1 acceptance

This spec is `built` when §5 passes and these stay under test:

- **MD-1** WHEN a launch would use 4-bit KV for a tool-calling model THE SYSTEM SHALL refuse it with `KvPolicyError`.
- **MD-2** WHEN a model's chat template checksum changes THE SYSTEM SHALL mark its qualification invalidated.
- **MD-3** WHEN swap in use exceeds 6 GB, or has grown 2 GB since the card started THE SYSTEM SHALL refuse the next step and stop the card with `memory_pressure`.
- **MD-4** WHEN the watchdog sees pressure rise THE SYSTEM SHALL escalate on the first such sample and de-escalate only after the configured number of calmer samples.
- **MD-5** WHEN a role's model is absent THE SYSTEM SHALL use its named fallback and say so on the card.
- **MD-6** WHEN the Worker weights are missing from the models directory THE SYSTEM SHALL report `doctor` red before any other check is reported green.
- **MD-7** WHEN a request carries a token callback THE SYSTEM SHALL deliver each streamed delta to it and still return the full reply and its usage.
- **MD-8** WHEN a server answers `/health` as loading THE SYSTEM SHALL report the model as loading, not dead.
- **MD-9** WHEN the Planner is asked for a plan THE SYSTEM SHALL send the planning sampling (temperature 0.7, top_p 0.8) and `min_p` 0; for code, temperature 0.2 and top_p 0.9.

## 7. Later

- **Cloud models per role** — after v1, optional and per role, never as a silent fallback.
- **An MLX engine path** (unified-memory reuse, MTPLX native MTP heads). Only an engine label exists (`bakeoff.ts:17`); an adapter comes only if the engine measurement favours it on Apple Silicon.
- **The vLLM adapter is built with the company-server mode**, not before: the owner approved vLLM as the optional multi-user engine ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O8), qualified per combination with MTP off until its prefix-caching fix lands and is re-qualified (rule 13). SGLang stays *proposed*. Rule 14 keeps the adapter boundary so adding one changes no other code. Per-tenant token quotas beyond fair share, Kubernetes deployment and autoscaling are out: a team server is one machine in v1.
- **The ceiling run** — the frozen suite once with a frontier model as Worker, only after local v1 meets the Definition of Done ([DEC-07](../DECISIONS.md#dec-07)); measurement only.
- **Replacing the Worker's weights.** The project's research rates Cyber-Tiel "not recommended" and names Tiel-Coder-35B-A3B-MTP as a same-size guardrailed drop-in; the owner kept Cyber-Tiel (DEC-04). A swap is a new decision with its own suite run.
- **A multi-machine inference pool**, and a local verifier model ranking passing samples (only if it beats gate-only selection at equal wall-clock, and only with an anchor set calibrating it — a learned scorer drifts without one, arXiv:2608.12564).
- **Rejected:** KV-cache eviction by random scoring (arXiv:2609.03430) — its gains are batch-128 datacentre gains, its failure mode (a fact stated once, never restated) is a tool loop's normal case, and it needs a forked engine; a learned tabular predictor for competence (LimiX-2) — a second resident model and an unreadable router; local LoRA or RL on the repository's history — too little data, too much forgetting.
- **Initialising difficulty and routing from public data** (SWE-bench annotations) — [measurement.md](measurement.md) says what may and may not be imported.

## 8. Open questions

1. *Decided* ([DEC-25](../DECISIONS.md#dec-25--the-leads-rulings-during-the-design-v3-fix-pass) R30): **wire `schedule.ts`**; only its unreached exports are removed. Was: keep or cut `schedule.ts` (NEW-models-3) — a cut needs the owner, and the question is not yet in the owner queue ([OPEN_QUESTIONS](../../reference/OPEN_QUESTIONS.md#owner-decisions)). *Recommendation, and the default until decided:* wire it in — declared hours are the non-developer's guarantee that the harness will not load a 13 GB model while they are working, and the overnight benchmark is scheduled by them (rule 20b) — and cut the exports no command reaches.
2. **Where MTP is decided when the thinking A/B picks `all`.** Decode matters far more under `all`. *Recommendation:* run the MTP A/B after the thinking A/B picks its winner, only for that policy, so one measurement decides the shipped default.
3. **Measurement tools — owner decision [O21](../../reference/OPEN_QUESTIONS.md#owner-decisions), open.** `llama-bench` (MIT) for the throughput and MTP repetitions: it gives repetitions with standard deviations on the same build. *Default until decided, and the recommendation:* approve, as a measurement tool run as a separate process, not a dependency of the product; until the owner decides, B2.2's MTP A/B (MD-M11-1) replays step prompts through the harness's own adapter, which it needs anyway.
4. *Decided.* **The multi-user engine** ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O8): vLLM is approved as the optional multi-user engine, a separate process; llama.cpp stays the default and the single-user engine. The vLLM adapter is built with the company-server mode, qualified per combination with MTP off until its prefix-caching fix lands and is re-qualified (§7).

## 9. Evidence and rationale

- Review: [domain05_10_models_measurement.md](../../reference/reviews/domain05_10_models_measurement.md) (Domain 5).
- Owner decisions ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)): O2 (the Configuration page: rules 4–4d, NEW-models-12; the overnight benchmark's scheduling, rule 20b), O3 (every role's model named on that page), O8 (vLLM approved, rule 14, §8 Q4), the Reviewer default decided (Gemma-4-26B-A4B, rule 3). Open, with defaults: O21 (§8 Q3).
- Confirmation review ([design_v3_confirmation.md](../../reference/reviews/design_v3_confirmation.md)): N1 (the playbook version is outside the context version, MD-M4-5), N5 (INVEST *Small* is Zone 3's fit, rule 11, MD-N4-10), M3 residue (§8 Q1 not in the owner queue), n12.
- Independent review of design v3 ([design_v3_review.md](../../reference/reviews/design_v3_review.md)): B3 (`kind` is the stored field, [DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)), M11 (card sizing from the resolved Worker's window), M13 (the Reviewer default and every default's family), and the research-coverage note on Spark-X2.5-4B (NEW-models-11).
- Candidates and hardware: [MODEL_CANDIDATES.md](../../research/MODEL_CANDIDATES.md) (the M4 24 GB practical budget of ~14–15 GB for weights, KV and buffers; decode estimates).
- Research: [WEB_RESEARCH_2026-09.md](../../research/WEB_RESEARCH_2026-09.md) group A Q2 (MTP: [llama.cpp #22673](https://github.com/ggml-org/llama.cpp/pull/22673), about 1.28× decode on 35B-A3B with 2 draft tokens and a prefill penalty; a 24→2 tok/s collapse past Metal's working set, [#23011](https://github.com/ggml-org/llama.cpp/issues/23011); the [RTX 3090 study](https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090)) and group D §A (Cyber-Tiel's provenance and card warnings), §D (models for 24 GB), §E (abliteration and agent safety).
- Decisions: [DEC-03](../DECISIONS.md#dec-03) (local in v1), [DEC-04](../DECISIONS.md#dec-04) (Worker weights), [DEC-05](../DECISIONS.md#dec-05) (roles, not personas), [DEC-07](../DECISIONS.md#dec-07) (ceiling run after DoD), [DEC-22](../DECISIONS.md#dec-22--rejected-techniques) (KV eviction, tabular competence model, hard schema constraints by default, routing fitted to public results: rejected).
- Papers: [PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md) — NeoHorse-1 (arXiv:2609.08183: prediction/decision/outcome fields), Spark-X2.5-4B and NeoHorse-1-4B (Researcher candidates), Random Attention (arXiv:2609.03430, rejected), LimiX-2 (arXiv:2609.17488, rejected), WMRL (arXiv:2608.12564, anchors for any learned scorer).
- Public data: [PUBLIC_DATA_SURVEY.md](../../research/PUBLIC_DATA_SURVEY.md) verdicts 1 and 2 (difficulty prior only; routing from the local ledger).
- Register: [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md) R4 (per-model tool-call format, threshold 5 points of tool-call validity; recorded as adopted but never benched for the Worker). Format tax: arXiv:2408.02442.
- Quantisation: Jang et al. (arXiv:2607.27275) via [WEB_RESEARCH_2026-09.md](../../research/WEB_RESEARCH_2026-09.md) group D §D; SWE-rebench window scores, group D §B.
- Built history: [IMPLEMENTATION_AUDIT.md](../../research/IMPLEMENTATION_AUDIT.md) (swap safety, role batching, slot cache; the 128 GB Linux node's PSI memory reading).
- Research: [DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md) — engines as adapters (LLMKube bake-off: vLLM 345–377 tok/s against llama.cpp's 94–133 at 64 concurrent requests on two consumer GPUs; llama.cpp reached a 65k context against vLLM's 16k), MTP with prefix caching ([vLLM #47194](https://github.com/vllm-project/vllm/issues/47194), [PR #50172](https://github.com/vllm-project/vllm/pull/50172)), batch size as a host property, adoption by bake-off. Integration review ([reviews/integration_review_2026-09-18.md](../../reference/reviews/integration_review_2026-09-18.md)) C1–C4 and the target scheduler. [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 2 (person-built attempts out of the competence model).
- *Changed on purpose:* MTP's claimed 1.6×–2.6× decode speed-up was withdrawn — about 1.28× decode with a prefill penalty was measured, and agent steps are mostly prefill (rule 13); weights are never downloaded without a person's explicit act — the Configuration page's **Download…** or `sekhemet models fetch` (ruling DEC-25.R7, owner decision O2); the three watchdog stages of 85/90/94% became four levels driven by kernel pressure and swap growth, with the used-memory ratios kept as triggers (rule 19).
