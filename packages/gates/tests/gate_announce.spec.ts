import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicGateRunner } from "../src/runner.js";
import type { GateRung } from "../src/types.js";

// Dashboard DB-N2-10 (B4.11): the In progress badge names the running check
// (*Running Tests…*), which needs the runner to announce each gate as it
// starts — `RunGatesOptions.onGateStart`, before the gate's process runs and
// never for a verdict read from the cache. Real git, real processes.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A gate that appends its id to `.log/starts` and exits 0. */
const logging = (id: string, rung: string) => `
[[gate]]
id = "${id}"
rung = "${rung}"
command = "sh"
args = ["-c", "mkdir -p .log && echo ${id} >> .log/starts"]
parser = "generic"
timeout_s = 60
`;

function repo(gatesToml: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "announce-")));
  dirs.push(root);
  const files: Record<string, string> = {
    "package.json": '{ "name": "e", "type": "module", "private": true }\n',
    ".gitignore": ".sekhemet/\nnode_modules/\n.log/\n",
    ".sekhemet/gates.toml": gatesToml,
    "src/a.ts": "export const a = 1;\n",
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

const starts = (root: string): string[] => {
  try {
    return readFileSync(join(root, ".log", "starts"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};

describe("DB-N2-10: the runner announces each gate as it starts", () => {
  it("names each gate before its process runs, in the order they run", async () => {
    const root = repo(logging("lint", "lint") + logging("types", "typecheck"));
    const runner = new DeterministicGateRunner(new ProcessSandbox(), { repoRoot: root });
    const seen: { gate: string; rung: GateRung; startedBefore: string[] }[] = [];
    const result = await runner.runGates(["lint", "typecheck"], root, {
      onGateStart: (g) => seen.push({ ...g, startedBefore: starts(root) }),
    });
    expect(result.passed).toBe(true);
    const ran = (result.rungResults ?? []).map((o) => o.gate);
    expect(seen.map((s) => s.gate)).toEqual(ran);
    expect(seen.map((s) => s.rung).sort()).toEqual(["lint", "typecheck"]);
    // Each announce came before its own process wrote its start.
    for (const [i, s] of seen.entries()) expect(s.startedBefore).toEqual(ran.slice(0, i));
  });

  it("does not announce a verdict read from the cache: nothing is running", async () => {
    const root = repo(logging("lint", "lint"));
    const runner = new DeterministicGateRunner(new ProcessSandbox(), { repoRoot: root });
    await runner.runGates(["lint"], root);
    const seen: string[] = [];
    const again = await runner.runGates(["lint"], root, { onGateStart: (g) => seen.push(g.gate) });
    expect(again.rungResults?.[0]?.cached).toBe(true);
    expect(seen).toEqual([]);
  });

  it("an announce that throws never stops the gates", async () => {
    const root = repo(logging("lint", "lint"));
    const runner = new DeterministicGateRunner(new ProcessSandbox(), { repoRoot: root });
    const result = await runner.runGates(["lint"], root, {
      onGateStart: () => {
        throw new Error("the page is gone");
      },
    });
    expect(result.passed).toBe(true);
    expect(starts(root)).toEqual(["lint"]);
  });
});
