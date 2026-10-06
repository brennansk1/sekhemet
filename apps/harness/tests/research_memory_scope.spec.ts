import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest, InferenceResponse, LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  ResearchMemory,
  ResearchService,
  packagesInQuestion,
  pinsInQuestion,
} from "../src/research/service.js";

/**
 * Design-stage DS-N2-5: a cached answer recorded for another repository, or
 * for another installed version of the package in question, is not reused.
 * Real repositories on disk, each with its own node_modules.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const repoWith = (version: string): string => {
  const repo = mkdtempSync(join(tmpdir(), "mem-repo-"));
  dirs.push(repo);
  const pkg = join(repo, "node_modules", "zod");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "zod", version }));
  return repo;
};

function model(): LocalInferenceAdapter & { calls: number } {
  const steps: Partial<InferenceResponse>[] = [
    { toolCalls: [{ id: "c1", name: "package_readme", arguments: { name: "zod" } }] },
    { text: "Use z.object().parse [1]." },
  ];
  const m = {
    modelId: "generic-researcher",
    supportedArms: ["arm_a_flat"],
    nativeTools: true,
    contextWindow: { contextTokens: 16384, maxTokens: 1500 },
    calls: 0,
    async generate(_req: InferenceRequest): Promise<InferenceResponse> {
      const step = steps[m.calls % steps.length] ?? {};
      m.calls++;
      return {
        text: "",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        ...step,
      };
    },
  };
  return m as LocalInferenceAdapter & { calls: number };
}

const service = (repoPath: string, memory: ResearchMemory, m: LocalInferenceAdapter) =>
  new ResearchService({
    repoPath,
    memory,
    tools: { fetchJson: async () => ({ readme: "zod docs", license: "MIT" }) },
    model: async () => m,
  });

describe("research memory is scoped to the repository and the installed version (DS-N2-5)", () => {
  it("names the installed packages a question is about", () => {
    const repo = repoWith("3.22.4");
    expect(packagesInQuestion(repo, "How do I validate input with zod?")).toEqual({
      zod: "3.22.4",
    });
    expect(packagesInQuestion(repo, "How do I read a file?")).toEqual({});
  });

  it("reuses an answer in the same repository at the same version, and in no other", async () => {
    const memDir = mkdtempSync(join(tmpdir(), "mem-"));
    dirs.push(memDir);
    const memory = new ResearchMemory(join(memDir, "m.jsonl"));
    const q = "How do I validate input with zod?";
    const a = repoWith("3.22.4");
    const m = model();
    expect((await service(a, memory, m).ask(q)).fromMemory).toBe(false);
    expect(memory.all()[0]).toMatchObject({ repo: a, packages: { zod: "3.22.4" } });
    expect((await service(a, memory, m).ask(q)).fromMemory).toBe(true);

    // Another repository with the same version: not reused.
    const b = repoWith("3.22.4");
    expect((await service(b, memory, model()).ask(q)).fromMemory).toBe(false);

    // The same repository after an upgrade: not reused.
    writeFileSync(
      join(a, "node_modules", "zod", "package.json"),
      JSON.stringify({ name: "zod", version: "4.0.0" }),
    );
    expect((await service(a, memory, model()).ask(q)).fromMemory).toBe(false);
  });

  it("never reuses an entry recorded before the scope was kept, when the question names an installed package", async () => {
    const memDir = mkdtempSync(join(tmpdir(), "mem-"));
    dirs.push(memDir);
    const path = join(memDir, "m.jsonl");
    const a = repoWith("3.22.4");
    writeFileSync(
      path,
      `${JSON.stringify({
        question: "How do I validate input with zod?",
        answer: "old",
        sources: ["x"],
        confidence: 0.9,
        at: new Date().toISOString(),
        repo: a,
      })}\n`,
    );
    const memory = new ResearchMemory(path);
    expect(
      memory.recall("How do I validate input with zod?", { repo: a, packages: { zod: "3.22.4" } }),
    ).toBeUndefined();
  });
});

describe("every research question carries the pins of the packages it names (DS-N9-11)", () => {
  /** A Go module and a Rust crate pinned by their lockfiles, neither installed. */
  const polyglot = (): string => {
    const repo = mkdtempSync(join(tmpdir(), "pins-repo-"));
    dirs.push(repo);
    writeFileSync(
      join(repo, "go.mod"),
      "module example.com/app\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.0\n",
    );
    writeFileSync(
      join(repo, "go.sum"),
      "github.com/spf13/cobra v1.8.0 h1:abc=\ngithub.com/spf13/cobra v1.8.0/go.mod h1:def=\n",
    );
    writeFileSync(
      join(repo, "Cargo.toml"),
      '[package]\nname = "app"\n\n[dependencies]\nserde = "1"\n',
    );
    writeFileSync(
      join(repo, "Cargo.lock"),
      'version = 3\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
    );
    return repo;
  };

  it("finds a Go module by its path or its last element, and a crate by its name", () => {
    const repo = polyglot();
    const cobra = { eco: "go", name: "github.com/spf13/cobra", version: "v1.8.0" };
    expect(pinsInQuestion(repo, "How does cobra register a subcommand?")).toEqual([cobra]);
    expect(pinsInQuestion(repo, "Is github.com/spf13/cobra's Command.Execute safe?")).toEqual([
      cobra,
    ]);
    expect(pinsInQuestion(repo, "Does serde derive Deserialize for enums?")).toEqual([
      { eco: "rust", name: "serde", version: "1.0.200" },
    ]);
    expect(packagesInQuestion(repo, "serde and cobra")).toEqual({
      "go:github.com/spf13/cobra": "v1.8.0",
      "rust:serde": "1.0.200",
    });
    expect(pinsInQuestion(repo, "How do I read a file?")).toEqual([]);
  });

  it("sends the pins with the question and records them on research/asked", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { EventLog, initSchema } = await import("@sekhemet/kernel");
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const repo = repoWith("3.22.4");
    const seen: string[] = [];
    const m = model();
    const generate = m.generate.bind(m);
    m.generate = async (req) => {
      seen.push(JSON.stringify(req.messages ?? req.prompt));
      return generate(req);
    };
    const memDir = mkdtempSync(join(tmpdir(), "mem-"));
    dirs.push(memDir);
    await new ResearchService({
      repoPath: repo,
      log,
      memory: new ResearchMemory(join(memDir, "m.jsonl")),
      tools: { fetchJson: async () => ({ readme: "zod docs", license: "MIT" }) },
      model: async () => m,
    }).ask("How do I validate input with zod?");
    expect(seen[0]).toMatch(/zod@3\.22\.4/);
    const e = (await log.getEventsByTypes(["research/asked"]))[0];
    expect(e?.payload).toMatchObject({ pins: ["npm:zod@3.22.4"] });
    db.close();
  });
});
