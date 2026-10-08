import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "./update_check.js";
import { userDir } from "./user_dir.js";

/**
 * *What's new* (surface item 34, NEW-surface-9, SUR-68; DEC-53 c5): the
 * first command at a terminal after an upgrade prints, once, the notes of
 * each version since the one last shown, read from the `CHANGELOG.md`
 * bundled with the package (Keep a Changelog), Security entries first and at
 * most 20 lines. No network request is made. Under `--json`, or with no
 * terminal, nothing is printed and nothing is recorded, so the note waits for
 * the next command at a terminal. The version last shown is kept in
 * `<user dir>/whats-new.json`; a first install records its version and
 * prints nothing (there is nothing it upgraded from).
 */

export const WHATS_NEW_MAX_LINES = 20;

/** The harness's own version, from its package.json (as `--version` prints it, SUR-13). */
export function installedVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The bundled changelog: beside `dist/` in the installed package
 * (`scripts/pack_npm.mjs` copies it there), or at the root of a checkout.
 */
export function bundledChangelog(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", "CHANGELOG.md"), join(here, "..", "..", "..", "CHANGELOG.md")])
    if (existsSync(p)) return readFileSync(p, "utf8");
  return undefined;
}

export interface ChangelogVersion {
  version: string;
  sections: { name: string; entries: string[] }[];
}

/** The released versions of a Keep a Changelog file, newest first; `[Unreleased]` is skipped. */
export function parseChangelog(text: string): ChangelogVersion[] {
  const out: ChangelogVersion[] = [];
  let version: ChangelogVersion | undefined;
  let section: { name: string; entries: string[] } | undefined;
  for (const line of text.split("\n")) {
    const v = /^## \[([^\]]+)\]/.exec(line);
    if (v) {
      section = undefined;
      version = /^\d+\.\d+\.\d+/.test(v[1] ?? "")
        ? { version: v[1] as string, sections: [] }
        : undefined;
      if (version) out.push(version);
      continue;
    }
    if (/^## /.test(line)) {
      version = undefined;
      section = undefined;
      continue;
    }
    const s = /^### (.+)$/.exec(line);
    if (s && version) {
      section = { name: (s[1] as string).trim(), entries: [] };
      version.sections.push(section);
      continue;
    }
    const e = /^- (.+)$/.exec(line);
    if (e && section) section.entries.push((e[1] as string).trim());
    else if (/^ {2,}\S/.test(line) && section?.entries.length)
      section.entries[section.entries.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

/** The note for the versions after `since` up to `current`: Security first, at most `max` lines. */
export function whatsNewLines(
  changelog: string,
  since: string,
  current: string,
  max = WHATS_NEW_MAX_LINES,
): string[] {
  const versions = parseChangelog(changelog).filter(
    (v) => compareVersions(v.version, since) > 0 && compareVersions(v.version, current) <= 0,
  );
  if (versions.length === 0) return [];
  const body: string[] = [];
  for (const v of versions) {
    const ordered = [
      ...v.sections.filter((s) => s.name.toLowerCase() === "security"),
      ...v.sections.filter((s) => s.name.toLowerCase() !== "security"),
    ];
    for (const s of ordered)
      for (const e of s.entries) body.push(`  ${v.version} · ${s.name}: ${e.replace(/\*\*/g, "")}`);
  }
  const head = `What's new since ${since} (from CHANGELOG.md; shown once):`;
  if (body.length + 1 <= max) return [head, ...body];
  const room = max - 2;
  return [
    head,
    ...body.slice(0, room),
    `  … and ${body.length - room} more: see CHANGELOG.md in the package`,
  ];
}

interface WhatsNewState {
  shown: string;
}

export function whatsNewStatePath(): string {
  return join(userDir(), "whats-new.json");
}

/**
 * Print the note when this is the first command at a terminal since an
 * upgrade (SUR-68). Never throws; returns the lines printed.
 */
export function showWhatsNew(
  opts: {
    json?: boolean;
    terminal?: boolean;
    version?: string;
    changelog?: string;
    statePath?: string;
    print?: (line: string) => void;
  } = {},
): string[] {
  try {
    const terminal = opts.terminal ?? process.stdout.isTTY === true;
    if (opts.json || !terminal) return [];
    const version = opts.version ?? installedVersion();
    const path = opts.statePath ?? whatsNewStatePath();
    let state: WhatsNewState | undefined;
    try {
      state = JSON.parse(readFileSync(path, "utf8")) as WhatsNewState;
    } catch {
      state = undefined;
    }
    if (state?.shown === version) return [];
    const lines =
      state && typeof state.shown === "string" && compareVersions(state.shown, version) < 0
        ? whatsNewLines(opts.changelog ?? bundledChangelog() ?? "", state.shown, version)
        : [];
    const print = opts.print ?? ((l: string) => console.log(l));
    for (const l of lines) print(l);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ shown: version } satisfies WhatsNewState)}\n`, {
      mode: 0o600,
    });
    return lines;
  } catch {
    return [];
  }
}
