import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, homedir, hostname, platform, totalmem, userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactSecrets } from "@sekhemet/gates";
import { EventLog, type TomlTable, parseToml } from "@sekhemet/kernel";
import { resolveConfig, userConfigPath } from "./config.js";
import type { DoctorReport } from "./doctor.js";
import { effectiveLogLevel } from "./log_levels.js";
import { lostRecordsPath } from "./lost_records.js";
import { userDir } from "./user_dir.js";
import { holdsLedger, ledgerFacts, ledgerPathOf, workspaceFolderOf } from "./workspace_locator.js";

/**
 * `sekhemet doctor --report` (surface item 20f, NEW-surface-12: SUR-90;
 * FINDINGS_C1 REL-17, FINISH_LINE_PLAN B-16): a folder a person reads before
 * they choose to share it. It is written under
 * `<user dir>/reports/<workspace id>/report-<UTC time>/`, the folder 0700 and
 * every file 0600, and sends nothing: this module imports no network code.
 *
 * What goes in is chosen, not filtered: counts and shapes from the ledger
 * (never a title, text, diff or name), the settings each layer sets with
 * values only for numbers, booleans and closed choices, and the tails of the
 * diagnostic logs. Every text written then passes through the secret
 * redaction (security item 34) and a scrub of private fields: the home
 * folder, the workspace folder, each project root, the login, the host's
 * name, every email address, every string a `config.toml` sets, and every
 * string the ledger keeps in a private part or a card's title.
 */

export interface ReportEntry {
  file: string;
  what: string;
}

export interface ReportBundle {
  dir: string;
  contents: ReportEntry[];
}

/** Settings whose values are closed choices, shown as they are (item 20f). */
const CLOSED_CHOICES = new Set([
  "network.mode",
  "network.research",
  "team.mode",
  "machine.tier",
  "log.level",
]);

const DAEMON_LOG_LINES = 500;
const ERROR_REPORTS = 5;
/** Shorter strings are not scrubbed as private values: they would mangle ordinary words. */
const MIN_PRIVATE = 4;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every string value in a parsed TOML table or JSON value, walked deeply. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

