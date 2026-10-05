import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema, isNoSpaceError } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { listBackupSets, writeBackupSet } from "../src/backup_sets.js";
import {
  DiskLowError,
  FREE_SPACE_FLOOR_BYTES,
  checkFreeSpace,
  describeDiskLow,
  freeSpaceFloor,
  freeSpaceOf,
} from "../src/disk_space.js";
import { executeCard } from "../src/execute.js";
import { sweepCrashedAttempts } from "../src/supervisor.js";

// Runtime item 34c, NEW-runtime-13 (RUN-69, RUN-70, RUN-83), worker-loop
// NEW-worker-loop-11 (WL-N11-1 to -3). W8's full-disk fault is done for real
// (DEFINITION_OF_DONE §2A): a small disk image is attached, filled until the
// operating system answers ENOSPC, and the real card runner, git, SQLite and
// file writes run on it. Nothing about free space is mocked. macOS attaches
// an image without root (`hdiutil`); elsewhere the volume tests are skipped
// and only the pure parts run.

const darwin = process.platform === "darwin";
const MB = 1024 * 1024;
const dirs: string[] = [];
const mounts: string[] = [];
afterEach(() => {
  for (const m of mounts.splice(0)) {
    try {
      execFileSync("hdiutil", ["detach", "-force", m], { stdio: "ignore" });
    } catch {
      // Already detached.
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 60_000);

function tempDir(prefix = "sek-disk-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** A real volume of `mb` megabytes, attached at a fresh mount point. */
function smallVolume(mb: number): string {
  const d = tempDir("sek-vol-");
  const image = join(d, "vol.dmg");
  execFileSync("hdiutil", ["create", "-size", `${mb}m`, "-fs", "HFS+", "-volname", "sek", image], {
    stdio: "ignore",
  });
  const mnt = join(d, "mnt");
  mkdirSync(mnt);
  execFileSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", mnt, image], { stdio: "ignore" });
  mounts.push(mnt);
  return realpathSync(mnt);
}

/** Write zeros to `path` until the volume answers ENOSPC; returns that error. */
function fillVolume(path: string): NodeJS.ErrnoException {
  const fd = openSync(path, "w");
  const chunk = Buffer.alloc(MB);
  try {
    for (;;) writeSync(fd, chunk);
  } catch (err) {
    return err as NodeJS.ErrnoException;
  } finally {
    closeSync(fd);
  }
}

const finish = (text = "") => ({
  text,
  toolCalls: [{ id: "f", name: "finish_card", arguments: {} }],
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});

function sized(path: string, bytes: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
}

describe("the free-space floor (RUN-69, RUN-83)", () => {
  it("is 5 GB, or twice the largest worktree when that is larger", () => {
    const root = tempDir();
    sized(join(root, ".sekhemet", "worktrees", "small", "a.bin"), 1 * MB);
    sized(join(root, ".sekhemet", "worktrees", "big", "b.bin"), 3 * MB);
    expect(freeSpaceFloor([root]).floorBytes).toBe(FREE_SPACE_FLOOR_BYTES);
    expect(FREE_SPACE_FLOOR_BYTES).toBe(5 * 1024 ** 3);
    // With a smaller policy minimum, the largest worktree decides.
    const f = freeSpaceFloor([root], MB);
    expect(f.largestWorktree?.path).toBe(join(root, ".sekhemet", "worktrees", "big"));
    expect(f.floorBytes).toBeGreaterThanOrEqual(6 * MB);
    expect(f.floorBytes).toBeLessThan(6.5 * MB);
  });

  it("reads each volume once and passes when every one is above the floor", () => {
    const a = tempDir();
    const b = tempDir();
    const check = checkFreeSpace([a, b, join(a, "not", "yet", "made")], { floorBytes: 1 });
    expect(check.ok).toBe(true);
    expect(check.volumes).toHaveLength(1);
    expect(check.volumes[0]?.freeBytes).toBeGreaterThan(0);
    // The volume reported is a's: the same mount and size. Its free bytes are
    // live, so a second read may differ by what other processes wrote meanwhile.
    const own = freeSpaceOf(a);
    expect(check.volumes[0]?.mount).toBe(own.mount);
    expect(check.volumes[0]?.totalBytes).toBe(own.totalBytes);
  });

  it.runIf(darwin)(
    "RUN-69, RUN-83: names the short volume, its free space against the floor and the largest .sekhemet consumers",
    () => {
      const vol = smallVolume(48);
      sized(join(vol, ".sekhemet", "worktrees", "card_1", "w.bin"), 3 * MB);
      sized(join(vol, ".sekhemet", "blobs", "aa", "x.json"), 2 * MB);
      sized(join(vol, ".sekhemet", "evidence", "e.json"), 1 * MB);
      const big = tempDir();
      // The workspace folder on the big volume, the project on the small one:
      // the check reads both and names the one that is short, whichever comes first.
      for (const paths of [
        [big, vol],
        [vol, big],
      ]) {
        const check = checkFreeSpace(paths);
        expect(check.ok).toBe(false);
        if (check.ok) return;
        expect(check.short.mount).toBe(vol);
        expect(check.short.freeBytes).toBeLessThan(48 * MB);
        expect(check.floorBytes).toBe(FREE_SPACE_FLOOR_BYTES);
        expect(check.consumers.map((c) => c.path.slice(vol.length + 1))).toEqual([
          ".sekhemet/worktrees/card_1",
          ".sekhemet/blobs",
          ".sekhemet/evidence",
        ]);
        const said = describeDiskLow(check);
        expect(said).toMatch(new RegExp(`${vol.replace(/[/.]/g, "\\$&")}`));
        expect(said).toMatch(/free of a 5\.0 GB floor/);
        expect(said).toMatch(/worktrees\/card_1 \(3\.0 MB\)/);
      }
    },
  );
});

describe("ENOSPC and SQLITE_FULL are recognised (RUN-70)", () => {
  it.runIf(darwin)("a real full volume: a file write and a ledger append", () => {
    const vol = smallVolume(16);
    const db = new DatabaseSync(join(vol, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    log.appendNow({ actor: "harness", type: "test/one", payload: { n: 1 } });
    const full = fillVolume(join(vol, "filler.bin"));
    expect(full.code).toBe("ENOSPC");
    expect(isNoSpaceError(full)).toBe(true);
    let appendError: unknown;
    try {
      for (let i = 0; i < 2000; i++)
        log.appendNow({ actor: "harness", type: "test/fill", payload: { pad: "x".repeat(4000) } });
    } catch (err) {
      appendError = err;
    }
    expect(appendError).toBeDefined();
    expect(isNoSpaceError(appendError)).toBe(true);
    db.close();
    expect(
      isNoSpaceError(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })),
    ).toBe(false);
    expect(isNoSpaceError(new Error("something else"))).toBe(false);
  });
});

describe("a card on a full disk (RUN-69, RUN-70, WL-N11-2, WL-N11-3)", () => {
  const GATES = `[project]\nmax_files = 5\nmax_diff_lines = 2000\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`;

  function repoOn(parent: string) {
    const repo = join(parent, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".sekhemet"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "src", "a.ts"), "");
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), GATES);
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    return repo;
  }

  function ledger() {
    const state = tempDir("sek-state-");
    mkdirSync(join(state, ".sekhemet"));
    const db = new DatabaseSync(join(state, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    return { state, db, log, cardStore, boardService: new BoardServiceImpl(cardStore) };
  }

  it.runIf(darwin)(
    "RUN-69: below the floor no card starts: it stays Ready, and machine/disk_low names the volume",
    async () => {
      const vol = smallVolume(48);
      const repo = repoOn(vol);
      const l = ledger();
      const card = await l.cardStore.createCard({
        id: "card_low",
        tier: "task",
        title: "Write a",
        scopeFiles: ["src/a.ts"],
        stepBudget: 3,
        spec: "Write src/a.ts",
      });
      await l.boardService.transitionCard({
        cardId: card.id,
        fromStatus: card.status,
        toStatus: "ready",
        actor: "human",
      });
      const model = new MockInferenceAdapter("scripted", [finish()]);
      const err = await executeCard(
        {
          repoPath: repo,
          workspaceFolder: l.state,
          restrictedMode: false,
          cardStore: l.cardStore,
          boardService: l.boardService,
          log: () => {},
          headroomCheck: false,
        },
        (await l.cardStore.getCard(card.id)) ?? card,
        model,
      ).catch((e) => e);
      expect(err).toBeInstanceOf(DiskLowError);
      expect(String(err.message)).toMatch(/free of a 5\.0 GB floor/);
      const after = await l.cardStore.getCard(card.id);
      expect(after?.status).toBe("ready");
      expect(after?.stopReason ?? undefined).toBeUndefined();
      expect(l.cardStore.runs.listAttempts(card.id)).toEqual([]);
      const events = await l.cardStore.cardEvents(card.id, ["machine/disk_low"]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ volume: vol, floorBytes: FREE_SPACE_FLOOR_BYTES });
      l.db.close();
    },
  );

  // RUN-83 (C4 review): with only the project's volume read, every test
  // above still passed; this one fails unless the workspace folder's volume
  // — the ledger's — is read too.
  it.runIf(darwin)(
    "RUN-83: the project on a roomy volume and the workspace folder on a short one: no card starts, and the ledger's volume is named",
    async () => {
      const vol = smallVolume(48);
      const repo = repoOn(tempDir("sek-roomy-"));
      expect(checkFreeSpace([repo]).ok).toBe(true);
      const state = join(vol, "workspace");
      mkdirSync(join(state, ".sekhemet"), { recursive: true });
      const db = new DatabaseSync(join(state, ".sekhemet", "events.db"));
      initSchema(db);
      const cardStore = new CardStore(db, new EventLog(db));
      const boardService = new BoardServiceImpl(cardStore);
      const card = await cardStore.createCard({
        id: "card_ws_low",
        tier: "task",
        title: "Write a",
        scopeFiles: ["src/a.ts"],
        stepBudget: 3,
        spec: "Write src/a.ts",
      });
      await boardService.transitionCard({
        cardId: card.id,
        fromStatus: card.status,
        toStatus: "ready",
        actor: "human",
      });
      const model = new MockInferenceAdapter("scripted", [finish()]);
      const err = await executeCard(
        {
          repoPath: repo,
          workspaceFolder: state,
          restrictedMode: false,
          cardStore,
          boardService,
          log: () => {},
          headroomCheck: false,
        },
        (await cardStore.getCard(card.id)) ?? card,
        model,
      ).catch((e) => e);
      expect(err).toBeInstanceOf(DiskLowError);
      expect((await cardStore.getCard(card.id))?.status).toBe("ready");
      expect(cardStore.runs.listAttempts(card.id)).toEqual([]);
      const events = await cardStore.cardEvents(card.id, ["machine/disk_low"]);
      expect(events[0]?.payload).toMatchObject({ volume: vol });
      db.close();
    },
  );

  it.runIf(darwin)(
    "RUN-70, WL-N11-3: a Worker's write that hits ENOSPC stops the card with disk_low and the path; once space is freed, the next run resumes from its checkpoint",
    async () => {
      const vol = smallVolume(64);
      const repo = repoOn(vol);
      const l = ledger();
      const card = await l.cardStore.createCard({
        id: "card_full",
        tier: "task",
        title: "Write a and data",
        scopeFiles: ["src/a.ts", "src/data.txt"],
        stepBudget: 6,
        spec: "Write src/a.ts and src/data.txt",
      });
      await l.boardService.transitionCard({
        cardId: card.id,
        fromStatus: card.status,
        toStatus: "ready",
        actor: "human",
      });
      const ctx = {
        repoPath: repo,
        workspaceFolder: l.state,
        restrictedMode: false,
        cardStore: l.cardStore,
        boardService: l.boardService,
        log: () => {},
        headroomCheck: false,
        // The policy floor for a 64 MB volume: the card starts with room to spare.
        freeSpaceFloorBytes: 8 * MB,
      };
      const step = (name: string, args: Record<string, unknown>) => ({
        text: "",
        toolCalls: [{ id: name, name, arguments: args }],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      });
      const first = new MockInferenceAdapter("scripted", [
        step("write_file", { path: "src/a.ts", content: "export const a = 1;\n" }),
        // More than the volume holds: the operating system answers ENOSPC.
        step("write_file", { path: "src/data.txt", content: "x".repeat(80 * MB) }),
        finish(),
      ]);
      const stopped = await executeCard(ctx, (await l.cardStore.getCard(card.id)) ?? card, first);
      expect(stopped.stopReason).toBe("disk_low");
      expect(stopped.passed).toBe(false);
      expect(stopped.evidence.stopDetail).toMatchObject({ path: "src/data.txt", volume: vol });
      expect(stopped.finalStatus).toBe("ready");
      const held = await l.cardStore.getCard(card.id);
      expect(held?.status).toBe("ready");
      expect(held?.stopReason).toBe("disk_low");
      const attempt = l.cardStore.runs.listAttempts(card.id).at(-1);
      expect(attempt?.status).toBe("halted");
      expect(l.cardStore.runs.listCompetence()).toEqual([]);
      // The volume fills up meanwhile: the next run does not start (RUN-69)…
      const filler = join(vol, "filler.bin");
      expect(fillVolume(filler).code).toBe("ENOSPC");
      const refused = await executeCard(
        ctx,
        (await l.cardStore.getCard(card.id)) ?? card,
        new MockInferenceAdapter("scripted", [finish()]),
      ).catch((e) => e);
      expect(refused).toBeInstanceOf(DiskLowError);
      expect((await l.cardStore.getCard(card.id))?.status).toBe("ready");
      // …until a person frees the space; then it resumes from its checkpoint.
      rmSync(filler);
      const resumed = await executeCard(
        ctx,
        (await l.cardStore.getCard(card.id)) ?? card,
        new MockInferenceAdapter("scripted", [finish()]),
      );
      expect(resumed.resumedFrom?.step).toBe(1);
      expect(resumed.passed).toBe(true);
      l.db.close();
    },
    120_000,
  );
});

describe("the ledger's own volume fills mid-card (RUN-70, WL-N11-3)", () => {
  it.runIf(darwin)(
    "a step's append fails with SQLITE_FULL: the card stops with disk_low, the lost records are logged, and the start-up sweep records disk_low, not crashed, while space is below the floor",
    async () => {
      const home = tempDir("sek-home-");
      const savedHome = process.env.SEKHEMET_CONFIG_DIR;
      process.env.SEKHEMET_CONFIG_DIR = home;
      try {
        const vol = smallVolume(64);
        // The repository on the big volume; the workspace's ledger, evidence
        // and blobs on the small one.
        const big = tempDir();
        const repo = join(big, "repo");
        mkdirSync(join(repo, "src"), { recursive: true });
        mkdirSync(join(repo, ".sekhemet"));
        const git = (...args: string[]) =>
          execFileSync("git", args, { cwd: repo, stdio: "ignore" });
        git("init", "-q", "-b", "main");
        git("config", "user.email", "t@t.t");
        git("config", "user.name", "T");
        writeFileSync(join(repo, "src", "a.ts"), "");
        writeFileSync(
          join(repo, ".sekhemet", "gates.toml"),
          `[project]\nmax_files = 5\nmax_diff_lines = 2000\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
        );
        writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
        git("add", "-A");
        git("commit", "-q", "-m", "seed");
        const state = join(vol, "ws");
        mkdirSync(join(state, ".sekhemet"), { recursive: true });
        const db = new DatabaseSync(join(state, ".sekhemet", "events.db"));
        initSchema(db);
        const log = new EventLog(db);
        const cardStore = new CardStore(db, log);
        const boardService = new BoardServiceImpl(cardStore);
        const card = await cardStore.createCard({
          id: "card_ledger_full",
          tier: "task",
          title: "Write a",
          scopeFiles: ["src/a.ts"],
          stepBudget: 6,
          spec: "Write src/a.ts",
        });
        await boardService.transitionCard({
          cardId: card.id,
          fromStatus: card.status,
          toStatus: "ready",
          actor: "human",
        });
        const step = (content: string) => ({
          text: "",
          toolCalls: [{ id: "w", name: "write_file", arguments: { path: "src/a.ts", content } }],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        });
        const model = new MockInferenceAdapter("scripted", [
          step("export const a = 1;\n"),
          step("export const a = 2;\n"),
          finish(),
        ]);
        const generate = model.generate.bind(model);
        const filler = join(vol, "filler.bin");
        let calls = 0;
        model.generate = async (req) => {
          // The volume fills while the second step is generating.
          if (++calls === 2) expect(fillVolume(filler).code).toBe("ENOSPC");
          return generate(req);
        };
        const result = await executeCard(
          {
            repoPath: repo,
            workspaceFolder: state,
            restrictedMode: false,
            cardStore,
            boardService,
            log: () => {},
            headroomCheck: false,
            freeSpaceFloorBytes: 8 * MB,
          },
          (await cardStore.getCard(card.id)) ?? card,
          model,
        );
        expect(result.stopReason).toBe("disk_low");
        expect(result.passed).toBe(false);
        // SQLite reuses its WAL's free frames, so the first append to fail
        // may be a step later than the fill.
        expect(calls).toBeGreaterThanOrEqual(2);
        // The stop's own records could not be written: each is in the lost-record log.
        const ws = cardStore.workspaceId();
        const lost = readFileSync(
          join(home, "logs", ws ?? "unknown", "lost-records.ndjson"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { kind: string; error: string; cardId?: string });
        expect(lost.length).toBeGreaterThan(0);
        expect(lost[0]).toMatchObject({
          kind: expect.stringMatching(/^step \d+$/),
          cardId: card.id,
        });
        expect(lost[0]?.error).toMatch(/database or disk is full/);
        // The ledger stayed consistent: the chain verifies.
        expect(cardStore.verifyLedger().valid).toBe(true);
        // Next start: space is freed but still below the policy floor on this
        // volume, so the crashed attempt is recorded as disk_low.
        rmSync(filler);
        const swept = await sweepCrashedAttempts(repo, cardStore, boardService, {
          workspaceFolder: state,
        });
        expect(swept).toEqual([
          expect.objectContaining({ cardId: card.id, stopReason: "disk_low" }),
        ]);
        const after = await cardStore.getCard(card.id);
        expect(after?.status).toBe("ready");
        expect(after?.stopReason).toBe("disk_low");
        expect(cardStore.runs.listAttempts(card.id).at(-1)).toMatchObject({
          status: "halted",
          stopReason: "disk_low",
        });
        db.close();
      } finally {
        if (savedHome === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
        else process.env.SEKHEMET_CONFIG_DIR = savedHome;
      }
    },
    120_000,
  );
});

describe("a backup on a full disk (RUN-69)", () => {
  it.runIf(darwin)(
    "is not started when the workspace's volume is below the floor: DiskLowError, no set, no partial folder",
    async () => {
      const home = tempDir("sek-home-");
      const savedHome = process.env.SEKHEMET_CONFIG_DIR;
      process.env.SEKHEMET_CONFIG_DIR = home;
      try {
        const vol = smallVolume(48);
        const ws = join(vol, "ws");
        mkdirSync(join(ws, ".sekhemet"), { recursive: true });
        const db = new DatabaseSync(join(ws, ".sekhemet", "events.db"));
        initSchema(db);
        const log = new EventLog(db);
        log.appendNow({ actor: "harness", type: "test/one", payload: { n: 1 } });
        const err = await writeBackupSet({ workspaceFolder: ws, db, log }).catch((e) => e);
        expect(err).toBeInstanceOf(DiskLowError);
        expect(String(err.message)).toMatch(new RegExp(vol.replace(/[/.]/g, "\\$&")));
        expect(listBackupSets(log.workspaceId())).toEqual([]);
        db.close();
      } finally {
        if (savedHome === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
        else process.env.SEKHEMET_CONFIG_DIR = savedHome;
      }
    },
  );
});
