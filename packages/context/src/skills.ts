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
import { estimateTokens } from "./tokens.js";

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
  /** Tools the skill needs; a card without them gets neither its line nor its body (rule 12). */
  tools?: string[];
  /** The body's budget (`budget_tokens`, rule 14). */
  budgetTokens?: number;
  /** Where it was loaded from; a project skill overrides the person's by name (rule 13). */
  scope?: "user" | "project";
  /** Set when the body was cut to `budget_tokens` at a section boundary (EXT-25). */
  truncated?: { budgetTokens: number; keptTokens: number; originalTokens: number };
}

/** A skill left out of a card's prompt because the card lacks tools it needs (EXT-22a). */
export interface SkillOmission {
  name: string;
  missingTools: string[];
}

/**
 * The YAML front matter of a SKILL.md (Agent Skills format, rule 10): the
 * subset skills use — scalars, quoted strings, `>` and `|` block scalars,
 * flow lists `[a, b]`, block lists `- a`, and nested maps (kept as objects).
 * Not a general YAML parser: anchors, tags and multi-document streams are not
 * read. Returns the body after the closing `---`.
 */
export function parseFrontMatter(raw: string): { data: Record<string, unknown>; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const lines = (m[1] ?? "").split(/\r?\n/);
  return { data: parseBlock(lines, 0, lines.length, 0), body: raw.slice(m[0].length) };
}

