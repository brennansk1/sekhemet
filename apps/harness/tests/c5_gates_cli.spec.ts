import { chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GateProject, gateProject } from "./support/g4_gate.js";
import { gateCard } from "./support/g4_queue.js";

/**
 * The project gates fail closed (gates rules 9 and 28b; GT-T1-2, GT-IX-1;
 * C2d findings routed to C5): `sekhemet gate <card>` spawned as the built
 * binary (`apps/harness/dist/index.js`, `support/g4_queue.ts`) over a real
 * repository and the card's real worktree, a file made unreadable with
 * chmod. No model is reached.
 */

const LINT = `[[gate]]\nid = "lint"\nrung = "lint"\ncommand = "sh"\nargs = ["-c", "exit 0"]\nparser = "generic"\n`;
const BRIEF = "# Brief\n\n## Invariants\n\n- `src/db/` does not import `src/cli.ts`\n";

/** The printed outcome line of `gate`: its mark (✓ ✗ ! -) and its reason. */
function outcome(out: string, gate: string): { mark: string; reason: string } | undefined {
  const re = new RegExp(`^\\s+([✓✗!-]) ${gate} \\(\\d+ ms\\)(?: — (.*))?$`, "m");
  const m = re.exec(out);
  return m ? { mark: m[1] as string, reason: m[2] ?? "" } : undefined;
}

const run = async (p: GateProject) => {
  const r = await gateCard(p);
  return { ...r, all: `${r.stdout}\n${r.stderr}` };
};

describe("an unreadable changed file is partial, never 'no exports' (GT-IX-1, rules 9 and 28b)", () => {
  it("GT-IX-1: a changed file the source index cannot read fails reachability and architecture with the reason, never a pass", async () => {
    const p = await gateProject({
      files: { ".sekhemet/gates.toml": LINT, ".sekhemet/brief.md": BRIEF, "src/cli.ts": "" },
      card: {
        "src/db/a.ts": 'import { run } from "../cli.js";\nexport const unused = run;\n',
      },
    });
    const file = join(p.worktree, "src", "db", "a.ts");
    chmodSync(file, 0o000);
    try {
      const r = await run(p);
      expect(r.status, r.all).toBe(1);
      for (const gate of ["reachability", "architecture"]) {
        const o = outcome(r.stdout, gate);
        expect(o?.mark, `${gate}\n${r.all}`).not.toBe("✓");
        expect(o).toBeDefined();
      }
      expect(r.stderr).toMatch(/\[reachability\] src\/db\/a\.ts: .*could not be read/);
      expect(r.stderr).toMatch(/\[architecture\] src\/db\/a\.ts: .*could not be read/);
    } finally {
      chmodSync(file, 0o644);
    }
  });
});

describe("a project gate that throws keeps every other gate's outcome (GT-T1-2)", () => {
  it("GT-T1-2: an unreadable brief makes the architecture gate unavailable with the error, and lint, licenses, trailers, reachability and regression still print their outcomes", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": LINT,
        ".sekhemet/brief.md": BRIEF,
        "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n',
        "src/a.ts": "",
      },
      card: { "src/a.ts": "export const a = 1;\n" },
    });
    const brief = join(p.worktree, ".sekhemet", "brief.md");
    const inRepo = join(p.repo, ".sekhemet", "brief.md");
    chmodSync(inRepo, 0o000);
    try {
      chmodSync(brief, 0o000);
    } catch {
      // The worktree has no brief of its own: the repository's is read.
    }
    try {
      const r = await run(p);
      expect(r.status, r.all).toBe(1);
      const arch = outcome(r.stdout, "architecture");
      expect(arch?.mark, r.all).toBe("!");
      expect(arch?.reason).toMatch(/brief/);
      expect(outcome(r.stdout, "lint")?.mark, r.all).toBe("✓");
      for (const gate of ["licenses", "trailers", "reachability", "regression"])
        expect(outcome(r.stdout, gate), `${gate}\n${r.all}`).toBeDefined();
    } finally {
      chmodSync(inRepo, 0o644);
      try {
        chmodSync(brief, 0o644);
      } catch {
        // As above.
      }
    }
  });
});
