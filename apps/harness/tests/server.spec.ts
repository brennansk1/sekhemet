import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { UI_LIB_MODULES, UI_WEB_DIR } from "@sekhemet/ui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveStaticPath, startDashboardServer } from "../src/server.js";

describe("@sekhemet/harness Dashboard Server", () => {
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let boardService: BoardServiceImpl;
  let serverInstance: { port: number; close: () => Promise<void> };
  let repo: string;

  beforeAll(async () => {
    // A real database file on disk, as the DoD requires: an in-memory database
    // hides WAL and locking behaviour the dashboard runs against in practice.
    repo = mkdtempSync(join(tmpdir(), "sekhemet-server-"));
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    boardService = new BoardServiceImpl(cardStore);

    // Seed test cards
    await cardStore.createCard({
      id: "card_ui_1",
      tier: "feature",
      title: "Basalt Theme Virtual Kanban",
      status: "in_progress",
      scopeFiles: ["packages/ui/src/canvas.ts"],
    });

    await cardStore.createCard({
      id: "card_ui_2",
      tier: "task",
      title: "Playwright visual gate verification",
      status: "ready",
      scopeFiles: ["tests/visual.spec.ts"],
    });

    // Start server on an ephemeral port (port 0)
    serverInstance = await startDashboardServer({
      db,
      log,
      boardService,
      cardStore,
      repoPath: repo,
      port: 0,
    });
  });

  afterAll(async () => {
    await serverInstance.close();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("serves the dashboard with the Basalt token stylesheet", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("<title>Sekhemet</title>");
    expect(html).toContain('data-theme="basalt"');
    // Colors must arrive as custom properties, never inlined per component.
    expect(html).toContain("--bg-base: #14120F;");
    expect(html).toContain("--accent: #C8952A;");
    expect(html).toContain('[data-theme="sand"]');
  });

  it("serves scripts that compile and stylesheets free of script", async () => {
    // Both regressions happened: drawer JS inserted into the <style> block
    // (silently dropping every later CSS rule), and \n escapes that became raw
    // newlines inside JS string literals (a SyntaxError that blanked the board).
    // The page is now static ES modules, so every one of them is compiled with
    // `node --check` exactly as served, and every stylesheet is checked.
    const base = `http://127.0.0.1:${serverInstance.port}`;
    const html = await (await fetch(`${base}/`)).text();
    // The shell carries no inline script: only the module entry and the theme boot.
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect(html).toContain('<script type="module" src="/app/app.js"></script>');

    const scripts = [
      ...readdirSync(UI_WEB_DIR).filter((f) => f.endsWith(".js")),
      ...UI_LIB_MODULES.map((m) => `lib/${m}`),
    ];
    expect(scripts).toContain("app.js");
    expect(scripts.length).toBeGreaterThan(15);
    const dir = mkdtempSync(join(tmpdir(), "sekhemet-js-"));
    try {
      for (const name of scripts) {
        const res = await fetch(`${base}/app/${name}`);
        expect(res.status, name).toBe(200);
        expect(res.headers.get("content-type"), name).toContain("text/javascript");
        const source = await res.text();
        expect(source.length, name).toBeGreaterThan(100);
        const file = join(dir, `${name.replace(/\//g, "_")}.mjs`);
        writeFileSync(file, source);
        expect(
          () => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }),
          name,
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const styles = readdirSync(UI_WEB_DIR).filter((f) => f.endsWith(".css"));
    let allCss = "";
    for (const name of styles) {
      const res = await fetch(`${base}/app/${name}`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type"), name).toContain("text/css");
      const css = await res.text();
      expect(css, name).not.toMatch(/\bfunction\s*\w*\s*\(/);
      expect(css, name).not.toContain("document.");
      expect(css, name).not.toContain("<script");
      // No hard-coded colour: every value comes from a token.
      expect(css, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
      expect(html, name).toContain(`href="/app/${name}"`);
      allCss += css;
    }
    // The drawer and palette styles must actually be present.
    expect(allCss).toContain(".peek {");
    expect(allCss).toContain(".scrim {");
  });

  it("escapes model-authored text instead of interpolating it as markup", async () => {
    // Card titles come from a model, so the renderer must escape. A dashboard
    // that innerHTMLs untrusted titles is an injection vector. The escape
    // function now lives in the page's shared DOM module rather than inline.
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/app/dom.js`);
    const html = await res.text();

    // Extract the page's own escape function and exercise it, rather than
    // grepping for its source: the behaviour is what protects the user.
    const source = /function esc\(v\) \{[\s\S]*?\n\}/.exec(html)?.[0];
    expect(source, "esc() not found in page").toBeTruthy();

    const esc = new Function(`${source}; return esc;`)() as (v: unknown) => string;
    const attack = `<img src=x onerror="alert(1)">`;
    const escaped = esc(attack);

    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;img");
    expect(escaped).toContain("&quot;");
    expect(esc("a & b")).toBe("a &amp; b");
    expect(esc("it's")).toBe("it&#39;s");
    // Ampersand must be escaped first, or every other entity is double-escaped.
    expect(esc("&lt;")).toBe("&amp;lt;");
    expect(esc(null)).toBe("");

    // And no template, in the shell or any module, may interpolate a card
    // field straight into markup.
    const shell = await (await fetch(`http://127.0.0.1:${serverInstance.port}/`)).text();
    expect(shell).not.toMatch(/innerHTML\s*=\s*`?\$\{card\.(title|id)\}/);
    for (const name of readdirSync(UI_WEB_DIR).filter((f) => f.endsWith(".js"))) {
      const js = await (await fetch(`http://127.0.0.1:${serverInstance.port}/app/${name}`)).text();
      expect(js, name).not.toMatch(/innerHTML\s*=\s*`?\$\{card\.(title|id)\}/);
      expect(js, name).not.toMatch(/\$\{(card|c|d)\.title\}/);
    }
  });

  it("refuses path traversal and unknown types when serving /app", async () => {
    const raw = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: serverInstance.port, path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await raw("/app/../../../package.json")).toBe(404);
    expect(await raw("/app/..%2f..%2f..%2fpackage.json")).toBe(404);
    expect(await raw("/app/%2e%2e/%2e%2e/package.json")).toBe(404);
    expect(await raw("/app/lib/../../package.json")).toBe(404);
    expect(await raw("/app/lib/canvas.js")).toBe(404);
    expect(await raw("/app/does-not-exist.js")).toBe(404);
    expect(await raw("/app/app.js")).toBe(200);
    expect(resolveStaticPath(UI_WEB_DIR, "../src/index.ts")).toBeUndefined();
    expect(resolveStaticPath(UI_WEB_DIR, "..\\src\\x.js")).toBeUndefined();
    expect(resolveStaticPath(UI_WEB_DIR, "app.js")).toBeTruthy();
  });

  it("publishes the vocabulary and a favicon", async () => {
    const vocab = await (await fetch(`http://127.0.0.1:${serverInstance.port}/vocab.json`)).json();
    expect(vocab.columns.in_progress.label).toBe("Working");
    expect(vocab.stopReasons.oscillation_detected.short).toBe("Looping");
    const icon = await fetch(`http://127.0.0.1:${serverInstance.port}/favicon.svg`);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    expect(await icon.text()).toContain("#C8952A");
  });

  it("publishes design tokens as CSS and JSON for plugin panels", async () => {
    const css = await fetch(`http://127.0.0.1:${serverInstance.port}/tokens.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("--state-running: #4C8ED9;");

    const jsonRes = await fetch(`http://127.0.0.1:${serverInstance.port}/tokens.json`);
    expect(jsonRes.status).toBe(200);
    const tokens = (await jsonRes.json()) as {
      themes: { basalt: Record<string, string>; sand: Record<string, string> };
    };
    expect(tokens.themes.basalt.bgBase).toBe("#14120F");
    // Both themes must define the same roles or a component resolves to nothing.
    expect(Object.keys(tokens.themes.sand).sort()).toEqual(
      Object.keys(tokens.themes.basalt).sort(),
    );
  });

  it("streams updates over SSE rather than requiring a poll", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/api/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("serves /api/board with active cards and WIP limits", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/api/board`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { cards: unknown[]; backpressureActive: boolean };

    expect(data.cards.length).toBe(2);
    expect(data.backpressureActive).toBe(false);
  });

  it("serves /api/events with cryptographic hash chain verification", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/api/events`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      events: unknown[];
      verification: { valid: boolean; totalEvents: number };
    };

    expect(data.events.length).toBeGreaterThanOrEqual(2);
    expect(data.verification.valid).toBe(true);
  });

  it("serves /api/doctor diagnostic reports", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/api/doctor`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      checks: { name: string; status: string; detail: string }[];
    };

    // Deliberately not asserting ok === true. These probes report real machine
    // state: with a 14GB model resident, memory pressure legitimately reports
    // `fail`, and a CI box has no inference server at all. Asserting a healthy
    // host would make the suite fail for the diagnostic working correctly —
    // and would quietly re-create the always-passes check this replaced.
    expect(data.checks.length).toBeGreaterThanOrEqual(4);
    expect(data.checks.map((c) => c.name)).toContain("Sandbox confinement");

    for (const check of data.checks) {
      expect(["pass", "warn", "fail"]).toContain(check.status);
      expect(check.detail.length).toBeGreaterThan(0);
    }

    // `ok` must remain derived from the checks rather than hardcoded.
    expect(data.ok).toBe(data.checks.every((c) => c.status !== "fail"));
  });

  const post = (path: string, body?: unknown, trusted = true) =>
    fetch(`http://127.0.0.1:${serverInstance.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(trusted ? { "X-Sekhemet-Action": "1" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it("refuses a triage action that does not come from the dashboard", async () => {
    await cardStore.createCard({
      id: "card_triage",
      tier: "task",
      title: "Card awaiting review",
      status: "review",
      scopeFiles: ["src/a.ts"],
    });
    const res = await post("/api/cards/card_triage/park", undefined, false);
    expect(res.status).toBe(403);
    expect((await cardStore.getCard("card_triage"))?.status).toBe("review");
  });

  it("refuses a return without a reason, because the reason is the agent's next instruction", async () => {
    const res = await post("/api/cards/card_triage/return", { reason: "   " });
    expect(res.status).toBe(400);
    expect((await cardStore.getCard("card_triage"))?.status).toBe("review");
  });

  it("returns a card to Ready and records the reason as a playbook candidate", async () => {
    const res = await post("/api/cards/card_triage/return", {
      reason: "Handle the empty-chain case explicitly",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "ready" });
    expect((await cardStore.getCard("card_triage"))?.status).toBe("ready");

    const candidates = join(repo, ".sekhemet", "playbook_candidates.jsonl");
    expect(existsSync(candidates)).toBe(true);
    const line = JSON.parse(readFileSync(candidates, "utf8").trim().split("\n").at(-1) ?? "{}");
    expect(line.cardId).toBe("card_triage");
    expect(line.reason).toBe("Handle the empty-chain case explicitly");
  });

  it("parks a card and reports illegal transitions instead of forcing them", async () => {
    const parked = await post("/api/cards/card_triage/park", { reason: "waiting on API design" });
    expect(parked.status).toBe(200);
    expect((await cardStore.getCard("card_triage"))?.status).toBe("parked");

    // Accepting is only legal from Review; the board's transition table rules.
    const accept = await post("/api/cards/card_triage/accept");
    expect(accept.status).toBe(409);
    expect((await accept.json()).error).toContain("Review");
  });

  it("returns 404 for an unknown card and reports project metadata", async () => {
    expect((await post("/api/cards/card_nope/park")).status).toBe(404);
    const meta = await (await fetch(`http://127.0.0.1:${serverInstance.port}/api/meta`)).json();
    expect(meta).toMatchObject({ triage: true, repoPath: repo });
  });

  it("enriches board cards with display: plain title, kinds, status line", async () => {
    await cardStore.createCard({
      id: "card_chron_hasher",
      tier: "story",
      title: "Implement canonical JSON and SHA-256 hash chaining (SPIDR: Rule)",
      status: "verify",
      scopeFiles: ["src/hasher.ts"],
      acceptanceTests: ["hasher.spec.ts"],
    });
    const failure = (line: number) => ({
      rung: "typecheck",
      gate: "typecheck",
      layer: "static",
      exitCode: 1,
      errorExcerpt: `tests/hasher.spec.ts:${line}:7 TS2353: Object literal may only specify known properties.`,
      suggestedFixFiles: [],
      location: { file: "tests/hasher.spec.ts", line, column: 7 },
    });
    const bundle = (id: string, createdAt: string, passed: boolean) => ({
      id,
      cardId: "card_chron_hasher",
      attempt: 1,
      createdAt,
      diff: "diff --git a/src/hasher.ts b/src/hasher.ts\n--- a/src/hasher.ts\n+++ b/src/hasher.ts\n@@ -0,0 +1 @@\n+x\n",
      filesTouched: ["src/hasher.ts"],
      linesAdded: 1,
      linesRemoved: 0,
      rungResults: [
        {
          gate: "typecheck",
          rung: "typecheck",
          layer: "static",
          passed,
          exitCode: passed ? 0 : 1,
          durationMs: 658,
        },
        {
          gate: "unit",
          rung: "test",
          layer: "functional",
          passed,
          exitCode: passed ? 0 : 1,
          durationMs: 900,
        },
      ],
      failures: passed ? [] : [failure(25), failure(58), failure(59)],
      passed,
      turnsUsed: 8,
      stopReason: passed ? "gate_passed" : "oscillation_detected",
      checkpointShas: [],
      tokens: { promptTokens: 16800, completionTokens: 1440 },
      durationMs: 4959,
      settings: { modelId: "scripted", toolArm: "arm_a_flat" },
      gatesConfigSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    const dir = join(repo, ".sekhemet", "evidence");
    mkdirSync(dir, { recursive: true });
    const first = bundle("ev_aaaaaaaaaa", "2026-09-18T14:00:00.000Z", true);
    const latest = bundle("ev_bbbbbbbbbb", "2026-09-18T14:42:30.000Z", false);
    writeFileSync(join(dir, "ev_aaaaaaaaaa.json"), JSON.stringify(first));
    writeFileSync(join(dir, "ev_bbbbbbbbbb.json"), JSON.stringify(latest));
    writeFileSync(join(dir, "latest-card_chron_hasher.json"), JSON.stringify(latest));
    mkdirSync(join(repo, "acceptance"), { recursive: true });
    writeFileSync(join(repo, "acceptance", "hasher.spec.ts"), "// the oracle\n");

    const base = `http://127.0.0.1:${serverInstance.port}`;
    const board = (await (await fetch(`${base}/api/board`)).json()) as {
      cards: {
        id: string;
        display: Record<string, unknown> & {
          evidence?: { gates: { id: string; label: string; state: string }[] };
        };
      }[];
    };
    const hasher = board.cards.find((c) => c.id === "card_chron_hasher");
    expect(hasher?.display.title).toBe("Implement canonical JSON and SHA-256 hash chaining");
    expect(hasher?.display.kinds).toEqual(["rules"]);
    expect(hasher?.display.statusLine).toBe("Types failed · 3 errors");
    expect(hasher?.display.stateLabel).toBe("Checking");
    expect(hasher?.display.needsYou).toBe(true);
    expect(typeof hasher?.display.enteredColumnAt).toBe("string");
    // Gates in execution order from the evidence; no synthetic Parse.
    expect(hasher?.display.evidence?.gates.map((g) => g.id)).toContain("typecheck");
    expect(hasher?.display.evidence?.gates.some((g) => g.id === "parse")).toBe(false);
    // Every card carries display, including ones that never ran.
    for (const c of board.cards) expect(typeof c.display.statusLine).toBe("string");

    const detail = await (await fetch(`${base}/api/cards/card_chron_hasher`)).json();
    expect(detail.card.display.shortId).toBe("hasher");
    expect(detail.attempts.map((a: { evidenceId: string }) => a.evidenceId)).toEqual([
      "ev_aaaaaaaaaa",
      "ev_bbbbbbbbbb",
    ]);
    expect(detail.attempts[0]).toMatchObject({
      attempt: 1,
      passed: true,
      stopReason: "gate_passed",
    });
    expect(detail.acceptance).toEqual([
      { name: "hasher.spec.ts", path: "tests/hasher.spec.ts", content: "// the oracle\n" },
    ]);

    const one = await (await fetch(`${base}/api/evidence/card_chron_hasher?attempt=1`)).json();
    expect(one.id).toBe("ev_aaaaaaaaaa");
    const latestRes = await (await fetch(`${base}/api/evidence/card_chron_hasher`)).json();
    expect(latestRes.id).toBe("ev_bbbbbbbbbb");
    expect((await fetch(`${base}/api/evidence/card_chron_hasher?attempt=9`)).status).toBe(404);
    expect((await fetch(`${base}/api/cards/card_nope`)).status).toBe(404);
  });

  it("serves the gate contract in execution order and flags an empty one", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/api/gates`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      gates: { id: string; label: string; blocking: boolean }[];
      empty: boolean;
      sha256: string;
      maxFiles: number;
    };
    // This repo has no gates.toml, so the defaults apply and hash to nothing.
    expect(data.empty).toBe(true);
    expect(data.sha256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(data.gates.length).toBeGreaterThanOrEqual(2);
    expect(data.gates[0]?.label).toBe("Types");
    expect(data.maxFiles).toBeGreaterThan(0);
  });

  it("reports the extra metadata the shell needs", async () => {
    const meta = await (await fetch(`http://127.0.0.1:${serverInstance.port}/api/meta`)).json();
    expect(meta.reviewMinutesPerDay).toBe(60);
    expect(typeof meta.version).toBe("string");
  });
});
