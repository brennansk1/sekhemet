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
  - apps/harness/tests/doctor_weights.spec.ts
  - apps/harness/tests/calibrate_cmd.spec.ts
changes: [M4, M7, M11, NEW-models-1, NEW-models-2, NEW-models-3, NEW-models-4, NEW-models-5, NEW-models-6, NEW-models-7]
---

# Models: hardware, the registry and inference

## 1. Purpose

This subsystem runs the local models: it measures the machine, obtains and verifies the weights, launches and supervises the inference server, keeps the machine out of swap, and records which model, on which settings, is qualified for which role. It serves the product's promise that **v1 inference is 100% local**, and the spine rule that a result means something only with the settings that produced it: a number without its settings is not admissible.

## 2. Behaviour

### The v1 models

1. **In v1 every model runs on the user's machine** ([DEC-03](../DECISIONS.md#dec-03)). Cloud models are a planned post-v1 option per role, never a silent fallback.
2. **The Worker is Cyber-Tiel-Coder-35B-A3B MTP at IQ3_XXS** ([DEC-04](../DECISIONS.md#dec-04)): 16,384-token context, 4,096-token answer cap, sampling from its model card (temperature 0.6, top_p 0.95, top_k 20, min_p 0), served by llama-server on port 8098 with `--jinja`, flash attention and KV at `q8_0`. It is uncensored (abliterated); the model's own card demands OS-level sandboxing, so the sandbox and permission layer is the only defence against destructive actions and every security item is v1-blocking ([security.md](security.md)).
3. The managed defaults for the other roles are Dirk-Qwen3.8-27B (IQ3_S) as Planner and Apodex-1.1-mini (IQ3_M) as Researcher. Shipped source names model **files**, never locations.

### Getting the weights

4. **Named defaults are fetchable.** Each default model has an acquisition source recorded in the component register and a SHA-256, and the harness can download and verify it. A default with no acquisition path is not a default.
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
11. Sampling parameters, context window and reasoning support are stored **per model in the registry** and read from it; factories only supply defaults for an empty registry.
12. Chat templates are pinned per model build by SHA-256; a template change invalidates that model's qualification.
13. **MTP (speculative decoding) is off until measured** on this host, per thinking policy. The measurement is an A/B on the same GGUF and the same server build, MTP on against off, replaying real Worker turn prompts, reporting prefill seconds, decode seconds and total seconds per turn separately, the draft acceptance rate and tokens per verify step, and the Metal working set. MTP uses two draft tokens (`--spec-draft-n-max 2`). It is enabled only where it lowers seconds per turn; the decision is recorded in the registry with the host fingerprint and the thinking policy it was measured under. MTP speeds decode only and slows prefill, and agent turns are mostly prefill, so decode speed-up alone never justifies it.
14. **Engine selection.** llama.cpp's server over HTTP is the baseline everywhere; an MLX path is available on Apple Silicon; Ollama is supported as a client. Choice is by measurement per machine, weighting cross-turn cache retention above raw decode speed.
15. **Server identity.** Before adopting a server already listening on a managed port, the adapter reads its `/props` and refuses it unless the loaded model path (and, for the managed Worker, the context size and MTP state) matches the profile. The evidence records the running server's reported settings and build, never the adapter's intended ones.
16. Per turn, the adapter records prompt, cached, evaluated, thinking and answer tokens, `finish_reason`, and the draft statistics when speculative decoding is on.
17. The Worker server is started once and every card attaches to it; the harness never unloads a model another card is about to use. A model loaded from a slow external drive takes minutes, so load time is reported separately from card time.

### Memory safety

18. Memory pressure is read from the OS: the kernel pressure level and swap on macOS, PSI on Linux. Before each turn the harness checks headroom and refuses the turn when swap in use exceeds 6 GB or has grown more than 2 GB since the card started; the card then stops with `memory_pressure`.
19. A watchdog polls every 2 s on every path that runs cards (`run`, `queue`, the daemon) and escalates through levels, each adding actions: **elevated** — suspend MTP at the next launch, stop new worktrees, shorten keep-alive; **high** — also trim KV and prompt caches; **critical** — also pause, issuing no new turns until pressure falls; **emergency** — also unload the models. It escalates on the first sample that warrants it and de-escalates only after consecutive calmer samples, so it does not flap. Used-memory ratios of 0.85 and 0.94 mark warning and critical.

### Scheduling

20. The user declares the hours the machine is theirs; outside them the harness works the backlog. Model swaps are batched by project to preserve caches, and planning runs in scheduled blocks on tiers where the Planner and Worker cannot be co-loaded. The daemon and `overnight` apply this ([runtime.md](runtime.md)).

### Roles and the registry

21. The harness consults a model in four roles: **Worker** (executes cards), **Planner** (plans, decomposes and answers questions about the board; the PM persona Seshat speaks with the Planner's weights), **Reviewer** (reads a passing diff against its specification, from a different model family than the Worker), and **Researcher** (answers questions with cited sources). `vision` is a capability a model may hold, not a role. There is one role enumeration in code.
22. Roles are routing decisions, not agents or personas; the harness never simulates a conversation between them ([DEC-05](../DECISIONS.md#dec-05): agents never role-play ceremonies with each other; reports for people come from the one PM persona). One model may hold several roles, and on small machines usually does. Roles never co-reside below 32 GB.
23. A role whose model is absent degrades to a named fallback, never a failure: no Reviewer means the diff reaches the person unreviewed and the card says so; no Researcher means questions are answered from the repository alone.
24. A fifth role is added only when an existing one cannot be qualified for the work.
25. **The registry** is the harness's memory of what works on this machine: per model its identity, family, quant, size, context window, engine, template checksum, sampling, reasoning support, measured tool arm (with per-arm measurements), script capability, throughput per context bucket, qualification record and history, speculative decision and roles. It is keyed by host fingerprint, written atomically with a merge that never drops another writer's entry, and never written by tests.
26. **One construction path.** Every command that needs a model (`run`, `queue`, `bake-off`, `plan`, the PM) obtains it from the roster, which applies the registry, the tier cap and the engine decision; there is one `ModelProfile` record per model build.

### Qualification

27. A model is qualified, not chosen by reputation. The qualification suite uses the harness's own tool schemas and deterministic scoring (no model judge) and measures schema validity, tool selection, arguments, multi-turn recovery after an injected error, and refusal of an out-of-scope request. A model qualifies as Worker at a set pass rate on this internal suite — a bar not comparable to public leaderboards, set with multi-turn scores below single-turn in mind. An unqualified or invalidated model is not used as Worker without a recorded override.
28. **Tool arm.** Each model's tool interface is measured across three arms — A (`arm_a_flat`: native, flat tool calls, optionally grammar-constrained per model), B (`arm_b_json`: calls written as JSON in the reply, read by the tolerant parser) and C (`arm_c_sketch`: the tool chosen in natural language, with constraints only on the terminal payload) — and the registry pins the winner once it has at least `MIN_ARM_TRIALS` trials and beats the others by the register's pre-set bar (5 points of tool-call validity, R4). Grammar constraints help on terminal payloads (paths, identifiers, flags) and hurt on reasoning and high-level selection (the "format tax", 15–30% on small models), so hard schema constraints are never a default ([DEC-22](../DECISIONS.md#dec-22--rejected-techniques)); a model gets them only when its measurement says so. Until a model is measured, arm A without constraints is used and the evidence says the arm was not measured.
29. **Quantisation is measured, not assumed.** No public source measures IQ3 against Q4 on agentic coding, and INT4 has raised tool-name hallucination up to 2.5× at unchanged final scores; so every run records tool-call format errors and tool-name errors per turn, not only pass/fail.

### Per-repo bake-off

30. `sekhemet bake-off` runs candidate models under the real harness on tasks from the repository's own history: closed issues with their fixing commits become fail-to-pass tasks (a task is kept only if reverting the fix makes its test fail), and recent commits become reconstruction tasks. Every result carries its full settings (model, quant, tool arm, step budget, working context, engine, date), taken from the child run's evidence, not reconstructed afterwards.

### Card class and the competence model

31. `cardClass = "<kind>:<ext>"`. `kind` is one of seven, closed: `spike`, `interface`, `implement`, `data`, `rule` (the SPIDR five) and `review`, `research`. `ext` is the primary file extension of the declared scope, or `none`. It is knowable before the card runs and coarse enough to fill; tool sets key on `kind` alone, and budgets, routes and exemplars on the whole class. It is defined once, in the kernel.
32. Every card outcome writes a competence row: class, files touched, difficulty, model, arm, step budget and steps used, stop reason, gate failures, tokens and wall-clock — and, as three separate fields, the routing **prediction**, the **decision** taken and the **outcome**, so a row can say whether an escalation or a budget was necessary. Budgets and routes change from these rows only through the inlet rules in [measurement.md](measurement.md). Public outcome data may seed only the **task-difficulty** axis as a prior; the model × arm axis comes only from this machine's ledger, because public data has no tool-arm dimension and its pass rates are dominated by the scaffold that produced them (16.7% versus 47.9% on the same instances under two harnesses). If routing ever needs more than a mean with a Wilson interval, a logistic regression over the row's columns is the tool, not a learned tabular model.

## 3. Contract

| Item | Source |
| --- | --- |
| Managed profiles, `MANAGED_MODEL_FILES`, `createCyberTielWorker`, `launchArgs`, `cacheProfileForHost`, `mtpEnabled` | `packages/models/src/llama_server.ts` |
| HTTP adapter, usage parsing `usageFromLlamaServer`, `REASONING_BUDGET_TOKENS` (high 2,048) | `packages/models/src/http_adapter.ts` |
| Registry `ModelEntry`, `QualificationRecord`, `SpeculativeDecision`, `RegistryRole` | `packages/models/src/registry.ts` |
| Roles `ModelRole`, router | `packages/models/src/router.ts` |
| Roster (construction path) | `packages/models/src/roster.ts` |
| Tiers, usable memory, `THROUGHPUT_FLOORS`, `assertThroughputFloor`, `calibrateSpeculative` | `packages/models/src/calibration.ts` |
| KV policy `assertKvPolicy` | `packages/models/src/kv_policy.ts` |
| Weights `resolveModelsDir`, `probeModelWeights` | `packages/models/src/models_dir.ts` |
| Headroom (6 GB swap, 2 GB growth), `classifyMemoryPressure` (0.85, 0.94) | `packages/models/src/memory.ts` |
| Watchdog levels and actions, 2 s poll | `packages/models/src/watchdog.ts` |
| Qualification suite | `packages/models/src/qualification.ts` |
| Bake-off | `packages/models/src/bakeoff.ts` |
| Card class `cardKind`, `cardClass` | `packages/kernel/src/card_class.ts` |
| Competence rows `CompetenceEntry` | `packages/kernel/src/types.ts:520` |
| CLI: `sekhemet calibrate`, `doctor`, `bake-off`, `qualify`, `--models-dir`; env `SEKHEMET_MODELS_DIR`, `SEKHEMET_LLAMA_SERVER`, `SEKHEMET_SLOT_CACHE` | `apps/harness/src/index.ts`, `wave2.ts` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Worker profile (D1) and managed server on 8098 | built | `llama_server.ts:518-535`; `launch_profiles.spec.ts` | — |
| Weights resolved by `--models-dir`; doctor checks existence and readability | built | `models_dir.ts`; `doctor.ts:197`; `doctor_weights.spec.ts` | — |
| Weights fetchable and hash-verified | not-built | no acquisition path; hash kept only in the air-gap manifest (`models_dir.ts:62`) | NEW-models-7 |
| Calibration command and machine profile | partial | `sekhemet calibrate` exists; never run on the reference host (no `~/.sekhemet/machine.json`) | NEW-models-1 |
| Tier of the reference host | not-built | usable ⅔ × 24 GB = 16 GB puts the 24 GB host in tier S (`calibration.ts:296`, `:187`); `roster.tuned()` would cut the window to 12,288 (`roster.ts:150-172`) | NEW-models-1 |
| Throughput floors refuse cards | not-built | `assertThroughputFloor` has no production caller | NEW-models-2 |
| KV policy (no 4-bit for tool calling) | built | `kv_policy.ts`; `llama_server.ts:255` | — |
| Template pin and invalidation | built | `registry.ts`; `registry_calibration.spec.ts` | — |
| Sampling, window, reasoning read from the registry | not-built | hard-coded in five factories (`roster.ts:45-78`; `llama_server.ts:534`, `589`, `677`; `http_adapter.ts:1178`) | NEW-models-4 |
| MTP off until measured; two draft tokens; decision per host and policy | not-built | Worker ships `mtp: true` (`llama_server.ts:532`); `calibrateSpeculative` never run | M7, M11 |
| Refuse a foreign server (`/props`) | not-built | adopts anything answering `/health` (`llama_server.ts:374-383`) | M4 |
| Per-turn provenance: server settings/build, `finish_reason`, draft stats; real harness commit | not-built | `usageFromLlamaServer` captures none of these (`http_adapter.ts:338`); `harnessCommit(repoRoot)` is the fixture's HEAD (`card_runner.ts:1549`) | M4 |
| Headroom check (6 GB / 2 GB) | built | `memory.ts:158-190`; `memory.spec.ts` | — |
| Watchdog levels and actions | partial | `watchdog.ts`; wired into `queue` only (`index.ts:1298`) | NEW-models-2 |
| Declared hours, swap batching by project | partial | `overnight` runs; `isUserTime`, `nextWorkWindow` unreachable (`schedule.ts`) | NEW-models-3 |
| One role enum; one profile record; one construction path | not-built | three role vocabularies (`registry.ts:13`, `router.ts:20`, the design); `run` builds its adapter inline and an Ollama tag skips the roster (`index.ts:1122-1128`) | NEW-models-4 |
| Registry keyed by host; safe merge; tests isolated | not-built | test entries `"a"`, `"b"` leaked into the real `~/.sekhemet/models.json`; default path is the home directory (`registry.ts:75`) | NEW-models-4 |
| Qualification suite | built | `qualification.ts`; `qualification_schedule.spec.ts`; `sekhemet qualify` | — |
| Qualification gates Worker use | not-built | `isQualified` has no caller (`registry.ts:192`) | NEW-models-4 |
| Tool arm measured and pinned | not-built | registry field exists; no measurement for the Worker; default `arm_a_flat` | NEW-models-5 |
| Bake-off under the real harness | partial | `bakeoff.ts`; settings rebuilt after the child ran (`index.ts:1044-1053`) | NEW-models-4 |
| Card class definition | built | `card_class.ts` | — |
| Competence rows | partial | `CompetenceEntry` has no prediction/decision/outcome split; no gate failures | NEW-models-6 |
| Watchdog, roster, residency tests on real sockets | built | `watchdog.spec.ts`, `residency.spec.ts`, `router_swap.spec.ts` | — |

## 5. Changes for v1

### M4 — provenance: what produced a result

- **MD-M4-1** WHEN a server already listens on a managed port and its `/props` reports a different model path THE SYSTEM SHALL refuse to adopt it and say which model is loaded; WHEN the model matches but the context size or MTP state differs from the profile, it SHALL refuse the same way.
- **MD-M4-2** WHEN a card's evidence is compiled THE SYSTEM SHALL record the harness repository's commit and dirty flag and a hash of the built `dist` directories — never the target repository's HEAD as the harness commit.
- **MD-M4-3** WHEN a card's evidence is compiled THE SYSTEM SHALL record the running server's reported model, context, KV type, MTP state and build as read from `/props`.
- **MD-M4-4** WHEN a turn completes THE SYSTEM SHALL record `finish_reason`, thinking tokens, answer tokens, cached and evaluated prompt tokens, tool-call format errors and unknown-tool-name errors, and, with speculative decoding on, drafted and accepted token counts.

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

### NEW-models-3 — declared hours and swap batching

*Justification:* the design's scheduling is half-unreachable (`isUserTime`, `nextWorkWindow`); either it is wired in or cut (owner decides).

- **MD-N3-1** WHEN the current time is inside the user's declared hours THE SYSTEM SHALL NOT start a backlog card unattended, unless the card is marked urgent.
- **MD-N3-2** WHEN the queue holds cards from two projects THE SYSTEM SHALL run each project's cards together before swapping models, unless a dependency forces the order.

### NEW-models-4 — one profile, one role enum, one construction path, a live registry

*Justification:* three role vocabularies, sampling hard-coded in five places, three construction paths with different settings, and qualification that gates nothing.

- **MD-N4-1** WHEN the source is searched THE SYSTEM SHALL define one role type (`worker`, `planner`, `reviewer`, `researcher`) and one capability flag `vision`, and no other role enumeration.
- **MD-N4-2** WHEN a registry entry sets sampling, window or reasoning for a model THE SYSTEM SHALL use those values in the request, overriding the factory default (a test changes the registry and observes the request).
- **MD-N4-3** WHEN `run`, `queue`, `bake-off`, `plan` or the PM needs a model, including by an Ollama tag THE SYSTEM SHALL obtain it from the roster.
- **MD-N4-4** WHEN the Worker model's qualification is missing, failed or invalidated THE SYSTEM SHALL refuse to run cards with it unless a person recorded an override, and the evidence SHALL say so.
- **MD-N4-5** WHEN tests run THE SYSTEM SHALL write no file under the user's home `.sekhemet`, and a registry write SHALL preserve entries written by another process since it was read.
- **MD-N4-6** WHEN a bake-off child finishes THE SYSTEM SHALL report the settings recorded in the child's evidence.

### NEW-models-5 — tool-arm qualification

*Justification:* "which tool arm wins" blocks the product thesis and has never been measured for the Worker.

- **MD-N5-1** WHEN `sekhemet qualify` runs a model THE SYSTEM SHALL score arms A, B and C on the same tasks and record per-arm tool-call validity, pass rate and trials, and pin the winner only with at least `MIN_ARM_TRIALS` trials per arm and a lead of at least 5 points of tool-call validity whose interval excludes zero ([measurement.md](measurement.md) statistics).
- **MD-N5-2** WHEN a card runs with an unmeasured arm THE SYSTEM SHALL record `toolArm` with `measured: false` in the evidence.

### NEW-models-6 — competence rows that can improve routing

*Justification:* a row that records only the outcome cannot say whether an escalation or a budget was necessary.

- **MD-N6-1** WHEN a card finishes THE SYSTEM SHALL write a competence row with separate `prediction`, `decision` and `outcome` fields and the card's gate failures.

### NEW-models-7 — weights that a new user can obtain

*Justification:* a local-first harness whose defaults cannot be obtained does not run for anyone but its author.

- **MD-N7-1** WHEN a default model's file is missing THE SYSTEM SHALL offer to fetch it from its registered source (download is a user-confirmed action) and verify its SHA-256 before use.
- **MD-N7-2** WHEN a weights file's hash differs from the registered one THE SYSTEM SHALL report `doctor` red for that model.
- **MD-N7-3** WHEN the shipped source is searched THE SYSTEM SHALL contain no absolute model path, external-volume path or user-specific directory.

## 6. v1 acceptance

This spec is `built` when §5 passes and these stay under test:

- **MD-1** WHEN a launch would use 4-bit KV for a tool-calling model THE SYSTEM SHALL refuse it with `KvPolicyError`.
- **MD-2** WHEN a model's chat template checksum changes THE SYSTEM SHALL mark its qualification invalidated.
- **MD-3** WHEN swap in use exceeds 6 GB, or has grown 2 GB since the card started THE SYSTEM SHALL refuse the next turn and stop the card with `memory_pressure`.
- **MD-4** WHEN the watchdog sees pressure rise THE SYSTEM SHALL escalate on the first such sample and de-escalate only after the configured number of calmer samples.
- **MD-5** WHEN a role's model is absent THE SYSTEM SHALL use its named fallback and say so on the card.
- **MD-6** WHEN the Worker weights are missing from the models directory THE SYSTEM SHALL report `doctor` red before any other check is reported green.

## 7. Later

- **Cloud models per role** — after v1, optional and per role, never as a silent fallback.
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
