import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagedLlamaServerAdapter } from "../src/llama_server.js";
import {
  ModelLeaseHeld,
  acquireModelLease,
  modelLeaseWaitLine,
  readModelLease,
  setModelLeaseOwner,
  tryModelLease,
} from "../src/model_lease.js";

// NEW-models-17 (MD-N17-1, MD-N17-2; FINDINGS REL-07): one machine-wide model
// lease at <user dir>/model.lock, taken by exclusive creation, naming its
// holder by pid and process start time (the runner lease's pattern), and the
// workspace, project, model and port it holds. Real processes throughout:
// each holder is a separate Node process, and a holder is killed for real.

const DIST = join(import.meta.dirname, "..", "dist");
let dir: string;
let lock: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-model-lease-"));
  lock = join(dir, "model.lock");
  setModelLeaseOwner({ workspace: "ws_parent", project: "/work/parent" });
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

/** A separate process running `body` with the lease module imported as `L`; resolves on its first line. */
function holder(body: string): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const L = await import(${JSON.stringify(join(DIST, "model_lease.js"))});
       const lock = ${JSON.stringify(lock)};
       ${body}`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
      const nl = out.indexOf("\n");
      if (nl >= 0) resolve({ child, line: out.slice(0, nl) });
    });
    child.once("exit", (code) => reject(new Error(`holder exited ${code}: ${out}`)));
  });
}

const exited = (c: ChildProcess) =>
  c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((r) => c.once("exit", () => r()));

describe("the machine-wide model lease (MD-N17-1)", () => {
  it("is taken by one process, names its workspace, project, model and port, and passes on only when its holder is gone", async () => {
    const { child, line } = await holder(`
      L.setModelLeaseOwner({ workspace: "ws_alpha", project: "/work/alpha" });
      const got = L.tryModelLease({ model: "coder-a", port: 18801 }, lock);
      console.log("release" in got ? "held" : "refused");
      setInterval(() => {}, 1000);`);
    expect(line).toBe("held");
    const lease = readModelLease(lock);
    expect(lease).toMatchObject({
      pid: child.pid,
      workspace: "ws_alpha",
      project: "/work/alpha",
      models: [{ model: "coder-a", port: 18801 }],
    });
    expect(lease?.processStart).toBeTruthy();
    // A second process is refused while the first lives, and told who holds it.
    const second = tryModelLease({ model: "planner-b", port: 18802 }, lock);
    expect("holder" in second && second.holder.pid).toBe(child.pid);
    if (!("holder" in second)) throw new Error("expected a holder");
    expect(modelLeaseWaitLine(second.holder)).toMatch(
      /project \/work\/alpha \(workspace ws_alpha\) holds coder-a on port 18801 \(pid \d+/,
    );
    // Killed for real: its lease is stale by pid, and taken without cleanup.
    child.kill("SIGKILL");
    await exited(child);
    const third = tryModelLease({ model: "planner-b", port: 18802 }, lock);
    expect("release" in third).toBe(true);
    expect(readModelLease(lock)).toMatchObject({
      pid: process.pid,
      workspace: "ws_parent",
      models: [{ model: "planner-b", port: 18802 }],
    });
    if ("release" in third) third.release();
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  it("is not held by a recycled pid: a live process with another start time", async () => {
    const { child } = await holder(`console.log("up"); setInterval(() => {}, 1000);`);
    writeFileSync(
      lock,
      JSON.stringify({
        pid: child.pid,
        processStart: "Thu Jan  1 00:00:00 1970",
        token: "old",
        since: "1970-01-01T00:00:00.000Z",
        workspace: "ws_gone",
        project: "/work/gone",
        models: [{ model: "old", port: 1, since: "1970-01-01T00:00:00.000Z" }],
      }),
    );
    const got = tryModelLease({ model: "coder-a", port: 18801 }, lock);
    expect("release" in got).toBe(true);
    expect(readModelLease(lock)?.pid).toBe(process.pid);
    if ("release" in got) got.release();
  }, 30_000);

  it("is held once by a process for every model it loads, and given up after the last", () => {
    const a = tryModelLease({ model: "coder-a", port: 18801 }, lock);
    const b = tryModelLease({ model: "planner-b", port: 18802 }, lock);
    if (!("release" in a) || !("release" in b)) throw new Error("expected both held");
    expect(readModelLease(lock)?.models.map((m) => m.model)).toEqual(["coder-a", "planner-b"]);
    a.release();
    expect(readModelLease(lock)?.models.map((m) => m.model)).toEqual(["planner-b"]);
    a.release();
    expect(readModelLease(lock)?.models).toHaveLength(1);
    b.release();
    expect(existsSync(lock)).toBe(false);
  });

  it("goes to exactly one of several processes racing for it", async () => {
    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        holder(`
          const got = L.tryModelLease({ model: "m${i}", port: ${18810 + i} }, lock);
          console.log("release" in got ? "got" : "refused");
          setInterval(() => {}, 1000);`),
      ),
    );
    expect(racers.filter((r) => r.line === "got")).toHaveLength(1);
  }, 30_000);
});

describe("waiting for the lease, or attaching (MD-N17-2)", () => {
  it("waits, says once who holds which model, and takes the lease when it is released", async () => {
    const { child } = await holder(`
      L.setModelLeaseOwner({ workspace: "ws_alpha", project: "/work/alpha" });
      const got = L.tryModelLease({ model: "coder-a", port: 18801 }, lock);
      console.log("held");
      setTimeout(() => { got.release(); }, 800);
      setInterval(() => {}, 1000);`);
    const said: string[] = [];
    const t0 = Date.now();
    const got = await acquireModelLease(
      { model: "planner-b", port: 18802 },
      { path: lock, pollMs: 50, waitMs: 20_000, onWait: (l) => said.push(l) },
    );
    expect("release" in got).toBe(true);
    expect(Date.now() - t0).toBeGreaterThan(500);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/Waiting for this machine's model lease: project \/work\/alpha/);
    expect(said[0]).toMatch(/coder-a on port 18801/);
    if ("release" in got) got.release();
    child.kill("SIGKILL");
  }, 30_000);

  it("attaches to an engine that already serves a matching profile, without the lease", async () => {
    const { child } = await holder(`
      L.tryModelLease({ model: "coder-a", port: 18801 }, lock);
      console.log("held"); setInterval(() => {}, 1000);`);
    const got = await acquireModelLease(
      { model: "coder-a", port: 18801 },
      { path: lock, pollMs: 50, attach: async () => true, onWait: () => {} },
    );
    expect(got).toEqual({ attached: true });
    expect(readModelLease(lock)?.pid).toBe(child.pid);
  }, 30_000);

  it("gives up after its wait, naming the holder", async () => {
    await holder(`
      L.setModelLeaseOwner({ workspace: "ws_alpha", project: "/work/alpha" });
      L.tryModelLease({ model: "coder-a", port: 18801 }, lock);
      console.log("held"); setInterval(() => {}, 1000);`);
    const err = await acquireModelLease(
      { model: "planner-b", port: 18802 },
      { path: lock, pollMs: 50, waitMs: 300, onWait: () => {} },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ModelLeaseHeld);
    expect(String(err.message)).toMatch(/\/work\/alpha.*coder-a on port 18801.*nothing was loaded/);
  }, 30_000);
});

/**
 * A fake llama-server: healthy at once, reports its model and window, and
 * appends its pid to `starts.log` so a second spawn would be seen.
 */
function fakeServer(model: string): string {
  const bin = join(dir, "fake-llama-server.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const arg = (f) => process.argv[process.argv.indexOf(f) + 1];
appendFileSync(${JSON.stringify(join(dir, "starts.log"))}, process.pid + "\\n");
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return res.end("{}");
  if (req.url === "/props") return res.end(JSON.stringify({ model_path: arg("-m"), default_generation_settings: { n_ctx: Number(arg("-c")) } }));
  res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
}).listen(Number(arg("--port")), "127.0.0.1");
`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(model, "not a real model");
  return bin;
}

