import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import {
  CardStore,
  EventLog,
  type Requirement,
  initSchema,
  readGeneratedHeader,
} from "@sekhemet/kernel";
import { DecisionStore, type PlannerLedger, acceptBrief } from "@sekhemet/planner";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter, readBranchFile } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptCard, recordReviewOpened } from "../src/accept.js";
import { main } from "../src/index.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { PmStore } from "../src/pm/store.js";
import {
  diffRequirements,
  docsLayout,
  exportProjectDocuments,
  moscowOf,
} from "../src/project_docs.js";
import {
  acceptSliceAndRelease,
  checkMain,
  confirmSliceRelease,
  releaseSubcommand,
  strengthVerdict,
} from "../src/project_done.js";
import type { RepoContext } from "../src/wave2.js";

// design-stage NEW-design-stage-3 (DS-N3-1..8): the brief, the requirements
// and the decision records are generated from the ledger into the
// repository and committed onto the integration branch through the Accept
// path; a merged edit comes back as proposals; a person's own file is never
// overwritten; a release's CHANGELOG section and notes are committed before
// its tag. Real SQLite file, real git (DEFINITION_OF_DONE §2A); no model.

let root: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let board: BoardServiceImpl;
let k: RepoContext;
let projectId: string;
let principal: string;

const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const commit = (message: string, files: Record<string, string>) => {
  for (const [p, t] of Object.entries(files)) put(p, t);
  git("add", "-A");
  git("commit", "-q", "-m", message);
};
const onMain = (path: string) => readBranchFile(root, "main", path);
const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const ledger = (): PlannerLedger => ({ store, log, board });
const ctx = () => ({ repoPath: root, cardStore: store, log });

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {
    index: readFileSync(join(root, ".git", "index")).toString("base64"),
  };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === ".sekhemet") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "project-docs-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  commit("chore: seed", { ".gitignore": ".sekhemet/\n", "src/a.ts": "export const a = 1;\n" });
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
  board = new BoardServiceImpl(store);
  k = { repoPath: root, cardStore: store, log, boardService: board };
  projectId = (await store.ensureProject({ rootPath: root, name: "Recipes" })).id;
  principal = store.localPrincipal();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function brief(): Promise<void> {
  await acceptBrief(
    ledger(),
    {
      projectId,
      baseline: "Recipes live in a shared spreadsheet",
      slices: [
        {
          title: "Walking skeleton",
          appetite: { cards: 6 },
          requirements: [
            {
              key: "save",
              title: "Save a recipe",
              kano: "must-be",
              criteria: [{ id: "save.1", text: "WHEN a recipe is saved THE SYSTEM SHALL list it" }],
            },
            { key: "tags", title: "Tag a recipe", mustHave: false, kano: "attractive" },
          ],
        },
      ],
    },
    principal,
  );
}

async function decision(question = "Which store keeps the recipes?"): Promise<string> {
  const decisions = new DecisionStore(ledger());
  const id = await decisions.request({
    id: `q_${question.length}`,
    cardId: "c_none",
    question,
    options: [
      { label: "SQLite", consequence: "One file and no server", effortDelta: "+0", riskNote: "" },
      { label: "Postgres", consequence: "A server to run", effortDelta: "+4", riskNote: "" },
    ],
    previewSketches: [],
    recommendation: { optionIndex: 0, rationale: "there is no server to run" },
    policy: "safe_default",
    defaultIfNoAnswer: { optionIndex: 0, deadline: "2099-01-01T00:00:00.000Z" },
    category: "storage",
    createdAt: new Date().toISOString(),
  });
  await decisions.answer(id, 0, "human", principal);
  return id;
}

