import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelLoadRefusal } from "../src/load_guard.js";

// With SEKHEMET_MODEL_LOADS=off (set for every test run in vitest.config.ts),
// nothing in the process may reach the owner's real model servers or start a
// real llama.cpp binary: a test that forgets `--planner none` fails loudly
// instead of loading 13 GB on the owner's machine (B4.3, part 1A's near miss).
const was = process.env.SEKHEMET_MODEL_LOADS;
afterEach(() => {
  if (was === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_MODEL_LOADS");
  else process.env.SEKHEMET_MODEL_LOADS = was;
});

describe("the model-load guard", () => {
  it("refuses the real servers' ports and a real llama.cpp binary when loads are off", () => {
    process.env.SEKHEMET_MODEL_LOADS = "off";
    for (const url of [
      "http://127.0.0.1:11434/api/chat",
      "http://localhost:8098/completion",
      "http://[::1]:8080/v1/chat/completions",
    ]) {
      expect(modelLoadRefusal({ url }), url).toMatch(/SEKHEMET_MODEL_LOADS=off/);
    }
    expect(modelLoadRefusal({ binary: undefined })).toMatch(/llama-server/);
    expect(modelLoadRefusal({ binary: "llama-server" })).toMatch(/llama-server/);
    expect(modelLoadRefusal({ binary: "/opt/homebrew/bin/llama-server" })).toMatch(/llama-server/);
  });

  it("lets a test's fake server and fake binary through", () => {
    process.env.SEKHEMET_MODEL_LOADS = "off";
    expect(modelLoadRefusal({ url: "http://127.0.0.1:53211/api/chat" })).toBeUndefined();
    expect(
      modelLoadRefusal({ binary: join(tmpdir(), "x", "fake-llama-server.mjs") }),
    ).toBeUndefined();
  });

  it("refuses nothing when loads are not off", () => {
    Reflect.deleteProperty(process.env, "SEKHEMET_MODEL_LOADS");
    expect(modelLoadRefusal({ url: "http://127.0.0.1:11434/api/chat" })).toBeUndefined();
    expect(modelLoadRefusal({ binary: undefined })).toBeUndefined();
  });
});
