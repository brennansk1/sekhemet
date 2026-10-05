import { describe, expect, it } from "vitest";
import type { FitLabel, FoundModel } from "../src/library_types.js";
import {
  type CombinationCandidate,
  type RoleEvidence,
  candidatesFor,
  rankCombinations,
  recommendRole,
  timePerCard,
} from "../src/recommend.js";

// MD-N12-4, MD-N12-5, MD-N14-42, DB-NM14-6: one model per role that fits,
// with its reason; the Reviewer from another family; indistinguishable
// candidates said so; combinations by floors, then time per card, then
// footprint, with no weighted score.

const GB = 1e9;
function found(name: string, family: string | undefined, fits: FitLabel, sizeGb = 10): FoundModel {
  return {
    id: name,
    name,
    file: `${name}.gguf`,
    folder: "/m",
    ...(family ? { family } : {}),
    sizeBytes: sizeGb * GB,
    quantisation: "Q4_K_M",
    contextLength: 32768,
    fits: { worker: fits, planner: fits, reviewer: fits, researcher: fits },
    fitReason: {
      reviewer: fits === "no" ? "Needs 4.0 GB more" : `${sizeGb}.0 GB of 16.0 GB usable`,
    },
    path: `/m/${name}.gguf`,
    format: "gguf",
    hash: "not_registry",
    metadata: {},
  };
}

const none: RoleEvidence = { qualification: "missing" };

