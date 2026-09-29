import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, DEFAULT_STEP_BUDGET, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordReviewOpened } from "../src/accept.js";
import {
  acceptCard,
  executeCard,
  explainCard,
  forkCard,
  pullThroughPlanning,
  requestAbort,
  rewindCard,
  rollupParent,
} from "../src/execute.js";
import { ledgerEvidenceSummary } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

function scripted(turn: (n: number) => Omit<ToolCall, "id">[]) {
  const seen: InferenceRequest[] = [];
  let n = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "scripted",
    supportedArms: ["arm_a_flat"],
    generate: async (req) => {
      seen.push(req);
      n++;
      return {
        text: "",
        toolCalls: turn(n).map((c, i) => ({ id: `t${n}-${i}`, ...c })),
        usage: { promptTokens: 10, completionTokens: 2, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}
const write = (n: number): Omit<ToolCall, "id"> => ({
  name: "write_file",
  arguments: { path: "src/a.ts", content: `export const a = ${n};\n` },
});

describe("apps/harness planning, rollup, explain and runner control (B2, B7, B12, K25, L21, L25, H17-H19)", () => {
  let repo: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let boardService: BoardServiceImpl;
  let ctx: Parameters<typeof executeCard>[0];

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-control-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.ts"), "");
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    // The production board: entry conditions on, Review reading evidence.
    boardService = new BoardServiceImpl(cardStore, {
      entryConditions: true,
      // As production resolves it: from the ledger (K-S7-7).
      evidenceFor: (id) => ledgerEvidenceSummary(cardStore, repo, id),
    });
    ctx = {
      repoPath: repo,
      restrictedMode: false,
      cardStore,
      boardService,
      log: () => {},
      // The host's swap moves with whatever else runs; the watchdog tests cover memory.
      headroomCheck: false,
    };
  });
  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const newCard = (id: string, over: Record<string, unknown> = {}) =>
    cardStore.createCard({
      id,
      tier: "story",
      title: `Write a (SPIDR: Path) ${id}`,
      scopeFiles: ["src/a.ts"],
      acceptanceCriteria: ["exports a"],
      spec: "Write src/a.ts",
      ...over,
    });

  it("pulls a Ready card through Planning, scores it and sets its budget (B2, K25, L21)", async () => {
    const card = await newCard("card_plan");
    const planned = await pullThroughPlanning(ctx, card, "m");
    expect(planned.status).toBe("planning");
    const stored = await cardStore.getCard(card.id);
    expect(stored?.difficulty).toBeGreaterThanOrEqual(1);
    // Nothing measured and the schema default: set from the difficulty.
    expect(stored?.stepBudget).not.toBe(DEFAULT_STEP_BUDGET);
    const [set] = await cardStore.cardEvents(card.id, ["card/budget_set"]);
    // WL-T3-11: the one default step budget (was 50 on the card record).
    expect((set?.payload as { from: number }).from).toBe(DEFAULT_STEP_BUDGET);

    // With measured history of this class, the budget moves toward it by at most 15%.
    for (let i = 0; i < 3; i++) {
      await cardStore.runs.recordCompetence({
        repoId: "r",
        cardClass: "implement:ts",
        filesTouchedCount: 1,
        difficulty: "S",
        modelId: "m",
        toolArm: "arm_a_flat",
        stepBudget: 40,
        stepsUsed: 4,
        stopReason: "gate_passed",
        passed: true,
        tokensUsed: 1,
        wallClockSeconds: 1,
      });
    }
    const next = await newCard("card_plan2", { stepBudget: 40 });
    await pullThroughPlanning(ctx, next, "m");
    expect((await cardStore.getCard("card_plan2"))?.stepBudget).toBe(34);

    // And a full run moves on from Planning through the entry conditions to Review.
    const run = await newCard("card_run");
    const result = await executeCard(
      ctx,
      run,
      scripted(() => [write(1), { name: "finish_card", arguments: {} }]).adapter,
    );
    expect(result.passed).toBe(true);
    expect((await cardStore.getCard("card_run"))?.status).toBe("review");
    const statuses = (await cardStore.cardEvents("card_run", ["card/status_changed"])).map(
      (e) => (e.payload as { toStatus: string }).toStatus,
    );
    expect(statuses).toEqual(["planning", "in_progress", "verify", "review"]);
  });

  it("keeps an explicit step budget equal to the default through Planning; only a defaulted one is set from the difficulty (WL-T3-11)", async () => {
    // Suite cards set 40 explicitly (fixtures/*/cards.json, seed_chronicle):
    // the value alone must not read as "defaulted".
    const explicit = await newCard("card_explicit", { stepBudget: DEFAULT_STEP_BUDGET });
    await pullThroughPlanning(ctx, explicit, "m");
    expect((await cardStore.getCard("card_explicit"))?.stepBudget).toBe(DEFAULT_STEP_BUDGET);
    expect(await cardStore.cardEvents("card_explicit", ["card/budget_set"])).toHaveLength(0);

    const defaulted = await newCard("card_defaulted");
    expect(defaulted.stepBudget).toBe(DEFAULT_STEP_BUDGET);
    await pullThroughPlanning(ctx, defaulted, "m");
    const stored = await cardStore.getCard("card_defaulted");
    expect(stored?.stepBudget).not.toBe(DEFAULT_STEP_BUDGET);
    expect(await cardStore.cardEvents("card_defaulted", ["card/budget_set"])).toHaveLength(1);

    // The queue caps its copy of the card (--max-turns, a tune policy) before
    // Planning: the stored budget, not the capped copy, says it was defaulted.
    const capped = await newCard("card_capped");
    const run = await pullThroughPlanning(ctx, { ...capped, stepBudget: 12 }, "m");
    expect((await cardStore.getCard("card_capped"))?.stepBudget).not.toBe(DEFAULT_STEP_BUDGET);
    // ... and the cap still holds for this run.
    expect(run.stepBudget).toBeLessThanOrEqual(12);
    expect(await cardStore.cardEvents("card_capped", ["card/budget_set"])).toHaveLength(1);
  });

  it("rolls a parent up through its integration gate when the last child is accepted (B7)", async () => {
    await cardStore.createCard({
      id: "epic_p",
      tier: "epic",
      title: "Parent",
      status: "in_progress",
    });
    const child = await newCard("card_child", { parentId: "epic_p" });
    await executeCard(
      ctx,
      child,
      scripted(() => [write(2), { name: "finish_card", arguments: {} }]).adapter,
    );
    expect((await rollupParent(ctx, "epic_p")).status).toBe("not_ready");
    const reviewed = await cardStore.getCard("card_child");
    // review-git §2.4.3: the person looks at the Implementation files first.
    await recordReviewOpened(ctx, reviewed as NonNullable<typeof reviewed>, ["src/a.ts"]);
    await acceptCard(ctx, reviewed as NonNullable<typeof reviewed>);
    // Kernel rule 12 (K-N1-5): the merge commit anchors the ledger head.
    const body = execFileSync("git", ["log", "-1", "--format=%B", "main"], {
      cwd: repo,
    }).toString();
    const [, seq, hash] = body.match(/^Ledger-Head: (\d+):([0-9a-f]{64})$/m) ?? [];
    expect((await log.getEvents(Number(seq), 1))[0]?.hash).toBe(hash);
    expect((await cardStore.getCard("epic_p"))?.status).toBe("done");
    const [rollup] = await cardStore.cardEvents("epic_p", ["card/rollup"]);
    expect(rollup?.payload).toMatchObject({ passed: true, children: ["card_child"] });
  });

  it("explains a card in plain sentences (B12)", async () => {
    await newCard("card_dep");
    await newCard("card_x", { dependsOn: ["card_dep"] });
    const lines = await explainCard(ctx, "card_x");
    expect(lines[0]).toBe("card_x is in ready.");
    expect(lines.join(" ")).toContain("waits on card_dep");
    expect(lines.at(-1)).toBe("Next: Finish card_dep first.");
  });

  it("stops a running card when an abort is requested from elsewhere (L25)", async () => {
    const card = await newCard("card_stop");
    const { adapter, seen } = scripted((n) => {
      if (n === 2) void requestAbort(cardStore, card.id, "wrong approach");
      // A different slice each turn: two identical reads are a stall (L13),
      // and the stall would end the card before the abort arrived.
      return [{ name: "read_file", arguments: { path: "src/a.ts", start: 1, end: 1 + n } }];
    });
    const result = await executeCard(ctx, card, adapter);
    expect(result.stopReason).toBe("human_abort");
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it("TEAM-16: stops a running card between steps once its person may no longer start the Agent", async () => {
    const card = await newCard("card_level");
    let lowered = false;
    const { adapter, seen } = scripted((n) => {
      if (n === 2) lowered = true;
      return [{ name: "read_file", arguments: { path: "src/a.ts", start: 1, end: 1 + n } }];
    });
    const said: string[] = [];
    const result = await executeCard(
      {
        ...ctx,
        log: (line) => said.push(line),
        agentRefusal: async (id) =>
          id === card.id && lowered
            ? "You're a Viewer on Chronicle. A Member can start the Agent on this issue."
            : undefined,
      },
      card,
      adapter,
    );
    expect(result.passed).toBe(false);
    expect(result.stopReason).toBe("human_abort");
    expect(seen.length).toBeLessThanOrEqual(3);
    expect(said.some((l) => /stopped: You're a Viewer on Chronicle/.test(l))).toBe(true);
  });

  it("rewinds to a step, keeps the abandoned state, and the next run resumes from there with history replayed (H19, H17)", async () => {
    const card = await newCard("card_rw", { stepBudget: 3 });
    // Three writes, a checkpoint after each; the budget ends the card (and the
    // written scope is verified once).
    const first = await executeCard(ctx, card, scripted((n) => [write(n)]).adapter);
    expect(first.turns).toHaveLength(3);
    const wt = first.worktreePath;
    expect(readFileSync(join(wt, "src", "a.ts"), "utf8")).toBe("export const a = 3;\n");

    const r = await rewindCard(ctx, card.id, 1);
    expect(r.step).toBe(1);
    expect(readFileSync(join(wt, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(
      execFileSync("git", ["show", `${r.preservedRef}:src/a.ts`], { cwd: wt, encoding: "utf8" }),
    ).toBe("export const a = 3;\n");
    expect((await cardStore.getCard(card.id))?.status).toBe("ready");

    const { adapter, seen } = scripted(() => [{ name: "finish_card", arguments: {} }]);
    const resumed = await executeCard(ctx, (await cardStore.getCard(card.id)) as never, adapter);
    expect(resumed.resumedFrom?.step).toBe(1);
    expect(resumed.turns[0]?.turnIndex).toBe(2);
    // Step 1 was replayed from the log into the Worker's history.
    expect(seen[0]?.prompt).toContain("write_file(src/a.ts)");
  });

  it("forks an attempt at a step into a new attempt (H18)", async () => {
    const card = await newCard("card_fk", { stepBudget: 2 });
    const first = await executeCard(ctx, card, scripted((n) => [write(n)]).adapter);
    const [attempt] = cardStore.runs.listAttempts(card.id);
    await forkCard(ctx, card.id, 1, attempt?.id);
    const second = await executeCard(
      ctx,
      (await cardStore.getCard(card.id)) as never,
      scripted(() => [{ name: "finish_card", arguments: {} }]).adapter,
    );
    expect(second.resumedFrom?.step).toBe(1);
    const attempts = cardStore.runs.listAttempts(card.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.forkedFrom).toEqual({ attemptId: attempt?.id, step: 1 });
    expect(first.worktreePath).toBe(second.worktreePath);
  });

  it("sends a revision that breaks a gate its Review snapshot passed back to Planning (G23)", async () => {
    // The unit gate fails when src/a.ts contains BROKEN.
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(require('fs').readFileSync('src/a.ts','utf8').includes('BROKEN') ? 1 : 0)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    execFileSync("git", ["commit", "-qam", "gate"], { cwd: repo });
    const card = await newCard("card_reg", { stepBudget: 2 });
    const first = await executeCard(
      ctx,
      card,
      scripted(() => [write(1), { name: "finish_card", arguments: {} }]).adapter,
    );
    expect(first.passed).toBe(true);
    // A person sends it back; the revision breaks the gate.
    await boardService.transitionCard({
      cardId: card.id,
      fromStatus: "review",
      toStatus: "ready",
      actor: "human",
      reason: "returned: rename a",
    });
    const again = await executeCard(
      ctx,
      (await cardStore.getCard(card.id)) as never,
      scripted(() => [
        {
          name: "write_file",
          arguments: { path: "src/a.ts", content: "export const a = 'BROKEN';\n" },
        },
        { name: "finish_card", arguments: {} },
      ]).adapter,
    );
    expect(again.passed).toBe(false);
    expect(again.finalStatus).toBe("planning");
    const stored = await cardStore.getCard(card.id);
    expect(stored?.status).toBe("planning");
    // K-N5-4: the move into Planning records the regression as its reason.
    const [intoPlanning] = (await cardStore.cardEvents(card.id, ["card/status_changed"]))
      .filter((e) => (e.payload as { toStatus?: string }).toStatus === "planning")
      .slice(-1);
    expect((intoPlanning?.payload as { reason?: string }).reason).toMatch(
      /^regression: unit passed at Review \(ev_[0-9a-f]+\) and fails now/,
    );
    expect(stored?.blockedReason).toMatch(
      /^regression: unit passed at Review \(ev_[0-9a-f]+\) and fails now/,
    );
  });

  it("serves the human commands over the dashboard (B8, B11, B12, H19, L25)", async () => {
    const server = await startDashboardServer({
      db,
      log,
      boardService,
      cardStore,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 60_000,
    });
    const post = async (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await pageWriteHeaders(`http://127.0.0.1:${server.port}`)),
        },
        body: JSON.stringify(body),
      });
    try {
      const project = await cardStore.ensureProject({ rootPath: repo, name: "r" });
      await newCard("card_1");
      await newCard("card_2");
      await newCard("card_3", { scopeFiles: [] });

      // B11: drag card_2 above card_1.
      expect((await post("/api/cards/card_2/reorder", { beforeCardId: "card_1" })).status).toBe(
        200,
      );
      expect((await cardStore.listCards()).map((c) => c.id).slice(0, 2)).toEqual([
        "card_2",
        "card_1",
      ]);

      // B12: reroute, override, abort, pause project, review hours.
      await post("/api/cards/card_1/reroute", { executor: "escalation" });
      expect((await cardStore.getCard("card_1"))?.modelRoute?.executor).toBe("escalation");
      const refused = await post("/api/cards/card_3/override", {
        toStatus: "in_progress",
        reason: "",
      });
      expect(refused.status).toBe(400);
      // K-S7-5: a toStatus outside the nine states is refused, appending nothing.
      const before = (await log.getEvents(1, 1_000_000)).length;
      const unknown = await post("/api/cards/card_3/override", {
        toStatus: "shipped",
        reason: "spike without scope",
        principal: "p_owner",
      });
      expect(unknown.status).toBe(400);
      expect((await log.getEvents(1, 1_000_000)).length).toBe(before);
      const forced = await post("/api/cards/card_3/override", {
        toStatus: "in_progress",
        reason: "spike without scope",
        principal: "p_owner",
      });
      expect(forced.status).toBe(200);
      expect(await cardStore.cardEvents("card_3", ["card/override"])).toHaveLength(1);
      expect((await post("/api/cards/card_1/abort", { reason: "stop" })).status).toBe(200);
      expect(await cardStore.cardEvents("card_1", ["card/abort_requested"])).toHaveLength(1);
      const paused = await (await post(`/api/projects/${project.id}`, { status: "paused" })).json();
      expect(paused.project.status).toBe("paused");
      // K-N5-3: the projects route reports the derived rollup; a person's pause wins.
      const listed = await (await fetch(`http://127.0.0.1:${server.port}/api/projects`)).json();
      expect(listed.projects.find((p: { id: string }) => p.id === project.id)?.rollup).toBe(
        "paused",
      );
      // `done` is never a status write (K-N5-5).
      expect((await post(`/api/projects/${project.id}`, { status: "done" })).status).not.toBe(200);
      const hours = await (
        await post(`/api/projects/${project.id}`, { reviewMinutesPerDay: 90 })
      ).json();
      expect(hours.project.reviewMinutesPerDay).toBe(90);

      const explain = await (
        await fetch(`http://127.0.0.1:${server.port}/api/cards/card_1/explain`)
      ).json();
      expect(explain.lines[0]).toBe("card_1 is in ready.");
      const board = await (
        await fetch(`http://127.0.0.1:${server.port}/api/board?project=${project.id}`)
      ).json();
      expect(board.cards.length).toBe(3);
      const bad = await post("/api/cards/card_1/rewind", { step: 1 });
      expect(bad.status).toBe(409);
      expect(existsSync(join(repo, ".sekhemet"))).toBe(true);
    } finally {
      await server.close();
    }
  });
});
