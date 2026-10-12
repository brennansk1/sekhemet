import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hooksCheck } from "../src/doctor.js";
import { hookEngineFor } from "../src/user_hooks.js";
import { setInvocationTrust } from "../src/workspace_trust.js";

/**
 * extensibility NEW-extensibility-2 — hooks that fail visibly. Real shell
 * hooks, real files.
 */
beforeAll(() => setInvocationTrust(true));
afterAll(() => setInvocationTrust(false));

let root: string;
let userDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-hooks-visible-"));
  userDir = join(root, "user");
  mkdirSync(userDir);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", userDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function project(toml: string): string {
  const repo = join(root, `repo-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  writeFileSync(join(repo, ".sekhemet", "hooks.toml"), toml);
  return repo;
}

describe("EXT-10: a broken hooks.toml is named, with its error, by doctor and to the card", () => {
  it("names the file and an unknown event", () => {
    const repo = project('[[hook]]\nevent = "pre-lunch"\ncommand = "true"\n');
    const check = hooksCheck(repo);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(join(repo, ".sekhemet", "hooks.toml"));
    expect(check.detail).toContain('unknown event "pre-lunch"');
    expect(hookEngineFor(repo).errors.join("\n")).toContain("hooks.toml");
  });

  it("names the file and invalid TOML", () => {
    const repo = project("[[hook]\nevent = ");
    const check = hooksCheck(repo);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(join(repo, ".sekhemet", "hooks.toml"));
    expect(hookEngineFor(repo).errors.length).toBe(1);
  });

  it("passes when every hook loads", () => {
    const repo = project('[[hook]]\nevent = "post-tool"\ncommand = "true"\n');
    expect(hooksCheck(repo).status).toBe("pass");
  });
});

describe("EXT-10, item 1: an untrusted hooks.toml is named as waiting for trust, with its errors", () => {
  beforeEach(() => {
    setInvocationTrust(false);
    vi.stubEnv("SEKHEMET_TRUST_DIR", join(root, "trust"));
  });
  afterEach(() => setInvocationTrust(true));

  it("does not pass 'none declared': it names the file, what it declares and the unknown event", () => {
    const repo = project(
      '[[hook]]\nevent = "pre-tool"\ntool = "write_file"\ncommand = "true"\n\n[[hook]]\nevent = "post-tolol"\ncommand = "true"\n',
    );
    // Nothing of it runs before trust.
    expect(hookEngineFor(repo).count).toBe(0);
    const check = hooksCheck(repo);
    expect(check.status).toBe("warn");
    expect(check.detail).not.toMatch(/none declared/);
    expect(check.detail).toContain(join(repo, ".sekhemet", "hooks.toml"));
    expect(check.detail).toMatch(/waits for trust/);
    expect(check.detail).toMatch(/2 hooks declared/);
    expect(check.detail).toContain('unknown event "post-tolol"');
    expect(check.do).toMatch(/sekhemet dev trust/);
  });

  it("names invalid TOML in an untrusted file", () => {
    const repo = project("[[hook]\nevent = ");
    const check = hooksCheck(repo);
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/waits for trust: none runs until you trust it/);
    expect(check.detail).toMatch(/hooks\.toml: hooks\.toml: /);
  });
});

describe("EXT-11: a hook that exits before reading its stdin does not crash the harness", () => {
  it("continues, reading the exit code as usual", async () => {
    const repo = project(
      '[[hook]]\nevent = "post-tool"\ncommand = "exit 0"\n\n[[hook]]\nevent = "pre-tool"\ncommand = "echo no >&2; exit 2"\n',
    );
    const { engine } = hookEngineFor(repo);
    // A context far larger than a pipe's buffer, so the write meets a closed pipe.
    const big = { cardId: "c1", toolName: "write_file", data: { blob: "x".repeat(4_000_000) } };
    const post = await engine.emit("post-tool", big);
    expect(post.blocked).toBe(false);
    expect(post.errors).toEqual([]);
    const pre = await engine.emit("pre-tool", big);
    expect(pre).toMatchObject({ blocked: true, reason: "no" });
  });
});

describe("EXT-12: a pre-tool hook past its timeout is killed and blocks", () => {
  it('blocks the tool call with the reason "hook timed out"', async () => {
    const repo = project('[[hook]]\nevent = "pre-tool"\ncommand = "sleep 30"\ntimeout_s = 1\n');
    const { engine } = hookEngineFor(repo);
    const started = Date.now();
    const r = await engine.emit("pre-tool", { cardId: "c1", toolName: "shell" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/^hook timed out/);
  });
});

describe("EXT-13: the person's hooks run first, then the trusted project's", () => {
  it("runs ~/.sekhemet/hooks.toml before .sekhemet/hooks.toml for one event", async () => {
    writeFileSync(
      join(userDir, "hooks.toml"),
      '[[hook]]\nevent = "pre-step"\ncommand = "echo \'{\\"message\\": \\"user\\"}\'"\n',
    );
    const repo = project(
      '[[hook]]\nevent = "pre-step"\ncommand = "echo \'{\\"message\\": \\"project\\"}\'"\n',
    );
    const { engine, count } = hookEngineFor(repo);
    expect(count).toBe(2);
    const r = await engine.emit("pre-step", { cardId: "c1", step: 1 });
    expect(r.messages.map((m) => m.content)).toEqual(["user", "project"]);
  });

  it("runs the person's hooks in a project with no hooks.toml", async () => {
    writeFileSync(
      join(userDir, "hooks.toml"),
      '[[hook]]\nevent = "pre-step"\ncommand = "echo \'{\\"message\\": \\"user\\"}\'"\n',
    );
    const repo = join(root, "bare");
    mkdirSync(repo);
    const r = await hookEngineFor(repo).engine.emit("pre-step", { cardId: "c1", step: 1 });
    expect(r.messages.map((m) => m.content)).toEqual(["user"]);
  });
});
