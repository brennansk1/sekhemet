import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_COLUMNS } from "@sekhemet/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";
import { sekhemet } from "./cli_fixture.js";
import { type SeededBoard, seedBoard } from "./support/dashboard_seed.js";

/**
 * Wave 8 B1 (sweep 4, P1): `status` in the Timesheets repository listed the
 * Recipes project's card and said *12 issues*, counting a Won't do card no
 * column shows. Surface item 8a: the command acts on the project whose root
 * holds the folder; a column holds and counts only what it shows. The
 * expected numbers are re-derived from the ledger's own cards.
 */
describe("status acts on the folder's project (surface item 8a)", () => {
  let seed: SeededBoard | undefined;
  afterEach(() => {
    seed?.cleanup();
    seed = undefined;
    process.exitCode = undefined;
  });

  /** What `main` prints for `argv` (the text board and its lines). */
  async function run(argv: string[]): Promise<{ out: string }> {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await main(argv);
    } finally {
      log.mockRestore();
    }
    return { out: lines.join("\n") };
  }

  /** The Timesheets cards a column shows, read from the ledger. */
  async function expected(s: SeededBoard): Promise<string[]> {
    const shown = new Set(BOARD_COLUMNS.flatMap((c) => c.states as string[]));
    return (await s.store.listCards())
      .filter((c) => c.projectId === s.project && shown.has(c.status))
      .map((c) => c.id)
      .sort();
  }

  it("status --json lists only the Timesheets project's issues and counts what its columns show", async () => {
    seed = await seedBoard("sek-status-scope-");
    const want = await expected(seed);
    // The built binary: `--json` writes its one object straight to stdout.
    const home = mkdtempSync(join(tmpdir(), "sek-status-home-"));
    const r = sekhemet(["status", "--json"], { cwd: seed.dir, home });
    rmSync(home, { recursive: true, force: true });
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    const columns = (json?.columns ?? []) as {
      name: string;
      issues: { id: string; state: string }[];
    }[];
    // Wave 8 B4: a stored Verify card is *In progress*, as Status says it, never *Being checked*.
    const vf1 = columns.flatMap((c) => c.issues).find((i) => i.id === "card_vf1");
    expect(vf1?.state).toBe("In progress");
    const ids = columns.flatMap((c) => c.issues.map((i) => i.id)).sort();
    expect(ids).toEqual(want);
    expect(ids).not.toContain("card_o1");
    expect(String(json?.message)).toMatch(new RegExp(`^${want.length} issues;`));
  });

  // Wave 8 review (sweep 4 #19, #20): the count named *issues* counted an
  // epic too, so `status` said 11 where Status said *of 10 issues*. The
  // number is re-derived from the ledger's card/created events and their tier.
  it("counts issues only: an epic is listed where its issues are, never counted as one", async () => {
    seed = await seedBoard("sek-status-scope-");
    await seed.store.createCard({
      id: "card_ep1",
      tier: "epic",
      title: "Overtime rules",
      status: "ready",
      projectId: seed.project,
    });
    const shown = new Set(BOARD_COLUMNS.flatMap((c) => c.states as string[]));
    const status = new Map((await seed.store.listCards()).map((c) => [c.id, c.status]));
    const created = (
      seed.db.prepare("SELECT card_id, payload FROM events WHERE type = 'card/created'").all() as {
        card_id: string;
        payload: string;
      }[]
    ).map((r) => ({
      id: r.card_id,
      ...(JSON.parse(r.payload) as { tier?: string; projectId?: string }),
    }));
    const issues = created.filter(
      (c) =>
        c.projectId === seed?.project &&
        (!c.tier || c.tier === "story" || c.tier === "task") &&
        shown.has(String(status.get(c.id))),
    ).length;
    expect(created.some((c) => c.id === "card_ep1" && c.tier === "epic")).toBe(true);
    // The built binary: `--json` writes its one object straight to stdout.
    const home = mkdtempSync(join(tmpdir(), "sek-status-home-"));
    const out = sekhemet(["status", "--json"], { cwd: seed.dir, home });
    rmSync(home, { recursive: true, force: true });
    expect(out.status, out.stderr).toBe(0);
    const r = JSON.parse(out.stdout) as {
      message: string;
      columns: { issues: { id: string }[] }[];
    };
    // The epic is listed where its issues are (S1B-B16)…
    expect(r.columns.flatMap((c) => c.issues.map((i) => i.id))).toContain("card_ep1");
    // …and the count names only issues, as Status's *of N issues* does.
    expect(r.message).toMatch(new RegExp(`^${issues} issues;`));
  });

  it("the text board and its decisions name no other project's issue", async () => {
    seed = await seedBoard("sek-status-scope-");
    for (const [cardId, question] of [
      ["card_bk1", "Which months to import?"],
      ["card_o1", "Metric or imperial?"],
    ] as const)
      await seed.store.runs.requestDecision({
        cardId,
        kind: "planner",
        question,
        context: "{}",
        options: ["One", "Two"],
      });
    const { out } = await run(["status", "--repo", seed.dir]);
    expect(out).toMatch(/card_bk1/);
    expect(out).toMatch(/Decision: .*Which months to import\?/);
    expect(out).not.toMatch(/card_o1|Save a recipe|Metric or imperial/);
  });

  it("board --terminal shows the folder's project only", async () => {
    seed = await seedBoard("sek-status-scope-");
    const { out } = await run(["board", "--terminal", "--repo", seed.dir]);
    expect(out).toMatch(/card_bk1/);
    expect(out).not.toMatch(/card_o1|Save a recipe/);
  });
});
