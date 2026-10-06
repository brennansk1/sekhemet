import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import {
  type Place,
  freePort,
  npmRepo,
  place,
  runCli,
  spawnCli,
  writeFile,
} from "./support/cli_spawn.js";

// The first run through its door (C2d, FINDINGS_C1 TST-01; surface P10,
// items 5–8, 5a, 5b): the built `sekhemet` spawned in a real npm repository
// with an empty home and its own model folder, exactly as a person types it.
// Before C2d these criteria were proved by calling `runFirstRun` in process.
// Nothing loads a model (`SEKHEMET_MODEL_LOADS=off`); the browser is a script
// that only records being called; nothing leaves the machine.

/** A preload that records every connection and fetch the process makes. */
function netRecorder(p: Place): { env: Record<string, string>; hosts: () => string[] } {
  const log = join(p.root, "net.log");
  const file = join(p.root, "net-recorder.mjs");
  writeFileSync(
    file,
    `import net from "node:net";
import { appendFileSync } from "node:fs";
const note = (h) => { try { appendFileSync(${JSON.stringify(log)}, String(h) + "\\n"); } catch {} };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = args[0];
  const o = typeof a === "object" && a !== null && !Array.isArray(a) ? a : { port: a, host: args[1] };
  note(o.path ? "unix:" + o.path : (o.host ?? "localhost") + ":" + o.port);
  return connect.apply(this, args);
};
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  note("fetch " + (typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
  return realFetch(input, init);
};
`,
  );
  return {
    env: { NODE_OPTIONS: `--import=${file}` },
    hosts: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  };
}

const LOOPBACK =
  /^(fetch https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]|(127\.0\.0\.1|localhost|::1|unix):)/;

