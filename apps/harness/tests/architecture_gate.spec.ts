import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { architectureGate, parseInvariants } from "../src/architecture_gate.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "arch-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [f, body] of Object.entries(files)) write(root, f, body);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

function write(root: string, file: string, body: string): void {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), body);
}

const BRIEF = [
  "# Brief",
  "## Constraints",
  "- TypeScript, Node 20.",
  "## Invariants",
  "- `src/db/` does not import `src/cli.ts`",
  "- `PartitionKey` is defined only in `src/types.ts`",
  "- The UI feels fast",
  "## Riskiest assumption",
  "- `src/x.ts` does not import `src/y.ts`",
].join("\n");

describe("the architecture gate", () => {
  it("reads the brief's invariants, and says which it cannot enforce", () => {
    // Prose cannot be checked. An invariant the gate cannot read is reported
    // as not enforced — never silently treated as holding.
    const { rules, unenforced } = parseInvariants(BRIEF);
    expect(rules).toEqual([
      { kind: "no-import", from: "src/db/", to: "src/cli.ts", text: expect.any(String) },
      {
        kind: "defined-only",
        name: "PartitionKey",
        file: "src/types.ts",
        text: expect.any(String),
      },
    ]);
    expect(unenforced).toEqual(["The UI feels fast"]);
  });

  it("fails a card whose change imports across a forbidden boundary", () => {
    const root = repo({ ".sekhemet/brief.md": BRIEF, "src/cli.ts": "", "src/db/store.ts": "" });
    write(root, "src/db/store.ts", 'import { run } from "../cli.js";\n');
    const [f] = architectureGate(root);
    expect(f?.gate).toBe("architecture");
    expect(f?.location?.file).toBe("src/db/store.ts");
    expect(f?.suggestedAction).toMatch(/src\/db\/ does not import src\/cli\.ts/);
  });

  it("fails a second definition of a name the brief gives one home", () => {
    // The failure that motivated this gate: three incompatible definitions of
    // one partition key, each reasonable where it was written.
    const root = repo({ ".sekhemet/brief.md": BRIEF, "src/types.ts": "", "src/ledger.ts": "" });
    write(root, "src/ledger.ts", "export type PartitionKey = string;\n");
    const [f] = architectureGate(root);
    expect(f?.gate).toBe("architecture");
    expect(f?.suggestedAction).toMatch(/import it from src\/types\.ts/);
  });

  it("allows the definition in its home, and judges only files the card changed", () => {
    const root = repo({
      ".sekhemet/brief.md": BRIEF,
      "src/cli.ts": "",
      "src/db/old.ts": 'import "../cli.js";\n',
      "src/types.ts": "",
    });
    write(root, "src/types.ts", "export type PartitionKey = string;\n");
    expect(architectureGate(root)).toEqual([]);
  });

  it("enforces nothing when the project declares nothing", () => {
    const root = repo({ "src/a.ts": "" });
    write(root, "src/a.ts", 'import "./b.js";\n');
    expect(architectureGate(root)).toEqual([]);
  });
});
