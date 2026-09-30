import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ModelHold } from "@sekhemet/models";
import { readBranchFile } from "@sekhemet/sync";
import { SESHAT_MESSAGE_MAX_BYTES } from "@sekhemet/ui";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp.js";
import { runAsk } from "../src/ask_cmd.js";
import { handleMcpRequest } from "../src/mcp.js";
import { attachDocuments } from "../src/pm/documents.js";
import { SESHAT_READER_SYSTEM } from "../src/pm/pm_copy.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

// W2b G1 (planner-pm PM-N10): a person's long message reaches Seshat whole.
// A message or pasted document longer than a comfortable message becomes a
// project document in the repository — committed on the integration branch,
// byte for byte — that Seshat reads through its context budget (in parts
// when its window cannot hold it whole), never cut, and its reply cites it.
// A body over the request cap is refused with its size before anything is
// recorded. Real server, real git, a real SQLite file; no model is loaded.

const PROMPT_MD = readFileSync(
  join(__dirname, "..", "..", "..", "fixtures", "capstone", "timesheet", "prompt.md"),
  "utf8",
);
/** About 20,000 characters: the capstone's frozen prompt, then more of the same. */
const TWENTY_K = `${PROMPT_MD.trim()}\n\n${"Each week closes on Sunday night. ".repeat(60)}`.slice(
  0,
  20_000,
);
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
/** The text inside each attached document's tags in a prompt. */
const between = (text: string) =>
  [...text.matchAll(/<document [^>]*>\n([\s\S]*?)\n<\/document>/g)].map((m) => m[1] ?? "");

