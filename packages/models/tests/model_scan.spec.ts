import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashModels, readGgufHeader, scanModelFolders } from "../src/model_scan.js";
import { suggestedModelFolders } from "../src/models_dir.js";
import { SMALL, ggufBytes, writeGguf } from "./support/gguf_fixture.js";

// MD-N12-1, MD-N12-2, MD-N13-1, SEC-N10-1, SEC-N10-2, MD-N12-8: the scan reads
// headers and sizes only, writes nothing, and says why it skipped a file.

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop() as string;
    chmodTree(d, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});

function chmodTree(d: string, mode: number): void {
  try {
    chmodSync(d, mode);
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) chmodTree(join(d, e.name), mode);
    }
  } catch {
    // gone already
  }
}

function snapshot(d: string): string {
  const h = createHash("sha256");
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(p, e.name);
      const st = statSync(full, { throwIfNoEntry: false });
      h.update(`${full}:${st?.size}:${st?.mtimeMs}\n`);
      if (e.isDirectory()) walk(full);
    }
  };
  walk(d);
  return h.digest("hex");
}

/** The MD-N12-1 fixture: a GGUF, a split GGUF, an mmproj, a safetensors directory and a truncated file. */
function libraryFixture(): string {
  const d = tmp("sek-scan-");
  writeGguf(join(d, "tiny-llama-Q4_K_M.gguf"), { ...SMALL, padBytes: 4096 });
  writeGguf(join(d, "big-00001-of-00002.gguf"), {
    ...SMALL,
    name: "Big Model 70B",
    architecture: "qwen2",
    fileType: 23,
    padBytes: 1000,
  });
  writeFileSync(join(d, "big-00002-of-00002.gguf"), Buffer.alloc(3000));
  writeGguf(join(d, "vision", "gemma-3-Q4_K_M.gguf"), {
    ...SMALL,
    name: "Gemma 3 4B",
    architecture: "gemma3",
  });
  writeGguf(join(d, "vision", "mmproj-gemma-3-f16.gguf"), { architecture: "clip", padBytes: 512 });
  mkdirSync(join(d, "Qwen3-8B"));
  writeFileSync(
    join(d, "Qwen3-8B", "config.json"),
    JSON.stringify({ model_type: "qwen3", max_position_embeddings: 40960 }),
  );
  writeFileSync(join(d, "Qwen3-8B", "model-00001-of-00002.safetensors"), Buffer.alloc(2048));
  writeFileSync(join(d, "Qwen3-8B", "model-00002-of-00002.safetensors"), Buffer.alloc(1024));
  writeFileSync(join(d, "broken.gguf"), ggufBytes(SMALL).subarray(0, 40));
  writeFileSync(join(d, "README.md"), "notes");
  return d;
}

