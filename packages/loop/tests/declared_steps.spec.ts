import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/tools.js";

// gates rule 12, design-stage DS-P2-1: a card that declares its generator's
// steps (card zero) runs each through run_cmd, and what a declared step wrote
// is tool-applied — counted against its own bound, as rename_symbol's lines
// are, never against the Worker's max_diff_lines. A command the card did not
// declare is the Worker's own. Real files, the real sandbox.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-steps-")));
  dirs.push(root);
  writeFileSync(join(root, "README.md"), "# app\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=T", "commit", "-q", "-m", "seed"],
    { cwd: root },
  );
  return root;
}

/** A generator step: writes a manifest, a lockfile and a file in an ignored directory. */
const GENERATE = [
  "-e",
  [
    'const fs=require("node:fs");',
    'fs.writeFileSync("app.json",JSON.stringify({name:"app",version:"1.0.0"},null,2)+"\\n");',
    'fs.writeFileSync("app.lock",Array.from({length:600},(_,i)=>"dep"+i).join("\\n")+"\\n");',
    'fs.mkdirSync("vendor/x",{recursive:true});',
    'fs.writeFileSync("vendor/x/index.js","module.exports=1;\\n");',
  ].join(""),
];
/** A second step that changes one line of the manifest. */
const BUMP = [
  "-e",
  'const fs=require("node:fs");fs.writeFileSync("app.json",fs.readFileSync("app.json","utf8").replace("1.0.0","1.1.0"));',
];

const call = (t: ToolExecutor, command: string, args: string[]) =>
  t.execute({ id: "c", name: "run_cmd", arguments: { command, args } });

describe("declared generator steps are tool-applied (rule 12)", () => {
  it("records every line a declared step wrote, per file, outside the ignored directories", async () => {
    const root = repo();
    const t = new ToolExecutor({
      worktreePath: root,
      declaredSteps: {
        tool: "generator",
        steps: [
          { command: "node", args: GENERATE },
          { command: "node", args: BUMP },
        ],
        ignored: ["vendor"],
      },
    });
    expect((await call(t, "node", GENERATE)).ok).toBe(true);
    expect((await call(t, "node", BUMP)).ok).toBe(true);
    const applied = t.toolAppliedLines();
    expect(applied?.tool).toBe("generator");
    expect(applied?.files["app.lock"]).toBe(600);
    // app.json: four lines written, then one of them changed.
    expect(applied?.files["app.json"]).toBe(4);
    expect(Object.keys(applied?.files ?? {})).not.toContain("vendor/x/index.js");
  });

  it("a command the card did not declare is the Worker's own, and a failed step records nothing", async () => {
    const root = repo();
    const t = new ToolExecutor({
      worktreePath: root,
      declaredSteps: { tool: "generator", steps: [{ command: "node", args: BUMP }] },
    });
    expect((await call(t, "node", GENERATE)).ok).toBe(true);
    expect(t.toolAppliedLines()).toBeUndefined();
    writeFileSync(join(root, "app.json"), "{}\n");
    // BUMP finds nothing to replace here and fails on a read of a missing file.
    rmSync(join(root, "app.json"));
    expect((await call(t, "node", BUMP)).ok).toBe(false);
    expect(t.toolAppliedLines()).toBeUndefined();
  });

  it("a declared step reaches the network through the generator's proxy; any other command stays offline", async () => {
    const root = repo();
    const seen: { command: string; port: number | undefined }[] = [];
    const sandbox = {
      execute: async (command: string, _args: string[], o: { egressProxyPort?: number }) => {
        seen.push({ command, port: o.egressProxyPort });
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 0,
          oomKilled: false,
          timedOut: false,
        };
      },
    };
    const t = new ToolExecutor({
      worktreePath: root,
      sandbox: sandbox as never,
      declaredSteps: {
        tool: "generator",
        steps: [{ command: "npm", args: ["init", "-y"] }],
        egressProxyPort: 4321,
      },
    });
    await call(t, "npm", ["init", "-y"]);
    await call(t, "npm", ["install", "left-pad"]);
    expect(seen).toEqual([
      { command: "npm", port: 4321 },
      { command: "npm", port: undefined },
    ]);
  });

  it("without declared steps nothing a command writes is tool-applied", async () => {
    const root = repo();
    const t = new ToolExecutor({ worktreePath: root });
    await call(t, "node", GENERATE);
    expect(t.toolAppliedLines()).toBeUndefined();
  });
});
