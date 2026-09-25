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
  - packages/sync/src/git_preflight.ts
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
  - packages/sync/tests/git_preflight.spec.ts
  - packages/sandbox/tests/fail_closed.spec.ts
  - apps/harness/tests/security_small.spec.ts
  - apps/harness/tests/ask_tier.spec.ts
  - packages/gates/tests/executes_later.spec.ts
  - packages/loop/tests/paths.spec.ts
  - packages/loop/tests/restricted.spec.ts
  - packages/loop/tests/untrusted.spec.ts
  - apps/harness/tests/airgap.spec.ts
changes: [S1, S2, S3, S3a, S3b, S3c, S9, NEW-security-1, NEW-security-2, NEW-security-3, NEW-security-4, NEW-security-5, NEW-security-6, NEW-security-7, NEW-security-8, NEW-security-9, NEW-security-10]
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
4a. **`--validate-tools` is kept and confined, not cut** (decided 2026-09-24, §8 Q1). It runs command strings mined from the Worker's trajectories — on-the-fly tool synthesis, held at `triaged` in [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md) (R6) — so each candidate is Worker-written code: it runs through `runConfined()` in a scratch worktree created from the base branch for the validation and deleted after it, with no network, the allowlisted environment of item 6 and its 60 s timeout, never in the main checkout. A validated candidate is only written to `.sekhemet/tool-candidates/`; it never joins the Worker's tools (R6 stays `triaged`). Built in B1 with the rest of S3a (SEC-17a). *Changed from the code:* today it runs with `execFileSync` in the repository root with the harness's full environment (`wave2.ts:863-876`).
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
13. `sandbox-exec` is deprecated by Apple. It stays the macOS mechanism behind the sandbox interface, with containment tests that fail loudly if its behaviour changes. This is a **recorded known liability** (open question 4): if Apple removes it, a Mac has no confinement, item 7 stops every card, and the fallback is a VM per card (§7).

### Linux profile (bubblewrap)

