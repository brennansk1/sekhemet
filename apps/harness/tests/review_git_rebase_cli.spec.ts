import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Turn, WORKER, scriptedTurnsProject } from "./support/g6_models.js";
import { BIN, eventsOf, g6Repo, statusOf } from "./support/g6_review.js";

/**
 * review-git NEW-review-git-1 at the door (C2d, FINDINGS_C1 TST-01): a
 * spawned `sekhemet queue` runs card `c1` (scope `src/a.ts`) with a scripted
 * Worker while another accepted card lands on main under it, so the rebase
 * before Verify conflicts. Real git, a real ledger, the built command; the
 * Worker's requests are read back from the preload's log.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const write = (path: string, content: string) => ({
  name: "write_file",
  arguments: { path, content },
});
const finish = { name: "finish_card", arguments: {} };

async function queue(turns: Turn[], stepBudget: number) {
  const r = g6Repo();
  const project = await scriptedTurnsProject(r, turns, { stepBudget });
  const log = join(r.root, "worker-requests.jsonl");
  const out = spawnSync(process.execPath, [...project.nodeArgs, BIN, "queue", "--worker", WORKER], {
    cwd: r.repo,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...r.env({ env: project.env }), G6_REQUEST_LOG: log },
  });
  const requests = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { r, out: out.stdout + out.stderr, requests };
}

describe("RG-N1-1, RG-N1-3: a rebase conflict before Verify, through `sekhemet queue`", () => {
  it("RG-N1-1: a conflict inside the card's scope goes back to the Worker as one typed failure per file naming its hunks, within the budget; resolved, the card reaches Review on top of main", async () => {
    const { r, out, requests } = await queue(
      [
        {
          main: { file: "src/a.ts", content: "export const a = 99;\n" },
          calls: [write("src/a.ts", "export const a = 2;\n"), finish],
        },
        { calls: [write("src/a.ts", "export const a = 99 + 2;\n"), finish] },
      ],
      5,
    );
    expect(requests.length, out).toBe(2);
    // The Worker's second request carries the conflict: the file, the rebase, the hunk.
    const second = requests[1] as string;
    expect(second).toContain("rebase");
    expect(second).toContain("src/a.ts");
    expect(second).toContain("<<<<<<<");
    expect(second).toContain("export const a = 99;");
    expect(await statusOf(r, "c1"), out).toBe("review");
    const [conflict] = await eventsOf(r, "c1", ["card/rebase_conflict"]);
    expect(conflict?.payload).toMatchObject({
      files: ["src/a.ts"],
      outOfScope: [],
      returnedToWorker: true,
    });
    const wt = join(r.repo, ".sekhemet", "worktrees", "c1");
    const onWt = (...a: string[]) =>
      spawnSync("git", a, { cwd: wt, encoding: "utf8" }).stdout.trim();
    expect(onWt("merge-base", "HEAD", "main")).toBe(r.git("rev-parse", "main"));
    expect(readFileSync(join(wt, "src", "a.ts"), "utf8")).toBe("export const a = 99 + 2;\n");
  }, 150_000);

  it("RG-N1-3: the budget ending with the conflict unresolved posts one decision request naming both cards", async () => {
    const { r, out, requests } = await queue(
      [
        {
          main: { file: "src/a.ts", content: "export const a = 99;\n" },
          calls: [write("src/a.ts", "export const a = 2;\n"), finish],
        },
        { calls: [{ name: "read_file", arguments: { path: "src/a.ts" } }] },
      ],
      3,
    );
    expect(requests.length, out).toBeGreaterThanOrEqual(2);
    const decisions = await r.ledger(({ store }) => store.runs.listDecisions("pending"));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ cardId: "c1", kind: "rebase_conflict" });
    expect(decisions[0]?.question).toContain("c1");
    expect(decisions[0]?.question).toContain("card_other");
    expect(decisions[0]?.context).toContain("src/a.ts");
    const [conflict] = await eventsOf(r, "c1", ["card/rebase_conflict"]);
    expect(conflict?.payload).toMatchObject({ files: ["src/a.ts"], returnedToWorker: true });
  }, 150_000);
});
