import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { LearningStore } from "../src/learning/store.js";
import {
  detectCommands,
  detectConventionDrift,
  postConventionDrift,
  runOnboard,
} from "../src/onboard.js";
import { PmStore } from "../src/pm/store.js";

const FAKE_LSP = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/context/tests/support/fake_lsp.mjs",
);
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "sek-onboard-"));
  dirs.push(root);
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "demo",
      scripts: { test: "vitest run", lint: "biome check .", typecheck: "tsc -b", build: "tsc" },
      devDependencies: { vitest: "3", typescript: "5" },
    }),
  );
  write(root, "pnpm-lock.yaml", "");
  write(root, "src/user-store.ts", "export class UserStore { get(): never { throw new NotFoundError('x'); } }\nexport class NotFoundError extends Error {}\n");
  write(root, "src/order-service.ts", 'import { UserStore } from "./user-store.js";\nexport const orders = new UserStore();\n');
  write(root, "src/price-rules.ts", "export const price = 1;\n");
  write(root, "src/tax-table.ts", "export const tax = 2;\n");
  write(root, "tests/user-store.spec.ts", 'import { describe, it } from "vitest";\ndescribe("x", () => it("y", () => {}));\n');
  write(root, ".github/workflows/ci.yml", "jobs:\n  t:\n    steps:\n      - run: pnpm test\n      - run: cargo clippy\n");
  write(root, "AGENTS.md", "# Agents\n\n## Code Standards\n- Keep functions under forty lines.\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

function ledger() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { log, cardStore: new CardStore(db, log) };
}

describe("X1: sekhemet onboard runs the seven steps", () => {
  it("maps, starts servers, detects commands, proposes gates, drafts rules and AGENTS.md, qualifies", async () => {
    const root = repo();
    const store = ledger();
    const lines: string[] = [];
    const report = await runOnboard(root, {
      store,
      say: (l) => lines.push(l),
      lspServers: {
        typescript: { command: process.execPath, args: [FAKE_LSP] },
      },
      models: [new MockInferenceAdapter("tiny", [], { exhaustion: "default" })],
    });
    expect(report.repoMap.files).toBeGreaterThan(0);
    expect(existsSync(join(root, ".sekhemet/onboard/repo_map.txt"))).toBe(true);
    expect(report.languageServers).toEqual([
      { language: "typescript", command: process.execPath, ok: true, detail: "initialized" },
    ]);
    expect(report.commands.map((c) => `${c.kind}:${c.command}`)).toEqual(
      expect.arrayContaining(["test:pnpm run test", "lint:pnpm run lint", "typecheck:pnpm run typecheck", "build:pnpm run build", "lint:cargo clippy"]),
    );
    expect(readFileSync(join(root, report.gatesProposal.path), "utf8")).toContain("[[gate]]");
    expect(existsSync(join(root, ".sekhemet/gates.toml"))).toBe(false);
    expect(report.conventions.dominantNaming).toBe("kebab-case");
    expect(report.conventions.testLayout).toBe("tests-dir");
    expect(report.conventions.errorPatterns).toContain("NotFoundError");
    const rules = await new LearningStore(store.log).rules();
    expect(rules.some((r) => /kebab-case/.test(r.text) && r.status === "candidate")).toBe(true);
    const draft = readFileSync(join(root, ".sekhemet/onboard/AGENTS.md.draft"), "utf8");
    expect(draft).toContain("Keep functions under forty lines.");
    expect(draft).toContain("- test: `pnpm run test`");
    expect(report.qualification[0]).toMatchObject({ modelId: "tiny", qualified: false });
    expect(lines.filter((l) => /^\d\. /.test(l)).map((l) => l[0])).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).not.toContain("sekhemet onboard");
  });

  it("--apply installs the gates and the drafts; a missing server is reported, not fatal", async () => {
    const root = repo();
    const r = await runOnboard(root, {
      apply: true,
      say: () => undefined,
      lspServers: { typescript: { command: "no-such-lsp-server", args: [] } },
    });
    expect(r.languageServers[0]?.ok).toBe(false);
    expect(r.applied).toEqual([".sekhemet/gates.toml", "AGENTS.md", "CLAUDE.md"]);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("[AGENTS.md](AGENTS.md)");
    expect(detectCommands(root).length).toBeGreaterThan(3);
  });
});

describe("X2: convention drift against the onboarding snapshot", () => {
  it("detects a naming change in recent commits and posts it as Seshat's note", async () => {
    const root = repo();
    await runOnboard(root, { say: () => undefined, lspServers: {} });
    for (const n of ["userAccount", "orderLine", "priceBook"]) write(root, `src/${n}.ts`, "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "camel"], { cwd: root });
    const { drift } = detectConventionDrift(root);
    expect(drift.map((d) => `${d.aspect}:${d.was}->${d.now}`)).toContain("file naming:kebab-case->camelCase");
    const store = ledger();
    await postConventionDrift(root, store.log);
    const thread = await new PmStore(store.log).thread();
    expect(thread.at(-1)?.text).toMatch(/Convention drift over the last 7 days/);
  });
});
