# Installing Sekhemet

One install path per audience ([surface](../design/specs/surface.md) item 31, NEW-surface-4; owner decision O9 in [DEC-29](../design/DECISIONS.md)). Neither artefact is published yet: each is built from this repository, and where it goes is the owner's decision.

## For one person: the npm package

```bash
pnpm install && pnpm build
node scripts/pack_npm.mjs --out packaging/out     # prints packaging/out/sekhemet-<version>.tgz
npm install --global packaging/out/sekhemet-<version>.tgz
```

The tarball bundles every dependency, so the install needs no registry and no build step (SUR-41). It needs Node.js 22.13 or newer ([surface](../design/specs/surface.md) item 5a). Then, in a repository:

```bash
sekhemet
```

That is the whole setup: the first run checks the machine, says which models it found, derives the gates from the project, asks once, and opens the board — or the Configuration page while no model is set up. `sekhemet --yes` does the same without a prompt and prints the address instead of opening a browser.

## The inference engine

Sekhemet runs its models on llama.cpp's `llama-server`, build b10809 or later — the build the shipped models were verified on ([models](../design/specs/models.md) rules 6a and 6b). The first run and `sekhemet doctor` say which `llama-server` they found, where it came from and its build. There are three ways to get one:

- **Get the inference engine**, on Configuration › Models, or `sekhemet engine get` in a terminal. It shows the pinned release (llama.cpp b10809, MIT licence), the file and its size, and only after your yes downloads that file from llama.cpp's own release on GitHub, checks it against the SHA-256 recorded in [PROVENANCE](PROVENANCE.md), and unpacks it into `~/.sekhemet/engines/` — nothing outside your Sekhemet folder, and no administrator rights. It is offered for macOS on Apple silicon (Metal) and for Linux on x64 (CPU, or Vulkan where a Vulkan driver is installed).
- **Homebrew**, on macOS: `brew install llama.cpp`.
- **Build it yourself**, for any other machine — Linux with an NVIDIA GPU (CUDA) or an AMD GPU (ROCm), for example. Follow llama.cpp's build guide (`docs/build.md` in the llama.cpp repository) for your backend, at release b10809 or later, then put `llama-server` on your `PATH` or name it with `SEKHEMET_LLAMA_SERVER=/path/to/llama-server`.

When several are installed, Sekhemet uses `SEKHEMET_LLAMA_SERVER` when it is set, otherwise the newer of the downloaded engine and the one on your `PATH` that is new enough.

## For a team: the server image

`packaging/server/Dockerfile` builds one image holding the harness, installed from the same npm tarball; `packaging/server/compose.yaml` runs it with the containers it needs beside it (SUR-42):

| Container | What it is |
| --- | --- |
| `identity-proxy` | The **identity-aware proxy** (oauth2-proxy in the example): it terminates TLS with the certificate and key you mount at `/tls` (`tls.crt`, the full chain, and `tls.key`; only its HTTPS listener, on 443, is published), signs people in with your OIDC provider and passes each person's email in `X-Forwarded-Email`. Sekhemet trusts that header only from the addresses listed in `[identity] trusted_proxies` of the server's user configuration ([integrations](../design/specs/integrations.md) item 24, [teams](../design/specs/teams.md) item 13). |
| `engine-coding`, `engine-planning`, `engine-research` | The **inference engines, one container per filled role** of the shipped set ([models](../design/specs/models.md) rules 3 and 26a): llama.cpp's server with that role's weights, started with exactly its profile's arguments. They join the harness's network namespace and are reached on loopback, as on a laptop; one whose model, context or MTP state differs from its profile is refused. The Review role is unfilled until a model is admitted for it, so it has no engine. |
| `sekhemet` | The harness: `sekhemet dev serve --host 0.0.0.0` over the repository mounted at `/work`, with its user directory in a volume. |

```bash
docker build -f packaging/server/Dockerfile -t sekhemet-server .
docker compose -f packaging/server/compose.yaml up
```

**GPU and memory** (MD-N15-4). The engines use llama.cpp build b10818, pinned by digest: `ghcr.io/ggml-org/llama.cpp:server-cuda-b10818` for NVIDIA GPUs (the compose file's default; it needs the NVIDIA Container Toolkit), `ghcr.io/ggml-org/llama.cpp:server-vulkan-b10818` for AMD or Intel GPUs through Vulkan, and `ghcr.io/ggml-org/llama.cpp:server-b10818` to run on the CPU (slow). To use another variant, replace each engine's `image` with the matching line from [PROVENANCE](PROVENANCE.md) and, for Vulkan, pass `/dev/dri` instead of the NVIDIA reservation. Every engine keeps its role resident, so their memory adds up:

| Engine service | Model | Memory it needs |
| --- | --- | --- |
| `engine-coding` | nail-mtp (14.1 GB file, 16k window) | 16.9 GB |
| `engine-planning` | Qwen3.8-27B GSQ-RCO (12.1 GB file, 8k window) | 14.3 GB |
| `engine-research` | Apodex-1.1-mini (16.0 GB file, two 32k slots) | 22.1 GB |
| Together | | 53.2 GB of GPU memory (system memory on the CPU image), plus up to 4 GB of system memory per engine for its prompt cache |

These are the harness's own footprint estimates (weights, KV cache and runtime overhead): keep their sum within the GPU memory free on the host.

In the server's user configuration (`/home/node/.sekhemet/config.toml` in the volume):

```toml
[identity]
sources = ["proxy"]
user_header = "x-forwarded-email"
trusted_proxies = ["<the proxy container's address>"]
```

Repository processes run confined by bubblewrap, which needs unprivileged user namespaces inside the container; the compose file relaxes seccomp and AppArmor for that one service. The image has not yet been built and run on a Linux host by this project: that check is owed before a release.

## From source

For developing the harness and for the air-gap kit, the source install of [DEC-21](../design/DECISIONS.md) remains: `pnpm install && pnpm build`, then `node apps/harness/dist/index.js`.
