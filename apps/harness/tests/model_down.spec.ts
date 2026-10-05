import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, STOP_REASONS, initSchema } from "@sekhemet/kernel";
import { HttpInferenceAdapter, ManagedLlamaServerAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard, queueHaltReason } from "../src/execute.js";

// Worker-loop NEW-worker-loop-12 (WL-N12-1 to -3; FINDINGS_C1 REL-10, C.9
// item 5): a Coding model whose engine refuses its connection, or whose
// stream dies, ends the card with the environment stop `model_unavailable`
// — never `error` — the card is held in Ready at its checkpoint, and the
// queue starts no further card. The engine is a real OpenAI-compatible
// server in its own process, killed with SIGKILL (DEFINITION_OF_DONE §2A);
// the card runs through the real HTTP adapter, git and SQLite.

const dirs: string[] = [];
const servers: ChildProcess[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) if (s.exitCode === null) s.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/**
 * A fake OpenAI-compatible server: it streams the scripted replies in order;
 * `die` kills its own process with SIGKILL after the stream's first chunk.
 */
const SERVER = `
import { createServer } from "node:http";
const script = JSON.parse(process.argv[2]);
let n = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    const step = script[n++] ?? { finish: true };
    if (step.status) { res.writeHead(step.status, { "content-type": "application/json" }); res.end('{"error":"bad request"}'); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write("data: " + JSON.stringify(o) + "\\n\\n");
    const call = step.finish
      ? { name: "finish_card", arguments: "{}" }
      : { name: "write_file", arguments: JSON.stringify({ path: step.path, content: step.content }) };
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c" + n, function: { name: call.name } }] } }] });
    if (step.die) { setTimeout(() => process.kill(process.pid, "SIGKILL"), 50); return; }
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: call.arguments } }] } }] });
    send({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    res.write("data: [DONE]\\n\\n");
    res.end();
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

async function fakeEngine(script: unknown[]): Promise<{ url: string; proc: ChildProcess }> {
  const dir = tempDir("sek-engine-");
  const file = join(dir, "engine.mjs");
  writeFileSync(file, SERVER);
  const proc = spawn(process.execPath, [file, JSON.stringify(script)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  servers.push(proc);
  const port = await new Promise<string>((ok) => proc.stdout?.once("data", (d) => ok(String(d))));
  return { url: `http://127.0.0.1:${port.trim()}`, proc };
}

