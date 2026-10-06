import { type ChildProcess, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { pageWriteHeaders } from "./page_headers.js";
import { g2Dirs } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * The runner's moves on the board reached the way the product makes them
 * (C2d, FINDINGS_C1 TST-01; kernel.md NEW-kernel-3 K-N3-1, K-N3-2;
 * NEW-kernel-5 K-N5-4): the built command `sekhemet queue` spawned over a
 * real repository and ledger, its Worker a scripted model at the HTTP
 * boundary, with real gate processes; then `sekhemet serve` spawned and a
 * person's Park or Request changes from the board, over HTTP. No model is
 * loaded.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await new Promise((r) => c.once("close", r));
    }
  }
});

/**
 * `sekhemet <args>` spawned with the scripted model preloaded, read until it
 * exits or prints its queue report: a run whose language server outlives the
 * report keeps its process up (a C2d finding of another group, not judged here).
 */
function sekhemet(args: string[], p: G2Project, extra: Record<string, string> = {}) {
  return new Promise<{ status: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, ["--import", p.preload, BIN, ...args], {
      cwd: p.repo,
      env: { ...p.env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    let reported = false;
    const read = (b: Buffer) => {
      out += String(b);
      if (!reported && /Report: \S+queue_report\.json/.test(out)) {
        reported = true;
        // Give the process a moment to finish on its own, then stop it.
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }, 2000);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, out });
    });
  });
}

/** `sekhemet serve --port 0` over the same repository; resolves with its address. */
function serve(p: G2Project): Promise<string> {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
    cwd: p.repo,
    env: { ...p.env, SEKHEMET_MODEL_LOADS: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`no address: ${out}`)), 60_000);
    const read = (d: Buffer) => {
      out += String(d);
      const m = /running at:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1] as string);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => bad(new Error(`serve exited ${code}: ${out}`)));
  });
}

function read<T>(p: G2Project, sql: string, ...args: string[]): T[] {
  const db = new DatabaseSync(join(p.repo, ".sekhemet", "events.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

describe("back-pressure holds the runner's card and a drained Review releases it (K-N3-1, K-N3-2)", () => {
  it("K-N3-1, K-N3-2: with Review at its limit, `queue` holds its passing card with card/held, the board lists it held; a person's Park drains Review and card/released clears the hold", async () => {
    const reviewIds = ["card_r1", "card_r2", "card_r3", "card_r4"];
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
        ...reviewIds.map((id) => ({ id, tier: "story" as const, title: `Waiting ${id}` })),
      ],
      // Review full: with no person's review yet, the limit is the 15-minute prior's 4.
      seed: async (store) => {
        for (const id of reviewIds)
          await store.updateCardStatus(id, "review", "set up as reviewed work", "harness", {
            override: true,
          });
      },
    });
    const ran = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, {
        worker: [
          [
            {
              name: "write_file",
              arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
            },
          ],
          [{ name: "finish_card" }],
        ],
      }),
    });
    // K-N3-1: held with a typed hold naming the awaited status, on the ledger.
    const [held] = read<{ status: string; hold: string | null; blocked_reason: string | null }>(
      p,
      "SELECT status, hold, blocked_reason FROM cards WHERE id = 'c1'",
    );
    expect(held?.status, ran.out).toBe("in_progress");
    expect(JSON.parse(held?.hold ?? "null")).toMatchObject({
      kind: "backpressure",
      awaiting: "verify",
    });
    const heldEvents = read<{ payload: string }>(
      p,
      "SELECT payload FROM events WHERE card_id = 'c1' AND type = 'card/held'",
    );
    expect(heldEvents).toHaveLength(1);
    expect(JSON.parse(heldEvents[0]?.payload ?? "{}")).toMatchObject({ awaiting: "verify" });
    expect(String(JSON.parse(heldEvents[0]?.payload ?? "{}").reason)).toMatch(/Review/);
    // The board, over HTTP, lists it as held from the typed hold.
    const base = await serve(p);
    const board = (await (await fetch(`${base}/api/board`)).json()) as {
      cards: { id: string; hold?: { kind: string; awaiting: string } }[];
    };
    expect(board.cards.find((c) => c.id === "c1")?.hold).toMatchObject({
      kind: "backpressure",
      awaiting: "verify",
    });
    // K-N3-2: a person parks one reviewed card; Review drains and the held card moves on.
    const parked = await fetch(`${base}/api/cards/card_r1/park`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ reason: "waiting on the payroll rules" }),
    });
    expect(parked.status).toBe(200);
    const [after] = read<{ status: string; hold: string | null }>(
      p,
      "SELECT status, hold FROM cards WHERE id = 'c1'",
    );
    expect(after?.status).toBe("verify");
    expect(after?.hold ?? null).toBeNull();
    expect(
      read(p, "SELECT seq FROM events WHERE card_id = 'c1' AND type = 'card/released'"),
    ).toHaveLength(1);
  }, 240_000);
});

