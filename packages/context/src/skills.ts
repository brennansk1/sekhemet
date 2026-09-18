import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface SkillManifest {
  name: string;
  description: string;
  triggers: string[];
  content: string;
  path?: string;
  /**
   * How this skill appears in the prompt (C9): `manifest` is one line (name
   * and description), `full` the body. Set by `skillsForPrompt`.
   */
  disclosure?: "full" | "manifest";
  /** sha256 of the SKILL.md bytes (C10). */
  sha256?: string;
}

/**
 * Skill trust (C10): every skill is pinned by the SHA-256 of its SKILL.md in
 * a lock file. A skill that is new, or whose bytes differ from its pin, is
 * rejected (not loaded) until a human approves it; every decision is kept
 * in an audit trail. With no lock file yet, the first load pins what is
 * there (trust on first use) so an existing project keeps working.
 */
export interface SkillLockEntry {
  sha256: string;
  approvedAt: string;
  approvedBy: string;
}

export interface SkillLock {
  version: 1;
  skills: Record<string, SkillLockEntry>;
  audit: SkillAuditEntry[];
}

export interface SkillAuditEntry {
  at: string;
  skill: string;
  action: "pinned" | "rejected_new" | "rejected_changed" | "approved" | "revoked";
  sha256: string;
  previous?: string;
  /** For a change: added/removed line counts against the pinned copy, when known. */
  diff?: string;
}

export interface SkillTrustOptions {
  /** Lock file. Default `<skills dir>/../skills.lock.json`. `false` disables trust. */
  lockPath?: string | false;
  /** Pin every skill when no lock exists yet. Default true. */
  trustOnFirstUse?: boolean;
  now?: () => Date;
}

export function skillSha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function readSkillLock(path: string): SkillLock | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as SkillLock;
}

function writeSkillLock(path: string, lock: SkillLock): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Approve a skill at its current bytes (the human action behind
 * `sekhemet skills approve <name>`): pins the hash and logs it.
 */
export function approveSkill(
  skillsDir: string,
  name: string,
  approvedBy = "human",
  lockPath = join(skillsDir, "..", "skills.lock.json"),
  now: () => Date = () => new Date(),
): SkillLockEntry {
  const file = join(skillsDir, name, "SKILL.md");
  if (!existsSync(file)) throw new Error(`No skill ${name} in ${skillsDir}`);
  const sha256 = skillSha256(readFileSync(file, "utf8"));
  const lock = readSkillLock(lockPath) ?? { version: 1, skills: {}, audit: [] };
  const previous = lock.skills[name]?.sha256;
  const entry = { sha256, approvedAt: now().toISOString(), approvedBy };
  lock.skills[name] = entry;
  lock.audit.push({
    at: entry.approvedAt,
    skill: name,
    action: "approved",
    sha256,
    ...(previous && previous !== sha256 ? { previous } : {}),
  });
  writeSkillLock(lockPath, lock);
  return entry;
}

/** Revoke a skill's pin: it is rejected on the next load. */
export function revokeSkill(
  skillsDir: string,
  name: string,
  lockPath = join(skillsDir, "..", "skills.lock.json"),
  now: () => Date = () => new Date(),
): void {
  const lock = readSkillLock(lockPath);
  const entry = lock?.skills[name];
  if (!lock || !entry) return;
  delete lock.skills[name];
  lock.audit.push({
    at: now().toISOString(),
    skill: name,
    action: "revoked",
    sha256: entry.sha256,
  });
  writeSkillLock(lockPath, lock);
}

export class SkillsRegistry {
  private skills: Map<string, SkillManifest> = new Map();
  private rejectedSkills: SkillAuditEntry[] = [];

  /** Skills refused by the trust check on the last load (C10). */
  public rejected(): SkillAuditEntry[] {
    return [...this.rejectedSkills];
  }

  public registerSkill(skill: SkillManifest): void {
    this.skills.set(skill.name, skill);
  }

  public getSkill(name: string): SkillManifest | undefined {
    return this.skills.get(name);
  }

