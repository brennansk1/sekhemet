import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Upgrades keep a person's data (surface item 32, NEW-surface-4, SUR-43):
 * when a release renames a config key, the upgrade rewrites it in
 * `config.toml` after keeping the file as a backup, and `doctor` reports
 * each change. It runs where the ledger migrates (`initLocalKernel`), for the
 * project's and the person's configuration. Text-level, so a person's
 * comments and layout survive; a key already set under its new name is left
 * alone.
 */
export interface RenamedKey {
  section: string;
  from: string;
  to: string;
}

/** Every rename a release has made, oldest first. */
export const RENAMED_KEYS: readonly RenamedKey[] = [
  // T10 (B4.1 step 0): the hours reserved for the person, not "the hours".
  { section: "machine", from: "hours", to: "reserved_hours" },
];

interface UpgradeRecord {
  at: string;
  file: string;
  backup: string;
  changes: RenamedKey[];
}

const recordPath = (file: string) => join(dirname(file), "config.upgrades.json");

function readRecords(file: string): UpgradeRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(file), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as UpgradeRecord[]) : [];
  } catch {
    return [];
  }
}

/** The line range of `[section]`'s body in `lines`: after its header, up to the next header. */
function sectionRange(lines: readonly string[], section: string): [number, number] | undefined {
  const start = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] as string)) end++;
  return [start + 1, end];
}

/** A new backup name for `file`, stamped with the time (and a counter should two share it). */
function backupPath(file: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "");
  const base = join(dirname(file), `${basename(file)}.pre-upgrade-${stamp}`);
  let candidate = `${base}.bak`;
  for (let n = 2; existsSync(candidate); n++) candidate = `${base}-${n}.bak`;
  return candidate;
}

/** The renames `file` still needs, with its lines as they would be after them. */
function pendingRenames(file: string): { changes: RenamedKey[]; lines: string[] } {
  if (!existsSync(file)) return { changes: [], lines: [] };
  const lines = readFileSync(file, "utf8").split("\n");
  const changes: RenamedKey[] = [];
  for (const rename of RENAMED_KEYS) {
    const range = sectionRange(lines, rename.section);
    if (!range) continue;
    const keyAt = (key: string) => {
      for (let i = range[0]; i < range[1]; i++) {
        if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i] as string)) return i;
      }
      return -1;
    };
    const old = keyAt(rename.from);
    if (old === -1 || keyAt(rename.to) !== -1) continue;
    lines[old] = (lines[old] as string).replace(
      new RegExp(`^(\\s*)${rename.from}(\\s*=)`),
      `$1${rename.to}$2`,
    );
    changes.push(rename);
  }
  return { changes, lines };
}

/**
 * Whether `file` has a renamed key to rewrite: the start records the
 * rewrite of the user config as Sekhemet's own (`config/changed`, TEAM-44),
 * and only when there is one.
 */
export function configRenamesDue(file: string): RenamedKey[] {
  return pendingRenames(file).changes;
}

/** Rewrite renamed keys in one `config.toml`; a backup is written first when anything changes. */
export function upgradeConfigKeys(file: string): { changes: RenamedKey[]; backup?: string } {
  const { changes, lines } = pendingRenames(file);
  if (changes.length === 0) return { changes };
  const backup = backupPath(file);
  // Exclusive: an earlier upgrade's backup is never overwritten.
  copyFileSync(file, backup, constants.COPYFILE_EXCL);
  writeFileSync(file, lines.join("\n"));
  const records = readRecords(file);
  records.push({ at: new Date().toISOString(), file, backup, changes });
  writeFileSync(recordPath(file), `${JSON.stringify(records, null, 2)}\n`);
  return { changes, backup };
}

/** `doctor`'s line: every rename an upgrade made to these files, with its backup (SUR-43). */
export function configUpgradeCheck(files: readonly string[]): {
  name: string;
  status: "pass" | "warn";
  detail: string;
} {
  const made = files.flatMap((f) => readRecords(f).filter((r) => r.file === f));
  if (made.length === 0) {
    return { name: "Config upgrades", status: "pass", detail: "no renamed keys found" };
  }
  const detail = made
    .flatMap((r) =>
      r.changes.map(
        (c) => `${r.file}: [${c.section}] ${c.from} → ${c.to} (backup ${r.backup}, ${r.at})`,
      ),
    )
    .join("; ");
  return { name: "Config upgrades", status: "warn", detail };
}
