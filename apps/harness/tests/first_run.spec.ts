import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadGatesConfig } from "@sekhemet/gates";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type RoleWeightsFinder,
  homeDestination,
  planFirstRun,
  runFirstRun,
} from "../src/first_run.js";

/**
 * P10 — one first run for all three audiences (surface items 5–8, 5a, 5b):
 * SUR-1 to SUR-6, SUR-34, SUR-46, SUR-49, SUR-50. Real repositories, real
 * git, the real gates parser; the model folders are read through part (b)'s
 * `findRoleWeights`, injected here with what each case needs.
 */
const GB = 1024 ** 3;
const BIN = resolve(import.meta.dirname, "../dist/index.js");
const dirs: string[] = [];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "first-run-home-"));
  dirs.push(home);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(home, ".sekhemet"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

function npmRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "first-run-"));
  dirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "shop",
      scripts: { test: "vitest run" },
      devDependencies: { typescript: "5.7.3", vitest: "3" },
    }),
  );
  write(root, ".gitignore", "node_modules/\n");
  return root;
}

const tree = (root: string) =>
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((p) => !p.startsWith(".git/") && p !== ".git")
    .sort();

/** Tools found: git and llama-server, so the toolchain is ready. */
const run = (cmd: string) =>
  cmd === "llama-server" ? "version: 6500 (abc)" : cmd === "git" ? "git version 2.50" : undefined;

const none: RoleWeightsFinder = async () => ({});
const workerAndPlanner: RoleWeightsFinder = async () => ({
  worker: { name: "Cyber-Tiel-Coder-35B-A3B", sizeBytes: 13 * GB },
  planner: { name: "qwen3.8-27b", sizeBytes: 16 * GB },
});

const base = { run, totalBytes: 24 * GB, nodeVersion: "26.0.0" };

