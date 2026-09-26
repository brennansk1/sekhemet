import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type CardStatus, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import type { StoryMap } from "@sekhemet/planner";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { answer } from "../src/pm/agent.js";
import { ledgerStandup } from "../src/pm/agent.js";
import { applyProposal } from "../src/pm/apply.js";
import { buildSnapshot } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";
import { checkMain, confirmSliceRelease, extendRefusal, mainHead } from "../src/project_done.js";
import { startDashboardServer } from "../src/server.js";
import { type Kernel, queuePrelude, runWave2Command } from "../src/wave2.js";

// planner-pm P13 (§6): on a fixture project whose brief has eight
// requirements across two slices, one of which is revised after its slice is
// proven, every criterion of P13 this change builds holds — PM-P13-1,
// -3..-14. Real SQLite file, real git, a real Vitest run on main in a
// scratch checkout; nothing loads a model (Seshat's model is a stand-in
// that says what a model might say).

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");
const GATES = `[[gate]]
id = "unit"
rung = "test"
command = "node"
args = [${JSON.stringify(VITEST)}, "run"]
parser = "vitest"
timeout_s = 120
`;

const STRONG = {
  origin: "card",
  redForWrongReason: [],
  profile: "internal tool",
  profileNote: "depth profile: internal tool (default)",
  interface: [],
  smells: [],
  redAtAssertion: { status: "red", results: [], requireAssertions: true },
  stubKill: { status: "killed", runs: [] },
  testGaps: [],
  verdict: { detail: "" },
};
const WEAK = { ...STRONG, stubKill: { status: "survived", runs: [], passing: ["x"] } };

const BRIEF = {
  baseline: "Recipes live in a shared spreadsheet",
  slices: [
    {
      title: "Walking skeleton",
      appetite: { cards: 12 },
      requirements: [
        {
          key: "save",
          title: "Save a recipe",
          kano: "must-be",
          criteria: [{ id: "save.1", text: "A saved recipe is listed" }],
        },
        {
          key: "list",
          title: "List saved recipes",
          dependsOn: ["save"],
          criteria: [{ id: "list.1", text: "Lists in saved order" }],
        },
        {
          key: "view",
          title: "Open a recipe",
          dependsOn: ["list"],
          criteria: [{ id: "view.1", text: "Shows its steps" }],
        },
        {
          key: "search",
          title: "Search by name",
          kano: "performance",
          criteria: [{ id: "search.1", text: "Finds by a word of the name" }],
        },
        { key: "tags", title: "Tag a recipe", mustHave: false, kano: "attractive" },
      ],
    },
    {
      title: "Favourites",
      appetite: { cards: 12 },
      requirements: [
        {
          key: "fav",
          title: "Mark a favourite",
          dependsOn: ["list"],
          criteria: [{ id: "fav.1", text: "A favourite is starred" }],
        },
        {
          key: "unfav",
          title: "Unmark a favourite",
          dependsOn: ["fav"],
          criteria: [{ id: "unfav.1", text: "An unstarred recipe loses its star" }],
        },
        { key: "share", title: "Share a favourite", mustHave: false },
      ],
    },
  ],
};

const SRC = `export const recipes: string[] = [];
export function save(name: string): void { recipes.push(name); }
export function list(): string[] { return [...recipes]; }
export function view(name: string): string { return \`Steps for \${name}\`; }
export function search(word: string): string[] { return recipes.filter((r) => r.includes(word)); }
const stars = new Set<string>();
export function fav(name: string): void { stars.add(name); }
export function unfav(name: string): void { stars.delete(name); }
export function starred(name: string): boolean { return stars.has(name); }
`;
const test = (name: string, body: string) =>
  `import { expect, it } from "vitest";\nimport * as r from "../src/recipes.ts";\nit(${JSON.stringify(name)}, () => {\n${body}\n});\n`;
const TESTS: Record<string, { name: string; body: string }> = {
  save: {
    name: "lists a saved recipe",
    body: 'r.save("soup"); expect(r.list()).toContain("soup");',
  },
  list: {
    name: "keeps order",
    body: 'r.save("a"); r.save("b"); expect(r.list().slice(-2)).toEqual(["a", "b"]);',
  },
  view: { name: "shows steps", body: 'expect(r.view("soup")).toBe("Steps for soup");' },
  search: {
    name: "finds by a word",
    body: 'r.save("pea soup"); expect(r.search("pea")).toEqual(["pea soup"]);',
  },
  fav: { name: "stars a favourite", body: 'r.fav("soup"); expect(r.starred("soup")).toBe(true);' },
  unfav: { name: "unstars", body: 'r.fav("x"); r.unfav("x"); expect(r.starred("x")).toBe(false);' },
};

