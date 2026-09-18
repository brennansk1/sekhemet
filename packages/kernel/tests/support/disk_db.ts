import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "../../src/schema.js";

/**
 * A real on-disk SQLite database in WAL mode, in its own temp directory
 * (DEFINITION_OF_DONE §2.A.1: no `:memory:` stand-ins for kernel storage).
 */
export interface DiskDb {
  db: DatabaseSync;
  dir: string;
  path: string;
  /** Close the connection (idempotent). */
  close(): void;
  /** Close and delete the directory. */
  dispose(): void;
}

export function openDiskDb(prefix = "sekhemet-kernel-"): DiskDb {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "events.db");
  const db = new DatabaseSync(path);
  initSchema(db);
  let open = true;
  const close = (): void => {
    if (open) {
      open = false;
      db.close();
    }
  };
  return {
    db,
    dir,
    path,
    close,
    dispose: () => {
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
