import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { type AddressInfo, type Server, type Socket, connect, createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bubblewrapArgv } from "../src/bubblewrap.js";
import { ProcessSandbox, type SandboxEngine } from "../src/executor.js";
import {
  RELAY_NAME,
  relayEnv,
  relayPlan,
  relayScript,
  relayScriptPath,
  startHostRelays,
} from "../src/relay.js";
import { srtRelayInner, srtUnavailableReason } from "../src/srt_engine.js";

/**
 * DEC-50: on Linux a card's egress proxy and its named ports are reached
 * through relays across the sandbox's network namespace. A port something on
 * the host already listens on (the proxy, a test server, another card
 * process's relay) is relayed inward: a relay inside listens on the same
 * loopback port and reaches the host through a Unix socket in the scratch
 * directory. A free port is the command's own (a dev server): the host side
 * listens on it and reaches the command through a socket the relay inside
 * listens on.
 */

const linux = platform() === "linux";
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "relay-"));
  dirs.push(d);
  return d;
}

async function listenTcp(onConn: (c: Socket) => void): Promise<number> {
  const s = createServer(onConn);
  servers.push(s);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
}

async function listenUnix(path: string, onConn: (c: Socket) => void): Promise<void> {
  const s = createServer(onConn);
  servers.push(s);
  await new Promise((r) => s.listen(path, () => r(undefined)));
}

function readAll(sock: Socket, send?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    sock.on("data", (d) => {
      out += String(d);
    });
    sock.on("end", () => resolve(out));
    sock.on("error", reject);
    if (send) sock.write(send);
  });
}

describe("DEC-50: the relay plan", () => {
  it("relays a port the host listens on inward and a free one outward, each once", () => {
    const dir = "/tmp/sekhemet-box-abc";
    const plan = relayPlan([4000, 5000, 4000, 0, -1, 70000], dir, (p) => p === 4000);
    expect(plan).toEqual([
      { kind: "f", port: 4000, socket: "/tmp/sekhemet-box-abc/.relay-4000" },
      { kind: "r", port: 5000, socket: "/tmp/sekhemet-box-abc/.relay-5000" },
    ]);
    expect(relayEnv(plan)).toBe(
      "f:4000:/tmp/sekhemet-box-abc/.relay-4000 r:5000:/tmp/sekhemet-box-abc/.relay-5000",
    );
  });

  it("builds no relay where a socket path could not be named safely (fails closed: no route)", () => {
    expect(relayPlan([4000], `/tmp/${"x".repeat(120)}`, () => true)).toEqual([]);
    expect(relayPlan([4000], "/tmp/a b", () => true)).toEqual([]);
    expect(relayPlan([4000], "/tmp/a:b", () => true)).toEqual([]);
    expect(relayPlan([4000], "/tmp/a,b", () => true)).toEqual([]);
  });

  it("ships the inner relay as an executable POSIX script srt can run as its socat", () => {
    const path = relayScriptPath();
    expect(statSync(path).mode & 0o111).not.toBe(0);
    const text = relayScript();
    expect(text).toBe(readFileSync(path, "utf8"));
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    // Each mode: native (`--`), srt's socat (its proxy listener inside), the wait.
    for (const word of ["--)", "--wait)", "TCP-LISTEN:3128,*)", 'exec socat "$@"']) {
      expect(text).toContain(word);
    }
  });
});

describe("DEC-50: bubblewrap with relays", () => {
  const base = { allowedPaths: ["/w"], allowNetwork: false, timeoutMs: 1, cwd: "/w" };

  it("keeps the empty network namespace and starts the relays inside before the command", () => {
    const relays = [{ kind: "f" as const, port: 4000, socket: "/tmp/s/.relay-4000" }];
    const argv = bubblewrapArgv(base, "node", ["-v"], undefined, relays);
    expect(argv).toContain("--unshare-net");
    const env = argv.indexOf("--setenv");
    expect(argv.slice(env, env + 3)).toEqual([
      "--setenv",
      "SEKHEMET_RELAYS",
      "f:4000:/tmp/s/.relay-4000",
    ]);
    const sep = argv.indexOf("--", argv.indexOf("--chdir"));
    expect(argv.slice(sep)).toEqual([
      "--",
      "/bin/sh",
      "-c",
      relayScript(),
      RELAY_NAME,
      "--",
      "node",
      "-v",
    ]);
  });

  it("is unchanged without relays", () => {
    const argv = bubblewrapArgv(base, "node", ["-v"], undefined, []);
    expect(argv).not.toContain("SEKHEMET_RELAYS");
    expect(argv.slice(-3)).toEqual(["--", "node", "-v"]);
  });
});

