import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * NEW-surface-4 — one install path per audience (surface item 31). SUR-41:
 * the npm package, packed by `scripts/pack_npm.mjs` from the built tree and
 * installed with no registry, reaches the first run with no other step.
 * SUR-42: the server image is built from that same package, and its
 * documentation names the identity proxy and the separate inference
 * container. Nothing is published.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SUR-41: the npm package reaches the first run with no other step", () => {
  it("packs every dependency, installs offline, and the bare sekhemet is the first run", () => {
    const work = mkdtempSync(join(tmpdir(), "sek-pack-"));
    dirs.push(work);
    const out = join(work, "out");
    const tarball = execFileSync(
      process.execPath,
      [join(ROOT, "scripts", "pack_npm.mjs"), "--out", out, "--offline"],
      { cwd: ROOT, encoding: "utf8", timeout: 240_000 },
    )
      .trim()
      .split("\n")
      .at(-1) as string;
    expect(tarball).toMatch(/sekhemet-\d+\.\d+\.\d+\.tgz$/);
    const manifest = JSON.parse(readFileSync(join(out, "stage", "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "sekhemet",
      bin: { sekhemet: "./dist/index.js" },
      engines: { node: ">=22.13.0" },
    });
    expect(manifest.bundleDependencies).toEqual(Object.keys(manifest.dependencies));
    const prefix = join(work, "prefix");
    // --offline: the tarball carries everything; no registry is reached.
    execFileSync(
      "npm",
      ["install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", tarball],
      { encoding: "utf8", timeout: 240_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const bin = join(prefix, "bin", "sekhemet");
    expect(existsSync(bin)).toBe(true);
    const repo = join(work, "repo");
    const home = join(work, "home");
    mkdirSync(repo);
    mkdirSync(home);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
      SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
      SEKHEMET_MODELS_DIR: join(home, "models"),
    };
    const first = spawnSync(bin, [], {
      cwd: repo,
      encoding: "utf8",
      input: "",
      env,
      timeout: 60_000,
    });
    // The first run of item 5: the paragraph, then no terminal to confirm in.
    expect(`${first.stdout}${first.stderr}`).toMatch(/No models found yet/);
    expect(`${first.stdout}${first.stderr}`).toMatch(/--yes/);
    expect(first.status).toBe(2);
    expect(readdirSync(repo)).toEqual([".git"]);
  }, 480_000);
});

describe("SUR-42: one server image, documented with its identity proxy and inference container", () => {
  it("builds the image from the same npm package and runs the engine in its own container", () => {
    const dockerfile = readFileSync(join(ROOT, "packaging", "server", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/node scripts\/pack_npm\.mjs --out \/pack/);
    expect(dockerfile).toMatch(/npm install --global --offline .*sekhemet-\*\.tgz/);
    expect(dockerfile).not.toMatch(/llama|ollama|vllm/i);
    const compose = readFileSync(join(ROOT, "packaging", "server", "compose.yaml"), "utf8");
    // MD-N15-2: one engine container per filled role's weights, not one shared engine.
    for (const role of ["coding", "planning", "research"])
      expect(compose).toMatch(new RegExp(`^ {2}engine-${role}:$`, "m"));
    expect(compose).not.toMatch(/^ {2}inference:$/m);
    expect(compose).toMatch(/^ {2}identity-proxy:$/m);
    expect(compose).toMatch(/^ {2}sekhemet:$/m);
    const doc = readFileSync(join(ROOT, "docs", "reference", "INSTALL.md"), "utf8");
    expect(doc).toMatch(/identity-aware proxy/);
    expect(doc).toMatch(/inference engines, one container per filled role/);
    expect(doc).toMatch(/trusted_proxies/);
  });

  // Review M5: the proxy published on 443 really terminates TLS, as
  // INSTALL.md says — an HTTPS listener with a certificate and key mounted,
  // and no plain HTTP listener published.
  it("the identity proxy terminates TLS on the published port, as INSTALL.md says", () => {
    const compose = readFileSync(join(ROOT, "packaging", "server", "compose.yaml"), "utf8");
    const proxy = compose.slice(compose.indexOf("  identity-proxy:"));
    expect(proxy).toMatch(/--https-address=0\.0\.0\.0:4443/);
    expect(proxy).toMatch(/--tls-cert-file=\/tls\/\S+/);
    expect(proxy).toMatch(/--tls-key-file=\/tls\/\S+/);
    expect(proxy).toMatch(/- <TLS certificate folder>:\/tls:ro/);
    expect(proxy).toMatch(/- "443:4443"/);
    expect(proxy).not.toMatch(/--http-address=0\.0\.0\.0/);
    expect(proxy).not.toMatch(/"443:4180"/);
    const doc = readFileSync(join(ROOT, "docs", "reference", "INSTALL.md"), "utf8");
    expect(doc).toMatch(/terminates TLS with the certificate and key/);
  });
});
