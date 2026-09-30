import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, type Server, createServer } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessSandbox, type SandboxEngine } from "../src/executor.js";
import { srtUnavailableReason } from "../src/srt_engine.js";

/**
 * DEC-39: every behavioural case runs against both engines. srt is skipped
 * only where srt itself does not support the platform (it supports macOS and
 * Linux); on macOS a broken srt fails here rather than being skipped.
 */
const srtRuns = platform() === "darwin" || srtUnavailableReason() === undefined;
if (!srtRuns) {
  console.warn(`containment: srt engine skipped on ${platform()}: ${srtUnavailableReason()}`);
}
const ENGINES: SandboxEngine[] = srtRuns ? ["native", "srt"] : ["native"];

/**
 * Where the canary directory lives: on Linux outside the sandbox's private
 * /tmp (item 14), so the sandbox sees it read-only and an escape is refused
 * there rather than aimed at a directory it cannot see at all.
 */
const VISIBLE_BASE = platform() === "linux" && existsSync("/var/tmp") ? "/var/tmp" : tmpdir();

/**
 * Containment is asserted by attempting to escape, not by inspecting a profile.
 *
 * The suite this replaced checked that the Seatbelt profile *string* was
 * well-formed while the executor never applied it — so every assertion passed
 * against a sandbox that confined nothing.
 */