describe("DEC-50: srt's command on Linux waits for the relays", () => {
  it("waits for them after its seccomp filter, then hides the variable from the command", () => {
    expect(srtRelayInner([], "/opt/s/bin/sekhemet-relay")).toBe("");
    expect(srtRelayInner([{ kind: "r", port: 5000, socket: "/tmp/s/.relay-5000" }], "/p/r")).toBe(
      "/bin/sh '/p/r' --wait; unset SEKHEMET_RELAYS;",
    );
  });
});

describe("DEC-50: the host side of the relays", () => {
  it("inward: a connection on the socket reaches the host port", async () => {
    const port = await listenTcp((c) => c.end("PONG"));
    const dir = scratch();
    const plan = relayPlan([port], dir, () => true);
    const host = startHostRelays(plan);
    try {
      expect(await readAll(connect(plan[0]?.socket as string))).toBe("PONG");
    } finally {
      host.close();
    }
  });

  it("outward: a connection on the host's loopback port reaches the socket inside", async () => {
    const dir = scratch();
    // A free port: bind one and let it go.
    const probe = createServer();
    const port: number = await new Promise((r) =>
      probe.listen(0, "127.0.0.1", () => r((probe.address() as AddressInfo).port)),
    );
    await new Promise((r) => probe.close(() => r(undefined)));
    const plan = relayPlan([port], dir, () => false);
    // Stands in for the relay inside, which listens on the socket.
    await listenUnix(plan[0]?.socket as string, (c) => {
      c.once("data", (d) => c.end(`ECHO ${String(d)}`));
    });
    const host = startHostRelays(plan);
    try {
      await host.ready;
      expect(await readAll(connect(port, "127.0.0.1"), "hi")).toBe("ECHO hi");
    } finally {
      host.close();
    }
    // Closed: the port is free again.
    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once("error", reject);
      again.listen(port, "127.0.0.1", () => again.close(() => resolve()));
    });
  });
});

/**
 * Security item 14b: an outward relay's socket is in the command's own
 * scratch directory, which the command can write. The host half, unconfined,
 * must never follow a path the command rewrote — a symlink planted there to
 * a host socket (docker.sock, the ssh-agent, the D-Bus session bus) would
 * hand the command that socket.
 */
describe("14b: the host half of an outward relay follows no path the command can rewrite", () => {
  /** A free loopback port: bind one and let it go. */
  async function freePort(): Promise<number> {
    const probe = createServer();
    const port: number = await new Promise((r) =>
      probe.listen(0, "127.0.0.1", () => r((probe.address() as AddressInfo).port)),
    );
    await new Promise((r) => probe.close(() => r(undefined)));
    return port;
  }

  /** What a host client reads through the port: the host socket's secret, or nothing. */
  function readThrough(port: number): Promise<string> {
    return new Promise((resolve) => {
      let out = "";
      const sock = connect(port, "127.0.0.1");
      sock.on("data", (d) => {
        out += String(d);
      });
      sock.on("close", () => resolve(out));
      sock.on("error", () => resolve(out));
      sock.setTimeout(3000, () => sock.destroy());
    });
  }

  it("refuses a symlink planted where the relay's socket was, and reaches no host socket", async () => {
    const dir = scratch();
    const hostOnly = scratch();
    // Stands in for /var/run/docker.sock: a host socket the sandbox masks.
    const secret = join(hostOnly, "docker.sock");
    await listenUnix(secret, (c) => c.end("HOST-SOCKET"));
    const port = await freePort();
    const plan = relayPlan([port], dir, () => false);
    // The command replaced the relay's socket with a symlink to the host socket.
    symlinkSync(secret, plan[0]?.socket as string);
    const host = startHostRelays(plan);
    try {
      await host.ready;
      expect(await readThrough(port)).toBe("");
    } finally {
      host.close();
    }
  });

  for (const engine of ["native", "srt"] as const)
    it.runIf(linux && (engine === "native" || srtUnavailableReason() === undefined))(
      `a confined command that swaps its relay socket for a symlink reaches no host socket (${engine} engine)`,
      async () => {
        const sandbox = new ProcessSandbox({ engine });
        if (sandbox.confinement === "none") return;
        const work = scratch();
        const hostOnly = scratch();
        const secret = join(hostOnly, "docker.sock");
        await listenUnix(secret, (c) => c.end("HOST-SOCKET"));
        const port = await freePort();
        const child = await sandbox.spawnBackgroundAsync(
          "/bin/sh",
          [
            "-c",
            `sleep 0.5; rm -f "$TMPDIR/.relay-${port}"; ln -s '${secret}' "$TMPDIR/.relay-${port}" && echo planted; sleep 30`,
          ],
          {
            allowedPaths: [work],
            allowNetwork: false,
            timeoutMs: 0,
            cwd: work,
            localPorts: [port],
          },
        );
        expect(child).not.toBeNull();
        try {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(
              () => reject(new Error("the command did not plant the link")),
              15_000,
            );
            child?.stdout.on("data", (d) => {
              if (String(d).includes("planted")) {
                clearTimeout(t);
                resolve();
              }
            });
          });
          expect(await readThrough(port)).toBe("");
        } finally {
          child?.kill("SIGKILL");
          await new Promise((r) => child?.once("exit", r));
        }
      },
    );
});

