import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, checklistRowsFor, initSchema } from "@sekhemet/kernel";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { checkTestStrength } from "../src/test_strength.js";
import type { GateDefinition } from "../src/types.js";

// design-stage DS-P14-3 (gates rule 32a): the strength rule comes from the
// depth profile a person recorded on the ledger, read by the kernel's one
// function; "(default)" only when none is recorded. A smelly test stops the
// card before any run at a blocking profile, so no Vitest process is needed.

const unit: GateDefinition = {
  id: "unit",
  rung: "test",
  layer: "functional",
  command: process.execPath,
  args: ["-e", "process.exit(1)"],
  timeoutMs: 60_000,
  parser: "vitest",
  blocking: true,
};

const SMELLY = `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("no assertion at all", () => { add(1, 2); });
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "strength-profile-")));
  dirs.push(root);
  const put = (p: string, text: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  put("package.json", '{ "name": "seed", "type": "module", "private": true }\n');
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  put("tests/a.spec.ts", SMELLY);
  return root;
}

function ledger(): { db: DatabaseSync; store: CardStore } {
  const dir = mkdtempSync(join(tmpdir(), "strength-ledger-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  return { db, store: new CardStore(db, new EventLog(db)) };
}

describe("DS-P14-3: test strength reads the recorded depth profile", () => {
  it("reads the default, marked so, from a ledger with none recorded", async () => {
    const { db } = ledger();
    const record = await checkTestStrength({
      sandbox: new ProcessSandbox(),
      root: repo(),
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
      ledger: db,
    });
    db.close();
    expect(record.profileNote).toBe("depth profile: internal tool (default)");
  });

  it("reads the person's recorded profile for the card's project", async () => {
    const { db, store } = ledger();
    const project = await store.ensureProject({ rootPath: dirs[0] as string, name: "Shop" });
    await store.depthProfiles.choose(
      {
        profile: "production",
        projectId: project.id,
        checklist: Object.fromEntries(
          checklistRowsFor("production").map((row) => [
            row,
            { title: row, invariant: `${row}-gate` },
          ]),
        ),
      },
      "p_owner",
    );
    const record = await checkTestStrength({
      sandbox: new ProcessSandbox(),
      root: repo(),
      testGate: unit,
      tests: ["tests/a.spec.ts"],
      change: "feature",
      origin: "card",
      ledger: db,
      projectId: project.id,
    });
    db.close();
    expect(record.profile).toBe("production");
    expect(record.profileNote).toBe("depth profile: production");
    expect(record.verdict.stopReason).toBe("vacuous_tests");
  });
});