describe("a revision that breaks a gate its Review snapshot passed goes back to Planning (K-N5-4)", () => {
  it("K-N5-4: sent back from the board, the next `queue` run's failing gate moves the card to Planning with a reason naming the gate and the evidence it passed in", async () => {
    const p = await g2Project(g2Dirs(), {
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Write a",
          status: "ready",
          scopeFiles: ["src/a.ts"],
          stepBudget: 3,
          spec: "Export a constant named a from src/a.ts",
          acceptanceCriteria: ["src/a.ts exports a"],
        },
      ],
      // The unit gate fails when src/a.ts says BROKEN.
      gateArgs: [
        "-e",
        "process.exit(require('fs').readFileSync('src/a.ts','utf8').includes('BROKEN') ? 1 : 0)",
      ],
    });
    const turn = (content: string) => [
      [{ name: "write_file", arguments: { path: "src/a.ts", content } }],
      [{ name: "finish_card" }],
    ];
    const first = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, { worker: turn("export const a = 1;\n") }),
    });
    const [passed] = read<{ status: string }>(p, "SELECT status FROM cards WHERE id = 'c1'");
    expect(passed?.status, first.out).toBe("review");
    // A person requests changes from the board.
    const base = await serve(p);
    const returned = await fetch(`${base}/api/cards/c1/return`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ reason: "rename a to total" }),
    });
    expect(returned.status).toBe(200);
    // Stop the server (a queue run that already exited has nothing to stop).
    for (const c of children.splice(0)) {
      if (c.exitCode !== null || c.signalCode !== null) continue;
      c.kill("SIGKILL");
      await new Promise((r) => c.once("close", r));
    }
    // The revision breaks the gate the Review snapshot passed.
    const second = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, { worker: turn("export const a = 'BROKEN';\n") }),
    });
    const [after] = read<{ status: string; blocked_reason: string | null }>(
      p,
      "SELECT status, blocked_reason FROM cards WHERE id = 'c1'",
    );
    expect(after?.status, second.out).toBe("planning");
    const into = read<{ payload: string }>(
      p,
      "SELECT payload FROM events WHERE card_id = 'c1' AND type = 'card/status_changed' ORDER BY seq",
    )
      .map((e) => JSON.parse(e.payload) as { toStatus?: string; reason?: string })
      .filter((e) => e.toStatus === "planning")
      .at(-1);
    expect(into?.reason).toMatch(
      /^regression: unit passed at Review \(ev_[0-9a-f]+\) and fails now/,
    );
    // The evidence it names is the first attempt's passing bundle.
    const id = /\((ev_[0-9a-f]+)\)/.exec(into?.reason ?? "")?.[1] as string;
    const bundle = read<{ payload: string }>(
      p,
      "SELECT payload FROM events WHERE type = 'evidence/recorded' AND payload LIKE ?",
      `%${id}%`,
    );
    expect(bundle.length).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
