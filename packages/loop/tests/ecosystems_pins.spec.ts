import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinsDigest, pinsOf } from "../src/ecosystems/index.js";

// DS-N9-7: one pins reader for every ecosystem, read from the real lockfiles
// a project carries, with a digest that changes exactly when a pin does.

const sorted = (pins: ReturnType<typeof pinsOf>) =>
  pins.map((p) => `${p.eco} ${p.name} ${p.version} ${p.source}`).sort();

describe("pinsOf: the project's pinned versions (DS-N9-7)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pins-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reads pnpm, npm, requirements, poetry, uv, Cargo and go.mod pins", () => {
    writeFileSync(
      join(repo, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\npackages:\n\n  '@types/node@22.13.4':\n    resolution: {}\n\n  vitest@3.2.7:\n    resolution: {}\n",
    );
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } }),
    );
    writeFileSync(join(repo, "requirements.txt"), "requests==2.32.3\n# a comment\nflask>=3\n");
    writeFileSync(
      join(repo, "poetry.lock"),
      '[[package]]\nname = "Jinja2"\nversion = "3.1.4"\n\n[package.dependencies]\nMarkupSafe = ">=2.0"\n',
    );
    writeFileSync(join(repo, "uv.lock"), '[[package]]\nname = "httpx"\nversion = "0.28.1"\n');
    writeFileSync(
      join(repo, "Cargo.lock"),
      '# generated\nversion = 3\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n',
    );
    writeFileSync(
      join(repo, "go.mod"),
      "module example.com/app\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.0\n\nrequire (\n\tgithub.com/BurntSushi/toml v1.3.2 // indirect\n)\n",
    );
    writeFileSync(
      join(repo, "go.sum"),
      "github.com/spf13/cobra v1.8.0 h1:x=\ngithub.com/spf13/cobra v1.8.0/go.mod h1:y=\n",
    );
    const pins = pinsOf(repo);
    expect(sorted(pins)).toEqual(
      [
        "npm @types/node 22.13.4 pnpm-lock.yaml",
        "npm vitest 3.2.7 pnpm-lock.yaml",
        "npm left-pad 1.3.0 package-lock.json",
        "python requests 2.32.3 requirements.txt",
        "python Jinja2 3.1.4 poetry.lock",
        "python httpx 0.28.1 uv.lock",
        "rust serde 1.0.200 Cargo.lock",
        "rust app 0.1.0 Cargo.lock",
        "go github.com/spf13/cobra v1.8.0 go.mod",
        "go github.com/BurntSushi/toml v1.3.2 go.mod",
      ].sort(),
    );
    const serde = pins.find((p) => p.name === "serde");
    expect(serde?.origin).toBe("registry+https://github.com/rust-lang/crates.io-index");
    // go.mod's selected versions are checked against go.sum.
    expect(pins.find((p) => p.name === "github.com/spf13/cobra")?.verified).toBe(true);
    expect(pins.find((p) => p.name === "github.com/BurntSushi/toml")?.verified).toBe(false);
  });

  it("keeps only complete entries from a truncated Cargo.lock, poetry.lock or go.mod", () => {
    writeFileSync(
      join(repo, "Cargo.lock"),
      '[[package]]\nname = "serde"\nversion = "1.0.200"\n\n[[package]]\nname = "rand"\nversion = "0.8',
    );
    writeFileSync(join(repo, "poetry.lock"), '[[package]]\nname = "Jinja2"\nvers');
    writeFileSync(
      join(repo, "go.mod"),
      "module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/",
    );
    expect(sorted(pinsOf(repo))).toEqual([
      "go github.com/a/b v1.0.0 go.mod",
      "rust serde 1.0.200 Cargo.lock",
    ]);
  });

  it("pins nothing from a truncated package-lock.json, and does not throw", () => {
    writeFileSync(join(repo, "package-lock.json"), '{"packages": {"node_modules/a": {"vers');
    expect(pinsOf(repo)).toEqual([]);
  });

  it("refuses a go.mod path that is not a module path", () => {
    writeFileSync(
      join(repo, "go.mod"),
      "module x\n\nrequire (\n\tgithub.com/!evil/x v1.0.0\n\t../escape v1.0.0\n\tgithub.com/ok/y v0.1.0\n)\n",
    );
    expect(sorted(pinsOf(repo))).toEqual(["go github.com/ok/y v0.1.0 go.mod"]);
  });

  it("digests the pins: stable in order, changed by a version", () => {
    writeFileSync(join(repo, "requirements.txt"), "a==1.0\nb==2.0\n");
    const one = pinsDigest(pinsOf(repo));
    writeFileSync(join(repo, "requirements.txt"), "b==2.0\na==1.0\n");
    expect(pinsDigest(pinsOf(repo))).toBe(one);
    writeFileSync(join(repo, "requirements.txt"), "a==1.1\nb==2.0\n");
    expect(pinsDigest(pinsOf(repo))).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });
});
