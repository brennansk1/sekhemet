import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillsRegistry, parseFrontMatter } from "../src/skills.js";

/**
 * extensibility NEW-extensibility-4 — skills in the Agent Skills format, read
 * from real SKILL.md files.
 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-skills-format-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skill(dir: string, name: string, text: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), text);
}

const ECOSYSTEM = `---
name: pdf-forms
description: >
  Fill and flatten PDF forms, reading
  every field before writing values.
license: Apache-2.0
metadata:
  author: someone
---
# PDF forms

Read the fields first.
`;

describe("EXT-22: multi-line YAML front matter, no triggers", () => {
  it("parses a folded description, nested maps and lists", () => {
    const fm = parseFrontMatter(`${ECOSYSTEM}`);
    expect(fm.data.description).toBe(
      "Fill and flatten PDF forms, reading every field before writing values.",
    );
    expect(fm.data.name).toBe("pdf-forms");
    expect(fm.body.trim().startsWith("# PDF forms")).toBe(true);
    const lists = parseFrontMatter(
      "---\ntools:\n  - read_file\n  - shell\ntriggers: [ast, rename]\n---\nbody",
    );
    expect(lists.data.tools).toEqual(["read_file", "shell"]);
    expect(lists.data.triggers).toEqual(["ast", "rename"]);
  });

  it("loads the skill and selects it by its description", () => {
    const dir = join(root, "skills");
    skill(dir, "pdf-forms", ECOSYSTEM);
    const reg = new SkillsRegistry();
    reg.loadFromDirectory(dir, { lockPath: false });
    const s = reg.getSkill("pdf-forms");
    expect(s?.triggers).toEqual([]);
    expect(s?.description).toMatch(/^Fill and flatten PDF forms/);
    expect(reg.resolveActiveSkills("Flatten the PDF forms export").map((x) => x.name)).toEqual([
      "pdf-forms",
    ]);
    expect(reg.resolveActiveSkills("Add a login page")).toEqual([]);
  });
});

describe("EXT-23: triggers match whole words", () => {
  it("the trigger ast does not fire on last", () => {
    const reg = new SkillsRegistry();
    reg.registerSkill({ name: "ast-refactor", description: "x", triggers: ["ast"], content: "" });
    expect(reg.resolveActiveSkills("Show the last five orders")).toEqual([]);
    expect(reg.resolveActiveSkills("Rewrite the AST walker").map((s) => s.name)).toEqual([
      "ast-refactor",
    ]);
  });
});

describe("EXT-22a: a skill needing tools the card lacks is left out, and the omission recorded", () => {
  it("omits the manifest line and the body, naming the missing tools", () => {
    const reg = new SkillsRegistry();
    reg.registerSkill({
      name: "browser-check",
      description: "Check a page in a browser",
      triggers: ["page"],
      tools: ["browse"],
      content: "Open it.",
    });
    reg.registerSkill({ name: "plain", description: "y", triggers: ["page"], content: "Body." });
    const out = reg.skillsForPrompt("Fix the page title", [], {
      tools: ["read_file", "write_file"],
    });
    expect(out.map((s) => s.name)).toEqual(["plain"]);
    expect(reg.omitted()).toEqual([{ name: "browser-check", missingTools: ["browse"] }]);
    const all = reg.skillsForPrompt("Fix the page title", [], { tools: ["browse"] });
    expect(all.map((s) => s.name)).toEqual(["browser-check", "plain"]);
    expect(reg.omitted()).toEqual([]);
  });
});

describe("EXT-24: a user-level skill is offered unless the project has one by that name", () => {
  it("loads the person's skills, then the project's over them", () => {
    const user = join(root, "user-skills");
    const project = join(root, "project-skills");
    skill(
      user,
      "commit-style",
      "---\ndescription: user commit style\ntriggers: [commit]\n---\nUser body",
    );
    skill(user, "shared", "---\ndescription: user shared\ntriggers: [shared]\n---\nUser shared");
    skill(
      project,
      "shared",
      "---\ndescription: project shared\ntriggers: [shared]\n---\nProject shared",
    );
    const reg = new SkillsRegistry();
    reg.loadFromDirectory(user, { lockPath: false, scope: "user" });
    reg.loadFromDirectory(project, { lockPath: false, scope: "project" });
    expect(reg.getSkill("commit-style")?.content).toBe("User body");
    expect(reg.getSkill("shared")?.content).toBe("Project shared");
    expect(reg.resolveActiveSkills("Tidy the commit message").map((s) => s.name)).toEqual([
      "commit-style",
    ]);
  });
});

describe("EXT-25: budget_tokens is read — a long body is cut at a section boundary", () => {
  it("truncates at the last heading that fits and records the truncation", () => {
    const section = (n: number) => `## Part ${n}\n${"word ".repeat(120)}\n`;
    const dir = join(root, "skills");
    skill(
      dir,
      "long",
      `---\ndescription: long\ntriggers: [long]\nbudget_tokens: 400\n---\n${section(1)}${section(2)}${section(3)}${section(4)}`,
    );
    const reg = new SkillsRegistry();
    reg.loadFromDirectory(dir, { lockPath: false });
    const [s] = reg.skillsForPrompt("a long card", []).filter((x) => x.disclosure === "full");
    expect(s?.content).toContain("## Part 1");
    expect(s?.content).not.toContain("## Part 4");
    expect(s?.content.endsWith("\n") || s?.content.includes("Part")).toBe(true);
    expect(s?.truncated).toMatchObject({ budgetTokens: 400 });
    expect((s?.truncated?.keptTokens ?? 0) <= 400).toBe(true);
    // Cut on a heading, never mid-section.
    expect(s?.content.trimEnd().split("\n").at(-1)).toMatch(/word$/);
  });
});
