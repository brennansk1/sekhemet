import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { loadGatesConfig } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { DecisionStore } from "@sekhemet/planner";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_ONE_LABEL, CARD_ZERO_LABEL } from "../src/card_zero.js";
import { type PmSnapshot, answer, toProposals, withProjectGroups } from "../src/pm/agent.js";
import { applyProposal } from "../src/pm/apply.js";
import { type ProjectGroup, draftProjectGroup } from "../src/pm/pipeline.js";
import { answerQueued } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";

/**
 * planner-pm §2.9 and design-stage §2.9 (PM-P2-1, -2; DS-P2-5, -6, -7): a
 * person tells Seshat what to build in one sentence; the reply is one
 * proposal group — epics, the first slice's cards with criteria and points,
 * the proposed requirements, card zero — that creates nothing until it is
 * applied, and applying it creates the project with the person as actor, no
 * terminal command at any step. A real repository and an on-disk ledger
 * (DEFINITION_OF_DONE §2A); the model is a scripted adapter, none is loaded.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function setup() {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-start-"));
  dirs.push(repoPath);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("commit", "-q", "--allow-empty", "-m", "chore: empty");
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const boardService = new BoardServiceImpl(cardStore, { entryConditions: true });
  const pmStore = new PmStore(log);
  return { repoPath, db, log, cardStore, boardService, pmStore };
}

type Setup = ReturnType<typeof setup>;

const eventCount = (s: Setup) =>
  (s.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

async function propose(s: Setup, sentence: string) {
  const drafts = await withProjectGroups(
    toProposals(
      [
        {
          id: "1",
          name: "start_project",
          arguments: { brief: sentence, reason: "you asked for it" },
        },
      ],
      [],
    ),
    (x) => draftProjectGroup(s, x),
  );
  return drafts[0];
}

async function stored(s: Setup, draft: Awaited<ReturnType<typeof propose>>) {
  const reply = await s.pmStore.appendReply({
    replyTo: [],
    text: "x",
    proposals: draft ? [draft] : [],
  });
  return reply.proposals?.[0] as NonNullable<typeof reply.proposals>[number];
}

const ctx = (s: Setup) => ({
  cardStore: s.cardStore,
  boardService: s.boardService,
  pmStore: s.pmStore,
  repoPath: s.repoPath,
  actor: "human",
  principal: "p_ada",
});

describe("PM-P2-1: 'start a new project' returns one proposal group and creates nothing", () => {
  it("holds the epics, the first slice's cards with criteria and points, the requirements and card zero", async () => {
    const s = setup();
    const before = eventCount(s);
    const draft = await propose(s, "a recipe website where people can sign up and save favourites");
    expect(draft?.kind).toBe("start_project");
    const group = draft?.patch?.group as ProjectGroup;
    expect(group.epics.length).toBeGreaterThan(0);
    expect(group.cards.length).toBeGreaterThan(0);
    for (const c of group.cards) {
      expect(c.criteria.length).toBeGreaterThan(0);
      expect([1, 2, 3, 5, 8]).toContain(c.points);
    }
    expect(group.requirements.length).toBeGreaterThan(0);
    expect(group.cardZero.labels).toContain(CARD_ZERO_LABEL);
    expect(group.cardZero.spec).toContain("npm init -y");
    expect(group.cardOne.labels).toContain(CARD_ONE_LABEL);
    expect(draft?.summary).toContain("Review the plan");
    // Created nothing: no event, no card, no requirement, no brief, no gates.
    expect(eventCount(s)).toBe(before);
    expect(await s.cardStore.listCards()).toHaveLength(0);
    expect(await s.cardStore.requirements.list()).toHaveLength(0);
    expect(existsSync(join(s.repoPath, ".sekhemet", "brief.md"))).toBe(false);
    expect(existsSync(join(s.repoPath, ".sekhemet", "gates.toml"))).toBe(false);
  });
});

describe("PM-P2-1 in the product: Seshat's answer carries the group", () => {
  it("answerQueued turns a start_project call into one proposal group, creating no card", async () => {
    const s = setup();
    await s.pmStore.appendUserMessage("start a new project: build me a calculator");
    const model = new MockInferenceAdapter("seshat", [
      {
        text: "I've proposed the plan for you to review.",
        toolCalls: [
          {
            id: "c1",
            name: "start_project",
            arguments: { brief: "build me a calculator", reason: "you asked to start it" },
          },
        ],
        finishReason: "tool_calls",
        usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
      },
    ]);
    const answered = await answerQueued({
      repoPath: s.repoPath,
      cardStore: s.cardStore,
      pmStore: s.pmStore,
      pmModel: "seshat",
      acquire: async () => ({ role: "chat", adapter: model, release: () => {} }),
    });
    expect(answered).toBe(true);
    const reply = (await s.pmStore.thread()).at(-1);
    const [draft] = reply?.proposals ?? [];
    expect(draft?.kind).toBe("start_project");
    const group = draft?.patch?.group as ProjectGroup | undefined;
    expect(group?.cardZero.labels).toContain(CARD_ZERO_LABEL);
    expect(group?.cards.length).toBeGreaterThan(0);
    expect(await s.cardStore.listCards()).toHaveLength(0);
  });
});

describe("DS-P2-6: Review plan shows the brief, the releases, the assumptions and the count", () => {
  it("has the eight headings, a release with no forecast yet, the assumptions and what approval creates", async () => {
    const s = setup();
    const group = (await propose(s, "A billing service that charges customers monthly"))?.patch
      ?.group as ProjectGroup;
    const b = group.brief;
    for (const section of [
      b.problem,
      b.outcome,
      b.users,
      b.notInScope,
      b.constraints,
      b.priorArt,
      b.riskiest,
      b.doneMeans,
    ]) {
      expect(section.length).toBeGreaterThan(0);
    }
    expect(b.riskiest.join(" ")).toMatch(/charge/i);
    expect(b.constraints.join(" ")).toContain("Generator: npm init, tsc --init and Vitest");
    // No finished work yet: no forecast, which Review plan says as "Not enough history yet".
    expect(group.releases[0]?.forecast).toBeUndefined();
    expect(group.releases[0]?.cards).toBeGreaterThan(2);
    expect(group.assumptions.length).toBeGreaterThan(0);
    expect(group.creates).toEqual({
      project: 1,
      epics: group.epics.length,
      issues: group.cards.length + 2,
      brief: 1,
      cardZero: 1,
    });
  });
});

describe("DS-P2-7: candidates by priority, a movable release line, the Type, at most two questions", () => {
  it("groups the candidates, proposes the Type with its reason and asks at most two questions", async () => {
    const s = setup();
    const group = (
      await propose(
        s,
        "A CLI that syncs my notes to S3. It lists what changed. It restores a deleted note.",
      )
    )?.patch?.group as ProjectGroup;
    expect(group.candidates.map((c) => c.priority)).toEqual(
      [...group.candidates.map((c) => c.priority)].sort(
        (a, b) => ["must", "should", "could"].indexOf(a) - ["must", "should", "could"].indexOf(b),
      ),
    );
    expect(group.candidates.some((c) => c.priority === "must")).toBe(true);
    expect(group.candidates.some((c) => c.priority === "should")).toBe(true);
    expect(group.releaseLine).toBeGreaterThan(0);
    expect(group.type.profile).toBe("internal tool");
    expect(group.type.reason.length).toBeGreaterThan(10);
    expect(group.questions.length).toBeLessThanOrEqual(2);
    expect(group.questions.length).toBeGreaterThan(0);
  });

  it("applied: a removed candidate is not planned, the line splits the releases, unanswered questions are assumptions", async () => {
    const s = setup();
    const draft = await propose(
      s,
      "A CLI that syncs my notes to S3. It lists what changed. It restores a deleted note.",
    );
    const group = draft?.patch?.group as ProjectGroup;
    const [must, ...rest] = group.candidates;
    const removed = rest.at(-1);
    if (!must || !removed) throw new Error("expected candidates");
    const p = await stored(s, draft);
    const out = await applyProposal(p, {
      ...ctx(s),
      choices: { remove: [removed.key], releaseLine: 1, answers: { "0": 1 } },
    });
    expect(out.proposal.state).toBe("applied");
    const reqs = await s.cardStore.requirements.list();
    expect(reqs.map((r) => r.title)).toContain(must.title);
    expect(reqs.map((r) => r.title)).not.toContain(removed.title);
    const slices = await s.cardStore.slices.list();
    expect(slices.map((x) => x.title)).toEqual(expect.arrayContaining(["Release 1"]));
    // The first question was answered: a decision with the answer; the second, if any, assumed.
    const decisions = await new DecisionStore({ store: s.cardStore, log: s.log }).all();
    expect(
      decisions.some(
        (d) => d.state === "answered" && d.request.question === group.questions[0]?.question,
      ),
    ).toBe(true);
    if (group.questions[1]) {
      const assumed = await s.log.getEventsByTypes(["assumption/logged"]);
      expect(
        assumed.some((e) =>
          String((e.payload as { statement?: string }).statement).startsWith(
            group.questions[1]?.question as string,
          ),
        ),
      ).toBe(true);
    }
  });
});

describe("PM-P2-2: applying the group creates the project through the pipeline, the person the actor", () => {
  it("creates the brief, card zero with its gate, card one after it, and the planned cards after card one", async () => {
    const s = setup();
    const p = await stored(s, await propose(s, "build me a calculator"));
    const out = await applyProposal(p, ctx(s));
    const zero = out.cards.find((c) => c.labels?.includes(CARD_ZERO_LABEL));
    const one = out.cards.find((c) => c.labels?.includes(CARD_ONE_LABEL));
    expect(zero?.status).toBe("ready");
    expect(one?.dependsOn).toEqual([zero?.id]);
    const planned = out.cards.filter((c) => c !== zero && c !== one);
    expect(planned.length).toBeGreaterThan(0);
    for (const c of planned) expect(c.dependsOn).toContain(one?.id);
    // Every card through the pipeline: criteria linted, a person's approval pending.
    for (const c of planned) expect(c.status).toBe("planning");
    // The person is the actor of every card created.
    const created = (await s.log.getEventsByTypes(["card/created"])).filter((e) =>
      out.cards.some((c) => c.id === (e.payload as { id?: string }).id),
    );
    expect(created.length).toBe(out.cards.length);
    for (const e of created) expect(e.actor).not.toBe("planner");
    const brief = readFileSync(join(s.repoPath, ".sekhemet", "brief.md"), "utf8");
    expect(brief).toContain("Generator: npm init, tsc --init and Vitest");
    expect(loadGatesConfig(s.repoPath).gates.map((g) => g.id)).toEqual(["scaffold"]);
    expect(s.cardStore.depthProfiles.of(zero?.projectId).recorded).toBe(true);
  });
});

describe("DS-P2-5: the five greenfield specs, started by a scripted non-developer conversation", () => {
  const SPECS: [string, string][] = [
    ["build me a calculator", "npm init -y"],
    ["a Python script that renames photos", "uv init"],
    ["a CLI that syncs my notes to S3", "npm init -y"],
    ["A billing service that charges customers monthly", "npm init -y"],
    ["a recipe website where people can sign up and save favourites", "npm init -y"],
  ];

  for (const [sentence, generator] of SPECS) {
    it(`"${sentence}": one sentence, one Apply, card zero and card one planned, no shell command said`, async () => {
      const s = setup();
      const model = new MockInferenceAdapter("seshat", [
        {
          text: "I've proposed the plan for you to review.",
          toolCalls: [
            {
              id: "c1",
              name: "start_project",
              arguments: { brief: sentence, reason: "you asked to start it" },
            },
          ],
          finishReason: "tool_calls",
          usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
        },
      ]);
      const snapshot: PmSnapshot = {
        project: "new",
        cards: [],
        cycles: [],
        recentRuns: [],
        pmModel: "seshat",
        today: "2026-09-26",
      };
      const said = await answer(
        model,
        snapshot,
        [],
        [
          {
            id: "m1",
            seq: 1,
            role: "user",
            text: `start a new project: ${sentence}`,
            createdAt: "2026-09-26T00:00:00Z",
            state: "queued",
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        (x) => draftProjectGroup(s, x),
      );
      const [draft] = said.proposals;
      const group = draft?.patch?.group as ProjectGroup;
      expect(group.cardZero.spec).toContain(generator);
      const p = await stored(s, draft);
      const out = await applyProposal(p, ctx(s));
      expect(out.cards.some((c) => c.labels?.includes(CARD_ZERO_LABEL))).toBe(true);
      expect(out.cards.some((c) => c.labels?.includes(CARD_ONE_LABEL))).toBe(true);
      // What the person read: the reply and the proposal. No command to type.
      const transcript = [said.text, draft?.summary ?? ""].join("\n");
      expect(transcript).not.toMatch(/`?\b(?:sekhemet|npm|npx|uv|pnpm|git|cd)\s+[a-z-]/);
    });
  }
});

describe("PM-P2-2 with DEC-57: a new project's group is applied only in a folder that holds no project", () => {
  it("DEC-57 (DS-N8-1): over a project that already has an accepted brief, the next is a new project in a new folder, its brief and issues untouched", async () => {
    const s = setup();
    const first = await stored(s, await propose(s, "build me a calculator"));
    await applyProposal(first, ctx(s));
    const project = s.cardStore.listProjects()[0];
    const brief = readFileSync(join(s.repoPath, ".sekhemet", "brief.md"), "utf8");
    const cardsBefore = await s.cardStore.listCards();
    const second = await stored(s, await propose(s, "a Python script that renames photos"));
    const parent = mkdtempSync(join(tmpdir(), "sek-start-next-"));
    dirs.push(parent);
    const folder = join(parent, "photos");
    await applyProposal(second, { ...ctx(s), choices: { folder } });
    // The first project's brief and issues are as they were; the second is its own.
    expect(readFileSync(join(s.repoPath, ".sekhemet", "brief.md"), "utf8")).toBe(brief);
    const now = await s.cardStore.listCards();
    for (const c of cardsBefore)
      expect(now.find((x) => x.id === c.id)?.projectId).toBe(project?.id);
    const next = s.cardStore.listProjects().find((p) => p.id !== project?.id);
    expect(next?.rootPath).toBe(realpathSync(folder));
    expect(now.filter((c) => c.projectId === next?.id).length).toBeGreaterThan(2);
  });

  it("refuses a ledger that already holds cards, even with no project recorded for the folder", async () => {
    const s = setup();
    await s.cardStore.createCard({ tier: "task", title: "Fix the login bug", status: "backlog" });
    expect(s.cardStore.listProjects()).toHaveLength(0);
    const p = await stored(s, await propose(s, "build me a calculator"));
    const before = eventCount(s);
    await expect(applyProposal(p, ctx(s))).rejects.toMatchObject({ status: 409 });
    expect(eventCount(s)).toBe(before);
    expect(await s.cardStore.listCards()).toHaveLength(1);
  });

  it("refuses in a repository that already holds code, so card zero never runs its generator over it", async () => {
    const s = setup();
    const git = (...a: string[]) => execFileSync("git", a, { cwd: s.repoPath, encoding: "utf8" });
    mkdirSync(join(s.repoPath, "src"), { recursive: true });
    writeFileSync(join(s.repoPath, "src", "index.ts"), "export const x = 1;\n");
    git("add", "src/index.ts");
    git("commit", "-q", "-m", "feat: existing code");
    const p = await stored(s, await propose(s, "build me a calculator"));
    const before = eventCount(s);
    await expect(applyProposal(p, ctx(s))).rejects.toMatchObject({ status: 409 });
    expect(eventCount(s)).toBe(before);
    expect(await s.cardStore.listCards()).toHaveLength(0);
    expect(existsSync(join(s.repoPath, ".sekhemet", "brief.md"))).toBe(false);
  });

  it("records the Type the person chose even where a profile was recorded before, never dropping it", async () => {
    const s = setup();
    const project = await s.cardStore.ensureProject({ rootPath: s.repoPath, name: "calc" });
    await s.cardStore.depthProfiles.choose(
      { profile: "prototype", projectId: project.id, checklist: [] },
      "p_ada",
    );
    const p = await stored(s, await propose(s, "build me a calculator"));
    await applyProposal(p, { ...ctx(s), choices: { type: "internal tool" } });
    expect(s.cardStore.depthProfiles.of(project.id).profile).toBe("internal tool");
  });
});
