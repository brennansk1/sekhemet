import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { SkillsRegistry } from "@sekhemet/context";
import { type TomlTable, parseToml } from "@sekhemet/kernel";
import { hasAdmin, memberOf } from "./team/members.js";
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

interface Approval {
  sha256: string;
  at: string;
  by: string;
}

export interface TrustRecord {
  version: 1;
  /**
   * Real repository path → trusted files (repository-relative) → their
   * SHA-256; whether the repository itself is trusted to run (SUR-56); and
   * the other agents' configuration files approved, each by its SHA-256
   * (security item 38a, SEC-54).
   */
  repos: Record<
    string,
    {
      files: Record<string, Approval>;
      workspace?: { at: string; by: string };
      agentConfig?: Record<string, Approval>;
    }
  >;
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

/** A symbolic link, read without following it; undefined when `path` is not one. */
function linkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `path` exists as an entry — a dangling link included. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A file's SHA-256. A symbolic link hashes as its target text plus, when it
 * resolves to a regular file, that file's bytes: re-pointing the link or
 * changing what it runs untrusts it; a dangling link still hashes.
 */
const sha256 = (path: string) => {
  const target = linkTarget(path);
  const hash = createHash("sha256");
  if (target === undefined) return hash.update(readFileSync(path)).digest("hex");
  hash.update(`symlink\0${target}\0`);
  try {
    if (statSync(path).isFile()) hash.update(readFileSync(path));
  } catch {
    // dangling or a loop: the target text alone
  }
  return hash.digest("hex");
};

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
      // A `scripts` that is itself a link is listed as itself, never followed.
      if (linkTarget(scripts) !== undefined) out.push(relative(repoPath, scripts));
      else if (existsSync(scripts) && statSync(scripts).isDirectory()) {
        for (const f of walk(scripts)) out.push(relative(repoPath, f));
      }
    }
  }
  return out;
}

/**
 * Every entry under `dir`, never following a symbolic link (lstat): a link
 * is listed as itself, so a loop or a dangling link neither hangs nor throws.
 */
function walk(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(dir, n);
    try {
      return lstatSync(p).isDirectory() ? walk(p) : [p];
    } catch {
      return [];
    }
  });
}

