import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dependencyApi,
  dependencyFile,
  dependencyFiles,
  dependencyRuntime,
  escapeModulePath,
  resolveDependency,
} from "../src/ecosystems/index.js";

// DS-N9-3, DS-N9-6: the Go adapter over a module cache laid out as `go mod
// download` lays it out (case-escaped paths, `<module>@<version>`).

const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("the Go adapter (DS-N9-3)", () => {
  let repo: string;
  let cache: string;
  let outside: string;
  const saved = process.env.GOMODCACHE;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "eco-go-"));
    cache = mkdtempSync(join(tmpdir(), "eco-gomod-"));
    outside = mkdtempSync(join(tmpdir(), "eco-go-out-"));
    writeFileSync(join(outside, "secret.go"), "package secret\n");
    process.env.GOMODCACHE = cache;
    writeFileSync(
      join(repo, "go.mod"),
      [
        "module example.com/app",
        "",
        "go 1.22",
        "",
        "require (",
        "\tgithub.com/BurntSushi/toml v1.3.2",
        "\tgithub.com/spf13/cobra v1.8.0",
        "\tgolang.org/x/text v0.14.0 // indirect",
        ")",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, "go.sum"),
      [
        "github.com/BurntSushi/toml v1.3.2 h1:a=",
        "github.com/BurntSushi/toml v1.3.2/go.mod h1:b=",
        "github.com/spf13/cobra v1.8.0 h1:c=",
        "",
      ].join("\n"),
    );
    const toml = join(cache, "github.com", "!burnt!sushi", "toml@v1.3.2");
    mkdirSync(join(toml, "internal"), { recursive: true });
    writeFileSync(join(toml, "go.mod"), "module github.com/BurntSushi/toml\n");
    writeFileSync(join(toml, "README.md"), "# toml\n\nTOML parser for Go.\n");
    writeFileSync(
      join(toml, "decode.go"),
      [
        "// Package toml implements decoding of TOML.",
        "package toml",
        "",
        "// Decode decodes the contents of data in TOML format into v.",
        "func Decode(data string, v any) (MetaData, error) {",
        "\treturn MetaData{}, nil",
        "}",
        "",
        "// MetaData allows access to meta information about TOML data.",
        "type MetaData struct {",
        "\tKeys []Key",
        "\tcontext Key",
        "}",
        "",
        "// IsDefined reports if the key exists in the TOML data.",
        "func (md *MetaData) IsDefined(key ...string) bool { return false }",
        "",
        "func (md MetaData) undecoded() []Key { return nil }",
        "",
        "type (",
        "\tKey []string",
        "\tunexported int",
        ")",
        "",
      ].join("\n"),
    );
    writeFileSync(join(toml, "decode_test.go"), "package toml\n\nfunc TestHidden() {}\n");
    symlinkSync(join(outside, "secret.go"), join(toml, "leak.go"));
    const cobra = join(cache, "github.com", "spf13", "cobra@v1.8.0");
    mkdirSync(cobra, { recursive: true });
    writeFileSync(
      join(cobra, "command.go"),
      "package cobra\n\n// Command is just that, a command for your application.\ntype Command struct {\n\tUse string\n}\n\n// Execute uses the args.\nfunc (c *Command) Execute() error { return nil }\n",
    );
  });
  afterAll(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "GOMODCACHE");
    else process.env.GOMODCACHE = saved;
    for (const d of [repo, cache, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("escapes upper-case letters in module paths as the module cache does", () => {
    expect(escapeModulePath("github.com/BurntSushi/toml")).toBe("github.com/!burnt!sushi/toml");
    // A path that already holds `!` or a `..` element is not a module path.
    expect(escapeModulePath("github.com/!x/y")).toBeUndefined();
    expect(escapeModulePath("github.com/../y")).toBeUndefined();
  });

  it("resolves a required module under GOMODCACHE, by path or last element", () => {
    const toml = resolveDependency(repo, "github.com/BurntSushi/toml");
    expect(toml).toMatchObject({ eco: "go", version: "v1.3.2", installed: true });
    expect(toml?.root).toBe(realpathSync(join(cache, "github.com", "!burnt!sushi", "toml@v1.3.2")));
    expect(resolveDependency(repo, "go:cobra")?.name).toBe("github.com/spf13/cobra");
    // A lower-cased spelling names a different module: Go paths are case-sensitive.
    expect(resolveDependency(repo, "github.com/burntsushi/toml")).toBeUndefined();
    // Required but absent from the cache.
    expect(resolveDependency(repo, "golang.org/x/text")).toMatchObject({
      installed: false,
      version: "v0.14.0",
    });
  });

  it("checks the selected version against go.sum", () => {
    expect(resolveDependency(repo, "cobra")?.verified).toBe(true);
    expect(resolveDependency(repo, "golang.org/x/text")?.verified).toBe(false);
  });

  it("scans exported names statically, leaving out tests and unexported names", async () => {
    const dep = resolveDependency(repo, "toml");
    if (!dep) throw new Error("unresolved");
    expect(dependencyFiles(dep)).toEqual(expect.arrayContaining(["README.md", "decode.go"]));
    expect(dependencyFiles(dep)).not.toContain("decode_test.go");
    const api = await dependencyApi(repo, "toml", "toml.MetaData.IsDefined");
    if (!hasGo) expect(api?.method).toBe("static");
    expect(api?.found).toBe(true);
    expect(api?.members).toEqual(expect.arrayContaining(["IsDefined", "Keys"]));
    expect(api?.members).not.toContain("undecoded");
    expect(api?.members).not.toContain("context");
    expect(api?.exports).toEqual(expect.arrayContaining(["Decode", "MetaData", "Key"]));
    expect(api?.exports).not.toContain("unexported");
    expect(api?.exports).not.toContain("TestHidden");
    const decode = await dependencyApi(repo, "toml", "Decode");
    expect(decode?.declarations[0]?.doc).toContain("Decode decodes");
    expect((await dependencyApi(repo, "toml", "MetaData.Missing"))?.found).toBe(false);
  });

  it.skipIf(!hasGo)("asks `go doc` offline, in the sandbox, when go is installed", async () => {
    const api = await dependencyApi(repo, "toml", "Decode");
    expect(api?.method).toBe("go doc");
  });

  it("keeps reads inside the module (DS-N9-6)", () => {
    const dep = resolveDependency(repo, "toml");
    if (!dep) throw new Error("unresolved");
    expect(dependencyFile(dep, "../cobra@v1.8.0/command.go")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(dependencyFile(dep, "leak.go")).toEqual({ ok: false, reason: "invalid" });
    expect(dependencyFile(dep, "decode.go")).toMatchObject({ ok: true });
  });

  it("names the module cache as what a probe reads", () => {
    expect(dependencyRuntime(repo, "go").readRoots).toEqual([realpathSync(cache)]);
  });
});
