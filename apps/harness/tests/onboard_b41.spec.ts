import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectConventionDrift, runOnboard } from "../src/onboard.js";
import { trustWorkspace } from "../src/workspace_trust.js";

/**
 * P10's onboarding (surface items 9–12): trust before any repository process
 * (SUR-56), the gates diff with a backup (SUR-7), one AGENTS.md block
 * (SUR-9), no drift without a convention change (SUR-10), the CI coverage
 * list (SUR-35), an AGENTS.md block of what no gate enforces (SUR-37), and
 * the workspace graph (SUR-39). Real repositories, git and processes.
 */
const FAKE_LSP = resolve(
  import.meta.dirname,
  "../../../packages/context/tests/support/fake_lsp.mjs",
);
const dirs: string[] = [];
beforeEach(() => {
  const store = mkdtempSync(join(tmpdir(), "onboard-b41-trust-"));
  dirs.push(store);
  vi.stubEnv("SEKHEMET_TRUST_DIR", store);
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const git = (root: string, ...a: string[]) =>
  execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();

function repo(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "onboard-b41-"));
  dirs.push(root);
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "demo",
      scripts: { test: "vitest run", lint: "biome check ." },
      devDependencies: { vitest: "3", typescript: "5" },
    }),
  );
  write(root, "pnpm-lock.yaml", "");
  write(root, "src/user-store.ts", "export const users = 1;\n");
  write(root, "src/order-line.ts", "export const lines = 1;\n");
  write(root, "src/price-book.ts", "export const prices = 1;\n");
  write(
    root,
    ".github/workflows/ci.yml",
    "jobs:\n  t:\n    steps:\n      - run: |\n          pnpm install\n          pnpm test:e2e\n",
  );
  write(root, "AGENTS.md", "# Agents\n\nKeep functions under forty lines.\n");
  for (const [rel, text] of Object.entries(extra)) write(root, rel, text);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "e@x");
  git(root, "config", "user.name", "E");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

const quiet = { say: () => undefined, baseline: false } as const;

describe("SUR-56: nothing from an untrusted repository runs", () => {
  it("starts no language server and takes no baseline before trust; starts them after", async () => {
    const root = repo();
    const marker = join(root, "lsp-started");
    const script = `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); require(${JSON.stringify(FAKE_LSP)});`;
    const servers = { typescript: { command: process.execPath, args: ["-e", script] } };
    const lines: string[] = [];
    const before = await runOnboard(root, {
      say: (l) => lines.push(l),
      lspServers: servers,
      lspTimeoutMs: 5_000,
    });
    expect(existsSync(marker)).toBe(false);
    expect(before.trusted).toBe(false);
    expect(before.languageServers).toEqual([
      {
        language: "typescript",
        command: process.execPath,
        ok: false,
        detail: "not started: the repository is not trusted",
      },
    ]);
    expect(before.baseline).toBeUndefined();
    expect(lines.join("\n")).toMatch(/not trusted/);
    trustWorkspace(root, "p_owner");
    const after = await runOnboard(root, { ...quiet, lspServers: servers, lspTimeoutMs: 5_000 });
    expect(after.trusted).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});

describe("SUR-7, SUR-9, SUR-10, SUR-35, SUR-37: drafts, the gates diff and drift", () => {
  it("SUR-7: a different gates.toml is shown as a diff, kept without confirmation, and backed up when replaced", async () => {
    const root = repo();
    const mine =
      '[project]\nmax_files = 5\n\n[[gate]]\nid = "mine"\nrung = "test"\nlayer = "functional"\ncommand = "make"\nargs = ["check"]\n';
    write(root, ".sekhemet/gates.toml", mine);
    const kept = await runOnboard(root, { ...quiet, apply: true, lspServers: {} });
    expect(kept.gatesDiff).toMatch(/^- max_files = 5$/m);
    expect(kept.gatesDiff).toMatch(/^\+ max_files = 3$/m);
    expect(kept.applied).not.toContain(".sekhemet/gates.toml");
    expect(readFileSync(join(root, ".sekhemet/gates.toml"), "utf8")).toBe(mine);
    const replaced = await runOnboard(root, {
      ...quiet,
      apply: true,
      confirm: true,
      lspServers: {},
    });
    expect(replaced.applied).toContain(".sekhemet/gates.toml");
    expect(readFileSync(join(root, ".sekhemet/gates.toml.bak"), "utf8")).toBe(mine);
    expect(readFileSync(join(root, ".sekhemet/gates.toml"), "utf8")).toContain('id = "unit"');
  });

  it("SUR-9, SUR-37: applied three times, AGENTS.md holds one Sekhemet block of commands and locations only", async () => {
    const root = repo();
    for (let i = 0; i < 3; i++) {
      await runOnboard(root, { ...quiet, apply: true, confirm: true, lspServers: {} });
    }
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents.match(/<!-- sekhemet:begin -->/g)?.length).toBe(1);
    expect(agents.match(/<!-- sekhemet:end -->/g)?.length).toBe(1);
    expect(agents.match(/Keep functions under forty lines\./g)?.length).toBe(1);
    expect(agents).toContain("- test: `pnpm run test`");
    // Rules a gate already enforces are not repeated to other agents.
    expect(agents).not.toMatch(/at most 3 files|failing test first|weaken a test/);
  });

  it("SUR-10: no drift when no commit changed the conventions, even after the drafts are committed", async () => {
    const root = repo();
    await runOnboard(root, { ...quiet, apply: true, confirm: true, lspServers: {} });
    write(root, "README.md", "# demo\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "docs and the applied drafts");
    expect(detectConventionDrift(root).drift).toEqual([]);
  });

  it("SUR-35: the report lists every CI step with its gate or reason", async () => {
    const root = repo();
    const r = await runOnboard(root, { ...quiet, lspServers: {} });
    expect(r.ciCoverage.map((s) => `${s.command}:${s.gate ?? s.reason}`)).toEqual([
      "pnpm install:setup",
      "pnpm test:e2e:ci-test-1",
    ]);
    expect(existsSync(join(root, ".sekhemet/onboard/ci_coverage.json"))).toBe(true);
  });
});

describe("SUR-39: workspaces are recorded at onboarding", () => {
  it("records each package's name, dependencies and build order, and TypeScript project references", async () => {
    const root = repo({
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/core/package.json": JSON.stringify({ name: "@demo/core" }),
      "packages/api/package.json": JSON.stringify({
        name: "@demo/api",
        dependencies: { "@demo/core": "workspace:*" },
      }),
      "tsconfig.json": JSON.stringify({
        files: [],
        references: [{ path: "packages/core" }, { path: "packages/api" }],
      }),
      "packages/core/tsconfig.json": JSON.stringify({ compilerOptions: { composite: true } }),
      "packages/api/tsconfig.json": JSON.stringify({ references: [{ path: "../core" }] }),
    });
    const r = await runOnboard(root, { ...quiet, lspServers: {} });
    const graph = JSON.parse(readFileSync(join(root, ".sekhemet/onboard/workspace.json"), "utf8"));
    expect(r.workspace?.buildOrder).toEqual(["@demo/core", "@demo/api"]);
    expect(graph.tool).toBe("pnpm");
    expect(graph.packages).toEqual([
      { name: "@demo/api", dir: "packages/api", deps: ["@demo/core"] },
      { name: "@demo/core", dir: "packages/core", deps: [] },
    ]);
    expect(graph.tsReferences).toEqual([
      { dir: ".", references: ["packages/api", "packages/core"] },
      { dir: "packages/api", references: ["packages/core"] },
    ]);
  });
});
