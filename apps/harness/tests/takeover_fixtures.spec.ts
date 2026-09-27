import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTakeover } from "../src/takeover.js";
import { approveTakeoverPlan } from "../src/takeover_backlog.js";
import {
  TAKEOVER_FIXTURES,
  buildTakeoverFixture,
  fakeTracker,
  fixtureSnapshot,
} from "./takeover_fixtures.js";

/**
 * DS-TO-15's fixtures (design-stage §2.10): a half-built TypeScript app with
 * failing tests, a repository that does not build, a Python project with
 * stubs, a repository with a committed fake secret and one with inherited
 * issues, each built as a real git repository and taken over with trust —
 * install, build and the suite twice, confined — to an approved plan whose
 * cards are on the board. Bringing a card to accepted needs the Worker and a
 * scripted conversation, which this test does not load (no model runs).
 */
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
beforeEach(() => {
  const trust = mkdtempSync(join(tmpdir(), "takeover-fx-trust-"));
  dirs.push(trust);
  vi.stubEnv("SEKHEMET_TRUST_DIR", trust);
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("DS-TO-15: every take-over fixture reaches an approved plan with cards", () => {
  const before = fixtureSnapshot();
  for (const name of TAKEOVER_FIXTURES) {
    it(`${name}: a brief, an evidenced backlog and, on approval, cards`, async () => {
      const fx = buildTakeoverFixture(name);
      dirs.push(fx.root);
      const dir = mkdtempSync(join(tmpdir(), "takeover-fx-db-"));
      dirs.push(dir);
      const db = new DatabaseSync(join(dir, "events.db"));
      dbs.push(db);
      initSchema(db);
      const log = new EventLog(db);
      const cardStore = new CardStore(db, log);
      const report = await runTakeover(fx.root, {
        store: cardStore,
        log,
        principal: "p_owner",
        trusted: true,
        gitleaks: false,
        osvScanner: false,
        tracker: fx.issues.length > 0 ? fakeTracker(fx.issues) : false,
        say: () => undefined,
      });
      expect(report.plan?.claims.length).toBeGreaterThan(0);
      const proposalId = report.plan?.proposalId as string;
      expect(proposalId).toMatch(/^TOP-\d+$/);
      expect(await cardStore.listCards()).toHaveLength(0);
      const approved = await approveTakeoverPlan(
        { repoPath: fx.root, cardStore, log },
        { proposalId },
        "p_owner",
      );
      expect(approved.cards.length).toBeGreaterThan(0);
      const stories = (await cardStore.listCards()).filter((c) => c.tier !== "epic");
      expect(stories.length).toBe(approved.cards.length);
      // Through the one planning pipeline: every card has criteria with ids (PM-P1-1).
      for (const c of stories) {
        expect(c.acceptanceCriteria?.length).toBeGreaterThan(0);
        expect(c.criterionIds?.length).toBe(c.acceptanceCriteria?.length);
      }
    });
  }

  it("no fixture file was edited", () => {
    expect(fixtureSnapshot()).toEqual(before);
  });
});
