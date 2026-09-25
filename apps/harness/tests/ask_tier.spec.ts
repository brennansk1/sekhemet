import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { ToolExecutor } from "@sekhemet/loop";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decisionApprover } from "../src/execute.js";

/** NEW-security-6: an Ask that a person really answers (SEC-47, SEC-48, SEC-49). */
describe("the Ask tier answered by a person", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-ask-"));
    mkdirSync(join(dir, "build"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    await cardStore.createCard({ id: "card_ask", tier: "task", title: "Ask" });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rmBuild = {
    id: "t",
    name: "run_cmd",
    arguments: { command: "rm", args: ["-rf", "build"] },
  };

  it("runs the command once a person allows it, and records who answered (SEC-47)", async () => {
    const executor = new ToolExecutor({
      worktreePath: dir,
      agentRole: "implementer",
      onApproval: decisionApprover(cardStore, "card_ask", 5_000, 10),
    });
    const pending = executor.execute(rmBuild);
    let id: string | undefined;
    for (let i = 0; i < 200 && !id; i++) {
      await new Promise((r) => setTimeout(r, 10));
      id = cardStore.runs.listDecisions("pending")[0]?.id;
    }
    expect(id).toBeDefined();
    await cardStore.runs.answerDecision(id as string, 1, "brennan");
    const obs = await pending;
    expect(obs.denied).toBeUndefined();
    expect(existsSync(join(dir, "build"))).toBe(false);
    expect(cardStore.runs.listDecisions()).toHaveLength(1);
    const answered = (await log.getEventsByTypes(["decision/answered"]))[0];
    expect(answered?.payload).toMatchObject({ optionIndex: 1, answeredBy: "brennan" });
  });

  it("denies after the time limit and tells the model not to retry (SEC-48)", async () => {
    const executor = new ToolExecutor({
      worktreePath: dir,
      agentRole: "implementer",
      onApproval: decisionApprover(cardStore, "card_ask", 100, 10),
    });
    const obs = await executor.execute(rmBuild);
    expect(obs.denied).toBe(true);
    expect(obs.content).toMatch(/Do not retry/);
    expect(existsSync(join(dir, "build"))).toBe(true);
    expect(cardStore.runs.listDecisions()[0]?.status).toBe("timed_out");
  });

  it("denies at once, posting nothing, when no approver is attached (SEC-49)", async () => {
    const executor = new ToolExecutor({ worktreePath: dir, agentRole: "implementer" });
    const started = Date.now();
    const obs = await executor.execute(rmBuild);
    expect(obs.denied).toBe(true);
    expect(obs.content).toMatch(/Do not retry/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cardStore.runs.listDecisions()).toHaveLength(0);
    expect(existsSync(join(dir, "build"))).toBe(true);
  });
});
