# CLI reference

Every command, with what it does, every form it takes and one example. `sekhemet <command> --help` prints the same for one command. This page is generated from the command registry and the help table, and the build fails when a command has no entry here.

**Flags every command takes:** `--repo <folder>` runs it on another folder's project; `--json`, where a command lists it, prints one JSON object on stdout and progress on stderr; `--debug` prints more detail when something fails; `--restricted` is a read-only audit (no commands run, no writes, static checks only); `--trust` trusts the repository's configuration for this one run.

<!-- generated:cli-reference:start -->
## The front door

`sekhemet --help` lists these.

| Command | What it does |
| --- | --- |
| `sekhemet` | Set up on first run, then open the board |
| `sekhemet "<spec>"` | Plan the work; each issue is built once you approve it |
| `sekhemet run [issue]` | Run an issue, resume a stopped one, or run the queue |
| `sekhemet review` | Show the next issue waiting on you |
| `sekhemet accept <issue>` | Accept and merge. Also: request-changes &lt;issue&gt; "&lt;reason&gt;", park / unpark &lt;issue&gt;, reject &lt;issue&gt; "&lt;reason&gt;", reopen &lt;issue&gt;, revert &lt;issue&gt;; sekhemet card message\|pause\|hand-back\|take-over &lt;issue&gt; for a running one |
| `sekhemet ask "<question>"` | Ask Seshat from the terminal; the reply prints here |
| `sekhemet doctor` | Check the install, including the model weights |
| `sekhemet dev <command>` | Everything for developing Sekhemet itself |

## Every command

Each runs as `sekhemet <command>`, and as `sekhemet dev <command>`. Every command also takes `--repo`, `--restricted`, `--trust`, `--debug`.

### `abort`

Stop a running issue before its next step.

```
sekhemet abort <issue> [<reason>]
```

Example: `sekhemet abort TS-101 "wrong approach"`

### `accept`

Accept and merge. Also: request-changes &lt;issue&gt; "&lt;reason&gt;", park / unpark &lt;issue&gt;, reject &lt;issue&gt; "&lt;reason&gt;", reopen &lt;issue&gt;, revert &lt;issue&gt;; sekhemet card message|pause|hand-back|take-over &lt;issue&gt; for a running one.

```
sekhemet accept <issue> [--ack <finding numbers>] [--json]
```

Example: `sekhemet accept TS-101 --ack 1,2`

Flags: `--ack`, `--json`.

### `acp`

Seshat over the Agent Client Protocol on stdio, for Zed and other editors.

```
sekhemet acp [--repo <folder>]
```

Example: `sekhemet acp --repo ~/code/shop`

### `airgap`

Prepare and check a machine that never reaches the network.

```
sekhemet airgap mirror | manifest <models-dir> | verify-models <manifest> <dir> | docs <library or url> | export-docs <out> | import-docs <file> | sign <file> --key <key> | update <bundle> --sig <s> --signers <f> --identity <i> | selftest
```

Example: `sekhemet airgap selftest`

### `approve`

Approve a plan's acceptance criteria, so its issues may leave Planning.

```
sekhemet approve <issue or epic> [--show]
```

Example: `sekhemet approve TS-100 --show`

### `ask`

Ask Seshat from the terminal; the reply prints here.

```
sekhemet ask "<question>"
```

Example: `sekhemet ask "What is left before the release?"`

### `assume`

The assumptions the plan made: list them, keep one, or override it with your answer.

```
sekhemet assume [list]
sekhemet assume keep <id>
sekhemet assume override <id> [--answer "<text>"]
```

Example: `sekhemet assume list`

### `attach`

Attach screenshots or mock-ups to an issue.

```
sekhemet attach <issue> <image>…
```

Example: `sekhemet attach TS-101 mockup.png`

### `backup`

Back the workspace up outside the repository: the Activity log, its blobs and evidence, each project's configuration; --list shows the sets with their schema.

```
sekhemet backup
sekhemet backup <file>
sekhemet backup --list
```

Example: `sekhemet backup --list`

Flags: `--list`.

### `bake-off`

Compare Coding models on the same release checks, each from a clean copy.

```
sekhemet bake-off --workers <model>,<model> [--fixture <name>]
```

Example: `sekhemet bake-off --workers nail-mtp,cyber-tiel`

### `benchmark`

Benchmark this machine's models from the terminal, as Configuration › Models does.

```
sekhemet benchmark estimate|quick --worker <model> --planner <model> [--reviewer <model>] [--researcher <model>] [--yes]
sekhemet benchmark overnight|status|stop|report
```

