import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/index.js";

/**
 * The connection pragmas (K23, design §2098-2101), against a real file.
 *
 * `:memory:` cannot show any of this: WAL and lock contention only exist
 * once two connections share a file on disk, which is exactly the situation
 * the pragmas are there for — the dashboard, the CLI and the card loop all
 * writing to `.sekhemet/events.db` at once.
 */
describe("@sekhemet/kernel connection pragmas on a real database file (K23)", () => {
  let dir: string;
  /** Every connection opens the same file on disk; that is the whole point. */
  const open = () => new DatabaseSync(join(dir, "events.db"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kernel-pragmas-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens in WAL with a five-second busy timeout", () => {
    const db = open();
    initSchema(db);

    const pragma = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];
    expect(String(pragma("journal_mode")).toLowerCase()).toBe("wal");
    expect(Number(pragma("busy_timeout"))).toBe(5000);
    expect(Number(pragma("foreign_keys"))).toBe(1);

    db.close();
  });

  it("waits for a concurrent writer instead of failing instantly", () => {
    const holder = open();
    initSchema(holder);
    const waiter = open();
    initSchema(waiter);
    // The same wait, shortened: a 5000 ms proof would cost the suite five
    // seconds to observe a behaviour a few hundred milliseconds shows.
    waiter.exec("PRAGMA busy_timeout = 400");

    holder.exec("BEGIN IMMEDIATE");
    holder.exec(
      "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('proj_h', 'h', '/h', '', '')",
    );

    const started = Date.now();
    expect(() =>
      waiter.exec(
        "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('proj_w', 'w', '/w', '', '')",
      ),
    ).toThrow();
    const waited = Date.now() - started;

    // Without the pragma this returns SQLITE_BUSY at once; with it, the
    // writer sits on the lock for its whole timeout before giving up.
    expect(waited).toBeGreaterThanOrEqual(350);

    holder.exec("ROLLBACK");
    // Once the lock is gone the same write goes through on the next try.
    waiter.exec(
      "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('proj_w', 'w', '/w', '', '')",
    );
    expect(waiter.prepare("SELECT COUNT(*) AS n FROM projects").get()).toMatchObject({ n: 1 });

    holder.close();
    waiter.close();
  });

  it("waits out a lock another process holds while the connection is being opened (RUN-2)", async () => {
    // The race RUN-2 met: two `queue` processes open the same ledger at the
    // same moment and one is still recovering the WAL index (SQLITE_BUSY_RECOVERY)
    // when the other runs the connection pragmas. Every pragma before the busy
    // timeout ran with no busy handler, so `journal_mode = WAL` failed at once.
    // Here another process holds the file exclusively for a moment instead.
    const file = join(dir, "events.db");
    const first = open();
    initSchema(first);
    first.close();
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(file)});
db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('proj_x', 'x', '/x', '', ''); COMMIT;");
process.stdout.write("held\\n");
setTimeout(() => db.close(), 500);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise((ok) => holder.once("exit", ok));
    await new Promise((ok) => holder.stdout?.once("data", ok));

    const opener = open();
    const started = Date.now();
    expect(() => initSchema(opener)).not.toThrow();
    // It waited for the other process rather than failing at once.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(opener.prepare("SELECT COUNT(*) AS n FROM projects").get()).toMatchObject({ n: 1 });
    opener.close();
    await exited;
  });
});
