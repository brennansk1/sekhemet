import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { configParseErrors, resolveConfig } from "../src/config.js";
import { configurationCheck } from "../src/doctor.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { BIN, sandboxDirs, scriptedWorkerProject } from "./cli_fixture.js";

/**
 * Surface item 21, SUR-92 (FINDINGS_C1 REL-06, design-robustness ROB-7): a
 * `config.toml` that does not parse was dropped silently, so one typo reset
 * every setting in it. Now its error names the file, the line and the
 * column; `doctor` fails its Configuration check with them; and `run`,
 * `resume`, `queue` and `overnight` start nothing and exit 2.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWith(config: string): string {
  const repo = mkdtempSync(join(tmpdir(), "sek-cfg-parse-"));
  dirs.push(repo);
  const sek = join(repo, ".sekhemet");
  mkdirSync(sek);
  writeFileSync(join(sek, "config.toml"), config);
  return repo;
}

// Line 3, column 9: the value has no closing quote.
const BROKEN = '[queue]\nworker = "a"\nmode = "unterminated\n';

describe("a config.toml that does not parse (SUR-92)", () => {
  it("is named with its file, line and column", () => {
    const repo = repoWith(BROKEN);
    const path = join(repo, ".sekhemet", "config.toml");
    const errors = configParseErrors(repo, "/nonexistent/user.toml");
    expect(errors).toEqual([
      expect.objectContaining({ path, line: 3, column: 21, layer: "project" }),
    ]);
    expect(errors[0]?.text).toBe(`${path}:3:21: newline in basic string`);
    // The other layers still resolve, and the broken one is reported, not silent.
    const resolved = resolveConfig({ repoPath: repo, userConfigPath: "/nonexistent/user.toml" });
    expect(resolved.parseErrors.map((e) => e.text)).toEqual([errors[0]?.text]);
  });

  it("a header with no closing bracket is named at the bracket's line and column", () => {
    const repo = repoWith('[queue]\nworker = "a"\n\n  [machine\ntier = "S"\n');
    const [e] = configParseErrors(repo, "/nonexistent/user.toml");
    expect([e?.line, e?.column]).toEqual([4, 11]);
    expect(e?.message).toMatch(/expected \]/);
  });

  it("fails doctor's Configuration check with the same words", () => {
    const repo = repoWith(BROKEN);
    const path = join(repo, ".sekhemet", "config.toml");
    const c = configurationCheck(repo, "/nonexistent/user.toml");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain(`${path}:3:21: newline in basic string`);
    expect(c.detail).toMatch(/Do: /);
  });

  it("passes the check for files that parse, and names a refused value as a warning", () => {
    const good = repoWith('[queue]\nworker = "a"\n');
    expect(configurationCheck(good, "/nonexistent/user.toml").status).toBe("pass");
    const odd = repoWith('[log]\nlevel = "loud"\n');
    const c = configurationCheck(odd, "/nonexistent/user.toml");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/log\.level/);
  });
});

describe("run, resume, queue and overnight refuse a configuration that does not parse (SUR-92)", () => {
  it("each exits 2 naming file, line and column, and starts nothing", async () => {
    const where = sandboxDirs();
    const env = await scriptedWorkerProject(where);
    const path = join(where.cwd, ".sekhemet", "config.toml");
    writeFileSync(path, BROKEN);
    for (const args of [["run", "c1"], ["resume", "c1"], ["queue"], ["overnight"]]) {
      const r = spawnSync(process.execPath, [BIN, ...args], {
        cwd: where.cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...env.vars, SEKHEMET_MODEL_LOADS: "off" },
      });
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toContain(`${path}:3:21: newline in basic string`);
    }
    const { db, log } = openLocalLedger(where.cwd);
    const store = new CardStore(db, log);
    expect(store.runs.listAttempts("c1")).toEqual([]);
    db.close();
  }, 120_000);
});
