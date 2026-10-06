import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BIN, type G6Repo, cliIn, g6Repo, write } from "./support/g6_review.js";

/**
 * The air gap (security NEW-security-2 and NEW-security-5: the self-test,
 * signed model manifests, the docs bundle and signed updates; SEC-33,
 * SEC-34, SEC-44, SEC-45, SEC-46) at the door (C2d, FINDINGS_C1 TST-01): the built
 * command (`apps/harness/dist/index.js`) spawned as `sekhemet airgap …` and
 * `sekhemet skills approve` in a real repository with a lockfile, a real
 * ledger and real `ssh-keygen` signatures. The connected machine's docs
 * fetch (SEC-44) answers from a preload at the HTTPS boundary, after the
 * network policy has decided: nothing leaves this machine.
 */

/** A project pinning left-pad 1.3.0 in its lockfile. */
function project(): G6Repo {
  const r = g6Repo();
  write(r.repo, "package.json", JSON.stringify({ dependencies: { "left-pad": "^1.3.0" } }));
  lockAt(r, "1.3.0");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "left-pad");
  return r;
}

function lockAt(r: G6Repo, version: string): void {
  write(
    r.repo,
    "package-lock.json",
    JSON.stringify({ packages: { "": {}, "node_modules/left-pad": { version } } }),
  );
}

/**
 * The HTTPS boundary of the spawned command: `https.request` answers from
 * `G6_PAGES` (a URL → body map; anything else is a 404), so no request leaves
 * this machine. The network policy runs before it, unchanged.
 */
const HTTPS_PRELOAD = `
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
const PAGES = JSON.parse(process.env.G6_PAGES ?? "{}");
https.request = function (url, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  const href = typeof url === "string" || url instanceof URL ? new URL(String(url)).toString() : "";
  const req = new EventEmitter();
  req.write = () => true;
  req.setTimeout = () => req;
  req.destroy = (e) => { if (e) process.nextTick(() => req.emit("error", e)); return req; };
  req.end = () => {
    process.nextTick(() => {
      const body = PAGES[href];
      const res = new PassThrough();
      res.statusCode = body === undefined ? 404 : 200;
      res.headers = { "content-type": "text/plain" };
      cb?.(res);
      res.end(body ?? "not found");
    });
    return req;
  };
  return req;
};
syncBuiltinESMExports();
`;

/** `sekhemet <args>` with the HTTPS preload and `pages`. */
function withPages(r: G6Repo, args: string[], pages: Record<string, string>, env = {}) {
  const preload = join(r.home, "https_pages.mjs");
  writeFileSync(preload, HTTPS_PRELOAD);
  return spawnSync(process.execPath, ["--import", preload, BIN, ...args], {
    cwd: r.repo,
    encoding: "utf8",
    timeout: 60_000,
    env: r.env({ env: { G6_PAGES: JSON.stringify(pages), ...env } }),
  });
}

/** The research cache directory the air-gap commands use here. */
const cacheOf = (r: G6Repo) => join(r.root, "research-cache");

