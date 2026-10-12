import { describe, expect, it, vi } from "vitest";

// The browser module's DOM helpers need a page; its words do not.
vi.mock("../web/dom.js", () => ({
  esc: (v: unknown) => String(v ?? ""),
  getJSON: async () => ({ ok: true, status: 200, data: {} }),
  postJSON: async () => ({ ok: true, status: 200, data: {} }),
}));

const { quickSetupMissing } = await import("../web/config_benchmark.js");

/**
 * Wave 2 A8 (dashboard §2.16 item 1, DB-N27-7): Configuration › Models offers
 * the quick benchmark of its setup only when Benchmark could run it — its
 * Coding and Planning models are among the models found on this machine, the
 * ones Benchmark's pickers list. Otherwise it says which model is missing.
 */
describe("A8: Models offers only a quick benchmark Benchmark can set up", () => {
  const found = [{ id: "qwen-coder.gguf", registryId: "qwen-coder", name: "Qwen coder" }];

  it("names a setup model that is not on this machine", () => {
    expect(quickSetupMissing({ worker: "nail-mtp", planner: "nail-mtp" }, [])).toBe(
      "The quick benchmark needs the Coding model and the Planning model on this machine: nail-mtp is not in a model folder yet.",
    );
    expect(quickSetupMissing({ worker: "qwen-coder", planner: "gemma" }, found)).toBe(
      "The quick benchmark needs the Coding model and the Planning model on this machine: gemma is not in a model folder yet.",
    );
  });

  // Review finding 7: the five parts load in parallel, and the models read can
  // fail; with no list read there is no record that a model is missing.
  it("claims no model missing before the models are read, or when the read failed", () => {
    const setup = { worker: "nail-mtp", planner: "nail-mtp" };
    expect(quickSetupMissing(setup, undefined)).toBe("Checking the models on this machine…");
    expect(quickSetupMissing(setup, undefined, "The server returned 500.")).toBe(
      "Couldn't read the models on this machine, so the quick benchmark isn't offered: The server returned 500.",
    );
    for (const words of [
      quickSetupMissing(setup, undefined),
      quickSetupMissing(setup, undefined, "x"),
    ])
      expect(words).not.toMatch(/not in a model folder/);
  });

  it("a setup Benchmark's pickers list (by file or registry id) can run", () => {
    expect(quickSetupMissing({ worker: "qwen-coder", planner: "qwen-coder.gguf" }, found)).toBe("");
  });
});
