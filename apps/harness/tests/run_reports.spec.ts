import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  type QueueReport,
  executeCard,
  queueEntryOf,
  rebuildRunCaches,
  recordQueueReport,
} from "../src/execute.js";
import { initLocalKernel } from "../src/index.js";
import { startDashboardServer } from "../src/server.js";
import { Tracer, cardTrace } from "../src/tracing.js";

/**
 * NEW-runtime-9 (runtime.md items 30, 32, 34b): a span per tool call under
 * its step, the card's trace from the dashboard's API, the condensing saving
 * per card in the run report, and the report as a ledger event with the
 * files as a cache rebuilt from it. Real git, real SQLite, real commands.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "run-reports-"));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, ".sekhemet"));
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(
    join(repo, ".sekhemet", "gates.toml"),
    `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
  );
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return repo;
}

function scripted(turn: (n: number) => Omit<ToolCall, "id">[]) {
  const seen: InferenceRequest[] = [];
  let n = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "scripted",
    supportedArms: ["arm_a_flat"],
    generate: async (req) => {
      seen.push(req);
      n++;
      return {
        text: "",
        toolCalls: turn(n).map((c, i) => ({ id: `t${n}-${i}`, ...c })),
        usage: { promptTokens: 10, completionTokens: 2, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}

describe("NEW-runtime-9: telemetry as specified", () => {
  it("RUN-45, RUN-46, RUN-47: tool calls are spans under their step; the card's trace is served with Step labels; the condensing saving reaches the report entry", async () => {
    const repo = gitRepo();
    const k = initLocalKernel(repo);
    const card = await k.cardStore.createCard({
      id: "card_tr",
      tier: "story",
      title: "Write a (SPIDR: Path)",
      scopeFiles: ["src/a.ts"],
      acceptanceCriteria: ["exports a"],
      spec: "Write src/a.ts",
      status: "ready",
      stepBudget: 4,
    });
    // A command with long, repetitive output: the condenser removes most of it.
    const noisy = `node -e "for (let i = 0; i < 400; i++) console.log('compiling module ' + (i % 3) + ' ok')"`;
    const result = await executeCard(
      {
        repoPath: repo,
        restrictedMode: false,
        cardStore: k.cardStore,
        boardService: k.boardService,
        log: () => {},
        headroomCheck: false,
      },
      card,
      scripted((n) =>
        n === 1
          ? [
              {
                name: "write_file",
                arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
              },
            ]
          : n === 2
            ? [{ name: "run_cmd", arguments: { command: noisy } }]
            : [{ name: "finish_card", arguments: {} }],
      ).adapter,
    );

    // RUN-45: one span per tool call, child of its step's span, name and outcome.
    const tracer = Tracer.forRepo(repo);
    const spans = tracer.spans();
    tracer.close();
    const steps = spans.filter((s) => s.name === "card.turn");
    const tools = spans.filter((s) => s.name.startsWith("execute_tool "));
    const write = tools.find((s) => s.attributes["gen_ai.tool.name"] === "write_file");
    expect(write).toBeDefined();
    expect(write?.attributes["sekhemet.tool.outcome"]).toBe("ok");
    expect(steps.map((s) => s.spanId)).toContain(write?.parentSpanId);
    expect(write?.endNs).toBeGreaterThanOrEqual(write?.startNs ?? 0n);
    const cmd = tools.find((s) => s.attributes["gen_ai.tool.name"] === "run_cmd");
    expect(steps.map((s) => s.spanId)).toContain(cmd?.parentSpanId);

    // RUN-46: the card's trace, as the dashboard reads it, labels the step span Step.
    const trace = cardTrace(repo, card.id);
    const kinds = new Set(trace.map((s) => s.kind));
    expect(kinds).toEqual(new Set(["Card", "Step", "Model request", "Tool call"]));
    expect(trace.every((s) => typeof s.durationMs === "number" && s.durationMs >= 0)).toBe(true);
    const server = await startDashboardServer({
      db: k.db,
      log: k.log,
      cardStore: k.cardStore,
      boardService: k.boardService,
      repoPath: repo,
      port: 0,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/cards/${card.id}/traces`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { spans: { kind: string; label: string }[] };
      expect(body.spans.filter((s) => s.kind === "Step").length).toBe(steps.length);
      expect(body.spans.some((s) => s.kind === "Tool call" && s.label === "write_file")).toBe(true);
    } finally {
      await server.close();
    }

    // RUN-47: the tokens removed by condensing, per card, in the queue's entry.
    expect(result.condensedTokensSaved).toBeGreaterThan(100);
    const entry = queueEntryOf(card.id, 1, result, false);
    expect(entry.condensedTokensSaved).toBe(result.condensedTokensSaved);
    // CX-N5-3: per tool, beside the raw tool-output tokens.
    expect(entry.condensing?.savedTokens).toBe(result.condensedTokensSaved);
    expect(entry.condensing?.rawTokens).toBeGreaterThan(entry.condensing?.savedTokens ?? 0);
    expect(entry.condensing?.byTool.map((t) => [t.tool, t.calls])).toEqual([["run_cmd", 1]]);
    k.db.close();
  }, 60_000);

  it("CX-N5-3: a finished run's report gives condensing's savings in total and per tool, beside the raw tokens", async () => {
    const repo = gitRepo();
    const k = initLocalKernel(repo);
    const entry = (cardId: string, saved: number, raw: number) => ({
      cardId,
      attempt: 1,
      passed: true,
      accepted: false,
      stopReason: "gate_passed",
      turns: 2,
      durationMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      condensedTokensSaved: saved,
      condensing: {
        rawTokens: raw,
        savedTokens: saved,
        byTool: [{ tool: "run_cmd", calls: 1, rawTokens: raw, savedTokens: saved }],
      },
    });
    await recordQueueReport(k.log, repo, {
      startedAt: "2026-09-25T02:00:00.000Z",
      model: "m",
      entries: [entry("a", 300, 500), entry("b", 100, 400)],
      passAt1: 1,
      passAfterEscalation: 1,
      modelSwaps: 0,
      totalDurationMs: 1,
    });
    const [event] = await k.log.getEventsByTypes(["queue/reported"]);
    expect((event?.payload as { report: QueueReport }).report.condensing).toEqual({
      rawTokens: 900,
      savedTokens: 400,
      byTool: [{ tool: "run_cmd", calls: 2, rawTokens: 900, savedTokens: 400 }],
    });
    k.db.close();
  });

  it("RUN-56: a queue run's report is one queue/reported event; with the files deleted the Runs view lists the same runs and figures, rebuilt from the ledger", async () => {
    const repo = gitRepo();
    const k = initLocalKernel(repo);
    const report: QueueReport = {
      startedAt: "2026-09-25T01:02:03.000Z",
      model: "cyber-tiel",
      entries: [
        {
          cardId: "card_a",
          attempt: 1,
          passed: true,
          accepted: false,
          stopReason: "gate_passed",
          turns: 4,
          durationMs: 1000,
          promptTokens: 10,
          completionTokens: 5,
          condensedTokensSaved: 120,
        },
      ],
      passAt1: 1,
      passAfterEscalation: 1,
      modelSwaps: 0,
      totalDurationMs: 2000,
    };
    await recordQueueReport(k.log, repo, report);
    const events = await k.log.getEventsByTypes(["queue/reported"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ report });
    const cache = join(repo, ".sekhemet", "runs", "2026-09-25T01-02-03-000Z.json");
    expect(existsSync(cache)).toBe(true);

    const server = await startDashboardServer({
      db: k.db,
      log: k.log,
      cardStore: k.cardStore,
      boardService: k.boardService,
      repoPath: repo,
      port: 0,
    });
    try {
      const before = await (await fetch(`http://127.0.0.1:${server.port}/api/runs`)).json();
      rmSync(join(repo, ".sekhemet", "runs"), { recursive: true, force: true });
      rmSync(join(repo, ".sekhemet", "queue_report.json"), { force: true });
      const after = await (await fetch(`http://127.0.0.1:${server.port}/api/runs`)).json();
      expect(after).toEqual(before);
      expect((after as { runs: { cards: number }[] }).runs[0]?.cards).toBe(1);
      const id = (after as { runs: { id: string }[] }).runs[0]?.id;
      const one = (await (
        await fetch(`http://127.0.0.1:${server.port}/api/runs/${id}`)
      ).json()) as {
        entries: { condensedTokensSaved: number }[];
      };
      expect(one.entries[0]?.condensedTokensSaved).toBe(120);
    } finally {
      await server.close();
    }
    // The caches come back from the events.
    expect(await rebuildRunCaches(repo, k.log)).toBe(2);
    expect(JSON.parse(readFileSync(cache, "utf8"))).toEqual(report);
    expect(JSON.parse(readFileSync(join(repo, ".sekhemet", "queue_report.json"), "utf8"))).toEqual(
      report,
    );
    k.db.close();
  });
});
