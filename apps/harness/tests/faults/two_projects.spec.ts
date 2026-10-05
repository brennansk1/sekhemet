import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { ManagedLlamaServerAdapter, setModelLeaseOwner } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard } from "../../src/execute.js";
import {
  DIST,
  cleanUp,
  context,
  expectRecordedStop,
  openLedger,
  projectRepo,
  readyCard,
  tempDir,
  track,
} from "./fault_fixture.js";

// C.6 fault 9, two projects on one machine (models MD-N17-4; FINDINGS_C1
// REL-07). Two workspaces, each with its own ledger, run an issue at the
// same time on a managed engine (a fake llama-server each — real processes
// the adapter spawns as it spawns the real one), in two harness processes
// sharing one user directory's machine-wide model lease. A 24 GB host holds
// one model at a time: the second waits, naming the first, and loads only
// once the first engine is gone.

afterEach(() => {
  setModelLeaseOwner({ workspace: process.cwd(), project: process.cwd() });
  cleanUp();
});

const PACKAGES = resolve(DIST, "../../../packages");

/** A fake llama-server; at its start it notes whether `OTHER_PORT`'s engine still answers. */
const FAKE = (overlapLog: string) => `#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const arg = (f) => process.argv[process.argv.indexOf(f) + 1];
const other = process.env.OTHER_PORT;
if (other) {
  const up = await fetch("http://127.0.0.1:" + other + "/health").then(() => true, () => false);
  appendFileSync(${JSON.stringify(overlapLog)}, (up ? "overlap " : "alone ") + arg("--port") + "\\n");
}
createServer((req, res) => {
  if (req.url === "/health") { res.setHeader("content-type", "application/json"); return res.end("{}"); }
  if (req.url === "/props") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ model_path: arg("-m"), default_generation_settings: { n_ctx: Number(arg("-c")) } })); }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\\n\\n");
  send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "finish_card", arguments: "{}" } }] } }] });
  send({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  res.write("data: [DONE]\\n\\n");
  res.end();
}).listen(Number(arg("--port")), "127.0.0.1");
`;

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

describe("C.6: two projects on one machine (MD-N17-4)", () => {
  it("the second project's load waits for the first's model lease, naming it; both issues end in their recorded stops and both ledgers verify", async () => {
    const machine = tempDir("sek-fault-machine-");
    const lock = join(machine, "model.lock");
    const overlap = join(machine, "engines.log");
    const bin = join(machine, "fake-llama-server.mjs");
    writeFileSync(bin, FAKE(overlap));
    chmodSync(bin, 0o755);
    const weightsA = join(machine, "coder-a.gguf");
    const weightsB = join(machine, "coder-b.gguf");
    writeFileSync(weightsA, "a");
    writeFileSync(weightsB, "b");
    const [portA, portB] = [await freePort(), await freePort()];

    const rootA = projectRepo(tempDir("sek-fault-proj-a-"));
    const rootB = projectRepo(tempDir("sek-fault-proj-b-"));
    const a = openLedger(rootA);
    const b = openLedger(rootB);
    const cardA = await readyCard(a, "card_a");
    await readyCard(b, "card_b");
    b.db.close();

    // Project A, in this process: its engine loads and holds the lease.
    setModelLeaseOwner({ workspace: a.log.workspaceId() as string, project: rootA });
    const engineA = new ManagedLlamaServerAdapter({
      modelId: "coder-a",
      modelPath: weightsA,
      binary: bin,
      port: portA,
      contextTokens: 32768,
      startupTimeoutMs: 20_000,
      ollamaBaseUrl: "http://127.0.0.1:1",
      modelLeasePath: lock,
    });
    expect(await engineA.load()).toBe("loaded");

    // Project B, in another harness process, starts meanwhile.
    const childLog = join(machine, "b.out");
    const script = join(machine, "project-b.mjs");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { executeCard } from ${JSON.stringify(join(DIST, "execute.js"))};
import { CardStore, EventLog, initSchema } from ${JSON.stringify(join(PACKAGES, "kernel/dist/index.js"))};
import { BoardServiceImpl } from ${JSON.stringify(join(PACKAGES, "board/dist/index.js"))};
import { ManagedLlamaServerAdapter, setModelLeaseOwner } from ${JSON.stringify(join(PACKAGES, "models/dist/index.js"))};
const root = ${JSON.stringify(rootB)};
const db = new DatabaseSync(root + "/.sekhemet/events.db");
initSchema(db);
const log = new EventLog(db);
const cardStore = new CardStore(db, log);
const boardService = new BoardServiceImpl(cardStore);
setModelLeaseOwner({ workspace: log.workspaceId(), project: root });
const say = (l) => appendFileSync(${JSON.stringify(childLog)}, l + "\\n");
const engine = new ManagedLlamaServerAdapter({
  modelId: "coder-b", modelPath: ${JSON.stringify(weightsB)}, binary: ${JSON.stringify(bin)}, port: ${portB},
  contextTokens: 32768, startupTimeoutMs: 20000, ollamaBaseUrl: "http://127.0.0.1:1",
  modelLeasePath: ${JSON.stringify(lock)}, modelLeaseWaitMs: 60000, onModelLeaseWait: say,
});
const result = await executeCard({ repoPath: root, workspaceFolder: root, restrictedMode: false, cardStore, boardService, log: () => {}, headroomCheck: false, freeSpaceFloorBytes: 1 }, await cardStore.getCard("card_b"), engine);
await engine.unload();
say("result " + result.stopReason);
db.close();
`,
    );
    const child = track(
      spawn(process.execPath, [script], {
        cwd: rootB,
        env: { ...process.env, OTHER_PORT: String(portA) },
        stdio: ["ignore", "ignore", "inherit"],
      }),
    );
    // B says, once, who holds which model, and waits.
    const deadline = Date.now() + 30_000;
    while (!(existsSync(childLog) && readFileSync(childLog, "utf8").includes("Waiting"))) {
      if (Date.now() > deadline) throw new Error("project B never waited for the lease");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(readFileSync(childLog, "utf8")).toContain(
      `Waiting for this machine's model lease: project ${rootA} (workspace ${a.log.workspaceId()}) holds coder-a on port ${portA}`,
    );
    // A runs its issue to its recorded stop, then its engine goes.
    const resultA = await executeCard(context(rootA, a), cardA, engineA);
    expect(resultA.stopReason).toBe("gate_passed");
    await expectRecordedStop(a, cardA.id, "gate_passed");
    await engineA.unload();
    expect(await engineA.confirmUnloaded()).toBe(true);
    // B then loads, alone, and runs its issue to its recorded stop.
    const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    expect(code).toBe(0);
    expect(readFileSync(childLog, "utf8")).toMatch(/result gate_passed/);
    // B's engine started only once A's no longer answered.
    const engines = readFileSync(overlap, "utf8").trim().split("\n");
    expect(engines, engines.join("; ")).toContain(`alone ${portB}`);
    expect(engines.filter((l) => l.startsWith("overlap"))).toEqual([]);
    const bAfter = openLedger(rootB);
    await expectRecordedStop(bAfter, "card_b", "gate_passed");
    bAfter.db.close();
    expect(a.cardStore.verifyLedger().valid).toBe(true);
    a.db.close();
  }, 180_000);
});