let root: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let k: Kernel;
let projectId: string;
let server: { port: number; close: () => Promise<void> };
const out: string[] = [];
const io = { print: (l: string) => out.push(l) };
const sandbox = new ProcessSandbox();
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const put = (p: string, text: string) => {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), text);
};

// biome-ignore lint/suspicious/noExplicitAny: JSON read back from the API, checked field by field
type Json = any;

function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path,
        headers: { "x-sekhemet-action": "1", "content-type": "application/json" },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const map = async (): Promise<StoryMap> => (await call("GET", `/api/story-map/${projectId}`)).json;
const req = (m: StoryMap, id: string) =>
  m.slices.flatMap((s) => s.requirements).find((r) => r.id === id);

async function move(id: string, to: CardStatus[]) {
  for (const s of to) await store.updateCardStatus(id, s, "fixture", "human");
}

/** Plan and finish a card for one requirement, as the planner and the Worker would leave it. */
async function build(cardId: string, reqId: string, key: string, strength = STRONG) {
  const r = await store.requirements.get(reqId);
  const criteria = r?.criteria ?? [];
  await store.createCard({
    id: cardId,
    tier: "task",
    title: `Build ${r?.title}`,
    status: "ready",
    projectId,
    acceptanceCriteria: criteria.map((c) => c.text),
    criterionIds: criteria.map((c) => c.id),
  });
  // PM-P13-2 (the planner's): the card → requirement link.
  await store.requirements.link({ requirementId: reqId, from: "card", ref: cardId });
  const t = TESTS[key] as { name: string; body: string };
  const path = `tests/${key}.spec.ts`;
  await store.stagedTests.stage({
    cardId,
    path,
    sha256: createHash("sha256").update(test(t.name, t.body)).digest("hex"),
    author: "planner",
    cases: [{ name: t.name, criterionId: criteria[0]?.id as string }],
  });
  await evidence(cardId, strength);
  await move(cardId, ["in_progress", "verify", "review", "done"]);
}

async function evidence(cardId: string, strength: object) {
  const n = (await store.cardEvents(cardId, ["evidence/recorded"])).length + 1;
  const id = `ev_${cardId}_${n}`;
  const body = `${JSON.stringify({ id, cardId, testStrength: strength }, null, 2)}\n`;
  put(`.sekhemet/evidence/${id}.json`, body);
  await recordLedgerRun(store, {
    cardId,
    modelId: "worker",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: id,
    path: `.sekhemet/evidence/${id}.json`,
    body,
  });
}

function commit(message: string, files: Record<string, string>) {
  for (const [p, t] of Object.entries(files)) put(p, t);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

function claimingModel(text: string): LocalInferenceAdapter {
  return {
    modelId: "stand-in",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 8192, maxTokens: 1200 },
    generate: async () => ({
      text,
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    }),
  };
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "p13-fixture-")));
  put("package.json", '{ "name": "recipes", "type": "module", "private": true }\n');
  put(".gitignore", ".sekhemet/*\n!.sekhemet/gates.toml\nnode_modules/\n");
  put(".sekhemet/gates.toml", GATES);
  put("src/recipes.ts", "export const recipes: string[] = [];\n");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: seed");
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
  projectId = (await store.ensureProject({ rootPath: root, name: "Recipes" })).id;
  k = { repoPath: root, cardStore: store, log, boardService: new BoardServiceImpl(store) };
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: root,
    port: 0,
    streamIntervalMs: 1000,
  });
}, 60_000);

