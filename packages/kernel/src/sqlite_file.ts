import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * The file behind the main database, or undefined for an in-memory one.
 * `PRAGMA database_list` rather than `DatabaseSync#location()`, which Node
 * added only in 22.16 — above the supported floor of 22.13.
 */
export function databaseFile(db: DatabaseSync): string | undefined {
  const rows = db.prepare("PRAGMA database_list").all() as unknown as {
    name: string;
    file: string;
  }[];
  const file = rows.find((r) => r.name === "main")?.file;
  return file ? file : undefined;
}

/**
 * A consistent copy of the database (kernel rule 35's fallback, K-N4-5,
 * K-N7-4): `VACUUM INTO`, one read transaction that WAL writers do not
 * block. The online backup API is not used because `node:sqlite`'s
 * `backup()` was added in Node 22.16, above the 22.13 floor (Node's API
 * docs, checked in B3.1), and it is asynchronous while a database is opened
 * synchronously. The copy is compacted, so no free page of the source —
 * erased content included — reaches it.
 */
export function copyDatabase(db: DatabaseSync, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
}
