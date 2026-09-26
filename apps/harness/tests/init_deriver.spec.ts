import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadGatesConfig } from "@sekhemet/gates";
import { afterEach, describe, expect, it } from "vitest";
import { deriveGates } from "../src/init.js";

/**
 * P10's one gate deriver (surface item 5.3, items 9a–9b): the project's own
 * scripts, the team's own linter and formatter configurations, and every CI
 * step — multi-line `run: |` blocks included — each listed with the gate it
 * became or the reason it did not (SUR-8, SUR-35, SUR-36).
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deriver-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const WORKFLOW = `name: ci
on: [push]
jobs:
  unit:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Unit
        run: pnpm test
      - name: End to end
        run: |
          pnpm build
          pnpm test:e2e --reporter=dot
      - name: Node matrix
        run: node --version && echo \${{ matrix.node }}
      - name: Publish coverage
        env:
          TOKEN: \${{ secrets.CODECOV_TOKEN }}
        run: pnpm test:coverage
      - run: ./scripts/smoke.sh
  db:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
    steps:
      - run: pnpm test:db
`;

describe("P10: one gate deriver", () => {
  it("SUR-8: a test command in a multi-line run: | block becomes a proposed gate", () => {
    const root = repo({
      "pnpm-lock.yaml": "",
      "package.json": JSON.stringify({
        scripts: { test: "vitest run", "test:e2e": "playwright test", build: "tsc" },
        devDependencies: { vitest: "3" },
      }),
      ".github/workflows/ci.yml": WORKFLOW,
    });
    const d = deriveGates(root);
    expect(d.gates).toContain("ci-test-1: pnpm test:e2e --reporter=dot");
    // It loads through the real gates parser.
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(join(root, ".sekhemet", "gates.toml"), d.toml);
    expect(loadGatesConfig(root).gates.map((g) => g.id)).toContain("ci-test-1");
  });

  it("SUR-35: every CI step is listed with the gate it became or why it did not", () => {
    const root = repo({
      "pnpm-lock.yaml": "",
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      ".github/workflows/ci.yml": WORKFLOW,
    });
    const steps = deriveGates(root).ci.map(
      (s) => `${s.line}:${s.command}:${s.gate ?? `(${s.reason})`}`,
    );
    expect(steps).toEqual([
      "10:actions/checkout@v4:(action)",
      "12:pnpm install --frozen-lockfile:(setup)",
      "14:pnpm test:unit",
      "17:pnpm build:(not_a_check)",
      "18:pnpm test:e2e --reporter=dot:ci-test-1",
      "20:node --version && echo ${{ matrix.node }}:(matrix)",
      "24:pnpm test:coverage:(needs_secret)",
      "25:./scripts/smoke.sh:(unknown_tool)",
      "32:pnpm test:db:(needs_service)",
    ]);
  });

  it("SUR-36: the team's own linter and formatter, with their configuration, never Sekhemet's", () => {
    const eslint = repo({
      "package.json": JSON.stringify({ devDependencies: { eslint: "9", prettier: "3" } }),
      "eslint.config.js": "export default [];\n",
      ".prettierrc": "{}\n",
    });
    const d = deriveGates(eslint);
    expect(d.gates).toEqual(["lint: npx eslint .", "format: npx prettier --check ."]);
    expect(d.teamTools).toEqual(["eslint (eslint.config.js)", "prettier (.prettierrc)"]);
    expect(d.toml).not.toMatch(/biome/);
    const biome = repo({
      "pnpm-lock.yaml": "",
      "package.json": JSON.stringify({ devDependencies: { "@biomejs/biome": "2" } }),
      "biome.json": "{}\n",
    });
    expect(deriveGates(biome).gates).toEqual(["lint: pnpm exec biome check ."]);
  });
});
