import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dependencyApi,
  dependencyFile,
  dependencyFiles,
  dependencyRuntime,
  resolveDependency,
} from "../src/ecosystems/index.js";

// DS-N9-4, DS-N9-6: the Rust adapter over a Cargo registry source tree laid
// out as cargo unpacks it (`registry/src/<index>/<name>-<version>`).

describe("the Rust adapter (DS-N9-4)", () => {
  let repo: string;
  let home: string;
  let outside: string;
  const saved = process.env.CARGO_HOME;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "eco-rs-"));
    home = mkdtempSync(join(tmpdir(), "eco-cargo-"));
    outside = mkdtempSync(join(tmpdir(), "eco-rs-out-"));
    writeFileSync(join(outside, "secret.rs"), "pub fn stolen() {}\n");
    process.env.CARGO_HOME = home;
    writeFileSync(
      join(repo, "Cargo.toml"),
      '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nserde_json = "1"\nrand = { version = "0.8" }\n',
    );
    writeFileSync(
      join(repo, "Cargo.lock"),
      [
        "version = 3",
        "",
        "[[package]]",
        'name = "app"',
        'version = "0.1.0"',
        "",
        "[[package]]",
        'name = "serde_json"',
        'version = "1.0.120"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "abc"',
        "",
        "[[package]]",
        'name = "rand"',
        'version = "0.8.5"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        "",
        "[[package]]",
        'name = "gitdep"',
        'version = "0.2.0"',
        'source = "git+https://example.com/gitdep#abc"',
        "",
      ].join("\n"),
    );
    // Another index directory first: any index directory is searched.
    mkdirSync(join(home, "registry", "src", "aaa-0000"), { recursive: true });
    const crate = join(
      home,
      "registry",
      "src",
      "index.crates.io-6f17d22bba15001f",
      "serde_json-1.0.120",
    );
    mkdirSync(join(crate, "src", "value"), { recursive: true });
    writeFileSync(
      join(crate, "Cargo.toml"),
      '[package]\nname = "serde_json"\nversion = "1.0.120"\n',
    );
    writeFileSync(join(crate, "README.md"), "# Serde JSON\n\nStrongly typed JSON.\n");
    writeFileSync(
      join(crate, "src", "lib.rs"),
      [
        "//! # Serde JSON",
        "//! A JSON serialization file format.",
        "",
        "pub mod value;",
        "pub use crate::value::Value;",
        "",
        "/// Deserialize an instance of type `T` from a string of JSON text.",
        "pub fn from_str<'a, T>(s: &'a str) -> Result<T, Error> { todo!() }",
        "",
        "fn private_helper() {}",
        "",
        "pub(crate) fn crate_only() {}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(crate, "src", "value", "mod.rs"),
      [
        "/// Represents any valid JSON value.",
        "pub enum Value {",
        "    Null,",
        "    Bool(bool),",
        "    String(String),",
        "}",
        "",
        "impl Value {",
        "    /// If the `Value` is a String, returns the associated str.",
        "    pub fn as_str(&self) -> Option<&str> { None }",
        "    fn hidden(&self) {}",
        "}",
        "",
        "pub trait Index {",
        "    fn index_into(&self) -> bool;",
        "}",
        "",
      ].join("\n"),
    );
    symlinkSync(join(outside, "secret.rs"), join(crate, "src", "leak.rs"));
  });
  afterAll(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "CARGO_HOME");
    else process.env.CARGO_HOME = saved;
    for (const d of [repo, home, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("resolves a crate from Cargo.lock to its registry source, in any index directory", () => {
    const dep = resolveDependency(repo, "serde_json");
    expect(dep).toMatchObject({ eco: "rust", version: "1.0.120", installed: true });
    expect(dep?.root).toBe(
      realpathSync(
        join(home, "registry", "src", "index.crates.io-6f17d22bba15001f", "serde_json-1.0.120"),
      ),
    );
    // Cargo treats - and _ in a crate name alike.
    expect(resolveDependency(repo, "rust:serde-json")?.name).toBe("serde_json");
  });

  it("labels a pinned crate whose source is absent, and a git crate, as not installed", () => {
    expect(resolveDependency(repo, "rand")).toMatchObject({ version: "0.8.5", installed: false });
    expect(resolveDependency(repo, "gitdep")).toMatchObject({ installed: false });
    expect(resolveDependency(repo, "../serde_json")).toBeUndefined();
  });

  it("scans pub items with their /// docs, and members of a type's impl", async () => {
    const dep = resolveDependency(repo, "serde_json");
    if (!dep) throw new Error("unresolved");
    expect(dependencyFiles(dep)).toEqual(
      expect.arrayContaining(["README.md", "src/lib.rs", "src/value/mod.rs"]),
    );
    const api = await dependencyApi(repo, "serde_json", "serde_json::Value::as_str");
    expect(api).toMatchObject({ found: true, method: "static", version: "1.0.120" });
    expect(api?.members).toEqual(expect.arrayContaining(["as_str", "Null", "Bool", "String"]));
    expect(api?.members).not.toContain("hidden");
    expect(api?.exports).toEqual(expect.arrayContaining(["from_str", "value", "Value"]));
    expect(api?.exports).not.toContain("private_helper");
    expect(api?.exports).not.toContain("crate_only");
    const from = await dependencyApi(repo, "serde_json", "from_str");
    expect(from?.declarations[0]).toMatchObject({ file: "src/lib.rs", line: 8 });
    expect(from?.declarations[0]?.doc).toContain("Deserialize an instance");
    const trait = await dependencyApi(repo, "serde_json", "Index::index_into");
    expect(trait?.found).toBe(true);
    expect((await dependencyApi(repo, "serde_json", "Value.as_string"))?.found).toBe(false);
  });

  it("keeps reads inside the crate (DS-N9-6)", () => {
    const dep = resolveDependency(repo, "serde_json");
    if (!dep) throw new Error("unresolved");
    expect(dependencyFile(dep, "src/leak.rs")).toEqual({ ok: false, reason: "invalid" });
    expect(dependencyFile(dep, "../../aaa-0000")).toEqual({ ok: false, reason: "invalid" });
    expect(dependencyFile(dep, "src/lib.rs")).toMatchObject({ ok: true });
    expect(dependencyFiles(dep)).not.toContain("src/leak.rs");
  });

  it("names the registry sources as what a probe reads", () => {
    expect(dependencyRuntime(repo, "rust").readRoots).toEqual([
      realpathSync(join(home, "registry", "src")),
    ]);
  });
});

