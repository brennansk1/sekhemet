import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cardStepCap,
  cliOverrides,
  configOverrideLines,
  effectiveConfig,
  explicitNetworkMode,
  queueDefaults,
  reviewLimit,
} from "../src/config_apply.js";
import { writeSettings } from "../src/integrations.js";
import { HostPacer, PoliteFetcher } from "../src/research/polite.js";
import { researchSources } from "../src/research/service.js";

function project(toml: string): string {
  const repo = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  writeFileSync(join(repo, ".sekhemet", "config.toml"), toml);
  return repo;
}

describe("config.toml applied (H15)", () => {
  it("reads --set flags as the command-line layer, which wins", () => {
    expect(
      cliOverrides([
        "queue",
        "--set",
        "loop.default_step_budget=24",
        "--set",
        "review.wip=2",
        "--set",
        "network.mode=open",
      ]),
    ).toEqual({
      loop: { default_step_budget: 24 },
      review: { wip: 2 },
      network: { mode: "open" },
    });
    const repo = project("[loop]\ndefault_step_budget = 30\n");
    expect(effectiveConfig(repo).config.loop.defaultStepBudget).toBe(30);
    expect(
      effectiveConfig(repo, ["--set", "loop.default_step_budget=12"]).config.loop.defaultStepBudget,
    ).toBe(12);
  });

  it("gives the queue its models and step cap where flags leave them open", () => {
    const cfg = effectiveConfig(
      project(
        '[models]\nexecutor = "cyber-tiel"\nplanner = "qwen3.8-27b"\n[loop]\ndefault_step_budget = 28\n',
      ),
    ).config;
    expect(queueDefaults(cfg, [])).toEqual({
      worker: "cyber-tiel",
      manager: "qwen3.8-27b",
      maxTurns: 28,
    });
    expect(queueDefaults(cfg, ["--worker", "x", "--max-turns", "10"])).toEqual({
      manager: "qwen3.8-27b",
    });
    expect(queueDefaults(effectiveConfig(project("")).config, []).worker).toBeUndefined(); // "auto"
  });

  it("sets the Review limit from [review] wip", () => {
    expect(reviewLimit(effectiveConfig(project("[review]\nwip = 2\n")).config)).toBe(2);
    expect(reviewLimit(effectiveConfig(project("")).config)).toBeUndefined();
  });

  it("network.mode: the default leaves Integrations in charge; an explicit offline turns the web off", async () => {
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cfg-home-"));
    const ensure = async () => undefined;
    const open = project("");
    writeSettings(open, { researchWeb: true });
    expect(explicitNetworkMode(open)).toBeUndefined();
    expect((await researchSources(open, { ensure })).status.web).toBe(true);
    const off = project('[network]\nmode = "offline"\n');
    writeSettings(off, { researchWeb: true });
    const r = await researchSources(off, { ensure });
    expect(r.web).toBeUndefined();
    expect(r.status.search).toMatch(/network.mode = offline/);
  });

  it("network.mode allowlist limits page reads to [network] allow", async () => {
    const repo = project('[network]\nmode = "allowlist"\nallow = ["nodejs.org", "arxiv.org"]\n');
    writeSettings(repo, { researchWeb: true });
    const { web } = await researchSources(repo, { ensure: async () => undefined });
    expect(web?.polite).toBeDefined();
    const pf = new PoliteFetcher({
      fetch: async () => new Response("ok"),
      pacer: new HostPacer({ now: () => 0, sleep: async () => {} }),
      allowOnly: ["nodejs.org"],
    });
    expect(await (await pf.fetch("https://nodejs.org/api/")).text()).toBe("ok");
    await expect(pf.fetch("https://example.com/")).rejects.toThrow(/not on the network allowlist/);
    expect(await pf.permit("https://evil.example/")).toMatch(/not on the network allowlist/);
  });
});

describe("NEW-surface-3: the card layer of the configuration (SUR-40)", () => {
  it("resolves a card's overrides between the project layer and the command line", () => {
    const repo = project("[loop]\ndefault_step_budget = 30\n[review]\nwip = 4\n");
    const card = { configOverrides: { loop: { default_step_budget: 12 } } };
    const r = effectiveConfig(repo, [], card);
    expect(r.layers).toEqual(["defaults", "project", "card"]);
    expect(r.config.loop.defaultStepBudget).toBe(12);
    expect(r.config.review.wip).toBe(4);
    const cli = effectiveConfig(repo, ["--set", "loop.default_step_budget=8"], card);
    expect(cli.config.loop.defaultStepBudget).toBe(8);
  });

  it("names the overrides for the card and the run's output", () => {
    expect(
      configOverrideLines({ loop: { default_step_budget: 12 }, models: { executor: "x" } }),
    ).toEqual(["loop.default_step_budget = 12", 'models.executor = "x"']);
    expect(configOverrideLines(undefined)).toEqual([]);
  });

  it("caps a card's steps: a --max-turns flag, else the card's own budget, else the run's", () => {
    const card = { configOverrides: { loop: { default_step_budget: 12 } } };
    expect(cardStepCap(card, { flag: 5, otherwise: 40 })).toBe(5);
    expect(cardStepCap(card, { otherwise: 40 })).toBe(12);
    expect(cardStepCap({}, { otherwise: 40 })).toBe(40);
    expect(cardStepCap({}, {})).toBeUndefined();
  });
});