/**
 * The paths a card's processes take (visual gate, `start_process`, `browse`):
 * a dev server confined with its own named port is reached from the host and
 * from another confined command that names the port. On Linux each runs in
 * its own network namespace, so this crosses two relays.
 */
const srtRuns = platform() === "darwin" || srtUnavailableReason() === undefined;
const ENGINES: SandboxEngine[] = srtRuns ? ["native", "srt"] : ["native"];
describe.each(ENGINES)("DEC-50: a card's dev server across namespaces (%s engine)", (engine) => {
  const sandbox = new ProcessSandbox({ engine });
  const confines = sandbox.confinement !== "none";

  it.runIf(confines)(
    "is reached from the host and from another confined command naming its port",
    async () => {
      const work = scratch();
      const probe = createServer();
      const port: number = await new Promise((r) =>
        probe.listen(0, "127.0.0.1", () => r((probe.address() as AddressInfo).port)),
      );
      await new Promise((r) => probe.close(() => r(undefined)));
      const server = await sandbox.spawnBackgroundAsync(
        process.execPath,
        [
          "-e",
          `require('net').createServer(c=>c.end('DEV')).listen(${port},'127.0.0.1',()=>console.log('up'))`,
        ],
        { allowedPaths: [work], allowNetwork: false, timeoutMs: 0, cwd: work, localPorts: [port] },
      );
      expect(server).not.toBeNull();
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("the dev server did not start")), 15_000);
          server?.stdout.on("data", (d) => {
            if (String(d).includes("up")) {
              clearTimeout(t);
              resolve();
            }
          });
        });
        expect(await readAll(connect(port, "127.0.0.1"))).toBe("DEV");
        const client = await sandbox.execute(
          process.execPath,
          [
            "-e",
            `const s=require('net').connect(${port},'127.0.0.1');s.on('data',d=>{console.log(String(d));process.exit(0)});s.on('error',e=>{console.log('REFUSED '+e.code);process.exit(3)})`,
          ],
          {
            allowedPaths: [work],
            allowNetwork: false,
            timeoutMs: 20_000,
            cwd: work,
            localPorts: [port],
          },
        );
        expect(client.stdout).toContain("DEV");
      } finally {
        server?.kill("SIGKILL");
        await new Promise((r) => server?.once("exit", r));
      }
    },
  );

  it.runIf(confines && linux)(
    "a missing program is still reported as never started when relays wrap it",
    async () => {
      const work = scratch();
      const r = await sandbox.execute("sekhemet-no-such-program", [], {
        allowedPaths: [work],
        allowNetwork: false,
        timeoutMs: 20_000,
        cwd: work,
        localPorts: [9],
      });
      expect(r.exitCode).toBe(127);
      expect(r.notStarted).toBe(true);
    },
  );
});
