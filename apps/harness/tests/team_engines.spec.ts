import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedLlamaServerAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TeamEngine, checkTeamEngines, teamEngines } from "../src/team_engines.js";

// MD-N15-3, MD-N15-5 (models rule 26a): at start the Team server checks that
// each filled role's engine answers and matches its profile (MD-M4-1), adopts
// it with no load or unload — it reads /health and /props only — and sums the
// services' footprints against the measured headroom. Real local HTTP servers
// stand in for the engine containers; no model is loaded.

interface Fake {
  server: Server;
  port: number;
  requests: string[];
  props: Record<string, unknown> | undefined;
}

let dir: string;
const fakes: Fake[] = [];

async function fakeEngine(props: Record<string, unknown> | undefined): Promise<Fake> {
  const fake: Fake = { server: createServer(), port: 0, requests: [], props };
  fake.server.on("request", (req, res) => {
    fake.requests.push(`${req.method} ${req.url}`);
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === "/props" && fake.props) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fake.props));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
  const a = fake.server.address();
  fake.port = typeof a === "object" && a ? a.port : 0;
  fakes.push(fake);
  return fake;
}

/** The shipped engines with their weights in a temp folder, each on the given port. */
function enginesOn(ports: number[]): TeamEngine[] {
  return teamEngines({ modelsDir: dir }).map((e, i) => {
    const port = ports[i] as number;
    return {
      ...e,
      port,
      adapter: new ManagedLlamaServerAdapter({ ...e.adapter.launchProfile, port }),
    };
  });
}

/** What a matching engine reports on /props. */
const propsOf = (e: TeamEngine) => ({
  model_path: e.adapter.launchProfile.modelPath,
  build_info: "b10818-abc",
  default_generation_settings: { n_ctx: e.adapter.totalContextTokens(), speculative: false },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-team-"));
  for (const e of teamEngines({ modelsDir: dir }))
    writeFileSync(join(dir, e.model.source?.file as string), Buffer.alloc(1_000_000, 1));
});
afterEach(async () => {
  while (fakes.length) {
    const f = fakes.pop() as Fake;
    await new Promise<void>((r) => f.server.close(() => r()));
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("checkTeamEngines (MD-N15-3, MD-N15-5)", () => {
  it("accepts each filled role's engine that answers and matches its profile, reading only /health and /props", async () => {
    const shipped = teamEngines({ modelsDir: dir });
    const fs = await Promise.all(shipped.map(() => fakeEngine(undefined)));
    const engines = enginesOn(fs.map((f) => f.port));
    engines.forEach((e, i) => {
      (fs[i] as Fake).props = propsOf(e);
    });
    const report = await checkTeamEngines({ engines, headroomBytes: 100e9 });
    expect(report.engines.map((e) => [e.service, e.state])).toEqual([
      ["engine-coding", "ok"],
      ["engine-planning", "ok"],
      ["engine-research", "ok"],
    ]);
    expect(report.footprint.fits).toBe(true);
    expect(report.unfilled.map((u) => u.role)).toEqual(["review"]);
    expect(report.lines.join("\n")).toMatch(/Review.*unfilled/);
    // Adopted with no load or unload: nothing but the two reads reached any engine.
    for (const f of fs) expect(new Set(f.requests)).toEqual(new Set(["GET /health", "GET /props"]));
  });

  it("names a role with no engine, and refuses one that serves other weights, another window or another MTP state (MD-M4-1)", async () => {
    const [a, b] = await Promise.all([fakeEngine(undefined), fakeEngine(undefined)]);
    const closed = await fakeEngine(undefined);
    await new Promise<void>((r) => closed.server.close(() => r()));
    fakes.splice(fakes.indexOf(closed), 1);
    const engines = enginesOn([(a as Fake).port, (b as Fake).port, closed.port]);
    (a as Fake).props = { ...propsOf(engines[0] as TeamEngine), model_path: "/models/other.gguf" };
    (b as Fake).props = {
      ...propsOf(engines[1] as TeamEngine),
      default_generation_settings: { n_ctx: 4096, speculative: false },
    };
    const report = await checkTeamEngines({ engines, headroomBytes: 100e9 });
    const by = Object.fromEntries(report.engines.map((e) => [e.service, e]));
    expect(by["engine-coding"]?.state).toBe("refused");
    expect(by["engine-coding"]?.reason).toMatch(/\/models\/other\.gguf/);
    expect(by["engine-planning"]?.state).toBe("refused");
    expect(by["engine-planning"]?.reason).toMatch(/context 4096/);
    expect(by["engine-research"]?.state).toBe("no-engine");
    const text = report.lines.join("\n");
    expect(text).toMatch(/Coding.*refused/);
    expect(text).toMatch(/Research.*no engine answers on port/);

    const [c] = await Promise.all([fakeEngine(undefined)]);
    const one = enginesOn([(c as Fake).port]).slice(0, 1);
    (c as Fake).props = {
      ...propsOf(one[0] as TeamEngine),
      default_generation_settings: {
        n_ctx: (one[0] as TeamEngine).adapter.totalContextTokens(),
        speculative: true,
      },
    };
    const mtp = await checkTeamEngines({ engines: one, headroomBytes: 100e9 });
    expect(mtp.engines[0]?.state).toBe("refused");
    expect(mtp.engines[0]?.reason).toMatch(/MTP on/);
  });

  it("says when the services' summed footprint exceeds the measured headroom, naming each (MD-N15-5)", async () => {
    const fs = await Promise.all([0, 1, 2].map(() => fakeEngine(undefined)));
    const engines = enginesOn(fs.map((f) => f.port));
    engines.forEach((e, i) => {
      (fs[i] as Fake).props = propsOf(e);
    });
    const report = await checkTeamEngines({ engines, headroomBytes: 1e9 });
    expect(report.footprint.fits).toBe(false);
    const sum = report.engines.reduce((n, e) => n + (e.footprintBytes ?? 0), 0);
    expect(report.footprint.totalBytes).toBe(sum);
    const text = report.lines.join("\n");
    expect(text).toMatch(/exceeds the measured headroom/);
    for (const e of report.engines)
      expect(text).toContain(`${e.service} ${((e.footprintBytes ?? 0) / 1e9).toFixed(1)} GB`);

    const unmeasured = await checkTeamEngines({ engines });
    expect(unmeasured.footprint.fits).toBeUndefined();
    expect(unmeasured.lines.join("\n")).toMatch(/headroom was not measured/);
  });
});
