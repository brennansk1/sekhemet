import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REVIEW_REPLY_SCHEMA } from "../src/learning/review_copy.js";
import {
  CRITERIA,
  REVIEWER,
  SAME_FAMILY_REVIEWER,
  WORKER,
  scriptedReviewProject,
} from "./support/g6_models.js";
import { BIN, type G6Repo, eventsOf, g6Repo, statusOf, write } from "./support/g6_review.js";

/**
 * review-git P8, the Reviewer, at the door (C2d, FINDINGS_C1 TST-01): a
 * spawned `sekhemet queue` builds a card with a scripted Worker, then the
 * run's Review role — a scripted Reviewer of another family — reviews it
 * before it reaches Review; `sekhemet serve` then shows the findings on the
 * Review desk, and `sekhemet review` in the terminal. The scripted models
 * answer at the HTTP boundary (`support/g6_models.ts`); what the product sent
 * the Reviewer is read back from the request log.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

interface Run {
  r: G6Repo;
  status: number | null;
  out: string;
  requests: Record<string, unknown>[];
}

/** `sekhemet queue` with the scripted Worker and `reviewer`, the Reviewer replying in `mode`. */
async function queueWithReviewer(
  opts: {
    reviewer?: string;
    mode?: "json" | "prose" | "cut";
    flags?: string[];
    env?: Record<string, string>;
    /** The environment the models were qualified under; default `env`. */
    qualifiedUnder?: Record<string, string>;
    before?: (r: G6Repo) => void;
  } = {},
): Promise<Run> {
  const r = g6Repo();
  const reviewer = opts.reviewer ?? REVIEWER;
  const project = await scriptedReviewProject(r, {
    reviewers: [reviewer],
    env: opts.qualifiedUnder ?? opts.env ?? {},
  });
  opts.before?.(r);
  const log = join(r.root, "reviewer-requests.jsonl");
  const out = spawnSync(
    process.execPath,
    [
      ...project.nodeArgs,
      BIN,
      "queue",
      "--worker",
      WORKER,
      "--reviewer",
      reviewer,
      ...(opts.flags ?? []),
    ],
    {
      cwd: r.repo,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...r.env({ env: project.env }),
        G6_REQUEST_LOG: log,
        G6_REVIEW_MODE: opts.mode ?? "json",
        ...opts.env,
      },
    },
  );
  const requests = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return { r, status: out.status, out: out.stdout + out.stderr, requests };
}

/** `sekhemet serve`, then the card's Review desk over HTTP. */
async function reviewDesk(r: G6Repo, id: string): Promise<Record<string, unknown>> {
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
    const res = await fetch(`${address}/api/cards/${id}/review`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    child.kill("SIGTERM");
  }
}

/** The card's AI review entries on its dossier, in order. */
async function reviewEntries(r: G6Repo, id: string) {
  return r.ledger(async ({ store }) => (await store.getDossier(id)).reviews);
}

describe("RG-P8-1, RG-P8-12, RG-P8-18: the Reviewer reviews a passing card before it reaches Review", () => {
  it("RG-P8-1: one finding per acceptance criterion, each with a verdict and a file:line, recorded before the card enters Review", async () => {
    const { r, status, out } = await queueWithReviewer();
    expect(status, out).toBe(0);
    expect(out).toMatch(new RegExp(`AI review of c1 \\(${REVIEWER}\\)`));
    expect(await statusOf(r, "c1")).toBe("review");
    const entries = await reviewEntries(r, "c1");
    for (const [i, criterion] of CRITERIA.entries()) {
      const e = entries.find((x) => x.text.startsWith(criterion));
      expect(e, `criterion ${i + 1}`).toBeDefined();
      expect(["met", "unmet", "unclear"]).toContain(e?.verdict);
      expect(e?.text).toMatch(/\(src\/a\.ts:1\)/);
    }
    expect(entries.find((x) => x.text.startsWith(CRITERIA[0] as string))?.verdict).toBe("met");
    expect(entries.find((x) => x.text.startsWith(CRITERIA[1] as string))?.verdict).toBe("unmet");
    // Recorded before the card appeared in the Review queue.
    const toReview = (await eventsOf(r, "c1", ["card/status_changed"])).find(
      (e) => e.payload.toStatus === "review",
    );
    expect(toReview).toBeDefined();
    for (const e of entries) expect(e.seq).toBeLessThan(toReview?.seq ?? 0);
  }, 150_000);

  it("RG-P8-12: the Review desk served by `sekhemet serve` attributes the findings to the Reviewer and its model id, and show no model-stated confidence", async () => {
    const { r, status, out } = await queueWithReviewer();
    expect(status, out).toBe(0);
    const desk = await reviewDesk(r, "c1");
    const findings = desk.findings as { modelId?: string; text: string }[];
    expect(findings.length).toBeGreaterThanOrEqual(CRITERIA.length);
    for (const f of findings) expect(f.modelId).toBe(REVIEWER);
    expect(JSON.stringify(desk)).not.toMatch(/confiden/i);
    const entries = await reviewEntries(r, "c1");
    for (const e of entries) expect(e.actor).toBe("reviewer");
  }, 150_000);

  it("RG-P8-18: every Reviewer request names the reply's JSON schema, REVIEW_REPLY_SCHEMA, as Ollama's `format`", async () => {
    const { status, out, requests } = await queueWithReviewer();
    expect(status, out).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    for (const body of requests) {
      expect(body.model).toBe(REVIEWER);
      expect(body.format).toEqual(REVIEW_REPLY_SCHEMA);
    }
  }, 150_000);
});

