import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { SkillsRegistry } from "@sekhemet/context";
import { type TomlTable, parseToml } from "@sekhemet/kernel";
import { userPaths } from "./user_dir.js";

/**
 * Workspace trust (security.md items 38–40, S9; SEC-28 to SEC-31).
 *
 * Repository-supplied configuration that makes the harness run code outside
 * the sandbox — `.sekhemet/hooks.toml`, `.sekhemet/mcp.json` and skill
 * `scripts/` — is inert until the person trusts it. Trust is recorded in the
 * user directory, never in the repository, keyed by the repository's real
 * path and the SHA-256 of each trusted file; a changed file is untrusted
 * again, including after an Accept merges a Worker's edit to it. Nothing is
 * ever trusted implicitly: `sekhemet dev trust` shows exactly what would run
 * and records the person's yes, and `--trust` trusts for one invocation
 * only. A trust file or skills lock the repository ships is never read for a
 * trust decision (SEC-31).
 */

export interface TrustRecord {
  version: 1;
  /** Real repository path → trusted files (repository-relative) → their SHA-256. */
  repos: Record<string, { files: Record<string, { sha256: string; at: string; by: string }> }>;
}

/** The user directory's trust store (`SEKHEMET_TRUST_DIR` overrides it, for tests; SUR-25). */
export function trustDir(): string {
  return process.env.SEKHEMET_TRUST_DIR ?? userPaths().trust;
}

const trustFile = () => join(trustDir(), "workspaces.json");

function realRepo(repoPath: string): string {
  try {
    return realpathSync(repoPath);
  } catch {
    return repoPath;
  }
}

function readTrust(): TrustRecord {
  try {
    const t = JSON.parse(readFileSync(trustFile(), "utf8")) as TrustRecord;
    return t.version === 1 && t.repos ? t : { version: 1, repos: {} };
  } catch {
    return { version: 1, repos: {} };
  }
}

