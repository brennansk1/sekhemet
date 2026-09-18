import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { applyExploration, exploreProject } from "../src/learning/explore.js";
import { LearningStore } from "../src/learning/store.js";

describe("exploring a project before the work (RSIAgent)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const project = () => {
    const repo = mkdtempSync(join(tmpdir(), "explore-"));
    dirs.push(repo);
    writeFileSync(
      join(repo, "tsconfig.json"),
      `{
  // comments and trailing commas are allowed in tsconfig
  "compilerOptions": { "strict": true, "exactOptionalPropertyTypes": true, "module": "NodeNext", },
}`,
    );
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^3" } }),
    );
    return repo;
  };

  it("reads the constraints the compiler will enforce, and only those", () => {
    const keys = exploreProject(project()).map((c) => c.key);
    expect(keys).toContain("ts_exact_optional");
    expect(keys).toContain("esm_js_extensions");
    expect(keys).toContain("test_runner_vitest");
    expect(keys).not.toContain("ts_unchecked_index");
  });

  it("stores them once, active only when asked", async () => {
    const repo = project();
    const configDir = mkdtempSync(join(tmpdir(), "explore-cfg-"));
    dirs.push(configDir);
    process.env.SEKHEMET_CONFIG_DIR = configDir;
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const store = new LearningStore(new EventLog(db));
    expect((await applyExploration(store, repo, false)).activated).toBe(0);
    const again = await applyExploration(store, repo, true);
    expect(again.proposed).toBe(0); // duplicates strengthen evidence, never add rules
    expect(again.activated).toBe(4); // ...but the earlier candidates are activated
    expect((await store.rules()).every((r) => r.status === "active")).toBe(true);
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  });
});
