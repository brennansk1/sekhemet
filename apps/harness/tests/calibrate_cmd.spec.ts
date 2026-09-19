import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest, UnloadableAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { parseModelList, runCalibrate } from "../src/calibrate_cmd.js";

describe("sekhemet calibrate (H3)", () => {
  it("parses name=role lists and rejects unknown roles", () => {
    expect(parseModelList(undefined)).toEqual([{ name: "cyber-tiel", role: "worker" }]);
    expect(parseModelList("cyber-tiel=worker, apodex=researcher")).toEqual([
      { name: "cyber-tiel", role: "worker" },
      { name: "apodex", role: "researcher" },
    ]);
    expect(() => parseModelList("x=chef")).toThrow(/Unknown role/);
  });

  it("measures models one at a time, unloading each before the next, and saves the profile", async () => {
    const events: string[] = [];
    const fake = (id: string): UnloadableAdapter => ({
      modelId: id,
      supportedArms: ["arm_a_flat"],
      async generate(_req: InferenceRequest) {
        events.push(`gen ${id}`);
        return {
          text: "ok",
          toolCalls: [],
          usage: {
            promptTokens: 2048,
            completionTokens: 64,
            durationMs: 1000,
            prefillTokensPerSecond: 400,
            decodeTokensPerSecond: 30,
          },
        };
      },
      async unload() {
        events.push(`unload ${id}`);
      },
    });
    const path = join(mkdtempSync(join(tmpdir(), "cal-")), "machine.json");
    const lines: string[] = [];
    const profile = await runCalibrate({
      models: parseModelList("a=worker,b=researcher"),
      buckets: [2048],
      decodeTokens: 16,
      force: true,
      resolve: (name) => fake(name),
      path,
      registry: null,
      say: (l) => lines.push(l),
    });
    const firstUnloadA = events.indexOf("unload a");
    const firstGenB = events.indexOf("gen b");
    expect(firstUnloadA).toBeGreaterThan(-1);
    expect(firstGenB).toBeGreaterThan(firstUnloadA); // never two models at once
    expect(Object.keys(profile?.models ?? {})).toEqual(["a", "b"]);
    expect(lines.some((l) => /a \(.+\): 2k: prefill \d+ tok\/s, decode \d+/.test(l))).toBe(true);
    // A second run on the same hardware reuses the saved profile.
    const again = await runCalibrate({
      models: parseModelList("a=worker"),
      path,
      resolve: () => fake("z"),
      say: (l) => lines.push(l),
    });
    expect(again?.date).toBe(profile?.date);
    expect(lines.at(-1)).toMatch(/use --force/);
  });
});