describe("scanModelFolders (MD-N12-1, MD-N13-1)", () => {
  it("lists each model from its header in a read-only folder, and writes nothing there", async () => {
    const d = libraryFixture();
    chmodTree(d, 0o555);
    const before = snapshot(d);
    const scan = await scanModelFolders([{ path: d, source: "config", includeSubfolders: true }]);
    expect(snapshot(d)).toBe(before);

    const byFile = new Map(scan.models.map((m) => [m.file, m]));
    const tiny = byFile.get("tiny-llama-Q4_K_M.gguf");
    expect(tiny).toMatchObject({
      name: "Tiny Llama 1B",
      format: "gguf",
      quantisation: "Q4_K_M",
      contextLength: 32768,
      folder: d,
      hash: "pending",
      fits: {},
    });
    expect(tiny?.metadata.architecture).toBe("llama");
    expect(tiny?.sizeBytes).toBe(statSync(join(d, "tiny-llama-Q4_K_M.gguf")).size);

    // A split GGUF is one model with its parts, its size their sum.
    const big = byFile.get("big-00001-of-00002.gguf");
    expect(big?.parts).toEqual(["big-00001-of-00002.gguf", "big-00002-of-00002.gguf"]);
    expect(big?.quantisation).toBe("IQ3_XXS");
    expect(big?.sizeBytes).toBe(statSync(join(d, "big-00001-of-00002.gguf")).size + 3000);
    expect(byFile.has("big-00002-of-00002.gguf")).toBe(false);

    // A vision projector is its model's companion, not a model.
    const gemma = byFile.get(join("vision", "gemma-3-Q4_K_M.gguf"));
    expect(gemma?.companions?.map((c) => c.kind)).toEqual(["mmproj"]);
    expect([...byFile.keys()].some((f) => f.includes("mmproj"))).toBe(false);

    // A safetensors directory is one model, named by its directory; no engine serves it here.
    const st = byFile.get("Qwen3-8B");
    expect(st).toMatchObject({ format: "safetensors", name: "Qwen3-8B", contextLength: 40960 });
    expect(st?.sizeBytes).toBe(3072);
    expect(st?.noEngine).toMatch(/no engine here serves this format/);

    // The truncated file is listed as unreadable, with the reason.
    const broken = scan.skipped.find((s) => s.path.endsWith("broken.gguf"));
    expect(broken?.reason).toBe("unreadable");
    expect(broken?.detail).toBeTruthy();
    expect(scan.skipped.find((s) => s.path.endsWith("README.md"))?.reason).toBe("not_a_model");

    expect(scan.folders).toEqual([
      {
        path: d,
        source: "config",
        includeSubfolders: true,
        readable: true,
        modelCount: 4,
      },
    ]);
    expect(scan.truncated).toBe(false);
  });

  it("reads only the top level without Include subfolders, but still lists a model directory there", async () => {
    const d = libraryFixture();
    const scan = await scanModelFolders([{ path: d, source: "config", includeSubfolders: false }]);
    const files = scan.models.map((m) => m.file).sort();
    expect(files).toEqual(["Qwen3-8B", "big-00001-of-00002.gguf", "tiny-llama-Q4_K_M.gguf"]);
  });

  it("says why a folder cannot be read and lists nothing from it (DB-N6-3)", async () => {
    const scan = await scanModelFolders([
      { path: "/nonexistent/sekhemet-models", source: "env", includeSubfolders: false },
    ]);
    expect(scan.models).toEqual([]);
    expect(scan.folders[0]).toMatchObject({ readable: false, source: "env" });
    expect(scan.folders[0]?.error).toMatch(/does not exist|no such/i);
  });

  it("does not follow a symbolic link that leaves the folder (SEC-N10-1)", async () => {
    const outside = tmp("sek-outside-");
    writeGguf(join(outside, "secret.gguf"), SMALL);
    const d = tmp("sek-links-");
    writeGguf(join(d, "inside.gguf"), SMALL);
    symlinkSync(join(outside, "secret.gguf"), join(d, "escape.gguf"));
    symlinkSync(outside, join(d, "escape-dir"));
    symlinkSync(join(d, "inside.gguf"), join(d, "alias.gguf"));
    const scan = await scanModelFolders([{ path: d, source: "config", includeSubfolders: true }]);
    const skipped = scan.skipped.filter((s) => s.reason === "symlink_outside").map((s) => s.path);
    expect(skipped.sort()).toEqual([join(d, "escape-dir"), join(d, "escape.gguf")]);
    expect(scan.models.map((m) => m.file).sort()).toEqual(["alias.gguf", "inside.gguf"]);
  });

  it("skips an oversized header without reading on, and a file with an unknown extension (SEC-N10-2)", async () => {
    const d = tmp("sek-big-header-");
    writeGguf(join(d, "huge.gguf"), {
      ...SMALL,
      strings: { "general.description": "x".repeat(300_000) },
    });
    writeGguf(join(d, "fine.gguf"), SMALL);
    writeFileSync(join(d, "weights.bin"), Buffer.alloc(100));
    const scan = await scanModelFolders([{ path: d, source: "config", includeSubfolders: false }], {
      maxHeaderBytes: 64 * 1024,
    });
    expect(scan.skipped.find((s) => s.path.endsWith("huge.gguf"))?.reason).toBe("header_too_large");
    expect(scan.skipped.find((s) => s.path.endsWith("weights.bin"))?.reason).toBe("not_a_model");
    expect(scan.models.map((m) => m.file)).toEqual(["fine.gguf"]);
    await expect(
      readGgufHeader(join(d, "huge.gguf"), { maxHeaderBytes: 64 * 1024 }),
    ).rejects.toThrow(/16 MB|limit/);
  });

  it("stops at the depth and file-count limits and reports what it skipped (MD-N13-1)", async () => {
    const d = tmp("sek-limits-");
    writeGguf(join(d, "a", "b", "c", "deep.gguf"), SMALL);
    writeGguf(join(d, "a", "shallow.gguf"), SMALL);
    const shallow = await scanModelFolders(
      [{ path: d, source: "config", includeSubfolders: true }],
      { depth: 2 },
    );
    expect(shallow.models.map((m) => m.file)).toEqual([join("a", "shallow.gguf")]);
    expect(shallow.skipped.some((s) => s.reason === "depth_limit")).toBe(true);
    expect(shallow.depth).toBe(2);

    for (let i = 0; i < 5; i++) writeGguf(join(d, `m${i}.gguf`), SMALL);
    const limited = await scanModelFolders(
      [{ path: d, source: "config", includeSubfolders: false }],
      { fileLimit: 3 },
    );
    expect(limited.models.length).toBe(3);
    expect(limited.truncated).toBe(true);
    expect(limited.skipped.some((s) => s.reason === "file_limit")).toBe(true);
    expect(limited.fileLimit).toBe(3);
  });

  it("reports progress per folder", async () => {
    const d = libraryFixture();
    const seen: { folder: string; found: number; done: boolean }[] = [];
    await scanModelFolders([{ path: d, source: "config", includeSubfolders: true }], {
      onFolder: (p) => seen.push(p),
    });
    expect(seen.at(-1)).toEqual({ folder: d, found: 4, done: true });
  });
});