const profile = (bin: string, model: string, modelId: string, port: number) => ({
  modelId,
  modelPath: model,
  binary: bin,
  port,
  contextTokens: 4096,
  startupTimeoutMs: 20_000,
  ollamaBaseUrl: "http://127.0.0.1:1",
});

describe("a managed engine holds the lease while its weights are resident (MD-N17-1, -2)", () => {
  it("takes it before the start, keeps it while the server runs, and gives it up at the unload", async () => {
    const model = join(dir, "a.gguf");
    const a = new ManagedLlamaServerAdapter({
      ...profile(fakeServer(model), model, "coder-a", 18831),
      modelLeasePath: lock,
    });
    try {
      expect(await a.load()).toBe("loaded");
      expect(readModelLease(lock)).toMatchObject({
        pid: process.pid,
        workspace: "ws_parent",
        models: [{ model: "coder-a", port: 18831 }],
      });
      await a.unload();
      expect(await a.confirmUnloaded()).toBe(true);
      expect(existsSync(lock)).toBe(false);
    } finally {
      await a.unload();
    }
  }, 30_000);

  it("in another process: attaches to the engine serving its profile, and waits, naming the holder, for another model", async () => {
    const model = join(dir, "a.gguf");
    const bin = fakeServer(model);
    const { child } = await holder(`
      const { ManagedLlamaServerAdapter } = await import(${JSON.stringify(join(DIST, "llama_server.js"))});
      L.setModelLeaseOwner({ workspace: "ws_alpha", project: "/work/alpha" });
      const a = new ManagedLlamaServerAdapter({ ...${JSON.stringify(profile(bin, model, "coder-a", 18832))}, modelLeasePath: lock });
      await a.load();
      console.log("loaded");
      setInterval(() => {}, 1000);`);
    const starts = () => readFileSync(join(dir, "starts.log"), "utf8").trim().split("\n").length;
    expect(starts()).toBe(1);
    // The same profile: attached, nothing started, the lease still the holder's.
    const same = new ManagedLlamaServerAdapter({
      ...profile(bin, model, "coder-a", 18832),
      modelLeasePath: lock,
    });
    expect(await same.load()).toBe("adopted");
    expect(starts()).toBe(1);
    expect(readModelLease(lock)?.pid).toBe(child.pid);
    // Another model: it waits, says who holds what, and gives up after its wait.
    const said: string[] = [];
    const otherModel = join(dir, "b.gguf");
    writeFileSync(otherModel, "not a real model");
    const other = new ManagedLlamaServerAdapter({
      ...profile(bin, otherModel, "planner-b", 18833),
      modelLeasePath: lock,
      modelLeaseWaitMs: 500,
      onModelLeaseWait: (l) => said.push(l),
    });
    const err = await other.load().catch((e) => e);
    expect(err).toBeInstanceOf(ModelLeaseHeld);
    expect(said[0]).toMatch(
      /project \/work\/alpha \(workspace ws_alpha\) holds coder-a on port 18832/,
    );
    expect(starts()).toBe(1);
    // The holder ends: its server goes with it, and the other model loads.
    child.kill("SIGTERM");
    await exited(child);
    try {
      expect(await other.load()).toBe("loaded");
      expect(readModelLease(lock)).toMatchObject({
        pid: process.pid,
        models: [{ model: "planner-b", port: 18833 }],
      });
    } finally {
      await other.unload();
    }
  }, 60_000);
});

