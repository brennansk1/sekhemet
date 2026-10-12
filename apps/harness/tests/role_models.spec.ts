import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { MockInferenceAdapter, ModelRegistry, assignRole } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { recommendRoster, runInit } from "../src/init.js";
import { resolveWorkerName } from "../src/model_access.js";
import { seshatModelName } from "../src/pm/seshat_model.js";
import { type CombinationDeps, qualificationCombination } from "../src/qualify.js";
import { effectiveRoleModels, roleModelLines } from "../src/role_models.js";

/**
 * S1B-B25: `models list` said *worker: unassigned* while `init` said
 * *Coding model nail-mtp* — two sources (the registry's assignment and
 * config.toml) read by two commands. Both now show the model each role runs,
 * in NAMING's role names, and where it comes from, from one resolution:
 * the one `run`, the queue and Seshat use.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function project(configToml?: string): { repo: string; registry: ModelRegistry } {
  const repo = mkdtempSync(join(tmpdir(), "role-models-"));
  dirs.push(repo);
  mkdirSync(join(repo, ".sekhemet"));
  if (configToml) writeFileSync(join(repo, ".sekhemet", "config.toml"), configToml);
  return { repo, registry: new ModelRegistry(join(repo, "models.json")) };
}

const ENV = {} as NodeJS.ProcessEnv;

describe("S1B-B25: each role's model, where it comes from, in NAMING's words", () => {
  it("names the four roles Coding, Planning, Review and Research model, never worker or planner", () => {
    const { repo, registry } = project();
    const lines = roleModelLines(effectiveRoleModels(repo, { registry, host: "h", env: ENV }));
    expect(lines.map((l) => l.split(":")[0])).toEqual([
      "Coding model",
      "Planning model",
      "Review model",
      "Research model",
    ]);
    // The command keeps its internal role argument (the guide's models page); the words do not.
    const words = lines.join("\n").replace(/sekhemet models assign \w+/g, "");
    expect(words).not.toMatch(/\b(worker|planner|reviewer|researcher|unassigned)\b/);
  });

  it("config.toml's model, with config.toml as its source, when no one assigned one", () => {
    const { repo, registry } = project('[models]\nexecutor = "nail-mtp"\nplanner = "qwen-plan"\n');
    const [coding, planning, review, research] = roleModelLines(
      effectiveRoleModels(repo, { registry, host: "h", env: ENV }),
    );
    expect(coding).toBe("Coding model: nail-mtp (config.toml [models] executor)");
    expect(planning).toBe("Planning model: qwen-plan (config.toml [models] planner)");
    expect(review).toMatch(/^Review model: unfilled — /);
    expect(research).toMatch(
      /^Research model: none — research runs once one is assigned: sekhemet models assign researcher <model>$/,
    );
  });

  it("a person's assignment outranks config.toml, and says so; the defaults come last", () => {
    const { repo, registry } = project('[models]\nexecutor = "nail-mtp"\n');
    assignRole(registry, {
      role: "worker",
      model: "mine:latest",
      scope: "personal",
      by: "person: B",
      host: "h",
      qualification: "qualified",
    });
    const roles = effectiveRoleModels(repo, { registry, host: "h", env: ENV });
    expect(roles[0]).toMatchObject({ model: "mine:latest", source: "assigned" });
    expect(roleModelLines(roles)[0]).toMatch(
      /^Coding model: mine:latest \(your assignment on this machine, \d{4}-\d{2}-\d{2}\)$/,
    );
    const bare = project();
    const defaults = effectiveRoleModels(bare.repo, {
      registry: bare.registry,
      host: "h",
      env: ENV,
    });
    expect(defaults[0]).toMatchObject({
      model: recommendRoster(totalmem()).worker,
      source: "default",
    });
    // The Research model a person named in the environment, as the queue reads it.
    const env = { SEKHEMET_RESEARCHER: "apodex" } as NodeJS.ProcessEnv;
    expect(
      roleModelLines(
        effectiveRoleModels(bare.repo, { registry: bare.registry, host: "h", env }),
      )[3],
    ).toBe("Research model: apodex (SEKHEMET_RESEARCHER)");
  });

  it("agrees with the resolutions run, the queue and Seshat use", () => {
    for (const toml of [undefined, '[models]\nexecutor = "nail-mtp"\nplanner = "qwen-plan"\n']) {
      const { repo, registry } = project(toml);
      const [coding, planning] = effectiveRoleModels(repo, { registry, host: "h", env: ENV });
      const configured = toml ? "nail-mtp" : undefined;
      expect(coding?.model).toBe(resolveWorkerName(undefined, configured, { registry, host: "h" }));
      expect(planning?.model).toBe(seshatModelName(repo, { registry, host: "h" }));
    }
  });

  it("init reports the same lines, after writing config.toml", () => {
    const { repo, registry } = project();
    const said: string[] = [];
    runInit(repo, {
      run: (cmd) => (cmd === "git" ? "git version 2" : undefined),
      say: (l) => said.push(l),
      roleModels: (at) =>
        roleModelLines(effectiveRoleModels(at, { registry, host: "h", env: ENV })),
    });
    const expected = roleModelLines(effectiveRoleModels(repo, { registry, host: "h", env: ENV }));
    expect(said.map((l) => l.trim())).toEqual(expect.arrayContaining(expected));
    expect(expected[0]).toMatch(/\(config\.toml \[models\] executor\)$/);
    expect(said.join("\n")).not.toMatch(/Models: Coding model /);
  });

  describe("the Review model run and the queue actually use (resolveReviewerRole, then verified here)", () => {
    const deps: CombinationDeps = {
      digest: () => "sampled-sha256:abc",
      engineBuild: () => "b10809 (abc1234)",
      host: () => "h",
      contextVersion: (role) => `ctx-${role}`,
    };
    const mock = (n: string) => new MockInferenceAdapter(n, [], { exhaustion: "default" as const });
    const verify = (registry: ModelRegistry, name: string) =>
      registry.recordCombinationQualification(
        name,
        qualificationCombination(mock(name), { ...deps, role: "reviewer", registry }),
        {
          suiteVersion: "q1.2",
          passRate: 0.95,
          status: "qualified",
          byCategory: { schema: 0.95 },
        },
      );
    const reviewLine = (repo: string, registry: ModelRegistry) =>
      roleModelLines(
        effectiveRoleModels(repo, {
          registry,
          host: "h",
          env: ENV,
          describe: mock,
          combinationDeps: deps,
        }),
      )[2];
    const assignReviewer = (registry: ModelRegistry, model: string) =>
      assignRole(registry, {
        role: "reviewer",
        model,
        scope: "personal",
        by: "person: B",
        host: "h",
        qualification: "qualified",
      });

    it("a Review model of the Coding model's family is not listed as the Review model: run drops it", () => {
      const { repo, registry } = project(
        '[models]\nexecutor = "qwen-coder"\nplanner = "qwen-plan"\n',
      );
      assignReviewer(registry, "qwen-critic");
      verify(registry, "qwen-critic");
      const line = reviewLine(repo, registry);
      expect(line).toMatch(
        /^Review model: unfilled — qwen-critic is of the Coding model's family; no model of another family than the Coding model's is verified on this machine, so a change reaches you without an AI review$/,
      );
    });

    it("an assigned Review model of another family that is not verified here is not listed as the Review model", () => {
      const { repo, registry } = project(
        '[models]\nexecutor = "qwen-coder"\nplanner = "qwen-plan"\n',
      );
      assignReviewer(registry, "gemma-critic");
      expect(reviewLine(repo, registry)).toMatch(
        /^Review model: unfilled — The Review model gemma-critic is not verified on this machine/,
      );
      verify(registry, "gemma-critic");
      expect(reviewLine(repo, registry)).toMatch(
        /^Review model: gemma-critic \(your assignment on this machine, \d{4}-\d{2}-\d{2}\)$/,
      );
    });

    it("no Review model, and a verified Planning model of another family: the Planning model reviews, as the queue runs it", () => {
      const { repo, registry } = project(
        '[models]\nexecutor = "qwen-coder"\nplanner = "gemma-plan"\n',
      );
      verify(registry, "gemma-plan");
      expect(reviewLine(repo, registry)).toBe(
        "Review model: gemma-plan (the Planning model, of another family than the Coding model's)",
      );
    });
  });
});
