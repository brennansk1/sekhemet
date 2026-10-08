import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CardStore } from "@sekhemet/kernel";
import {
  type EngineStatus,
  MockInferenceAdapter,
  ModelRegistry,
  assignRole,
} from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  engineDoctorCheck,
  memoryFloorCheck,
  ollamaRolesCheck,
  roleQualificationCheck,
  teamEnginesCheck,
} from "../src/doctor.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { type CombinationDeps, qualificationCombination } from "../src/qualify.js";
import { BIN } from "./cli_fixture.js";

// NEW-models-16 (rules 6a, 6c, 6d), NEW-models-19 (MD-N19-1, -5), MD-N8-1 and
// MD-N15-3: doctor's rows for the engine, the memory floor, Ollama's roles,
// each role's verification and the Team engines — each check that is not a
// pass carrying its next step, printed on its own line as "Do: …" (SUR-62).

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const GB = 1024 ** 3;
const mac = { os: "darwin", arch: "arm64", backend: "metal" } as const;
const status = (over: Partial<EngineStatus>): EngineStatus => ({
  floor: 10809,
  meetsFloor: false,
  platform: mac,
  installed: false,
  line: "llama-server not found.",
  fixes: [
    "Get the inference engine on Configuration › Models, or run `sekhemet engine get`",
    "`brew install llama.cpp`",
  ],
  offer: { release: "b10809", file: "f.tar.gz", sizeBytes: 1, sha256: "a", license: "MIT" },
  ...over,
});

describe("doctor: the engine (MD-N16-1, MD-N16-2, MD-N19-5)", () => {
  it("fails with no engine, naming this platform's first fix as its next step", () => {
    const c = engineDoctorCheck(status({}));
    expect(c).toMatchObject({ name: "Inference engine", status: "fail" });
    expect(c.detail).toBe("llama-server not found.");
    expect(c.do).toBe(
      "Get the inference engine on Configuration › Models, or run `sekhemet engine get`.",
    );
  });

  it("fails below the floor with both builds", () => {
    const c = engineDoctorCheck(
      status({
        engine: { path: "/opt/homebrew/bin/llama-server", origin: "path", build: 8000 },
        line: "llama-server b8000 found; b10809 or later needed (/opt/homebrew/bin/llama-server, on PATH).",
      }),
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/llama-server b8000 found; b10809 or later needed/);
    expect(c.do).toMatch(/\S/);
  });

  it("passes naming which engine, where it came from and its build", () => {
    const c = engineDoctorCheck(
      status({
        meetsFloor: true,
        engine: {
          path: "/u/engines/llama.cpp-b10809/llama-server",
          origin: "downloaded",
          build: 10809,
        },
        line: "llama-server b10809 at /u/engines/llama.cpp-b10809/llama-server (downloaded by Sekhemet); b10809 or later needed.",
      }),
    );
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("downloaded by Sekhemet");
    expect(c.do).toBeUndefined();
  });
});

describe("doctor: the memory floor (rule 6c, MD-N16-3)", () => {
  it("warns under 24 GB that v1 does not support it, and passes at 24 GB", () => {
    const low = memoryFloorCheck(16 * GB);
    expect(low.status).toBe("warn");
    expect(low.detail).toMatch(/16 GB installed; v1 supports 24 GB of memory and above/);
    expect(low.do).toMatch(/24 GB or more/);
    const ok = memoryFloorCheck(24 * GB);
    expect(ok).toMatchObject({ status: "pass" });
    expect(ok.detail).toMatch(/24 GB installed/);
  });
});

describe("doctor: Ollama's roles (rule 6d, MD-N16-4)", () => {
  const readme = readFileSync(join(import.meta.dirname, "..", "..", "..", "README.md"), "utf8");

  it("names the roles an Ollama model serves, in the README's words for v1's engine", () => {
    expect(readme).toContain("served by llama.cpp's `llama-server`");
    const c = ollamaRolesCheck([
      { role: "worker", model: "qwen3:8b", engine: "ollama" },
      { role: "planner", model: "qwen3.8-27b-gsq-rco", engine: "llama.cpp" },
    ]);
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(
      /^Local models only in v1, served by llama\.cpp's `llama-server` \(README\); Ollama serves the Coding model \(qwen3:8b\), outside that statement$/,
    );
    expect(c.do).toMatch(/assign a GGUF model/);
  });

  it("passes when no role runs on Ollama", () => {
    const c = ollamaRolesCheck([{ role: "worker", model: "nail-mtp", engine: "llama.cpp" }]);
    expect(c).toMatchObject({ status: "pass" });
    expect(c.detail).toMatch(/no role runs on Ollama/);
  });
});

