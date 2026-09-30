import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BWRAP_CANDIDATES, bubblewrapArgv } from "../src/bubblewrap.js";
import { ProcessSandbox, type SandboxEngine } from "../src/executor.js";
import { generateSeatbeltProfile } from "../src/seatbelt.js";
import {
  HOME_SECRET_PATHS,
  SESSION_SECRET_PATHS,
  sessionSecretDenies,
} from "../src/secret_paths.js";
import { srtFilesystem, srtReset, srtUnavailableReason } from "../src/srt_engine.js";
import type { SandboxOptions } from "../src/types.js";

/**
 * Fix round F3 (W2b finding, security item 15, SEC-15): on Linux a Unix
 * socket is reached by its path, and bubblewrap cannot filter a connect by
 * path, so every socket that is not behind a mask stays reachable, with the
 * network granted or not; with the network granted, an abstract socket (no
 * path at all: X11's, some session buses') is reachable too, since the
 * command shares the host's network namespace. What a mount can deny, it
 * denies: the system bus, the container and VM daemons that are root on the
 * host, the smart-card daemon, terminal multiplexers' sockets and the key
 * agents in the home. srt's seccomp refuses creating any Unix socket, which
 * closes the rest under that engine. The argv checks run everywhere; the
 * runtime checks need Linux (R9, the Linux CI runner).
 */

const real = (p: string) => realpathSync(p);
const LINUX = platform() === "linux";
const BWRAP = LINUX && BWRAP_CANDIDATES.some((p) => existsSync(p));
const SRT = LINUX && srtUnavailableReason() === undefined;

function mountsOf(argv: string[], path: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === "--tmpfs" && argv[i + 1] === path) out.push("--tmpfs");
    if (a === "--ro-bind" && argv[i + 2] === path) out.push(`--ro-bind ${argv[i + 1]}`);
  });
  return out;
}

