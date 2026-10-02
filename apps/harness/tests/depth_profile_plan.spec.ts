import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { DecisionStore, designStage } from "@sekhemet/planner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";
import {
  comparablesSearchFor,
  depthCommand,
  designCoverage,
  offerDepthProfile,
  planningInputs,
  projectDepthProfile,
} from "../src/plan_approval.js";
import { planCommand } from "../src/wave2.js";

// design-stage P14 in the product (DS-P14-1, -3, -4, -5, -7, -9): the harness
// reads the recorded profile, offers the design stage's proposal, records a
// person's choice, and searches comparables only when research is allowed.
// A real git repository, an on-disk ledger, a real user config.toml.

let root: string;
let repo: string;
let userConfig: string;
let db: DatabaseSync;
let log: EventLog;
let cardStore: CardStore;
const lines: string[] = [];
const print = (l: string) => lines.push(l);
const k = () => ({ repoPath: repo, cardStore, log });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-depth-plan-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  userConfig = join(root, "user", "config.toml");
  vi.stubEnv("SEKHEMET_USER_CONFIG", userConfig);
  vi.stubEnv("SEKHEMET_OFFLINE", undefined as unknown as string);
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  cardStore = new CardStore(db, log);
  lines.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const writeUser = (text: string) => {
  mkdirSync(join(root, "user"), { recursive: true });
  writeFileSync(userConfig, text);
};

const RECIPES = "a recipe website where people can sign up and save favourites";

describe("DS-P14-3: the harness plans and approves under the recorded profile", () => {
  it("reads internal tool until a person chooses, then the choice", async () => {
    expect(projectDepthProfile(cardStore)).toBe("internal tool");
    expect((await planningInputs(k())).depthProfile).toBe("internal tool");
    expect(await depthCommand(k(), ["production"], print)).toBe(0);
    expect(projectDepthProfile(cardStore)).toBe("production");
    expect((await planningInputs(k())).depthProfile).toBe("production");
    const project = await cardStore.ensureProject({ rootPath: repo, name: "Recipes" });
    await depthCommand(k(), ["prototype", "--project", project.id], print);
    expect(projectDepthProfile(cardStore, project.id)).toBe("prototype");
    expect((await planningInputs(k(), project.id)).depthProfile).toBe("prototype");
    expect(projectDepthProfile(cardStore)).toBe("production");
  });
});

describe("sekhemet depth (DS-P14-1, -2, -4)", () => {
  it("shows the profile in force, and records a person's choice with its checklist", async () => {
    expect(await depthCommand(k(), [], print)).toBe(0);
    expect(lines.join("\n")).toMatch(/internal tool .*nobody has chosen/i);
    lines.length = 0;
    expect(await depthCommand(k(), ["production"], print)).toBe(0);
    const record = cardStore.depthProfiles.of();
    expect(record).toMatchObject({ profile: "production", recorded: true });
    expect(record.principal).toBe(cardStore.localPrincipal());
    const checklist = (await cardStore.requirements.list()).filter((r) => r.source === "checklist");
    expect(checklist).toHaveLength(7);
    expect(lines.join("\n")).toMatch(/7 quality checks/);
  });

  it("says regulated claims no compliance", async () => {
    await depthCommand(k(), ["regulated"], print);
    expect(lines.join(" ")).toMatch(/claims no compliance/);
  });

  it("refuses a name that is not a profile", async () => {
    expect(await depthCommand(k(), ["enterprise"], print)).toBe(1);
    expect(cardStore.depthProfiles.of().recorded).toBe(false);
  });
});

describe("offerDepthProfile (DS-P14-1)", () => {
  it("with no one to ask, proposes with the reason and records nothing", async () => {
    const d = designStage(RECIPES, { greenfield: true });
    const r = await offerDepthProfile(k(), d, { print });
    expect(r.recorded).toBe(false);
    const said = lines.join("\n");
    expect(said).toMatch(/production/);
    expect(said).toContain(d.depth?.reason as string);
    expect(said).toMatch(/sekhemet depth production/);
  });

  it("records the person's answer with what was proposed", async () => {
    const d = designStage(RECIPES, { greenfield: true });
    const asked: string[] = [];
    const r = await offerDepthProfile(k(), d, {
      print,
      ask: async (q) => {
        asked.push(q);
        return "internal tool";
      },
    });
    expect(asked).toHaveLength(1);
    expect(r).toMatchObject({ profile: "internal tool", proposed: "production", recorded: true });
  });

  it("an empty answer accepts the proposal; a recorded choice is not asked again", async () => {
    const d = designStage(RECIPES, { greenfield: true });
    await offerDepthProfile(k(), d, { print, ask: async () => "" });
    expect(cardStore.depthProfiles.of().profile).toBe("production");
    const ask = vi.fn(async () => "prototype");
    await offerDepthProfile(k(), d, { print, ask });
    expect(ask).not.toHaveBeenCalled();
    expect(cardStore.depthProfiles.of().profile).toBe("production");
  });
});