Example: `sekhemet benchmark estimate --worker nail-mtp --planner qwen3:8b`

### `board`

The board in the browser (the bare `sekhemet` opens it), or the text board with --terminal.

```
sekhemet board [--terminal] [--port <n>] [--yes]
```

Example: `sekhemet board --terminal`

Flags: `--models-dir`, `--new-workspace`, `--port`, `--terminal`, `--yes`.

### `calibrate`

Measure each model's speed and memory at each context size on this machine.

```
sekhemet calibrate [--models <model>=<role>,…] [--buckets <tokens>,…] [--from <repo>,…] [--force]
sekhemet calibrate --mtp-ab --from <repo>,… [--max-steps <n>] [--thinking off|surgical|all] [--worker <model>]
```

Example: `sekhemet calibrate --models cyber-tiel=worker`

### `card`

Talk to a running issue: send a message, pause it, hand it back, or take it over yourself.

```
sekhemet card message <issue> "<text>"
sekhemet card pause <issue>
sekhemet card hand-back <issue>
sekhemet card take-over <issue>
```

Example: `sekhemet card message TS-101 "Use the existing date helper"`

### `ci`

Run the project's own CI workflow locally, as a check.

```
sekhemet ci [--job <id>] [--workflow <file>]
```

Example: `sekhemet ci --job test`

### `daemon`

The dashboard in the background; --at-login starts it at every login; status --all lists every workspace's server.

```
sekhemet daemon start [--port <n>] [--at-login]
sekhemet daemon stop [--at-login]
sekhemet daemon status [--all]
```

Example: `sekhemet daemon start --at-login`

Flags: `--all`, `--at-login`, `--port`.

### `decide`

List the decisions waiting on you, or answer one with an option's number.

```
sekhemet decide
sekhemet decide <decision> <option number>
```

Example: `sekhemet decide dec_3f9a1c2b7e 2`

### `depth`

Show the project's type, or choose one: Prototype, Internal tool, Production or Regulated.

```
sekhemet depth [prototype|internal|production|regulated] [--project <id>]
```

Example: `sekhemet depth production`

### `doctor`

Check the install, including the model weights.

```
sekhemet doctor [--json] [--verify-weights] [--report]
sekhemet doctor --airgap [--models-dir <dir>] [--query <question>] [--run-gates]
sekhemet doctor --check-updates [--yes]
```

Example: `sekhemet doctor --json`

Flags: `--airgap`, `--check-updates`, `--json`, `--models-dir`, `--query`, `--report`, `--run-gates`, `--verify-weights`, `--yes`.

### `drift`

What changed in the repository outside Sekhemet in the last days.

```
sekhemet drift [--days <n>]
```

Example: `sekhemet drift --days 7`

### `editors`

The snippet that connects VS Code, Cursor or Zed to the board and to Seshat, and where it goes.

```
sekhemet editors [vscode | cursor | zed]
```

Example: `sekhemet editors vscode`

### `egress`

What has left this machine: every recorded network request and model download, newest first.

```
sekhemet egress [--since <date or time>] [--refused] [--json]
```

Example: `sekhemet egress --since 2026-10-01 --refused`

Flags: `--json`, `--refused`, `--since`.

### `engine`

The inference engine: which llama-server is used and its build, or get the pinned llama.cpp release.

```
sekhemet engine [status]
sekhemet engine get [--yes]
```

Example: `sekhemet engine get --yes`

Flags: `--yes`.

### `erase`

Erase a secret found after the fact, or chosen entries, leaving a recorded gap.

```
sekhemet erase --secret [--secret-file <file>] --rotated
sekhemet erase --events <id>,…
```

Example: `sekhemet erase --secret --secret-file leaked.txt --rotated`

### `explore`

Learn the project's constraints from its own configuration before any issue runs.

```
sekhemet explore [--activate]
```

Example: `sekhemet explore --activate`

### `export`

Write the Activity log as NDJSON a verifier checks alone; with a folder, its projections, blobs and evidence too.

```
sekhemet export --ledger [--no-private] [--out <file.ndjson>]
sekhemet export --out <dir> [--no-private]
```

Example: `sekhemet export --ledger --out ledger.ndjson`

### `fixture`

Write a small practice repository with one issue, optionally with a planted bug.

```
sekhemet fixture typescript|python|rust <dir> [--bug]
```

Example: `sekhemet fixture typescript /tmp/practice --bug`

### `fork`

