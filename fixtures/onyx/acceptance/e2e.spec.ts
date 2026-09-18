import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIO, runCli } from "../src/app.js";
import { decrypt } from "../src/crypto.js";
import type { CryptoEnvelope } from "../src/types.js";

const FAST = 1000;
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

/** End-to-end tests for card_onyx_8_e2e: the CLI wired to vault, injector and scanner. */
describe("onyx end to end", () => {
  let home: string;
  let work: string;
  let out: string[];
  let err: string[];
  let io: CliIO;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "onyx-home-"));
    work = mkdtempSync(join(tmpdir(), "onyx-work-"));
    out = [];
    err = [];
    io = {
      dbPath: join(home, "vault.db"),
      passphrase: "team-passphrase",
      cwd: work,
      iterations: FAST,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("stores, lists and reads back secrets", async () => {
    expect(await runCli(["set", "API_KEY", "sk_live_1"], io)).toBe(0);
    expect(await runCli(["set", "DB_URL", "postgres://x"], io)).toBe(0);
    expect(await runCli(["list"], io)).toBe(0);
    expect(await runCli(["get", "API_KEY"], io)).toBe(0);
    expect(out).toEqual(["set API_KEY", "set DB_URL", "API_KEY", "DB_URL", "sk_live_1"]);
    expect(err).toEqual([]);
  });

  it("returns 1 and reports a missing key on stderr", async () => {
    expect(await runCli(["get", "NOPE"], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["not found: NOPE"]);
  });

  it("returns 2 for a usage error without touching the vault", async () => {
    expect(await runCli(["frobnicate"], io)).toBe(2);
    expect(err).toEqual(["unknown command: frobnicate"]);
    expect(existsSync(io.dbPath)).toBe(false);
  });

  it("returns 1 with the error message when a key is invalid", async () => {
    expect(await runCli(["set", "bad-key", "v"], io)).toBe(1);
    expect(err).toEqual(["invalid key: bad-key"]);
  });

  it("injects secrets into a child process without writing them to disk", async () => {
    await runCli(["--project", "api", "set", "ONYX_TOKEN", "tok_123"], io);
    const code = await runCli(
      [
        "run",
        "--project",
        "api",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('token=' + process.env.ONYX_TOKEN)",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(out).toEqual(["set ONYX_TOKEN", "token=tok_123"]);
    expect(readdirSync(work)).toEqual([]);
  });

  it("propagates the child's exit code", async () => {
    const code = await runCli(["run", "--", process.execPath, "-e", "process.exit(7)"], io);
    expect(code).toBe(7);
  });

  it("isolates projects when running a child", async () => {
    await runCli(["--project", "api", "set", "ONLY_API", "yes"], io);
    await runCli(
      [
        "run",
        "--project",
        "web",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(String(process.env.ONLY_API))",
      ],
      io,
    );
    expect(out).toEqual(["set ONLY_API", "undefined"]);
  });

  it("exports an encrypted bundle that decrypts to the project's secrets", async () => {
    await runCli(["set", "A", "alpha"], io);
    await runCli(["set", "B", "beta"], io);
    expect(await runCli(["export", "team.onyx"], io)).toBe(0);
    expect(out[out.length - 1]).toBe("exported 2 secrets to team.onyx");

    const raw = readFileSync(join(work, "team.onyx"), "utf8");
    expect(raw.includes("alpha")).toBe(false);
    const envelope = JSON.parse(raw) as CryptoEnvelope;
    expect(JSON.parse(decrypt(envelope, "team-passphrase", FAST))).toEqual({
      A: "alpha",
      B: "beta",
    });
    expect(() => decrypt(envelope, "not-the-passphrase", FAST)).toThrow("decryption failed");
  });

  it("scans the git staging area and fails when a secret is staged", async () => {
    execFileSync("git", ["init", "-q"], { cwd: work });
    writeFileSync(join(work, "clean.txt"), "hello\n");
    writeFileSync(join(work, "config.env"), `REGION=us-east-1\nAWS_ACCESS_KEY_ID=${AWS_KEY}\n`);
    execFileSync("git", ["add", "clean.txt", "config.env"], { cwd: work });

    expect(await runCli(["scan"], io)).toBe(1);
    expect(out).toEqual(["config.env:2 aws-access-key"]);
  });

  it("passes the scan when only clean files are staged, ignoring unstaged secrets", async () => {
    execFileSync("git", ["init", "-q"], { cwd: work });
    writeFileSync(join(work, "clean.txt"), "hello\n");
    writeFileSync(join(work, "unstaged.env"), `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`);
    execFileSync("git", ["add", "clean.txt"], { cwd: work });

    expect(await runCli(["scan"], io)).toBe(0);
    expect(out).toEqual([]);
  });
});
