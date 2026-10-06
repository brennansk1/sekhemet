import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { g2Dirs } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, type Turn, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * The residency scheduler as the queue meets it (C2d, FINDINGS_C1 TST-01;
 * models.md rule 20a, NEW-models-9): the built command `sekhemet queue`
 * spawned over a real repository and ledger with its roles' models named on
 * the command line, each answered by the scripted model at the HTTP
 * boundary (`g2_model.ts`: nothing is loaded, nothing leaves the machine).
 * Ollama's list of models and their sizes, and the installed memory, are
 * given at the host's boundary by `support/g5_host.mjs`; a calibrated host
 * (usable memory, tier) is the machine profile `support/g5_models.mjs` writes.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const HOST = resolve(import.meta.dirname, "support/g5_host.mjs");
const SETUP = resolve(import.meta.dirname, "support/g5_models.mjs");
const RESEARCH = "other-research:latest";
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await new Promise((r) => c.once("close", r));
    }
  }
});

/** `sekhemet queue <args>` to its report, the scripted model and the host preloaded. */
function queue(p: G2Project, args: string[], extra: Record<string, string>): Promise<string> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      ["--import", p.preload, "--import", HOST, BIN, "queue", "--worker", SCRIPTED_MODEL, ...args],
      { cwd: p.repo, env: { ...p.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let out = "";
    let reported = false;
    const read = (b: Buffer) => {
      out += String(b);
      if (!reported && /Report: \S+queue_report\.json/.test(out)) {
        reported = true;
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }, 2000);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done(`${out}\n[exited ${code ?? signal}]`);
    });
  });
}

/** What a person's earlier work left on this host, written with the binary's modules. */
function setUp(p: G2Project, steps: unknown[], env: Record<string, string> = {}): void {
  execFileSync(process.execPath, ["--import", HOST, SETUP, JSON.stringify(steps)], {
    env: { ...p.env, ...env },
    encoding: "utf8",
  });
}

interface Request {
  role: string;
  body: { model: string; options?: { num_ctx?: number } };
}
const requests = (p: G2Project): Request[] =>
  existsSync(p.record)
    ? readFileSync(p.record, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Request)
    : [];

function statuses(p: G2Project): Record<string, string> {
  const db = new DatabaseSync(join(p.repo, ".sekhemet", "events.db"), { readOnly: true });
  try {
    return Object.fromEntries(
      (db.prepare("SELECT id, status FROM cards").all() as { id: string; status: string }[]).map(
        (c) => [c.id, c.status],
      ),
    );
  } finally {
    db.close();
  }
}

const coding = {
  id: "c1",
  tier: "story" as const,
  title: "Write a",
  status: "ready" as const,
  scopeFiles: ["src/a.ts"],
  stepBudget: 5,
  spec: "Export a constant named a from src/a.ts",
  acceptanceCriteria: ["src/a.ts exports a"],
  priority: 2,
};
const research = {
  id: "r1",
  tier: "task" as const,
  title: "Which CSV library parses quoted fields?",
  status: "ready" as const,
  labels: ["research"],
  spec: "Compare two CSV parsers for the timesheet import.",
  acceptanceCriteria: ["names one library"],
  priority: 1,
};
const writeAndFinish: Turn[] = [
  [{ name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } }],
  [{ name: "finish_card" }],
];

describe("two roles on one model's weights (MD-N9-1)", () => {
  it("MD-N9-1: the Coding and Planning roles on the same weights get one adapter at the larger window, and Seshat's answer mid-card loads nothing", async () => {
    const turns: Turn[] = [
      [{ name: "ask", arguments: { question: "Should a be a number or a string?" } }],
      ...writeAndFinish,
    ];
    // The Coding model alone: its own window.
    const alone = await g2Project(g2Dirs(), { cards: [coding] });
    const first = await queue(
      alone,
      [],
      scriptEnv(alone.record, { worker: turns, other: "A number." }),
    );
    expect(first, first).toMatch(/residency: scripted-worker:latest resident for worker\n/);
    const own = new Set(requests(alone).map((r) => r.body.options?.num_ctx));
    expect(own.size).toBe(1);
    const workerWindow = [...own][0] as number;
    // The same weights as the Planning model too (the manager, Seshat and escalation queues).
    const shared = await g2Project(g2Dirs(), {
      cards: [coding],
      qualifyAs: [{}, { role: "planner" }],
    });
    const out = await queue(
      shared,
      ["--manager", SCRIPTED_MODEL],
      scriptEnv(shared.record, { worker: turns, other: "A number." }),
    );
    expect(out).toContain(
      "residency: scripted-worker:latest resident for worker, manager, seshat, escalation",
    );
    // One adapter: one footprint on the residency line, at the larger window.
    expect(out).toMatch(/Residency: \d+ GB usable; scripted-worker:latest [\d.]+ GB\.\n/);
    const sent = requests(shared);
    expect(sent.map((r) => r.role)).toEqual(["worker", "other", "worker", "worker"]);
    const windows = new Set(sent.map((r) => r.body.options?.num_ctx));
    expect(windows.size).toBe(1);
    expect([...windows][0]).toBeGreaterThan(workerWindow);
    // Seshat answered between the Worker's steps without a reload.
    expect(out).toMatch(/0 model swaps/);
    expect(statuses(shared).c1).toBe("review");
  }, 300_000);
});

describe("every model fits the host (MD-N9-5)", () => {
  it("MD-N9-5: on a calibrated host where both fit, the Coding and Research models stay resident together and both cards' work drains with no swap", async () => {
    const p = await g2Project(g2Dirs(), { cards: [coding, research] });
    // A 128 GB host calibrated at 96 GB usable (tier XL: roles co-load); the
    // qualifications are recorded on that host.
    const host = { G5_TOTALMEM_GB: "128" };
    setUp(
      p,
      [
        { profile: "unrelated-model", prefill: 500, decode: 50, usableGb: 96, tier: "XL" },
        { qualify: SCRIPTED_MODEL },
        { qualify: RESEARCH, role: "researcher", as: "researcher", family: "llama" },
      ],
      host,
    );
    const out = await queue(p, ["--researcher", RESEARCH], {
      ...scriptEnv(p.record, { worker: writeAndFinish }),
      ...host,
      G5_TAGS: JSON.stringify({ [SCRIPTED_MODEL]: 1e9, [RESEARCH]: 2e9 }),
    });
    expect(out).toMatch(
      /Residency: 96 GB usable; scripted-worker:latest [\d.]+ GB, other-research:latest [\d.]+ GB\./,
    );
    expect(out).toContain("residency: scripted-worker:latest resident for worker");
    expect(out).toContain("residency: other-research:latest resident for researcher");
    expect(out).not.toMatch(/swap scripted-worker:latest -> other-research:latest/);
    expect(out).toMatch(/0 model swaps/);
    const sent = requests(p);
    expect(sent.filter((r) => r.role === "worker").length).toBe(2);
    expect(sent.filter((r) => r.body.model === RESEARCH).length).toBeGreaterThan(0);
    // Both queues drained: the Coding card in Review, the research card's note written.
    expect(statuses(p).c1).toBe("review");
    expect(out).toMatch(/research\/r1\.md/);
  }, 300_000);
});
