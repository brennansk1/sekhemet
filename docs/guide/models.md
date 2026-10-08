# Models

Every model runs on your machine (or your team's server) in v1, served by llama.cpp's `llama-server`. Nothing is sent to a cloud model.

## The four roles

| Role | What it does | Recommended model | Size |
| --- | --- | --- | --- |
| **Coding model** | Builds each issue in its sandbox until the checks pass | nail-mtp | 14.1 GB |
| **Planning model** | Seshat's planning: the brief, the epics and stories, the acceptance tests | Qwen3.8-27B GSQ-RCO | 12.1 GB |
| **Research model** | Answers research questions from the documentation of the versions your project uses | Apodex-1.1-mini | 16.0 GB |
| **Review model** | Reviews each change against its acceptance criteria | *Unfilled in v1 for now* | — |

The three files are Apache-2.0 and total about 42 GB. The roles are not characters and never talk to each other; *Seshat* is the one persona, the name people talk to. The Review role ships unfilled until a model catches at least 0.3 of a 22-defect seeded set; until then a change reaches you without an AI review, and its issue says so. Details and the measurements: [MODELS](../reference/MODELS.md).

Sekhemet swaps models in and out of memory as the roles take turns, so a 24 GB machine runs one role's model at a time.

## Getting the recommended models

On the Configuration page, choose **Download…** on a model, or in a terminal:

```bash
sekhemet models fetch --recommended --folder ~/.sekhemet/models
```

It prints each file, its size and licence and the total, then asks before downloading anything. Each file is checked against its published SHA-256 before it is used, and a partial download resumes. The folder must exist (`mkdir -p ~/.sekhemet/models`); `~/.sekhemet/models` is the folder Sekhemet reads by default, and `SEKHEMET_MODELS_DIR` names another. Downloads go through the network policy: under the default `offline` mode the request is refused and the setting that allows it is named ([Privacy and network](privacy-and-network.md)).

## Using models you already have

Register any GGUF file; its header is read and its hash recorded, and it is not loaded:

```bash
sekhemet models add <path-to.gguf>
```

Then assign it to a role. The command names the roles by their internal names: `worker` (Coding), `planner` (Planning), `reviewer` (Review) and `researcher` (Research):

```bash
sekhemet models assign worker <model>
```

`sekhemet models list` shows what is registered and which role each fills.

## Verifying a model on this machine

A model is used for a role only once it is verified on this machine: a short qualification run that loads the model and checks it can do the role's work within the machine's memory.

```bash
sekhemet qualify --models <model> --role worker
```

`sekhemet doctor` names any verification still owed, with the command that runs it. A change to the role's prompt, the engine or the model's settings asks for verification again. The Configuration page does the same from the dashboard.

## The inference engine

Sekhemet needs `llama-server` from llama.cpp, build b10809 or later. Three ways to get it:

- **Get the inference engine** on Configuration › Models, or `sekhemet engine get`: on your yes it downloads the pinned llama.cpp release for your platform from llama.cpp's own GitHub release, checks its SHA-256 and unpacks it into your Sekhemet folder. No administrator rights.
- **Homebrew** on macOS: `brew install llama.cpp`.
- **Build it yourself** for a GPU the release does not cover (CUDA, ROCm), then put `llama-server` on your `PATH` or name it with `SEKHEMET_LLAMA_SERVER`.

`sekhemet engine status` says which `llama-server` is used and its build.

## Ollama

`sekhemet doctor` recognises an Ollama endpoint and says which roles it serves, but v1's verified path is `llama-server`. Ollama's cloud models are refused: every role runs locally.
