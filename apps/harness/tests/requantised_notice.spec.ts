import type { EventRecord } from "@sekhemet/kernel";
import { SWAP_EVENTS } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { ALL_EVENTS, noticeFor } from "../src/notify.js";

describe("models rule 20h: a model Ollama serves requantised raises a notice", () => {
  it("names the served and the file's quantisation and prefers llama-server", () => {
    const e = {
      seq: 1,
      id: "evt_1",
      actor: "harness",
      type: SWAP_EVENTS.requantised,
      payload: {
        model: "cyber:latest",
        servedQuant: "Q4_K_M",
        fileQuant: "IQ3_XXS",
        hashDiffers: false,
      },
      payloadHash: "",
      hash: "",
      prevHash: "",
      createdAt: new Date().toISOString(),
    } as EventRecord;
    const n = noticeFor(e);
    expect(n).toMatchObject({ event: "requantised", key: "requantised:cyber:latest", priority: 3 });
    expect(n?.message).toContain("Q4_K_M");
    expect(n?.message).toContain("IQ3_XXS");
    expect(n?.message).toContain("llama-server");
    expect(ALL_EVENTS).toContain("requantised");
  });
});
