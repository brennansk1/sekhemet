# Phase A — Domains 11 (Security) and 14 (Runtime), v2

This review was read-only. The only thing run was the existing specs (containment, egress, sandbox_wave2, daemon_ws and watchdog), and all 33 passed. Line numbers refer to 468f67f.

## Security findings

K# marks issues carried over from the earlier pass; N# marks new ones.

| ID | Sev | Where | What, and why |
|---|---|---|---|
| K1 | **Crit** | `git_adapter.ts`, `integrity.ts:94-116` | The sandbox can write the `.git` pointer, and the harness then runs git outside the sandbox. The Worker can trigger this itself right away: `tools.ts:1240` (search) and `:1496` (git_history). More call sites: `card_runner.ts:364,385,743,750`, `session.ts:1714`, `index.ts:741`. |
| N1 | **Crit** | `gates/visual.ts:615-618`, called from `builtin.ts:1150` and `session.ts:1712` | Once the gates pass, the visual gate starts the project's `start` command without confinement. It runs in the worktree with the full `process.env` (API keys, GITHUB_TOKEN) and network access. The app and `package.json` scripts were written by the Worker. `--restricted` does not turn it off (`session.ts:1710` strips only mutation). Headless Chrome (`visual.ts:112`) is also unconfined. |
| K2 | High | `seatbelt.ts:29-45,66`, `bubblewrap.ts:29` | The symlinked `node_modules` can be written through its realpath. |
| N2 | High | `wave2.ts:1304`, `repo_tools.ts:337-377`, `index.ts:782` | `sekhemet gate <card>` runs each package's gates unconfined with the full env. The commands come from the **worktree's** `package.json` scripts or a package-level `gates.toml`, and the Worker can edit both. |
| N3 | High | `execute.ts:315,426`, `index.ts:729`, `executor.ts:130-134` | Confinement fails open. Outside `--restricted` the code passes `requireConfinement:false`, so on a host without Seatbelt or bubblewrap the Worker and the gates run unconfined without a word. The design says it fails closed. |
| N4 | High | `context/lsp.ts:85-88` | Language servers run unconfined on worktrees with the full env. rust-analyzer runs `build.rs` and proc-macros, and the TypeScript server loads tsserver from the writable `node_modules`. |
| N5 | High (confirm; critical if confirmed) | `seatbelt.ts:103,111,116` | Every `mach-lookup` and `process-exec` is allowed, and `file-read*` everywhere. System services (LaunchServices, AppleEvents) can act outside the sandbox. `~/.ssh`, `~/.aws`, `~/.npmrc` and `~/.config/sekhemet` can all be read. |
| N6 | High (Linux) | `bubblewrap.ts:30-47` | `/` is ro-bound, so host UNIX sockets stay reachable (the D-Bus session bus, `docker.sock`), and `--unshare-net` does not block them. `egressProxyPort` and `localPorts` are ignored, so the proxy cannot be reached. |
| K3 | High | the section below | Egress channels that bypass "network denied". |
| K4 | High | `user_hooks.ts:96`, `mcp_client.ts:74`, plugins | Hooks, `mcp.json` and plugins from the repository run with the full env and no trust prompt. |
| N7 | Med | `builtin.ts:539`, registry `getJson`; `airgap.ts:157-161` vs `config.ts:44` | The supply-chain lookups send package names the Worker chose, straight from the harness: no proxy, no ledger record. `npm view` runs in the worktree and so obeys its `.npmrc`. A regex decides offline mode, but `config.ts` makes offline the *default*, so default users are looked up online. |
| N8 | Med | `card_runner.ts:884`, `gates/config.ts:190`, `egress.ts:28-34,73-97` | The allowlist comes from the repository's `gates.toml`, not the user's policy in `config.toml`. CONNECT is allowed to any port. Nothing refuses loopback or private addresses after resolution, so the proxy can reach the dashboard, which trusts requests without an Origin header. |
| N9 | Med | `server.ts:115-126,490`; `ws.ts:32`; guards copied into 5 modules | There is no Host-header check, so a DNS-rebinding page can read every GET (evidence, transcripts, diffs, live tokens, SSE). The mutation header is a constant, and requests without an Origin are trusted, so any local process can accept. There is no `frame-ancestors` (clickjacking) and no CSP, although the pages build HTML with innerHTML. The two Origin checks disagree. |
| N10 | Med | `execute.ts:222-262`, `retention.ts`, `github_app.ts:236` | Command lines and observations go into context packs and the **hash-chained ledger**, which cannot be purged. Evidence is never pruned. Gate excerpts are published as GitHub annotations. There is no redaction, although `scanSecrets` and `redact` exist (`gates/secrets.ts:100`). |
| N11 | Med | `integrations.ts:36-67`; `gate_host.ts:45-70` | Tokens are stored as plaintext JSON; mode 0600 applies only when the file is created, and every sandboxed command can read it. The gate-host CA key is unencrypted and valid for 10 years. |
| N12 | Med | `wave2.ts:863-876` | `--validate-tools` runs command strings mined from Worker trajectories, unconfined, in the main checkout. |
| N13 | Med | `crawl4ai.ts:79-92`, `llama_server.ts:383` | Both reuse whatever answers on their port, so prompts and code can go to a foreign process. crawl4ai also inherits the full env. |
| K5–K7 | Med | — | `acceptCard` runs `git checkout main` in the user's own copy; `plan` ignores offline mode; MCP can override a card to Done. |
| N14 | Low | `airgap.ts:438`, `builtin.ts:92` | `sh -c "command -v ${JSON.stringify(x)}"`: double quotes still expand `$()`, and the value comes from gates.toml. |
| N15 | Low | `license_gate.ts:120`, `parse_gate.ts:73` | `python3` without `-I` puts the cwd on `sys.path`. |
| N16 | Low | `wave2_server.ts:248`; `airgap.ts:420-434` | The trigger token is compared in non-constant time. The air-gap self-test is a single TCP probe. |