function writeTrust(t: TrustRecord): void {
  mkdirSync(trustDir(), { recursive: true, mode: 0o700 });
  const tmp = `${trustFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, trustFile());
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

let invocationTrust = false;

/** `--trust` on this invocation (item 40): trusted for this process only, never recorded. */
export function setInvocationTrust(on: boolean): void {
  invocationTrust = on;
}

/**
 * Every trust-gated file the repository holds, repository-relative: the
 * hooks file, the project's MCP servers, and every file under a skill's
 * `scripts/` directory.
 */
export function gatedFiles(repoPath: string): string[] {
  const out: string[] = [];
  for (const rel of [join(".sekhemet", "hooks.toml"), join(".sekhemet", "mcp.json")]) {
    if (existsSync(join(repoPath, rel))) out.push(rel);
  }
  const skills = join(repoPath, ".sekhemet", "skills");
  if (existsSync(skills)) {
    for (const skill of readdirSync(skills).sort()) {
      const scripts = join(skills, skill, "scripts");
      if (existsSync(scripts) && statSync(scripts).isDirectory()) {
        for (const f of walk(scripts)) out.push(relative(repoPath, f));
      }
    }
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

/** Whether one repository file is trusted as it is now (SEC-29: by its current hash). */
export function isTrusted(repoPath: string, rel: string): boolean {
  if (invocationTrust) return true;
  const path = join(repoPath, rel);
  if (!existsSync(path)) return false;
  const entry = readTrust().repos[realRepo(repoPath)]?.files[rel.split(sep).join("/")];
  return entry !== undefined && entry.sha256 === sha256(path);
}

/** The trust-gated files that would not run now. */
export function untrustedFiles(repoPath: string): string[] {
  return gatedFiles(repoPath).filter((rel) => !isTrusted(repoPath, rel));
}

/**
 * Record the person's trust in these files as they are now. Returns each
 * file trusted with its SHA-256, for the `workspace/trusted` ledger event.
 */
export function trustFiles(
  repoPath: string,
  rels: readonly string[],
  by: string,
): { path: string; sha256: string }[] {
  const t = readTrust();
  const key = realRepo(repoPath);
  const entry = t.repos[key] ?? { files: {} };
  const at = new Date().toISOString();
  const trusted: { path: string; sha256: string }[] = [];
  for (const rel of rels) {
    const path = join(repoPath, rel);
    if (!existsSync(path)) continue;
    const file = { path: rel.split(sep).join("/"), sha256: sha256(path) };
    entry.files[file.path] = { sha256: file.sha256, at, by };
    trusted.push(file);
  }
  t.repos[key] = entry;
  writeTrust(t);
  return trusted;
}

/**
 * Exactly what each untrusted file would run (item 40): every hook's event
 * and command, every MCP server's command line, every script's path and
 * first lines.
 */
export function describeUntrusted(repoPath: string, rels = untrustedFiles(repoPath)): string[] {
  const lines: string[] = [];
  for (const rel of rels) {
    const path = join(repoPath, rel);
    const text = readFileSync(path, "utf8");
    if (rel.endsWith("hooks.toml")) {
      lines.push(`${rel} — runs these commands outside the sandbox, with your rights:`);
      let hooks: TomlTable[] = [];
      try {
        const parsed = parseToml(text);
        hooks = Array.isArray(parsed.hook) ? (parsed.hook as TomlTable[]) : [];
      } catch (err) {
        lines.push(`   (unreadable: ${err instanceof Error ? err.message : String(err)})`);
      }
      for (const h of hooks) {
        lines.push(
          `   on ${String(h.event ?? "?")}${h.tool ? ` (${String(h.tool)})` : ""}: ${String(h.command ?? "")}`,
        );
      }
    } else if (rel.endsWith("mcp.json")) {
      lines.push(`${rel} — starts these servers outside the sandbox, with your rights:`);
      try {
        const servers = (JSON.parse(text) as { mcpServers?: Record<string, unknown> }).mcpServers;
        for (const [name, cfg] of Object.entries(servers ?? {})) {
          const c = cfg as { command?: unknown; args?: unknown; env?: unknown };
          const args = Array.isArray(c.args) ? c.args.map(String).join(" ") : "";
          const env =
            c.env && typeof c.env === "object" ? Object.keys(c.env as object).join(", ") : "";
          lines.push(
            `   ${name}: ${String(c.command ?? "")}${args ? ` ${args}` : ""}${env ? ` (env: ${env})` : ""}`,
          );
        }
      } catch (err) {
        lines.push(`   (unreadable: ${err instanceof Error ? err.message : String(err)})`);
      }
    } else {
      lines.push(`${rel} — a skill script:`);
      for (const l of text.split("\n").slice(0, 5)) lines.push(`   | ${l}`);
    }
  }
  return lines;
}

/**
 * The skills lock for a repository, in the user directory (SEC-31): a lock
 * the repository ships is never read for a trust decision.
 */
export function skillsLockPath(repoPath: string): string {
  const key = createHash("sha256").update(realRepo(repoPath)).digest("hex").slice(0, 16);
  return join(trustDir(), `skills-${key}.json`);
}

/** The repository's skills, pinned in the user directory's lock (C10, SEC-31). */
export function loadRepoSkills(repoPath: string): SkillsRegistry {
  const skills = new SkillsRegistry();
  const lockPath = skillsLockPath(repoPath);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  // Rule 13 (EXT-24): the person's own skills first, then the project's,
  // which override the person's by name. Both pinned in the user directory.
  skills.loadFromDirectory(userPaths().skills, { lockPath, scope: "user" });
  const personal = skills.getAllSkills();
  skills.loadFromDirectory(join(repoPath, ".sekhemet", "skills"), { lockPath, scope: "project" });
  for (const s of personal) if (!skills.getSkill(s.name)) skills.registerSkill(s);
  return skills;
}