function readToml(path: string): TomlTable | undefined {
  try {
    return parseToml(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The private values the ledger holds: private parts, card titles, project names and roots. */
function ledgerPrivateValues(workspaceFolder: string): { values: string[]; roots: string[] } {
  if (!holdsLedger(workspaceFolder)) return { values: [], roots: [] };
  const db = new DatabaseSync(ledgerPathOf(workspaceFolder), { readOnly: true });
  const values: string[] = [];
  let roots: string[] = [];
  const all = (sql: string): Record<string, unknown>[] => {
    try {
      return db.prepare(sql).all() as Record<string, unknown>[];
    } catch {
      return [];
    }
  };
  try {
    for (const row of all("SELECT body FROM event_private")) {
      try {
        strings(JSON.parse(String(row.body)), values);
      } catch {
        values.push(String(row.body));
      }
    }
    for (const row of all("SELECT title FROM cards")) values.push(String(row.title ?? ""));
    const projects = all("SELECT name, root_path FROM projects");
    for (const p of projects) values.push(String(p.name ?? ""));
    roots = projects.map((p) => String(p.root_path ?? "")).filter(Boolean);
  } finally {
    db.close();
  }
  return { values, roots };
}

/**
 * The scrub every text passes through after the secret redaction: paths
 * first (longest first, so a project inside the workspace is named as the
 * project), then the private values, the login, the host and email addresses.
 */
export function privateScrubber(input: {
  home: string;
  workspaceFolder?: string;
  projectRoots?: readonly string[];
  login?: string | undefined;
  host?: string;
  privateValues?: readonly string[];
}): (text: string) => string {
  const paths: [string, string][] = [];
  (input.projectRoots ?? []).forEach((r, i) => paths.push([r, `<project ${i + 1}>`]));
  if (input.workspaceFolder) paths.push([input.workspaceFolder, "<workspace>"]);
  if (input.home) paths.push([input.home, "~"]);
  paths.sort((a, b) => b[0].length - a[0].length);
  const values = [...new Set(input.privateValues ?? [])]
    .map((v) => v.trim())
    .filter((v) => v.length >= MIN_PRIVATE)
    .sort((a, b) => b.length - a.length);
  const host = input.host?.trim();
  const shortHost = host?.split(".")[0];
  const login = input.login?.trim();
  return (text: string) => {
    let t = text;
    for (const [p, name] of paths) if (p.length > 1) t = t.split(p).join(name);
    for (const v of values) t = t.split(v).join("<private>");
    if (host && host.length >= 3) t = t.split(host).join("<host>");
    if (shortHost && shortHost.length >= 3)
      t = t.replace(new RegExp(`\\b${escapeRegExp(shortHost)}\\b`, "g"), "<host>");
    if (login && login.length >= 3)
      t = t.replace(new RegExp(`\\b${escapeRegExp(login)}\\b`, "g"), "<user>");
    return t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
  };
}

/** The settings each layer sets, by dotted key, with values only for numbers, booleans and closed choices. */
function settingsOf(repoPath: string): Record<string, { layer: string; value: unknown }> {
  const resolved = resolveConfig({ repoPath });
  const layers: Record<string, TomlTable | undefined> = {
    user: readToml(userConfigPath()),
    project: readToml(join(repoPath, ".sekhemet", "config.toml")),
  };
  const out: Record<string, { layer: string; value: unknown }> = {};
  for (const [key, layer] of Object.entries(resolved.sources).sort()) {
    let raw: unknown = layers[layer];
    for (const part of key.split(".")) raw = (raw as Record<string, unknown> | undefined)?.[part];
    const value =
      typeof raw === "number" || typeof raw === "boolean"
        ? raw
        : typeof raw === "string" && CLOSED_CHOICES.has(key)
          ? raw
          : Array.isArray(raw)
            ? "<array>"
            : `<${typeof raw}>`;
    out[key] = { layer, value };
  }
  return out;
}

/** The ledger's counts: schema version, events, head, chain, cards by status and stop reason, events by type. */
function ledgerSummary(workspaceFolder: string): Record<string, unknown> {
  if (!holdsLedger(workspaceFolder)) return { present: false };
  const db = new DatabaseSync(ledgerPathOf(workspaceFolder), { readOnly: true });
  const counts = (sql: string): Record<string, number> => {
    try {
      return Object.fromEntries(
        (db.prepare(sql).all() as { k: string | null; n: number }[]).map((r) => [
          r.k ?? "(none)",
          r.n,
        ]),
      );
    } catch {
      return {};
    }
  };
  try {
    const schemaVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    const head = db.prepare("SELECT COUNT(*) AS n, MAX(seq) AS s FROM events").get() as {
      n: number;
      s: number | null;
    };
    let chainValid: boolean | string;
    try {
      const chain = new EventLog(db).verifyHashChainSync();
      chainValid = chain.valid ? true : (chain.reason ?? `broken at seq ${chain.corruptedSeq}`);
    } catch (err) {
      chainValid = `not verified: ${err instanceof Error ? err.message : String(err)}`;
    }
    return {
      present: true,
      schemaVersion,
      eventCount: head.n,
      headSeq: head.s ?? 0,
      chainValid,
      cardsByStatus: counts("SELECT status AS k, COUNT(*) AS n FROM cards GROUP BY status"),
      cardsByStopReason: counts(
        "SELECT stop_reason AS k, COUNT(*) AS n FROM cards WHERE stop_reason IS NOT NULL GROUP BY stop_reason",
      ),
      eventsByType: counts("SELECT type AS k, COUNT(*) AS n FROM events GROUP BY type"),
    };
  } finally {
    db.close();
  }
}

function tail(path: string, lines: number): string {
  try {
    const all = readFileSync(path, "utf8").split("\n");
    if (all.at(-1) === "") all.pop();
    return `${all.slice(-lines).join("\n")}\n`;
  } catch {
    return "";
  }
}

function newestErrorReports(logs: string, n: number): string {
  let names: string[];
  try {
    names = readdirSync(logs)
      .filter((f) => /^error-.*\.log$/.test(f))
      .sort()
      .slice(-n);
  } catch {
    return "";
  }
  return names
    .reverse()
    .map((f) => `=== ${f}\n${readFileSync(join(logs, f), "utf8")}`)
    .join("\n");
}

function harnessVersion(): string {
  try {
    return (
      (
        JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
          version?: string;
        }
      ).version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

/**
 * Write the report folder for `repoPath`'s workspace from a doctor report
 * already run, and return its path and table of contents (SUR-90).
 */
export function writeReportBundle(
  repoPath: string,
  report: DoctorReport,
  now: Date = new Date(),
): ReportBundle {
  const workspaceFolder = workspaceFolderOf(repoPath);
  let workspaceId: string | undefined;
  try {
    workspaceId = holdsLedger(workspaceFolder)
      ? ledgerFacts(workspaceFolder).workspaceId
      : undefined;
  } catch {
    workspaceId = undefined;
  }
  const ledger = ledgerPrivateValues(workspaceFolder);
  // Every string a config.toml sets, except the closed choices item 20f shows.
  const configValues = [userConfigPath(), join(repoPath, ".sekhemet", "config.toml")].flatMap(
    (p) => {
      const t = readToml(p) ?? {};
      const shown = [...CLOSED_CHOICES].map((k) =>
        k.split(".").reduce<unknown>((v, part) => (v as Record<string, unknown>)?.[part], t),
      );
      return strings(t).filter((v) => !shown.includes(v));
    },
  );
  let login: string | undefined;
  try {
    login = userInfo().username;
  } catch {
    login = undefined;
  }
  const scrub = privateScrubber({
    home: homedir(),
    workspaceFolder,
    projectRoots: [...new Set([repoPath, ...ledger.roots])].filter((r) => r !== workspaceFolder),
    login,
    host: hostname(),
    privateValues: [...ledger.values, ...configValues],
  });
  const clean = (text: string) => scrub(redactSecrets(text));

  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const dir = join(userDir(), "reports", workspaceId ?? "no-workspace", `report-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const resolved = resolveConfig({ repoPath });
  const logs = join(userDir(), "logs");
  const files: { entry: ReportEntry; text: string }[] = [
    {
      entry: { file: "doctor.json", what: "every check's name, status and detail" },
      text: JSON.stringify(
        { ok: report.ok, checks: report.checks.map((c) => ({ ...c })) },
        null,
        2,
      ),
    },
    {
      entry: {
        file: "environment.json",
        what: "versions, platform, memory, the log level, and which settings each config.toml sets (values only for numbers, booleans and closed choices)",
      },
      text: JSON.stringify(
        {
          sekhemet: harnessVersion(),
          node: process.version,
          platform: platform(),
          arch: arch(),
          memoryGB: Math.round(totalmem() / 1024 ** 3),
          cpus: cpus().length,
          logLevel: effectiveLogLevel(resolved.config.log.level),
          configLayers: resolved.layers,
          configParseErrors: resolved.parseErrors.map((e) => ({
            layer: e.layer,
            line: e.line,
            column: e.column,
            message: e.message,
          })),
          settings: settingsOf(repoPath),
        },
        null,
        2,
      ),
    },
    {
      entry: {
        file: "ledger.json",
        what: "the Activity log's schema version, counts, head and whether its chain verifies — no title, text or name",
      },
      text: JSON.stringify(ledgerSummary(workspaceFolder), null, 2),
    },
    {
      entry: {
        file: "daemon-log.txt",
        what: `the last ${DAEMON_LOG_LINES} lines of the server's log`,
      },
      text: tail(join(workspaceFolder, ".sekhemet", "daemon.log"), DAEMON_LOG_LINES),
    },
    {
      entry: { file: "errors.txt", what: `the ${ERROR_REPORTS} newest error reports` },
      text: newestErrorReports(logs, ERROR_REPORTS),
    },
    {
      entry: { file: "lost-records.txt", what: "the records that could not be written" },
      text: existsSync(lostRecordsPath(workspaceId))
        ? readFileSync(lostRecordsPath(workspaceId), "utf8")
        : "",
    },
  ];
  const contents: ReportEntry[] = [
    { file: "contents.txt", what: "this table of contents" },
    ...files.map((f) => f.entry),
  ];
  const write = (file: string, text: string) => {
    const path = join(dir, file);
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  write("contents.txt", clean(`${contentsLines(dir, contents).join("\n")}\n`));
  for (const f of files) write(f.entry.file, clean(f.text));
  // A folder the person reads: nothing else is in it.
  for (const name of readdirSync(dir))
    if (!contents.some((c) => c.file === name) && statSync(join(dir, name)).isFile())
      throw new Error(`unexpected file in the report: ${name}`);
  return { dir, contents };
}

/** The table of contents as printed and as `contents.txt` holds it. */
export function contentsLines(dir: string, contents: readonly ReportEntry[]): string[] {
  const width = Math.max(...contents.map((c) => c.file.length));
  return [
    `Report written to ${dir}`,
    ...contents.map((c) => `  ${c.file.padEnd(width)}  ${c.what}`),
    "Nothing was sent. Read it before you share it; it is yours to attach to an issue or not.",
  ];
}
