import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

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

  it("serves a script that compiles and a stylesheet free of script", async () => {
    // Both regressions happened: drawer JS inserted into the <style> block
    // (silently dropping every later CSS rule), and \n escapes that became raw
    // newlines inside JS string literals (a SyntaxError that blanked the board).
    const html = await (await fetch(`http://127.0.0.1:${serverInstance.port}/`)).text();
    const script = html.split("<script>")[1]?.split("</script>")[0] ?? "";
    const style = html.split("<style>")[1]?.split("</style>")[0] ?? "";

    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
    expect(style).not.toMatch(/\bfunction\s*\w*\s*\(/);
    expect(style).not.toContain("document.");
    // The drawer and palette styles must actually be present in the stylesheet.
    expect(style).toContain(".evidence {");
    expect(style).toContain(".scrim {");
  });

  it("escapes model-authored text instead of interpolating it as markup", async () => {
    // Card titles come from a model, so the renderer must escape. A dashboard
    // that innerHTMLs untrusted titles is an injection vector.
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/`);
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

    // And no template may interpolate a card field straight into markup.
    expect(html).not.toMatch(/innerHTML\s*=\s*`?\$\{card\.(title|id)\}/);
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
});
