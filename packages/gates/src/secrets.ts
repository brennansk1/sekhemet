/**
 * Secret scanning (G14, and the write path's secret check, G7).
 *
 * Rules follow gitleaks' default rule set for the credential shapes a
 * coding agent is most likely to paste or hallucinate into source: cloud
 * keys, VCS and chat tokens, model-provider keys, private key blocks, and
 * generic `secret = "<high-entropy>"` assignments. `gitleaks` itself is run
 * too when it is installed (see `builtin.ts`).
 */
export interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** Minimum Shannon entropy of the captured secret (generic rules). */
  minEntropy?: number;
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: "aws-access-key-id",
    description: "AWS access key id",
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/,
  },
  {
    id: "aws-secret-access-key",
    description: "AWS secret access key",
    pattern: /aws.{0,20}?(?:secret|key).{0,20}?['"]([A-Za-z0-9/+=]{40})['"]/i,
  },
  {
    id: "github-token",
    description: "GitHub token",
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,})\b/,
  },
  {
    id: "github-fine-grained",
    description: "GitHub fine-grained token",
    pattern: /\b(github_pat_[A-Za-z0-9_]{80,})\b/,
  },
  { id: "gitlab-token", description: "GitLab token", pattern: /\b(glpat-[A-Za-z0-9_-]{20,})\b/ },
  { id: "slack-token", description: "Slack token", pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/ },
  {
    id: "slack-webhook",
    description: "Slack webhook",
    pattern:
      /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+)/,
  },
  {
    id: "anthropic-key",
    description: "Anthropic API key",
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{32,})\b/,
  },
  {
    id: "openai-key",
    description: "OpenAI API key",
    pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/,
  },
  { id: "google-api-key", description: "Google API key", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/ },
  {
    id: "stripe-key",
    description: "Stripe secret key",
    pattern: /\b((?:sk|rk)_live_[0-9A-Za-z]{24,})\b/,
  },
  { id: "npm-token", description: "npm token", pattern: /\b(npm_[A-Za-z0-9]{36})\b/ },
  {
    id: "private-key",
    description: "Private key block",
    pattern: /(-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----)/,
  },
  {
    id: "generic-secret",
    description: "Hard-coded secret",
    pattern:
      /(?:api[_-]?key|secret|token|passw(?:or)?d|auth)[\w-]*\s*[:=]\s*['"`]([A-Za-z0-9_+/=.-]{20,})['"`]/i,
    minEntropy: 3.5,
  },
];

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

/**
 * `text` with every secret the rules find replaced by its redacted form
 * (security item 34, SEC-22): applied to what the harness persists or
 * publishes — observations, context packs, gate excerpts, evidence — before
 * it is written. An allow marker does not exempt a line here: a fixture's
 * fake is still not written out whole.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of SECRET_RULES) {
    const global = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
    );
    out = out.replace(global, (match: string, secret: string | undefined) => {
      if (!secret) return match;
      if (rule.minEntropy !== undefined && shannonEntropy(secret) < rule.minEntropy) return match;
      return match.replace(secret, redact(secret));
    });
  }
  return out;
}

/** Lines a test fixture may use to mark an intentional fake. */
const ALLOW_MARKER = /gitleaks:allow|sekhemet:allow-secret/;

/** Secrets in `text` (one file's content or added lines), line by line. */
export function scanSecrets(text: string, file: string, firstLine = 1): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split("\n").forEach((line, i) => {
    if (ALLOW_MARKER.test(line)) return;
    for (const rule of SECRET_RULES) {
      const m = rule.pattern.exec(line);
      const secret = m?.[1];
      if (!secret) continue;
      if (rule.minEntropy !== undefined && shannonEntropy(secret) < rule.minEntropy) continue;
      out.push({
        rule: rule.id,
        description: rule.description,
        file,
        line: firstLine + i,
        redacted: redact(secret),
      });
      break;
    }
  });
  return out;
}

/** Secrets on the added lines of a unified diff (what this change introduces). */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push(...scanSecrets(raw.slice(1), file, line));
      line++;
    } else if (!raw.startsWith("-")) {
      line++;
    }
  }
  return out;
}
