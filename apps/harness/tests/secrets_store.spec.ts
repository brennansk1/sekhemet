import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings, writeSettings } from "../src/integrations.js";

/**
 * S3c, security item 35 (SEC-27): integration tokens written to a file are
 * mode 0600 in a 0700 directory, and wider modes on an existing file or
 * directory are corrected. Real files and real modes.
 */
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe("S3c: integration tokens out of reach", () => {
  it("SEC-27: a saved token file is 0600 in a 0700 directory, and wider modes are corrected", () => {
    const base = mkdtempSync(join(tmpdir(), "tokens-"));
    dirs.push(base);
    vi.stubEnv("SEKHEMET_CONFIG_DIR", base);
    const repo = mkdtempSync(join(tmpdir(), "tokens-repo-"));
    dirs.push(repo);

    writeSettings(repo, { slackWebhookUrl: "https://hooks.slack.test/T0/B0/secret" });
    const reposDir = join(base, "repos");
    const [file] = readdirSync(reposDir);
    const path = join(reposDir, file as string);
    expect(mode(path)).toBe(0o600);
    expect(mode(reposDir)).toBe(0o700);
    expect(mode(base)).toBe(0o700);

    // Someone widened them: the next save corrects both.
    chmodSync(path, 0o644);
    chmodSync(reposDir, 0o755);
    writeSettings(repo, { researchWeb: true });
    expect(mode(path)).toBe(0o600);
    expect(mode(reposDir)).toBe(0o700);

    // And so does the next read.
    chmodSync(path, 0o666);
    expect(readSettings(repo).researchWeb).toBe(true);
    expect(mode(path)).toBe(0o600);
  });

  it("SEC-27: an existing wider directory is corrected before anything is written into it", () => {
    const base = mkdtempSync(join(tmpdir(), "tokens-"));
    dirs.push(base);
    vi.stubEnv("SEKHEMET_CONFIG_DIR", base);
    mkdirSync(join(base, "repos"), { mode: 0o777 });
    chmodSync(join(base, "repos"), 0o777);
    writeFileSync(join(base, "unrelated"), "x");
    const repo = mkdtempSync(join(tmpdir(), "tokens-repo-"));
    dirs.push(repo);
    writeSettings(repo, { researchWeb: false });
    expect(mode(join(base, "repos"))).toBe(0o700);
  });
});
