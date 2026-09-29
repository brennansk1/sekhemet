import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { platform, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BWRAP_CANDIDATES, bubblewrapArgv } from "../src/bubblewrap.js";
import { ProcessSandbox } from "../src/executor.js";
import { generateSeatbeltProfile } from "../src/seatbelt.js";
import {
  HOME_SECRET_PATHS,
  SESSION_SECRET_PATHS,
  secretReadDenies,
  sessionSecretDenies,
} from "../src/secret_paths.js";
import { srtFilesystem } from "../src/srt_engine.js";
import type { SandboxOptions } from "../src/types.js";

// B-2 (FINISH_LINE_PLAN §B), security item 10 and 14a, SEC-23: bubblewrap
// hides the same secret-bearing paths Seatbelt denies, from one shared table.

const real = (p: string) => realpathSync(p);

/** The position of each mount of `path` in the argv, whatever the option. */
function mountsOf(argv: string[], path: string): { op: string; at: number }[] {
  const out: { op: string; at: number }[] = [];
  argv.forEach((a, i) => {
    if (a === "--tmpfs" && argv[i + 1] === path) out.push({ op: "--tmpfs", at: i });
    if ((a === "--ro-bind" || a === "--bind") && argv[i + 2] === path) {
      out.push({ op: a === "--bind" ? "--bind" : `--ro-bind ${argv[i + 1]}`, at: i });
    }
  });
  return out;
}

