import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { acceptBrief } from "@sekhemet/planner";
import { afterEach, describe, expect, it } from "vitest";
import { type RepoContext, planCommand } from "../src/wave2.js";

// B4.3 wiring of part 1A in `sekhemet plan`:
// - PM-P13-2: once a person has accepted the project's brief, a story that
//   traces to none of its requirements is offered as a proposed change, never
//   given a requirement derived from the spec;
// - PM-12..14: the plan's Small check runs at the resolved Worker's window.
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function kernel(): RepoContext {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-plan-b43-"));
  dirs.push(repoPath);
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), text);
  };
  w("src/recipes.ts", "export const recipes: string[] = [];\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: init");
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

describe("sekhemet plan after a brief is accepted (PM-P13-2)", () => {
  it("derives no requirement from the spec: an untraced story becomes a proposed change", async () => {
    const k = kernel();
    const projectId = (await k.cardStore.ensureProject({ rootPath: k.repoPath, name: "Recipes" }))
      .id;
    const ledger = { store: k.cardStore, log: k.log, board: new BoardServiceImpl(k.cardStore) };
    await acceptBrief(
      ledger,
      {
        projectId,
        baseline: "Recipes live in a shared spreadsheet",
        slices: [
          {
            title: "Walking skeleton",
            appetite: { cards: 6 },
            requirements: [{ key: "save", title: "Save a recipe" }],
          },
        ],
      },
      "p_owner",
    );
    const before = (await k.cardStore.requirements.list()).length;
    const out: string[] = [];
    await planCommand(k, "Export every invoice to a PDF file with the company logo.", {
      print: (l) => out.push(l),
    });
    expect((await k.cardStore.requirements.list()).length).toBe(before);
    expect(out.join("\n")).toMatch(/proposed change/i);
  });
});
