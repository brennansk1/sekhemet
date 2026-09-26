import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceRequest, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCard } from "../src/execute.js";
import { initLocalKernel, main } from "../src/index.js";
import {
  acquireSlotLease,
  liveSlotLeases,
  qualifiedSlotCapacity,
  scopesOverlap,
  slotLeasePath,
  slotWaitReason,
} from "../src/slot_lease.js";
import { SlotPool } from "../src/slot_pool.js";

/**
 * RUN-35 (runtime.md item 3, NEW-runtime-6): the qualified capacity N gives
 * N slot leases; each running card holds its own, with its own worktree and
 * sandbox; two running cards never write the same file. Real lease files,
 * real processes, real SQLite and real git worktrees; the model is a fake.
 */
const DIST = resolve(import.meta.dirname, "../dist/slot_lease.js");
const RUNNER_DIST = resolve(import.meta.dirname, "../dist/runner_lease.js");
const dirs: string[] = [];
const children: ChildProcess[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "slots-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      // gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A process that claims a slot for one card once `go` exists, reports, and holds it. */
function contender(
  dir: string,
  go: string,
  out: string,
  card: { id: string; scope: string[] },
  capacity: number,
): ChildProcess {
  const script = join(dir, `c-${children.length}.mjs`);
  writeFileSync(
    script,
    `import { existsSync, writeFileSync } from "node:fs";
     import { acquireSlotLease } from ${JSON.stringify(DIST)};
     while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 2));
     const got = acquireSlotLease(${JSON.stringify(dir)}, {
       capacity: ${capacity}, cardId: ${JSON.stringify(card.id)}, scopeFiles: ${JSON.stringify(card.scope)},
     });
     writeFileSync(${JSON.stringify(out)}, got.granted ? "granted " + got.slot : got.reason + " " + got.message);
     setTimeout(() => process.exit(0), 4000);`,
  );
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  children.push(child);
  return child;
}

describe("RUN-35: slot leases, one per running card", () => {
  it("of processes racing for N=2 slots with disjoint scopes, exactly two run, each in its own slot", async () => {
    const dir = tmp();
    const go = join(dir, "go");
    const outs = [0, 1, 2, 3, 4].map((i) => join(dir, `out-${i}`));
    outs.forEach((out, i) =>
      contender(dir, go, out, { id: `card_${i}`, scope: [`src/f${i}.ts`] }, 2),
    );
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(go, "");
    await waitFor(() => outs.every((o) => existsSync(o)));
    const verdicts = outs.map((o) => readFileSync(o, "utf8"));
    const granted = verdicts.filter((v) => v.startsWith("granted"));
    expect(granted.sort()).toEqual(["granted 0", "granted 1"]);
    expect(verdicts.filter((v) => v.startsWith("full"))).toHaveLength(3);
    expect(verdicts.find((v) => v.startsWith("full"))).toMatch(/all 2 slots are running/);
    expect(liveSlotLeases(dir).map((l) => l.slot)).toEqual([0, 1]);
  });

  it("of processes racing with overlapping scopes and room to spare, exactly one runs; the other waits, naming the card and the file", async () => {
    const dir = tmp();
    const go = join(dir, "go");
    const outs = [0, 1, 2, 3].map((i) => join(dir, `out-${i}`));
    outs.forEach((out, i) =>
      contender(dir, go, out, { id: `card_${i}`, scope: ["src/shared.ts", `src/own${i}.ts`] }, 4),
    );
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(go, "");
    await waitFor(() => outs.every((o) => existsSync(o)));
    const verdicts = outs.map((o) => readFileSync(o, "utf8"));
    expect(verdicts.filter((v) => v.startsWith("granted"))).toHaveLength(1);
    const waiting = verdicts.filter((v) => v.startsWith("overlap"));
    expect(waiting).toHaveLength(3);
    const holder = liveSlotLeases(dir)[0];
    expect(waiting[0]).toContain(`waits for ${holder?.cardId}`);
    expect(waiting[0]).toContain("src/shared.ts");
  });

  it("a slot whose holder was killed with SIGKILL is taken over; a recycled pid's slot is stale", async () => {
    const dir = tmp();
    const go = join(dir, "go");
    writeFileSync(go, "");
    const out = join(dir, "out");
    const holder = contender(dir, go, out, { id: "card_dead", scope: ["src/a.ts"] }, 1);
    await waitFor(() => existsSync(out));
    expect(readFileSync(out, "utf8")).toBe("granted 0");
    const refused = acquireSlotLease(dir, {
      capacity: 1,
      cardId: "card_next",
      scopeFiles: ["src/b.ts"],
    });
    expect(refused.granted).toBe(false);
    holder.kill("SIGKILL");
    await waitFor(() => holder.exitCode !== null || holder.signalCode !== null);
    expect(liveSlotLeases(dir)).toEqual([]);
    const taken = acquireSlotLease(dir, {
      capacity: 1,
      cardId: "card_next",
      scopeFiles: ["src/a.ts"],
    });
    expect(taken.granted && taken.slot).toBe(0);
    if (taken.granted) taken.release();
    expect(existsSync(slotLeasePath(dir, 0))).toBe(false);

    // This test's own pid with a start time it never had: a recycled pid.
    mkdirSync(join(dir, ".sekhemet", "slots"), { recursive: true });
    writeFileSync(
      slotLeasePath(dir, 0),
      JSON.stringify({
        pid: process.pid,
        processStart: "Thu Jan  1 00:00:00 1970",
        token: "x",
        startedAt: "2026-01-01T00:00:00.000Z",
        heartbeatAt: "2026-01-01T00:00:00.000Z",
        slot: 0,
        cardId: "card_ghost",
        scopeFiles: ["src/a.ts"],
      }),
    );
    const again = acquireSlotLease(dir, {
      capacity: 1,
      cardId: "card_x",
      scopeFiles: ["src/a.ts"],
    });
    expect(again.granted).toBe(true);
    if (again.granted) again.release();
  });

  it("a card already running in a slot is not started twice; slots above a lowered capacity still count", () => {
    const dir = tmp();
    const a = acquireSlotLease(dir, { capacity: 3, cardId: "card_a", scopeFiles: ["src/a.ts"] });
    const b = acquireSlotLease(dir, { capacity: 3, cardId: "card_b", scopeFiles: ["src/b.ts"] });
    expect(a.granted && b.granted).toBe(true);
    const twice = acquireSlotLease(dir, {
      capacity: 3,
      cardId: "card_a",
      scopeFiles: ["src/a.ts"],
    });
    expect(!twice.granted && twice.reason).toBe("running");
    // The capacity is now 1 (a requalified engine): two cards still run, so none starts.
    const lowered = acquireSlotLease(dir, {
      capacity: 1,
      cardId: "card_c",
      scopeFiles: ["src/c.ts"],
    });
    expect(!lowered.granted && lowered.reason).toBe("full");
    if (a.granted) a.release();
    if (b.granted) b.release();
    expect(liveSlotLeases(dir)).toEqual([]);
  });

  it("scopes overlap by file, by glob, and a card declaring no files overlaps every card", () => {
    expect(scopesOverlap(["src/a.ts"], ["src/a.ts"])).toEqual(["src/a.ts"]);
    expect(scopesOverlap(["src/a.ts"], ["src/*.ts"])).toEqual(["src/a.ts"]);
    expect(scopesOverlap(["src/**"], ["src/x/y.ts"])).toEqual(["src/**"]);
    // Two globs that could name the same file overlap.
    expect(scopesOverlap(["src/**/*.ts"], ["src/lib/*.ts"])).toEqual(["src/**/*.ts"]);
    expect(scopesOverlap(["src/a.ts"], ["src/b.ts"])).toEqual([]);
    expect(scopesOverlap(["lib/*.ts"], ["src/*.ts"])).toEqual([]);
    expect(scopesOverlap([], ["src/b.ts"])).toEqual(["(any file)"]);
    expect(scopesOverlap(["src/b.ts"], [])).toEqual(["(any file)"]);
  });

  it("the capacity is the qualified slots on a team server and one on a single-user install", () => {
    expect(qualifiedSlotCapacity({ mode: "solo", parallelSlots: 4 })).toBe(1);
    expect(qualifiedSlotCapacity({ mode: "team", parallelSlots: 4 })).toBe(4);
    expect(qualifiedSlotCapacity({ mode: "team", parallelSlots: 0 })).toBe(1);
    expect(qualifiedSlotCapacity({ mode: "team" })).toBe(1);
  });

  it("a waiting card's reason, for the queue standing", () => {
    const dir = tmp();
    const a = acquireSlotLease(dir, { capacity: 2, cardId: "card_a", scopeFiles: ["src/a.ts"] });
    expect(slotWaitReason(dir, { id: "card_c", scopeFiles: ["src/a.ts", "src/c.ts"] }, 2)).toMatch(
      /^waits for card_a \(slot 0\), which is editing src\/a\.ts$/,
    );
    expect(slotWaitReason(dir, { id: "card_d", scopeFiles: ["src/d.ts"] }, 2)).toBeUndefined();
    expect(slotWaitReason(dir, { id: "card_d", scopeFiles: ["src/d.ts"] }, 1)).toMatch(
      /all 1 slot is running \(card_a\)/,
    );
    if (a.granted) a.release();
  });
});

describe("RUN-35: the queue's slot pool", () => {
  it("runs at most N cards at once, each with its own slot", async () => {
    const dir = tmp();
    const pool = new SlotPool(dir, 2);
    let now = 0;
    let most = 0;
    const slots = new Set<number>();
    for (let i = 0; i < 5; i++) {
      const card = { id: `card_${i}`, scopeFiles: [`src/f${i}.ts`] };
      const claim = await pool.claim(card);
      if ("waiting" in claim) throw new Error(claim.waiting);
      slots.add(claim.slot);
      pool.start(card.id, claim, async () => {
        now++;
        most = Math.max(most, now, liveSlotLeases(dir).length);
        await new Promise((r) => setTimeout(r, 40));
        now--;
      });
      await pool.whileFull();
      expect(pool.running).toBeLessThanOrEqual(2);
    }
    await pool.drain();
    expect(most).toBe(2);
    expect([...slots].sort()).toEqual([0, 1]);
    expect(liveSlotLeases(dir)).toEqual([]);
  });

  it("a card whose files a running card is editing waits with the reason; it starts once that card ends", async () => {
    const dir = tmp();
    const pool = new SlotPool(dir, 3);
    let finish: () => void = () => {};
    const a = await pool.claim({ id: "card_a", scopeFiles: ["src/a.ts"] });
    if ("waiting" in a) throw new Error(a.waiting);
    pool.start(
      "card_a",
      a,
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const c = await pool.claim({ id: "card_c", scopeFiles: ["src/a.ts"] });
    expect("waiting" in c && c.waiting).toBe(
      "waits for card_a (slot 0), which is editing src/a.ts",
    );
    finish();
    await pool.drain();
    const later = await pool.claim({ id: "card_c", scopeFiles: ["src/a.ts"] });
    expect("slot" in later && later.slot).toBe(0);
    if ("release" in later) later.release();
  });

  it("an error in a card surfaces at the drain and its slot is released", async () => {
    const dir = tmp();
    const pool = new SlotPool(dir, 2);
    const a = await pool.claim({ id: "card_a", scopeFiles: ["src/a.ts"] });
    if ("waiting" in a) throw new Error(a.waiting);
    pool.start("card_a", a, async () => {
      throw new Error("boom");
    });
    await expect(pool.drain()).rejects.toThrow("boom");
    expect(liveSlotLeases(dir)).toEqual([]);
  });

  it("two cards run at once through the real card runner, each in its own slot, worktree and sandbox", async () => {
    const repo = tmp();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.ts"), "");
    writeFileSync(join(repo, "src", "b.ts"), "");
    // The production caller that makes each card's export reachable.
    writeFileSync(
      join(repo, "src", "index.ts"),
      'import { a } from "./a.js";\nimport { b } from "./b.js";\nconsole.log(a, b);\n',
    );
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    writeFileSync(
      join(repo, ".gitignore"),
      ".sekhemet/events.db*\n.sekhemet/worktrees\n.sekhemet/evidence\n.sekhemet/transcripts\n.sekhemet/slots\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    try {
      initSchema(db);
      const log = new EventLog(db);
      const cardStore = new CardStore(db, log);
      const ctx = {
        repoPath: repo,
        restrictedMode: false,
        cardStore,
        boardService: new BoardServiceImpl(cardStore),
        log: () => {},
        headroomCheck: false,
      };
      // Both cards must be inside a model call at once for either to go on.
      let arrived = 0;
      let open: () => void = () => {};
      const barrier = new Promise<void>((r) => {
        open = r;
      });
      const seen: { cardId: string; slot: number }[][] = [];
      class TogetherAdapter extends MockInferenceAdapter {
        private first = true;
        public override async generate(req: InferenceRequest) {
          if (this.first) {
            this.first = false;
            if (++arrived === 2) {
              seen.push(liveSlotLeases(repo).map((l) => ({ cardId: l.cardId, slot: l.slot })));
              open();
            }
            await Promise.race([
              barrier,
              new Promise((_, no) => setTimeout(() => no(new Error("not concurrent")), 15_000)),
            ]);
          }
          return super.generate(req);
        }
      }
      const model = (file: string, name: string) =>
        new TogetherAdapter("scripted", [
          {
            text: "",
            toolCalls: [
              {
                id: "1",
                name: "write_file",
                arguments: { path: file, content: `export const ${name} = 1;\n` },
              },
              { id: "2", name: "finish_card", arguments: {} },
            ],
            usage: { promptTokens: 100, completionTokens: 10, durationMs: 5 },
          },
        ]);
      const pool = new SlotPool(repo, 2);
      const results: Record<string, boolean> = {};
      for (const [id, file, name] of [
        ["card_a", "src/a.ts", "a"],
        ["card_b", "src/b.ts", "b"],
      ] as const) {
        const card = await cardStore.createCard({
          id,
          tier: "story",
          title: `Write ${file}`,
          scopeFiles: [file],
          stepBudget: 6,
          spec: `Write ${file}`,
        });
        const claim = await pool.claim(card);
        if ("waiting" in claim) throw new Error(claim.waiting);
        pool.start(id, claim, async () => {
          const r = await executeCard(ctx, card, model(file, name), `1. Export ${name}.`);
          results[id] = r.passed;
        });
        await pool.whileFull();
      }
      await pool.drain();
      expect(results).toEqual({ card_a: true, card_b: true });
      expect(seen[0]?.sort((x, y) => x.slot - y.slot)).toEqual([
        { cardId: "card_a", slot: 0 },
        { cardId: "card_b", slot: 1 },
      ]);
      for (const id of ["card_a", "card_b"]) {
        expect(existsSync(join(repo, ".sekhemet", "worktrees", id))).toBe(true);
      }
      expect(liveSlotLeases(repo)).toEqual([]);
    } finally {
      db.close();
    }
  }, 60_000);
});

describe("RUN-35: every path that runs a card stays within the queue's slots", () => {
  it("`run <card>` and `overnight` are refused outright while a queue holds the runner lease and a slot, so neither exceeds N nor runs an overlapping card", async () => {
    const dir = tmp();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const { db, cardStore } = initLocalKernel(dir);
    const card = await cardStore.createCard({
      tier: "task",
      title: "Edit a",
      status: "ready",
      scopeFiles: ["src/a.ts"],
    });
    db.close();
    // A queue pass: the runner lease, and one slot running a card on the same file.
    const out = join(dir, "out");
    const script = join(dir, "queue.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
       import { acquireRunnerLease } from ${JSON.stringify(RUNNER_DIST)};
       import { acquireSlotLease } from ${JSON.stringify(DIST)};
       const runner = acquireRunnerLease(${JSON.stringify(dir)}, { kind: "queue" });
       const slot = acquireSlotLease(${JSON.stringify(dir)}, { capacity: 1, cardId: "card_q", scopeFiles: ["src/a.ts"] });
       writeFileSync(${JSON.stringify(out)}, "holder" in runner ? "refused" : slot.granted ? "held" : slot.message);
       setTimeout(() => process.exit(0), 20000);`,
    );
    const queue = spawn(process.execPath, [script], { stdio: "ignore" });
    children.push(queue);
    await waitFor(() => existsSync(out));
    expect(readFileSync(out, "utf8")).toBe("held");

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (const argv of [
        ["run", card.id, "--repo", dir],
        ["overnight", "--repo", dir],
      ]) {
        errors.length = 0;
        process.exitCode = 0;
        await main(argv);
        expect(process.exitCode).toBe(1);
        expect(errors.join("\n")).toContain(`pid ${queue.pid}, queue`);
        // No second slot was taken, and the overlapping card never ran.
        expect(liveSlotLeases(dir).map((l) => l.cardId)).toEqual(["card_q"]);
      }
    } finally {
      process.exitCode = 0;
      vi.restoreAllMocks();
    }
    const after = initLocalKernel(dir);
    expect(after.cardStore.runs.listAttempts(card.id)).toEqual([]);
    expect((await after.cardStore.getCard(card.id))?.status).toBe("ready");
    after.db.close();
  }, 60_000);
});
