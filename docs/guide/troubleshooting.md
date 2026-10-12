# Troubleshooting

Start with:

```bash
sekhemet doctor
```

It checks the install, prints `Do:` under each check that does not pass, and ends with one verdict: *Ready to run an issue*, or *Not ready* naming the first step to take. `sekhemet doctor --json` gives the same for a script, and `sekhemet doctor --verify-weights` also checks each model file against its recorded hash (slow: it reads every file).

## When a command refuses

A command that cannot do what you asked says so in one line starting `sekhemet:`, and, when there is a step that moves things on, a second line starting `Do:` with that step:

```
sekhemet: Issue TS-101 is To do. Only an issue In review can be accepted.
  Do: sekhemet run TS-101 (it reaches In review when its checks pass)
```

An issue ID that does not exist is answered with the closest ID when it looks like a typo, and `Do: sekhemet status lists every issue with its ID`. A refusal exits 1 (2 for a usage error) and writes no error report; only an error nothing handled prints a line saying Sekhemet stopped, naming its report.

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

**Do:** Run `sekhemet doctor --verify-weights`; download a file whose hash differs again on Configuration › Models, or, for a file you added yourself, put the original back or add the changed one under a new id with `sekhemet models add`; put a file that is not found back, or register where it is now with `sekhemet models add <file> --id <id>`.

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

**Do:** Add skills under .sekhemet/skills/, or leave it: a project runs without skills; a skill it names as not approved or changed loads once you read it and run `sekhemet skills approve <name>`.

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

**Do:** Fix .sekhemet/hooks.toml where it says; a file waiting for trust runs once you read it with `sekhemet dev trust` and trust it with `sekhemet dev trust --yes`.

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

**Push or email says *Last test failed* or *Last send failed*.** The server you connected did not take the last test, or the last notice Sekhemet sent: the card names the reason (a refused connection reads *could not reach* the host). Your network settings allowed the request, and Network activity lists it as *Allowed* and *not reached*. Check the server's address and port, then send a test, or connect it again; until a send arrives the card is not counted as connected, and once one does it says *Connected* again.

**An import leaves rows out.** The Import sheet names each by its line in the file — a row with no title, a priority, estimate or due date it cannot read, a repeated row (proposed once), a parent link a new issue does not get (an import does not bring hierarchy), and the rows past the first 500, which go in a second file — above the proposals. New issues are created in the project you are on. Nothing changes until you apply.

**A command says the disk is full.** Every command says it the same way — *the disk is full, so nothing more could be written* — and *Do: free some space on the disk, then run the command again*. Nothing half-written is shown as finished: a plan that stopped on a full disk names the epic and issues it kept, says no plan was recorded, and tells you to free space, reject those issues with `sekhemet reject <issue> "unfinished plan"`, and plan again.

**`sekhemet log` says the chain is corrupted at a seq.** It names the first row that does not verify and why. *seq 14 is missing: the row after 13 is 15* means a row was deleted from the Activity log; restore the newest backup ([Upgrade and uninstall](upgrade-and-uninstall.md)). Its *Projections: rebuilt from N events* line counts every event in the log.

**An epic shows *Being planned* with no issues.** Its plan stopped before it wrote any issue, or every issue was rejected. Nothing of it is built until it has issues: plan it again, or reject it.

**An issue in To do says *Waiting to start* instead of *Queued*.** The Agent does not start it until the condition named is met — a dependency done, its criteria approved (`sekhemet approve <issue>`), or the files it may change declared. The issue's *Ready to start* list shows the same condition.

**`sekhemet trailers` refuses a range.** Git could not read it — a branch or commit it does not know, or more commits back than the branch has; the message gives git's words. A range with no commits says there was nothing to check.

**Accept says the issue conflicts with main.** Something else landed on `main` that touches the same files since the issue was built. Nothing was written and the issue stays In review; the issue's Activity says *could not accept* with the files. `sekhemet request-changes <issue> "rebase onto main and resolve the conflict"` sends it back: the Agent's next run rebases onto `main` before its checks, then it comes back to In review. On the dashboard the failed Accept says the same step and offers **Request changes** with that reason already written.

**`sekhemet revert` says there is nothing of its own to revert, or the dashboard's Revert is greyed out with that reason.** The issue was accepted through a pull request, merged on the hosting service, or it is Done with no Accept on its Activity log. Revert the merge where the pull request lives (`git revert -m 1 <merge commit>`), then plan the work again with `sekhemet plan "<what to change>"` or a New issue on the board.

**Request changes is refused on an issue In review with no attempt.** There is no work to decide on yet, so only Put on hold is offered, on the board as in the terminal: `sekhemet park <issue> "<why>"`, then `sekhemet unpark <issue>` puts it in Ready to run. Taken off hold, an issue goes to Ready, or to Backlog or Planning if it was put on hold from there; the dashboard's toast names the column. An issue put on hold from In review (including through the hold's Undo) goes to To do, and the Agent runs it again.

**`sekhemet take-over` says the repository belongs to a Sekhemet workspace already.** Its history carries `Ledger-Head` trailers, as a clone of a project Sekhemet built does; it is refused exactly as the first run is, and nothing is written. Open the workspace the message names, or start a new one with `--new-workspace`.

**The dashboard says it cannot open the Activity log, or a newer version wrote it.** After a rollback, restore the backup the message names ([Upgrade and uninstall](upgrade-and-uninstall.md)). `sekhemet log` says whether the log's hash chain verifies.

**An issue stopped and asks for you.** Open it on the board: its *Activity* tab says why it stopped and what it needs. `sekhemet request-changes <issue> "<what to change>"` sends it back with guidance, or `sekhemet issue message <issue> "<text>"` guides one that is still running.
