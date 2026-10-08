# Changelog

All notable changes to Sekhemet are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Within each version, Security comes first.

This file ships in the npm package. After an upgrade, the first `sekhemet` command run at a terminal prints, once, the notes of each version since the one it last showed — Security entries first, at most 20 lines, with no network request (*What's new*). Sekhemet never checks for a release on its own: `sekhemet doctor --check-updates` asks the npm registry, and only after your yes.

## [Unreleased]

Planned as **0.9.0**, the public pre-release: the first with an npm package and a server image. Sekhemet is source-available under the Functional Source License (FSL-1.1-ALv2), which becomes Apache 2.0 two years after each release. Known limits of this release are listed in [STATUS.md](docs/reference/STATUS.md): local models only, the Review role unfilled until a model passes admission, and checks that need a database or another service reported as unavailable.

### Security

- The server image checks its own health through `GET /healthz`, which answers 200 only while the ledger opens and its head verifies, and carries no data and needs no session.
- `sekhemet doctor --check-updates` names the one host it asks (registry.npmjs.org), sends nothing before your yes, goes through the network policy and sends no identifier of the install or of you; no other command asks.

### Added

- `sekhemet uninstall --dry-run` lists everything an install wrote outside its package, with sizes, keychain items by name and containers by name; `--yes` removes them, keeping each project's ledger and every backup unless `--include-ledgers`.
- `sekhemet daemon start --at-login` starts the workspace's dashboard at every login, through a LaunchAgent (macOS) or a `systemd --user` unit (Linux), on a port of its own; `daemon stop --at-login` removes only what it wrote; `daemon status --all` shows which workspaces start at login.
- *What's new*: the notes of this file, shown once after an upgrade.
- The Team server's `builtin` compose profile: built-in accounts (passwords, passkeys, invites) behind the reverse proxy you already run, for a team with no identity provider.
- The Team server checks each role's inference engine as it starts and shows the result on Configuration › Models.

### Changed

- The server image starts `sekhemet serve`, as a person runs it, rather than the developer's `dev serve`.
- `scripts/install.sh` requires Node.js 22.13 or newer (the built-in `node:sqlite`), as the npm package does.

## [0.1.0] - 2026-09-17

The development builds, never published: installed from source only.

### Security

- Every command the Coding model runs is confined by the operating system's sandbox: Seatbelt on macOS, bubblewrap on Linux, with home-directory secrets masked and the network denied unless a policy opens it.
- The network is off by default; research, git remotes and sync are opt-in, and every request is recorded as egress.
- Integration secrets are kept in the operating system's secret store (the macOS keychain, or the Secret Service on Linux).
- A prompt-injection suite of 14 fixtures across four channels, run against the real Coding model.

### Added

- Seshat, the PM: a conversation that starts a project, a brief with Must/Should/Could requirements and a depth profile, and suggestions a person applies or dismisses.
- The planner: epics and thin vertical stories, each traced to a requirement with checkable acceptance criteria and red-first tests.
- A board with familiar columns, issue types and keys, a Status page, Projects, Review, Insights, a story map and a burn-up chart.
- Checks per issue — tests, types, lint, a bundled gitleaks secret scan, visual and accessibility checks — declared in `.sekhemet/gates.toml`, hash-pinned and out of the model's reach.
- The repair ladder: direct repair, a fresh context, a written edit sketch, then a stop that asks a person.
- Accept squash-merges to `main` without touching your working copy, and can be undone; Request changes returns an issue with its reason.
- Releases that roll accepted requirements up, with SemVer versions and a changelog.
- One hash-chained event log: the board, the audit trail, replay and every measurement are projections of it.
- Local models on llama.cpp's `llama-server`, four roles, qualification per machine, and Smart Swap, the residency scheduler.
- `sekhemet models fetch --recommended`, which downloads the recommended set on your yes and verifies each file by its published hash.
- *Get the inference engine*: the pinned llama.cpp release, downloaded on your yes and checked against its recorded SHA-256.
- The Team setup: four access levels, a per-project Accept rule, invites, passwords, passkeys and company sign-in (OIDC).
- `@Agent` and `@Seshat` as labelled AI teammates, an Inbox, @mentions, review threads and an exportable audit log.
- Backups outside the repository, per workspace, verified before they are kept; `restore` refuses a set that does not verify.
- An MCP server over stdio, an MCP client for outside tool servers, and export and import for Jira and Linear boards.
- The frozen suite of 30 issues across four fixture projects, and milestone runners that write evidence files.
- Research like an engineer: installed dependencies read at their installed version, docs at the pinned version, and durable research notes.
