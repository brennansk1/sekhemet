import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeterministicGateRunner } from "@sekhemet/gates";
import { BlobStore, CardStore, type ContextPack, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRunner } from "../src/card_runner.js";

const GATE = `[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "0"]\ntimeout_s = 30\nparser = "generic"\n`;

// Kernel rule 17: the context pack is exactly what was sent, so a replay
// (models MD-M11-1) sends the same request (B2.2 review A3, A4, A5).

describe("the context pack records the whole request, and the attempt its arm", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pack-request-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.js"), "module.exports = { a: 0 };\n");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), `[project]\n\n${GATE}`);
    git("add", "-A");
    git("commit", "-qm", "seed");
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("stores the arm, thinking policy, sampling, token caps and exact tool definitions sent", async () => {
    const card = await store.createCard({
      id: "card_pack",
      tier: "story",
      title: "pack",
      scopeFiles: ["src/a.js"],
      stepBudget: 1,
    });
    const sent: InferenceRequest[] = [];
    const adapter: LocalInferenceAdapter = {
      modelId: "m",
      supportedArms: ["arm_a_flat", "arm_b_json"],
      // Room for the whole implement catalog in zone 1 at maxTokens 900.
      contextWindow: { contextTokens: 32_768, maxTokens: 4_096 },
      generate: async (req: InferenceRequest) => {
        sent.push(req);
        return {
          text: "",
          toolCalls: [{ id: "1", name: "read_file", arguments: { path: "src/a.js" } }],
          usage: { promptTokens: 10, completionTokens: 3, durationMs: 1 },
          finishReason: "tool_calls",
        };
      },
    };
    await new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", card.id),
      stepBudget: 1,
      modelAdapter: adapter,
      gateRunner: new DeterministicGateRunner(new ProcessSandbox(), { repoRoot: repo }),
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.js"],
      store,
      verifyFailToPass: false,
      toolArm: "arm_b_json",
      thinking: "surgical",
      temperature: 0.3,
      maxTokens: 900,
    }).run();

    // A3: the attempt row carries the arm the steps were sent in.
    const attempt = store.runs.listAttempts("card_pack").at(-1);
    expect(attempt?.toolArm).toBe("B");

    const step = attempt ? store.runs.listSteps(attempt.id)[0] : undefined;
    const blobs = new BlobStore(repo);
    const pack = JSON.parse(blobs.get(step?.contextPackId as string) as string) as ContextPack;
    const req = sent[0] as InferenceRequest;
    expect(pack).toMatchObject({
      systemPrompt: req.systemPrompt,
      prompt: req.prompt,
      toolArm: "arm_b_json",
      // A4: the policy the step ran under.
      thinking: "surgical",
      temperature: 0.3,
      maxTokens: 900,
    });
    expect(pack.reasoning).toBe(req.reasoning);
    expect(pack.reasoningBudgetTokens).toBe(req.reasoningBudgetTokens);
    // A5: the exact definitions sent, note's gate enum included, not names rebuilt later.
    const tools = JSON.parse(blobs.get(pack.toolSchemas as string) as string);
    expect(tools).toEqual(req.tools);
    const note = (
      tools as { name: string; parameters: { properties: Record<string, unknown> } }[]
    ).find((t) => t.name === "note");
    // The runner offers every gate this attempt runs, the declared "unit" among them.
    expect((note?.parameters.properties.gate as { enum?: string[] }).enum).toContain("unit");
  });
});