describe("DS-N3-1: the documents are generated from the ledger and committed onto the integration branch", () => {
  it("writes the brief, the requirements and a MADR record, each headed with the seq, the checkout untouched", async () => {
    await brief();
    const decisionId = await decision();
    const before = snapshot();
    const head = git("rev-parse", "main");
    const r = await exportProjectDocuments(ctx(), { principal });
    expect(r.written).toEqual([
      "docs/product/brief.md",
      "docs/product/requirements.md",
      "docs/decisions/0001-which-store-keeps-the-recipes.md",
    ]);
    expect(git("rev-parse", "main")).toBe(r.sha);
    expect(git("rev-parse", `${r.sha}^`)).toBe(head);
    expect(snapshot()).toEqual(before);
    const message = git("log", "-1", "--format=%B", "main");
    expect(message).toMatch(/^docs\(product\): /);
    expect(message).toMatch(/Accepted-by: Jane Doe/);

    const briefText = onMain("docs/product/brief.md") as string;
    expect(readGeneratedHeader(briefText)).toBe(r.seq);
    expect(briefText).toContain("Recipes live in a shared spreadsheet");
    expect(briefText).toMatch(/### SLICE-1 — Walking skeleton/);
    expect(briefText).toContain("Accepted by Jane Doe");
    // DEC-31: the documents speak MoSCoW, releases and the project's Type, never Kano.
    expect(briefText).toContain("## Releases");
    expect(briefText).toContain("## Type");
    expect(briefText).toContain("- REQ-2 — Tag a recipe (Could have)");
    expect(briefText).not.toMatch(/kano|nice-to-have|must-have|Depth profile|## Slices/i);

    const reqs = onMain("docs/product/requirements.md") as string;
    expect(readGeneratedHeader(reqs)).toBe(r.seq);
    expect(reqs).toContain("### REQ-1 — Save a recipe");
    expect(reqs).toContain(
      "version: 1 · priority: Must have · release: SLICE-1 · status: unplanned · dependsOn: none",
    );
    expect(reqs).toContain("- `save.1` WHEN a recipe is saved THE SYSTEM SHALL list it");
    expect(reqs).toContain("### REQ-2 — Tag a recipe");
    expect(reqs).toMatch(/version: 1 · priority: Could have · release: SLICE-1/);
    expect(reqs).not.toMatch(/kano|must-have|nice-to-have/i);

    const madr = onMain("docs/decisions/0001-which-store-keeps-the-recipes.md") as string;
    expect(readGeneratedHeader(madr)).toBe(r.seq);
    expect(madr).toMatch(/\nstatus: accepted\n/);
    expect(madr).toMatch(/\ndate: \d{4}-\d{2}-\d{2}\n/);
    expect(madr).toMatch(/\ndecision-makers: Jane Doe\n/);
    expect(madr).toContain(`sekhemet-decision: ${decisionId}`);
    for (const heading of [
      "## Context and Problem Statement",
      "## Decision Drivers",
      "## Considered Options",
      "## Decision Outcome",
      "### Consequences",
      "### Confirmation",
    ]) {
      expect(madr).toContain(heading);
    }
    expect(madr).toContain('Chosen option: "SQLite", because there is no server to run.');

    // The export is recorded: the seq and each file's SHA-256 as committed.
    const last = store.documents.exports().at(-1);
    expect(last?.seq).toBe(r.seq);
    expect(last?.noNames).toBe(false);
    for (const f of last?.files ?? []) expect(f.sha256).toBe(sha256(onMain(f.path) as string));

    // Nothing changed in the ledger's documents: no second commit.
    const again = await exportProjectDocuments(ctx(), { principal });
    expect(again.sha).toBeUndefined();
    expect(git("rev-parse", "main")).toBe(r.sha);

    // A revised requirement regenerates only what changed; the record keeps its number.
    await store.requirements.revise("REQ-1", { title: "Save and name a recipe" }, principal);
    const third = await exportProjectDocuments(ctx(), { principal });
    expect(third.written).toEqual(["docs/product/brief.md", "docs/product/requirements.md"]);
    expect(onMain("docs/product/requirements.md")).toContain("### REQ-1 — Save and name a recipe");
    expect(onMain("docs/product/requirements.md")).toMatch(/version: 2 · priority: Must have/);
  });

  it("is triggered by a person's Accept of a card: the documents follow the squash", async () => {
    await brief();
    const card = await cardInReview();
    const accept = { repoPath: root, cardStore: store, boardService: board, eventLog: log };
    await recordReviewOpened(accept, card, ["src/b.ts"]);
    const squash = await acceptCard(accept, card);
    const head = git("rev-parse", "main");
    expect(git("rev-parse", `${head}^`)).toBe(squash);
    expect(onMain("src/b.ts")).toBe("export const b = 2;\n");
    expect(onMain("docs/product/requirements.md")).toContain("### REQ-1 — Save a recipe");
    expect(git("log", "-1", "--format=%B", "main")).toMatch(/Card: c1/);
  });

  it("`sekhemet accept <card>` exports them too (the CLI passes the ledger to Accept)", async () => {
    await brief();
    const card = await cardInReview();
    await recordReviewOpened({ repoPath: root, cardStore: store, boardService: board }, card, [
      "src/b.ts",
    ]);
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    await main(["accept", "c1", "--repo", root]);
    spy.mockRestore();
    expect(out.join("\n")).toMatch(/Accepted c1/);
    expect(onMain("docs/product/requirements.md")).toContain("### REQ-1 — Save a recipe");
  });
});

/** Card c1 with one checkpoint and its evidence, in Review. */
async function cardInReview(project?: string) {
  const adapter = new NodeGitSyncAdapter(root);
  await store.createCard({
    id: "c1",
    tier: "story",
    title: "Card c1",
    scopeFiles: ["src/**"],
    ...(project ? { projectId: project } : {}),
  });
  const wt = await adapter.createWorktree("c1", "main", "Card c1");
  writeFileSync(join(wt, "src", "b.ts"), "export const b = 2;\n");
  await adapter.commitCheckpoint({
    cardId: "c1",
    step: 1,
    gateStatus: "pass",
    agentModel: "nail",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });
  const evidence = {
    id: "ev_c1",
    cardId: "c1",
    attempt: 1,
    passed: true,
    rungResults: [
      {
        gate: "unit",
        rung: "test",
        layer: "functional",
        passed: true,
        exitCode: 0,
        durationMs: 1,
      },
    ],
    filesTouched: ["src/b.ts"],
    linesAdded: 1,
    linesRemoved: 0,
    settings: { modelId: "nail" },
    stopReason: "gate_passed",
    repoState: await adapter.getRepoStateHash("c1"),
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  put(".sekhemet/evidence/ev_c1.json", body);
  await recordLedgerRun(store, {
    cardId: "c1",
    modelId: "nail",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: "ev_c1",
    path: ".sekhemet/evidence/ev_c1.json",
    body,
    filesTouched: ["src/b.ts"],
  });
  await store.updateCardStatus("c1", "review", "verified", "harness", { override: true });
  const card = await store.getCard("c1");
  if (!card) throw new Error("no c1");
  return card;
}

describe("DS-N3-2: a merged edit to a generated document comes back as proposals", () => {
  it("records one proposal per difference, changes nothing until a person applies one, then regenerates", async () => {
    await brief();
    await exportProjectDocuments(ctx(), { principal });
    const generated = onMain("docs/product/requirements.md") as string;
    git("checkout", "-q", "-f", "main");
    const edited = generated
      .replace("### REQ-1 — Save a recipe", "### REQ-1 — Save and share a recipe")
      .replace(
        "- `save.1` WHEN a recipe is saved THE SYSTEM SHALL list it",
        "- `save.1` WHEN a recipe is saved THE SYSTEM SHALL list it first",
      )
      .concat("\n### Print a recipe\n\n- WHEN a recipe is printed THE SYSTEM SHALL fit one page\n");
    commit("docs: edit the requirements by hand", { "docs/product/requirements.md": edited });
    const mergedAt = git("rev-parse", "main");

    const r = await exportProjectDocuments(ctx(), { principal });
    expect(r.proposals).toEqual(["DOCP-1", "DOCP-2", "DOCP-3"]);
    expect(r.held).toEqual(["docs/product/requirements.md"]);
    expect(onMain("docs/product/requirements.md")).toBe(edited);
    const open = await store.documents.openProposals();
    expect(open.map((p) => [p.kind, p.target, p.targetId, p.field, p.commit])).toEqual([
      ["changed", "requirement", "REQ-1", "title", mergedAt],
      ["changed", "requirement", "REQ-1", "criteria", mergedAt],
      ["added", "requirement", undefined, undefined, mergedAt],
    ]);
    expect((await store.requirements.get("REQ-1"))?.version).toBe(1);
    // The same edit is never diffed twice.
    expect((await exportProjectDocuments(ctx(), { principal })).proposals).toEqual([]);

    const out: string[] = [];
    const run = (args: string[]) => releaseSubcommand(k, ["docs", ...args], (l) => out.push(l));
    expect(await run(["proposals"])).toBe(0);
    expect(await run(["apply", "DOCP-9"])).toBe(1);
    expect(out.join("\n")).toMatch(/DOCP-1 .*REQ-1 title/);
    expect(await run(["apply", "DOCP-1"])).toBe(0);
    expect(await run(["apply", "DOCP-2"])).toBe(0);
    expect(await run(["dismiss", "DOCP-3"])).toBe(0);
    const req = await store.requirements.get("REQ-1");
    expect(req?.version).toBe(3);
    expect(req?.title).toBe("Save and share a recipe");
    expect(req?.criteria).toEqual([
      { id: "save.1", text: "WHEN a recipe is saved THE SYSTEM SHALL list it first" },
    ]);
    expect(await store.documents.openProposals()).toEqual([]);
    // Resolved: the next export writes the ledger's version again.
    const after = await exportProjectDocuments(ctx(), { principal });
    expect(after.written).toContain("docs/product/requirements.md");
    const now = onMain("docs/product/requirements.md") as string;
    expect(now).toContain("### REQ-1 — Save and share a recipe");
    expect(now).not.toContain("Print a recipe");
  });
});

describe("DS-N3-3: --no-names writes role labels", () => {
  it("names nobody in the brief or the decision records", async () => {
    await brief();
    await decision();
    const r = await exportProjectDocuments(ctx(), { principal, noNames: true });
    const all = r.written.map((p) => onMain(p) as string).join("\n");
    expect(all).not.toContain("Jane Doe");
    expect(all).toMatch(/decision-makers: Owner\n/);
    expect(all).toContain("Accepted by Owner");
    expect(store.documents.exports().at(-1)?.noNames).toBe(true);
    expect(git("log", "-1", "--format=%B", "main")).not.toContain("Jane Doe");
  });
});

describe("DS-N3-4, -6: the layout the repository already has", () => {
  it("exports to the configured folders and nowhere else", async () => {
    put(
      ".sekhemet/config.toml",
      '[docs]\nproduct = "handbook/product"\ndecisions = "handbook/adr"\n',
    );
    await brief();
    await decision();
    const r = await exportProjectDocuments(ctx(), { principal });
    expect(r.written).toEqual([
      "handbook/product/brief.md",
      "handbook/product/requirements.md",
      "handbook/adr/0001-which-store-keeps-the-recipes.md",
    ]);
    expect(onMain("docs/product/brief.md")).toBeUndefined();
  });

  it("writes into an existing ADR folder, numbered after its highest record, and creates no docs/decisions", async () => {
    commit("docs: our ADRs", {
      "docs/adr/0003-use-typescript.md": "# Use TypeScript\n",
      "docs/adr/0007-use-vitest.md": "# Use Vitest\n",
    });
    expect(docsLayout(root, ["docs/adr/0003-use-typescript.md"]).decisions).toBe("docs/adr");
    expect(
      docsLayout(root, ["doc/architecture/decisions/0001-record-architecture-decisions.md"])
        .decisions,
    ).toBe("doc/architecture/decisions");
    await decision();
    const r = await exportProjectDocuments(ctx(), { principal });
    expect(r.written).toEqual(["docs/adr/0008-which-store-keeps-the-recipes.md"]);
    expect(onMain("docs/adr/0003-use-typescript.md")).toBe("# Use TypeScript\n");
    // A second decision takes the next number; the first keeps its own.
    await decision("Which test runner checks the recipes?");
    const r2 = await exportProjectDocuments(ctx(), { principal });
    expect(r2.written).toEqual(["docs/adr/0009-which-test-runner-checks-the-recipes.md"]);
    expect(git("ls-tree", "-r", "--name-only", "main")).not.toContain("docs/decisions");
  });
});

describe("DS-N3-5: a document the person wrote is never overwritten", () => {
  it("leaves a header-less file at an export path as it is and offers it", async () => {
    commit("docs: my brief", { "docs/product/brief.md": "# Our brief\n\nWritten by us.\n" });
    await brief();
    const r = await exportProjectDocuments(ctx(), { principal });
    expect(r.left).toEqual(["docs/product/brief.md"]);
    expect(r.written).toEqual(["docs/product/requirements.md"]);
    expect(onMain("docs/product/brief.md")).toBe("# Our brief\n\nWritten by us.\n");
    const thread = await new PmStore(log).thread();
    expect(thread.map((m) => m.text).join("\n")).toMatch(
      /docs\/product\/brief\.md.*has no generated header.*left as it is/,
    );
    // Offered once, not on every export.
    await exportProjectDocuments(ctx(), { principal });
    const again = await new PmStore(log).thread();
    expect(again.filter((m) => m.text.includes("docs/product/brief.md"))).toHaveLength(1);
  });

  it("offers a replaced generated file's content as proposals and never writes over it", async () => {
    await brief();
    await exportProjectDocuments(ctx(), { principal });
    git("checkout", "-q", "-f", "main");
    commit("docs: replace the brief", {
      "docs/product/brief.md":
        "# Brief\n\n## What people have today\n\nRecipes live on paper cards\n",
    });
    const r = await exportProjectDocuments(ctx(), { principal });
    expect(r.left).toEqual(["docs/product/brief.md"]);
    const [p] = await store.documents.openProposals();
    expect(p).toMatchObject({
      kind: "changed",
      target: "brief",
      field: "baseline",
      proposed: "Recipes live on paper cards",
    });
    const [event] = await log.getEventsByTypes(["docs/import_diffed"]);
    expect(event?.payload).not.toHaveProperty("headerSeq");
  });
});

describe("DS-N3-7: README.md and CONTRIBUTING.md are the person's", () => {
  it("offers a link to the documents as a proposal and writes neither file", async () => {
    commit("docs: readme", {
      "README.md": "# Recipes\n",
      "CONTRIBUTING.md": "Be kind.\n",
    });
    await brief();
    const r = await exportProjectDocuments(ctx(), { principal });
    expect(r.offers).toEqual(["README.md"]);
    expect(onMain("README.md")).toBe("# Recipes\n");
    expect(onMain("CONTRIBUTING.md")).toBe("Be kind.\n");
    const thread = (await new PmStore(log).thread()).map((m) => m.text).join("\n");
    expect(thread).toMatch(/Suggested: .*README\.md.*docs\/product\/brief\.md/);
    expect(thread).toMatch(/does not edit README\.md/);
  });
});

describe("DS-N3-8: a release's changelog section and notes are committed before its tag", () => {
  it("proposes the section, then commits CHANGELOG.md and the notes and tags that commit", async () => {
    const earlier =
      "## [0.0.9] - 2026-01-01\n\n### Added\n\n- Something from before\n\n[0.0.9]: https://example.com\n";
    const theirs = `# Changelog\n\nOur own changelog.\n\n${earlier}`;
    commit("feat: save a recipe", { "CHANGELOG.md": theirs, "src/save.ts": "export {};\n" });
    await brief();
    // The slice is proven on main: a check at the head with its tests passing.
    const head = git("rev-parse", "main");
    await store.createCard({
      id: "c_save",
      tier: "task",
      title: "Save",
      status: "ready",
      projectId,
    });
    await store.updateCardStatus("c_save", "done", "built", "harness", { override: true });
    await store.requirements.link({ requirementId: "REQ-1", from: "card", ref: "c_save" });
    await store.requirements.link({ requirementId: "REQ-1", from: "test", ref: "t.spec.ts" });
    await log.append({
      actor: "gate",
      type: "requirement/main_checked",
      payload: {
        sha: head,
        branch: "main",
        gatesPassed: true,
        tests: { "t.spec.ts": { result: "passed", strength: "met" } },
        profile: "internal tool",
      },
    });
    const accepted = await acceptSliceAndRelease(k, "SLICE-1", principal);
    expect(accepted.release?.version).toBe("0.1.0");
    expect(accepted.release?.changelog).toMatch(
      /^## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- save a recipe/,
    );
    expect(git("rev-parse", "main")).toBe(head);

    const tagged = await confirmSliceRelease(k, "SLICE-1");
    expect(tagged.tag).toBe("v0.1.0");
    expect(git("rev-parse", `${tagged.sha}^`)).toBe(head);
    expect(git("rev-parse", "v0.1.0^{commit}")).toBe(tagged.sha);
    const changelog = readBranchFile(root, "v0.1.0", "CHANGELOG.md") as string;
    expect(changelog.startsWith("# Changelog\n\nOur own changelog.\n\n## [0.1.0] - ")).toBe(true);
    expect(changelog.endsWith(earlier)).toBe(true);
    const notes = readBranchFile(root, "v0.1.0", "docs/product/releases/0.1.0.md") as string;
    expect(readGeneratedHeader(notes)).toBeGreaterThan(0);
    expect(notes).toContain("You can now:\n- Save a recipe");
    const [taggedEvent] = await log.getEventsByTypes(["release/tagged"]);
    expect(taggedEvent?.payload).toMatchObject({ sha: tagged.sha, proven: head });
    expect(
      store.documents
        .exports()
        .at(-1)
        ?.files.map((f) => f.kind),
    ).toEqual(expect.arrayContaining(["changelog", "release"]));
  });
});

describe("project done reads the recorded depth profile (DS-P14-1)", () => {
  it("judges main against the project's chosen profile, not the default", async () => {
    await brief();
    put(
      ".sekhemet/gates.toml",
      '[[gate]]\nid = "noop"\nrung = "typecheck"\ncommand = "node"\nargs = ["-e", ""]\ntimeout_s = 60\n',
    );
    await store.depthProfiles.choose({ profile: "prototype", projectId }, principal);
    const r = await checkMain(k, { sandbox: new ProcessSandbox() });
    expect(r.check?.profile).toBe("prototype");
    // The profile decides the verdict: a stub that survived fails internal tool's rule only.
    const weak = {
      origin: "card",
      redForWrongReason: [],
      profile: "prototype",
      profileNote: "",
      interface: [],
      smells: [],
      redAtAssertion: { status: "red", results: [], requireAssertions: true },
      stubKill: { status: "survived", runs: [], passing: ["x"] },
      testGaps: [],
      verdict: { detail: "" },
    } as unknown as Parameters<typeof strengthVerdict>[0];
    expect(strengthVerdict(weak, "internal tool")).toBe("unmet");
    expect(strengthVerdict(weak, "prototype")).toBe("met");
  }, 60_000);
});

describe("[docs] through the config module (B4.4)", () => {
  it("reads the configured folders through the config module and refuses one outside the repository", () => {
    put(".sekhemet/config.toml", '[docs]\nproduct = "../outside"\ndecisions = "handbook/adr"\n');
    expect(docsLayout(root, [])).toEqual({ product: "docs/product", decisions: "handbook/adr" });
  });
});

describe("RG-S5-2: a checkout on the integration branch is told how to catch up after an export", () => {
  it("`release docs` and `release brief` say the command that brings its files up to date", async () => {
    const out: string[] = [];
    const file = join(root, ".sekhemet", "brief.json");
    writeFileSync(
      file,
      JSON.stringify({
        baseline: "Recipes live in a shared spreadsheet",
        slices: [
          {
            title: "Walking skeleton",
            appetite: { cards: 6 },
            requirements: [{ key: "save", title: "Save a recipe" }],
          },
        ],
      }),
    );
    expect(await releaseSubcommand(k, ["brief", file], (l) => out.push(l))).toBe(0);
    expect(out.join("\n")).toMatch(/Your checkout .* is on main, which moved to .*read-tree -m -u/);
    out.length = 0;
    await decision();
    expect(await releaseSubcommand(k, ["docs"], (l) => out.push(l))).toBe(0);
    expect(out.join("\n")).toMatch(/Your checkout .* is on main, which moved to .*read-tree -m -u/);
  });
});

describe("DEC-31: a requirements document speaks MoSCoW, and a changed priority is read back", () => {
  const req = (patch: Partial<Requirement>): Requirement =>
    ({
      id: "REQ-2",
      title: "Tag a recipe",
      version: 1,
      mustHave: false,
      kano: "attractive",
      sliceId: "SLICE-1",
      dependsOn: [],
      criteria: [],
      ...patch,
    }) as Requirement;
  const doc = (priority: string) =>
    `### REQ-2 — Tag a recipe\n\nversion: 1 · priority: ${priority} · release: SLICE-1 · status: planned · dependsOn: none\n`;

  it("names each requirement Must have, Should have or Could have", () => {
    expect(moscowOf(req({ mustHave: true, kano: "performance" }))).toBe("Must have");
    expect(moscowOf(req({ kano: "performance" }))).toBe("Should have");
    expect(moscowOf(req({ kano: "attractive" }))).toBe("Could have");
    expect(moscowOf(req({ kano: undefined }))).toBe("Could have");
  });

  it("proposes nothing for an unchanged priority, and the must-have and class for a changed one", () => {
    expect(diffRequirements(doc("Could have"), [req({})])).toEqual([]);
    expect(diffRequirements(doc("Could have"), [req({ kano: undefined })])).toEqual([]);
    expect(diffRequirements(doc("Must have"), [req({})])).toEqual([
      {
        kind: "changed",
        target: "requirement",
        targetId: "REQ-2",
        field: "must_have",
        proposed: "yes",
      },
    ]);
    expect(diffRequirements(doc("Should have"), [req({})])).toEqual([
      {
        kind: "changed",
        target: "requirement",
        targetId: "REQ-2",
        field: "kano",
        proposed: "performance",
      },
    ]);
  });
});

// DEC-57: a workspace holds many projects and each keeps its own
// repository. A project's documents, its main check and its release are its
// own: an Accept in project A never commits project B's brief, an export of
// B never makes A's documents look edited, and a release of B is planned,
// proven and tagged in B's repository whichever folder the server started in.
describe("DEC-57: each project's documents and releases stay in its own repository", () => {
  let rootB: string;
  let projectB: string;
  const gitB = (...a: string[]) => execFileSync("git", a, { cwd: rootB, encoding: "utf8" }).trim();

  beforeEach(async () => {
    rootB = realpathSync(mkdtempSync(join(tmpdir(), "project-docs-beta-")));
    gitB("init", "-q", "-b", "main");
    gitB("config", "user.name", "Jane Doe");
    gitB("config", "user.email", "jane@example.com");
    writeFileSync(join(rootB, ".gitignore"), ".sekhemet/\n");
    writeFileSync(join(rootB, "invoice.ts"), "export const invoice = 1;\n");
    gitB("add", "-A");
    gitB("commit", "-q", "-m", "feat: round invoices");
    projectB = (await store.ensureProject({ rootPath: rootB, name: "Beta" })).id;
  });
  afterEach(() => rmSync(rootB, { recursive: true, force: true }));

  async function briefB(): Promise<void> {
    await acceptBrief(
      ledger(),
      {
        projectId: projectB,
        baseline: "Invoices are rounded by hand",
        slices: [
          {
            title: "Rounding",
            appetite: { cards: 3 },
            requirements: [{ key: "round", title: "Beta rounds invoices", kano: "must-be" }],
          },
        ],
      },
      principal,
    );
  }

  it("an Accept in project A commits A's documents, never the brief accepted last in B", async () => {
    await brief();
    await briefB();
    const card = await cardInReview(projectId);
    const accept = { repoPath: root, cardStore: store, boardService: board, eventLog: log };
    await recordReviewOpened(accept, card, ["src/b.ts"]);
    await acceptCard(accept, card);
    const requirements = onMain("docs/product/requirements.md") as string;
    expect(requirements).toContain("Save a recipe");
    expect(requirements).not.toContain("Beta rounds invoices");
    expect(onMain("docs/product/brief.md")).toContain("# Product brief: Recipes");
    expect(store.documents.exports().at(-1)?.projectId).toBe(projectId);
    // Nothing was written into B's repository by A's Accept.
    expect(readBranchFile(rootB, "main", "docs/product/requirements.md")).toBeUndefined();
  });

  it("an export of B never makes A's generated documents look edited", async () => {
    await brief();
    await exportProjectDocuments(ctx(), { principal, card: "docs" });
    await briefB();
    const b = await exportProjectDocuments(
      { repoPath: rootB, cardStore: store, log },
      { principal, card: "docs" },
    );
    expect(readBranchFile(rootB, "main", "docs/product/requirements.md")).toContain(
      "Beta rounds invoices",
    );
    expect(b.proposals).toEqual([]);
    const again = await exportProjectDocuments(ctx(), { principal, card: "docs" });
    expect(again.proposals).toEqual([]);
    expect(await store.documents.openProposals()).toEqual([]);
    expect(onMain("docs/product/requirements.md")).toContain("Save a recipe");
  });

  it("a release of B is planned, proven and tagged in B's repository from the server's folder", async () => {
    await brief();
    await briefB();
    const headA = git("rev-parse", "main");
    const headB = gitB("rev-parse", "main");
    await log.append({
      actor: "gate",
      type: "requirement/main_checked",
      payload: {
        sha: headB,
        branch: "main",
        gatesPassed: true,
        tests: {},
        profile: "internal tool",
        projectId: projectB,
      },
    });
    const sliceB = (await store.slices.list(projectB))[0]?.id as string;
    await store.createCard({
      id: "c_round",
      tier: "task",
      title: "Round",
      status: "ready",
      projectId: projectB,
    });
    await store.updateCardStatus("c_round", "done", "built", "harness", { override: true });
    const reqB = (await store.requirements.list({ projectId: projectB }))[0]?.id as string;
    await store.requirements.link({ requirementId: reqB, from: "card", ref: "c_round" });
    await store.requirements.link({ requirementId: reqB, from: "test", ref: "r.spec.ts" });
    await log.append({
      actor: "gate",
      type: "requirement/main_checked",
      payload: {
        sha: headB,
        branch: "main",
        gatesPassed: true,
        tests: { "r.spec.ts": { result: "passed", strength: "met" } },
        profile: "internal tool",
        projectId: projectB,
      },
    });
    // k is the server's folder: project A's root.
    const accepted = await acceptSliceAndRelease(k, sliceB, principal);
    expect(accepted.releaseRefused).toBeUndefined();
    expect(accepted.release?.changelog).toMatch(/round invoices/);
    const [proven] = await log.getEventsByTypes(["release/proven"]);
    expect(proven?.payload).toMatchObject({ sliceId: sliceB, sha: headB });
    const tagged = await confirmSliceRelease(k, sliceB);
    expect(gitB("rev-parse", `${tagged.tag}^{commit}`)).toBe(tagged.sha);
    expect(gitB("rev-parse", `${tagged.sha}^`)).toBe(headB);
    expect(readBranchFile(rootB, tagged.tag, "CHANGELOG.md")).toContain("round invoices");
    // A's repository has no tag and no new commit.
    expect(git("tag", "--list")).toBe("");
    expect(git("rev-parse", "main")).toBe(headA);
  });
});