describe("the first run, spawned (surface P10)", () => {
  it(
    "SUR-1, SUR-3, SUR-34: --yes writes config.toml, npm gates with a typecheck and one .gitignore block, exactly once",
    { timeout: 90_000 },
    async () => {
      const p = place();
      const repo = npmRepo(p);
      const port = await freePort();
      const first = spawnCli(["--yes", "--port", String(port)], p);
      await first.until(/Sekhemet Configuration: http:\/\/127\.0\.0\.1:\d+/);
      await first.stop();
      expect(existsSync(join(repo, ".sekhemet", "config.toml"))).toBe(true);
      // SUR-1: npm, with a typecheck gate.
      const gates = readFileSync(join(repo, ".sekhemet", "gates.toml"), "utf8");
      expect(gates).toMatch(/id = "typecheck"/);
      expect(gates).toMatch(/npx|npm/);
      expect(gates).toMatch(/tsc/);
      expect(gates).not.toMatch(/\b(pnpm|yarn|bun)\b/);
      // SUR-3: a second first run (config.toml removed by hand) adds no second block.
      rmSync(join(repo, ".sekhemet", "config.toml"));
      const again = spawnCli(["--yes", "--port", String(await freePort())], p);
      await again.until(/Sekhemet Configuration: http:\/\/127\.0\.0\.1:\d+/);
      await again.stop();
      const ignore = readFileSync(join(repo, ".gitignore"), "utf8");
      expect(ignore.startsWith("node_modules/\n")).toBe(true);
      expect(ignore.match(/>>> sekhemet/g)?.length).toBe(1);
      // SUR-34: the state is never committable; the shared files are.
      const ignored = (path: string) =>
        spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: repo }).status === 0;
      for (const path of [
        ".sekhemet/evidence/",
        ".sekhemet/transcripts/",
        ".sekhemet/artifacts/",
        ".sekhemet/research/",
        ".sekhemet/observations/",
        ".sekhemet/live/",
        ".sekhemet/tuning/",
        ".sekhemet/traces.db",
        ".sekhemet/runs/",
        ".sekhemet/blobs/",
        ".sekhemet/gate-host/",
        ".sekhemet/events.db",
        ".sekhemet/queue_report.json",
        ".sekhemet/something-new/",
      ])
        expect(ignored(path), path).toBe(true);
      expect(ignored(".sekhemet/config.toml")).toBe(false);
      expect(ignored(".sekhemet/gates.toml")).toBe(false);
    },
  );

  it(
    "SUR-4, SUR-49: --yes asks nothing, opens no browser, and with no weights prints the Configuration address; later runs open it again",
    { timeout: 90_000 },
    async () => {
      const p = place();
      npmRepo(p);
      const first = spawnCli(["--yes", "--port", String(await freePort())], p);
      const [, url] = (await first.until(
        /Sekhemet Configuration: (http:\/\/127\.0\.0\.1:\d+\/#\/configuration)/,
      )) as RegExpMatchArray;
      // The address answers: the dashboard itself is serving.
      const page = await fetch((url as string).replace(/#.*$/, ""));
      expect(page.status).toBe(200);
      await first.stop();
      expect(first.out()).not.toMatch(/\?\s*$|\[y\/N\]|\(y\/n\)/im);
      expect(existsSync(p.browserLog)).toBe(false);
      // Nothing was downloaded: no model folder was made, no weights appeared.
      expect(existsSync(p.models)).toBe(false);
      // A later run, still with no model set up, opens Configuration again.
      const later = spawnCli(["--yes", "--port", String(await freePort())], p);
      await later.until(/Sekhemet Configuration: http:\/\/127\.0\.0\.1:\d+\/#\/configuration/);
      await later.stop();
      expect(existsSync(p.browserLog)).toBe(false);
    },
  );

  it(
    "SUR-50: with the Coding and Planning models' weights present the first run opens the board",
    { timeout: 90_000 },
    async () => {
      const p = place();
      npmRepo(p);
      // The managed files' names, each a real GGUF header standing in for weights.
      writeGguf(
        join(
          p.models,
          "Cyber-Tiel-Coder-35B-A3B-GGUF-MTP",
          "Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf",
        ),
        { ...SMALL, name: "Cyber-Tiel-Coder-35B-A3B" },
      );
      writeGguf(join(p.models, "Dirk-Qwen3.8-27B-GGUF", "Dirk-Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf"), {
        ...SMALL,
        name: "Dirk-Qwen3.8-27B",
      });
      const s = spawnCli(["--yes", "--port", String(await freePort())], p);
      const line = await s.until(/Sekhemet[^\n]*http:\/\/127\.0\.0\.1:\d+\/\S*/);
      await s.stop();
      expect(s.out()).toMatch(/Coding model \S+ — weights present/);
      expect(line[0]).not.toMatch(/Configuration|#\/configuration/);
      expect(line[0]).toMatch(/#\/board|http:\/\/127\.0\.0\.1:\d+\/?(\s|$)/);
    },
  );

  it(
    "SUR-6: with no user network setting the first run makes no outbound request",
    { timeout: 90_000 },
    async () => {
      const p = place();
      npmRepo(p);
      const rec = netRecorder(p);
      const s = spawnCli(["--yes", "--port", String(await freePort())], p, { env: rec.env });
      await s.until(/Sekhemet Configuration: http:\/\/127\.0\.0\.1:\d+/);
      // Let the server settle a moment: anything it would fetch on start has started.
      await new Promise((r) => setTimeout(r, 2000));
      await s.stop();
      const outbound = rec.hosts().filter((h) => !LOOPBACK.test(h));
      expect(outbound).toEqual([]);
    },
  );

  it(
    "SUR-8: a CI step's run: | block with a test command becomes a proposed gate",
    { timeout: 60_000 },
    async () => {
      const p = place();
      const repo = npmRepo(p);
      writeFile(
        repo,
        ".github/workflows/ci.yml",
        [
          "name: ci",
          "on: [push]",
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - name: Unit and integration",
          "        run: |",
          "          npm ci",
          "          npx vitest run --project integration",
          "",
        ].join("\n"),
      );
      // Proposed without a terminal: the step is named as a check.
      const plan = await runCli([], p);
      expect(plan.code).toBe(2);
      expect(plan.out).toMatch(
        /Checks from package\.json, \.github\/workflows\/ci\.yml: [^.]*ci-test/,
      );
      // Confirmed: the step's command, from inside its run: | block, is that check's command.
      const s = spawnCli(["--yes", "--port", String(await freePort())], p);
      await s.until(/Sekhemet Configuration: http:\/\/127\.0\.0\.1:\d+/);
      await s.stop();
      const gates = readFileSync(join(repo, ".sekhemet", "gates.toml"), "utf8");
      expect(gates).toMatch(/vitest/);
      expect(gates).toMatch(/--project/);
      expect(gates).toMatch(/integration/);
    },
  );
});
