# Sandbox reuse: can an existing project replace ours?

*Web research, 2026-09-24. Question: the owner asked us to reuse an existing sandbox instead of building our own. Which parts of `packages/sandbox` and `packages/sync/src/git_hardening.ts` can an existing, legally usable project replace, measured against the B1 criteria in [security.md](../design/specs/security.md) §2 (items 4–24a, 28–33) and §5 (SEC-1…SEC-21, SEC-32…SEC-37b)? Sources were read on the primary page; **[search]** marks a search summary only.*

## Summary

- **Recommendation:** adopt **`@anthropic-ai/sandbox-runtime` (srt)** as the confinement engine behind `ProcessSandbox`, through an adapter, replacing `seatbelt.ts`, `bubblewrap.ts` and `seccomp.ts` (about 320 lines). Its macOS profile is stricter than ours: ours has an unrestricted `(allow mach-lookup)`, so a confined process can reach the resolver and LaunchServices.
- **Keep ours:** the `runConfined()`/`runTrusted()` chokepoint, the environment allowlist, fail-closed behaviour and isolation recording (`executor.ts`), the per-card egress proxy and its `card/egress` ledger records (`egress.ts`), harness-side git hardening (`git_hardening.ts` plus the preflight), the policy merge (`config.toml`/`gates.toml`) and the permission engine. No candidate covers these in the shape the spec needs.
- **Caveats:** srt is a research preview (0.0.77, near-weekly releases). `SandboxManager` is a process-wide singleton, so concurrent cards with different policies need the CLI (`srt --settings`), one process per command. Several defaults are weaker than our spec and must be set explicitly.
- The `sandbox-exec` deprecation risk (item 13) remains; srt uses the same mechanism. microsandbox is the §7 fallback candidate, not v1.

## Candidates

| Candidate | Licence | Maintenance (2026-09-24) | Platforms | API from Node | Fit |
|---|---|---|---|---|---|
| **srt** (`@anthropic-ai/sandbox-runtime`; repo moved from `anthropic-experimental` to `anthropics`) | Apache-2.0 | v0.0.77 (2026-09-18); push 2026-09-23; ~5.3k stars; 103 open issues; created 2025-10 | macOS (Seatbelt), Linux (bubblewrap + seccomp), Windows alpha | TS library `SandboxManager` (singleton) **and** CLI `srt --settings <file> -- cmd`; Node ≥ 20.11 | **Best.** Same mechanisms as ours (DEC-21), plus resolving proxy, mach-lookup allowlist, AF_UNIX seccomp, violation reports |
| OpenAI Codex sandbox (`codex-rs/linux-sandbox`, Seatbelt policy) | Apache-2.0 | Active | macOS, Linux (bwrap, legacy Landlock), Windows | None for Node: Rust crate or `codex sandbox` CLI | Re-binds `.git` read-only; a reference, not a library |
| nsjail, firejail, gVisor, landrun (Landlock) | Apache-2.0 / GPL-2.0 / Apache-2.0 / MIT | Active | **Linux only** | CLI / OCI | None covers macOS. firejail is setuid-root and GPL. Landlock is a hardening layer at most (DEC-21) |
| Docker / Podman rootless | Apache-2.0 | Active | macOS through a VM | CLI | Too heavy beside a 13 GB Worker on a 24 GB host |
| microsandbox | Apache-2.0 | v0.7.2, about 8.3k stars **[search]** | Linux, macOS (Apple Silicon), Windows | npm SDK | A microVM per card: the §7 fallback if `sandbox-exec` goes away. Not v1 |
| E2B / Daytona | — | — | Cloud | — | Out of scope (local only) |
| **Egress:** Stripe Smokescreen | MIT **[search]** | Active | Go binary | Separate process | Resolves names and refuses internal addresses, but adds a Go binary |
| **Egress:** `request-filtering-agent` | MIT | Active; CVE-2025-57814 fixed in 2.x | Node | `http.Agent` | Checks the resolved IP just before connecting. Fits **harness-side** `NetworkPolicy` fetches (SEC-14), not the CONNECT proxy |
| **Egress:** `ipaddr.js` | MIT | Mature | Node | Library | Address-range classification for our proxy's SEC-9 check |

## What srt enforces (from its README and source, 2026-09-24)

