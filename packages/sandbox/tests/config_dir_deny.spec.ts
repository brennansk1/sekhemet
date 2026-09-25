import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessSandbox, type SandboxEngine } from "../src/executor.js";
import { secretReadDenies } from "../src/seatbelt.js";
import { srtUnavailableReason } from "../src/srt_engine.js";

// security item 10 (SEC-23) with surface NEW-surface-1: the user directory
// moved by `SEKHEMET_CONFIG_DIR` is as unreadable to a card as `~/.sekhemet`.
// Asserted by attempting the read inside the real sandbox.

const srtRuns = platform() === "darwin" || srtUnavailableReason() === undefined;
const ENGINES: SandboxEngine[] = srtRuns ? ["native", "srt"] : ["native"];

describe("SEC-23: the user directory named by SEKHEMET_CONFIG_DIR", () => {
  let config: string;
  let work: string;
  beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), "sek-config-dir-"));
    work = mkdtempSync(join(tmpdir(), "sek-config-work-"));
    mkdirSync(join(config, "repos"), { recursive: true });
    writeFileSync(join(config, "repos", "tokens.json"), "SECRET-CANARY");
    vi.stubEnv("SEKHEMET_CONFIG_DIR", config);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of [config, work]) rmSync(d, { recursive: true, force: true });
  });

  it("is on the deny list only when set", () => {
    expect(secretReadDenies("/home/p")).toContain(config);
    vi.stubEnv("SEKHEMET_CONFIG_DIR", "");
    expect(secretReadDenies("/home/p")).toEqual(
      secretReadDenies("/home/p").filter((p) => p.startsWith("/home/p")),
    );
  });

  it("resolves a relative SEKHEMET_CONFIG_DIR against the working directory and denies it", () => {
    vi.stubEnv("SEKHEMET_CONFIG_DIR", "relative-user-dir");
    expect(secretReadDenies("/home/p")).toContain(resolve("relative-user-dir"));
  });

  it.runIf(platform() === "darwin").each(ENGINES)(
    "a card cannot read it (%s engine)",
    async (engine) => {
      const sandbox = new ProcessSandbox({ engine });
      const target = join(config, "repos", "tokens.json");
      const result = await sandbox.execute(
        process.execPath,
        ["-e", `console.log(require('fs').readFileSync(${JSON.stringify(target)}, 'utf8'))`],
        { allowedPaths: [work], allowNetwork: false, timeoutMs: 20_000, cwd: work },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("CANARY");
    },
  );
});
