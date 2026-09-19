import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { ModelRegistry } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  airgapSelfTest,
  allowlistFromLockfiles,
  applyUpdate,
  buildMirror,
  buildModelManifest,
  exportDocBundle,
  importDocBundle,
  isAirgapped,
  mirrorRegistry,
  prefetchDocs,
  signBundle,
  verifyBundle,
  verifyModels,
} from "../src/airgap.js";
import { ResearchCache } from "../src/research/polite.js";

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
