import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { cli, scratch } from "./support/g2_cli.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * C.6's fault "two projects, one machine" through the command a person runs
 * (C2d, FINDINGS_C1 TST-01; models.md MD-N17-4, rule 20a): two repositories,
 * each its own workspace and ledger, and one user directory, so one
 * machine-wide model lease. `sekhemet queue` is spawned in both at once, each
 * with its own GGUF as the Coding model under a harness-managed llama-server
 * — a fake engine (`SEKHEMET_LLAMA_SERVER`), a real process on a real port
 * that notes when it starts and stops and answers the Worker's two turns
 * slowly enough for the runs to meet. No model is loaded; the owner's
 * servers on 8098, 8099 and 8080 are never reached (a person's model is
 * served on 8110–8189).
 */

const SETUP = resolve(import.meta.dirname, "support/g5_models.mjs");
const BIN = resolve(import.meta.dirname, "../dist/index.js");

const FAKE_ENGINE = (events: string) => `#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("version: 1111 (abcdef0)\\nbuilt with test for test");
  process.exit(0);
}
const arg = (f) => argv[argv.indexOf(f) + 1];
const note = (event) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event, model: arg("-m"), port: Number(arg("--port")), t: Date.now() }) + "\\n");
note("start");
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { note("stop"); process.exit(0); });
const turns = [
  { name: "write_file", arguments: JSON.stringify({ path: "src/a.ts", content: "export const a = 1;\\n" }) },
  { name: "finish_card", arguments: "{}" },
];
let n = 0;
createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const json = (b) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); };
    if (req.url === "/health") return json({ status: "ok" });
    if (req.url === "/props")
      return json({ model_path: arg("-m"), build_info: "b7777-1a2b3c4", default_generation_settings: { n_ctx: Number(arg("-c")) / Number(arg("-np") ?? 1) } });
    if (!req.url.startsWith("/v1/chat/completions")) return json({});
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const worker = (body.tools ?? []).some((t) => (t.function?.name ?? t.name) === "finish_card");
    const call = worker ? turns[Math.min(n++, turns.length - 1)] : undefined;
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    // Slow enough that the other project's run starts while this one holds the machine.
    setTimeout(() => {
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o) => res.write("data: " + JSON.stringify(o) + "\\n\\n");
        if (call) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c" + n, type: "function", function: { name: call.name, arguments: call.arguments } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage });
        } else {
          send({ choices: [{ delta: { content: "" } }] });
          send({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
        }
        res.write("data: [DONE]\\n\\n");
        return res.end();
      }
      const message = call
        ? { role: "assistant", content: "", tool_calls: [{ id: "c" + n, type: "function", function: call }] }
        : { role: "assistant", content: "" };
      json({ choices: [{ message, finish_reason: call ? "tool_calls" : "stop" }], usage });
    }, worker ? 1500 : 0);
  });
}).listen(Number(arg("--port")), "127.0.0.1");
`;

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await new Promise((r) => c.once("close", r));
    }
  }
});

/** `sekhemet queue` in a project, to its queue report or its exit. */
function queue(p: G2Project, worker: string, env: Record<string, string>): Promise<string> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, "queue", "--worker", worker], {
      cwd: p.repo,
      env: { ...p.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    let reported = false;
    const read = (b: Buffer) => {
      out += String(b);
      if (!reported && /Report: \S+queue_report\.json/.test(out)) {
        reported = true;
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }, 3000);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const timer = setTimeout(() => child.kill("SIGKILL"), 170_000);
    child.on("close", () => {
      clearTimeout(timer);
      done(out);
    });
  });
}

function cardOf(p: G2Project): { status: string; workspace: string } {
  const db = new DatabaseSync(join(p.repo, ".sekhemet", "events.db"), { readOnly: true });
  try {
    const c = db.prepare("SELECT status FROM cards WHERE id = 'c1'").get() as { status: string };
    const first = db.prepare("SELECT hash FROM events ORDER BY seq LIMIT 1").get() as {
      hash: string;
    };
    return { status: c.status, workspace: `ws_${first.hash.slice(0, 12)}` };
  } finally {
    db.close();
  }
}

