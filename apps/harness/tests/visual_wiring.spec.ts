import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import {
  DEFAULT_PROJECT_CONFIG,
  type GateResult,
  type GateRunner,
  VISION_CHECKLIST_VERSION,
  gateCopy,
  parseVisualConfig,
} from "@sekhemet/gates";
import { CardStore } from "@sekhemet/kernel";
import { verifyCardTree } from "@sekhemet/loop";
import type { InferenceRequest, LocalInferenceAdapter, ModelEntry } from "@sekhemet/models";
import { findChrome } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visionForCard } from "../src/execute.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { cardVision, inferenceVisionAdapter, parseChecklistAnswers } from "../src/vision_check.js";
import { BASELINE_APPROVED } from "../src/visual_baseline.js";

// NEW-gates-4 wired into the product: the card's declared DOM assertions and
// overlaps reach the visual layer (GT-N4-4, GT-N4-6); the vision checklist
// runs only on a vision model the registry records as qualified, and no
// qualified model means no check, said in the evidence (GT-N4-2); a person
// approves a candidate baseline from the command line or the dashboard, on
// the ledger with their principal (GT-N4-1). Real git, SQLite, headless
// Chromium and the built CLI; a fake vision model, never a loaded one.

const BIN = resolve(import.meta.dirname, "../dist/index.js");

const qualified = {
  checklistVersion: VISION_CHECKLIST_VERSION,
  approvedScreens: 60,
  wrongFails: 0,
  defectScreens: 30,
  falsePasses: 10,
};

