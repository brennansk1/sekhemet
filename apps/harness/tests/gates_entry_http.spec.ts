import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { INVARIANT_FORMS } from "../src/architecture_gate.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * The brief's invariants a person reads (gates rule 26, NEW-gates-1;
 * FINISH_LINE_PLAN C2d): a real dashboard server on a real repository and
 * SQLite ledger, asked over HTTP as the board and Seshat's chat ask it. No
 * model is loaded: the standup comes from the ledger.
 */

const BRIEF = `# Brief

## Invariants
- \`src/db/\` does not import \`src/cli.ts\`
- Amounts are always integer cents.
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("unenforced invariants on the board and in the PM's report (GT-N1-1)", () => {
  it("GT-N1-1: a brief line in neither enforced form is listed as not enforced on the board and in Seshat's standup, with the two forms to restate it in", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gates-http-")));
    dirs.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(join(root, ".sekhemet", "brief.md"), BRIEF);
    const db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    await cardStore.createCard({ id: "c1", tier: "story", title: "Export a week as CSV" });
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: root,
      port: 0,
      streamIntervalMs: 1000,
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      // The board's gates panel.
      const gates = (await (await fetch(`${base}/api/gates`)).json()) as {
        invariants: { notEnforced: { line: string; restate: string[] }[] };
      };
      expect(gates.invariants.notEnforced).toEqual([
        { line: "Amounts are always integer cents.", restate: [...INVARIANT_FORMS] },
      ]);

      // Seshat's standup, asked in the chat.
      const sent = await fetch(`${base}/api/pm/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ text: "/standup" }),
      });
      expect(sent.status).toBe(200);
      let reply = "";
      for (let i = 0; i < 100 && !reply; i++) {
        const thread = (await (await fetch(`${base}/api/pm/thread`)).json()) as {
          messages: { role?: string; author?: string; text: string }[];
        };
        reply = thread.messages.map((m) => m.text).find((t) => t.includes("Not enforced")) ?? "";
        if (!reply) await new Promise((r) => setTimeout(r, 100));
      }
      expect(reply).toContain(
        `Not enforced (restate as ${INVARIANT_FORMS.join(" or ")} for the architecture check to enforce it): "Amounts are always integer cents."`,
      );
      expect(reply).not.toContain("src/db/");
    } finally {
      await server.close();
      db.close();
    }
  }, 60_000);
});
