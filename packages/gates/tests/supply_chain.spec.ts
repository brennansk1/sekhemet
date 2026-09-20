import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEPENDENCY_MANIFESTS, cachedRegistry, ecosystemRegistry } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sek-supply-"));
  dirs.push(d);
  mkdirSync(join(d, ".sekhemet"), { recursive: true });
  return d;
}

const parse = (file: string, text: string): string[] =>
  (DEPENDENCY_MANIFESTS.find((m) => m.file === file) as { parse: (t: string) => string[] }).parse(
    text,
  );

describe("the supply-chain gate reads every manifest a card can touch (S10, G15)", () => {
  it("names the ecosystem each manifest belongs to", () => {
    expect(
      Object.fromEntries(DEPENDENCY_MANIFESTS.map((m) => [m.file, m.ecosystem])),
    ).toMatchObject({
      "package.json": "npm",
      "requirements.txt": "pypi",
      "pyproject.toml": "pypi",
      "Cargo.toml": "crates",
      "go.mod": "go",
    });
  });

  it("reads PEP 621, Poetry, Cargo and go.mod dependency names", () => {
    expect(
      parse(
        "pyproject.toml",
        [
          "[project]",
          'name = "p"',
          'dependencies = ["requests >= 2.31", "httpx[http2]==0.27"]',
          "[project.optional-dependencies]",
          'dev = ["pytest"]',
          "[tool.poetry.dependencies]",
          'python = "^3.12"',
          'rich = "^13"',
        ].join("\n"),
      ).sort(),
    ).toEqual(["httpx", "pytest", "requests", "rich"]);

    expect(
      parse(
        "Cargo.toml",
        '[dependencies]\nserde = { version = "1", features = ["derive"] }\n[dev-dependencies]\nproptest = "1"\n',
      ).sort(),
    ).toEqual(["proptest", "serde"]);

    expect(
      parse(
        "go.mod",
        "module x\n\ngo 1.22\n\nrequire golang.org/x/sync v0.7.0\n\nrequire (\n\tgithub.com/a/b v1.0.0 // indirect\n)\n",
      ).sort(),
    ).toEqual(["github.com/a/b", "golang.org/x/sync"]);
  });

  it("survives a manifest the card is midway through editing", () => {
    expect(parse("Cargo.toml", "[dependencies\nserde =")).toEqual([]);
  });
});

describe("registry lookups per ecosystem", () => {
  const ok = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => body }) as Response;

  it("reads age and downloads from PyPI and crates.io, and existence from the Go proxy", async () => {
    const root = tmp();
    const seen: string[] = [];
    const registry = ecosystemRegistry(root, {
      fetchImpl: (async (url: string) => {
        seen.push(url);
        if (url.includes("/pypi/"))
          return ok({
            info: { downloads: { last_week: 4200 } },
            releases: {
              "2.0": [{ upload_time_iso_8601: "2021-05-01T00:00:00Z" }],
              "1.0": [{ upload_time_iso_8601: "2019-01-01T00:00:00Z" }],
            },
          });
        if (url.includes("/crates/"))
          return ok({ crate: { created_at: "2018-02-02T00:00:00Z", downloads: 77 } });
        return ok(null, 404);
      }) as unknown as typeof fetch,
      endpoints: { pypi: "https://mirror.local/pypi", crates: "https://mirror.local/crates" },
    });

    // The earliest upload is the distribution's age, not the first release listed.
    expect(await registry("requests", "pypi")).toEqual({
      exists: true,
      created: "2019-01-01T00:00:00Z",
      downloads: 4200,
    });
    expect(await registry("serde", "crates")).toEqual({
      exists: true,
      created: "2018-02-02T00:00:00Z",
      downloads: 77,
    });
    expect(await registry("github.com/a/ghost", "go")).toEqual({ exists: false });
    // A mirror is asked instead of the public registry (the air-gap kit's index).
    expect(seen.every((u) => u.startsWith("https://mirror.local/") || u.includes("golang"))).toBe(
      true,
    );
  });

  it("caches per ecosystem, so one registry's answer never stands in for another's", async () => {
    const root = tmp();
    let calls = 0;
    const registry = ecosystemRegistry(root, {
      fetchImpl: (async () => {
        calls++;
        return ok({ crate: { created_at: "2018-02-02T00:00:00Z", downloads: 5 } });
      }) as unknown as typeof fetch,
    });
    await registry("shared-name", "crates");
    await registry("shared-name", "crates");
    expect(calls).toBe(1);
    const cache = JSON.parse(
      readFileSync(join(root, ".sekhemet", "registry-cache.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(cache)).toEqual(["crates:shared-name"]);
    expect(await cachedRegistry(root)("shared-name", "pypi")).toBeUndefined();
  });

  it("reports a registry it cannot reach as unknown, never as absent", async () => {
    const root = tmp();
    const registry = ecosystemRegistry(root, {
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await registry("anything", "pypi")).toBeUndefined();
    writeFileSync(join(root, ".sekhemet", "registry-cache.json"), "{}");
    expect(await registry("anything", "crates")).toBeUndefined();
  });
});