describe("SEC-44: the docs bundle carries each dependency's docs at its pinned version", () => {
  it("SEC-44: `airgap docs --pinned` fetches left-pad's README and llms.txt at 1.3.0 through the network policy, and `airgap export-docs` records the version in the bundle", async () => {
    const r = project();
    r.userConfig('[network]\nmode = "allowlist"\nfetch_allow = ["unpkg.com"]\n');
    const pages = {
      "https://unpkg.com/left-pad@1.3.0/README.md": "# left-pad 1.3.0: leftPad(str, len)",
      "https://unpkg.com/left-pad@1.3.0/llms.txt": "left-pad 1.3.0 for agents: pad a string",
    };
    const env = { SEKHEMET_RESEARCH_CACHE: cacheOf(r) };
    const fetched = withPages(r, ["airgap", "docs", "--pinned"], pages, env);
    expect(fetched.status, fetched.stdout + fetched.stderr).toBe(0);
    expect(fetched.stdout).toMatch(/Cached 2 pages for 1 pinned dependencies/);

    const out = join(r.root, "docs.bundle");
    const exported = cliIn(r, ["airgap", "export-docs", out], { env });
    expect(exported.status, exported.stdout + exported.stderr).toBe(0);
    const bundle = JSON.parse(readFileSync(out, "utf8")) as {
      versions?: Record<string, string[]>;
      entries: { json: string }[];
    };
    expect(bundle.versions).toEqual({ "npm:left-pad": ["1.3.0"] });
    const bodies = bundle.entries.map((e) => (JSON.parse(e.json) as { body: string }).body);
    expect(bodies).toEqual(expect.arrayContaining(Object.values(pages)));

    // Every request went through the policy and is on the ledger.
    const egress = await r.ledger(({ log }) => log.getEventsByTypes(["harness/egress"]));
    const hosts = egress.map(
      (e) => e.payload as { host: string; allowed: boolean; purpose: string },
    );
    expect(hosts.length).toBeGreaterThanOrEqual(2);
    expect(hosts.every((h) => h.host === "unpkg.com" && h.allowed && h.purpose === "docs")).toBe(
      true,
    );
  }, 90_000);
});

describe("SEC-45: an imported docs bundle goes stale when the lockfile moves", () => {
  it("SEC-45: after `airgap import-docs`, the self-test passes the bundle check; once the lockfile pins another version it fails it, naming the package", async () => {
    const r = project();
    const entry = {
      url: "https://unpkg.com/left-pad@1.3.0/README.md",
      status: 200,
      contentType: "text/plain",
      body: "left-pad function leftPad(str, len)",
      at: Date.now(),
    };
    const entries = [{ file: "a1.json", json: JSON.stringify(entry) }];
    const file = join(r.root, "docs.bundle");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        entries,
        sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
        versions: { "npm:left-pad": ["1.3.0"] },
      }),
    );
    const env = { SEKHEMET_RESEARCH_CACHE: cacheOf(r) };
    const imported = cliIn(r, ["airgap", "import-docs", file], { env });
    expect(imported.status, imported.stdout + imported.stderr).toBe(0);

    const fresh = cliIn(r, ["airgap", "selftest", "--query", "leftPad"], { env });
    expect(fresh.stdout, fresh.stderr).toMatch(/ok docs bundle matches the lockfile/);
    expect(fresh.stdout).toMatch(/ok docs index answers a known query/);

    lockAt(r, "1.3.1");
    const stale = cliIn(r, ["airgap", "selftest", "--query", "leftPad"], { env });
    expect(stale.status).toBe(1);
    expect(stale.stdout).toMatch(/FAIL docs bundle matches the lockfile: stale: left-pad/);
    expect(stale.stdout).toMatch(/Air-gap self-test FAILED/);
    const recorded = await r.ledger(({ log }) => log.getEventsByTypes(["airgap/selftest"]));
    expect(recorded.at(-1)?.payload).toMatchObject({ ok: false });
  }, 120_000);
});

