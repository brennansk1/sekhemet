import { spawn } from "node:child_process";
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
 * path, so every socket that is not behind a mask stays reachable with the
 * network off. With the network granted the command shares the host's
 * network namespace, and with it the abstract sockets (no path at all: X11's,
 * some session buses'), so the native engine's seccomp program then refuses
 * creating any Unix socket, as srt's always does (B1). What a mount can deny, it
 * denies: the system bus, the container and VM daemons that are root on the
 * host, the smart-card daemon, terminal multiplexers' sockets and the key
 * agents in the home. srt's seccomp refuses `socket(AF_UNIX)`, which closes
 * the rest of the stream sockets under that engine; it allows a datagram
 * socketpair, srt's residual (item 15). The argv checks run everywhere; the
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
 * srt `socket(AF_UNIX)` is refused, so an unlisted path and an abstract
 * socket are refused a stream connect too. Under the native engine an
 * abstract socket is refused with the network off by the empty namespace and
 * with it on by its seccomp program; an unlisted path with the network off
 * remains (item 15).
 */
// argv cannot carry a NUL, so an abstract name travels as "@name" (ss's notation).
const CONNECT = `const p=process.argv[1];const s=require('net').connect(p.startsWith('@')?'\\0'+p.slice(1):p);
s.on('connect',()=>{console.log('CONNECTED');s.destroy();process.exit(0)});
s.on('error',e=>{console.log('REFUSED '+e.code);process.exit(7)});`;

/**
 * The datagram probe (B1 review): Node has no Unix datagram sockets, so
 * python3 plays both sides. Inside, every way to a Unix datagram socket is
 * tried — `socket(AF_UNIX, SOCK_DGRAM)`, and `socketpair(AF_UNIX, …)` with
 * SOCK_DGRAM and SOCK_RAW (which the kernel makes a datagram socket) — each
 * by `sendto` and by `connect` then `send`. "SENT" is printed for every
 * datagram the kernel accepted.
 */
const PYTHON = "/usr/bin/python3";
const DGRAM_SEND = `import socket,sys
def addr(t): return '\\0'+t[1:] if t.startswith('@') else t
socks=[]
try: socks.append(('socket',socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)))
except OSError as e: print('REFUSED socket',e.errno)
for kind in (socket.SOCK_DGRAM,3):
  try: socks.append(('pair%d'%kind,socket.socketpair(socket.AF_UNIX,kind)[0]))
  except OSError as e: print('REFUSED pair%d'%kind,e.errno)
for name,s in socks:
  for t in sys.argv[1:]:
    try: s.sendto(b'PROBE '+name.encode(),addr(t)); print('SENT sendto',name,t)
    except OSError as e: print('NOT sendto',name,t,e.errno)
    try: s.connect(addr(t)); s.send(b'PROBE '+name.encode()); print('SENT connect',name,t)
    except OSError as e: print('NOT connect',name,t,e.errno)
`;
// The host's listener: binds each target, prints READY, then GOT for every datagram.
const DGRAM_LISTEN = `import socket,sys,select
socks=[]
for t in sys.argv[1:]:
  s=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM); s.bind('\\0'+t[1:] if t.startswith('@') else t); socks.append(s)
print('READY',flush=True)
while True:
  for s in select.select(socks,[],[])[0]: print('GOT',s.recv(256).decode(),flush=True)
`;

async function datagramProbe(
  targets: string[],
  send: (targets: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<{ sent: string[]; received: string[]; stdout: string }> {
  expect(existsSync(PYTHON), "the datagram probe needs python3 at /usr/bin/python3").toBe(true);
  const listener = spawn(PYTHON, ["-u", "-c", DGRAM_LISTEN, ...targets], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let heard = "";
  listener.stdout.on("data", (b: Buffer) => {
    heard += b.toString();
  });
  try {
    await new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error("the datagram listener did not start")), 10_000);
      listener.stdout.on("data", () => {
        if (heard.includes("READY")) {
          clearTimeout(t);
          ok();
        }
      });
      listener.once("exit", (code) => fail(new Error(`the datagram listener exited ${code}`)));
    });
    // The probe itself ran: some attempt must be reported, refused or not.
    const result = await send(targets);
    expect(result.stdout, result.stderr).toMatch(/REFUSED|SENT|NOT /);
    // A datagram the kernel accepted arrives at once; give it a moment anyway.
    await new Promise((r) => setTimeout(r, 300));
    return {
      sent: result.stdout.split("\n").filter((l) => l.startsWith("SENT")),
      received: heard.split("\n").filter((l) => l.startsWith("GOT")),
      stdout: result.stdout,
    };
  } finally {
    listener.kill();
  }
}

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

      // Network off: the namespace is empty, and the abstract one with it.
      // Network on: the host's namespace is shared, so the engine's seccomp
      // program refuses creating a Unix socket at all (item 15, B1).
      it(`cannot reach an abstract socket (network ${allowNetwork ? "on" : "off"})`, async () => {
        const name = `\0sek-abstract-${process.pid}`;
        await listen(name);
        const result = await connect(`@${name.slice(1)}`, allowNetwork);
        expect(result.stdout).not.toContain("CONNECTED");
        expect(seen[name]).toBe(0);
      });
    }

    // B1 review blocker: a datagram socket needs no connect, so a Unix
    // socketpair's datagram end can sendto any host datagram socket. The
    // native engine's network-granted program refuses that pair (seccomp.ts);
    // with the network off the empty namespace hides every abstract name.
    // srt's own filter allows the pair, so under srt only the network-off
    // abstract case holds: its residual, security.md item 15.
    const DGRAM_POSTURES = engine === "native" ? [false, true] : [false];
    for (const allowNetwork of DGRAM_POSTURES) {
      it(`cannot send a datagram to a host abstract socket (network ${allowNetwork ? "on" : "off"})`, async () => {
        const probe = await datagramProbe([`@sek-dgram-${process.pid}`], (targets) =>
          new ProcessSandbox({ engine }).execute(PYTHON, ["-c", DGRAM_SEND, ...targets], {
            allowedPaths: [work],
            allowNetwork,
            timeoutMs: 20_000,
            cwd: work,
          }),
        );
        expect(probe.sent).toEqual([]);
        expect(probe.received).toEqual([]);
      });
    }
    if (engine === "native") {
      it("native: cannot send a datagram to a host path socket no table names, with the network granted", async () => {
        const probe = await datagramProbe([join(outside, "unlisted-dgram.sock")], (targets) =>
          new ProcessSandbox({ engine }).execute(PYTHON, ["-c", DGRAM_SEND, ...targets], {
            allowedPaths: [work],
            allowNetwork: true,
            timeoutMs: 20_000,
            cwd: work,
          }),
        );
        expect(probe.sent).toEqual([]);
        expect(probe.received).toEqual([]);
      });
    }

    // Generated for srt only, so no engine's block holds a case it never runs (B1, SEC-43).
    if (engine === "srt") {
      it("srt: a socket at a path no table names is refused too, with the network granted", async () => {
        const sock = join(outside, "unlisted.sock");
        await listen(sock);
        const result = await connect(sock, true);
        expect(result.stdout).not.toContain("CONNECTED");
        expect(seen[sock]).toBe(0);
      });
    }
  });
}
