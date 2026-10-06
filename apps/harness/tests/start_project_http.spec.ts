import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { scratch } from "./support/g2_cli.js";

/**
 * Starting a project by talking to Seshat, over HTTP (design-stage §2.2,
 * DS-P2-6, DS-P2-7; PM_CONTRACT §3; FINISH_LINE_PLAN C2d): a person's
 * message posted to the real dashboard server, Seshat a scripted stand-in
 * that answers with `start_project`, the drafted group read back as Review
 * plan reads it, and Apply sent with the person's choices. A real git
 * repository and an on-disk ledger; no model is loaded.
 */

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const BRIEF = "A CLI that syncs my notes to S3. It lists what changed. It restores a deleted note.";

interface Group {
  brief: Record<string, string[]>;
  releases: { title: string; cards: number; forecast?: unknown }[];
  assumptions: string[];
  creates: Record<string, number>;
  candidates: { key: string; title: string; priority: "must" | "should" | "could" }[];
  releaseLine: number;
  type: { profile: string; reason: string };
  questions: { question: string }[];
}
interface Thread {
  messages: {
    role: string;
    proposals?: { id: string; kind: string; state: string; patch?: { group?: Group } }[];
  }[];
}

const servers: { close: () => Promise<void> }[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dbs.splice(0)) d.close();
  vi.unstubAllEnvs();
});

async function seshatStarts(brief = BRIEF) {
  const repo = scratch("sek-start-http-");
  const config = scratch("sek-start-http-config-");
  vi.stubEnv("SEKHEMET_CONFIG_DIR", config);
  vi.stubEnv("SEKHEMET_USER_CONFIG", join(config, "config.toml"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ada@example.com");
  git("config", "user.name", "Ada Lovelace");
  git("commit", "-q", "--allow-empty", "-m", "chore: empty");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const seshat = new MockInferenceAdapter(
    "scripted",
    [
      {
        text: "I've drafted a brief, the requirements and a plan beside this conversation.",
        toolCalls: [
          {
            id: "c1",
            name: "start_project",
            arguments: { brief, reason: "you asked to start it" },
          },
        ],
        finishReason: "tool_calls",
        usage,
      },
    ],
    { exhaustion: "cycle" },
  );
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cardStore, { entryConditions: true }),
    cardStore,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 50,
    pressureLevel: () => 1,
    pmAdapter: () => seshat,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify(body),
    });
  const sent = await post("/api/pm/messages", { text: brief, context: { view: "projects/new" } });
  expect(sent.status).toBe(200);
  let thread: Thread = { messages: [] };
  for (let i = 0; i < 200 && !thread.messages.some((m) => m.proposals?.length); i++) {
    await new Promise((r) => setTimeout(r, 25));
    thread = (await (await fetch(`${base}/api/pm/thread`)).json()) as Thread;
  }
  const proposal = thread.messages
    .flatMap((m) => m.proposals ?? [])
    .find((p) => p.kind === "start_project");
  if (!proposal?.patch?.group) throw new Error(`no start_project draft: ${JSON.stringify(thread)}`);
  const events = () =>
    (db.prepare("SELECT type FROM events ORDER BY seq").all() as { type: string }[]).map(
      (r) => r.type,
    );
  const rows = (type: string) =>
    (
      db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq").all(type) as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  return { base, post, proposal, group: proposal.patch.group, cardStore, events, rows };
}

describe("Seshat starts a project over HTTP: Review plan's draft", () => {
  it("DS-P2-6: the draft holds the brief's eight parts, each release with no forecast yet, the assumptions and what approval creates — and nothing is created", async () => {
    const s = await seshatStarts("A billing service that charges customers monthly");
    const b = s.group.brief;
    for (const part of [
      "problem",
      "outcome",
      "users",
      "notInScope",
      "constraints",
      "priorArt",
      "riskiest",
      "doneMeans",
    ]) {
      expect({ part, filled: (b[part] ?? []).length > 0 }).toEqual({ part, filled: true });
    }
    expect((b.riskiest ?? []).join(" ")).toMatch(/charge/i);
    expect((b.constraints ?? []).join(" ")).toContain("Generator: npm init, tsc --init and Vitest");
    // No finished work yet: no forecast, which Review plan says as "Not enough history yet".
    expect(s.group.releases.length).toBeGreaterThan(0);
    for (const r of s.group.releases) expect(r.forecast).toBeUndefined();
    expect(s.group.assumptions.length).toBeGreaterThan(0);
    expect(s.group.creates).toMatchObject({ project: 1, brief: 1, cardZero: 1 });
    expect(s.group.creates.issues).toBeGreaterThan(0);
    // Drafting created nothing.
    expect(await s.cardStore.listCards()).toEqual([]);
    expect(s.events()).not.toContain("card/created");
    expect(s.events()).not.toContain("project/created");
  }, 60_000);

  it("DS-P2-7: candidates grouped Must, Should, Could with a release line and the Type with its reason, at most two questions; Apply honours a removal and records an unanswered question as an assumption", async () => {
    const s = await seshatStarts();
    const order = ["must", "should", "could"];
    const priorities = s.group.candidates.map((c) => c.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(priorities).toContain("must");
    expect(s.group.releaseLine).toBeGreaterThan(0);
    expect(s.group.type.profile.length).toBeGreaterThan(0);
    expect(s.group.type.reason.length).toBeGreaterThan(10);
    expect(s.group.questions.length).toBeGreaterThan(0);
    expect(s.group.questions.length).toBeLessThanOrEqual(2);

    const [must, ...rest] = s.group.candidates;
    const removed = rest.at(-1);
    if (!must || !removed) throw new Error("expected at least two candidates");
    const applied = await s.post(`/api/pm/proposals/${s.proposal.id}/apply`, {
      choices: { remove: [removed.key], releaseLine: 1, answers: {} },
    });
    expect(applied.status, await applied.clone().text()).toBe(200);
    const titles = (await s.cardStore.requirements.list()).map((r) => r.title);
    expect(titles).toContain(must.title);
    expect(titles).not.toContain(removed.title);
    // Every question nobody answered is planned on its default, recorded as an assumption.
    const assumed = s.rows("assumption/logged").map((x) => String(x.statement));
    for (const q of s.group.questions) {
      expect({ q: q.question, assumed: assumed.some((a) => a.startsWith(q.question)) }).toEqual({
        q: q.question,
        assumed: true,
      });
    }
  }, 60_000);
});
