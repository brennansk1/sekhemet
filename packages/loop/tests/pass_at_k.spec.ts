import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeterministicGateRunner } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRunner } from "../src/card_runner.js";

// The test gate runs every tests/*.test.js; each throws when it fails.
const GATE = `[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "const fs=require('fs');for (const f of fs.existsSync('tests')?fs.readdirSync('tests'):[]) if (f.endsWith('.test.js')) require(require('path').resolve('tests', f));"]\ntimeout_s = 30\nparser = "generic"\n`;

describe("pass@k with gate selection and cross-validation (G25, G26)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "passk-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.js"), "module.exports = { a: 0 };\n");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const setup = (project: string) => {
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), `[project]\n${project}\n\n${GATE}`);
    git("add", "-A");
    git("commit", "-qm", "seed");
  };

  const runner = async (
    id: string,
    byTemperature: (t: number | undefined, n: number) => Omit<ToolCall, "id">[],
  ) => {
    const card = await store.createCard({
      id,
      tier: "story",
      title: id,
      scopeFiles: ["src/a.js", "tests/a.test.js"],
      stepBudget: 2,
    });
    const temps: (number | undefined)[] = [];
    let n = 0;
    const adapter: LocalInferenceAdapter = {
      modelId: "m",
      supportedArms: ["arm_a_flat"],
      generate: async (req: InferenceRequest) => {
        temps.push(req.temperature);
        n++;
        return {
          text: "",
          toolCalls: byTemperature(req.temperature, n).map((c, i) => ({ id: `${n}-${i}`, ...c })),
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    };
    const result = await new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", id),
      stepBudget: 2,
      modelAdapter: adapter,
      gateRunner: new DeterministicGateRunner(new ProcessSandbox(), { repoRoot: repo }),
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.js", "tests/a.test.js"],
      store,
      verifyFailToPass: false,
    }).run();
    return { result, temps };
  };

  const write = (path: string, content: string): Omit<ToolCall, "id"> => ({
    name: "write_file",
    arguments: { path, content },
  });
  const finish: Omit<ToolCall, "id"> = { name: "finish_card", arguments: {} };
  const testFor = (v: number) =>
    `const { a } = require("../src/a.js"); if (a !== ${v}) throw new Error("a should be ${v}, got " + a);\n`;

  it("draws another sample from the same tree when the first fails, and takes the first that passes", async () => {
    setup("pass_at_k = 3");
    const { result, temps } = await runner("card_k", (t) =>
      t === undefined
        ? [
            write("tests/a.test.js", testFor(1)),
            write("src/a.js", "module.exports = { a: 7 };\n"),
            finish,
          ]
        : [
            write("tests/a.test.js", testFor(1)),
            write("src/a.js", "module.exports = { a: 1 };\n"),
            finish,
          ],
    );
    expect(result.passed).toBe(true);
    expect(temps[0]).toBeUndefined();
    expect(temps).toContain(0.4);
    expect(readFileSync(join(result.worktreePath, "src", "a.js"), "utf8")).toBe(
      "module.exports = { a: 1 };\n",
    );
  }, 60_000);

  it("sends the card to the planner when two passing samples disagree on each other's tests", async () => {
    setup("pass_at_k = 2\ncross_validate = true");
    const { result } = await runner("card_x", (t) => {
      const v = t === undefined ? 1 : 2;
      return [
        write("tests/a.test.js", testFor(v)),
        write("src/a.js", `module.exports = { a: ${v} };\n`),
        finish,
      ];
    });
    expect(result.passed).toBe(false);
    expect(result.stopReason).toBe("replan_requested");
    expect(result.replan?.summary).toMatch(/Two passing attempts disagree/);
    expect(result.finalStatus).toBe("planning");
  }, 60_000);

  it("keeps the first sample when two passing samples agree", async () => {
    setup("pass_at_k = 2\ncross_validate = true");
    const { result } = await runner("card_y", () => [
      write("tests/a.test.js", testFor(1)),
      write("src/a.js", "module.exports = { a: 1 };\n"),
      finish,
    ]);
    expect(result.passed).toBe(true);
  }, 60_000);
});