describe.each(ENGINES)("@sekhemet/sandbox containment (%s engine)", (engine) => {
  let work: string;
  let outside: string;
  const sandbox = new ProcessSandbox({ engine });
  const darwin = platform() === "darwin";
  // R9: every confining host runs these (SEC-43), not only macOS.
  const confines = sandbox.confinement !== "none";

  const opts = (): Parameters<ProcessSandbox["execute"]>[2] => ({
    allowedPaths: [work],
    allowNetwork: false,
    timeoutMs: 20_000,
    cwd: work,
  });

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "contain-work-"));
    outside = mkdtempSync(join(VISIBLE_BASE, "contain-out-"));
  });

  afterEach(() => {
    for (const dir of [work, outside]) rmSync(dir, { recursive: true, force: true });
  });

  it("reports which confinement mechanism is actually in force", () => {
    if (engine === "native") {
      expect(["seatbelt", "bubblewrap", "none"]).toContain(sandbox.confinement);
      if (process.platform === "linux") expect(sandbox.confinement).toBe("bubblewrap");
      if (darwin) expect(sandbox.confinement).toBe("seatbelt");
    } else {
      expect(sandbox.engine).toBe("srt");
      expect(sandbox.confinement).toBe("srt");
    }
  });

  it("permits writes inside the allowed path", async () => {
    const result = await sandbox.execute(
      process.execPath,
      ["-e", `require('fs').writeFileSync(process.argv[1] + '/ok.txt', 'x')`, work],
      opts(),
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(work, "ok.txt"))).toBe(true);
  });

  it.runIf(confines)("refuses a write outside the allowed path", async () => {
    const target = join(outside, "escaped.txt");
    const result = await sandbox.execute(
      process.execPath,
      ["-e", `require('fs').writeFileSync(${JSON.stringify(target)}, 'pwned')`],
      opts(),
    );

    expect(result.exitCode).not.toBe(0);
    // Seatbelt denies the write; bubblewrap's read-only root refuses it (item 14).
    expect(result.stderr).toContain(darwin ? "EPERM" : "EROFS");
    // The decisive assertion: nothing was written.
    expect(existsSync(target)).toBe(false);
  });

  it.runIf(confines)("refuses a write to the user's home directory", async () => {
    const target = join(homedir(), ".sekhemet_containment_probe");
    const result = await sandbox.execute(
      process.execPath,
      ["-e", `require('fs').writeFileSync(${JSON.stringify(target)}, 'x')`],
      opts(),
    );
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it.runIf(confines)("blocks network egress when allowNetwork is false", async () => {
    const result = await sandbox.execute(
      process.execPath,
      [
        "-e",
        "fetch('https://example.com').then(()=>{console.log('REACHED');process.exit(0)}).catch(()=>{console.log('BLOCKED');process.exit(7)})",
      ],
      opts(),
    );
    expect(result.stdout).toContain("BLOCKED");
    expect(result.stdout).not.toContain("REACHED");
  });

  // Phase A security review, 2026-09-22 (S1): a worktree's `.git` pointer
  // file says where its git metadata lives, and the harness runs git OUTSIDE
  // the sandbox in that worktree. A Worker able to rewrite the pointer could
  // aim git at metadata it controls. The sandbox must never let it.
  it.runIf(confines)("refuses to rewrite a worktree's .git pointer file", async () => {
    const { writeFileSync: w } = await import("node:fs");
    w(join(work, ".git"), "gitdir: /original/location\n");
    const result = await sandbox.execute(
      process.execPath,
      [
        "-e",
        `require('fs').writeFileSync(process.argv[1] + '/.git', 'gitdir: elsewhere\\n')`,
        work,
      ],
      opts(),
    );
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(work, ".git"), "utf8")).toBe("gitdir: /original/location\n");
  });

  it.runIf(confines)("refuses to write inside a .git directory", async () => {
    const { mkdirSync: md, writeFileSync: w } = await import("node:fs");
    md(join(work, ".git"));
    w(join(work, ".git", "config"), "[core]\n");
    const result = await sandbox.execute(
      process.execPath,
      ["-e", `require('fs').appendFileSync(process.argv[1] + '/.git/config', 'x')`, work],
      opts(),
    );
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(work, ".git", "config"), "utf8")).toBe("[core]\n");
  });

  // Seatbelt refuses the creation. bubblewrap cannot refuse by name; on Linux
  // the preflight names a nested .git before git runs (DEC-49,
  // git_preflight.spec.ts "a nested .git written from inside the sandbox").
  it.runIf(confines && darwin)(
    "refuses to create git metadata at any depth or in any case",
    async () => {
      // Independent review of the S1 fix (G2): only <root>/.git was protected,
      // so a nested sub/.git — which the harness's git would then descend into —
      // could still be created.
      const { mkdirSync: md } = await import("node:fs");
      md(join(work, "sub"));
      for (const target of ["sub/.git", "sub/.GIT", ".Git"]) {
        const result = await sandbox.execute(
          process.execPath,
          [
            "-e",
            `require('fs').writeFileSync(process.argv[1] + '/' + process.argv[2], 'gitdir: x')`,
            work,
            target,
          ],
          opts(),
        );
        expect(result.exitCode, target).not.toBe(0);
        expect(existsSync(join(work, target)), target).toBe(false);
      }
    },
  );

  // S2: a worktree's node_modules is a link into the user's main checkout.
  // Granting writes to its target let a card change dependencies the user
  // later runs unconfined. Toolchains need their cache directories, nothing
  // more.
  // Item 24 (B1): caches live in each worktree's own node_modules
  // (dependency_trees.spec.ts), so the linked main tree is not writable at all.
  it.runIf(confines)(
    "refuses to modify linked dependencies or to write caches into them",
    async () => {
      const { mkdirSync: md, symlinkSync, writeFileSync: w } = await import("node:fs");
      const deps = join(outside, "node_modules");
      md(join(deps, "dep"), { recursive: true });
      w(join(deps, "dep", "index.js"), "module.exports = 1;\n");
      symlinkSync(deps, join(work, "node_modules"));
      const tamper = await sandbox.execute(
        process.execPath,
        [
          "-e",
          `require('fs').appendFileSync(process.argv[1] + '/node_modules/dep/index.js', 'x')`,
          work,
        ],
        opts(),
      );
      expect(tamper.exitCode).not.toBe(0);
      expect(readFileSync(join(deps, "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
      const cache = await sandbox.execute(
        process.execPath,
        [
          "-e",
          `const f=require('fs');f.mkdirSync(process.argv[1]+'/node_modules/.vite-temp',{recursive:true});f.writeFileSync(process.argv[1]+'/node_modules/.vite-temp/x','ok')`,
          work,
        ],
        opts(),
      );
      expect(cache.exitCode).not.toBe(0);
      expect(existsSync(join(deps, ".vite-temp", "x"))).toBe(false);
    },
  );

  it("does not leak parent environment variables to the child", async () => {
    // The parent holds model endpoints and credentials; a sandbox that inherits
    // the full environment hands them to any command the agent chooses to run.
    process.env.SEKHEMET_FAKE_SECRET = "super-secret-value";
    try {
      const result = await sandbox.execute(
        process.execPath,
        ["-e", "console.log(process.env.SEKHEMET_FAKE_SECRET ?? 'ABSENT')"],
        opts(),
      );
      expect(result.stdout.trim()).toBe("ABSENT");
    } finally {
      process.env.SEKHEMET_FAKE_SECRET = undefined;
    }
  });

  it("passes explicitly provided environment variables through", async () => {
    const result = await sandbox.execute(
      process.execPath,
      ["-e", "console.log(process.env.EXPLICIT ?? 'ABSENT')"],
      { ...opts(), env: { EXPLICIT: "yes" } },
    );
    expect(result.stdout.trim()).toBe("yes");
  });

  it("kills a process that ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await sandbox.execute(
      process.execPath,
      [
        "-e",
        // Trap SIGTERM and refuse to exit: only an uncatchable SIGKILL ends this.
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 50);",
      ],
      { ...opts(), timeoutMs: 800 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // SIGTERM plus the 500ms grace, with headroom for process teardown.
    expect(Date.now() - started).toBeLessThan(6000);
  });

  // S7 under confinement: the sampled tree is the confined command's.
  it("kills a confined command tree past its memory cap", async () => {
    const result = await sandbox.execute(
      process.execPath,
      ["-e", "const a=[]; for(;;){ a.push(Buffer.alloc(8*1024*1024, 1)); }"],
      { ...opts(), maxMemoryBytes: 200 * 1024 * 1024 },
    );
    expect(result.oomKilled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toMatch(/over its 200 MB memory cap/);
  });

  it("reports a non-zero exit code and captures stderr", async () => {
    const result = await sandbox.execute(
      process.execPath,
      ["-e", "console.error('boom'); process.exit(3)"],
      opts(),
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
    expect(result.timedOut).toBe(false);
  });

  it("returns 127 for a command that does not exist", async () => {
    const result = await sandbox.execute("definitely-not-a-real-binary-xyz", [], opts());
    expect(result.exitCode).toBe(127);
  });

  it("refuses to run unconfined when requireConfinement is set and none is available", async () => {
    const strict = new ProcessSandbox({
      engine,
      requireConfinement: true,
      disableConfinement: true,
    });
    const result = await strict.execute(process.execPath, ["-e", "console.log('ran')"], opts());

    // Failing closed matters: degrading silently to an unconfined run is how a
    // sandbox stops being one.
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("Refusing to execute");
    expect(result.stdout).not.toContain("ran");
    expect(strict.requiresConfinement).toBe(true);
    expect(strict.confinement).toBe("none");
    // S4 (wave 2): a default sandbox fails closed; opting out is explicit.
    expect(new ProcessSandbox().requiresConfinement).toBe(true);
    expect(new ProcessSandbox({ disableConfinement: true }).requiresConfinement).toBe(false);
  });

  it("truncates output beyond the buffer cap rather than growing without bound", async () => {
    const result = await sandbox.execute(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(200000))"],
      { ...opts(), maxBufferBytes: 4096 },
    );
    expect(result.stdout).toContain("output truncated");
    expect(result.stdout.length).toBeLessThan(200_000);
  });

  it.runIf(confines)("allows reads of system files the toolchain needs", async () => {
    // Confinement restricts writes and egress; a profile that also blocked
    // reads would break every compiler rather than improve safety.
    const result = await sandbox.execute(
      process.execPath,
      ["-e", "console.log(require('fs').existsSync('/usr/bin/env'))"],
      opts(),
    );
    expect(result.stdout.trim()).toBe("true");
  });

  it("gives the command its private scratch directory as TMPDIR", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "contain-scratch-"));
    try {
      const result = await sandbox.execute(
        process.execPath,
        [
          "-e",
          "const f=require('fs');f.writeFileSync(require('path').join(process.env.TMPDIR,'t'),'x');console.log(process.env.TMPDIR)",
        ],
        { ...opts(), scratchDir: scratch },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(scratch);
      expect(readFileSync(join(scratch, "t"), "utf8")).toBe("x");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  const expectHomeVisible = async (
    home: string,
    over: Partial<Parameters<ProcessSandbox["execute"]>[2]> = {},
  ): Promise<void> => {
    const seen = await sandbox.execute(
      process.execPath,
      [
        "-e",
        `console.log(require('fs').readFileSync(${JSON.stringify(join(home, "visible.txt"))}, 'utf8'))`,
      ],
      { ...opts(), ...over },
    );
    expect(seen.stdout.trim(), "the test home is visible inside the sandbox").toBe("VISIBLE");
  };

  // srt grants writes to ~/.npm/_logs, ~/.claude/debug and /tmp/claude on its
  // own; the native engine grants none of them, so neither may the srt one.
  it.runIf(confines)("refuses writes to srt's convenience directories", async () => {
    const home = mkdtempSync(join(VISIBLE_BASE, "contain-home-"));
    writeFileSync(join(home, "visible.txt"), "VISIBLE");
    vi.stubEnv("HOME", home);
    try {
      // Control: the home is visible inside the sandbox, so the refusals
      // below are the sandbox's, not a missing directory's (R9 review).
      await expectHomeVisible(home);
      for (const rel of [".npm/_logs", ".claude/debug"]) {
        mkdirSync(join(home, rel), { recursive: true });
        const target = join(home, rel, "canary");
        const result = await sandbox.execute(
          process.execPath,
          ["-e", `require('fs').writeFileSync(${JSON.stringify(target)}, 'x')`],
          opts(),
        );
        expect(result.exitCode, rel).not.toBe(0);
        expect(existsSync(target), rel).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  // security.md item 10, SEC-23: both engines deny these reads (the native
  // Seatbelt profile since B3.3; srt through its denyRead list).
  it.runIf(confines)("refuses reads of the user's secrets and the project ledger", async () => {
    const home = mkdtempSync(join(VISIBLE_BASE, "contain-home-"));
    writeFileSync(join(home, "visible.txt"), "VISIBLE");
    vi.stubEnv("HOME", home);
    const project = join(outside, "project");
    const tree = join(project, ".sekhemet", "worktrees", "card-1");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(project, ".sekhemet", "events.db"), "LEDGER-CANARY");
    const secrets = [
      ".ssh/id_ed25519",
      ".aws/credentials",
      ".npmrc",
      ".netrc",
      ".config/gh/hosts.yml",
      ".sekhemet/config.toml",
      // The integration tokens' file (SEC-27).
      ".config/sekhemet/repos/project-0123.json",
    ];
    for (const rel of secrets) {
      mkdirSync(dirname(join(home, rel)), { recursive: true });
      writeFileSync(join(home, rel), "SECRET-CANARY");
    }
    try {
      for (const target of [
        ...secrets.map((rel) => join(home, rel)),
        join(project, ".sekhemet", "events.db"),
      ]) {
        const result = await sandbox.execute(
          process.execPath,
          ["-e", `console.log(require('fs').readFileSync(${JSON.stringify(target)}, 'utf8'))`],
          { ...opts(), allowedPaths: [tree], cwd: tree },
        );
        // bubblewrap masks a file with /dev/null: it reads empty and exits 0
        // (security item 14a); Seatbelt refuses the read.
        if (darwin) expect(result.exitCode, target).not.toBe(0);
        expect(result.stdout, target).not.toContain("CANARY");
      }
      await expectHomeVisible(home, { allowedPaths: [tree], cwd: tree });
      // The worktree itself stays readable and writable.
      const own = await sandbox.execute(
        process.execPath,
        [
          "-e",
          "require('fs').writeFileSync('own.txt','ok');console.log(require('fs').readFileSync('own.txt','utf8'))",
        ],
        { ...opts(), allowedPaths: [tree], cwd: tree },
      );
      expect(own.stdout.trim()).toBe("ok");
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  // S5: with an egress proxy, its loopback port is the only way out; L23: a
  // card's own ports are reachable.
  it.runIf(confines)("reaches the egress proxy port and the card's own ports only", async () => {
    const listen = async (): Promise<{ server: Server; port: number; hits: () => number }> => {
      let hits = 0;
      const server = createServer((c) => {
        hits++;
        c.end("PONG");
      });
      const port = await new Promise<number>((r) =>
        server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)),
      );
      return { server, port, hits: () => hits };
    };
    const proxy = await listen();
    const other = await listen();
    const own = await listen();
    const probe = (port: number): string[] => [
      "-e",
      `const s=require('net').connect(${port},'127.0.0.1');s.on('data',d=>{console.log(String(d));process.exit(0)});s.on('error',e=>{console.log('REFUSED '+e.code);process.exit(3)})`,
    ];
    try {
      const o = { ...opts(), egressProxyPort: proxy.port, localPorts: [own.port] };
      // The proxy at the address the command is given: its own port, except
      // under srt on Linux, whose relay inside its network namespace leads to
      // it (srtProxyUrl). Either way the connection must arrive at the proxy.
      const viaProxy = await sandbox.execute(
        process.execPath,
        [
          "-e",
          `const s=require('net').connect(Number(new URL(process.env.HTTP_PROXY).port),'127.0.0.1');s.on('data',d=>{console.log(String(d));process.exit(0)});s.on('error',e=>{console.log('REFUSED '+e.code);process.exit(3)})`,
        ],
        o,
      );
      expect(viaProxy.stdout).toContain("PONG");
      expect(proxy.hits()).toBe(1);
      const ownPort = await sandbox.execute(process.execPath, probe(own.port), o);
      expect(ownPort.stdout).toContain("PONG");
      const noLocal = await sandbox.execute(process.execPath, probe(other.port), {
        ...opts(),
        egressProxyPort: proxy.port,
      });
      expect(noLocal.stdout).toContain("REFUSED");
      if (engine === "native") {
        // srt cannot scope local binding to ports: with any localPorts, every
        // loopback port is reachable (reported gap, DEC-39).
        const otherPort = await sandbox.execute(process.execPath, probe(other.port), o);
        expect(otherPort.stdout).toContain("REFUSED");
      }
    } finally {
      for (const s of [proxy, other, own]) s.server.close();
    }
  });
});