Branch a new attempt of an issue from step n.

```
sekhemet fork <issue> <step> [--attempt <id>]
```

Example: `sekhemet fork TS-101 4`

### `gate`

Run the project's checks, in the issue's own worktree when one exists.

```
sekhemet gate [<issue>]
```

Example: `sekhemet gate TS-101`

### `gate-host`

Run the checks for other machines over mutual TLS; init writes its certificates.

```
sekhemet gate-host init
sekhemet gate-host [--port <n>]
```

Example: `sekhemet gate-host init`

### `gates`

Write the checks file for this project's language, or approve a visual baseline.

```
sekhemet gates init [--force]
sekhemet gates approve-baseline <key> --sha256 <hash> [--card <issue>]
```

Example: `sekhemet gates init`

### `goal`

A project goal and its criteria: propose one, approve it, or mark a criterion.

```
sekhemet goal "<statement>"
sekhemet goal approve <goal>
sekhemet goal mark <goal> <criterion> met|unmet
```

Example: `sekhemet goal "Customers can export a week of hours"`

### `improve`

Improve the checks: propose rules from past runs, test the tests with mutants, or check mined tools.

```
sekhemet improve
sekhemet improve --mutants [--limit <n>] [--max-mutants <n>]
sekhemet improve --gate-rule <id> [--fixtures <a>,<b>] [--worker <model>]
sekhemet improve --validate-tools
```

Example: `sekhemet improve --mutants --limit 3`

### `init`

Check the machine and write the project's checks file and configuration.

```
sekhemet init [--force]
```

Example: `sekhemet init`

### `log`

The Activity log's newest entries and whether its hash chain verifies.

```
sekhemet log [--rebuild]
```

Example: `sekhemet log`

### `m0`

The first-run benchmark a newly adopted Coding model owes.

```
sekhemet m0 --worker <model> [--runs <n>] [--budgets <a>,<b>] [--max-commits <n>]
```

Example: `sekhemet m0 --worker nail-mtp`

### `mcp`

The board and Seshat as an MCP server on stdio, for an editor or another agent.

```
sekhemet mcp [--repo <folder>]
```

Example: `sekhemet mcp --repo ~/code/shop`

### `measure`

Measurement tooling: the harness's footprint, paired comparisons and a rule's credit.

```
sekhemet measure footprint [--out <file>]
sekhemet measure compare <baseline.json> <candidate.json>
sekhemet measure watch <change> --kind budget|harness --with <a,b> --without <c,d>
sekhemet measure rescore <result.json> --work <dir> [--out <file>]
sekhemet measure promote <issue> [--because <change>]
sekhemet measure rule-credit <rule>
sekhemet measure admit
```

Example: `sekhemet measure compare base.json candidate.json`

### `models`

The models on this machine: list, assign a role, restore the default, add a GGUF, or download.

```
sekhemet models list
sekhemet models assign <worker|planner|reviewer|researcher> <model> [--baseline | --default --bake-off <event>]
sekhemet models restore <role>
sekhemet models add <file.gguf> [--id <id>] [--sampling <settings>]
sekhemet models fetch <model> | --role <role> | --recommended [--yes] [--folder <path>]
```

Example: `sekhemet models assign worker nail-mtp`

### `onboard`

Bring an existing repository in: its checks, conventions and a first baseline.

```
sekhemet onboard [--apply [--yes]] [--models <a>,<b>] [--no-baseline]
```

Example: `sekhemet onboard`

### `overnight`

Run the queue in rounds while the machine is free and every safeguard holds.

```
sekhemet overnight [--until <HH:MM>] [--idle-min <n>] [--max-failures <n>] [--round-limit-min <n>] [--calibration-night --permit-loads] [run flags…]
```

Example: `sekhemet overnight --until 07:00`

### `park`

Put an issue on hold, with why.

```
sekhemet park <issue> "<reason>"
```

Example: `sekhemet park TS-101 "Waiting for the API key"`

### `pause`

Pause a project: none of its issues starts until it is resumed.

```
sekhemet pause <project id or name>
```

Example: `sekhemet pause shop`

### `plan`

Break a description of the work into issues, without running them.

```
sekhemet plan "<spec>" [--planner <model> | --planner none] [--researcher <model>] [--offline] [--verbose]
```

Example: `sekhemet plan "Add a CSV export of a week"`

### `project`

List the workspace's projects, or record that a project's repository moved.

```
sekhemet project list [--json]
sekhemet project move <project id or name> <new folder> [--yes]
```

Example: `sekhemet project list`