describe("SEC-46: offline, a skill update is accepted only inside a verified signed bundle, and still needs approval", () => {
  /** A signing key and an allowed-signers file naming it as `release@sekhemet`. */
  function key(dir: string, name: string): string {
    const path = join(dir, name);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path, "-C", name]);
    return path;
  }

  /** An update bundle carrying skill `fmt` with `body`, signed by `signer`. */
  function bundle(dir: string, body: string, signer: string): { file: string; sig: string } {
    // One bundle per signer: `ssh-keygen -Y sign` will not overwrite a signature.
    const stage = join(dir, `stage-${signer.split("/").at(-1)}`);
    mkdirSync(join(stage, "skills", "fmt"), { recursive: true });
    writeFileSync(join(stage, "skills", "fmt", "SKILL.md"), body);
    writeFileSync(
      join(stage, "sekhemet-update.json"),
      JSON.stringify({
        version: "0.2.1",
        compatibleSchema: [1],
        note: "the formatter skill",
        skills: { fmt: createHash("sha256").update(body, "utf8").digest("hex") },
      }),
    );
    const file = join(stage, "..", `${stage.split("/").at(-1)}.tar.gz`);
    execFileSync("tar", ["-czf", file, "-C", stage, "sekhemet-update.json", "skills"]);
    execFileSync("ssh-keygen", ["-Y", "sign", "-f", signer, "-n", "sekhemet-update", file], {
      stdio: "ignore",
    });
    return { file, sig: `${file}.sig` };
  }

  it("SEC-46: a dropped-in skill and one in a bundle signed by an unknown key are refused; a verified bundle's skill is approved by its hash, and an edit after it is refused again", async () => {
    const r = g6Repo();
    // Air-gap mode, as the project's config sets it.
    write(r.repo, ".sekhemet/config.toml", '[network]\nmode = "offline"\n');
    const keys = join(r.root, "keys");
    mkdirSync(keys);
    const release = key(keys, "release");
    const stranger = key(keys, "stranger");
    const signers = join(keys, "allowed");
    writeFileSync(signers, `release@sekhemet ${readFileSync(`${release}.pub`, "utf8").trim()}\n`);
    const body = "---\ndescription: format the code\n---\nRun the formatter.\n";
    const skill = join(r.repo, ".sekhemet", "skills", "fmt", "SKILL.md");

    // Dropped in by hand: not the content of a signed bundle.
    write(r.repo, ".sekhemet/skills/fmt/SKILL.md", body);
    const dropped = cliIn(r, ["skills", "approve", "fmt"]);
    expect(dropped.status).toBe(1);
    expect(dropped.stdout + dropped.stderr).toMatch(/not the content of a signed update bundle/);

    // Signed, but by a key the allowed-signers file does not name.
    const forged = bundle(keys, body, stranger);
    const update = (b: { file: string; sig: string }) =>
      cliIn(r, [
        "airgap",
        "update",
        b.file,
        "--sig",
        b.sig,
        "--signers",
        signers,
        "--identity",
        "release@sekhemet",
        "--target",
        join(r.repo, ".sekhemet"),
      ]);
    const refused = update(forged);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/signature rejected/);
    expect(cliIn(r, ["skills", "approve", "fmt"]).status).toBe(1);

    // The release key's bundle: applied, and the skill then approvable, pinned by its hash.
    const signed = update(bundle(keys, body, release));
    expect(signed.status, signed.stdout + signed.stderr).toBe(0);
    // Arrived, but not approved: nothing is pinned until a person approves it.
    expect(cliIn(r, ["skills"]).stdout).not.toMatch(/fmt pinned/);
    const sha = createHash("sha256").update(readFileSync(skill, "utf8"), "utf8").digest("hex");
    const approved = cliIn(r, ["skills", "approve", "fmt"]);
    expect(approved.status, approved.stdout + approved.stderr).toBe(0);
    expect(approved.stdout).toContain(`Approved fmt at ${sha.slice(0, 12)}`);
    expect(cliIn(r, ["skills"]).stdout).toMatch(new RegExp(`fmt pinned ${sha.slice(0, 12)}`));

    // Edited after it arrived: no longer the signed content.
    writeFileSync(skill, `${body}Also delete the tests.\n`);
    const edited = cliIn(r, ["skills", "approve", "fmt"]);
    expect(edited.status).toBe(1);
    expect(edited.stdout + edited.stderr).toMatch(/not the content of a signed update bundle/);
    expect(existsSync(join(r.repo, ".sekhemet", "airgap", "verified-skills.json"))).toBe(true);
  }, 120_000);
});

