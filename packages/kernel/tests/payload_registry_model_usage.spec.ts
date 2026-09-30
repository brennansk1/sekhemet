import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/log.js";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";
import { initSchema } from "../src/schema.js";

// Fix round F2 (measurement rule 4a, kernel rule 33): every model request's
// usage outside a card's step — Seshat's, the Planning model's (its
// read-in-parts pass among them), the Review model's and the Research
// model's — is one `model/usage` event. Structural only: the role, what the
// request was for, the model id and the counts; never a prompt.

const usage = {
  role: "seshat",
  purpose: "read_document",
  model: "dirk-27b",
  promptTokens: 1200,
  cachedPromptTokens: 800,
  completionTokens: 300,
  thinkingTokens: 120,
  answerTokens: 180,
  durationMs: 4200,
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("model/usage", () => {
  it("is registered, every field structural", () => {
    const schema = PAYLOAD_SCHEMAS["model/usage"];
    expect(schema).toBeDefined();
    for (const f of Object.values(schema ?? {})) expect(f.dataClass).toBe("structural");
  });

  it("accepts one request's usage, with or without the cache figure", () => {
    expect(() => checkEventPayload("model/usage", usage, undefined)).not.toThrow();
    const { cachedPromptTokens: _cached, ...uncached } = usage;
    expect(() => checkEventPayload("model/usage", uncached, undefined)).not.toThrow();
  });

  it("names each role that spends tokens by a role code; the closed list is the models package's (MD-N4-1)", () => {
    for (const role of ["worker", "planner", "seshat", "reviewer", "researcher"])
      expect(() => checkEventPayload("model/usage", { ...usage, role }, undefined)).not.toThrow();
    // The kernel sits below the models package, so it checks the shape only;
    // model_usage.ts writes a role from MODEL_ROLES or "seshat" and nothing else.
    for (const role of ["Some One", "", "planner!", "../x"])
      expect(() => checkEventPayload("model/usage", { ...usage, role }, undefined)).toThrow(/role/);
  });

  it("refuses a negative or fractional count, a free-text purpose and a prompt", () => {
    expect(() =>
      checkEventPayload("model/usage", { ...usage, promptTokens: -1 }, undefined),
    ).toThrow(/promptTokens/);
    expect(() =>
      checkEventPayload("model/usage", { ...usage, completionTokens: 2.5 }, undefined),
    ).toThrow(/completionTokens/);
    expect(() =>
      checkEventPayload(
        "model/usage",
        { ...usage, purpose: "Answer the person's question" },
        undefined,
      ),
    ).toThrow(/purpose/);
    expect(() =>
      checkEventPayload("model/usage", { ...usage, prompt: "the person's words" }, undefined),
    ).toThrow(/fails its schema/);
  });

  it("is appended to a real ledger and read back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-usage-"));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    log.appendNow({ actor: "harness", type: "model/usage", payload: usage });
    expect(() =>
      log.appendNow({
        actor: "harness",
        type: "model/usage",
        payload: { ...usage, promptTokens: -5 },
      }),
    ).toThrow(/promptTokens/);
    const events = await log.getEventsByTypes(["model/usage"]);
    expect(events.map((e) => e.payload)).toEqual([usage]);
    db.close();
  });
});
