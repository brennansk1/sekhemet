import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { type EgressRow, egressLines, egressRows } from "../src/egress_view.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { sandboxDirs, sekhemet } from "./cli_fixture.js";
import { EGRESS_TIMES, seedEgress } from "./egress_fixture.js";

/**
 * What leaves the machine, listed (security item 33a, NEW-security-11;
 * dashboard NEW-dashboard-24; FINDINGS INS-08): `sekhemet egress` run as the
 * built binary, and `GET /api/config/egress` against a real server, over the
 * same real ledger on disk — the same rows, newest first, recording nothing.
 */

const eventCount = (repo: string) => {
  const { db } = openLocalLedger(repo);
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("sekhemet egress (SEC-N11-2, SEC-N11-3)", () => {
  it("lists every recorded request newest first: host, purpose, allowed or refused, size, cause", async () => {
    const where = sandboxDirs();
    await seedEgress(where.cwd);
    const before = eventCount(where.cwd);
    const r = sekhemet(["egress"], where);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.trim());
    const download = lines.findIndex((l) => l.includes("huggingface.co"));
    const refused = lines.findIndex((l) => l.includes("paste.example.net"));
    const github = lines.findIndex((l) => l.includes("api.github.com"));
    expect([download, refused, github].every((i) => i >= 0)).toBe(true);
    expect(download).toBeLessThan(refused);
    expect(refused).toBeLessThan(github);
    expect(lines[download]).toMatch(/Allowed.*Model download.*5 GB.*You/);
    expect(lines[refused]).toMatch(/Refused.*2 KB.*c1 Fetch exchange rates.*not on the allowlist/);
    expect(lines[github]).toMatch(/Allowed.*GitHub integration.*You/);
    // The URL's path and query are the private part: never printed.
    expect(r.stdout).not.toContain("/repos/o/r/issues");
    expect(eventCount(where.cwd)).toBe(before);
  });

  it("filters by --since and --refused, and says when nothing has left", async () => {
    const where = sandboxDirs();
    await seedEgress(where.cwd);
    const refused = sekhemet(["egress", "--refused"], where);
    expect(refused.status, refused.stderr).toBe(0);
    expect(refused.stdout).toContain("paste.example.net");
    expect(refused.stdout).not.toContain("api.github.com");
    expect(refused.stdout).not.toContain("huggingface.co");
    const since = sekhemet(["egress", "--since", EGRESS_TIMES.refused], where);
    expect(since.stdout).toContain("paste.example.net");
    expect(since.stdout).not.toContain("api.github.com");
    const none = sekhemet(["egress", "--since", "2999-01-01"], where);
    expect(none.status).toBe(0);
    expect(none.stdout.trim()).toBe("Nothing has left this machine.");
    const bad = sekhemet(["egress", "--since", "yesterday-ish"], where);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--since");
  });

  it("an empty ledger: Nothing has left this machine.", async () => {
    const where = sandboxDirs();
    const { db, log } = openLocalLedger(where.cwd);
    await new CardStore(db, log).createCard({ id: "c1", tier: "story", title: "One" });
    db.close();
    const r = sekhemet(["egress"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("Nothing has left this machine.");
  });

  it("--json: one object of the published schema, with the same rows", async () => {
    const where = sandboxDirs();
    await seedEgress(where.cwd);
    const r = sekhemet(["egress", "--json"], where);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const value = JSON.parse(lines[0] as string) as { rows: EgressRow[] } & Record<string, unknown>;
    const schema = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../data/schemas/cli/egress.schema.json"), "utf8"),
    );
    const check = new AjvJsonSchemaValidator().getValidator(schema)(value);
    expect(check.errorMessage, JSON.stringify(value)).toBeUndefined();
    expect(value).toMatchObject({ command: "egress", ok: true, exitCode: 0 });
    expect(value.rows.map((x) => x.host)).toEqual([
      "huggingface.co",
      "paste.example.net",
      "api.github.com",
    ]);
  });
});

describe("GET /api/config/egress (DB-N24-1, DB-N24-2, DB-N24-3)", () => {
  it("serves the rows `sekhemet egress` prints for the same ledger, filtered, recording nothing", async () => {
    const where = sandboxDirs();
    await seedEgress(where.cwd);
    const printed = sekhemet(["egress"], where)
      .stdout.split("\n")
      .filter((l) => l.trim());
    const { db, log } = openLocalLedger(where.cwd);
    const cardStore = new CardStore(db, log);
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: where.cwd,
      port: 0,
      streamIntervalMs: 500,
      pressureLevel: () => 1,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // The server's own record that a session is active is written on a
      // first request; the view's requests after it record nothing.
      await fetch(`${base}/api/config`);
      const before = (db.prepare("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
      const all = (await (await fetch(`${base}/api/config/egress`)).json()) as {
        rows: EgressRow[];
        empty: string;
      };
      expect(egressLines(all.rows)).toEqual(printed);
      expect(all.rows.map((x) => x.allowed)).toEqual([true, false, true]);
      expect(all.rows[1]?.cause).toEqual({
        kind: "issue",
        id: "c1",
        title: "Fetch exchange rates",
      });
      const refused = (await (await fetch(`${base}/api/config/egress?refused=1`)).json()) as {
        rows: EgressRow[];
      };
      expect(refused.rows.map((x) => x.host)).toEqual(["paste.example.net"]);
      const since = (await (
        await fetch(`${base}/api/config/egress?since=${encodeURIComponent("2999-01-01")}`)
      ).json()) as { rows: EgressRow[]; empty: string };
      expect(since.rows).toEqual([]);
      expect(since.empty).toBe("Nothing has left this machine.");
      const after = db.prepare("SELECT type FROM events WHERE seq > ?").all(before);
      expect(after).toEqual([]);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("shows a reader only the rows of projects they may see", async () => {
    const where = sandboxDirs();
    await seedEgress(where.cwd);
    const { db, log } = openLocalLedger(where.cwd);
    try {
      const issue = (id: string) => {
        const row = db.prepare("SELECT title FROM cards WHERE id = ?").get(id) as
          | { title: string }
          | undefined;
        return row ? { title: row.title, projectId: "p_hidden" } : undefined;
      };
      const rows = await egressRows(log, {}, { issue, canSee: (p) => p !== "p_hidden" });
      expect(rows.map((x) => x.host)).toEqual(["huggingface.co", "api.github.com"]);
    } finally {
      db.close();
    }
  });
});
