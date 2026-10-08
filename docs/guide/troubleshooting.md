# Troubleshooting

Start with:

```bash
sekhemet doctor
```

It checks the install, prints `Do:` under each check that does not pass, and ends with one verdict: *Ready to run an issue*, or *Not ready* naming the first step to take. `sekhemet doctor --json` gives the same for a script, and `sekhemet doctor --verify-weights` also checks each model file against its recorded hash (slow: it reads every file).

## When asking for help

`sekhemet doctor --report` writes a report folder, prints its path and lists what is in it: the checks, the settings, counts from the Activity log (never a title, text or diff) and the end of the diagnostic logs, with secrets, your paths, login, host name and email addresses taken out. Nothing is sent anywhere. Read it, then attach it to a bug report ([SUPPORT](../../.github/SUPPORT.md)).

`--debug` on any command prints more detail when something fails.

## Every check

<!-- generated:troubleshooting:start -->
`sekhemet doctor` runs these checks in this order. A check that does not pass prints `Do:` with its next step, and the verdict names the first one that fails. Below is each check's general next step; the line `doctor` prints may be more specific.

### Unified memory

**Do:** Close programs you are not using, or wait until the system's memory pressure is normal.

### Memory floor

**Do:** Use a machine with 24 GB of memory or more; you may continue here at your own risk.

### Inference engine

**Do:** Get the inference engine on Configuration › Models, or run `sekhemet engine get`.

### Model weights

**Do:** Point SEKHEMET_MODELS_DIR (or `--models-dir`) at the folder holding your weights, or download them on Configuration › Models.

### Weights' hashes

**Do:** Run `sekhemet doctor --verify-weights`; download a file whose hash differs again on Configuration › Models.

### Role verification

**Do:** Verify each role's model on Configuration › Models, or run `sekhemet qualify --models <model>`.

### Ollama's roles

**Do:** Assign a GGUF model to each role on Configuration › Models, or run `sekhemet models assign <role> <model>`.

### Team engines

**Do:** Start each engine service with its profile's arguments: `docker compose -f packaging/server/compose.yaml up` (docs/reference/INSTALL.md, For a team).

### Model server

**Do:** Start Ollama for the roles it serves; a role on llama.cpp needs nothing running, since each run starts its own llama-server.

### Git repository

**Do:** Run `git init` in the project's folder, or run `sekhemet doctor` in a folder that is a git repository.

### Sandbox confinement

**Do:** On Linux install bubblewrap (`sudo apt install bubblewrap`); on macOS the sandbox is built in (docs/reference/INSTALL.md).

### Port relays

**Do:** Install socat (`sudo apt install socat`, or your distribution's package).

### Node runtime

**Do:** Install Node.js 22.13 or newer (https://nodejs.org).

### Git

**Do:** Install git (https://git-scm.com/downloads).

### Package manager

**Do:** Install the package manager the project uses (the `packageManager` field in package.json, or its lockfile).

### Skills

**Do:** Add skills under .sekhemet/skills/, or leave it: a project runs without skills.

### Playbook and skills

**Do:** Prune the rules and skills it names on Configuration › Project, or run `sekhemet skills`.

### Project records

**Do:** Fix the entries it names in docs/reference/PROVENANCE.md or the research register.

### Plugins

**Do:** Move what the plugins did to hooks (.sekhemet/hooks.toml) or MCP servers (.sekhemet/mcp.json), then remove .sekhemet/plugins/.

### First-run benchmark

**Do:** Run `sekhemet m0 --worker <name>`, or let `sekhemet overnight` run it first.

### Model verification

**Do:** Verify each model it names again: `sekhemet qualify --models <model>`.

### Local models only

**Do:** Assign a local model to each role it names on Configuration › Models.

### User directory

**Do:** Merge or delete by hand the files it names as left behind.

### Configuration

**Do:** Fix the config.toml line it names, then run `sekhemet doctor` again.

### Config upgrades

**Do:** Read the renamed keys it lists; each file's backup sits beside it.

### Hooks

**Do:** Fix .sekhemet/hooks.toml where it says.

### Research

**Do:** Set `[network] research` in your own config.toml (only you can allow research).

### Network allowlist

**Do:** Remove the wildcard or upload-capable entry from `[project] network_allow` in .sekhemet/gates.toml unless the project's checks truly need it; every issue that runs under it records the warning.

### Research pipelines

**Do:** Run `sekhemet research-bakeoff` to compare the pipelines again.

### Secret store

**Do:** Install the system's secret store (macOS Keychain, or the Secret Service on Linux), or choose a private file in Integrations.

### Activity log

**Do:** Run `sekhemet log` to see the entry named; restore the newest backup that verifies with `sekhemet restore --latest`.

### Locks

**Do:** Nothing is needed: the next run takes over a lock whose holder is gone; or remove the file it names.

### Crashed attempts

**Do:** Run `sekhemet run`: its start-up pass returns each to Ready from its last checkpoint.

### Workspace in a git repository

**Do:** Run `sekhemet backup` before any `git clean -xdf` there.

### Project locators

**Do:** Move the project back, or record its new folder with `sekhemet project move <id> <path>`.

### Team address

**Do:** Serve the Team server behind TLS — your reverse proxy (the `builtin` profile) or the identity proxy with your certificate (the `proxy` profile), docs/reference/INSTALL.md › For a team — and set `[identity] public_url = "https://…"`.

### Backup

**Do:** Run `sekhemet backup`.

### Staying awake

**Do:** Install the tool that keeps the machine awake (`caffeinate` on macOS, `systemd-inhibit` on Linux), or keep the machine from sleeping while a run works.

### Power

**Do:** Plug the machine in for the night.

### Free space

**Do:** Free space on the volume it names.

### Credential store

**Do:** Set `[team] mode = "team"` in your config.toml and run `sekhemet serve` in the workspace's folder: a Team server moves the store into its workspace.

### Model lease

**Do:** Wait for the run that holds it to finish, or stop that process.

### Lost records

**Do:** Read the file it names; each line is a record that could not be written.
<!-- generated:troubleshooting:end -->

## Other problems

**Every command is refused on Ubuntu, naming AppArmor.** Ubuntu 24.04 and later stop bubblewrap until a profile allows it; [Install](install.md) gives the two commands.

**An issue's dev server is not reachable on Linux.** The issue's port relays need `socat`: `sudo apt install socat`. The *Port relays* check above says so.

**A download is refused with "network policy refused".** Sekhemet is offline by default. The message names the setting that allows the request; [Privacy and network](privacy-and-network.md) lists every host and its setting.

**The dashboard says it cannot open the Activity log, or a newer version wrote it.** After a rollback, restore the backup the message names ([Upgrade and uninstall](upgrade-and-uninstall.md)). `sekhemet log` says whether the log's hash chain verifies.

**An issue stopped and asks for you.** Open it on the board: its *Activity* tab says why it stopped and what it needs. `sekhemet request-changes <issue> "<what to change>"` sends it back with guidance, or `sekhemet card message <issue> "<text>"` guides one that is still running.
