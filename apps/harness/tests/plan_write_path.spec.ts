import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { statusColumns } from "../src/commands/status.js";
import { toProposals } from "../src/pm/agent.js";
import { applyProposal } from "../src/pm/apply.js";
import { PmStore } from "../src/pm/store.js";
import { refusalOf } from "../src/process_errors.js";
import { reject } from "../src/triage.js";
import { planCommand } from "../src/wave2.js";

/**
 * Wave 9 A1 and A2 (sweep 5): a plan stored its epic In progress before the
 * plan existed — a plan killed mid-write, one whose issues were all
 * rejected, showed an epic *Being built* with nothing to build — and a plan
 * that stopped partway (a full disk) kept its first issues with no plan
 * record and said only *stopped*. A real repository and an on-disk ledger
 * (DEFINITION_OF_DONE §2A); no model is loaded.
 */
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function kernel() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-plan-write-"));
  dirs.push(repoPath);
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), text);
  };
  w("package.json", JSON.stringify({ name: "pages", devDependencies: { vitest: "^3.0.0" } }));
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
  const boardService = new BoardServiceImpl(cardStore, { entryConditions: true });
  return { repoPath, db, log, cardStore, boardService };
}

const SPEC = "Add a hello page that says hello and a goodbye page";
const quiet = { print: () => undefined, offline: true };

describe("wave 9 A1: an epic is stored in Planning, never In progress before its plan", () => {
  it("sekhemet plan stores the epic in Planning, and Status never calls it Being built", async () => {
    const k = kernel();
    const { epicId } = await planCommand(k, SPEC, quiet);
    expect((await k.cardStore.getCard(epicId))?.status).toBe("planning");
    const stories = await k.cardStore.listCards({ parentId: epicId });
    expect(stories.length).toBeGreaterThan(0);
    // Every issue rejected: nothing of it is live, so nothing is being built.
    for (const s of stories) await reject(k, s, "not wanted");
    const columns = statusColumns((await k.boardService.getBoardState()).cards);
    const epic = columns.flatMap((c) => c.issues).find((i) => i.id === epicId);
    expect(epic?.state).toBe("Being planned");
    expect(columns.find((c) => c.name === "In progress")?.issues ?? []).toEqual([]);
  });

  it("an issue Seshat files under a new epic stores that epic in Planning", async () => {
    const k = kernel();
    const pmStore = new PmStore(k.log);
    const [draft] = toProposals(
      [
        {
          id: "1",
          name: "propose_create_card",
          arguments: {
            title: "Say hello on the hello page",
            spec: "The hello page says hello.",
            acceptance_criteria: ["Given the hello page, it shows the word hello"],
            scope_files: ["src/hello.ts"],
            reason: "the first page",
          },
        },
      ],
      [],
    );
    const reply = await pmStore.appendReply({
      replyTo: [],
      text: "x",
      proposals: [draft as never],
    });
    await applyProposal(reply.proposals?.[0] as never, {
      cardStore: k.cardStore,
      boardService: k.boardService,
      pmStore,
      repoPath: k.repoPath,
      actor: "human",
    });
    const epics = (await k.cardStore.listCards()).filter((c) => c.tier === "epic");
    expect(epics.length).toBe(1);
    expect(epics[0]?.status).toBe("planning");
  });
});

describe("wave 9 A2: a plan that stops partway is named, with a next step", () => {
  /** Let the database grow `pages` more pages: then SQLite says it is full (SQLITE_FULL). */
  const fillAfter = (db: DatabaseSync, pages: number) => {
    const { page_count } = db.prepare("PRAGMA page_count").get() as { page_count: number };
    db.exec(`PRAGMA max_page_count = ${page_count + pages}`);
  };

  it("a full disk mid-plan names the unfinished plan's issues and says what to do", async () => {
    const k = kernel();
    // A first plan, so the second's writes are ordinary appends.
    await planCommand(k, "Add a footer page that says footer", quiet);
    let caught: unknown;
    let kept: string[] = [];
    // Find a limit that stops the plan after its epic and before its record.
    for (let pages = 1; pages < 60 && kept.length < 2; pages++) {
      const before = new Set((await k.cardStore.listCards()).map((c) => c.id));
      fillAfter(k.db, pages);
      caught = undefined;
      try {
        await planCommand(k, `${SPEC} ${pages}`, quiet);
      } catch (err) {
        caught = err;
      }
      k.db.exec("PRAGMA max_page_count = 1073741823");
      kept = (await k.cardStore.listCards()).map((c) => c.id).filter((id) => !before.has(id));
      if (!caught) break;
    }
    expect(caught, "no limit stopped the plan partway").toBeDefined();
    expect(kept.length).toBeGreaterThanOrEqual(2);
    const refusal = refusalOf(caught);
    expect(refusal, String(caught)).toBeDefined();
    expect(refusal?.what).toMatch(/the plan stopped partway/i);
    expect(refusal?.what).toMatch(/the disk is full/);
    expect(refusal?.what).toMatch(/no plan was recorded/);
    for (const id of kept) expect(refusal?.what).toContain(id);
    expect(refusal?.next).toMatch(/free some space/);
    expect(refusal?.next).toMatch(/sekhemet reject /);
    // Nothing of it is shown as being built.
    const columns = statusColumns((await k.boardService.getBoardState()).cards);
    const inProgress = columns.find((c) => c.name === "In progress")?.issues ?? [];
    for (const id of kept) expect(inProgress.map((i) => i.id)).not.toContain(id);
  });
});
