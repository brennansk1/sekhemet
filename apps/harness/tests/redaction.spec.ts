import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { annotationsFromFailures } from "@sekhemet/sync";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard } from "../src/execute.js";
import { initLocalKernel } from "../src/index.js";

/**
 * S3c, security item 34 (SEC-22): a secret the Worker reads is stored only
 * in its redacted form — in the ledger, the blobs, the observations, the
 * transcript, the evidence bundle and a GitHub annotation built from it.
 * Real git, real SQLite, real commands; every byte under `.sekhemet/` is
 * searched, the ledger's WAL included.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A fake GitHub token: gitleaks' `github-pat` shape, never a real one.
const TOKEN = `ghp_${"Z9y8X7w6V5u4T3s2R1q0".repeat(2).slice(0, 36)}`;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("S3c: redaction before persistence", () => {
  it("SEC-22: a seeded fake key the Worker reads is stored only redacted", async () => {
    const repo = mkdtempSync(join(tmpdir(), "redact-"));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.ts"), "");
    writeFileSync(join(repo, "src", "config.ts"), `export const token = "${TOKEN}";\n`);
    // The gate prints the key too, so the evidence's failure excerpt holds it.
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "console.log(require('fs').readFileSync('src/config.ts','utf8')); process.exit(1)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");

    const k = initLocalKernel(repo);
    const card = await k.cardStore.createCard({
      id: "card_sec",
      tier: "story",
      title: "Write a (SPIDR: Path)",
      scopeFiles: ["src/a.ts"],
      acceptanceCriteria: ["exports a"],
      spec: "Write src/a.ts",
      status: "ready",
      stepBudget: 4,
    });
    let n = 0;
    const adapter: LocalInferenceAdapter = {
      modelId: "scripted",
      supportedArms: ["arm_a_flat"],
      generate: async () => {
        n++;
        const calls: Omit<ToolCall, "id">[] =
          n === 1
            ? [{ name: "read_file", arguments: { path: "src/config.ts" } }]
            : n === 2
              ? [{ name: "run_cmd", arguments: { command: "cat src/config.ts" } }]
              : n === 3
                ? [
                    {
                      name: "write_file",
                      arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
                    },
                  ]
                : [{ name: "finish_card", arguments: {} }];
        return {
          text: "",
          toolCalls: calls.map((c, i) => ({ id: `t${n}-${i}`, ...c })),
          usage: { promptTokens: 10, completionTokens: 2, durationMs: 1 },
        };
      },
    };
    const result = await executeCard(
      {
        repoPath: repo,
        restrictedMode: false,
        cardStore: k.cardStore,
        boardService: k.boardService,
        log: () => {},
        headroomCheck: false,
      },
      card,
      adapter,
    );
    k.db.close();

    const redacted = `${TOKEN.slice(0, 4)}…${TOKEN.slice(-2)}`;
    // Nothing under .sekhemet — ledger, WAL, blobs, observations, transcripts,
    // evidence — holds the key; the worktree itself is the repository's own file.
    const stored = filesUnder(join(repo, ".sekhemet")).filter(
      (f) => !f.includes(`${join(".sekhemet", "worktrees")}`),
    );
    const holding = stored.filter((f) => readFileSync(f).includes(TOKEN));
    expect(holding).toEqual([]);
    const everything = stored.map((f) => readFileSync(f, "latin1")).join("\n");
    expect(everything).toContain(Buffer.from(redacted).toString("latin1"));
    // The evidence the GitHub annotations are built from holds only the redacted form.
    const failures = result.evidence.failures;
    expect(failures.length).toBeGreaterThan(0);
    const annotations = JSON.stringify(annotationsFromFailures(failures as never));
    expect(annotations).not.toContain(TOKEN);
    expect(JSON.stringify(result.evidence)).not.toContain(TOKEN);
  }, 60_000);
});