  /** Sorted by name: prompt-facing order must never depend on load order. */
  public getAllSkills(): SkillManifest[] {
    return Array.from(this.skills.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  public getCompactSummary(): string {
    const lines: string[] = [];
    for (const s of this.getAllSkills()) {
      lines.push(`- ${s.name}: ${s.description} [triggers: ${s.triggers.join(", ")}]`);
    }
    return lines.join("\n");
  }

  public resolveActiveSkills(cardTitle: string, filesTouched: string[] = []): SkillManifest[] {
    const textToMatch = `${cardTitle} ${filesTouched.join(" ")}`.toLowerCase();
    const matched: SkillManifest[] = [];

    for (const skill of this.getAllSkills()) {
      const matchesTrigger = skill.triggers.some((trig) =>
        textToMatch.includes(trig.toLowerCase()),
      );
      if (matchesTrigger) {
        matched.push(skill);
      }
    }

    return matched;
  }

  /**
   * Every skill for the prompt (C9): the ones whose triggers match the card
   * carry their body (`full`); the rest are one manifest line, so the model
   * knows they exist without paying their prefill.
   */
  public skillsForPrompt(cardTitle: string, filesTouched: string[] = []): SkillManifest[] {
    const matched = new Set(this.resolveActiveSkills(cardTitle, filesTouched).map((s) => s.name));
    return this.getAllSkills().map((s) => ({
      ...s,
      disclosure: matched.has(s.name) ? ("full" as const) : ("manifest" as const),
    }));
  }

  public loadFromDirectory(dirPath: string, trust: SkillTrustOptions = {}): void {
    if (!existsSync(dirPath)) return;
    const lockPath =
      trust.lockPath === false
        ? undefined
        : (trust.lockPath ?? join(dirPath, "..", "skills.lock.json"));
    const now = trust.now ?? (() => new Date());
    let lock = lockPath ? readSkillLock(lockPath) : undefined;
    const firstUse =
      lockPath !== undefined && lock === undefined && trust.trustOnFirstUse !== false;
    if (lockPath && !lock) lock = { version: 1, skills: {}, audit: [] };
    let lockChanged = false;
    this.rejectedSkills = [];

    // readdirSync order is filesystem-dependent; sorting here is what makes the
    // Zone 2 prefix byte-identical across machines (C15 / design M2).
    const entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = join(dirPath, entry.name, "SKILL.md");
        if (existsSync(skillMdPath)) {
          const content = readFileSync(skillMdPath, "utf8");
          const sha256 = skillSha256(content);
          if (lock) {
            const pinned = lock.skills[entry.name];
            const at = now().toISOString();
            if (!pinned && firstUse) {
              lock.skills[entry.name] = {
                sha256,
                approvedAt: at,
                approvedBy: "trust-on-first-use",
              };
              lock.audit.push({ at, skill: entry.name, action: "pinned", sha256 });
              lockChanged = true;
            } else if (!pinned || pinned.sha256 !== sha256) {
              const audit: SkillAuditEntry = {
                at,
                skill: entry.name,
                action: pinned ? "rejected_changed" : "rejected_new",
                sha256,
                ...(pinned ? { previous: pinned.sha256 } : {}),
              };
              const last = [...lock.audit].reverse().find((a) => a.skill === entry.name);
              // Log a rejection once per distinct content, not on every load.
              if (!(last && last.action === audit.action && last.sha256 === sha256)) {
                lock.audit.push(audit);
                lockChanged = true;
              }
              this.rejectedSkills.push(audit);
              continue;
            }
          }
          const skill = this.parseSkillMarkdown(entry.name, content, skillMdPath);
          this.registerSkill({ ...skill, sha256 });
        }
      }
    }
    if (lockPath && lock && lockChanged) writeSkillLock(lockPath, lock);
  }

  private parseSkillMarkdown(dirName: string, raw: string, filePath: string): SkillManifest {
    let description = "Custom skill";
    let triggers: string[] = [dirName];
    let body = raw;

    // Check for YAML frontmatter
    if (raw.startsWith("---")) {
      const parts = raw.split("---");
      if (parts.length >= 3) {
        const frontmatter = parts[1] ?? "";
        body = parts.slice(2).join("---").trim();

        const descMatch = frontmatter.match(/description:\s*(.+)/);
        if (descMatch?.[1]) {
          description = descMatch[1].trim().replace(/^["']|["']$/g, "");
        }

        const trigMatch = frontmatter.match(/triggers:\s*\[(.*)\]/);
        if (trigMatch?.[1]) {
          triggers = trigMatch[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, ""));
        }
      }
    }

    return {
      name: dirName,
      description,
      triggers,
      content: body,
      path: filePath,
    };
  }
}
