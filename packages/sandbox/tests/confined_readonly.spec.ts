import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bubblewrapArgv } from "../src/bubblewrap.js";
import { runConfined } from "../src/confined.js";
import { ProcessSandbox } from "../src/executor.js";
import { srtFilesystem } from "../src/srt_engine.js";

/**
 * `readOnly` (design-stage DS-N9-17; the research probe and the claim gate):
 * harness-chosen paths a confined process may read and never write. The
 * folders are made under the host's temporary directory on purpose: under
 * bubblewrap that /tmp is private, so only the read-only grant makes them
 * visible at all.
 */
const confines = new ProcessSandbox({ engine: "native" }).confinement !== "none";
/** Seatbelt denies the write; bubblewrap's read-only bind refuses it. */
const WRITE_REFUSED = platform() === "darwin" ? "EPERM" : "EROFS";

const script = (body: string) => ["-e", body];
const tryWrite = (target: string) =>
  `try { require("fs").writeFileSync(${JSON.stringify(target)}, "x"); console.log("wrote") } catch (e) { console.log(e.code) }`;

describe.runIf(confines)("runConfined readOnly (DS-N9-17)", () => {
  let root: string;
  let deps: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ro-root-"));
    deps = mkdtempSync(join(tmpdir(), "ro-deps-"));
    writeFileSync(join(deps, "index.js"), "module.exports = 41 + 1;\n");
  });
  afterEach(() => {
    for (const d of [root, deps]) rmSync(d, { recursive: true, force: true });
  });

  it("grants read: a file under a read-only path is read and required", async () => {
    const r = await runConfined(
      process.execPath,
      script(
        `console.log(require(${JSON.stringify(join(deps, "index.js"))}), require("fs").readFileSync(${JSON.stringify(join(deps, "index.js"))}, "utf8").length)`,
      ),
      { root, readOnly: [deps], timeoutMs: 20_000 },
    );
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe(`42 ${readFileSync(join(deps, "index.js"), "utf8").length}`);
  }, 30_000);

  it("never grants write: writing, creating and deleting under it are refused", async () => {
    const r = await runConfined(
      process.execPath,
      script(
        `${tryWrite(join(deps, "new.txt"))};${tryWrite(join(deps, "index.js"))};try { require("fs").rmSync(${JSON.stringify(join(deps, "index.js"))}); console.log("deleted") } catch (e) { console.log(e.code) }`,
      ),
      { root, readOnly: [deps], timeoutMs: 20_000 },
    );
    expect(r.stdout.trim().split("\n")).toEqual([WRITE_REFUSED, WRITE_REFUSED, WRITE_REFUSED]);
    expect(existsSync(join(deps, "new.txt"))).toBe(false);
    expect(readFileSync(join(deps, "index.js"), "utf8")).toBe("module.exports = 41 + 1;\n");
  }, 30_000);

  it("does not become the working directory: a cwd inside it is clamped to the root", async () => {
    const r = await runConfined(process.execPath, script(`${tryWrite("here.txt")}`), {
      root,
      cwd: deps,
      readOnly: [deps],
      timeoutMs: 20_000,
    });
    expect(r.cwdClamped).toBe(true);
    expect(r.stdout.trim()).toBe("wrote");
    expect(existsSync(join(deps, "here.txt"))).toBe(false);
    expect(existsSync(join(root, "here.txt"))).toBe(true);
  }, 30_000);

  it("keeps a project ledger inside a read-only path unreadable (SEC-23)", async () => {
    mkdirSync(join(deps, ".sekhemet"));
    writeFileSync(join(deps, ".sekhemet", "events.db"), "ledger bytes");
    const r = await runConfined(
      process.execPath,
      script(
        `try { console.log(require("fs").readFileSync(${JSON.stringify(join(deps, ".sekhemet", "events.db"))}, "utf8")) } catch (e) { console.log("denied") }`,
      ),
      { root, readOnly: [deps], timeoutMs: 20_000 },
    );
    expect(r.stdout.trim()).toBe("denied");
  }, 30_000);
});

/**
 * `hiddenReads` (security item 8c; design-stage DS-N9-17): a research
 * packet's probe reads the project's installed dependencies and nothing
 * else of the repository, because the Researcher that wrote it also holds
 * the web. The repository's contents are unreadable; a read-only grant
 * inside it (node_modules) stays readable.
 */
describe.runIf(confines)("runConfined hiddenReads (security item 8c)", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hid-root-"));
    repo = mkdtempSync(join(tmpdir(), "hid-repo-"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "secret.ts"), "export const key = 'SECRET_FROM_PROJECT';\n");
    writeFileSync(join(repo, "package.json"), '{ "name": "app" }\n');
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 'dep ok';\n");
  });
  afterEach(() => {
    for (const d of [root, repo]) rmSync(d, { recursive: true, force: true });
  });

  it("hides the repository's files and listing, and keeps a read-only grant inside it readable", async () => {
    const read = (p: string) =>
      `try { console.log(require("fs").readFileSync(${JSON.stringify(p)}, "utf8").trim()) } catch (e) { console.log(e.code) }`;
    const r = await runConfined(
      process.execPath,
      script(
        `${read(join(repo, "src", "secret.ts"))};try { console.log(require("fs").readdirSync(${JSON.stringify(join(repo, "src"))}).join(",")) } catch (e) { console.log(e.code) };console.log(require(${JSON.stringify(join(repo, "node_modules", "dep", "index.js"))}))`,
      ),
      {
        root,
        readOnly: [join(repo, "node_modules")],
        hiddenReads: [repo],
        timeoutMs: 20_000,
      },
    );
    const lines = r.stdout.trim().split("\n");
    expect(r.stdout).not.toContain("SECRET_FROM_PROJECT");
    expect(lines[0]).toMatch(/^(EPERM|EACCES|ENOENT)$/);
    expect(lines[1]).not.toContain("secret.ts");
    expect(lines[2]).toBe("dep ok");
  }, 30_000);
});

// Item 8c in the other engines' terms: bubblewrap hides the path behind an
// empty tmpfs before binding the grants back; srt denies it and reads the
// grants inside it back. (Run on every host: these are the policies built.)
describe("hiddenReadPaths in bubblewrap and srt (security item 8c)", () => {
  let repo: string;
  let scratch: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "hid-pol-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "hid-scr-")));
    mkdirSync(join(repo, "node_modules"));
  });
  afterEach(() => {
    for (const d of [repo, scratch]) rmSync(d, { recursive: true, force: true });
  });
  const options = () => ({
    allowedPaths: [scratch],
    readOnlyPaths: [join(repo, "node_modules")],
    hiddenReadPaths: [repo],
    allowNetwork: false,
    timeoutMs: 1000,
    cwd: scratch,
  });

  it("bubblewrap mounts an empty tmpfs over the hidden path, then binds the grant back", () => {
    const argv = bubblewrapArgv(options(), "node", ["-e", "1"]);
    const hide = argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === repo);
    const grant = argv.findIndex(
      (a, i) => a === "--ro-bind" && argv[i + 1] === join(repo, "node_modules"),
    );
    expect(hide).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(hide);
  });

  it("srt denies the hidden path and reads the grant inside it back", () => {
    const fs = srtFilesystem(options());
    expect(fs.denyRead).toContain(repo);
    expect(fs.allowRead).toContain(join(repo, "node_modules"));
  });
});
