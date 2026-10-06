import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStartTime } from "@sekhemet/sandbox";
import { describe, expect, it } from "vitest";
import {
  BIN,
  type G6Repo,
  cliIn,
  eventsOf,
  g6Repo,
  inReview,
  lastSeq,
  localPrincipal,
  statusOf,
  typesSince,
  write,
} from "./support/g6_review.js";

/**
 * review-git S5, NEW-review-git-5 and NEW-review-git-8 through the built
 * command (C2d, FINDINGS_C1 TST-01): `sekhemet accept`, `reject`, `reopen`,
 * `send-back` and `revert` spawned as a person types them, in a real
 * repository with a real ledger (DEFINITION_OF_DONE §2A). `accept_safe.spec.ts`
 * proves the same rules on the functions; here they hold at the door.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const B = { "src/b.ts": "export const b = 2;\n" };

const execGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** Files on `rev` holding a conflict marker (`git grep` exits 1 when there are none). */
const markersOn = (r: G6Repo, rev: string) =>
  spawnSync("git", ["grep", "-l", "-e", "^<<<<<<< ", "-e", "^>>>>>>> ", rev], {
    cwd: r.repo,
    encoding: "utf8",
  }).stdout.trim();

/** The built command, started without waiting for it (two at once, or one to kill). */
function acceptAsync(r: G6Repo, id: string): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(process.execPath, [BIN, "accept", id], {
    cwd: r.repo,
    env: r.env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)));
  return { child, done };
}

