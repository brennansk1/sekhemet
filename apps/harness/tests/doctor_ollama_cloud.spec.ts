import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { ollamaCloudCheck } from "../src/doctor.js";

// MD-N20-2 (NEW-models-20, DEC-55): a role whose configuration already names
// an Ollama cloud model fails doctor's check with the refusal's words.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-doc-cloud-"));
  dirs.push(d);
  return d;
};

describe("doctor: Ollama cloud models (MD-N20-2)", () => {
  it("passes when no role names a cloud model", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordRoleAssignment("h", {
      role: "planner",
      model: "qwen3:8b",
      scope: "personal",
      by: "person: ada",
      date: new Date().toISOString(),
    });
    const c = ollamaCloudCheck(tmp(), reg, "h");
    expect(c.status).toBe("pass");
  });

  it("fails a role whose assignment names a cloud tag, in the refusal's words", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordRoleAssignment("h", {
      role: "reviewer",
      model: "gpt-oss:120b-cloud",
      scope: "personal",
      by: "person: ada",
      date: new Date().toISOString(),
    });
    const c = ollamaCloudCheck(tmp(), reg, "h");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("gpt-oss:120b-cloud");
    expect(c.detail).toContain("Review model");
    expect(c.detail).toMatch(/prompts would leave this machine/);
  });

  it("fails the Coding model when the project's config.toml names a cloud tag", () => {
    const repo = tmp();
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "config.toml"), '[models]\nexecutor = "kimi-k2:cloud"\n');
    const c = ollamaCloudCheck(repo, new ModelRegistry(join(tmp(), "models.json")), "h");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("kimi-k2:cloud");
    expect(c.detail).toContain("Coding model");
  });
});