/**
 * The host's own practice (CLAUDE.md): the Worker's server is started once
 * on its port, outside any card, and every card attaches to it. Adopted, it
 * held no lease, so another project's load of another model found the lease
 * free and loaded beside a 13 GB Worker on a 24 GB host (C4 review).
 */
describe("an adopted engine holds the lease while it is adopted (MD-N17-5)", () => {
  it("takes the lease when it adopts a server it did not start; another project's other model waits; the unload gives it up and leaves the server", async () => {
    const model = join(dir, "a.gguf");
    const bin = fakeServer(model);
    // Started by a person, not by the harness: no lease.
    const server = spawn(process.execPath, [bin, "--port", "18834", "-m", model, "-c", "4096"], {
      stdio: "ignore",
    });
    children.push(server);
    const up = Date.now();
    while (Date.now() - up < 10_000) {
      const ok = await fetch("http://127.0.0.1:18834/health").then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(lock)).toBe(false);
    const a = new ManagedLlamaServerAdapter({
      ...profile(bin, model, "coder-a", 18834),
      modelLeasePath: lock,
    });
    expect(await a.load()).toBe("adopted");
    expect(readModelLease(lock)).toMatchObject({
      pid: process.pid,
      models: [{ model: "coder-a", port: 18834 }],
    });
    // Another project's process, another model: it waits and is refused.
    const otherModel = join(dir, "b.gguf");
    writeFileSync(otherModel, "not a real model");
    const { line } = await holder(`
      const { ManagedLlamaServerAdapter } = await import(${JSON.stringify(join(DIST, "llama_server.js"))});
      const b = new ManagedLlamaServerAdapter({ ...${JSON.stringify(profile(bin, otherModel, "planner-b", 18835))}, modelLeasePath: lock, modelLeaseWaitMs: 400, onModelLeaseWait: () => {} });
      const r = await b.load().then((x) => x, (e) => e.name);
      console.log(String(r));
      setInterval(() => {}, 1000);`);
    expect(line).toBe("ModelLeaseHeld");
    expect(readFileSync(join(dir, "starts.log"), "utf8").trim().split("\n")).toHaveLength(1);
    // The same profile in another process attaches to it, as before.
    const { line: same } = await holder(`
      const { ManagedLlamaServerAdapter } = await import(${JSON.stringify(join(DIST, "llama_server.js"))});
      const c = new ManagedLlamaServerAdapter({ ...${JSON.stringify(profile(bin, model, "coder-a", 18834))}, modelLeasePath: lock, modelLeaseWaitMs: 400 });
      console.log(String(await c.load()));
      setInterval(() => {}, 1000);`);
    expect(same).toBe("adopted");
    // The unload gives the lease up; a server it did not start keeps running.
    await a.unload();
    expect(existsSync(lock)).toBe(false);
    expect(server.exitCode).toBe(null);
  }, 60_000);
});
