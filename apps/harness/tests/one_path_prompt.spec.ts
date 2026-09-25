import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type RunProfile, queueInvocation, resolveRunProfile } from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceResponse, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard } from "../src/execute.js";
import { productCardRunner } from "../src/m0_path.js";
import { runSuitePath } from "../src/suite_path.js";

// Measurement MS-M9-1, as far as this test proves it (review minor 1): every
// measured path starts `sekhemet queue` with the same invocation for the
// same settings — `queueInvocation` from one RunProfile — and the same card
// run from the same RunProfile renders the same first request. The render is
// in process, through `executeCard`, not through a spawned queue; that a
// queue given the same invocation builds the same card execution is the
// queue's own code path, not re-proved here.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("one measurement path: the same invocation, and a deterministic first request (MS-M9-1)", () => {
  it("the suite runner starts the queue with the invocation its RunProfile gives, and the bake-off and rule gate run the suite runner", async () => {
    const script = readFileSync(join(ROOT, "scripts", "run_suite.mjs"), "utf8");
    expect(script).toMatch(/queueInvocation\(runProfile, repo\)/);
    expect(script).not.toMatch(/"queue", "--repo"/);
    const calls: string[][] = [];
    const out = join(mkdtempSync(join(tmpdir(), "one-path-")), "r.json");
    dirs.push(join(out, ".."));
    await runSuitePath({
      harnessRoot: ROOT,
      worker: "cyber-tiel",
      fixtures: ["chronicle"],
      out,
      spawn: async (_c, args) => {
        calls.push(args);
        writeFileSync(out, JSON.stringify({ outcomes: [] }));
        return 0;
      },
    });
    expect(calls[0]?.[0]).toBe(join(ROOT, "scripts", "run_suite.mjs"));
  });

  it("m0 starts the queue with the same invocation as the suite for the same settings", async () => {
    const ws = mkdtempSync(join(tmpdir(), "one-path-m0-"));
    dirs.push(ws);
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...a], { cwd: ws });
    git("init", "-q", "-b", "trunk");
    writeFileSync(join(ws, "a.js"), "1\n");
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    let seen: { argv: string[]; env: Record<string, string> } | undefined;
    await productCardRunner({
      worker: "cyber-tiel",
      runQueue: async (_repo, argv, _t, env) => {
        seen = { argv, env: env ?? {} };
        return { timedOut: false };
      },
    })({
      workspacePath: ws,
      task: {
        id: "t",
        repoCommit: "HEAD",
        issueDescription: "x",
        failToPassTests: ["t"],
        passToPassTests: [],
      },
      stepBudget: 50,
      attempt: 1,
      temperature: 0,
    });
    const profile = resolveRunProfile({
      env: process.env,
      argv: ["--worker", "cyber-tiel", "--max-turns", "50", "--auto-accept"],
      envRoles: true,
    });
    const expected = queueInvocation(profile, ws);
    expect(["queue", "--repo", ws, ...(seen?.argv ?? [])]).toEqual(expected.args);
    expect(seen?.env).toMatchObject(expected.env);
  });

  it("the same card from the same RunProfile renders a byte-identical first request, in process", async () => {
    const suiteProfile = resolveRunProfile({
      env: {},
      argv: ["--worker", "cyber-tiel", "--auto-accept", "--max-turns", "6"],
    });
    const m0Profile = resolveRunProfile({
      env: {},
      argv: ["--worker", "cyber-tiel", "--max-turns", "6", "--auto-accept"],
    });
    const a = await firstRequest(suiteProfile);
    const b = await firstRequest(m0Profile);
    expect(a.request).toBe(b.request);
    expect(a.request.includes(a.repo)).toBe(false);
  });
});

async function firstRequest(profile: RunProfile): Promise<{ request: string; repo: string }> {
  const repo = mkdtempSync(join(tmpdir(), "one-path-card-"));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, ".sekhemet"));
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(
    join(repo, ".sekhemet", "gates.toml"),
    `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
  );
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const cardStore = new CardStore(db, new EventLog(db));
  const card = await cardStore.createCard({
    id: "card_one_path",
    tier: "story",
    title: "Write a",
    scopeFiles: ["src/a.ts"],
    stepBudget: 6,
    spec: "Write src/a.ts exporting a = 1",
  });
  const reply: InferenceResponse[] = [
    {
      text: "",
      toolCalls: [
        {
          id: "1",
          name: "write_file",
          arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
        },
        { id: "2", name: "finish_card", arguments: {} },
      ],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    },
  ];
  const model = new MockInferenceAdapter("scripted", reply, { exhaustion: "default" });
  await executeCard(
    {
      repoPath: repo,
      restrictedMode: false,
      cardStore,
      boardService: new BoardServiceImpl(cardStore),
      log: () => {},
      headroomCheck: false,
      runProfile: profile,
    },
    card,
    model,
    undefined,
    { maxSteps: profile.policies.stepCap ?? undefined },
  );
  db.close();
  return { request: JSON.stringify(model.callHistory[0]), repo };
}