describe("comparables through the research consent (DS-P14-5, -9)", () => {
  it("research off: no request, and it says comparables were not searched", async () => {
    writeUser('[network]\nresearch = "no"\n');
    const fetchImpl = vi.fn(async () => Response.json({ items: [] }));
    const s = comparablesSearchFor(repo, log, { fetchImpl });
    expect(s.search).toBeUndefined();
    expect(s.notSearched).toMatch(/research is off/);
    const d = designStage(RECIPES, { greenfield: true });
    await designCoverage(k(), d, { print, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join(" ")).toMatch(/not searched.*research is off/i);
    expect(lines.join(" ")).toMatch(/not complete coverage/);
  });

  it("unanswered is off: silence is never a yes", () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [] }));
    expect(comparablesSearchFor(repo, log, { fetchImpl }).notSearched).toMatch(/research is off/);
  });

  it("offline wins over a yes", () => {
    writeUser('[network]\nresearch = "yes"\n');
    expect(comparablesSearchFor(repo, log, { offline: true }).notSearched).toMatch(/offline/);
  });

  it("research on: short keywords to GitHub, each query on the ledger, candidates proposed", async () => {
    writeUser('[network]\nresearch = "yes"\n');
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL) => {
      urls.push(String(input));
      return Response.json({
        items: ["mealie", "tandoor", "kitchenowl"].map((n) => ({
          full_name: `example/${n}`,
          html_url: `https://github.com/example/${n}`,
          topics: ["meal-planning", n],
        })),
      });
    };
    const project = await cardStore.ensureProject({ rootPath: repo, name: "Recipes" });
    const d = designStage(RECIPES, { greenfield: true });
    const out = await designCoverage(k(), d, { projectId: project.id, print, fetchImpl });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] as string).host).toBe("api.github.com");
    expect(new URL(urls[0] as string).searchParams.get("q")).toBe("recipe website");
    expect(lines.join("\n")).toContain("https://github.com/example/mealie");
    const events = await log.getEventsByTypes(["research/query"]);
    expect(events.at(-1)?.payload).toMatchObject({ source: "comparables", ok: true, count: 3 });
    const candidates = await cardStore.candidates.list({ projectId: project.id });
    expect(candidates.find((c) => c.title === "Meal planning")).toMatchObject({
      kano: "must-be",
      source: "comparable",
    });
    expect(out.candidateIds.length).toBeGreaterThan(0);
  });
});

// B4.4 wiring: `sekhemet plan` itself offers the profile before planning,
// plans under the answer, adds the comparables and walks after persisting,
// and posts the second design question as an open decision (DS-N1-4).
describe("planCommand offers the depth profile and adds the design coverage (DS-P14-1, -3, -5)", () => {
  it("records the person's answer before planning and plans under it", async () => {
    const asked: string[] = [];
    await planCommand(k(), RECIPES, {
      print,
      offline: true,
      ask: async (q) => {
        asked.push(q);
        return "prototype";
      },
    });
    expect(asked).toHaveLength(1);
    expect(cardStore.depthProfiles.of()).toMatchObject({
      profile: "prototype",
      proposed: "production",
      recorded: true,
    });
    // After persisting: comparables, unsearched offline, and said so.
    expect(lines.join("\n")).toMatch(/not searched.*offline/i);
  });

  it("from the CLI: proposes with no one to ask, records nothing, and honours --offline", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    await main(["plan", RECIPES, "--repo", repo, "--planner", "none", "--offline"]);
    vi.restoreAllMocks();
    expect(out.join("\n")).toMatch(/Proposed Type: production/);
    expect(out.join("\n")).toMatch(/not searched.*offline/i);
    expect(cardStore.depthProfiles.of().recorded).toBe(false);
  });
});

describe("planCommand posts the second design question as an open decision (DS-N1-4)", () => {
  it("asks the first in what it says; the second waits as a safe_default decision with its default", async () => {
    const spec = "Keep notes in a database and sync them between laptops";
    const d = designStage(spec, { greenfield: true });
    expect(d.questions).toHaveLength(2);
    const second = d.questions[1] as (typeof d.questions)[number];
    const { epicId } = await planCommand(k(), spec, { print, offline: true });
    const decisions = await new DecisionStore({ store: cardStore, log }).all();
    const posted = decisions.find((x) => x.request.question === second.question);
    expect(posted?.state).toBe("pending");
    expect(posted?.record.cardId).toBe(epicId);
    expect(posted?.request.policy).toBe("safe_default");
    const i = posted?.request.defaultIfNoAnswer.optionIndex as number;
    expect(posted?.request.options[i]?.label.toLowerCase()).toBe(second.default.toLowerCase());
    expect(posted?.request.recommendation.optionIndex).toBe(i);
    // Only the second: the first is asked in what plan says.
    const first = d.questions[0]?.question as string;
    expect(decisions.some((x) => x.request.question === first)).toBe(false);
  });
});

describe("sekhemet depth from the command line (DS-P14-1)", () => {
  it("records a person's choice for a project and shows it", async () => {
    const project = await cardStore.ensureProject({ rootPath: repo, name: "Recipes" });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    await main(["depth", "internal", "tool", "--project", project.id, "--repo", repo]);
    await main(["dev", "depth", "--project", project.id, "--repo", repo]);
    vi.restoreAllMocks();
    expect(process.exitCode ?? 0).toBe(0);
    expect(cardStore.depthProfiles.of(project.id)).toMatchObject({
      profile: "internal tool",
      recorded: true,
      projectId: project.id,
    });
    expect(cardStore.depthProfiles.of().recorded).toBe(false);
    expect(out.join("\n")).toMatch(/Type: internal tool, chosen\./);
  });
});