async function setup() {
  const repo = tempDir("sek-down-");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, ".sekhemet"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(
    join(repo, ".sekhemet", "gates.toml"),
    `[project]\nmax_files = 5\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
  );
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const boardService = new BoardServiceImpl(cardStore);
  const card = await cardStore.createCard({
    id: "card_down",
    tier: "task",
    title: "Write a",
    scopeFiles: ["src/a.ts"],
    stepBudget: 6,
    spec: "Write src/a.ts",
  });
  await boardService.transitionCard({
    cardId: card.id,
    fromStatus: card.status,
    toStatus: "ready",
    actor: "human",
  });
  const ctx = {
    repoPath: repo,
    restrictedMode: false,
    cardStore,
    boardService,
    log: () => {},
    headroomCheck: false,
    freeSpaceFloorBytes: 1,
  };
  return { repo, db, cardStore, ctx, cardId: card.id };
}

const adapter = (url: string) =>
  new HttpInferenceAdapter({ modelId: "fake-coder", baseUrl: url, apiFormat: "openai" });

describe("a Worker that is down (WL-N12-2)", () => {
  it("dies mid-stream: one retry, then model_unavailable; the card is held in Ready at its checkpoint and resumes from it", async () => {
    const s = await setup();
    const engine = await fakeEngine([
      { path: "src/a.ts", content: "export const a = 1;\n" },
      { die: true },
    ]);
    const result = await executeCard(
      s.ctx,
      (await s.cardStore.getCard(s.cardId)) as never,
      adapter(engine.url),
    );
    expect(engine.proc.signalCode).toBe("SIGKILL");
    expect(result.stopReason).toBe("model_unavailable");
    expect(result.passed).toBe(false);
    expect(result.evidence.stopDetail).toMatchObject({ model: "fake-coder" });
    expect(String(result.evidence.stopDetail?.error)).toMatch(/ECONNREFUSED|fetch failed/);
    expect(result.finalStatus).toBe("ready");
    const card = await s.cardStore.getCard(s.cardId);
    expect([card?.status, card?.stopReason]).toEqual(["ready", "model_unavailable"]);
    // Never counted against the Worker.
    expect(s.cardStore.runs.listCompetence()).toEqual([]);
    expect(s.cardStore.runs.listAttempts(s.cardId).at(-1)?.status).toBe("halted");
    // The queue starts no further card.
    expect(queueHaltReason(result.stopReason)).toBe(
      `model unavailable: ${STOP_REASONS.model_unavailable.nextAction}`,
    );
    // The engine is started again: the next run resumes from the checkpoint.
    const again = await fakeEngine([{ finish: true }]);
    const resumed = await executeCard(
      s.ctx,
      (await s.cardStore.getCard(s.cardId)) as never,
      adapter(again.url),
    );
    expect(resumed.resumedFrom?.step).toBe(1);
    expect(resumed.passed).toBe(true);
    s.db.close();
  }, 60_000);

  it("refuses its connection from the first step: model_unavailable, never error", async () => {
    const s = await setup();
    const engine = await fakeEngine([]);
    engine.proc.kill("SIGKILL");
    await new Promise((r) => engine.proc.once("exit", r));
    const result = await executeCard(
      s.ctx,
      (await s.cardStore.getCard(s.cardId)) as never,
      adapter(engine.url),
    );
    expect(result.stopReason).toBe("model_unavailable");
    expect(result.finalStatus).toBe("ready");
    expect((await s.cardStore.getCard(s.cardId))?.status).toBe("ready");
    s.db.close();
  }, 60_000);

  it("WL-N12-3: an HTTP 4xx from a live engine stays error, and is not retried as an outage", async () => {
    const s = await setup();
    const engine = await fakeEngine([{ status: 400 }, { status: 400 }]);
    const result = await executeCard(
      s.ctx,
      (await s.cardStore.getCard(s.cardId)) as never,
      adapter(engine.url),
    );
    expect(result.stopReason).toBe("error");
    expect(queueHaltReason(result.stopReason)).toBeUndefined();
    s.db.close();
  }, 60_000);
});

describe("the queue halts on the machine's stops", () => {
  it("memory pressure, a full disk and a Worker that is down end the round; other stops do not", () => {
    expect(queueHaltReason("memory_pressure")).toBe(
      `memory pressure: ${STOP_REASONS.memory_pressure.nextAction}`,
    );
    expect(queueHaltReason("disk_low")).toBe(`disk low: ${STOP_REASONS.disk_low.nextAction}`);
    expect(queueHaltReason("model_unavailable")).toMatch(
      /^model unavailable: Start the Coding model's engine/,
    );
    for (const r of ["error", "budget_exhausted", "gate_passed", "crashed"] as const)
      expect(queueHaltReason(r), r).toBeUndefined();
  });
});

/**
 * MD-N17-2's wait ends with `ModelLeaseHeld` when another project keeps its
 * model past the wait. That is the machine's state, not the issue's: the card
 * stops `model_unavailable` (held in Ready, the queue halts), never `error`,
 * which let the queue start the next card into another 30-minute wait, and
 * so on through an overnight (C4 review). The lease is held by a real second
 * process; the card's engine is the real managed adapter.
 */
describe("another project holds the model lease past the wait (MD-N17-2)", () => {
  it("stops the card model_unavailable, held in Ready, and the queue starts no further card", async () => {
    const s = await setup();
    const lock = join(tempDir("sek-lease-"), "model.lock");
    const leaseModule = resolve(
      import.meta.dirname,
      "../../../packages/models/dist/model_lease.js",
    );
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const L = await import(${JSON.stringify(leaseModule)});
         L.setModelLeaseOwner({ workspace: "ws_other", project: "/work/other" });
         L.tryModelLease({ model: "planner-b", port: 18899 }, ${JSON.stringify(lock)});
         console.log("held"); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    servers.push(holder);
    await new Promise((ok) => holder.stdout?.once("data", ok));
    const model = join(tempDir("sek-weights-"), "coder.gguf");
    writeFileSync(model, "not a real model");
    const waits: string[] = [];
    const engine = new ManagedLlamaServerAdapter({
      modelId: "coder-a",
      modelPath: model,
      binary: "/nonexistent/llama-server",
      port: 18898,
      contextTokens: 32_768,
      ollamaBaseUrl: "http://127.0.0.1:1",
      modelLeasePath: lock,
      modelLeaseWaitMs: 300,
      onModelLeaseWait: (l) => waits.push(l),
    });
    const result = await executeCard(s.ctx, (await s.cardStore.getCard(s.cardId)) as never, engine);
    expect(waits[0]).toMatch(/project \/work\/other \(workspace ws_other\) holds planner-b/);
    expect(result.stopReason).toBe("model_unavailable");
    expect(String(result.evidence.stopDetail?.error)).toMatch(/model lease/);
    expect((await s.cardStore.getCard(s.cardId))?.status).toBe("ready");
    expect(s.cardStore.runs.listCompetence()).toEqual([]);
    expect(queueHaltReason(result.stopReason)).toBe(
      `model unavailable: ${STOP_REASONS.model_unavailable.nextAction}`,
    );
    s.db.close();
  }, 60_000);
});