describe("RG-P8-16: a Reviewer reply cut at its cap, or with no readable JSON, is a failed review", () => {
  for (const mode of ["prose", "cut"] as const) {
    it(`RG-P8-16: a reply ${mode === "cut" ? "ended at its length cap" : "with no readable JSON"} is recorded on the card as a failed review with its reason, shown on Review, never as findings or a clean pass`, async () => {
      const { r, status, out, requests } = await queueWithReviewer({ mode });
      expect(requests.length).toBeGreaterThan(0);
      expect(status, out).toBe(0);
      expect(await statusOf(r, "c1")).toBe("review");
      const entries = await reviewEntries(r, "c1");
      // Not read as findings: no criterion judged, nothing marked met or unclear.
      for (const c of CRITERIA) expect(entries.some((e) => e.text.startsWith(c))).toBe(false);
      expect(entries.some((e) => e.verdict === "met")).toBe(false);
      const failed = entries.filter((e) => /AI review could not run/.test(e.text));
      expect(failed).toHaveLength(1);
      expect(failed[0]?.text).toMatch(mode === "cut" ? /length|cap|cut/i : /JSON|readable/i);
      const desk = await reviewDesk(r, "c1");
      expect(JSON.stringify(desk)).toMatch(/AI review could not run/);
    }, 150_000);
  }

  it("RG-P8-16: every Reviewer request states its thinking cap as well as its answer cap", async () => {
    const { status, out, requests } = await queueWithReviewer();
    expect(status, out).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    for (const body of requests) {
      // The answer cap, and the thinking cap: this Reviewer thinks not at all, and says so.
      const options = body.options as Record<string, unknown>;
      expect(options.num_predict).toBeGreaterThan(0);
      expect(body.think).toBe(false);
      expect(body.reasoning_effort).toBe("none");
    }
  }, 150_000);

  const measured = (x: G6Repo) =>
    write(
      x.repo,
      ".sekhemet/measurement.json",
      JSON.stringify({ purpose: "frozen suite", by: "test", createdAt: new Date().toISOString() }),
    );

  it("RG-P8-16: `--auto-accept` refuses a card whose review failed; it stays In review", async () => {
    const { r, status, out } = await queueWithReviewer({
      mode: "prose",
      flags: ["--auto-accept"],
      before: measured,
    });
    expect(status, out).not.toBeNull();
    expect(await statusOf(r, "c1")).toBe("review");
    expect(await eventsOf(r, "c1", ["card/accepted"])).toEqual([]);
    expect(r.git("show", "main:src/a.ts")).toBe("");
  }, 150_000);

  it("RG-P8-16, RG-S5-8: the same run with a review that reads is auto-accepted: actor harness, auto: true, the enabling person as principal", async () => {
    const { r, status, out } = await queueWithReviewer({
      mode: "json",
      flags: ["--auto-accept"],
      before: measured,
    });
    expect(status, out).toBe(0);
    expect(await statusOf(r, "c1")).toBe("done");
    const [accepted] = await eventsOf(r, "c1", ["card/accepted"]);
    const me = await r.ledger(({ log }) => log.localPrincipal());
    expect(accepted?.actor).toBe("harness");
    expect(accepted?.payload).toMatchObject({ auto: true, principal: me });
    const enabled = await r.ledger(({ log }) =>
      log.getEventsByTypes(["review/auto_accept_enabled"]),
    );
    expect(enabled.map((e) => (e.payload as { principal: string }).principal)).toEqual([me]);
    expect(r.git("log", "-1", "--format=%B", "main")).toMatch(
      /Accepted-by: sekhemet --auto-accept \(for Jane Doe <jane@example\.com>\)/,
    );
    expect(r.git("show", "main:src/a.ts")).toBe("export const a = 1;");
  }, 150_000);
});

