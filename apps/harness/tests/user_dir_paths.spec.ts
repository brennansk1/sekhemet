import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordResearchAnswer, researchAnswer } from "../src/research_consent.js";
import { trustDir } from "../src/workspace_trust.js";

// surface NEW-surface-1 (one user directory, SUR-25): workspace trust and the
// research answer live under `userDir()`, so `SEKHEMET_CONFIG_DIR` moves them
// with everything else — never a hard-coded `~/.sekhemet`.

describe("trust and the research answer follow the user directory", () => {
  const saved = {
    config: process.env.SEKHEMET_CONFIG_DIR,
    trust: process.env.SEKHEMET_TRUST_DIR,
    user: process.env.SEKHEMET_USER_CONFIG,
  };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sek-userdir-"));
    process.env.SEKHEMET_CONFIG_DIR = dir;
    Reflect.deleteProperty(process.env, "SEKHEMET_TRUST_DIR");
    Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
  });
  afterEach(() => {
    for (const [k, v] of [
      ["SEKHEMET_CONFIG_DIR", saved.config],
      ["SEKHEMET_TRUST_DIR", saved.trust],
      ["SEKHEMET_USER_CONFIG", saved.user],
    ] as const) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts the trust store at <user dir>/trust", () => {
    expect(trustDir()).toBe(join(dir, "trust"));
  });

  it("reads and records the research answer in <user dir>/config.toml", () => {
    writeFileSync(join(dir, "config.toml"), '[network]\nresearch = "no"\n');
    expect(researchAnswer()).toBe("no");
    recordResearchAnswer("yes");
    expect(researchAnswer(join(dir, "config.toml"))).toBe("yes");
  });
});