### `prompt-screen`

Replay recorded steps against a changed prompt, to screen it before a measured run.

```
sekhemet prompt-screen [--from <repo>,…] [--limit <n>] [--worker <model>]
```

Example: `sekhemet prompt-screen --from ~/code/shop --limit 20`

### `qualify`

Verify models for a role on this machine, or record an override with its reason.

```
sekhemet qualify --models <a>,<b> [--role worker|planner|reviewer|researcher] [--speculative on] [--check]
sekhemet qualify --override <model> [--role <role>] --by <name>
```

Example: `sekhemet qualify --models nail-mtp`

### `queue`

Run every Ready issue in board order; `sekhemet run` with no issue does the same.

```
sekhemet queue [--worker <model>] [--manager <model>] [--reviewer <model>] [--researcher <model>] [--max-turns <n>] [--settings <file>] [--review] [--explore] [--escalate-retries] [--calibration-night --permit-loads]
```

Example: `sekhemet queue --worker nail-mtp`

Flags: `--arm`, `--auto-accept`, `--calibration-night`, `--escalate-retries`, `--explore`, `--manager`, `--max-turns`, `--permit-loads`, `--profile`, `--prune`, `--researcher`, `--review`, `--reviewer`, `--seed`, `--settings`, `--tool-arm`, `--worker`.

### `recurring`

Issues that come back on a schedule or an event.

```
sekhemet recurring add <issue> (--cron '<expr>' | --on file:<glob>|release:npm:<package>|webhook:<name>) [--urgent]
sekhemet recurring list | tick | trigger <name>
```

Example: `sekhemet recurring add TS-101 --cron '0 6 * * 1'`

### `register`

The project's provenance and research records: check them, list licences, or move an entry on.

```
sekhemet register check
sekhemet register licenses
sekhemet register advance <id> <state> [--threshold <t>] [--evidence <e>]
```

Example: `sekhemet register check`

### `reject`

Reject an issue: it will not be done.

```
sekhemet reject <issue> "<reason>"
```

Example: `sekhemet reject TS-101 "Out of scope for this release"`

### `release`

The current release slice: its status, acceptance, scope changes, report and docs.

```
sekhemet release [--confirm <slice>]
sekhemet release brief <brief.json> | accept <slice> | cut <requirement> [--reason <text>] | extend <slice> [--cards <n>] [--hours <h>] | revise <requirement> <revision.json> | confirm <requirement> <issue|test> <ref> | report <slice> | docs [export|show|proposals|apply <id>|dismiss <id>]
```

Example: `sekhemet release`

### `reopen`

Reopen a finished or rejected issue.

```
sekhemet reopen <issue> ["<reason>"]
```

Example: `sekhemet reopen TS-101 "The export drops Sundays"`

### `replay`

Replay an issue's attempt step by step from the Activity log.

```
sekhemet replay <issue> [--attempt <n>] [--diff <a>,<b>] [--as <model>]
```

Example: `sekhemet replay TS-101 --attempt 2`

### `request-changes`

Send an issue in Review back to the Coding model with what to change.

```
sekhemet request-changes <issue> "<what to change>"
```

Example: `sekhemet request-changes TS-101 "Keep the header row"`

### `research`

Ask the Research model directly; it answers with its sources.

```
sekhemet research "<question>" [--deep | --effort quick|standard|exhaustive] [--model <name>] [--web | --offline] [--card <issue>] [--fresh] [--json]
sekhemet research --batch <file>
sekhemet research --status
```

Example: `sekhemet research "How does Express parse cookies?" --deep`

### `research-bakeoff`

Compare Research models on the research question set; adopt one only when the comparison allows it.

```
sekhemet research-bakeoff [--models <a>,<b>] [--pipelines native,tool-loop] [--adopt]
sekhemet research-bakeoff --adopt-from <run>
```

Example: `sekhemet research-bakeoff --models apodex-1.1-mini,neohorse-1-4b`

### `reserve`

Reserve the machine for yourself now: no unattended issue starts until you release it.

```
sekhemet reserve [--until <HH:MM or ISO time>]
sekhemet reserve --release
```

Example: `sekhemet reserve --until 18:00`

### `restore`

Restore the workspace from a backup, re-applying erasures; --latest takes the newest set that verifies.

```
sekhemet restore --latest
sekhemet restore <set folder or file>
```

Example: `sekhemet restore --latest`

Flags: `--latest`.

### `resume`

Continue an issue that stopped part-way, or resume a paused project.

