import { parseToml } from "@sekhemet/kernel";
import { type GitleaksAllowlist, type SecretRule, gitleaksRuleSet } from "./gitleaks_rules.js";

export type { SecretRule } from "./gitleaks_rules.js";

/**
 * Secret scanning (G14, the write path's secret check, G7, the history scan
 * of a take-over, DS-TO-3, and redaction before persistence, SEC-22).
 *
 * The rules are gitleaks' own default rule file, vendored (DEC-43, DEC-44;
 * `gitleaks_rules.ts`), so the bundled scan and the gitleaks program report
 * the same rule ids. They run as gitleaks runs them: over a whole fragment
 * (a file, or one hunk's added lines) so a multi-line private key is found;
 * a rule only on text holding one of its keywords; the secret its group
 * names, else the first non-empty group, else the match; not reported at or
 * below the rule's entropy, when an allowlist (the file's global one or the
 * rule's own) allows it, or on a line marked `gitleaks:allow`; and a
 * `generic-*` finding dropped where another rule found the same secret on
 * the same line. `gitleaks` itself is run too when it is installed (see
 * `builtin.ts`, `history_secrets.ts`).
 */
export const SECRET_RULES: readonly SecretRule[] = gitleaksRuleSet().rules;

/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export interface SecretFinding {
  rule: string;
  description: string;
  file: string;
  line: number;
  /** The secret with its middle masked, never the full value. */
  redacted: string;
}

