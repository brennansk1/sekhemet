import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Turn, WORKER, scriptedTurnsProject } from "./support/g6_models.js";
import { BIN, g6Repo } from "./support/g6_review.js";

/**
 * security item 10a (NEW-security-13, SEC-N13-2) at the door (C2d,
 * FINDINGS_C1 TST-01): the built command (`apps/harness/dist/index.js`)
 * spawned as `sekhemet queue` in a workspace laid out as every install
 * before DEC-57 is — the workspace folder is the project's own root, so the
 * card's worktree is `<root>/.sekhemet/worktrees/c1` beside the workspace's
 * ledger, evidence and another card's worktree. The scripted Worker's
 * command tries each; what it was told is read back from its requests.
 */

const SYNC = resolve(import.meta.dirname, "../../../packages/sync/dist/index.js");

describe("SEC-N13-2: a card in the workspace folder's own project", () => {
  it("SEC-N13-2: the card reads and writes its worktree and reads the rest of its root, and is denied the workspace's ledger, evidence and another card's worktree beside it", async () => {
    const r = g6Repo();
    const R = r.repo;
    // One probe per path, each printing NAME=0 when it succeeded and NAME=1 when refused.
    const probe = `const fs = require("fs");
const R = ${JSON.stringify(R)};
const t = (k, f) => { try { f(); console.log(k + "=0"); } catch (e) { console.log(k + "=1 " + e.code); } };
t("OWN", () => fs.writeFileSync("mine.txt", "mine\\n"));
t("ROOT", () => fs.readFileSync(R + "/src/shared.ts"));
t("DB", () => fs.readFileSync(R + "/.sekhemet/events.db"));
t("EVIDENCE", () => fs.readFileSync(R + "/.sekhemet/evidence/canary.json"));
t("OTHER_READ", () => fs.readFileSync(R + "/.sekhemet/worktrees/c2/src/a.ts"));
t("OTHER_WRITE", () => fs.writeFileSync(R + "/.sekhemet/worktrees/c2/stolen", "x"));`;
    const turns: Turn[] = [
      { calls: [{ name: "run_cmd", arguments: { command: "node", args: ["-e", probe] } }] },
      {
        calls: [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 2;\n" } },
          { name: "finish_card", arguments: {} },
        ],
      },
    ];
    const project = await scriptedTurnsProject(r, turns, { stepBudget: 3 });
    // The workspace's evidence folder holds another card's bundle.
    mkdirSync(join(R, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(join(R, ".sekhemet", "evidence", "canary.json"), '{"canary":true}\n');
    // Another card's worktree, live beside this one.
    const made = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { NodeGitSyncAdapter } = await import(${JSON.stringify(SYNC)});
         await new NodeGitSyncAdapter(${JSON.stringify(R)}).createWorktree("c2", "main", "Other");`,
      ],
      { encoding: "utf8", env: r.env() },
    );
    expect(made.status, made.stderr).toBe(0);
    const requests = join(r.root, "worker-requests.jsonl");
    const out = spawnSync(
      process.execPath,
      [...project.nodeArgs, BIN, "queue", "--worker", WORKER],
      {
        cwd: R,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...r.env({ env: project.env }), G6_REQUEST_LOG: requests },
      },
    );
    const told = readFileSync(requests, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.stringify(JSON.parse(l).messages))
      .join("\n");
    expect(told, out.stdout + out.stderr).toMatch(/OWN=0/);
    expect(told).toMatch(/ROOT=0/);
    expect(told).toMatch(/DB=1/);
    expect(told).toMatch(/EVIDENCE=1/);
    expect(told).toMatch(/OTHER_READ=1/);
    expect(told).toMatch(/OTHER_WRITE=1/);
    expect(readFileSync(join(R, ".sekhemet", "worktrees", "c1", "mine.txt"), "utf8")).toBe(
      "mine\n",
    );
    expect(existsSync(join(R, ".sekhemet", "worktrees", "c2", "stolen"))).toBe(false);
  }, 150_000);
});