/** Whether one repository file is trusted as it is now (SEC-29: by its current hash). */
export function isTrusted(repoPath: string, rel: string): boolean {
  if (invocationTrust) return true;
  const path = join(repoPath, rel);
  if (!present(path)) return false;
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
    if (!present(path)) continue;
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
    const target = linkTarget(path);
    if (target !== undefined) {
      lines.push(`${rel} — a symbolic link to ${target}, never followed here`);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      lines.push(`${rel} — unreadable: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
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
  // Item 15, EXT-4 (FINDINGS_C1 SEC-02): no trust on first use — a skill
  // loads only once a person approved its content (`sekhemet skills approve`).
  const trust = { lockPath, trustOnFirstUse: false } as const;
  skills.loadFromDirectory(userPaths().skills, { ...trust, scope: "user" });
  const personal = skills.getAllSkills();
  skills.loadFromDirectory(join(repoPath, ".sekhemet", "skills"), { ...trust, scope: "project" });
  for (const s of personal) if (!skills.getSkill(s.name)) skills.registerSkill(s);
  return skills;
}

// --- The repository itself, and other agents' configuration (B4.1) ---------

/**
 * Who may trust (security item 39; teams item 6): in the Team setup only an
 * Admin may trust a repository or approve another agent's configuration in
 * it. Solo — no Admin exists on the ledger — the person at the machine may.
 */
export interface TrustAuthority {
  team: boolean;
  admin: boolean;
}

export class TrustRefused extends Error {
  constructor(what: string) {
    super(`Only an Admin may ${what} in the Team setup; nothing was recorded.`);
    this.name = "TrustRefused";
  }
}

const SOLO: TrustAuthority = { team: false, admin: true };

/**
 * Who `principal` is for trust (teams item 6): a Team install is one with an
 * Admin on the ledger, and there only an Admin may trust or approve.
 */
export function trustAuthorityFor(
  db: import("node:sqlite").DatabaseSync,
  principal: string,
): TrustAuthority {
  if (!hasAdmin(db)) return SOLO;
  const me = memberOf(db, principal);
  return { team: true, admin: me?.level === "admin" && !me.pending && !me.removed };
}

/**
 * Whether the repository is trusted to run its own code — installs, builds,
 * tests, language servers (surface item 9, SUR-56; design-stage §2.10 step
 * 1, DS-TO-1). Recorded in the user directory by the repository's real path;
 * `--trust` holds for this invocation only.
 */
export function isWorkspaceTrusted(repoPath: string): boolean {
  if (invocationTrust) return true;
  return readTrust().repos[realRepo(repoPath)]?.workspace !== undefined;
}

/** Record the person's trust in the repository (after they saw what would run). */
export function trustWorkspace(
  repoPath: string,
  by: string,
  authority: TrustAuthority = SOLO,
): void {
  if (authority.team && !authority.admin) throw new TrustRefused("trust a repository");
  const t = readTrust();
  const key = realRepo(repoPath);
  const entry = t.repos[key] ?? { files: {} };
  entry.workspace = { at: new Date().toISOString(), by };
  t.repos[key] = entry;
  writeTrust(t);
}

/** Directories another coding agent reads or runs on open, and git's hook directories. */
const AGENT_CONFIG_DIRS = [".claude", ".cursor", ".githooks", ".husky"];
/** Single files of the same kind. */
const AGENT_CONFIG_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".mcp.json",
  ".envrc",
  ".pre-commit-config.yaml",
];

/**
 * Every file of another agent's configuration the repository holds
 * (security item 38a, SEC-54), repository-relative and sorted: `.claude/`,
 * `.cursor/`, `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.envrc`, `.githooks/`,
 * `.husky/`, `.pre-commit-config.yaml` and the hooks under `.git/hooks/`
 * (git's `*.sample` files excepted). Sekhemet executes none of them.
 */
export function agentConfigFiles(repoPath: string): string[] {
  const out: string[] = [];
  for (const name of AGENT_CONFIG_FILES) {
    const p = join(repoPath, name);
    if (existsSync(p) && statSync(p).isFile()) out.push(name);
  }
  for (const dir of AGENT_CONFIG_DIRS) {
    const p = join(repoPath, dir);
    if (existsSync(p) && statSync(p).isDirectory()) {
      for (const f of walk(p)) out.push(relative(repoPath, f).split(sep).join("/"));
    }
  }
  const hooks = join(repoPath, ".git", "hooks");
  if (existsSync(hooks) && statSync(hooks).isDirectory()) {
    for (const f of walk(hooks)) {
      if (!f.endsWith(".sample")) out.push(relative(repoPath, f).split(sep).join("/"));
    }
  }
  return out.sort();
}

/**
 * Whether one agent configuration file is approved as it is now: only the
 * user directory's store decides — never the ledger, the repository or
 * `--trust` — and a changed hash is unapproved again (SEC-54).
 */
export function isAgentConfigApproved(repoPath: string, rel: string): boolean {
  const path = join(repoPath, rel);
  if (!present(path)) return false;
  const entry = readTrust().repos[realRepo(repoPath)]?.agentConfig?.[rel.split(sep).join("/")];
  return entry !== undefined && entry.sha256 === sha256(path);
}

/** The agent configuration files not approved as they are now. */
export function unapprovedAgentConfig(repoPath: string): string[] {
  return agentConfigFiles(repoPath).filter((rel) => !isAgentConfigApproved(repoPath, rel));
}

/**
 * Approve these agent configuration files as they are now, in the user
 * directory; nothing is written into the repository. Returns each with its
 * SHA-256 for the `trust/agent_config_approved` audit records.
 */
export function approveAgentConfig(
  repoPath: string,
  rels: readonly string[],
  by: string,
  authority: TrustAuthority = SOLO,
): { path: string; sha256: string }[] {
  if (authority.team && !authority.admin) {
    throw new TrustRefused("approve another agent's configuration");
  }
  const allowed = new Set(agentConfigFiles(repoPath));
  const t = readTrust();
  const key = realRepo(repoPath);
  const entry = t.repos[key] ?? { files: {} };
  const approvals = entry.agentConfig ?? {};
  const at = new Date().toISOString();
  const approved: { path: string; sha256: string }[] = [];
  for (const rel of rels) {
    const norm = rel.split(sep).join("/");
    if (!allowed.has(norm)) continue;
    const file = { path: norm, sha256: sha256(join(repoPath, norm)) };
    approvals[norm] = { sha256: file.sha256, at, by };
    approved.push(file);
  }
  entry.agentConfig = approvals;
  t.repos[key] = entry;
  writeTrust(t);
  return approved;
}

/**
 * The audit record of each approval (`trust/agent_config_approved`): the
 * path, hash and principal structural, the repository's real path private
 * (it may name a home directory). It grants nothing on replay.
 */
export async function recordAgentConfigApprovals(
  store: {
    recordLedgerEvent(params: {
      type: string;
      actor: string;
      payload: unknown;
      principal?: string;
      private?: Record<string, unknown>;
    }): Promise<unknown>;
  },
  repoPath: string,
  approved: readonly { path: string; sha256: string }[],
  principal: string,
): Promise<void> {
  for (const a of approved) {
    await store.recordLedgerEvent({
      type: "trust/agent_config_approved",
      actor: "human",
      principal,
      payload: { path: a.path, sha256: a.sha256, principal },
      private: { repo: realRepo(repoPath) },
    });
  }
}