14. `--ro-bind / /`, writable binds for the granted roots, then every `.git` under a root (any depth) re-bound read-only; `--unshare-all`, `--die-with-parent`, `--new-session`, a private `/tmp` (S1/G2, S3).
15. Host UNIX sockets are unreachable: `/run/user`, the D-Bus session bus and `docker.sock` are masked, and seccomp refuses creating `AF_UNIX` and `AF_INET` sockets except to the proxy, which is reached through a bind-mounted UNIX socket (S3).
16. The harness refuses to run git in a root whose `.git` it did not create itself (G6).
17. Linux runs bubblewrap, not Landlock ([DEC-21](../DECISIONS.md#dec-21--accepted-substitutions)); Landlock and seccomp are hardening layers on top.

### Git run by the harness (S1, G3)

18. The harness runs git outside the sandbox, at an absolute path, version ≥ 2.50.1, with `GIT_DIR` and `GIT_WORK_TREE` pinned from its own record of the worktree (`<main>/.git/worktrees/<name>`), so a rewritten `.git` pointer changes nothing.
19. Pinned for every harness git call: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`, `GIT_PAGER=cat`, empty `GIT_ASKPASS`/`SSH_ASKPASS`, `GIT_CEILING_DIRECTORIES`; and through `GIT_CONFIG_*`: `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.untrackedCache=false`, `core.sshCommand=false`, `core.symlinks=false`, `credential.helper=`, `gpg.program=false`, `commit.gpgSign=false`, `log.showSignature=false`, `diff.external=`, `protocol.file.allow=never`, `submodule.recurse=false`, `diff.ignoreSubmodules=all`, `safe.bareRepository=explicit`. Found in B1:
    - `include.path=` and `diff.external=` are not pinned. Git refuses an empty include given on the command line, and an empty external diff makes git try to run "" on every diff that prints a patch. The item 21 preflight refuses both in repository config instead, and every harness diff passes `--no-ext-diff --no-textconv`.
    - `core.symlinks=false`, `protocol.file.allow=never` and `GIT_CEILING_DIRECTORIES` are pinned only for git in a card's worktree (`guardedGitEnv`), never process-wide. In the user's own checkout they would write symlinks as text files and refuse local-path clones. `GIT_CONFIG_GLOBAL` points at a harness-written file holding only the user's `[user]` name and email, so commits keep the user's identity and a repository's own identity still wins.
20. `diff`, `log` and `show` run with `--no-ext-diff --no-textconv`; commits with `--no-verify`; nothing uses `--recurse-submodules`.
20b. **One named exception today:** the review diff runs `git -c diff.external=difft --ext-diff` (`packages/sync/src/git_adapter.ts:721`), so a harness-chosen parser reads worktree content outside the sandbox. A program the harness runs over worktree content outside the sandbox must be on a fixed allowlist, resolved by absolute path, run with the hardened git environment, no network, and time and memory limits; otherwise it runs confined. Carried by S3a.
21. **Preflight:** before git runs in a worktree, the harness reads its config with `--no-includes` and refuses on any of `core.fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy`, `filter.*`, `diff.*.(command|textconv)`, `merge.*.driver`, `include*`, `gpg.*`, `credential.*`, `remote.*.(uploadpack|receivepack)`; scans the worktree for embedded bare repositories (a directory holding `HEAD` and `objects`), `.git` files or symlinks below the root, and carriage returns in `.gitmodules` (CVE-2025-48384); and fails the card if the staged diff adds a gitlink (mode 160000) or a nested bare repository.
22. "Already hardened" is decided by checking the keys are present, never by trusting an environment flag.
23. Consequence, stated to the user by `doctor` and the README: Sekhemet's own git commands never run git hooks or fsmonitor. The project's pre-commit checks belong in gates, run confined from the base branch's hook files ([review-git](review-git.md) owns Accept and LFS).

### Dependency trees (S2, G4)

24. The shared dependency tree is never writable from a card — `node_modules`, a Python `.venv`, and any other dependency directory the harness links into a worktree. Each worktree gets its own `node_modules` directory whose entries are links into the main checkout; caches (`.vite`, `.vite-temp`, `.cache`, `.tmp`) are created inside the worktree and deleted with it. A `.venv` is linked whole and read-only: an interpreter that cannot write bytecode caches there runs without them, and a card that needs a new Python package adds it through the supply-chain gate (item 44), not by installing into the shared environment. No write grant reaches outside the worktree.

24a. **Per-card worktrees.** Each card works in its own git worktree under `.sekhemet/worktrees/<card>`, the only writable root its sandbox is granted (plain worktrees, not copy-on-write clones: [DEC-21](../DECISIONS.md#dec-21--accepted-substitutions)).

### Permission engine

25. Three tiers, **Allow**, **Ask**, **Deny**; Deny wins. Allow: reads inside the repo, writes inside the declared scope. Ask: destructive commands (recursive force-remove, `git reset --hard`, `git clean -f`, `sudo`, `kill -9`, `chmod 777`), network commands to allowlisted hosts, external binaries not provided by the toolchain or the project. Deny: writes outside scope, paths that resolve outside the worktree, and protected paths — gate files, test globs the project protects, `.git` at any depth, `.githooks/`, `.sekhemet/` state and extension files (`hooks.toml`, `mcp.json`, `skills/`, `plugins/`), and the harness's own loop, gate runner and sandbox sources. The agent cannot override a Deny.
25a. **How an Ask is answered.** An Ask-tier call posts a `permission` decision request on the card — "Allow <tool>: <command or path>?", options deny and allow, recommendation deny — answered from the board, the CLI or `/api/decisions`. With no answer within 60 s (`approvalTimeoutMs`) the call is denied; with no approver attached (a headless caller) it is denied at once; either way the model is told why and not to retry. The Worker keeps its slot while it waits. In the Team setup only a person the project's Accept rule names may answer ([integrations](integrations.md) item 26, [teams](teams.md) item 7).
26. The engine decides on the **resolved** path (symlinks followed), not the string the model supplied.
27. The engine is a usability layer; the sandbox is the security boundary. No protection may exist only in the engine.

### Egress (S3)

28. One network policy, in the one schema [surface](surface.md) item 24 owns: `[network] mode`, `fetch_allow`, `fetch_deny` and `research`. `research` is **the one exception to `mode`**: it covers only the Researcher's harness-side requests (item 32), always through `NetworkPolicy` and logged, and it never reaches a sandbox (item 29a). The user's `config.toml` is authoritative; a project's `config.toml` may only add hosts to `fetch_deny`, narrow `fetch_allow` and set `research = "no"` for itself, never widen `mode` or `research`; `fetch_deny` wins over everything. A card's sandboxed commands are narrowed once more by the repository's `gates.toml` `[project] network_allow` (empty: the card's commands reach nothing), which can never add a host the effective `fetch_allow` lacks.
29. Offline is the default. With `mode = "offline"` no sandboxed command has a route out, and harness-side requests reach only loopback — except the Researcher's requests under `research = "yes"` (item 29a), the one exception to `mode`.
29a. **Research asks once** (the default of owner decision [O16](../../reference/OPEN_QUESTIONS.md#owner-decisions), pending). Research before building needs the network, and nothing may leave the machine without a person's yes. So the first time a person starts a new project, the harness asks one question — whether research may use the network — before any outbound request; the question and its effect are [design-stage](design-stage.md)'s (S8). The answer is recorded once, as `[network] research = "yes"|"no"` in the user's `config.toml` (the one authoritative source, item 28; [surface](surface.md) item 24), and applies to every later project without asking again; `mode` is not changed by it. A yes enables only the harness-side research requests of item 32, through `NetworkPolicy` and logged; it never opens a route for a card's sandboxed commands, which stay narrowed by `network_allow` (item 28). **What a yes reaches** (lead's decision, 2026-09-24, on the final check's F1): the hosts in the effective `fetch_allow` if that list is non-empty, otherwise any public host, minus `fetch_deny` — whatever `mode` says. So a yes never widens a list the person wrote: a person who chose `allowlist` gets no wider policy for research than for anything else. A project's `config.toml` may set `research = "no"` for itself (item 28), never `yes`. A no, or no answer, keeps research offline (NEW-security-8, SEC-52, SEC-52a, SEC-52b).
30. With an allowlist, sandboxed commands reach the network only through the harness's proxy, whose list is the effective `fetch_allow` narrowed by `network_allow`, minus `fetch_deny`. The proxy: treats an empty allowlist as deny-all; canonicalises hostnames and rejects NUL bytes and non-hostname characters; resolves names itself and refuses loopback, private, link-local and metadata addresses after resolution; allows only ports 80 and 443; and records every request, allowed or refused, as a `card/egress` event with the SHA-256 of its payload.
31. The sandbox has no resolver of its own (DNS is itself an exfiltration channel).
31a. An allowlist names exact hosts. The proxy decides on the hostname the client supplies and does not inspect TLS, so a broad or upload-capable entry — a wildcard, a code host such as `github.com`, a registry's publish endpoint — is an exfiltration path: it is accepted only with a warning shown when it is added and recorded on every card that runs under it.
32. Every harness-side outbound request that input from the Worker or a repository can influence — registry lookups for the supply-chain gate, research fetches, repository clones — goes through one `NetworkPolicy` wrapper that applies the mode — or, for a research fetch only, `research` and `fetch_allow` as item 29a says — and logs to the ledger. Registry lookups never run inside a worktree (so a worktree `.npmrc` is ignored).
33. Integrations the user connected (GitHub, Slack, ntfy, OTLP) are allowed destinations because connecting them is the consent; they are still logged, and `offline` blocks all of them except loopback.

### Secrets (S3c)

34. Command lines, observations, context packs, gate excerpts and evidence are redacted with the secret scanner **before** they are persisted or published. Redaction is the plan; erasure is the backstop: once the kernel's erasable `private` part exists ([kernel](kernel.md) NEW-kernel-1, hash chain v3), a secret the scanner missed can be erased without breaking the chain (item 34b). Until then the hash-chained ledger cannot be purged, so a secret must never reach it.
34a. **Nothing personal or secret is committable by accident.** Evidence bundles, transcripts, artifacts, research pages, observations, live token files, tuning data, traces and the queue report can hold names, prompts and redaction misses; the first run ignores all of them in `.gitignore` ([surface](surface.md) item 5.6, SUR-34). Only `config.toml`, `gates.toml` and documents exported for the team are meant to be tracked. Git history cannot be cleaned without rewriting every later hash, and forks keep the data, so no ledger erasure can reach a committed transcript.
34b. **A secret found after the fact** is handled in this order (erasure amends spine rule 2 — anything a model saw can be reconstructed *except content erased by a recorded `ledger/erased` event, which replay names as a gap*; owner decision O1, decided 2026-09-24, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)): the person is told to rotate it first; then the affected `private` fields are erased with reason `secret` and every blob holding it is deleted; the evidence bundle keeps its identity because its gate excerpts and command lines sit in an erasable part whose commitment the bundle id covers (NEW-security-7; the mechanism is [kernel](kernel.md)'s, the bundle is [gates](gates.md)').
35. Integration tokens live in the OS keychain; where none exists (Linux without a secret service), in a file of mode 0600 inside a directory of mode 0700 in the user directory, which the sandbox cannot read (item 10). Webhook URLs are secrets. *Changed from the old design's "keychain only, never written to disk":* a Linux host without a secret service has no keychain, and a file the sandbox cannot read is the least-bad fallback.
35a. **The credential store** (Team setup, [teams](teams.md) item 16) holds what people sign in with: password hashes (scrypt), passkey public keys and personal-access-token hashes, and the setup token's hash until it is used (the token itself is only in the 0600 file of [teams](teams.md) item 2). It is one file of mode 0600 in the server's data directory, in a directory of mode 0700, **outside `events.db`**, which the sandbox cannot read (item 10). It is included in every backup and restored with it, and **never exported**: no project export, audit export or tracker sync reads it. The event log records only that a credential was created, used, reset or revoked ([teams](teams.md) TEAM-11). An existing file with wider modes is corrected at start-up, as for item 35's token file.
36. The gate host's CA key is stored encrypted and certificates are valid for at most one year.

### Dashboard as an attack surface (S3c)

37. One guard at the top of the server: requests whose `Host` is not the bound name are refused (DNS rebinding); every mutation carries a random per-start token that the dashboard page receives from the server, replacing the constant `X-Sekhemet-Action: 1`; a request with no `Origin` is trusted only with that token; responses send `Content-Security-Policy: frame-ancestors 'none'; script-src 'self'`. Binding and per-person sessions for the Team setup are in [runtime](runtime.md) and [teams](teams.md) (DEC-35).

### Workspace trust (S9)

38. Repository-supplied configuration that makes the harness run code outside the sandbox — `.sekhemet/hooks.toml`, `.sekhemet/mcp.json`, skill `scripts/` — is inert until the user trusts it. Plugins are not in this list because they are cut in B0, before workspace trust is built: nothing is loaded from `.sekhemet/plugins/` in any workspace ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O4; [extensibility](extensibility.md) item 29, EXT-28). [Extensibility](extensibility.md) lists what each gates.
39. Trust is recorded in the user directory, never in the repository, keyed by the repository's real path and the SHA-256 of each trusted file. A changed hash is untrusted again, including after an Accept merges a Worker's edit to one of these files.
40. The trust prompt shows exactly what would run. Headless and non-TTY runs never trust implicitly; `--trust` must be given per invocation.
41. The Review evidence flags any diff to files that execute later outside the sandbox: the paths in item 38, `.githooks/`, `.husky/`, `.pre-commit-config.yaml`, `.gitattributes`, `.gitmodules`, editor and container task configuration (`.vscode/`, `.idea/`, `.devcontainer/`), `.envrc` (direnv) and CI workflows (`.github/workflows/`), matched without regard to case (NEW-security-1; the last three and case-insensitivity added in the B1 review).

### Untrusted content

42. Issue text, PR comments, fetched pages and synced data enter prompts wrapped as `<untrusted_content source="…">…</untrusted_content>`, with a system contract that instructions inside issue no tool calls. A step whose context holds untrusted content cannot use Ask-tier or network commands.
42a. **The Worker's browser.** `browse` reaches only the card's own app on loopback, except on research cards; its pages are untrusted content unless loopback; the browser runs confined (item 4); it reads and screenshots only — a tool that clicks or types into a page needs the card's scope to name a URL allowlist, and its screenshots go to the evidence bundle.
42b. **Prompt injection has no model-level fix, and the v1 Worker has no refusals.** Abliteration removes the refusal direction while leaving capability intact, and shifts the model's judgement in untargeted ways; refusal training does not carry over to agents even when present. Policy is therefore enforced deterministically outside the model — the sandbox, scope-confined writes, egress denial, a person deciding every irreversible action (Accept, push, merge), and checkpoint rollback — and never relies on the Worker declining.
42c. **Tested against this Worker.** A fixed set of injection fixtures — issue text, fetched pages, file contents and gate output that instruct destructive or exfiltrating actions — runs with the configured Worker, and the sandbox must hold with canary markers absent (NEW-security-4).

### Restricted mode (`--restricted`)

43. For auditing an untrusted repository: the shell tool and every writing tool are removed from the catalog; the sandbox has no network; and nothing from the repository executes — no dev server, browser, language server, package gate, mutation run, hook or repository script. What runs is read-only inspection: the harness's own parse and outline of files (the TypeScript compiler, [DEC-20](../DECISIONS.md#dec-20)) and static checks the harness runs itself, never through a repository script. A structural diff preview joins once review-git's difftastic path writes nothing to the repository ([review-git](review-git.md) RG-S5-19): today it can run `git add -A` or `checkout` in the repository root when the worktree is gone ([review-git](review-git.md) §4), which an audit of an untrusted repository must never do.

### Supply chain

44. Before a dependency is added, the harness checks, and fails the card's security gate on: a name that does not exist in the registry (or the air-gap mirror) — hallucinated names are an exploited vector; a package first published fewer than 30 days ago (`MIN_PACKAGE_AGE_DAYS`), which needs a person; and a name within Levenshtein distance 2 (1 for names of four characters or fewer), or equal after removing separators, of an existing dependency or a widely used package (typosquatting). Each manifest is checked against **its own registry** — `package.json` against npm, `requirements.txt`/`pyproject.toml` against PyPI, `Cargo.toml` against crates.io, `go.mod` against the Go proxy — because a Python name checked against npm is not a check. The **download profile** is advisory, never blocking (a new or internal library sits below any useful floor): under 100 downloads a week on npm or PyPI, or 1,000 lifetime on crates.io (which reports no weekly figure), the gate reports the number for the reviewer; Go has no floor. Vulnerabilities are scanned offline with `osv-scanner`.

### Air-gap kit

45. With no network, a machine can install from source ([DEC-21](../DECISIONS.md#dec-21--accepted-substitutions)), calibrate ([models](models.md) rule 7: calibration measures only the local machine and needs no network), work cards, add mirrored dependencies and look up documentation.
46. **Mirrors:** an allowlist exported from the lockfiles (for pnpm, the store is filled from the lockfile with `pnpm fetch`, so `pnpm install --offline` works); the supply-chain gate resolves against it, so an unmirrored package cannot be installed — the correct default when there is no network.
47. **Models:** the harness never downloads weights on its own. Weights are downloaded only when a person explicitly asks, from the **Configuration page** ([dashboard](dashboard.md) NEW-dashboard-6; [models](models.md) NEW-models-7, NEW-models-12), where the harness recommends a model per role and a person chooses to download it; the published SHA-256 is verified before the weights are used, and a file whose hash differs is deleted, never registered (owner decision O2, decided 2026-09-24, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue); DEC-25 R7). The download is a harness-side request under the one network policy — logged on the ledger with its source, refused in `offline` mode with the reason shown on the page (item 29) — and weights never pass through a sandbox (NEW-security-9, SEC-53). In air-gap mode weights are copied in by hand. A manifest lists each approved model's checksum, quantisation, chat-template checksum and the tier it qualifies for; weights are registered only when both checksums match, and the qualification suite still runs on this machine, because a model that qualifies on one machine may not on another. A signed manifest is required in air-gap mode.
48. **Documentation:** a library's docs are prefetched into the research cache on a connected machine, exported as one bundle with its SHA-256, and imported on the air-gapped one — the same route carries the whole research cache. The bundle holds docsets and `llms.txt` snapshots at the versions the lockfiles pin, and is marked stale (and named by the self-test) when a lockfile changes after it was built (NEW-security-5).
49. **Updates:** by signed bundle (`ssh-keygen -Y`, namespace `sekhemet-update`), applied by hand, with a compatibility note for the event-log schema; the ledger is backed up before any update, and the log is never migrated in place without that backup. Skill updates travel the same signed route in air-gap mode (NEW-security-5). Plugins have no update route: they are cut (item 38).
50. **Self-test:** a full card run produces no outbound connection attempt, checked at the proxy; every gate command is runnable; every registered model loads; the docs index answers a known query. The result goes to the audit log.

## 3. Contract

| Item | Source |
| --- | --- |
| `ExecutionSandbox`, `SandboxOptions` (`allowedPaths`, `scratchDir`, `allowNetwork`, `egressProxyPort`, `localPorts`, `env`, `timeoutMs`, `maxMemoryBytes`) | `packages/sandbox/src/types.ts` |
| `ProcessSandbox` (`confinement`, `requiresConfinement`, `execute`, `spawnBackground`) | `packages/sandbox/src/executor.ts` |
| `confinedSandbox(restricted)`, the one constructor for Worker and gate sandboxes (S3b); `RunSettings.isolation` (SEC-21) | `packages/sandbox/src/executor.ts`; `packages/gates/src/evidence.ts` |
| `generateSeatbeltProfile`, `DEPENDENCY_CACHE_DIRS` | `packages/sandbox/src/seatbelt.ts` |
| `bubblewrapArgv`, `seccompProgram` | `packages/sandbox/src/bubblewrap.ts`, `seccomp.ts` |
| `PermissionEngine`, `PermissionTier`, `PermissionRule`, `KNOWN_TOOLCHAIN` | `packages/sandbox/src/permissions.ts` |
| `EgressProxy`, `EgressRecord`, `domainAllowed` | `packages/sandbox/src/egress.ts` |
| `resolveInWorktree`, `PathEscapeError` | `packages/loop/src/paths.ts` |
| `HARDENED_GIT_CONFIG`, `hardenedGitEnv`, `hardenGitForProcess` | `packages/sync/src/git_hardening.ts` |
| `scanSecrets`, `redact` | `packages/gates/src/secrets.ts` |
| `tagUntrusted` | `packages/sandbox/src/untrusted.ts` |
| `decisionApprover` (the Ask-tier approver; `approvalTimeoutMs`, default 60,000) | `apps/harness/src/execute.ts:141-165` |
| `DEPENDENCY_MANIFESTS`, `MIN_PACKAGE_AGE_DAYS`, `MIN_WEEKLY_DOWNLOADS`, `DEFAULT_REGISTRY_ENDPOINTS` | `packages/gates/src/builtin.ts` |
| `ManifestModel` (`sha256`, `quant`, `tier`, `templateChecksum`) | `apps/harness/src/airgap.ts:165-173` |
| Events: `card/egress` (payload `EgressRecord`) | `packages/loop/src/card_runner.ts:884-895` |
| Env: `SEKHEMET_ALLOW_UNCONFINED`, `SEKHEMET_AIRGAP`, `SEKHEMET_MAX_COMMAND_MEMORY_MB` | inventory in [surface](surface.md) |
| Config: `[network] mode`, `fetch_allow`, `fetch_deny` (user `config.toml`, narrowed by the project's; [surface](surface.md) item 24 owns the schema); `[project] network_allow`, `protected` (`gates.toml`) | [surface](surface.md), [gates](gates.md) |
| CLI: `--restricted`; `sekhemet dev airgap` with `mirror`, `manifest`, `verify-models`, `docs`, `export-docs`, `import-docs`, `sign`, `update`, `selftest`; `sekhemet dev skills approve`, `revoke` | `apps/harness/src/airgap.ts:495-611`, `wave2.ts:756` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Seatbelt denies `.git` writes at any depth and case | built | `seatbelt.ts:105-109`; `containment.spec.ts` | S1 |
| bubblewrap re-binds only the root `.git`, only if it exists | partial | `bubblewrap.ts:43`; argv-shape test only | S1 (G2, G6) |
| File tools refuse paths resolving into `.git`, including via symlink | built | `paths.ts:80-89`; `paths.spec.ts:93-118` | S1 (G1) |
| Git hardening: item 19's keys and pins; an identity-only global config; "hardened" decided by the keys (SEC-5) | built (B1) | `HARDENED_GIT_CONFIG`, `HARDENED_GIT_PINS`, `identityConfig`, `isHardened` (`git_hardening.ts`); `git_preflight.spec.ts`, `git_hardening.spec.ts`. `include.path` is not pinned: git refuses an empty include on the command line, so includes are refused by the preflight instead | S1 (G3) |
| Worktree preflight and pinned gitdir (items 18, 21) | built (B1) | `preflightWorktree`, `recordedGitDir`, `stagedGitlinks` (`git_preflight.ts`); `guardedGitEnv`/`gitEnvFor` pin `GIT_DIR`/`GIT_WORK_TREE` from the harness's record, `GIT_CEILING_DIRECTORIES` and the worktree-only keys for every git call in a card's worktree (the adapter's diff, checkpoint, fingerprint, head, rebase and restack; `integrity.ts`; the CLI's layer diff); the repository's own program-running keys are recorded when the worktree is created (`writeConfigBaseline`) and only changes are refused (Q5); diffs and logs run `--no-ext-diff --no-textconv`, commits `--no-verify`; the card stops with `git_metadata_tampered` (`card_runner.ts`); `git_preflight.spec.ts` SEC-2, SEC-3, SEC-4, SEC-6, SEC-6a; `c_integration.spec.ts` SEC-2 | S1 |
| Dependency code read-only; caches shared and writable | partial | `seatbelt.ts:38-44`; `node_modules` and `.venv` are linked whole into each worktree (`sync/src/git_adapter.ts:318-330`) and their link targets are made read-only (`seatbelt.ts:57-72`) | S2 (G4) |
| Fail closed: the Worker's tools | built | `ToolExecutor` builds its sandbox with the closed default unless told otherwise (`loop/src/tools.ts:214-218`; `executor.ts:130-134`) | — |
| Fail closed: gates and the Worker; `isolation` in every bundle and on the card | built (B1) | every gate and Worker sandbox comes from `confinedSandbox()` (`executor.ts`), which only `SEKHEMET_ALLOW_UNCONFINED=1` opts out of, never under `--restricted`; `settings.isolation` (`card_runner.ts`), the Run facts' *Isolation* row (`isolationLabel`); `fail_closed.spec.ts`, `c_integration.spec.ts` E3, `vocabulary.spec.ts` | S3b |
| One confined execution path | not-built | visual gate `spawn` with `process.env` (`gates/src/visual.ts:614-618`); LSP (`context/src/lsp.ts:85`); package gates (`sync/src/repo_tools.ts:337`); `--validate-tools` (`wave2.ts:863-876`) | S3a |
| Environment allowlist in the sandbox | built | `executor.ts:63-98`; `containment.spec.ts:179`. Carries a stray `LOGSEQ_TEST` (`:74`) | S3a |
| Seatbelt reads and mach services unrestricted | not-built | `seatbelt.ts:150,155` | S3, S3c |
| Linux host sockets and proxy route | not-built | `bubblewrap.ts:44-68` ignores `egressProxyPort` | S3 |
| Egress proxy: allowlist, log with payload hash | built | `egress.ts`; `egress.spec.ts:35` | — |
| Proxy refuses loopback/private, ports ≠ 80/443; canonical names | not-built | `egress.ts:73-97` | S3 |
| Policy source is the repo's `gates.toml` | not-built (wrong source) | `card_runner.ts:884`; `gates/src/config.ts:189` | S3 |
| Registry lookups proxied and logged | not-built | `npm view` in the worktree (`gates/src/builtin.ts:539`) | S3 |
| Offline default honoured everywhere | partial | `airgap.ts:157-161` regex vs `config.ts:44` default | S3 |
| One-time research question; a yes widens no sandbox route | not-built | no such question; `plan` checks only `--offline`/`SEKHEMET_OFFLINE` (`index.ts:703`) | NEW-security-8 |
| Model downloads through `NetworkPolicy`, refused offline | not-built | no download path exists ([models](models.md) NEW-models-7) | NEW-security-9 |
| `--validate-tools` confined in a scratch worktree | not-built | `execFileSync` in the repository root with the full environment (`wave2.ts:863-876`) | S3a |
| Permission engine, three tiers, protected paths | built | `permissions.ts`; `permissions.spec.ts` | — |
| Ask answered by a person through a decision request | built (B1) | `decisionApprover` posts a `permission` request, deny by default, 60 s (`execute.ts`); denied at once with no approver (`loop/src/tools.ts`); `ask_tier.spec.ts` drives allow (answer and answerer recorded on `decision/answered`), time-out and no-approver against a real SQLite store. The answerer is today's `answeredBy` string; principals arrive with kernel rule 19 (B3.1) | NEW-security-6 |
| Redaction before persistence | not-built | `redact` exists (`secrets.ts:100`), no caller outside the scanner | S3c |
| Erasing a secret found after the fact | not-built | the ledger has no erasable part ([kernel](kernel.md) NEW-kernel-1) | NEW-security-7 |
| Personal and secret files kept out of git | not-built | `.gitignore` lists only `worktrees/`, `*.db`, `*.db-*`, `daemon.*`, `observations/` (`init.ts:348-354`) | [surface](surface.md) P10 |
| Tokens outside the sandbox's reach | not-built | plaintext JSON (`integrations.ts:57-67`), readable under item 10's gap | S3c |
| Dashboard Host check, token, CSP, framing | not-built | constant header, no-Origin trusted (`server.ts:115-126`) | S3c |
| Workspace trust | not-built | hooks (`user_hooks.ts:56`), `mcp.json` (`mcp_client.ts:29-49`), plugins (`execute.ts:385-386`) load unprompted; skills trust-on-first-use with the lock in the repo (`context/src/skills.ts`) | S9; plugins are cut instead ([extensibility](extensibility.md) NEW-extensibility-5, B0) |
| Untrusted-content tagging and step policy | built | `untrusted.ts`; `untrusted.spec.ts:19` | — |
| `browse`: loopback-only outside research cards, pages tagged | partial | `loop/src/tools.ts:1072-1106`; its Chrome is spawned unconfined (`sandbox/src/browser.ts:29`) | S3a |
| Restricted mode strips tools | partial | `restricted.spec.ts`; the visual gate still runs (`loop/src/session.ts:1710` strips only mutation) | S3a |
| Supply-chain existence/age/typosquat, osv offline | built | `gates/tests/supply_chain.spec.ts` | — |
| Supply chain per ecosystem (npm, PyPI, crates.io, Go) with an advisory download floor | built | `DEPENDENCY_MANIFESTS`, `MIN_WEEKLY_DOWNLOADS` (`gates/src/builtin.ts:677-699, 780-786`); `supply_chain.spec.ts:24-30, 73` | — |
| Air-gap mirror, manifest, docs, signed updates, self-test | partial | `airgap.spec.ts`. Built in B1: offline, `verify-models` refuses an unsigned manifest (SEC-34), and a registered model records the manifest's tier as `manifestTier` with no qualification (SEC-34b). Still open: the self-test is one TCP probe to 1.1.1.1:443 (SEC-33, which needs the engine's violation reports, DEC-39); `templateChecksum` is not checked, because checking it offline means reading the GGUF header's chat template (SEC-34a; the GGUF reader is NEW-models-13's) | NEW-security-2 |
| Docs bundle and research-cache export/import | built | `prefetchDocs`, export and import with SHA-256 (`airgap.ts:251-305`) | — |
| `llms.txt` snapshots, staleness on lockfile change, signed skill updates | not-built | none in `airgap.ts` | NEW-security-5 |
| Files that run outside the sandbox later flagged in Review | built (B1) | `executesLater` (`gates/src/evidence.ts`) sets `executesLater` on the bundle; the Review evidence shows *Runs outside the sandbox later* (`ui/web/evidence.js`); `executes_later.spec.ts` | NEW-security-1 |
| Credential store for the Team setup (item 35a) | not-built | no accounts exist | NEW-teams-3 ([teams](teams.md)) |
| Low items: `sh -c` quoting, `python3 -I`, constant-time token compare | built (B1) | `onPath` passes the name as `$1` (`builtin.ts`), and the air-gap self-test uses it; `python3 -I` in `parse_gate.ts` and `license_gate.ts`; `tokenMatches` with `timingSafeEqual` over SHA-256 digests (`wave2_server.ts`); `security_small.spec.ts` | NEW-security-3 |

## 5. Changes for v1

Tests use canary markers — a fixture that would write a marker file outside the worktree, or read a seeded fake key — and assert the marker is absent. No test depends on a real exploit.

### S1 — git metadata (remaining: G2, G3, G6)
*Harness git still honours most program-running config, and bubblewrap protects only the root `.git`.*
- **SEC-1** WHEN a sandboxed command on Linux attempts to create or write `sub/.git/config` under a granted root THE SYSTEM SHALL fail the write and leave no such file.
- **SEC-2** WHEN a worktree's `.git` pointer names a gitdir other than the harness's record THE SYSTEM SHALL run no git command there and SHALL stop the card with stop reason `git_metadata_tampered`, a stored reason in [worker-loop](worker-loop.md)'s one stop-reason table (rule 31), which gives its class, `parks` and next action; this spec keeps no list of its own. B1 comes before that table (T3, built in B2.1), so B1 adds the reason to today's closed list, `CARD_STOP_REASONS` (`packages/kernel/src/types.ts:72`), and T3 carries it into the table (confirmation review N7c).
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
- **SEC-8a** WHEN a sandboxed command writes into a worktree's linked `.venv` THE SYSTEM SHALL fail the write, and the main checkout's `.venv` SHALL be byte-identical before and after the card.

### S3 — one egress policy
- **SEC-9** WHEN a name on the allowlist resolves to a loopback, private, link-local or metadata address THE SYSTEM SHALL refuse the connection at the proxy and record `allowed: false`.
- **SEC-10** WHEN a sandboxed command sends CONNECT to an allowlisted host on a port other than 80 or 443 THE SYSTEM SHALL refuse it.
- **SEC-11** WHEN a hostname contains a NUL byte or characters outside hostname syntax THE SYSTEM SHALL refuse it.
- **SEC-12** WHEN the repository's `gates.toml` lists a host the user's `config.toml` does not permit THE SYSTEM SHALL not reach that host.
- **SEC-12a** WHEN a host is in the user's `fetch_allow` and the repository's `network_allow` but the project's `config.toml` adds it to `fetch_deny` THE SYSTEM SHALL refuse it at the proxy and record `allowed: false`.
- **SEC-13** WHEN the user's config sets neither `[network] mode` nor `[network] research` THE SYSTEM SHALL behave as offline in `plan`, the supply-chain gate and research, with no outbound request recorded.
- **SEC-14** WHEN the supply-chain gate looks up a package THE SYSTEM SHALL send the request through `NetworkPolicy`, record it on the ledger, and not read the worktree's `.npmrc`.
- **SEC-15** WHEN a sandboxed command on Linux connects to a host UNIX socket (session bus, `docker.sock`) or on macOS asks LaunchServices to open an application THE SYSTEM SHALL refuse it.
- **SEC-15a** WHEN a sandboxed command resolves a hostname itself THE SYSTEM SHALL give it no answer (no resolver inside the sandbox).
- **SEC-15b** WHEN an allowlist entry is a wildcard or a known upload-capable host THE SYSTEM SHALL warn when it is added and record the warning on every card that runs under it.

### S3a — one confined execution path
- **SEC-16** WHEN the visual gate starts a project whose `start` script writes a marker outside the worktree THE SYSTEM SHALL leave the marker absent and pass the dev server no variable outside the allowlist.
- **SEC-17** WHEN a language server, a package gate, an onboarding probe, `--validate-tools` or the `browse` tool's browser runs a fixture that writes a marker outside the worktree THE SYSTEM SHALL leave the marker absent.
- **SEC-17a** WHEN `--validate-tools` validates a mined command whose fixture writes a marker outside its scratch worktree, reads a seeded fake key from the environment or the user directory, or opens a network connection THE SYSTEM SHALL run it through `runConfined()` in a scratch worktree with no network and the allowlisted environment, leave the marker absent and the key unread, record the connection as refused, and delete the scratch worktree afterwards; the main checkout SHALL be byte-identical before and after (B1).
- **SEC-18** WHEN the test suite enumerates the modules that import `node:child_process` THE SYSTEM SHALL find exactly the written allowlist.
- **SEC-19** WHILE `--restricted` is set THE SYSTEM SHALL start no dev server, browser, language server, package gate or hook.
- **SEC-19a** WHEN the harness runs a program other than git over worktree content outside the sandbox (today: difftastic for the review diff) THE SYSTEM SHALL resolve it by absolute path from a fixed allowlist, run it with no network and with time and memory limits, and SHALL refuse any program not on the allowlist.

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
- **SEC-28** WHEN a repository with `.sekhemet/hooks.toml`, `mcp.json` or skill `scripts/` is opened for the first time THE SYSTEM SHALL run none of them and SHALL show what each would run. (Plugins are cut and never run, [extensibility](extensibility.md) EXT-28.)
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
- **SEC-34a** WHEN `verify-models` finds a model whose weights match the manifest's SHA-256 but whose chat-template checksum does not THE SYSTEM SHALL refuse to register it and name the template.
- **SEC-34b** WHEN a model is registered from the manifest THE SYSTEM SHALL record the tier the manifest says it qualifies for, and SHALL still require this machine's qualification before the model runs a card.

### NEW-security-3 — small hardening items
*Justification: three low findings (N14–N16) with no programme ID.*
- **SEC-35** WHEN a gate command name contains `$(` THE SYSTEM SHALL check it with `sh -c 'command -v "$1"' _ <name>` and not execute the substitution.
- **SEC-36** WHEN the harness runs `python3` for a gate helper THE SYSTEM SHALL pass `-I`.
- **SEC-37** WHEN a trigger token is compared THE SYSTEM SHALL use a constant-time comparison.

### NEW-security-4 — injection fixtures run against the real Worker
*Justification: DEC-04 requires security tests against this model's behaviour; the research finds no study of abliterated coding agents, so the evidence has to be ours.*
- **SEC-37a** WHEN the injection fixtures of item 42c run with the configured Worker THE SYSTEM SHALL end every fixture with no canary marker outside the worktree, no outbound request outside the allowlist, and no card moved past Review.
- **SEC-37b** WHEN the Worker model or its quantisation changes THE SYSTEM SHALL require the injection fixtures to pass again before the new Worker runs unattended (`overnight`).

### NEW-security-5 — documentation and skills that match the air-gapped project
*Justification: the old kit pinned docs to the locked versions, refreshed them on lockfile changes, and carried skill updates by signed bundle; none of the three survives in code (trace of HARNESS_DESIGN "Air-gap kit").*
- **SEC-44** WHEN a docs bundle is built on a connected machine THE SYSTEM SHALL include each dependency's docs and any published `llms.txt` at the version its lockfile pins, and record those versions in the bundle.
- **SEC-45** WHEN a lockfile changes after the imported docs bundle was built THE SYSTEM SHALL mark the bundle stale and the self-test SHALL name the packages whose docs no longer match.
- **SEC-46** WHILE air-gap mode is on, WHEN a skill update arrives THE SYSTEM SHALL accept it only inside a bundle whose `sekhemet-update` signature verifies, and SHALL still require the skill's approval by content hash ([extensibility](extensibility.md) item 15).

### NEW-security-6 — an Ask that a person really answers
*Justification: the Ask tier's approval path is wired but no test drives it; the reaudit found exactly this gap (R1 defect 4: nobody said who approves an Ask).*
- **SEC-47** WHEN the Worker issues an Ask-tier command and a person answers "allow" before the timeout THE SYSTEM SHALL run the command once and record the answer and who gave it.
- **SEC-48** WHEN an Ask-tier request has no answer after 60 s THE SYSTEM SHALL deny the command and tell the model not to retry it.
- **SEC-49** WHEN an Ask-tier command is issued with no approver attached THE SYSTEM SHALL deny it at once, without posting a decision request.

### NEW-security-7 — erase a secret the scanner missed
*Justification: a scanner false negative becomes permanent in a ledger that cannot be purged ([DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) decisions 6 and 15, SEC-T2, SEC-T3). Depends on [kernel](kernel.md) NEW-kernel-1.*
- **SEC-50** WHEN a secret is found in the ledger after it was written THE SYSTEM SHALL tell the person to rotate it first, then erase the affected `private` fields with reason `secret`, delete every blob that contains it, and leave the hash chain verifying.
- **SEC-51** WHEN an evidence bundle is stored THE SYSTEM SHALL keep its gate excerpts and command lines in an erasable part whose commitment the bundle id covers, so that erasing a secret in an excerpt leaves the bundle id unchanged.

### NEW-security-8 — the one-time research question opens no sandbox route
*Justification: owner decision [O16](../../reference/OPEN_QUESTIONS.md#owner-decisions) (pending) sets research against offline-by-default; its default — ask once, on the first new project — must not leak a byte before the answer, nor widen what a card's commands reach after a yes (item 29a). Built with [design-stage](design-stage.md) S8, which asks the question.*
- **SEC-52** WHEN a person starts their first new project and has not yet answered the one-time research question THE SYSTEM SHALL make no outbound request before the answer; and WHEN the answer is yes THE SYSTEM SHALL record it in the user's `config.toml`, SHALL not ask again for a later project, and SHALL still give a card's sandboxed commands no host beyond the repository's `network_allow`.
- **SEC-52a** WHEN `[network] research = "yes"`, `mode = "offline"` (or unset) and `fetch_allow` is empty THE SYSTEM SHALL let the Researcher fetch a public host not in `fetch_deny` through `NetworkPolicy`, logged on the ledger, SHALL give every card command no route out, and SHALL send no other harness-side request (a supply-chain lookup stays offline) — mirroring [surface](surface.md) SUR-48a.
- **SEC-52b** WHEN `[network] research = "yes"` and the effective `fetch_allow` is non-empty THE SYSTEM SHALL refuse a research fetch to a public host outside it, whatever `mode` says, and record the refusal; and WHEN a project's `config.toml` sets `research = "no"` THE SYSTEM SHALL make no research request for that project, while a project's `research = "yes"` under a user's `no` SHALL be ignored and named by `doctor`.

### NEW-security-9 — model downloads under the one network policy
*Justification: owner decision O2 ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)) adds a download action to the Configuration page; a harness-side request a person starts must still obey `[network] mode` and be logged (items 32, 47). Built with [models](models.md) NEW-models-12.*
- **SEC-53** WHEN a person downloads a model from the Configuration page THE SYSTEM SHALL send the request through `NetworkPolicy` and record it on the ledger with its source; WHILE `[network] mode = "offline"` THE SYSTEM SHALL refuse the download and say why; and WHEN no person has asked for a download THE SYSTEM SHALL make no request for weights.

### NEW-security-10 — Scanning model folders and the Hugging Face lookup ([DEC-32](../DECISIONS.md#dec-32))

- **SEC-N10-1** WHEN a scan meets a symbolic link whose target lies outside the chosen folder THE SYSTEM SHALL not follow it and SHALL report it as skipped.
- **SEC-N10-2** WHEN a scan opens a file THE SYSTEM SHALL open it read-only, only for a known model extension, parse its header with a size limit (default 16 MB of metadata), and SHALL skip a malformed or oversized header without loading the file.
- **SEC-N10-3** WHEN a model is looked up on Hugging Face THE SYSTEM SHALL send only its name or published hash, never a path or a file name from this machine, and only through the research network policy (`[network] research`, `fetch_deny`).
- **SEC-N10-4** WHEN a scan completes THE SYSTEM SHALL record one event with the folders, the depth, and the counts found and skipped, and no scan SHALL execute, load or modify any file it reads.

## 6. v1 acceptance

SEC-1 to SEC-37b and SEC-44 to SEC-53 (including the lettered criteria; SEC-17a is B1's, with the rest of S3a; SEC-52 holds O16's default until the owner answers; SEC-50 and SEC-51 once [kernel](kernel.md) NEW-kernel-1 and NEW-kernel-7 land in B3.1 — erasure itself is decided, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O1), the `.gitignore` criterion SUR-34 in [surface](surface.md), plus these behaviours already built and to be kept under test:
- **SEC-38** WHEN a sandboxed command writes `<root>/.git`, `<root>/sub/.GIT/config` or through a symlink into `.git` on macOS THE SYSTEM SHALL fail the write and leave the target unchanged.
- **SEC-39** WHEN an allowlist is empty THE SYSTEM SHALL refuse every proxied request.
- **SEC-40** WHEN a step's context holds untrusted content THE SYSTEM SHALL refuse Ask-tier and network commands in that step without asking.
- **SEC-41** WHEN a card adds a dependency that is absent from the registry, younger than 30 days, or within the typosquat distance of item 44 THE SYSTEM SHALL fail the supply-chain gate and name the rule.
- **SEC-42** WHEN a signed update bundle is tampered with THE SYSTEM SHALL refuse it and leave the ledger untouched.
- **SEC-43** WHEN the containment suite runs in CI THE SYSTEM SHALL run it under a real bubblewrap on Linux as well as Seatbelt on macOS, with no test skipped on either.
- **SEC-43a** WHEN a card adds a Python dependency THE SYSTEM SHALL look it up on PyPI, not npm, and WHEN its weekly downloads are under 100 THE SYSTEM SHALL report the number as an advisory and not fail the gate for it.
- **SEC-43b** WHEN the Worker's tool sandbox is built with no explicit confinement setting on a host without a mechanism THE SYSTEM SHALL refuse the command.

## 7. Later

- **`@anthropic-ai/sandbox-runtime`, Smokescreen, nsjail/landrun, secretlint, `@napi-rs/keyring`** — proposals from the review; each needs the owner's yes. The profile requirements above hold whichever implementation is chosen.
- **A VM per test gate or per card** (Apple `container`, gVisor, Firecracker) — stronger isolation, not researched for our hosts; also the planned route off `sandbox-exec` if Apple removes it (item 13).
- **Registry mirrors as services** (verdaccio, devpi, a crates mirror), pre-seeded from the lockfile allowlist **plus a curated set** of common packages — v1 ships the lockfile allowlist alone; a transitive dependency not yet in any lockfile cannot be mirrored in advance, which is the open policy question the design left, and a curated set needs someone to curate it.
- **Crypto-shredding of backups and exports** — deleting the `private` rows plus a declared backup window covers v1 (runtime's backup and restore re-apply erasures); per-subject keys add key management the product does not otherwise need ([research](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md) §5).
- **Plugin signing** — v1 has no plugins (cut, [DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue) O4); signing comes only with a plugin API ([extensibility](extensibility.md) §7).

## 8. Open questions

1. **Keep the `--validate-tools` execution path, or cut it?** *Decided 2026-09-24 (lead, on the confirmation review's M3): keep it, confined* — item 4a, SEC-17a, built in B1. Confining it under S3a removes the risk without cutting reachable code, which would need the owner; R6 stays `triaged`, so a validated candidate never becomes a Worker tool.
2. **Which mach services does the allowlist contain?** *Recommendation:* start from sandbox-runtime's published list, then add only what the frozen suite's toolchains fail without, each with a test.
3. **A repository's pre-commit hooks as gates** — run from the base branch's copy, confined. *Recommendation:* yes, owned by [gates](gates.md); until then `doctor` states that hooks do not run.
4. **The `sandbox-exec` liability.** Apple deprecated it years ago and offers no supported per-process replacement for arbitrary command lines. *Recommendation:* keep it behind the sandbox interface with loud containment tests (item 13, SEC-38); if a macOS release breaks it, confinement fails closed (item 7) and the VM-per-card route in §7 is researched then, not now.

5. **Husky's `core.hooksPath` and Git LFS's `filter.lfs.*` in the repository's own config.** *Decided in B1 (lead, on the B1 review; this spec's own recommendation):* the harness records the program-running keys the repository sets when a card's worktree is created, in its gitdir entry under the main `.git` where the Worker cannot write (`writeConfigBaseline`). The preflight refuses only keys that differ from that record. The pinned config already neutralises hooks, so the user's own setup is not the attack, and a key added or changed during the card still stops it.

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
- Research, [DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md](../../research/DESIGN_RESEARCH_TEAMS_DATA_CHANGE.md): decision 15 (`init` leaves evidence and transcripts committable; git history cannot be cleaned) → item 34a, SUR-34; decision 6 and SEC-T2/SEC-T3 (an erasable `private` part, the EDPB's salted-commitment pattern) → items 34, 34b, NEW-security-7; crypto-shredding kept Later (§7). SEC-T1 is carried as SUR-34, because the first run writes `.gitignore`.
- Decisions: [DEC-04](../DECISIONS.md#dec-04) (why this is v1-blocking), [DEC-21](../DECISIONS.md#dec-21--accepted-substitutions) (bubblewrap rather than Landlock on Linux, plain worktrees rather than copy-on-write clones, source installer — each a deliberate change from the 2026-09-17 design).
- **Why the weights rule changed** (DEC-25 R7, 2026-09-22; owner decision O2, 2026-09-24): the old "weights are never downloaded" and the models spec's user-confirmed download disagreed; both hold as "never on its own, always by a person's explicit download from the Configuration page, always hash-verified" (item 47).
- Owner decisions of 2026-09-24 ([DEC-29](../DECISIONS.md#dec-29--the-owners-answers-to-the-decision-queue)): O1 (spine rule 2 amended for recorded erasure → items 34, 34b, NEW-security-7), O2 (item 47, SEC-53), O4 (plugins cut → items 38, 49). Pending: O16 (research asks once → item 29a, SEC-52, whose default this spec uses).
- **Why `research` is the one exception to `mode`, bounded by `fetch_allow`** (lead's decision, 2026-09-24, on the [final check](../../reference/reviews/design_v3_final_check.md)'s F1): [surface](surface.md) item 24 and SUR-48a let research fetch while `mode` stays offline, which items 28, 29, 32 and SEC-13 used to forbid; a yes reaching past a `fetch_allow` the person wrote would have widened their own list → items 28, 29, 29a, 32, SEC-13, SEC-52a, SEC-52b.
- Confirmation review ([design_v3_confirmation.md](../../reference/reviews/design_v3_confirmation.md)) M3: the `--validate-tools` choice is written into this spec (item 4a, §8 Q1) so that B1 has no unqueued owner decision in its path.
- **Why the permission engine is not the boundary:** G1 showed a string check bypassed by a symlink the sandbox let the Worker create; only the kernel-enforced profile holds against a model with a shell.