### Egress channels (completes K3)

**Inside the sandbox:**
- macOS mach services (N5).
- Linux host sockets (N6).
- The proxy, through upload-capable domains, any port, or loopback (N8).
- The `.git` pointer, then unconfined git contacting remotes (K1).
- `node_modules` writes that run later (K2).
- Everything, on fail-open hosts (N3).

**Harness-side, on input the Worker influenced:**
- The visual gate and Chrome (N1).
- Package gates (N2).
- Language servers (N4).
- Registry lookups (N7).
- Hooks, MCP and plugins (K4).
- Research: `web.ts`, `polite.ts`, crawl4ai, the searxng docker pull, `git clone` in `research/repo.ts:256-280` (K6).

**Not governed by `config.toml`:** ntfy.sh, Slack, GitHub PRs and check runs, and OTLP export (user-started).

### Fix plan (the tests use canary markers, no exploits)

1. **Execution chokepoint (N1, N2, N4, N12, K4).**
   - Route everything that touches the worktree through `runConfined()` with a scrubbed env.
   - Route trusted calls through `runTrusted()`, with a written allowlist of call sites.
   - Biome `noRestrictedImports` bans `node:child_process` everywhere else.
   - *Test:* a fixture whose dev script or `build.rs` writes a marker outside the worktree; the marker must be absent. The spawn inventory must equal the allowlist.
2. **`safeGit` (K1).**
   - Verify the pointer's `gitdir:` before every call.
   - Pass `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never` (allow `file` where needed), `--no-ext-diff --no-textconv`, and `GIT_CONFIG_NOSYSTEM=1`.
   - Make the bare `.git` path protected in the permission engine.
   - *Test:* tamper with the pointer and expect a refusal; confirm the marker never runs.
3. **Fail closed (N3).**
   - Remove the `restrictedMode` overrides; `SEKHEMET_ALLOW_UNCONFINED=1` is the only way out, and evidence records it.
   - *Test:* force `mode:"none"`; `run_cmd` and the gates must refuse.
4. **Profiles (N5, N6, K2).**
   - macOS: a mach-lookup allowlist, and deny reads of secret directories and the ledger.
   - Each card gets an overlay or copy-on-write `node_modules`.
   - Linux: `--unshare-all`, mask `/run/user` and `docker.sock`, and reach the proxy through a bind-mounted UNIX socket.
   - *Test:* `open`, canary reads and socket connects must all fail.
