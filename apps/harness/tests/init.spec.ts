import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGatesConfig } from "@sekhemet/gates";
import { SHIPPED_ENGINE_FLOOR } from "@sekhemet/models";
import { describe, expect, it, vi } from "vitest";
import { findCommand } from "../src/commands/registry.js";
import { deriveGates, recommendRoster, runInit, toolchainChecks } from "../src/init.js";

const GB = 1024 ** 3;
/** A machine with git and the reference host's llama-server (build 10809). */
const fakeRun = (cmd: string) =>
  cmd === "llama-server"
    ? "version: 0.4.0 (build 10809, commit 5266f24da)"
    : cmd === "git"
      ? "git version 2"
      : undefined;

describe("sekhemet init (H25)", () => {
  it("recommends the shipped set by memory: one at a time on 24 GB, all resident on 128 GB", () => {
    // MD-N22-2: the roster reads SHIPPED_MODELS and SUPPORTED_HARDWARE (DEC-47 O-5).
    expect(recommendRoster(24 * GB)).toMatchObject({
      tier: "M",
      supported: true,
      worker: "nail-mtp",
      manager: "qwen3.8-27b-gsq-rco",
      researcher: "apodex-1.1-mini",
      reviewer: "",
    });
    expect(recommendRoster(24 * GB).note).toMatch(/One large model at a time/);
    expect(recommendRoster(128 * GB)).toMatchObject({ tier: "XL", supported: true });
    expect(recommendRoster(128 * GB).note).toMatch(/Every shipped role resident/);
    // The Review role is unfilled, never mistral (DEC-47 O-5).
    for (const gb of [16, 24, 64, 128])
      expect(JSON.stringify(recommendRoster(gb * GB))).not.toMatch(/mistral|cyber-tiel/i);
  });

  it("MD-N16-3: below 24 GB says v1 does not support it, and never that the set fits", () => {
    const r = recommendRoster(16 * GB);
    expect(r).toMatchObject({ tier: "S", supported: false });
    expect(r.note).toMatch(/v1 supports 24 GB of memory and above/);
    expect(r.note).toMatch(/your own risk/);
    const repo = mkdtempSync(join(tmpdir(), "init-16-"));
    const lines: string[] = [];
    runInit(repo, { run: fakeRun, totalBytes: 16 * GB, say: (l) => lines.push(l) });
    const text = lines.join("\n");
    expect(text).toMatch(/v1 supports 24 GB of memory and above/);
    expect(text).not.toMatch(/Models: Coding model nail-mtp/);
    expect(text).toMatch(/do not fit/);
    rmSync(repo, { recursive: true, force: true });
  });

  it("derives gates from the project's own scripts and tooling", () => {
    const repo = mkdtempSync(join(tmpdir(), "init-"));
    writeFileSync(join(repo, "pnpm-lock.yaml"), "");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        scripts: { typecheck: "tsc -b", lint: "biome check .", test: "vitest run" },
        devDependencies: { vitest: "3", "@biomejs/biome": "2" },
      }),
    );
    const g = deriveGates(repo);
    expect(g.gates).toEqual([
      "typecheck: pnpm run typecheck",
      "lint: pnpm run lint",
      "unit: pnpm run test",
    ]);
    expect(g.toml).toMatch(
      /\[\[gate\]\]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "pnpm"\nargs = \["run", "test"\]\ntimeout_s = 600\nparser = "vitest"/,
    );
    const py = mkdtempSync(join(tmpdir(), "init-py-"));
    writeFileSync(join(py, "pyproject.toml"), "[tool.ruff]\n[tool.mypy]\n");
    expect(deriveGates(py).gates).toEqual([
      "typecheck: mypy .",
      "lint: ruff check .",
      "unit: pytest -q",
    ]);
  });

  it("checks the toolchain with a fix for each missing piece", () => {
    const checks = toolchainChecks((cmd) => (cmd === "git" ? "git version 2.50" : undefined));
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.git?.ok).toBe(true);
    expect(byName["llama-server (llama.cpp)"]).toMatchObject({
      ok: false,
      required: true,
      detail: "not found",
    });
    expect(byName["Docker (for private web search)"]).toMatchObject({ ok: false, required: false });
    expect(checks.every((c) => c.ok || c.fix)).toBe(true);
  });

  it("MD-N16-1: says which llama-server build was found and which the floor needs", () => {
    const old = toolchainChecks((cmd) =>
      cmd === "llama-server" ? "version: 0.3.0 (build 6500, commit abc)" : undefined,
    ).find((c) => c.name === "llama-server (llama.cpp)");
    expect(old).toMatchObject({
      ok: false,
      detail: `llama-server b6500 found; b${SHIPPED_ENGINE_FLOOR} or later needed`,
    });
    const now = toolchainChecks(fakeRun).find((c) => c.name === "llama-server (llama.cpp)");
    expect(now).toMatchObject({ ok: true, detail: "b10809" });
  });

  it("MD-N16-2: names this platform's fixes, and every file or page a fix names exists", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    for (const p of [
      { os: "darwin", arch: "arm64", backend: "metal" },
      { os: "linux", arch: "x64", backend: "vulkan" },
      { os: "linux", arch: "x64", backend: "cuda" },
    ] as const) {
      const fix = toolchainChecks(() => undefined, undefined, { platform: p }).find(
        (c) => c.name === "llama-server (llama.cpp)",
      )?.fix as string;
      expect(fix).not.toMatch(/HARNESS_DESIGN/);
      if (p.os === "darwin") expect(fix).toMatch(/brew install llama\.cpp/);
      if (p.backend === "cuda") expect(fix).not.toMatch(/Get the inference engine/);
      else expect(fix).toMatch(/Get the inference engine on Configuration › Models/);
      // Every repository file a fix names exists, with the section it names.
      for (const m of fix.matchAll(/(docs\/[\w./-]+\.md)(?:, section \*([^*]+)\*)?/g)) {
        const text = readFileSync(join(root, m[1] as string), "utf8");
        if (m[2]) expect(text).toMatch(new RegExp(`^## ${m[2]}$`, "m"));
      }
      // The page and the command a fix names exist.
      if (/sekhemet engine get/.test(fix)) expect(findCommand("engine")).toBeDefined();
      if (/Configuration › Models/.test(fix))
        expect(
          readFileSync(join(root, "packages", "ui", "web", "configuration.js"), "utf8"),
        ).toMatch(/config_models\.js/);
    }
  });

  it("writes config, gates and .gitignore once, keeps them after, and reports readiness", () => {
    const repo = mkdtempSync(join(tmpdir(), "init-run-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(join(repo, ".gitignore"), "node_modules/");
    const lines: string[] = [];
    const run = fakeRun;
    const first = runInit(repo, { run, totalBytes: 24 * GB, say: (l) => lines.push(l) });
    expect(first.wrote).toEqual(["gates.toml", "config.toml", ".gitignore"]);
    expect(first.ready).toBe(true);
    expect(readFileSync(join(repo, ".sekhemet", "config.toml"), "utf8")).toMatch(
      /executor = "nail-mtp"/,
    );
    // SUR-34: one marked block that ignores .sekhemet/ by default.
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toMatch(
      /^node_modules\/\n# >>> sekhemet[^\n]*\n\.sekhemet\/\*\n/,
    );
    // The generated file loads through the real gates parser.
    const cfg = loadGatesConfig(repo);
    expect(cfg.gates.map((g) => g.id)).toEqual(["unit"]);
    expect(cfg.project.maxFiles).toBe(3);
    const second = runInit(repo, { run, totalBytes: 24 * GB, say: () => {} });
    expect(second.wrote).toEqual([]);
    expect(second.kept).toEqual(["gates.toml", "config.toml"]);
    expect(lines.at(-1)).toMatch(/Ready\. Ask for work with: sekhemet "/);
  });

  it("RUN-35: the runner lease and the slot leases are ignored by git, so a running card never dirties the tree", () => {
    const repo = mkdtempSync(join(tmpdir(), "init-leases-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      runInit(repo, { run: fakeRun, totalBytes: 24 * GB, say: () => {} });
      // The block ignores all of .sekhemet/ but the shared files (SUR-34).
      const ignore = readFileSync(join(repo, ".gitignore"), "utf8").split("\n");
      expect(ignore).toContain(".sekhemet/*");
      mkdirSync(join(repo, ".sekhemet", "slots"), { recursive: true });
      writeFileSync(join(repo, ".sekhemet", "slots", "0.lock"), "{}");
      writeFileSync(join(repo, ".sekhemet", "slots", "admit.lock"), "");
      writeFileSync(join(repo, ".sekhemet", "runner.lock"), "{}");
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(status).not.toMatch(/slots|runner\.lock/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Review M1 (SUR-6, security S9): probing the toolchain runs no program the
// repository chose. `pnpm --version` inside a repository whose package.json
// has a `packageManager` field makes Corepack fetch that version; the probe
// runs from a neutral directory with Corepack's download and pinning off.
describe("the toolchain probe runs outside the repository (review M1)", () => {
  it("runs each probe from the system temp directory with Corepack's strict mode, auto-pin and npm's version management off", () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "probe-bin-")));
    const seen = join(bin, "seen.txt");
    const fake = join(bin, "pnpm");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        `{ pwd; echo "S=$COREPACK_ENABLE_STRICT"; echo "A=$COREPACK_ENABLE_AUTO_PIN"; echo "M=$npm_config_manage_package_manager_versions"; } > ${JSON.stringify(seen)}`,
        "echo 10.0.0",
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    vi.stubEnv("PATH", bin);
    try {
      const checks = toolchainChecks();
      expect(checks.find((c) => c.name === "pnpm")?.detail).toBe("10.0.0");
    } finally {
      vi.unstubAllEnvs();
    }
    const [cwd, strict, pin, manage] = readFileSync(seen, "utf8").trim().split("\n");
    expect(cwd).toBe(realpathSync(tmpdir()));
    expect(cwd).not.toBe(realpathSync(process.cwd()));
    expect(strict).toBe("S=0");
    expect(pin).toBe("A=0");
    expect(manage).toBe("M=false");
    rmSync(bin, { recursive: true, force: true });
  });
});
