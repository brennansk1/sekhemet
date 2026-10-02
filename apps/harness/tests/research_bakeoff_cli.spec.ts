import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";

// `sekhemet research-bakeoff` from the command line (DS-N2-9, MD-N11-1..3):
// the command reaches `runResearchBakeoffCommand` over the repository's own
// ledger. No model is loaded: the run named is not on the ledger.
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("sekhemet research-bakeoff", () => {
  it("reads the repository's ledger and refuses a run it does not hold, exiting 1", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sek-rbo-cli-"));
    dirs.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    db.close();
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    const exits: (number | undefined)[] = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code);
      throw new Error("exit");
    }) as never);
    await expect(
      main(["research-bakeoff", "--adopt-from", "evt_missing", "--repo", repo]),
    ).rejects.toThrow("exit");
    expect(out.join("\n")).toContain("No recorded Research quality run evt_missing");
    expect(exits).toEqual([1]);
  });

  it("is listed in the developer help", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    await main(["dev", "--help"]);
    expect(out.join("\n")).toMatch(/research-bakeoff/);
  });
});
