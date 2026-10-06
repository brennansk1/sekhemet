import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it, vi } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { type LedgerRow, cli, g2Env, ledgerRows, scratch, track } from "./support/g2_cli.js";
import { fakeGh, fakeGitHub, githubWrites } from "./support/g3_github.js";
import { FIXTURES_DIR, buildTakeoverFixture } from "./takeover_fixtures.js";

/**
 * Inherited issues through `sekhemet take-over` (design-stage §2.10 step 5;
 * integrations NEW-integrations-4, INT-42 to INT-44; FINISH_LINE_PLAN C2d,
 * FINDINGS_C1 TST-01): the built binary spawned, trusted, in the
 * inherited-issues fixture repository, whose tracker is GitHub reached
 * through the fake `gh` login as a GitHub Enterprise Server
 * (`support/g3_github.ts`), its issues the fixture's own. The person applies
 * the proposal from the dashboard's route on a started server. Real git,
 * the real ledger file the binary wrote; no model and no network.
 */

interface Verdict {
  issue: { id: string };
  verdict: "done" | "duplicate" | "stale" | "valid";
  evidence: { kind: string; ref: string }[];
  newCard?: boolean;
  cardId?: string;
}

const proposals = (rows: LedgerRow[]) =>
  rows
    .filter((r) => r.type === "reconcile/proposed")
    .map((r) => ({ ...r.payload, ...(r.private ?? {}) }) as { id: string; issues: Verdict[] });

describe("sekhemet take-over with a connected tracker (INT-42 to INT-44)", () => {
  it(
    "INT-42, INT-43, INT-44: each open issue is proposed done, duplicate, stale or valid with its evidence; a card's own issue is reconciled to it; nothing is written until a person applies it through the one adapter; a second take-over proposes no card again",
    { timeout: 300_000 },
    async () => {
      const fx = buildTakeoverFixture("inherited-issues");
      track(fx.root);
      execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], {
        cwd: fx.root,
      });
      // GitHub holds the fixture's issues.
      const api = await fakeGitHub();
      const spec = JSON.parse(
        readFileSync(join(FIXTURES_DIR, "inherited-issues", "fixture.json"), "utf8"),
      ) as { issues: { number: number; title: string; body: string; state: string }[] };
      for (const i of spec.issues)
        api.edit(i.number, { title: i.title, body: i.body, state: i.state });
      const home = join(scratch(), "home");
      const bin = fakeGh(join(home, "gh-bin"));
      const env = {
        ...g2Env(home),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_GH_TOKEN: "gho_fake",
        SEKHEMET_GITHUB_HOST: api.url,
      };
      // Issue #5 is already carried by a card on this board.
      {
        const { db, log } = openLocalLedger(fx.root);
        await new CardStore(db, log).createCard({
          id: "card_euros",
          tier: "story",
          title: "Show totals in euros",
          status: "backlog",
          externalRef: { system: "github", id: "o/r#5", url: "https://github.com/o/r/issues/5" },
        });
        db.close();
      }
      const trust = await cli(["trust", "--yes"], { cwd: fx.root, env });
      expect(trust.status, trust.stderr).toBe(0);
      const first = await cli(["take-over"], { cwd: fx.root, env, timeoutMs: 180_000 });
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(first.stdout).toMatch(
        /Inherited issues: 5 proposed as done, duplicate, stale or valid \(REC-1\); nothing changes on the tracker until you apply it\./,
      );
      const [rec] = proposals(ledgerRows(fx.root));
      expect(rec?.id).toBe("REC-1");
      const by = new Map(rec?.issues.map((i) => [i.issue.id.split("#")[1], i]));
      // INT-42: one verdict per open issue (the closed #6 is not reconciled), each with its evidence.
      expect([...by.keys()].sort()).toEqual(["1", "2", "3", "4", "5"]);
      expect(by.get("2")).toMatchObject({
        verdict: "done",
        evidence: [{ kind: "commit", ref: fx.commits[1] }],
      });
      expect(by.get("3")).toMatchObject({
        verdict: "duplicate",
        evidence: [{ kind: "issue", ref: "o/r#1" }],
      });
      expect(by.get("4")).toMatchObject({
        verdict: "stale",
        evidence: [{ kind: "commit", ref: fx.commits[2] }],
      });
      expect(by.get("1")).toMatchObject({ verdict: "valid", newCard: true });
      expect(by.get("1")?.evidence).toContainEqual({ kind: "file_line", ref: "src/total.ts:1" });
      // INT-44: #5 says it is done, but no test or commit shows it — and a card already carries it.
      expect(by.get("5")).toMatchObject({ verdict: "valid", newCard: false, cardId: "card_euros" });
      // INT-43: nothing written to the tracker before a person applies it.
      expect(githubWrites(api)).toEqual([]);

      // The person applies it, from the dashboard.
      vi.stubEnv("PATH", env.PATH);
      vi.stubEnv("FAKE_GH_TOKEN", "gho_fake");
      vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
      vi.stubEnv("SEKHEMET_CONFIG_DIR", env.SEKHEMET_CONFIG_DIR as string);
      vi.stubEnv("SEKHEMET_USER_CONFIG", env.SEKHEMET_USER_CONFIG as string);
      const { db, log } = openLocalLedger(fx.root);
      const store = new CardStore(db, log);
      const server = await startDashboardServer({
        db,
        log,
        boardService: new BoardServiceImpl(store),
        cardStore: store,
        repoPath: fx.root,
        port: 0,
        streamIntervalMs: 10_000,
        pressureLevel: () => 1,
      });
      const base = `http://127.0.0.1:${server.port}`;
      try {
        const applied = await fetch(`${base}/api/takeover/reconciliation/apply`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
          body: JSON.stringify({ id: "REC-1" }),
        });
        expect(applied.status).toBe(200);
        expect(await applied.json()).toMatchObject({ id: "REC-1", state: "applied", errors: [] });
        // Through the one adapter: done and duplicate closed, stale labelled, each commented.
        const patches = githubWrites(api)
          .filter((s) => s.method === "PATCH")
          .map((s) => [s.url, s.body]);
        expect(patches).toEqual([
          ["/api/v3/repos/o/r/issues/2", expect.objectContaining({ state: "closed" })],
          ["/api/v3/repos/o/r/issues/3", expect.objectContaining({ state: "closed" })],
          ["/api/v3/repos/o/r/issues/4", expect.objectContaining({ labels: ["stale"] })],
        ]);
        const comments = githubWrites(api)
          .filter((s) => s.method === "POST" && s.url.endsWith("/comments"))
          .map((s) => s.url);
        expect(comments).toEqual([
          "/api/v3/repos/o/r/issues/2/comments",
          "/api/v3/repos/o/r/issues/3/comments",
          "/api/v3/repos/o/r/issues/4/comments",
        ]);
        expect(githubWrites(api).some((s) => /\/issues\/(1|5)(\/|$)/.test(s.url))).toBe(false);
        // Who applied it is recorded.
        expect(await store.reconciliation.get("REC-1")).toMatchObject({
          state: "applied",
          principal: store.localPrincipal(),
        });
      } finally {
        await server.close();
        db.close();
        vi.unstubAllEnvs();
      }

      // INT-42: taken over again, no card is proposed a second time.
      const second = await cli(["take-over"], { cwd: fx.root, env, timeoutMs: 180_000 });
      expect(second.status, second.stdout + second.stderr).toBe(0);
      const again = proposals(ledgerRows(fx.root)).at(-1);
      expect(again?.issues.filter((i) => i.newCard)).toEqual([]);
    },
  );
});
