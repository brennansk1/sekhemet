import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { acceptBrief } from "@sekhemet/planner";
import { NodeGitSyncAdapter, readBranchFile } from "@sekhemet/sync";
import { describe, expect, it } from "vitest";
import { recordReviewOpened } from "../src/accept.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { cli, g2Dirs, g2Env, ledgerRows } from "./support/g2_cli.js";

/**
 * A merged edit to a generated project document comes back as proposals
 * (design-stage §2.3, DS-N3-2; FINISH_LINE_PLAN C2d): the documents exported
 * by a spawned `sekhemet release docs`, an issue whose branch edits the
 * requirements by hand accepted by a spawned `sekhemet accept`, and the
 * proposals listed and applied by spawned `release docs` commands. Real git,
 * the real ledger file; no model.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe("sekhemet accept of an edit to the generated requirements (DS-N3-2)", () => {
  it("DS-N3-2: the merged edit becomes one proposal per difference, and the ledger changes only when a person applies one", async () => {
    const where = g2Dirs();
    const repo = where.cwd;
    const env = g2Env(where.home);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    put(repo, ".gitignore", ".sekhemet/\n");
    put(repo, "src/a.ts", "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "chore: seed");
    // The accepted brief: one requirement with one criterion.
    {
      const { db, log } = openLocalLedger(repo);
      try {
        const store = new CardStore(db, log);
        const board = new BoardServiceImpl(store);
        const projectId = (await store.ensureProject({ rootPath: repo, name: "Recipes" })).id;
        await acceptBrief(
          { store, log, board },
          {
            projectId,
            baseline: "Recipes live in a shared spreadsheet",
            slices: [
              {
                title: "Walking skeleton",
                appetite: { cards: 6 },
                requirements: [
                  {
                    key: "save",
                    title: "Save a recipe",
                    kano: "must-be",
                    criteria: [
                      { id: "save.1", text: "WHEN a recipe is saved THE SYSTEM SHALL list it" },
                    ],
                  },
                ],
              },
            ],
          },
          store.localPrincipal(),
        );
      } finally {
        db.close();
      }
    }
    const exported = await cli(["release", "docs"], { cwd: repo, env });
    expect(exported.status, exported.stdout + exported.stderr).toBe(0);
    const generated = readBranchFile(repo, "main", "docs/product/requirements.md") as string;
    expect(generated).toContain("### REQ-1 — Save a recipe");
    git("checkout", "-q", "-f", "main");

    // An issue whose branch edits the requirements by hand, in Review.
    const edited = generated
      .replace("### REQ-1 — Save a recipe", "### REQ-1 — Save and share a recipe")
      .replace(
        "- `save.1` WHEN a recipe is saved THE SYSTEM SHALL list it",
        "- `save.1` WHEN a recipe is saved THE SYSTEM SHALL list it first",
      );
    {
      const { db, log } = openLocalLedger(repo);
      try {
        const store = new CardStore(db, log);
        const board = new BoardServiceImpl(store);
        const me = log.localPrincipal();
        await store.createCard({
          id: "c1",
          tier: "story",
          title: "Retitle REQ-1",
          scopeFiles: ["docs/**"],
        });
        await store.delegateCard("c1", { kind: "worker" }, me);
        const adapter = new NodeGitSyncAdapter(repo);
        const wt = await adapter.createWorktree("c1", "main", "Retitle REQ-1");
        put(wt, "docs/product/requirements.md", edited);
        await adapter.commitCheckpoint({
          cardId: "c1",
          step: 1,
          gateStatus: "pass",
          agentModel: "scripted",
          agentHarness: "sekhemet",
          agentRole: "implementer",
        });
        const evidence = {
          id: "ev_c1",
          cardId: "c1",
          attempt: 1,
          passed: true,
          rungResults: [
            {
              gate: "unit",
              rung: "test",
              layer: "functional",
              passed: true,
              exitCode: 0,
              durationMs: 5,
            },
          ],
          filesTouched: ["docs/product/requirements.md"],
          linesAdded: 2,
          linesRemoved: 2,
          settings: { modelId: "scripted" },
          stopReason: "gate_passed",
          repoState: await adapter.getRepoStateHash("c1"),
        };
        const body = `${JSON.stringify(evidence, null, 2)}\n`;
        put(repo, ".sekhemet/evidence/ev_c1.json", body);
        await recordLedgerRun(store, {
          cardId: "c1",
          modelId: "scripted",
          passed: true,
          stopReason: "gate_passed",
          evidenceId: "ev_c1",
          path: join(".sekhemet", "evidence", "ev_c1.json"),
          body,
          filesTouched: evidence.filesTouched,
        });
        await store.updateCardStatus("c1", "review", "verified", "harness", { override: true });
        const card = await store.getCard("c1");
        if (!card) throw new Error("no c1");
        await recordReviewOpened({ repoPath: repo, cardStore: store, boardService: board }, card, [
          "docs/product/requirements.md",
        ]);
      } finally {
        db.close();
      }
    }
    const accepted = await cli(["accept", "c1"], { cwd: repo, env });
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(accepted.stdout).toMatch(/Accepted c1/);

    // One proposal per difference, recorded against the merged commit; the
    // person's edit stays on main and the requirement is unchanged.
    expect(readBranchFile(repo, "main", "docs/product/requirements.md")).toBe(edited);
    const listed = await cli(["release", "docs", "proposals"], { cwd: repo, env });
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/DOCP-1 .*REQ-1 title/);
    expect(listed.stdout).toMatch(/DOCP-2 .*REQ-1 criteria/);
    expect(listed.stdout).not.toMatch(/DOCP-3/);
    const versions = () =>
      ledgerRows(repo)
        .filter((x) => x.type.startsWith("requirement/") && x.payload.id === "REQ-1")
        .map((x) => x.payload.version);
    expect(Math.max(...(versions() as number[]))).toBe(1);

    // A person applies the title's: only then does the ledger change.
    const applied = await cli(["release", "docs", "apply", "DOCP-1"], { cwd: repo, env });
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toMatch(/DOCP-1 applied/);
    expect(Math.max(...(versions() as number[]))).toBe(2);
  }, 180_000);
});