const indentOf = (l: string) => l.length - l.trimStart().length;
const unquote = (v: string) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
};
function scalar(v: string): unknown {
  const t = v.replace(/\s+#.*$/, "").trim();
  if (/^\[.*\]$/.test(t))
    return t
      .slice(1, -1)
      .split(",")
      .map((x) => unquote(x))
      .filter((x) => x.length > 0);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return unquote(t);
}

function parseBlock(
  lines: string[],
  from: number,
  to: number,
  indent: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = from;
  while (i < to) {
    const line = lines[i] as string;
    if (!line.trim() || line.trimStart().startsWith("#") || indentOf(line) < indent) {
      i++;
      continue;
    }
    const kv = /^(\s*)([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[2] as string;
    const rest = (kv[3] ?? "").trim();
    // The lines that belong to this key: more indented than it, or blank.
    let end = i + 1;
    while (
      end < to &&
      (!(lines[end] as string).trim() || indentOf(lines[end] as string) > indentOf(line))
    )
      end++;
    const child = lines.slice(i + 1, end);
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const text = child.map((l) => l.trim());
      out[key] = (rest.startsWith(">") ? text.filter(Boolean).join(" ") : text.join("\n")).trim();
    } else if (rest === "" && child.some((l) => l.trim().startsWith("- "))) {
      out[key] = child
        .filter((l) => l.trim().startsWith("- "))
        .map((l) => scalar(l.trim().slice(2)));
    } else if (rest === "" && child.some((l) => l.trim())) {
      const inner = Math.min(...child.filter((l) => l.trim()).map(indentOf));
      out[key] = parseBlock(lines, i + 1, end, inner);
    } else {
      // A plain scalar may continue on more-indented lines (folded).
      const more = child.map((l) => l.trim()).filter(Boolean);
      out[key] = more.length ? [rest, ...more].join(" ") : scalar(rest);
    }
    i = end;
  }
  return out;
}

/** Words a description shares with a card, for selection by description (rule 12). */
const DESCRIPTION_STOP = new Set(
  "the and for with from that this into when then than your their them they its are was were been being have has had not but any all each every before after about over under use using used make makes made more most other some such only also very can will would should".split(
    " ",
  ),
);
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const stemsOf = (text: string): Set<string> =>
  new Set(
    wordsOf(text)
      .filter((w) => w.length >= 3 && !DESCRIPTION_STOP.has(w))
      .map((w) => w.slice(0, 5)),
  );

/**
 * Cut a body to its budget at a section boundary (rule 14): whole sections,
 * each starting at a Markdown heading, while they fit; a first section that
 * alone is too long is cut at its last paragraph break that fits.
 */
export function truncateAtSection(
  body: string,
  budgetTokens: number,
): { text: string; keptTokens: number; originalTokens: number } | undefined {
  const originalTokens = estimateTokens(body);
  if (originalTokens <= budgetTokens) return undefined;
  const sections = body.split(/\n(?=#{1,6} )/);
  let kept = "";
  for (const section of sections) {
    const next = kept ? `${kept}\n${section}` : section;
    if (estimateTokens(next) > budgetTokens) break;
    kept = next;
  }
  if (!kept) {
    for (const para of (sections[0] ?? "").split(/\n\s*\n/)) {
      const next = kept ? `${kept}\n\n${para}` : para;
      if (estimateTokens(next) > budgetTokens) break;
      kept = next;
    }
  }
  const text = `${kept.trimEnd()}\n`;
  return { text, keptTokens: estimateTokens(text), originalTokens };
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
  /** The directory's scope (rule 13); loaded after the person's, a project skill overrides by name. */
  scope?: "user" | "project";
  /** Pin every skill when no lock exists yet. Default true. */
  trustOnFirstUse?: boolean;
  now?: () => Date;
}

/**
 * What a skill's scripts may never touch (rule 15, EXT-27): the gate files,
 * the loop driver and the sandbox's configuration, and the harness's own
 * extension and ledger files. A static read of `scripts/`: naming one of
 * these is enough to reject the skill at import, before it could run.
 */
const PROTECTED_SKILL_TARGETS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /(?:^|[^\w-])((?:\.sekhemet\/)?gates\.toml)\b/, what: "gate file" },
  {
    pattern: /(\.sekhemet\/(?:config\.toml|hooks\.toml|mcp\.json|events\.db|skills\.lock\.json))/,
    what: "harness configuration",
  },
  { pattern: /(packages\/loop\/[\w./-]*|\bcard_runner(?:\.[jt]s)?\b)/, what: "loop driver" },
  {
    pattern:
      /(packages\/sandbox\/[\w./-]*|\bseatbelt(?:\.[jt]s)?\b|child_process\.allowlist\.json)/,
    what: "sandbox configuration",
  },
];

/** Each script in a skill's `scripts/` that names a protected file, with the file. */
export function skillProtectedWrites(
  skillDir: string,
): { script: string; target: string; what: string }[] {
  const root = join(skillDir, "scripts");
  if (!existsSync(root)) return [];
  const found: { script: string; target: string; what: string }[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path, r);
      else if (e.isFile()) {
        const text = readFileSync(path, "utf8");
        for (const t of PROTECTED_SKILL_TARGETS) {
          const m = t.pattern.exec(text);
          if (m) found.push({ script: `scripts/${r}`, target: m[1] ?? m[0], what: t.what });
        }
      }
    }
  };
  walk(root, "");
  return found;
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

  /**
   * The skills selected for a card (rule 12), deterministically: a declared
   * trigger matches as a whole word of the title or a file path (`ast` does
   * not fire on "last", EXT-23); a skill with no triggers is selected by its
   * description — two of its content words, by stem, in the card (one, when
   * the description has only one).
   */
  public resolveActiveSkills(cardTitle: string, filesTouched: string[] = []): SkillManifest[] {
    const text = `${cardTitle} ${filesTouched.join(" ")}`;
    const words = new Set(wordsOf(text));
    const have = stemsOf(text);
    return this.getAllSkills().filter((skill) => {
      if (skill.triggers.length > 0) {
        return skill.triggers.some((trig) => {
          const parts = wordsOf(trig);
          if (parts.length === 0) return false;
          if (parts.length === 1) return words.has(parts[0] as string);
          // A multi-word trigger matches as a phrase of whole words.
          return new RegExp(`(^|[^a-z0-9])${parts.join("[^a-z0-9]+")}($|[^a-z0-9])`).test(
            text.toLowerCase(),
          );
        });
      }
      const wanted = [...stemsOf(skill.description)];
      if (wanted.length === 0) return false;
      const overlap = wanted.filter((w) => have.has(w)).length;
      return overlap >= Math.min(2, wanted.length);
    });
  }

  private omittedSkills: SkillOmission[] = [];

  /** Skills the last `skillsForPrompt` left out for missing tools (EXT-22a). */
  public omitted(): SkillOmission[] {
    return [...this.omittedSkills];
  }

  /**
   * Every skill for the prompt (C9): the ones selected for the card carry
   * their body (`full`, cut to `budget_tokens` at a section boundary and
   * marked `truncated`); the rest are one manifest line, so the model knows
   * they exist without paying their prefill. With the card's `tools`, a skill
   * that needs a tool the card lacks is left out entirely and listed by
   * `omitted()` — a skill never widens the card's tool set (rule 12).
   */
  public skillsForPrompt(
    cardTitle: string,
    filesTouched: string[] = [],
    options: { tools?: readonly string[] } = {},
  ): SkillManifest[] {
    const matched = new Set(this.resolveActiveSkills(cardTitle, filesTouched).map((s) => s.name));
    const available = options.tools ? new Set(options.tools) : undefined;
    this.omittedSkills = [];
    const out: SkillManifest[] = [];
    for (const s of this.getAllSkills()) {
      const missing = available ? (s.tools ?? []).filter((t) => !available.has(t)) : [];
      if (missing.length > 0) {
        this.omittedSkills.push({ name: s.name, missingTools: missing });
        continue;
      }
      if (!matched.has(s.name)) {
        out.push({ ...s, disclosure: "manifest" });
        continue;
      }
      const cut = s.budgetTokens ? truncateAtSection(s.content, s.budgetTokens) : undefined;
      out.push({
        ...s,
        disclosure: "full",
        ...(cut && s.budgetTokens
          ? {
              content: cut.text,
              truncated: {
                budgetTokens: s.budgetTokens,
                keptTokens: cut.keptTokens,
                originalTokens: cut.originalTokens,
              },
            }
          : {}),
      });
    }
    return out;
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
          this.registerSkill({ ...skill, sha256, ...(trust.scope ? { scope: trust.scope } : {}) });
        }
      }
    }
    if (lockPath && lock && lockChanged) writeSkillLock(lockPath, lock);
  }

  /**
   * One SKILL.md in the Agent Skills format (rule 10): YAML front matter with
   * `description` and optional `triggers`, `tools`, `budget_tokens`; the
   * body after it. The directory's name is the skill's name.
   */
  private parseSkillMarkdown(dirName: string, raw: string, filePath: string): SkillManifest {
    const { data, body } = parseFrontMatter(raw);
    const list = (v: unknown): string[] | undefined =>
      Array.isArray(v)
        ? v.map(String).filter(Boolean)
        : typeof v === "string" && v.trim()
          ? [v.trim()]
          : undefined;
    const description =
      typeof data.description === "string" && data.description.trim()
        ? data.description.trim()
        : "Custom skill";
    const tools = list(data.tools);
    const budget = Number(data.budget_tokens ?? data.budgetTokens);
    return {
      name: dirName,
      description,
      triggers: list(data.triggers) ?? [],
      content: body.trim(),
      path: filePath,
      ...(tools ? { tools } : {}),
      ...(Number.isFinite(budget) && budget > 0 ? { budgetTokens: budget } : {}),
    };
  }
}
