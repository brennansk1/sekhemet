import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuiltinGates } from "../src/builtin.js";
import { compileEvidence } from "../src/evidence.js";
import {
  VISION_CHECKLIST_VERSION,
  VISUAL_GATE_IDS,
  type VisionAdapter,
  approveVisualBaseline,
  decodePng,
  encodePng,
  exactUpperBound,
  listVisualCandidates,
  parseVisualConfig,
  pixelDiffRatio,
  runVisualGates,
  visionMayBlock,
} from "../src/visual.js";

// NEW-gates-4: the visual layer to its design (gates rules 29-31, GT-N4-1..6),
// in a real headless Chromium (the cached build playwright-core pins), with a
// fake vision adapter: no model is loaded.

describe("the vision checklist's qualification (rule 30, GT-N4-2)", () => {
  it("computes the exact one-sided 95% upper bound the rule quotes", () => {
    // 60 approved screens allow no wrong fail; one is allowed from 93.
    expect(exactUpperBound(0, 60)).toBeLessThanOrEqual(0.05);
    expect(exactUpperBound(1, 60)).toBeGreaterThan(0.05);
    expect(exactUpperBound(1, 93)).toBeLessThanOrEqual(0.05);
    expect(exactUpperBound(1, 92)).toBeGreaterThan(0.05);
    expect(exactUpperBound(0, 1)).toBeCloseTo(0.95, 5);
  });

  it("blocks only for the recorded model and checklist, on enough screens, within both rates", () => {
    const good = {
      model: "vision-a",
      checklistVersion: VISION_CHECKLIST_VERSION,
      approvedScreens: 60,
      wrongFails: 0,
      defectScreens: 30,
      falsePasses: 15,
    };
    expect(visionMayBlock(good, "vision-a").blocking).toBe(true);
    expect(visionMayBlock(good, "vision-b").blocking).toBe(false);
    expect(visionMayBlock({ ...good, checklistVersion: "0" }, "vision-a").blocking).toBe(false);
    expect(visionMayBlock({ ...good, approvedScreens: 59 }, "vision-a").blocking).toBe(false);
    expect(visionMayBlock({ ...good, wrongFails: 1 }, "vision-a").reason).toMatch(/wrong-fail/);
    expect(visionMayBlock({ ...good, defectScreens: 29 }, "vision-a").blocking).toBe(false);
    expect(visionMayBlock({ ...good, falsePasses: 16 }, "vision-a").reason).toMatch(/false-pass/);
    expect(visionMayBlock(undefined, "vision-a").blocking).toBe(false);
  });
});

