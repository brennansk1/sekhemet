import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initLocalKernel, main } from "../src/index.js";

/**
 * Wave 9 B7, B9, B11 (sweep 5): `replay` of an unknown issue is a refusal
 * (exit 1), `log`'s projection line counts the ledger's events, and a
 * deleted middle row is named at its own seq. In-process CLI on real SQLite
 * files (DEFINITION_OF_DONE §2A).
 */
describe("ledger commands say what they found", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function project(): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "ledger-msg-"));
    dirs.push(repo);
    const { db, cardStore } = initLocalKernel(repo);
    for (const id of ["s_a", "s_b", "s_c"])
      await cardStore.createCard({ id, tier: "story", title: id, scopeFiles: [`${id}.ts`] });
    db.close();
    return repo;
  }

  async function run(argv: string[]): Promise<{ out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    });
    const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.map(String).join(" "));
    });
    try {
      await main(argv);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    return { out: out.join("\n"), err: err.join("\n") };
  }

  const eventCount = (repo: string): number => {
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  it("replay of an issue no one filed exits 1 with where the IDs are listed", async () => {
    const repo = await project();
    const { out, err } = await run(["replay", "NOPE-1", "--repo", repo]);
    expect(out).not.toMatch(/No attempts recorded/);
    expect(err).toMatch(/^sekhemet: no issue NOPE-1/m);
    expect(err).toMatch(/^ {2}Do: /m);
    expect(process.exitCode).toBe(1);
  });

  it("replay of a real issue with no attempts still says so, exit 0", async () => {
    const repo = await project();
    const { out } = await run(["replay", "s_a", "--repo", repo]);
    expect(out).toMatch(/No attempts recorded for s_a/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("log's projection line names the ledger's own event count", async () => {
    const repo = await project();
    const { out } = await run(["log", "--repo", repo]);
    // Read after the command: whatever it recorded is in the count it replayed.
    const n = eventCount(repo);
    expect(out).toContain(`Projections: rebuilt from ${n} events, byte-identical.`);
  });

  it("log names a deleted middle row at its own seq", async () => {
    const repo = await project();
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    db.exec("DROP TRIGGER IF EXISTS events_no_delete");
    db.exec("DELETE FROM events WHERE seq = 2");
    db.close();
    const { out } = await run(["log", "--repo", repo]);
    expect(out).toMatch(/CORRUPTED at seq 2: seq 2 is missing/);
    expect(process.exitCode).toBe(1);
  });
});
