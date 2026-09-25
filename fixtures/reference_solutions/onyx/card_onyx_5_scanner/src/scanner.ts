import type { ScanMatch, ScanRule } from "./types.js";

export const ENTROPY_THRESHOLD = 4.0;

/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const SIGNATURES: [ScanRule, RegExp][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github-pat", /\bghp_[A-Za-z0-9]{36}\b/],
];

/** The first secret on a line: a signature rule, else a high-entropy token. */
export function scanLine(line: string): { rule: ScanRule; excerpt: string } | null {
  for (const [rule, pattern] of SIGNATURES) {
    const match = pattern.exec(line);
    if (match) return { rule, excerpt: match[0] };
  }
  for (const match of line.matchAll(/[A-Za-z0-9+/_-]{20,}/g)) {
    if (shannonEntropy(match[0]) >= ENTROPY_THRESHOLD) {
      return { rule: "high-entropy", excerpt: match[0] };
    }
  }
  return null;
}

/** Every line of `text` with a hit, 1-based. */
export function scanText(text: string, file: string): ScanMatch[] {
  const out: ScanMatch[] = [];
  text.split("\n").forEach((line, i) => {
    const hit = scanLine(line);
    if (hit) out.push({ file, line: i + 1, ...hit });
  });
  return out;
}

/** Secrets on the added lines of a unified diff, at their new-file line numbers. */
export function scanDiff(diff: string): ScanMatch[] {
  const out: ScanMatch[] = [];
  let file = "";
  let line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) {
      file = text.slice(4).replace(/^b\//, "");
      continue;
    }
    if (text.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith("+")) {
      const hit = scanLine(text.slice(1));
      if (hit) out.push({ file, line, ...hit });
      line++;
    } else if (text.startsWith(" ")) {
      line++;
    }
  }
  return out;
}