describe("RG-S5-1, RG-S5-2, RG-S5-7: `sekhemet accept` squashes onto the integration branch and leaves the checkout alone", () => {
  it("RG-S5-1, RG-S5-7: the person's HEAD, index and files are byte-identical; the squash carries GateStatus, Accepted-by and Ledger-Head", async () => {
    const r = g6Repo();
    await inReview(r, "c1", { files: B });
    const before = r.snapshot();
    const out = cliIn(r, ["accept", "c1"]);
    expect(out.status, out.stderr).toBe(0);
    expect(r.snapshot()).toEqual(before);
    const sha = r.git("rev-parse", "main");
    expect(out.stdout).toContain(sha.slice(0, 10));
    expect(r.git("show", "main:src/b.ts")).toBe("export const b = 2;");
    const msg = r.git("log", "-1", "--format=%B", "main");
    expect(msg).toContain("GateStatus: pass");
    expect(msg).toContain("Accepted-by: Jane Doe <jane@example.com>");
    expect(msg).toMatch(/Ledger-Head: \d+:[0-9a-f]{64}/);
    expect(await statusOf(r, "c1")).toBe("done");
    const [accepted] = await eventsOf(r, "c1", ["card/accepted"]);
    expect(accepted?.payload).toMatchObject({
      sha,
      gateStatus: "pass",
      principal: await localPrincipal(r),
    });
  });

  it("RG-S5-7: GateStatus is read from the evidence: a skipped gate makes it partial", async () => {
    const r = g6Repo();
    await inReview(r, "c2", {
      files: B,
      rungs: [
        { gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 },
        {
          gate: "visual",
          rung: "visual",
          layer: "functional",
          passed: false,
          skipped: true,
          exitCode: 0,
        },
      ],
    });
    const out = cliIn(r, ["accept", "c2"]);
    expect(out.status, out.stderr).toBe(0);
    expect(r.git("log", "-1", "--format=%B", "main")).toContain("GateStatus: partial");
  });

  it("RG-S5-2: accepts while the person's checkout is dirty and on another branch, touching none of it", async () => {
    const r = g6Repo();
    await inReview(r, "c3", { files: B });
    r.git("checkout", "-q", "-b", "mine");
    write(r.repo, "src/a.ts", "export const a = 5; // unsaved\n");
    write(r.repo, "notes.txt", "untracked\n");
    const before = r.snapshot();
    const out = cliIn(r, ["accept", "c3"]);
    expect(out.status, out.stderr).toBe(0);
    expect(r.snapshot()).toEqual(before);
    expect(r.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("mine");
    expect(r.git("status", "--porcelain")).toBe("M src/a.ts\n?? notes.txt");
    expect(r.git("show", "main:src/b.ts")).toBe("export const b = 2;");
  });
});

describe("RG-S5-3, RG-S5-4, RG-S5-6, RG-N8-1: nothing merges that the board refuses, that conflicts, or that changed after review", () => {
  it("RG-S5-3, RG-N8-1: the board refusing the move to Done leaves the integration branch where it was and the card In review", async () => {
    const r = g6Repo();
    // A security gate failed on the latest evidence: the board's door to Done refuses it (B12).
    await inReview(r, "c1", {
      files: B,
      passed: true,
      rungs: [
        { gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 },
        { gate: "secrets", rung: "lint", layer: "security", passed: false, exitCode: 1 },
      ],
    });
    const old = r.git("rev-parse", "main");
    const out = cliIn(r, ["accept", "c1"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/security gate/);
    expect(r.git("rev-parse", "main")).toBe(old);
    expect(await statusOf(r, "c1")).toBe("review");
    const events = await eventsOf(r, "c1", [
      "card/accept_started",
      "card/accept_failed",
      "card/accepted",
    ]);
    expect(events.map((e) => e.type)).toEqual(["card/accept_started", "card/accept_failed"]);
    expect(events[1]?.payload).toMatchObject({ reason: "refused", integration: "main" });
  });

  it("RG-S5-4, RG-N8-1: a squash that conflicts with a moved integration branch writes no commit, no markers, names the file, and records accept_failed", async () => {
    const r = g6Repo();
    await inReview(r, "c4", { files: { "src/shared.ts": "export const shared = 2;\n" } });
    write(r.repo, "src/shared.ts", "export const shared = 3;\n");
    r.git("commit", "-q", "-am", "main moved");
    const moved = r.git("rev-parse", "main");
    const before = r.snapshot();
    const out = cliIn(r, ["accept", "c4", "--json"]);
    expect(out.status).toBe(1);
    expect(JSON.parse(out.stdout.trim())).toMatchObject({ accepted: false, refusal: "conflict" });
    expect(out.stderr).toContain("src/shared.ts");
    expect(r.git("rev-parse", "main")).toBe(moved);
    expect(r.snapshot()).toEqual(before);
    // No conflict markers anywhere: not in the checkout, not on any branch.
    expect(markersOn(r, "main")).toBe("");
    const branch = r.git("branch", "--list", "--format=%(refname:short)", "sekhemet/*c4*");
    expect(markersOn(r, branch)).toBe("");
    expect(readFileSync(join(r.repo, "src/shared.ts"), "utf8")).toBe("export const shared = 3;\n");
    const wt = join(r.repo, ".sekhemet", "worktrees", "c4", "src", "shared.ts");
    if (existsSync(wt)) expect(readFileSync(wt, "utf8")).not.toMatch(/<<<<<<<|>>>>>>>/);
    expect(await statusOf(r, "c4")).toBe("review");
    const events = await eventsOf(r, "c4", ["card/accept_started", "card/accept_failed"]);
    expect(events.map((e) => e.type)).toEqual(["card/accept_started", "card/accept_failed"]);
    expect(events[0]?.payload).toMatchObject({
      base: moved,
      integration: "main",
      branchHead: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(events[1]?.payload).toMatchObject({ reason: "conflict" });
  }, 60_000);

  it("RG-N8-1: a clean accept records accept_started with the integration head, the card branch and its head and the squash's tree, before card/accepted", async () => {
    const r = g6Repo();
    await inReview(r, "c5", { files: B });
    const base = r.git("rev-parse", "main");
    const branch = r.git("branch", "--list", "--format=%(refname:short)", "sekhemet/*c5*");
    expect(branch).toMatch(/^sekhemet\/.*c5/);
    const branchHead = r.git("rev-parse", branch);
    expect(cliIn(r, ["accept", "c5"]).status).toBe(0);
    const [started, accepted] = await eventsOf(r, "c5", ["card/accept_started", "card/accepted"]);
    expect(started?.type).toBe("card/accept_started");
    expect(started?.payload).toMatchObject({
      base,
      branch,
      branchHead,
      squashTree: r.git("rev-parse", "main^{tree}"),
      integration: "main",
    });
    expect(accepted?.type).toBe("card/accepted");
    expect(accepted?.seq).toBeGreaterThan(started?.seq ?? Number.POSITIVE_INFINITY);
  });

  it("RG-S5-6: a card whose branch moved after its evidence is refused as changed after it was reviewed", async () => {
    const r = g6Repo();
    await inReview(r, "c6", { files: B });
    const wt = join(r.repo, ".sekhemet", "worktrees", "c6");
    write(wt, "src/b.ts", "export const b = 99;\n");
    execGit(wt, "commit", "-q", "-am", "a change nobody reviewed");
    const old = r.git("rev-parse", "main");
    const out = cliIn(r, ["accept", "c6", "--json"]);
    expect(out.status).toBe(1);
    expect(JSON.parse(out.stdout.trim())).toMatchObject({ refusal: "changed_after_review" });
    expect(out.stderr).toMatch(/changed after it was reviewed/);
    expect(r.git("rev-parse", "main")).toBe(old);
    expect(await statusOf(r, "c6")).toBe("review");
  });
});

describe("RG-S5-5: two accepts at once never lose an update", () => {
  it("RG-S5-5: two `sekhemet accept` processes for one project: one completes, the other is refused or waits, and main holds both changes or exactly one", async () => {
    const r = g6Repo();
    await inReview(r, "c1", { files: { "src/b.ts": "export const b = 2;\n" } });
    await inReview(r, "c2", { files: { "src/c.ts": "export const c = 3;\n" } });
    const one = acceptAsync(r, "c1");
    const two = acceptAsync(r, "c2");
    const codes = await Promise.all([one.done, two.done]);
    expect(codes.filter((c) => c === 0).length).toBeGreaterThanOrEqual(1);
    const tree = r.git("ls-tree", "-r", "--name-only", "main").split("\n");
    const statuses = [await statusOf(r, "c1"), await statusOf(r, "c2")];
    // What main holds is exactly what the board says was accepted: no lost update.
    expect(tree.includes("src/b.ts")).toBe(statuses[0] === "done");
    expect(tree.includes("src/c.ts")).toBe(statuses[1] === "done");
    expect(codes.map((c) => c === 0)).toEqual(statuses.map((s) => s === "done"));
    // The refused one goes through next, and main then holds both.
    for (const [i, id] of ["c1", "c2"].entries()) {
      if (statuses[i] === "review") expect(cliIn(r, ["accept", id]).status).toBe(0);
    }
    const both = r.git("ls-tree", "-r", "--name-only", "main");
    expect(both).toContain("src/b.ts");
    expect(both).toContain("src/c.ts");
    expect(r.git("rev-list", "--count", "main")).toBe("3");
  }, 60_000);
});

describe("RG-N8-4: the accept lock is judged by pid and process start time", () => {
  it("RG-N8-4: a lock whose pid is alive but was recycled (another start time) is taken over; one held by the live process itself refuses", async () => {
    const r = g6Repo();
    await inReview(r, "c1", { files: B });
    const lock = join(r.repo, ".git", "sekhemet-accept.lock");
    // This test's own process is alive; the lock names it with another start time.
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        processStart: "Thu Jan 1 00:00:00 1970",
        at: new Date().toISOString(),
      }),
    );
    const taken = cliIn(r, ["accept", "c1"]);
    expect(taken.status, taken.stderr).toBe(0);
    expect(await statusOf(r, "c1")).toBe("done");
    expect(existsSync(lock)).toBe(false);

    await inReview(r, "c2", { files: { "src/c.ts": "export const c = 3;\n" } });
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        processStart: processStartTime(process.pid),
        at: new Date().toISOString(),
      }),
    );
    const held = cliIn(r, ["accept", "c2"]);
    expect(held.status).toBe(1);
    expect(held.stderr).toMatch(/another accept/i);
    expect(await statusOf(r, "c2")).toBe("review");
    expect(r.git("ls-tree", "-r", "--name-only", "main")).not.toContain("src/c.ts");
  }, 60_000);
});

