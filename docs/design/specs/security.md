---
spec: security
status: partial
audiences: [developer]
code:
  - packages/sandbox/src/executor.ts
  - packages/sandbox/src/seatbelt.ts
  - packages/sandbox/src/bubblewrap.ts
  - packages/sandbox/src/seccomp.ts
  - packages/sandbox/src/egress.ts
  - packages/sandbox/src/permissions.ts
  - packages/sandbox/src/untrusted.ts
  - packages/sync/src/git_hardening.ts
  - packages/loop/src/paths.ts
  - packages/gates/src/secrets.ts
  - apps/harness/src/airgap.ts
tests:
  - packages/sandbox/tests/containment.spec.ts
  - packages/sandbox/tests/bubblewrap.spec.ts
  - packages/sandbox/tests/egress.spec.ts
  - packages/sandbox/tests/permissions.spec.ts
  - packages/sandbox/tests/sandbox_wave2.spec.ts
  - packages/sync/tests/git_hardening.spec.ts
  - packages/loop/tests/paths.spec.ts
  - packages/loop/tests/restricted.spec.ts
  - packages/loop/tests/untrusted.spec.ts
  - apps/harness/tests/airgap.spec.ts
changes: [S1, S2, S3, S3a, S3b, S3c, S9]
---

# Security: sandboxing, permissions, egress, secrets, workspace trust, air-gap

## 1. Purpose

The harness runs code written by a local model on the owner's machine. The v1 Worker is uncensored ([DEC-04](../DECISIONS.md#dec-04)), so the sandbox, the permission engine and fail-closed confinement are its **only** guardrails, and every item in this spec is v1-blocking. It serves the spine rule that the model never certifies its own work: a model that can leave its sandbox can edit the machinery that judges it.

## 2. Behaviour

### Threat model

