import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM scripts, run by `pnpm milestone` and checked here.
import {
  INJECTION_SURFACE,
  acrossPlatforms,
  appliesTo,
  injectionCheck,
  platformCheck,
  surfaceChanges,
} from "../../../scripts/milestones/b1.mjs";
// @ts-expect-error: as above.
import { fairReplay } from "../../../scripts/milestones/b4_10.mjs";
// @ts-expect-error: as above.
import { journeyAudit } from "../../../scripts/milestones/b4_11.mjs";
// @ts-expect-error: as above.
import * as m from "../../../scripts/milestones/lib.mjs";

/**
 * The milestone runners of MODERNIZATION_PLAN "Milestones the owner sees"
 * (close-out C4): each produces an evidence file on this machine and
 * docs/reference/MILESTONES.md is rendered from them. What is tested here is
 * what the runners judge with — the verdict, the baseline's reading, the
 * containment suite's reading, a real kill -9 of a ledger writer, the chain
 * comparison across an upgrade, the stand-in model server a card is built
 * against, and the page — each against real files, processes and git.
 */
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the verdict", () => {
  it("is PASS only when every check passed, FAIL when any failed, else NOT RUN", () => {
    expect(m.verdictOf([{ name: "a", ok: true }])).toBe("PASS");
    expect(
      m.verdictOf([
        { name: "a", ok: true },
        { name: "b", ok: false },
      ]),
    ).toBe("FAIL");
    expect(
      m.verdictOf([
        { name: "a", ok: true },
        { name: "b", ok: null },
      ]),
    ).toBe("NOT RUN");
    expect(
      m.verdictOf([
        { name: "a", ok: false },
        { name: "b", ok: null },
      ]),
    ).toBe("FAIL");
    expect(m.verdictOf([])).toBe("NOT RUN");
  });

  it("names the commit, whether the tree was clean, and the date on every evidence file", () => {
    const out = tmp("ms-ev-");
    const path = m.writeEvidence(
      { id: "B3", title: "t", checks: [{ name: "a", ok: true, detail: "d" }] },
      { dir: out, date: "2026-09-28" },
    );
    expect(path).toBe(join(out, "B3_2026-09-28.json"));
    const ev = JSON.parse(readFileSync(path, "utf8"));
    expect(ev.verdict).toBe("PASS");
    expect(ev.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof ev.treeClean).toBe("boolean");
    expect(ev.date).toBe("2026-09-28");
    expect(ev.host).toMatchObject({ platform: process.platform });
    // The working tree it ran on, uncommitted and untracked files included.
    expect(ev.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it("writes evidence exactly as the gate's formatter would, so a runner's file never fails the gate", () => {
    // W1 finding: JSON.stringify spreads short arrays one item a line, which
    // biome joins, so every new evidence file failed `biome check .`.
    const out = tmp("ms-fmt-");
    const path = m.writeEvidence(
      {
        id: "B2.5",
        title: "t",
        checks: [
          { name: "a", ok: true, detail: "d", counts: [38, 43, 42] },
          { name: "b", ok: false, arms: ["ref", "strict"], none: [], nested: [[1, 2], [3]] },
        ],
        details: {
          passed: Array.from({ length: 40 }, (_, i) => i),
          empty: {},
          flags: [true, null],
        },
      },
      { dir: out, date: "2026-09-29" },
    );
    const written = readFileSync(path, "utf8");
    const root = join(import.meta.dirname, "../../..");
    const biome = join(root, "node_modules", ".bin", "biome");
    const formatted = execFileSync(
      biome,
      ["format", `--stdin-file-path=${join("evidence", "milestones", "B2.5_2026-09-29.json")}`],
      { cwd: root, input: written, encoding: "utf8" },
    );
    expect(written).toBe(formatted);
    expect(JSON.parse(written).details.passed).toHaveLength(40);
  });

  it("identifies the tree a runner ran on, so it can be tied to the commit that later holds it", () => {
    const repo = tmp("ms-tree-");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    // Clean: the commit's own tree.
    expect(m.treeIdentity(repo)).toBe(git("rev-parse", "HEAD^{tree}"));
    // A change and a new, untracked file: another tree, and the real index untouched.
    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "runner.mjs"), "export {};\n");
    const ran = m.treeIdentity(repo);
    expect(ran).not.toBe(git("rev-parse", "HEAD^{tree}"));
    expect(git("status", "--porcelain")).toBe("M a.txt\n?? runner.mjs");
    // Committing exactly that tree gives the same identity.
    git("add", "-A");
    git("commit", "-q", "-m", "two");
    expect(git("rev-parse", "HEAD^{tree}")).toBe(ran);
  });
});