5. **One egress policy (N7, N8, K6).**
   - `config.toml` is authoritative; `gates.toml` can only narrow it.
   - Add a `NetworkPolicy` wrapper for all harness `fetch` and registry calls, logging to the ledger.
   - The proxy refuses loopback, private and link-local addresses, and ports other than 80/443.
   - *Test:* proxy specs for a name that resolves to loopback, CONNECT to port 22, and the offline default.
6. **Dashboard (N9).**
   - One guard at the top of the handler with a Host check.
   - A random per-start token instead of the constant header; requests without an Origin must carry it.
   - Send `frame-ancestors 'none'` and `script-src 'self'`.
   - *Test:* foreign Host, missing token, framed request.
7. **Secrets (N10, N11).**
   - Redact observations, command targets and gate excerpts before they are persisted or published.
   - Store tokens in the keychain; directory mode 0700.
   - *Test:* after the Worker reads a seeded key, only the redacted form appears in the ledger, blobs, evidence and annotations.
8. **Low items (N14–N16).** `sh -c 'command -v "$1"' _ x`; `python3 -I`; `timingSafeEqual`; a self-test that checks at the proxy.

## Runtime (rubric questions 2–7)

### 2. Drift
- **Fail-closed claim.** The design says confinement fails closed, but it fails open (N3).
- **Kills are not tree-wide.** Timeouts (`executor.ts:248-266`) and `dispose` (`tools.ts:1057-1067`) signal only the direct child, so grandchildren survive. The memory cap does walk the tree.
- **Resume needs the card run again.** A crash leaves the card In Progress with its attempt "running". The queue takes only Ready cards, and there is no startup sweep.
- **Watchdog.** `stopNewWorktrees` and `shortenKeepAlive` are never acted on: `isActive` (`watchdog.ts:194`) is never called.
- **Missing and unstated.** There is no nightly vulnerability scan, ntfy.sh is allowed although notifications are described as self-hosted, and the design never mentions the OTLP export.

### 3. Dead and duplicated code
- Dead: the two no-op watchdog actions; the unused `run` parameter of `verifyBundle` (`airgap.ts:328-339`); `LOGSEQ_TEST` in `executor.ts:74`, left over from another project.
- Duplicated:
  - The PID-alive check, three times (`daemon.ts:26`, `pm/service.ts:108`, llama lifetime).
  - The Origin check, twice; the copies disagree.
  - The mutation guard, five times.
  - Network-mode parsing, twice.
  - Bake-off spawning, twice (`index.ts:1009`, `wave2.ts:1183`).
- About 60 raw spawn sites, each with its own env, timeout and kill policy.

### 4. Complexity hotspots
- `index.ts` (2,081 lines): the queue path at lines 1239-1400 wires the router, watchdog, lease and notifier inline.
- `server.ts` (1,261 lines): one handler chained through five regex-routed modules.
- `execute.ts` (1,600) and `wave2.ts` (1,318): grab-bags.
- `llama_server.ts`: every spawn adds SIGINT, SIGTERM and SIGHUP handlers that call `process.exit`, which cuts off later cleanup such as lease release.

### 5. Test quality (against DoD §2)
- `daemon_ws.spec.ts:128-153` mocks launch, fetch and kill, uses the test's own pid, and asserts "Stopped" while that process is alive. It locks in the PID-reuse bug.
- `llama_server_lifetime.spec.ts` imports from `dist/`, so it tests a possibly stale build, and covers SIGTERM only.
- Negative containment tests run only on darwin; bubblewrap is checked for argv shape only. The network test cannot tell a DNS failure from a refused connection.
- Missing: egress port and loopback tests, rebinding tests, a test that watchdog actions take effect, and an overnight hung-round test.

