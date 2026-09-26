import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl, type CardTransition } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcceptRefusedError,
  acceptCard,
  checkoutNotice,
  enableAutoAccept,
  gateStatusOf,
  recordReviewOpened,
  revertAccept,
} from "../src/accept.js";
import { submitTakenOver, takeOver } from "../src/collaborate.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { autoAcceptRefusal } from "../src/measure_cmd.js";
import { reject, reopen, sendBack } from "../src/triage.js";

// A switch to make the restack after Accept fail, to see its failure reported.
const restack = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/execute.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/execute.js")>();
  return {
    ...real,
    restackAfterAccept: (...args: Parameters<typeof real.restackAfterAccept>) =>
      restack.fail
        ? Promise.reject(new Error("the restack broke"))
        : real.restackAfterAccept(...args),
  };
});

/**
 * review-git S5 and NEW-review-git-5 end to end: a real repository, a real
 * ledger, real worktrees (DEFINITION_OF_DONE §2A).
 */
let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let board: BoardServiceImpl;
let adapter: NodeGitSyncAdapter;
let holders: string[] | undefined;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

function open(): void {
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, holders ? { acceptHolders: () => holders ?? [] } : {});
  store = new CardStore(db, log);
  board = new BoardServiceImpl(store, { entryConditions: true, customLimits: { review: 5 } });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-accept-h-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, "src/shared.ts", "export const shared = 1;\n");
  write(repo, ".gitignore", ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  holders = undefined;
  open();
  adapter = new NodeGitSyncAdapter(repo);
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

/** Every byte of the person's checkout that Accept must not touch. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {
    HEAD: readFileSync(join(repo, ".git", "HEAD"), "utf8"),
    index: readFileSync(join(repo, ".git", "index")).toString("base64"),
  };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === ".sekhemet") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(repo, path)] = readFileSync(path).toString("base64");
    }
  };
  walk(repo);
  return out;
}

interface Built {
  files: Record<string, string>;
  rungs?: { gate: string; rung: string; layer: string; passed: boolean; skipped?: boolean }[];
  showFiles?: boolean;
}

/** A card built on its branch, verified, with its evidence on the ledger, in Review. */
async function inReview(id: string, built: Built): Promise<void> {
  await store.createCard({ id, tier: "story", title: `Card ${id}`, scopeFiles: ["src/**"] });
  const wt = await adapter.createWorktree(id, "main", `Card ${id}`);
  for (const [f, t] of Object.entries(built.files)) write(wt, f, t);
  await adapter.commitCheckpoint({
    cardId: id,
    step: 1,
    gateStatus: "pass",
    agentModel: "nail",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });
  const rungs = built.rungs ?? [{ gate: "unit", rung: "test", layer: "functional", passed: true }];
  const evidence = {
    id: `ev_${id}`,
    cardId: id,
    attempt: 1,
    passed: rungs.every((r) => r.passed || r.skipped),
    rungResults: rungs.map((r) => ({ ...r, exitCode: r.passed ? 0 : 1, durationMs: 12 })),
    filesTouched: Object.keys(built.files),
    linesAdded: Object.keys(built.files).length,
    linesRemoved: 0,
    settings: { modelId: "nail" },
    stopReason: "gate_passed",
    repoState: await adapter.getRepoStateHash(id),
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
  writeFileSync(join(repo, ".sekhemet", "evidence", `${evidence.id}.json`), body);
  await recordLedgerRun(store, {
    cardId: id,
    modelId: "nail",
    passed: evidence.passed,
    stopReason: "gate_passed",
    evidenceId: evidence.id,
    path: join(".sekhemet", "evidence", `${evidence.id}.json`),
    body,
    filesTouched: evidence.filesTouched,
  });
  await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
  if (built.showFiles !== false) {
    const card = await store.getCard(id);
    if (card)
      await recordReviewOpened({ repoPath: repo, cardStore: store, boardService: board }, card, [
        ...Object.keys(built.files),
      ]);
  }
}

const ctx = () => ({ repoPath: repo, cardStore: store, boardService: board });
const card = async (id: string) => {
  const c = await store.getCard(id);
  if (!c) throw new Error(`no ${id}`);
  return c;
};
const refusal = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("RG-S5-1/2/3/7: Accept merges with plumbing, then moves the card, as one step", () => {
  it("§2.5.5: a restack that fails after Accept is reported, not swallowed; the accept stands", async () => {
    await inReview("c10", { files: { "src/b.ts": "export const b = 2;\n" } });
    const lines: string[] = [];
    restack.fail = true;
    try {
      const sha = await acceptCard(
        { ...ctx(), report: (l: string) => lines.push(l) },
        await card("c10"),
      );
      expect(git("rev-parse", "main")).toBe(sha);
    } finally {
      restack.fail = false;
    }
    expect((await card("c10")).status).toBe("done");
    expect(lines.join("\n")).toMatch(/restack.*c10.*the restack broke/i);
  });

  it("RG-S5-1, RG-S5-7: squashes onto main with the checkout untouched and real trailers", async () => {
    await inReview("c1", { files: { "src/b.ts": "export const b = 2;\n" } });
    const before = snapshot();
    const sha = await acceptCard(ctx(), await card("c1"));
    expect(snapshot()).toEqual(before);
    expect(git("rev-parse", "main")).toBe(sha);
    expect((await card("c1")).status).toBe("done");
    const msg = git("log", "-1", "--format=%B", sha);
    expect(msg).toContain("GateStatus: pass");
    expect(msg).toContain("Accepted-by: Jane Doe <jane@example.com>");
    expect(msg).toMatch(/Ledger-Head: \d+:[0-9a-f]{64}/);
    expect(msg).toContain("Agent-Model: nail");
    // §2.5.3: the move and card/accepted committed together.
    const events = await store.cardEvents("c1", ["card/status_changed", "card/accepted"]);
    const done = events.find((e) => (e.payload as { toStatus?: string }).toStatus === "done");
    const accepted = events.find((e) => e.type === "card/accepted");
    expect(accepted?.seq).toBe((done?.seq ?? 0) + 1);
    expect(accepted?.payload).toMatchObject({
      sha,
      principal: store.localPrincipal(),
      independent: false,
      gateStatus: "pass",
    });
  });

  it("RG-S5-7: GateStatus comes from the evidence — a skipped gate is partial", async () => {
    await inReview("c7", {
      files: { "src/b.ts": "export const b = 2;\n" },
      rungs: [
        { gate: "unit", rung: "test", layer: "functional", passed: true },
        { gate: "visual", rung: "visual", layer: "functional", passed: false, skipped: true },
      ],
    });
    const sha = await acceptCard(ctx(), await card("c7"));
    expect(git("log", "-1", "--format=%B", sha)).toContain("GateStatus: partial");
  });

  it("RG-S5-2: accepts while the checkout is dirty and on another branch", async () => {
    await inReview("c2", { files: { "src/b.ts": "export const b = 2;\n" } });
    git("checkout", "-q", "-b", "mine");
    write(repo, "src/a.ts", "export const a = 5; // unsaved\n");
    const before = snapshot();
    const sha = await acceptCard(ctx(), await card("c2"));
    expect(snapshot()).toEqual(before);
    expect(git("rev-parse", "main")).toBe(sha);
  });

  it("RG-S5-3: a board that refuses the move leaves main where it was and the card in Review", async () => {
    await inReview("c3", { files: { "src/b.ts": "export const b = 2;\n" } });
    const old = git("rev-parse", "main");
    // Another person parks the card between the checks and the move.
    const racing = new (class extends BoardServiceImpl {
      override async transitionCard(t: CardTransition): Promise<void> {
        if (t.toStatus === "done") {
          await store.updateCardStatus(t.cardId, "parked", "a person parked it", "human");
        }
        return super.transitionCard(t);
      }
    })(store, { entryConditions: true });
    const err = await refusal(acceptCard({ ...ctx(), boardService: racing }, await card("c3")));
    expect(err).toBeInstanceOf(Error);
    expect(git("rev-parse", "main")).toBe(old);
    expect(await store.cardEvents("c3", ["card/accepted"])).toEqual([]);
  });
});

describe("RG-S5-4/5/6: nothing merges that conflicts, races or changed after review", () => {
  it("RG-S5-4: a conflicting squash writes nothing and names the files", async () => {
    await inReview("c4", { files: { "src/shared.ts": "export const shared = 2;\n" } });
    write(repo, "src/shared.ts", "export const shared = 3;\n");
    git("commit", "-q", "-am", "main moved");
    const moved = git("rev-parse", "main");
    const before = snapshot();
    const err = await refusal(acceptCard(ctx(), await card("c4")));
    expect(err).toBeInstanceOf(AcceptRefusedError);
    expect((err as AcceptRefusedError).code).toBe("conflict");
    expect((err as Error).message).toContain("src/shared.ts");
    expect(git("rev-parse", "main")).toBe(moved);
    expect(snapshot()).toEqual(before);
    expect((await card("c4")).status).toBe("review");
  });

  it("RG-S5-5: two accepts at once complete one and refuse the other, never losing an update", async () => {
    await inReview("c5", { files: { "src/b.ts": "export const b = 2;\n" } });
    await inReview("c6", { files: { "src/c.ts": "export const c = 3;\n" } });
    const results = await Promise.allSettled([
      acceptCard(ctx(), await card("c5")),
      acceptCard(ctx(), await card("c6")),
    ]);
    const done = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(done).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/another accept/i);
    const tree = git("ls-tree", "-r", "--name-only", "main");
    expect([tree.includes("src/b.ts"), tree.includes("src/c.ts")].filter(Boolean)).toHaveLength(1);
    // The refused one goes through next, and main then holds both.
    const waiting = (await card("c5")).status === "review" ? "c5" : "c6";
    await acceptCard(ctx(), await card(waiting));
    const both = git("ls-tree", "-r", "--name-only", "main");
    expect(both).toContain("src/b.ts");
    expect(both).toContain("src/c.ts");
  });

  it("RG-S5-5: the integration branch moving between the preview and the lock refuses, writing nothing", async () => {
    await inReview("c9", { files: { "src/b.ts": "export const b = 2;\n" } });
    const take = NodeGitSyncAdapter.prototype.withAcceptLock;
    // Another accept lands while this one waits for the lock.
    const spy = vi
      .spyOn(NodeGitSyncAdapter.prototype, "withAcceptLock")
      .mockImplementation(async function (this: NodeGitSyncAdapter, fn) {
        write(repo, "src/other.ts", "export const other = 1;\n");
        git("add", "-A");
        git("commit", "-q", "-m", "another accept landed");
        return take.call(this, fn) as never;
      });
    try {
      const err = await refusal(acceptCard(ctx(), await card("c9")));
      expect((err as Error).message).toMatch(/moved since the preview/);
      expect(git("log", "-1", "--format=%s", "main")).toBe("another accept landed");
      expect((await card("c9")).status).toBe("review");
    } finally {
      spy.mockRestore();
    }
  });

  it("RG-S5-6: a card whose branch moved after its evidence is refused as changed after review", async () => {
    await inReview("c8", { files: { "src/b.ts": "export const b = 2;\n" } });
    const wt = join(repo, ".sekhemet", "worktrees", "c8");
    write(wt, "src/b.ts", "export const b = 99;\n");
    await adapter.commitCheckpoint({
      cardId: "c8",
      step: 2,
      gateStatus: "partial",
      agentModel: "nail",
      agentHarness: "sekhemet",
      agentRole: "implementer",
    });
    const old = git("rev-parse", "main");
    const err = await refusal(acceptCard(ctx(), await card("c8")));
    expect((err as AcceptRefusedError).code).toBe("changed_after_review");
    expect((err as Error).message).toMatch(/changed after it was reviewed/);
    expect(git("rev-parse", "main")).toBe(old);
  });
});

describe("RG-S5-8/9: auto-accept is a person's recorded standing decision", () => {
  const marker = () =>
    writeFileSync(
      join(repo, ".sekhemet", "measurement.json"),
      JSON.stringify({ purpose: "frozen suite", by: "test", createdAt: new Date().toISOString() }),
    );

  it("RG-S5-8: records actor harness, auto: true and the enabling person; refuses without one", async () => {
    marker();
    db.close();
    open();
    board = new BoardServiceImpl(store, {
      entryConditions: true,
      measurementMarker: { purpose: "frozen suite" },
    });
    await inReview("a1", { files: { "src/b.ts": "export const b = 2;\n" }, showFiles: false });
    const err = await refusal(acceptCard(ctx(), await card("a1"), "harness"));
    expect((err as AcceptRefusedError).code).toBe("no_enabling_person");
    expect((await card("a1")).status).toBe("review");

    const run = await enableAutoAccept(store);
    const sha = await acceptCard(ctx(), await card("a1"), "harness", { autoRun: run });
    const [accepted] = await store.cardEvents("a1", ["card/accepted"]);
    expect(accepted?.actor).toBe("harness");
    expect(accepted?.payload).toMatchObject({ auto: true, principal: store.localPrincipal() });
    expect(git("log", "-1", "--format=%B", sha)).toContain(
      "Accepted-by: sekhemet --auto-accept (for Jane Doe <jane@example.com>)",
    );
    const [enabled] = await store.eventsOfType(["review/auto_accept_enabled"]);
    expect(enabled?.payload).toEqual({ principal: store.localPrincipal(), run });
  });

  it("RG-S5-9: --auto-accept is refused in the Team setup, even where a measured run prepared the repository", () => {
    marker();
    expect(autoAcceptRefusal(["queue", "--auto-accept"], repo, "solo")).toBeUndefined();
    expect(autoAcceptRefusal(["queue", "--auto-accept"], repo, "team")).toMatch(/Team setup/);
  });
});

describe("RG-S5-10/11/12: revert, reject, reopen, and send-back only from Review or Parked", () => {
  it("RG-S5-10: reverting an accept adds a revert commit, moves the card to Ready, records both shas", async () => {
    await inReview("r1", { files: { "src/b.ts": "export const b = 2;\n" } });
    const sha = await acceptCard(ctx(), await card("r1"));
    const before = snapshot();
    const revert = await revertAccept(ctx(), await card("r1"), "broke the build");
    expect(snapshot()).toEqual(before);
    expect(git("rev-parse", "main")).toBe(revert);
    expect(git("ls-tree", "-r", "--name-only", "main")).not.toContain("src/b.ts");
    expect((await card("r1")).status).toBe("ready");
    const [reverted] = await store.cardEvents("r1", ["card/reverted"]);
    expect(reverted?.payload).toMatchObject({ sha, revertSha: revert });
    expect(reverted?.private).toEqual({ reason: "broke the build" });
  });

  it("RG-S5-11: reject requires a reason and moves to Rejected; reopen moves to Ready", async () => {
    await inReview("r2", { files: { "src/b.ts": "export const b = 2;\n" } });
    const t = { ...ctx(), log };
    await expect(reject(t, await card("r2"), "  ")).rejects.toThrow(/reason/);
    expect((await card("r2")).status).toBe("review");
    await reject(t, await card("r2"), "not what we need");
    expect((await card("r2")).status).toBe("rejected");
    await reopen(t, await card("r2"));
    expect((await card("r2")).status).toBe("ready");
  });

  it("RG-S5-12: send-back from In progress or Verify is refused naming abort", async () => {
    await store.createCard({ id: "r3", tier: "story", title: "R3", status: "in_progress" });
    const t = { ...ctx(), log };
    await expect(sendBack(t, await card("r3"), "wrong approach")).rejects.toThrow(/abort/);
    await store.updateCardStatus("r3", "verify", "x", "harness", { override: true });
    await expect(sendBack(t, await card("r3"), "wrong approach")).rejects.toThrow(/abort/);
    expect((await card("r3")).status).toBe("verify");
  });
});

describe("RG-S5-2 follow-up: a checkout on the integration branch is told how to catch up", () => {
  it("names the checkout on main and a command that fast-forwards its files, keeping unsaved work", async () => {
    await inReview("f1", { files: { "src/b.ts": "export const b = 2;\n" } });
    write(repo, "src/shared.ts", "export const shared = 9; // unsaved\n");
    const sha = await acceptCard(ctx(), await card("f1"));
    const notice = checkoutNotice(repo, "main", sha);
    expect(notice).toBeDefined();
    expect(notice).not.toContain("\n");
    expect(notice).toContain(realpathSync(repo));
    // The command it names brings the files up to date and keeps the edit.
    const cmd = /`(git [^`]+)`/.exec(notice ?? "")?.[1] ?? "";
    expect(cmd).toMatch(/^git -C /);
    execFileSync("sh", ["-c", cmd], { cwd: repo });
    expect(readFileSync(join(repo, "src/b.ts"), "utf8")).toBe("export const b = 2;\n");
    expect(git("status", "--porcelain")).toBe("M src/shared.ts");
  });

  it("names a linked worktree on main, and says nothing when no checkout is on main", async () => {
    await inReview("f2", { files: { "src/b.ts": "export const b = 2;\n" } });
    git("checkout", "-q", "-b", "mine");
    const sha = await acceptCard(ctx(), await card("f2"));
    expect(checkoutNotice(repo, "main", sha)).toBeUndefined();
    const linked = mkdtempSync(join(tmpdir(), "sek-accept-wt-"));
    rmSync(linked, { recursive: true, force: true });
    git("worktree", "add", "-q", linked, "main");
    try {
      const notice = checkoutNotice(repo, "main", sha) ?? "";
      expect(notice).toContain(realpathSync(linked));
      expect(notice).not.toContain(`${realpathSync(repo)} `);
    } finally {
      git("worktree", "remove", "--force", linked);
    }
  });
});

describe("RG-S5-14: the integration branch is configurable", () => {
  it("merges into develop when the project names it", async () => {
    git("branch", "develop");
    write(repo, ".sekhemet/config.toml", '[review]\nintegration_branch = "develop"\n');
    // The runner cuts from the integration branch; here, by hand, as it would.
    await inReview("d2", { files: { "src/b.ts": "export const b = 2;\n" } });
    const mainBefore = git("rev-parse", "main");
    const sha = await acceptCard(ctx(), await card("d2"));
    expect(git("rev-parse", "develop")).toBe(sha);
    expect(git("rev-parse", "main")).toBe(mainBefore);
  });
});

describe("NEW-review-git-5: who may accept (independent accept, O11) and the light friction", () => {
  const alice = "p_alice";
  const bob = "p_bob";
  const carol = "p_carol";

  it("RG-N5-2: one Accept-holder may accept a card they delegated, recorded independent: false", async () => {
    holders = [alice];
    db.close();
    open();
    await inReview("n1", { files: { "src/b.ts": "export const b = 2;\n" }, showFiles: false });
    await store.delegateCard("n1", { kind: "worker" }, alice);
    await recordReviewOpened(ctx(), await card("n1"), ["src/b.ts"], alice);
    await acceptCard(ctx(), await card("n1"), "human", { principal: alice });
    const [accepted] = await store.cardEvents("n1", ["card/accepted"]);
    expect(accepted?.payload).toMatchObject({ principal: alice, independent: false });
  });

  it("RG-N5-1, RG-N5-8: on a team the delegator may not accept, whoever owns it now; another holder may, independent: true", async () => {
    holders = [alice, bob, carol];
    db.close();
    open();
    await inReview("n2", { files: { "src/b.ts": "export const b = 2;\n" }, showFiles: false });
    await store.delegateCard("n2", { kind: "worker" }, alice);
    await store.changeOwner("n2", bob, alice);
    for (const p of [alice, bob])
      await recordReviewOpened(ctx(), await card("n2"), ["src/b.ts"], p);
    const err = await refusal(acceptCard(ctx(), await card("n2"), "human", { principal: alice }));
    expect((err as AcceptRefusedError).code).toBe("not_independent");
    expect((err as Error).message).toContain(bob);
    expect((err as Error).message).toContain(carol);
    expect((err as Error).message).not.toMatch(new RegExp(`may accept: .*${alice}`));
    await acceptCard(ctx(), await card("n2"), "human", { principal: bob });
    const [accepted] = await store.cardEvents("n2", ["card/accepted"]);
    expect(accepted?.payload).toMatchObject({ principal: bob, independent: true });
  });

  it("RG-N5-8: a new delegation by Bob makes Bob the delegator from then on", async () => {
    holders = [alice, bob];
    db.close();
    open();
    await inReview("n3", { files: { "src/b.ts": "export const b = 2;\n" }, showFiles: false });
    await store.delegateCard("n3", { kind: "worker" }, alice);
    await store.delegateCard("n3", null, bob);
    await store.delegateCard("n3", { kind: "worker" }, bob);
    await recordReviewOpened(ctx(), await card("n3"), ["src/b.ts"], bob);
    const err = await refusal(acceptCard(ctx(), await card("n3"), "human", { principal: bob }));
    expect((err as AcceptRefusedError).code).toBe("not_independent");
    await recordReviewOpened(ctx(), await card("n3"), ["src/b.ts"], alice);
    await acceptCard(ctx(), await card("n3"), "human", { principal: alice });
  });

  it("RG-N5-1: the person who built a card may not accept it on a team", async () => {
    holders = [alice, bob];
    db.close();
    open();
    await inReview("n4", { files: { "src/b.ts": "export const b = 2;\n" }, showFiles: false });
    await store.delegateCard("n4", { kind: "person", id: bob }, alice);
    await recordReviewOpened(ctx(), await card("n4"), ["src/b.ts"], bob);
    const err = await refusal(acceptCard(ctx(), await card("n4"), "human", { principal: bob }));
    expect((err as AcceptRefusedError).code).toBe("not_independent");
    expect((err as Error).message).toMatch(/built/);
  });

  it("RG-N5-1, WL-N10-3: a person who took a card over and submitted it may not accept it on a team", async () => {
    holders = [alice, bob];
    db.close();
    open();
    write(
      repo,
      ".sekhemet/gates.toml",
      `[project]\nmax_files = 5\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    await store.createCard({ id: "n8", tier: "story", title: "Card n8", scopeFiles: ["src/**"] });
    const execCtx = {
      ...ctx(),
      boardService: new BoardServiceImpl(store, {
        entryConditions: true,
        evidenceFor: () => ({ passed: true, gatesRun: 1 }),
      }),
      restrictedMode: false,
      log: () => {},
      headroomCheck: false,
    };
    const { worktreePath } = await takeOver(execCtx, "n8", bob);
    write(worktreePath, "src/b.ts", "export const b = 2;\n");
    const submitted = await submitTakenOver(execCtx, "n8", bob);
    expect(submitted.passed).toBe(true);
    expect(await store.buildersOf("n8")).toContain(bob);
    await recordReviewOpened(ctx(), await card("n8"), ["src/b.ts"], bob);
    const err = await refusal(acceptCard(ctx(), await card("n8"), "human", { principal: bob }));
    expect((err as AcceptRefusedError).code).toBe("not_independent");
    expect((err as Error).message).toMatch(/built/);
  });

  it("RG-N5-7: a second Accept-holder makes the project a team from then on; earlier records stay", async () => {
    holders = [alice];
    db.close();
    open();
    await inReview("n5", { files: { "src/b.ts": "export const b = 2;\n" }, showFiles: false });
    await inReview("n6", { files: { "src/c.ts": "export const c = 3;\n" }, showFiles: false });
    for (const id of ["n5", "n6"]) {
      await store.delegateCard(id, { kind: "worker" }, alice);
      await recordReviewOpened(
        ctx(),
        await card(id),
        [id === "n5" ? "src/b.ts" : "src/c.ts"],
        alice,
      );
    }
    await acceptCard(ctx(), await card("n5"), "human", { principal: alice });
    const before = (await store.cardEvents("n5", ["card/accepted"]))[0];
    holders.push(bob); // granted now
    const err = await refusal(acceptCard(ctx(), await card("n6"), "human", { principal: alice }));
    expect((err as AcceptRefusedError).code).toBe("not_independent");
    expect((await store.cardEvents("n5", ["card/accepted"]))[0]).toEqual(before);
    expect((before?.payload as { independent: boolean }).independent).toBe(false);
  });

  it("refuses a principal who does not hold the Accept permission, naming who may", async () => {
    holders = [alice];
    db.close();
    open();
    await inReview("n7", { files: { "src/b.ts": "export const b = 2;\n" }, showFiles: false });
    const err = await refusal(acceptCard(ctx(), await card("n7"), "human", { principal: bob }));
    expect((err as AcceptRefusedError).code).toBe("not_permitted");
    expect((err as Error).message).toContain(alice);
  });

  it("RG-N5-5: an unshown Implementation file or an unacknowledged unmet finding refuses Accept, naming them", async () => {
    await inReview("f1", {
      files: { "src/b.ts": "export const b = 2;\n", "tests/b.test.ts": "// t\n" },
      showFiles: false,
    });
    const finding = await store.recordDossierEntry({
      cardId: "f1",
      kind: "review",
      actor: "reviewer",
      verdict: "unmet",
      text: "criterion 2 is not exercised",
    });
    let err = await refusal(acceptCard(ctx(), await card("f1")));
    expect((err as AcceptRefusedError).code).toBe("unacknowledged");
    expect((err as Error).message).toContain("src/b.ts");
    expect((err as Error).message).not.toContain("tests/b.test.ts");
    expect((err as Error).message).toContain(finding.entryId);
    await recordReviewOpened(ctx(), await card("f1"), ["src/b.ts"]);
    err = await refusal(acceptCard(ctx(), await card("f1")));
    expect((err as Error).message).toContain(finding.entryId);
    expect((err as Error).message).not.toContain("src/b.ts");
    const sha = await acceptCard(ctx(), await card("f1"), "human", {
      acknowledgedFindings: [finding.entryId],
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // RG-S6-6: the decision is recorded with the acknowledged findings.
    const [decided] = await store.cardEvents("f1", ["review/decided"]);
    expect(decided?.payload).toMatchObject({
      decision: "accept",
      acknowledgedFindings: [finding.entryId],
      principal: store.localPrincipal(),
    });
    expect(typeof (decided?.payload as { minutes: number }).minutes).toBe("number");
  });

  it("RG-N5-6: a person-built card meets the same entry conditions — a failing gate refuses Review without an override", async () => {
    await store.createCard({ id: "pb", tier: "story", title: "PB", scopeFiles: ["src/**"] });
    await store.delegateCard(
      "pb",
      { kind: "person", id: store.localPrincipal() },
      store.localPrincipal(),
    );
    const body = `${JSON.stringify({ id: "ev_pb", passed: false, rungResults: [{ gate: "unit", passed: false }] })}\n`;
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "evidence", "ev_pb.json"), body);
    await recordLedgerRun(store, {
      cardId: "pb",
      modelId: "person",
      passed: false,
      stopReason: "repair_exhausted",
      evidenceId: "ev_pb",
      path: join(".sekhemet", "evidence", "ev_pb.json"),
      body,
    });
    await store.updateCardStatus("pb", "verify", "x", "harness", { override: true });
    const withEvidence = new BoardServiceImpl(store, {
      entryConditions: true,
      evidenceFor: () => ({ passed: false, gatesRun: 1 }),
    });
    await expect(
      withEvidence.transitionCard({
        cardId: "pb",
        fromStatus: "verify",
        toStatus: "review",
        actor: "human",
      }),
    ).rejects.toThrow(/did not pass every gate/);
    expect((await card("pb")).status).toBe("verify");
  });
});

describe("GateStatus from the evidence (RG-S5-7)", () => {
  const ok = { gate: "unit", passed: true };
  it("a gate that could not run is unavailable, never fail", () => {
    const down = { gate: "gitleaks", passed: false, unavailable: true };
    expect(gateStatusOf({ passed: true, rungResults: [ok, down] })).toBe("unavailable");
    expect(gateStatusOf({ passed: false, rungResults: [ok, down] })).toBe("unavailable");
  });
  it("a gate that failed is fail, even beside an unavailable one", () => {
    expect(
      gateStatusOf({
        passed: false,
        rungResults: [
          { gate: "unit", passed: false },
          { gate: "gitleaks", passed: false, unavailable: true },
        ],
      }),
    ).toBe("fail");
    expect(gateStatusOf({ passed: true, rungResults: [ok] })).toBe("pass");
    expect(
      gateStatusOf({
        passed: true,
        rungResults: [ok, { gate: "e2e", passed: false, skipped: true }],
      }),
    ).toBe("partial");
  });
});
