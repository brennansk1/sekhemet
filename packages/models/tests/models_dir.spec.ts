import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_MODEL_FILES,
  createApodexResearcher,
  createCyberTielWorker,
  createQwen38Managed,
  managedModelWeights,
  probeModelWeights,
  resolveModelPath,
  resolveModelsDir,
  sekhemetConfigDir,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sek-weights-"));
  dirs.push(d);
  return d;
}

describe("the models directory is the one override (design: Getting the weights)", () => {
  it("prefers --models-dir, then SEKHEMET_MODELS_DIR, then the config directory", () => {
    const env = { SEKHEMET_MODELS_DIR: "/env/models", SEKHEMET_CONFIG_DIR: "/cfg" };
    expect(resolveModelsDir({ modelsDir: "/flag/models", env })).toBe("/flag/models");
    expect(resolveModelsDir({ env })).toBe("/env/models");
    expect(resolveModelsDir({ env: { SEKHEMET_CONFIG_DIR: "/cfg" } })).toBe("/cfg/models");
  });

  it("resolves a relative SEKHEMET_CONFIG_DIR, and refuses one inside a repository or worktree", () => {
    const outside = tmp();
    expect(sekhemetConfigDir({ SEKHEMET_CONFIG_DIR: outside })).toBe(outside);
    const repo = tmp();
    mkdirSync(join(repo, ".git"));
    expect(() => sekhemetConfigDir({ SEKHEMET_CONFIG_DIR: join(repo, "user") })).toThrow(
      /inside the repository/,
    );
    // A linked worktree's `.git` is a file.
    const worktree = tmp();
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n");
    expect(() => sekhemetConfigDir({ SEKHEMET_CONFIG_DIR: join(worktree, "a", "b") })).toThrow(
      /inside the repository/,
    );
    // Relative: resolved against the working directory — this checkout, a repository.
    expect(() => sekhemetConfigDir({ SEKHEMET_CONFIG_DIR: "user-dir" })).toThrow(
      new RegExp(`${resolve("user-dir")}.*inside the repository`),
    );
  });

  it("resolves a catalogue file name inside it and leaves an absolute path alone", () => {
    const env = { SEKHEMET_MODELS_DIR: "/m" };
    expect(resolveModelPath("a/b.gguf", { env })).toBe("/m/a/b.gguf");
    expect(resolveModelPath("/elsewhere/b.gguf", { env })).toBe("/elsewhere/b.gguf");
  });

  it("every managed profile's weights land under the configured directory", () => {
    const dir = tmp();
    const worker = createCyberTielWorker(
      resolveModelPath(MANAGED_MODEL_FILES.worker, {
        modelsDir: dir,
      }),
    );
    const researcher = createApodexResearcher(
      resolveModelPath(MANAGED_MODEL_FILES.researcher, { modelsDir: dir }),
    );
    const planner = createQwen38Managed({
      modelPath: resolveModelPath(MANAGED_MODEL_FILES.planner, { modelsDir: dir }),
    });
    for (const a of [worker, researcher, planner]) {
      expect(a.launchProfile.modelPath.startsWith(`${dir}/`)).toBe(true);
    }
    expect(managedModelWeights({ modelsDir: dir }).map((m) => m.modelId)).toEqual([
      worker.modelId,
      researcher.modelId,
      planner.modelId,
    ]);
  });

  it("no shipped model path points outside the user's own configuration", () => {
    const src = join(dirname(new URL(import.meta.url).pathname), "..", "src");
    for (const name of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(src, name), "utf8");
      // A quoted absolute path in source is a path only its author can use.
      expect(/"\/(Volumes|Users|home|mnt|media)\//.test(text)).toBe(false);
    }
  });
});

describe("the weights check reports what is really on disk", () => {
  it("separates a missing directory, a missing file and an unreadable one", () => {
    const dir = tmp();
    expect(probeModelWeights([], { modelsDir: join(dir, "absent") })).toMatchObject({
      modelsDirExists: false,
    });

    const present = join(dir, "a", "w.gguf");
    mkdirSync(dirname(present), { recursive: true });
    writeFileSync(present, "x".repeat(1024));
    const report = probeModelWeights(
      [
        { modelId: "here", path: present },
        { modelId: "gone", path: join(dir, "a", "missing.gguf") },
      ],
      { modelsDir: dir },
    );
    expect(report.modelsDirExists).toBe(true);
    expect(report.present).toBe(1);
    expect(report.missing).toEqual(["gone"]);
    expect(report.probes.find((p) => p.modelId === "gone")?.detail).toBe("not found");
    expect(report.probes.find((p) => p.modelId === "here")?.ok).toBe(true);
  });
});