describe("P10: one first run", () => {
  it("SUR-1: a fresh npm repository with TypeScript and no lockfile gets npm gates with a typecheck", async () => {
    const plan = await planFirstRun(npmRepo(), { ...base, findRoleWeights: none });
    expect(plan.gates.gates).toEqual(["typecheck: npx tsc --noEmit", "unit: npm run test"]);
    expect(plan.gates.packageManager).toBe("npm");
  });

  it("SUR-2: prints the machine, the four roles with their weights, and the gates, and writes nothing until confirmed", async () => {
    const root = npmRepo();
    const before = tree(root);
    const lines: string[] = [];
    const out = await runFirstRun(root, {
      ...base,
      findRoleWeights: workerAndPlanner,
      interactive: true,
      ask: async () => false,
      say: (l) => lines.push(l),
    });
    const text = lines.join("\n");
    expect(text).toMatch(/24 GB/);
    // DEC-31: the roles and the checks in the words teams use, never Worker or gates.
    for (const role of ["Coding model", "Planning model", "Review model", "Research model"])
      expect(text).toContain(role);
    expect(text).toMatch(/Coding model Cyber-Tiel-Coder-35B-A3B — weights present/);
    expect(text).toMatch(/Review model .* — no weights found/);
    expect(text).toMatch(/Checks from package\.json: typecheck, unit\./);
    expect(text).not.toMatch(/\b(?:Worker|Planner|Reviewer|Researcher)\b|\bgates?\b/);
    expect(out.code).toBe(2);
    expect(out.wrote).toEqual([]);
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(home, ".sekhemet"))).toBe(false);
  });

  it("SUR-3, SUR-34: confirmed, it writes config.toml, gates.toml and one .gitignore block, exactly once", async () => {
    const root = npmRepo();
    const confirm = { ...base, findRoleWeights: none, interactive: true, say: () => {} };
    const first = await runFirstRun(root, { ...confirm, ask: async () => true });
    expect(first.code).toBe(0);
    expect(first.wrote).toEqual([".sekhemet/config.toml", ".sekhemet/gates.toml", ".gitignore"]);
    expect(loadGatesConfig(root).gates.map((g) => g.id)).toEqual(["typecheck", "unit"]);
    // A second first run (config.toml removed by hand) adds no second block.
    rmSync(join(root, ".sekhemet", "config.toml"));
    await runFirstRun(root, { ...confirm, ask: async () => true });
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignore.startsWith("node_modules/\n")).toBe(true);
    expect(ignore.match(/>>> sekhemet/g)?.length).toBe(1);
    // SUR-34: state is never committable; the shared files are.
    const ignored = (p: string) =>
      spawnSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: root }).status === 0;
    for (const p of [
      ".sekhemet/evidence/",
      ".sekhemet/transcripts/",
      ".sekhemet/artifacts/",
      ".sekhemet/research/",
      ".sekhemet/observations/",
      ".sekhemet/live/",
      ".sekhemet/tuning/",
      ".sekhemet/traces.db",
      ".sekhemet/runs/",
      ".sekhemet/blobs/",
      ".sekhemet/gate-host/",
      ".sekhemet/events.db",
      ".sekhemet/queue_report.json",
      ".sekhemet/something-new/",
    ]) {
      expect(ignored(p), p).toBe(true);
    }
    expect(ignored(".sekhemet/config.toml")).toBe(false);
    expect(ignored(".sekhemet/gates.toml")).toBe(false);
  });

  it("SUR-4: --yes completes without a prompt and opens no browser", async () => {
    const root = npmRepo();
    const ask = vi.fn(async () => false);
    const out = await runFirstRun(root, {
      ...base,
      findRoleWeights: workerAndPlanner,
      yes: true,
      interactive: true,
      ask,
      say: () => {},
    });
    expect(ask).not.toHaveBeenCalled();
    expect(out).toMatchObject({ code: 0, opens: "board", openBrowser: false });
    expect(existsSync(join(root, ".sekhemet", "gates.toml"))).toBe(true);
  });

  it("SUR-5: without a terminal and without --yes it prints the plan, writes nothing and exits 2", async () => {
    const root = npmRepo();
    const before = tree(root);
    const lines: string[] = [];
    const out = await runFirstRun(root, {
      ...base,
      findRoleWeights: none,
      interactive: false,
      say: (l) => lines.push(l),
    });
    expect(out.code).toBe(2);
    expect(lines.join("\n")).toMatch(/--yes/);
    expect(tree(root)).toEqual(before);
  });

  it("SUR-5 (spawned): the built command without a terminal writes nothing and exits 2", () => {
    const root = npmRepo();
    const before = tree(root);
    const r = spawnSync(process.execPath, [BIN], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      input: "",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
        SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
        SEKHEMET_MODELS_DIR: join(home, "no-models"),
        BROWSER: "false",
      },
    });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toMatch(/--yes/);
    expect(tree(root)).toEqual(before);
  });

  it("SUR-6: with no user network setting the first run makes no outbound request", async () => {
    const root = npmRepo();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    await runFirstRun(root, {
      ...base,
      findRoleWeights: none,
      yes: true,
      interactive: false,
      say: () => {},
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("SUR-46: Node.js older than 22.13 is named with the version required; nothing is written, exit 1", async () => {
    const root = npmRepo();
    const before = tree(root);
    const lines: string[] = [];
    const out = await runFirstRun(root, {
      ...base,
      nodeVersion: "22.12.0",
      findRoleWeights: none,
      yes: true,
      interactive: false,
      say: (l) => lines.push(l),
    });
    expect(out.code).toBe(1);
    expect(lines.join("\n")).toMatch(/22\.12\.0.*22\.13/s);
    expect(tree(root)).toEqual(before);
  });

  it("SUR-49: with no role's weights found it opens Configuration, downloads nothing, and does again on later runs", async () => {
    const root = npmRepo();
    const lines: string[] = [];
    const out = await runFirstRun(root, {
      ...base,
      findRoleWeights: none,
      yes: true,
      interactive: false,
      say: (l) => lines.push(l),
    });
    expect(out).toMatchObject({ code: 0, opens: "configuration", openBrowser: false });
    expect(lines.join("\n")).toMatch(
      /No models found yet — recommended: Coding model \S+, Planning model \S+/,
    );
    expect(await homeDestination(none)).toBe("configuration");
    expect(readdirSync(home)).not.toContain("models");
  });

  it("SUR-50: with the Worker's and the Planner's weights present it opens the board", async () => {
    const out = await runFirstRun(npmRepo(), {
      ...base,
      findRoleWeights: workerAndPlanner,
      yes: true,
      interactive: false,
      say: () => {},
    });
    expect(out.opens).toBe("board");
    expect(await homeDestination(workerAndPlanner)).toBe("board");
  });
});

// B4.1 half-A fix round (minor): a folder inside another repository does
// not report the parent's history as its own.
describe("a folder inside another repository", () => {
  it("has no history of its own: the parent's commits are not offered for onboarding", async () => {
    const parent = mkdtempSync(join(tmpdir(), "first-run-parent-"));
    dirs.push(parent);
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], { cwd: parent });
    git("init", "-q", "-b", "main");
    write(parent, "a.txt", "1\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    write(parent, "a.txt", "2\n");
    git("commit", "-qam", "two");
    const child = join(parent, "sub");
    write(child, "package.json", JSON.stringify({ name: "sub", scripts: { test: "vitest run" } }));
    expect((await planFirstRun(parent, { ...base, findRoleWeights: none })).history).toBe(true);
    expect((await planFirstRun(child, { ...base, findRoleWeights: none })).history).toBe(false);
  });
});