describe("B2.5: the baseline, read from its results only", () => {
  const result = (passed: number, failures: { stopReason?: string }[]) => ({
    suiteHash: "d70f689d",
    passed,
    total: passed + failures.length,
    runProfile: { hash: "f7d1" },
    outcomes: [
      ...Array.from({ length: passed }, (_, i) => ({ task: { cardId: `ok${i}` }, passed: true })),
      ...failures.map((f, i) => ({ task: { cardId: `bad${i}` }, passed: false, ...f })),
    ],
  });

  function baseline(files: Record<string, unknown>, arms: string[]) {
    const root = tmp("ms-base-");
    mkdirSync(join(root, "results"));
    mkdirSync(join(root, "arms"));
    for (const a of arms) writeFileSync(join(root, "arms", `${a}.json`), "{}");
    for (const [f, body] of Object.entries(files)) {
      writeFileSync(join(root, "results", f), JSON.stringify(body));
    }
    return root;
  }

  it("is NOT RUN while an arm lacks its second round, and names what is missing", () => {
    const root = baseline(
      {
        "ref-r1.json": result(20, [{ stopReason: "budget_exhausted" }]),
        "ref-r2.json": result(19, [{ stopReason: "oscillation" }]),
        "strict-r1.json": result(18, [{ stopReason: "budget_exhausted" }]),
      },
      ["ref", "strict"],
    );
    const s = m.summarizeBaseline({ root, suiteRuns: "" });
    expect(s.verdict).toBe("NOT RUN");
    expect(s.runs.map((r: { file: string }) => r.file)).toEqual([
      "ref-r1.json",
      "ref-r2.json",
      "strict-r1.json",
    ]);
    expect(s.missingRounds).toEqual(["strict-r2"]);
    expect(s.reason).toMatch(/strict-r2/);
    expect(s.reason).toMatch(/planning measure/);
  });

  it("prefers a rescored result to the original of the same run", () => {
    const root = baseline(
      {
        "ref-r1.json": result(20, [{ stopReason: "budget_exhausted" }]),
        "ref-r1.rescored.json": result(21, []),
      },
      ["ref"],
    );
    const s = m.summarizeBaseline({ root, suiteRuns: "" });
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ file: "ref-r1.rescored.json", passed: 21 });
  });

  it("is FAIL when a failure carries no named cause", () => {
    const root = baseline(
      { "ref-r1.json": result(20, [{}]), "ref-r2.json": result(20, [{ stopReason: "x" }]) },
      ["ref"],
    );
    const s = m.summarizeBaseline({ root, suiteRuns: "" });
    expect(s.verdict).toBe("FAIL");
    expect(s.unnamedFailures).toEqual(["ref-r1.json: bad0"]);
  });

  it("is PASS with every round, every failure named, the planning measure and the frozen RunProfile", () => {
    const root = baseline(
      {
        "ref-r1.json": result(20, [{ stopReason: "budget_exhausted" }]),
        "ref-r2.json": result(19, [{ stopReason: "oscillation" }]),
        "planning-r1.json": { score: 0.7 },
      },
      ["ref"],
    );
    const s = m.summarizeBaseline({
      root,
      suiteRuns: "## Baseline RunProfile (frozen 2026-10-01)\n\nhash f7d1\n",
    });
    expect(s.verdict).toBe("PASS");
  });
});

describe("B1: the containment suite's own report", () => {
  it("reads vitest's JSON report and fails on a failed or skipped test", () => {
    const report = (states: string[]) => ({
      testResults: [
        {
          name: "/x/packages/sandbox/tests/containment.spec.ts",
          assertionResults: states.map((status, i) => ({ title: `t${i}`, status })),
        },
      ],
    });
    expect(m.summarizeVitest(report(["passed", "passed"]))).toMatchObject({
      files: 1,
      tests: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      ok: true,
    });
    expect(m.summarizeVitest(report(["passed", "failed"])).ok).toBe(false);
    // SEC-43: no test skipped on either platform.
    const skipped = m.summarizeVitest(report(["passed", "skipped"]));
    expect(skipped.ok).toBe(false);
    expect(skipped.skippedTitles).toEqual(["containment.spec.ts: t1"]);
  });
});