### 6. Senior judgement, ranked by impact
1. **One supervisor daemon** that owns models, runs, the queue and logs. It replaces:
   - PID files: `alive()` accepts a recycled pid, so `daemonStop` can SIGTERM an unrelated process (`daemon.ts:26-33,109-118`).
   - The non-atomic lease (`pm/service.ts:66-113`), which `run` never takes. Two Workers can run at once (`rest_extra.ts:192-202`); the second adopts the first's llama-server, which dies when the first exits.
   - Detached `run` launches that leave no log (`rest_extra.ts:55-64`).
2. **Model servers with an identity check.** Use a random port or socket, verify the model through `/props`, and never adopt a foreign server. An adopted server is never unloaded (`llama_server.ts:488-507`), so the watchdog is defeated. Kill process groups.
3. **Overnight round timeout and startup sweep.** A hung `queue` child blocks the night (`overnight.ts:60-73,145`).
4. **Rotation and retention.** Rotate `daemon.log`; add retention for `traces.db` (`tracing.ts:39-48`), egress events, and parked worktrees.
5. **Redaction at ingestion.**

### 7. Verdicts
- **Keep:** `executor.ts` (fix the tree kill and the default), `seccomp.ts`, `watchdog.ts` (wire or cut its actions), `memory.ts`, `scheduler.ts`, `governance.ts`, `overnight.ts`, `tracing.ts` and `retention.ts` (extend both), `ws.ts`, `notify.ts`.
- **Refactor:** `seatbelt.ts`, `bubblewrap.ts`, `egress.ts`; `permissions.ts` (treat it as UX, and protect `.git`); `llama_server.ts`; the lease; the `server.ts` guard; `integrations.ts`; `visual.ts`, `lsp.ts`, `wave2.ts`, `airgap.ts`, `crawl4ai.ts`, `user_hooks.ts`, `mcp_client.ts`.
- **Rebuild:** `daemon.ts`.
- **Cut** (needs sign-off): the `--validate-tools` execution path.

## Proposals (not added; each needs the owner's yes)

| Name | Licence | Maintenance | Replaces | Why |
|---|---|---|---|---|
| `@anthropic-ai/sandbox-runtime` | Apache-2.0 | Active; Claude Code uses it | `seatbelt.ts`, `bubblewrap.ts`, `egress.ts` | Reviewed profiles, a filtering proxy, and mach and socket limits (N5, N6, N8) |
| Smokescreen (Stripe) | MIT | Maintained | `egress.ts` | A CONNECT allowlist that refuses private addresses by default |
| nsjail / landrun | Apache-2.0 / MIT | Active | The Linux fallback | The Landlock the design claims |
| secretlint (+ existing gitleaks) | MIT | Active | Adds redaction | In-process redaction (trufflehog is AGPL: flagged) |
| `@napi-rs/keyring` | MIT | Active (keytar is archived) | Plaintext tokens | Cross-platform keychain |
| `proper-lockfile` | MIT | Stable | The lease and PID files | Atomic lock with staleness detection |
| `tree-kill` / `kill(-pgid)` | MIT / built-in | Stable | Kills that signal a single pid | Kills whole process trees |
| pino + pino-roll | MIT | Active | `console.log` | Structured logs with rotation |
| launchd / systemd `--user` | OS built-in | — | `daemon.ts` | Supervision and restart |

## Top 5 changes

| # | What | Why | Effort | Risk | How it is measured |
|---|---|---|---|---|---|
| 1 | Execution chokepoint, env scrub, lint ban | N1, N2, N4, N12: card code running outside the sandbox today | M | Med | Canary fixtures; spawn inventory equals the allowlist; frozen-suite pass rate unchanged |
| 2 | `safeGit` | K1: critical, one step to reach | S | Low | Tamper spec refuses; no marker runs |
| 3 | Fail closed, tighter profiles (or sandbox-runtime) | N3, N5, N6, K2 | M-L | Med | Negative specs on both OSes; gate time within +10% |
| 4 | One egress policy and a hardened dashboard guard | N7, N8, N9, K6 | S-M | Low | Rebinding, Host and proxy specs; every outbound request is in the ledger |
| 5 | Supervisor: atomic lease, no adoption, process-group kill, timeouts, sweep, retention | Runtime §6 | M | Med | kill -9 chaos test leaves no orphans or stuck cards; a second `run` is refused; disk growth per 100 cards is bounded |
