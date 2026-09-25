import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SandboxOptions } from "./types.js";

/**
 * Resolve a path through symlinks for use in a Seatbelt `subpath` rule.
 *
 * Seatbelt matches on the real filesystem path. On macOS `/tmp` is a symlink to
 * `/private/tmp`, so a profile written against the unresolved path silently
 * fails to grant the access it appears to grant.
 */
export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve dependency directories that are symlinked into an allowed root.
 *
 * Per-card worktrees link `node_modules` rather than copying it, so the real
 * tree lives outside the worktree. Toolchains write inside it as a matter of
 * course — vitest alone needs `node_modules/.vite-temp` — so without this every
 * gate fails on EPERM rather than on the card's work. The grant is deliberately
 * narrow: the dependency tree only, never its parent.
 */
/**
 * Paths inside a writable root that the sandbox must never write: the git
 * metadata. A worktree's `.git` pointer tells git where its metadata lives,
 * and the harness runs git outside the sandbox in that worktree, so a Worker
 * able to rewrite it could aim git at configuration it controls (Phase A
 * security review, 2026-09-22).
 */
export function protectedInsideRoots(roots: string[]): string[] {
  return roots.map((r) => join(realPath(r), ".git"));
}

export function linkedDependencyTargets(roots: string[]): string[] {
  const targets: string[] = [];

  for (const root of roots) {
    for (const name of ["node_modules", ".venv"]) {
      const candidate = join(root, name);
      if (!existsSync(candidate)) continue;
      try {
        if (lstatSync(candidate).isSymbolicLink()) targets.push(realpathSync(candidate));
      } catch {
        // Unreadable link: the gate reports the real consequence instead.
      }
    }
  }

  return targets;
}

/**
 * Toolchains that commonly live under the user's home: version managers,
 * package-manager stores and the Playwright browser cache. Under
 * `denyHomeReads` they stay readable; nothing else in the home does.
 */
export function homeToolchainPaths(home: string = homedir()): string[] {
  return [
    ".nvm",
    ".volta",
    ".fnm",
    ".asdf",
    ".cargo",
    ".rustup",
    ".pyenv",
    ".bun",
    ".deno",
    join("Library", "pnpm"),
    join(".local", "share", "pnpm"),
    join("Library", "Caches", "ms-playwright"),
    join(".cache", "ms-playwright"),
  ].map((p) => join(home, p));
}

/**
 * What a headless Chromium needs beyond the base profile to start
 * (SandboxOptions.browser): its own Mach services and the power-management
 * IOKit client, nothing wider. Without them it crashes at start.
 */
const BROWSER_RULES = `
;; S3a: a headless browser.
(allow mach-register (global-name-prefix "org.chromium."))
(allow iokit-open (iokit-user-client-class "RootDomainUserClient"))`;

