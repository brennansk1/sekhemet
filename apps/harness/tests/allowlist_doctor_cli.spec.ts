import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, g2Dirs, g2Env } from "./support/g2_cli.js";

/**
 * SEC-15b (security item 31a; C2d finding, routed to C5): an allowlist entry
 * that is a wildcard or an upload-capable host is warned about where a person
 * meets it — `sekhemet doctor`, the check run after configuring — and not
 * only on each card that runs under it. The built `apps/harness/dist/index.js`
 * spawned over a real repository; nothing leaves the machine.
 */

function project(networkAllow: string[]): { cwd: string; home: string } {
  const where = g2Dirs();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: where.cwd });
  mkdirSync(join(where.cwd, ".sekhemet"), { recursive: true });
  writeFileSync(
    join(where.cwd, ".sekhemet", "gates.toml"),
    `[project]\nnetwork_allow = ${JSON.stringify(networkAllow)}\n\n[[gate]]\nid = "unit"\nrung = "test"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\nparser = "generic"\ntimeout_s = 30\n`,
  );
  return where;
}

describe("doctor warns about a wildcard or upload-capable allowlist entry (SEC-15b)", () => {
  it("SEC-15b: names each such entry of [project] network_allow with its reason, as a warning, and leaves a plain registry host alone", async () => {
    const where = project(["*.example.com", "pastebin.com", "registry.npmjs.org"]);
    const r = await cli(["doctor"], { cwd: where.cwd, env: g2Env(where.home), timeoutMs: 120_000 });
    const out = r.stdout + r.stderr;
    const line = out.split("\n").find((l) => /Network allowlist/.test(l)) ?? "";
    expect(line, out).toMatch(/^\s+! Network allowlist: /);
    expect(line).toMatch(/\*\.example\.com \(a wildcard entry allows every subdomain\)/);
    expect(line).toMatch(/pastebin\.com \(an upload-capable host can carry data out\)/);
    expect(line).not.toMatch(/registry\.npmjs\.org/);
  }, 150_000);

  it("SEC-15b: with no such entry, the check passes", async () => {
    const where = project(["registry.npmjs.org"]);
    const r = await cli(["doctor"], { cwd: where.cwd, env: g2Env(where.home), timeoutMs: 120_000 });
    const line = (r.stdout + r.stderr).split("\n").find((l) => /Network allowlist/.test(l)) ?? "";
    expect(line, r.stdout).toMatch(/^\s+✓ Network allowlist: /);
  }, 150_000);
});
