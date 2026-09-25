import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { approveSkill } from "@sekhemet/context";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playbookDoctorCheck } from "../src/wave2.js";
import { skillsLockPath } from "../src/workspace_trust.js";

/**
 * EXT-26 (extensibility item 16): `doctor` on a repository with recorded
 * outcomes reports, per skill, its token cost, how many recent cards it
 * triggered on, and its net gain (pass rate with it minus without).
 */
let root: string;
let repo: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-skill-doctor-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".sekhemet", "skills"), { recursive: true });
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(root, "user"));
  vi.stubEnv("SEKHEMET_TRUST_DIR", join(root, "user", "trust"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function skill(name: string, trigger: string, body: string): void {
  const dir = join(repo, ".sekhemet", "skills");
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\ndescription: ${name}\ntriggers: [${trigger}]\n---\n${body}\n`,
  );
  approveSkill(dir, name, "human", skillsLockPath(repo));
}

async function cards(
  list: { id: string; title: string; status: "done" | "parked" | "review" | "ready" }[],
) {
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const store = new CardStore(db, new EventLog(db));
  for (const c of list) {
    await store.createCard({
      id: c.id,
      tier: "task",
      title: c.title,
      scopeFiles: ["src/x.ts"],
      status: c.status === "parked" ? "parked" : "ready",
      ...(c.status === "parked" ? { blockedReason: "budget exhausted" } : {}),
    });
    if (c.status === "ready") continue;
    await store.updateCard(c.id, { stepsUsed: 3 }, "harness");
    // Review and Done are reached only through the transition law's gates and
    // a person's accept; the outcome is what matters here, so the projection
    // row is set to it directly.
    if (c.status !== "parked")
      db.prepare("UPDATE cards SET status = ? WHERE id = ?").run(c.status, c.id);
  }
  db.close();
}

describe("EXT-26: doctor reports each skill's cost, triggers and net gain", () => {
  it("from the cards the ledger recorded as finished", async () => {
    skill("sql-migrations", "migration", "Write the down migration first. ".repeat(20));
    skill("never-used", "kubernetes", "Pods.");
    await cards([
      { id: "c1", title: "Add a migration for users", status: "done" },
      { id: "c2", title: "Add a migration for orders", status: "review" },
      { id: "c3", title: "Fix the migration of carts", status: "parked" },
      { id: "c4", title: "Fix the header", status: "parked" },
      { id: "c5", title: "Fix the footer", status: "done" },
      // Not yet run: no outcome, not counted.
      { id: "c6", title: "Write a migration later", status: "ready" },
    ]);
    const check = playbookDoctorCheck(repo);
    // sql-migrations: on 3 finished cards (2 passed), off 2 (1 passed): +16.7 points.
    expect(check.detail).toMatch(
      /Skill sql-migrations: \d+ tokens, triggered on 3 of 5 recent cards, net gain \+16\.7 points \(2\/3 with, 1\/2 without\)/,
    );
    expect(check.detail).toMatch(
      /Skill never-used: \d+ tokens, triggered on 0 of 5 recent cards, net gain unmeasured/,
    );
    expect(check.detail).toMatch(/never triggered on recent cards: never-used/);
  });

  it("says so when no card has finished yet", () => {
    skill("sql-migrations", "migration", "Body.");
    expect(playbookDoctorCheck(repo).detail).toMatch(
      /Skill sql-migrations: \d+ tokens, triggered on 0 of 0 recent cards, net gain unmeasured/,
    );
  });
});
