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
changes: [M4, M7, M11, NEW-models-1, NEW-models-2, NEW-models-3, NEW-models-4, NEW-models-5, NEW-models-6, NEW-models-7, NEW-models-8, NEW-models-9, NEW-models-10]
---

# Models: hardware, the registry and inference

## 1. Purpose

This subsystem runs the local models: it measures the machine, obtains and verifies the weights, launches and supervises the inference server, keeps the machine out of swap, and records which model, on which settings, is qualified for which role. It serves the product's promise that **v1 inference is 100% local**, and the spine rule that a result means something only with the settings that produced it: a number without its settings is not admissible.

## 2. Behaviour

### The v1 models

1. **In v1 every model runs on the user's machine** ([DEC-03](../DECISIONS.md#dec-03)). Cloud models are a planned post-v1 option per role, never a silent fallback.
2. **The Worker is Cyber-Tiel-Coder-35B-A3B MTP at IQ3_XXS** ([DEC-04](../DECISIONS.md#dec-04)): 16,384-token context, 4,096-token answer cap, sampling from its model card (temperature 0.6, top_p 0.95, top_k 20, min_p 0), served by llama-server on port 8098 with `--jinja`, flash attention and KV at `q8_0`. It is uncensored (abliterated); the model's own card demands OS-level sandboxing, so the sandbox and permission layer is the only defence against destructive actions and every security item is v1-blocking ([security.md](security.md)).
3. The managed defaults for the other roles are Dirk-Qwen3.8-27B (IQ3_S) as Planner and Apodex-1.1-mini (IQ3_M) as Researcher. Shipped source names model **files**, never locations.
3a. **Per-model sampling and launch values live in the registry and the managed profiles, not in prose.** The values the design fixed, so they are not lost: Dirk-Qwen3.8-27B uses a **code** profile (temperature 0.2, top_p 0.9, top_k 20, min_p 0, presence_penalty 1.5) and a **planning** profile (temperature 0.7, top_p 0.8, the rest as for code), with reasoning off; `min_p = 0` is mandatory, because it overrides llama-server's default of 0.05 — a server-default override, not a preference (`QWEN38_CODE_SAMPLING`, `QWEN38_PLANNING_SAMPLING`, `llama_server.ts:592-605`). Apodex-1.1-mini runs with temperature 1.0, top_p 0.95, top_k 20, min_p 0 on two parallel slots — slot 0 for the research conversation, slot 1 for one-off extractions, which otherwise evict the conversation's prefix (live hit rate 55–68% on one slot) (`llama_server.ts:580-590`). Every managed server is launched by `launchArgs()` with `--host 127.0.0.1`, `-ngl` (99 by default), `-fa on`, `--jinja`, `-c`, `-ctk`/`-ctv q8_0` and `-np` (the slot count), plus, per profile, `-t`, the cache flags of [context.md](context.md), `--metrics` (the server-side telemetry the harness reads), `--no-webui`, `--reasoning` and `--spec-type draft-mtp` (`llama_server.ts:273-313`). The earlier Chronicle profile (`-t 2 -np 2 -c 49152 --ctx-checkpoints 6 --cache-ram 2048 --metrics --no-webui --reasoning off` on 127.0.0.1:8099) is superseded by the DEC-04 Worker on port 8098.

### Getting the weights

4. **Named defaults are obtainable, never downloaded on the harness's own initiative.** Each default model has an acquisition source recorded in the component register and a SHA-256. The harness never downloads weights by itself; a person may run an explicit download command for a registry model, which verifies the published hash before the file is used ([security.md](security.md) states the same rule). A default with no acquisition path is not a default.
5. **`doctor` verifies the weights** named by the resolved profiles — existence, readability and hash — before anything else reports green.
6. **One override:** `--models-dir` (and its config and `SEKHEMET_MODELS_DIR` equivalents). No other per-model environment variable is a configuration surface, and no path in shipped source refers to an absolute location, an external volume or an author's directory.

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

   | Mode | Prefill | Decode | Seconds per turn |
   | --- | --- | --- | --- |
   | Overnight batch | 40 tok/s | 10 tok/s | ~70 |
   | Interactive | 100 tok/s | 20 tok/s | ~30 |
   | Recommended | 300 tok/s | 40 tok/s | ~12 |

   Below the overnight floor the harness refuses to run cards and says why. Below 16 GB usable is unsupported. Vendor and model-card scores are upper bounds, never inputs: a model's fitness here is what this machine measures (the same 35B-A3B family scores 73.4 on SWE-bench Verified by its card and 24.7% on the decontaminated SWE-rebench window).

### Inference settings

10. KV cache at 8 bits (`q8_0` or FP8); 4-bit KV is refused for a tool-calling model, and anything below 8 bits needs a qualification run with it. Flash attention on; prefill batch size swept per machine; expert offload only when the model does not fit, tuned to just below spill. Prompt-cache settings are [context.md](context.md)'s (`--cache-ram`, `--ctx-checkpoints`, `--checkpoint-min-step`, no `--cache-reuse`).
10a. **Batch size is a property of the host.** "One request at a time" holds only on the single-user profile. On a multi-user host the number of concurrent requests an engine serves correctly — its parallel slots or batch capacity — is read from that engine's qualification (rule 27a), never assumed, and cache and memory budgets are set per slot. How many cards run at once (one slot lease per qualified slot), and how model time is shared between people (fair share per person, interactive replies first, aging), is [runtime.md](runtime.md)'s NEW-runtime-6; this spec supplies the qualified capacity.
11. Sampling parameters, context window and reasoning support are stored **per model in the registry** and read from it; factories only supply defaults for an empty registry.
12. Chat templates are pinned per model build by SHA-256; a template change invalidates that model's qualification.
13. **Speculative decoding is off until measured** on this host, per thinking policy — native MTP heads and a separate draft model (`-md`) alike. The measurement is an A/B on the same GGUF and the same server build, speculation on against off, replaying real Worker turn prompts, reporting prefill seconds, decode seconds and total seconds per turn separately, the draft acceptance rate and tokens per verify step, and the Metal working set. MTP uses two draft tokens (`--spec-draft-n-max 2`). It is enabled only where it lowers seconds per turn **and** the qualification's tool-call checks still pass with it on, with prefix caching on as it runs in production — speculation and prefix caching are qualified together, never separately, because the combination has corrupted tool calls on another engine (vLLM issue #47194: prefix caching with MTP-3 on a Qwen3.6 hybrid left 2 of 10 tool calls correct, 0 of 10 needle recalls and 0 of 5 multi-turn tool conversations, while the path without MTP was correct). The decision is recorded in the registry with the engine, the host fingerprint and the thinking policy it was measured under. MTP speeds decode only and slows prefill, and agent turns are mostly prefill, so decode speed-up alone never justifies it.
14. **Engines are adapters, qualified per combination.** Every engine is reached through one OpenAI-compatible adapter. llama.cpp's server over HTTP is the baseline everywhere and the single-user default; Ollama is supported as a client; on a multi-user NVIDIA server a batching engine (vLLM, possibly SGLang — *proposed, each a separate process over its OpenAI-compatible API*) is the throughput path, because on a team server the engine choice is a throughput choice and on a laptop a memory choice. MLX exists only as an engine label (`bakeoff.ts:17`) with no adapter; an MLX path is Later. Choice is by measurement per machine, weighting cross-turn cache retention above raw decode speed. No engine-specific assumption (a single slot, a llama.cpp flag) is allowed outside that engine's adapter.
14a. **Token streaming.** A request with a token callback streams the reply (`stream: true`, with usage in the final chunk for OpenAI-compatible servers) and hands each delta to the caller as it is decoded (`http_adapter.ts:711-725`, `:872-933`, `:956-964`). The runner writes the Worker's deltas to the card's live file, buffered and flushed every 250 ms, restarting the file at each new generation, which the dashboard's Steps view follows (`execute.ts:484-486`, `:683-700`; the stream route is [runtime.md](runtime.md)'s).
14b. **Every adapter answers a health check** (`healthCheck()`, `http_adapter.ts:747`): for an OpenAI-compatible server `/health` answering ok, distinguishing a server that is loading from one that is down, so a healthy machine with a model still loading is never reported as a dead model.
15. **Server identity.** Before adopting a server already listening on a managed port, the adapter reads its `/props` and refuses it unless the loaded model path (and, for the managed Worker, the context size and MTP state) matches the profile. The evidence records the running server's reported settings and build, never the adapter's intended ones.
16. Per turn, the adapter records prompt, cached, evaluated, thinking and answer tokens, `finish_reason`, and the draft statistics when speculative decoding is on.
17. The Worker server is started once and every card attaches to it; the harness never unloads a model another card is about to use. A model loaded from a slow external drive takes minutes, so load time is reported separately from card time.

### Memory safety

18. Memory pressure is read from the OS: the kernel pressure level and swap on macOS, PSI on Linux. Before each turn the harness checks headroom and refuses the turn when swap in use exceeds 6 GB or has grown more than 2 GB since the card started; the card then stops with `memory_pressure`.
19. **One watchdog, one set of thresholds** — this spec owns them; [runtime.md](runtime.md) and [security.md](security.md) link here. It polls every 2 s on every path that runs cards (`run`, `queue`, the daemon) and escalates through levels, each adding actions:

    | Level | Raised by | Actions (cumulative) |
    | --- | --- | --- |
    | **elevated** | kernel warning, or swap grown 0.5 GB since the run started, or used memory ≥ 0.85 | suspend speculative decoding at the next launch (falling back to plain decoding to reclaim KV headroom), stop new worktrees, shorten keep-alive (to 5 minutes), shed masked-observation caches |
    | **high** | kernel warning for 3 consecutive samples, or swap grown 1 GB, or used memory ≥ 0.90 | also throttle parallel cards to one, trim KV and prompt caches (erase the server's slots) and language-server symbol caches, and force the masking of older observations at the next turn ([context.md](context.md)) |
    | **critical** | kernel critical, or swap grown 2 GB, or swap in use ≥ 6 GB, or used memory ≥ 0.94 | also pause: no new turns until pressure falls, state persisted to the ledger first (keep-alive 60 s — evicting mid-card forces a full reload) |
    | **emergency** | kernel critical for 3 consecutive samples, or swap grown 3 GB | also unload the models |

    Swap growth is measured from the run's own start, so stale swap from before the run is not its doing. It escalates on the first sample that warrants it and de-escalates only after consecutive calmer samples, so it does not flap. Every action a level lists is either acted on by the queue and the runner or removed from the list; today `stopNewWorktrees` and `shortenKeepAlive` are declared and never acted on, and the 0.90 stage's parallel-card, language-server and forced-masking actions do not exist (`watchdog.ts:43-54`; `memory.ts:20-56` classifies 0.85, 0.90 and 0.94 separately from the levels) (NEW-models-2).

### Scheduling

20. The user declares the hours the machine is theirs; outside them the harness works the backlog, and while it is idle outside them it keeps the next card's model loaded and its prompt cache warm. Model swaps are batched by project to preserve caches, and planning runs in scheduled blocks on tiers where the Planner and Worker cannot be co-loaded. The daemon and `overnight` apply this ([runtime.md](runtime.md)).
20a. **One scheduler owns model residency.** Every caller that needs a model — the queue, the PM's chat, the dashboard, the Researcher, the Reviewer, a retry — asks one scheduler, through the runner lease ([runtime.md](runtime.md)), and never loads a model itself:
    - **Adapters are keyed by weights, not by role.** Roles served by the same weights share one adapter, loaded once with the largest context any of them needs; a context-size change never reloads the same weights behind the scheduler's back (Ollama reloads on every `num_ctx` change, invisibly to the swap count).
    - **Work waits in per-role queues** (plans, questions, reviews, research, chat) and a queue drains whenever its model is resident. Swaps are ordered by the waiting queues and the residency plan, not by the order questions arrive: on the 24 GB reference host the plan is a Worker pass, then the Researcher for every unexplained struggle (one load), then the Planner and Seshat for plans, answers and reflection after the retries, then the Worker's retries — four loads where asking per question cost ten, at 40–120 s each. The Reviewer's place in the order is [review-git.md](review-git.md)'s.
    - **Two large models are never resident at once** unless the tier co-loads them (rule 8): before any load the scheduler checks the footprint of what is resident plus what it would load against usable memory, and refuses (queueing the work) when it does not fit or when a footprint is unknown. A question asked during an escalated retry waits for its model's turn rather than loading the Worker behind the running session (~13.7 GB + ~12 GB on a 24 GB host is the out-of-memory path).
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

27. A model is qualified, not chosen by reputation. The qualification suite uses the harness's own tool schemas and deterministic scoring (no model judge) and measures schema validity, tool selection, arguments, multi-turn recovery after an injected error, and refusal of an out-of-scope request. A model qualifies as Worker at a set pass rate on this internal suite — a bar not comparable to public leaderboards, set with multi-turn scores below single-turn in mind. An unqualified or invalidated model is not used as Worker without a recorded override.
27a. **Qualification is per combination.** What is qualified is the tuple **(engine, model build, host fingerprint, settings)** — settings meaning the context size, KV type, speculative decoding, prefix caching, parallel slots and chat template. A model assigned to a role on a host is refused until that exact combination has passed, and the suite includes, besides speed, **tool-call validity, a multi-turn tool conversation and a recall check** (a fact stated once early in a long context, asked for later), because tool calls are the Worker's only interface and a speed-only qualification would pass a configuration that corrupts them. A change to any element of the tuple — a new engine build, a new template, MTP switched on, a new context version ([context.md](context.md) rule 27) — invalidates the qualification.
28. **Tool arm.** Each model's tool interface is measured across three arms — A (`arm_a_flat`: native, flat tool calls, optionally grammar-constrained per model), B (`arm_b_json`: calls written as JSON in the reply, read by the tolerant parser) and C (`arm_c_sketch`: the tool chosen in natural language, with constraints only on the terminal payload) — and the registry pins the winner once it has at least `MIN_ARM_TRIALS` trials and beats the others by the register's pre-set bar (5 points of tool-call validity, R4). Grammar constraints help on terminal payloads (paths, identifiers, flags) and hurt on reasoning and high-level selection (the "format tax", 15–30% on small models), so hard schema constraints are never a default ([DEC-22](../DECISIONS.md#dec-22--rejected-techniques)); a model gets them only when its measurement says so. Until a model is measured, arm A without constraints is used and the evidence says the arm was not measured.
29. **Quantisation is measured, not assumed.** No public source measures IQ3 against Q4 on agentic coding, and INT4 has raised tool-name hallucination up to 2.5× at unchanged final scores; so every run records tool-call format errors and tool-name errors per turn, not only pass/fail.

### Per-repo bake-off

30. `sekhemet bake-off` runs candidate models under the real harness on tasks from the repository's own history: closed issues with their fixing commits become fail-to-pass tasks (a task is kept only if reverting the fix makes its test fail), and recent commits become reconstruction tasks. Every result carries its full settings (model, quant, tool arm, step budget, working context, engine, date), taken from the child run's evidence, not reconstructed afterwards. The results are written as a matrix by hardware tier with full settings, `MODEL_MATRIX.md` (`packages/eval/src/report.ts:133-200`), which the dashboard's Registry shows.
30a. **A model enters a role only through a bake-off.** A new local model is adopted for a role on a host only after a recorded bake-off on the frozen suite on that host ([measurement.md](measurement.md)'s statistics), and the previous assignment stays restorable with one command (`sekhemet models restore <role>`). Published numbers are upper bounds, never inputs; model churn that nobody measured would silently change every result.

### Card class and the competence model

31. `cardClass = "<kind>:<ext>"`. `kind` is one of seven, closed: `spike`, `interface`, `implement`, `data`, `rule` (the SPIDR five) and `review`, `research`. `ext` is the primary file extension of the declared scope, or `none`. It is knowable before the card runs and coarse enough to fill; tool sets key on `kind` alone, and budgets, routes and exemplars on the whole class. It is defined once, in the kernel.
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
| Calibration command and machine profile | partial | `sekhemet calibrate` exists; never run on the reference host (no `~/.sekhemet/machine.json`) | NEW-models-1 |
| Tier of the reference host | not-built | usable ⅔ × 24 GB = 16 GB puts the 24 GB host in tier S (`calibration.ts:296`, `:187`); `roster.tuned()` would cut the window to 12,288 (`roster.ts:150-172`) | NEW-models-1 |
| Throughput floors refuse cards | partial | the queue's prelude refuses (`wave2.ts:322` → `assertModelRunnable` → `assertThroughputFloor`, `calibration.ts:659-666`); `run` has no check | NEW-models-2 |
| KV policy (no 4-bit for tool calling) | built | `kv_policy.ts`; `llama_server.ts:255` | — |
| Template pin and invalidation | built | `registry.ts`; `registry_calibration.spec.ts` | — |
| Sampling, window, reasoning read from the registry | not-built | hard-coded in five factories (`roster.ts:45-78`; `llama_server.ts:534`, `589`, `677`; `http_adapter.ts:1178`) | NEW-models-4 |
| MTP off until measured; two draft tokens; decision per host and policy | not-built | Worker ships `mtp: true` (`llama_server.ts:532`); `calibrateSpeculative` never run | M7, M11 |
| Refuse a foreign server (`/props`) | not-built | adopts anything answering `/health` (`llama_server.ts:374-383`) | M4 |
| Per-turn provenance: server settings/build, `finish_reason`, draft stats; real harness commit | not-built | `usageFromLlamaServer` captures none of these (`http_adapter.ts:338`); `harnessCommit(repoRoot)` is the fixture's HEAD (`card_runner.ts:1549`) | M4 |
| Headroom check (6 GB / 2 GB) | built | `memory.ts:158-190`; `memory.spec.ts` | — |
| Watchdog levels and actions | partial | `watchdog.ts`; wired into `queue` only (`index.ts:1298`); `stopNewWorktrees`, `shortenKeepAlive` never acted on | NEW-models-2 |
| The 0.90 stage (parallel cards to one, language-server caches, forced masking) | not-built | no such actions in `ACTIONS_AT` (`watchdog.ts:41-54`) | NEW-models-2 |
| Token streaming to the live Steps view | built | `http_adapter.ts:711-964`; `execute.ts:484-486`, `:683`; `models.spec.ts` | — |
| Adapter health check | built | `http_adapter.ts:747`; `adapter_contract.spec.ts` | — |
| Per-model sampling values (Qwen code/planning; Apodex two slots) | built | `llama_server.ts:580-605`; `roster.ts:45-78` | — (read from the registry: NEW-models-4) |
| Bake-off matrix `MODEL_MATRIX.md` | built | `report.ts:133-200` | — |
| Speculative decoding and prefix caching qualified together, with tool-call checks | not-built | `calibrateSpeculative` measures speed only | NEW-models-8 |
| Draft-model speculative decoding (`-md`) | not-built | only `--spec-type draft-mtp` (`llama_server.ts:310`) | NEW-models-8 |
| Qualification keyed by (engine, model, host, settings), with recall and multi-turn tool checks | not-built | qualification is per model id; no recall check (`qualification.ts`) | NEW-models-8 |
| Qualified parallel capacity read per engine | not-built | slot counts are profile constants (`llama_server.ts:270`) | NEW-models-8 |
| One residency scheduler: adapters by weights, per-role queues, footprint check, all callers | not-built | adapters keyed by role (`roster.ts:45-78`: manager 8,192, escalation 12,288, PM 8,192 on the same weights); questions swap per question (`index.ts:1386-1422`); the dashboard's kick loads models without the router | NEW-models-9 |
| Warm caches outside declared hours | not-built | — | NEW-models-3 |
| Adoption only through a recorded bake-off; one-command restore | not-built | a role's model is changed by editing the profile | NEW-models-10 |
| Person-built attempts excluded from competence | not-built | no `builtBy` ([kernel.md](kernel.md) NEW-kernel-6) | NEW-models-6 |
| Declared hours, swap batching by project | partial | `overnight` runs; `isUserTime`, `nextWorkWindow` unreachable (`schedule.ts`) | NEW-models-3 |
| One role enum; one profile record; one construction path | not-built | three role vocabularies (`registry.ts:13`, `router.ts:20`, the design); `run` builds its adapter inline and an Ollama tag skips the roster (`index.ts:1122-1128`) | NEW-models-4 |
| Registry keyed by host; safe merge; tests isolated | not-built | test entries `"a"`, `"b"` leaked into the real `~/.sekhemet/models.json`; default path is the home directory (`registry.ts:75`) | NEW-models-4 |
| Qualification suite | built | `qualification.ts`; `qualification_schedule.spec.ts`; `sekhemet qualify` | — |
| Qualification gates Worker use | not-built | `isQualified` has no caller (`registry.ts:192`) | NEW-models-4 |
| Tool arm measured and pinned | not-built | registry field exists; no measurement for the Worker; default `arm_a_flat` | NEW-models-5 |
| Bake-off under the real harness | partial | `bakeoff.ts`; settings rebuilt after the child ran (`index.ts:1044-1053`); runs `--fixture chronicle`, not tasks mined from the repository's history (`wave2.ts:1180`) | NEW-models-4 |
| Card class definition | built | `card_class.ts` | — |
| Competence rows | partial | `CompetenceEntry` has no prediction/decision/outcome split; no gate failures | NEW-models-6 |
| Watchdog, roster, residency tests on real sockets | built | `watchdog.spec.ts`, `residency.spec.ts`, `router_swap.spec.ts` | — |

## 5. Changes for v1

### M4 — provenance: what produced a result

- **MD-M4-1** WHEN a server already listens on a managed port and its `/props` reports a different model path THE SYSTEM SHALL refuse to adopt it and say which model is loaded; WHEN the model matches but the context size or MTP state differs from the profile, it SHALL refuse the same way.
- **MD-M4-2** WHEN a card's evidence is compiled THE SYSTEM SHALL record the harness repository's commit and dirty flag and a hash of the built `dist` directories — never the target repository's HEAD as the harness commit.
- **MD-M4-3** WHEN a card's evidence is compiled THE SYSTEM SHALL record the running server's reported model, context, KV type, MTP state and build as read from `/props`.
- **MD-M4-4** WHEN a turn completes THE SYSTEM SHALL record `finish_reason`, thinking tokens, answer tokens, cached and evaluated prompt tokens, tool-call format errors and unknown-tool-name errors, and, with speculative decoding on, drafted and accepted token counts.
- **MD-M4-5** WHEN a card's evidence is compiled THE SYSTEM SHALL record the seven-field reproducibility record — model, quantisation, chat-template checksum, prompt-set version, playbook version, tool-schema version and engine settings (the three versions as the parts of the context version) — so a card can be replayed and A/B-compared on exactly what produced it.

### M7 and M11 — MTP decided by measurement, on seconds per turn

- **MD-M7-1** WHEN no speculative decision is recorded for this model, host fingerprint and thinking policy THE SYSTEM SHALL launch the Worker without `--spec-type draft-mtp`.
- **MD-M7-2** WHEN a recorded decision enables MTP for this host and policy THE SYSTEM SHALL launch with `--spec-type draft-mtp` and `--spec-draft-n-max 2`; WHEN the thinking policy changes, the decision for the new policy SHALL apply.
- **MD-M11-1** WHEN the MTP A/B runs THE SYSTEM SHALL replay recorded Worker turn prompts against one GGUF and one server build with MTP on and off, and record per turn prefill seconds, decode seconds, total seconds, draft acceptance and the peak Metal working set, for each thinking policy.
- **MD-M11-2** WHEN the A/B's paired total seconds per turn is not lower with MTP THE SYSTEM SHALL record `enabled: false` with the measured speed-up and reason.
- **MD-M11-3** WHEN the watchdog reaches `elevated` THE SYSTEM SHALL suspend MTP at the next launch whatever the recorded decision.

### NEW-models-1 — calibrate the reference host and correct its tier

*Justification:* the 24 GB reference host computes as tier S and calibration would shrink the Worker's window below what its prompts need.

- **MD-N1-1** WHEN a machine with 24 GB installed is classified THE SYSTEM SHALL place it in tier M.
- **MD-N1-2** WHEN calibration would set the Worker's working context below the p99 of its recorded prompt sizes plus the answer and thinking caps THE SYSTEM SHALL keep the larger window and say why.
- **MD-N1-3** WHEN `sekhemet calibrate` completes THE SYSTEM SHALL write the machine profile keyed by the hardware fingerprint, and the next run on the same host SHALL read it rather than re-measure.

### NEW-models-2 — floors and the watchdog on every path

*Justification:* the throughput floor never refuses anything, and the watchdog guards `queue` but not `run`.

- **MD-N2-1** WHEN the Worker's measured throughput is below the overnight floor THE SYSTEM SHALL refuse to start a card with a message naming the measured and required prefill and decode rates.
- **MD-N2-2** WHEN `sekhemet run` executes a card THE SYSTEM SHALL run the memory watchdog for the card's duration, and a `critical` level SHALL pause new turns.
- **MD-N2-3** WHEN `sekhemet run` starts a card with a Worker whose measured throughput is below the overnight floor THE SYSTEM SHALL refuse it as the queue does.
- **MD-N2-4** WHEN the watchdog reaches `high` THE SYSTEM SHALL run at most one card at a time, trim the language servers' symbol caches and mask older observations at the next turn; WHEN it reaches `elevated`, it SHALL start no new worktree and shorten keep-alive.
- **MD-N2-5** WHEN the watchdog's action list is walked THE SYSTEM SHALL find each action handled by the queue or the runner (a test fails for an action with no handler).

### NEW-models-3 — declared hours and swap batching

*Justification:* the design's scheduling is half-unreachable (`isUserTime`, `nextWorkWindow`); either it is wired in or cut (owner decides).

- **MD-N3-1** WHEN the current time is inside the user's declared hours THE SYSTEM SHALL NOT start a backlog card unattended, unless the card is marked urgent.
- **MD-N3-2** WHEN the queue holds cards from two projects THE SYSTEM SHALL run each project's cards together before swapping models, unless a dependency forces the order.
- **MD-N3-3** WHEN the machine is outside the declared hours and idle with cards queued THE SYSTEM SHALL keep the next card's model loaded and SHALL NOT unload it between cards.

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

- **MD-N7-1** WHEN a default model's file is missing THE SYSTEM SHALL say so and name the explicit command that downloads it; WHEN a person runs `sekhemet models fetch <model>` THE SYSTEM SHALL download from the registered source and verify the published SHA-256 before the file is used, and SHALL delete a file whose hash differs.
- **MD-N7-4** WHEN no person has run the download command THE SYSTEM SHALL NOT download any weights (a test runs `doctor`, `run` and `queue` with a missing model and observes no network request for weights).
- **MD-N7-2** WHEN a weights file's hash differs from the registered one THE SYSTEM SHALL report `doctor` red for that model.
- **MD-N7-3** WHEN the shipped source is searched THE SYSTEM SHALL contain no absolute model path, external-volume path or user-specific directory.

### NEW-models-8 — engines as adapters, qualified per combination

*Justification:* on a team server the engine is a throughput choice and on a laptop a memory choice, so no engine is universal; and a configuration can pass a speed check while corrupting tool calls (vLLM #47194, prefix caching with MTP) — the Worker's only interface ([DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md)).

- **MD-N8-1** WHEN a model is assigned to a role on a host THE SYSTEM SHALL refuse to use it until that (engine, model build, host fingerprint, settings) combination has passed qualification, which includes tool-call validity, a multi-turn tool conversation and a recall check as well as speed.
- **MD-N8-2** WHEN speculative decoding (MTP or a draft model) is enabled THE SYSTEM SHALL have qualified that exact combination with prefix caching on, and SHALL disable it, recording why, if the qualification's tool-call checks fail.
- **MD-N8-3** WHEN the host profile is multi-user THE SYSTEM SHALL read the engine's parallel-slot or batch capacity from its qualification and SHALL NOT assume one request at a time.
- **MD-N8-4** WHEN any element of the qualified combination changes (engine build, template, speculative decoding, context size, KV type, slots, context version) THE SYSTEM SHALL mark the qualification invalidated with the changed element as the reason.
- **MD-N8-5** WHEN a draft model is configured for speculative decoding THE SYSTEM SHALL measure and decide it by the same A/B as MTP (MD-M11-1, MD-M11-2), keyed by the draft model as well.

### NEW-models-9 — one scheduler owns residency

*Justification:* the integration review measured ten evictions where four were needed (4–12 minutes a run), an escalated retry that could load the Worker beside a 12 GB model on a 24 GB host, three adapters on the same weights reloading on every `num_ctx` change, and a dashboard path that loads models with no footprint check (C1–C4; suggestions 1 and 10; target scheduler; ruling R20).

- **MD-N9-1** WHEN two roles are served by the same weights THE SYSTEM SHALL construct one adapter for them with the largest context either needs, and a request from either SHALL NOT reload the model.
- **MD-N9-2** WHEN work for a role whose model is not resident arrives THE SYSTEM SHALL queue it, and SHALL swap models in the order the residency plan and the waiting queues give, not per request (a test with four Researcher and four Planner questions interleaved observes at most two swaps per batch).
- **MD-N9-3** WHEN a load would put the resident footprint plus the new model above usable memory, or a footprint is unknown, THE SYSTEM SHALL refuse the load and keep the work queued, naming both footprints.
- **MD-N9-4** WHEN the dashboard, the PM's chat or any other caller needs a model THE SYSTEM SHALL obtain it through the scheduler, and no production code outside it SHALL construct or load a model adapter (a search test).
- **MD-N9-5** WHEN every model fits the host THE SYSTEM SHALL keep them all resident and drain every queue as work arrives.

### NEW-models-10 — adopting a model is a measured decision

*Justification:* published numbers are upper bounds (the same 35B-A3B family scores 73.4 on SWE-bench Verified by its card and 24.7% on SWE-rebench), and model churn silently changes results nobody measured ([research](../../research/DESIGN_RESEARCH_TEAM_SERVER.md)).

- **MD-N10-1** WHEN a new model is proposed for a role on a host THE SYSTEM SHALL require a recorded bake-off on the frozen suite on that host before the assignment takes effect, and SHALL refuse the assignment without one.
- **MD-N10-2** WHEN a role's model is replaced THE SYSTEM SHALL keep the previous assignment, and `sekhemet models restore <role>` SHALL restore it in one command.

## 6. v1 acceptance

This spec is `built` when §5 passes and these stay under test:

- **MD-1** WHEN a launch would use 4-bit KV for a tool-calling model THE SYSTEM SHALL refuse it with `KvPolicyError`.
- **MD-2** WHEN a model's chat template checksum changes THE SYSTEM SHALL mark its qualification invalidated.
- **MD-3** WHEN swap in use exceeds 6 GB, or has grown 2 GB since the card started THE SYSTEM SHALL refuse the next turn and stop the card with `memory_pressure`.
- **MD-4** WHEN the watchdog sees pressure rise THE SYSTEM SHALL escalate on the first such sample and de-escalate only after the configured number of calmer samples.
- **MD-5** WHEN a role's model is absent THE SYSTEM SHALL use its named fallback and say so on the card.
- **MD-6** WHEN the Worker weights are missing from the models directory THE SYSTEM SHALL report `doctor` red before any other check is reported green.
- **MD-7** WHEN a request carries a token callback THE SYSTEM SHALL deliver each streamed delta to it and still return the full reply and its usage.
- **MD-8** WHEN a server answers `/health` as loading THE SYSTEM SHALL report the model as loading, not dead.
- **MD-9** WHEN the Planner is asked for a plan THE SYSTEM SHALL send the planning sampling (temperature 0.7, top_p 0.8) and `min_p` 0; for code, temperature 0.2 and top_p 0.9.

## 7. Later

- **Cloud models per role** — after v1, optional and per role, never as a silent fallback.
- **An MLX engine path** (unified-memory reuse, MTPLX native MTP heads). Only an engine label exists (`bakeoff.ts:17`); an adapter comes only if the engine measurement favours it on Apple Silicon.
- **vLLM or SGLang as the multi-user engine** — *proposed, need the owner's yes* (Apache-2.0, separate processes); rule 14 keeps the adapter boundary so adding one changes no other code. Per-tenant token quotas beyond fair share, Kubernetes deployment and autoscaling are out: a team server is one machine in v1.
- **The ceiling run** — the frozen suite once with a frontier model as Worker, only after local v1 meets the Definition of Done ([DEC-07](../DECISIONS.md#dec-07)); measurement only.
- **Replacing the Worker's weights.** The project's research rates Cyber-Tiel "not recommended" and names Tiel-Coder-35B-A3B-MTP as a same-size guardrailed drop-in; the owner kept Cyber-Tiel (DEC-04). A swap is a new decision with its own suite run.
- **A multi-machine inference pool**, and a local verifier model ranking passing samples (only if it beats gate-only selection at equal wall-clock, and only with an anchor set calibrating it — a learned scorer drifts without one, arXiv:2608.12564).
- **A smaller Researcher.** Spark-X2.5-4B (Apache-2.0, 2.6–4.4 GB GGUF, needs llama.cpp b10828 or later) and NeoHorse-1-4B are candidates to replace Apodex-1.1-mini (~16 GB at IQ3_M) as the Researcher, which would let it stay loaded beside the Worker — *proposed; decided by one bake-off of both against the incumbent, never from vendor tables*.
- **Rejected:** KV-cache eviction by random scoring (arXiv:2609.03430) — its gains are batch-128 datacentre gains, its failure mode (a fact stated once, never restated) is a tool loop's normal case, and it needs a forked engine; a learned tabular predictor for competence (LimiX-2) — a second resident model and an unreadable router; local LoRA or RL on the repository's history — too little data, too much forgetting.
- **Initialising difficulty and routing from public data** (SWE-bench annotations) — [measurement.md](measurement.md) says what may and may not be imported.

## 8. Open questions

1. **Keep or cut `schedule.ts`** (NEW-models-3). *Recommendation:* wire it in — declared hours are the non-developer's guarantee that the harness will not load a 13 GB model while they are working — and cut the exports no command reaches.
2. **Where MTP is decided when the thinking A/B picks `all`.** Decode matters far more under `all`. *Recommendation:* run the MTP A/B after the thinking A/B picks its winner, only for that policy, so one measurement decides the shipped default.
3. **Measurement tools.** `llama-bench` for the throughput and MTP repetitions (MIT) — *proposed, needs the owner's yes*; it gives repetitions with standard deviations on the same build.
4. **The multi-user engine (owner decision).** *Recommendation:* keep llama.cpp as the only v1 engine adapter and the single-user default; approve vLLM as the first multi-user adapter when the company-server mode is built, qualified per combination with MTP off until its prefix-caching fix lands and is re-qualified.

## 9. Evidence and rationale

- Review: [domain05_10_models_measurement.md](../../reference/reviews/domain05_10_models_measurement.md) (Domain 5).
- Candidates and hardware: [MODEL_CANDIDATES.md](../../research/MODEL_CANDIDATES.md) (the M4 24 GB practical budget of ~14–15 GB for weights, KV and buffers; decode estimates).
- Research: [WEB_RESEARCH_2026-09.md](../../research/WEB_RESEARCH_2026-09.md) group A Q2 (MTP: [llama.cpp #22673](https://github.com/ggml-org/llama.cpp/pull/22673), about 1.28× decode on 35B-A3B with 2 draft tokens and a prefill penalty; a 24→2 tok/s collapse past Metal's working set, [#23011](https://github.com/ggml-org/llama.cpp/issues/23011); the [RTX 3090 study](https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090)) and group D §A (Cyber-Tiel's provenance and card warnings), §D (models for 24 GB), §E (abliteration and agent safety).
- Decisions: [DEC-03](../DECISIONS.md#dec-03) (local in v1), [DEC-04](../DECISIONS.md#dec-04) (Worker weights), [DEC-05](../DECISIONS.md#dec-05) (roles, not personas), [DEC-07](../DECISIONS.md#dec-07) (ceiling run after DoD), [DEC-22](../DECISIONS.md#dec-22--rejected-techniques) (KV eviction, tabular competence model, hard schema constraints by default, routing fitted to public results: rejected).
- Papers: [PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md) — NeoHorse-1 (arXiv:2609.08183: prediction/decision/outcome fields), Spark-X2.5-4B and NeoHorse-1-4B (Researcher candidates), Random Attention (arXiv:2609.03430, rejected), LimiX-2 (arXiv:2609.17488, rejected), WMRL (arXiv:2608.12564, anchors for any learned scorer).
- Public data: [PUBLIC_DATA_SURVEY.md](../../research/PUBLIC_DATA_SURVEY.md) verdicts 1 and 2 (difficulty prior only; routing from the local ledger).
- Register: [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md) R4 (per-model tool-call format, threshold 5 points of tool-call validity; recorded as adopted but never benched for the Worker). Format tax: arXiv:2408.02442.
- Quantisation: Jang et al. (arXiv:2607.27275) via [WEB_RESEARCH_2026-09.md](../../research/WEB_RESEARCH_2026-09.md) group D §D; SWE-rebench window scores, group D §B.
- Built history: [IMPLEMENTATION_AUDIT.md](../../research/IMPLEMENTATION_AUDIT.md) (swap safety, role batching, slot cache; the 128 GB Linux node's PSI memory reading).
- Research: [DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md) — engines as adapters (LLMKube bake-off: vLLM 345–377 tok/s against llama.cpp's 94–133 at 64 concurrent requests on two consumer GPUs; llama.cpp reached a 65k context against vLLM's 16k), MTP with prefix caching ([vLLM #47194](https://github.com/vllm-project/vllm/issues/47194), [PR #50172](https://github.com/vllm-project/vllm/pull/50172)), batch size as a host property, adoption by bake-off. Integration review ([reviews/integration_review_2026-09-18.md](../../reference/reviews/integration_review_2026-09-18.md)) C1–C4 and the target scheduler. [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decision 2 (person-built attempts out of the competence model).
- *Changed on purpose:* MTP's claimed 1.6×–2.6× decode speed-up was withdrawn — about 1.28× decode with a prefill penalty was measured, and agent turns are mostly prefill (rule 13); weights are never downloaded without an explicit command (ruling R7); the three watchdog stages of 85/90/94% became four levels driven by kernel pressure and swap growth, with the used-memory ratios kept as triggers (rule 19).
