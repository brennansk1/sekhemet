import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaimGate } from "@sekhemet/gates";
import { ProcessSandbox, resolveProgram } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_LIMITS, type ProbeRequest, runResearchProbe } from "../src/research/probe.js";

// The Researcher's probe (design-stage DS-N9-17, DS-N9-18): at most 30 lines
// of Node or Python run in the claim gate's sandbox — no network, a fresh
// scratch directory the only writable root, the repository and its installed
// dependencies read-only — against real packages laid out on disk. One that
// exits 0 becomes an executable claim the claim gate re-runs unchanged.

const confines = new ProcessSandbox({ engine: "native" }).confinement !== "none";
const python = resolveProgram("python3");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A project with a CommonJS package and an ESM-only package (an `import`-only export map). */
function npmProject(): string {
  const repo = mkdtempSync(join(tmpdir(), "probe-npm-"));
  write(
    join(repo, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      dependencies: { "cjs-calc": "1.0.0", "esm-only": "2.1.0" },
    }),
  );
  const nm = join(repo, "node_modules");
  write(
    join(nm, "cjs-calc", "package.json"),
    JSON.stringify({ name: "cjs-calc", version: "1.0.0", main: "lib/index.js" }),
  );
  write(join(nm, "cjs-calc", "lib", "index.js"), "exports.add = (a, b) => a + b;\n");
  write(
    join(nm, "esm-only", "package.json"),
    JSON.stringify({
      name: "esm-only",
      version: "2.1.0",
      type: "module",
      exports: { ".": { import: "./index.js" } },
    }),
  );
  write(join(nm, "esm-only", "index.js"), "export const twice = (n) => n * 2;\n");
  return repo;
}

/** A project with a virtual environment's site-packages holding one real distribution. */
function pythonProject(): { repo: string; site: string } {
  const repo = mkdtempSync(join(tmpdir(), "probe-py-"));
  const site = join(repo, ".venv", "lib", "python3.9", "site-packages");
  write(join(site, "fixpkg", "__init__.py"), 'def greet(name):\n    return "hi " + name\n');
  write(
    join(site, "fixpkg-1.2.0.dist-info", "METADATA"),
    "Metadata-Version: 2.1\nName: fixpkg\nVersion: 1.2.0\n",
  );
  write(join(site, "fixpkg-1.2.0.dist-info", "RECORD"), "fixpkg/__init__.py,,\n");
  write(join(repo, "requirements.txt"), "fixpkg==1.2.0\n");
  return { repo, site };
}

const npmReq = (code: string, overrides: Partial<ProbeRequest> = {}): ProbeRequest => ({
  language: "node",
  code,
  target: { eco: "npm", name: "esm-only", version: "2.1.0" },
  statement: "twice doubles its argument",
  ...overrides,
});

