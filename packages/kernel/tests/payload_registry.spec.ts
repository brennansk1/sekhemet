import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { DATA_CLASSES, PAYLOAD_SCHEMAS } from "../src/payload_registry.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md S7: the payload schema registry — one Valibot schema per event
// type (DEC-29 O7), every field marked with its data class (rule 33).
// K-S7-4, K-S7-9, K-S7-10. Real SQLite.

describe("the payload schema registry (K-S7-4, K-S7-9, K-S7-10)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  const count = (): number =>
    (disk.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-registry-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    await store.createCard({ id: "c", tier: "task", title: "A card" });
  });
  afterEach(() => disk.dispose());

  it("K-S7-4: refuses a payload that fails its type's schema, naming the type and the field", () => {
    const before = count();
    expect(() =>
      log.appendNow({
        actor: "human",
        type: "card/owner_changed",
        cardId: "c",
        payload: { id: "c", from: null, to: "someone@example.com" },
      }),
    ).toThrow(/card\/owner_changed.*\bto\b/);
    expect(() =>
      log.appendNow({
        actor: "human",
        type: "card/override",
        cardId: "c",
        payload: { id: "c", from: "ready", to: "nowhere", overrode: "edge" },
      }),
    ).toThrow(/card\/override.*\bto\b/);
    // A field the schema does not know is a failure too, named.
    expect(() =>
      log.appendNow({
        actor: "human",
        type: "playbook/candidate",
        cardId: "c",
        payload: { cardId: "c", extra: 1 },
      }),
    ).toThrow(/playbook\/candidate.*\bextra\b/);
    expect(count()).toBe(before);
    // An unregistered type is not checked by the registry.
    log.appendNow({ actor: "system", type: "test/unregistered", payload: { anything: "x" } });
    expect(count()).toBe(before + 1);
  });

  it("K-S7-4: a staged test is recorded by path, SHA-256 and author, structural only (gates rule 6a)", () => {
    const before = count();
    const sha = "a".repeat(64);
    log.appendNow({
      actor: "planner",
      type: "test/staged",
      cardId: "c",
      payload: { cardId: "c", path: "tests/a.spec.ts", sha256: sha, author: "planner" },
    });
    expect(count()).toBe(before + 1);
    expect(() =>
      log.appendNow({
        actor: "planner",
        type: "test/staged",
        cardId: "c",
        payload: { cardId: "c", path: "tests/a.spec.ts", sha256: "not-a-hash", author: "planner" },
      }),
    ).toThrow(/test\/staged.*sha256/);
    expect(() =>
      log.appendNow({
        actor: "planner",
        type: "test/staged",
        cardId: "c",
        payload: { cardId: "c", path: "tests/a.spec.ts", sha256: sha, author: "the model" },
      }),
    ).toThrow(/test\/staged.*author/);
    expect(count()).toBe(before + 1);
  });

  it("K-S7-4: a card's nightly mutation score is registered, its measure checked (GT-N5-5)", () => {
    const before = count();
    const measure = {
      score: null,
      killed: 0,
      total: 0,
      refused: "no live mutant: every mutant judged was stillborn, so nothing was measured",
      notMeasured: [],
      stillborn: 2,
      equivalent: 0,
      acceptance: { score: null, killed: 0, total: 0, reason: "not run" },
      stale: ["src/a.ts:3"],
    };
    log.appendNow({
      actor: "system",
      type: "card/mutation_completed",
      cardId: "c",
      payload: { queue: ".sekhemet/nightly/mutation/c.json", measure },
    });
    expect(count()).toBe(before + 1);
    expect(() =>
      log.appendNow({
        actor: "system",
        type: "card/mutation_completed",
        cardId: "c",
        payload: {
          queue: ".sekhemet/nightly/mutation/c.json",
          measure: { ...measure, score: "high" },
        },
      }),
    ).toThrow(/card\/mutation_completed.*score/);
    expect(count()).toBe(before + 1);
  });

  it("K-S7-9: a personal, free-text or secret-bearing field goes only in the private part", async () => {
    const before = count();
    expect(() =>
      log.appendNow({
        actor: "human",
        type: "playbook/candidate",
        cardId: "c",
        payload: { cardId: "c", reason: "Stop renaming the exports" },
      }),
    ).toThrow(/playbook\/candidate.*\breason\b.*free_text.*private/);
    expect(() =>
      log.appendNow({
        actor: "system",
        type: "person/created",
        payload: { principal: "p_abc", email: "a@example.com" },
      }),
    ).toThrow(/person\/created.*\bemail\b.*personal/);
    expect(count()).toBe(before);

    const ok = log.appendNow({
      actor: "human",
      type: "playbook/candidate",
      cardId: "c",
      payload: { cardId: "c" },
      private: { reason: "Stop renaming the exports" },
    });
    const row = disk.db.prepare("SELECT payload FROM events WHERE id = ?").get(ok.id) as {
      payload: string;
    };
    expect(row.payload).not.toContain("renaming");
    const [read] = await log.getEventsByTypes(["playbook/candidate"]);
    expect(read?.private).toEqual({ reason: "Stop renaming the exports" });
    // The private part is checked against the same schema.
    expect(() =>
      log.appendNow({
        actor: "human",
        type: "playbook/candidate",
        cardId: "c",
        payload: { cardId: "c" },
        private: { reason: 42 },
      }),
    ).toThrow(/playbook\/candidate.*\breason\b/);
  });

  it("K-S7-9: the board's override writes its reason to the private part", async () => {
    await store.recordEvent({
      type: "card/override",
      cardId: "c",
      actor: "human",
      principal: "p_owner",
      payload: { id: "c", from: "ready", to: "done", overrode: "edge", principal: "p_owner" },
      private: { reason: "override: shipped by hand" },
    });
    const [o] = await store.cardEvents("c", ["card/override"]);
    expect(o?.payload).not.toHaveProperty("reason");
    expect(o?.private).toEqual({ reason: "override: shipped by hand" });
  });

  it("K-S7-4: the GitHub pull request record is registered, and a stray login in it is refused (B4.9 re-check)", async () => {
    const pr = {
      number: 5,
      nodeId: "PR_1",
      url: "https://github.com/o/r/pull/5",
      headSha: "abc",
      repo: { owner: "o", repo: "r" },
    };
    expect(PAYLOAD_SCHEMAS["github/pr_opened"]).toBeDefined();
    await expect(
      log.append({
        actor: "harness",
        type: "github/pr_opened",
        payload: { ...pr, author: "jane-gh" },
      }),
    ).rejects.toThrow(/github\/pr_opened/);
    await expect(
      log.append({ actor: "harness", type: "github/pr_opened", payload: pr }),
    ).resolves.toBeDefined();
  });

  it("K-S7-10: every field of every registered event type carries a data class", () => {
    const types = Object.keys(PAYLOAD_SCHEMAS);
    expect(types.length).toBeGreaterThan(5);
    for (const type of types) {
      const fields = Object.entries(PAYLOAD_SCHEMAS[type] ?? {});
      expect(fields.length, type).toBeGreaterThan(0);
      for (const [name, field] of fields) {
        expect(DATA_CLASSES, `${type}.${name}`).toContain(field.dataClass);
        expect(field.schema, `${type}.${name}`).toHaveProperty("kind", "schema");
      }
    }
  });
});
