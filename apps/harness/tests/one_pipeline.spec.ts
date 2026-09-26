import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type GateResult, loadGatesConfig } from "@sekhemet/gates";
import { CardStore } from "@sekhemet/kernel";
import { CardExecutionSessionImpl, verificationSessionOptions } from "@sekhemet/loop";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, describe, expect, it } from "vitest";
import { cardGateRunner, verifyCardWorktree } from "../src/card_gates.js";
import { main } from "../src/index.js";
import { openLocalLedger } from "../src/ledger_cmds.js";

// GT-T1-1: the card run and `sekhemet gate <card>` give the same verdict and
// the same set of gate outcomes on the same worktree, on every seeded fixture.

const GATES = `[project]
max_files = 3
max_diff_lines = 200

[[gate]]
id = "unit"
rung = "test"
command = "node"
args = ["-e", "const fs=require('fs');const t=fs.readdirSync('src').map(f=>fs.readFileSync('src/'+f,'utf8')).join('');if(t.includes('BROKEN')){console.error('src/b.ts:1 error: broken');process.exit(1)}"]
timeout_s = 30
parser = "generic"
`;

const model: LocalInferenceAdapter = {
  modelId: "m",
  supportedArms: ["arm_a_flat"],
  generate: async () => ({
    text: "",
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
  }),
};

/** What must agree between the two paths: the verdict and each outcome's state. */
const shape = (r: GateResult) => ({
  passed: r.passed,
  outcomes: (r.rungResults ?? [])
    .map(
      (o) =>
        `${o.gate}:${o.passed ? "pass" : o.unavailable ? "unavailable" : o.skipped ? "skipped" : "fail"}`,
    )
    .sort(),
  failures: r.failures.map((f) => `${f.gate}@${f.location.file}`).sort(),
});

describe("the card run and `sekhemet gate` give one verdict (GT-T1-1)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    process.exitCode = 0;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function fixture(id: string, files: Record<string, string>) {
    const repo = mkdtempSync(join(tmpdir(), "one-pipeline-"));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const write = (root: string, rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    write(repo, "src/a.ts", "export const a = 1;\n");
    write(repo, ".gitignore", ".sekhemet/\n");
    write(repo, ".sekhemet/gates.toml", GATES);
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const { db, log } = openLocalLedger(repo);
    const store = new CardStore(db, log);
    const card = await store.createCard({
      id,
      tier: "story",
      title: `Card ${id}`,
      scopeFiles: ["src/**"],
    });
    const wt = await new NodeGitSyncAdapter(repo).createWorktree(id, "main", `Card ${id}`);
    for (const [rel, text] of Object.entries(files)) write(wt, rel, text);
    db.close();
    return { repo, wt, card };
  }

  const fixtures: [string, Record<string, string>][] = [
    ["clean", { "src/a.ts": "export const a = 2;\n" }],
    ["test-fails", { "src/b.ts": "export const b = 'BROKEN';\n" }],
    [
      "too-many-files",
      {
        "src/b.ts": "export const b = 1;\n",
        "src/c.ts": "export const c = 1;\n",
        "src/d.ts": "export const d = 1;\n",
        "src/e.ts": "export const e = 1;\n",
      },
    ],
    ["switched-off", { "src/b.ts": "// @ts-ignore\nexport const b: number = 'x';\ndebugger;\n" }],
  ];

  for (const [name, files] of fixtures) {
    it(`agrees on the ${name} fixture`, async () => {
      const { repo, wt, card } = await fixture(`c-${name}`, files);
      const gatesConfig = loadGatesConfig(repo);
      // The card run: the session's verification, built by the card runner's
      // own helper, so a setting added there is exercised here too.
      const session = new CardExecutionSessionImpl({
        ...verificationSessionOptions(gatesConfig, { repoRoot: repo, restricted: false }),
        cardId: card.id,
        stepBudget: 5,
        worktreePath: wt,
        modelAdapter: model,
        gateRunner: cardGateRunner({ repoPath: repo, gatesConfig, restricted: false, card }),
        baseBranch: "main",
        card,
      });
      const cardRun = await session.runVerification();
      session.dispose();
      // `sekhemet gate <card>`: the function the command calls.
      const cli = await verifyCardWorktree({
        repoPath: repo,
        gatesConfig,
        restricted: false,
        card,
        worktree: wt,
        base: "main",
      });
      expect(shape(cli)).toEqual(shape(cardRun));
      expect(cardRun.passed).toBe(name === "clean");
      // And the command itself exits by the same verdict.
      await main(["gate", card.id, "--repo", repo]);
      expect((process.exitCode ?? 0) === 0).toBe(cardRun.passed);
    });
  }
});
