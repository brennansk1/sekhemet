import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { pageWriteHeaders } from "./page_headers.js";
import { installZod } from "./research_notes_fixture.js";
import { cli, g2Dirs, g2Env, ledgerRows } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project, gatesToml } from "./support/g2_project.js";

/**
 * The ledger's rules over a run, reached the way a person and the product
 * reach them (C2d, FINDINGS_C1 TST-01; kernel.md rules 19, 27, 32, 33):
 * the built command (`apps/harness/dist/index.js`) spawned over a real
 * repository and SQLite ledger — `queue` with its Worker a scripted model at
 * the HTTP boundary (`g2_model.ts`: no model is loaded, nothing leaves the
 * machine), real gate processes, then `rewind`, `erase`, `prompt-screen`,
 * `export`, `log` and `plan`, and `serve` asked over
 * HTTP as the board asks it.
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
 * exits or prints its queue report (a run's language server may outlive the
 * report; another group's C2d finding, not judged here).
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

/** `sekhemet serve --port 0` over the repository; resolves with its address. */
function serve(p: G2Project): Promise<{ base: string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
    cwd: p.repo,
    env: { ...p.env, SEKHEMET_MODEL_LOADS: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await new Promise((r) => child.once("close", r));
  };
  let out = "";
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`no address: ${out}`)), 60_000);
    const read = (d: Buffer) => {
      out += String(d);
      const m = /running at:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok({ base: m[1] as string, stop });
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => bad(new Error(`serve exited ${code}: ${out}`)));
  });
}