describe("doctor: each assigned role's verification (MD-N8-1)", () => {
  const deps: CombinationDeps = {
    digest: () => "sampled-sha256:abc",
    engineBuild: () => "b10809 (abc)",
    host: () => "host-a",
    contextVersion: (role) => `ctx-${role}`,
  };
  const mock = (n: string) => new MockInferenceAdapter(n, [], { exhaustion: "default" as const });

  it("names each role not verified for its combination, with its Verify step", () => {
    const reg = new ModelRegistry(join(tmp("doc-q-"), "models.json"));
    for (const role of ["worker", "reviewer"] as const)
      assignRole(reg, {
        role,
        model: role === "worker" ? "w" : "critic",
        scope: "personal",
        by: "person",
        host: "host-a",
        qualification: "qualified",
      });
    reg.recordCombinationQualification(
      "w",
      qualificationCombination(mock("w"), { ...deps, role: "worker" }),
      { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" },
    );
    const c = roleQualificationCheck(reg, { describe: mock, deps, host: "host-a" });
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/Coding model w: verified/);
    expect(c.detail).toMatch(/Review model critic: not verified \(missing\)/);
    expect(c.do).toBe(
      "Verify it on Configuration › Models, or run `sekhemet qualify --models critic --role reviewer`.",
    );
  });

  it("fails while the Coding model is not verified: no issue can run", () => {
    const reg = new ModelRegistry(join(tmp("doc-q2-"), "models.json"));
    const c = roleQualificationCheck(reg, {
      describe: mock,
      deps,
      host: "host-a",
      worker: "nail-mtp",
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/Coding model nail-mtp: not verified \(missing\)/);
  });
});

describe("doctor: the Team engines (MD-N15-3)", () => {
  it("passes when every engine answers and matches; fails naming a missing one with the step", () => {
    const ok = teamEnginesCheck({
      engines: [
        {
          service: "engine-coding",
          roles: ["coding"],
          modelId: "nail-mtp",
          port: 8098,
          state: "ok",
        },
      ],
      unfilled: [],
      footprint: { totalBytes: 1 },
      lines: [
        "Coding model (engine-coding, nail-mtp): answering on port 8098, matches its profile.",
      ],
    });
    expect(ok.status).toBe("pass");
    const bad = teamEnginesCheck({
      engines: [
        {
          service: "engine-planning",
          roles: ["planning"],
          modelId: "qwen3.8-27b-gsq-rco",
          port: 8099,
          state: "no-engine",
          reason: "no engine answers on port 8099",
        },
      ],
      unfilled: [],
      footprint: { totalBytes: 1 },
      lines: [
        "Planning model (engine-planning, qwen3.8-27b-gsq-rco): no engine answers on port 8099.",
      ],
    });
    expect(bad.status).toBe("fail");
    expect(bad.detail).toMatch(/no engine answers on port 8099/);
    expect(bad.do).toMatch(/docker compose/);
  });
});

describe("MD-N19-1: no engine is fetched on any path a person did not choose", () => {
  it("first run, doctor, run and the queue with no engine make no request for one", async () => {
    const root = tmp("no-engine-");
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(home);
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    // Every TCP connection the process opens is written down.
    const seen = join(root, "connections.log");
    const preload = join(root, "watch.mjs");
    writeFileSync(
      preload,
      `import net from "node:net";
import { appendFileSync } from "node:fs";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect passes its options normalized, as an array.
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof a === "object" && a ? (a.host ?? a.path ?? "") : String(args[1] ?? "");
  appendFileSync(${JSON.stringify(seen)}, host + "\\n");
  return connect.apply(this, args);
};
`,
    );
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
      SEKHEMET_USER_CONFIG: join(home, "config.toml"),
      SEKHEMET_MODELS_DIR: join(home, "models"),
      SEKHEMET_MODEL_LOADS: "off",
      BROWSER: "false",
    };
    // An open network: only the person's choice may fetch the engine.
    writeFileSync(env.SEKHEMET_USER_CONFIG, '[network]\nmode = "open"\n');
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, BIN, ...args], {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
        input: "",
        env,
      });
    // The first run checks the toolchain and stops for its confirmation.
    const first = run([]);
    expect(first.status).toBe(2);
    expect(`${first.stdout}${first.stderr}`).toMatch(
      /✗ llama-server \(llama\.cpp\): not found → Get the inference engine/,
    );
    const { db, log } = openLocalLedger(repo);
    await new CardStore(db, log).createCard({
      id: "c1",
      tier: "story",
      title: "One",
      status: "ready",
    });
    db.close();
    const doctor = run(["doctor"]);
    expect(doctor.stdout).toMatch(/Inference engine: llama-server not found\.\n\s+Do: /);
    run(["run", "c1"]);
    run(["run"]);
    const hosts = existsSync(seen) ? readFileSync(seen, "utf8").split("\n").filter(Boolean) : [];
    // The watcher sees doctor's own loopback probes, so it was watching.
    expect(hosts).toContain("127.0.0.1");
    expect(hosts.filter((h) => !/^(127\.0\.0\.1|localhost|::1|\/)/.test(h))).toEqual([]);
    expect(existsSync(join(home, ".sekhemet", "engines"))).toBe(false);
  }, 180_000);
});