describe("probe budget and language, checked before anything runs (DS-N9-17)", () => {
  const ctx = { repoPath: tmpdir(), runtime: { readRoots: [] } };

  it("accepts 30 lines and refuses 31, unrun", async () => {
    const lines = (n: number) =>
      Array.from({ length: n }, () => "process.exitCode = 0;").join("\n");
    expect(PROBE_LIMITS).toMatchObject({ maxLines: 30, maxChars: 2000 });
    const refused = await runResearchProbe(npmReq(lines(31)), ctx);
    expect(refused).toEqual({
      status: "refused",
      refusal: "too_many_lines",
      limit: 30,
      actual: 31,
    });
    expect("result" in refused).toBe(false);
  });

  it("refuses more than 2,000 characters", async () => {
    const r = await runResearchProbe(npmReq(`// ${"x".repeat(2000)}`), ctx);
    expect(r).toMatchObject({ status: "refused", refusal: "too_many_chars", limit: 2000 });
  });

  it("refuses a language other than node or python, and one that does not match the package's ecosystem", async () => {
    expect(await runResearchProbe(npmReq("puts 1", { language: "ruby" }), ctx)).toMatchObject({
      status: "refused",
      refusal: "language",
    });
    expect(await runResearchProbe(npmReq("print(1)", { language: "python" }), ctx)).toMatchObject({
      status: "refused",
      refusal: "language_mismatch",
    });
  });

  it("documents a Go or Rust question as not reproduced, and the claim gate accepts the reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "probe-go-"));
    try {
      const go = await runResearchProbe(
        {
          language: "go",
          code: "package main",
          target: { eco: "go", name: "github.com/spf13/cobra", version: "v1.8.0" },
          statement: "Command has a RunE field",
        },
        ctx,
      );
      expect(go.status).toBe("documented");
      if (go.status !== "documented") return;
      expect(go.claim.unreproducible).toBe(
        "documented, not reproduced: no probe runner for go in this version",
      );
      const rust = await runResearchProbe(
        {
          language: "rust",
          code: "fn main() {}",
          target: { eco: "rust", name: "serde", version: "1.0.200" },
          statement: "Serialize is a trait",
        },
        ctx,
      );
      expect(rust).toMatchObject({
        status: "documented",
        claim: {
          unreproducible: "documented, not reproduced: no probe runner for rust in this version",
        },
      });
      write(join(root, "claims.json"), JSON.stringify({ claims: [go.claim] }));
      const gate = await runClaimGate({
        root,
        report: join(root, "claims.json"),
        timeoutMs: 5_000,
      });
      expect(gate.failures).toEqual([]);
      expect(gate.verdicts).toEqual([
        { id: go.claim.id, verdict: "unreproducible", reason: go.claim.unreproducible },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.runIf(confines)(
  "probes run confined against the installed packages (DS-N9-17, DS-N9-18)",
  () => {
    let repo: string;
    let server: Server | undefined;
    let connections = 0;
    beforeEach(() => {
      repo = npmProject();
      connections = 0;
    });
    afterEach(async () => {
      rmSync(repo, { recursive: true, force: true });
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = undefined;
    });
    const npmCtx = () => ({
      repoPath: repo,
      runtime: { interpreter: "node", readRoots: [join(repo, "node_modules")] },
    });

    it("runs a probe that loads a CommonJS and an ESM-only package, records it, and the claim gate re-runs it unchanged", async () => {
      const code = [
        'const { add } = require("cjs-calc");',
        'const { twice } = await load("esm-only");',
        "if (add(2, 3) !== 5 || twice(add(1, 1)) !== 4) process.exit(2);",
        'console.log("ok");',
      ].join("\n");
      const r = await runResearchProbe(npmReq(code), npmCtx());
      expect(r.status).toBe("ran");
      if (r.status !== "ran") return;
      expect(r.result).toMatchObject({
        language: "node",
        exitCode: 0,
        target: "esm-only@2.1.0",
        timedOut: false,
      });
      expect(r.result.output.trim()).toBe("ok");
      expect(r.claim).toBeDefined();
      if (!r.claim?.reproduce) return;
      expect(r.claim).toMatchObject({
        kind: "executable",
        text: "twice doubles its argument (reproduced at esm-only@2.1.0)",
      });
      expect(r.claim.reproduce.code).toContain(code);
      expect(r.result.codeSha256).toBe(sha(r.claim.reproduce.code));

      write(
        join(repo, ".sekhemet", "research", "r1.claims.json"),
        JSON.stringify({ claims: [r.claim] }),
      );
      const gate = await runClaimGate({
        root: repo,
        report: join(repo, ".sekhemet", "research", "r1.claims.json"),
        timeoutMs: 20_000,
      });
      expect(gate.failures).toEqual([]);
      expect(gate.verdicts).toEqual([{ id: r.claim.id, verdict: "reproduced" }]);
    }, 60_000);

    it("keeps the last 1,000 characters of output", async () => {
      const r = await runResearchProbe(
        npmReq('process.stdout.write("a".repeat(3000) + "END\\n");'),
        npmCtx(),
      );
      expect(r.status).toBe("ran");
      if (r.status !== "ran") return;
      expect(r.result.output.length).toBeLessThanOrEqual(1000);
      expect(r.result.output.trimEnd().endsWith("aEND")).toBe(true);
    }, 30_000);

    it("denies a write into the repository: the file stays absent and no claim is made", async () => {
      const marker = join(repo, "written-by-probe");
      const r = await runResearchProbe(
        npmReq(`require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`),
        npmCtx(),
      );
      expect(existsSync(marker)).toBe(false);
      expect(r.status).toBe("ran");
      if (r.status !== "ran") return;
      expect(r.result.exitCode).not.toBe(0);
      expect(r.result.output).toMatch(/EPERM|EROFS/);
      expect(r.claim).toBeUndefined();
    }, 30_000);

    it("fails a probe that opens a socket, and the connection never arrives", async () => {
      const port = await new Promise<number>((resolve) => {
        server = createServer((s) => {
          connections++;
          s.end();
        });
        server.listen(0, "127.0.0.1", () => {
          const a = server?.address();
          resolve(typeof a === "object" && a ? a.port : 0);
        });
      });
      const r = await runResearchProbe(
        npmReq(
          `await new Promise((ok, no) => require("net").connect(${port}, "127.0.0.1").on("connect", ok).on("error", no));`,
        ),
        npmCtx(),
      );
      expect(r.status).toBe("ran");
      if (r.status !== "ran") return;
      expect(r.result.exitCode).not.toBe(0);
      expect(r.claim).toBeUndefined();
      expect(connections).toBe(0);
    }, 30_000);

    it("kills a probe at the 10 s limit", async () => {
      expect(PROBE_LIMITS.timeoutMs).toBe(10_000);
      const started = Date.now();
      const r = await runResearchProbe(npmReq("for (;;) {}"), npmCtx());
      expect(r.status).toBe("ran");
      if (r.status !== "ran") return;
      expect(r.result.timedOut).toBe(true);
      expect(r.claim).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(20_000);
    }, 40_000);
  },
);

describe.runIf(confines && python !== undefined)("a Python probe (DS-N9-17)", () => {
  let project: { repo: string; site: string };
  beforeEach(() => {
    project = pythonProject();
  });
  afterEach(() => rmSync(project.repo, { recursive: true, force: true }));

  const pyReq = (code: string): ProbeRequest => ({
    language: "python",
    code,
    target: { eco: "python", name: "fixpkg", version: "1.2.0" },
    statement: "greet prefixes hi",
  });
  const ctx = () => ({
    repoPath: project.repo,
    runtime: { interpreter: python as string, readRoots: [project.site] },
  });

  it("imports the installed distribution, writes no bytecode, and the claim gate re-runs it", async () => {
    const r = await runResearchProbe(
      pyReq(
        'import fixpkg, sys\nassert fixpkg.greet("x") == "hi x"\nassert sys.flags.isolated == 1\nprint("ok")',
      ),
      ctx(),
    );
    expect(r.status).toBe("ran");
    if (r.status !== "ran") return;
    expect(r.result).toMatchObject({ language: "python", exitCode: 0, target: "fixpkg@1.2.0" });
    expect(existsSync(join(project.site, "fixpkg", "__pycache__"))).toBe(false);
    expect(r.claim?.reproduce?.language).toBe("python");
    write(join(project.repo, "claims.json"), JSON.stringify({ claims: [r.claim] }));
    const gate = await runClaimGate({
      root: project.repo,
      report: join(project.repo, "claims.json"),
      timeoutMs: 20_000,
    });
    expect(gate.verdicts).toEqual([{ id: r.claim?.id, verdict: "reproduced" }]);
  }, 60_000);

  it("fails a Python probe that opens a socket, and the connection never arrives", async () => {
    let connections = 0;
    const server = createServer((s) => {
      connections++;
      s.end();
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      }),
    );
    try {
      const r = await runResearchProbe(
        pyReq(`import socket\nsocket.create_connection(("127.0.0.1", ${port}), timeout=2)`),
        ctx(),
      );
      expect(r.status).toBe("ran");
      if (r.status !== "ran") return;
      expect(r.result.exitCode).not.toBe(0);
      expect(r.claim).toBeUndefined();
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

// DS-N9-17, security item 8c: a research packet's probe — the Researcher
// that wrote it also holds the web — reads the installed dependencies and
// nothing else of the repository.
describe.runIf(confines)(
  "a packet probe sees the dependencies, never the project (DS-N9-17)",
  () => {
    let repo: string;
    beforeEach(() => {
      repo = npmProject();
      write(join(repo, "src", "secret.ts"), "export const key = 'SECRET_FROM_PROJECT';\n");
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("loads the packages and cannot read the project's source", async () => {
      const code = [
        'const { add } = require("cjs-calc");',
        'const { twice } = await load("esm-only");',
        "let seen = 'unread';",
        `try { seen = require("node:fs").readFileSync(${JSON.stringify(join(repo, "src", "secret.ts"))}, "utf8"); } catch (e) { seen = e.code; }`,
        "console.log(add(2, 3), twice(2), seen);",
      ].join("\n");
      const r = await runResearchProbe(npmReq(code), {
        repoPath: repo,
        runtime: { interpreter: "node", readRoots: [join(repo, "node_modules")] },
        scope: "dependencies",
      });
      expect(r.status).toBe("ran");
      if (r.status !== "ran") return;
      expect(r.result.output).not.toContain("SECRET_FROM_PROJECT");
      expect(r.result.output.trim()).toMatch(/^5 4 (EPERM|EACCES|ENOENT)$/);
      expect(r.result.exitCode).toBe(0);
    }, 60_000);
  },
);

describe.runIf(confines && python !== undefined)(
  "a packet probe in a real virtual environment (DS-N9-17)",
  () => {
    let repo: string;
    let site: string;
    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), "probe-venv-"));
      execFileSync(python as string, ["-m", "venv", "--without-pip", join(repo, ".venv")]);
      const lib = join(repo, ".venv", "lib");
      site = join(lib, readdirSync(lib)[0] as string, "site-packages");
      write(join(site, "fixpkg", "__init__.py"), 'def greet(name):\n    return "hi " + name\n');
      write(join(repo, "src", "secret.py"), "KEY = 'SECRET_FROM_PROJECT'\n");
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("runs the project's interpreter, imports the distribution and cannot read the project", async () => {
      const r = await runResearchProbe(
        {
          language: "python",
          code: [
            "import fixpkg",
            "try:",
            `    seen = open(${JSON.stringify(join(repo, "src", "secret.py"))}).read()`,
            "except OSError as e:",
            "    seen = type(e).__name__",
            'print(fixpkg.greet("x"), seen)',
          ].join("\n"),
          target: { eco: "python", name: "fixpkg", version: "1.2.0" },
          statement: "greet prefixes hi",
        },
        {
          repoPath: repo,
          runtime: {
            interpreter: join(repo, ".venv", "bin", "python3"),
            readRoots: [site],
            envRoots: [join(repo, ".venv")],
          },
          scope: "dependencies",
        },
      );
      expect(r.status).toBe("ran");
      if (r.status !== "ran") return;
      expect(r.result.output).not.toContain("SECRET_FROM_PROJECT");
      expect(r.result.output.trim()).toMatch(/^hi x (PermissionError|FileNotFoundError)$/);
    }, 60_000);
  },
);
