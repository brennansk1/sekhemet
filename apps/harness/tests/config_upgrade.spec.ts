import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { configUpgradeCheck, upgradeConfigKeys } from "../src/config_upgrade.js";

/**
 * SUR-43 (surface item 32): an upgrade that finds renamed config keys backs
 * `config.toml` up, rewrites the keys, and `doctor` reports each change.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(config: string): string {
  const root = mkdtempSync(join(tmpdir(), "cfg-upgrade-"));
  dirs.push(root);
  mkdirSync(join(root, ".sekhemet"));
  writeFileSync(join(root, ".sekhemet", "config.toml"), config);
  return root;
}

const OLD = [
  "# mine",
  "[machine]",
  'hours = "09:00-17:00 Mon-Fri" # my hours',
  "power_budget_kwh_day = 2",
  "",
  "[network]",
  'mode = "offline"',
  "",
].join("\n");

describe("SUR-43: renamed config keys are rewritten after a backup, and doctor reports them", () => {
  it("backs up, rewrites [machine] hours to reserved_hours, keeps comments, and reports", () => {
    const root = repo(OLD);
    const file = join(root, ".sekhemet", "config.toml");
    const r = upgradeConfigKeys(file);
    expect(r.changes).toEqual([{ section: "machine", from: "hours", to: "reserved_hours" }]);
    expect(readFileSync(r.backup as string, "utf8")).toBe(OLD);
    const now = readFileSync(file, "utf8");
    expect(now).toContain('reserved_hours = "09:00-17:00 Mon-Fri" # my hours');
    expect(now).not.toMatch(/^hours =/m);
    expect(now).toContain("# mine");
    // The config readers see the same value under the new name.
    expect(resolveConfig({ repoPath: root }).config.machine.reservedHours).toBe(
      "09:00-17:00 Mon-Fri",
    );
    const check = configUpgradeCheck([file]);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("[machine] hours → reserved_hours");
    expect(check.detail).toContain(".bak");
  });

  it("changes nothing, writes no backup and reports nothing when no key was renamed", () => {
    const root = repo('[machine]\nreserved_hours = "08:00-18:00"\n');
    const file = join(root, ".sekhemet", "config.toml");
    expect(upgradeConfigKeys(file)).toEqual({ changes: [] });
    expect(configUpgradeCheck([file]).status).toBe("pass");
  });

  it("leaves an old key alone when the new one is already set", () => {
    const text = '[machine]\nhours = "1"\nreserved_hours = "2"\n';
    const root = repo(text);
    const file = join(root, ".sekhemet", "config.toml");
    expect(upgradeConfigKeys(file).changes).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  // B4.1 half-A fix round (minor): each upgrade keeps its own backup, named
  // by its time; a later upgrade never overwrites an earlier backup.
  it("a second upgrade writes a new, timestamped backup and keeps the first", () => {
    const root = repo(OLD);
    const file = join(root, ".sekhemet", "config.toml");
    const first = upgradeConfigKeys(file);
    const edited = OLD.replace("# mine", "# mine, edited");
    writeFileSync(file, edited);
    const second = upgradeConfigKeys(file);
    expect(first.backup).toMatch(/config\.toml\.pre-upgrade-\d{8}T\d{6}(\.\d+)?Z(-\d+)?\.bak$/);
    expect(second.backup).toBeDefined();
    expect(second.backup).not.toBe(first.backup);
    expect(readFileSync(first.backup as string, "utf8")).toBe(OLD);
    expect(readFileSync(second.backup as string, "utf8")).toBe(edited);
  });
});
