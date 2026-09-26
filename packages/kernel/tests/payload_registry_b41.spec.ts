import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/log.js";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// B4.1 step 0: the event types B4.1's specs name, registered in the payload
// schema registry (kernel rule 33, K-S7-4, K-S7-9) before any writer exists.
// design-stage §3 (take-over, DS-TO-3, DS-TO-7, DS-TO-8), security SEC-54,
// SEC-55, SEC-N10-4, models MD-N12-6, MD-N14-40a/41, dashboard DB-NM14-8,
// measurement rule 36-37, MS-N5-8, MS-N5-11.

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);

interface Case {
  type: string;
  payload: Record<string, unknown>;
  private?: Record<string, unknown>;
  /** A field that is not structural, put in the payload: refused, named. */
  stray: [string, unknown];
}

const roleScore = {
  role: "worker",
  model: "cyber-tiel-35b-a3b",
  state: "measured",
  cacheKey: "ck_1",
  setHash: SHA,
  score: 0.75,
  items: [
    { id: "w1", score: 1 },
    { id: "w2", score: 0.5 },
  ],
  capped: 1,
  secondary: { secondsPerItem: 95, validToolCallRate: 0.98, stepsToPass: 12, fits: true },
};

const CASES: Case[] = [
  {
    type: "takeover/secrets_scanned",
    payload: {
      scanner: "builtin",
      commits: 42,
      findings: [{ commit: COMMIT, path: "config/prod.env", rule: "aws-access-key" }],
    },
    // The secret itself is recorded nowhere, not even privately (SEC-55).
    stray: ["secret", "AKIAIOSFODNN7EXAMPLE"],
  },
  {
    type: "takeover/inventory",
    payload: {
      baselineSeq: 17,
      findings: [
        { id: "f1", kind: "stub", path: "src/pdf.ts", line: 3, commit: COMMIT },
        { id: "f2", kind: "could_not_build" },
      ],
    },
    private: {
      recon: "README says it exports PDF",
      findingDetails: [{ id: "f1", reason: "throws not implemented", command: "npm test" }],
    },
    stray: ["recon", "README says it exports PDF"],
  },
  {
    type: "takeover/brief_as_found",
    payload: {
      claims: [{ id: "c1", label: "contradicted", citations: ["f1", "src/pdf.ts:3", COMMIT] }],
    },
    private: { claimTexts: [{ id: "c1", text: "It exports PDF" }] },
    stray: ["claimTexts", [{ id: "c1", text: "It exports PDF" }]],
  },
  {
    type: "trust/agent_config_approved",
    payload: { path: ".mcp.json", sha256: SHA, principal: "p_owner" },
    private: { repo: "/Users/someone/code/app" },
    stray: ["repo", "/Users/someone/code/app"],
  },
  {
    type: "models/scanned",
    payload: {
      folderCount: 2,
      depth: 6,
      fileLimit: 5000,
      found: 3,
      skipped: 1,
      truncated: false,
    },
    private: { folders: ["/Users/someone/models", "/Volumes/Drive/llm"] },
    stray: ["folders", ["/Users/someone/models"]],
  },
  {
    type: "model/downloaded",
    payload: {
      model: "cyber-tiel-35b-a3b",
      source: "huggingface.co",
      sha256: SHA,
      bytes: 13_600_000_000,
      principal: "p_owner",
      verified: true,
    },
    // Where it was written names a person's directory: never on the chain.
    stray: ["destination", "/Users/someone/models/x.gguf"],
  },
  {
    type: "model/copied",
    payload: {
      model: "cyber-tiel-35b-a3b",
      sha256: SHA,
      bytes: 13_600_000_000,
      from: "external",
      to: "internal",
      principal: "p_owner",
      verified: true,
    },
    stray: ["destination", "/Users/someone/models/x.gguf"],
  },
  {
    type: "measure/benchmarked",
    payload: {
      tier: "quick",
      profileHash: SHA,
      partial: false,
      roles: [roleScore],
      comparisons: [
        {
          role: "worker",
          a: "m_a",
          b: "m_b",
          better: 6,
          worse: 0,
          ties: 0,
          p: 0.031,
          indistinguishable: false,
        },
      ],
      endToEnd: { passed: 2, total: 2 },
    },
    private: { runProfile: { schema: 1, settingsFile: { path: "/Users/someone/arm.toml" } } },
    stray: ["runProfile", { schema: 1 }],
  },
];

