import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSandbox, resolveProgram } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProbe } from "../src/claims.js";

// One runner for the claim gate and the Researcher's probe (gates GT-N5-3,
// design-stage DS-N9-17): Node or Python code, confined, a fresh scratch
// directory as the only writable root and working directory, the harness's
// read-only grants, no network. Real subprocesses under the real sandbox.

const confines = new ProcessSandbox({ engine: "native" }).confinement !== "none";
const python = resolveProgram("python3");

describe.runIf(confines)("runProbe (GT-N5-3, DS-N9-17)", () => {
  let repo: string;
  let server: Server | undefined;
  let connections = 0;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "probe-repo-"));
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib", "answer.js"), "module.exports = { answer: () => 42 };\n");
    connections = 0;
  });
  afterEach(async () => {
    rmSync(repo, { recursive: true, force: true });
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  const listen = () =>
    new Promise<number>((resolve) => {
      server = createServer((s) => {
        connections++;
        s.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const a = server?.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      });
    });

  it("runs Node code that reads a read-only root, and reports exit 0 with its output", async () => {
    const r = await runProbe({
      language: "node",
      code: `const m = require(${JSON.stringify(join(repo, "lib", "answer.js"))}); console.log("answer", m.answer())`,
      readOnly: [repo],
      timeoutMs: 20_000,
    });
    expect(r).toMatchObject({ ok: true, exitCode: 0, timedOut: false, detail: "exit 0" });
    expect(r.stdout.trim()).toBe("answer 42");
  }, 30_000);

  it.runIf(python !== undefined)(
    "runs Python code isolated (-I) and reports a failing exit",
    async () => {
      const r = await runProbe({
        language: "python",
        code: "import sys\nprint(sys.flags.isolated)\nsys.exit(3)",
        timeoutMs: 20_000,
      });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(3);
      expect(r.stdout.trim()).toBe("1");
      expect(r.detail).toMatch(/^exit 3\b/);
    },
    30_000,
  );

  it("refuses a write into a read-only root: the file stays absent and the run fails", async () => {
    const marker = join(repo, "written-by-probe");
    const r = await runProbe({
      language: "node",
      code: `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
      readOnly: [repo],
      timeoutMs: 20_000,
    });
    expect(existsSync(marker)).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^exit [1-9]/);
    expect(r.stderr).toMatch(/EPERM|EROFS/);
  }, 30_000);

  it("gives no network: a connection to a loopback listener fails and never arrives", async () => {
    const port = await listen();
    const r = await runProbe({
      language: "node",
      code: `const s = require("net").connect(${port}, "127.0.0.1"); s.on("connect", () => process.exit(0)); s.on("error", (e) => { console.error(e.code); process.exit(5) });`,
      timeoutMs: 20_000,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(5);
    expect(connections).toBe(0);
  }, 30_000);

  it("is not started for a language with no trusted interpreter", async () => {
    const r = await runProbe({ language: "ruby" as "node", code: "exit 0", timeoutMs: 5_000 });
    expect(r).toMatchObject({ ok: false, notStarted: true, detail: "no interpreter for ruby" });
  });

  it("kills a probe at its time limit", async () => {
    const started = Date.now();
    const r = await runProbe({ language: "node", code: "for (;;) {}", timeoutMs: 1_500 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