let outside: string;
let work: string;
beforeEach(() => {
  // Not under /tmp on Linux: bubblewrap's private /tmp would hide it with no mask.
  const base = LINUX && existsSync("/var/tmp") ? "/var/tmp" : tmpdir();
  outside = mkdtempSync(join(base, "sek-sock-"));
  work = mkdtempSync(join(tmpdir(), "sek-sock-work-"));
  vi.stubEnv("SEKHEMET_CONFIG_DIR", "");
  for (const v of ["TMUX", "TMUX_TMPDIR", "SCREENDIR"]) vi.stubEnv(v, "");
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

describe("SEC-15: the host sockets a mount can hide", () => {
  it("names the system bus, the root-equivalent daemons, the smart cards and screen, each with a reason", () => {
    const table = SESSION_SECRET_PATHS.map((e) => e.path);
    for (const p of [
      "/run/dbus",
      "/run/podman",
      "/run/containerd",
      "/run/libvirt",
      "/var/snap/lxd/common/lxd/unix.socket",
      "/var/lib/lxd/unix.socket",
      "/var/lib/incus/unix.socket",
      "/run/pcscd",
      "/run/screen",
    ]) {
      expect(table, p).toContain(p);
    }
    for (const e of SESSION_SECRET_PATHS) expect(e.why.length, e.path).toBeGreaterThan(0);
  });

  it("names the key agents' sockets in the home", () => {
    const table = HOME_SECRET_PATHS.map((e) => e.path);
    expect(table).toContain(".1password");
    expect(table).toContain(".bitwarden-ssh-agent.sock");
  });

  it("names the tmux and screen sockets this session's environment points at", () => {
    const sock = join(outside, "tmux-1000", "default");
    vi.stubEnv("TMUX", `${sock},4242,0`);
    vi.stubEnv("TMUX_TMPDIR", join(outside, "tt"));
    vi.stubEnv("SCREENDIR", join(outside, "screens"));
    const denies = sessionSecretDenies();
    expect(denies).toContain(sock);
    expect(denies).toContain(join(outside, "tt", `tmux-${userInfo().uid}`));
    expect(denies).toContain(join(outside, "screens"));
    // A relative value names nothing the harness can resolve: it is ignored.
    vi.stubEnv("TMUX", "default,1,0");
    vi.stubEnv("TMUX_TMPDIR", "tt");
    vi.stubEnv("SCREENDIR", "screens");
    const relative = sessionSecretDenies();
    for (const p of ["default", join("tt", `tmux-${userInfo().uid}`), "screens"]) {
      expect(relative).not.toContain(p);
    }
  });

  it("bubblewrap hides each after the writable binds, with the network granted or not", () => {
    const sock = join(outside, "tmux-1000", "default");
    mkdirSync(join(outside, "tmux-1000"));
    writeFileSync(sock, "");
    mkdirSync(join(outside, "screens"));
    vi.stubEnv("TMUX", `${sock},4242,0`);
    vi.stubEnv("SCREENDIR", join(outside, "screens"));
    for (const allowNetwork of [false, true]) {
      const argv = bubblewrapArgv(opts({ allowNetwork }), "node", []);
      const lastWritable = argv.lastIndexOf("--bind");
      expect(mountsOf(argv, real(sock))).toEqual(["--ro-bind /dev/null"]);
      expect(mountsOf(argv, real(join(outside, "screens")))).toEqual(["--tmpfs"]);
      expect(argv.indexOf(real(sock))).toBeGreaterThan(lastWritable);
      // The table's own paths, where this host has them.
      for (const { path } of SESSION_SECRET_PATHS) {
        if (existsSync(path)) expect(mountsOf(argv, real(path)), path).toHaveLength(1);
      }
    }
  });

  it("srt receives them as denyRead, and Seatbelt refuses a connect to them", () => {
    const sock = join(outside, "tmux-1000", "default");
    mkdirSync(join(outside, "tmux-1000"));
    writeFileSync(sock, "");
    vi.stubEnv("TMUX", `${sock},4242,0`);
    const fs = srtFilesystem(opts());
    for (const p of ["/run/dbus", "/run/podman", "/var/lib/incus/unix.socket", sock]) {
      expect(fs.denyRead, p).toContain(p);
    }
    const profile = generateSeatbeltProfile(opts({ allowNetwork: true }));
    const resolved = real(sock);
    expect(profile).toContain(
      `(deny network-outbound (remote unix-socket (subpath "${resolved}")))`,
    );
  });
});

/**
 * The behaviour, on Linux: a stand-in tmux server at the path `$TMUX` names,
 * outside the granted paths and outside /tmp, never sees a connection from
 * inside the sandbox, under either engine, with the network off or on. Under
 * srt no Unix socket can be made at all, so an unlisted path and an abstract
 * socket are refused too; under the native engine those two remain (item 15).
 */
// argv cannot carry a NUL, so an abstract name travels as "@name" (ss's notation).
const CONNECT = `const p=process.argv[1];const s=require('net').connect(p.startsWith('@')?'\\0'+p.slice(1):p);
s.on('connect',()=>{console.log('CONNECTED');s.destroy();process.exit(0)});
s.on('error',e=>{console.log('REFUSED '+e.code);process.exit(7)});`;

const ENGINES: { engine: SandboxEngine; runs: boolean }[] = [
  { engine: "native", runs: BWRAP },
  { engine: "srt", runs: SRT },
];

for (const { engine, runs } of ENGINES) {
  describe.runIf(runs)(`Linux host sockets (${engine} engine)`, () => {
    let servers: Server[] = [];
    let seen: Record<string, number> = {};
    const listen = async (path: string) => {
      seen[path] = 0;
      const server = createServer((c) => {
        seen[path] = (seen[path] ?? 0) + 1;
        c.end("TMUX-CANARY\n");
      });
      await new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen(path, () => ok());
      });
      servers.push(server);
    };
    const connect = (path: string, allowNetwork: boolean) =>
      new ProcessSandbox({ engine }).execute(process.execPath, ["-e", CONNECT, path], {
        allowedPaths: [work],
        allowNetwork,
        timeoutMs: 20_000,
        cwd: work,
      });
    beforeEach(() => {
      servers = [];
      seen = {};
    });
    afterEach(async () => {
      for (const s of servers) await new Promise((r) => s.close(r));
      if (engine === "srt") await srtReset();
    });

    for (const allowNetwork of [false, true]) {
      it(`cannot reach the tmux server $TMUX names (network ${allowNetwork ? "on" : "off"})`, async () => {
        mkdirSync(join(outside, "tmux-1000"), { mode: 0o700 });
        const sock = join(outside, "tmux-1000", "default");
        await listen(sock);
        vi.stubEnv("TMUX", `${sock},4242,0`);
        const result = await connect(sock, allowNetwork);
        expect(result.stdout).not.toContain("CONNECTED");
        expect(seen[sock]).toBe(0);
      });

      // The native engine shares the host's network namespace when the
      // network is granted, and with it the abstract namespace: item 15's residual.
      it.skipIf(engine === "native" && allowNetwork)(
        `cannot reach an abstract socket (network ${allowNetwork ? "on" : "off"})`,
        async () => {
          const name = `\0sek-abstract-${process.pid}`;
          await listen(name);
          const result = await connect(`@${name.slice(1)}`, allowNetwork);
          expect(result.stdout).not.toContain("CONNECTED");
          expect(seen[name]).toBe(0);
        },
      );
    }

    it.runIf(engine === "srt")(
      "srt: a socket at a path no table names is refused too, with the network granted",
      async () => {
        const sock = join(outside, "unlisted.sock");
        await listen(sock);
        const result = await connect(sock, true);
        expect(result.stdout).not.toContain("CONNECTED");
        expect(seen[sock]).toBe(0);
      },
    );
  });
}