describe("visual configuration (GT-N4-1, GT-N4-4, GT-N4-5, GT-N4-6)", () => {
  it("requires a person for baselines unless the project says auto, and reads masks, overlaps and DOM assertions", () => {
    const c = parseVisualConfig({
      url: "http://localhost:{port}/",
      mask: [".clock"],
      allow_overlap: [["#badge", "#title"]],
      snapshot: [{ name: "header", selector: "header", mask: [".avatar"] }],
      assert: [
        { selector: "#title", text: "Board" },
        { selector: "#gone", present: false },
        { selector: "a.help", attribute: "href", value: "/help" },
      ],
    });
    expect(c?.baselineApproval).toBe("human");
    expect(c).toMatchObject({
      mask: [".clock"],
      overlap: true,
      allowOverlap: [["#badge", "#title"]],
      snapshots: [{ name: "header", selector: "header", mask: [".avatar"] }],
      assertions: [
        { selector: "#title", text: "Board" },
        { selector: "#gone", present: false },
        { selector: "a.help", attribute: "href", value: "/help" },
      ],
    });
    expect(parseVisualConfig({ url: "x", baseline_approval: "auto" })?.baselineApproval).toBe(
      "auto",
    );
    expect(parseVisualConfig({ url: "x", overlap: false })?.overlap).toBe(false);
    expect(VISUAL_GATE_IDS).toEqual(expect.arrayContaining(["visual-dom", "visual-vision"]));
  });

  it("encodes a PNG the decoder reads back exactly", () => {
    const data = Buffer.alloc(3 * 2 * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
    const img = { width: 3, height: 2, data };
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(3);
    expect(back.height).toBe(2);
    expect([...back.data]).toEqual([...data]);
  });
});

describe.runIf(findChrome() !== undefined)("the visual layer in headless Chromium", () => {
  let server: Server;
  let port: number;
  let state: string;
  let html = "";
  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "visual-design-"));
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
    rmSync(state, { recursive: true, force: true });
  });

  const page = (body: string, head = "") =>
    `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body style="margin:0;background:#fff">${body}</body></html>`;
  const config = (over: Record<string, unknown> = {}) =>
    parseVisualConfig({
      url: `http://127.0.0.1:${port}/`,
      viewports: [1280],
      a11y: false,
      ...over,
    }) as NonNullable<ReturnType<typeof parseVisualConfig>>;

  it("GT-N4-4: fails two visible elements whose boxes intersect, naming both, unless the overlap is declared", async () => {
    html = page(
      `<div id="title" style="position:absolute;left:10px;top:10px;width:200px;height:40px;background:#123;color:#fff">Title</div>
       <div id="badge" style="position:absolute;left:180px;top:20px;width:60px;height:20px;background:#a00;color:#fff">3</div>
       <div id="apart" style="position:absolute;left:10px;top:200px;width:50px;height:50px;background:#0a0"></div>`,
    );
    const r = await runVisualGates({ root: state, config: config(), stateDir: state });
    const overlaps = r.failures.filter((f) => f.gate === "visual-layout");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.errorExcerpt).toMatch(/#(title|badge) overlaps #(badge|title) @1280px/);
    expect(overlaps[0]?.errorExcerpt).not.toContain("#apart");

    const declared = await runVisualGates({
      root: state,
      config: config({ allow_overlap: [["#badge", "#title"]] }),
      stateDir: state,
    });
    expect(declared.failures).toEqual([]);
    const byCard = await runVisualGates({
      root: state,
      config: config(),
      stateDir: state,
      allowOverlap: [["#title", "#badge"]],
    });
    expect(byCard.failures).toEqual([]);
  }, 60_000);

  it("GT-N4-5: with animations off and dynamic regions masked, two runs on an unchanged page differ by 0 pixels", async () => {
    html = page(
      `<div id="box" style="width:240px;height:80px;background:#eee;position:relative">
         <span class="clock" style="font:20px monospace"></span>
         <div class="spin" style="position:absolute;left:150px;top:10px;width:40px;height:40px;background:#036;animation:spin 0.9s linear infinite"></div>
         <div class="fade" style="position:absolute;left:200px;top:10px;width:30px;height:30px;background:#c00;transition:opacity 5s;opacity:1"></div>
       </div>
       <script>
         document.querySelector(".clock").textContent = String(Date.now()) + Math.random();
         requestAnimationFrame(() => { document.querySelector(".fade").style.opacity = "0.1"; });
       </script>`,
      "<style>@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }</style>",
    );
    const cfg = config({
      baseline_approval: "auto",
      snapshot: [{ name: "box", selector: "#box", mask: [".clock"] }],
      threshold: 0,
    });
    const first = await runVisualGates({ root: state, config: cfg, stateDir: state });
    expect(first.failures).toEqual([]);
    const shot1 = first.artifacts.find((a) => a.kind === "screenshot")?.ref as string;
    const bytes1 = readFileSync(shot1);
    const second = await runVisualGates({ root: state, config: cfg, stateDir: state });
    expect(second.failures).toEqual([]);
    const shot2 = second.artifacts.find((a) => a.kind === "screenshot")?.ref as string;
    expect(pixelDiffRatio(decodePng(bytes1), decodePng(readFileSync(shot2)), 0)).toBe(0);

    // The same page without the mask: the clock alone changes pixels between runs.
    const unmasked = config({
      baseline_approval: "auto",
      snapshot: [{ name: "raw", selector: "#box" }],
      threshold: 0,
    });
    await runVisualGates({ root: state, config: unmasked, stateDir: state });
    const again = await runVisualGates({ root: state, config: unmasked, stateDir: state });
    expect(again.failures.map((f) => f.gate)).toEqual(["visual-snapshot"]);
  }, 90_000);

  it("GT-N4-6: checks declared DOM assertions and fails naming the selector and the actual value", async () => {
    html = page(
      `<h1 id="title">Backlog</h1><a class="help" href="/faq">help</a><div id="gone">still here</div>`,
    );
    const r = await runVisualGates({
      root: state,
      config: config({
        assert: [
          { selector: "#title", text: "Board" },
          { selector: "#gone", present: false },
          { selector: "a.help", attribute: "href", value: "/help" },
          { selector: "#missing" },
        ],
      }),
      stateDir: state,
      assertions: [{ selector: "h1", text: "Backlog" }],
    });
    const dom = r.failures.filter((f) => f.gate === "visual-dom");
    expect(dom.map((f) => f.errorExcerpt)).toEqual([
      '#title @1280px: text "Backlog", expected "Board"',
      "#gone @1280px: present (1), expected absent",
      'a.help @1280px: href "/faq", expected "/help"',
      "#missing @1280px: absent, expected present",
    ]);
    expect(dom[0]?.actual).toBe('"Backlog"');
    expect(r.outcomes.find((o) => o.gate === "visual-dom")?.passed).toBe(false);
    const none = await runVisualGates({ root: state, config: config(), stateDir: state });
    expect(none.outcomes.find((o) => o.gate === "visual-dom")).toMatchObject({
      skipped: true,
      reason: "no DOM assertions declared",
    });
  }, 60_000);

  it("GT-N4-6: the built-in layers pass the card's own assertions to the visual layer", async () => {
    html = page(`<h1 id="title">Backlog</h1>`);
    const r = await runBuiltinGates({
      root: state,
      base: "main",
      diff: "",
      project: { protected: [], maxFiles: 3, maxDiffLines: 200, visual: config() },
      which: () => false,
      gates: [],
      visual: true,
      stateDir: state,
      visualCard: { assertions: [{ selector: "#title", text: "Board" }] },
    });
    expect(r.failures.map((f) => f.errorExcerpt)).toEqual([
      '#title @1280px: text "Backlog", expected "Board"',
    ]);
  }, 60_000);

  it("GT-N4-1: a new or changed baseline waits for a person by default; approving it makes the next run pass", async () => {
    html = page(`<div id="box" style="width:30px;height:30px;background:#000"></div>`);
    const cfg = config({ snapshot: [{ name: "box", selector: "#box" }] });
    const first = await runVisualGates({ root: state, config: cfg, stateDir: state });
    expect(first.failures.map((f) => f.errorExcerpt)).toEqual([
      expect.stringContaining("no approved baseline"),
    ]);
    expect(existsSync(join(state, "visual", "baselines", "box-1280.png"))).toBe(false);
    const [c1] = listVisualCandidates(state);
    expect(c1).toMatchObject({ key: "box-1280" });
    expect(c1?.cardId).toBeUndefined();
    expect(
      approveVisualBaseline(state, { key: "box-1280", sha256: c1?.sha256 ?? "" }),
    ).toMatchObject({ approved: true });
    expect((await runVisualGates({ root: state, config: cfg, stateDir: state })).failures).toEqual(
      [],
    );

    // A changed screen is a candidate for a person too, never a new baseline by itself.
    html = page(`<div id="box" style="width:30px;height:30px;background:#f00"></div>`);
    const changed = await runVisualGates({ root: state, config: cfg, stateDir: state });
    expect(changed.failures.map((f) => f.gate)).toEqual(["visual-snapshot"]);
    const [c2] = listVisualCandidates(state);
    expect(c2?.sha256).not.toBe(c1?.sha256);
    expect(
      approveVisualBaseline(state, { key: "box-1280", sha256: c2?.sha256 ?? "" }),
    ).toMatchObject({ approved: true });
    expect((await runVisualGates({ root: state, config: cfg, stateDir: state })).failures).toEqual(
      [],
    );
    expect(
      approveVisualBaseline(state, { key: "box-1280", sha256: c2?.sha256 ?? "" }).approved,
    ).toBe(false);
  }, 90_000);

  it("GT-N4-1: a candidate is kept per card and screen, and an approval binds to the card and the screenshot the person saw", async () => {
    const cfg = config({ snapshot: [{ name: "box", selector: "#box" }] });
    const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    html = page(`<div id="box" style="width:30px;height:30px;background:#000"></div>`);
    await runVisualGates({ root: state, config: cfg, stateDir: state, cardId: "card_a" });
    const seenA = listVisualCandidates(state).find((c) => c.cardId === "card_a");
    expect(seenA?.key).toBe("box-1280");
    // Card B's run of the same screen writes its own candidate; card A's is untouched.
    html = page(`<div id="box" style="width:30px;height:30px;background:#0a0"></div>`);
    await runVisualGates({ root: state, config: cfg, stateDir: state, cardId: "card_b" });
    const all = listVisualCandidates(state);
    expect(all.map((c) => c.cardId).sort()).toEqual(["card_a", "card_b"]);
    const seenB = all.find((c) => c.cardId === "card_b");
    expect(seenB?.sha256).not.toBe(seenA?.sha256);
    expect(all.find((c) => c.cardId === "card_a")?.sha256).toBe(seenA?.sha256);

    // Card B's candidate cannot be approved under the hash the person saw for card A.
    const wrong = approveVisualBaseline(state, {
      key: "box-1280",
      cardId: "card_b",
      sha256: seenA?.sha256 ?? "",
    });
    expect(wrong).toMatchObject({ approved: false });
    expect(wrong.approved ? "" : wrong.reason).toContain("differs from the one approved");
    expect(existsSync(join(state, "visual", "baselines", "box-1280.png"))).toBe(false);
    // No candidate without its card.
    expect(
      approveVisualBaseline(state, { key: "box-1280", sha256: seenA?.sha256 ?? "" }).approved,
    ).toBe(false);

    // Card A reruns with a changed screen: the hash the person saw no longer matches.
    html = page(`<div id="box" style="width:30px;height:30px;background:#00a"></div>`);
    await runVisualGates({ root: state, config: cfg, stateDir: state, cardId: "card_a" });
    expect(
      approveVisualBaseline(state, {
        key: "box-1280",
        cardId: "card_a",
        sha256: seenA?.sha256 ?? "",
      }).approved,
    ).toBe(false);
    const rerun = listVisualCandidates(state).find((c) => c.cardId === "card_a");
    const ok = approveVisualBaseline(state, {
      key: "box-1280",
      cardId: "card_a",
      sha256: rerun?.sha256 ?? "",
    });
    expect(ok).toMatchObject({ approved: true, cardId: "card_a", sha256: rerun?.sha256 });
    expect(sha(join(state, "visual", "baselines", "box-1280.png"))).toBe(rerun?.sha256);
    // Card B's candidate still waits, for its own approval.
    expect(listVisualCandidates(state).map((c) => c.cardId)).toEqual(["card_b"]);
  }, 90_000);

  it("GT-N4-3: attaches its screenshots and diffs to the evidence bundle as artifacts", async () => {
    html = page(`<div id="box" style="width:30px;height:30px;background:#000"></div>`);
    const cfg = config({
      baseline_approval: "auto",
      snapshot: [{ name: "box", selector: "#box" }],
    });
    await runVisualGates({ root: state, config: cfg, stateDir: state });
    html = page(`<div id="box" style="width:30px;height:30px;background:#fff"></div>`);
    const r = await runVisualGates({ root: state, config: cfg, stateDir: state });
    const kinds = r.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(["screenshot", "visual-baseline", "visual-diff"]);
    for (const a of r.artifacts) expect(existsSync(a.ref)).toBe(true);
    const diff = decodePng(
      readFileSync(r.artifacts.find((a) => a.kind === "visual-diff")?.ref as string),
    );
    expect(diff.width).toBe(30);
    const snap = r.outcomes.find((o) => o.gate === "visual-snapshot");
    expect(snap?.artifacts?.map((a) => a.kind).sort()).toEqual(kinds);
    const bundle = compileEvidence({
      cardId: "c1",
      attempt: 1,
      diff: "",
      filesTouched: [],
      linesAdded: 0,
      linesRemoved: 0,
      gateResult: { passed: false, failures: r.failures, durationMs: 1, rungResults: r.outcomes },
      turnsUsed: 0,
      stopReason: "x",
      checkpointShas: [],
      tokens: { promptTokens: 0, completionTokens: 0 },
      durationMs: 1,
      settings: {} as never,
      gatesConfigSha256: "x",
    });
    expect(bundle.artifacts.map((a) => a.kind).sort()).toEqual(kinds);
  }, 90_000);

  describe("GT-N4-2: the vision checklist fails a card but never passes one", () => {
    const answers =
      (reply: "yes" | "no", seen: { questions?: readonly string[]; temperature?: number } = {}) =>
      (): VisionAdapter => ({
        model: "vision-a",
        answer: async (_png, questions, options) => {
          seen.questions = questions;
          seen.temperature = options.temperature;
          return questions.map((_q, i) => (reply === "no" && i === 0 ? "no" : "yes"));
        },
      });
    const qualified = {
      model: "vision-a",
      checklistVersion: VISION_CHECKLIST_VERSION,
      approvedScreens: 93,
      wrongFails: 1,
      defectScreens: 30,
      falsePasses: 10,
    };

    it("records a 'no' as an advisory while the model is unqualified, and fails the card once it is", async () => {
      html = page(`<div id="box">hello</div>`);
      const seen: { questions?: readonly string[]; temperature?: number } = {};
      const advisory = await runVisualGates({
        root: state,
        config: config(),
        stateDir: state,
        vision: { adapter: answers("no", seen)() },
      });
      expect(seen.temperature).toBe(0);
      expect(seen.questions?.length).toBeGreaterThan(2);
      expect(advisory.failures).toEqual([]);
      expect(advisory.advisories.join("\n")).toMatch(
        /vision checklist \(advisory: .*\) @1280px: no:/,
      );
      expect(advisory.outcomes.some((o) => o.gate === "visual-vision")).toBe(false);

      const blocking = await runVisualGates({
        root: state,
        config: config(),
        stateDir: state,
        vision: { adapter: answers("no")(), qualification: qualified },
      });
      expect(blocking.failures.map((f) => f.gate)).toEqual(["visual-vision"]);
      expect(blocking.outcomes.find((o) => o.gate === "visual-vision")?.passed).toBe(false);
    }, 60_000);

    it("never counts an all-yes answer as a pass of any gate", async () => {
      html = page(`<div id="box">hello</div>`);
      const r = await runVisualGates({
        root: state,
        config: config(),
        stateDir: state,
        vision: { adapter: answers("yes")(), qualification: qualified },
      });
      expect(r.failures).toEqual([]);
      expect(r.outcomes.some((o) => o.gate === "visual-vision")).toBe(false);
      expect(r.advisories.join("\n")).toMatch(/vision checklist: every answer yes; never a pass/);
    }, 60_000);
  });
});
