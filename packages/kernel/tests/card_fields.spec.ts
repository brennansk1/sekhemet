import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cardKind } from "../src/card_class.js";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { SCHEMA_VERSION, initSchema } from "../src/schema.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md rule 21 and the card's kind fields: NEW-kernel-9 (kind, change,
// split stored once) and NEW-kernel-6 (owner, delegate, accepter). Real
// SQLite files (DoD §2A).

describe("the card's kind, change and split, stored (NEW-kernel-9)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  beforeEach(() => {
    disk = openDiskDb("sekhemet-kind-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
  });
  afterEach(() => disk.dispose());

  it("K-N9-1: stores the given kind, derives one once when none is given, and refuses any other", async () => {
    const given = await store.createCard({
      id: "g",
      tier: "task",
      title: "Investigate the parser",
      kind: "data",
    });
    expect(given.kind).toBe("data");
    const derived = await store.createCard({ id: "d", tier: "task", title: "Investigate caching" });
    expect(derived.kind).toBe("spike");
    const [created] = await store.cardEvents("d", ["card/created"]);
    expect((created?.payload as { kind?: string }).kind).toBe("spike");
    const before = (await log.getEvents(1, 1_000_000)).length;
    await expect(
      store.createCard({ id: "x", tier: "task", title: "X", kind: "chore" as never }),
    ).rejects.toThrow(/kind must be one of the seven card kinds/);
    expect((await log.getEvents(1, 1_000_000)).length).toBe(before);
    // Replay reads the recorded kind; it never re-derives from the title.
    await store.rebuildProjections();
    expect((await store.getCard("g"))?.kind).toBe("data");
  });

  it("K-N9-2: a rename never changes the kind; a principal's change is recorded, and refused mid-run", async () => {
    await store.createCard({ id: "c", tier: "task", title: "Write the parser" });
    expect((await store.getCard("c"))?.kind).toBe("implement");
    await store.updateCard("c", { title: "Research and survey parsers", labels: ["review"] });
    expect((await store.getCard("c"))?.kind).toBe("implement");

    await expect(store.updateCard("c", { kind: "rule" })).rejects.toThrow(/names the principal/);
    await store.updateCard("c", { kind: "rule", change: "fix" }, "human", { principal: "p_owner" });
    const [changed] = (await store.cardEvents("c", ["card/updated"])).slice(-1);
    expect(changed?.principal).toBe("p_owner");
    expect(changed?.payload).toMatchObject({ patch: { kind: "rule", change: "fix" } });
    expect(await store.getCard("c")).toMatchObject({ kind: "rule", change: "fix" });

    for (const status of ["in_progress", "verify"] as const) {
      await store.updateCardStatus("c", status);
      await expect(
        store.updateCard("c", { kind: "data" }, "human", { principal: "p_owner" }),
      ).rejects.toThrow(new RegExp(`while it is ${status}`));
    }
    expect((await store.getCard("c"))?.kind).toBe("rule");
  });

  it("K-N9-3: change defaults to feature, split comes from the SPIDR marker, and other values are refused", async () => {
    const plain = await store.createCard({ id: "p", tier: "task", title: "Plain" });
    expect(plain.change).toBe("feature");
    expect(plain.split).toBeUndefined();
    const spidr = await store.createCard({ id: "s", tier: "task", title: "Path one (SPIDR: P)" });
    expect(spidr).toMatchObject({ split: "path", kind: "implement" });
    const explicit = await store.createCard({
      id: "e",
      tier: "task",
      title: "E",
      change: "characterize",
      split: "rules",
    });
    expect(explicit).toMatchObject({ change: "characterize", split: "rules" });
    await expect(
      store.createCard({ id: "b1", tier: "task", title: "B", change: "chore" as never }),
    ).rejects.toThrow(/change must be one of/);
    await expect(
      store.createCard({ id: "b2", tier: "task", title: "B", split: "vertical" as never }),
    ).rejects.toThrow(/split must be one of/);
  });

  it("K-N9-4: the class reads the stored kind; nothing outside storage, display and export reads split", async () => {
    const card = await store.createCard({
      id: "k",
      tier: "task",
      title: "Investigate",
      kind: "interface",
    });
    expect(cardKind(card)).toBe("interface");
    expect(cardKind({ ...card, title: "Add a migration" })).toBe("interface");

    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) ? [p] : [];
      });
    const allowed = new Set([
      join("packages", "kernel", "src", "card_store.ts"),
      join("packages", "kernel", "src", "card_columns.ts"),
    ]);
    const readers: string[] = [];
    for (const top of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(root, top))) {
        const src = join(root, top, pkg, "src");
        try {
          if (!statSync(src).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const f of walk(src)) {
          const rel = relative(root, f);
          if (allowed.has(rel)) continue;
          if (/\.split\b(?!\s*\()/.test(readFileSync(f, "utf8"))) readers.push(rel);
        }
      }
    }
    expect(readers).toEqual([]);
  });

  it("K-N9-5: replay reproduces kind, change and split exactly", async () => {
    await store.createCard({ id: "a", tier: "task", title: "A (SPIDR: D)" });
    await store.createCard({ id: "b", tier: "task", title: "B", kind: "review", change: "fix" });
    await store.updateCard("a", { change: "refactor" }, "human", { principal: "p_owner" });
    expect((await store.verifyProjections()).identical).toBe(true);
  });
});