async function post(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

function read<T>(p: G2Project, sql: string, ...args: string[]): T[] {
  const db = new DatabaseSync(join(p.repo, ".sekhemet", "events.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

/** A command that loads no model, as a person runs it. */
async function plain(
  p: G2Project,
  args: string[],
): Promise<{ status: number | null; out: string }> {
  const r = await cli(args, {
    cwd: p.repo,
    env: { ...p.env, SEKHEMET_MODEL_LOADS: "off" },
    timeoutMs: 120_000,
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

const writeTurns = (content: string) => [
  [{ name: "write_file", arguments: { path: "src/a.ts", content } }],
  [{ name: "finish_card" }],
];

const oneCard = (spec = "Export a constant named a from src/a.ts") => ({
  id: "c1",
  tier: "story" as const,
  title: "Write a",
  status: "ready" as const,
  scopeFiles: ["src/a.ts"],
  stepBudget: 4,
  spec,
  acceptanceCriteria: ["src/a.ts exports a"],
});

const cardStatus = (p: G2Project) =>
  read<{ status: string }>(p, "SELECT status FROM cards WHERE id = 'c1'")[0]?.status;

describe("evidence from before a rewind does not admit a card to Review (K-S7-8)", () => {
  it("K-S7-8: a card `queue` brought to Review, rewound with `rewind`, enters Review again only once evidence recorded after the rewind passes; until then the board's move must override 'no evidence'", async () => {
    const p = await g2Project(g2Dirs(), { cards: [oneCard()] });
    const first = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, { worker: writeTurns("export const a = 1;\n") }),
    });
    expect(cardStatus(p), first.out).toBe("review");
    const passedBefore = read<{ seq: number }>(
      p,
      "SELECT seq FROM events WHERE card_id = 'c1' AND type = 'evidence/recorded'",
    );
    expect(passedBefore.length).toBeGreaterThan(0);
    // The person rewinds the card to its first step.
    const rewound = await plain(p, ["rewind", "c1", "1"]);
    expect(rewound.status, rewound.out).toBe(0);
    expect(cardStatus(p)).toBe("ready");
    const [rewind] = read<{ seq: number }>(
      p,
      "SELECT seq FROM events WHERE card_id = 'c1' AND type = 'card/rewound'",
    );
    expect(rewind?.seq).toBeGreaterThan(passedBefore.at(-1)?.seq ?? 0);
    // On the board, the earlier passing evidence no longer counts for Review.
    const server = await serve(p);
    const forced = await post(server.base, "/api/cards/c1/override", {
      toStatus: "review",
      reason: "it passed before the rewind",
    });
    expect(forced.status).toBe(200);
    const overrode = read<{ payload: string }>(
      p,
      "SELECT payload FROM events WHERE card_id = 'c1' AND type = 'card/override' ORDER BY seq",
    ).map((r) => (JSON.parse(r.payload) as { overrode: string }).overrode);
    expect(overrode).toContain("entry condition: c1 has no evidence bundle; Review needs one");
    // Sent back, the next run records new evidence after the rewind, and the card enters Review by right.
    expect(
      (await post(server.base, "/api/cards/c1/return", { reason: "run it again" })).status,
    ).toBe(200);
    await server.stop();
    const overridesBefore = overrode.length;
    const second = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, { worker: writeTurns("export const a = 2;\n") }),
    });
    expect(cardStatus(p), second.out).toBe("review");
    const after = read<{ seq: number }>(
      p,
      "SELECT seq FROM events WHERE card_id = 'c1' AND type = 'evidence/recorded' AND seq > ?",
      String(rewind?.seq),
    );
    expect(after.length).toBeGreaterThan(0);
    expect(
      read(p, "SELECT seq FROM events WHERE card_id = 'c1' AND type = 'card/override'"),
    ).toHaveLength(overridesBefore);
  }, 360_000);
});

describe("a replay of an erased context pack names the gap (K-N7-6)", () => {
  it("K-N7-6: after `erase` removes the context packs holding a secret, `prompt-screen --from` names each as erased by its ledger/erased seq, never as missing", async () => {
    const SECRET = "payroll-signing-key-7Q4Z9X2M8K";
    // The secret is in a file the Worker reads, so its context packs hold it
    // (not in the card's spec, a structural payload the chain covers).
    const p = await g2Project(g2Dirs(), {
      files: { "src/a.ts": `// payroll key: ${SECRET}\n` },
      cards: [oneCard()],
    });
    const ran = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, { worker: writeTurns("export const a = 1;\n") }),
    });
    expect(cardStatus(p), ran.out).toBe("review");
    const packs = read<{ id: string }>(
      p,
      "SELECT context_pack_id AS id FROM steps WHERE card_id = 'c1' AND context_pack_id IS NOT NULL",
    );
    expect(packs.length).toBeGreaterThan(0);
    const secretFile = join(p.home, "secret.txt");
    writeFileSync(secretFile, SECRET);
    const erased = await plain(p, ["erase", "--secret-file", secretFile, "--rotated"]);
    expect(erased.status, erased.out).toBe(0);
    const m = /and (\d+) blobs? \(ledger\/erased seq (\d+)\)/.exec(erased.out);
    expect(m, erased.out).not.toBeNull();
    const [, blobs, seq] = m as RegExpExecArray;
    expect(Number(blobs)).toBeGreaterThan(0);
    // The steps whose context pack the erasure deleted (the blob store's own layout).
    const gone = packs.filter(
      (k) => !existsSync(join(p.repo, ".sekhemet", "blobs", k.id.slice(0, 2), `${k.id}.json`)),
    );
    expect(gone.length).toBeGreaterThan(0);
    const screen = await cli(["prompt-screen", "--from", p.repo, "--worker", SCRIPTED_MODEL], {
      cwd: p.repo,
      env: { ...p.env, ...scriptEnv(p.record, {}) },
      preload: p.preload,
      timeoutMs: 120_000,
    });
    const out = screen.stdout + screen.stderr;
    expect(out).toContain(
      `skipped ${gone.length}: context pack erased by ledger/erased seq ${seq}`,
    );
    expect(out).not.toMatch(/context pack missing/);
  }, 240_000);
});

