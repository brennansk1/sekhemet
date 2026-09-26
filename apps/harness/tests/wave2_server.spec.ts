import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { DecisionStore } from "@sekhemet/planner";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explainCard } from "../src/execute.js";
import { LearningStore } from "../src/learning/store.js";
import { startDashboardServer } from "../src/server.js";
import { gateRuleOnFixtures } from "../src/wave2.js";

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let cardStore: CardStore;
let server: { port: number; close: () => Promise<void> };
const SECRET = "hook-secret";

function call(
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server.port, method, path, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "sek-w2srv-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  db = new DatabaseSync(join(repo, "events.db"));
  initSchema(db);
  log = new EventLog(db);
  cardStore = new CardStore(db, log);
  process.env.SEKHEMET_GITHUB_WEBHOOK_SECRET = SECRET;
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cardStore),
    cardStore,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 1000,
  });
});

afterAll(async () => {
  await server.close();
  Reflect.deleteProperty(process.env, "SEKHEMET_GITHUB_WEBHOOK_SECRET");
  rmSync(repo, { recursive: true, force: true });
});

describe("dashboard routes for the planner and sync (P9, P11, P13, P17, P20, Y8, Y13)", () => {
  it("lists planner decisions and answering one resumes the card", async () => {
    await cardStore.createCard({ id: "c1", tier: "task", title: "c1", status: "ready" });
    const id = await new DecisionStore({ store: cardStore, log }).request({
      id: "r1",
      cardId: "c1",
      question: "Which store?",
      options: [
        { label: "SQLite", consequence: "local", effortDelta: "0", riskNote: "Low." },
        { label: "Postgres", consequence: "server", effortDelta: "+1h", riskNote: "Server." },
      ],
      previewSketches: ["src/db.ts: sqlite"],
      recommendation: { optionIndex: 0, rationale: "local" },
      policy: "default_deny",
      defaultIfNoAnswer: { deadline: "2099-01-01T00:00:00Z" },
      category: "storage",
      createdAt: "",
    });
    const list = await call("GET", "/api/planner/decisions");
    expect((list.json.decisions as { id: string }[]).map((d) => d.id)).toContain(id);
    // The existing decisions endpoint resumes planner cards too.
    const r = await call("POST", `/api/decisions/${id}`, JSON.stringify({ option: 1 }), {
      "x-sekhemet-action": "1",
      "content-type": "application/json",
    });
    expect(r.status).toBe(200);
    expect((await cardStore.getCard("c1"))?.status).toBe("ready");
  });

  it("serves goals, the standup and the signals", async () => {
    expect((await call("GET", "/api/goals")).json.goals).toEqual([]);
    expect(String((await call("GET", "/api/standup")).json.text)).toBeTruthy();
    expect((await call("GET", "/api/signals")).json.signals).toHaveLength(6);
  });

  it("serves the structural diff of a card's worktree", async () => {
    const wt = await new NodeGitSyncAdapter(repo).createWorktree("cd", "main", "D");
    writeFileSync(join(wt, "a.ts"), "export const a = 2;\n");
    const r = await call("GET", "/api/cards/cd/diff");
    expect(r.status).toBe(200);
    expect(r.json.groups).toMatchObject({ source: ["a.ts"] });
  });

  it("accepts a signed GitHub webhook and creates a card; rejects a bad signature", async () => {
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "sekhemet" },
      issue: { number: 12, title: "Crash on save", body: "steps", html_url: "https://x/12" },
      repository: { full_name: "o/r" },
    });
    const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const ok = await call("POST", "/webhooks/github", body, {
      "x-hub-signature-256": sig,
      "x-github-event": "issues",
    });
    expect(ok.status).toBe(202);
    // One identity (INT-1); the text as written, tagged untrusted where it
    // reaches a prompt (the loop's untrusted.spec.ts, INT-32).
    const card = (await cardStore.listCards()).find((c) => c.externalRef?.id === "o/r#12");
    expect(card?.externalRef?.url).toBe("https://x/12");
    expect(card?.spec).toBe("steps");
    // Intake keeps the text as written; where it reaches the Worker it is
    // tagged untrusted (S9): the title in the card contract, here, and the
    // spec in the goal (the loop's untrusted.spec.ts).
    const { buildWorkerPrompt } = await import("@sekhemet/context");
    const built = buildWorkerPrompt({ card: card as never, tools: [] });
    expect(built.prompt).toContain(
      'Title: <untrusted_content source="github:o/r#12">\nCrash on save\n</untrusted_content>',
    );
    const bad = await call("POST", "/webhooks/github", body, {
      "x-hub-signature-256": "sha256=00",
      "x-github-event": "issues",
    });
    expect(bad.status).toBe(401);
  });

  it("the review route and explain carry the escalation diagnosis for a parked card (P12, P14)", async () => {
    await cardStore.createCard({ id: "p1", tier: "task", title: "stuck" });
    await cardStore.updateCardStatus("p1", "parked", "test setup", "harness", { override: true });
    await cardStore.updateCard("p1", { stopReason: "scope_violation", scopeFiles: ["a.ts"] });
    const r = await call("GET", "/api/cards/p1/review");
    expect((r.json.escalation as { category: string }).category).toBe("scope");
    const lines = await explainCard(
      {
        repoPath: repo,
        restrictedMode: false,
        cardStore,
        boardService: new BoardServiceImpl(cardStore) as never,
      },
      "p1",
    );
    expect(lines.join("\n")).toMatch(/Smallest unblocking action: Add the needed file/);
  });

  it("approves a rule a person approves, whatever the diagnostic suite gate said (DEC-28, rule 16a)", async () => {
    const learning = new LearningStore(log);
    const bad = await learning.propose({
      role: "worker",
      text: "Never run the tests.",
      scope: {},
      source: "seed",
      evidence: [],
    });
    const good = await learning.propose({
      role: "worker",
      text: "Cast rows through unknown before narrowing.",
      scope: {},
      source: "seed",
      evidence: [],
    });
    await gateRuleOnFixtures({ repoPath: repo, cardStore, log }, bad?.id as string, {
      fixtures: ["chronicle"],
      runFixture: async (_f, rule) => ({ passed: rule ? 2 : 5, total: 6 }),
    });
    const headers = { "x-sekhemet-action": "1", "content-type": "application/json" };
    // The frozen suite never admits a project rule: its verdict is shown, not enforced.
    const approved = await call("POST", `/api/learning/rules/${bad?.id}/approve`, "{}", headers);
    expect(approved.status).toBe(200);
    expect(approved.json.rule.status).toBe("active");
    expect(approved.json.suiteDiagnostic).toMatchObject({ accepted: false });
    const ok = await call("POST", `/api/learning/rules/${good?.id}/approve`, "{}", headers);
    expect(ok.status).toBe(200);
    expect(ok.json.suiteDiagnostic).toBeUndefined();
  });
});
