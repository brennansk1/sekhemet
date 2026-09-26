import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseVisualConfig, runVisualGates } from "../src/visual.js";

/** The environment a confined process may see (security item 6), plus what the gate names. */
const ALLOWED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "LOGSEQ_TEST",
  "NODE_ENV",
  "CI",
  "PORT",
  // Set by the OS for any process on macOS, not passed by the harness.
  "__CF_USER_TEXT_ENCODING",
]);

describe("SEC-16: the visual gate's dev server and browser run confined", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "visual-root-")));
    outside = mkdtempSync(join(tmpdir(), "visual-out-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
  });

  it.runIf(platform() === "darwin" && findChrome() !== undefined)(
    "a start script writing outside the worktree leaves no marker and sees only allowlisted variables",
    async () => {
      vi.stubEnv("SEKHEMET_CANARY_API_KEY", "sk-canary");
      const marker = join(outside, "marker");
      writeFileSync(
        join(root, "server.cjs"),
        `const fs = require("fs"), http = require("http");
try { fs.writeFileSync(${JSON.stringify(marker)}, "escaped") } catch {}
fs.writeFileSync("env.json", JSON.stringify(Object.keys(process.env)));
http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end('<!doctype html><html lang="en"><head><title>t</title></head><body><div id="box">ok</div></body></html>') })
  .listen(Number(process.env.PORT), "127.0.0.1");
`,
      );
      const config = parseVisualConfig({
        url: "http://127.0.0.1:{port}/",
        start: [process.execPath, "server.cjs"],
        viewports: [1280],
        check: [{ selector: "#box", visible: true }],
      }) as NonNullable<ReturnType<typeof parseVisualConfig>>;
      const r = await runVisualGates({ root, config, stateDir: join(root, ".sekhemet") });
      // The server ran (it wrote inside the worktree) and the page was checked.
      expect(existsSync(join(root, "env.json"))).toBe(true);
      // Every check ran; only the DOM check has nothing declared to judge (GT-N4-6).
      expect(r.outcomes.filter((o) => o.skipped).map((o) => o.gate)).toEqual(["visual-dom"]);
      expect(r.failures.filter((f) => f.gate === "visual-layout")).toEqual([]);
      expect(existsSync(marker)).toBe(false);
      const seen = JSON.parse(readFileSync(join(root, "env.json"), "utf8")) as string[];
      expect(seen.filter((k) => !ALLOWED.has(k))).toEqual([]);
    },
    60_000,
  );

  it.runIf(platform() === "darwin")(
    "a browser binary that writes outside the worktree leaves no marker, and its failure is not a pass",
    async () => {
      const marker = join(outside, "marker");
      const fake = join(outside, "fake-chrome.sh");
      writeFileSync(fake, `#!/bin/sh\necho escaped > ${JSON.stringify(marker)} 2>/dev/null\n`);
      chmodSync(fake, 0o755);
      vi.stubEnv("SEKHEMET_CHROME", fake);
      const config = parseVisualConfig({
        url: "http://127.0.0.1:9/",
        viewports: [1280],
      }) as NonNullable<ReturnType<typeof parseVisualConfig>>;
      const r = await runVisualGates({ root, config, stateDir: join(root, ".sekhemet") });
      expect(existsSync(marker)).toBe(false);
      // Installed but unable to run confined: not a pass, and the card says why.
      expect(r.outcomes.length).toBeGreaterThan(0);
      expect(r.outcomes.every((o) => !o.passed && !o.skipped)).toBe(true);
      const why = r.failures.find((f) => f.gate === "visual-confinement")?.errorExcerpt ?? "";
      expect(why).toContain("Chromium exited");
      expect(why).toMatch(/sandbox engine: (native|srt)/);
    },
    30_000,
  );

  it("no Chromium installed stays a passing skip", async () => {
    vi.stubEnv("SEKHEMET_CHROME", join(outside, "missing-chrome"));
    vi.stubEnv("HOME", outside);
    const config = parseVisualConfig({
      url: "http://127.0.0.1:9/",
      viewports: [1280],
    }) as NonNullable<ReturnType<typeof parseVisualConfig>>;
    const r = await runVisualGates({ root, config, stateDir: join(root, ".sekhemet") });
    if (findChrome() !== undefined) return; // A system Chrome outside HOME is still found.
    expect(r.failures).toEqual([]);
    expect(r.outcomes.every((o) => o.passed && o.skipped)).toBe(true);
  });
});