/** A fake vision model: answers from `reply`, recording each request. */
function fakeVisionModel(reply: string, seen: InferenceRequest[] = []): LocalInferenceAdapter {
  return {
    modelId: "vision-a",
    supportedArms: ["arm_a_flat"],
    generate: async (req) => {
      seen.push(req);
      return { text: reply, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    },
  };
}

describe("the vision checklist's model (GT-N4-2)", () => {
  it("reads one yes or no per numbered question, and nothing from an unreadable reply", () => {
    expect(parseChecklistAnswers("1. yes\n2) No\n3: yes", 3)).toEqual(["yes", "no", "yes"]);
    expect(parseChecklistAnswers("1. yes\n3. no", 3)).toEqual(["yes"]);
    expect(parseChecklistAnswers("It looks fine.", 2)).toEqual([]);
  });

  it("asks at temperature 0 with the screenshot and the fixed questions, loading the model on the first question", async () => {
    const seen: InferenceRequest[] = [];
    let loads = 0;
    const adapter = inferenceVisionAdapter("vision-a", async () => {
      loads++;
      return fakeVisionModel("1. yes\n2. yes\n3. no\n4. yes\n5. yes", seen);
    });
    expect(loads).toBe(0);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const answers = await adapter.answer(png, gateCopy.visionChecklist, { temperature: 0 });
    expect(answers).toEqual(["yes", "yes", "no", "yes", "yes"]);
    expect(loads).toBe(1);
    expect(seen[0]?.temperature).toBe(0);
    expect(seen[0]?.images?.[0]).toMatchObject({ mime: "image/png", data: png.toString("base64") });
    for (const q of gateCopy.visionChecklist) expect(seen[0]?.prompt).toContain(q);
  });

  it("gives the checklist only to a vision model the registry records as qualified, and says why otherwise", () => {
    const load = async () => fakeVisionModel("");
    expect(cardVision([], load)).toEqual({
      visionNotRun: `no vision model in the registry is verified on this machine on checklist ${VISION_CHECKLIST_VERSION}`,
    });
    const unmeasured: ModelEntry = { id: "vision-u", vision: true };
    const short: ModelEntry = {
      id: "vision-s",
      vision: true,
      visionQualification: { ...qualified, approvedScreens: 12 },
    };
    const none = cardVision([unmeasured, short], load);
    expect(none.vision).toBeUndefined();
    expect(none.visionNotRun).toContain("vision-u: no measurement recorded for vision-u");
    expect(none.visionNotRun).toContain("vision-s: 12 approved screens, 60 needed");
    const good: ModelEntry = { id: "vision-q", vision: true, visionQualification: qualified };
    const chosen = cardVision([unmeasured, good], load);
    expect(chosen.vision?.adapter.model).toBe("vision-q");
    expect(chosen.vision?.qualification).toMatchObject({ model: "vision-q", approvedScreens: 60 });
    expect(cardVision([good], undefined).visionNotRun).toMatch(
      /vision-q is verified on this machine, but/,
    );
  });

  it("executeCard's choice reads the model registry on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-registry-"));
    const path = join(dir, "models.json");
    const before = process.env.SEKHEMET_MODEL_REGISTRY;
    process.env.SEKHEMET_MODEL_REGISTRY = path;
    try {
      const ctx = { loadVisionModel: async () => fakeVisionModel("") } as Parameters<
        typeof visionForCard
      >[0];
      writeFileSync(path, JSON.stringify({ models: [{ id: "vision-u", vision: true }] }));
      expect(visionForCard(ctx).visionNotRun).toMatch(
        /no vision model is verified on this machine/,
      );
      writeFileSync(
        path,
        JSON.stringify({
          models: [{ id: "vision-q", vision: true, visionQualification: qualified }],
        }),
      );
      expect(visionForCard(ctx).vision?.adapter.model).toBe("vision-q");
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_MODEL_REGISTRY");
      else process.env.SEKHEMET_MODEL_REGISTRY = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(findChrome() !== undefined)("the visual layer in a card's verification", () => {
  let server: Server;
  let port: number;
  let repo: string;
  let home: string;
  let html = "";
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });

  beforeEach(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "visual-wiring-")));
    home = mkdtempSync(join(tmpdir(), "visual-wiring-home-"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(html);
    });
    port = await new Promise((r) =>
      server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)),
    );
  });
  afterEach(async () => {
    await new Promise((r) => server.close(() => r(undefined)));
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const page = (body: string) =>
    `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;background:#fff">${body}</body></html>`;
  const passing: GateRunner = {
    runGates: async (): Promise<GateResult> => ({
      passed: true,
      failures: [],
      durationMs: 1,
      rungResults: [],
    }),
  };
  const verify = (
    over: Partial<Parameters<typeof verifyCardTree>[0]> = {},
    visual: Record<string, unknown> = {},
  ) =>
    verifyCardTree({
      root: repo,
      base: "main",
      rungs: ["test"],
      runner: passing,
      staged: [],
      packageGates: false,
      builtin: {
        project: {
          ...DEFAULT_PROJECT_CONFIG,
          builtin: [],
          visual: parseVisualConfig({
            url: `http://127.0.0.1:${port}/`,
            viewports: [1280],
            a11y: false,
            ...visual,
          }) as NonNullable<ReturnType<typeof parseVisualConfig>>,
        },
        stateDir: join(repo, ".sekhemet"),
      },
      ...over,
    });

  it("GT-N4-6, GT-N4-4: checks the card's own DOM assertions and allows the overlaps it declares", async () => {
    html = page(
      `<h1 id="title" style="position:absolute;left:10px;top:10px;width:200px;height:40px">Backlog</h1>
       <span id="badge" style="position:absolute;left:180px;top:20px;width:60px;height:20px;background:#a00">3</span>`,
    );
    const undeclared = await verify({ card: { id: "card_v" } });
    expect(undeclared.allFailures.map((f) => f.gate)).toEqual(["visual-layout"]);
    const declared = await verify({
      card: {
        id: "card_v",
        gateChecks: {
          visualAssertions: [{ selector: "#title", text: "Board" }],
          allowOverlap: [["#badge", "#title"]],
        },
      },
    });
    expect(declared.allFailures.map((f) => f.errorExcerpt)).toEqual([
      '#title @1280px: text "Backlog", expected "Board"',
    ]);
  }, 60_000);

  it("GT-N4-2: a qualified vision model fails a card on a no; with none qualified the evidence says no check ran", async () => {
    html = page(`<h1 id="title">Board</h1>`);
    const good: ModelEntry = { id: "vision-q", vision: true, visionQualification: qualified };
    const seen: InferenceRequest[] = [];
    const vision = cardVision([good], async () =>
      fakeVisionModel("1. yes\n2. yes\n3. yes\n4. no\n5. yes", seen),
    );
    const failed = await verify({ card: { id: "card_v" }, vision });
    expect(seen).toHaveLength(1);
    expect(failed.allFailures.map((f) => f.gate)).toEqual(["visual-vision"]);
    expect(failed.allFailures[0]?.errorExcerpt).toContain(gateCopy.visionChecklist[3]);

    const none = await verify({ card: { id: "card_v" }, vision: cardVision([], undefined) });
    expect(none.allFailures).toEqual([]);
    expect(none.advisories).toContain(
      `vision checklist not run: no vision model in the registry is verified on this machine on checklist ${VISION_CHECKLIST_VERSION}`,
    );
  }, 60_000);

  it("GT-N4-1: a person approves the candidate from the dashboard or the command line, recorded with their principal", async () => {
    html = page(`<div id="box" style="width:30px;height:30px;background:#000"></div>`);
    const snap = { snapshot: [{ name: "box", selector: "#box" }] };
    const first = await verify({ card: { id: "card_v" } }, snap);
    expect(first.allFailures.map((f) => f.gate)).toEqual(["visual-snapshot"]);
    const candidates = join(repo, ".sekhemet", "visual", "candidates", "card_v");
    expect(existsSync(join(candidates, "box-1280.png"))).toBe(true);

    // The dashboard: a person's POST, their principal on the ledger.
    const { db, log } = openLocalLedger(repo);
    const cardStore = new CardStore(db, log);
    await cardStore.createCard({ id: "card_v", tier: "task", title: "Box", status: "ready" });
    const dash = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 60_000,
      setup: "solo",
    });
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${dash.port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
        body: JSON.stringify(body),
      });
    try {
      const listed = (await (
        await fetch(`http://127.0.0.1:${dash.port}/api/visual/candidates`)
      ).json()) as { candidates: { key: string; cardId?: string; sha256: string }[] };
      expect(listed.candidates).toMatchObject([{ key: "box-1280", cardId: "card_v" }]);
      const sha256 = listed.candidates[0]?.sha256 ?? "";
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      const nothing = await post("/api/visual/baselines/nothing-1280/approve", {
        cardId: "card_v",
        sha256,
      });
      expect(nothing.status).toBe(404);
      // No hash, a hash other than the one shown, or a card the ledger does not know: refused.
      expect(
        (await post("/api/visual/baselines/box-1280/approve", { cardId: "card_v" })).status,
      ).toBe(400);
      expect(
        (
          await post("/api/visual/baselines/box-1280/approve", {
            cardId: "card_v",
            sha256: "0".repeat(64),
          })
        ).status,
      ).toBe(409);
      expect(
        (await post("/api/visual/baselines/box-1280/approve", { cardId: "card_x", sha256 })).status,
      ).toBe(404);
      const ok = await post("/api/visual/baselines/box-1280/approve", { cardId: "card_v", sha256 });
      expect(ok.status).toBe(200);
      const approvals = await log.getEventsByTypes([BASELINE_APPROVED]);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.payload).toMatchObject({
        key: "box-1280",
        sha256,
        principal: log.localPrincipal(),
        cardId: "card_v",
      });
    } finally {
      await dash.close();
      db.close();
    }
    const again = await verify({ card: { id: "card_v" } }, snap);
    expect(again.allFailures).toEqual([]);

    // The command line: the next changed screen, approved by the person at it.
    html = page(`<div id="box" style="width:30px;height:30px;background:#c00"></div>`);
    const changed = await verify({ card: { id: "card_v" } }, snap);
    expect(changed.allFailures.map((f) => f.gate)).toEqual(["visual-snapshot"]);
    const cliEnv = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
      SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
      BROWSER: "false",
    };
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [BIN, "gates", "approve-baseline", ...args], {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
        env: cliEnv,
      });
    const list = cli();
    expect(list.status, list.stderr).toBe(0);
    const shown = /box-1280 --card card_v --sha256 ([0-9a-f]{64})/.exec(list.stdout)?.[1];
    expect(shown, list.stdout).toBeDefined();
    const unbound = cli("box-1280", "--card", "card_v");
    expect(unbound.status).toBe(1);
    expect(unbound.stderr).toContain("SHA-256");
    const approved = cli("box-1280", "--card", "card_v", "--sha256", shown ?? "");
    expect(approved.status, approved.stderr).toBe(0);
    expect(approved.stdout).toContain("Approved box-1280 as the baseline");
    const ledger = openLocalLedger(repo);
    try {
      const all = await ledger.log.getEventsByTypes([BASELINE_APPROVED]);
      expect(all).toHaveLength(2);
      expect(all[1]?.payload).toMatchObject({
        key: "box-1280",
        sha256: shown,
        cardId: "card_v",
        principal: ledger.log.localPrincipal(),
      });
    } finally {
      ledger.db.close();
    }
    expect((await verify({ card: { id: "card_v" } }, snap)).allFailures).toEqual([]);
  }, 120_000);
});
