import { describe, expect, it, vi } from "vitest";

// The browser module's DOM helpers need a page; its words and choices do not.
vi.mock("../web/dom.js", () => ({
  $: () => null,
  announce: () => undefined,
  copyText: async () => undefined,
  esc: (v: unknown) => String(v ?? ""),
  getJSON: async () => ({ ok: true, status: 200, data: {} }),
  icon: () => "",
  postJSON: async () => ({ ok: true, status: 200, data: {} }),
  sendJSON: async () => ({ ok: true, status: 200, data: {} }),
  setCsrf: () => undefined,
}));

const { assignChoices, fitWords, roleHeadline } = await import("../web/config_models.js");
const { quickSetupMissing } = await import("../web/config_benchmark.js");

/**
 * Loop wave 7 B (sweep 4): Configuration › Models' rows from one source.
 * B1: a role with no assignment names the model `run` would use and where it
 * comes from, as `models list` and Machine do, never *No model · Not
 * configured* beside a CLI that names nail-mtp. B3: the Review picker offers
 * no model of the Coding model's family (RG-P8-10). B4: an unverified model
 * offers *Verify on this machine to assign* before the press. B5: a found
 * model is matched by the key the setup names it by. B7: a fit far above the
 * file's size says what it is made of.
 */
describe("B1: each role's model, from the one effective-role source", () => {
  it("names the default the harness would run, with where it comes from and that it is not here", () => {
    const h = roleHeadline({
      role: "worker",
      state: "not_configured",
      effective: {
        model: "nail-mtp",
        source: "default",
        from: "the default for this machine's memory",
        present: false,
      },
    });
    expect(h.model).toBe("nail-mtp");
    expect(h.words).toBe(
      "Not assigned: the default for this machine's memory. Not in a model folder on this machine yet",
    );
    expect(h.words).not.toMatch(/Not configured/);
  });

  it("says Not configured only when no model would run, and keeps an assigned model's state", () => {
    expect(
      roleHeadline({
        role: "researcher",
        state: "not_configured",
        effective: { source: "none", from: "research runs once one is assigned" },
      }),
    ).toEqual({ model: "", words: "Not configured" });
    expect(roleHeadline({ role: "worker", model: "mine", state: "resident" })).toEqual({
      model: "mine",
      words: "Resident",
    });
  });
});

describe("B3 and B4: the picker and its button", () => {
  const found = [
    { id: "sha-q", key: "dummy-qwen-test-7b", name: "Dummy Qwen Test 7B", family: "qwen" },
    { id: "sha-g", key: "gemma-small", name: "Gemma Small", family: "gemma" },
    { id: "sha-u", key: "mystery", name: "Mystery" },
  ];

  it("offers the Review model no model of the Coding model's family, nor of an unknown family", () => {
    const c = assignChoices({ role: "reviewer", codingFamily: "qwen", verifiedModels: [] }, found);
    expect(c.options.map((o: { name: string }) => o.name)).toEqual(["Gemma Small"]);
    const none = assignChoices({ role: "reviewer", codingFamily: "qwen" }, [found[0], found[2]]);
    expect(none.options).toEqual([]);
    expect(none.action).toBe("");
  });

  it("an unverified model's button is Verify on this machine to assign; a verified one's is Assign", () => {
    const row = { role: "worker", verifiedModels: ["gemma-small"] };
    expect(assignChoices(row, found).action).toBe("qualify");
    expect(assignChoices(row, found, "sha-g").action).toBe("assign");
    expect(
      assignChoices({ ...row, recommendation: { model: "gemma-small" } }, found).options.find(
        (o: { selected: boolean }) => o.selected,
      )?.id,
    ).toBe("sha-g");
  });
});

describe("B5: Compare setups finds a model the folder lists", () => {
  it("matches the setup's model by the found model's key", () => {
    const models = [
      { id: "/m/dummy/w.gguf", name: "Dummy Qwen Test 7B", key: "dummy-qwen-test-7b" },
    ];
    expect(
      quickSetupMissing({ worker: "dummy-qwen-test-7b", planner: "dummy-qwen-test-7b" }, models),
    ).toBe("");
  });
});

describe("B7: a fit says what it is made of when the file is a small part of it", () => {
  it("a 0.0 GB file that needs 4.3 GB says the rest is the context cache and buffers", () => {
    const m = {
      sizeBytes: 183,
      fitReason: { worker: "4.3 GB of 20.4 GB usable" },
      fit: {
        worker: {
          breakdown: {
            weightsBytes: 183,
            kvBytes: 3.2e9,
            computeBufferBytes: 1.0e9,
            promptCacheBytes: 0.1e9,
            contextTokens: 32768,
          },
        },
      },
    };
    expect(fitWords(m, "worker")).toBe(
      "4.3 GB of 20.4 GB usable: the file is 0.0 GB; the rest is the context cache at 32,768 tokens and the engine's buffers, estimated",
    );
    const big = {
      fitReason: { worker: "14.0 GB of 20.4 GB usable" },
      fit: {
        worker: {
          breakdown: {
            weightsBytes: 12e9,
            kvBytes: 1e9,
            computeBufferBytes: 1e9,
            promptCacheBytes: 0,
            contextTokens: 32768,
          },
        },
      },
    };
    expect(fitWords(big, "worker")).toBe("14.0 GB of 20.4 GB usable");
  });
});

describe("B6: Benchmark in the product's words, each instruction once", () => {
  it("one line under Run quick when both runs wait for the same two models", async () => {
    const { quickDisabledReason, overnightDisabledReason, runReasons } = await import(
      "../web/config_benchmark.js"
    );
    const pick = {};
    const r = runReasons(
      quickDisabledReason({ readOnly: "", pick, models: [], busy: undefined }),
      overnightDisabledReason({ readOnly: "", pick, picks: [] }),
    );
    expect(r.quick).toBe("Choose a Coding model and a Planning model to run either benchmark.");
    expect(r.overnight).toBe("");
    expect(r.shared).toBe(true);
    // A different reason for each stays two lines.
    expect(
      runReasons(
        "A run is going.",
        "Choose a Coding model and a Planning model, or run quick benchmarks to compare first.",
      ).shared,
    ).toBe(false);
  });

  it("the verdicts, the scores and the copy use no internal words", async () => {
    const { tuneVerdictText, externalHtml, TUNE_COPY } = await import("../web/config_benchmark.js");
    const words = [
      tuneVerdictText({ state: "done", verdict: "worse", survivor: { words: "temperature 0.2" } }),
      tuneVerdictText({ state: "done", verdict: "none" }),
      tuneVerdictText({ state: "running", rung: 2 }),
      externalHtml({
        capstone: [],
        webbench: [
          { arm: "sekhemet", run: 1, scores: { "pass@1": 0.25, "pass@2": 0.35, "error@1": 0.1 } },
        ],
        protocol: {},
      }),
      TUNE_COPY,
    ].join("\n");
    expect(words).not.toMatch(/screen|pass@|error@|non-zero|harness-and-model|On six issues only/);
    expect(words).toMatch(/passed on the first try 25%/);
  });
});