describe("RG-P8-10: a Reviewer of the Worker's family leaves the role unfilled", () => {
  it("RG-P8-10: with only a same-family model named, no review runs, and Review shows why", async () => {
    const { r, status, out, requests } = await queueWithReviewer({
      reviewer: SAME_FAMILY_REVIEWER,
    });
    expect(status, out).toBe(0);
    expect(requests).toEqual([]);
    expect(await statusOf(r, "c1")).toBe("review");
    const entries = await reviewEntries(r, "c1");
    expect(entries.map((e) => e.verdict)).toEqual(["not_reviewed"]);
    expect(entries[0]?.text).toMatch(/outside the Coding model's family/);
    const desk = await reviewDesk(r, "c1");
    expect(JSON.stringify(desk)).toMatch(/outside the Coding model's family/);
  }, 150_000);
});

describe("RG-P8-17: the Reviewer's method is a recorded experiment switch", () => {
  const PROVE = { SEKHEMET_REVIEW_METHOD: "prove" };

  it("RG-P8-17: SEKHEMET_REVIEW_METHOD=prove reviews with the prove copy; unset, with baseline", async () => {
    const baseline = await queueWithReviewer();
    const prove = await queueWithReviewer({ env: PROVE });
    expect(baseline.status, baseline.out).toBe(0);
    expect(prove.status, prove.out).toBe(0);
    const system = (run: Run) =>
      ((run.requests[0]?.messages as { role: string; content: string }[]) ?? []).find(
        (m) => m.role === "system",
      )?.content ?? "";
    expect(system(baseline)).not.toBe("");
    expect(system(prove)).not.toBe("");
    expect(system(prove)).not.toBe(system(baseline));
    // Each is a review, recorded on the card.
    for (const run of [baseline, prove])
      expect((await reviewEntries(run.r, "c1")).some((e) => e.verdict === "met")).toBe(true);
  }, 300_000);

  it("RG-P8-17: the method is part of the Review role's context version: a Reviewer qualified under baseline is not used under prove", async () => {
    const run = await queueWithReviewer({ env: PROVE, qualifiedUnder: {} });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toMatch(/context version changed since it qualified/);
    expect(run.requests).toEqual([]);
    const entries = await reviewEntries(run.r, "c1");
    expect(entries.map((e) => e.verdict)).toEqual(["not_reviewed"]);
  }, 150_000);

  it("RG-P8-17: any value but baseline or prove is refused, and nothing is reviewed with it", async () => {
    const run = await queueWithReviewer({
      env: { SEKHEMET_REVIEW_METHOD: "sloppy" },
      qualifiedUnder: {},
    });
    expect(run.out).toMatch(/SEKHEMET_REVIEW_METHOD is baseline or prove, not sloppy/);
    expect(run.requests).toEqual([]);
    expect((await reviewEntries(run.r, "c1")).some((e) => e.verdict === "met")).toBe(false);
  }, 150_000);
});

/** `sekhemet measure reviewer …` with the scripted Reviewer replying in `mode`. */
async function measureReviewer(args: string[], mode: "json" | "prose" = "json") {
  const r = g6Repo();
  const project = await scriptedReviewProject(r);
  const out = spawnSync(
    process.execPath,
    [...project.nodeArgs, BIN, "measure", "reviewer", "--model", REVIEWER, ...args],
    {
      cwd: r.repo,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...r.env({ env: project.env }), G6_REVIEW_MODE: mode },
    },
  );
  const events = await r.ledger(({ db }) =>
    (
      db
        .prepare("SELECT type, payload FROM events WHERE type LIKE 'measure/%' ORDER BY seq")
        .all() as { type: string; payload: string }[]
    ).map((e) => ({ type: e.type, payload: JSON.parse(e.payload) as Record<string, unknown> })),
  );
  return { r, status: out.status, out: out.stdout + out.stderr, events };
}

const TWO = "onyx-vault-project-case,onyx-vault-key-lower-tail";

describe("RG-P8-13, RG-P8-16, RG-P8-17: `sekhemet measure reviewer` on the seeded-defect set", () => {
  it("RG-P8-13: records the Reviewer's recall and each card's catch and false positives, with the per-card verdict", async () => {
    const { status, out, events } = await measureReviewer(["--only", TWO]);
    expect(status, out).toBe(0);
    expect(out).toMatch(/Reviewing 22 seeded defects/);
    const [e] = events.filter((x) => x.type === "measure/reviewer_seeded");
    expect(e?.payload).toMatchObject({ model: REVIEWER, items: 2, partial: true });
    expect(typeof e?.payload.recall).toBe("number");
    expect(typeof e?.payload.passes).toBe("boolean");
    const perItem = e?.payload.perItem as { id: string; caught: boolean; falsePositives: number }[];
    expect(perItem.map((p) => p.id).sort()).toEqual(TWO.split(",").sort());
    for (const p of perItem) {
      expect(typeof p.caught).toBe("boolean");
      expect(p.falsePositives).toBeGreaterThanOrEqual(0);
    }
    // The verdict is counted on each card: more than one false positive on any card fails it.
    if (perItem.some((p) => p.falsePositives > 1)) expect(e?.payload.passes).toBe(false);
  }, 150_000);

  it("RG-P8-16: a review with no readable JSON is counted apart: its reason is on the ledger event and recall excludes it", async () => {
    const { status, out, events } = await measureReviewer(["--only", TWO], "prose");
    expect(status, out).toBe(0);
    const [e] = events.filter((x) => x.type === "measure/reviewer_seeded");
    expect(e?.payload).toMatchObject({ items: 2, reviewed: 0, failed: 2, caught: 0 });
    const perItem = e?.payload.perItem as {
      caught: boolean;
      falsePositives: number;
      failed?: string;
    }[];
    for (const p of perItem) {
      expect(p.failed).toMatch(/\w/);
      expect(p.caught).toBe(false);
      expect(p.falsePositives).toBe(0);
    }
    expect(e?.payload.passes).toBe(false);
  }, 150_000);

  it("RG-P8-17: `--method prove` reviews the set with the current method and the candidate's, paired item by item, records the comparison and each arm's verdict, and adopts nothing", async () => {
    const { r, status, out, events } = await measureReviewer(["--method", "prove", "--only", TWO]);
    expect(status, out).toBe(0);
    expect(out).toMatch(/current \(method baseline/);
    expect(out).toMatch(/candidate \(method prove/);
    expect(out).toMatch(/Nothing is adopted/);
    const [e] = events.filter((x) => x.type === "measure/settings_tuned");
    expect(e?.payload).toMatchObject({ kind: "paired_ab", role: "reviewer", model: REVIEWER });
    const comparison = e?.payload.comparison as Record<string, number>;
    expect(comparison.better + comparison.worse + comparison.ties).toBe(2);
    expect(comparison.p).toBeGreaterThanOrEqual(0);
    expect(comparison.p).toBeLessThanOrEqual(1);
    const arms = e?.payload.candidates as {
      id: string;
      values: Record<string, unknown>;
      passes: boolean;
    }[];
    expect(arms.map((a) => [a.id, a.values.reviewMethod])).toEqual([
      ["current", "baseline"],
      ["candidate", "prove"],
    ]);
    for (const a of arms) expect(typeof a.passes).toBe("boolean");
    // Nothing adopted: the Review role's recorded settings name no method.
    expect(readFileSync(join(r.home, ".sekhemet", "models.json"), "utf8")).not.toContain("prove");
    // And `--method` takes baseline or prove only.
    expect(
      spawnSync(process.execPath, [BIN, "measure", "reviewer", "--method", "sloppy"], {
        cwd: r.repo,
        encoding: "utf8",
        env: r.env(),
      }).stdout,
    ).toMatch(/--method is baseline or prove, not sloppy/);
  }, 200_000);
});
