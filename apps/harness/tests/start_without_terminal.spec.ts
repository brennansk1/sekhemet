import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { START_PROJECT_OPENING, type StatusFacts, statusModel } from "@sekhemet/ui";
import { afterEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * dashboard DB-P5-3 and DB-P5-7 (DEFINITION_OF_DONE §6.4) through the real
 * server: a non-developer presses *Start a new project*, finishes the
 * sentence and sends it; Seshat answers with one proposal group; *Create
 * project* applies it and the issues exist; then they ask how it is going,
 * on Status and in words to Seshat. Every step is an HTTP call the page
 * makes — no terminal. A real git repository, an on-disk ledger and the real
 * server (DEFINITION_OF_DONE §2A); the model is a scripted adapter, none is
 * loaded. The 400 px layout of the same walk is `seshat.spec.ts`
 * (`nonDeveloperWalk`); the browser sweep drives the page itself.
 */

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await (cleanup.pop() as () => Promise<void> | void)();
});

type Thread = {
  messages: {
    role: string;
    text: string;
    proposals?: { id: string; kind: string; state: string; patch?: { group?: unknown } }[];
  }[];
};

describe("DB-P5-3, DB-P5-7: start a project and ask how it is going, with no terminal", () => {
  it("creates the issues from Seshat's proposal and answers from them", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "sek-start-ui-"));
    const configDir = mkdtempSync(join(tmpdir(), "sek-start-ui-config-"));
    cleanup.push(() => rmSync(repoPath, { recursive: true, force: true }));
    cleanup.push(() => rmSync(configDir, { recursive: true, force: true }));
    const prevConfig = process.env.SEKHEMET_CONFIG_DIR;
    process.env.SEKHEMET_CONFIG_DIR = configDir;
    cleanup.push(() => {
      if (prevConfig === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
      else process.env.SEKHEMET_CONFIG_DIR = prevConfig;
    });
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "e@x");
    git("config", "user.name", "E");
    git("commit", "-q", "--allow-empty", "-m", "chore: empty");
    mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    const sentence = "a recipe website where people can sign up and save favourites";
    const seshat = new MockInferenceAdapter(
      "scripted",
      [
        {
          text: "I've drafted a plan for you to review.",
          toolCalls: [
            {
              id: "c1",
              name: "start_project",
              arguments: { brief: sentence, reason: "you asked to start it" },
            },
          ],
          finishReason: "tool_calls",
          usage,
        },
        {
          text: "The plan is in place, and the Agent starts with the setup issue. Nothing has shipped yet.",
          toolCalls: [],
          usage,
        },
      ],
      { exhaustion: "throw" },
    );
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore, { entryConditions: true }),
      cardStore,
      repoPath,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
      pmAdapter: () => seshat,
    });
    cleanup.push(() => server.close());
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify(body),
      });
    const replies = async (n: number): Promise<Thread> => {
      let thread: Thread = { messages: [] };
      for (let i = 0; i < 200; i++) {
        thread = (await (await fetch(`${base}/api/pm/thread`)).json()) as Thread;
        if (thread.messages.filter((m) => m.role === "pm").length >= n) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      return thread;
    };

    // 1. Start a new project: the composer holds the prompt; the person finishes it and sends.
    const started = await post("/api/pm/messages", {
      text: `${START_PROJECT_OPENING}${sentence}`,
      context: { view: "status" },
    });
    expect(started.status).toBe(200);
    const first = await replies(1);
    const proposal = first.messages.at(-1)?.proposals?.[0];
    expect(proposal?.kind).toBe("start_project");
    expect(proposal?.patch?.group).toBeDefined();
    // Nothing exists before the person applies it.
    expect(await cardStore.listCards()).toHaveLength(0);

    // 2. Review plan's Create project: the one apply, no terminal step.
    const applied = await post(`/api/pm/proposals/${proposal?.id}/apply`, { choices: {} });
    expect(applied.status).toBe(200);
    const cards = await cardStore.listCards();
    const issues = cards.filter((c) => c.tier !== "epic");
    expect(issues.length).toBeGreaterThan(2);

    // 3. How is it going — on Status, in plain words (DB-P5-2).
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    const { facts } = (await res.json()) as { facts: StatusFacts };
    expect(facts.project?.name).toBeTruthy();
    const view = statusModel({ now: Date.now(), facts, cards });
    expect(view.headline).toMatch(/^0 of \d+ issues done\./);
    for (const c of cards) expect(view.headline).not.toContain(c.id);

    // 4. …and in words to Seshat, who answers from the project just created.
    const asked = await post("/api/pm/messages", {
      text: "How is it going?",
      context: { view: "status" },
    });
    expect(asked.status).toBe(200);
    const second = await replies(2);
    expect(second.messages.at(-1)?.text).toBe(
      "The plan is in place, and the Agent starts with the setup issue. Nothing has shipped yet.",
    );
    expect(seshat.callHistory).toHaveLength(2);
    const seen = JSON.stringify(seshat.callHistory.at(-1));
    const firstIssue = issues[0]?.title ?? "";
    expect(firstIssue).not.toBe("");
    expect(seen).toContain(firstIssue.slice(0, 20));
  });
});
