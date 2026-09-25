import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cardMessages,
  handBack,
  postCardMessage,
  requestPause,
  submitTakenOver,
  takeOver,
} from "../src/collaborate.js";
import { executeCard } from "../src/execute.js";
import { startDashboardServer } from "../src/server.js";

// worker-loop NEW-worker-loop-10 (WL-N10-1..3, DEC-34): a person messages a
// running agent, pauses it and hands it back, or takes the issue over.
// A real repository and worktrees, a real SQLite ledger, real gate processes.

type Script = (n: number, req: InferenceRequest) => Omit<ToolCall, "id">[];
function adapterOf(script: Script) {
  const seen: InferenceRequest[] = [];
  let n = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "m",
    supportedArms: ["arm_a_flat", "arm_b_json"],
    generate: async (req) => {
      seen.push(req);
      n++;
      const calls = script(n, req);
      return {
        text: "",
        toolCalls: calls.map((c, i) => ({ id: `${n}-${i}`, ...c })),
        usage: { promptTokens: 5, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}
const text = (req: InferenceRequest | undefined) => JSON.stringify(req ?? {});

describe("NEW-worker-loop-10: collaborating on a running issue", () => {
  let repo: string;
  let db: DatabaseSync;
  let cardStore: CardStore;
  let boardService: BoardServiceImpl;
  let person: string;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  const gate = (code: string) =>
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 5\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", ${JSON.stringify(code)}]\ntimeout_s = 30\nparser = "generic"\n`,
    );

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "wl-n10-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.ts"), "");
    gate("process.exit(0)");
    writeFileSync(
      join(repo, ".gitignore"),
      ".sekhemet/events.db*\n.sekhemet/worktrees\n.sekhemet/evidence\n.sekhemet/transcripts\n.sekhemet/traces.db*\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    cardStore = new CardStore(db, new EventLog(db));
    boardService = new BoardServiceImpl(cardStore);
    person = cardStore.localPrincipal();
  });
  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const ctx = () => ({
    repoPath: repo,
    restrictedMode: false,
    cardStore,
    boardService,
    log: () => {},
    headroomCheck: false,
  });
  const newCard = (id: string) =>
    cardStore.createCard({
      id,
      tier: "story",
      title: `Card ${id}`,
      scopeFiles: ["src/a.ts"],
      stepBudget: 6,
      spec: "Write src/a.ts exporting the constants a, b and answer.",
    });

  it("WL-N10-1: a message posted while the agent runs reaches its next step and is shown with that step", async () => {
    const card = await newCard("card_msg");
    const { adapter, seen } = adapterOf((n) => {
      if (n === 1) {
        // Posted mid-step: delivered after this step's tool calls finish.
        void postCardMessage(cardStore, "card_msg", "Name the constant answer, please.", person);
        return [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
        ];
      }
      return [
        {
          name: "write_file",
          arguments: { path: "src/a.ts", content: "export const answer = 1;\n" },
        },
        { name: "finish_card", arguments: {} },
      ];
    });
    const result = await executeCard(ctx(), card, adapter);
    expect(result.passed).toBe(true);
    expect(text(seen[0])).not.toContain("Name the constant answer");
    expect(text(seen[1])).toContain("Name the constant answer, please.");
    const [message] = await cardMessages(cardStore, "card_msg");
    expect(message).toMatchObject({
      kind: "message",
      principal: person,
      text: "Name the constant answer, please.",
      reachedStep: 2,
    });
    // The text is off the chain, in the event's erasable private part.
    const [posted] = await cardStore.cardEvents("card_msg", ["card/message"]);
    expect(JSON.stringify(posted?.payload)).not.toContain("Name the constant");
  });

  it("WL-N10-2: a pause stops at the next step boundary resumably, keeps the checkpoint, and a hand-back resumes with the person's note", async () => {
    const card = await newCard("card_pause");
    const first = adapterOf((n) => {
      if (n === 1) void requestPause(cardStore, "card_pause", person);
      return [
        { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
      ];
    });
    const paused = await executeCard(ctx(), card, first.adapter);
    expect(paused.stopReason).toBe("paused");
    expect(first.seen).toHaveLength(1);
    const stored = await cardStore.getCard("card_pause");
    expect(stored?.status).toBe("in_progress");
    expect(stored?.stopReason).toBe("paused");
    const checkpoints = await cardStore.getCheckpoints("card_pause");
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(
      readFileSync(join(repo, ".sekhemet", "worktrees", "card_pause", "src", "a.ts"), "utf8"),
    ).toBe("export const a = 1;\n");

    await handBack(ctx(), "card_pause", "Also export b = 2.", person);
    const ready = await cardStore.getCard("card_pause");
    expect(ready?.status).toBe("ready");

    const second = adapterOf(() => [
      {
        name: "write_file",
        arguments: { path: "src/a.ts", content: "export const a = 1;\nexport const b = 2;\n" },
      },
      { name: "finish_card", arguments: {} },
    ]);
    const resumed = await executeCard(ctx(), ready ?? card, second.adapter);
    expect(resumed.resumedFrom?.step).toBe(1);
    expect(text(second.seen[0])).toContain("Also export b = 2.");
    expect(resumed.passed).toBe(true);
    const messages = await cardMessages(cardStore, "card_pause");
    expect(messages.find((m) => m.kind === "hand_back")).toMatchObject({ reachedStep: 2 });
  });

  it("WL-N10-2: a hand-back the board refuses records nothing — the note and the move commit together", async () => {
    await newCard("card_hb");
    await cardStore.updateCardStatus("card_hb", "in_progress", "setup", "harness", {
      override: true,
    });
    await cardStore.updateCard("card_hb", { stopReason: "paused" }, "harness");
    const full = {
      ...ctx(),
      boardService: new BoardServiceImpl(cardStore, { customLimits: { ready: 0 } }),
    };
    await expect(handBack(full, "card_hb", "Try again.", person)).rejects.toThrow(/WIP limit/);
    expect(await cardStore.cardEvents("card_hb", ["card/handed_back"])).toEqual([]);
    expect((await cardStore.getCard("card_hb"))?.status).toBe("in_progress");
    await handBack(ctx(), "card_hb", "Try again.", person);
    const [back] = await cardStore.cardEvents("card_hb", ["card/handed_back"]);
    expect(back?.payload).toMatchObject({ id: "card_hb", principal: person });
    expect((await cardMessages(cardStore, "card_hb"))[0]).toMatchObject({
      kind: "hand_back",
      text: "Try again.",
    });
    expect((await cardStore.getCard("card_hb"))?.status).toBe("ready");
  });

  it("WL-N10-3: a take-over records the person as the builder, runs the same checks, and adds nothing to the agent's competence", async () => {
    const card = await newCard("card_take");
    const { worktreePath } = await takeOver(ctx(), "card_take", person);
    expect((await cardStore.getCard("card_take"))?.status).toBe("in_progress");
    const [event] = await cardStore.cardEvents("card_take", ["card/taken_over"]);
    expect(event?.payload).toMatchObject({ id: "card_take", principal: person });

    // The same checks: a failing gate fails the person's work too.
    gate("process.exit(1)");
    writeFileSync(join(worktreePath, "src", "a.ts"), "export const a = 5;\n");
    const failed = await submitTakenOver(ctx(), "card_take", person);
    expect(failed.passed).toBe(false);
    expect((await cardStore.getCard("card_take"))?.status).toBe("in_progress");

    gate("process.exit(0)");
    const ok = await submitTakenOver(ctx(), "card_take", person);
    expect(ok.passed).toBe(true);
    expect((await cardStore.getCard("card_take"))?.status).toBe("review");

    const attempts = cardStore.runs.listAttempts("card_take");
    expect(attempts).toHaveLength(2);
    for (const a of attempts) expect(a.builtBy).toEqual({ kind: "person", id: person });
    expect(attempts.map((a) => a.status)).toEqual(["failed", "passed"]);
    // Excluded from the agent's competence records (K-N6-4): recording the
    // person's attempt as competence is refused, and nothing is written.
    for (const a of attempts) {
      const recorded = await cardStore.runs.recordCompetence(
        {
          repoId: "r",
          cardClass: "story",
          filesTouchedCount: 1,
          difficulty: "low",
          modelId: "person",
          toolArm: "A",
          stepBudget: 6,
          stepsUsed: 0,
          stopReason: a.status === "passed" ? "gate_passed" : "paused",
          passed: a.status === "passed",
          tokensUsed: 0,
          wallClockSeconds: 0,
        },
        { attemptId: a.id },
      );
      expect(recorded).toBeUndefined();
    }
    expect(cardStore.runs.listCompetence()).toEqual([]);
    // The commit names the person, not a model.
    const branchLog = execFileSync("git", ["log", "-1", "--format=%B"], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    expect(branchLog).toContain("Card: card_take");
    expect(branchLog).not.toMatch(/Co-authored-by: .*models\.sekhemet/);
    void card;
  });
  it("serves the four actions and the messages over the dashboard (WL-N10-1..3)", async () => {
    await newCard("card_srv");
    const server = await startDashboardServer({
      db,
      log: new EventLog(db),
      boardService,
      cardStore,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 60_000,
    });
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
        body: JSON.stringify(body),
      });
    try {
      expect((await post("/api/cards/card_srv/message", { text: "" })).status).toBe(400);
      expect(
        (await post("/api/cards/card_srv/message", { text: "Use named exports." })).status,
      ).toBe(200);
      expect((await post("/api/cards/card_srv/pause", {})).status).toBe(200);
      expect(await cardStore.cardEvents("card_srv", ["card/pause_requested"])).toHaveLength(1);
      // Not paused: a hand-back is refused and says why.
      const refused = await post("/api/cards/card_srv/hand-back", { note: "go" });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toMatch(/not paused/);
      const taken = await post("/api/cards/card_srv/take-over", {});
      expect(taken.status).toBe(200);
      expect((await taken.json()).worktreePath).toContain("card_srv");
      const listed = await (
        await fetch(`http://127.0.0.1:${server.port}/api/cards/card_srv/messages`)
      ).json();
      expect(listed.messages).toMatchObject([{ kind: "message", text: "Use named exports." }]);
    } finally {
      await server.close();
    }
  });
});
