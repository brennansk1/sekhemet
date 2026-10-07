# Models

How Sekhemet chooses, fetches and verifies its local models. Moved here from the [README](../../README.md) on 2026-10-07 and brought up to date with the shipped set in `packages/models/src/shipped_models.ts`. The design is [models.md](../design/specs/models.md); model research, with every benchmark number sourced, is in [MODEL_CANDIDATES.md](../research/MODEL_CANDIDATES.md).

## The engine

Local models only in v1, served by llama.cpp's `llama-server`, build b10809 or later. `sekhemet doctor` names the build it found and what to do when it is missing or old. [INSTALL.md](INSTALL.md#the-inference-engine) gives the three ways to get it.

## Supported hardware

v1 supports machines with 24 GB of memory or more ([DEC-47](../design/DECISIONS.md#dec-47--the-finish-line-decisions) O-5): macOS on Apple silicon (Metal), and Linux x64 (CPU or Vulkan; CUDA and ROCm by building llama.cpp yourself). Below 24 GB, the first run and `init` say v1 does not support it and name no model as fitting; you may continue at your own risk. At 24 GB one large model is resident at a time, and the roles swap.

## The shipped set

The recommended set for 24 GB and above. Each file's source, SHA-256, size and licence are recorded in `shipped_models.ts` and in [PROVENANCE.md](PROVENANCE.md).

| Role | Model | File size | Licence | State |
| --- | --- | --- | --- | --- |
| Coding model | nail-mtp (Nail-Qwen3.6-35B-A3B MTP, UD-IQ3_XXS) | 14.1 GB | Apache-2.0 | Qualified on the 24 GB reference host (re-qualified 2026-10-06 at 99.3%) |
| Planning model | Qwen3.8-27B GSQ-RCO (IQ3_S, MTP head) | 12.1 GB | Apache-2.0 | Qualified on the 24 GB reference host (2026-09-30) |
| Research model | Apodex-1.1-mini (IQ3_M) | 16.0 GB | Apache-2.0 | Recommended; the file matches the reference host's copy, but no qualification is recorded yet |
| Review model | *Unfilled* | — | — | No candidate has reached the admission bar |

The three files total about 42 GB.

**The Review role ships unfilled.** A model is admitted for Review when it catches at least 0.3 of a 22-defect seeded set (RG-P8-13) and comes from a different family from the Coding model. No candidate has reached that bar: gpt-oss-20b caught 4 of 22 (0.18) and GLM-4.7-Flash 0 of 22 (DEV_LOG Entry 77); Gemma-4-26B-A4B was not admitted, and the rest of the bake-off waits on memory (Entry 83). Until a model is admitted, a change reaches you without an AI review, and its issue says so.

**The measurement baseline.** Cyber-Tiel-Coder-35B-A3B MTP is the profile the frozen suite and the B2.5 baseline measured. It keeps its verified source in the code, but it is not a shipped or recommended role.

**Re-qualification.** A change to a role's prompt or context version asks for verification again. The research change of [DEC-59](../design/DECISIONS.md#dec-59--research-like-an-engineer-notes-are-ledger-events-and-cited-data) changed the Coding model's context; nail-mtp was re-qualified for it on 2026-10-06 at 99.3% (every check 100% but multi-step at 90%, 16.9 tok/s; build 17e2d25).

## Fetching the set

Print the set's files, sizes and licences and the total to download, then download on your yes, each file verified by its published hash (this goes through the network policy, and a partial download resumes):

```bash
sekhemet models fetch --recommended --folder <models-folder>
```

With no terminal to ask, nothing is downloaded unless you add `--yes`. One role's model alone:

```bash
sekhemet models fetch --role coding --folder <models-folder>
```

## Your own models

Register any GGUF file. Its header is read and its SHA-256 recorded; the model is not loaded:

```bash
sekhemet models add <path-to.gguf>
```

Download a registered model from its recorded source, verified by its published hash:

```bash
sekhemet models fetch <model>
```

Assign a model to a role (`worker`, `planner`, `reviewer` or `researcher` are the internal names of the Coding, Planning, Review and Research models):

```bash
sekhemet models assign <role> <model>
```

Verify it for that role on this machine:

```bash
sekhemet qualify --models <model> --role <role>
```

A model is used for a role only once it is verified on this machine. A change to the role's prompt, the engine or the model's settings asks for verification again, and `sekhemet doctor` names anything owed. The Configuration page does the same from the dashboard.

## The reasoning floor

Some models cannot turn thinking off. The registry keeps a reasoning floor per GGUF architecture and adds the thinking budget to the reply budget, so a review is never cut off mid-thought and read as clean. A truncated or unreadable review counts as a failed review.

## Ollama

`sekhemet doctor` passes on an Ollama endpoint, and says which roles it serves, outside v1's statement that models are served by llama.cpp's `llama-server` (models rule 6d). Ollama's cloud models are refused: every role runs locally.
