# Install

Sekhemet runs on macOS on Apple silicon and on Linux x64, with 24 GB of memory or more. Until the npm package is published with the public pre-release 0.9.0, it installs from source; both ways are below. A team server is installed from its container image instead: see the [Team administrator's guide](team-admin.md).

## What you need

| | |
| --- | --- |
| **Operating system** | macOS on Apple silicon, or Linux x64 (Ubuntu 24.04 is the Linux this project tests on). Windows is not supported in v1. |
| **Memory** | 24 GB or more. 16 GB is not supported in v1: the Coding model alone is about 14 GB. |
| **Disk** | About 45 GB free for the recommended models, plus room for your projects. |
| **Node.js** | 22.13 or newer (the built-in `node:sqlite`). |
| **git** | Any recent version. |
| **pnpm** | 10, for the source install only. |
| **Inference engine** | llama.cpp's `llama-server`, build b10809 or later. Sekhemet can get it for you (below). |
| **Linux only** | `bubblewrap` (the sandbox) and `socat` (the issue's network relays). |

## What you download, and how big it is

| What | Size | When |
| --- | --- | --- |
| The recommended models: the Coding, Planning and Research models | about 42 GB (14.1 + 12.1 + 16.0 GB) | Only on your yes; Sekhemet prints each file, its size and licence and the total first |
| The inference engine (llama.cpp b10809) | 11 MB on macOS; 17 MB (CPU) or 34 MB (Vulkan) on Linux | Only on your yes, or install it yourself |
| Sekhemet's own packages, for a source install | about 160 MB on disk after `pnpm install` | When you install |

**About 42.5 GB in all,** almost all of it the models. You can skip the model download entirely by registering GGUF files you already have ([Models](models.md)).

## macOS

1. Install Node.js 22.13 or newer from [nodejs.org](https://nodejs.org) or your package manager, and git (the Xcode command-line tools include it).
2. Install pnpm 10: `npm install --global pnpm@10`.
3. Get the source and build it:

   ```bash
   git clone https://github.com/brennansk1/sekhemet.git
   cd sekhemet
   pnpm install
   pnpm build
   alias sekhemet="node $PWD/apps/harness/dist/index.js"
   ```

   Put the `alias` line in your shell's profile to keep it. pnpm may warn that it ignored the build scripts of `@biomejs/biome` and `esbuild`; Sekhemet does not need them to run.
4. Check the machine: `sekhemet doctor`. Each check that does not pass prints `Do:` with its next step; [Troubleshooting](troubleshooting.md) lists them all.

The sandbox needs nothing extra on macOS: Seatbelt is built in. For the engine, `sekhemet engine get` downloads the pinned release on your yes, or `brew install llama.cpp` installs it with Homebrew.

## Ubuntu (and other Linux)

1. Install the system packages:

   ```bash
   sudo apt install git bubblewrap socat
   ```

   `bubblewrap` confines every command the Coding model runs; `socat` gives an issue its network relays (without it, an issue's own dev-server ports get no route, and `doctor` says so).
2. Install Node.js 22.13 or newer (your distribution's package may be older: use [nodejs.org](https://nodejs.org)'s packages or a version manager), then pnpm 10: `npm install --global pnpm@10`.
3. **Ubuntu 24.04 and later:** AppArmor stops bubblewrap from creating the namespaces it needs until a profile allows it. `sekhemet doctor` says so, and every command is refused until the profile is in place. Add it once:

   ```bash
   printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' 'profile bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '}' | sudo tee /etc/apparmor.d/bwrap
   sudo apparmor_parser -r /etc/apparmor.d/bwrap
   ```

4. Get the source and build it, as on macOS (step 3 above), then run `sekhemet doctor`.

For the engine, `sekhemet engine get` downloads llama.cpp's own Linux build (CPU, or Vulkan where a Vulkan driver is installed). For an NVIDIA or AMD GPU, build llama.cpp yourself with CUDA or ROCm at release b10809 or later and put `llama-server` on your `PATH`, or name it with `SEKHEMET_LLAMA_SERVER`.

Linux is supported in v1. Its containment suite passed the B1 milestone in an Ubuntu 24.04 virtual machine; because the sandbox changed since, B1 is run again on the release candidate ([MILESTONES](../reference/MILESTONES.md)).

## The npm package (from 0.9.0)

Once published, a person installs one package, which bundles every dependency:

```bash
npm install --global sekhemet
```

It needs Node.js 22.13 or newer and no build step. Until then, `node scripts/pack_npm.mjs` builds the same package from a checkout ([INSTALL](../reference/INSTALL.md) § *For one person*).

Why npm and source only: Sekhemet's licence (FSL-1.1-ALv2, source-available) is not one that Homebrew's core formulae or Linux distributions' repositories accept, so there is no `brew install sekhemet` or `apt install sekhemet`. See the [FAQ](faq.md).

## Next

Go to your project's folder and run `sekhemet`: [First run](first-run.md). The full operator detail — every path, the engine's choices, the server image — is in [INSTALL](../reference/INSTALL.md).
