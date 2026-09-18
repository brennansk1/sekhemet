import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "../src/integrations.js";
import { startDashboardServer } from "../src/server.js";

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

describe("PM and board-practice API", () => {
  let repo: string;
  let configDir: string;
  let cards: CardStore;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  let ledgerId: string;

  const post = (path: string, body: unknown, method = "POST") =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "pm-api-"));
    configDir = mkdtempSync(join(tmpdir(), "pm-config-"));
    process.env.SEKHEMET_CONFIG_DIR = configDir;
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    cards = new CardStore(db, log);
    const ledger = await cards.createCard({
      tier: "task",
      title: "Implement append-only ledger (SPIDR: Rule)",
      status: "ready",
      estimate: 3,
      labels: ["storage"],
    });
    ledgerId = ledger.id;
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cards),
      cardStore: cards,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
      pmAdapter: () =>
        new MockInferenceAdapter("dirk-27b", [
          {
            text: `Ledger (\`${ledgerId}\`) is next. I suggest making it High.`,
            toolCalls: [
              {
                id: "1",
                name: "propose_update_card",
                arguments: { card_id: ledgerId, priority: 2, reason: "the API waits on it" },
              },
            ],
            usage,
          },
        ]),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    // Assigning undefined would leave the string "undefined" in the environment.
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    rmSync(repo, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("answers a chat message with the PM model when no queue holds the Worker", async () => {
    const sent = await post("/api/pm/messages", {
      text: "What's next?",
      context: { view: "board" },
    });
    expect(sent.status).toBe(200);

    let thread: { messages: { role: string; proposals?: { id: string; state: string }[] }[] } = {
      messages: [],
    };
    for (let i = 0; i < 50 && thread.messages.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      thread = await (await fetch(`${base}/api/pm/thread`)).json();
    }
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "pm"]);
    const proposal = thread.messages[1]?.proposals?.[0];
    expect(proposal?.state).toBe("open");

    const applied = await post(`/api/pm/proposals/${proposal?.id}/apply`, {});
    expect(applied.status).toBe(200);
    expect((await cards.getCard(ledgerId))?.priority).toBe(2);
    // A proposal applies once.
    expect((await post(`/api/pm/proposals/${proposal?.id}/apply`, {})).status).toBe(409);
  });

  it("refuses chat and edits that do not come from the dashboard", async () => {
    const res = await fetch(`${base}/api/pm/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(403);
  });

  it("edits card fields inline and rejects invalid values", async () => {
    const res = await post(
      `/api/cards/${ledgerId}`,
      { estimate: 5, dueDate: "2026-10-01", priority: 9 },
      "PATCH",
    );
    const body = (await res.json()) as {
      card: { estimate: number; dueDate: string };
      ignored: string[];
    };
    expect(body.card.estimate).toBe(5);
    expect(body.card.dueDate).toBe("2026-10-01");
    expect(body.ignored).toEqual(["priority"]);
  });

  it("creates cycles and reports them on the board", async () => {
    const created = await post("/api/cycles", {
      name: "Cycle 1",
      startsOn: "2026-09-21",
      endsOn: "2026-10-02",
      goal: "Ship the ledger",
    });
    const { cycle } = (await created.json()) as { cycle: { id: string } };
    const board = (await (await fetch(`${base}/api/board`)).json()) as {
      cycles: { id: string; goal: string }[];
    };
    expect(board.cycles.map((c) => c.id)).toContain(cycle.id);
  });

  it("exports the board in Jira's CSV columns with a download filename", async () => {
    const res = await fetch(`${base}/api/export?format=jira-csv`);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="sekhemet-.*-jira-csv\.csv"/,
    );
    const [header, row] = parseCsv(await res.text());
    expect(header?.slice(0, 5)).toEqual([
      "Summary",
      "Issue Type",
      "Status",
      "Priority",
      "Story Points",
    ]);
    // The SPIDR suffix is ours, not the team's: it is stripped on export.
    expect(row?.[0]).toBe("Implement append-only ledger");
    expect(row?.[3]).toBe("High");
  });

  it("imports a Linear CSV as proposals, never directly", async () => {
    const before = (await cards.listCards()).length;
    const csv =
      'Title,Description,Priority,Estimate,Labels\n"Add HTTP API","Expose the ledger",Urgent,5,"api,http"\n';
    const res = await post("/api/import", { format: "linear-csv", content: csv });
    const { proposals } = (await res.json()) as {
      proposals: { id: string; cards: Record<string, unknown>[] }[];
    };
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.cards[0]).toMatchObject({
      title: "Add HTTP API",
      priority: 1,
      estimate: 5,
      labels: ["api", "http"],
    });
    expect((await cards.listCards()).length).toBe(before);
    await post(`/api/pm/proposals/${proposals[0]?.id}/apply`, {});
    expect((await cards.listCards()).length).toBe(before + 1);
  });

  it("lists every integration by tier and keeps the Slack webhook out of the repo", async () => {
    const list = (await (await fetch(`${base}/api/integrations`)).json()) as {
      id: string;
      tier: string;
      connected: boolean;
    }[];
    expect(list.filter((i) => i.tier === "now").map((i) => i.id)).toEqual([
      "github",
      "github-pr",
      "jira",
      "linear",
      "slack",
      "research-web",
    ]);
    expect(
      (await post("/api/integrations/slack", { webhookUrl: "https://evil.example/x" }, "PUT"))
        .status,
    ).toBe(400);
    const ok = await post(
      "/api/integrations/slack",
      { webhookUrl: "https://hooks.slack.com/services/T000/B000/XXXX" },
      "PUT",
    );
    expect(((await ok.json()) as { connected: boolean }).connected).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(configDir, "repos")).length).toBe(1);
  });

  it("serves flow metrics from the ledger", async () => {
    const res = (await (await fetch(`${base}/api/metrics/flow?days=7`)).json()) as {
      cfd: { ready: number }[];
      throughput: unknown[];
    };
    expect(res.cfd.length).toBeGreaterThanOrEqual(7);
    expect(res.cfd.at(-1)?.ready).toBeGreaterThan(0);
  });

  it("reports the model roster; without a running queue only Seshat is known", async () => {
    const body = (await (await fetch(`${base}/api/models`)).json()) as {
      roles: { role: string; model?: string; state: string }[];
      coResident: boolean;
    };
    expect(body.roles.map((r) => r.role)).toEqual(["worker", "manager", "reviewer", "researcher"]);
    expect(body.roles.find((r) => r.role === "manager")).toMatchObject({
      model: "dirk-27b:latest",
      state: "swapped",
    });
    expect(body.roles.find((r) => r.role === "worker")?.state).toBe("unconfigured");
  });

  it("does not load Seshat's model from the dashboard while memory is under pressure", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    let loaded = false;
    const s2 = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: repo,
      port: 0,
      pressureLevel: () => 2,
      pmAdapter: () => {
        loaded = true;
        return new MockInferenceAdapter("dirk", []);
      },
    });
    const res = await fetch(`http://127.0.0.1:${s2.port}/api/pm/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
      body: JSON.stringify({ text: "status of the api card?" }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(loaded).toBe(false);
    await s2.close();
  });
});
