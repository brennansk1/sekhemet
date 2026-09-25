import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { ModelRegistry } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  airgapCommand,
  airgapSelfTest,
  airgapSkillApproval,
  allowlistFromLockfiles,
  applyUpdate,
  approveVerifiedSkill,
  buildMirror,
  buildModelManifest,
  docsBundleStaleness,
  exportDocBundle,
  importDocBundle,
  isAirgapped,
  mirrorRegistry,
  prefetchDocs,
  prefetchPinnedDocs,
  signBundle,
  verifyBundle,
  verifyModels,
} from "../src/airgap.js";
import { ResearchCache } from "../src/research/polite.js";

/** A minimal GGUF v3 file: no tensors, one metadata key (the chat template). */
function ggufWithTemplate(template: string): Buffer {
  const str = (v: string) => {
    const b = Buffer.from(v, "utf8");
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(b.length));
    return Buffer.concat([len, b]);
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  return Buffer.concat([
    Buffer.from("GGUF"),
    u32(3),
    u64(0),
    u64(1),
    str("tokenizer.chat_template"),
    u32(8),
    str(template),
  ]);
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "SEKHEMET_AIRGAP");
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-airgap-"));
  dirs.push(d);
  return d;
};

describe("X10: package mirrors", () => {
  it("allowlists what the lockfiles pin, fills the store, and refuses unmirrored packages", async () => {
    const repo = tmp();
    writeFileSync(
      join(repo, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\npackages:\n\n  '@types/node@22.13.4':\n    resolution: {integrity: x}\n\n  vitest@3.2.7:\n    resolution: {integrity: y}\n\nsnapshots:\n\n  vitest@3.2.7(@types/node@22.13.4):\n    dependencies: {}\n",
    );
    writeFileSync(join(repo, "requirements.txt"), "requests==2.32.3\n# comment\n");
    writeFileSync(join(repo, "Cargo.lock"), '[[package]]\nname = "serde"\nversion = "1.0.200"\n');
    const a = allowlistFromLockfiles(repo);
    expect(a.npm).toEqual({ "@types/node": ["22.13.4"], vitest: ["3.2.7"] });
    expect(a.pypi).toEqual({ requests: ["2.32.3"] });
    expect(a.crates).toEqual({ serde: ["1.0.200"] });
    const calls: string[][] = [];
    const r = buildMirror(repo, {
      storeDir: "/tmp/store",
      run: (cmd, args) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual([["pnpm", "fetch", "--store-dir", "/tmp/store"]]);
    expect(r.packages).toBe(4);
    const reg = mirrorRegistry(repo);
    expect(await reg("vitest")).toEqual({ exists: true });
    expect(await reg("lodahs")).toEqual({ exists: false });
    expect(isAirgapped(repo)).toBe(false);
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "config.toml"), '[network]\nmode = "offline"\n');
    expect(isAirgapped(repo)).toBe(true);
  });
});

describe("X11: model manifest", () => {
  it("records sha256 and quant, verifies copied weights and registers only matches", async () => {
    const src = tmp();
    writeFileSync(join(src, "tiny-Q4_K_M.gguf"), "weights-a");
    writeFileSync(join(src, "other-IQ3_S.gguf"), "weights-b");
    const m = await buildModelManifest(src);
    expect(m.models.map((x) => `${x.id}:${x.quant}`)).toEqual([
      "other-IQ3_S:IQ3_S",
      "tiny-Q4_K_M:Q4_K_M",
    ]);
    const dst = tmp();
    writeFileSync(join(dst, "tiny-Q4_K_M.gguf"), "weights-a");
    writeFileSync(join(dst, "other-IQ3_S.gguf"), "tampered");
    const reg = new ModelRegistry(join(dst, "models.json"));
    const r = await verifyModels(m, dst, reg);
    expect(r.map((x) => `${x.id}:${x.ok}`)).toEqual(["other-IQ3_S:false", "tiny-Q4_K_M:true"]);
    expect(reg.get("tiny-Q4_K_M")?.quant).toBe("Q4_K_M");
    expect(reg.get("other-IQ3_S")).toBeUndefined();
  });
});

describe("NEW-security-2: the manifest in air-gap mode", () => {
  it("refuses to register models from an unsigned manifest in air-gap mode (SEC-34)", async () => {
    const src = tmp();
    writeFileSync(join(src, "tiny-Q4_K_M.gguf"), "weights-a");
    const manifest = join(src, "manifest.json");
    writeFileSync(manifest, JSON.stringify(await buildModelManifest(src)));
    const reg = new ModelRegistry(join(src, "models.json"));
    process.env.SEKHEMET_AIRGAP = "1";
    const out: string[] = [];
    const code = await airgapCommand(tmp(), ["verify-models", manifest, src], {
      registry: reg,
      print: (l) => out.push(l),
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/signature/i);
    expect(reg.get("tiny-Q4_K_M")).toBeUndefined();
  });

  it("refuses weights whose chat template differs from the manifest, naming it (SEC-34a)", async () => {
    const src = tmp();
    writeFileSync(join(src, "coder.safetensors"), "weights-a");
    writeFileSync(
      join(src, "tokenizer_config.json"),
      JSON.stringify({ chat_template: "{{ good }}" }),
    );
    const m = await buildModelManifest(src);
    expect(m.models[0]?.templateChecksum).toMatch(/^[0-9a-f]{64}$/);
    const dst = tmp();
    writeFileSync(join(dst, "coder.safetensors"), "weights-a");
    writeFileSync(
      join(dst, "tokenizer_config.json"),
      JSON.stringify({ chat_template: "{{ evil }}" }),
    );
    const reg = new ModelRegistry(join(dst, "models.json"));
    const r = await verifyModels(m, dst, reg);
    expect(r[0]?.ok).toBe(false);
    expect(r[0]?.detail).toMatch(/chat template.*tokenizer_config\.json/);
    expect(reg.get("coder")).toBeUndefined();
  });

  it("prefers chat_template.jinja and records 'none' so a template added later is caught (SEC-34a)", async () => {
    const src = tmp();
    writeFileSync(join(src, "coder.safetensors"), "weights-a");
    const m = await buildModelManifest(src);
    expect(m.models[0]?.templateChecksum).toBe("none");
    const dst = tmp();
    writeFileSync(join(dst, "coder.safetensors"), "weights-a");
    writeFileSync(join(dst, "tokenizer_config.json"), JSON.stringify({ chat_template: "{{ a }}" }));
    writeFileSync(join(dst, "chat_template.jinja"), "{{ added }}");
    const r = await verifyModels(m, dst);
    expect(r[0]?.ok).toBe(false);
    expect(r[0]?.detail).toMatch(/chat_template\.jinja/);
  });

  it("reads a GGUF model's embedded chat template for the manifest", async () => {
    const src = tmp();
    writeFileSync(join(src, "tiny-Q4_K_M.gguf"), ggufWithTemplate("{{ messages }}"));
    const m = await buildModelManifest(src);
    expect(m.models[0]?.templateChecksum).toBe(
      createHash("sha256").update("{{ messages }}", "utf8").digest("hex"),
    );
  });

  it("records the manifest's tier but still requires this machine's qualification (SEC-34b)", async () => {
    const src = tmp();
    writeFileSync(join(src, "tiny-Q4_K_M.gguf"), "weights-a");
    const m = await buildModelManifest(src);
    const model = m.models[0];
    if (model) model.tier = "worker";
    const reg = new ModelRegistry(join(src, "models.json"));
    await verifyModels(m, src, reg);
    expect(reg.get("tiny-Q4_K_M")?.manifestTier).toBe("worker");
    expect(reg.get("tiny-Q4_K_M")?.qualification).toBeUndefined();
  });
});

describe("X12: documentation bundles", () => {
  it("prefetches from the sitemap, exports and imports the cache with a checksum", async () => {
    const pages: Record<string, string> = {
      "https://docs.x.dev/robots.txt": "",
      "https://docs.x.dev/sitemap.xml":
        "<urlset><url><loc>https://docs.x.dev/guide/a</loc></url><url><loc>https://docs.x.dev/guide/b</loc></url></urlset>",
      "https://docs.x.dev/guide/a": "<h1>DatabaseSync prepare</h1>",
      "https://docs.x.dev/guide/b": "<h1>Statements</h1>",
    };
    const cacheDir = tmp();
    const r = await prefetchDocs(
      "https://docs.x.dev/guide/",
      async (u) => pages[u],
      new ResearchCache(cacheDir),
    );
    expect(r.pages).toBe(2);
    const bundle = join(tmp(), "docs.bundle.json");
    expect(exportDocBundle(cacheDir, bundle).entries).toHaveLength(2);
    const target = tmp();
    expect(importDocBundle(bundle, target)).toBe(2);
    expect(new ResearchCache(target).get("https://docs.x.dev/guide/a")?.body).toContain(
      "DatabaseSync",
    );
    const b = JSON.parse(readFileSync(bundle, "utf8"));
    b.entries[0].json = b.entries[0].json.replace("DatabaseSync", "Evil");
    writeFileSync(bundle, JSON.stringify(b));
    expect(() => importDocBundle(bundle, tmp())).toThrow(/checksum/);
  });
});

describe("X13: signed update bundles", () => {
  it("signs with ssh-keygen, refuses a tampered bundle, backs up the ledger and applies", () => {
    const dir = tmp();
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(dir, "key"),
      "-C",
      "release@sekhemet",
    ]);
    const pub = readFileSync(join(dir, "key.pub"), "utf8").trim();
    writeFileSync(join(dir, "allowed"), `release@sekhemet ${pub}\n`);
    const stage = join(dir, "stage");
    mkdirSync(stage);
    writeFileSync(
      join(stage, "sekhemet-update.json"),
      JSON.stringify({ version: "0.2.0", compatibleSchema: [1], note: "no schema change" }),
    );
    writeFileSync(join(stage, "payload.txt"), "new harness");
    const bundle = join(dir, "update.tar.gz");
    execFileSync("tar", ["-czf", bundle, "-C", stage, "sekhemet-update.json", "payload.txt"]);
    const sig = signBundle(bundle, join(dir, "key"));
    expect(verifyBundle(bundle, sig, join(dir, "allowed"), "release@sekhemet").ok).toBe(true);
    const repo = tmp();
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, ".sekhemet", "events.db"), "ledger");
    const target = join(dir, "installed");
    const r = applyUpdate(bundle, {
      sig,
      allowedSigners: join(dir, "allowed"),
      identity: "release@sekhemet",
      target,
      repo,
      schemaVersion: 1,
    });
    expect(r.applied).toBe(true);
    expect(existsSync(r.backup as string)).toBe(true);
    expect(readFileSync(join(target, "payload.txt"), "utf8")).toBe("new harness");
    expect(
      applyUpdate(bundle, {
        sig,
        allowedSigners: join(dir, "allowed"),
        identity: "release@sekhemet",
        target,
        repo,
        schemaVersion: 2,
      }).applied,
    ).toBe(false);
    writeFileSync(bundle, "tampered");
    expect(
      applyUpdate(bundle, {
        sig,
        allowedSigners: join(dir, "allowed"),
        identity: "release@sekhemet",
        target,
        repo,
        schemaVersion: 1,
      }).detail,
    ).toMatch(/signature rejected/);
  });
});