describe("PM-N10: long messages to Seshat", () => {
  let repo: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cards: CardStore;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  let window = 32_768;
  /** How long each reading answer's notes are; 0 gives the short default. */
  let noteChars = 0;
  let seen: InferenceRequest[] = [];
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

  const adapter = (): LocalInferenceAdapter => ({
    modelId: "planner-model",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: window, maxTokens: 1200 },
    generate: async (req) => {
      seen.push(req);
      const reading = req.systemPrompt === SESHAT_READER_SYSTEM;
      return {
        text: reading
          ? `Notes on this part (${seen.length}).${noteChars ? ` ${"Each week closes on Sunday. ".repeat(Math.ceil(noteChars / 28))}`.slice(0, noteChars) : ""}`
          : "I read the brief. One question first.",
        toolCalls: [],
        usage,
      };
    },
  });

  const post = async (path: string, body: string | unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  type Doc = {
    id: string;
    name: string;
    chars: number;
    bytes: number;
    sha256: string;
    path?: string;
    fromMessage?: boolean;
    unfiled?: string;
  };
  type Msg = {
    id: string;
    role: string;
    text: string;
    documents?: Doc[];
    cites?: { documentId?: string; label?: string; path?: string }[];
    replyTo?: string[];
  };
  const thread = async (): Promise<Msg[]> =>
    ((await (await fetch(`${base}/api/pm/thread`)).json()) as { messages: Msg[] }).messages;
  const replyAfter = async (count: number): Promise<Msg> => {
    for (let i = 0; i < 200; i++) {
      const pm = (await thread()).filter((m) => m.role === "pm");
      if (pm.length > count) return pm.at(-1) as Msg;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Seshat did not reply");
  };
  const replies = async () => (await thread()).filter((m) => m.role === "pm").length;

  beforeAll(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "pm-long-")));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
    writeFileSync(join(repo, "README.md"), "# Timesheets\n");
    git("add", "-A");
    git("commit", "-q", "-m", "chore: seed");
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cards = new CardStore(db, log);
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cards),
      cardStore: cards,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
      pmAdapter: adapter,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  beforeEach(() => {
    seen = [];
    window = 32_768;
    noteChars = 0;
  });

  it("accepts a 20,000-character message whole, commits it as a project document and reads it whole", async () => {
    expect(TWENTY_K.length).toBe(20_000);
    const before = await replies();
    const headBefore = git("rev-parse", "main");
    const sent = await post("/api/pm/messages", { text: TWENTY_K });
    expect(sent.status).toBe(200);
    const { message, notice } = (await sent.json()) as { message: Msg; notice?: string };
    // Accepted whole: the thread holds every character the person sent.
    expect(message.text).toBe(TWENTY_K.trim());
    const doc = message.documents?.[0] as Doc;
    expect(doc).toMatchObject({ fromMessage: true, chars: TWENTY_K.trim().length });
    expect(doc.path).toMatch(/^docs\/product\/inputs\/\d{4}-\d{2}-\d{2}-.+\.md$/);
    // In the repository, on the integration branch, byte for byte; the checkout untouched.
    expect(readBranchFile(repo, "main", doc.path as string)).toBe(TWENTY_K.trim());
    expect(git("rev-parse", "main^")).toBe(headBefore);
    expect(git("log", "-1", "--format=%B", "main")).toMatch(/Agent-Role: documenter/);
    // The person's files are not written; their checkout on the branch is told how to catch up.
    expect(existsSync(join(repo, doc.path as string))).toBe(false);
    expect(notice).toContain(`read-tree -m -u ${headBefore} main`);

    const reply = await replyAfter(before);
    const asked = seen.find((r) => r.systemPrompt !== SESHAT_READER_SYSTEM);
    const prompt = asked?.prompt ?? "";
    // Read whole, once, through the budget: never cut, never repeated in the message line.
    expect(between(prompt)).toEqual([TWENTY_K.trim()]);
    expect(prompt.split(TWENTY_K.trim().slice(0, 200)).length).toBe(2);
    expect(prompt).toContain(doc.path as string);
    expect(seen.some((r) => r.systemPrompt === SESHAT_READER_SYSTEM)).toBe(false);
    // The reply cites the document.
    expect(reply.cites).toContainEqual(
      expect.objectContaining({ documentId: doc.id, path: doc.path }),
    );
  });

  it("commits a long message's document as the bytes sent, its final newline kept", async () => {
    expect(PROMPT_MD.endsWith("\n")).toBe(true);
    const sent = await post("/api/pm/messages", { text: PROMPT_MD });
    expect(sent.status).toBe(200);
    const { message } = (await sent.json()) as { message: Msg };
    const doc = message.documents?.[0] as Doc;
    expect(doc).toMatchObject({ fromMessage: true, chars: PROMPT_MD.length });
    expect(doc.sha256).toBe(createHash("sha256").update(PROMPT_MD).digest("hex"));
    expect(readBranchFile(repo, "main", doc.path as string)).toBe(PROMPT_MD);
    // The thread shows the person's words without the surrounding whitespace.
    expect(message.text).toBe(PROMPT_MD.trim());
  });

  it("keeps the composer's attached document apart from the person's words, byte for byte", async () => {
    const before = await replies();
    const sent = await post("/api/pm/messages", {
      text: "Here is the brief from the bakery owner.",
      documents: [{ name: "prompt.md", text: PROMPT_MD }],
    });
    expect(sent.status).toBe(200);
    const { message } = (await sent.json()) as { message: Msg };
    expect(message.text).toBe("Here is the brief from the bakery owner.");
    const doc = message.documents?.[0] as Doc;
    expect(doc).toMatchObject({ name: "prompt.md", chars: PROMPT_MD.length });
    expect(doc.fromMessage).toBeUndefined();
    expect(doc.bytes).toBe(Buffer.byteLength(PROMPT_MD));
    expect(doc.path).toMatch(/^docs\/product\/inputs\/\d{4}-\d{2}-\d{2}-prompt\.md$/);
    expect(readBranchFile(repo, "main", doc.path as string)).toBe(PROMPT_MD);
    const reply = await replyAfter(before);
    const prompt = seen.find((r) => r.systemPrompt !== SESHAT_READER_SYSTEM)?.prompt ?? "";
    expect(between(prompt)).toEqual([PROMPT_MD]);
    expect(prompt).toContain("Here is the brief from the bakery owner.");
    expect(reply.cites?.some((c) => c.documentId === doc.id)).toBe(true);
    // The thread gives the reference, never the document's text.
    const listed = (await thread()).find((m) => m.id === message.id);
    expect(JSON.stringify(listed)).not.toContain(PROMPT_MD.slice(0, 300));
    expect(listed?.documents?.[0]).toMatchObject({ id: doc.id, name: "prompt.md" });
  });

  it("reads a document too long for the window in parts, every character, before answering", async () => {
    window = 6144;
    const before = await replies();
    const sent = await post("/api/pm/messages", { text: TWENTY_K });
    expect(sent.status).toBe(200);
    const { message } = (await sent.json()) as { message: Msg };
    const doc = message.documents?.[0] as Doc;
    const reply = await replyAfter(before);
    const reads = seen.filter((r) => r.systemPrompt === SESHAT_READER_SYSTEM);
    expect(reads.length).toBeGreaterThan(1);
    // Every part within the window, and the parts together are the whole text.
    for (const r of reads) {
      expect(Math.ceil(r.prompt.length / 3.2) + (r.maxTokens ?? 0)).toBeLessThan(window);
    }
    expect(reads.flatMap((r) => between(r.prompt)).join("")).toBe(TWENTY_K.trim());
    const answerPrompt = seen.find((r) => r.systemPrompt !== SESHAT_READER_SYSTEM)?.prompt ?? "";
    expect(answerPrompt).toContain(`in ${reads.length} parts`);
    expect(answerPrompt).toContain("Notes on this part");
    expect(answerPrompt).toContain(doc.path as string);
    // The reading is recorded, so a later answer does not read it again.
    const recorded = db
      .prepare("SELECT payload FROM events WHERE type = 'pm/document_read'")
      .all() as { payload: string }[];
    expect(recorded.map((r) => JSON.parse(r.payload))).toContainEqual(
      expect.objectContaining({ document: doc.id, parts: reads.length }),
    );
    expect(reply.cites?.some((c) => c.documentId === doc.id)).toBe(true);
  });

  it("condenses notes too long to sit beside the prompt, so the reply is made from them and cites it", async () => {
    // A 200,000-character brief at Seshat's default window: its notes alone
    // are longer than the prompt can hold, so they are read again, in parts.
    window = 8192;
    noteChars = 2000;
    const big = `${PROMPT_MD.trim()}\n\n`.repeat(11).slice(0, 200_000).trim();
    const before = await replies();
    const sent = await post("/api/pm/messages", { text: big });
    expect(sent.status).toBe(200);
    const doc = ((await sent.json()) as { message: Msg }).message.documents?.[0] as Doc;
    const reply = await replyAfter(before);
    const reads = seen.filter((r) => r.systemPrompt === SESHAT_READER_SYSTEM);
    expect(reads.length).toBeGreaterThan(10);
    const answerPrompt = seen.find((r) => r.systemPrompt !== SESHAT_READER_SYSTEM)?.prompt ?? "";
    // The notes are in the prompt the reply was made from, and it cites the document.
    expect(between(answerPrompt)).toHaveLength(1);
    expect(answerPrompt).toContain("Notes on this part");
    expect(answerPrompt).toContain("condensed");
    expect(reply.cites?.some((c) => c.documentId === doc.id)).toBe(true);
    const recorded = db
      .prepare("SELECT payload FROM events WHERE type = 'pm/document_read'")
      .all() as { payload: string }[];
    const read = recorded.map((r) => JSON.parse(r.payload)).find((p) => p.document === doc.id);
    expect(read?.condensed).toBeGreaterThanOrEqual(1);
  });

  it("never cites a document it could not hold, even as notes, and says so", async () => {
    // Notes that never get shorter than the prompt can hold.
    window = 8192;
    noteChars = 40_000;
    const big = `${PROMPT_MD.trim()}\n\n`.repeat(3).trim();
    const before = await replies();
    const sent = await post("/api/pm/messages", { text: big });
    expect(sent.status).toBe(200);
    const doc = ((await sent.json()) as { message: Msg }).message.documents?.[0] as Doc;
    const reply = await replyAfter(before);
    const answerPrompt = seen.find((r) => r.systemPrompt !== SESHAT_READER_SYSTEM)?.prompt ?? "";
    expect(between(answerPrompt)).toHaveLength(0);
    expect((reply.cites ?? []).some((c) => c.documentId === doc.id)).toBe(false);
    expect(reply.text).toContain(`could not fit "${doc.name}"`);
    expect(reply.text).toContain(doc.path as string);
  });

  it("reads a long message as a document, never routing it by a phrase inside it", async () => {
    const before = await replies();
    // "assign … to" and a status word inside a brief are the brief's words, not a request.
    const text = `Status: please assign the night shift to Maria.\n\n${TWENTY_K}`.slice(0, 20_000);
    expect((await post("/api/pm/messages", { text })).status).toBe(200);
    const reply = await replyAfter(before);
    expect(reply.text).toBe("I read the brief. One question first.");
  });

  it("refuses a body over the request cap with its size, before anything is recorded", async () => {
    const messages = (await thread()).length;
    const head = git("rev-parse", "main");
    const huge = JSON.stringify({ text: "x".repeat(SESHAT_MESSAGE_MAX_BYTES + 10) });
    const sent = await post("/api/pm/messages", huge);
    expect(sent.status).toBe(413);
    const body = (await sent.json()) as { error: string; bytes?: number; limitBytes: number };
    expect(body.error).toContain("1 MB");
    expect(body.error).toContain("Nothing was sent");
    expect(body.limitBytes).toBe(SESHAT_MESSAGE_MAX_BYTES);
    expect(body.bytes).toBe(Buffer.byteLength(huge));
    expect((await thread()).length).toBe(messages);
    expect(git("rev-parse", "main")).toBe(head);
  });

  it("keeps a character split across two network chunks whole", async () => {
    const headers = await pageWriteHeaders(base);
    const text = `Pay = minutes × rate ÷ 60. ${"é".repeat(12_000)}`;
    const body = Buffer.from(JSON.stringify({ text }));
    // Split inside the two bytes of the first "é".
    const at = body.indexOf(Buffer.from("é")) + 1;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${base}/api/pm/messages`,
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Content-Length": String(body.length),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write(body.subarray(0, at));
      setTimeout(() => req.end(body.subarray(at)), 50);
    });
    expect(status).toBe(200);
    const held = (await thread()).filter((m) => m.role === "user").at(-1);
    expect(held?.text).toBe(text);
  });

  it("refuses more documents than one message carries, plainly", async () => {
    const sent = await post("/api/pm/messages", {
      text: "Many",
      documents: Array.from({ length: 11 }, (_, i) => ({ name: `${i}.md`, text: "x" })),
    });
    expect(sent.status).toBe(400);
    expect(((await sent.json()) as { error: string }).error).toContain("11 documents");
  });

  it("posts a long weekly update whole", async () => {
    const project = (await cards.ensureProject({ rootPath: repo, name: "Timesheets" })).id;
    const sent = await post(`/api/projects/${project}/update`, { text: TWENTY_K });
    expect(sent.status).toBe(200);
    const posted = (await log.getEventsByTypes(["project/update_posted"])).at(-1);
    expect((posted?.private as { text?: string } | undefined)?.text).toBe(TWENTY_K.trim());
  });

  it("keeps a long message whole from every door: sekhemet ask, the MCP tool and the editor", async () => {
    const pmStore = new PmStore(log);
    const acquire = async () =>
      ({ role: "chat", adapter: adapter(), release: () => {} }) as unknown as ModelHold;
    const code = await runAsk(TWENTY_K, {
      repoPath: repo,
      cardStore: cards,
      pmStore,
      pmModel: "planner-model",
      acquire,
      say: () => {},
    });
    expect(code).toBe(0);
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "sekhemet_ask_seshat", arguments: { text: TWENTY_K } },
      },
      { db, log, cardStore: cards, boardService: new BoardServiceImpl(cards), repoPath: repo },
    );
    const agent = new AcpAgent({
      repoPath: repo,
      cardStore: cards,
      pmStore,
      pmModel: "planner-model",
      acquire,
      send: () => {},
    });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: repo } });
    await agent.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "sess_1", prompt: [{ type: "text", text: TWENTY_K }] },
    });
    const doors = ["terminal", "mcp", "editor"];
    const sent = (await pmStore.thread()).filter(
      (m) => m.role === "user" && doors.includes(m.context?.view ?? ""),
    );
    expect(sent.map((m) => m.context?.view)).toEqual(doors);
    for (const m of sent) {
      expect(m.text).toBe(TWENTY_K.trim());
      expect(m.documents?.[0]).toMatchObject({ fromMessage: true, chars: 20_000 });
      expect(readBranchFile(repo, "main", m.documents?.[0]?.path ?? "")).toBe(TWENTY_K.trim());
    }
  });

  it("keeps a long issue comment to @Seshat whole, as a project document, from the comment door too", async () => {
    const card = await cards.createCard({ tier: "task", title: "Payroll CSV", status: "backlog" });
    const before = await replies();
    const text = `@Seshat here is the brief the bakery sent.\n\n${TWENTY_K}`;
    const sent = await post(`/api/cards/${card.id}/comments`, { text });
    expect(sent.status).toBe(200);
    // The checkout is on main, which the document's commit moved: the route
    // says how it catches up, and the issue page shows it (commentPostedToasts).
    const { notice } = (await sent.json()) as { notice?: string };
    expect(notice).toMatch(/is on main, which moved to .*read-tree -m -u \S+ main/);
    const asked = (await thread()).filter((m) => m.role === "user").at(-1) as Msg;
    // Every character reaches Seshat, and the long comment is committed like any long message.
    expect(asked.text).toBe(text.trim());
    const doc = asked.documents?.[0] as Doc;
    expect(doc).toMatchObject({ fromMessage: true, chars: text.trim().length });
    expect(readBranchFile(repo, "main", doc.path as string)).toBe(text.trim());
    await replyAfter(before);
    // The comment itself is kept whole too.
    const listed = (await (await fetch(`${base}/api/cards/${card.id}/comments`)).json()) as {
      comments: { text: string }[];
    };
    const mine = listed.comments.filter((c) => c.text.startsWith("@Seshat here is the brief"));
    expect(mine.map((c) => c.text)).toEqual([text.trim()]);
  });

  it("refuses an issue comment over the request cap in the same words, before anything is recorded", async () => {
    const card = await cards.createCard({ tier: "task", title: "Night shift", status: "backlog" });
    const messages = (await thread()).length;
    const huge = JSON.stringify({ text: `@Seshat ${"x".repeat(SESHAT_MESSAGE_MAX_BYTES + 10)}` });
    const sent = await post(`/api/cards/${card.id}/comments`, huge);
    expect(sent.status).toBe(413);
    const body = (await sent.json()) as { error: string; limitBytes: number };
    expect(body.error).toContain("1 MB");
    expect(body.error).toContain("Nothing was sent");
    expect(body.limitBytes).toBe(SESHAT_MESSAGE_MAX_BYTES);
    expect((await thread()).length).toBe(messages);
  });

  it("keeps a document with the conversation when the repository has no commit yet", async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "pm-long-empty-")));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: empty });
      const {
        documents: [kept],
      } = await attachDocuments(
        { repoPath: empty, cardStore: cards, log },
        [{ name: "brief.md", text: TWENTY_K }],
        cards.localPrincipal(),
      );
      expect(kept?.ref.path).toBeUndefined();
      expect(kept?.ref.unfiled).toBe("no_commit");
      expect(kept?.ref.chars).toBe(20_000);
      expect(kept?.text).toBe(TWENTY_K);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("says why a document was not added when the commit fails, and keeps it with the conversation", async () => {
    // Another writer holds the branch's lock: the commit cannot land.
    const lock = join(repo, ".git", "refs", "heads", "main.lock");
    writeFileSync(lock, "");
    try {
      const {
        documents: [kept],
      } = await attachDocuments(
        { repoPath: repo, cardStore: cards, log },
        [{ name: "brief.md", text: TWENTY_K }],
        cards.localPrincipal(),
      );
      expect(kept?.ref.path).toBeUndefined();
      expect(kept?.ref.unfiled).toBe("commit_failed");
      expect(kept?.text).toBe(TWENTY_K);
      // The reason reaches the ledger with the message, as a word, not an error text.
      const message = await new PmStore(log).appendUserMessage("Here it is.", undefined, "human", [
        kept as NonNullable<typeof kept>,
      ]);
      expect(message.documents?.[0]?.unfiled).toBe("commit_failed");
      const listed = (await thread()).find((m) => m.id === message.id);
      expect(listed?.documents?.[0]).toMatchObject({ unfiled: "commit_failed" });
    } finally {
      rmSync(lock, { force: true });
    }
  });
});
