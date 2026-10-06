import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { pageWriteHeaders } from "./page_headers.js";
import {
  BIN,
  type G6Repo,
  cliIn,
  eventsOf,
  g6Repo,
  inReview,
  localPrincipal,
  statusOf,
  write,
} from "./support/g6_review.js";

/**
 * review-git S6 and NEW-review-git-5 over HTTP (C2d, FINDINGS_C1 TST-01):
 * `sekhemet serve` spawned on a real repository and ledger, the board and the
 * Review desk read as the dashboard reads them, and Accept made with
 * `sekhemet accept` as a person makes it.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

/** `sekhemet serve` on a free port; GET `path` as JSON, then stop the server. */
async function getFromServe(r: G6Repo, path: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
    cwd: r.repo,
    env: r.env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  const address = await new Promise<string>((ok, bad) => {
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
  try {
    const res = await fetch(`${address}${path}`);
    expect(res.status, path).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    child.kill("SIGTERM");
    await new Promise((ok) => child.once("exit", ok));
  }
}

/** `sekhemet serve` on a free port: `use` gets its address and stdout so far, then the server stops. */
async function withServe<T>(
  r: G6Repo,
  use: (base: string, out: () => string) => Promise<T>,
): Promise<T> {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
    cwd: r.repo,
    env: r.env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  const base = await new Promise<string>((ok, bad) => {
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
  try {
    return await use(base, () => out);
  } finally {
    child.kill("SIGTERM");
    await new Promise((ok) => child.once("exit", ok));
  }
}

const reviewLimit = async (r: G6Repo) =>
  (await getFromServe(r, "/api/board")).reviewLimit as Record<string, unknown>;

describe("RG-S6-1, RG-S6-9: ReviewWIP on the board the dashboard serves", () => {
  it("RG-S6-1: five sub-second `harness` exits from Review and no human review: the limit comes from the 15-minute prior, 60 minutes a day giving 4", async () => {
    const r = g6Repo();
    await r.ledger(async ({ store }) => {
      for (let i = 1; i <= 5; i++) {
        await store.createCard({ id: `h${i}`, tier: "story", title: `H${i}` });
        await store.updateCardStatus(`h${i}`, "review", "verified", "harness", { override: true });
        await store.updateCardStatus(`h${i}`, "ready", "restacked", "harness", { override: true });
      }
    });
    expect(await reviewLimit(r)).toMatchObject({
      limit: 4,
      fixed: false,
      minutesPerDay: 60,
      minutesPerCard: 15,
      reviews: 0,
    });
  }, 60_000);

  it("RG-S6-9: under five human reviews the prior holds; at five, a median under two minutes counts as two (60 minutes a day gives 30)", async () => {
    const r = g6Repo();
    for (let i = 1; i <= 5; i++)
      await inReview(r, `q${i}`, { files: { [`src/q${i}.ts`]: `export const q${i} = ${i};\n` } });
    // Four quick decisions, made at the terminal: the prior still holds.
    for (let i = 1; i <= 4; i++) {
      const out = cliIn(r, ["accept", `q${i}`]);
      expect(out.status, out.stderr).toBe(0);
    }
    expect(await reviewLimit(r)).toMatchObject({ limit: 4, minutesPerCard: 15, reviews: 4 });
    // The fifth: the measured median (well under a minute) counts as two minutes.
    expect(cliIn(r, ["accept", "q5"]).status).toBe(0);
    expect(await reviewLimit(r)).toMatchObject({ limit: 30, minutesPerCard: 2, reviews: 5 });
  }, 120_000);
});

describe("RG-N5-3, RG-N5-4: CODEOWNERS on the Review desk and at Accept", () => {
  const ALICE = "p_alice";
  const CODEOWNERS = "* @carol-gh\n/src/ @alice-gh @octo-org/reviewers\n/docs/ @bob-gh\n";

  /** CODEOWNERS on main, Alice linked to her GitHub login. */
  async function owned(r: G6Repo, requireOwner: boolean): Promise<void> {
    write(r.repo, ".github/CODEOWNERS", CODEOWNERS);
    r.git("add", ".github/CODEOWNERS");
    r.git("commit", "-q", "-m", "owners");
    if (requireOwner)
      write(
        r.repo,
        ".sekhemet/config.toml",
        '[review]\nintegration_branch = "main"\nrequire_code_owner_accept = true\n',
      );
    await r.ledger(async ({ store }) => {
      await store.linkIdentity(ALICE, "github", "alice-gh", ALICE);
    });
  }

  it("RG-N5-3: a card with a declared scope is shown with its suggested accepters, from the last matching pattern for each file", async () => {
    const r = g6Repo();
    await owned(r, false);
    await inReview(r, "o1", {
      files: { "src/b.ts": "export const b = 2;\n" },
      scope: ["src/a.ts"],
    });
    const desk = await getFromServe(r, "/api/cards/o1/review");
    expect(desk.suggestedAccepters).toEqual({
      principals: [ALICE],
      unmapped: ["@octo-org/reviewers"],
    });
  }, 60_000);

  it("RG-N5-4: with code-owner acceptance required, the desk and `sekhemet accept` refuse a person who owns none of the card's files, naming the owners", async () => {
    const r = g6Repo();
    await owned(r, true);
    await inReview(r, "o2", { files: { "src/b.ts": "export const b = 2;\n" } });
    const desk = await getFromServe(r, "/api/cards/o2/review");
    expect(desk.accept).toMatchObject({ may: false, code: "not_code_owner" });
    expect(JSON.stringify(desk.accept)).toContain(ALICE);
    const old = r.git("rev-parse", "main");
    const out = cliIn(r, ["accept", "o2", "--json"]);
    expect(out.status).toBe(1);
    expect(JSON.parse(out.stdout.trim())).toMatchObject({ refusal: "not_code_owner" });
    expect(out.stderr).toContain(ALICE);
    expect(r.git("rev-parse", "main")).toBe(old);
    expect(await statusOf(r, "o2")).toBe("review");
  }, 60_000);

  it("RG-N5-4: a code owner of the card's files accepts it", async () => {
    const r = g6Repo();
    await owned(r, true);
    const me = await localPrincipal(r);
    await r.ledger(async ({ store }) => {
      await store.linkIdentity(me, "github", "alice-gh", me);
    });
    await inReview(r, "o3", { files: { "src/b.ts": "export const b = 2;\n" } });
    const desk = await getFromServe(r, "/api/cards/o3/review");
    expect(desk.accept).toEqual({ may: true });
    const out = cliIn(r, ["accept", "o3"]);
    expect(out.status, out.stderr).toBe(0);
    expect(await statusOf(r, "o3")).toBe("done");
  }, 60_000);
});

describe("RG-S5-19: the Review diff of a card whose worktree is gone", () => {
  it("RG-S5-19: GET /api/cards/<id>/diff computes the change from refs and writes nothing to the person's repository", async () => {
    const r = g6Repo();
    await inReview(r, "w1", { files: { "src/b.ts": "export const b = 2;\n" } });
    r.git("worktree", "remove", "--force", ".sekhemet/worktrees/w1");
    write(r.repo, "src/a.ts", "export const a = 7; // unsaved\n");
    const before = r.snapshot();
    const refs = r.git("for-each-ref");
    const worktrees = r.git("worktree", "list", "--porcelain");
    const diff = await getFromServe(r, "/api/cards/w1/diff");
    expect(String(diff.text)).toContain("src/b.ts");
    expect(String(diff.text)).toContain("export const b = 2;");
    expect((diff.groups as Record<string, string[]>).source).toContain("src/b.ts");
    expect(r.snapshot()).toEqual(before);
    expect(r.git("for-each-ref")).toBe(refs);
    expect(r.git("worktree", "list", "--porcelain")).toBe(worktrees);
    expect(r.git("status", "--porcelain")).toBe("M src/a.ts");
  }, 60_000);
});

describe("RG-S6-2, RG-S6-8: ReviewWIP's defaults and a refused review budget", () => {
  it("RG-S6-2: a project with no review recorded and no review_minutes_per_day gets 60 minutes a day and the 15-minute prior: ReviewWIP 4, not the static 3", async () => {
    const r = g6Repo();
    await r.ledger(({ store }) => store.ensureProject({ rootPath: r.repo, name: "Timesheet" }));
    expect(await reviewLimit(r)).toMatchObject({
      limit: 4,
      fixed: false,
      minutesPerDay: 60,
      minutesPerCard: 15,
      reviews: 0,
    });
  }, 60_000);

  it("RG-S6-8: review_minutes_per_day = 0 is refused, in the configuration file and on the Configuration page, naming the key; ReviewWIP still comes from 60 minutes, never the static 3", async () => {
    const r = g6Repo();
    const project = await r.ledger(
      async ({ store }) => (await store.ensureProject({ rootPath: r.repo, name: "Timesheet" })).id,
    );
    write(r.repo, ".sekhemet/config.toml", "[review]\nreview_minutes_per_day = 0\n");
    // The configuration file: refused, and the default applies.
    const doctor = cliIn(r, ["doctor"]);
    expect(doctor.stdout + doctor.stderr).toMatch(
      /review\.review_minutes_per_day must be greater than 0 \(got 0\)/,
    );
    expect(await reviewLimit(r)).toMatchObject({ limit: 4, minutesPerDay: 60 });
    // The Configuration page: refused, naming the key, nothing recorded.
    const refused = await withServe(r, async (base) => {
      const res = await fetch(`${base}/api/config/review`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ project, minutesPerDay: 0 }),
      });
      return { status: res.status, body: (await res.json()) as { key?: string; error?: string } };
    });
    expect(refused.status).toBe(400);
    expect(refused.body.key).toBe("review_minutes_per_day");
    expect(await r.ledger(({ log }) => log.getEventsByTypes(["project/review_hours"]))).toEqual([]);
    expect(await reviewLimit(r)).toMatchObject({ limit: 4, minutesPerDay: 60 });
  }, 90_000);
});

describe("RG-N6-1, RG-1: request changes, by either name and from the page, is one decision", () => {
  const B = { "src/b.ts": "export const b = 2;\n" };
  const DECISION = [
    "card/status_changed",
    "card/sent_back",
    "review/decided",
    "playbook/candidate",
  ];

  it("RG-1, RG-N6-1: an empty reason is refused by `send-back`, by `request-changes` and by the Review desk, and the card stays in Review", async () => {
    const r = g6Repo();
    await inReview(r, "e1", { files: B });
    const before = await eventsOf(r, "e1", DECISION);
    for (const name of ["send-back", "request-changes"]) {
      for (const reason of [[], [""], ["   "]]) {
        const out = cliIn(r, [name, "e1", ...reason]);
        expect(out.status, `${name} ${JSON.stringify(reason)}`).not.toBe(0);
      }
    }
    const desk = await withServe(r, async (base) => {
      const res = await fetch(`${base}/api/cards/e1/return`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ reason: " " }),
      });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    });
    expect(desk.status).toBe(400);
    expect(desk.body.error).toMatch(/needs a reason/);
    expect(await statusOf(r, "e1")).toBe("review");
    expect(await eventsOf(r, "e1", DECISION)).toEqual(before);
  }, 90_000);

  it("RG-N6-1: `send-back`, `request-changes` and the desk's Request changes move the card to To do and record the same events", async () => {
    const r = g6Repo();
    for (const id of ["a1", "a2", "a3"])
      await inReview(r, id, { files: { [`src/${id}.ts`]: `export const ${id} = 1;\n` } });
    const reason = "use the shared helper in src/shared.ts";
    expect(cliIn(r, ["send-back", "a1", reason]).status).toBe(0);
    expect(cliIn(r, ["request-changes", "a2", reason]).status).toBe(0);
    const desk = await withServe(r, async (base) => {
      const res = await fetch(`${base}/api/cards/a3/return`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ reason }),
      });
      return res.status;
    });
    expect(desk).toBe(200);
    // The decision's events: what each card recorded after it was put in Review.
    const shape = async (id: string) =>
      (await eventsOf(r, id, DECISION)).slice(1).map((e) => ({
        type: e.type,
        to: e.payload.toStatus,
        decision: e.payload.decision,
      }));
    const first = await shape("a1");
    expect(first.length).toBeGreaterThan(0);
    expect(first.some((e) => e.type === "card/status_changed" && e.to === "ready")).toBe(true);
    expect(await shape("a2")).toEqual(first);
    expect(await shape("a3")).toEqual(first);
    for (const id of ["a1", "a2", "a3"]) expect(await statusOf(r, id)).toBe("ready");
  }, 90_000);
});
