import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratch, until } from "./support/g2_cli.js";
import { type EngineTurn, startEngine, workerRequests } from "./support/g4_engine.js";
import { queueProject, runQueueOn } from "./support/g4_queue.js";

/**
 * C5's core safety findings (C2d review, routed to C5) through the built
 * binary (`apps/harness/dist/index.js`, spawned by `support/g4_queue.ts`)
 * over a real repository, real git and a real ledger. The Worker is a
 * scripted engine in its own process (`support/g4_engine.ts`); no model is
 * loaded and nothing leaves the machine.
 */

const BASE = { "src/a.ts": "" };
const card = {
  id: "c1",
  tier: "story" as const,
  title: "Write a",
  scopeFiles: ["src/a.ts"],
  stepBudget: 6,
  spec: "Export a from src/a.ts",
};

describe("SEC-2: a rewritten .git pointer runs no git command there", () => {
  it("SEC-2: the pointer rewritten mid-card to another repository stops the card git_metadata_tampered and leaves that repository's index untouched", async () => {
    const p = await queueProject({ files: BASE, cards: [card] });
    const signal = join(p.home, "tampered");
    const turns: EngineTurn[] = [
      {
        calls: [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
        ],
      },
      { waitFor: signal, calls: [{ name: "finish_card" }] },
    ];
    const engine = await startEngine(p.home, turns);
    const other = scratch("sek-evil-");
    execFileSync("git", ["init", "-q"], { cwd: other });
    mkdirSync(join(other, "src"), { recursive: true });
    const running = runQueueOn(p, engine);
    await until(() => workerRequests(engine).length >= 2, 90_000);
    writeFileSync(
      join(p.repo, ".sekhemet", "worktrees", "c1", ".git"),
      `gitdir: ${join(other, ".git")}\n`,
    );
    writeFileSync(signal, "");
    const r = await running;
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/git_metadata_tampered/);
    // No git command ran against the other repository: its index is empty.
    const staged = execFileSync("git", ["ls-files", "--stage"], { cwd: other, encoding: "utf8" });
    expect(staged, out).toBe("");
  }, 180_000);
});
