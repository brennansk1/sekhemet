import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SkillManifest {
  name: string;
  description: string;
  triggers: string[];
  content: string;
  path?: string;
}

export class SkillsRegistry {
  private skills: Map<string, SkillManifest> = new Map();

  public registerSkill(skill: SkillManifest): void {
    this.skills.set(skill.name, skill);
  }

  public getSkill(name: string): SkillManifest | undefined {
    return this.skills.get(name);
  }

  public getAllSkills(): SkillManifest[] {
    return Array.from(this.skills.values());
  }

  public getCompactSummary(): string {
    const lines: string[] = [];
    for (const s of this.skills.values()) {
      lines.push(`- ${s.name}: ${s.description} [triggers: ${s.triggers.join(", ")}]`);
    }
    return lines.join("\n");
  }

  public resolveActiveSkills(cardTitle: string, filesTouched: string[] = []): SkillManifest[] {
    const textToMatch = `${cardTitle} ${filesTouched.join(" ")}`.toLowerCase();
    const matched: SkillManifest[] = [];

    for (const skill of this.skills.values()) {
      const matchesTrigger = skill.triggers.some((trig) =>
        textToMatch.includes(trig.toLowerCase()),
      );
      if (matchesTrigger) {
        matched.push(skill);
      }
    }

    return matched;
  }

  public loadFromDirectory(dirPath: string): void {
    if (!existsSync(dirPath)) return;

    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = join(dirPath, entry.name, "SKILL.md");
        if (existsSync(skillMdPath)) {
          const content = readFileSync(skillMdPath, "utf8");
          const skill = this.parseSkillMarkdown(entry.name, content, skillMdPath);
          this.registerSkill(skill);
        }
      }
    }
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
