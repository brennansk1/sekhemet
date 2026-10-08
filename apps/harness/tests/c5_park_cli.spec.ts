import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ledgerRows, until } from "./support/g2_cli.js";
import { type EngineTurn, startEngine, workerRequests } from "./support/g4_engine.js";
import { queueProject, runQueueOn } from "./support/g4_queue.js";

/**
 * Cards the runner parks are parked on the real board (review-git RG-N1-2,
 * RG-N1-3; worker-loop rule 31; C2d findings routed to C5): `sekhemet queue`
 * spawned as the built binary (`apps/harness/dist/index.js`,
 * `support/g4_queue.ts`) over a real repository, real git and a real ledger,
 * the board's entry conditions on. The Worker is a scripted engine in its own
 * process (`support/g4_engine.ts`); no model is loaded.
 */

const FILES = {
  "src/a.ts": "export const a = 0;\n",
  "src/b.ts": "export const b = 0;\n",
  "src/main.ts": 'import { a } from "./a.js";\nimport { b } from "./b.js";\nconsole.log(a, b);\n',
};

const card = (stepBudget: number) => ({
  id: "c1",
  tier: "story" as const,
  title: "Change a",
  scopeFiles: ["src/a.ts"],
  stepBudget,
  spec: "Set a to 2 in src/a.ts",
});

/** The card's column, read back from the ledger's cards table. */
function statusOf(repo: string): string | undefined {
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT status FROM cards WHERE id = 'c1'").get() as { status?: string })
      ?.status;
  } finally {
    db.close();
  }
}

/** Commit `text` to `file` on main while the card runs. */
function mainMoves(repo: string, file: string, text: string): void {
  writeFileSync(join(repo, file), text);
  execFileSync("git", ["commit", "-qam", `main moved ${file}`], { cwd: repo });
}

describe("a rebase conflict parks the card on the board (RG-N1-2, RG-N1-3)", () => {
  it("RG-N1-2: a conflict touching a file outside the card's scope parks the card with the files named, and a decision request asks a person", async () => {
    const p = await queueProject({ files: FILES, cards: [card(4)] });
    const signal = join(p.home, "moved");
    const turns: EngineTurn[] = [
      {
        waitFor: signal,
        calls: [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 2;\n" } },
          { name: "finish_card" },
        ],
      },
    ];
    const engine = await startEngine(p.home, turns);
    const running = runQueueOn(p, engine);
    await until(() => workerRequests(engine).length >= 1, 90_000);
    mainMoves(p.repo, "src/b.ts", "export const b = 7;\n");
    // A side effect outside the declared scope (a formatter, a generator).
    writeFileSync(
      join(p.repo, ".sekhemet", "worktrees", "c1", "src", "b.ts"),
      "export const b = 8;\n",
    );
    writeFileSync(signal, "");
    const r = await running;
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/rebase conflict/);
    expect(statusOf(p.repo), out).toBe("parked");
    expect(out).not.toMatch(/parked refused/);
    const decisions = ledgerRows(p.repo).filter(
      (e) => e.type === "decision/requested" && e.cardId === "c1",
    );
    expect(decisions.length, out).toBe(1);
    expect(JSON.stringify(decisions[0]?.payload)).toMatch(/src\/b\.ts/);
  }, 180_000);

  it("RG-N1-3: a conflict still unresolved when the budget ends posts one decision request and parks the card", async () => {
    const p = await queueProject({ files: FILES, cards: [card(1)] });
    const signal = join(p.home, "moved");
    const engine = await startEngine(p.home, [
      {
        waitFor: signal,
        calls: [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 2;\n" } },
          { name: "finish_card" },
        ],
      },
    ]);
    const running = runQueueOn(p, engine);
    await until(() => workerRequests(engine).length >= 1, 90_000);
    mainMoves(p.repo, "src/a.ts", "export const a = 99;\n");
    writeFileSync(signal, "");
    const r = await running;
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/rebase conflict/);
    expect(statusOf(p.repo), out).toBe("parked");
    const decisions = ledgerRows(p.repo).filter(
      (e) => e.type === "decision/requested" && e.cardId === "c1",
    );
    expect(decisions.length, out).toBe(1);
  }, 180_000);
});

describe("a park before any attempt names its stop reason (worker-loop rule 31)", () => {
  it("WL-T3-2: a card stopped vacuous_tests before any step is parked on the board, not held with 'no reason to park'", async () => {
    const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
    const VITEST = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
    const TEST = `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds nothing to nothing", () => { expect(add(0, 0)).toBe(0); });
`;
    const p = await queueProject({
      files: {
        "package.json": '{ "name": "s", "type": "module", "private": true }\n',
        "src/keep.ts": "export const keep = 1;\n",
        "acceptance/a.spec.ts": TEST,
        ".sekhemet/gates.toml": `[[gate]]\nid = "unit"\nrung = "test"\ncommand = "node"\nargs = [${JSON.stringify(VITEST)}, "run"]\nparser = "vitest"\ntimeout_s = 120\n`,
      },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Add math",
          scopeFiles: ["src/math.ts"],
          stepBudget: 4,
          spec: "Add add().",
          acceptanceTests: ["a.spec.ts"],
        },
      ],
      seed: async (store) => {
        await store.recordEvent({
          type: "test/staged",
          cardId: "c1",
          actor: "planner",
          payload: {
            cardId: "c1",
            path: "tests/a.spec.ts",
            sha256: createHash("sha256").update(TEST).digest("hex"),
            author: "planner",
          },
        });
      },
    });
    const engine = await startEngine(p.home, [{ calls: [{ name: "finish_card" }] }]);
    const r = await runQueueOn(p, engine);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/\(vacuous_tests\)/);
    expect(out).not.toMatch(/no reason to park/);
    expect(statusOf(p.repo), out).toBe("parked");
  }, 180_000);
});
