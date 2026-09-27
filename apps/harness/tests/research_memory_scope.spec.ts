import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest, InferenceResponse, LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchMemory, ResearchService, packagesInQuestion } from "../src/research/service.js";

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
