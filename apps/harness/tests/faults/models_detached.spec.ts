import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ManagedLlamaServerAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard } from "../../src/execute.js";
import {
  cleanUp,
  context,
  darwin,
  expectRecordedStop,
  openLedger,
  projectRepo,
  readyCard,
  slowFaults,
  smallVolume,
  tempDir,
  waitFor,
} from "./fault_fixture.js";

// C.6 fault 3: the models volume unmounted during a load. The weights sit on
// a real disk image (macOS; elsewhere a folder that is removed); a fake
// llama-server — a real process the managed adapter spawns, as it spawns the
// real one — starts, and while it is loading the image is detached with
// `hdiutil detach -force`. Its read of the weights then fails and it exits,
// as llama-server does when its model file is gone.

afterEach(cleanUp);

const FAKE = (dir: string) => `#!/usr/bin/env node
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const arg = (f) => process.argv[process.argv.indexOf(f) + 1];
writeFileSync(${JSON.stringify(join(dir, "started"))}, String(process.pid));
const until = Date.now() + 20000;
while (!existsSync(${JSON.stringify(join(dir, "go"))}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
try { readFileSync(arg("-m")); } catch (e) { console.error("llama_model_load: failed to load model: " + e.message); process.exit(1); }
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

describe("C.6: the models volume detached during a load", () => {
  it("ends in a recorded stop that holds the issue in Ready, and resume continues once the volume is back", async () => {
    const work = tempDir("sek-fault-models-");
    const repo = projectRepo(work);
    const l = openLedger(repo);
    const card = await readyCard(l, "card_models_gone");
    // The real image in `pnpm release-gate` (macOS); a folder removed in `pnpm gate`.
    const image = darwin && slowFaults;
    const vol = image ? smallVolume(16) : { mount: join(work, "models"), image: "" };
    mkdirSync(vol.mount, { recursive: true });
    const weights = join(vol.mount, "coder.gguf");
    writeFileSync(weights, "fake weights");
    const bin = join(work, "fake-llama-server.mjs");
    writeFileSync(bin, FAKE(work));
    chmodSync(bin, 0o755);
    const profile = async () => ({
      modelId: "fault-coder",
      modelPath: weights,
      binary: bin,
      port: await freePort(),
      contextTokens: 32768,
      startupTimeoutMs: 20_000,
      ollamaBaseUrl: "http://127.0.0.1:1",
      modelLeasePath: join(work, "model.lock"),
    });
    const adapter = new ManagedLlamaServerAdapter(await profile());
    const run = executeCard(context(repo, l), card, adapter);
    await waitFor(() => existsSync(join(work, "started")), 30_000, "the engine to start loading");
    // The volume goes while the engine is loading.
    if (image) execFileSync("hdiutil", ["detach", "-force", vol.mount], { stdio: "ignore" });
    else rmSync(vol.mount, { recursive: true, force: true });
    expect(existsSync(weights)).toBe(false);
    writeFileSync(join(work, "go"), "");
    const stopped = await run;
    await adapter.unload().catch(() => undefined);
    expect(stopped.passed).toBe(false);
    expect(stopped.stopReason).toBe("model_unavailable");
    await expectRecordedStop(l, card.id, "model_unavailable");
    expect((await l.cardStore.getCard(card.id))?.status).toBe("ready");
    // Not counted against the Worker.
    expect(l.cardStore.runs.listCompetence()).toEqual([]);

    // The volume is back: resume continues.
    if (image) {
      execFileSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", vol.mount, vol.image], {
        stdio: "ignore",
      });
    } else {
      mkdirSync(vol.mount, { recursive: true });
      writeFileSync(weights, "fake weights");
    }
    expect(existsSync(weights)).toBe(true);
    const again = new ManagedLlamaServerAdapter(await profile());
    try {
      const resumed = await executeCard(
        context(repo, l),
        (await l.cardStore.getCard(card.id)) as never,
        again,
      );
      expect(resumed.passed).toBe(true);
    } finally {
      await again.unload().catch(() => undefined);
    }
    expect(l.cardStore.verifyLedger().valid).toBe(true);
    l.db.close();
  }, 120_000);
});
