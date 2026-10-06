import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ModelRegistry, ModelRoster } from "@sekhemet/models";
import { describe, expect, it, vi } from "vitest";
import { rolePromptVersion } from "../src/prompt_versions.js";
import { qualificationCombination } from "../src/qualify.js";
import { cli, g2Dirs } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, type Turn, recorded, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * Prompt versions and qualification through the doors a person uses (context
 * rule 27, CX-N6-1, CX-N6-4; models rule 4d; FINISH_LINE_PLAN C2d): `sekhemet
 * queue` and `sekhemet models assign` spawned as the built binary over a real
 * model registry file, the Coding model a scripted model at the HTTP boundary.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

const CARD = {
  id: "c1",
  tier: "story" as const,
  title: "Write a",
  scopeFiles: ["src/a.ts"],
  stepBudget: 2,
  spec: "Export a constant named a from src/a.ts",
};
const WRITE: Turn = [
  { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
  { name: "finish_card" },
];

const queue = (p: G2Project) =>
  cli(["queue", "--worker", SCRIPTED_MODEL], {
    cwd: p.repo,
    preload: p.preload,
    env: { ...p.env, ...scriptEnv(p.record, { worker: [WRITE] }) },
    timeoutMs: 120_000,
  });

/** The registry as the spawned binary sees it, read in this process. */
function registryOf(p: G2Project) {
  for (const [k, v] of Object.entries(p.env)) vi.stubEnv(k, v);
  try {
    const registry = new ModelRegistry(p.env.SEKHEMET_MODEL_REGISTRY);
    const adapter = new ModelRoster({ registry }).resolve(SCRIPTED_MODEL, "worker");
    const under = (version: string) =>
      registry.lookupQualification(
        adapter.modelId,
        qualificationCombination(adapter, { registry, contextVersion: () => version }),
      ).status;
    return { registry, under };
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("CX-N6-1: a qualification is per prompt version", () => {
  it("CX-N6-1: a Coding model qualified only under another build's prompt version is refused, naming both, scheduled once for re-qualification, and the other build's qualification is kept", async () => {
    const current = rolePromptVersion("worker");
    const older = "ctx-older-build";
    const p = await g2Project(g2Dirs(), {
      cards: [CARD],
      qualifyAs: [{ contextVersion: older }],
    });
    const r = await queue(p);
    const out = r.stdout + r.stderr;
    expect(out).toContain(`context version ${older} -> ${current}`);
    expect(out).toMatch(/sekhemet qualify --models scripted-worker:latest/);
    // Nothing ran: the card never reached the Worker.
    expect(r.stdout).not.toMatch(/=== c1 \(attempt/);
    expect(recorded(p.record).filter((x) => x.role === "worker")).toEqual([]);
    const pending = () =>
      registryOf(p).registry.pendingRequalifications({ version: current, role: "worker" });
    expect(pending()).toEqual([
      expect.objectContaining({ reason: `context version changed (${older} -> ${current})` }),
    ]);
    // The other build's qualification is untouched; this build's is missing.
    expect(registryOf(p).under(older)).toBe("qualified");
    expect(registryOf(p).under(current)).not.toBe("qualified");
    // Asked again, the re-qualification is still owed once, not twice.
    await queue(p);
    expect(pending()).toHaveLength(1);
  }, 240_000);
});

describe("CX-N6-4: each role has its own prompt version and qualification", () => {
  it("CX-N6-4: the Coding model's qualification does not carry to another role, another role's old version leaves the Coding model valid, and every card records the full context version", async () => {
    const p = await g2Project(g2Dirs(), {
      cards: [CARD],
      // The Coding model under this build's prompts; the Review model only
      // under a Review prompt version this build no longer has.
      qualifyAs: [{}, { role: "reviewer", contextVersion: "reviewer-older-prompts" }],
    });
    const assign = await cli(["models", "assign", "reviewer", SCRIPTED_MODEL], {
      cwd: p.repo,
      env: p.env,
    });
    expect(assign.status).toBe(1);
    expect(assign.stdout + assign.stderr).toMatch(
      /scripted-worker:latest is not verified on this machine for the Review model .*Verify it first: sekhemet qualify --models scripted-worker:latest --role reviewer/,
    );
    // The Review model's stale version did not touch the Coding model's.
    const r = await queue(p);
    expect(r.stdout, r.stderr).toMatch(/PASSED/);
    expect(registryOf(p).under(rolePromptVersion("worker"))).toBe("qualified");
    expect(rolePromptVersion("reviewer")).not.toBe(rolePromptVersion("worker"));
    // Every card records the full context version and the Coding model's prompt version.
    const dir = join(p.repo, ".sekhemet", "evidence");
    const settings = readdirSync(dir)
      .map(
        (f) =>
          (JSON.parse(readFileSync(join(dir, f), "utf8")) as { settings?: Record<string, unknown> })
            .settings,
      )
      .filter((x): x is Record<string, unknown> => x !== undefined);
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) {
      // The full version covers every role's prompts and the literal
      // inventory of the build that ran; the Coding model's is the one it
      // was qualified under here.
      expect(s.contextVersion).toMatch(/^[0-9a-f]{16}$/);
      expect(s.promptVersion).toBe(rolePromptVersion("worker"));
      expect(s.contextVersion).not.toBe(s.promptVersion);
    }
  }, 240_000);
});
