import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DISK_FULL_NEXT, DISK_FULL_WHAT, refusalOf, topLevelLines } from "../src/process_errors.js";

/**
 * Wave 9 B8 and B12 (sweep 5): one condition, a full disk, was said three
 * ways (`ENOSPC: no space left on device, write`, `database or disk is full`,
 * `disk I/O error`) with no step; and a validation refusal that reached the
 * top was printed as a crash (`sekhemet stopped: … details are in <log>`).
 * Both are item 18b's refusal: one `sekhemet:` line and a `Do:` line.
 */
describe("an error that reaches the top: a refusal is never a crash line", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A real SQLITE_FULL from a real database file at its page limit. */
  function sqliteFull(): unknown {
    const dir = mkdtempSync(join(tmpdir(), "full-"));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, "x.db"));
    db.exec("CREATE TABLE t(x)");
    db.exec("PRAGMA max_page_count = 3");
    try {
      for (let i = 0; i < 100; i++) db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(4000));
    } catch (err) {
      return err;
    } finally {
      db.close();
    }
    throw new Error("the page limit was never reached");
  }

  it("a full disk is said one way, whichever layer met it, with the step that frees it", () => {
    const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });
    for (const err of [sqliteFull(), enospc]) {
      expect(refusalOf(err)).toEqual({ what: DISK_FULL_WHAT, next: DISK_FULL_NEXT });
    }
    expect(DISK_FULL_NEXT).toMatch(/free some space/i);
  });

  it("an error named a refusal is a refusal, with its own next step when it carries one", () => {
    class RestoreRefused extends Error {
      constructor(m: string) {
        super(m);
        this.name = "RestoreRefused";
      }
    }
    expect(refusalOf(new RestoreRefused("No backup at /x"))).toEqual({ what: "No backup at /x" });
    const withNext = Object.assign(new Error("Nothing to erase"), {
      name: "EraseRefusal",
      next: "sekhemet export --ledger lists the event ids",
    });
    expect(refusalOf(withNext)).toEqual({
      what: "Nothing to erase",
      next: "sekhemet export --ledger lists the event ids",
    });
    // Anything else stays a crash.
    expect(refusalOf(new TypeError("x is undefined"))).toBeUndefined();
    expect(refusalOf("text")).toBeUndefined();
  });

  it("the lines printed: a refusal's two, else the crash line with its report", () => {
    expect(topLevelLines(sqliteFull(), "/r.log")).toEqual([
      `sekhemet: ${DISK_FULL_WHAT}`,
      `  Do: ${DISK_FULL_NEXT}`,
    ]);
    expect(topLevelLines(new Error("boom"), "/r.log")).toEqual([
      "sekhemet stopped: boom — details are in /r.log; run again with --debug to print them here.",
    ]);
  });
});
