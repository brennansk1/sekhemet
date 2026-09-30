import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { runSubtask } from "@sekhemet/context";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, ModelRole, UnloadableAdapter } from "@sekhemet/models";
import {
  type PlannedStory,
  proposeSlicesWithModel,
  requestSlicesWithModel,
  sampleExpected,
  sketchWithModel,
} from "@sekhemet/planner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consolidateWithManager, reflectWithManager } from "../src/learning/reflect.js";
import { LearningStore } from "../src/learning/store.js";
import { ModelAccess } from "../src/model_access.js";
import {
  MODEL_USAGE,
  meterModelUsage,
  modelUse,
  recordUsageOn,
  usageRole,
} from "../src/model_usage.js";
import { readDocumentInParts, summarizeConversation } from "../src/pm/agent.js";
import type { PmSnapshot } from "../src/pm/types.js";
import { quickAnswer } from "../src/pm/while_worker.js";
import { capabilityQueries } from "../src/research/capability_queries.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

// Fix round F2 (measurement rule 4a): every model request's usage is on the
// ledger. A card's step keeps its own record (`card/step`); every other
// request that goes through the one path to a model — Seshat's answer and
// its read-in-parts pass, the Planning model's, the Review model's and the
// Research model's — is one `model/usage` event, and Insights totals every
// role from the two. Real SQLite ledgers; no model is loaded.

const GB = 1024 ** 3;
const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "model-usage-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  closers.push(() => db.close());
  return { db, log: new EventLog(db), dir };
}

/** Adapters that answer with fixed counts, one per weights, as the roster would build them. */
function fakes(fail?: (req: InferenceRequest) => boolean) {
  return (name: string, _role: ModelRole): UnloadableAdapter => ({
    modelId: name,
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 8192, maxTokens: 1024 },
    generate: async (req) => {
      if (fail?.(req)) throw new Error("the server went away");
      return {
        text: "ok",
        toolCalls: [],
        usage: {
          promptTokens: 1000,
          cachedPromptTokens: 600,
          completionTokens: 200,
          thinkingTokens: 50,
          answerTokens: 150,
          durationMs: 900,
        },
      };
    },
    unload: async () => {},
    confirmUnloaded: async () => true,
    footprintBytes: async () => 4 * GB,
  });
}

const ask = (extra: Partial<InferenceRequest> = {}): InferenceRequest => ({
  prompt: "p",
  toolArm: "arm_a_flat",
  ...extra,
});