describe("on_behalf_of reproduced from the ledger (K-N10-3)", () => {
  it("K-N10-3: a delegated card's run records on_behalf_of on the Worker's events only; `log` rebuilds the projections byte-identical and `export --ledger` carries every on_behalf_of exactly", async () => {
    const p = await g2Project(g2Dirs(), {
      cards: [oneCard()],
      // A person hands the card to the Worker (the board's Run in the Team setup does this).
      seed: async (store) => {
        await store.delegateCard("c1", { kind: "worker" }, store.localPrincipal());
      },
    });
    // The Worker asks a question on the way (its `ask` tool): an event it writes itself.
    const ran = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, {
        worker: [
          [
            {
              name: "ask",
              arguments: { question: "Should a be a number or a string?", assumption: "a number" },
            },
          ],
          ...writeTurns("export const a = 1;\n"),
        ],
      }),
    });
    expect(cardStatus(p), ran.out).toBe("review");
    const rows = read<{ seq: number; actor: string; on_behalf_of: string | null }>(
      p,
      "SELECT seq, actor, on_behalf_of FROM events ORDER BY seq",
    );
    const carried = rows.filter((r) => r.on_behalf_of !== null);
    expect(carried.length).toBeGreaterThan(0);
    // Only the Worker's events carry it, each naming the person who delegated.
    expect(new Set(carried.map((r) => r.actor))).toEqual(new Set(["worker"]));
    const [delegator] = read<{ principal: string }>(
      p,
      "SELECT principal FROM events WHERE card_id = 'c1' AND type = 'card/delegated'",
    );
    expect(delegator?.principal).toBeTruthy();
    expect(new Set(carried.map((r) => r.on_behalf_of))).toEqual(new Set([delegator?.principal]));
    const log = await plain(p, ["log"]);
    expect(log.status, log.out).toBe(0);
    expect(log.out).toMatch(/Projections: rebuilt from \d+ events, byte-identical\./);
    const file = join(p.home, "ledger.ndjson");
    const exported = await plain(p, ["export", "--ledger", "--out", file]);
    expect(exported.status, exported.out).toBe(0);
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { seq: number; onbehalfof?: string });
    expect(lines.map((l) => [l.seq, l.onbehalfof ?? null])).toEqual(
      rows.map((r) => [r.seq, r.on_behalf_of]),
    );
  }, 240_000);
});

describe("a gate result names its source (K-N8-3)", () => {
  it("K-N8-3: every gate result `queue` records from its own checks is source local with no external reference, and `log` rebuilds them byte-identical", async () => {
    const p = await g2Project(g2Dirs(), { cards: [oneCard()] });
    const ran = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, { worker: writeTurns("export const a = 1;\n") }),
    });
    expect(cardStatus(p), ran.out).toBe("review");
    const results = read<{ payload: string }>(
      p,
      "SELECT payload FROM events WHERE card_id = 'c1' AND type = 'gate/result' ORDER BY seq",
    ).map((r) => JSON.parse(r.payload) as { gate: string; source?: string; externalRef?: unknown });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source, r.gate).toBe("local");
      expect(r.externalRef, r.gate).toBeUndefined();
    }
    expect(results.map((r) => r.gate)).toContain("unit");
    const log = await plain(p, ["log"]);
    expect(log.out).toMatch(/Projections: rebuilt from \d+ events, byte-identical\./);
  }, 240_000);
});

describe("a default_deny question parks its card from the request (K-N5-2)", () => {
  it("K-N5-2: `plan` that asks a default_deny question parks the card the question is on as it is asked, not at its deadline", async () => {
    const where = g2Dirs();
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], { cwd: where.cwd });
    git("init", "-q", "-b", "main");
    mkdirSync(join(where.cwd, "src"), { recursive: true });
    git("commit", "-q", "--allow-empty", "-m", "seed");
    const spec =
      "A notes app that syncs to the cloud or to a local folder. Persist the notes in a backend. Maybe expose a public API. Admin roles can manage users. Make the sharing sensible.";
    const r = await cli(["plan", spec, "--planner", "none", "--offline"], {
      cwd: where.cwd,
      env: g2Env(where.home),
      timeoutMs: 180_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rows = ledgerRows(where.cwd);
    const asked = rows.filter((e) => e.type === "decision/requested");
    const deny = asked.find((e) => {
      const ctx = JSON.parse(String({ ...e.payload, ...(e.private ?? {}) }.context ?? "{}")) as {
        planner?: { policy?: string };
      };
      return ctx.planner?.policy === "default_deny";
    });
    expect(deny, JSON.stringify(asked.map((a) => a.payload))).toBeDefined();
    const cardId = deny?.cardId ?? (deny?.payload.cardId as string | undefined);
    expect(cardId).toBeTruthy();
    const mine = rows.filter((e) => e.cardId === cardId);
    const parkedAt = mine.find(
      (e) => e.type === "card/status_changed" && e.payload.toStatus === "parked",
    );
    // Parked by the request, recorded with it, before any deadline could pass.
    expect(parkedAt, JSON.stringify(mine.map((e) => e.type))).toBeDefined();
    expect(parkedAt?.seq).toBeGreaterThan(deny?.seq ?? Number.POSITIVE_INFINITY);
    expect(
      rows.some((e) => e.type === "decision/timed_out" || e.type === "decision/default_applied"),
    ).toBe(false);
  }, 240_000);
});

