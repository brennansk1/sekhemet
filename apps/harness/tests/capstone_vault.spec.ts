import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as grid from "../../../scripts/capstone/grid.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as score from "../../../scripts/capstone/score.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as vault from "../../../scripts/capstone/vault.mjs";

/**
 * The hidden suite's vault (W2b G4, CAPSTONE_SELECTION "Isolation for an
 * agentic run"): an AES-256 encrypted APFS disk image made with the system's
 * `hdiutil`, its passphrase random and kept only in a keychain whose access
 * list asks the person, mounted only to migrate and to score. Real `hdiutil`,
 * real `security`, a small temporary image and a temporary keychain file
 * (never the login keychain), both removed after each test.
 *
 * Reading a passphrase whose access list asks the person would show a dialog,
 * so the tests that mount give the test keychain's item one trusted
 * application (`/usr/bin/security`, `trustedApps`); the default, checked in
 * the first test, trusts none.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const VAULT_CLI = join(ROOT, "scripts", "capstone", "vault.mjs");
const SECURITY = "/usr/bin/security";

type Env = NodeJS.ProcessEnv & {
  SEKHEMET_CAPSTONE_HIDDEN: string;
  SEKHEMET_WEBBENCH_SRC: string;
  SEKHEMET_CAPSTONE_RUNS: string;
  SEKHEMET_CAPSTONE_VAULT_KEYCHAIN: string;
  TMPDIR: string;
};

const temps: string[] = [];
const keychains: string[] = [];
const images: string[] = [];

function detachAll(image: string): void {
  for (const at of grid.vaultAttachments(image) as { device: string }[])
    spawnSync("hdiutil", ["detach", at.device, "-force"], { encoding: "utf8" });
}

afterEach(() => {
  for (const i of images.splice(0)) if (existsSync(i)) detachAll(i);
  for (const k of keychains.splice(0)) spawnSync(SECURITY, ["delete-keychain", k]);
  for (const t of temps.splice(0)) {
    chmodSync(t, 0o700);
    rmSync(t, { recursive: true, force: true });
  }
});

/**
 * A stand-in `~/.sekhemet` under the temporary directory, with a keychain
 * file of its own (unlocked, never locking), and the vault's image beside
 * the sealed paths, where `vaultImage` puts it.
 */
function setup(): { env: Env; root: string; image: string; keychain: string } {
  const root = mkdtempSync(join(tmpdir(), "vault-test-"));
  temps.push(root);
  const dot = join(root, "home", ".sekhemet");
  mkdirSync(dot, { recursive: true });
  mkdirSync(join(root, "tmp"));
  const keychain = join(root, "test.keychain-db");
  const made = spawnSync(SECURITY, [
    "create-keychain",
    "-p",
    randomBytes(16).toString("hex"),
    keychain,
  ]);
  expect(made.status).toBe(0);
  keychains.push(keychain);
  expect(spawnSync(SECURITY, ["set-keychain-settings", keychain]).status).toBe(0);
  const env: Env = {
    ...process.env,
    SEKHEMET_CAPSTONE_HIDDEN: join(dot, "capstone-hidden"),
    SEKHEMET_WEBBENCH_SRC: join(dot, "webbench-src"),
    SEKHEMET_CAPSTONE_RUNS: join(root, "runs"),
    SEKHEMET_CAPSTONE_VAULT_KEYCHAIN: keychain,
    TMPDIR: join(root, "tmp"),
  };
  const image = grid.vaultImage(env);
  images.push(image);
  return { env, root, image, keychain };
}

/** The sealed material as it sits today: plain directories, one with a symlink and a mode-600 file. */
function plantSealed(env: Env): void {
  const hidden = env.SEKHEMET_CAPSTONE_HIDDEN;
  mkdirSync(join(hidden, "tests"), { recursive: true, mode: 0o700 });
  writeFileSync(join(hidden, "run.mjs"), "// the stand-in suite's runner\n");
  writeFileSync(join(hidden, "tests", "a.test.mjs"), "// sealed test\n", { mode: 0o600 });
  symlinkSync("tests/a.test.mjs", join(hidden, "first.mjs"));
  const wb = env.SEKHEMET_WEBBENCH_SRC;
  mkdirSync(join(wb, "projects", "fastify"), { recursive: true });
  writeFileSync(join(wb, "projects", "fastify", "tasks.jsonl"), '{"id":"task-1"}\n');
  mkdirSync(`${hidden}-scratch`, { mode: 0o700 });
}

