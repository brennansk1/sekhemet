# Developing Sekhemet: the operations procedure

How the people and agents building Sekhemet run models, tests, the frozen suite
and the Linux checks on their own machine. The procedure is the same everywhere;
each machine's values come from the environment and from a git-ignored
`CLAUDE.local.md` beside `CLAUDE.md`, which imports it (DEC-54 c2). A machine's
paths, its drive names and its memory never go in a tracked file:
`node scripts/prepublication.mjs --check` fails when one does.

| Variable | What it names |
| --- | --- |
| `$SEKHEMET_MODELS_DIR` | The folder holding the model weights (the Worker's GGUF and the others). Scripts that load a model refuse to start without it. |
| `$LIMA_HOME` | Where Lima keeps its virtual machines, for the Linux checks below. |
| `SEKHEMET_MODEL_LOADS=off` | Set by the test suite: no test loads a model. |

Write this machine's values in `CLAUDE.local.md` (memory, the drive, how long a
load takes, anything about the shell), for example:

```markdown
- 24 GB host; the Worker is 13 GB.
- export SEKHEMET_MODELS_DIR="<the drive>/AI-Models/llm"; a load from it takes about five minutes.
- export LIMA_HOME="<the drive>/AI-Models/lima"
```

## Before loading a model

1. Check what is already loaded and how much memory is free:
   `ollama ps`, then `memory_pressure -Q` on macOS (`free -h` on Linux).
2. Load one model at a time; unload it when the run ends. The harness's own
   memory guard stops a card when swap passes 6 GB.
3. While a model is loaded, run tests only for the files you changed, with
   `--pool=forks --poolOptions.forks.maxForks=1`. Never run `vitest run` with an
   empty file list: it runs the whole suite.

## The Worker's server

Start the Worker's server once and let every card attach to it. Its arguments
come from `createCyberTielWorker().launchArgs()` (port 8098), with the weights
read from `$SEKHEMET_MODELS_DIR`. MTP (`--spec-type draft-mtp
--spec-draft-n-max 1 --spec-draft-p-min 0.0`, the model card's values) is in
those arguments only once `sekhemet calibrate --mtp-ab` has recorded a per-step
gain for this host and thinking policy (models rule 13) and `sekhemet qualify
--speculative on` has passed with it (MD-N8-2). A server whose model, context or
MTP state differs from the profile is refused (MD-M4-1).

## The frozen suite and other model runs

- `node scripts/run_suite.mjs --worker cyber-tiel --out <file>` runs the frozen
  suite; `node scripts/injection_fixtures.mjs --worker cyber-tiel` the injection
  fixtures. Both need `$SEKHEMET_MODELS_DIR`.
- **Never run `tsc -b` or `pnpm gate` during a suite run**: each card is a fresh
  process and would load a different build. Run model work from a frozen
  snapshot (`git worktree` at a commit, with its own `dist/`).
- **Experiment switches**, recorded in every evidence bundle:
  `SEKHEMET_THINKING=off|surgical|all`, `SEKHEMET_WORKER_METHOD=baseline|strict`,
  and (once built, worker-loop rule 29a) `SEKHEMET_EVIDENCE_GATE`.

## Linux, in a Lima VM

Linux behaviour (bubblewrap, `socat` relays, the Ubuntu install steps) is
proven in a Lima VM named `sekhemet-linux` (Ubuntu 24.04):

```bash
LIMA_HOME="$LIMA_HOME" limactl start sekhemet-linux
# sync this checkout into the VM's ~/sekhemet, without builds or state
LIMA_HOME="$LIMA_HOME" limactl shell sekhemet-linux -- rsync -a --delete \
  --exclude node_modules --exclude dist --exclude /.git --exclude '*.tsbuildinfo' \
  --exclude /.sekhemet --exclude /evidence "$PWD/" ~/sekhemet/
LIMA_HOME="$LIMA_HOME" limactl shell sekhemet-linux -- bash -lc \
  'cd ~/sekhemet && pnpm install --frozen-lockfile --offline && npx tsc -b --force'
# … run the changed spec files there …
LIMA_HOME="$LIMA_HOME" limactl stop sekhemet-linux
```

Stop the VM when done: it holds memory a model run needs.

## Before publishing

- `node scripts/prepublication.mjs --check` before a commit that adds files:
  no machine path in a tracked file, no tracked `.claude/launch.json`.
- `node scripts/prepublication.mjs` writes
  [PREPUBLICATION.md](PREPUBLICATION.md): the history scanned for secrets (it
  reports and never rewrites), the author addresses, and the machine paths.
- `node scripts/clean_machine_walk.mjs` guides the timed walk from a clean
  macOS or Ubuntu machine to a first accepted issue, and records each step's
  wall time (INS-05, DoD §6.7).

On macOS `/tmp` is `/private/tmp`.
