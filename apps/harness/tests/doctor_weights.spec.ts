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
    const c = await weightsHashCheck({ registry: reg, cachePath, hash, files: [], verify: true });
    expect(c).toMatchObject({ name: "Weights' hashes", status: "pass" });
    expect(c.detail).toMatch(/1 model file matches its registered SHA-256/);
    await weightsHashCheck({ registry: reg, cachePath, hash, files: [], verify: true });
    expect(reads).toBe(1);
    // A changed file (size or time) is read again.
    writeFileSync(file, "weightz");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const changed = await weightsHashCheck({
      registry: reg,
      cachePath,
      hash,
      files: [],
      verify: true,
    });
    expect(reads).toBe(2);
    expect(changed.status).toBe("fail");
    expect(changed.detail).toMatch(
      /nail-mtp: the file's hash differs from the registered one \(.*w\.gguf\)/,
    );
    expect(changed.do).toBe(
      "download it again on Configuration › Models, or run `sekhemet models fetch nail-mtp`.",
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
      verify: true,
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/nail-mtp: the file's hash differs/);
  });

  it("SUR-89: without --verify-weights reads no file the cache does not hold, and names how many, how big and how long; with it, says how long it took", async () => {
    const { reg, file, cachePath } = setup();
    reg.recordWeights("nail-mtp", { path: file, volume: "internal", sha256: sha("weights") });
    let reads = 0;
    const hash = async (p: string) => {
      reads++;
      return createHash("sha256").update(readFileSync(p)).digest("hex");
    };
    const quiet = await weightsHashCheck({ registry: reg, cachePath, hash, files: [] });
    expect(reads).toBe(0);
    // Nothing was checked, so nothing passed (C4 review): a warning.
    expect(quiet.status).toBe("warn");
    expect(quiet.detail).toMatch(
      /^1 model file \(7 bytes\) not verified yet: reading it takes about 1 s; run `sekhemet doctor --verify-weights` to check it$/,
    );
    let t = 0;
    const asked = await weightsHashCheck({
      registry: reg,
      cachePath,
      hash,
      files: [],
      verify: true,
      now: () => {
        t += 2500;
        return t;
      },
    });
    expect(reads).toBe(1);
    expect(asked.detail).toBe("1 model file matches its registered SHA-256 (read in 3 s)");
    // Now in the cache: compared without being read, and without the flag.
    const cached = await weightsHashCheck({ registry: reg, cachePath, hash, files: [] });
    expect(reads).toBe(1);
    expect(cached.detail).toBe("1 model file matches its registered SHA-256");
    expect(cached.status).toBe("pass");
  });

  // C4 review: the cache is keyed by path, size and time, so a file replaced
  // after its verification missed the cache and was "not verified yet" with
  // status pass, where before it failed. The cheap signals are read without
  // reading the file: a size other than the verified file's, or the
  // registered size, cannot have the registered hash.
  it("SUR-89: without --verify-weights a file whose size differs from the verified one, or the registered one, fails unread", async () => {
    const { reg, file, cachePath } = setup();
    reg.recordWeights("nail-mtp", { path: file, volume: "internal", sha256: sha("weights") });
    let reads = 0;
    const hash = async (p: string) => {
      reads++;
      return createHash("sha256").update(readFileSync(p)).digest("hex");
    };
    expect(
      (await weightsHashCheck({ registry: reg, cachePath, hash, files: [], verify: true })).status,
    ).toBe("pass");
    // Truncated by a failed copy, after its verification.
    writeFileSync(file, "weig");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const truncated = await weightsHashCheck({ registry: reg, cachePath, hash, files: [] });
    expect(reads).toBe(1);
    expect(truncated.status).toBe("fail");
    expect(truncated.detail).toMatch(
      /nail-mtp: the file is 4 bytes, not the 7 bytes verified before, so its hash differs from the registered one \(.*w\.gguf\)/,
    );
    expect(truncated.do).toMatch(/^download it again/);
    // The registered size, with no verification ever made.
    const other = setup();
    other.reg.recordWeights("nail-mtp", {
      path: other.file,
      volume: "internal",
      sha256: sha("weights"),
    });
    other.reg.upsert("nail-mtp", { sizeBytes: 9 });
    const sized = await weightsHashCheck({
      registry: other.reg,
      cachePath: other.cachePath,
      hash,
      files: [],
    });
    expect(reads).toBe(1);
    expect(sized.status).toBe("fail");
    expect(sized.detail).toMatch(/nail-mtp: the file is 7 bytes, not the registered 9 bytes/);
  });

  it("SUR-89: a file rewritten at the same size since its verification warns, unread, and names it as changed", async () => {
    const { reg, file, cachePath } = setup();
    reg.recordWeights("nail-mtp", { path: file, volume: "internal", sha256: sha("weights") });
    let reads = 0;
    const hash = async (p: string) => {
      reads++;
      return createHash("sha256").update(readFileSync(p)).digest("hex");
    };
    await weightsHashCheck({ registry: reg, cachePath, hash, files: [], verify: true });
    writeFileSync(file, "weightz");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const c = await weightsHashCheck({ registry: reg, cachePath, hash, files: [] });
    expect(reads).toBe(1);
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/changed since it was verified/);
    expect(c.detail).toMatch(/sekhemet doctor --verify-weights/);
  });
});
