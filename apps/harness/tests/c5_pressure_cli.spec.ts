import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { g2Dirs } from "./support/g2_cli.js";
import { type Recorded, SCRIPTED_MODEL, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";
import { guardedImports } from "./support/hygiene.js";

/**
 * The memory watchdog's `high` stage masks older observations at the next
 * step (models MD-N2-4, MD-N2-5; C2d finding routed to C5): `sekhemet run`
 * spawned as the built binary (`apps/harness/dist/index.js`) over a real
 * repository and ledger, its Worker the scripted model at the HTTP boundary
 * (`g2_model.ts`), and the host's swap injected at its boundary
 * (`support/g5_host.mjs`). No model is loaded.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const HOST = resolve(import.meta.dirname, "support/g5_host.mjs");
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await new Promise((r) => c.once("close", r));
    }
  }
});

function start(args: string[], p: G2Project, extra: Record<string, string>) {
  const child = spawn(
    process.execPath,
    [...guardedImports(p.preload), "--import", HOST, BIN, ...args],
    {
      cwd: p.repo,
      env: { ...p.env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  let out = "";
  child.stdout.on("data", (b) => {
    out += String(b);
  });
  child.stderr.on("data", (b) => {
    out += String(b);
  });
  const closed = new Promise<number | null>((r) => child.once("close", (code) => r(code)));
  return { child, out: () => out, closed };
}

async function until(test: () => boolean, what: () => string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const workerBodies = (p: G2Project): Recorded["body"][] =>
  existsSync(p.record)
    ? readFileSync(p.record, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Recorded)
        .filter((r) => r.role === "worker")
        .map((r) => r.body)
    : [];

const MARKER = "NOTES_MARKER_LINE";
const NOTES = Array.from(
  { length: 12 },
  (_, i) => `// ${MARKER} ${i}: a note the Worker read`,
).join("\n");

describe("the watchdog's high stage masks older observations at the next step (MD-N2-4, MD-N2-5)", () => {
  it("MD-N2-4: at `high` (swap grew over 1 GB) the next step's prompt shows every earlier observation as a pointer, once, and the run says so", async () => {
    const p = await g2Project(g2Dirs(), {
      files: { "src/a.ts": "", "docs/notes.md": `${NOTES}\n` },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Write a",
          status: "ready",
          scopeFiles: ["src/a.ts"],
          stepBudget: 5,
          spec: "Export a constant named a from src/a.ts",
        },
      ],
    });
    const pressure = join(p.home, "pressure.json");
    const hold = join(p.home, "release-step-1");
    writeFileSync(pressure, JSON.stringify({ kernel: 1, swapMb: 100 }));
    const run = start(["run", "c1", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, {
        worker: [
          [{ name: "read_file", arguments: { path: "docs/notes.md" } }],
          [{ name: "read_file", arguments: { path: "src/a.ts" } }],
          [
            {
              name: "write_file",
              arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
            },
            { name: "finish_card" },
          ],
        ],
      }),
      G5_PRESSURE: pressure,
      G5_HOLD_FILE: hold,
    });
    // Step 1 is answered and held: the card is mid-run.
    await until(() => workerBodies(p).length === 1, run.out);
    // Swap grows by 1.2 GB: the watchdog's high stage.
    writeFileSync(pressure, JSON.stringify({ kernel: 1, swapMb: 1300 }));
    await until(() => /memory watchdog: normal -> high/.test(run.out()), run.out, 20_000);
    writeFileSync(hold, "");
    await until(() => workerBodies(p).length >= 3, run.out, 60_000);
    const [, second, third] = workerBodies(p);
    const text = (b: Recorded["body"] | undefined) =>
      (b?.messages ?? []).map((m) => m.content).join("\n");
    // Step 2's prompt carries step 1's observation as a pointer, not its text.
    expect(text(second)).not.toContain(MARKER);
    expect(text(second)).toMatch(/\[Observation #1: [^\]]*omitted/);
    expect(run.out()).toMatch(/memory watchdog: older observations masked at this step/);
    // Once per request: step 3 is masked by the usual rule only, which keeps
    // the last two turns, so step 1's text is back in view.
    expect(text(third)).toContain(MARKER);
    await Promise.race([run.closed, new Promise((r) => setTimeout(r, 20_000))]);
  }, 180_000);
});
