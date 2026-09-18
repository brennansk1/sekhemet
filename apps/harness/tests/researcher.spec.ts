import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { research } from "../src/research/researcher.js";

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

describe("the Researcher answers from evidence it fetched", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("uses its tools, cites the sources, and marks the answer grounded", async () => {
    const repo = mkdtempSync(join(tmpdir(), "research-"));
    dirs.push(repo);
    mkdirSync(join(repo, "node_modules", "@types", "node"), { recursive: true });
    writeFileSync(
      join(repo, "node_modules", "@types", "node", "sqlite.d.ts"),
      'declare module "node:sqlite" {\n  class DatabaseSync {\n    exec(sql: string): void;\n    prepare(sql: string): unknown;\n  }\n}\n',
    );
    const model = new MockInferenceAdapter("apodex", [
      {
        text: "",
        toolCalls: [{ id: "1", name: "module_api", arguments: { module: "node:sqlite" } }],
        usage,
      },
      {
        text: "DatabaseSync has exec for DDL and prepare for statements; there is no run.",
        toolCalls: [],
        usage,
      },
    ]);
    const r = await research(model, "Does DatabaseSync have run()?", { repoPath: repo });
    expect(r.grounded).toBe(true);
    expect(r.sources).toEqual(["type declarations of node:sqlite"]);
    expect(r.answer).toMatch(/no run/);
  });

  it("reports an answer without evidence as ungrounded", async () => {
    const model = new MockInferenceAdapter("apodex", [
      { text: "Probably yes.", toolCalls: [], usage },
    ]);
    const r = await research(model, "Is it fast?", { repoPath: tmpdir() });
    expect(r.grounded).toBe(false);
  });

  it("rejects a package name that could escape the registry URL", async () => {
    let fetched = "";
    const model = new MockInferenceAdapter("apodex", [
      {
        text: "",
        toolCalls: [{ id: "1", name: "package_readme", arguments: { name: "../../evil" } }],
        usage,
      },
      { text: "done", toolCalls: [], usage },
    ]);
    await research(model, "q", {
      repoPath: tmpdir(),
      fetchJson: async (u) => {
        fetched = u;
        return {};
      },
    });
    expect(fetched).toBe("");
  });
});
