import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { userDirCheck } from "../src/doctor.js";
import { readSettings, writeSettings } from "../src/integrations.js";
import { loadMcpConfig } from "../src/mcp_client.js";
import { migrateLegacyUserDir, userDir, userPaths } from "../src/user_dir.js";

/**
 * surface NEW-surface-1 — one user directory. Real files under a scratch HOME
 * and a scratch SEKHEMET_CONFIG_DIR.
 */
let root: string;
let home: string;
let dir: string;
let repo: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-userdir-"));
  home = join(root, "home");
  dir = join(root, "sekhemet-user");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  vi.stubEnv("HOME", home);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", dir);
  vi.stubEnv("SEKHEMET_USER_CONFIG", undefined as unknown as string);
  vi.stubEnv("SEKHEMET_MODEL_REGISTRY", undefined as unknown as string);
  vi.stubEnv("SEKHEMET_MACHINE_PROFILE", undefined as unknown as string);
  vi.stubEnv("SEKHEMET_TRUST_DIR", undefined as unknown as string);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("SUR-25: SEKHEMET_CONFIG_DIR holds every piece of user state", () => {
  it("names one directory for config, registry, machine profile, integrations, trust, learning, research and MCP", () => {
    expect(userDir()).toBe(dir);
    for (const [name, path] of Object.entries(userPaths())) {
      expect(path.startsWith(`${dir}/`), `${name}: ${path}`).toBe(true);
    }
  });

  it("reads user config and MCP servers from it, and writes integration settings only under it", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.toml"), "[loop]\ndefault_step_budget = 17\n");
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { mine: { command: "true" } } }),
    );
    expect(resolveConfig({ repoPath: repo }).config.loop.defaultStepBudget).toBe(17);
    expect(Object.keys(loadMcpConfig(repo))).toEqual(["mine"]);

    writeSettings(repo, { slackWebhook: "https://hooks.example/x" } as never);
    expect(readSettings(repo)).toMatchObject({ slackWebhook: "https://hooks.example/x" });
    expect(existsSync(join(dir, "repos"))).toBe(true);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(join(home, ".sekhemet"))).toBe(false);
  });
});

describe("SUR-26: the old ~/.config/sekhemet is moved once, and doctor says so", () => {
  it("moves each file, reports the move, and does nothing the second time", () => {
    vi.stubEnv("SEKHEMET_CONFIG_DIR", undefined as unknown as string);
    const legacy = join(home, ".config", "sekhemet");
    mkdirSync(join(legacy, "repos"), { recursive: true });
    mkdirSync(join(legacy, "research"), { recursive: true });
    writeFileSync(join(legacy, "global_playbook.json"), "[]\n");
    writeFileSync(join(legacy, "repos", "r-0123.json"), "{}\n");
    writeFileSync(join(legacy, "research", "memory.jsonl"), "");

    const first = migrateLegacyUserDir();
    expect(first.moved.sort()).toEqual(["global_playbook.json", "repos", "research"]);
    const target = join(home, ".sekhemet");
    expect(readFileSync(join(target, "global_playbook.json"), "utf8")).toBe("[]\n");
    expect(existsSync(join(target, "repos", "r-0123.json"))).toBe(true);
    expect(existsSync(legacy)).toBe(false);

    const check = userDirCheck();
    expect(check.detail).toMatch(/moved 3 .*\.config\/sekhemet/);

    const second = migrateLegacyUserDir();
    expect(second.moved).toEqual([]);
    expect(userDirCheck().detail).toMatch(/moved 3/);
  });

  it("keeps a legacy file whose name is already taken, and doctor warns about it", () => {
    vi.stubEnv("SEKHEMET_CONFIG_DIR", undefined as unknown as string);
    const legacy = join(home, ".config", "sekhemet");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(home, ".sekhemet"), { recursive: true });
    writeFileSync(join(legacy, "global_playbook.json"), "old\n");
    writeFileSync(join(home, ".sekhemet", "global_playbook.json"), "new\n");
    const r = migrateLegacyUserDir();
    expect(r.moved).toEqual([]);
    expect(r.kept).toEqual(["global_playbook.json"]);
    expect(readFileSync(join(home, ".sekhemet", "global_playbook.json"), "utf8")).toBe("new\n");
    const check = userDirCheck();
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("global_playbook.json");
  });
});
