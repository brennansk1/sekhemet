import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { annotationsFromFailures } from "@sekhemet/sync";
import { describe, expect, it } from "vitest";
import { type Turn, WORKER, scriptedTurnsProject } from "./support/g6_models.js";
import { BIN, g6Repo, write } from "./support/g6_review.js";

/**
 * security item 34 (SEC-22) at the door (C2d, FINDINGS_C1 TST-01): a spawned
 * `sekhemet queue` whose scripted Worker reads a file holding a seeded fake
 * key, prints it with a command, and whose gate prints it too. Afterwards
 * every byte the product stored — the ledger and its WAL, the blobs, the
 * observations, the evidence bundles, the user directory — is searched.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

// A fake GitHub token: gitleaks' `github-pat` shape, never a real one.
const TOKEN = `ghp_${"Z9y8X7w6V5u4T3s2R1q0".repeat(2).slice(0, 36)}`;
const REDACTED = `${TOKEN.slice(0, 4)}…${TOKEN.slice(-2)}`;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("SEC-22: a seeded fake key the Worker reads is stored only redacted", () => {
  it("SEC-22: after `sekhemet queue`, no file the product wrote holds the key; the evidence and the annotations built from it hold only its redacted form", async () => {
    const r = g6Repo();
    const turns: Turn[] = [
      { calls: [{ name: "read_file", arguments: { path: "src/config.ts" } }] },
      { calls: [{ name: "run_cmd", arguments: { command: "cat src/config.ts" } }] },
      {
        calls: [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 2;\n" } },
          { name: "finish_card", arguments: {} },
        ],
      },
    ];
    const project = await scriptedTurnsProject(r, turns, { stepBudget: 4 });
    write(r.repo, "src/config.ts", `export const token = "${TOKEN}";\n`);
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "config");
    // The gate prints the key too, so the evidence's failure excerpt holds it.
    write(
      r.repo,
      ".sekhemet/gates.toml",
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "console.log(require('fs').readFileSync('src/config.ts','utf8')); process.exit(1)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    const out = spawnSync(
      process.execPath,
      [...project.nodeArgs, BIN, "queue", "--worker", WORKER],
      {
        cwd: r.repo,
        encoding: "utf8",
        timeout: 120_000,
        env: r.env({ env: project.env }),
      },
    );
    expect(out.stdout, out.stderr).toMatch(/turn: read_file/);
    expect(out.stdout).toMatch(/turn: run_cmd/);

    // Everything stored under .sekhemet (but the worktree, the repository's own
    // file) and under the user directory.
    const stored = [
      ...filesUnder(join(r.repo, ".sekhemet")).filter(
        (f) => !f.includes(join(".sekhemet", "worktrees")),
      ),
      ...filesUnder(r.home).filter((f) => !f.endsWith(".mjs")),
    ];
    expect(stored.some((f) => f.endsWith("events.db"))).toBe(true);
    expect(stored.filter((f) => readFileSync(f).includes(TOKEN))).toEqual([]);
    const everything = stored.map((f) => readFileSync(f, "latin1")).join("\n");
    expect(everything).toContain(Buffer.from(REDACTED).toString("latin1"));

    // The evidence the GitHub annotations are built from.
    const bundles = filesUnder(join(r.repo, ".sekhemet", "evidence")).filter((f) =>
      f.endsWith(".json"),
    );
    expect(bundles.length).toBeGreaterThan(0);
    const failures = bundles.flatMap(
      (f) => (JSON.parse(readFileSync(f, "utf8")) as { failures?: unknown[] }).failures ?? [],
    );
    expect(failures.length).toBeGreaterThan(0);
    const annotations = JSON.stringify(annotationsFromFailures(failures as never));
    expect(annotations).not.toContain(TOKEN);
    expect(JSON.stringify(failures)).toContain(REDACTED);
  }, 150_000);
});
