import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unmetDependencies } from "../src/suite_runner.js";

// Live-test F20: safe Accept (B3.2) moves `main` by plumbing and never touches
// the checkout, so the fixture's working-tree files stay as seeded (empty).
// A dependency is built when `main` holds it, not when the checkout does:
// otherwise a genuine failure is relabelled "blocked" and leaves the
// denominator (a reported 4/4 was an honest 4/5).
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sek-unmet-"));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "acceptance"));
  writeFileSync(join(dir, "src", "hasher.ts"), "");
  writeFileSync(join(dir, "src", "db.ts"), "");
  writeFileSync(
    join(dir, "acceptance", "ledger.spec.ts"),
    'import { h } from "../src/hasher.js";\nimport { d } from "../src/db.js";\n',
  );
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  // An accepted card: main gains the hasher, the checkout keeps the empty seed.
  writeFileSync(join(dir, "src", "hasher.ts"), "export const h = 1;\n");
  git("add", "src/hasher.ts");
  git("commit", "-q", "-m", "feat: hasher");
  writeFileSync(join(dir, "src", "hasher.ts"), "");
  return dir;
}

describe("a dependency is built when main holds it (F20)", () => {
  it("reads the committed tree, not the stale checkout", () => {
    const dir = repo();
    const unmet = unmetDependencies(dir, {
      scope: ["src/ledger.ts"],
      tests: ["ledger.spec.ts"],
      spec: "",
    } as never);
    expect(unmet).toEqual(["src/db"]);
  });
});
