import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";

/**
 * B4.1 step 0: `[models] folders` (surface item 23, models rule 4a,
 * MD-N13-1) and `[machine] overnight_hours` beside the canonical
 * `reserved_hours` (surface items 23 and 25, models rule 20, MD-N3-4).
 */
describe("[models] folders and [machine] reserved_hours / overnight_hours", () => {
  let repo: string;
  let userConfig: string;
  const write = (path: string, text: string) => writeFileSync(path, text);
  const project = (text: string) => {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    write(join(repo, ".sekhemet", "config.toml"), text);
  };
  const resolve = () => resolveConfig({ repoPath: repo, userConfigPath: userConfig });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-config-b41-"));
    userConfig = join(repo, "user.toml");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("defaults: no folders, the design's reserved hours, no overnight narrowing", () => {
    const { config, problems } = resolve();
    expect(config.models.folders).toEqual([]);
    expect(config.machine.reservedHours).toBe("08:00-18:00 Mon-Fri");
    expect(config.machine.overnightHours).toBeUndefined();
    expect(DEFAULT_CONFIG.models.folders).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("reads folders as paths or { path, subfolders } tables, subfolders off unless set (MD-N13-1)", () => {
    write(
      userConfig,
      '[models]\nfolders = ["/models/a", { path = "/models/b", subfolders = true }, { path = "/models/c" }, 7, { subfolders = true }]\n',
    );
    expect(resolve().config.models.folders).toEqual([
      { path: "/models/a", includeSubfolders: false },
      { path: "/models/b", includeSubfolders: true },
      { path: "/models/c", includeSubfolders: false },
    ]);
  });

  it("reads folders from the user config only: a repository cannot point the scan anywhere (models rule 4a)", () => {
    write(userConfig, '[models]\nfolders = ["/mine"]\n');
    project('[models]\nfolders = ["/etc", "/Users/someone"]\n');
    expect(resolve().config.models.folders).toEqual([{ path: "/mine", includeSubfolders: false }]);
    const card = resolveConfig({
      repoPath: repo,
      userConfigPath: userConfig,
      cardOverrides: { models: { folders: ["/card"] } },
      cliOverrides: { models: { folders: ["/cli"] } },
    });
    expect(card.config.models.folders).toEqual([{ path: "/mine", includeSubfolders: false }]);
  });

  it("reads reserved_hours and overnight_hours; the old name hours is read as reserved_hours and reported (surface item 25)", () => {
    write(
      userConfig,
      '[machine]\nreserved_hours = "09:00-17:00 Mon-Fri"\novernight_hours = "22:00-06:00"\n',
    );
    const a = resolve();
    expect(a.config.machine.reservedHours).toBe("09:00-17:00 Mon-Fri");
    expect(a.config.machine.overnightHours).toBe("22:00-06:00");
    // The old field stays a read-only alias of the canonical value for its readers.
    expect(a.config.machine.hours).toBe("09:00-17:00 Mon-Fri");
    expect(a.problems).toEqual([]);

    write(userConfig, '[machine]\nhours = "07:00-15:00"\n');
    const b = resolve();
    expect(b.config.machine.reservedHours).toBe("07:00-15:00");
    expect(b.config.machine.hours).toBe("07:00-15:00");
    expect(b.problems.join("\n")).toMatch(/machine\.hours.*reserved_hours/);

    // The canonical name wins over the old one when both are set.
    write(userConfig, '[machine]\nhours = "07:00-15:00"\nreserved_hours = "10:00-12:00"\n');
    expect(resolve().config.machine.reservedHours).toBe("10:00-12:00");
  });

  it("refuses an overnight_hours it cannot read, naming the key, and applies none", () => {
    write(userConfig, '[machine]\novernight_hours = "tonight"\n');
    const { config, problems } = resolve();
    expect(config.machine.overnightHours).toBeUndefined();
    expect(problems.join("\n")).toMatch(/machine\.overnight_hours/);
  });
});

/**
 * B4.4: the config module owns `[docs] product`, `decisions` and `no_names`
 * (design-stage DS-N3-3, -4, -6); the project documents read them through it.
 * A value it cannot use, or a key it does not know, is refused and named.
 */
describe("[docs] product, decisions and no_names", () => {
  let repo: string;
  const project = (text: string) => {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "config.toml"), text);
  };
  const resolve = () => resolveConfig({ repoPath: repo, userConfigPath: join(repo, "u.toml") });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-config-docs-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("defaults: no folder configured, names shown", () => {
    const { config, problems } = resolve();
    expect(config.docs).toEqual({ noNames: false });
    expect(problems).toEqual([]);
  });

  it("reads the folders, repository-relative, and no_names", () => {
    project(
      '[docs]\nproduct = "./handbook/product/"\ndecisions = "handbook/adr"\nno_names = true\n',
    );
    const { config, problems } = resolve();
    expect(config.docs).toEqual({
      product: "handbook/product",
      decisions: "handbook/adr",
      noNames: true,
    });
    expect(problems).toEqual([]);
  });

  it("refuses a folder outside the repository, a no_names that is not true or false, and an unknown key", () => {
    project(
      '[docs]\nproduct = "/etc"\ndecisions = "../elsewhere"\nno_names = "yes"\nfolder = "x"\n',
    );
    const { config, problems } = resolve();
    expect(config.docs).toEqual({ noNames: false });
    expect(problems.join("\n")).toMatch(/docs\.product/);
    expect(problems.join("\n")).toMatch(/docs\.decisions/);
    expect(problems.join("\n")).toMatch(/docs\.no_names/);
    expect(problems.join("\n")).toMatch(/docs\.folder/);
  });
});
