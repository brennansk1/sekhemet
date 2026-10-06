import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { g2Dirs } from "./support/g2_cli.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * Speculative decoding qualified as it runs (C2d, FINDINGS_C1 TST-01;
 * models.md rule 13, MD-N8-2): `sekhemet qualify --speculative on` spawned
 * over a person's GGUF served by a harness-managed llama-server — a fake
 * engine (`SEKHEMET_LLAMA_SERVER`), a real process on a real port that
 * records how it was launched and answers every request in prose, never with
 * a tool call, so the qualification's tool-call checks fail. No model is
 * loaded; the owner's servers on 8098, 8099 and 8080 are never reached.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");

const PROSE_ENGINE = (log: string) => `#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("version: 1111 (abcdef0)\\nbuilt with test for test");
  process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const arg = (f) => argv[argv.indexOf(f) + 1];
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
    const text = "I would rather describe the change than make it.";
    const usage = { prompt_tokens: 10, completion_tokens: 12 };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write("data: " + JSON.stringify(o) + "\\n\\n");
      send({ choices: [{ delta: { content: text } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
      res.write("data: [DONE]\\n\\n");
      return res.end();
    }
    json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
  });
}).listen(Number(arg("--port")), "127.0.0.1");
`;

function sekhemet(
  args: string[],
  p: G2Project,
  env: Record<string, string>,
): Promise<{ status: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: p.repo,
      env: { ...p.env, ...env },
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
    }, 280_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, out });
    });
  });
}

describe("qualifying with speculative decoding on (MD-N8-2)", () => {
  it("MD-N8-2: `qualify --speculative on` launches the exact combination with MTP and prefix caching on; its tool-call checks failing, the combination fails and speculation is turned off with the reason recorded", async () => {
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
    const launches = join(p.home, "launches.jsonl");
    const engine = join(p.home, "fake-llama-server.mjs");
    writeFileSync(engine, PROSE_ENGINE(launches));
    chmodSync(engine, 0o755);
    const env = { SEKHEMET_LLAMA_SERVER: engine };
    const weights = writeGguf(join(p.home, "Tiel-Coder.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder",
    });
    expect((await sekhemet(["models", "add", weights, "--id", "tiel-coder"], p, env)).status).toBe(
      0,
    );

    const q = await sekhemet(["qualify", "--models", "tiel-coder", "--speculative", "on"], p, env);
    expect(q.status, q.out).toBe(1);
    expect(q.out).toMatch(
      /tiel-coder: .* not verified on this machine for .*: tool-call checks failed with speculative decoding on \(MTP/,
    );
    // The engine ran the speculative launch: the MTP head on.
    expect(existsSync(launches), q.out).toBe(true);
    const argv = readFileSync(launches, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(
      argv.some(
        (a) => a.includes("--spec-type") && a[a.indexOf("--spec-type") + 1] === "draft-mtp",
      ),
      JSON.stringify(argv),
    ).toBe(true);
    // The registry: that exact combination, speculation and prefix caching on, failed; speculation off, saying why.
    interface Entry {
      id: string;
      qualifications?: {
        combination: { settings: { speculative: unknown; prefixCaching?: unknown } };
        status: string;
        toolCallChecks: boolean;
        reason?: string;
      }[];
      speculative?: unknown;
    }
    const registry = JSON.parse(readFileSync(p.env.SEKHEMET_MODEL_REGISTRY as string, "utf8")) as {
      models: Entry[];
    };
    const entry = registry.models.find((m) => m.id === "tiel-coder");
    const record = entry?.qualifications?.find((r) => r.combination.settings.speculative === "mtp");
    expect(record, JSON.stringify(entry)).toBeDefined();
    expect(record?.combination.settings.prefixCaching).toBe(true);
    expect(record?.status).toBe("failed");
    expect(record?.toolCallChecks).toBe(false);
    expect(record?.reason).toMatch(/tool-call checks failed with speculative decoding on/);
    expect(JSON.stringify(entry?.speculative)).toMatch(/"enabled":false/);
    expect(JSON.stringify(entry?.speculative)).toMatch(
      /tool-call checks failed with speculative decoding on/,
    );
  }, 300_000);
});