describe("C.6: two projects, one machine, through `sekhemet queue` (MD-N17-4)", () => {
  it("MD-N17-4: two projects' queues started together on one machine: the second waits for the model lease naming the first project and its model, the two engines never run at once, and both issues pass", async () => {
    // One person, one user directory; two repositories.
    const root = scratch("sek-two-projects-");
    const home = join(root, "home");
    mkdirSync(home);
    const where = (name: string) => {
      const cwd = join(root, name);
      mkdirSync(cwd);
      return { cwd, home };
    };
    const card = {
      id: "c1",
      tier: "story" as const,
      title: "Write a",
      status: "ready" as const,
      scopeFiles: ["src/a.ts"],
      stepBudget: 4,
      spec: "Export a constant named a from src/a.ts",
      acceptanceCriteria: ["src/a.ts exports a"],
    };
    const a = await g2Project(where("timesheets"), { cards: [card], qualifyAs: [] });
    const b = await g2Project(where("payroll"), { cards: [card], qualifyAs: [] });
    const events = join(home, "engines.jsonl");
    const engine = join(home, "fake-llama-server.mjs");
    writeFileSync(engine, FAKE_ENGINE(events));
    chmodSync(engine, 0o755);
    const env = { SEKHEMET_LLAMA_SERVER: engine };
    // Each project's own GGUF, registered once on this machine and qualified under its id.
    for (const [p, id] of [
      [a, "coder-a"],
      [b, "coder-b"],
    ] as const) {
      const weights = writeGguf(join(home, `${id}.gguf`), { architecture: "qwen3moe", name: id });
      const added = await cli(["models", "add", weights, "--id", id], {
        cwd: p.repo,
        env: { ...p.env, ...env },
      });
      expect(added.status, added.stdout + added.stderr).toBe(0);
    }
    execFileSync(
      process.execPath,
      [SETUP, JSON.stringify([{ qualify: "coder-a" }, { qualify: "coder-b" }])],
      {
        env: { ...a.env, ...env },
      },
    );
    const [outA, outB] = await Promise.all([queue(a, "coder-a", env), queue(b, "coder-b", env)]);
    const both = `${outA}\n----\n${outB}`;
    // Both issues ran to their recorded stop.
    expect(cardOf(a).status, both).toBe("review");
    expect(cardOf(b).status, both).toBe("review");
    // Exactly one waited, naming the project, workspace and model that held the machine.
    const waitedA = /Waiting for this machine's model lease: (.+)\./.exec(outA);
    const waitedB = /Waiting for this machine's model lease: (.+)\./.exec(outB);
    expect([waitedA, waitedB].filter(Boolean), both).toHaveLength(1);
    const [holder, waiter] = waitedA ? [b, waitedA] : [a, waitedB];
    const holderModel = holder === a ? "coder-a" : "coder-b";
    expect(waiter?.[1]).toContain(`project ${holder.repo}`);
    expect(waiter?.[1]).toContain(`workspace ${cardOf(holder).workspace}`);
    expect(waiter?.[1]).toContain(`holds ${holderModel}`);
    // The two engines never answered at once: each started only after the other stopped.
    expect(existsSync(events), both).toBe(true);
    const seen = readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; model: string; t: number });
    const span = (model: string) => {
      const mine = seen.filter((e) => e.model.endsWith(model));
      const start = mine.find((e) => e.event === "start")?.t as number;
      const stop = mine.find((e) => e.event === "stop")?.t ?? Number.POSITIVE_INFINITY;
      return [start, stop] as const;
    };
    const [a0, a1] = span("coder-a.gguf");
    const [b0, b1] = span("coder-b.gguf");
    expect(a0 && b0, JSON.stringify(seen)).toBeTruthy();
    expect(a1 <= b0 || b1 <= a0, JSON.stringify(seen)).toBe(true);
    // Each ledger verifies on its own.
    for (const p of [a, b]) {
      const log = await cli(["log"], { cwd: p.repo, env: p.env });
      expect(log.stdout).toContain("VALID (100% Intact)");
    }
  }, 300_000);
});