describe("model/usage: every request through the one path to a model is on the ledger", () => {
  it("records Seshat's, the Planning, Review and Research models' requests, each with its role, purpose and model", async () => {
    const { log } = ledger();
    const access = ModelAccess.forQueues(
      [
        { queue: "worker", role: "worker", name: "coder" },
        { queue: "seshat", role: "planner", name: "dirk" },
        { queue: "manager", role: "planner", name: "dirk" },
        { queue: "reviewer", role: "reviewer", name: "critic" },
        { queue: "researcher", role: "researcher", name: "scholar" },
      ],
      {
        resolve: fakes(),
        usableBytes: 64 * GB,
        coResident: true,
        pressureLevel: () => 1,
        healthCheck: false,
        ledger: log,
      },
    );
    await access.measure();
    // Queues on the same weights still share one adapter (MD-N9-1).
    const seshat = await access.use("seshat");
    expect(await access.use("manager")).toBe(seshat);
    await seshat.generate(ask({ role: "seshat", task: "read_document" }));
    await seshat.generate(ask({ role: "seshat" }));
    await seshat.generate(ask({ task: "replan" }));
    await (await access.use("reviewer")).generate(ask());
    await (await access.use("researcher")).generate(ask());
    const events = await log.getEventsByTypes([MODEL_USAGE]);
    expect(events.map((e) => e.actor)).toEqual(Array(5).fill("harness"));
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ role: "seshat", purpose: "read_document", model: "dirk" }),
      expect.objectContaining({ role: "seshat", purpose: "answer", model: "dirk" }),
      expect.objectContaining({ role: "planner", purpose: "replan", model: "dirk" }),
      expect.objectContaining({ role: "reviewer", purpose: "review", model: "critic" }),
      expect.objectContaining({ role: "researcher", purpose: "research", model: "scholar" }),
    ]);
    expect(events[0]?.payload).toEqual({
      role: "seshat",
      purpose: "read_document",
      model: "dirk",
      promptTokens: 1000,
      cachedPromptTokens: 600,
      completionTokens: 200,
      thinkingTokens: 50,
      answerTokens: 150,
      durationMs: 900,
    });
  });

  it("leaves a card's step to card/step, a failed request and a measurement run unrecorded", async () => {
    const { log } = ledger();
    const access = ModelAccess.forQueues(
      [
        { queue: "worker", role: "worker", name: "coder" },
        { queue: "chat", role: "planner", name: "dirk" },
      ],
      {
        resolve: fakes((req) => req.task === "doomed"),
        usableBytes: 64 * GB,
        coResident: true,
        pressureLevel: () => 1,
        healthCheck: false,
        ledger: log,
      },
    );
    await access.measure();
    const worker = await access.use("worker");
    await worker.generate(ask({ recordedAsCardStep: true }));
    const chat = await access.use("chat");
    await expect(chat.generate(ask({ task: "doomed" }))).rejects.toThrow(/went away/);
    await access.measurementRun(async () => {
      await chat.generate(ask({ role: "seshat" }));
    });
    expect(await log.getEventsByTypes([MODEL_USAGE])).toEqual([]);
    // Outside a step, the Coding model's own request counts too (a reflection).
    await worker.generate(ask({ role: "worker", task: "reflect" }));
    expect((await log.getEventsByTypes([MODEL_USAGE])).map((e) => e.payload)).toEqual([
      expect.objectContaining({ role: "worker", purpose: "reflect", model: "coder" }),
    ]);
  });

  it("totals every role for Insights: card steps as the Coding model's, the rest by role", async () => {
    const { log } = ledger();
    const step = (promptTokens: number, completionTokens: number, cached?: number) =>
      log.appendNow({
        actor: "worker",
        type: "card/step",
        payload: {
          id: "c1",
          turn: 0,
          calls: [],
          usage: {
            promptTokens,
            completionTokens,
            durationMs: 1,
            thinkingTokens: 10,
            answerTokens: completionTokens - 10,
            ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
          },
        },
      });
    step(900, 120, 700);
    step(1100, 80);
    const use = (role: string, purpose: string, promptTokens: number, completionTokens: number) =>
      log.appendNow({
        actor: "harness",
        type: MODEL_USAGE,
        payload: {
          role,
          purpose,
          model: "m",
          promptTokens,
          completionTokens,
          thinkingTokens: 0,
          answerTokens: completionTokens,
          durationMs: 1,
        },
      });
    use("seshat", "read_document", 5000, 400);
    use("seshat", "answer", 3000, 300);
    use("planner", "plan", 2000, 500);
    use("reviewer", "review", 1500, 100);
    use("researcher", "research", 800, 60);
    const u = await modelUse(log, 30);
    expect(u.rows.map((r) => r.role)).toEqual([
      "worker",
      "seshat",
      "planner",
      "reviewer",
      "researcher",
    ]);
    expect(u.rows[0]).toMatchObject({
      role: "worker",
      requests: 2,
      promptTokens: 2000,
      cachedPromptTokens: 700,
      completionTokens: 200,
      thinkingTokens: 20,
      answerTokens: 180,
      purposes: { card_step: 2 },
    });
    expect(u.rows[1]).toMatchObject({
      role: "seshat",
      requests: 2,
      promptTokens: 8000,
      completionTokens: 700,
      purposes: { read_document: 1, answer: 1 },
    });
    expect(u.total).toMatchObject({ requests: 7, promptTokens: 14_300, completionTokens: 1_560 });
    // Outside the window nothing counts.
    const later = new Date(Date.now() + 40 * 86_400_000);
    expect((await modelUse(log, 30, later)).total.requests).toBe(0);
  });

  // Fix round F2 review: Insights read every step and usage event the ledger
  // ever held on each request, and only the first 10,000 of them, so on a
  // ledger past that the window's own requests went uncounted.
  it("reads only the window, and every request in it however long the ledger", async () => {
    const { db, log } = ledger();
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const insert = db.prepare(
      "INSERT INTO events (id, actor, type, payload, payload_hash, hash, prev_hash, created_at, hash_version) VALUES (?, 'harness', ?, ?, 'h', 'h', 'h', ?, 1)",
    );
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    db.exec("BEGIN");
    for (let i = 0; i < 10_050; i++) {
      const at = i < 50 ? old : recent;
      insert.run(`e${i}`, "card/step", JSON.stringify({ usage }), at);
    }
    db.exec("COMMIT");
    const reads: number[] = [];
    const spied = {
      getEventsByTypes: (types: string[], fromSeq?: number, limit?: number) => {
        reads.push(fromSeq ?? 1);
        return log.getEventsByTypes(types, fromSeq, limit);
      },
      firstSeqSince: (iso: string) => log.firstSeqSince(iso),
    };
    const u = await modelUse(spied, 30);
    expect(u.total.requests).toBe(10_000);
    // Nothing before the window is read.
    expect(Math.min(...reads)).toBeGreaterThan(50);
  });

  it("serves Seshat's usage in Insights' flow metrics, with the Coding model's", async () => {
    const { db, log, dir } = ledger();
    const cards = new CardStore(db, log);
    log.appendNow({
      actor: "worker",
      type: "card/step",
      payload: {
        id: "c1",
        turn: 0,
        calls: [],
        usage: { promptTokens: 10, completionTokens: 5, durationMs: 1 },
      },
    });
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cards),
      cardStore: cards,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
      pmAdapter: () => ({
        modelId: "dirk-27b",
        supportedArms: ["arm_a_flat"],
        contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
        generate: async () => ({
          text: "Noted.",
          toolCalls: [],
          usage: { promptTokens: 700, completionTokens: 30, durationMs: 5 },
        }),
      }),
    });
    closers.push(() => server.close());
    const base = `http://127.0.0.1:${server.port}`;
    const sent = await fetch(`${base}/api/pm/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ text: "What's next?", context: { view: "board" } }),
    });
    expect(sent.status).toBe(200);
    let rows: { role: string; promptTokens: number }[] = [];
    for (let i = 0; i < 100 && !rows.some((r) => r.role === "seshat"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      const flow = (await (await fetch(`${base}/api/metrics/flow?days=7`)).json()) as {
        modelUse?: { rows: { role: string; promptTokens: number }[] };
      };
      rows = flow.modelUse?.rows ?? [];
    }
    expect(rows).toEqual([
      expect.objectContaining({ role: "worker", promptTokens: 10 }),
      expect.objectContaining({ role: "seshat", promptTokens: 700 }),
    ]);
  });

  // Fix round F2 review: a request that names no role is charged to the first
  // queue on its weights. With one model for every role the Coding model's
  // queue is first, so Seshat's lessons and the Planning model's work were
  // charged to the Coding model. Each such request now names its role.
  it("on one model serving every role, charges Seshat's lessons, the Planning model's work and a subtask to their own roles", async () => {
    const { db, log, dir } = ledger();
    vi.stubEnv("SEKHEMET_CONFIG_DIR", dir);
    try {
      const model = meterModelUsage(fakes()("one", "worker"), {
        record: recordUsageOn(log),
        served: () => ["worker", "planner", "seshat", "reviewer", "researcher"],
      });
      const cards = new CardStore(db, log);
      const card = await cards.createCard({ tier: "task", title: "Ledger" });
      const store = new LearningStore(log);
      await reflectWithManager(model, store, [
        { card, plan: "Root cause", firstStop: "repair_exhausted", retryPassed: false },
      ]);
      // A rule related to an earlier one, and two related preferences, for consolidation.
      for (const text of [
        "Use the exec method for DDL statements.",
        "Use the prepare method for inserts, not exec.",
      ]) {
        await store.propose({
          role: "worker",
          text,
          scope: { kind: "data" },
          source: "seed",
          evidence: [],
        });
      }
      for (const [key, statement] of [
        ["small", "The lead prefers small cards with one test each"],
        ["large", "The lead prefers large cards with many tests each"],
      ] as const) {
        await store.observe({
          key,
          statement,
          category: "planning",
          source: "send_back",
          evidence: "said so",
        });
      }
      await consolidateWithManager(model, store);
      await requestSlicesWithModel(model, "A bakery's timesheet", undefined);
      await proposeSlicesWithModel(model, "A bakery's timesheet", undefined);
      await sketchWithModel(model, {
        card: { ...card, scopeFiles: ["src/a.ts"] },
        rationale: "why",
        keywords: ["timesheet"],
        acceptanceTests: [],
      } as unknown as PlannedStory);
      await sampleExpected(model, {
        spec: "s",
        symbol: { symbol: "pay", file: "src/a.ts", signature: "pay(h: number): number" },
        args: [40],
      });
      await capabilityQueries("parse a CSV", { planner: model });
      await runSubtask({ adapter: model, question: "Where is pay?", maxSteps: 1 });
      const charged = (await log.getEventsByTypes([MODEL_USAGE])).map(
        (e) =>
          `${(e.payload as { role: string }).role}:${(e.payload as { purpose: string }).purpose}`,
      );
      expect(charged).toEqual([
        "seshat:reflect",
        "seshat:consolidate_rules",
        "seshat:consolidate_preferences",
        "planner:slice",
        "planner:slice",
        "planner:slice",
        "planner:edit_sketch",
        "planner:oracle_sample",
        "planner:reuse_queries",
        "worker:subtask",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("counts Seshat's read-in-parts pass, its summary and its quick answer apart from its answers", async () => {
    const { log } = ledger();
    const model = meterModelUsage(fakes()("dirk", "planner"), {
      record: recordUsageOn(log),
      served: () => ["planner"],
    });
    // A small window, so the document is read in several parts.
    Object.assign(model, { contextWindow: { contextTokens: 4096, maxTokens: 600 } });
    const read = await readDocumentInParts(model, {
      id: "doc1",
      name: "brief.md",
      text: "The bakery pays overtime past forty hours. ".repeat(900),
    });
    expect(read.parts).toBeGreaterThan(1);
    await summarizeConversation(model, undefined, []);
    await quickAnswer(model, { project: "p" } as PmSnapshot, [], "dirk");
    // Metered once, however often it is handed out.
    meterModelUsage(model, { record: recordUsageOn(log), served: () => ["planner"] });
    await summarizeConversation(model, "so far", []);
    const purposes = (await log.getEventsByTypes([MODEL_USAGE])).map(
      (e) =>
        `${(e.payload as { role: string }).role}:${(e.payload as { purpose: string }).purpose}`,
    );
    expect(purposes).toEqual([
      ...Array(read.parts).fill("seshat:read_document"),
      "seshat:summarize",
      "seshat:quick_answer",
      "seshat:summarize",
    ]);
  });
});

describe("model/usage roles: the one closed list lives with the models package (MD-N4-1)", () => {
  it("writes only a model role or seshat; an unknown name falls back to the role the weights serve", () => {
    expect(usageRole("seshat", ["planner"])).toBe("seshat");
    expect(usageRole("reviewer", ["worker"])).toBe("reviewer");
    expect(usageRole("someone", ["planner"])).toBe("planner");
    expect(usageRole(undefined, ["researcher", "planner"])).toBe("researcher");
  });
});
