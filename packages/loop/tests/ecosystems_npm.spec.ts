import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dependencyApi,
  dependencyFile,
  dependencyFiles,
  dependencyRuntime,
  resolveDependency,
} from "../src/ecosystems/index.js";

// DS-N9-1, DS-N9-6: the npm adapter over a real node_modules tree.

describe("the npm adapter (DS-N9-1)", () => {
  let repo: string;
  let outside: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "eco-npm-"));
    outside = mkdtempSync(join(tmpdir(), "eco-npm-out-"));
    writeFileSync(join(outside, "secret.txt"), "outside the package\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { widget: "^2" } }));
    writeFileSync(
      join(repo, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\npackages:\n\n  widget@2.3.0:\n    resolution: {}\n",
    );
    const pkg = join(repo, "node_modules", "widget");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "widget", version: "2.3.1", types: "dist/index.d.ts" }),
    );
    writeFileSync(
      join(pkg, "dist", "index.d.ts"),
      [
        "/** Spins the widget n times. */",
        "export declare function spin(n: number): void;",
        "export declare class Client {",
        "  readonly base: string;",
        "  get(url: string): Promise<string>;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(pkg, "README.md"), "# widget\n\nCall `spin(3)`.\n");
    symlinkSync(join(outside, "secret.txt"), join(pkg, "leak.txt"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("uses one version when the lockfiles pin several and none is installed (DS-N9-7)", () => {
    rmSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/widget": { version: "2.10.0" } },
      }),
    );
    const dep = resolveDependency(repo, "widget");
    expect(dep).toMatchObject({ version: "2.10.0", installed: false });
    expect(dep?.pinnedVersion).toBe("2.10.0, 2.3.0");
  });

  it("records the installed version and the lockfile pin when they differ", () => {
    const dep = resolveDependency(repo, "widget");
    expect(dep).toMatchObject({
      eco: "npm",
      name: "widget",
      version: "2.3.1",
      installedVersion: "2.3.1",
      pinnedVersion: "2.3.0",
      installed: true,
    });
    expect(resolveDependency(repo, "npm:widget")?.eco).toBe("npm");
    expect(resolveDependency(repo, "python:widget")).toBeUndefined();
  });

  it("labels a pinned package that is not installed with its lockfile version", () => {
    rmSync(join(repo, "node_modules"), { recursive: true });
    expect(resolveDependency(repo, "widget")).toMatchObject({
      version: "2.3.0",
      pinnedVersion: "2.3.0",
      installed: false,
    });
    expect(resolveDependency(repo, "widget")?.installedVersion).toBeUndefined();
  });

  it("lists the declarations and README, and reads the API surface for a symbol", async () => {
    const dep = resolveDependency(repo, "widget");
    if (!dep) throw new Error("unresolved");
    expect(dependencyFiles(dep)).toEqual(expect.arrayContaining(["README.md", "dist/index.d.ts"]));
    const api = await dependencyApi(repo, "widget", "Client.get");
    expect(api).toMatchObject({ found: true, version: "2.3.1", method: "static" });
    expect(api?.members).toEqual(expect.arrayContaining(["base", "get"]));
    expect(api?.exports).toEqual(expect.arrayContaining(["spin", "Client"]));
    const spin = await dependencyApi(repo, "widget", "spin");
    expect(spin?.declarations[0]).toMatchObject({ file: "dist/index.d.ts", line: 2 });
    expect(spin?.declarations[0]?.doc).toContain("Spins the widget");
    const missing = await dependencyApi(repo, "widget", "Client.post");
    expect(missing?.found).toBe(false);
    expect(missing?.members).toContain("get");
  });

  it("refuses a traversal and a symlink that leaves the package (DS-N9-6)", () => {
    const dep = resolveDependency(repo, "widget");
    if (!dep) throw new Error("unresolved");
    expect(dependencyFile(dep, "../../package.json")).toEqual({ ok: false, reason: "invalid" });
    expect(dependencyFile(dep, "/etc/passwd")).toEqual({ ok: false, reason: "invalid" });
    expect(dependencyFile(dep, "leak.txt")).toEqual({ ok: false, reason: "invalid" });
    expect(dependencyFiles(dep)).not.toContain("leak.txt");
    expect(dependencyFile(dep, "dist/index.d.ts")).toMatchObject({ ok: true });
  });

  it("rejects a name that is not a package name", () => {
    expect(resolveDependency(repo, "../etc")).toBeUndefined();
    expect(resolveDependency(repo, "a b")).toBeUndefined();
  });

  it("says what a probe needs to read (runtime)", () => {
    const rt = dependencyRuntime(repo, "npm");
    expect(rt.interpreter).toBe("node");
    expect(rt.readRoots).toEqual([realpathSync(join(repo, "node_modules"))]);
  });
});
