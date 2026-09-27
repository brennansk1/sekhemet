import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { DecisionStore, acceptBrief, designStage } from "@sekhemet/planner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planThroughPipeline } from "../src/pm/pipeline.js";
import { type Kernel, planCommand } from "../src/wave2.js";

// B4.4 wiring of planner-pm §2.9-2.10 in `sekhemet plan` and `/plan`:
// - PM-P2-6: a design question the brief, a decision or the playbook already
//   answers is neither said nor posted; its answer is an assumption with its
//   source;
// - PM-P2-2: a person's `/plan` (and a bare-brief start_project) creates its
//   cards with the person as actor and principal, not "planner".
// A real git repository and an on-disk ledger (DEFINITION_OF_DONE §2A).
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function kernel(): Kernel {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-plan-b44-"));
  dirs.push(repoPath);
  vi.stubEnv("SEKHEMET_USER_CONFIG", join(repoPath, "user-config.toml"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("commit", "-q", "--allow-empty", "-m", "chore: empty");
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

const SPEC = "Keep notes in a database and sync them between laptops";

/** A person accepts a brief whose baseline states `text` (the ledger's brief, PM-P13-1). */
async function accepted(k: Kernel, text: string): Promise<void> {
  const project = await k.cardStore.ensureProject({ rootPath: k.repoPath, name: "notes" });
  await acceptBrief(
    { store: k.cardStore, log: k.log },
    {
      projectId: project.id,
      baseline: text,
      slices: [{ title: "Release 1", appetite: { cards: 4 }, requirements: [{ title: "Notes" }] }],
    },
    "p_ada",
  );
}

describe("sekhemet plan does not ask a question already answered (PM-P2-6)", () => {
  it("a question the brief answers is neither said nor posted, and becomes a sourced assumption", async () => {
    const k = kernel();
    const d = designStage(SPEC, { greenfield: true });
    expect(d.questions).toHaveLength(2);
    const [first, second] = d.questions as [
      (typeof d.questions)[number],
      (typeof d.questions)[number],
    ];
    // The brief a person accepted answers both: the first with its second
    // answer, the second with its default.
    const pick = first.answers[1]?.answer as string;
    await accepted(k, `${first.question} ${pick}\n\n${second.question} ${second.default}`);
    const out: string[] = [];
    const { epicId } = await planCommand(k, SPEC, { print: (l) => out.push(l), offline: true });
    const said = out.join("\n");
    expect(said).not.toContain(first.question);
    expect(said).not.toContain(second.question);
    const decisions = await new DecisionStore({ store: k.cardStore, log: k.log }).all();
    expect(decisions.some((x) => x.request.question === second.question)).toBe(false);
    const assumed = (await k.log.getEventsByTypes(["assumption/logged"])).map(
      (e) => e.payload as { statement?: string; basis?: string; cardId?: string },
    );
    const settled = assumed.find(
      (a) => String(a.statement).startsWith(first.question) && /^Settled/.test(String(a.basis)),
    );
    expect(settled?.statement).toContain(pick);
    expect(settled?.basis).toMatch(/^Settled by the brief/);
    // Its default is not also assumed.
    expect(
      assumed.filter((a) => String(a.statement).startsWith(first.question)).map((a) => a.basis),
    ).toEqual([settled?.basis]);
    expect(epicId).toMatch(/^epic_/);
  });

  it("a question still open is said as before: the first unanswered one", async () => {
    const k = kernel();
    const d = designStage(SPEC, { greenfield: true });
    const [first, second] = d.questions as [
      (typeof d.questions)[number],
      (typeof d.questions)[number],
    ];
    // Only the first is answered: the second is now the one said, and none is posted.
    await accepted(k, `${first.question} ${first.default}`);
    const out: string[] = [];
    await planCommand(k, SPEC, { print: (l) => out.push(l), offline: true });
    const said = out.join("\n");
    expect(said).not.toContain(first.question);
    expect(said).toContain(second.question);
    const decisions = await new DecisionStore({ store: k.cardStore, log: k.log }).all();
    expect(decisions.some((x) => x.request.question === second.question)).toBe(false);
  });
});

describe("only a brief a person accepted settles a question (PM-P2-6)", () => {
  it("a brief in the working tree that nobody accepted settles nothing: the question is said", async () => {
    const k = kernel();
    const d = designStage(SPEC, { greenfield: true });
    const [first] = d.questions as [(typeof d.questions)[number]];
    writeFileSync(
      join(k.repoPath, ".sekhemet", "brief.md"),
      `# Brief\n\n${first.question} ${first.answers[1]?.answer as string}\n`,
    );
    const out: string[] = [];
    await planCommand(k, SPEC, { print: (l) => out.push(l), offline: true });
    expect(out.join("\n")).toContain(first.question);
    const assumed = (await k.log.getEventsByTypes(["assumption/logged"])).map(
      (e) => e.payload as { basis?: string },
    );
    expect(assumed.some((a) => /^Settled by the brief/.test(String(a.basis)))).toBe(false);
  });
});

describe("a person's /plan creates cards as the person (PM-P2-2)", () => {
  it("every card the pipeline plans has the person's actor, and the requirements their principal", async () => {
    const k = kernel();
    const r = await planThroughPipeline(
      { ...k, actor: "human", principal: "p_ada" },
      "Export every invoice to a PDF file with the company logo.",
    );
    expect(r.created).toBeGreaterThan(0);
    const created = await k.log.getEventsByTypes(["card/created"]);
    expect(created.length).toBeGreaterThan(1);
    for (const e of created) expect(e.actor, e.type).toBe("human");
    const reqs = await k.log.getEventsByTypes(["requirement/created"]);
    expect(reqs.length).toBeGreaterThan(0);
    for (const e of reqs) expect(e.principal).toBe("p_ada");
  });
});
