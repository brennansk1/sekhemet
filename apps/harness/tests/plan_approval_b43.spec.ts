import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { type RepoContext, planCommand, runDevCommand } from "../src/wave2.js";

// B4.3 part 3 wiring in the product (planner-pm §2.16, §2.17; NEW-planner-pm-3,
// -6, -7), with a real git repository and an on-disk ledger:
// - `sekhemet plan` leaves every card in Planning until `sekhemet approve`;
// - `sekhemet plan` splits against, and records, the Worker's measured record;
// - `sekhemet upgrade` plans an upgrade card and, after its gates, fix cards.
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function kernel(): RepoContext & { boardService: BoardServiceImpl } {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-approve-b43-"));
  dirs.push(repoPath);
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), text);
  };
  w("package.json", JSON.stringify({ name: "recipes", devDependencies: { vitest: "^3.0.0" } }));
  w("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: init");
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  return {
    repoPath,
    log,
    cardStore,
    boardService: new BoardServiceImpl(cardStore, { entryConditions: true }),
  };
}

const SPEC = "Save a recipe with its title and list the saved recipes.";

describe("PM-N7-5 in the product: sekhemet plan, then sekhemet approve", () => {
  it("leaves every planned card in Planning until a person approves it from the CLI", async () => {
    const k = kernel();
    const out: string[] = [];
    const r = await planCommand(k, SPEC, { print: (l) => out.push(l) });
    expect(r.created).toBeGreaterThan(0);
    expect(out.join("\n")).toContain(`sekhemet approve ${r.epicId}`);
    const planned = await k.cardStore.listCards({ parentId: r.epicId });
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((c) => c.status === "planning")).toBe(true);

    const shown: string[] = [];
    expect(
      await runDevCommand("approve", [r.epicId, "--show"], k, { print: (l) => shown.push(l) }),
    ).toBe(0);
    expect(shown.join("\n")).toContain(`${planned[0]?.id}.c1`);
    expect(
      (await k.cardStore.listCards({ parentId: r.epicId })).every((c) => c.status === "planning"),
    ).toBe(true);

    const said: string[] = [];
    expect(await runDevCommand("approve", [r.epicId], k, { print: (l) => said.push(l) })).toBe(0);
    expect(said.join("\n")).toMatch(/Approved \d+ issues? under the internal tool profile/);
    for (const c of await k.cardStore.listCards({ parentId: r.epicId })) {
      expect(k.cardStore.stagedTests.criteriaApproval(c.id).approved).toBe(true);
      // Out of Planning unless something else holds it, and then it says what.
      if (c.status === "planning") expect(c.blockedReason).not.toMatch(/approval of its criteria/);
    }
  });
});

describe("PM-N3 in the product: the plan reads and records the Worker's record", () => {
  it("records the fitted horizon of a kind with 10 or more attempts", async () => {
    const k = kernel();
    for (let i = 0; i < 12; i += 1) {
      const id = `done_${i}`;
      await k.cardStore.createCard({
        id,
        tier: "story",
        title: id,
        status: "ready",
        kind: "implement",
        difficulty: 2 + (i % 4),
      });
      const a = await k.cardStore.runs.startAttempt({ cardId: id, attemptNumber: 1, modelId: "w" });
      await k.cardStore.runs.finishAttempt({
        attemptId: a.id,
        status: i < 7 ? "passed" : "failed",
        stopReason: i < 7 ? "gate_passed" : "repair_exhausted",
        tokensUsed: 1,
        secondsUsed: 1,
        linesAdded: 20 + i * 15,
      });
    }
    await planCommand(k, SPEC, { print: () => undefined });
    const fitted = await k.log.getEventsByTypes(["capability/fitted"]);
    expect(fitted.map((e) => (e.payload as { kind: string }).kind)).toEqual(["implement"]);
  });
});

describe("PM-N6-4 in the product: sekhemet upgrade", () => {
  it("plans the upgrade card, then a fix card per failing file", async () => {
    const k = kernel();
    writeFileSync(
      join(k.repoPath, "CHANGELOG.left-pad.md"),
      "## [1.1.0]\n- pad throws on negatives.\n",
    );
    const out: string[] = [];
    expect(
      await runDevCommand(
        "upgrade",
        ["left-pad", "1.0.0", "1.1.0", "--changelog", "CHANGELOG.left-pad.md"],
        k,
        { print: (l) => out.push(l) },
      ),
    ).toBe(0);
    expect(out.join("\n")).toContain("pnpm add left-pad@1.1.0");
    const card = (await k.cardStore.listCards()).find((c) => c.change === "upgrade");
    expect(card?.status).toBe("planning");
    const a = await k.cardStore.runs.startAttempt({
      cardId: card?.id as string,
      attemptNumber: 1,
      modelId: "tool",
    });
    await k.cardStore.runs.recordGateResult({
      attemptId: a.id,
      cardId: card?.id as string,
      gate: "unit",
      layer: "functional",
      passed: false,
      exitCode: 1,
      durationMs: 1,
      source: "local",
      failures: [{ gate: "unit", location: { file: "src/pad.ts" }, errorExcerpt: "x" }],
    });
    const fixes: string[] = [];
    await runDevCommand("upgrade", ["fixes", card?.id as string], k, {
      print: (l) => fixes.push(l),
    });
    const child = (await k.cardStore.listCards({ parentId: card?.id as string }))[0];
    expect(child?.change).toBe("fix");
    expect(child?.spec).toContain("1.1.0: - pad throws on negatives.");
  });
});
