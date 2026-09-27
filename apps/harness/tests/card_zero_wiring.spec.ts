import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadGatesConfig } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CARD_ZERO_LABEL,
  SCAFFOLD_GATES_MARKER,
  SCAFFOLD_MAX_TOOL_APPLIED_LINES,
  cardZeroCard,
  cardZeroSteps,
  generatorFor,
  generatorOfCard,
  installScaffoldGate,
} from "../src/card_zero.js";
import { type Kernel, queuePrelude } from "../src/wave2.js";

// design-stage DS-P2-1, -2 in the product: once card zero is Done (a person
// accepted it), the next pass derives the project's gates from what the
// generator left on the tree where accepted work lands — the tracked files;
// the generator's installed packages are ignored there and never merged —
// and writes the generator and its versions into the brief, before card one
// runs. Real git, an on-disk ledger (DEFINITION_OF_DONE §2A).

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function write(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function kernel(): Kernel {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-card0-wire-"));
  dirs.push(repoPath);
  vi.stubEnv("SEKHEMET_USER_CONFIG", join(repoPath, "user-config.toml"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

/** What an accepted card zero leaves on the integration branch: no node_modules. */
function acceptedScaffold(root: string) {
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "calc",
      version: "1.0.0",
      scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
      devDependencies: { typescript: "^5.9.2", vitest: "^3.2.7" },
    }),
  );
  write(
    root,
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "calc" },
        "node_modules/typescript": { version: "5.9.2" },
        "node_modules/vitest": { version: "3.2.7" },
      },
    }),
  );
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
  write(root, ".gitignore", "node_modules\n");
}

describe("card zero's card names its generator", () => {
  it("finds the stack from a card-zero card's steps, and nothing from any other card", () => {
    const zero = cardZeroCard("python");
    expect(generatorOfCard(zero)).toBe("python");
    expect(generatorOfCard(cardZeroCard("typescript"))).toBe("typescript");
    expect(generatorOfCard({ ...zero, labels: [] })).toBeUndefined();
    expect(generatorOfCard({ labels: [CARD_ZERO_LABEL], spec: "write code" })).toBeUndefined();
  });
});

describe("card zero's generator runs as a declared tool step (gates rule 12)", () => {
  it("declares the generator's steps, its ignored directories, and nothing for another card", () => {
    const zero = cardZeroCard("typescript");
    const g = generatorFor("typescript");
    // Create project approved this generator: its steps may reach its registry (DS-P2-1).
    expect(cardZeroSteps(zero)).toEqual({
      tool: "generator",
      steps: g.steps,
      ignored: g.ignored,
      registry: "npm",
    });
    expect(cardZeroSteps(cardZeroCard("python"))?.registry).toBe("python");
    expect(cardZeroSteps({ ...zero, labels: ["card-one"] })).toBeUndefined();
  });

  it("card zero's gates bound the generator's lines on their own, the Worker's as before", () => {
    const k = kernel();
    installScaffoldGate(k.repoPath, "typescript");
    const project = loadGatesConfig(k.repoPath).project;
    expect(project.maxToolAppliedLines).toBe(SCAFFOLD_MAX_TOOL_APPLIED_LINES);
    // A lockfile of a few thousand lines is the generator's, not the Worker's.
    expect(SCAFFOLD_MAX_TOOL_APPLIED_LINES).toBeGreaterThanOrEqual(10_000);
    expect(project.maxDiffLines).toBe(200);
  });
});

describe("the pass after card zero is Done derives the gates (DS-P2-1, -2)", () => {
  it("replaces card zero's gate with the derived ones and records the generator's versions from the lockfile", async () => {
    const k = kernel();
    installScaffoldGate(k.repoPath, "typescript");
    write(k.repoPath, ".sekhemet/brief.md", "# Brief\n\n## Constraints\n- TypeScript.\n");
    const zero = await k.cardStore.createCard({
      ...cardZeroCard("typescript"),
      tier: "task",
      status: "ready",
    });
    for (const s of ["in_progress", "verify", "review", "done"] as const) {
      await k.cardStore.updateCardStatus(zero.id, s, "accepted", "human");
    }
    // Before the generator's output is on the tree, nothing changes.
    const out: string[] = [];
    await queuePrelude(k, [], { print: (l) => out.push(l), setup: "solo" });
    expect(readFileSync(join(k.repoPath, ".sekhemet/gates.toml"), "utf8")).toMatch(
      new RegExp(`^${SCAFFOLD_GATES_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    acceptedScaffold(k.repoPath);
    await queuePrelude(k, [], { print: (l) => out.push(l), setup: "solo" });
    const ids = loadGatesConfig(k.repoPath).gates.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(["typecheck", "unit"]));
    expect(ids).not.toContain("scaffold");
    expect(readFileSync(join(k.repoPath, ".sekhemet/brief.md"), "utf8")).toContain(
      "Generator: npm init, tsc --init and Vitest (TypeScript 5.9.2, Vitest 3.2.7)",
    );
    expect(out.join("\n")).toMatch(/Card zero is done: the project's gates are now/);
    // Again: nothing more is said or changed.
    const before = out.length;
    await queuePrelude(k, [], { print: (l) => out.push(l), setup: "solo" });
    expect(out.slice(before).join("\n")).not.toMatch(/Card zero is done/);
  });

  it("leaves card zero's gate while card zero is not Done", async () => {
    const k = kernel();
    installScaffoldGate(k.repoPath, "typescript");
    acceptedScaffold(k.repoPath);
    await k.cardStore.createCard({ ...cardZeroCard("typescript"), tier: "task", status: "ready" });
    await queuePrelude(k, [], { print: () => undefined, setup: "solo" });
    expect(loadGatesConfig(k.repoPath).gates.map((g) => g.id)).toEqual(["scaffold"]);
  });
});
