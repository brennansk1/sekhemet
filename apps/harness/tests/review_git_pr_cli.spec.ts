import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSettings } from "../src/integrations.js";
import {
  type FakeGitHub,
  fakeGh,
  fakeGitHub,
  ghFixture,
  signedDelivery,
} from "./support/g3_github.js";
import {
  BIN,
  type G6Repo,
  cliAsync,
  eventsOf,
  g6Repo,
  inReview,
  statusOf,
  write,
} from "./support/g6_review.js";

/**
 * review-git §2.5.7 (pull-request-on-accept) and NEW-review-git-7 at the door
 * (C2d, FINDINGS_C1 TST-01): `sekhemet accept` spawned on a project whose
 * Accept opens a pull request, against a local GitHub (GHES paths, the
 * `support/g3_github.ts` fake), a fake `gh` and a real bare remote; the
 * merge or close then arrives as a signed webhook at a spawned
 * `sekhemet serve`. No request leaves the machine.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const SECRET = "g6-hook-secret";
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

interface PrProject {
  r: G6Repo;
  api: FakeGitHub;
  upstream: string;
  env: Record<string, string>;
}

/** A project with pull-request-on-accept (unless `pr` is false) and push-to-remote on, its remote a bare repository. */
async function prProject(pr = true): Promise<PrProject> {
  const r = g6Repo();
  // The GitHub repository is read from the remote's URL; pushes go to `upstream`.
  r.git("remote", "add", "origin", "https://github.com/o/r.git");
  const upstream = join(r.root, "upstream.git");
  execFileSync("git", ["init", "-q", "--bare", upstream]);
  r.git("remote", "add", "upstream", upstream);
  write(r.repo, ".sekhemet/config.toml", '[review]\nremote = "upstream"\n');
  // The integration settings live in the user directory the command reads.
  for (const [k, v] of Object.entries(r.env())) vi.stubEnv(k, v);
  try {
    if (pr) writeSettings(r.repo, { githubPrOnAccept: true });
  } finally {
    vi.unstubAllEnvs();
  }
  await r.ledger(async ({ store, log }) => {
    const project = await store.ensureProject({ rootPath: r.repo, name: "Chronicle" });
    log.appendNow({
      actor: "human",
      type: "project/settings_changed",
      principal: log.localPrincipal(),
      payload: { project: project.id, push_to_remote: true },
    });
  });
  const api = await fakeGitHub();
  const bin = fakeGh(join(r.root, "bin"));
  return {
    r,
    api,
    upstream,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GH_TOKEN: "gho_fake",
      SEKHEMET_GITHUB_HOST: api.url,
    },
  };
}

/** The evidence of a card with a test added, a screenshot and one abandoned attempt. */
const BUILT = {
  files: { "src/b.ts": "export const b = 2;\n", "src/b.test.ts": "it('b', () => {});\n" },
  abandoned: ["budget_exhausted"],
  rungs: [
    { gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0, durationMs: 12 },
    {
      gate: "visual",
      rung: "visual",
      layer: "functional",
      passed: true,
      exitCode: 0,
      durationMs: 340,
    },
  ],
  evidence: {
    linesAdded: 2,
    diff: [
      "diff --git a/src/b.test.ts b/src/b.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.test.ts",
      "@@ -0,0 +1 @@",
      "+it('b', () => {});",
      "diff --git a/src/b.ts b/src/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1 @@",
      "+export const b = 2;",
      "",
    ].join("\n"),
    screenshots: [".sekhemet/evidence/visual/p1-home.png"],
  },
};

const prBody = (api: FakeGitHub) =>
  (api.seen.find((s) => s.method === "POST" && s.url === "/api/v3/repos/o/r/pulls")?.body as {
    body: string;
    head: string;
    base: string;
  }) ?? { body: "", head: "", base: "" };