describe("B1: the recorded Worker that tries to leave counts only while its surface is unchanged", () => {
  const inj = {
    file: "evidence/injection_2026-09-25.json",
    commit: "",
    worker: "cyber-tiel",
    held: 14,
    total: 14,
    passed: true,
  };

  it("lists what changed in the sandbox or the Worker's tools since the run's commit", () => {
    expect(INJECTION_SURFACE).toEqual(
      expect.arrayContaining(["packages/sandbox/src", "packages/loop/src/tools.ts"]),
    );
    const repo = tmp("ms-inj-");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "packages", "sandbox", "src"), { recursive: true });
    mkdirSync(join(repo, "packages", "loop", "src"), { recursive: true });
    writeFileSync(join(repo, "packages", "sandbox", "src", "seatbelt.ts"), "a\n");
    writeFileSync(join(repo, "packages", "loop", "src", "tools.ts"), "a\n");
    writeFileSync(join(repo, "README.md"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "run");
    const at = git("rev-parse", "HEAD");
    expect(surfaceChanges(at, repo)).toEqual([]);
    // Elsewhere: still the same Worker.
    writeFileSync(join(repo, "README.md"), "b\n");
    expect(surfaceChanges(at, repo)).toEqual([]);
    // A committed sandbox change, an uncommitted tools change and a new sandbox file.
    writeFileSync(join(repo, "packages", "sandbox", "src", "seatbelt.ts"), "b\n");
    git("commit", "-q", "-am", "sandbox");
    writeFileSync(join(repo, "packages", "loop", "src", "tools.ts"), "b\n");
    writeFileSync(join(repo, "packages", "sandbox", "src", "new.ts"), "b\n");
    expect(surfaceChanges(at, repo).sort()).toEqual([
      "packages/loop/src/tools.ts",
      "packages/sandbox/src/new.ts",
      "packages/sandbox/src/seatbelt.ts",
    ]);
  });

  it("is NOT RUN, never PASS, when the surface changed since the recorded run", () => {
    const fresh = injectionCheck({ ...inj, commit: "5937e83" }, []);
    expect(fresh.ok).toBe(true);
    const stale = injectionCheck({ ...inj, commit: "5937e83" }, [
      "packages/sandbox/src/seatbelt.ts",
      "packages/loop/src/tools.ts",
    ]);
    expect(stale.ok).toBeNull();
    expect(stale.detail).toMatch(/2 files .* changed since 5937e83/);
    expect(stale.detail).toMatch(/run the injection fixtures again/);
    expect(m.verdictOf([{ name: "suite", ok: true }, stale])).toBe("NOT RUN");
    // A recorded run that did not hold stays a failure, stale or not.
    expect(injectionCheck({ ...inj, commit: "5937e83", held: 13 }, ["x"]).ok).toBe(false);
    expect(injectionCheck(undefined, []).ok).toBeNull();
  });
});

describe("B3: the ledger across a crash and an upgrade", () => {
  it("a real kill -9 of a writer mid-write leaves a chain that verifies on restart", async () => {
    const repo = tmp("ms-crash-");
    const trial = await m.crashTrial({ repo, killAfterEvents: 40 });
    expect(trial.killedBy).toBe("SIGKILL");
    expect(trial.walAtKill).toBe(true);
    expect(trial.eventsAtRestart).toBeGreaterThanOrEqual(40);
    expect(trial.chainValid).toBe(true);
    expect(trial.projectionsIdentical).toBe(true);
    // The ledger takes writes again after the restart.
    expect(trial.appendedAfter).toBe(true);
  }, 60_000);

  it("compares an old ledger's chain with the upgraded one row by row", () => {
    const before = [
      { seq: 1, type: "card/created", hash: "a" },
      { seq: 2, type: "card/status_changed", hash: "b" },
    ];
    expect(
      m.compareChains(before, [...before, { seq: 3, type: "person/created", hash: "c" }]),
    ).toEqual({ intact: true, kept: 2, added: 1, problems: [] });
    const changed = m.compareChains(before, [before[0], { seq: 2, type: "x", hash: "z" }]);
    expect(changed.intact).toBe(false);
    expect(changed.problems).toEqual(["seq 2: was card/status_changed b, now x z"]);
    expect(m.compareChains(before, [before[0]]).problems).toEqual(["seq 2: missing"]);
  });

  it("reads every row of a ledger file with its type and hash", () => {
    const dir = tmp("ms-rows-");
    const db = new DatabaseSync(join(dir, "events.db"));
    db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT, hash TEXT, payload TEXT)");
    db.exec(`INSERT INTO events VALUES (1, 'card/created', 'h1', '{"a":1}')`);
    db.exec(`INSERT INTO events VALUES (2, 'card/moved', 'h2', 'not json')`);
    db.close();
    const rows = m.chainRows(join(dir, "events.db"));
    expect(rows.map((r: { seq: number }) => r.seq)).toEqual([1, 2]);
    expect(m.unreadablePayloads(join(dir, "events.db"))).toEqual([2]);
  });
});