- **Filesystem.** Writes denied by default (`denyWrite` beats `allowWrite`); reads allowed by default (`denyRead`/`allowRead`). Always write-denied: `.git/hooks`, `.git/config`, `.gitmodules`, shell rc files, `.vscode/` and others. On macOS these match at any depth (`**/.git/config`). On Linux, ripgrep finds them at wrap time, to `mandatoryDenySearchDepth` (default 3). A `.git` created after the wrap is not protected. **Only these two `.git` entries are protected, not the whole `.git` directory.**
- **Network.** HTTP and SOCKS5 proxies on the host, with `allowedDomains`/`deniedDomains` (deny wins, `:port` suffixes allowed). Before dialling, the proxy resolves each allowed name once and drops loopback, unspecified, link-local, multicast, broadcast and metadata addresses. RFC 1918, ULA and CGNAT are **not** dropped by default; the source calls them "deliberately absent" and opt-in through `deniedResolvedAddresses`. On Linux, `--unshare-net` removes the network, so traffic reaches the proxy only through a socat bridge. There is no resolver in the sandbox on either platform: bubblewrap has no DNS handling, and `mDNSResponder` is not on the macOS mach-lookup allowlist. `httpProxyPort`/`socksProxyPort` switch to an **external** proxy and skip srt's own.
- **Sockets and OS services.** On Linux, seccomp blocks `socket(AF_UNIX)` and io_uring. On macOS, Unix sockets come from an allowlist. The profile starts from `(deny default)`, with a mach-lookup allowlist. `lsopen` and `appleevent-send` are denied unless `allowAppleEvents` is set, but the allowlist includes `com.apple.coreservices.launchservicesd`.
- **Environment.** On macOS and Linux the caller's environment passes through, apart from optional credential masking. srt does **not** filter it.
- **Missing tools.** `checkDependencies()` reports a missing bwrap, socat or ripgrep, and `isSupportedPlatform()` is exposed. If seccomp is unavailable, srt only prints a warning. The macOS code assumes `/usr/bin/sandbox-exec` exists and does not check it.
- **Violations.** On macOS they come from the system log store (`getViolationsForCommand`). Linux has none.
- **Dependencies.** npm: `zod`, `commander`, `node-forge`, `@pondwader/socks5-server`. System: ripgrep (both platforms; Homebrew on macOS), plus bubblewrap and socat on Linux.

## Criterion-by-criterion coverage

| Group | Criteria | Covered by | Notes |
|---|---|---|---|
| **S1 git, in the sandbox** | SEC-1; items 9 and 14 | **Partly srt**; the rest stays ours | srt denies `.git/config` and `.git/hooks` at any depth on macOS, and to depth 3 for existing paths on Linux. To meet item 9 ("`.git` at any depth"), pass `denyWrite: ["**/.git"]` on macOS. **Neither srt nor our bubblewrap stops a Linux command from creating a new `sub/.git/config` after the wrap.** SEC-1 stays open; the backstop is SEC-6a's preflight. Codex's re-bind approach has the same limit |
| **S1 git, harness side** | SEC-2…6, 6a, 6b; items 16, 18–23 | **Ours** (`git_hardening.ts`, preflight, recorded-root profile) | No sandbox tool covers the git that runs outside the sandbox. Nothing to reuse here |
| **S2 dependency trees** | SEC-7, 8, 8a; item 24 | **srt** enforces it; worktree preparation stays **ours** | Writes are denied outside `allowWrite`. The linked `node_modules` and `.venv` resolve into the main checkout, so writes there are refused (Seatbelt matches real paths; bwrap mounts the root read-only). Creating caches inside the worktree (`linkedDependencyCaches`) stays ours |
| **S3 egress in the sandbox** | SEC-10, 15a; items 12, 29, 31 | **srt** | Ports: `host:443` entries or our proxy. No resolver on either platform. Offline mode: no `allowedDomains`. Still to verify: whether the macOS rule allows `localhost:*` or only the proxy port (item 12) |
| **S3 proxy policy** | SEC-9, 11, 12, 12a, 15b; items 28, 30, 31a | **Ours** (`egress.ts` + config merge), using `ipaddr.js` | srt's proxy is one per process, so it cannot keep a separate allowlist and a separate `card/egress` log with payload SHA-256 per card. Keep our proxy and hand srt its port (`httpProxyPort`). Add the resolve-then-check that srt uses (SEC-9 is open in ours today) |
| **S3 harness-side requests** | SEC-13, 14; items 32–33 | **Ours** `NetworkPolicy`, plus `request-filtering-agent` | Outside the sandbox |
| **SEC-15 host sockets / LaunchServices** | SEC-15; items 11, 15 | **srt** | Linux: AF_UNIX is blocked by seccomp, so the session bus and `docker.sock` cannot be reached. `/run/user` is not masked; add it to `denyRead`. macOS: `lsopen` and AppleEvents are denied. Our profile allows every mach-lookup today, so this is a real gain. Check `launchservicesd` with a canary |
| **SEC-15a no resolver** | SEC-15a | **srt** | See S3 |
| **S3a one confined path** | SEC-16…19a; items 4–6, 8a | **Ours** (`runConfined`, lint rule, env allowlist, `--restricted`); srt is the engine underneath | srt passes the environment through, so our allowlist must be applied before the call. We choose the roots from the card record and pass them as the per-call `allowWrite` |
| **S3b fail closed** | SEC-20, 21; items 7–8 | **Ours**, fed by srt's `checkDependencies()` | Treat "seccomp unavailable" and a missing `sandbox-exec` as unconfined (exit 126). srt only warns or assumes |
| **Later items** | SEC-32…37b | **Ours** | Not sandbox features. The SEC-33 self-test can also read srt's violation store |

