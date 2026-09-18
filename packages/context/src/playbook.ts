import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PlaybookRule {
  id: string;
  originCard?: string;
  triggerGate?: string;
  pattern: string;
  instruction: string;
  effectiveDate?: string;
  evalPassRateDelta?: string;
}

export class PlaybookRegistry {
  private rules: Map<string, PlaybookRule> = new Map();
  private filePath: string;

  constructor(repoRoot: string) {
    this.filePath = join(repoRoot, ".sekhemet", "playbook.toml");
    this.load();
  }

  public load(): void {
    this.rules.clear();
    if (!existsSync(this.filePath)) {
      return;
    }

    try {
      const content = readFileSync(this.filePath, "utf-8");
      this.parseToml(content);
    } catch {
      // Fallback on corrupt or empty file
    }
  }

  public save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const lines: string[] = ["# Sekhemet Project Playbook — Versioned Invariant Rules", ""];
    for (const rule of this.rules.values()) {
      lines.push("[[rule]]");
      lines.push(`id = "${rule.id}"`);
      if (rule.originCard) lines.push(`originCard = "${rule.originCard}"`);
      if (rule.triggerGate) lines.push(`triggerGate = "${rule.triggerGate}"`);
      lines.push(`pattern = "${rule.pattern.replace(/"/g, '\\"')}"`);
      lines.push(`instruction = "${rule.instruction.replace(/"/g, '\\"')}"`);
      if (rule.effectiveDate) lines.push(`effectiveDate = "${rule.effectiveDate}"`);
      if (rule.evalPassRateDelta) lines.push(`evalPassRateDelta = "${rule.evalPassRateDelta}"`);
      lines.push("");
    }

    writeFileSync(this.filePath, lines.join("\n"), "utf-8");
  }

  public getAllRules(): PlaybookRule[] {
    return Array.from(this.rules.values());
  }

  public addRule(rule: PlaybookRule): void {
    this.rules.set(rule.id, rule);
    this.save();
  }

  public retireRule(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) {
      this.save();
    }
    return deleted;
  }

  public matchRules(options: {
    cardTitle?: string;
    scopeFiles?: string[];
    triggerGate?: string;
  }): PlaybookRule[] {
    const matched: PlaybookRule[] = [];
    const textToMatch =
      `${options.cardTitle ?? ""} ${(options.scopeFiles ?? []).join(" ")}`.toLowerCase();

    for (const rule of this.rules.values()) {
      let isMatch = false;

      if (options.triggerGate && rule.triggerGate) {
        if (rule.triggerGate.toLowerCase() === options.triggerGate.toLowerCase()) {
          isMatch = true;
        }
      }

      if (rule.pattern && textToMatch.includes(rule.pattern.toLowerCase())) {
        isMatch = true;
      }

      if (isMatch) {
        matched.push(rule);
      }
    }

    return matched;
  }

  public auditContextDebt(): { ruleId: string; tokenEstimate: number; flaggedDebt: boolean }[] {
    const results: { ruleId: string; tokenEstimate: number; flaggedDebt: boolean }[] = [];
    for (const rule of this.rules.values()) {
      // Rough 4 chars per token estimate
      const tokenEstimate = Math.ceil((rule.pattern.length + rule.instruction.length) / 4);
      results.push({
        ruleId: rule.id,
        tokenEstimate,
        flaggedDebt: tokenEstimate > 300, // Section 1186: rules adding >300 tokens flagged
      });
    }
    return results;
  }

  private parseToml(content: string): void {
    const blocks = content.split(/\[\[rule\]\]/g);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const rule: Partial<PlaybookRule> = {};
      const lines = trimmed.split("\n");
      for (const line of lines) {
        const match = line.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*"(.*)"\s*$/);
        if (match) {
          const key = match[1];
          const val = (match[2] ?? "").replace(/\\"/g, '"');
          if (key === "id") rule.id = val;
          else if (key === "originCard") rule.originCard = val;
          else if (key === "triggerGate") rule.triggerGate = val;
          else if (key === "pattern") rule.pattern = val;
          else if (key === "instruction") rule.instruction = val;
          else if (key === "effectiveDate") rule.effectiveDate = val;
          else if (key === "evalPassRateDelta") rule.evalPassRateDelta = val;
        }
      }

      if (rule.id && rule.pattern && rule.instruction) {
        this.rules.set(rule.id, rule as PlaybookRule);
      }
    }
  }
}
