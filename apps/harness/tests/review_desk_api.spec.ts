import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, checklistRowsFor, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordReviewOpened } from "../src/accept.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { reviewDesk } from "../src/review_desk.js";
import { startDashboardServer } from "../src/server.js";

/**
 * dashboard NEW-dashboard-5 on a real server: `GET /api/cards/:id/review`
 * carries what Review needs to keep Accept honest before it is pressed — the
 * Reviewer's findings (DB-N5-2, -3), the Implementation files Accept counts
 * and those already shown (DB-N5-3), whether the viewer may accept and who
 * may instead (DB-N5-9), who built the card (DB-N5-4), and each staged test's
 * approval state under the depth profile (DB-N5-8). Real SQLite file and
 * real evidence on the ledger (DoD §2A).
 */
describe("the review desk API (NEW-dashboard-5)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  let me: string;
  let server: { port: number; close: () => Promise<void> };
  const base = () => `http://127.0.0.1:${server.port}`;
  const holders: string[] = [];

  async function inReview(
    id: string,
    files: string[],
    builtBy?: { kind: "worker" | "person"; id: string },
  ): Promise<void> {
    await store.createCard({
      id,
      tier: "story",
      title: `Card ${id}`,
      scopeFiles: ["src/**"],
      acceptanceCriteria: ["adds two numbers"],
      criterionIds: ["AC-1"],
    });
    const evidence = {
      id: `ev_${id}`,
      cardId: id,
      attempt: 1,
      passed: true,
      rungResults: [{ gate: "unit", passed: true }],
      filesTouched: files,
    };
    const body = `${JSON.stringify(evidence)}\n`;
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "evidence", `${evidence.id}.json`), body);
    await recordLedgerRun(store, {
      cardId: id,
      modelId: "nail",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: evidence.id,
      path: join(".sekhemet", "evidence", `${evidence.id}.json`),
      body,
      filesTouched: files,
      ...(builtBy ? { builtBy } : {}),
    });
    await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
  }

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-review-desk-"));
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    const log = new EventLog(db, { acceptHolders: () => holders });
    store = new CardStore(db, log);
    me = store.localPrincipal();
    holders.push(me, "p_bob");
    await store.depthProfiles.choose(
      {
        profile: "regulated",
        checklist: Object.fromEntries(
          checklistRowsFor("regulated").map((row) => [row, { title: row, invariant: row }]),
        ),
      },
      me,
    );

    // A card the viewer delegated to the Worker, with an unmet finding.
    await inReview("card_w", ["src/a.ts", "src/b.ts", "tests/a.test.ts"]);
    await store.delegateCard("card_w", { kind: "worker" }, me);
    await store.recordDossierEntry({
      cardId: "card_w",
      kind: "review",
      actor: "reviewer",
      verdict: "unmet",
      text: "criterion 1 unmet: src/a.ts:2 adds the wrong operand",
      sources: ["src/a.ts"],
    });
    await store.recordDossierEntry({
      cardId: "card_w",
      kind: "review",
      actor: "reviewer",
      verdict: "consider",
      text: "- [consider] prefer const",
    });
    await recordReviewOpened(
      { repoPath: repo, cardStore: store, boardService: new BoardServiceImpl(store) },
      (await store.getCard("card_w")) as never,
      ["src/b.ts"],
      me,
    );
    const sha = (c: string) => c.repeat(64);
    await store.stagedTests.stage({
      cardId: "card_w",
      path: "acceptance/a.spec.ts",
      sha256: sha("a"),
      author: "planner",
      cases: [{ name: "adds", criterionId: "AC-1" }],
    });
    await store.stagedTests.stage({
      cardId: "card_w",
      path: "acceptance/b.spec.ts",
      sha256: sha("b"),
      author: "planner",
      cases: [{ name: "adds", criterionId: "AC-1" }],
    });
    await store.stagedTests.approveTest(
      { cardId: "card_w", path: "acceptance/a.spec.ts", sha256: sha("a"), what: "file" },
      me,
    );
    await store.stagedTests.approveTest(
      { cardId: "card_w", path: "acceptance/b.spec.ts", sha256: sha("b"), what: "file" },
      me,
    );
    // b's content changed after its approval: the approval is void.
    await store.stagedTests.stage({
      cardId: "card_w",
      path: "acceptance/b.spec.ts",
      sha256: sha("c"),
      author: "planner",
      cases: [{ name: "adds", criterionId: "AC-1" }],
    });

    // A card Bob built by hand.
    await inReview("card_p", ["src/c.ts"], { kind: "person", id: "p_bob" });
    await store.delegateCard("card_p", { kind: "person", id: "p_bob" }, me);
    // A card the Worker built, delegated to Bob only afterwards.
    await inReview("card_d", ["src/d.ts"]);
    await store.delegateCard("card_d", { kind: "person", id: "p_bob" }, me);

    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { reviewMinutesPerDay: 60 }),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const desk = async (id: string) => {
    const res = await fetch(`${base()}/api/cards/${id}/review`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  it("DB-N5-2, DB-N5-3: the Reviewer's findings with the files it read, and the files Accept counts and has seen", async () => {
    const d = await desk("card_w");
    expect(d.findings).toEqual([
      {
        id: expect.any(String),
        verdict: "unmet",
        text: "criterion 1 unmet: src/a.ts:2 adds the wrong operand",
        filesRead: ["src/a.ts"],
      },
      { id: expect.any(String), verdict: "consider", text: "- [consider] prefer const" },
    ]);
    expect(d.implementationFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(d.filesShown).toEqual(["src/b.ts"]);
  });

  it("DB-N5-9: the delegator may not accept on a team, and is told who may", async () => {
    expect((await desk("card_w")).accept).toEqual({
      may: false,
      code: "not_independent",
      because: "delegated",
      who: [{ principal: "p_bob" }],
    });
  });

  it("DB-N5-8: each staged test's approval state under the regulated profile", async () => {
    expect((await desk("card_w")).testApprovals).toEqual([
      {
        path: "acceptance/a.spec.ts",
        approved: true,
        approvedSha256: "a".repeat(64),
        what: "file",
        by: expect.any(String),
      },
      {
        path: "acceptance/b.spec.ts",
        approved: false,
        approvedSha256: "b".repeat(64),
        what: "file",
        by: expect.any(String),
      },
    ]);
  });

  it("DB-N5-4: a person-built card names its builder; a Worker-built one names none", async () => {
    expect((await desk("card_p")).builtBy).toEqual({ kind: "person", id: "p_bob" });
    expect((await desk("card_w")).builtBy).toBeUndefined();
    // Delegated to a person after the Worker built it: still the Worker's work.
    expect((await desk("card_d")).builtBy).toBeUndefined();
    expect((await desk("card_p")).accept).toEqual({ may: true });
  });

  it("answers 404 for an unknown card", async () => {
    expect((await fetch(`${base()}/api/cards/card_nope/review`)).status).toBe(404);
  });
});

/**
 * NEW-dashboard-3 and NEW-dashboard-5 in the Team setup (PM-N9-8): a running
 * card's streamed output and its review desk reach only the people who can
 * see its project — the text never arrives in anyone else's browser.
 */
describe("live output and the review desk stay inside the project (Team)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };
  const base = () => `http://127.0.0.1:${server.port}`;
  const as = (principal: string) => ({ headers: { "X-Test-Principal": principal } });

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-review-team-"));
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    const joined = (principal: string, level: string, pending = false) =>
      log.appendNow({
        actor: "system",
        type: "member/joined",
        principal,
        payload: { principal, level, via: "invite", pending },
      });
    joined("p_admin", "admin");
    joined("p_member", "member");
    // Not yet approved: no level anywhere, so no project is theirs to see.
    joined("p_pending", "member", true);
    const project = (await store.ensureProject({ rootPath: join(repo, "chronicle"), name: "C" }))
      .id;
    await store.createCard({
      id: "card_run",
      tier: "story",
      title: "Running",
      status: "in_progress",
      projectId: project,
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
      setup: "team",
      requester: (req) => {
        const h = req.headers["x-test-principal"];
        return typeof h === "string" && h ? h : undefined;
      },
      pressureLevel: () => 1,
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  /** What one stream receives, for at most `ms`, or until a tokens frame. */
  async function listen(principal: string, ms: number, started: Promise<unknown>) {
    const ctrl = new AbortController();
    const res = await fetch(`${base()}/api/stream`, { ...as(principal), signal: ctrl.signal });
    const reader = res.body?.getReader();
    await started;
    let text = "";
    const deadline = Date.now() + ms;
    while (reader && !text.includes("event: tokens") && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ late: true }>((r) =>
          setTimeout(() => r({ late: true }), deadline - Date.now()),
        ),
      ]);
      if ("late" in next || next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    ctrl.abort();
    return text;
  }

  it("NEW-dashboard-3: streams a running card's output to its project's people only", async () => {
    let go: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      go = r;
    });
    const member = listen("p_member", 2000, started);
    const outsider = listen("p_pending", 800, started);
    await new Promise((r) => setTimeout(r, 100));
    mkdirSync(join(repo, ".sekhemet", "live"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "live", "card_run.txt"), "const secret = readFile(");
    go();
    const [seen, hidden] = await Promise.all([member, outsider]);
    expect(seen).toContain("event: tokens");
    expect(seen).toContain("const secret");
    expect(hidden).not.toContain("event: tokens");
    expect(hidden).not.toContain("const secret");
  });

  it("NEW-dashboard-5: the review desk answers 404 to a person who cannot see the card's project", async () => {
    expect((await fetch(`${base()}/api/cards/card_run/review`, as("p_member"))).status).toBe(200);
    const hidden = await fetch(`${base()}/api/cards/card_run/review`, as("p_pending"));
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "No issue card_run" });
  });
});