describe("the stand-in model server a card is built against", () => {
  it("serves the OpenAI chat API the product's adapter speaks, and a card reaches Review", async () => {
    const repo = tmp("ms-build-");
    m.makeRepo(repo);
    const fake = await m.startFakeModel({
      card_ms_one: { path: "src/one.ts", content: "export const one = 1;\n", usage: [700, 90] },
    });
    try {
      const built = await m.buildCards({
        repo,
        modelUrl: fake.url,
        cards: [{ id: "card_ms_one", title: "Add one", scopeFiles: ["src/one.ts"] }],
      });
      expect(built).toEqual([{ id: "card_ms_one", passed: true, status: "review" }]);
      expect(fake.requests.length).toBeGreaterThanOrEqual(2);
      // The usage the server reported is what the ledger charges (RUN-34).
      const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
      const used = db
        .prepare(
          "SELECT SUM(json_extract(payload, '$.usage.promptTokens')) AS i FROM events WHERE type = 'card/step' AND card_id = 'card_ms_one'",
        )
        .get() as { i: number };
      db.close();
      expect(used.i).toBeGreaterThanOrEqual(700);
      const branches = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" });
      expect(branches).toMatch(/card_ms_one/);
    } finally {
      await fake.close();
    }
  }, 60_000);
});

describe("B4.10 and B4.11: what the team runners judge with", () => {
  it("replays fair share in tokens: the person who spent least goes next, ties in queue order", () => {
    const who: Record<string, string> = { m1: "mo", m2: "mo", l1: "lee", l2: "lee", l3: "lee" };
    const cost: Record<string, number> = {
      m1: 24_000,
      m2: 24_000,
      l1: 2_000,
      l2: 2_000,
      l3: 2_000,
    };
    expect(
      fairReplay(
        ["m1", "m2", "l1", "l2", "l3"],
        (id: string) => cost[id],
        (id: string) => who[id],
      ),
    ).toEqual(["m1", "l1", "l2", "l3", "m2"]);
    // Equal costs alternate, as turns by count would.
    expect(
      fairReplay(
        ["m1", "m2", "l1", "l2"],
        () => 1,
        (id: string) => who[id],
      ),
    ).toEqual(["m1", "l1", "m2", "l2"]);
  });

  it("audits a journey's ledger: the stakeholder's plan, its approval, the release, and who wrote", () => {
    const dir = tmp("ms-journey-");
    const path = join(dir, "events.db");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT, actor TEXT, principal TEXT, payload TEXT)",
    );
    const add = db.prepare(
      "INSERT INTO events (type, actor, principal, payload) VALUES (?, ?, ?, '{}')",
    );
    add.run("plan/sent_for_approval", "human", "p_sam");
    add.run("plan/approved", "human", "p_mo");
    add.run("card/created", "human", "p_zed");
    add.run("card/moved", "human", null);
    db.close();
    const people = {
      sam: { principal: "p_sam", level: "stakeholder" },
      mo: { principal: "p_mo", level: "member" },
    };
    const a = journeyAudit(path, people);
    expect(a.sent).toHaveLength(1);
    expect(a.approved).toHaveLength(1);
    expect(a.accepted).toHaveLength(0);
    expect(a.strangers).toEqual(["p_zed"]);
    expect(a.unattributed.map((e: { type: string }) => e.type)).toEqual(["card/moved"]);
  });
});