describe("RG-S5-18, RG-N7-2: `sekhemet accept` with pull-request-on-accept", () => {
  it("RG-S5-18: the pull request's body carries the gates with durations, the tests added, the diff stats, the abandoned attempts and a link to each visual-gate screenshot", async () => {
    const p = await prProject();
    await inReview(p.r, "p1", BUILT);
    const out = await cliAsync(p.r, ["accept", "p1"], { env: p.env });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("https://github.com/o/r/pull/5");
    const pr = prBody(p.api);
    expect(pr.body).toContain("### Checks\n- pass unit (12 ms)\n- pass visual (340 ms)");
    expect(pr.body).toContain("### Tests added\n- src/b.test.ts");
    expect(pr.body).toContain("### Diff\n2 files, +2 −0");
    expect(pr.body).toContain("### Tried and abandoned\n- attempt 1: budget_exhausted");
    expect(pr.body).toContain("[p1-home.png](.sekhemet/evidence/visual/p1-home.png)");
    // RG-S5-15: the card waits in Review for the merge.
    expect(await statusOf(p.r, "p1")).toBe("review");
  }, 60_000);

  it("RG-N7-2: with push-to-remote on as well, Accept pushes the card branch it opens the pull request from and nothing else", async () => {
    const p = await prProject();
    await inReview(p.r, "p2", BUILT);
    const main = p.r.git("rev-parse", "main");
    const out = await cliAsync(p.r, ["accept", "p2"], { env: p.env });
    expect(out.status, out.stderr).toBe(0);
    const pushed = p.r
      .git("ls-remote", "upstream")
      .split("\n")
      .map((l) => l.split("\t")[1]);
    expect(pushed).toEqual([`refs/heads/${prBody(p.api).head}`]);
    expect(pushed.some((ref) => /refs\/heads\/main$|refs\/tags\//.test(ref))).toBe(false);
    expect(p.r.git("rev-parse", "main")).toBe(main);
    expect(await eventsOf(p.r, "p2", ["remote/pushed"])).toEqual([]);
  }, 60_000);
});

describe("RG-N7-4: a push on Accept is recorded on the ledger, with no credential", () => {
  it("RG-N7-4: without pull-request-on-accept, `sekhemet accept` pushes main to the remote and records the ref, the sha, the remote and the result", async () => {
    const p = await prProject(false);
    await inReview(p.r, "u1", BUILT);
    const out = await cliAsync(p.r, ["accept", "u1"], { env: p.env });
    expect(out.status, out.stderr).toBe(0);
    const head = p.r.git("rev-parse", "main");
    expect(p.r.git("ls-remote", "upstream", "refs/heads/main").split("\t")[0]).toBe(head);
    const [pushed] = await eventsOf(p.r, "u1", ["remote/pushed"]);
    expect(pushed?.payload).toMatchObject({
      ref: "refs/heads/main",
      sha: head,
      remote: "upstream",
      result: "pushed",
    });
  }, 60_000);

  it("RG-N7-4: a push the network policy refuses is recorded with its result, and the remote's credential is stored nowhere on the ledger", async () => {
    const p = await prProject(false);
    p.r.git(
      "remote",
      "set-url",
      "upstream",
      "https://jane:s3cr3t-token@example.invalid/team/app.git",
    );
    await inReview(p.r, "u2", BUILT);
    const out = await cliAsync(p.r, ["accept", "u2"], { env: p.env });
    expect(out.status, out.stderr).toBe(0);
    expect(await statusOf(p.r, "u2")).toBe("done");
    const [refused] = await eventsOf(p.r, "u2", ["remote/pushed"]);
    expect(refused?.payload).toMatchObject({
      ref: "refs/heads/main",
      sha: p.r.git("rev-parse", "main"),
      remote: "upstream",
      result: "not_allowed",
    });
    const rows = await p.r.ledger(({ db }) => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[];
      return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()));
    });
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) expect(row).not.toContain("s3cr3t");
    expect(out.stdout + out.stderr).not.toContain("s3cr3t");
  }, 60_000);
});

