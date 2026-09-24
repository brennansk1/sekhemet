import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginsCheck, runDoctor } from "../src/doctor.js";

/**
 * B0: the approved cuts stay cut (DEC-09, DEC-29 O4, DEC-25 R31, EXT-28, EXT-28a).
 * These read the workspace itself, so a cut module that comes back — or a new
 * import of one — fails here rather than in review.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const productSources = (): string[] =>
  ["packages", "apps"].flatMap((top) =>
    readdirSync(join(ROOT, top), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(ROOT, top, d.name, "src")))
      .flatMap((d) => sourceFiles(join(ROOT, top, d.name, "src"))),
  );

describe("B0 cuts (EXT-28a, DEC-09, DEC-25 R31)", () => {
  it("has no @sekhemet/sdk package in the workspace", () => {
    const names = ["packages", "apps"].flatMap((top) =>
      readdirSync(join(ROOT, top), { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(ROOT, top, d.name, "package.json")))
        .map(
          (d) =>
            (
              JSON.parse(readFileSync(join(ROOT, top, d.name, "package.json"), "utf8")) as {
                name: string;
              }
            ).name,
        ),
    );
    expect(names).not.toContain("@sekhemet/sdk");
    expect(readFileSync(join(ROOT, "tsconfig.json"), "utf8")).not.toContain("packages/sdk");
  });

  it("exports no ServiceContainer or PluginManager from the kernel barrel", async () => {
    const kernel = (await import("@sekhemet/kernel")) as Record<string, unknown>;
    expect(kernel.ServiceContainer).toBeUndefined();
    expect(kernel.PluginManager).toBeUndefined();
  });

  it("imports none of the cut modules and names none of their symbols", () => {
    const cut =
      /\b(ServiceContainer|PluginManager|VirtualCanvasManager|DefaultContextEngine|buildFullPromptPack|VariantArchive|evolvePrompts|reflectiveMutator|siftProposals|ResearchInbox)\b|from ["'][^"']*\/(container|canvas|engine|archive|desk)\.js["']/;
    const offenders = productSources()
      .filter((f) => cut.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("reads .sekhemet/plugins nowhere but the doctor's warning", () => {
    const readers = productSources()
      .filter((f) => readFileSync(f, "utf8").includes('"plugins"'))
      .map((f) => relative(ROOT, f));
    expect(readers).toEqual(["apps/harness/src/doctor.ts"]);
  });
});

describe("doctor on a repository with plugins (EXT-28)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("warns that plugins are not supported and names hooks and MCP servers", () => {
    dir = mkdtempSync(join(tmpdir(), "sek-plugins-"));
    mkdirSync(join(dir, ".sekhemet", "plugins", "legacy"), { recursive: true });
    writeFileSync(join(dir, ".sekhemet", "plugins", "legacy", "index.mjs"), "export default {};\n");
    const c = pluginsCheck(dir);
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/not supported/);
    expect(c.detail).toMatch(/hooks/);
    expect(c.detail).toMatch(/MCP servers/);
    expect(c.detail).toContain("legacy");
  });

  it("is part of the doctor's report", async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-plugins-"));
    mkdirSync(join(dir, ".sekhemet", "plugins", "legacy"), { recursive: true });
    const report = await runDoctor(dir);
    const plugins = report.checks.find((c) => c.name === "Plugins");
    expect(plugins?.status).toBe("warn");
    expect(plugins?.detail).toMatch(/not supported/);
  }, 30_000);

  it("passes when the repository has no plugins directory", () => {
    dir = mkdtempSync(join(tmpdir(), "sek-plugins-"));
    expect(pluginsCheck(dir).status).toBe("pass");
  });
});