describe("K-N9-5: a database without the kind columns is migrated", () => {
  it("stores the kind its creation derives, change feature, and the SPIDR split; replay agrees", async () => {
    const disk = openDiskDb("sekhemet-kind-migrate-");
    const path = disk.path;
    const log = new EventLog(disk.db);
    const store = new CardStore(disk.db, log);
    await store.createCard({ id: "old1", tier: "task", title: "Investigate options" });
    await store.createCard({ id: "old2", tier: "task", title: "Seed rows (SPIDR: D)" });
    await store.updateCard("old1", { title: "Build the thing" });
    // Take the database back to before these columns existed.
    const db = disk.db;
    const keep = (db.prepare("PRAGMA table_info(cards)").all() as { name: string }[])
      .map((c) => c.name)
      .filter(
        (c) => !["kind", "change", "split", "owner", "delegate", "accepter", "hold"].includes(c),
      );
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`CREATE TABLE cards_old AS SELECT ${keep.join(", ")} FROM cards`);
    db.exec("DROP TABLE cards");
    db.exec("ALTER TABLE cards_old RENAME TO cards");
    db.exec("PRAGMA user_version = 2");
    disk.close();

    const reopened = new DatabaseSync(path);
    const report = initSchema(reopened, { backupDir: dirname(path) });
    expect(report.applied).toEqual(expect.arrayContaining([3, 4, 5, 6]));
    expect(
      (reopened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
    const rows = reopened
      .prepare("SELECT id, kind, change, split FROM cards ORDER BY id")
      .all() as Record<string, unknown>[];
    // old1 keeps the kind its creation derived, although it was renamed since.
    expect(rows).toEqual([
      { id: "old1", kind: "spike", change: "feature", split: null },
      { id: "old2", kind: "data", change: "feature", split: "data" },
    ]);
    const again = new CardStore(reopened, new EventLog(reopened));
    expect((await again.verifyProjections()).identical).toBe(true);
    reopened.close();
    disk.dispose();
  });
});

describe("who is on a card (NEW-kernel-6)", () => {
  let disk: DiskDb;
  let store: CardStore;
  beforeEach(() => {
    disk = openDiskDb("sekhemet-people-");
    store = new CardStore(disk.db, new EventLog(disk.db));
  });
  afterEach(() => disk.dispose());

  it("K-N6-1: records an owner and a delegate, and refuses a delegate kind outside the set", async () => {
    const card = await store.createCard({
      id: "c",
      tier: "task",
      title: "C",
      owner: "p_owner",
      delegate: { kind: "worker" },
    });
    expect(card).toMatchObject({ owner: "p_owner", delegate: { kind: "worker" } });
    const none = await store.createCard({ id: "n", tier: "task", title: "N" });
    expect(none.delegate).toBeUndefined();
    await expect(
      store.createCard({ id: "x", tier: "task", title: "X", delegate: { kind: "robot" } as never }),
    ).rejects.toThrow(/a delegate is/);
    await expect(
      store.createCard({ id: "y", tier: "task", title: "Y", delegate: { kind: "person" } }),
    ).rejects.toThrow(/names the person's principal/);
  });

  it("K-N6-2: a change of delegate or owner is its own event, naming the principal who made it", async () => {
    await store.createCard({ id: "c", tier: "task", title: "C", delegate: { kind: "worker" } });
    await store.delegateCard("c", { kind: "person", id: "p_dev" }, "p_owner");
    await store.changeOwner("c", "p_dev", "p_owner");
    const [delegated] = await store.cardEvents("c", ["card/delegated"]);
    expect(delegated?.payload).toMatchObject({
      from: { kind: "worker" },
      to: { kind: "person", id: "p_dev" },
    });
    expect(delegated?.principal).toBe("p_owner");
    const [owner] = await store.cardEvents("c", ["card/owner_changed"]);
    expect(owner?.payload).toMatchObject({ from: null, to: "p_dev" });
    expect(owner?.principal).toBe("p_owner");
    expect(await store.getCard("c")).toMatchObject({
      owner: "p_dev",
      delegate: { kind: "person", id: "p_dev" },
    });
  });

  it("K-N6-3: acceptance sets the accepter; replay reproduces owner, delegate and accepter", async () => {
    await store.createCard({
      id: "c",
      tier: "task",
      title: "C",
      owner: "p_owner",
    });
    await store.updateCardStatus("c", "review", "setup", "harness", { override: true });
    await store.delegateCard("c", { kind: "worker" }, "p_owner");
    await store.updateCardStatus("c", "done", "accepted", "human", { principal: "p_owner" });
    expect((await store.getCard("c"))?.accepter).toBe("p_owner");
    expect((await store.verifyProjections()).identical).toBe(true);
    await store.rebuildProjections();
    expect(await store.getCard("c")).toMatchObject({
      owner: "p_owner",
      delegate: { kind: "worker" },
      accepter: "p_owner",
    });
  });
});

describe("who built each attempt, and where each gate result came from", () => {
  let disk: DiskDb;
  let store: CardStore;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-built-");
    store = new CardStore(disk.db, new EventLog(disk.db));
    await store.createCard({ id: "c", tier: "task", title: "C" });
  });
  afterEach(() => disk.dispose());

  const outcome = {
    repoId: "r",
    cardClass: "implement:ts",
    filesTouchedCount: 1,
    difficulty: "medium",
    modelId: "m",
    toolArm: "arm_a_flat",
    stepBudget: 10,
    stepsUsed: 3,
    stopReason: "gate_passed",
    passed: true,
    tokensUsed: 5,
    wallClockSeconds: 2,
  };

  it("K-N6-4: records builtBy on attempts and checkpoints; a person's attempt never reaches competence", async () => {
    const worker = await store.runs.startAttempt({ cardId: "c", attemptNumber: 1, modelId: "m" });
    expect(worker.builtBy).toEqual({ kind: "worker", id: "m" });
    const person = await store.runs.startAttempt({
      cardId: "c",
      attemptNumber: 2,
      modelId: "m",
      builtBy: { kind: "person", id: "p_dev" },
    });
    expect(store.runs.getAttempt(person.id)?.builtBy).toEqual({ kind: "person", id: "p_dev" });
    expect(await store.runs.recordCompetence(outcome, { attemptId: person.id })).toBeUndefined();
    expect(await store.runs.recordCompetence(outcome, { attemptId: worker.id })).toBeDefined();
    expect(store.runs.listCompetence({ modelId: "m" })).toHaveLength(1);
    expect(store.runs.competence("implement:ts", "m").attempts).toBe(1);

    await store.recordCheckpoint({
      cardId: "c",
      step: 1,
      gitRef: "abc",
      gateStatus: "pass",
      agentModel: "m",
      agentHarness: "sekhemet",
      agentRole: "implementer",
      createdAt: "2026-09-25T00:00:00.000Z",
      builtBy: { kind: "person", id: "p_dev" },
    });
    expect((await store.getCheckpoints("c"))[0]?.builtBy).toEqual({ kind: "person", id: "p_dev" });
    expect((await store.verifyProjections()).identical).toBe(true);
  });

  it("K-N8-3: a gate result names its source; an external one its run; none is refused", async () => {
    const a = await store.runs.startAttempt({ cardId: "c", attemptNumber: 1, modelId: "m" });
    const base = {
      attemptId: a.id,
      cardId: "c",
      gate: "test",
      layer: "functional",
      passed: true,
      exitCode: 0,
      durationMs: 1,
      failures: [],
    };
    await expect(store.runs.recordGateResult(base as never)).rejects.toThrow(/names its source/);
    await expect(store.runs.recordGateResult({ ...base, source: "external" })).rejects.toThrow(
      /externalRef/,
    );
    await store.runs.recordGateResult({ ...base, source: "local" });
    const ref = { system: "github", checkName: "ci/test", runUrl: "https://ci/1", headSha: "abc" };
    await store.runs.recordGateResult({ ...base, source: "external", externalRef: ref });
    const results = store.runs.listGateResults(a.id);
    expect(results.map((r) => r.source)).toEqual(["local", "external"]);
    expect(results[1]?.externalRef).toEqual(ref);
    expect((await store.verifyProjections()).identical).toBe(true);
  });
});