// DS-N9-4, DS-N9-7: a Cargo.lock holding two versions of one crate (syn 1
// and 2, as a real tree often does), and a crate's exported macros.
describe("the Rust adapter with two versions of a crate, and macros (DS-N9-4)", () => {
  let repo: string;
  let home: string;
  const saved = process.env.CARGO_HOME;
  const index = "index.crates.io-6f17d22bba15001f";
  const crate = (name: string, version: string, lib: string[]) => {
    const dir = join(home, "registry", "src", index, `${name}-${version}`);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "${name}"\nversion = "${version}"\n`);
    writeFileSync(join(dir, "src", "lib.rs"), lib.join("\n"));
    return dir;
  };
  const lock = (deps: string[]) =>
    [
      "version = 3",
      "",
      "[[package]]",
      'name = "app"',
      'version = "0.1.0"',
      "dependencies = [",
      ...deps.map((d) => ` "${d}",`),
      "]",
      "",
      "[[package]]",
      'name = "syn"',
      'version = "1.0.109"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "syn"',
      'version = "2.0.50"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "anyhow"',
      'version = "1.0.86"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "old_macro"',
      'version = "0.1.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "dependencies = [",
      ' "syn 1.0.109",',
      "]",
      "",
    ].join("\n");

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "eco-rs2-"));
    home = mkdtempSync(join(tmpdir(), "eco-cargo2-"));
    process.env.CARGO_HOME = home;
    writeFileSync(
      join(repo, "Cargo.toml"),
      '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nsyn = "2"\nanyhow = "1"\n',
    );
    writeFileSync(join(repo, "Cargo.lock"), lock(["anyhow", "syn 2.0.50"]));
    crate("syn", "1.0.109", ["pub fn parse_str() {}", ""]);
    crate("syn", "2.0.50", ["pub fn parse_str() {}", "pub fn parse2() {}", ""]);
    const anyhow = crate("anyhow", "1.0.86", [
      "#[macro_use]",
      "mod macros;",
      "pub struct Error;",
      "",
    ]);
    writeFileSync(
      join(anyhow, "src", "macros.rs"),
      [
        "/// Return early with an error.",
        "#[macro_export]",
        "macro_rules! bail {",
        "    ($msg:literal $(,)?) => { return Err(anyhow!($msg)) };",
        "}",
        "",
        "macro_rules! not_exported {",
        "    () => {};",
        "}",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "CARGO_HOME");
    else process.env.CARGO_HOME = saved;
    for (const d of [repo, home]) rmSync(d, { recursive: true, force: true });
  });

  it("takes the version the project's own package depends on, not the first one unpacked", async () => {
    const dep = resolveDependency(repo, "syn");
    expect(dep).toMatchObject({ version: "2.0.50", installedVersion: "2.0.50", installed: true });
    expect(dep?.root).toBe(realpathSync(join(home, "registry", "src", index, "syn-2.0.50")));
    expect((await dependencyApi(repo, "syn", "parse2"))?.found).toBe(true);
  });

  it("falls back to Cargo.toml's requirement, and never joins two versions into one", () => {
    writeFileSync(join(repo, "Cargo.lock"), lock(["anyhow", "syn"]));
    expect(resolveDependency(repo, "syn")?.version).toBe("2.0.50");
    rmSync(join(home, "registry", "src", index, "syn-2.0.50"), { recursive: true });
    rmSync(join(home, "registry", "src", index, "syn-1.0.109"), { recursive: true });
    const dep = resolveDependency(repo, "syn");
    expect(dep).toMatchObject({ version: "2.0.50", installed: false });
    expect(dep?.version).not.toContain(",");
    writeFileSync(join(repo, "Cargo.lock"), lock(["anyhow", "syn 2.0.50"]));
    crate("syn", "1.0.109", ["pub fn parse_str() {}", ""]);
    crate("syn", "2.0.50", ["pub fn parse_str() {}", "pub fn parse2() {}", ""]);
  });

  it("declares a #[macro_export] macro at the crate root, and no other macro", async () => {
    const api = await dependencyApi(repo, "anyhow", "bail");
    expect(api).toMatchObject({ found: true });
    expect(api?.exports).toContain("bail");
    expect(api?.exports).not.toContain("not_exported");
    expect(api?.declarations[0]).toMatchObject({ file: "src/macros.rs", line: 3 });
    expect(api?.declarations[0]?.doc).toContain("Return early");
  });
});
