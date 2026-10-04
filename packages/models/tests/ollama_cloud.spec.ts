import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssignmentRefusal,
  HttpInferenceAdapter,
  ModelRegistry,
  ModelRoster,
  OllamaCloudRefusal,
  assignRole,
  isOllamaCloudTag,
  ollamaCloudRefusal,
  ollamaRemoteHost,
  restoreRole,
} from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

/** NEW-models-20 (DEC-55, DEC-03): Ollama's cloud models are refused for every role. */

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  while (closers.length) await (closers.pop() as () => Promise<void>)();
});
const registry = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-cloud-"));
  dirs.push(d);
  return new ModelRegistry(join(d, "models.json"));
};

describe("an Ollama cloud tag (MD-N20-1)", () => {
  it("is a tag ending in :cloud or -cloud, in any case", () => {
    for (const t of [
      "gpt-oss:120b-cloud",
      "qwen3-coder:480b-cloud",
      "kimi-k2:cloud",
      "glm-4.6:CLOUD",
      "deepseek-v3.1-cloud",
      "ollama/gpt-oss:20b-cloud",
    ])
      expect(isOllamaCloudTag(t), t).toBe(true);
    for (const t of [
      "qwen3:8b",
      "cloudy:7b",
      "soundcloud-coder:7b",
      "my-cloud-model:7b",
      "cyber-tiel",
      "qwen3:8b-cloudless",
    ])
      expect(isOllamaCloudTag(t), t).toBe(false);
  });

  it("names a remote host when Ollama's details carry one", () => {
    expect(ollamaRemoteHost({ remote_host: "https://ollama.com:443", remote_model: "x" })).toBe(
      "https://ollama.com:443",
    );
    expect(ollamaRemoteHost({ details: { family: "qwen3" } })).toBeUndefined();
    expect(ollamaRemoteHost(undefined)).toBeUndefined();
  });

  it("is refused in words that name the model and say its prompts would leave this machine", () => {
    const words = ollamaCloudRefusal("gpt-oss:120b-cloud", "worker");
    expect(words).toContain("gpt-oss:120b-cloud");
    expect(words).toMatch(/prompts would leave this machine/);
    expect(words).toContain("Coding model");
  });
});

describe("refused when assigned (MD-N20-1)", () => {
  it("refuses every role, even when the model is marked verified, and records nothing", () => {
    const reg = registry();
    for (const role of ["worker", "planner", "reviewer", "researcher"] as const) {
      expect(() =>
        assignRole(reg, {
          role,
          model: "qwen3-coder:480b-cloud",
          scope: "personal",
          by: "person: ada",
          host: "h",
          qualification: "qualified",
        }),
      ).toThrow(AssignmentRefusal);
      try {
        assignRole(reg, {
          role,
          model: "qwen3-coder:480b-cloud",
          scope: "personal",
          by: "person: ada",
          host: "h",
          qualification: "qualified",
        });
      } catch (err) {
        expect((err as Error).message).toMatch(/prompts would leave this machine/);
      }
    }
    expect(reg.roleAssignments("h")).toEqual([]);
  });
});

describe("refused on every run of a role that names it (MD-N20-2)", () => {
  it("the roster refuses to resolve a cloud tag for any role", () => {
    const roster = new ModelRoster({ registry: registry(), machineProfile: null });
    for (const role of ["worker", "planner", "reviewer", "researcher"] as const) {
      expect(() => roster.resolve("gpt-oss:120b-cloud", role)).toThrow(OllamaCloudRefusal);
    }
  });

  it("the adapter sends no request for a cloud tag", async () => {
    const srv = await fakeServer(() => ({ json: { message: { content: "hi" }, done: true } }));
    closers.push(srv.close);
    const adapter = new HttpInferenceAdapter({
      modelId: "kimi-k2:cloud",
      baseUrl: srv.url,
      memoryAware: false,
    });
    await expect(
      adapter.generate({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow(/prompts would leave this machine/);
    expect(srv.seen).toEqual([]);
  });

  it("a model whose details from Ollama name a remote host is refused after the health check, with no chat request", async () => {
    const srv = await fakeServer((req) =>
      req.url === "/api/tags"
        ? {
            json: {
              models: [
                {
                  name: "gpt-oss:120b",
                  model: "gpt-oss:120b",
                  remote_model: "gpt-oss:120b",
                  remote_host: "https://ollama.com:443",
                },
              ],
            },
          }
        : { json: { models: [], message: { content: "hi" }, done: true } },
    );
    closers.push(srv.close);
    const adapter = new HttpInferenceAdapter({
      modelId: "gpt-oss:120b",
      baseUrl: srv.url,
      memoryAware: false,
    });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/prompts would leave this machine/);
    await expect(
      adapter.generate({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow(OllamaCloudRefusal);
    expect(srv.seen.some((s) => s.url === "/api/chat")).toBe(false);
  });

  it("the load is refused before it is sent: a cloud tag gets no request, and a remote host no /api/generate", async () => {
    const tagged = await fakeServer(() => ({ json: { models: [], done: true } }));
    closers.push(tagged.close);
    await expect(
      new HttpInferenceAdapter({
        modelId: "kimi-k2:cloud",
        baseUrl: tagged.url,
        memoryAware: false,
      }).load(),
    ).rejects.toThrow(OllamaCloudRefusal);
    expect(tagged.seen).toEqual([]);

    const remote = await fakeServer((req) =>
      req.url === "/api/tags"
        ? {
            json: {
              models: [
                {
                  name: "gpt-oss:120b",
                  model: "gpt-oss:120b",
                  remote_host: "https://ollama.com:443",
                },
              ],
            },
          }
        : { json: { models: [], done: true } },
    );
    closers.push(remote.close);
    // No health check first: the residency scheduler loads before it checks.
    await expect(
      new HttpInferenceAdapter({
        modelId: "gpt-oss:120b",
        baseUrl: remote.url,
        memoryAware: false,
      }).load(),
    ).rejects.toThrow(/prompts would leave this machine/);
    expect(remote.seen.some((s) => s.url === "/api/generate" || s.url === "/api/chat")).toBe(false);
  });
});

describe("refused when restored (MD-N20-1)", () => {
  it("an earlier assignment naming a cloud tag is not restored, and nothing is recorded", () => {
    const reg = registry();
    // An assignment recorded before rule 14c, as an older registry holds it.
    reg.recordRoleAssignment("h", {
      role: "worker",
      model: "qwen3-coder:480b-cloud",
      scope: "personal",
      by: "person: ada",
      date: "2026-09-01T00:00:00.000Z",
    });
    reg.recordRoleAssignment("h", {
      role: "worker",
      model: "qwen3-coder:30b",
      scope: "personal",
      by: "person: ada",
      date: "2026-09-02T00:00:00.000Z",
    });
    const before = reg.roleAssignments("h").length;
    expect(() => restoreRole(reg, "h", "worker", { by: "person: ada" })).toThrow(
      /prompts would leave this machine/,
    );
    expect(reg.roleAssignments("h")).toHaveLength(before);
  });
});