describe("a research card's note moves it through the board (K-S4-4)", () => {
  it("K-S4-4: with Review at its limit, `queue`'s research card writes its cited note but is held out of Verify by back-pressure, as any card is; with room, the same note takes it through Verify into Review", async () => {
    const card = {
      id: "r1",
      tier: "story" as const,
      title: "Which zod API validates an email?",
      spec: "Find the zod API that validates an email address.",
      acceptanceCriteria: ["names one API"],
      labels: ["research", "effort:quick"],
      status: "ready" as const,
    };
    const reviewIds = ["card_r1", "card_r2", "card_r3", "card_r4"];
    const project = async (full: boolean) => {
      const p = await g2Project(g2Dirs(), {
        files: {
          "src/a.ts": "",
          "package.json": JSON.stringify({ name: "app" }),
          ".gitignore": "node_modules\n.sekhemet/*\n!.sekhemet/gates.toml\n",
          ".sekhemet/gates.toml": gatesToml(["-e", "process.exit(0)"]),
        },
        cards: [
          card,
          ...(full
            ? reviewIds.map((id) => ({ id, tier: "story" as const, title: `Waiting ${id}` }))
            : []),
        ],
        qualifyAs: [{}, { role: "researcher" }],
        // Review full: with no person's review yet, the limit is the 15-minute prior's 4.
        seed: async (store) => {
          if (!full) return;
          for (const id of reviewIds)
            await store.updateCardStatus(id, "review", "set up as reviewed work", "harness", {
              override: true,
            });
        },
      });
      installZod(p.repo);
      writeFileSync(
        join(p.repo, "node_modules/zod/lib/index.js"),
        "exports.z = { string: () => ({ email: () => ({ parse: (s) => { if (!/@/.test(s)) throw new Error('Invalid email'); return s; } }) }) };\n",
      );
      return p;
    };
    const research = (p: G2Project) =>
      cli(["queue", "--worker", SCRIPTED_MODEL, "--researcher", SCRIPTED_MODEL], {
        cwd: p.repo,
        preload: p.preload,
        env: {
          ...p.env,
          ...scriptEnv(p.record, {
            researcher: [
              [{ name: "git_history", arguments: { query: "seed" } }],
              "Use `zod` z.string().email(), which returns a ZodString that rejects strings without an at sign [1]. The history shows the seed commit only [1].",
            ],
          }),
        },
        timeoutMs: 180_000,
      });
    const moves = (p: G2Project) =>
      ledgerRows(p.repo)
        .filter((x) => x.type === "card/status_changed" && x.cardId === "r1")
        .map((x) => x.payload.toStatus);
    // With room in Review: the note's verdict moves the card through the board.
    const open = await project(false);
    const ran = await research(open);
    expect(ran.stdout, ran.stderr).toMatch(/cited note ready for review/);
    expect(moves(open)).toEqual(["in_progress", "verify", "review"]);
    // Review at its limit: the same note, but the board's back-pressure holds the card.
    const full = await project(true);
    const held = await research(full);
    expect(
      existsSync(join(full.repo, ".sekhemet", "research", "r1.md")),
      held.stdout + held.stderr,
    ).toBe(true);
    expect(moves(full)).not.toContain("review");
    expect(moves(full)).not.toContain("verify");
    const [r1] = ledgerRows(full.repo).filter((x) => x.type === "card/held" && x.cardId === "r1");
    const status = new DatabaseSync(join(full.repo, ".sekhemet", "events.db"), { readOnly: true });
    try {
      const row = status.prepare("SELECT status, hold FROM cards WHERE id = 'r1'").get() as {
        status: string;
        hold: string | null;
      };
      expect(row.status, held.stdout + held.stderr).toBe("in_progress");
      expect(r1 ?? JSON.parse(row.hold ?? "null"), held.stdout + held.stderr).toBeTruthy();
    } finally {
      status.close();
    }
  }, 360_000);
});
