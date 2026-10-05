import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, type WeightsReport } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { weightsCheck, weightsHashCheck } from "../src/doctor.js";

const report = (over: Partial<WeightsReport>): WeightsReport => ({
  modelsDir: "/models",
  modelsDirExists: true,
  probes: [],
  present: 0,
  missing: [],
  ...over,
});

describe("doctor checks the weights the resolved profile names", () => {
  it("passes only when every named file is there", () => {
    const c = weightsCheck(report({ present: 2, probes: [], missing: [] }));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("/models");
  });

  it("fails when the models directory holds none of them", () => {
    const c = weightsCheck(
      report({
        missing: ["w"],
        probes: [{ modelId: "w", path: "/models/w.gguf", ok: false, detail: "not found" }],
      }),
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("/models/w.gguf");
  });

  it("warns, rather than failing, when nothing is configured yet", () => {
    const c = weightsCheck(report({ modelsDirExists: false }));
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/--models-dir/);
  });
});

// MD-N7-2, rule 5 (FINDINGS CFG-05): doctor checks each weights file's hash
// against the registered one, keeping each file's hash by path, size and
// modification time so a 13 GB file is read once.
describe("doctor checks the weights' hashes (MD-N7-2)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "doc-hash-"));
    dirs.push(dir);
    const reg = new ModelRegistry(join(dir, "models.json"));
    const file = join(dir, "w.gguf");
    writeFileSync(file, "weights");
    return { dir, reg, file, cachePath: join(dir, "model-hashes.json") };
  }

  it("passes when the file matches its registered SHA-256, and hashes it once", async () => {
    const { reg, file, cachePath } = setup();
    reg.recordWeights("nail-mtp", { path: file, volume: "internal", sha256: sha("weights") });
    let reads = 0;
    const hash = async (p: string) => {
      reads++;
      return createHash("sha256").update(readFileSync(p)).digest("hex");
    };
    const c = await weightsHashCheck({ registry: reg, cachePath, hash, files: [] });
    expect(c).toMatchObject({ name: "Weights' hashes", status: "pass" });
    expect(c.detail).toMatch(/1 model file matches its registered SHA-256/);
    await weightsHashCheck({ registry: reg, cachePath, hash, files: [] });
    expect(reads).toBe(1);
    // A changed file (size or time) is read again.
    writeFileSync(file, "weightz");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const changed = await weightsHashCheck({ registry: reg, cachePath, hash, files: [] });
    expect(reads).toBe(2);
    expect(changed.status).toBe("fail");
    expect(changed.detail).toMatch(
      /nail-mtp: the file's hash differs from the registered one \(.*w\.gguf\)\. Do: download it again on Configuration › Models, or run `sekhemet models fetch nail-mtp`\./,
    );
  });

  it("checks a managed file against the shipped hash, and says when there is nothing to check", async () => {
    const { reg, file, cachePath } = setup();
    const none = await weightsHashCheck({ registry: reg, cachePath, files: [] });
    expect(none).toMatchObject({ status: "pass" });
    expect(none.detail).toMatch(/no registered model file on this machine to check/);
    const c = await weightsHashCheck({
      registry: reg,
      cachePath,
      files: [{ modelId: "nail-mtp", path: file }],
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/nail-mtp: the file's hash differs/);
  });
});
