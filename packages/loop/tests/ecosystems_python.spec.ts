import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

// DS-N9-2, DS-N9-6: the Python adapter over a real virtual environment
// (`python3 -m venv`), with installed distributions laid out as pip lays them
// out: a .dist-info with METADATA, RECORD and top_level.txt.

function distInfo(site: string, name: string, version: string, files: Record<string, string>) {
  const info = join(site, `${name}-${version}.dist-info`);
  mkdirSync(info, { recursive: true });
  writeFileSync(
    join(info, "METADATA"),
    `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\nSummary: ${name} for tests\n\n# ${name}\n\nThe long description says hello.\n`,
  );
  const record = [...Object.keys(files), `${name}-${version}.dist-info/METADATA`];
  writeFileSync(join(info, "RECORD"), `${record.map((f) => `${f},,`).join("\n")}\n`);
  const tops = [
    ...new Set(Object.keys(files).map((f) => (f.split("/")[0] ?? "").replace(/\.py[ic]?$/, ""))),
  ];
  writeFileSync(join(info, "top_level.txt"), `${tops.join("\n")}\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(site, path, ".."), { recursive: true });
    writeFileSync(join(site, path), text);
  }
}

describe("the Python adapter (DS-N9-2)", () => {
  let repo: string;
  let site: string;
  let outside: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "eco-py-"));
    outside = mkdtempSync(join(tmpdir(), "eco-py-out-"));
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    execFileSync("python3", ["-m", "venv", "--without-pip", join(repo, ".venv")]);
    const lib = join(repo, ".venv", "lib");
    site = join(lib, readdirSync(lib)[0] as string, "site-packages");
    writeFileSync(
      join(repo, "requirements.txt"),
      "requests==2.31.0\nPyYAML==6.0.1\nmissing-dist==1.0\n",
    );
    distInfo(site, "requests", "2.32.3", {
      "requests/__init__.py":
        "from .sessions import Session\nfrom .api import get\n__all__ = ['Session', 'get']\n",
      "requests/api.py":
        'def get(url, params=None, **kwargs):\n    """Sends a GET request."""\n    return None\n',
      "requests/sessions.py": [
        "class Session:",
        '    """A Requests session."""',
        "    trust_env = True",
        "    def get(self, url, **kwargs):",
        "        return None",
        "    def close(self):",
        "        pass",
        "",
      ].join("\n"),
      // The stub is read before the source (DS-N9-2).
      "requests/api.pyi": "def get(url: str, params: dict | None = ...) -> Response: ...\n",
    });
    distInfo(site, "PyYAML", "6.0.1", {
      "yaml/__init__.py": "def safe_load(stream):\n    return None\n",
    });
    symlinkSync(join(outside, "secret.txt"), join(site, "yaml", "leak.py"));
    // A distribution without METADATA is not an installed copy.
    mkdirSync(join(site, "broken-1.0.dist-info"));
    writeFileSync(join(site, "broken-1.0.dist-info", "RECORD"), "broken.py,,\n");
    // A module shipped compiled only: static reading has nothing to read.
    const src = join(outside, "fastcore.py");
    writeFileSync(
      src,
      "def compiled_fn(a, b):\n    return a\nclass Engine:\n    def start(self):\n        pass\n",
    );
    execFileSync("python3", [
      "-c",
      "import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)",
      src,
      join(site, "fastcore.pyc"),
    ]);
    const info = join(site, "fastcore-0.4.0.dist-info");
    mkdirSync(info);
    writeFileSync(
      join(info, "METADATA"),
      "Metadata-Version: 2.1\nName: fastcore\nVersion: 0.4.0\n",
    );
    writeFileSync(join(info, "RECORD"), "fastcore.pyc,,\nfastcore-0.4.0.dist-info/METADATA,,\n");
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("resolves a distribution from its .dist-info, recording the pin when it differs", () => {
    expect(resolveDependency(repo, "requests")).toMatchObject({
      eco: "python",
      name: "requests",
      version: "2.32.3",
      installedVersion: "2.32.3",
      pinnedVersion: "2.31.0",
      installed: true,
    });
    // By import name (top_level.txt) and by normalised distribution name.
    expect(resolveDependency(repo, "yaml")).toMatchObject({ name: "PyYAML", version: "6.0.1" });
    expect(resolveDependency(repo, "python:pyyaml")?.pinnedVersion).toBe("6.0.1");
  });

  it("labels a pinned distribution with no .dist-info as not installed", () => {
    expect(resolveDependency(repo, "missing-dist")).toMatchObject({
      version: "1.0",
      installed: false,
    });
    expect(resolveDependency(repo, "broken")).toBeUndefined();
  });

  it("lists stubs before sources, with the metadata's long description", () => {
    const dep = resolveDependency(repo, "requests");
    if (!dep) throw new Error("unresolved");
    const files = dependencyFiles(dep);
    expect(files.indexOf("requests/api.pyi")).toBeLessThan(files.indexOf("requests/api.py"));
    expect(files).toContain("requests-2.32.3.dist-info/METADATA");
  });

  it("reads the API surface statically, the stub before the source", async () => {
    const get = await dependencyApi(repo, "requests", "requests.get");
    expect(get).toMatchObject({ found: true, method: "static", version: "2.32.3" });
    expect(get?.declarations[0]?.file).toBe("requests/api.pyi");
    expect(get?.declarations[0]?.signature).toContain("url: str");
    const session = await dependencyApi(repo, "requests", "Session.close");
    expect(session?.found).toBe(true);
    expect(session?.members).toEqual(expect.arrayContaining(["get", "close", "trust_env"]));
    expect(session?.exports).toEqual(expect.arrayContaining(["Session", "get"]));
    expect((await dependencyApi(repo, "requests", "Session.post"))?.found).toBe(false);
  });

  it("falls back to inspect, run confined with no network, when there is no source", async () => {
    const api = await dependencyApi(repo, "fastcore", "Engine.start");
    expect(api).toMatchObject({ found: true, method: "inspect" });
    expect(api?.members).toContain("start");
    expect(api?.exports).toEqual(expect.arrayContaining(["compiled_fn", "Engine"]));
    expect((await dependencyApi(repo, "fastcore", "Engine.stop"))?.found).toBe(false);
  });

  it("keeps every read inside the distribution (DS-N9-6)", () => {
    const yaml = resolveDependency(repo, "yaml");
    if (!yaml) throw new Error("unresolved");
    expect(dependencyFile(yaml, "yaml/__init__.py")).toMatchObject({ ok: true });
    expect(dependencyFile(yaml, "yaml/leak.py")).toEqual({ ok: false, reason: "invalid" });
    expect(dependencyFile(yaml, "../../../../pyvenv.cfg")).toEqual({
      ok: false,
      reason: "invalid",
    });
    // Another distribution in the same site-packages is outside this one.
    expect(dependencyFile(yaml, "requests/api.py")).toEqual({ ok: false, reason: "invalid" });
  });

  it("names the venv's interpreter and site-packages for a probe", () => {
    const rt = dependencyRuntime(repo, "python");
    expect(rt.interpreter).toBe(join(repo, ".venv", "bin", "python3"));
    expect(rt.readRoots).toEqual([realpathSync(site)]);
  });
});
