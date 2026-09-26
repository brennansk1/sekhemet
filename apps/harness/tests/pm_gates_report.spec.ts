import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { INVARIANT_FORMS } from "../src/architecture_gate.js";
import { dailyStandup } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";

// NEW-gates-1 (GT-N1-1): the PM's report lists the brief's unenforced
// invariants with the forms they could be restated in. NEW-gates-7 (GT-BF-5):
// `GET /api/gates` reports `max_tool_applied_lines` in force. Real SQLite,
// real git, a real server.

const BRIEF = `# Brief

## Invariants
- \`src/db/\` does not import \`src/cli.ts\`
- Amounts are always integer cents.
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(gatesToml?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-gates-")));
  dirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(join(root, ".sekhemet", "brief.md"), BRIEF);
  if (gatesToml) writeFileSync(join(root, ".sekhemet", "gates.toml"), gatesToml);
  return root;
}

function ledger(root: string) {
  const db = new DatabaseSync(join(root, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { db, log, cardStore: new CardStore(db, log) };
}

describe("the PM's report lists the unenforced invariants (GT-N1-1)", () => {
  it("names each line and the two forms it could be restated in", async () => {
    const root = repo();
    const { db, log, cardStore } = ledger(root);
    try {
      const text = await dailyStandup({ repoPath: root, cardStore, pmStore: new PmStore(log) });
      expect(text).toContain("Not enforced (restate as");
      expect(text).toContain('"Amounts are always integer cents."');
      for (const form of INVARIANT_FORMS) expect(text).toContain(form);
      expect(text).not.toContain("src/db/");
    } finally {
      db.close();
    }
  });
});

describe("GET /api/gates reports max_tool_applied_lines in force (GT-BF-5)", () => {
  it("serves the default 500, and the project's value when gates.toml sets one", async () => {
    for (const [toml, want] of [
      [undefined, 500],
      ["[project]\nmax_tool_applied_lines = 750\n", 750],
    ] as const) {
      const root = repo(toml);
      const { db, log, cardStore } = ledger(root);
      const server = await startDashboardServer({
        db,
        log,
        boardService: new BoardServiceImpl(cardStore),
        cardStore,
        repoPath: root,
        port: 0,
        streamIntervalMs: 50,
      });
      try {
        const data = (await (await fetch(`http://127.0.0.1:${server.port}/api/gates`)).json()) as {
          maxToolAppliedLines: number;
        };
        expect(data.maxToolAppliedLines).toBe(want);
      } finally {
        await server.close();
        db.close();
      }
    }
  });
});
