import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import type { GateResult, GateRunner } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  INVARIANT_FORMS,
  unenforcedInvariants,
  withArchitectureGate,
} from "../src/architecture_gate.js";
import { startDashboardServer } from "../src/server.js";

// NEW-gates-1 (gates rule 26, GT-N1-1): a line in the brief's Invariants
// section that matches neither enforced form is shown to a person as "not
// enforced", with the two forms it could be restated in — on the board (the
// gate contract the dashboard reads) and in the evidence of every card.

const BRIEF = `# Brief

## Invariants
<!-- Checked on every card. Two forms are enforced:
- \`src/db/\` does not import \`src/cli.ts\`
-->
- \`src/db/\` does not import \`src/cli.ts\`
- \`Money\` is defined only in \`src/types.ts\`
- Amounts are always integer cents.
- The API never returns a stack trace

## Later
- Not an invariant.
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWithBrief(brief: string | undefined): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "invariants-")));
  dirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  if (brief !== undefined) {
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(join(root, ".sekhemet", "brief.md"), brief);
  }
  return root;
}

describe("unenforced invariants shown to a person (GT-N1-1)", () => {
  it("lists each line matching neither form, with the two forms it could be restated in", () => {
    const root = repoWithBrief(BRIEF);
    const lines = unenforcedInvariants(join(root, ".sekhemet", "brief.md"));
    expect(lines.map((l) => l.line)).toEqual([
      "Amounts are always integer cents.",
      "The API never returns a stack trace",
    ]);
    for (const l of lines) expect(l.restate).toEqual([...INVARIANT_FORMS]);
    expect(INVARIANT_FORMS).toEqual([
      "`A/` does not import `B`",
      "`Name` is defined only in `path`",
    ]);
  });

  it("lists nothing without a brief, or when every line is enforced", () => {
    expect(unenforcedInvariants(join(repoWithBrief(undefined), ".sekhemet", "brief.md"))).toEqual(
      [],
    );
    const root = repoWithBrief("## Invariants\n- `Money` is defined only in `src/types.ts`\n");
    expect(unenforcedInvariants(join(root, ".sekhemet", "brief.md"))).toEqual([]);
  });

  it("names the unenforced lines in the architecture gate's outcome, so every card's evidence carries them", async () => {
    const root = repoWithBrief(BRIEF);
    const inner: GateRunner = {
      runGates: async (): Promise<GateResult> => ({
        passed: true,
        failures: [],
        durationMs: 0,
        rungResults: [],
      }),
    };
    const r = await withArchitectureGate(inner, {
      briefPath: join(root, ".sekhemet", "brief.md"),
    }).runGates(["lint"], root);
    const outcome = r.rungResults?.find((o) => o.gate === "architecture");
    expect(outcome?.passed).toBe(true);
    expect(outcome?.note).toContain("2 invariant lines in the brief are not enforced");
    expect(outcome?.note).toContain("Amounts are always integer cents.");
  });

  it("serves them with the gate contract the board reads", async () => {
    const root = repoWithBrief(BRIEF);
    const db = new DatabaseSync(join(root, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: root,
      port: 0,
      streamIntervalMs: 50,
    });
    try {
      const data = (await (await fetch(`http://127.0.0.1:${server.port}/api/gates`)).json()) as {
        invariants: { notEnforced: { line: string; restate: string[] }[] };
      };
      expect(data.invariants.notEnforced.map((l) => l.line)).toEqual([
        "Amounts are always integer cents.",
        "The API never returns a stack trace",
      ]);
      expect(data.invariants.notEnforced[0]?.restate).toEqual([...INVARIANT_FORMS]);
    } finally {
      await server.close();
      db.close();
    }
  });
});
