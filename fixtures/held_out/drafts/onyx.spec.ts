import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIO, runCli } from "../src/app.js";

// HELD OUT (measurement T11, MS-T7-8): never shown to the Planner, Seshat or
// the Worker. Project-level checks of Onyx's promise — a local secrets vault
// that keeps secrets secret — that no card's acceptance test makes through
// the CLI. DRAFT until a person confirms it.

const SECRET = "sk_live_held_out_4a1f";

describe("held out: onyx as a whole", () => {
  let home: string;
  let work: string;
  let out: string[];
  let err: string[];
  const io = (passphrase = "team-passphrase"): CliIO => ({
    dbPath: join(home, "vault.db"),
    passphrase,
    cwd: work,
    iterations: 1000,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "onyx-held-home-"));
    work = mkdtempSync(join(tmpdir(), "onyx-held-work-"));
    out = [];
    err = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("never writes a secret to disk in the clear, in the database or its journal", async () => {
    expect(await runCli(["set", "API_KEY", SECRET], io())).toBe(0);
    for (const f of readdirSync(home)) {
      expect(
        readFileSync(join(home, f)).includes(Buffer.from(SECRET)),
        `${f} holds the secret`,
      ).toBe(false);
    }
  });

  it("does not reveal a secret to the wrong passphrase", async () => {
    await runCli(["set", "API_KEY", SECRET], io());
    out = [];
    const code = await runCli(["get", "API_KEY"], io("not-the-passphrase"));
    expect(code).not.toBe(0);
    expect(out.join("\n")).not.toContain(SECRET);
  });

  it("keeps projects apart: a secret set in one is not visible in another", async () => {
    await runCli(["--project", "billing", "set", "TOKEN", SECRET], io());
    out = [];
    expect(await runCli(["--project", "search", "list"], io())).toBe(0);
    expect(out).toEqual([]);
    expect(await runCli(["--project", "search", "get", "TOKEN"], io())).toBe(1);
  });
});