describe("B-2: one secret table for both engines", () => {
  let home: string;
  let work: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sek-mask-home-"));
    work = mkdtempSync(join(tmpdir(), "sek-mask-work-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("SEKHEMET_CONFIG_DIR", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of [home, work]) rmSync(d, { recursive: true, force: true });
  });

  const opts = (over: Partial<SandboxOptions> = {}): SandboxOptions => ({
    allowedPaths: [work],
    allowNetwork: false,
    timeoutMs: 1000,
    cwd: work,
    ...over,
  });

  it("names every credential store the plan lists", () => {
    const table = HOME_SECRET_PATHS.map((e) => e.path);
    for (const rel of [
      ".ssh",
      ".aws",
      join(".config", "gcloud"),
      ".azure",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".docker",
      ".kube",
      ".gnupg",
      ".sekhemet",
      join(".config", "sekhemet"),
      join(".config", "gh"),
      join("Library", "Keychains"),
      join(".local", "share", "keyrings"),
      ".password-store",
      ".mozilla",
      join(".config", "google-chrome"),
      join("Library", "Application Support", "Google", "Chrome"),
      // The W1 review's gaps: KWallet, Flatpak and other browsers, AI-agent
      // credentials, and tokens under otherwise readable caches.
      join(".local", "share", "kwalletd"),
      join(".var", "app", "org.mozilla.firefox"),
      join(".var", "app", "com.google.Chrome"),
      join(".config", "vivaldi"),
      join(".config", "opera"),
      join(".claude", ".credentials.json"),
      join(".codex", "auth.json"),
      join(".config", "github-copilot"),
      join(".cache", "huggingface", "token"),
      ".vault-token",
      join(".terraform.d", "credentials.tfrc.json"),
      join(".config", "hub"),
    ]) {
      expect(table, rel).toContain(rel);
    }
    for (const entry of HOME_SECRET_PATHS) expect(entry.why.length, entry.path).toBeGreaterThan(0);
    expect(secretReadDenies(home)).toEqual(HOME_SECRET_PATHS.map((e) => join(home, e.path)));
  });

  it("Seatbelt denies, and bubblewrap masks, every entry of the table (they cannot drift)", () => {
    for (const { path: rel } of HOME_SECRET_PATHS) {
      mkdirSync(dirname(join(home, rel)), { recursive: true });
      writeFileSync(join(home, rel), "SECRET-CANARY");
    }
    const profile = generateSeatbeltProfile(opts());
    const argv = bubblewrapArgv(opts(), "node", []);
    const lastWritable = argv.lastIndexOf("--bind");
    for (const { path: rel } of HOME_SECRET_PATHS) {
      const target = real(join(home, rel));
      expect(profile, rel).toContain(`(deny file-read-data (subpath "${target}"))`);
      const mounts = mountsOf(argv, target);
      // A planted file is hidden behind an empty, read-only /dev/null.
      expect(
        mounts.map((m) => m.op),
        rel,
      ).toEqual(["--ro-bind /dev/null"]);
      expect(mounts[0]?.at, rel).toBeGreaterThan(lastWritable);
    }
  });

  it("hides a secret directory under an empty tmpfs, through a symlink to its real place", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "sek-mask-ssh-"));
    try {
      writeFileSync(join(elsewhere, "id_ed25519"), "SECRET-CANARY");
      symlinkSync(elsewhere, join(home, ".ssh"));
      mkdirSync(join(home, ".aws"));
      const argv = bubblewrapArgv(opts(), "node", []);
      expect(mountsOf(argv, real(elsewhere)).map((m) => m.op)).toEqual(["--tmpfs"]);
      expect(mountsOf(argv, real(join(home, ".aws"))).map((m) => m.op)).toEqual(["--tmpfs"]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("mounts nothing for a secret path that does not exist (the root is read-only)", () => {
    const argv = bubblewrapArgv(opts(), "node", []);
    for (const { path: rel } of HOME_SECRET_PATHS) {
      expect(
        argv.some((a) => a.startsWith(join(real(home), rel))),
        rel,
      ).toBe(false);
    }
  });

  it("masks the secrets inside a granted root that contains them", () => {
    mkdirSync(join(home, ".ssh"));
    const argv = bubblewrapArgv(opts({ allowedPaths: [home], cwd: home }), "node", []);
    const bind = mountsOf(argv, real(home)).find((m) => m.op === "--bind");
    const mask = mountsOf(argv, real(join(home, ".ssh"))).find((m) => m.op === "--tmpfs");
    expect(bind).toBeDefined();
    expect(mask?.at).toBeGreaterThan(bind?.at ?? Number.POSITIVE_INFINITY);
  });

  it("keeps a granted root that lies inside a masked directory: re-bound after the mask", () => {
    const tree = join(home, ".sekhemet", "runs", "card-1");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(home, ".sekhemet", "models.json"), "SECRET-CANARY");
    const argv = bubblewrapArgv(opts({ allowedPaths: [tree], cwd: tree }), "node", []);
    const mask = mountsOf(argv, real(join(home, ".sekhemet"))).find((m) => m.op === "--tmpfs");
    const binds = mountsOf(argv, real(tree)).filter((m) => m.op === "--bind");
    expect(mask).toBeDefined();
    expect(binds.at(-1)?.at).toBeGreaterThan(mask?.at ?? Number.POSITIVE_INFINITY);
  });

  it("masks the project ledger above a granted worktree", () => {
    const project = mkdtempSync(join(tmpdir(), "sek-mask-project-"));
    try {
      const tree = join(project, ".sekhemet", "worktrees", "card-1");
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(project, ".sekhemet", "events.db"), "LEDGER-CANARY");
      const argv = bubblewrapArgv(opts({ allowedPaths: [tree], cwd: tree }), "node", []);
      const db = real(join(project, ".sekhemet", "events.db"));
      const mounts = mountsOf(argv, db);
      expect(mounts.map((m) => m.op)).toEqual(["--ro-bind /dev/null"]);
      expect(mounts[0]?.at).toBeGreaterThan(argv.lastIndexOf("--bind"));
      expect(argv.some((a) => a.includes("*"))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("denyHomeReads: an empty home before the grants, its toolchains read-only, as Seatbelt does", () => {
    mkdirSync(join(home, ".cargo", "bin"), { recursive: true });
    writeFileSync(join(home, ".cargo", "credentials.toml"), "SECRET-CANARY");
    const plain = bubblewrapArgv(opts(), "node", []);
    expect(mountsOf(plain, real(home))).toEqual([]);

    const argv = bubblewrapArgv(opts({ denyHomeReads: true }), "node", []);
    const homeMask = mountsOf(argv, real(home)).find((m) => m.op === "--tmpfs");
    expect(homeMask).toBeDefined();
    expect(homeMask?.at).toBeLessThan(argv.indexOf("--bind"));
    const cargo = mountsOf(argv, join(real(home), ".cargo"));
    expect(cargo.map((m) => m.op)).toEqual([`--ro-bind ${real(join(home, ".cargo"))}`]);
    expect(cargo[0]?.at).toBeGreaterThan(homeMask?.at ?? Number.POSITIVE_INFINITY);
    // The registry token inside a readable toolchain is still masked, later.
    const cred = mountsOf(argv, real(join(home, ".cargo", "credentials.toml")));
    expect(cred.map((m) => m.op)).toEqual(["--ro-bind /dev/null"]);
    expect(cred[0]?.at).toBeGreaterThan(cargo[0]?.at ?? Number.POSITIVE_INFINITY);
  });
});

/**
 * The behaviour, not the argv: a secret planted under HOME is read from inside
 * the real sandbox and the read must fail. HOME is kept out of the temporary
 * directory on Linux, because bubblewrap's private /tmp would hide it with no
 * mask at all and the test would prove nothing.
 */
const BWRAP = platform() === "linux" && BWRAP_CANDIDATES.some((p) => existsSync(p));
const SEATBELT = platform() === "darwin";
const NO_BWRAP_REASON =
  "skipped: no bubblewrap on this host (macOS). It runs in R9, the Lima VM, and on the Linux CI runner (W7)";

describe("B-2: a planted secret cannot be read inside the sandbox", () => {
  let home: string;
  let work: string;
  beforeEach(() => {
    const base = platform() === "linux" && existsSync("/var/tmp") ? "/var/tmp" : tmpdir();
    home = mkdtempSync(join(base, "sek-planted-home-"));
    work = mkdtempSync(join(tmpdir(), "sek-planted-work-"));
    vi.stubEnv("HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of [home, work]) rmSync(d, { recursive: true, force: true });
  });

  async function readInside(target: string) {
    const sandbox = new ProcessSandbox({ engine: "native" });
    return {
      confinement: sandbox.confinement,
      result: await sandbox.execute(
        process.execPath,
        [
          "-e",
          `process.stdout.write(require('fs').readFileSync(${JSON.stringify(target)}, 'utf8'))`,
        ],
        { allowedPaths: [work], allowNetwork: false, timeoutMs: 20_000, cwd: work },
      ),
    };
  }

  function plant(rel: string): string {
    const file = join(home, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "SECRET-CANARY");
    return file;
  }

  it.skipIf(!BWRAP)(
    `bubblewrap: ~/.ssh/id_ed25519 is unreadable, ~/.npmrc reads empty${BWRAP ? "" : ` (${NO_BWRAP_REASON})`}`,
    async () => {
      const key = plant(join(".ssh", "id_ed25519"));
      const npmrc = plant(".npmrc");
      const docker = plant(join(".docker", "config.json"));
      for (const target of [key, docker]) {
        const { confinement, result } = await readInside(target);
        expect(confinement).toBe("bubblewrap");
        expect(result.exitCode, target).not.toBe(0);
        expect(result.stdout, target).not.toContain("CANARY");
      }
      const { result } = await readInside(npmrc);
      expect(result.stdout).not.toContain("CANARY");
      // The grant itself is untouched.
      writeFileSync(join(work, "own.txt"), "mine");
      expect((await readInside(join(work, "own.txt"))).result.stdout).toBe("mine");
    },
  );

  it.runIf(SEATBELT)(
    "Seatbelt: the entries the shared table added are unreadable too",
    async () => {
      for (const rel of [
        join(".docker", "config.json"),
        join(".kube", "config"),
        join(".config", "gcloud", "credentials.db"),
        ".pypirc",
        join(".gnupg", "private-keys-v1.d", "key"),
        join(".cargo", "credentials.toml"),
      ]) {
        const target = plant(rel);
        const { confinement, result } = await readInside(target);
        expect(confinement).toBe("seatbelt");
        expect(result.exitCode, rel).not.toBe(0);
        expect(result.stdout, rel).not.toContain("CANARY");
      }
    },
  );
});

/**
 * W1 review blocker (G2/G3): the session's sockets. `--unshare-net` does not
 * isolate a socket reached by its path, so the D-Bus session bus under
 * /run/user/<uid> (the Secret Service, KWallet), gpg-agent, an ssh-agent and
 * the Docker daemon would answer a sandboxed command. The runtime directory,
 * the agent sockets and the Docker socket are hidden like the home's secrets
 * (docs/research/SANDBOX_REUSE.md: "/run/user is not masked").
 */
describe("B-2: the session's sockets are out of the sandbox's reach", () => {
  let outside: string;
  let work: string;
  beforeEach(() => {
    // Not under /tmp on Linux: bubblewrap's private /tmp would hide it with no mask.
    const base = platform() === "linux" && existsSync("/var/tmp") ? "/var/tmp" : tmpdir();
    outside = mkdtempSync(join(base, "sek-session-"));
    work = mkdtempSync(join(tmpdir(), "sek-session-work-"));
    vi.stubEnv("SEKHEMET_CONFIG_DIR", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of [outside, work]) rmSync(d, { recursive: true, force: true });
  });

  const opts = (over: Partial<SandboxOptions> = {}): SandboxOptions => ({
    allowedPaths: [work],
    allowNetwork: false,
    timeoutMs: 1000,
    cwd: work,
    ...over,
  });

  it("names the session's runtime directory and the Docker socket, each with its reason", () => {
    const table = SESSION_SECRET_PATHS.map((e) => e.path);
    for (const p of ["/run/user", "/run/docker.sock", "/var/run/docker.sock"]) {
      expect(table, p).toContain(p);
    }
    for (const e of SESSION_SECRET_PATHS) expect(e.why.length, e.path).toBeGreaterThan(0);
    vi.stubEnv("XDG_RUNTIME_DIR", join(outside, "runtime"));
    vi.stubEnv("SSH_AUTH_SOCK", join(outside, "agent.sock"));
    vi.stubEnv("GNUPGHOME", join(outside, "gnupg"));
    const denies = sessionSecretDenies();
    for (const p of ["runtime", "agent.sock", "gnupg"]) expect(denies).toContain(join(outside, p));
    // A relative value names nothing the harness can resolve: it is ignored.
    vi.stubEnv("SSH_AUTH_SOCK", "agent.sock");
    expect(sessionSecretDenies()).not.toContain("agent.sock");
  });

  it("bubblewrap hides the runtime directory and the agent socket, after the writable binds", () => {
    const runtime = join(outside, "runtime");
    mkdirSync(runtime);
    writeFileSync(join(outside, "agent.sock"), "");
    vi.stubEnv("XDG_RUNTIME_DIR", runtime);
    vi.stubEnv("SSH_AUTH_SOCK", join(outside, "agent.sock"));
    // With the network granted too: a socket's path is not the network.
    for (const allowNetwork of [false, true]) {
      const argv = bubblewrapArgv(opts({ allowNetwork }), "node", []);
      const lastWritable = argv.lastIndexOf("--bind");
      const dir = mountsOf(argv, real(runtime));
      expect(dir.map((m) => m.op)).toEqual(["--tmpfs"]);
      expect(dir[0]?.at).toBeGreaterThan(lastWritable);
      const sock = mountsOf(argv, real(join(outside, "agent.sock")));
      expect(sock.map((m) => m.op)).toEqual(["--ro-bind /dev/null"]);
      if (existsSync("/run/user")) {
        expect(mountsOf(argv, real("/run/user")).map((m) => m.op)).toEqual(["--tmpfs"]);
      }
    }
  });

  it("mounts nothing for a socket under the private /tmp or below another mask", () => {
    const tmpSock = join("/tmp", `sek-agent-${process.pid}.sock`);
    vi.stubEnv("SSH_AUTH_SOCK", tmpSock);
    const runtime = join(outside, "runtime");
    mkdirSync(join(runtime, "gnupg"), { recursive: true });
    vi.stubEnv("XDG_RUNTIME_DIR", runtime);
    vi.stubEnv("GNUPGHOME", join(runtime, "gnupg"));
    writeFileSync(tmpSock, "");
    try {
      const argv = bubblewrapArgv(opts(), "node", []);
      expect(argv.some((a) => a.startsWith(tmpSock) || a.startsWith(real(tmpSock)))).toBe(false);
      expect(mountsOf(argv, real(join(runtime, "gnupg")))).toEqual([]);
      expect(mountsOf(argv, real(runtime)).map((m) => m.op)).toEqual(["--tmpfs"]);
    } finally {
      rmSync(tmpSock, { force: true });
    }
  });

  it("srt receives the same paths as denyRead", () => {
    vi.stubEnv("XDG_RUNTIME_DIR", join(outside, "runtime"));
    const fs = srtFilesystem(opts());
    for (const p of ["/run/user", "/run/docker.sock", join(outside, "runtime")]) {
      expect(fs.denyRead, p).toContain(p);
    }
  });

  /**
   * The behaviour: a unix socket listening in the session's runtime
   * directory, as the D-Bus session bus does, is connected to from inside
   * the real sandbox, and the connection must fail, with the network granted
   * or not. Where the host has a session bus of its own, that is tried too.
   */
  it.skipIf(!BWRAP)(
    `bubblewrap: the session bus's socket cannot be reached${BWRAP ? "" : ` (${NO_BWRAP_REASON})`}`,
    async () => {
      const runtime = join(outside, "runtime");
      mkdirSync(runtime, { mode: 0o700 });
      const bus = join(runtime, "bus");
      const server = createServer((c) => c.end("SECRET-CANARY"));
      await new Promise<void>((ok) => server.listen(bus, ok));
      vi.stubEnv("XDG_RUNTIME_DIR", runtime);
      const hostBus = join("/run/user", String(userInfo().uid), "bus");
      try {
        for (const target of [bus, ...(existsSync(hostBus) ? [hostBus] : [])]) {
          for (const allowNetwork of [false, true]) {
            const sandbox = new ProcessSandbox({ engine: "native" });
            const result = await sandbox.execute(
              process.execPath,
              [
                "-e",
                `require('net').connect(${JSON.stringify(target)})
                  .on('connect', () => { process.stdout.write('CONNECTED'); process.exit(0); })
                  .on('error', (e) => { process.stdout.write('REFUSED ' + e.code); process.exit(3); });`,
              ],
              { allowedPaths: [work], allowNetwork, timeoutMs: 20_000, cwd: work },
            );
            expect(sandbox.confinement).toBe("bubblewrap");
            expect(result.stdout, `${target} network=${allowNetwork}`).toMatch(/^REFUSED/);
            expect(result.exitCode).not.toBe(0);
          }
        }
      } finally {
        await new Promise<void>((ok) => server.close(() => ok()));
      }
    },
  );
});
