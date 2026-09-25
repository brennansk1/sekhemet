import { readFileSync, readdirSync } from "node:fs";
import { platform } from "node:os";
import { join, relative } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessSandbox, confinedSandbox } from "../src/index.js";
import { srtReset } from "../src/srt_engine.js";

/** S3b: every Worker command and gate fails closed (SEC-20, SEC-21). */
const ROOT = join(import.meta.dirname, "..", "..", "..");

function productSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name === "dist") return [];
      const p = join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.ts$/.test(e.name) ? [p] : [];
    });
  return ["packages", "apps"].flatMap((top) =>
    readdirSync(join(ROOT, top), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        try {
          return walk(join(ROOT, top, d.name, "src"));
        } catch {
          return [];
        }
      }),
  );
}

describe("fail closed (S3b)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a gate or Worker sandbox requires confinement unless the owner opts out", () => {
    vi.stubEnv("SEKHEMET_ALLOW_UNCONFINED", undefined);
    expect(confinedSandbox(false).requiresConfinement).toBe(true);
    vi.stubEnv("SEKHEMET_ALLOW_UNCONFINED", "1");
    expect(confinedSandbox(false).requiresConfinement).toBe(false);
    // Restricted mode ignores the opt-out.
    expect(confinedSandbox(true).requiresConfinement).toBe(true);
  });

  it("refuses with exit code 126 and names the fix when nothing can confine (SEC-20)", async () => {
    const unconfinable = new ProcessSandbox({ disableConfinement: true, requireConfinement: true });
    const r = await unconfinable.execute("node", ["-e", "process.exit(0)"], {
      cwd: ROOT,
      allowedPaths: [],
      allowNetwork: false,
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(126);
    expect(r.stderr).toMatch(/bubblewrap/);
    expect(r.stderr).toMatch(/SEKHEMET_ALLOW_UNCONFINED=1/);
  });

  it("no product code builds a sandbox that opts out of confinement", () => {
    const optOut = /new ProcessSandbox\(\s*\{[^}]*requireConfinement:\s*(?!true\b)/;
    const offenders = productSources()
      .filter((f) => optOut.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("selects the engine from SEKHEMET_SANDBOX_ENGINE, native by default (DEC-39)", () => {
    vi.stubEnv("SEKHEMET_SANDBOX_ENGINE", undefined);
    expect(new ProcessSandbox().engine).toBe("native");
    vi.stubEnv("SEKHEMET_SANDBOX_ENGINE", "srt");
    const box = new ProcessSandbox();
    expect(box.engine).toBe("srt");
    if (platform() === "darwin") expect(box.confinement).toBe("srt");
    expect(new ProcessSandbox({ engine: "native" }).engine).toBe("native");
  });

  it.runIf(platform() === "darwin")(
    "refuses with 126 and names the fix when srt cannot initialise (SEC-20)",
    async () => {
      const init = vi
        .spyOn(SandboxManager, "initialize")
        .mockRejectedValue(new Error("Sandbox dependencies not available: bwrap not found"));
      const opts = {
        cwd: ROOT,
        allowedPaths: [],
        allowNetwork: false,
        timeoutMs: 5_000,
        // A posture no earlier command used, so srt must initialise for it.
        egressProxyPort: 1,
      };
      try {
        await srtReset();
        const r = await new ProcessSandbox({ engine: "srt" }).execute(
          "node",
          ["-e", "console.log('ran')"],
          opts,
        );
        expect(r.exitCode).toBe(126);
        expect(r.stdout).not.toContain("ran");
        expect(r.stderr).toMatch(/srt failed: Sandbox dependencies not available/);
        expect(r.stderr).toMatch(/SEKHEMET_SANDBOX_ENGINE=native/);
        expect(r.stderr).toMatch(/SEKHEMET_ALLOW_UNCONFINED=1/);
        // The explicit opt-out behaves as today: it runs, unconfined.
        const optedOut = await new ProcessSandbox({
          engine: "srt",
          requireConfinement: false,
        }).execute("node", ["-e", "console.log('ran')"], opts);
        expect(optedOut.stdout).toContain("ran");
      } finally {
        init.mockRestore();
        await srtReset();
      }
      // A later command initialises srt again and runs confined.
      const again = await new ProcessSandbox({ engine: "srt" }).execute(
        "node",
        ["-e", "console.log('ran')"],
        { cwd: ROOT, allowedPaths: [], allowNetwork: false, timeoutMs: 5_000 },
      );
      expect(again.exitCode).toBe(0);
    },
  );
});