const sealedPaths = (env: Env) => [
  env.SEKHEMET_CAPSTONE_HIDDEN,
  `${env.SEKHEMET_CAPSTONE_HIDDEN}-scratch`,
  env.SEKHEMET_WEBBENCH_SRC,
];

const readable = (p: string) => {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
};

function allFiles(dir: string, skip: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (p === skip) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const runPaths = (env: Env) => ({
  dir: join(env.SEKHEMET_CAPSTONE_RUNS, "claude-code-haiku", "1"),
});

describe.skipIf(process.platform !== "darwin")("the capstone vault", () => {
  it("create makes an AES-256 encrypted APFS image, its passphrase only in the keychain, where reading it asks the person", () => {
    const { env, image, keychain } = setup();
    const r = spawnSync(process.execPath, [VAULT_CLI, "create", "--size", "64m"], {
      env,
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(image);
    expect(existsSync(image)).toBe(true);
    const enc = spawnSync("hdiutil", ["isencrypted", image], { encoding: "utf8" });
    expect(enc.stdout).toMatch(/encrypted: YES/);
    // The access list: decrypting the passphrase trusts no application, so every read asks the person.
    const s = vault.vaultStatus({ env });
    expect(s).toMatchObject({
      image,
      exists: true,
      encrypted: true,
      passphraseStored: true,
      passphraseAsks: true,
      attachedAt: [],
    });
    const dump = spawnSync(SECURITY, ["dump-keychain", "-a", keychain], {
      encoding: "utf8",
    }).stdout;
    const item = dump.slice(dump.indexOf(`"svce"<blob>="${vault.KEYCHAIN_SERVICE}"`));
    expect(item).toMatch(
      /authorizations \(\d+\): decrypt[^\n]*\n(?:[^\n]*\n){0,3}\s+applications \(0\):/,
    );
    // Inside: the three sealed directories, mode 700, and the image is detached again.
    expect(grid.vaultAttachments(image)).toEqual([]);
    // A second create is refused: it would orphan the first image's passphrase.
    const again = spawnSync(process.execPath, [VAULT_CLI, "create", "--size", "64m"], {
      env,
      encoding: "utf8",
    });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already/);
    expect(vault.vaultStatus({ env }).passphraseStored).toBe(true);
  });

  it("migrate moves the sealed material in; the isolation check passes only while the vault is unmounted", () => {
    const { env, root, image, keychain } = setup();
    plantSealed(env);
    const before = sealedPaths(env).map((p) => vault.treeDigest(p));
    vault.createVault({ env, size: "64m", trustedApps: [SECURITY] });
    // Today's layout: the sealed paths are readable, so an agentic run is refused.
    expect(grid.isolationProblems(runPaths(env), env).join("\n")).toMatch(
      /hidden suite .* readable/,
    );

    const moved = vault.migrateVault({ env });
    expect(moved.map((m: { name: string }) => m.name).sort()).toEqual([
      "capstone-hidden",
      "capstone-hidden-scratch",
      "webbench-src",
    ]);
    for (const p of sealedPaths(env)) {
      expect(lstatSync(p).isSymbolicLink()).toBe(true);
      expect(resolve(join(p, ".."), readlinkSync(p)).startsWith(grid.vaultMountPoint(env))).toBe(
        true,
      );
      expect(readable(p)).toBe(false);
    }
    expect(grid.vaultAttachments(image)).toEqual([]);
    expect(grid.isolationProblems(runPaths(env), env)).toEqual([]);

    const at = vault.mountVault({ env });
    expect(at).toBe(grid.vaultMountPoint(env));
    expect(statSync(at).dev).not.toBe(statSync(join(at, "..")).dev);
    expect(sealedPaths(env).map((p) => vault.treeDigest(p))).toEqual(before);
    expect((statSync(at).mode & 0o777).toString(8)).toBe("700");
    const mounted = grid.isolationProblems(runPaths(env), env).join("\n");
    expect(mounted).toMatch(/vault .* is mounted/);
    expect(mounted).toMatch(/hidden suite .* readable/);
    expect(vault.vaultStatus({ env }).attachedAt).toEqual([at]);

    vault.unmountVault({ env });
    expect(grid.vaultAttachments(image)).toEqual([]);
    for (const p of sealedPaths(env)) expect(readable(p)).toBe(false);
    expect(grid.isolationProblems(runPaths(env), env)).toEqual([]);

    // The passphrase is in no file: not beside the image, not in the stand-in home, not in temp.
    const pass = spawnSync(
      SECURITY,
      ["find-generic-password", "-s", vault.KEYCHAIN_SERVICE, "-a", image, "-w", keychain],
      { encoding: "utf8" },
    ).stdout.trim();
    expect(pass.length).toBeGreaterThanOrEqual(43);
    for (const f of allFiles(root, keychain)) {
      if (f === image) continue;
      expect(readFileSync(f).includes(pass), f).toBe(false);
    }
    // The image is encrypted with AES-256 under that passphrase.
    const info = spawnSync("hdiutil", ["imageinfo", "-stdinpass", image], {
      input: pass,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(info.stdout).toMatch(/Encryption: AES-256/);
  });

  it("restore brings the material back out and removes the links: the rollback", () => {
    const { env } = setup();
    plantSealed(env);
    const before = sealedPaths(env).map((p) => vault.treeDigest(p));
    vault.createVault({ env, size: "64m", trustedApps: [SECURITY] });
    vault.migrateVault({ env });
    vault.restoreVault({ env });
    for (const p of sealedPaths(env)) {
      expect(lstatSync(p).isDirectory()).toBe(true);
      expect((lstatSync(p).mode & 0o777).toString(8)).toBe("700");
    }
    expect(sealedPaths(env).map((p) => vault.treeDigest(p))).toEqual(before);
    expect(grid.vaultAttachments(grid.vaultImage(env))).toEqual([]);
  });

  it("withVault mounts, runs, and unmounts in a finally block, also when the work fails", async () => {
    const { env, image } = setup();
    plantSealed(env);
    vault.createVault({ env, size: "64m", trustedApps: [SECURITY] });
    vault.migrateVault({ env });
    const seen = await vault.withVault(async () => readable(env.SEKHEMET_CAPSTONE_HIDDEN), { env });
    expect(seen).toBe(true);
    expect(grid.vaultAttachments(image)).toEqual([]);
    await expect(
      vault.withVault(
        async () => {
          throw new Error("the scoring failed");
        },
        { env },
      ),
    ).rejects.toThrow("the scoring failed");
    expect(grid.vaultAttachments(image)).toEqual([]);
  });

  it("the scorer mounts the vault to score and unmounts it after, even when scoring is refused", async () => {
    const { env, image } = setup();
    plantSealed(env);
    vault.createVault({ env, size: "64m", trustedApps: [SECURITY] });
    vault.migrateVault({ env });
    // The stand-in suite is not the frozen one: refused after the vault was mounted (unmounted, it would be "no hidden suite").
    await expect(
      score.scoreRun({ armId: "claude-code-haiku", run: 1, env, findingsToo: false }),
    ).rejects.toThrow(/not the frozen one/);
    expect(grid.vaultAttachments(image)).toEqual([]);
    expect(grid.isolationProblems(runPaths(env), env)).toEqual([]);
  });

  it("status on the command line says where things are, and withVault does nothing when the material is not in a vault", async () => {
    const { env } = setup();
    plantSealed(env);
    const r = spawnSync(process.execPath, [VAULT_CLI, "status"], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No vault/);
    expect(r.stdout).toMatch(/capstone-hidden: a plain directory, readable/);
    expect(await vault.withVault(async () => "ran", { env })).toBe("ran");
  });
});