export function redact(secret: string): string {
  return secret.length <= 8 ? "****" : `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}

/** One rule's match in a fragment. */
interface Match {
  rule: SecretRule;
  secret: string;
  /** Offsets of the secret in the fragment. */
  start: number;
  end: number;
  /** Zero-based line of the match's start within the fragment. */
  line: number;
}

/** Offsets where each line of `text` starts. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function lineText(text: string, starts: number[], line: number): string {
  const from = starts[line] as number;
  const to = starts[line + 1];
  return text.slice(from, to === undefined ? undefined : to - 1);
}

/** Whether one allowlist allows a finding (gitleaks' OR / AND over the checks it configures). */
function allows(
  a: GitleaksAllowlist,
  secret: string,
  match: string,
  line: string,
  file: string | undefined,
  commit: string | undefined,
): boolean {
  const target = a.regexTarget === "match" ? match : a.regexTarget === "line" ? line : secret;
  const lower = secret.toLowerCase();
  const checks: boolean[] = [];
  if (a.commits.length > 0) checks.push(!!commit && a.commits.includes(commit.toLowerCase()));
  if (a.paths.length > 0) checks.push(file !== undefined && a.paths.some((r) => r.test(file)));
  if (a.regexes.length > 0) checks.push(a.regexes.some((r) => r.test(target)));
  if (a.stopwords.length > 0) checks.push(a.stopwords.some((w) => lower.includes(w)));
  if (checks.length === 0) return false;
  return a.condition === "AND" ? checks.every(Boolean) : checks.some(Boolean);
}

interface ScanOptions {
  /** The fragment's path; path rules and path allowlists need it. */
  file?: string;
  commit?: string;
  /** Honour the `gitleaks:allow` line marker (the scan does; redaction does not). */
  marker: boolean;
  /**
   * Honour the rules' and the file's allowlists (the scan does; redaction does
   * not: a documentation key such as AWS's `…EXAMPLE` is still masked in text
   * the harness persists or sends to the Research model, DS-N5-1, SEC-22).
   */
  allowlists: boolean;
}

/** Lines a test fixture may use to mark an intentional fake. */
const ALLOW_MARKER = /gitleaks:allow|sekhemet:allow-secret/;

/** Every rule's findings in one fragment, as gitleaks finds them. */
function findSecrets(text: string, o: ScanOptions): Match[] {
  const set = gitleaksRuleSet();
  const { file, commit } = o;
  if (file !== undefined && set.allowlist.paths.some((r) => r.test(file))) return [];
  const lower = text.toLowerCase();
  let starts: number[] | undefined;
  const out: Match[] = [];
  for (const rule of set.rules) {
    if (rule.path) {
      // A path rule applies only to its files (a `.tf` password field, a
      // Kubernetes secret's YAML): with no path, as in redaction, it does not
      // run, as gitleaks would not run it on a file of another kind.
      if (file === undefined || !rule.path.test(file)) continue;
      if (!rule.pattern) {
        out.push({ rule, secret: "", start: 0, end: 0, line: 0 });
        continue;
      }
    }
    const pattern = rule.pattern;
    if (!pattern) continue;
    if (rule.keywords.length > 0 && !rule.keywords.some((k) => lower.includes(k))) continue;
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      if (m[0] === "") {
        pattern.lastIndex++;
        continue;
      }
      let secret = m[0];
      let offset = m.index;
      const group =
        rule.secretGroup !== undefined
          ? rule.secretGroup
          : m.findIndex((g, i) => i > 0 && g !== undefined && g !== "");
      if (group > 0 && m[group]) {
        secret = m[group] as string;
        offset = m.index + Math.max(0, m[0].indexOf(secret));
      }
      if (rule.minEntropy !== undefined && shannonEntropy(secret) <= rule.minEntropy) continue;
      starts ??= lineStarts(text);
      const line = lineAt(starts, m.index);
      const lastLine = lineAt(starts, m.index + m[0].length - 1);
      const lines = Array.from({ length: lastLine - line + 1 }, (_, k) =>
        lineText(text, starts as number[], line + k),
      );
      if (o.marker && lines.some((l) => ALLOW_MARKER.test(l))) continue;
      const lineOf = lines[0] ?? "";
      const whole = m[0];
      const allowed =
        o.allowlists &&
        [set.allowlist, ...rule.allowlists].some((a) =>
          allows(a, secret, whole, lineOf, file, commit),
        );
      if (allowed) continue;
      out.push({ rule, secret, start: offset, end: offset + secret.length, line });
    }
  }
  // gitleaks drops a generic rule's finding where a specific rule found the
  // same secret on the same line. Reported in the order of the text.
  out.sort((a, b) => a.line - b.line || a.start - b.start);
  return out.filter(
    (f) =>
      !f.rule.id.includes("generic") ||
      !out.some(
        (g) =>
          g !== f &&
          g.line === f.line &&
          !g.rule.id.includes("generic") &&
          g.secret.includes(f.secret),
      ),
  );
}

/**
 * `text` with every secret the rules find replaced by its redacted form
 * (security item 34, SEC-22): applied to what the harness persists or
 * publishes — observations, context packs, gate excerpts, evidence — before
 * it is written. An allow marker does not exempt a line here: a fixture's
 * fake is still not written out whole.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  const found = findSecrets(text, { marker: false, allowlists: false })
    .filter((f) => f.secret.length > 0)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  if (found.length === 0) return text;
  let out = "";
  let at = 0;
  for (const f of found) {
    if (f.start < at) continue; // inside a secret already redacted
    out += text.slice(at, f.start) + redactSpan(f.secret);
    at = f.end;
  }
  return out + text.slice(at);
}

/** A run of key material: base64 of 20 or more characters with a digit and both cases. */
const KEY_MATERIAL = /[A-Za-z0-9+/=]{20,}/g;
const isKeyMaterial = (run: string) => /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);

/**
 * A secret's redacted form. A secret on one line is masked whole. One that
 * spans lines (gitleaks' private-key pattern runs from a header to the next
 * `KEY-----`) is masked line by line: each run of key material becomes
 * `****` (a line of a PEM body, or the string of a concatenated one), and
 * the rest — a header, a footer, or the code between two headers a test
 * names — is kept, so a reader keeps the text's lines.
 */
function redactSpan(secret: string): string {
  if (!secret.includes("\n")) return redact(secret);
  return secret
    .split("\n")
    .map((line) => line.replace(KEY_MATERIAL, (run) => (isKeyMaterial(run) ? "****" : run)))
    .join("\n");
}

/**
 * Secrets in `text` — one file's content, or one hunk's added lines — with
 * `file` its path and `firstLine` the line number of its first line.
 */
export function scanSecrets(
  text: string,
  file: string,
  firstLine = 1,
  commit?: string,
): SecretFinding[] {
  return findSecrets(text, {
    file,
    marker: true,
    allowlists: true,
    ...(commit ? { commit } : {}),
  }).map((f) => ({
    rule: f.rule.id,
    description: f.rule.description,
    file,
    line: firstLine + f.line,
    redacted: f.secret ? redact(f.secret) : "(the file itself)",
  }));
}

/** Secrets on the added lines of a unified diff (what this change introduces), hunk by hunk. */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  let file = "";
  let line = 0;
  // The current hunk's added lines and the file line of each.
  let added: string[] = [];
  let numbers: number[] = [];
  const flush = () => {
    if (added.length > 0 && file) {
      for (const f of scanSecrets(added.join("\n"), file, 1)) {
        out.push({ ...f, line: numbers[f.line - 1] ?? f.line });
      }
    }
    added = [];
    numbers = [];
  };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flush();
      file = "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      flush();
      file = raw === "+++ /dev/null" ? "" : raw.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    const binary = /^Binary files .* and b\/(.+) differ$/.exec(raw);
    if (binary) {
      flush();
      // A binary file is judged by its path alone (gitleaks' path rules).
      out.push(...scanSecrets("", binary[1] as string, 1));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      flush();
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      added.push(raw.slice(1));
      numbers.push(line);
      line++;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      line++;
    }
  }
  flush();
  return out;
}

/**
 * The path allowlist of a gitleaks configuration (`.gitleaks.toml`:
 * `[allowlist] paths`, or `[[allowlists]] paths` in newer gitleaks), each a
 * regular expression over the repository-relative path. The built-in scan
 * and gitleaks honour one file, so a project's documented example
 * credentials (a rule set's fixtures) are allowlisted once. Unreadable or
 * absent: none.
 */
export function gitleaksAllowedPaths(toml: string | undefined): RegExp[] {
  if (!toml) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(toml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const tables = [
    parsed.allowlist,
    ...(Array.isArray(parsed.allowlists) ? parsed.allowlists : []),
  ].filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && !Array.isArray(t));
  const out: RegExp[] = [];
  for (const t of tables) {
    for (const p of Array.isArray(t.paths) ? t.paths : []) {
      if (typeof p !== "string" || !p) continue;
      try {
        out.push(new RegExp(p));
      } catch {
        // A pattern JavaScript cannot read allowlists nothing.
      }
    }
  }
  return out;
}
