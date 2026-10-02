import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type OvernightRunner,
  resolveRunProfile,
  runOvernightBench,
  scheduleOvernight,
} from "@sekhemet/eval";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { threadNotice } from "@sekhemet/ui";
import { afterEach, describe, expect, it } from "vitest";
import { writeSettings } from "../src/integrations.js";
import { startNotifier } from "../src/notify.js";
import {
  SPRINT_MEASURED,
  atRisk,
  judgementQuestion,
  recordSprintClose,
  sprintCapacity,
} from "../src/pm/judgement.js";
import { answerQueued, dailyStandup } from "../src/pm/service.js";
import { STANDUP_GIVEN, estimationUnit } from "../src/pm/standup.js";
import { PmStore } from "../src/pm/store.js";
import type { PmMessage } from "../src/pm/types.js";
import { orderForQueue } from "../src/wave2.js";
import { chooseSecretsFile } from "./secret_choice.js";

// planner-pm P6 (B4.8 group S2): Seshat's judgement — one standup, what is
// at risk, the sprint bet, split rather than retry, the message budget, a
// sprint's measures and the overnight benchmark in plain words. Real SQLite
// on disk; scripted model replies only; nothing loads a model.

const dirs: string[] = [];
const servers: Server[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const r of restores.splice(0)) r();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
});

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-judgement-"));
  dirs.push(repoPath);
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, db, log, cardStore: new CardStore(db, log), pmStore: new PmStore(log) };
}
type S = ReturnType<typeof setup>;