1. **Untrusted:** everything the Worker writes (worktree files, `package.json` scripts, `.gitattributes`, a worktree's `gates.toml`), every repository the user has not trusted, and all external text (issues, PR comments, fetched pages, synced items).
2. **Trusted:** the harness process, the user's own configuration directory, and repository configuration the user has explicitly trusted (§ Workspace trust).
3. **The rule that follows:** anything the harness runs on untrusted input runs confined. Code outside the sandbox never executes a program named or written by untrusted input.

### Confinement: one execution path

4. Every process that executes code from a worktree — Worker commands and background processes, gates (including per-package gates), the visual gate's dev server and browser, the `browse` tool's headless browser, language servers, onboarding probes, `--validate-tools` — runs through one chokepoint, `runConfined()`, in the card's sandbox with an allowlisted environment (S3a).
5. Processes the harness trusts (its own git, model servers, the dashboard) run through `runTrusted()`, from a written allowlist of call sites. No other module spawns processes; a lint rule bans `node:child_process` elsewhere (S3a).
6. The sandboxed environment carries only `PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, LC_CTYPE, TMPDIR, TERM, NODE_ENV, CI`, a private `TMPDIR`, the proxy variables when an egress proxy runs, and variables the caller names. API keys and tokens never enter it.
7. **Fail closed (S3b).** A host with no confinement mechanism runs no Worker command and no gate. The only opt-out is `SEKHEMET_ALLOW_UNCONFINED=1`; when set, every card's evidence bundle records `isolation: "none"`. No code path passes `requireConfinement: false` on the user's behalf.
8. The isolation level in force (`seatbelt`, `bubblewrap`, `none`) is recorded on every card and in its evidence bundle, and `sekhemet doctor` reports it.
8a. The harness, never the model, decides a sandbox's writable roots and working directory: from the card's record, canonicalised (symlinks resolved) before the profile is generated. A model-supplied `cwd` or path never widens them (the Codex CVE-2025-59532 class).

### macOS profile (Seatbelt)

9. Deny by default. Writes only to the granted roots and a private scratch directory. `.git` at any depth and in any case under a root is never writable (later rule wins).
10. Reads are allowed broadly except the user's secret-bearing paths: `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.netrc`, `~/.config/gh`, the Sekhemet user directory, and the project's `.sekhemet/events.db` (S3c).
11. `mach-lookup` is limited to an allowlist of services toolchains need; AppleEvents and LaunchServices lookups are denied (S3).
12. Network is denied except to the egress proxy's port, when one runs, and the card's own loopback ports.
13. `sandbox-exec` is deprecated by Apple. It stays the macOS mechanism behind the sandbox interface, with containment tests that fail loudly if its behaviour changes.

### Linux profile (bubblewrap)

14. `--ro-bind / /`, writable binds for the granted roots, then every `.git` under a root (any depth) re-bound read-only; `--unshare-all`, `--die-with-parent`, `--new-session`, a private `/tmp` (S1/G2, S3).
15. Host UNIX sockets are unreachable: `/run/user`, the D-Bus session bus and `docker.sock` are masked, and seccomp refuses creating `AF_UNIX` and `AF_INET` sockets except to the proxy, which is reached through a bind-mounted UNIX socket (S3).
16. The harness refuses to run git in a root whose `.git` it did not create itself (G6).
17. Linux runs bubblewrap, not Landlock ([DEC-21](../DECISIONS.md#dec-21--accepted-substitutions)); Landlock and seccomp are hardening layers on top.

### Git run by the harness (S1, G3)

18. The harness runs git outside the sandbox, at an absolute path, version ≥ 2.50.1, with `GIT_DIR` and `GIT_WORK_TREE` pinned from its own record of the worktree (`<main>/.git/worktrees/<name>`), so a rewritten `.git` pointer changes nothing.
19. Pinned for every harness git call: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`, `GIT_PAGER=cat`, empty `GIT_ASKPASS`/`SSH_ASKPASS`, `GIT_CEILING_DIRECTORIES`; and through `GIT_CONFIG_*`: `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.untrackedCache=false`, `core.sshCommand=false`, `core.symlinks=false`, `credential.helper=`, `gpg.program=false`, `commit.gpgSign=false`, `log.showSignature=false`, `diff.external=`, `protocol.file.allow=never`, `submodule.recurse=false`, `diff.ignoreSubmodules=all`, `safe.bareRepository=explicit`, `include.path=`.
20. `diff`, `log` and `show` run with `--no-ext-diff --no-textconv`; commits with `--no-verify`; nothing uses `--recurse-submodules`.
21. **Preflight:** before git runs in a worktree, the harness reads its config with `--no-includes` and refuses on any of `core.fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy`, `filter.*`, `diff.*.(command|textconv)`, `merge.*.driver`, `include*`, `gpg.*`, `credential.*`, `remote.*.(uploadpack|receivepack)`; scans the worktree for embedded bare repositories (a directory holding `HEAD` and `objects`), `.git` files or symlinks below the root, and carriage returns in `.gitmodules` (CVE-2025-48384); and fails the card if the staged diff adds a gitlink (mode 160000) or a nested bare repository.
22. "Already hardened" is decided by checking the keys are present, never by trusting an environment flag.
23. Consequence, stated to the user by `doctor` and the README: Sekhemet's own git commands never run git hooks or fsmonitor. The project's pre-commit checks belong in gates, run confined from the base branch's hook files ([review-git](review-git.md) owns Accept and LFS).

### Dependency trees (S2, G4)

24. The shared dependency tree is never writable from a card. Each worktree gets its own `node_modules` directory whose entries are links into the main checkout; caches (`.vite`, `.vite-temp`, `.cache`, `.tmp`) are created inside the worktree and deleted with it. No write grant reaches outside the worktree.

24a. **Per-card worktrees.** Each card works in its own git worktree under `.sekhemet/worktrees/<card>`, the only writable root its sandbox is granted (plain worktrees, not copy-on-write clones: [DEC-21](../DECISIONS.md#dec-21--accepted-substitutions)).

### Permission engine

25. Three tiers, **Allow**, **Ask**, **Deny**; Deny wins. Allow: reads inside the repo, writes inside the declared scope. Ask: destructive commands (recursive force-remove, `git reset --hard`, `git clean -f`, `sudo`, `kill -9`, `chmod 777`), network commands to allowlisted hosts, external binaries not provided by the toolchain or the project. Deny: writes outside scope, paths that resolve outside the worktree, and protected paths — gate files, test globs the project protects, `.git` at any depth, `.githooks/`, `.sekhemet/` state and extension files (`hooks.toml`, `mcp.json`, `skills/`, `plugins/`), and the harness's own loop, gate runner and sandbox sources. The agent cannot override a Deny.
26. The engine decides on the **resolved** path (symlinks followed), not the string the model supplied.
27. The engine is a usability layer; the sandbox is the security boundary. No protection may exist only in the engine.

### Egress (S3)

28. One network policy. The user's `config.toml` is authoritative; a repository's `gates.toml` `network_allow` may only **narrow** it; a project `config.toml` may not widen `[network] mode`.
29. Offline is the default. With `mode = "offline"` no sandboxed command has a route out, and harness-side requests reach only loopback.
30. With an allowlist, sandboxed commands reach the network only through the harness's proxy. The proxy: treats an empty allowlist as deny-all; canonicalises hostnames and rejects NUL bytes and non-hostname characters; resolves names itself and refuses loopback, private, link-local and metadata addresses after resolution; allows only ports 80 and 443; and records every request, allowed or refused, as a `card/egress` event with the SHA-256 of its payload.
31. The sandbox has no resolver of its own (DNS is itself an exfiltration channel).
31a. An allowlist names exact hosts. The proxy decides on the hostname the client supplies and does not inspect TLS, so a broad or upload-capable entry — a wildcard, a code host such as `github.com`, a registry's publish endpoint — is an exfiltration path: it is accepted only with a warning shown when it is added and recorded on every card that runs under it.
32. Every harness-side outbound request that input from the Worker or a repository can influence — registry lookups for the supply-chain gate, research fetches, repository clones — goes through one `NetworkPolicy` wrapper that applies the mode and logs to the ledger. Registry lookups never run inside a worktree (so a worktree `.npmrc` is ignored).
33. Integrations the user connected (GitHub, Slack, ntfy, OTLP) are allowed destinations because connecting them is the consent; they are still logged, and `offline` blocks all of them except loopback.

### Secrets (S3c)

34. Command lines, observations, context packs, gate excerpts and evidence are redacted with the secret scanner **before** they are persisted or published. The hash-chained ledger cannot be purged, so a secret must never reach it.
35. Integration tokens live in the OS keychain; where none exists (Linux without a secret service), in a file of mode 0600 inside a directory of mode 0700 in the user directory, which the sandbox cannot read (item 10). Webhook URLs are secrets.
36. The gate host's CA key is stored encrypted and certificates are valid for at most one year.

### Dashboard as an attack surface (S3c)

37. One guard at the top of the server: requests whose `Host` is not the bound name are refused (DNS rebinding); every mutation carries a random per-start token that the dashboard page receives from the server, replacing the constant `X-Sekhemet-Action: 1`; a request with no `Origin` is trusted only with that token; responses send `Content-Security-Policy: frame-ancestors 'none'; script-src 'self'`. Binding and per-person sessions for the company server are in [runtime](runtime.md).

### Workspace trust (S9)

38. Repository-supplied configuration that makes the harness run code outside the sandbox — `.sekhemet/hooks.toml`, `.sekhemet/mcp.json`, `.sekhemet/plugins/`, skill `scripts/` — is inert until the user trusts it. [Extensibility](extensibility.md) lists what each gates.
39. Trust is recorded in the user directory, never in the repository, keyed by the repository's real path and the SHA-256 of each trusted file. A changed hash is untrusted again, including after an Accept merges a Worker's edit to one of these files.
40. The trust prompt shows exactly what would run. Headless and non-TTY runs never trust implicitly; `--trust` must be given per invocation.
41. The Review evidence flags any diff to files that execute later outside the sandbox: the paths in item 38, `.githooks/`, `.husky/`, `.pre-commit-config.yaml`, `.gitattributes`, `.gitmodules`, and editor task configuration (`.vscode/`, `.idea/`) (NEW-security-1).

### Untrusted content

42. Issue text, PR comments, fetched pages and synced data enter prompts wrapped as `<untrusted_content source="…">…</untrusted_content>`, with a system contract that instructions inside issue no tool calls. A step whose context holds untrusted content cannot use Ask-tier or network commands.
42a. **The Worker's browser.** `browse` reaches only the card's own app on loopback, except on research cards; its pages are untrusted content unless loopback; the browser runs confined (item 4); it reads and screenshots only — a tool that clicks or types into a page needs the card's scope to name a URL allowlist, and its screenshots go to the evidence bundle.
42b. **Prompt injection has no model-level fix, and the v1 Worker has no refusals.** Abliteration removes the refusal direction while leaving capability intact, and shifts the model's judgement in untargeted ways; refusal training does not carry over to agents even when present. Policy is therefore enforced deterministically outside the model — the sandbox, scope-confined writes, egress denial, a person deciding every irreversible action (Accept, push, merge), and checkpoint rollback — and never relies on the Worker declining.
42c. **Tested against this Worker.** A fixed set of injection fixtures — issue text, fetched pages, file contents and gate output that instruct destructive or exfiltrating actions — runs with the configured Worker, and the sandbox must hold with canary markers absent (NEW-security-4).

### Restricted mode (`--restricted`)

43. For auditing an untrusted repository: the shell tool and every writing tool are removed from the catalog; the sandbox has no network; and nothing from the repository executes — no dev server, browser, language server, package gate, mutation run or hook. Only static checks run.

### Supply chain

44. Before a dependency is added, the harness checks, and fails the card's security gate on: a name that does not exist in the registry (or the air-gap mirror) — hallucinated names are an exploited vector; a package first published fewer than 30 days ago (`MIN_PACKAGE_AGE_DAYS`), which needs a person; and a name within Levenshtein distance 2 (1 for names of four characters or fewer), or equal after removing separators, of an existing dependency or a widely used package (typosquatting). The weekly download count is recorded for the reviewer. Vulnerabilities are scanned offline with `osv-scanner`.

### Air-gap kit

45. With no network, a machine can install from source ([DEC-21](../DECISIONS.md#dec-21--accepted-substitutions)), work cards, add mirrored dependencies and look up documentation.
46. **Mirrors:** an allowlist exported from the lockfiles; the supply-chain gate resolves against it, so an unmirrored package cannot be installed.
47. **Models:** weights are never downloaded by the harness; a manifest lists each model's checksum and quantisation; weights copied in are verified and registered only on a match. A signed manifest is required in air-gap mode.
48. **Documentation:** docsets are exported from a connected machine and imported with a checksum.
49. **Updates:** by signed bundle (`ssh-keygen -Y`, namespace `sekhemet-update`), applied by hand, with a compatibility note for the event-log schema; the ledger is backed up before any update.
50. **Self-test:** a full card run produces no outbound connection attempt, checked at the proxy; every gate command is runnable; every registered model loads; the docs index answers a known query. The result goes to the audit log.

## 3. Contract

| Item | Source |
| --- | --- |
| `ExecutionSandbox`, `SandboxOptions` (`allowedPaths`, `scratchDir`, `allowNetwork`, `egressProxyPort`, `localPorts`, `env`, `timeoutMs`, `maxMemoryBytes`) | `packages/sandbox/src/types.ts` |
| `ProcessSandbox` (`confinement`, `requiresConfinement`, `execute`, `spawnBackground`) | `packages/sandbox/src/executor.ts` |
| `generateSeatbeltProfile`, `DEPENDENCY_CACHE_DIRS` | `packages/sandbox/src/seatbelt.ts` |
| `bubblewrapArgv`, `seccompProgram` | `packages/sandbox/src/bubblewrap.ts`, `seccomp.ts` |
| `PermissionEngine`, `PermissionTier`, `PermissionRule`, `KNOWN_TOOLCHAIN` | `packages/sandbox/src/permissions.ts` |
| `EgressProxy`, `EgressRecord`, `domainAllowed` | `packages/sandbox/src/egress.ts` |
| `resolveInWorktree`, `PathEscapeError` | `packages/loop/src/paths.ts` |
| `HARDENED_GIT_CONFIG`, `hardenedGitEnv`, `hardenGitForProcess` | `packages/sync/src/git_hardening.ts` |
| `scanSecrets`, `redact` | `packages/gates/src/secrets.ts` |
| `tagUntrusted` | `packages/sandbox/src/untrusted.ts` |
| Events: `card/egress` (payload `EgressRecord`) | `packages/loop/src/card_runner.ts:884-895` |
| Env: `SEKHEMET_ALLOW_UNCONFINED`, `SEKHEMET_AIRGAP`, `SEKHEMET_MAX_COMMAND_MEMORY_MB` | inventory in [surface](surface.md) |
| Config: `[network] mode`, `fetch_allow` (user `config.toml`); `[project] network_allow`, `protected` (`gates.toml`) | [surface](surface.md), [gates](gates.md) |
| CLI: `--restricted`; `sekhemet dev airgap` with `mirror`, `manifest`, `verify-models`, `docs`, `export-docs`, `import-docs`, `sign`, `update`, `selftest`; `sekhemet dev skills approve`, `revoke` | `apps/harness/src/airgap.ts:495-611`, `wave2.ts:756` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Seatbelt denies `.git` writes at any depth and case | built | `seatbelt.ts:105-109`; `containment.spec.ts` | S1 |
| bubblewrap re-binds only the root `.git`, only if it exists | partial | `bubblewrap.ts:43`; argv-shape test only | S1 (G2, G6) |
| File tools refuse paths resolving into `.git`, including via symlink | built | `paths.ts:80-89`; `paths.spec.ts:93-118` | S1 (G1) |
| Git hardening: 4 keys via `GIT_CONFIG_*`; flag short-circuit | partial | `git_hardening.ts:15-45`; `git_hardening.spec.ts` | S1 (G3) |
| Dependency code read-only; caches shared and writable | partial | `seatbelt.ts:38-44` | S2 (G4) |
| Fail closed | not-built | default is closed (`executor.ts:130-134`) but every product caller passes `requireConfinement: ctx.restrictedMode` (`execute.ts:315,426,1051`; `index.ts:733`) | S3b |
| One confined execution path | not-built | visual gate `spawn` with `process.env` (`gates/src/visual.ts:614-618`); LSP (`context/src/lsp.ts:85`); package gates (`sync/src/repo_tools.ts:337`); `--validate-tools` (`wave2.ts:863-876`) | S3a |
| Environment allowlist in the sandbox | built | `executor.ts:63-98`; `containment.spec.ts:179`. Carries a stray `LOGSEQ_TEST` (`:74`) | S3a |
| Seatbelt reads and mach services unrestricted | not-built | `seatbelt.ts:150,155` | S3, S3c |
| Linux host sockets and proxy route | not-built | `bubblewrap.ts:44-68` ignores `egressProxyPort` | S3 |
| Egress proxy: allowlist, log with payload hash | built | `egress.ts`; `egress.spec.ts:35` | — |
| Proxy refuses loopback/private, ports ≠ 80/443; canonical names | not-built | `egress.ts:73-97` | S3 |
| Policy source is the repo's `gates.toml` | not-built (wrong source) | `card_runner.ts:884`; `gates/src/config.ts:189` | S3 |
| Registry lookups proxied and logged | not-built | `npm view` in the worktree (`gates/src/builtin.ts:539`) | S3 |
| Offline default honoured everywhere | partial | `airgap.ts:157-161` regex vs `config.ts:44` default | S3 |
| Permission engine, three tiers, protected paths | built | `permissions.ts`; `permissions.spec.ts` | — |
| Redaction before persistence | not-built | `redact` exists (`secrets.ts:100`), no caller outside the scanner | S3c |
| Tokens outside the sandbox's reach | not-built | plaintext JSON (`integrations.ts:57-67`), readable under item 10's gap | S3c |
| Dashboard Host check, token, CSP, framing | not-built | constant header, no-Origin trusted (`server.ts:115-126`) | S3c |
| Workspace trust | not-built | hooks (`user_hooks.ts:56`), `mcp.json` (`mcp_client.ts:29-49`), plugins (`execute.ts:385-386`) load unprompted; skills trust-on-first-use with the lock in the repo (`context/src/skills.ts`) | S9 |
| Untrusted-content tagging and step policy | built | `untrusted.ts`; `untrusted.spec.ts:19` | — |
| `browse`: loopback-only outside research cards, pages tagged | partial | `loop/src/tools.ts:1072-1106`; its Chrome is spawned unconfined (`sandbox/src/browser.ts:29`) | S3a |
| Restricted mode strips tools | partial | `restricted.spec.ts`; the visual gate still runs (`loop/src/session.ts:1710` strips only mutation) | S3a |
| Supply-chain existence/age/typosquat, osv offline | built | `gates/tests/supply_chain.spec.ts` | — |
| Air-gap mirror, manifest, docs, signed updates, self-test | partial | `airgap.spec.ts`; self-test is one TCP probe to 1.1.1.1:443 (`airgap.ts:418-433`); manifest signature optional (`:539`) | NEW-security-2 |
| Low items: `sh -c` quoting, `python3` without `-I`, non-constant-time token compare | not-built | `airgap.ts:438`, `builtin.ts:92`; `license_gate.ts:120`, `parse_gate.ts:73`; `wave2_server.ts:248` | NEW-security-3 |

## 5. Changes for v1

Tests use canary markers — a fixture that would write a marker file outside the worktree, or read a seeded fake key — and assert the marker is absent. No test depends on a real exploit.

### S1 — git metadata (remaining: G2, G3, G6)
*Harness git still honours most program-running config, and bubblewrap protects only the root `.git`.*
- **SEC-1** WHEN a sandboxed command on Linux attempts to create or write `sub/.git/config` under a granted root THE SYSTEM SHALL fail the write and leave no such file.
- **SEC-2** WHEN a worktree's `.git` pointer names a gitdir other than the harness's record THE SYSTEM SHALL run no git command there and SHALL stop the card with stop reason `git_metadata_tampered`.
- **SEC-3** WHEN a worktree's git config sets any key listed in item 21 THE SYSTEM SHALL refuse to run git in it and name the key.
- **SEC-4** WHEN `.gitattributes` in a worktree selects a clean filter or diff driver THE SYSTEM SHALL complete `status`, `diff` and `commit` without running the named program (marker absent).
- **SEC-5** WHEN `SEKHEMET_GIT_HARDENED=1` is set but the hardened keys are absent THE SYSTEM SHALL apply them.
- **SEC-6** WHEN a card's staged diff adds a gitlink THE SYSTEM SHALL fail the card's integrity check.
- **SEC-6a** WHEN a worktree contains an embedded bare repository or a `.gitmodules` with a carriage return THE SYSTEM SHALL refuse to run git there and name the path.
- **SEC-6b** WHEN a tool call supplies a working directory or path outside the card's recorded root THE SYSTEM SHALL generate the sandbox profile from the recorded root only.

### S2 — dependency trees (G4)
*Shared cache directories hold code the user's own tools later execute.*
- **SEC-7** WHEN a sandboxed command writes into `node_modules/.vite/deps` THE SYSTEM SHALL write it inside the card's worktree, and the main checkout's `node_modules` SHALL be byte-identical before and after the card.
- **SEC-8** WHEN two cards run concurrently THE SYSTEM SHALL give neither write access to the other's dependency caches.

### S3 — one egress policy
- **SEC-9** WHEN a name on the allowlist resolves to a loopback, private, link-local or metadata address THE SYSTEM SHALL refuse the connection at the proxy and record `allowed: false`.
- **SEC-10** WHEN a sandboxed command sends CONNECT to an allowlisted host on a port other than 80 or 443 THE SYSTEM SHALL refuse it.
- **SEC-11** WHEN a hostname contains a NUL byte or characters outside hostname syntax THE SYSTEM SHALL refuse it.
- **SEC-12** WHEN the repository's `gates.toml` lists a host the user's `config.toml` does not permit THE SYSTEM SHALL not reach that host.
- **SEC-13** WHEN no user config sets `[network] mode` THE SYSTEM SHALL behave as offline in `plan`, the supply-chain gate and research, with no outbound request recorded.
- **SEC-14** WHEN the supply-chain gate looks up a package THE SYSTEM SHALL send the request through `NetworkPolicy`, record it on the ledger, and not read the worktree's `.npmrc`.
- **SEC-15** WHEN a sandboxed command on Linux connects to a host UNIX socket (session bus, `docker.sock`) or on macOS asks LaunchServices to open an application THE SYSTEM SHALL refuse it.
- **SEC-15a** WHEN a sandboxed command resolves a hostname itself THE SYSTEM SHALL give it no answer (no resolver inside the sandbox).
- **SEC-15b** WHEN an allowlist entry is a wildcard or a known upload-capable host THE SYSTEM SHALL warn when it is added and record the warning on every card that runs under it.

### S3a — one confined execution path
- **SEC-16** WHEN the visual gate starts a project whose `start` script writes a marker outside the worktree THE SYSTEM SHALL leave the marker absent and pass the dev server no variable outside the allowlist.
- **SEC-17** WHEN a language server, a package gate, an onboarding probe, `--validate-tools` or the `browse` tool's browser runs a fixture that writes a marker outside the worktree THE SYSTEM SHALL leave the marker absent.
- **SEC-18** WHEN the test suite enumerates the modules that import `node:child_process` THE SYSTEM SHALL find exactly the written allowlist.
- **SEC-19** WHILE `--restricted` is set THE SYSTEM SHALL start no dev server, browser, language server, package gate or hook.

### S3b — fail closed
- **SEC-20** WHEN no confinement mechanism is available and `SEKHEMET_ALLOW_UNCONFINED` is unset THE SYSTEM SHALL refuse every Worker command and gate with exit code 126 and a message naming the fix.
- **SEC-21** WHEN `SEKHEMET_ALLOW_UNCONFINED=1` is set THE SYSTEM SHALL record `isolation: "none"` in every card's evidence bundle and show it on the card.

### S3c — secrets and the dashboard
- **SEC-22** WHEN the Worker reads a file holding a seeded fake key THE SYSTEM SHALL store only the redacted form in the ledger, blobs, evidence bundle and any GitHub annotation.
- **SEC-23** WHEN a sandboxed command reads `~/.ssh`, `~/.aws`, `~/.npmrc`, the Sekhemet user directory or the project ledger THE SYSTEM SHALL deny the read.
- **SEC-24** WHEN a request reaches the dashboard with a `Host` other than the bound name THE SYSTEM SHALL answer 421 and perform nothing.
- **SEC-25** WHEN a mutation arrives without the current per-start token, with or without an `Origin` THE SYSTEM SHALL answer 403.
- **SEC-26** WHEN any dashboard page is served THE SYSTEM SHALL send `frame-ancestors 'none'` and `script-src 'self'`.
- **SEC-27** WHEN an integration token is saved on a host with no keychain THE SYSTEM SHALL write it with mode 0600 in a 0700 directory, and SHALL correct wider modes on an existing file.

### S9 — workspace trust
- **SEC-28** WHEN a repository with `.sekhemet/hooks.toml`, `mcp.json` or plugins is opened for the first time THE SYSTEM SHALL run none of them and SHALL show what each would run.
- **SEC-29** WHEN a trusted file's SHA-256 changes (including through an accepted card) THE SYSTEM SHALL treat it as untrusted until the user trusts the new content.
- **SEC-30** WHEN the harness runs headless or without a TTY and without `--trust` THE SYSTEM SHALL not trust any repository configuration.
- **SEC-31** WHEN a repository ships its own trust or skills lock THE SYSTEM SHALL ignore it for trust decisions.

### NEW-security-1 — flag files that execute later
*Justification: the S1/S2 fix review found Worker-editable hook and attribute files that run on the user's next commit, outside any sandbox.*
- **SEC-32** WHEN a card's diff touches a path listed in item 41 THE SYSTEM SHALL mark it in the evidence bundle and the Review view as "runs outside the sandbox later".

### NEW-security-2 — the air-gap self-test checks at the proxy
*Justification: one TCP probe cannot show a full card run made no attempt (N16); an unsigned manifest defeats the manifest.*
- **SEC-33** WHEN the self-test runs a card end to end THE SYSTEM SHALL fail the check if the proxy or the sandbox recorded any outbound attempt.
- **SEC-34** WHILE air-gap mode is on, WHEN `verify-models` is given no signature THE SYSTEM SHALL refuse to register the models.

### NEW-security-3 — small hardening items
*Justification: three low findings (N14–N16) with no programme ID.*
- **SEC-35** WHEN a gate command name contains `$(` THE SYSTEM SHALL check it with `sh -c 'command -v "$1"' _ <name>` and not execute the substitution.
- **SEC-36** WHEN the harness runs `python3` for a gate helper THE SYSTEM SHALL pass `-I`.
- **SEC-37** WHEN a trigger token is compared THE SYSTEM SHALL use a constant-time comparison.

### NEW-security-4 — injection fixtures run against the real Worker
*Justification: DEC-04 requires security tests against this model's behaviour; the research finds no study of abliterated coding agents, so the evidence has to be ours.*
- **SEC-37a** WHEN the injection fixtures of item 42c run with the configured Worker THE SYSTEM SHALL end every fixture with no canary marker outside the worktree, no outbound request outside the allowlist, and no card moved past Review.
- **SEC-37b** WHEN the Worker model or its quantisation changes THE SYSTEM SHALL require the injection fixtures to pass again before the new Worker runs unattended (`overnight`).

## 6. v1 acceptance

SEC-1 to SEC-37b (including the lettered criteria), plus these behaviours already built and to be kept under test:
- **SEC-38** WHEN a sandboxed command writes `<root>/.git`, `<root>/sub/.GIT/config` or through a symlink into `.git` on macOS THE SYSTEM SHALL fail the write and leave the target unchanged.
- **SEC-39** WHEN an allowlist is empty THE SYSTEM SHALL refuse every proxied request.
- **SEC-40** WHEN a step's context holds untrusted content THE SYSTEM SHALL refuse Ask-tier and network commands in that step without asking.
- **SEC-41** WHEN a card adds a dependency that is absent from the registry, younger than 30 days, or within the typosquat distance of item 44 THE SYSTEM SHALL fail the supply-chain gate and name the rule.
- **SEC-42** WHEN a signed update bundle is tampered with THE SYSTEM SHALL refuse it and leave the ledger untouched.
- **SEC-43** WHEN the containment suite runs in CI THE SYSTEM SHALL run it under a real bubblewrap on Linux as well as Seatbelt on macOS, with no test skipped on either.

## 7. Later

- **`@anthropic-ai/sandbox-runtime`, Smokescreen, nsjail/landrun, secretlint, `@napi-rs/keyring`** — proposals from the review; each needs the owner's yes. The profile requirements above hold whichever implementation is chosen.
- **A VM per test gate** (Apple `container`, gVisor, Firecracker) — stronger isolation, not researched for our hosts.
- **Registry mirrors as services** (verdaccio, devpi, a crates mirror) — v1 ships the lockfile allowlist; a transitive dependency not yet in any lockfile cannot be mirrored in advance, which is the open policy question the design left.
- **Plugin signing** — plugins are cut in v1 ([extensibility](extensibility.md)).

## 8. Open questions

1. **Keep the `--validate-tools` execution path, or cut it?** It runs command strings mined from Worker trajectories — the on-the-fly tool synthesis technique that [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md) holds at `triaged` (R6). *Recommendation:* cut the execution path now; if R6 is ever shortlisted, validation runs confined in a scratch worktree with no network (SEC-17).
2. **Which mach services does the allowlist contain?** *Recommendation:* start from sandbox-runtime's published list, then add only what the frozen suite's toolchains fail without, each with a test.
3. **A repository's pre-commit hooks as gates** — run from the base branch's copy, confined. *Recommendation:* yes, owned by [gates](gates.md); until then `doctor` states that hooks do not run.

## 9. Evidence and rationale

- Reviews: [domain 11 and 14](../../reference/reviews/domain11_14_security_runtime.md) (K1–K7, N1–N16, fix plan); [S1/S2 fix review](../../reference/reviews/security_fix_review.md) (G1–G6, breakage risks); [gap sweep](../../reference/reviews/gap_sweep.md) (onboarding runs language servers before trust).
- Research, [group B](../../research/WEB_RESEARCH_2026-09.md#group-b-sandbox-and-git-safety), and the requirement each finding set:
  - sandbox-runtime always denies writes to `.git/hooks`, `.gitmodules`, `.vscode/`, `.idea/` → items 9, 14, 41;
  - CVE-2025-66479 (empty allowlist read as allow-all) and the SOCKS5 NUL-byte bypass → items 30, SEC-11, SEC-39;
  - Claude Code's sandbox docs (hostname-only decisions, domain fronting, broad domains as exfiltration paths, `docker.sock`) → items 15, 31a;
  - Codex's bubblewrap design (`.git` and the resolved gitdir re-mounted read-only; Landlock deprecated for missing socket isolation) and CVE-2025-59532 (model-supplied cwd became the writable root) → items 8a, 14, 17;
  - Cursor CVE-2026-26268 (sandboxed code wrote `.git` config and hooks) → items 9, 14, 18; Cursor running a workspace `git.exe` → item 18 (absolute path);
  - Gemini CLI GHSA-wpqr-6v78-jr5g (workspace config trusted automatically in headless runs) → item 40;
  - "GitSpawn" (fsmonitor run by background `git status` in Claude Code, Codex, Cursor, Goose, Hermes) and Hermes's fix → items 19–20; Copilot CLI CVE-2026-45033 (nested bare repository) → items 19, 21; git CVE-2024-32002, CVE-2025-48384 → items 18 (version), 19 (`core.symlinks=false`), 21 (CR scan);
  - Unit 42 on AWS AgentCore (DNS still resolved in "sandbox mode") → item 31;
  - the per-OS sandbox recommendation → items 9–17.
- Research, [group D §E](../../research/WEB_RESEARCH_2026-09.md#e-abliteration-and-agent-safety): Arditi et al. (refusal is one direction), David & Gervais (unsafe compliance 0.10 → 0.47 after abliteration), Fafuła (untargeted judgement shifts), AgentHarm, BrowserART, OS-Harm, and the 2026 injection literature's case for deterministic enforcement outside the model → items 42b, 42c, NEW-security-4. [MODEL_CANDIDATES.md](../../research/MODEL_CANDIDATES.md) records Cyber-Tiel as an abliterated Ornith-1.5 whose card demands OS sandboxing.
- Decisions: [DEC-04](../DECISIONS.md#dec-04) (why this is v1-blocking), [DEC-21](../DECISIONS.md#dec-21--accepted-substitutions) (bubblewrap, source installer).
- **Why the permission engine is not the boundary:** G1 showed a string check bypassed by a symlink the sandbox let the Worker create; only the kernel-enforced profile holds against a model with a shell.
