import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { configurationCheck } from "../src/doctor.js";
import { BIN } from "./cli_fixture.js";

/**
 * C-18, upgrade replay (FINISH_LINE_PLAN W8; surface item 32): a ledger and a
 * configuration written by an earlier release — one per schema boundary,
 * recorded from its own commit by `scripts/record_schema_fixtures.mjs` —
 * load under this build through the product's own door (`sekhemet status
 * --json`, the built binary), with no gap and no refusal: every issue as the
 * old build left it, the renamed configuration keys rewritten after a backup,
 * and every setting the old file held still in force.
 */

const FIXTURES = resolve(import.meta.dirname, "../../../packages/kernel/tests/fixtures/schemas");
const NAMES = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".db"))
  .map((f) => f.slice(0, -3))
  .sort();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("C-18: an earlier release's ledger and configuration load and replay (W8)", () => {
  it("covers every recorded boundary", () => {
    expect(NAMES).toContain("v21-previous-release");
    expect(NAMES.length).toBeGreaterThanOrEqual(5);
  });

  for (const name of NAMES) {
    it(`${name}: sekhemet status shows every issue; the configuration keeps every setting`, () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `sek-c18-${name}-`)));
      dirs.push(root);
      const home = join(root, "home");
      const repo = join(root, "repo");
      mkdirSync(home);
      mkdirSync(join(repo, ".sekhemet"), { recursive: true });
      const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "T");
      git("commit", "-q", "--allow-empty", "-m", "seed");
      copyFileSync(join(FIXTURES, `${name}.db`), join(repo, ".sekhemet", "events.db"));
      copyFileSync(join(FIXTURES, `${name}.config.toml`), join(repo, ".sekhemet", "config.toml"));
      const before = readFileSync(join(repo, ".sekhemet", "config.toml"), "utf8");
      const recorded = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as {
        cards: { id: string; status: string; title: string }[];
      };
      const r = spawnSync(process.execPath, [BIN, "status", "--json"], {
        cwd: repo,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
          SEKHEMET_USER_CONFIG: join(home, "config.toml"),
          SEKHEMET_MODEL_LOADS: "off",
          BROWSER: "false",
        },
      });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as {
        ok: boolean;
        columns: { issues: { id: string; title: string; status: string }[] }[];
      };
      expect(out.ok).toBe(true);
      const issues = out.columns
        .flatMap((c) => c.issues)
        .map((i) => ({ id: i.id, status: i.status, title: i.title }))
        .sort((a, b) => a.id.localeCompare(b.id));
      expect(issues).toEqual(recorded.cards);

      // The configuration: an old key name is rewritten after a backup, and
      // every value the old file set is still in force.
      const sek = readdirSync(join(repo, ".sekhemet"));
      if (/^hours = /m.test(before)) {
        expect(sek.some((f) => /^config\.toml\.pre-upgrade-.*\.bak$/.test(f))).toBe(true);
        expect(readFileSync(join(repo, ".sekhemet", "config.toml"), "utf8")).toMatch(
          /^reserved_hours = "09:00-17:00 Mon-Fri"$/m,
        );
      }
      const userPath = join(home, "config.toml");
      const resolved = resolveConfig({ repoPath: repo, userConfigPath: userPath });
      expect(resolved.parseErrors).toEqual([]);
      expect(resolved.problems).toEqual([]);
      expect(resolved.config.machine.reservedHours).toBe("09:00-17:00 Mon-Fri");
      expect(resolved.config.machine.powerBudgetKwhDay).toBe(2);
      expect(resolved.config.review.reviewMinutesPerDay).toBe(45);
      expect(resolved.config.network.mode).toBe("offline");
      expect(configurationCheck(repo, userPath).status).toBe("pass");
    }, 90_000);
  }
});
