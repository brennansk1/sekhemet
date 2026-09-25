import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_ITERATIONS, decrypt, encrypt } from "./crypto.js";
import { monotonicNow, openVaultDb } from "./db.js";
import type { CryptoEnvelope, SecretRecord, VaultConfig } from "./types.js";

const PROJECT = /^[a-z0-9][a-z0-9-]*$/;
const KEY = /^[A-Z_][A-Z0-9_]*$/;

function checkProject(project: string): void {
  if (!PROJECT.test(project)) throw new Error(`invalid project: ${project}`);
}

function checkKey(key: string): void {
  if (!KEY.test(key)) throw new Error(`invalid key: ${key}`);
}

/** Encrypted secrets per project, with an audit row for every operation. */
export class Vault {
  private readonly db: DatabaseSync;
  private readonly passphrase: string;
  private readonly iterations: number;
  private last: number;
  private open = true;

  constructor(config: VaultConfig) {
    this.db = openVaultDb(config.dbPath);
    this.passphrase = config.passphrase;
    this.iterations = config.iterations ?? DEFAULT_ITERATIONS;
    const row = this.db
      .prepare(
        "SELECT max(t) AS t FROM (SELECT max(created_at) AS t FROM projects UNION ALL SELECT max(updated_at) FROM secrets UNION ALL SELECT max(at) FROM audit_events)",
      )
      .get() as { t: number | null } | undefined;
    this.last = row?.t ?? 0;
  }

  private now(): number {
    this.last = monotonicNow(this.last);
    return this.last;
  }

  private audit(action: "set" | "get" | "list" | "delete", project: string, key: string | null) {
    this.db
      .prepare("INSERT INTO audit_events (action, project, key, at) VALUES (?, ?, ?, ?)")
      .run(action, project, key, this.now());
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  set(project: string, key: string, value: string): SecretRecord {
    checkProject(project);
    checkKey(key);
    return this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO projects (name, created_at) VALUES (?, ?)")
        .run(project, this.now());
      const envelope = JSON.stringify(encrypt(value, this.passphrase, this.iterations));
      const updatedAt = this.now();
      this.db
        .prepare(
          `INSERT INTO secrets (project_id, key, envelope_json, updated_at)
           VALUES ((SELECT id FROM projects WHERE name = ?), ?, ?, ?)
           ON CONFLICT (project_id, key) DO UPDATE SET
             envelope_json = excluded.envelope_json, updated_at = excluded.updated_at`,
        )
        .run(project, key, envelope, updatedAt);
      this.audit("set", project, key);
      return { project, key, value, updatedAt };
    });
  }

  get(project: string, key: string): string | undefined {
    this.audit("get", project, key);
    const row = this.db
      .prepare(
        "SELECT s.envelope_json AS e FROM secrets s JOIN projects p ON p.id = s.project_id WHERE p.name = ? AND s.key = ?",
      )
      .get(project, key) as { e: string } | undefined;
    if (!row) return undefined;
    return decrypt(JSON.parse(row.e) as CryptoEnvelope, this.passphrase, this.iterations);
  }

  list(project: string): string[] {
    this.audit("list", project, null);
    return (
      this.db
        .prepare(
          "SELECT s.key AS k FROM secrets s JOIN projects p ON p.id = s.project_id WHERE p.name = ? ORDER BY s.key",
        )
        .all(project) as { k: string }[]
    ).map((r) => r.k);
  }

  delete(project: string, key: string): boolean {
    this.audit("delete", project, key);
    const result = this.db
      .prepare(
        "DELETE FROM secrets WHERE key = ? AND project_id = (SELECT id FROM projects WHERE name = ?)",
      )
      .run(key, project);
    return Number(result.changes) > 0;
  }

  env(project: string): Record<string, string> {
    const rows = this.db
      .prepare(
        "SELECT s.key AS k, s.envelope_json AS e FROM secrets s JOIN projects p ON p.id = s.project_id WHERE p.name = ? ORDER BY s.key",
      )
      .all(project) as { k: string; e: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) {
      out[r.k] = decrypt(JSON.parse(r.e) as CryptoEnvelope, this.passphrase, this.iterations);
    }
    return out;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }
}