/** Escape a path for embedding in a Seatbelt regex literal. */
function regexQuote(p: string): string {
  return p.replace(/[\\^$.*+?()[\]{}|"#]/g, (c) => `\\${c}`);
}

/** Escape a path for embedding in a Seatbelt profile string literal. */
function quote(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The user's secret-bearing paths (security.md item 10, SEC-23). */
export function secretReadDenies(home: string): string[] {
  // `.config/sekhemet` holds the integration tokens' file (item 35, SEC-27).
  return [
    ".ssh",
    ".aws",
    ".npmrc",
    ".netrc",
    join(".config", "gh"),
    ".sekhemet",
    join(".config", "sekhemet"),
  ]
    .map((p) => join(home, p))
    .concat(configDirDeny());
}

/**
 * The user directory moved by `SEKHEMET_CONFIG_DIR` (surface NEW-surface-1):
 * it holds what `~/.sekhemet` would, so it is denied the same way (SEC-23).
 */
function configDirDeny(): string[] {
  const dir = process.env.SEKHEMET_CONFIG_DIR?.trim();
  // Resolved as the harness resolves it (sekhemetConfigDir): a relative one is still denied.
  return dir ? [resolve(dir)] : [];
}

/**
 * The project ledgers above each root: `<ancestor>/.sekhemet/*.db` (and their
 * WAL/SHM files). Listed as literal paths so Linux needs no ripgrep scan.
 */
export function ledgerReadDenies(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    let dir = realPath(root);
    for (;;) {
      const state = join(dir, ".sekhemet");
      if (existsSync(state)) {
        try {
          for (const f of readdirSync(state)) {
            if (/\.db(-wal|-shm|-journal)?$/i.test(f)) out.add(join(state, f));
          }
        } catch {
          // Unreadable: nothing to list, nothing to leak through us.
        }
        // New ledgers created after the wrap are still covered on macOS.
        if (platform() === "darwin") out.add(join(state, "*.db*"));
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return [...out];
}

/** Every `.sekhemet` directory at or above `root` (real paths), for the ledger denies. */
function ledgerDirsAbove(root: string): string[] {
  const out: string[] = [];
  let dir = realPath(root);
  for (;;) {
    const state = join(dir, ".sekhemet");
    if (existsSync(state)) out.push(state);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/**
 * Generate a macOS Seatbelt profile confining a subprocess to `allowedPaths`.
 *
 * The policy is deny-by-default. Reads are permitted broadly because
 * toolchains must load system libraries, interpreters and language servers;
 * it is *writes* and *network egress* that carry the blast radius, and those
 * are restricted to explicitly granted subpaths.
 */
export function generateSeatbeltProfile(options: SandboxOptions): string {
  // Only what the caller granted, plus an explicit scratch directory if one was
  // supplied. Granting the whole of TMPDIR would let a confined process write
  // into any other card's scratch space — which is still an escape, just a
  // quieter one.
  const roots = [...options.allowedPaths, ...(options.scratchDir ? [options.scratchDir] : [])];
  // S2: no grant reaches the main checkout's dependency tree; each worktree
  // has its own caches (item 24).
  const writeRoots = [...new Set(roots.map(realPath))];

  const writeRules = writeRoots
    .map((p) => `  (allow file-write* (subpath "${quote(p)}"))`)
    .join("\n");
  // Denials come after the grants: in a Seatbelt profile the later rule wins.
  // `.git` at any depth and in any case (APFS is case-insensitive): a nested
  // sub/.git is metadata the harness's git would descend into (review G2).
  const protectRules = [...new Set(roots.map(realPath))]
    .map((r) => `  (deny file-write* (regex #"^${regexQuote(r)}/(.*/)?[.][Gg][Ii][Tt](/|$)"))`)
    .join("\n");

  // Build tools legitimately write to these character devices; denying them
  // breaks ordinary stdout/stderr redirection rather than improving safety.
  const deviceRules = [
    '  (allow file-write-data (literal "/dev/null"))',
    '  (allow file-write-data (literal "/dev/stdout"))',
    '  (allow file-write-data (literal "/dev/stderr"))',
    '  (allow file-write-data (literal "/dev/dtracehelper"))',
    '  (allow file-ioctl (literal "/dev/tty"))',
  ].join("\n");

  // `(deny default)` already blocks egress; the explicit rule is kept so the
  // profile states its network posture rather than implying it.
  const networkRule = options.allowNetwork
    ? "  (allow network*)"
    : options.egressProxyPort
      ? `  (deny network*)\n  ;; S5: the allowlisting egress proxy is the only way out.\n  (allow network-outbound (remote tcp "localhost:${Math.floor(options.egressProxyPort)}"))`
      : "  (deny network*)";

  const portRules = (options.localPorts ?? [])
    .map((p) => Math.floor(p))
    .map(
      (p) =>
        `  (allow network-bind network-inbound (local ip "localhost:${p}"))\n  (allow network-outbound (remote ip "localhost:${p}"))`,
    )
    .join("\n");

  // S3a: the home directory's contents are unreadable, the toolchains in it
  // and the granted roots excepted (later rules win). Metadata stays
  // readable so paths still resolve.
  const home = realPath(homedir());
  const homeRules = options.denyHomeReads
    ? [
        ";; S3a: nothing under the user's home but its toolchains and the granted roots.",
        `  (deny file-read-data (subpath "${quote(home)}"))`,
        ...[...homeToolchainPaths(), ...roots]
          .map(realPath)
          .map((p) => `  (allow file-read-data (subpath "${quote(p)}"))`),
      ].join("\n")
    : "";

  // S3c, security item 10 (SEC-23): the user's secret-bearing paths and the
  // project ledgers above each root are never readable, whatever else is.
  const secretRules = [
    ";; S3c: the user's secrets and the project ledgers (SEC-23).",
    ...secretReadDenies(homedir())
      .map(realPath)
      .map((p) => `  (deny file-read-data (subpath "${quote(p)}"))`),
    ...[...new Set(roots.flatMap(ledgerDirsAbove))].map(
      (state) => `  (deny file-read-data (regex #"^${regexQuote(state)}/[^/]*[.][Dd][Bb]"))`,
    ),
  ].join("\n");

  return `;; Sekhemet Seatbelt Containment Profile
(version 1)
(deny default)

;; Process primitives required to run a toolchain at all.
(allow process-exec)
(allow process-fork)
;; Test runners and build tools manage worker pools, so they must be able to
;; signal their own descendants. Restricting this to self made vitest fail
;; with kill EPERM while tearing down workers: a sandbox that breaks the
;; toolchain reports the sandbox, not the card.
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow file-read-metadata)

;; Reads are broad: compilers and runtimes must load system libraries.
(allow file-read*)
${homeRules}
${secretRules}

;; Writes are confined to explicitly granted subpaths.
${writeRules}
${deviceRules}

;; Never the git metadata inside a granted path: git runs outside the sandbox.
${protectRules}

;; Network egress.
${networkRule}
${portRules ? `\n;; L23: the card's own loopback ports.\n${portRules}\n` : ""}${options.browser ? BROWSER_RULES : ""}`;
}
