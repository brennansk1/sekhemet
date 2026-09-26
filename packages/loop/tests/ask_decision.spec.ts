import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const GATE = `[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`;

/**
 * NEW-worker-loop-4: an `ask` nothing answers now posts a non-blocking
 * decision request with the Worker's assumption; a person's answer reaches
 * the Worker at the next step boundary and is filed under the question.
 * Real SQLite, git and processes; a scripted model.
 */
describe("NEW-worker-loop-4: ask can wait for a person without stopping the Worker", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ask-decision-"));
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

  it("WL-N4-1/2: posts the question with the assumption, continues, and hands the answer over at the next step, saying it contradicts the assumption", async () => {
    const card = await store.createCard({
      id: "card_ask",
      tier: "story",
      title: "Write a",
      scopeFiles: ["src/a.js"],
      stepBudget: 3,
    });
    const prompts: string[] = [];
    const calls: Record<number, Omit<ToolCall, "id">[]> = {
      1: [
        {
          name: "ask",
          arguments: {
            question: "Should a be exported as a default export?",
            assumption: "a stays a named export",
          },
        },
      ],
      2: [{ name: "read_file", arguments: { path: "src/a.js" } }],
      3: [{ name: "read_file", arguments: { path: "src/a.js" } }],
    };
    let n = 0;
    const adapter: LocalInferenceAdapter = {
      modelId: "m",
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 16_384, maxTokens: 4_096 },
      generate: async (req: InferenceRequest) => {
        n++;
        prompts.push(req.prompt);
        if (n === 2) {
          // A person answers while step 2 is being generated: not before step 3.
          const [pending] = store.runs?.listDecisions("pending") ?? [];
          if (pending) await store.runs?.answerDecision(pending.id, 1, "p_lead");
        }
        return {
          text: "",
          toolCalls: (calls[n] ?? []).map((c, i) => ({ id: `${n}-${i}`, ...c })),
          usage: { promptTokens: 10, completionTokens: 3, durationMs: 1 },
          finishReason: "tool_calls",
        };
      },
    };
    await new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", card.id),
      stepBudget: 3,
      modelAdapter: adapter,
      gateRunner: new DeterministicGateRunner(new ProcessSandbox(), { repoRoot: repo }),
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.js"],
      store,
      verifyFailToPass: false,
    }).run();

    // WL-N4-1: one non-blocking request, carrying the question, the card and the assumption.
    const [decision] = store.runs?.listDecisions() ?? [];
    expect(decision).toMatchObject({
      cardId: "card_ask",
      kind: "worker_question",
      question: "Should a be exported as a default export?",
    });
    expect(decision?.options[0]).toContain("a stays a named export");
    // The Worker went on: step 2 ran without the answer.
    expect(n).toBe(3);
    expect(prompts[1]).not.toContain("contradicts");
    // WL-N4-2: at the next step boundary, as an observation, saying it contradicts the assumption.
    expect(prompts[2]).toContain("contradicts your assumption");
    // Filed under the question in the dossier.
    const dossier = await store.getDossier("card_ask");
    const thread = dossier.questions.find(
      (t) => t.question.text === "Should a be exported as a default export?",
    );
    expect(thread?.answers.length).toBe(1);
  }, 60_000);
  it("M3: a contradicting answer carries the person's reply in the card's thread, even one written after the decision", async () => {
    const card = await store.createCard({
      id: "card_reply",
      tier: "story",
      title: "Write a",
      scopeFiles: ["src/a.js"],
      stepBudget: 4,
    });
    const prompts: string[] = [];
    const REPLY = "Export it as default and keep a named alias";
    let n = 0;
    const adapter: LocalInferenceAdapter = {
      modelId: "m",
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 16_384, maxTokens: 4_096 },
      generate: async (req: InferenceRequest) => {
        n++;
        prompts.push(req.prompt);
        if (n === 2) {
          // The person picks "Otherwise" first...
          const [pending] = store.runs?.listDecisions("pending") ?? [];
          if (pending) await store.runs?.answerDecision(pending.id, 1, "p_lead");
        }
        if (n === 3) {
          // ...and writes what they meant in the card's thread afterwards.
          const dossier = await store.getDossier("card_reply");
          const q = dossier.questions[0]?.question;
          await store.recordDossierEntry({
            cardId: "card_reply",
            kind: "answer",
            actor: "human",
            text: REPLY,
            ...(q ? { inReplyTo: q.entryId } : {}),
          });
        }
        const call =
          n === 1
            ? {
                name: "ask",
                arguments: {
                  question: "Should a be exported as a default export?",
                  assumption: "a stays a named export",
                },
              }
            : n === 3
              ? { name: "grep_search", arguments: { query: "module" } }
              : { name: "read_file", arguments: { path: "src/a.js" } };
        return {
          text: "",
          toolCalls: [{ id: `${n}-0`, ...call }],
          usage: { promptTokens: 10, completionTokens: 3, durationMs: 1 },
          finishReason: "tool_calls",
        };
      },
    };
    await new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", card.id),
      stepBudget: 4,
      modelAdapter: adapter,
      gateRunner: new DeterministicGateRunner(new ProcessSandbox(), { repoRoot: repo }),
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.js"],
      store,
      verifyFailToPass: false,
    }).run();

    expect(n).toBe(4);
    expect(prompts[2]).toContain("contradicts your assumption");
    // The reply reaches the Worker at the next step boundary after it is written.
    expect(prompts[2]).not.toContain(REPLY);
    expect(prompts[3]).toContain(REPLY);
    // And the answer filed under the question carries it.
    const dossier = await store.getDossier("card_reply");
    const thread = dossier.questions[0];
    const filed = (thread?.answers ?? []).filter((a) => a.actor !== "human");
    expect(filed.some((a) => a.text.includes(REPLY))).toBe(true);
  }, 60_000);
});
