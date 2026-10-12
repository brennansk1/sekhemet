import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { issueTypeOf } from "@sekhemet/ui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CsvError, importPreview, parseCsv } from "../src/import_board.js";
import { exportBoard, toCsv } from "../src/integrations.js";
import { applyProposal } from "../src/pm/apply.js";
import { PmStore } from "../src/pm/store.js";

/**
 * Loop wave 6, builder A (sweep 3, the Import sheet): an import names every
 * row it leaves out and every value it does not keep, proposes a repeated
 * row once, previews the type it will apply, and says what it does in words.
 */
describe("what an import leaves out is named (W6 A3)", () => {
  it("names a row with no title, invalid values, a cut title and a repeated row", () => {
    const csv = toCsv([
      ["Title", "Priority", "Estimate", "Due"],
      ["  spaces around  ", "9", "-3", "1999-01-01"],
      ["  spaces around  ", "9", "-3", "1999-01-01"],
      ["", "2", "3", ""],
      ["A".repeat(520), "", "", "someday"],
      ["Plain row", "2", "3", ""],
    ]);
    const { drafts, notes } = importPreview("linear-csv", csv, []);
    expect(drafts.map((d) => d.cards?.[0]?.title)).toEqual([
      "spaces around",
      "A".repeat(300),
      "Plain row",
    ]);
    const all = notes.join("\n");
    expect(all).toMatch(/Line 4 has no title/);
    expect(all).toMatch(/Line 3 is the same as line 2/);
    expect(all).toMatch(/Line 2: priority “9”/);
    expect(all).toMatch(/Line 2: estimate “-3”/);
    expect(all).toMatch(/Line 5: the title is 520 characters; the first 300 are kept/);
    expect(all).toMatch(/Line 5: due date “someday”/);
    // Nothing internal: no field keys, no JSON.
    expect(all).not.toMatch(/dueDate|externalRef|\{/);
  });

  it("names the line of a row with a quoted line break correctly", () => {
    const csv = 'Title,Description\n"A","two\nlines"\n,"no title"\n';
    const { notes } = importPreview("linear-csv", csv, []);
    expect(notes.join("\n")).toMatch(/Line 4 has no title/);
  });

  it("an item with no title in a JSON file is named too", () => {
    const { drafts, notes } = importPreview(
      "json",
      JSON.stringify([{ title: "A" }, { body: "x" }]),
    );
    expect(drafts).toHaveLength(1);
    expect(notes.join("\n")).toMatch(/Item 2 has no title/);
  });
});

describe("a file that cannot be read says so once, in words (W6 A5)", () => {
  it("names the line of an unclosed quote without the parser's own words", () => {
    let err: unknown;
    try {
      parseCsv('Summary\n"never closed\n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CsvError);
    expect((err as Error).message).toBe(
      "Line 2 has a quote that opens and never closes. Close that quote, then try again.",
    );
  });
});

describe("the preview's type is the type Apply creates; words, not field names (W6 A1, A4)", () => {
  let dir: string;
  let db: DatabaseSync;
  let cards: CardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "import-notes-"));
    db = new DatabaseSync(join(dir, "ledger.db"));
    initSchema(db);
    cards = new CardStore(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("each Jira type previews and applies as the same type; a parent link is named, not kept", async () => {
    const csv = toCsv([
      ["Issue key", "Summary", "Issue Type", "Parent"],
      ["SEK-1", "A story", "Story", ""],
      ["SEK-2", "A subtask", "Subtask", "SEK-1"],
      ["SEK-3", "A task", "Task", ""],
      ["SEK-4", "A bug", "Bug", ""],
      ["SEK-5", "A spike", "Spike", ""],
      ["SEK-6", "An improvement", "Improvement", ""],
    ]);
    const { drafts, notes } = importPreview("jira-csv", csv, []);
    const previewed = drafts.map((d) => issueTypeOf(d.cards?.[0] as never));
    expect(previewed).toEqual(["story", "task", "task", "bug", "spike", "task"]);
    expect(notes.join("\n")).toMatch(/Line 3: its parent SEK-1 is not linked/);
    expect(notes.join("\n")).toMatch(/Line 7: issue type “Improvement”/);
    const pm = new PmStore(new EventLog(db));
    const reply = await pm.appendReply({ replyTo: [], text: "Import", proposals: drafts });
    const ctx = { cardStore: cards, boardService: new BoardServiceImpl(cards), pmStore: pm };
    const applied: string[] = [];
    for (const p of reply.proposals ?? []) {
      const { cards: made } = await applyProposal(p as never, ctx);
      applied.push(issueTypeOf(made[0] as never));
    }
    expect(applied).toEqual(previewed);
  });

  it("a round trip of our own export says, in words, that it links each issue and changes nothing else", async () => {
    await cards.createCard({ tier: "task", title: "HTTP API", status: "backlog" });
    const board = await cards.listCards();
    const { drafts, notes } = importPreview(
      "jira-csv",
      exportBoard(board, [], "jira-csv").body,
      board,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.summary).toBe("Link “HTTP API” to Jira");
    expect(notes.join("\n")).toMatch(/already an issue here.*nothing else changes/i);
  });

  it("a round trip of an epic and its story claims no lost parent, and names no card id (W6 review)", async () => {
    const epic = await cards.createCard({ tier: "epic", title: "Epic one", status: "backlog" });
    await cards.createCard({
      tier: "story",
      title: "Story one",
      status: "backlog",
      epicId: epic.id,
    });
    const board = await cards.listCards();
    const { notes } = importPreview("jira-csv", exportBoard(board, [], "jira-csv").body, board);
    const all = notes.join("\n");
    expect(all).not.toMatch(/parent/i);
    expect(all).not.toMatch(/card_/);
    expect(all).toMatch(/already an issue here.*nothing else changes/i);
  });

  it("a new row whose parent is a Sekhemet issue names that issue by its title, never its id (W6 review)", async () => {
    const epic = await cards.createCard({ tier: "epic", title: "Epic one", status: "backlog" });
    const board = await cards.listCards();
    const csv = toCsv([
      ["Issue key", "Summary", "Issue Type", "Parent"],
      ["NEW-1", "A new story", "Story", epic.id],
      ["NEW-2", "An orphan", "Story", "card_gone0000"],
    ]);
    const all = importPreview("jira-csv", csv, board).notes.join("\n");
    expect(all).toMatch(/Line 2: its parent “Epic one” is not linked/);
    expect(all).toMatch(/Line 3: its parent is not linked/);
    expect(all).not.toMatch(/card_/);
  });
});