describe("candidatesFor (MD-N12-4, models rule 3)", () => {
  it("excludes from the Reviewer the Worker's family and any unknown family, and every model that does not fit", () => {
    const models = [
      found("qwen-a", "qwen", "yes"),
      found("gemma-b", "gemma", "yes"),
      found("mystery", undefined, "yes"),
      found("llama-huge", "llama", "no"),
    ];
    const c = candidatesFor("reviewer", models, { workerFamily: "qwen" });
    expect(c.eligible.map((m) => m.name)).toEqual(["gemma-b"]);
    expect(Object.fromEntries(c.excluded.map((x) => [x.model, x.reason]))).toMatchObject({
      "qwen-a": expect.stringMatching(/Coding model's family/),
      mystery: expect.stringMatching(/family is unknown/),
      "llama-huge": expect.stringMatching(/Needs/),
    });
  });
});

describe("recommendRole (MD-N12-4, MD-N12-5)", () => {
  it("prefers a qualified model, and gives one sentence naming its evidence", () => {
    const r = recommendRole({
      role: "reviewer",
      present: [found("gemma-4-26b", "gemma", "yes", 14), found("llama-8b", "llama", "yes", 5)],
      evidence: (m) => (m === "gemma-4-26b" ? { qualification: "qualified" } : none),
      workerFamily: "qwen",
    });
    expect(r.recommendation?.model).toBe("gemma-4-26b");
    expect(r.recommendation?.present).toBe(true);
    const reason = r.recommendation?.reason ?? "";
    expect(reason).toMatch(/different family from the Coding model, which the Review model needs/);
    expect(reason).toMatch(/fits at 14\.0 GB/);
    expect(reason).toMatch(/no quick score yet/);
    expect(reason.split(/(?<=\.)\s/).length).toBe(1);
  });

  it("uses quick scores when they exist, and says two are indistinguishable when the sign test does not reject", () => {
    const items = (xs: number[]) => xs.map((score, i) => ({ id: `w${i}`, score }));
    // 5 better of 6 with 1 tie: p = 0.0625, not rejected (DB-N6-12).
    const a = items([1, 1, 1, 1, 1, 0.5]);
    const b = items([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const r = recommendRole({
      role: "worker",
      present: [found("a", "qwen", "yes", 13), found("b", "qwen", "yes", 9)],
      evidence: (m) => ({
        qualification: "qualified",
        quick: { items: m === "a" ? a : b },
        timePerCardMs: m === "a" ? 600_000 : 500_000,
      }),
    });
    expect(r.recommendation?.indistinguishableFrom).toEqual(["a"]);
    // Tied on the quick benchmark: the least time per card wins.
    expect(r.recommendation?.model).toBe("b");
    expect(r.recommendation?.reason).toMatch(/no clear difference on the quick benchmark/);
  });

  it("orders by score when the sign test rejects (one better on all six items)", () => {
    const items = (xs: number[]) => xs.map((score, i) => ({ id: `w${i}`, score }));
    const r = recommendRole({
      role: "worker",
      present: [found("a", "qwen", "yes"), found("b", "qwen", "yes")],
      evidence: (m) => ({
        qualification: "qualified",
        quick: { items: m === "a" ? items([1, 1, 1, 1, 1, 1]) : items([0, 0, 0, 0, 0, 0]) },
      }),
    });
    expect(r.recommendation?.model).toBe("a");
    expect(r.recommendation?.indistinguishableFrom).toBeUndefined();
  });

  it("recommends from the qualification record and registry alone when the role's screen is not measured", () => {
    const r = recommendRole({
      role: "researcher",
      present: [found("x", "llama", "yes"), found("y", "llama", "yes")],
      evidence: (m) => ({
        qualification: "missing",
        registryDefault: m === "y",
        quick: { items: [{ id: "q", score: 1 }] },
      }),
      screenBuilt: false,
    });
    expect(r.recommendation?.model).toBe("y");
    expect(r.recommendation?.reason).toMatch(/not measured yet/);
  });

  it("offers a registered model that is not present, with Download, only when it beats every present one", () => {
    const remote = [
      {
        id: "gemma-reg",
        name: "Gemma registry",
        family: "gemma",
        fits: "yes" as FitLabel,
        footprintBytes: 14 * GB,
        registryDefault: true,
        source: {
          url: "https://huggingface.co/o/r/resolve/main/g.gguf",
          host: "huggingface.co",
          sha256: "a".repeat(64),
          sizeBytes: 14 * GB,
        },
      },
    ];
    const r = recommendRole({
      role: "reviewer",
      present: [],
      remote,
      evidence: () => none,
      workerFamily: "qwen",
    });
    expect(r.recommendation).toMatchObject({ model: "gemma-reg", present: false });
    expect(r.recommendation?.download).toEqual({
      source: "huggingface.co",
      sizeBytes: 14 * GB,
      sha256: "a".repeat(64),
    });
    const withPresent = recommendRole({
      role: "reviewer",
      present: [found("gemma-local", "gemma", "yes")],
      remote,
      evidence: (m) => (m === "gemma-local" ? { qualification: "qualified" } : none),
      workerFamily: "qwen",
    });
    expect(withPresent.recommendation?.model).toBe("gemma-local");
  });

  it("leaves the role unfilled with the reason in words when nothing is eligible", () => {
    const r = recommendRole({
      role: "reviewer",
      present: [found("qwen-a", "qwen", "yes")],
      evidence: () => none,
      workerFamily: "qwen",
    });
    expect(r.recommendation).toBeUndefined();
    expect(r.unfilledReason).toMatch(/No model outside the Coding model's family/);
  });

  it("assigns, loads and downloads nothing: it is a pure function of its inputs (MD-N12-5)", () => {
    const before = JSON.stringify(found("a", "qwen", "yes"));
    const present = [found("a", "qwen", "yes")];
    recommendRole({ role: "worker", present, evidence: () => none });
    expect(JSON.stringify(present[0])).toBe(before);
  });
});

describe("combinations (MD-N14-42, DB-NM14-6)", () => {
  const cand = (
    id: string,
    family: string,
    sizeGb: number,
    extra: Partial<CombinationCandidate> = {},
  ): CombinationCandidate => ({
    id,
    family,
    footprintBytes: sizeGb * GB,
    fits: "yes",
    floorOk: true,
    ...extra,
  });

  it("time per card is E[attempts] × compute + E[swaps] × C_pair, an estimate while N < 20", () => {
    const t = timePerCard({ attempts: 1.5, computeMs: 400_000, swaps: 2, cPairMs: 300_000, n: 12 });
    expect(t.value).toBe(1.5 * 400_000 + 2 * 300_000);
    expect(t.grade).toBe("estimated");
    expect(timePerCard({ attempts: 1, computeMs: 1, swaps: 0, cPairMs: 0, n: 25 }).grade).toBe(
      "measured",
    );
    expect(timePerCard({ attempts: 1, computeMs: 1, swaps: 0, cPairMs: 0, n: 0 }).grade).toBe(
      "design",
    );
  });

  it("excludes with the reason any combination that breaks the family rule or does not fit, then orders by floors, time per card and footprint", () => {
    const ranked = rankCombinations({
      roles: {
        worker: [cand("qwen-w", "qwen", 13), cand("small-w", "llama", 5, { floorOk: false })],
        reviewer: [
          cand("gemma-r", "gemma", 14),
          cand("qwen-r", "qwen", 9),
          cand("big-r", "mistral", 30, { fits: "no" }),
        ],
      },
      estimate: (c) => ({
        timePerCardMs: { value: c.reviewer === "gemma-r" ? 900_000 : 800_000, grade: "estimated" },
      }),
    });
    const excluded = ranked
      .filter((r) => r.excluded)
      .map((r) => [r.combination.worker, r.combination.reviewer, r.excluded]);
    expect(excluded).toEqual(
      expect.arrayContaining([
        ["qwen-w", "qwen-r", expect.stringMatching(/family/)],
        ["qwen-w", "big-r", expect.stringMatching(/does not fit/)],
      ]),
    );
    const kept = ranked.filter((r) => !r.excluded);
    // The Worker below its floor comes last, whatever its time per card.
    expect(kept.map((r) => `${r.combination.worker}+${r.combination.reviewer}`)).toEqual([
      "qwen-w+gemma-r",
      "small-w+qwen-r",
      "small-w+gemma-r",
    ]);
    for (const r of ranked) expect(Object.keys(r)).not.toContain("score");
  });
});

describe("MD-N21-10 (FINDINGS CFG-03): a role with no candidate is never a met floor", () => {
  const c = (id: string, family: string) => ({
    id,
    family,
    footprintBytes: 10e9,
    fits: "yes" as const,
    floorOk: true,
  });
  const estimate = () => ({ timePerCardMs: { value: 600_000, grade: "estimated" as const } });

  it("returns no combination when no role has a candidate", () => {
    expect(
      rankCombinations({
        roles: { worker: [], planner: [], reviewer: [], researcher: [] },
        estimate,
      }),
    ).toEqual([]);
  });

  it("names an empty role as unfilled on every combination and marks its floors not met", () => {
    const ranked = rankCombinations({
      roles: {
        worker: [c("w", "qwen")],
        planner: [c("p", "qwen")],
        reviewer: [],
        researcher: [c("r", "qwen")],
      },
      estimate,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      combination: { worker: "w", planner: "p", researcher: "r" },
      floorsMet: false,
      unfilled: ["reviewer"],
    });
  });
});