describe("B4.1's events in the payload schema registry (K-S7-4, K-S7-9)", () => {
  it.each(CASES)("$type is registered, and accepts its structural payload", (c) => {
    expect(PAYLOAD_SCHEMAS[c.type], c.type).toBeDefined();
    expect(() => checkEventPayload(c.type, c.payload, c.private)).not.toThrow();
  });

  it.each(CASES)("$type refuses a non-structural field in its payload, naming it", (c) => {
    const [field, value] = c.stray;
    const re = new RegExp(`${c.type.replace("/", "\\/")}.*\\b${field}\\b`);
    expect(() => checkEventPayload(c.type, { ...c.payload, [field]: value }, c.private)).toThrow(
      re,
    );
  });

  it("a take-over's commit may be a SHA-256 repository's 64-hex id, and nothing longer (B4.1 half-A minor)", () => {
    const at = (commit: string) => () =>
      checkEventPayload(
        "takeover/secrets_scanned",
        { scanner: "gitleaks", commits: 1, findings: [{ commit, path: "a.env", rule: "r" }] },
        undefined,
      );
    expect(at("d".repeat(64))).not.toThrow();
    expect(at("d".repeat(50))).toThrow();
    expect(at("d".repeat(65))).toThrow();
  });

  it("measure/benchmarked takes only the quick or overnight tier (measurement rules 36-37)", () => {
    const base = CASES.find((c) => c.type === "measure/benchmarked");
    if (!base) throw new Error("no case");
    expect(() =>
      checkEventPayload("measure/benchmarked", { ...base.payload, tier: "overnight" }, undefined),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("measure/benchmarked", { ...base.payload, tier: "full" }, undefined),
    ).toThrow(/measure\/benchmarked.*tier/);
  });

  it("a take-over finding's reason is free text: private, never in the payload (design-stage §3)", () => {
    expect(() =>
      checkEventPayload(
        "takeover/inventory",
        {
          baselineSeq: 1,
          findings: [{ id: "f1", kind: "stub", path: "a.ts", reason: "throws" }],
        },
        undefined,
      ),
    ).toThrow(/takeover\/inventory.*reason/);
  });
});

describe("B4.1's events on a real ledger (K-S7-4)", () => {
  let disk: DiskDb;
  let log: EventLog;
  const count = (): number =>
    (disk.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  beforeEach(() => {
    disk = openDiskDb("sekhemet-registry-b41-");
    log = new EventLog(disk.db);
  });
  afterEach(() => disk.dispose());

  it("appends the agent-configuration audit record with the repository's path private, and refuses it in the payload", async () => {
    const before = count();
    expect(() =>
      log.appendNow({
        actor: "human",
        type: "trust/agent_config_approved",
        payload: {
          path: "CLAUDE.md",
          sha256: SHA,
          principal: "p_owner",
          repo: "/Users/someone/app",
        },
      }),
    ).toThrow(/trust\/agent_config_approved.*\brepo\b.*personal/);
    expect(count()).toBe(before);
    log.appendNow({
      actor: "human",
      type: "trust/agent_config_approved",
      payload: { path: "CLAUDE.md", sha256: SHA, principal: "p_owner" },
      private: { repo: "/Users/someone/app" },
    });
    const [e] = await log.getEventsByTypes(["trust/agent_config_approved"]);
    expect(e?.payload).not.toHaveProperty("repo");
    expect(e?.private).toEqual({ repo: "/Users/someone/app" });
  });
});