/** A Planner that answers with the scripted text and tool calls. */
function planner(say: () => { text?: string; toolCalls?: ToolCall[] }) {
  const seen: InferenceRequest[] = [];
  const model: LocalInferenceAdapter = {
    modelId: "planner-model",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 16_384, maxTokens: 1200 },
    generate: async (req) => {
      seen.push(req);
      const r = say();
      return {
        text: r.text ?? "",
        toolCalls: r.toolCalls ?? [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return { model, seen };
}

async function ask(
  s: S,
  text: string,
  opts: { model?: LocalInferenceAdapter; cardId?: string } = {},
): Promise<PmMessage> {
  await s.pmStore.appendUserMessage(text, opts.cardId ? { cardId: opts.cardId } : undefined);
  await answerQueued({
    repoPath: s.repoPath,
    cardStore: s.cardStore,
    pmStore: s.pmStore,
    pmModel: "planner-model",
    acquire: async () => {
      if (!opts.model) throw new Error("no model may load for this question");
      return { role: "chat", adapter: opts.model, release: () => {} };
    },
  });
  const reply = (await s.pmStore.thread()).at(-1);
  if (!reply || reply.role !== "pm") throw new Error("no reply");
  return reply;
}

async function card(s: S, id: string, title: string, extra: Partial<CardRecord> = {}) {
  await s.cardStore.createCard({
    id,
    tier: "task",
    title,
    status: "ready",
    ...(extra as Record<string, unknown>),
  } as Parameters<CardStore["createCard"]>[0]);
  // A stop is recorded by a run, never at creation.
  if (extra.stopReason) await s.cardStore.updateCard(id, { stopReason: extra.stopReason });
}

const move = (s: S, id: string, to: CardRecord["status"]) =>
  s.cardStore.updateCardStatus(id, to, "test", "harness", { override: true });

/** A standup's text without its basis line, which names the ledger's length. */
const body = (text: string) =>
  text
    .replace(/\n\n_Answered from the Activity log[\s\S]*$/, "")
    .replace(/\nBased on: .*$/m, "")
    // The Monte Carlo forecast resamples at random each time it is drawn.
    .replace(/\nForecast: .*$/m, "");

/** No stop code, and no id in backticks: the plain mode (§2.8.9, PM-P6-3). */
function expectPlain(text: string) {
  expect(text).not.toMatch(/`[^`]+`/);
  expect(text).not.toMatch(
    /\b(budget_exhausted|repair_exhausted|memory_pressure|oscillation_detected|no_progress|gate_passed)\b/,
  );
}

describe("PM-P6-3: one standup builder for the chat, the notifier and the CLI", () => {
  it("lists only the issues done since the person's previous standup, the next issues in the queue's order, in plain words", async () => {
    const s = setup();
    await card(s, "c_hash", "Hasher (SPIDR: Rule)");
    await move(s, "c_hash", "done");
    await card(s, "c_read", "Read routes");
    await card(s, "c_write", "Write route", { dependsOn: ["c_env"] });
    await card(s, "c_env", "Error envelope");
    await card(s, "c_api", "API client", { stopReason: "budget_exhausted" } as Partial<CardRecord>);
    await move(s, "c_api", "parked");
    // The queue's order, from the function the queue itself uses.
    const ready = (await s.cardStore.listCards()).filter((c) => c.status === "ready");
    const order = orderForQueue(s.repoPath, ready, undefined).ordered.map((c) => c.title);
    // The channel's text and the chat's are the one builder's.
    const posted = await dailyStandup({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
    });
    const first = await ask(s, "/status");
    expect(body(first.text)).toBe(body(posted));
    expect(first.text).toMatch(/Done: Hasher\./);
    const next = /Next up: (.*)\./.exec(first.text)?.[1] ?? "";
    expect(next.split(", then ").map((x) => x.replace(/ \(.*$/, ""))).toEqual(order);
    expect(next).toMatch(/\(\d+-\d+ min, a prior, nothing measured yet\)/);
    expect(first.text).toMatch(/Needs you: API client stopped: Out of steps\./);
    expectPlain(first.text);
    // The issues it names are cited, so the chat links each one.
    expect(first.cites?.map((c) => c.cardId)).toEqual(expect.arrayContaining(["c_hash", "c_read"]));
    expect(await s.log.getEventsByTypes([STANDUP_GIVEN])).toHaveLength(1);

    // Since that standup: only what was done after it.
    await move(s, "c_read", "done");
    const second = await ask(s, "standup?");
    expect(second.text).toMatch(/^Since the last standup \(/);
    expect(second.text).toMatch(/Done: Read routes\./);
    expect(second.text).not.toMatch(/Hasher/);
    expect(second.text).toMatch(/1 issue done/);
    expectPlain(second.text);
    const third = await ask(s, "/standup");
    expect(third.text).toMatch(/Done: nothing since the last standup\./);
  });

  it("a standup the notifier sent starts the next one after it, and it is plain", async () => {
    const s = setup();
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sek-judgement-cfg-"));
    dirs.push(process.env.SEKHEMET_CONFIG_DIR);
    // SEC-27c: no secret store here, so the webhook is kept by the person's choice.
    restores.push(chooseSecretsFile(process.env.SEKHEMET_CONFIG_DIR));
    const { hook, hits } = await slackStandIn();
    writeSettings(s.repoPath, { slackWebhookUrl: hook, slackEvents: ["standup"] });
    await card(s, "c_one", "Ledger");
    await move(s, "c_one", "done");
    await card(s, "c_two", "Parser", { stopReason: "repair_exhausted" } as Partial<CardRecord>);
    await move(s, "c_two", "parked");
    const n = await startNotifier(s.log, s.repoPath, {
      intervalMs: 60_000,
      now: () => new Date(2026, 8, 25, 9, 30),
      standupAt: "09:00",
      standup: (person) =>
        dailyStandup({ repoPath: s.repoPath, cardStore: s.cardStore, pmStore: s.pmStore, person }),
    });
    expect(await n.tick()).toBe(1);
    n.stop();
    const text = JSON.parse(hits[0]?.body ?? "{}").text as string;
    expect(text).toMatch(/Done: Ledger\./);
    expect(text).toMatch(/Parser stopped: Couldn't fix/);
    expectPlain(text);
    const chat = await ask(s, "/status");
    expect(chat.text).toMatch(/Done: nothing since the last standup\./);
  });
});

describe("PM-N9-8: the notifier's standup names only what its recipient can see", () => {
  it("scopes a channel standup to the person it is for", async () => {
    const s = setup();
    await card(s, "c_a", "Ledger", { projectId: "p_a" } as Partial<CardRecord>);
    await move(s, "c_a", "done");
    await card(s, "c_b", "Payroll export", { projectId: "p_b" } as Partial<CardRecord>);
    await move(s, "c_b", "done");
    const audience = {
      setup: "team" as const,
      nameOf: () => undefined,
      levelOf: () => "member" as const,
      canSee: (who: string, project?: string) => who !== "u_bob" || project === "p_a",
      leadOf: () => undefined,
    };
    const text = await dailyStandup({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
      person: "u_bob",
      audience,
    });
    expect(text).toMatch(/Ledger/);
    expect(text).not.toMatch(/Payroll export/);
  });
});

/** A local HTTP server standing in for Slack's incoming webhook. */
async function slackStandIn() {
  const hits: { body: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
    });
    req.on("end", () => {
      hits.push({ body: b });
      res.writeHead(200);
      res.end("ok");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { hook: `http://127.0.0.1:${port}/services/T/B/X`, hits };
}

describe("PM-P6-14: an overnight benchmark in the next standup, in plain words", () => {
  async function night(s: S, winner: boolean) {
    const clock = { t: 0 };
    const cards = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, role: "worker" as const }));
    const { runId } = await scheduleOvernight(s.log, {
      combinations: [
        { worker: "wa", planner: "pp" },
        { worker: "wc", planner: "pp" },
      ],
      host: "h",
    });
    const runner: OvernightRunner = {
      swapTo: async () => undefined,
      runCard: async ({ combination, card }) => ({
        passed: winner ? combination.worker === "wa" : card.id !== "t0",
        seconds: 1,
      }),
    };
    await runOvernightBench({
      log: s.log,
      runId,
      runner,
      sets: {
        roles: {
          worker: { state: "ready", runs: 2, cards },
          planner: { state: "not_built", runs: 1, cards: [] },
          reviewer: { state: "not_built", runs: 1, cards: [] },
          researcher: { state: "not_built", runs: 1, cards: [] },
        },
      },
      host: "h",
      now: () => {
        clock.t += 1000;
        return clock.t;
      },
      window: () => ({ open: true, why: "open" }),
      fingerprint: { build: "b", contextVersion: "c", qualification: "q" },
      runProfileFor: () => resolveRunProfile({ env: {}, argv: [] }),
      measurementRun: (run) => run(),
    });
  }

  /** The text with every link to Configuration removed: no model id may remain. */
  const outsideLinks = (t: string) => t.replace(/\[[^\]]*\]\(#\/configuration\/models\)/g, "");

  it("names the best combination only inside a link to Configuration, assigns nothing, and says it once", async () => {
    const s = setup();
    await night(s, true);
    const text = await dailyStandup({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
    });
    expect(text).toMatch(
      /Overnight benchmark \(finished\): \[Coding model wa · Planning model pp\]\(#\/configuration\/models\) did best/,
    );
    expect(text).toMatch(/assigned nothing/);
    expect(outsideLinks(text)).not.toMatch(/\b(wa|wc|pp)\b/);
    expect(await s.log.getEventsByTypes(["models/assigned"])).toHaveLength(0);
    // Given once in the chat, the next standup does not repeat it.
    const chat = await ask(s, "/status");
    expect(chat.text).toMatch(/Overnight benchmark/);
    const again = await ask(s, "/status");
    expect(again.text).not.toMatch(/Overnight benchmark/);
  });

  it("says when the leading combinations could not be told apart", async () => {
    const s = setup();
    await night(s, false);
    const text = await dailyStandup({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
    });
    expect(text).toMatch(/no clear difference between the leading combinations/);
    expect(outsideLinks(text)).not.toMatch(/\b(wa|wc|pp)\b/);
  });

  it("asked to apply it, names the Configuration action and assigns nothing", async () => {
    const s = setup();
    await night(s, true);
    const reply = await ask(s, "Apply the benchmark's best combination");
    expect(reply.text).toMatch(/Configuration › Models/);
    expect(reply.text).toMatch(/Assign/);
    expect(reply.proposals ?? []).toHaveLength(0);
    expect(await s.log.getEventsByTypes(["models/assigned"])).toHaveLength(0);
  });
});

describe("PM-P6-7: what is at risk comes with its basis, and something that is not", () => {
  it("judges age against the 85th percentile of finished cycle times and separates pauses from defects", () => {
    const at = (id: string, status: CardRecord["status"], extra: Partial<CardRecord> = {}) =>
      ({
        id,
        title: id,
        status,
        tier: "task",
        stepBudget: 40,
        stepsUsed: 0,
        ...extra,
      }) as CardRecord;
    const r = atRisk(
      [
        at("old", "in_progress"),
        at("young", "in_progress"),
        at("mem", "parked", { stopReason: "memory_pressure" }),
        at("broke", "parked", { stopReason: "repair_exhausted" }),
      ],
      {
        cycleTime: [1, 2, 3, 4, 5, 6].map((hours) => ({ hours })),
        wipAge: [
          { cardId: "old", hours: 22 },
          { cardId: "young", hours: 2 },
        ],
      },
      new Map([["broke", 3]]),
    );
    // Nearest rank: the 85th percentile of six is the sixth.
    expect(r.mark).toEqual({ hours: 6, n: 6 });
    expect(r.atRisk.map((x) => [x.card.id, x.basis])).toEqual([
      ["old", "open 22h; 85% of finished issues took under 6h"],
      ["broke", "stopped: Couldn't fix, after 3 failed attempts"],
    ]);
    expect(r.notAtRisk.map((x) => x.card.id)).toEqual(["young", "mem"]);
    expect(r.notAtRisk[1]?.basis).toMatch(/paused .* not stopped by a defect/);
  });

  it("answers 'what's at risk?' from the ledger, naming the basis and one issue not at risk", async () => {
    const s = setup();
    await card(s, "c_broke", "Hasher", { stopReason: "repair_exhausted" } as Partial<CardRecord>);
    await move(s, "c_broke", "parked");
    await card(s, "c_mem", "Tamper check", {
      stopReason: "memory_pressure",
    } as Partial<CardRecord>);
    await move(s, "c_mem", "parked");
    for (const q of ["what is at risk", "Anything at risk?", "risks?"])
      expect(judgementQuestion(q)).toBe("at_risk");
    // A question about one thing is the model's judgement, with the snapshot.
    expect(judgementQuestion("Anything at risk in the cart?")).toBeUndefined();
    const reply = await ask(s, "What's at risk?");
    expect(reply.text).toMatch(/One thing at risk:\n1\. Hasher: stopped: Couldn't fix\./);
    expect(reply.text).toMatch(/Not at risk: Tamper check, paused/);
    expect(reply.text).toMatch(/Based on:/);
    expectPlain(reply.text);
    expect(reply.cites?.map((c) => c.cardId)).toEqual(["c_broke", "c_mem"]);
  });
});

describe("PM-P6-8: the next sprint's bet is at most 85% of the last three sprints' mean", () => {
  const today = new Date().toISOString().slice(0, 10);
  const plus = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

  /** Three closed sprints that completed `done[i]` issues each (sized `size`). */
  async function history(s: S, done: number[], size?: number, project?: string) {
    for (const [i, n] of done.entries()) {
      const cycle = await s.pmStore.createCycle({
        name: `Sprint ${i + 1}`,
        startsOn: plus(-1),
        endsOn: plus(i + 1),
        state: "closed",
      });
      for (let k = 0; k < n; k++) {
        const id = `c_s${i}_${k}`;
        await card(s, id, `Done ${i}.${k}`, {
          cycleId: cycle.id,
          ...(size ? { estimate: size } : {}),
          ...(project ? { projectId: project } : {}),
        } as Partial<CardRecord>);
        await move(s, id, "done");
      }
    }
  }

  it("proposes a bet within the cap, stating the basis, and counts issues when estimation is off", async () => {
    const s = setup();
    await history(s, [5, 4, 3]);
    for (let k = 0; k < 5; k++) await card(s, `c_next_${k}`, `Next ${k}`);
    const reply = await ask(s, "Plan the next sprint");
    expect(reply.text).toMatch(
      /For Sprint 4 I suggest betting 3 issues, no more than 3: 85% of the 4 issues a sprint completed on average over the last 3 sprints \(Sprint 3: 3, Sprint 2: 4, Sprint 1: 5\); estimation is off, so the bet counts issues\./,
    );
    const p = reply.proposals?.[0];
    expect(p?.kind).toBe("create_cycle");
    expect((p?.patch?.cardIds as string[]).length).toBe(3);
    expect(p?.patch?.startsOn >= today).toBe(true);
    expect(p?.summary).toMatch(/Why: 85% of the 4 issues/);
    // Nothing changes until a person applies it.
    expect((await s.pmStore.cycles()).length).toBe(3);
  });

  it("sizes in points when the project's estimation is story points", async () => {
    const s = setup();
    await s.log.append({
      actor: "human",
      type: "project/settings_changed",
      payload: { project: "prj_pts", estimation: "points" },
    });
    await history(s, [2, 2, 2], 5, "prj_pts");
    expect(await estimationUnit(s.log, ["prj_pts"])).toBe("points");
    const cap = await sprintCapacity(
      s.log,
      await s.pmStore.cycles(),
      await s.cardStore.listCards(),
    );
    expect(cap).toMatchObject({ unit: "points", mean: 10, cap: 8 });
  });

  it("cuts a sprint the model proposes to the cap, with the basis, whatever it wrote", async () => {
    const s = setup();
    await history(s, [5, 4, 3]);
    for (let k = 0; k < 5; k++) await card(s, `c_next_${k}`, `Next ${k}`);
    const { model } = planner(() => ({
      text: "Here is a sprint.",
      toolCalls: [
        {
          id: "1",
          name: "propose_create_cycle",
          arguments: {
            name: "Sprint 4",
            starts_on: plus(1),
            ends_on: plus(15),
            card_ids: [0, 1, 2, 3, 4].map((k) => `c_next_${k}`),
            reason: "the backlog is ready",
          },
        },
      ],
    }));
    const reply = await ask(s, "Put everything that's ready into one sprint please", { model });
    const p = reply.proposals?.find((x) => x.kind === "create_cycle");
    expect((p?.patch?.cardIds as string[]).length).toBe(3);
    expect(p?.summary).toMatch(/85% of the 4 issues/);
    expect(reply.text).toMatch(/I cut Sprint 4 to 3 issues, no more than 3/);
  });

  it("before any sprint has closed, leaves the first sprint to the Planning model, uncapped", async () => {
    const s = setup();
    for (let k = 0; k < 3; k++) await card(s, `c_x${k}`, `Anything ${k}`);
    const { model, seen } = planner(() => ({
      text: "A first sprint.",
      toolCalls: [
        {
          id: "1",
          name: "propose_create_cycle",
          arguments: {
            name: "Sprint 1",
            starts_on: plus(1),
            ends_on: plus(15),
            card_ids: ["c_x0", "c_x1", "c_x2"],
            reason: "the first slice",
          },
        },
      ],
    }));
    const reply = await ask(s, "plan the next sprint", { model });
    expect(seen).toHaveLength(1);
    const p = reply.proposals?.find((x) => x.kind === "create_cycle");
    expect((p?.patch?.cardIds as string[]).length).toBe(3);
  });
});

describe("PM-P6-9: over the 80% size horizon, a split and never a retry", () => {
  /** 24 measured implement attempts: small changes pass, large ones fail. */
  async function measured(s: S) {
    const rows: [number, number, boolean][] = [
      [2, 10, true],
      [3, 15, true],
      [2, 20, true],
      [3, 25, true],
      [4, 30, true],
      [3, 35, true],
      [2, 40, true],
      [4, 45, true],
      [3, 50, true],
      [4, 55, false],
      [3, 60, true],
      [4, 70, true],
      [5, 80, false],
      [4, 90, true],
      [5, 100, false],
      [5, 110, false],
      [4, 120, false],
      [5, 130, true],
      [6, 140, false],
      [5, 150, false],
      [6, 160, false],
      [6, 180, false],
      [5, 190, false],
      [6, 200, false],
    ];
    for (const [i, [difficulty, lines, passed]] of rows.entries()) {
      const id = `m_${i}`;
      await card(s, id, id, { kind: "implement", difficulty } as Partial<CardRecord>);
      const a = await s.cardStore.runs.startAttempt({ cardId: id, attemptNumber: 1, modelId: "w" });
      await s.cardStore.runs.finishAttempt({
        attemptId: a.id,
        status: passed ? "passed" : "failed",
        stopReason: passed ? "gate_passed" : "repair_exhausted",
        tokensUsed: 1,
        secondsUsed: 1,
        linesAdded: lines,
      });
      await move(s, id, passed ? "done" : "parked");
    }
  }

  async function big(s: S) {
    await card(s, "c_big", "Export everything", {
      kind: "implement",
      difficulty: 4,
      estimate: 8,
      acceptanceCriteria: [
        "exports CSV",
        "exports JSON",
        "streams large tables",
        "reports progress",
      ],
      stopReason: "repair_exhausted",
    } as Partial<CardRecord>);
    await move(s, "c_big", "parked");
  }

  it("asked to retry an issue over the horizon, proposes a split by its criteria with the reason", async () => {
    const s = setup();
    await measured(s);
    await big(s);
    const reply = await ask(s, "Can we retry it?", { cardId: "c_big" });
    expect(reply.text).toMatch(
      /I'd split Export everything, not retry it: about \d+ changed lines is over the \d+ lines the Coding model passes 80% of the time/,
    );
    const [p] = reply.proposals ?? [];
    expect(p?.kind).toBe("split_card");
    expect(p?.cardId).toBe("c_big");
    expect(p?.cards?.map((c) => c.acceptanceCriteria)).toEqual([
      ["exports CSV", "exports JSON"],
      ["streams large tables", "reports progress"],
    ]);
    expect(p?.summary).toMatch(/instead of retrying it/);
    expect((await s.cardStore.getCard("c_big"))?.status).toBe("parked");
  });

  it("turns the model's retry of an issue over the horizon into a split, and leaves one within it", async () => {
    const s = setup();
    await measured(s);
    await big(s);
    await card(s, "c_small", "Trim names", {
      kind: "implement",
      difficulty: 2,
      stopReason: "repair_exhausted",
    } as Partial<CardRecord>);
    await move(s, "c_small", "parked");
    const { model } = planner(() => ({
      text: "Both should go again.",
      toolCalls: ["c_big", "c_small"].map((id, i) => ({
        id: String(i),
        name: "propose_move_card",
        arguments: { card_id: id, to: "ready", reason: "give it another go" },
      })),
    }));
    const reply = await ask(s, "What should happen to the parked ones?", { model });
    const kinds = (reply.proposals ?? []).map((p) => [p.kind, p.cardId]);
    expect(kinds).toContainEqual(["split_card", "c_big"]);
    expect(kinds).toContainEqual(["unpark", "c_small"]);
    expect(kinds).not.toContainEqual(["unpark", "c_big"]);
    expect(reply.text).toMatch(/I did not propose retrying Export everything/);
  });
});

describe("PM-P6-10: the unsolicited-message budget, and the panel while the board is in focus", () => {
  async function notifier(s: S, clock: () => Date) {
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sek-judgement-cfg-"));
    dirs.push(process.env.SEKHEMET_CONFIG_DIR);
    restores.push(chooseSecretsFile(process.env.SEKHEMET_CONFIG_DIR));
    const { hook, hits } = await slackStandIn();
    writeSettings(s.repoPath, { slackWebhookUrl: hook });
    return { n: await startNotifier(s.log, s.repoPath, { intervalMs: 60_000, now: clock }), hits };
  }
  const toReview = async (s: S, id: string, priority?: number) => {
    await card(s, id, `Issue ${id}`, priority ? ({ priority } as Partial<CardRecord>) : {});
    await s.cardStore.updateCardStatus(id, "verify", "setup", "harness", { override: true });
    await s.cardStore.updateCardStatus(id, "review", "gates passed");
  };

  it("holds the 4th non-urgent notice, lets an urgent one through to the 5th, and never sends a 6th", async () => {
    const s = setup();
    const { n, hits } = await notifier(s, () => new Date());
    for (const id of ["a1", "a2", "a3", "a4"]) await toReview(s, id);
    expect(await n.tick()).toBe(3);
    expect((await s.log.getEventsByTypes(["pm/notice_held"])).map((e) => e.cardId)).toEqual(["a4"]);
    await toReview(s, "u1", 1);
    await toReview(s, "u2", 1);
    await toReview(s, "u3", 1);
    expect(await n.tick()).toBe(2);
    n.stop();
    expect(hits).toHaveLength(5);
    expect((await s.log.getEventsByTypes(["pm/notice_held"])).map((e) => e.cardId)).toEqual([
      "a4",
      "u3",
    ]);
  });

  it("while the board was in focus in the last 5 minutes, shows the item in Seshat's panel instead", async () => {
    const s = setup();
    const person = s.log.localPrincipal();
    let at = new Date();
    const { n, hits } = await notifier(s, () => at);
    await s.log.append({
      actor: "harness",
      type: "pm/board_focus",
      payload: { principal: person },
    });
    await toReview(s, "f1");
    expect(await n.tick()).toBe(0);
    expect(hits).toHaveLength(0);
    const shown = await s.log.getEventsByTypes(["pm/notice_shown"]);
    expect(shown.map((e) => e.cardId)).toEqual(["f1"]);
    const panel = (await s.pmStore.thread()).at(-1);
    expect(panel?.role).toBe("pm");
    expect(panel?.text).toMatch(/Ready for review: f1 passed its checks/);
    // PM-N9-6: the product's notice, which the panel shows apart from Seshat's voice.
    expect(panel?.model).toBe("notifier");
    expect(threadNotice(panel as never)).toMatch(/^Notice · Ready for review/);
    // Past five minutes without focus, notices go out again, and the shown one used no budget.
    at = new Date(Date.now() + 6 * 60_000);
    for (const id of ["f2", "f3", "f4"]) await toReview(s, id);
    expect(await n.tick()).toBe(3);
    n.stop();
  });
});

describe("PM-P6-12: a closing sprint records Seshat's measures", () => {
  it("records forecast calibration, proposal acceptance, Seshat-planned first-attempt passes and fields people edited after Seshat", async () => {
    const s = setup();
    const start = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const cycle = await s.pmStore.createCycle({
      name: "Sprint 1",
      startsOn: start,
      endsOn: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    });
    // Seshat proposed three changes; a person applied two and discarded one.
    const reply = await s.pmStore.appendReply({
      replyTo: [],
      text: "Three changes.",
      proposals: [
        { kind: "create_card", cards: [{ title: "Planned by Seshat" }], summary: "Create" },
        {
          kind: "update_card",
          cardId: "c_seshat",
          patch: { priority: 2 },
          before: {},
          summary: "Priority",
        },
        {
          kind: "update_card",
          cardId: "c_seshat",
          patch: { labels: ["x"] },
          before: {},
          summary: "Label",
        },
      ],
    });
    const [p0, p1, p2] = reply.proposals ?? [];
    await card(s, "c_seshat", "Planned by Seshat", { cycleId: cycle.id } as Partial<CardRecord>);
    await s.pmStore.setProposalState(p0?.id as string, "applied", ["c_seshat"]);
    await s.cardStore.updateCard("c_seshat", { priority: 2 }, "human");
    await s.pmStore.setProposalState(p1?.id as string, "applied", ["c_seshat"]);
    await s.pmStore.setProposalState(p2?.id as string, "discarded");
    // Its first attempt, by the Coding model, passed during the sprint.
    const a = await s.cardStore.runs.startAttempt({
      cardId: "c_seshat",
      attemptNumber: 1,
      modelId: "w",
    });
    await s.cardStore.runs.finishAttempt({
      attemptId: a.id,
      status: "passed",
      stopReason: "gate_passed",
      tokensUsed: 1,
      secondsUsed: 1,
    });
    // A person then changed the field Seshat set.
    await s.cardStore.updateCard("c_seshat", { priority: 3 }, "human");
    const measures = await recordSprintClose(
      { cardStore: s.cardStore, log: s.log },
      { ...cycle, state: "closed" },
    );
    expect(measures).toMatchObject({
      cycleId: cycle.id,
      forecast: { state: "no_forecast" },
      calibration: { held: 0, decided: 0 },
      proposals: { applied: 2, discarded: 1, acceptanceRate: 0.67 },
      planned: { issues: 1, passedFirstTry: 1, rate: 1 },
      editedAfterSeshat: 1,
    });
    // Once per sprint.
    await recordSprintClose({ cardStore: s.cardStore, log: s.log }, { ...cycle, state: "closed" });
    expect(await s.log.getEventsByTypes([SPRINT_MEASURED])).toHaveLength(1);
  });
});
