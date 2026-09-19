import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_LANGUAGES,
  createTestWorktree,
  fixtureFiles,
  generateFixture,
} from "../src/fixture_repo.js";

const MINI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/mini");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) =>
    statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
  );

describe("X21: the synthetic fixture generator", () => {
  it("the committed fixtures/mini repositories are exactly the generator's output", () => {
    for (const lang of FIXTURE_LANGUAGES) {
      const files = fixtureFiles(lang);
      const dir = join(MINI, lang);
      expect(
        walk(dir)
          .map((f) => relative(dir, f))
          .sort(),
      ).toEqual(Object.keys(files).sort());
      for (const [rel, text] of Object.entries(files))
        expect(readFileSync(join(dir, rel), "utf8"), `${lang}/${rel}`).toBe(text);
    }
    const out = mkdtempSync(join(tmpdir(), "sek-gen-"));
    expect(generateFixture("python", out, { bug: true })).toContain("mini/add.py");
    expect(readFileSync(join(out, "mini/add.py"), "utf8")).toContain("a - b");
    rmSync(out, { recursive: true, force: true });
  });

  it("createTestWorktree copies a git repository in milliseconds and cleans up", () => {
    createTestWorktree("typescript").cleanup(); // warm the template
    const started = performance.now();
    const wt = createTestWorktree("typescript");
    const ms = performance.now() - started;
    expect(wt.git("log", "--format=%s")).toBe("chore: typescript fixture");
    expect(wt.git("status", "--porcelain")).toBe("");
    // The design's bar is 10 ms; a loaded CI host gets headroom.
    expect(ms).toBeLessThan(100);
    wt.cleanup();
    expect(existsSync(wt.path)).toBe(false);
  });

  for (const lang of FIXTURE_LANGUAGES) {
    it(`${lang}: the gates pass on the fixture and fail on the planted bug`, async () => {
      const ok = createTestWorktree(lang);
      const bad = createTestWorktree(lang, { bug: true });
      try {
        expect((await ok.runGates()).passed).toBe(true);
        const r = await bad.runGates(["test"]);
        expect(r.passed).toBe(false);
        expect(r.failures[0]?.rung).toBe("test");
      } finally {
        ok.cleanup();
        bad.cleanup();
      }
    }, 120_000);
  }
});