afterAll(async () => {
  await server.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("P13 fixture: eight requirements, two slices, one revised after its slice is proven", () => {
  it("computes done from requirements and a person's acceptance, never from a claim", async () => {
    // PM-P13-1: the brief's requirements are stored on acceptance (REST).
    const accepted = await call("POST", "/api/brief/accept", { projectId, ...BRIEF });
    expect(accepted.status).toBe(200);
    expect(accepted.json.requirementIds).toHaveLength(8);
    expect(accepted.json.sliceIds).toEqual(["SLICE-1", "SLICE-2"]);
    expect(await log.getEventsByTypes(["requirement/created"])).toHaveLength(8);
    const events = await log.getEventsByTypes(["brief/accepted"]);
    expect(events[0]?.principal).toMatch(/^p_/);

    // PM-P13-3: unplanned must-haves on the story map and in Seshat's status.
    let m = await map();
    expect(m.unplanned.map((r) => r.id)).toEqual([
      "REQ-1",
      "REQ-2",
      "REQ-3",
      "REQ-4",
      "REQ-6",
      "REQ-7",
    ]);
    const pmStore = new PmStore(log);
    let snap = await buildSnapshot(root, store, pmStore, "stand-in");
    expect(ledgerStandup(snap)).toMatch(
      /0 of 6 must-haves proven\. Unplanned: REQ-1, REQ-2, REQ-3, REQ-4, REQ-6, REQ-7\./,
    );

    // Slice 1 is built: code and tests on main, cards Done with their evidence.
    commit("feat: recipes", { "src/recipes.ts": SRC });
    for (const key of ["save", "list", "view", "search"]) {
      const t = TESTS[key] as { name: string; body: string };
      commit(`test: ${key}`, { [`tests/${key}.spec.ts`]: test(t.name, t.body) });
    }
    await build("c_save", "REQ-1", "save");
    await build("c_list", "REQ-2", "list");
    await build("c_view", "REQ-3", "view");
    // PM-P13-5: its tests will pass, but their strength record does not meet the rule.
    await build("c_search", "REQ-4", "search", WEAK);

    // PM-P13-4: the gates and the linked tests run on main (a real Vitest run).
    const check = await checkMain(k, { sandbox });
    expect(check.check?.gatesPassed).toBe(true);
    expect(check.check?.tests["tests/save.spec.ts > lists a saved recipe"]).toEqual({
      result: "passed",
      strength: "met",
    });
    m = await map();
    expect(req(m, "REQ-1")?.state).toBe("proven");
    expect(req(m, "REQ-4")?.state).toBe("passing_strength_unmet");
    expect(m.slices[0]?.state).toBe("unproven");
    expect(m.slices[0]?.provenLine).toBe("3 of 4 must-haves proven");

    // PM-P13-6: a model claiming the slice complete changes nothing; the reply gives the count.
    snap = await buildSnapshot(root, store, pmStore, "stand-in");
    const reply = await answer(
      claimingModel("The walking skeleton is complete and the release is ready to ship."),
      snap,
      [],
      [
        {
          id: "m1",
          seq: 1,
          role: "user",
          text: "How are we doing?",
          createdAt: "",
          state: "queued",
        },
      ],
    );
    expect(reply.text).not.toMatch(/is complete|ready to ship/);
    expect(reply.text).toContain("Not done: 3 of 6 must-haves proven.");
    expect(reply.text).toMatch(/REQ-4 \(passing strength unmet\)/);
    expect(await log.getEventsByTypes(["slice/accepted", "release/proposed"])).toEqual([]);

    // The search tests are strengthened: a stronger record for its card.
    await evidence("c_search", STRONG);
    await checkMain(k, { sandbox, force: true });
    m = await map();
    expect(m.slices[0]?.state).toBe("proven");

    // PM-P13-7, -13, -10: a person accepts; the release is proposed with notes in the brief's words.
    const acceptedSlice = await call("POST", "/api/slices/SLICE-1/accept", {});
    expect(acceptedSlice.status).toBe(200);
    expect(acceptedSlice.json.completesProject).toBe(false);
    const [sliceAccepted] = await log.getEventsByTypes(["slice/accepted"]);
    expect(sliceAccepted).toMatchObject({ actor: "human" });
    expect(sliceAccepted?.principal).toMatch(/^p_/);
    const [release] = await store.slices.releases("SLICE-1");
    expect(release?.version).toBe("0.1.0");
    expect(release?.requirementIds).toEqual(["REQ-1", "REQ-2", "REQ-3", "REQ-4"]);
    expect(release?.notes).toMatch(
      /You can now:\n- Save a recipe\n- List saved recipes\n- Open a recipe\n- Search by name/,
    );
    expect(release?.changelog?.Added?.[0]).toMatch(/^recipes \([0-9a-f]{7}\)$/);
    // Finding 5 (B4.3): the sha proven when the release was proposed is
    // recorded (`release/proven`), separately from the kernel's own
    // `release/proposed` (its payload has no field for it).
    const slice1ProvenSha = mainHead(root).sha;
    const [proven] = await log.getEventsByTypes(["release/proven"]);
    expect(proven?.payload).toMatchObject({
      sliceId: "SLICE-1",
      version: "0.1.0",
      sha: slice1ProvenSha,
    });
    expect(acceptedSlice.json.report.text).toContain(
      "Compared with what you had before: Recipes live in a shared spreadsheet",
    );
    expect(acceptedSlice.json.report.remaining.map((r: { id: string }) => r.id)).toEqual(["REQ-5"]);
    // PM-P13-8: every card Done, slice 2 not accepted: the project is not done.
    m = await map();
    expect(m.slices[0]?.state).toBe("done");
    expect(m.projectDone).toBe(false);

    // PM-P13-11: REQ-1 is revised after its slice is proven and accepted.
    await store.createCard({
      id: "c_more",
      tier: "task",
      title: "Polish save",
      status: "ready",
      projectId,
    });
    await store.requirements.link({ requirementId: "REQ-1", from: "card", ref: "c_more" });
    put(
      ".sekhemet/rev.json",
      JSON.stringify({
        criteria: [{ id: "save.1", text: "A saved recipe is listed, newest first" }],
      }),
    );
    expect(
      await runWave2Command(
        "release",
        ["revise", "REQ-1", join(root, ".sekhemet", "rev.json")],
        k,
        io,
      ),
    ).toBe(0);
    expect((await store.getCard("c_more"))?.status).toBe("planning");
    m = await map();
    expect(req(m, "REQ-1")?.state).toBe("suspect");
    expect(m.slices[0]?.state).toBe("unproven");
    // Seshat proposes a change card for the suspect done card.
    const proposal = (await pmStore.thread())
      .flatMap((x) => x.proposals ?? [])
      .find((p) => p.kind === "create_card" && JSON.stringify(p.cards).includes("c_save"));
    expect(proposal).toBeDefined();

    // PM-P13-12: still suspect after a machine re-link; the accepted change card resolves the card link.
    await store.requirements.link({ requirementId: "REQ-1", from: "card", ref: "c_save" });
    expect(store.requirements.links("REQ-1").find((l) => l.ref === "c_save")?.suspect).toBe(true);
    const applied = await applyProposal(proposal as never, {
      cardStore: store,
      boardService: new BoardServiceImpl(store),
      pmStore,
    });
    const change = applied.cards[0]?.id as string;
    expect(store.requirements.linksFrom("card", change)[0]?.requirementId).toBe("REQ-1");
    await move(change, ["ready", "in_progress", "verify", "review", "done"]);
    expect(store.requirements.links("REQ-1").find((l) => l.ref === "c_save")?.suspect).toBe(false);
    // The test link is re-confirmed by a person (CLI), as is the held card's.
    for (const l of store.requirements.links("REQ-1").filter((x) => x.suspect)) {
      expect(await runWave2Command("release", ["confirm", "REQ-1", l.from, l.ref], k, io)).toBe(0);
    }
    await move("c_more", ["ready", "in_progress", "verify", "review", "done"]);

    // PM-P13-4: a linked test failing on main unproves the slice again.
    commit("fix: break view", {
      "tests/view.spec.ts": test("shows steps", 'expect(r.view("soup")).toBe("nope");'),
    });
    await checkMain(k, { sandbox });
    m = await map();
    expect(req(m, "REQ-3")?.state).toBe("failing");
    expect(m.slices[0]?.state).toBe("unproven");
    commit("fix: view", {
      "tests/view.spec.ts": test("shows steps", 'expect(r.view("soup")).toBe("Steps for soup");'),
    });
    await checkMain(k, { sandbox });
    expect((await map()).slices[0]?.state).toBe("done");

    // Finding 5 (B4.3): main moved (the two commits above) since SLICE-1's
    // release was proposed, and it was not re-proven at the new head, so
    // `--confirm` refuses rather than silently tag whatever main is now.
    expect(mainHead(root).sha).not.toBe(slice1ProvenSha);
    await expect(confirmSliceRelease(k, "SLICE-1")).rejects.toThrow(
      /Main has moved.*run `sekhemet release accept SLICE-1` again to re-prove it/,
    );
    expect(await log.getEventsByTypes(["release/tagged"])).toEqual([]);

    // Slice 2: favourites built and proven; accepting the last slice completes the project.
    for (const key of ["fav", "unfav"]) {
      const t = TESTS[key] as { name: string; body: string };
      commit(`feat: ${key}`, { [`tests/${key}.spec.ts`]: test(t.name, t.body) });
    }
    await build("c_fav", "REQ-6", "fav");
    await build("c_unfav", "REQ-7", "unfav");
    await checkMain(k, { sandbox });
    m = await map();
    expect(m.slices[1]?.state).toBe("proven");
    expect(m.projectDone).toBe(false);
    expect(await runWave2Command("release", ["accept", "SLICE-2"], k, io)).toBe(0);
    m = await map();
    expect(m.projectDone).toBe(true);
    expect(await store.projectRollup(projectId)).toBe("done");
    expect(out.join("\n")).toMatch(/SLICE-2 accepted; the project is done/);
    // PM-P13-13: a release per slice.
    expect((await store.slices.releases("SLICE-2"))[0]?.requirementIds).toEqual(["REQ-6", "REQ-7"]);
    // Finding 5 (B4.3): main has not moved since SLICE-2's release was
    // proposed, so `--confirm` tags the proven sha, which is main's head.
    const head = mainHead(root).sha;
    const slice2Version = (await store.slices.releases("SLICE-2"))[0]?.version;
    const tagged = await confirmSliceRelease(k, "SLICE-2");
    expect(tagged).toEqual({ tag: `v${slice2Version}`, sha: head });
    const [releaseTagged] = await log.getEventsByTypes(["release/tagged"]);
    expect(releaseTagged?.payload).toMatchObject({
      sliceId: "SLICE-2",
      tag: `v${slice2Version}`,
      sha: head,
    });
  }, 180_000);
});

describe("PM-P13-9: the queue prelude stops a slice at its appetite", () => {
  it("leaves the slice's cards unscheduled and asks the person through Seshat", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "p13-appetite-")));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    g("init", "-q", "-b", "main");
    const adb = new DatabaseSync(join(dir, "events.db"));
    initSchema(adb);
    const alog = new EventLog(adb);
    const astore = new CardStore(adb, alog);
    const pid = (await astore.ensureProject({ rootPath: dir, name: "A" })).id;
    const ak: Kernel = { repoPath: dir, cardStore: astore, log: alog };
    try {
      const sliceId = await astore.slices.create(
        { projectId: pid, title: "Skeleton", appetite: { cards: 1 } },
        "p_owner",
      );
      const r1 = await astore.requirements.create({ title: "One", sliceId }, "p_owner");
      const r2 = await astore.requirements.create(
        { title: "Two", sliceId, mustHave: false },
        "p_owner",
      );
      for (const [id, r] of [
        ["a1", r1.id],
        ["a2", r2.id],
        ["free", undefined],
      ] as const) {
        await astore.createCard({ id, tier: "task", title: id, status: "ready", projectId: pid });
        if (r) await astore.requirements.link({ requirementId: r, from: "card", ref: id });
      }
      await astore.updateCardStatus("a1", "in_progress", "t", "human");
      const ready = await astore.listCards({ status: "ready" });
      const { ordered, lines } = await queuePrelude(ak, ready, { print: () => undefined });
      expect(ordered.map((c) => c.id)).toEqual(["free"]);
      expect(lines.join("\n")).toMatch(/SLICE-1 \(Skeleton\) reached its appetite: 1 of 1 cards/);
      const asked = (await new PmStore(alog).thread()).map((x) => x.text).join("\n");
      expect(asked).toMatch(/cut REQ-2/);
      expect(asked).toMatch(/Extending is not offered: a2 has no red test yet/);
      // Finding 6 (B4.3): `POST /api/slices/:id/extend` enforces the same
      // condition the ask names, not only the offer that led to it.
      expect(await extendRefusal(ak, "SLICE-1")).toMatch(/a2 has no red test yet/);
      // Once a2 has a red test (an acceptance test named), the same condition allows it.
      await astore.updateCard("a2", { acceptanceTests: ["tests/a2.spec.ts"] }, "human");
      expect(await extendRefusal(ak, "SLICE-1")).toBeUndefined();
      // The person extends it (CLI): its cards are scheduled again, and it is asked again only at the new appetite.
      const said: string[] = [];
      expect(
        await runWave2Command("release", ["extend", "SLICE-1", "--cards", "3"], ak, {
          print: (l) => said.push(l),
        }),
      ).toBe(0);
      const again = await queuePrelude(ak, ready, { print: () => undefined });
      expect(again.ordered.map((c) => c.id).sort()).toEqual(["a2", "free"]);
      expect(again.lines.join("\n")).not.toMatch(/reached its appetite/);
    } finally {
      adb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