describe("RG-S5-9: --auto-accept is refused in the Team setup", () => {
  it("RG-S5-9: `sekhemet queue --auto-accept` on a Team install is refused before any card runs, even where a measured run prepared the repository", async () => {
    const r = g6Repo();
    await inReview(r, "c1", { files: B });
    write(
      r.repo,
      ".sekhemet/measurement.json",
      JSON.stringify({ purpose: "frozen suite", by: "test", createdAt: new Date().toISOString() }),
    );
    r.userConfig('[team]\nmode = "team"\n');
    const before = await lastSeq(r);
    const out = cliIn(r, ["queue", "--auto-accept"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/Team setup/);
    expect(await statusOf(r, "c1")).toBe("review");
    // Nothing ran: no attempt, no acceptance, no standing decision recorded.
    const after = await typesSince(r, before);
    expect(
      after.filter((t) => /^(card|review|attempt|runner)\//.test(t)),
      after.join(" "),
    ).toEqual([]);
  });
});

describe("RG-S5-10, RG-S5-11, RG-S5-12: revert, reject, reopen and send-back from the command line", () => {
  it("RG-S5-10: `sekhemet revert` adds a revert commit of the squash, moves the card to Ready and records both shas", async () => {
    const r = g6Repo();
    await inReview(r, "c1", { files: B });
    expect(cliIn(r, ["accept", "c1"]).status).toBe(0);
    const sha = r.git("rev-parse", "main");
    const before = r.snapshot();
    const out = cliIn(r, ["revert", "c1", "broke", "the", "build"]);
    expect(out.status, out.stderr).toBe(0);
    const revert = r.git("rev-parse", "main");
    expect(revert).not.toBe(sha);
    expect(r.git("rev-parse", "main^")).toBe(sha);
    expect(r.git("ls-tree", "-r", "--name-only", "main")).not.toContain("src/b.ts");
    expect(r.snapshot()).toEqual(before);
    expect(out.stdout).toContain(revert.slice(0, 10));
    expect(await statusOf(r, "c1")).toBe("ready");
    const [reverted] = await eventsOf(r, "c1", ["card/reverted"]);
    expect(reverted?.payload).toMatchObject({ sha, revertSha: revert });
  });

  it("RG-S5-11: `sekhemet reject` needs a reason (exit 2), then moves the card to Rejected; `reopen` moves it to Ready", async () => {
    const r = g6Repo();
    await inReview(r, "c2", { files: B });
    const bare = cliIn(r, ["reject", "c2"]);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/reason/);
    expect(await statusOf(r, "c2")).toBe("review");
    const out = cliIn(r, ["reject", "c2", "not what we need"]);
    expect(out.status, out.stderr).toBe(0);
    expect(await statusOf(r, "c2")).toBe("rejected");
    const back = cliIn(r, ["reopen", "c2"]);
    expect(back.status, back.stderr).toBe(0);
    expect(await statusOf(r, "c2")).toBe("ready");
  });

  it("RG-S5-12: `sekhemet send-back` on a card In progress or in Verify is refused, naming abort", async () => {
    const r = g6Repo();
    await r.ledger(async ({ store }) => {
      await store.createCard({ id: "r3", tier: "story", title: "R3", status: "in_progress" });
    });
    const busy = cliIn(r, ["send-back", "r3", "wrong approach"]);
    expect(busy.status).not.toBe(0);
    expect(busy.stderr).toMatch(/abort/);
    expect(await statusOf(r, "r3")).toBe("in_progress");
    await r.ledger(async ({ store }) => {
      await store.updateCardStatus("r3", "verify", "x", "harness", { override: true });
    });
    const verifying = cliIn(r, ["send-back", "r3", "wrong approach"]);
    expect(verifying.status).not.toBe(0);
    expect(verifying.stderr).toMatch(/abort/);
    expect(await statusOf(r, "r3")).toBe("verify");
  });
});

describe("RG-S5-14: the integration branch is configurable", () => {
  it('RG-S5-14: with `[review] integration_branch = "develop"`, `sekhemet accept` merges into develop and leaves main', async () => {
    const r = g6Repo();
    r.git("branch", "develop");
    write(r.repo, ".sekhemet/config.toml", '[review]\nintegration_branch = "develop"\n');
    await inReview(r, "d1", { files: B, base: "develop" });
    const mainBefore = r.git("rev-parse", "main");
    const developBefore = r.git("rev-parse", "develop");
    const out = cliIn(r, ["accept", "d1"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/onto develop/);
    expect(r.git("rev-parse", "develop^")).toBe(developBefore);
    expect(r.git("show", "develop:src/b.ts")).toBe("export const b = 2;");
    expect(r.git("rev-parse", "main")).toBe(mainBefore);
  });
});

describe("RG-N5-1, RG-N5-2, RG-N5-8: who may accept, from the command line", () => {
  const ALICE = "p_alice";

  /** Alice and the person at the terminal are Members; the project's Accept rule names `holders`. */
  async function team(r: G6Repo, holders: (me: string) => string[]): Promise<string> {
    const me = await localPrincipal(r);
    await r.ledger(async ({ store, log }) => {
      const project = await store.ensureProject({ rootPath: r.repo, name: "Chronicle" });
      for (const p of [ALICE, me])
        log.appendNow({
          actor: "system",
          type: "member/joined",
          principal: p,
          payload: { principal: p, level: "member", via: "invite", pending: false },
        });
      log.appendNow({
        actor: "human",
        type: "project/settings_changed",
        principal: me,
        payload: { project: project.id, accept_rule: holders(me) },
      });
    });
    r.userConfig('[team]\nmode = "team"\n');
    return me;
  }

  it("RG-N5-2: the one Accept-holder on a single machine accepts the card they delegated, recorded independent: false", async () => {
    const r = g6Repo();
    await inReview(r, "n1", { files: B });
    const out = cliIn(r, ["accept", "n1"]);
    expect(out.status, out.stderr).toBe(0);
    const [accepted] = await eventsOf(r, "n1", ["card/accepted"]);
    expect(accepted?.payload).toMatchObject({
      principal: await localPrincipal(r),
      independent: false,
    });
  });

  it("RG-N5-2: the one Accept-holder in the Team setup accepts the card they delegated, recorded independent: false", async () => {
    const r = g6Repo();
    await inReview(r, "n2", { files: B });
    const me = await team(r, (m) => [m]);
    const out = cliIn(r, ["accept", "n2"]);
    expect(out.status, out.stderr).toBe(0);
    const [accepted] = await eventsOf(r, "n2", ["card/accepted"]);
    expect(accepted?.payload).toMatchObject({ principal: me, independent: false });
  });

  it("RG-N5-1: on a two-holder project the delegator is refused, naming who may accept; another holder's accept is recorded independent: true", async () => {
    const r = g6Repo();
    await inReview(r, "n3", { files: B });
    await team(r, (m) => [ALICE, m]);
    const refused = cliIn(r, ["accept", "n3", "--json"]);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout.trim())).toMatchObject({ refusal: "not_independent" });
    expect(refused.stderr).toContain(ALICE);
    expect(await statusOf(r, "n3")).toBe("review");

    // Alice delegated this one; the person at the terminal neither built nor delegated it.
    await inReview(r, "n4", { files: { "src/c.ts": "export const c = 3;\n" }, delegator: ALICE });
    const out = cliIn(r, ["accept", "n4"]);
    expect(out.status, out.stderr).toBe(0);
    const [accepted] = await eventsOf(r, "n4", ["card/accepted"]);
    expect(accepted?.payload).toMatchObject({ independent: true });
  }, 60_000);

  it("RG-N5-8: a card delegated by the person at the terminal and then owned by Alice still refuses them, naming who may accept", async () => {
    const r = g6Repo();
    await inReview(r, "n5", { files: B });
    const me = await team(r, (m) => [ALICE, m]);
    await r.ledger(async ({ store }) => {
      await store.changeOwner("n5", ALICE, me);
    });
    const out = cliIn(r, ["accept", "n5"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(ALICE);
    expect(await statusOf(r, "n5")).toBe("review");
  });

  it("RG-N5-8: Alice delegated it and its owner was changed to the person at the terminal: they accept it, independent: true", async () => {
    const r = g6Repo();
    await inReview(r, "n6", { files: B, delegator: ALICE });
    const me = await team(r, (m) => [ALICE, m]);
    await r.ledger(async ({ store }) => {
      await store.changeOwner("n6", me, ALICE);
    });
    const out = cliIn(r, ["accept", "n6"]);
    expect(out.status, out.stderr).toBe(0);
    const [accepted] = await eventsOf(r, "n6", ["card/accepted"]);
    expect(accepted?.payload).toMatchObject({ principal: me, independent: true });
  });

  it("RG-N5-8: once Alice delegates the card to the Worker again she is its delegator, and the person at the terminal may accept it", async () => {
    const r = g6Repo();
    await inReview(r, "n7", { files: B });
    const me = await team(r, (m) => [ALICE, m]);
    expect(cliIn(r, ["accept", "n7"]).status).toBe(1);
    await r.ledger(async ({ store }) => {
      await store.delegateCard("n7", null, ALICE);
      await store.delegateCard("n7", { kind: "worker" }, ALICE);
    });
    const out = cliIn(r, ["accept", "n7"]);
    expect(out.status, out.stderr).toBe(0);
    const [accepted] = await eventsOf(r, "n7", ["card/accepted"]);
    expect(accepted?.payload).toMatchObject({ principal: me, independent: true });
  });
});

describe("RG-S5-13, RG-S5-17: send-back and unpark from the command line", () => {
  it("RG-S5-13: `sekhemet send-back` records the playbook candidate on the ledger and writes no file under .sekhemet/", async () => {
    const r = g6Repo();
    await inReview(r, "s1", { files: B });
    const files = () =>
      execGit(r.repo, "ls-files", "--others", "--ignored", "--exclude-standard", "--", ".sekhemet")
        .split("\n")
        .filter((f) => f && !/events\.db(-wal|-shm)?$/.test(f))
        .sort();
    const before = files();
    // A note naming a file is a playbook candidate (RG-P8-15).
    const out = cliIn(r, ["send-back", "s1", "use the shared helper in src/shared.ts"]);
    expect(out.status, out.stderr).toBe(0);
    expect(await statusOf(r, "s1")).toBe("ready");
    const candidates = await r.ledger(({ log }) => log.getEventsByTypes(["playbook/candidate"]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.cardId).toBe("s1");
    expect(JSON.stringify(candidates[0])).toContain("use the shared helper in src/shared.ts");
    expect(files()).toEqual(before);
  });

  it("RG-S5-17: a card parked from Review is unparked to Ready; one parked from Backlog returns to Backlog", async () => {
    const r = g6Repo();
    await inReview(r, "p1", { files: B });
    expect(cliIn(r, ["park", "p1", "waiting", "on", "design"]).status).toBe(0);
    expect(await statusOf(r, "p1")).toBe("parked");
    const back = cliIn(r, ["unpark", "p1"]);
    expect(back.status, back.stderr).toBe(0);
    expect(back.stdout).toMatch(/back in Ready/);
    expect(await statusOf(r, "p1")).toBe("ready");

    await r.ledger(async ({ store }) => {
      await store.createCard({ id: "p2", tier: "story", title: "P2", status: "backlog" });
    });
    expect(cliIn(r, ["park", "p2", "not", "now"]).status).toBe(0);
    expect(await statusOf(r, "p2")).toBe("parked");
    const again = cliIn(r, ["unpark", "p2"]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/back in Backlog/);
    expect(await statusOf(r, "p2")).toBe("backlog");
  });
});

describe("RG-N4-2: a release is tagged only on a person's confirmation", () => {
  it("RG-N4-2: `sekhemet release propose` writes no tag; `sekhemet release --confirm next` tags and records release/tagged with the tag, the sha and the principal", async () => {
    const r = g6Repo();
    await r.ledger(({ store }) => store.ensureProject({ rootPath: r.repo, name: "Timesheet" }));
    await inReview(r, "c1", { files: B });
    expect(cliIn(r, ["accept", "c1"]).status).toBe(0);

    const proposed = cliIn(r, ["release", "propose"]);
    expect(proposed.status, proposed.stdout + proposed.stderr).toBe(0);
    expect(proposed.stdout).toMatch(
      /Proposed release 0\.1\.0\. Tag it with: sekhemet release --confirm next/,
    );
    expect(r.git("tag", "--list")).toBe("");
    expect(await r.ledger(({ log }) => log.getEventsByTypes(["release/tagged"]))).toEqual([]);

    const confirmed = cliIn(r, ["release", "--confirm", "next"]);
    expect(confirmed.status, confirmed.stdout + confirmed.stderr).toBe(0);
    expect(confirmed.stdout).toMatch(/Tagged v0\.1\.0 at [0-9a-f]{7}\./);
    expect(r.git("tag", "--list")).toBe("v0.1.0");
    const [tagged] = await r.ledger(({ log }) => log.getEventsByTypes(["release/tagged"]));
    expect(tagged?.payload).toMatchObject({
      tag: "v0.1.0",
      sha: r.git("rev-parse", "v0.1.0^{commit}"),
    });
    expect(tagged?.principal).toBe(await localPrincipal(r));
  });
});