describe("docs/reference/MILESTONES.md", () => {
  it("has one section per milestone with its evidence, commit, date and verdict", () => {
    const page = m.renderMilestones([
      {
        id: "B3",
        title: "Accept, undo and send back; the ledger survives a crash and an upgrade",
        verdict: "PASS",
        commit: "a".repeat(40),
        treeClean: false,
        date: "2026-09-28",
        evidence: "evidence/milestones/B3_2026-09-28.json",
        checks: [{ name: "crash", ok: true, detail: "5 kills" }],
      },
    ]);
    for (const id of ["B1", "B2.5", "B3", "B4.4", "B4.10", "B4.11"]) {
      expect(page).toContain(`## ${id}`);
    }
    expect(page).toContain("**PASS**");
    expect(page).toContain("evidence/milestones/B3_2026-09-28.json");
    expect(page).toContain("aaaaaaaaaa");
    expect(page).toContain("uncommitted changes");
    // Evidence from before the tree was recorded says so; a tree recorded is named.
    expect(page).toContain("tree not recorded");
    const tied = m.renderMilestones([
      {
        id: "B3",
        title: "t",
        verdict: "PASS",
        commit: "a".repeat(40),
        treeClean: false,
        tree: "b".repeat(40),
        date: "2026-09-28",
        evidence: "evidence/milestones/B3_2026-09-28.json",
        checks: [],
      },
    ]);
    expect(tied).toContain(`tree \`${"b".repeat(40)}\``);
    // A milestone with no evidence yet says so, never a verdict it did not earn.
    expect(page).toMatch(/## B1[^#]*\*\*NOT RUN\*\*[^#]*no evidence/);
  });
});

/**
 * R9: the suite has tests only one platform can run (the keychain on macOS,
 * bubblewrap's masks on Linux). SEC-43 is read across both: each test passes
 * on every platform it applies to, and only the tests the runner names as
 * platform-only may be skipped on the other (R9-L3 review).
 */
describe("B1: the containment suite across macOS and Linux (SEC-43)", () => {
  const run = (files: Record<string, Record<string, string>>) =>
    m.summarizeVitest({
      testResults: Object.entries(files).map(([file, states]) => ({
        name: `/x/packages/sandbox/tests/${file}`,
        assertionResults: Object.entries(states).map(([title, status]) => ({
          title,
          fullName: title,
          status,
        })),
      })),
    });
  const write = "containment (srt engine) refuses a write outside the allowed path";

  it("names the tests only one platform can run, and nothing else", () => {
    expect(appliesTo("linux_sockets.spec.ts: Linux host sockets (srt engine) x")).toBe("Linux");
    expect(appliesTo("secret_masks.spec.ts: B-2: a planted secret bubblewrap: ~/.ssh")).toBe(
      "Linux",
    );
    expect(appliesTo("keychain_containment.spec.ts: anything")).toBe("macOS");
    expect(appliesTo("secret_masks.spec.ts: B-2: a planted secret Seatbelt: the entries")).toBe(
      "macOS",
    );
    expect(
      appliesTo(
        "containment.spec.ts: containment (native engine) refuses to create git metadata at any depth or in any case",
      ),
    ).toBe("macOS");
    expect(appliesTo(`containment.spec.ts: ${write}`)).toBe("both");
  });

  it("names the relays' confined tests Linux-only (DEC-50), and the relay's own tests both", () => {
    const relays = "port_relays.spec.ts: ";
    for (const engine of ["native", "srt"]) {
      expect(
        appliesTo(
          `${relays}14b: the host half of an outward relay follows no path the command can rewrite a confined command that swaps its relay socket for a symlink reaches no host socket (${engine} engine)`,
        ),
      ).toBe("Linux");
      expect(
        appliesTo(
          `${relays}DEC-50: a card's dev server across namespaces (${engine} engine) a missing program is still reported as never started when relays wrap it`,
        ),
      ).toBe("Linux");
      expect(
        appliesTo(
          `${relays}DEC-50: a card's dev server across namespaces (${engine} engine) is reached from the host and from another confined command naming its port`,
        ),
      ).toBe("both");
    }
    expect(
      appliesTo(
        `${relays}14b: the host half of an outward relay follows no path the command can rewrite refuses a symlink planted where the relay's socket was, and reaches no host socket`,
      ),
    ).toBe("both");
    expect(
      appliesTo(
        `${relays}DEC-50: the host side of the relays inward: a connection on the socket reaches the host port`,
      ),
    ).toBe("both");
  });

  it("passes when each test passed on every platform it applies to", () => {
    const check = acrossPlatforms([
      {
        label: "macOS",
        summary: run({
          "containment.spec.ts": { [write]: "passed" },
          "keychain_containment.spec.ts": { k: "passed" },
          "linux_sockets.spec.ts": { s: "skipped" },
        }),
      },
      {
        label: "Linux",
        summary: run({
          "containment.spec.ts": { [write]: "passed" },
          "keychain_containment.spec.ts": { k: "skipped" },
          "linux_sockets.spec.ts": { s: "passed" },
        }),
      },
    ]);
    expect(check.ok).toBe(true);
  });

  it("does not excuse a test for both platforms that one of them skipped, or never ran", () => {
    const skipped = acrossPlatforms([
      { label: "macOS", summary: run({ "containment.spec.ts": { [write]: "passed" } }) },
      { label: "Linux", summary: run({ "containment.spec.ts": { [write]: "skipped" } }) },
    ]);
    expect(skipped.ok).toBe(false);
    expect(skipped.detail).toContain(`Linux: containment.spec.ts: ${write} (skipped)`);
    const absent = acrossPlatforms([
      { label: "macOS", summary: run({ "containment.spec.ts": { [write]: "passed" } }) },
      { label: "Linux", summary: run({ "containment.spec.ts": { other: "passed" } }) },
    ]);
    expect(absent.ok).toBe(false);
    expect(absent.detail).toContain(`Linux: containment.spec.ts: ${write} (not run)`);
  });

  it("fails on a platform-only test its platform skipped (a named residual) or one that failed", () => {
    const residual = acrossPlatforms([
      { label: "macOS", summary: run({ "linux_sockets.spec.ts": { abstract: "skipped" } }) },
      { label: "Linux", summary: run({ "linux_sockets.spec.ts": { abstract: "skipped" } }) },
    ]);
    expect(residual.ok).toBe(false);
    expect(residual.detail).toContain("Linux: linux_sockets.spec.ts: abstract (skipped)");
    const failed = acrossPlatforms([
      { label: "macOS", summary: run({ "containment.spec.ts": { [write]: "passed" } }) },
      { label: "Linux", summary: run({ "containment.spec.ts": { [write]: "failed" } }) },
    ]);
    expect(failed.ok).toBe(false);
  });

  it("is NOT RUN until both platforms have run", () => {
    expect(
      acrossPlatforms([
        { label: "macOS", summary: run({ "containment.spec.ts": { a: "passed" } }) },
      ]).ok,
    ).toBeNull();
  });

  it("judges one platform by its failures and broken files, counting its skips", () => {
    const check = platformCheck(
      "Linux",
      run({ "containment.spec.ts": { a: "passed", b: "skipped" } }),
    );
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("1 skipped");
    expect(platformCheck("Linux", run({ "containment.spec.ts": { a: "failed" } })).ok).toBe(false);
    expect(platformCheck("Linux", undefined).ok).toBe(false);
  });
});

/**
 * B3 failed on 2026-10-02 because C2a's rename changed `sekhemet log`'s
 * words and the milestone's parser still read the old ones. The parser is
 * tied here to the real CLI's output: a real ledger, a real Ledger-Head
 * trailer, the real `log`.
 */
describe("the milestones read `sekhemet log` as the CLI prints it", () => {
  // @ts-expect-error: plain ESM scripts, run by `pnpm milestone` and checked here.
  const load = () => import("../../../scripts/milestones/ledger.mjs");
  // @ts-expect-error: as above.
  const core = () => import("../../../scripts/milestones/core.mjs");

  it("finds a matching anchor, and calls a tampered one broken", async () => {
    const { readLogVerdict } = await load();
    const { runCli, isolatedEnv } = await core();
    const base = mkdtempSync(join(tmpdir(), "log-verdict-"));
    try {
      const repo = join(base, "repo");
      mkdirSync(repo);
      const git = (...a: string[]) =>
        execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x", ...a], {
          cwd: repo,
          stdio: "ignore",
        });
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "init");
      const { initLocalKernel } = await import("../src/index.js");
      const { db, cardStore } = initLocalKernel(repo);
      await cardStore.createCard({
        id: "card_anchor_1",
        tier: "story",
        title: "Anchor issue",
        status: "ready",
        scopeFiles: ["src/a.ts"],
        acceptanceCriteria: ["src/a.ts exports a"],
      });
      const head = db.prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").get() as {
        seq: number;
        hash: string;
      };
      db.close();
      git(
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "accept",
        "-m",
        `Ledger-Head: ${head.seq}:${head.hash}`,
      );
      const env = isolatedEnv(base);
      const ok = readLogVerdict(runCli(["log", "--repo", repo], { env }));
      expect(ok.chainValid).toBe(true);
      expect(ok.anchor).toBe("matches");
      git(
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "later",
        "-m",
        `Ledger-Head: ${head.seq + 100}:${head.hash}`,
      );
      const cut = readLogVerdict(runCli(["log", "--repo", repo], { env }));
      expect(cut.anchor).toBe("broken");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