/**
 * RG-N5-4 on the review desk: where a code owner must accept, the page's
 * verdict is Accept's own — a viewer who owns none of the files sees Accept
 * disabled with the owners, never an enabled button the server then refuses.
 */
describe("the review desk and the code-owner rule (RG-N5-4)", () => {
  it("answers not_code_owner, naming the owners, to a viewer who owns none of the files", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sekhemet-review-owner-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "e@x");
      git("config", "user.name", "E");
      writeFileSync(join(repo, "CODEOWNERS"), "src/** @alice-gh\n");
      git("add", "-A");
      git("commit", "-q", "-m", "owners");
      mkdirSync(join(repo, ".sekhemet"), { recursive: true });
      writeFileSync(
        join(repo, ".sekhemet", "config.toml"),
        '[review]\nintegration_branch = "main"\nrequire_code_owner_accept = true\n',
      );
      const db = new DatabaseSync(join(repo, "events.db"));
      initSchema(db);
      const log = new EventLog(db, { acceptHolders: () => ["p_alice", "p_bob"] });
      const store = new CardStore(db, log);
      await store.linkIdentity("p_alice", "github", "alice-gh", "p_alice");
      await store.createCard({ id: "o1", tier: "story", title: "O", scopeFiles: ["src/**"] });
      const evidence = {
        id: "ev_o1",
        cardId: "o1",
        attempt: 1,
        passed: true,
        rungResults: [{ gate: "unit", passed: true }],
        filesTouched: ["src/b.ts"],
      };
      const body = `${JSON.stringify(evidence)}\n`;
      mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
      writeFileSync(join(repo, ".sekhemet", "evidence", "ev_o1.json"), body);
      await recordLedgerRun(store, {
        cardId: "o1",
        modelId: "nail",
        passed: true,
        stopReason: "gate_passed",
        evidenceId: "ev_o1",
        path: join(".sekhemet", "evidence", "ev_o1.json"),
        body,
        filesTouched: ["src/b.ts"],
      });
      await store.updateCardStatus("o1", "review", "verified", "harness", { override: true });
      const ctx = {
        repoPath: repo,
        cardStore: store,
        boardService: new BoardServiceImpl(store) as never,
        eventLog: log,
      };
      const card = (await store.getCard("o1")) as never;
      const opts = { acceptHolders: ["p_alice", "p_bob"], nameOf: () => undefined };
      expect((await reviewDesk(ctx, card, "p_bob", opts)).accept).toEqual({
        may: false,
        code: "not_code_owner",
        who: [{ principal: "p_alice" }],
      });
      expect((await reviewDesk(ctx, card, "p_alice", opts)).accept).toEqual({ may: true });
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