describe("X14: the air-gap self-test", () => {
  it("checks egress, gate commands and the doc index, and writes the audit log", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const cacheDir = tmp();
    new ResearchCache(cacheDir).set(
      "https://docs/x",
      200,
      "text/html",
      "prepare returns a StatementSync",
    );
    const r = await airgapSelfTest(tmp(), {
      log,
      gates: [
        { id: "unit", command: "node" },
        { id: "lint", command: "definitely-not-installed-linter" },
      ],
      cacheDir,
      knownQuery: "StatementSync",
    });
    const by = Object.fromEntries(r.checks.map((c) => [c.name, c.ok]));
    expect(by["gate unit runnable"]).toBe(true);
    expect(by["gate lint runnable"]).toBe(false);
    expect(by["docs index answers a known query"]).toBe(true);
    expect(typeof by["no outbound connections"]).toBe("boolean");
    expect(r.ok).toBe(false);
    const events = await log.getEventsByTypes(["airgap/selftest"]);
    expect(events).toHaveLength(1);
  }, 30_000);
});

describe("NEW-security-5: docs and skills that match the air-gapped project", () => {
  const project = () => {
    const repo = tmp();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { "left-pad": "^1.3.0" } }),
    );
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } }),
    );
    return repo;
  };

  it("bundles each dependency's docs and llms.txt at the pinned version, and records the versions (SEC-44)", async () => {
    const repo = project();
    const pages: Record<string, string> = {
      "https://unpkg.com/left-pad@1.3.0/README.md": "# left-pad 1.3.0",
      "https://unpkg.com/left-pad@1.3.0/llms.txt": "left-pad: pad a string",
    };
    const cacheDir = tmp();
    const r = await prefetchPinnedDocs(repo, async (u) => pages[u], new ResearchCache(cacheDir));
    expect(r.versions).toEqual({ "npm:left-pad": ["1.3.0"] });
    expect(r.pages).toBe(2);
    const out = join(tmp(), "docs.bundle");
    const bundle = exportDocBundle(cacheDir, out, { versions: r.versions });
    expect(bundle.versions).toEqual({ "npm:left-pad": ["1.3.0"] });
  });

  it("marks the imported bundle stale when the lockfile moves, naming the packages (SEC-45)", async () => {
    const repo = project();
    const cacheDir = tmp();
    const r = await prefetchPinnedDocs(repo, async () => "doc", new ResearchCache(cacheDir));
    const out = join(tmp(), "docs.bundle");
    exportDocBundle(cacheDir, out, { versions: r.versions });
    const imported = tmp();
    importDocBundle(out, imported);
    expect(docsBundleStaleness(repo, imported)).toEqual([]);
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "node_modules/left-pad": { version: "1.3.1" } } }),
    );
    expect(docsBundleStaleness(repo, imported)).toEqual(["left-pad"]);
    const t = await airgapSelfTest(repo, { cacheDir: imported, knownQuery: "doc" });
    const check = t.checks.find((c) => c.name === "docs bundle matches the lockfile");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/left-pad/);
  });

  it("accepts a skill offline only from a signed update bundle, and still needs its approval (SEC-46)", () => {
    const dir = tmp();
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(dir, "key"),
      "-C",
      "release@sekhemet",
    ]);
    writeFileSync(
      join(dir, "allowed"),
      `release@sekhemet ${readFileSync(join(dir, "key.pub"), "utf8").trim()}\n`,
    );
    const repo = tmp();
    const skills = join(repo, ".sekhemet", "skills");
    mkdirSync(join(skills, "fmt"), { recursive: true });
    const body = "---\ndescription: format\n---\nRun the formatter.\n";
    writeFileSync(join(skills, "fmt", "SKILL.md"), body);
    process.env.SEKHEMET_AIRGAP = "1";
    expect(airgapSkillApproval(repo, skills, "fmt").ok).toBe(false);
    // The same skill arrives in a signed bundle.
    const stage = join(dir, "stage");
    mkdirSync(join(stage, "skills", "fmt"), { recursive: true });
    writeFileSync(join(stage, "skills", "fmt", "SKILL.md"), body);
    const sha = createHash("sha256").update(body, "utf8").digest("hex");
    writeFileSync(
      join(stage, "sekhemet-update.json"),
      JSON.stringify({
        version: "0.2.1",
        compatibleSchema: [1],
        note: "skill",
        skills: { fmt: sha },
      }),
    );
    const bundle = join(dir, "update.tar.gz");
    execFileSync("tar", ["-czf", bundle, "-C", stage, "sekhemet-update.json", "skills"]);
    const sig = signBundle(bundle, join(dir, "key"));
    const r = applyUpdate(bundle, {
      sig,
      allowedSigners: join(dir, "allowed"),
      identity: "release@sekhemet",
      target: join(repo, ".sekhemet"),
      repo,
      schemaVersion: 1,
    });
    expect(r.applied).toBe(true);
    expect(airgapSkillApproval(repo, skills, "fmt").ok).toBe(true);
    // Edited after it arrived: no longer the signed content.
    writeFileSync(join(skills, "fmt", "SKILL.md"), `${body}Also delete the tests.\n`);
    expect(airgapSkillApproval(repo, skills, "fmt").ok).toBe(false);
  });
});