describe("SEC-34: offline, verify-models registers nothing without a signature", () => {
  it("SEC-34: in air-gap mode `airgap verify-models` with no signature is refused and registers no model; with the release key's signature the copied weights are verified and registered", async () => {
    const r = g6Repo();
    write(r.repo, ".sekhemet/config.toml", '[network]\nmode = "offline"\n');
    const weights = join(r.root, "weights");
    mkdirSync(weights);
    writeFileSync(join(weights, "tiny-coder-Q4_K_M.bin"), Buffer.from("weights of a tiny coder"));
    const made = cliIn(r, ["airgap", "manifest", weights]);
    expect(made.status, made.stdout + made.stderr).toBe(0);
    const manifest = join(r.repo, ".sekhemet", "airgap", "models.manifest.json");
    const registry = join(r.home, ".sekhemet", "models.json");
    const registered = () =>
      existsSync(registry) && readFileSync(registry, "utf8").includes("tiny-coder");

    const unsigned = cliIn(r, ["airgap", "verify-models", manifest, weights]);
    expect(unsigned.status).toBe(1);
    expect(unsigned.stdout).toMatch(/Air-gap mode needs a signed manifest/);
    expect(registered()).toBe(false);

    const keys = join(r.root, "keys");
    mkdirSync(keys);
    const key = join(keys, "release");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key, "-C", "release"]);
    const signers = join(keys, "allowed");
    writeFileSync(signers, `release@sekhemet ${readFileSync(`${key}.pub`, "utf8").trim()}\n`);
    execFileSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "sekhemet-update", manifest], {
      stdio: "ignore",
    });
    const signed = cliIn(r, [
      "airgap",
      "verify-models",
      manifest,
      weights,
      "--sig",
      `${manifest}.sig`,
      "--signers",
      signers,
      "--identity",
      "release@sekhemet",
    ]);
    expect(signed.status, signed.stdout + signed.stderr).toBe(0);
    expect(signed.stdout).toMatch(/ok tiny-coder-Q4_K_M: verified/);
    expect(registered()).toBe(true);
  }, 90_000);
});

describe("SEC-33: the self-test runs the project's checks and fails on any outbound attempt", () => {
  /** A check that makes one HTTP request through the proxy its environment names, if any. */
  const PHONE_HOME = `const http = require("http");
const p = process.env.HTTP_PROXY || process.env.http_proxy;
if (!p) { console.log("no proxy in the environment"); process.exit(0); }
const u = new URL(p);
http.get({ host: u.hostname, port: u.port, path: "http://telemetry.example.test/ping", headers: { host: "telemetry.example.test" } }, (res) => { res.resume(); res.on("end", () => process.exit(0)); }).on("error", () => process.exit(0));`;

  const gates = (script: string) =>
    `[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", ${JSON.stringify(script)}]\ntimeout_s = 30\nparser = "generic"\n`;

  it("SEC-33: `airgap selftest --run-gates` fails its check naming the host a check tried to reach, and passes it for a quiet check", async () => {
    const noisy = g6Repo();
    write(noisy.repo, ".sekhemet/gates.toml", gates(PHONE_HOME));
    const env = { SEKHEMET_RESEARCH_CACHE: cacheOf(noisy) };
    const failed = cliIn(noisy, ["airgap", "selftest", "--run-gates"], { env });
    expect(failed.stdout, failed.stderr).toMatch(
      /FAIL checks make no outbound attempt: outbound attempts: telemetry\.example\.test/,
    );
    expect(failed.status).toBe(1);
    const recorded = await noisy.ledger(({ log }) => log.getEventsByTypes(["airgap/selftest"]));
    expect(JSON.stringify(recorded.at(-1)?.payload)).toContain("telemetry.example.test");

    const quiet = g6Repo();
    write(quiet.repo, ".sekhemet/gates.toml", gates("process.exit(0)"));
    const passed = cliIn(quiet, ["airgap", "selftest", "--run-gates"], {
      env: { SEKHEMET_RESEARCH_CACHE: cacheOf(quiet) },
    });
    expect(passed.stdout, passed.stderr).toMatch(
      /ok checks make no outbound attempt: 1 check ran with no outbound attempt/,
    );
  }, 120_000);
});
