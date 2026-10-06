import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { g2Dirs } from "./support/g2_cli.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * A person's own GGUF run as the Coding model under a harness-managed
 * llama-server (C2d, FINDINGS_C1 TST-01; models.md MD-N12-10, MD-M4-3): the
 * built command `sekhemet queue` spawned over a real repository, the engine
 * binary a fake llama-server (`SEKHEMET_LLAMA_SERVER`) — a real process on a
 * real port that records how it was launched, reports itself on `/props` and
 * answers the Worker's turns. No model is loaded; the owner's servers on
 * 8098, 8099 and 8080 are never reached (a generic model's port is 8110–8189).
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const SETUP = resolve(import.meta.dirname, "support/g5_models.mjs");

const FAKE_LLAMA_SERVER = (log: string) => `#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("version: 1111 (abcdef0)\\nbuilt with test for test");
  process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const arg = (f) => argv[argv.indexOf(f) + 1];
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
      return json({
        model_path: arg("-m"),
        build_info: "b7777-1a2b3c4",
        default_generation_settings: { n_ctx: Number(arg("-c")) / Number(arg("-np") ?? 1), speculative: false },
      });
    if (!req.url.startsWith("/v1/chat/completions")) return json({});
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const worker = (body.tools ?? []).some((t) => (t.function?.name ?? t.name) === "finish_card");
    if (worker) {
      const { messages: _m, tools: _t, ...settings } = body;
      appendFileSync(${JSON.stringify(log)} + ".requests", JSON.stringify(settings) + "\\n");
    }
    const call = worker ? turns[Math.min(n++, turns.length - 1)] : undefined;
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
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
  });
}).listen(Number(arg("--port")), "127.0.0.1");
`;

function sekhemet(
  args: string[],
  p: G2Project,
  extra: Record<string, string>,
): Promise<{ status: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: p.repo,
      env: { ...p.env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += String(b);
    });
    child.stderr.on("data", (b) => {
      out += String(b);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`sekhemet ${args.join(" ")} timed out\n${out}`));
    }, 170_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, out });
    });
  });
}

async function engineProject(): Promise<{
  p: G2Project;
  env: Record<string, string>;
  launches: string;
}> {
  const p = await g2Project(g2Dirs(), {
    cards: [
      {
        id: "c1",
        tier: "story",
        title: "Write a",
        status: "ready",
        scopeFiles: ["src/a.ts"],
        stepBudget: 4,
        spec: "Export a constant named a from src/a.ts",
        acceptanceCriteria: ["src/a.ts exports a"],
      },
    ],
    qualifyAs: [],
  });
  const launches = join(p.home, "llama-server-launches.jsonl");
  const engine = join(p.home, "fake-llama-server.mjs");
  writeFileSync(engine, FAKE_LLAMA_SERVER(launches));
  chmodSync(engine, 0o755);
  const env = { SEKHEMET_LLAMA_SERVER: engine };
  return { p, env, launches };
}

describe("a person's GGUF as the Coding model under a managed llama-server (MD-N12-10, MD-M4-3, MD-N4-2)", () => {
  it("MD-N12-10, MD-M4-3: `queue` launches it under its own id with the generic Worker profile, and the card's evidence records what the running server reported on /props", async () => {
    const { p, env, launches } = await engineProject();
    // The person's file, its trained context above the Worker's window.
    const weights = writeGguf(join(p.home, "Tiel-Coder-35B.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder 35B",
      contextLength: 262144,
    });
    const added = await sekhemet(["models", "add", weights, "--id", "tiel-coder"], p, env);
    expect(added.status).toBe(0);
    // Qualified under its own id, as `qualify --models tiel-coder` would record it.
    execFileSync(process.execPath, [SETUP, JSON.stringify([{ qualify: "tiel-coder" }])], {
      env: { ...p.env, ...env },
    });
    const run = await sekhemet(["queue", "--worker", "tiel-coder"], p, env);
    expect(existsSync(launches), run.out).toBe(true);
    // MD-N12-10: one launch of the person's file, at the Worker's 16,384 window, q8_0 KV.
    const argv = readFileSync(launches, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(argv.length).toBeGreaterThanOrEqual(1);
    const first = argv[0] as string[];
    const at = (flag: string) => first[first.indexOf(flag) + 1];
    expect(at("-m")).toBe(weights);
    expect(Number(at("-c")) / Number(at("-np") ?? 1)).toBe(16384);
    expect(at("-ctk")).toBe("q8_0");
    expect(at("-ctv")).toBe("q8_0");
    const port = Number(at("--port"));
    expect(port).toBeGreaterThanOrEqual(8110);
    expect(port).toBeLessThanOrEqual(8189);
    // The card ran on it, under its own model id.
    const db = new DatabaseSync(join(p.repo, ".sekhemet", "events.db"), { readOnly: true });
    try {
      const attempts = db
        .prepare("SELECT COUNT(*) AS n FROM attempts WHERE card_id = 'c1'")
        .get() as { n: number };
      expect(attempts.n, run.out).toBe(1);
    } finally {
      db.close();
    }
    // MD-M4-3: the evidence records the server's own report on /props, beside the launch's intent.
    const repro = join(p.repo, ".sekhemet", "evidence", "repro-c1-1.json");
    expect(existsSync(repro), run.out).toBe(true);
    const record = JSON.parse(readFileSync(repro, "utf8")) as {
      model: { id: string; runtime?: string };
      server?: Record<string, unknown>;
      engine?: Record<string, unknown>;
    };
    expect(record.model.id).toBe("tiel-coder");
    expect(record.server).toEqual({
      modelPath: weights,
      contextTokens: 16384,
      mtp: false,
      build: "b7777-1a2b3c4",
    });
    // The build is the server's own word (build_info), not the binary's --version.
    expect(record.model.runtime).toBe("b7777 (1a2b3c4)");
    // KV type: llama-server's /props does not report it; the launch's is recorded.
    expect(record.engine).toMatchObject({ kvType: "q8_0" });
  }, 240_000);

  it("MD-N4-2: the sampling the registry records for the model is what the Worker's requests carry, over the family's defaults", async () => {
    const { p, env, launches } = await engineProject();
    const weights = writeGguf(join(p.home, "Tiel-Coder-35B.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder 35B",
    });
    const sampling = ["--sampling", "temperature=0.55,top_p=0.91,top_k=33,min_p=0.02"];
    const added = await sekhemet(
      ["models", "add", weights, "--id", "tiel-coder", ...sampling],
      p,
      env,
    );
    expect(added.status).toBe(0);
    execFileSync(process.execPath, [SETUP, JSON.stringify([{ qualify: "tiel-coder" }])], {
      env: { ...p.env, ...env },
    });
    const run = await sekhemet(["queue", "--worker", "tiel-coder"], p, env);
    const sent = readFileSync(`${launches}.requests`, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(sent.length, run.out).toBeGreaterThanOrEqual(1);
    for (const body of sent)
      expect(body).toMatchObject({ temperature: 0.55, top_p: 0.91, top_k: 33, min_p: 0.02 });
  }, 240_000);
});