/** `sekhemet serve` with the webhook secret set; resolves with its address. */
async function serveWithWebhooks(p: PrProject): Promise<string> {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
    cwd: p.r.repo,
    env: p.r.env({ env: { ...p.env, SEKHEMET_GITHUB_WEBHOOK_SECRET: SECRET } }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  return new Promise<string>((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`no address: ${out}`)), 30_000);
    child.stdout?.on("data", (d) => {
      out += String(d);
      const m = /running at:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1] as string);
      }
    });
    child.once("exit", (code) => bad(new Error(`serve exited ${code}: ${out}`)));
  });
}

/** GitHub's `pull_request` `closed` delivery for o/r#5, merged or not. */
function closed(merged: boolean) {
  const hook = ghFixture("webhook-pull_request-closed.json");
  hook.repository.full_name = "o/r";
  hook.repository.name = "r";
  hook.repository.owner.login = "o";
  hook.pull_request.html_url = "https://github.com/o/r/pull/5";
  if (!merged) {
    hook.pull_request.merged = false;
    hook.pull_request.merged_at = null;
    hook.pull_request.merge_commit_sha = null;
    hook.pull_request.merged_by = null;
    hook.sender.login = "octocat";
  }
  return JSON.stringify(hook);
}

async function deliver(address: string, delivery: string, body: string): Promise<number> {
  const res = await fetch(`${address}/webhooks/github`, {
    method: "POST",
    headers: signedDelivery(SECRET, "pull_request", delivery, body),
    body,
  });
  return res.status;
}

describe("RG-S5-16: a held card's pull request closes, by webhook to `sekhemet serve`", () => {
  it("RG-S5-16: merged, the card moves to Done and card/pr_closed records merged: true", async () => {
    const p = await prProject();
    await inReview(p.r, "m1", BUILT);
    expect((await cliAsync(p.r, ["accept", "m1"], { env: p.env })).status).toBe(0);
    const held = await p.r.ledger(({ store }) => store.getCard("m1"));
    expect(held?.hold).toMatchObject({ kind: "awaitingMerge", pr: 5 });
    const address = await serveWithWebhooks(p);
    expect(await deliver(address, "d-merged", closed(true))).toBe(202);
    expect(await statusOf(p.r, "m1")).toBe("done");
    const [pr] = await eventsOf(p.r, "m1", ["card/pr_closed"]);
    expect(pr?.payload).toMatchObject({
      merged: true,
      pr: 5,
      mergeCommit: "c4295bd74fb0f4fda03689c3df3f2803b658fd85",
    });
  }, 60_000);

  it("RG-S5-16: closed without merging, the hold clears, the card stays In review awaiting a new decision, and who closed it is recorded", async () => {
    const p = await prProject();
    await inReview(p.r, "m2", BUILT);
    expect((await cliAsync(p.r, ["accept", "m2"], { env: p.env })).status).toBe(0);
    const address = await serveWithWebhooks(p);
    expect(await deliver(address, "d-closed", closed(false))).toBe(202);
    const card = await p.r.ledger(({ store }) => store.getCard("m2"));
    expect(card?.status).toBe("review");
    expect(card?.hold).toBeUndefined();
    expect(card?.accepter).toBeUndefined();
    const closedEvents = await p.r.ledger(({ store }) =>
      store.cardEvents("m2", ["card/pr_closed"]),
    );
    expect(closedEvents.map((e) => e.payload)).toEqual([{ id: "m2", pr: 5, merged: false }]);
    expect(closedEvents[0]?.private).toEqual({ closedByHandle: "octocat" });
    // Counted toward ReviewWIP again: the board serves it in Review with no hold.
    const board = (await (await fetch(`${address}/api/board`)).json()) as {
      cards: { id: string; status: string; hold?: unknown }[];
    };
    expect(board.cards.find((c) => c.id === "m2")).toMatchObject({ status: "review" });
    expect(board.cards.find((c) => c.id === "m2")?.hold).toBeUndefined();
  }, 60_000);
});
