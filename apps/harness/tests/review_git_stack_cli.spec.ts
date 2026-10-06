import { describe, expect, it } from "vitest";
import { cliIn, eventsOf, g6Repo, inReview, statusOf, write } from "./support/g6_review.js";

/**
 * review-git NEW-review-git-2 at the door (C2d, FINDINGS_C1 TST-01): a
 * parent accepted with a spawned `sekhemet accept`, its stacked child
 * rebased onto the integration branch and its gates run again there, against
 * a real repository, real gates and a real ledger.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

/** One gate: it fails once src/breaker.ts exists. */
const GATES = `[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(require('fs').existsSync('src/breaker.ts') ? 1 : 0)"]\ntimeout_s = 30\nparser = "generic"\n`;

async function stacked() {
  const r = g6Repo();
  write(r.repo, ".sekhemet/gates.toml", GATES);
  await inReview(r, "par", { files: { "src/p.ts": 'export const p = "par";\n' } });
  await inReview(r, "kid", {
    files: { "src/c.ts": 'export const c = "kid";\n' },
    parent: "par",
    opened: false,
  });
  return r;
}

const evidenceOf = (r: Awaited<ReturnType<typeof stacked>>, id: string) =>
  r.ledger(async ({ store }) => store.runs.listEvidence(id).map((e) => e.passed));

describe("RG-N2-1, RG-N2-2: `sekhemet accept` of a parent restacks its child and re-runs the child's gates", () => {
  it("RG-N2-1: a child that rebases cleanly has its gates run on the rebased branch, recorded as its evidence, and stays In review", async () => {
    const r = await stacked();
    const before = await evidenceOf(r, "kid");
    const out = cliIn(r, ["accept", "par"]);
    expect(out.status, out.stderr).toBe(0);
    const after = await evidenceOf(r, "kid");
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)).toBe(true);
    expect(await statusOf(r, "kid")).toBe("review");
    const branch = r.git("branch", "--list", "--format=%(refname:short)", "sekhemet/*kid*");
    // The rebased branch sits on the new main and holds only the child's own change.
    expect(r.git("merge-base", "--is-ancestor", "main", branch)).toBe("");
    expect(r.git("diff", "--name-only", `main...${branch}`)).toBe("src/c.ts");
    const [restacked] = await eventsOf(r, "par", ["card/restacked"]);
    expect(restacked?.payload).toMatchObject({ ok: true, child: "kid" });
  }, 90_000);

  it("RG-N2-2: a child whose gates fail after the restack goes back to the Worker with the failures, not left In review", async () => {
    const r = await stacked();
    // Another change lands on main before the parent's accept, breaking the child's gate.
    write(r.repo, "src/breaker.ts", "export const broken = true;\n");
    r.git("add", "src/breaker.ts");
    r.git("commit", "-q", "-m", "another accept");
    const out = cliIn(r, ["accept", "par"]);
    expect(out.status, out.stderr).toBe(0);
    expect(await statusOf(r, "par")).toBe("done");
    expect(await statusOf(r, "kid")).toBe("ready");
    expect((await evidenceOf(r, "kid")).at(-1)).toBe(false);
    const dossier = await r.ledger(({ store }) => store.getDossier("kid"));
    expect(dossier.entries.map((e) => e.text).join("\n")).toMatch(/gates failed: \[unit\]/);
  }, 90_000);
});
