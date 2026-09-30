import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessSandbox, type SandboxEngine } from "../src/executor.js";
import { srtReset, withUnixSocketRules } from "../src/srt_engine.js";

/**
 * W1 finding (macOS parity, SEC-23): Seatbelt with the network granted says
 * `(allow network*)`, which includes connecting to any Unix socket by its
 * path, so a sandboxed command could reach the ssh-agent at `$SSH_AUTH_SOCK`
 * (and sign with keys `.ssh`'s read deny hides), a gpg-agent or the Docker
 * daemon. Asserted by trying: a stand-in agent is planted outside the granted
 * paths and the sandboxed command tries to connect to it, with the network
 * off and on, under both engines (DEC-39). An agent socket at a path the
 * environment does not name (launchd's, a Docker socket) is refused the same
 * way. The sockets a card's own tools use — inside its granted paths — and
 * the system's name resolver still connect, or the grant would be broken.
 */
const darwin = platform() === "darwin";
const ENGINES: SandboxEngine[] = ["native", "srt"];

const CONNECT = `const s=require('net').connect(process.argv[1]);
s.on('connect',()=>{console.log('CONNECTED');s.destroy();process.exit(0)});
s.on('error',e=>{console.log('REFUSED '+e.code);process.exit(7)});`;

describe.runIf(darwin).each(ENGINES)("Unix sockets outside the grant (%s engine)", (engine) => {
  const sandbox = new ProcessSandbox({ engine });
  const savedAgent = process.env.SSH_AUTH_SOCK;
  let work: string;
  let agentDir: string;
  let servers: Server[] = [];
  let connections: Record<string, number> = {};

  const listen = async (path: string): Promise<void> => {
    connections[path] = 0;
    const server = createServer((c) => {
      connections[path] = (connections[path] ?? 0) + 1;
      c.end("SSH_AGENT_IDENTITIES\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    servers.push(server);
  };

  const connect = (path: string, allowNetwork: boolean) =>
    sandbox.execute(process.execPath, ["-e", CONNECT, path], {
      allowedPaths: [work],
      allowNetwork,
      timeoutMs: 20_000,
      cwd: work,
    });

  beforeEach(() => {
    // Short paths: a Unix socket's path is limited to 104 bytes on macOS.
    work = mkdtempSync(join(tmpdir(), "sock-work-"));
    agentDir = mkdtempSync(join(tmpdir(), "sock-agent-"));
    servers = [];
    connections = {};
  });

  afterEach(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    if (savedAgent === undefined) Reflect.deleteProperty(process.env, "SSH_AUTH_SOCK");
    else process.env.SSH_AUTH_SOCK = savedAgent;
    for (const dir of [work, agentDir]) rmSync(dir, { recursive: true, force: true });
    if (engine === "srt") await srtReset();
  });

  for (const allowNetwork of [false, true]) {
    it(`cannot reach the ssh-agent at $SSH_AUTH_SOCK (network ${allowNetwork ? "on" : "off"})`, async () => {
      const agent = join(agentDir, "agent.sock");
      await listen(agent);
      process.env.SSH_AUTH_SOCK = agent;
      const result = await connect(agent, allowNetwork);
      expect(result.stdout).not.toContain("CONNECTED");
      expect(result.stdout).toContain("REFUSED");
      // The decisive assertion: the agent never saw a connection.
      expect(connections[agent]).toBe(0);
    });

    it(`cannot reach an agent socket the environment does not name (network ${allowNetwork ? "on" : "off"})`, async () => {
      const unnamed = join(agentDir, "Listeners");
      await listen(unnamed);
      Reflect.deleteProperty(process.env, "SSH_AUTH_SOCK");
      const result = await connect(unnamed, allowNetwork);
      expect(result.stdout).not.toContain("CONNECTED");
      expect(connections[unnamed]).toBe(0);
    });
  }

  it("with the network granted, a socket inside the granted path and the name resolver still connect", async () => {
    const own = join(work, "dev.sock");
    await listen(own);
    const inside = await connect(own, true);
    expect(inside.stdout).toContain("CONNECTED");
    expect(connections[own]).toBe(1);
    // DNS on macOS goes through mDNSResponder's socket.
    const resolver = await connect("/var/run/mDNSResponder", true);
    expect(resolver.stdout).toContain("CONNECTED");
  });
});

describe("srt's open-network profile gets the Unix-socket rules, or the command is refused", () => {
  const profile = (body: string) =>
    `env X=1 /usr/bin/sandbox-exec -p '(version 1)\n${body}' /bin/bash -c 'exec x'`;

  it("places them right after its (allow network*) line, quotes escaped for the shell word", () => {
    const out = withUnixSocketRules(profile("; Network\n(allow network*)\n\n; File read\n"), [
      "/private/tmp/it's-a-root",
    ]);
    const after = out.slice(out.indexOf("(allow network*)"));
    expect(after).toMatch(/^\(allow network\*\)\n;; W1: no Unix socket outside the grant/);
    expect(after).toContain('(deny network-outbound (remote unix-socket (path-regex #"^/")))');
    expect(after).toContain("/private/tmp/it'\\''s-a-root");
    expect(out.indexOf("; File read")).toBeGreaterThan(out.indexOf("unix-socket"));
  });

  it("refuses a profile without that line, or with it twice", () => {
    expect(() => withUnixSocketRules(profile("(deny network*)\n"), ["/w"])).toThrow(
      /open-network line exactly once/,
    );
    expect(() =>
      withUnixSocketRules(profile("\n(allow network*)\n(allow network*)\n"), ["/w"]),
    ).toThrow(/exactly once/);
  });
});