describe("SEC-46: approving pins only the verified content (B1 re-review)", () => {
  it("keeps the earlier pin when the skill changed between check and approval", () => {
    const repo = tmp();
    const skills = join(repo, ".sekhemet", "skills");
    const lockPath = join(repo, ".sekhemet", "skills.lock.json");
    mkdirSync(join(skills, "fmt"), { recursive: true });
    writeFileSync(join(skills, "fmt", "SKILL.md"), "v1\n");
    const first = approveVerifiedSkill(skills, "fmt", lockPath, undefined);
    expect(first.ok).toBe(true);
    const before = readFileSync(lockPath, "utf8");
    // Edited after the air-gap check verified some other content.
    writeFileSync(join(skills, "fmt", "SKILL.md"), "v2\n");
    const r = approveVerifiedSkill(skills, "fmt", lockPath, "0".repeat(64));
    expect(r.ok).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe(before);
  });

  it("leaves no lock behind when there was none", () => {
    const repo = tmp();
    const skills = join(repo, ".sekhemet", "skills");
    const lockPath = join(repo, ".sekhemet", "skills.lock.json");
    mkdirSync(join(skills, "fmt"), { recursive: true });
    writeFileSync(join(skills, "fmt", "SKILL.md"), "v1\n");
    expect(approveVerifiedSkill(skills, "fmt", lockPath, "0".repeat(64)).ok).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("NEW-security-2: the self-test watches a card's own commands (SEC-33)", () => {
  it("fails when the project's gates make any outbound attempt, and names the host", async () => {
    const repo = tmp();
    const noisy = await airgapSelfTest(repo, {
      gateRuns: [
        {
          id: "phones-home",
          command: "curl",
          args: ["-s", "--max-time", "3", "http://telemetry.example.com/ping"],
        },
      ],
    });
    const check = noisy.checks.find((c) => c.name === "gates make no outbound attempt");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/telemetry\.example\.com/);
    const quiet = await airgapSelfTest(repo, {
      gateRuns: [{ id: "unit", command: process.execPath, args: ["-e", "process.exit(0)"] }],
    });
    expect(quiet.checks.find((c) => c.name === "gates make no outbound attempt")?.ok).toBe(true);
  }, 30_000);
});

describe("B1 review: pinned docs and the self-test prove what they claim", () => {
  it("records no version for a package whose docs were not fetched, and flags new dependencies", async () => {
    const repo = tmp();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { "left-pad": "^1.3.0", "right-pad": "^1.0.0" } }),
    );
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/left-pad": { version: "1.3.0" },
          "node_modules/right-pad": { version: "1.0.0" },
        },
      }),
    );
    const cacheDir = tmp();
    const r = await prefetchPinnedDocs(
      repo,
      async (u) => (u.includes("left-pad") && u.endsWith("README.md") ? "# left-pad" : undefined),
      new ResearchCache(cacheDir),
    );
    expect(r.versions).toEqual({ "npm:left-pad": ["1.3.0"] });
    expect(r.missing).toEqual(["right-pad"]);
    const out = join(tmp(), "d.bundle");
    exportDocBundle(cacheDir, out, { versions: r.versions });
    const imported = tmp();
    importDocBundle(out, imported);
    expect(docsBundleStaleness(repo, imported)).toEqual(["right-pad"]);
  });

  it("does not keep flagging docs that could not be fetched, and flags new Python dependencies", async () => {
    const repo = tmp();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { "right-pad": "^1.0.0" } }),
    );
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/right-pad": { version: "1.0.0" } } }),
    );
    const cacheDir = tmp();
    const r = await prefetchPinnedDocs(repo, async () => undefined, new ResearchCache(cacheDir));
    expect(r.unavailable).toEqual({ "npm:right-pad": ["1.0.0"] });
    const out = join(tmp(), "d.bundle");
    exportDocBundle(cacheDir, out, { versions: r.versions, unavailable: r.unavailable });
    const imported = tmp();
    importDocBundle(out, imported);
    expect(docsBundleStaleness(repo, imported)).toEqual([]);
    // A new version of the unfetchable package is worth trying again.
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/right-pad": { version: "1.1.0" } } }),
    );
    expect(docsBundleStaleness(repo, imported)).toEqual(["right-pad"]);
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/right-pad": { version: "1.0.0" } } }),
    );
    // A Python dependency added after the bundle was built has no docs in it.
    writeFileSync(
      join(repo, "poetry.lock"),
      '[[package]]\nname = "requests"\nversion = "2.32.3"\n',
    );
    expect(docsBundleStaleness(repo, imported)).toEqual(["requests"]);
  });

  it("does not flag a removed dependency, and survives a corrupt bundle record", () => {
    const repo = tmp();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ packages: {} }));
    const imported = tmp();
    writeFileSync(
      join(imported, ".bundle-meta"),
      JSON.stringify({ versions: { "npm:left-pad": ["1.3.0"] } }),
    );
    expect(docsBundleStaleness(repo, imported)).toEqual([]);
    writeFileSync(join(imported, ".bundle-meta"), "{not json");
    expect(docsBundleStaleness(repo, imported)).toEqual([]);
  });

  it("reads poetry.lock and uv.lock", () => {
    const repo = tmp();
    writeFileSync(
      join(repo, "poetry.lock"),
      '[[package]]\nname = "Requests"\nversion = "2.32.3"\n',
    );
    writeFileSync(join(repo, "uv.lock"), '[[package]]\nname = "httpx"\nversion = "0.28.1"\n');
    const a = allowlistFromLockfiles(repo);
    expect(a.pypi).toMatchObject({ requests: ["2.32.3"], httpx: ["0.28.1"] });
  });

  it("does not claim a gate made no outbound attempt when it never ran", async () => {
    const t = await airgapSelfTest(tmp(), {
      gateRuns: [{ id: "missing", command: "definitely-not-a-command-xyz", args: [] }],
    });
    const check = t.checks.find((c) => c.name === "gates make no outbound attempt");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/not proven/);
  });
});