describe("hashModels (MD-N12-2)", () => {
  it("hashes after the listing and grades Verified, Hash differs and Not a registry model", async () => {
    const d = tmp("sek-hash-");
    const a = writeGguf(join(d, "a.gguf"), { ...SMALL, name: "A" });
    writeGguf(join(d, "b.gguf"), { ...SMALL, name: "B" });
    writeGguf(join(d, "c.gguf"), { ...SMALL, name: "C", padBytes: 10 });
    const scan = await scanModelFolders([{ path: d, source: "config", includeSubfolders: false }]);
    expect(scan.models.every((m) => m.hash === "pending")).toBe(true);
    const shaA = createHash("sha256")
      .update(ggufBytes({ ...SMALL, name: "A" }))
      .digest("hex");
    expect(
      createHash("sha256")
        .update(await import("node:fs").then((f) => f.readFileSync(a)))
        .digest("hex"),
    ).toBe(shaA);
    const hashed: string[] = [];
    const out = await hashModels(scan.models, {
      published: (m) =>
        m.name === "A"
          ? { registryId: "a", sha256: shaA }
          : m.name === "B"
            ? { registryId: "b", sha256: "0".repeat(64) }
            : undefined,
      onHashed: (m) => hashed.push(m.name),
    });
    const by = new Map(out.map((m) => [m.name, m]));
    expect(by.get("A")).toMatchObject({
      hash: "verified",
      verified: true,
      sha256: shaA,
      id: shaA,
      registryId: "a",
    });
    expect(by.get("B")).toMatchObject({ hash: "hash_differs", verified: false });
    expect(by.get("C")).toMatchObject({ hash: "not_registry" });
    expect(by.get("C")?.verified).toBeUndefined();
    expect(hashed.sort()).toEqual(["A", "B", "C"]);
  });
});

describe("suggestedModelFolders (MD-N12-8)", () => {
  it("suggests exactly the known locations that exist and are not yet configured", () => {
    const home = tmp("sek-home-");
    mkdirSync(join(home, ".ollama", "models"), { recursive: true });
    mkdirSync(join(home, ".cache", "huggingface", "hub"), { recursive: true });
    mkdirSync(join(home, ".lmstudio", "models"), { recursive: true });
    const envDir = tmp("sek-envdir-");
    const suggested = suggestedModelFolders({
      home,
      env: { SEKHEMET_MODELS_DIR: envDir },
      platform: "darwin",
      configured: [join(home, ".lmstudio", "models")],
    });
    expect(suggested.sort()).toEqual(
      [envDir, join(home, ".ollama", "models"), join(home, ".cache", "huggingface", "hub")].sort(),
    );
  });
});

describe("findRoleWeights (for the first run, SUR-49, DB-N6-2)", () => {
  it("reports per role the weights found in the models folder, reading only headers", async () => {
    const { findRoleWeights } = await import("../src/role_weights.js");
    const { MANAGED_MODEL_FILES } = await import("../src/llama_server.js");
    const d = tmp("sek-roles-");
    writeGguf(join(d, MANAGED_MODEL_FILES.worker), { ...SMALL, name: "Cyber Tiel" });
    writeGguf(join(d, "other", "unrelated-Q4_K_M.gguf"), SMALL);
    const found = await findRoleWeights({ modelsDir: d });
    expect(Object.keys(found)).toEqual(["worker"]);
    expect(found.worker?.name).toBe("Cyber Tiel");
    expect(found.worker?.sizeBytes).toBe(statSync(join(d, MANAGED_MODEL_FILES.worker)).size);
    expect(await findRoleWeights({ modelsDir: join(d, "missing") })).toEqual({});
  });
});
