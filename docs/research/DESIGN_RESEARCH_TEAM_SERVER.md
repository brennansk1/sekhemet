# Design research: the team server, and distribution

*Web research by the lead, 2026-09-22, to close the design stage. Question: what must the design decide now so that the company-server mode ([DEC-06](../design/DECISIONS.md#dec-06)) and installing and upgrading Sekhemet do not force a structural rework later? The assumed team server is Linux with NVIDIA GPUs; individuals use Apple Silicon Macs. Sources were opened unless marked [search].*

## What the design must decide now

| Decision | Recommendation | Evidence | Spec | What breaks later if not decided |
| --- | --- | --- | --- | --- |
| The inference engine is a replaceable adapter, qualified per engine and host | Every engine is reached through one OpenAI-compatible adapter. llama.cpp is the Mac and single-user default; vLLM (and possibly SGLang) is the multi-user NVIDIA path. Each (engine, model, host) triple is qualified before use | vLLM gave 3–4× llama.cpp's throughput at 64 concurrent requests and 2–4× faster prefill on consumer NVIDIA GPUs; llama.cpp wins on long context on small VRAM | models.md | Engine-specific assumptions (a single slot, llama.cpp flags) spread through the loop and the context layout |
| Batch size is a property of the host, not a design constant | Keep the byte-stable, append-only prompt (it helps every engine's prefix cache); state that "batch one" holds only on the single-user profile; on a server, cache and memory budgets are per-slot | llama.cpp shares one batch across slots; vLLM and SGLang page or tree their caches | context.md, models.md, DECISIONS (DEC-22's KV-eviction rationale cites batch one) | The rejected-technique rationale and the cache flags silently become wrong on a server |
| MTP/speculative decoding is qualified per engine, never assumed | Off until measured on that engine; on vLLM, do not combine MTP with hybrid prefix caching until the known correctness bug is fixed | vLLM issue #47194 (open since 2026-06-30): prefix caching + MTP3 on a Qwen3.6 hybrid broke tool calls (2/10 succeeded), needle recall (0/10) and multi-turn tool use (0/5); the no-MTP path was correct. vLLM's own recipe: MTP-1 for low-concurrency latency, with lower throughput under load | models.md | A server silently runs a configuration that corrupts tool calls — the Worker's only interface |
| One scheduler owns the model and the queue, across people | Cards and conversations from several people and projects share a fair queue: per-person fair share, the PM's interactive replies ahead of batch Worker steps, and an aging rule so a long card is never starved | Multi-tenant serving work (VTC, FairServe, Equinox); Chimera's starvation counter promotes a request once it passes a threshold; llm-d flow control priority queues [search] | runtime.md, models.md | Retrofitting fairness means re-keying every queue and lease by person and project |
| The runner lease and parallel cards | On a server, N cards may run at once (N from the qualified engine and memory), each in its own worktree and sandbox; the lease is per slot, not global | llama.cpp's `--parallel` slots, reported workable at 8–16 on one H100 [search]; vLLM continuous batching | runtime.md | The single global lease (COVERAGE runtime findings) becomes the bottleneck and a correctness risk |
| Packaging: one artefact per audience | Individuals: an npm package and, once stable, a single executable. Servers: a container image with the harness, a reverse proxy slot for the identity proxy, and the inference engine as a separate container | Node's single-executable build became one step (`--build-sea`, Node 25.5); SEA is still marked "active development" in the docs; `node:sqlite` is built in, so no native addon complicates bundling | surface.md, runtime.md | A second install path appears ad hoc, as three setup paths did before (domain 1 review) |
| Upgrades migrate data, never lose it | Numbered, forward-only schema migrations that preserve the hash chain (kernel NEW-kernel-4), a config migration step, a backup before every migration, and a refusal to start on a database newer than the binary | Standard practice; the kernel review found migrations ad hoc | kernel.md, surface.md | A user's ledger is stranded by an upgrade |
| Adopting a new model is a measured decision | A new local model enters a role only after a bake-off on the frozen suite on that host, recorded; the previous model stays one command away | The project's own bake-off; research group D (published numbers are upper bounds) | models.md, measurement.md | Model churn silently changes results nobody measured |

## Findings

**Multi-user local inference.**
- On two consumer NVIDIA GPUs with Qwen3.6-27B at 64 concurrent requests, [LLMKube](https://llmkube.com/blog/qwen3-6-27b-bakeoff) (2026-04-23) measured vLLM at 345–377 tok/s against llama.cpp's 94–133. Time to first token was 106–581 ms on vLLM and 208–2,279 ms on llama.cpp. llama.cpp with KV compression reached a 65k context against vLLM's 16k.
  - *Implication:* on a team server the engine choice is a throughput choice; on a laptop it is a memory choice. Neither is universal, so the engine must be an adapter.
- llama.cpp's server gathers work from all slots into one shared batch. A crash under parallel load on Qwen3.5/3.6 hybrids was fixed upstream in March 2026 ([ollama#17144](https://github.com/ollama/ollama/pull/17144) citing llama.cpp PR #20232).
  - *Implication:* parallel slots on this model family are recent; qualify them.
- vLLM's [Qwen3.5/3.6 recipe](https://docs.vllm.ai/projects/recipes/en/stable/Qwen/Qwen3.5.html) requires `--mamba-cache-mode align` for prefix caching on gated-DeltaNet layers, and recommends MTP-1 only at low concurrency. [Issue #47194](https://github.com/vllm-project/vllm/issues/47194) shows prefix caching combined with MTP3 corrupting tool calls; a fix for all-mode caching with MTP is still in review ([PR #50172](https://github.com/vllm-project/vllm/pull/50172)).
  - *Implication:* tool-call correctness is part of qualification, not only speed. A qualification suite must include tool-call and multi-turn checks.
- SGLang's tree-structured prefix cache favours agent loops with shared prefixes. Its vendor-reported gains are largest on prefix-heavy workloads [search].
  - *Implication:* Sekhemet's stable prompt prefix is exactly the case prefix caches reward. Keep it; it pays on every engine.

**Fairness and priority.**
- Fair LLM serving (VTC, FairServe, Equinox) balances service across tenants, and token-level latency fairness is an active topic ([2609.18112](https://arxiv.org/html/2609.18112)).
- Pure priority scheduling starves long requests; [Chimera](https://arxiv.org/pdf/2603.22206) promotes a request whose starvation count passes a threshold.
- *Implication:* the scheduler needs three rules, all testable: fair share per person, interactive-first, aging.

**Distribution.**
- Node 25.5 added `--build-sea` for one-step single executables ([Node blog](https://nodejs.org/en/blog/release/v25.5.0); [Cheung, 2026-01-26](https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js/)). The feature is still "active development" in the [docs](https://nodejs.org/api/single-executable-applications.html).
- `node:sqlite` is built in, so there is no native build step.
- *Implication:* a single executable is viable soon. v1 ships the npm package and the server container, with the single executable as a proposal once the feature is stable.

## Proposed requirements

**models.md**
- WHEN a model is assigned to a role on a host THE SYSTEM SHALL refuse to use it until that (engine, model, host, settings) combination has passed qualification, which includes tool-call validity, a multi-turn tool conversation and a recall check as well as speed.
- WHEN speculative decoding (MTP or a draft model) is enabled THE SYSTEM SHALL have qualified that exact combination with prefix caching on, and SHALL disable it if the qualification's tool-call checks fail.
- WHEN a new model is proposed for a role THE SYSTEM SHALL require a recorded bake-off on the frozen suite on that host, and SHALL keep the previous assignment restorable with one command.
- WHEN the host profile is multi-user THE SYSTEM SHALL read the engine's parallel-slot or batch capacity from qualification and SHALL not assume one request at a time.

**runtime.md**
- WHEN two or more people have work queued THE SYSTEM SHALL schedule model time by fair share per person, SHALL run interactive PM replies ahead of Worker steps, and SHALL promote any request that has waited longer than a configured bound ahead of both.
- WHEN the qualified capacity allows N concurrent cards THE SYSTEM SHALL run at most N, each holding its own slot lease, worktree and sandbox, and SHALL never let two cards write the same file.
- WHEN the harness starts on a database whose schema is newer than it knows THE SYSTEM SHALL refuse to start and say which version is needed; WHEN it is older THE SYSTEM SHALL back it up, migrate it forward and verify the hash chain before serving.

**surface.md**
- WHEN Sekhemet is installed for one person THE SYSTEM SHALL install from one npm package with one first-run path; WHEN it is installed as a team server THE SYSTEM SHALL be deployable from one container image whose documentation names the identity proxy and the separate inference container.

## Proposals (the owner decides)

| Proposal | Licence | Maintenance | Adds |
| --- | --- | --- | --- |
| vLLM as the multi-user NVIDIA engine (a separate process over its OpenAI-compatible API) | Apache-2.0 | Very active | Server throughput |
| SGLang as an alternative engine | Apache-2.0 | Very active | Prefix-heavy agent loops |
| A container image for the server (Docker or Podman; OCI) | — | — | One server install path |
| Node single executable, once no longer "active development" | Node core | Node core | One-file install for individuals |

## Later

- Multi-machine inference pooling (already not in v1).
- Kubernetes deployment and autoscaling: a team server is one machine in v1.
- Per-tenant token quotas beyond fair share: fair share with aging is enough for one team.