```
sekhemet resume <issue> [--worker <model>] [--max-turns <n>]
sekhemet resume <project id or name>
```

Example: `sekhemet resume TS-101`

Flags: `--arm`, `--auto-accept`, `--escalate-retries`, `--explore`, `--manager`, `--max-turns`, `--profile`, `--prune`, `--researcher`, `--review`, `--reviewer`, `--seed`, `--settings`, `--tool-arm`, `--worker`.

### `revert`

Undo an accepted issue's merge with a revert commit, and reopen it.

```
sekhemet revert <issue> ["<reason>"]
```

Example: `sekhemet revert TS-101 "Broke the weekly report"`

### `review`

Show the next issue waiting on you.

```
sekhemet review [issue]
```

Example: `sekhemet review TS-101`

### `rewind`

Take an issue back to step n; its later state is kept on a branch.

```
sekhemet rewind <issue> <step>
```

Example: `sekhemet rewind TS-101 4`

### `run`

Run an issue, resume a stopped one, or run the queue.

```
sekhemet run <issue> [--worker <model>] [--max-turns <n>] [--settings <file>] [--json]   (with no issue: the queue)
```

Example: `sekhemet run TS-101`

Flags: `--arm`, `--auto-accept`, `--escalate-retries`, `--explore`, `--json`, `--manager`, `--max-turns`, `--profile`, `--prune`, `--researcher`, `--review`, `--reviewer`, `--seed`, `--settings`, `--tool-arm`, `--worker`.

### `send-back`

Request changes' former name: send an issue back with what to change.

```
sekhemet send-back <issue> "<what to change>"
```

Example: `sekhemet send-back TS-101 "Keep the header row"`

### `serve`

The web dashboard server for this workspace (Ctrl+C to stop).

```
sekhemet serve [--port <n>] [--host <address>] [--yes]
sekhemet serve --new-setup-token
sekhemet serve --switch-to-solo
```

Example: `sekhemet serve --port 4040`

### `skills`

The project's skills: list them, or approve or revoke one.

```
sekhemet skills [list]
sekhemet skills approve <name> [--user]
sekhemet skills revoke <name> [--user]
```

Example: `sekhemet skills list`

### `status`

The board for a script: each column's issues, what the queue runs next, and what waits on a person.

```
sekhemet status [--json]
```

Example: `sekhemet status --json`

Flags: `--json`.

### `take-over`

Take over an unfinished project: trust it, survey it, then propose what runs.

```
sekhemet take-over [--yes]
sekhemet take-over --approve TOP-<n> [--project <id>]
```

Example: `sekhemet take-over`

### `traces`

Export the run traces as JSON, or send them to an OpenTelemetry collector.

```
sekhemet traces [--since-hours <n>] [--out <file.json>] [--otlp <url>]
```

Example: `sekhemet traces --since-hours 24 --out traces.json`

### `trailers`

Check that each commit in a range carries its issue and model trailers.

```
sekhemet trailers [<git range>]
```

Example: `sekhemet trailers main~10..main`

### `trust`

Show what this repository would run and trust it; or approve another agent's config file.

```
sekhemet trust [--yes]
sekhemet trust --approve <file>
```

Example: `sekhemet trust`

### `tune`

Tune the step budget from recorded runs, or a role's sampling settings on this machine.

```
sekhemet tune [--from <repo>…]
sekhemet tune settings --role worker|reviewer [--model <id>] [--yes]
sekhemet tune settings --apply <run id>
```

Example: `sekhemet tune settings --role worker`

### `ui`

The same as serve: the web dashboard server.

```
sekhemet ui [--port <n>] [--host <address>]
```

Example: `sekhemet ui --port 4040`

### `uninstall`

List, or remove, everything this install wrote outside its package; ledgers and backups are kept unless --include-ledgers.

```
sekhemet uninstall --dry-run
sekhemet uninstall --yes [--include-ledgers]
```

Example: `sekhemet uninstall --dry-run`

Flags: `--dry-run`, `--include-ledgers`, `--yes`.

### `unpark`

Take an issue off hold, back where it was.

```
sekhemet unpark <issue>
```

Example: `sekhemet unpark TS-101`

### `upgrade`

Upgrade a dependency as a recorded step, then plan issues for the checks it breaks.

```
sekhemet upgrade <package> <from> <to> [--changelog <file>]
sekhemet upgrade fixes <upgrade issue>
```

Example: `sekhemet upgrade react 18.3.1 19.0.0`
<!-- generated:cli-reference:end -->
