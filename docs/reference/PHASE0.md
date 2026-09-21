# Phase 0: the go/no-go

The design opens its build phases with a sentence everything after it depends on: *"Nothing is built before the reliability spike answers whether a local model can execute a card unattended on this hardware. Everything downstream assumes it can."* This is the record of that measurement.

## Result, 2026-09-21

| | |
| --- | --- |
| **Verdict** | **GO** |
| Model | `nail-35b-a3b-ctx-16k` (Qwen3.5-35B-A3B, IQ3_S, 13 GB, 16k context) |
| Rate | **100.0%** valid-and-correct |
| Winning arm | `arm_a_flat` — though all three tied |
| Host | 24 GB Apple M4, Ollama |

Per arm, and per category on the winner:

| Arm | Rate | | Category | Rate |
| --- | --- | --- | --- | --- |
| `arm_a_flat` | 100.0% | | schema validity | 100.0% |
| `arm_b_json` | 100.0% | | tool selection | 100.0% |
| `arm_c_sketch` | 100.0% | | argument correctness | 100.0% |
| | | | multi-turn recovery | 100.0% |
| | | | refusal | 100.0% |

**What it means:** the Worker can be trusted to emit a valid, correct tool call. The product thesis holds, and the harness may be built as specified.

## What this measurement is not

A perfect score deserves the same suspicion as a catastrophic one, so the limits are stated here rather than left for a reader to discover.

**It is 11 cases, not 30 tasks.** The design's Phase 0 specifies thirty tasks against a real repository, each with a known-correct tool sequence, run three times across three arms at two step budgets. What ran is the qualification suite: eleven cases covering the five categories the design names, against a seven-tool catalog. That is the right *shape* at a fraction of the *scale*.

**It measures tool-call correctness, not task completion.** Whether the model can *solve* a card is a different question, downstream of this one, and answered by M0 and the frozen suite. A model that passes here can still fail every card. A model that failed here could not pass any, which is why this comes first.

**Three arms tying at 100% is itself a finding, and a soft one.** It means the cases do not discriminate between arms for this model — not that the arms are equivalent in general. Arm choice should still come from measurement on harder work, and the registry's per-arm records remain the place that lives.

**The tool catalog was the qualification set, not the live one.** The production catalog is roughly thirty tools; progressive disclosure exists precisely because the full set does not fit the prompt's zone-1 budget at small context. Correctness against seven tools is weaker evidence than correctness against thirty.

## Honest reading

The result is real and it is good news, but it is the *necessary* half of Phase 0 rather than the *sufficient* half. It rules out the failure that would have killed the product — a local model that cannot reliably call a tool — and it does not establish that a card completes.

The remaining half is the frozen suite and the end-to-end card run, which are steps 5 and 6 of [MVP_PATH.md](MVP_PATH.md).

## A hardware finding worth recording

The 13 GB model fits this 24 GB host, and only just. Running it required stopping six Docker containers and quitting Docker Desktop; during the run, free memory fell to about 2.5 GB before recovering, and the machine had roughly 1.4 GB of swap in use afterwards. An earlier attempt at the same model, with those containers running, drove the host close to out-of-memory.

**The reference machine can run the intended Worker, but not alongside much else.** That is a real constraint on the product, not a note about one afternoon: a user who keeps a browser, a container runtime and an editor open has materially less room than this measurement assumed. `runPhase0` now refuses to start without headroom for that reason.

## Reproducing it

```bash
node -e '
import("@sekhemet/eval").then(async ({ runPhase0, formatPhase0 }) => {
  const { HttpInferenceAdapter } = await import("@sekhemet/models");
  const adapter = new HttpInferenceAdapter({
    modelId: "<model>",
    baseUrl: "http://127.0.0.1:11434",   // Ollama native, NOT /v1
    contextTokens: 16384,
  });
  console.log(formatPhase0(await runPhase0(adapter)));
});'
```

**[BENCH]** The `/v1` suffix is the one mistake to avoid: the adapter speaks Ollama's `/api/chat`, and pointing it at an OpenAI-style path produces 0% across every arm and category — a result indistinguishable from a catastrophic verdict about the model. `runPhase0` now raises on an unreachable endpoint rather than scoring it, because this measurement is the one the whole product rests on.