## Risks

1. **Research preview.** The README says "APIs and configuration formats may evolve." There were 77 releases in 11 months, so the API will change. Pin the exact version and upgrade behind the containment suite.
2. **Singleton.** One configuration and proxy per process; per-call `customConfig` cannot change proxy ports. The CLI per command costs a Node start and a ripgrep scan; measure it.
3. **Weaker defaults:** `~/.ssh` readable, RFC 1918 reachable, two `.git` paths only, `launchservicesd` allowed, environment passed through, missing seccomp only warns. Set each explicitly; test with a canary.
4. **New system dependencies.** ripgrep on macOS, socat on Linux. `doctor` must check for them.
5. **Engine bugs become outages.** Claude Code #55849 (macOS 26.4.1): "Sandbox failed to initialize" on every call, from profile generation, not the OS. Failing closed, that would stop every card; keep our engine as fallback during migration.
6. **`sandbox-exec` deprecation** stays a known liability. Apple has not answered the timeline question (apple/containerization #737, open). srt does not change this.
7. **Options that must stay off**, asserted by a test: TLS termination, credential injection, `allowAppleEvents`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowGitConfig`.
8. **Domain fronting** gets past any name-based allowlist, ours included (item 31a).

## Migration sketch (strangler fig)

1. **Spike (1 day).** Add srt behind `SEKHEMET_SANDBOX_ENGINE=native|srt` (default `native`). Write `SrtEngine implements ConfinementEngine` next to today's `NativeEngine` (seatbelt/bubblewrap/seccomp). It turns `SandboxOptions` into a per-command settings file: `allowWrite` = the canonical recorded roots and private TMPDIR; `denyWrite` = `**/.git` and the dependency links; `denyRead` = the item 10 secret paths and `/run/user`; `httpProxyPort`/`socksProxyPort` = the port of the card's `EgressProxy`, or no domains when offline; `deniedResolvedAddresses` = the RFC 1918, ULA and CGNAT ranges; `allowLocalBinding` = the card's own ports only. It spawns the pinned `srt` CLI by absolute path, with the **already-filtered** environment.
2. **Parameterise the tests.** Run the behavioural tests (`containment`, `sandbox*`, `fail_closed`, `bubblewrap`, `seccomp` specs) against both engines; profile-text tests stay native-only. Add canaries for SEC-15, SEC-15a and item 12. Both engines green on macOS and Linux.
3. **Record the engine.** Write `isolation: "seatbelt"|"bubblewrap"` plus `engine: "srt@0.0.77"|"native"` into the evidence bundle, and have `doctor` report the engine and srt's `checkDependencies()`.
4. **Flip the default** to `srt` once the suite is green on both platforms and one frozen-suite run matches the baseline. Keep `native` for one release as the fallback.
5. **Delete** the native engine (moving `realPath` and `linkedDependencyCaches` to worktree preparation) and its profile tests; update `security.md` §2 items 9–17 and §4 in the same commit, and record a DEC.
6. **Independently of srt:** add the SEC-9 resolve-then-check to `egress.ts` with `ipaddr.js`, and use `request-filtering-agent` for `NetworkPolicy`.

**Needs the owner's yes:** adding `@anthropic-ai/sandbox-runtime` (and `ipaddr.js`, `request-filtering-agent`), the new ripgrep and socat requirements, and a DEC recording srt as the engine under DEC-21's "bubblewrap, not Landlock".

## Sources

- srt repository and README: https://github.com/anthropics/sandbox-runtime (moved from https://github.com/anthropic-experimental/sandbox-runtime)
- srt metadata: https://api.github.com/repos/anthropics/sandbox-runtime ; releases: https://api.github.com/repos/anthropics/sandbox-runtime/releases ; npm: https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/latest
- srt source: `src/sandbox/sandbox-manager.ts`, `macos-sandbox-utils.ts`, `linux-sandbox-utils.ts`, `resolved-address-guard.ts`, `sandbox-config.ts` (main branch, 2026-09-24)
- Codex Linux sandbox: https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md
- Claude Code issue #55849: https://github.com/anthropics/claude-code/issues/55849
- Apple containerization #737: https://github.com/apple/containerization/issues/737
- microsandbox **[search]**: https://github.com/superradcompany/microsandbox ; landrun **[search]**: https://github.com/Zouuup/landrun
- Smokescreen **[search]**: https://github.com/stripe/smokescreen ; request-filtering-agent **[search]**: https://github.com/azu/request-filtering-agent
