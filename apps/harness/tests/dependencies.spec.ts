import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSourceIndex } from "@sekhemet/gates";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { inferDependencies, inferDependencyReasons, recordDependencies } from "../src/execute.js";

const now = new Date().toISOString();
const card = (
  id: string,
  scope: string,
  spec = "",
  extra: Partial<CardRecord> = {},
): CardRecord => ({
  id,
  tier: "story",
  title: id,
  status: "ready",
  scopeFiles: [scope],
  stepBudget: 32,
  stepsUsed: 0,
  createdAt: now,
  updatedAt: now,
  spec,
  ...extra,
});

describe("@sekhemet/harness dependency inference", () => {
  const cards = [
    card("iface", "src/types.ts", "Define the contracts."),
    card("hasher", "src/hasher.ts", "Implement hashEvent."),
    card("db", "src/db.ts", "Implement openDatabase."),
    card("verifier", "src/verifier.ts", "Use hashEvent and GENESIS_HASH from src/hasher.ts."),
    card(
      "ledger",
      "src/ledger.ts",
      "Use openDatabase from src/db.ts, hashEvent from src/hasher.ts and verifyChain from src/verifier.ts.",
    ),
    card("api", "src/server.ts", "Build on Ledger from src/ledger.ts."),
  ];
  const deps = inferDependencies(cards);

  it("PM-N8-1: never makes a card wait on another because that card owns a types file", () => {
    for (const id of ["hasher", "db", "verifier", "ledger", "api"]) {
      expect(deps.get(id)).not.toContain("iface");
    }
    expect(deps.get("iface")).toEqual([]);
  });

  it("infers a dependency wherever a spec names another card's scope file", () => {
    expect(new Set(deps.get("verifier"))).toEqual(new Set(["hasher"]));
    expect(new Set(deps.get("ledger"))).toEqual(new Set(["db", "hasher", "verifier"]));
    expect(new Set(deps.get("api"))).toEqual(new Set(["ledger"]));
  });

  it("does not invent dependencies between independent cards (PM-N8-3)", () => {
    expect(deps.get("hasher")).toEqual([]);
    expect(deps.get("db")).toEqual([]);
  });

  it("honours explicit dependsOn and reads acceptance criteria too", () => {
    const explicit = inferDependencies([
      card("a", "src/a.ts"),
      card("b", "src/b.ts", "", { dependsOn: ["a"] }),
      card("c", "src/c.ts", "", { acceptanceCriteria: ["Calls into src/a.ts"] }),
    ]);
    expect(explicit.get("b")).toEqual(["a"]);
    expect(explicit.get("c")).toEqual(["a"]);
    expect(explicit.get("a")).toEqual([]);
  });
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "sek-deps-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
}

describe("dependencies from what a card uses, with the reason recorded (NEW-planner-pm-8)", () => {
  const files = {
    "package.json": JSON.stringify({ name: "fx", type: "module" }),
    "src/types.ts": "export interface Order { id: string }\n",
    "src/store.ts":
      'import type { Order } from "./types.js";\nexport const save = (o: Order) => o.id;\n',
    "src/report.ts":
      'import { save } from "./store.js";\nexport const report = () => save({ id: "1" });\n',
    "src/export.ts": "export const toCsv = (rows: string[]) => rows.join(',');\n",
    "tests/audit.spec.ts": 'import { toCsv } from "../src/export.js";\nconsole.log(toCsv([]));\n',
  };

  it("PM-N8-1, -2: declared, named (spec, criteria or acceptance test) and imported (T2), and nothing for a types file", () => {
    const root = repo(files);
    const cards = [
      card("types", "src/types.ts", "Define Order."),
      card("store", "src/store.ts", "Save orders."),
      card("report", "src/report.ts", "Report on saved orders."),
      card("export", "src/export.ts", "Export rows."),
      card("audit", "src/audit.ts", "Audit trail.", { acceptanceTests: ["audit.spec.ts"] }),
      card("undo", "src/undo.ts", "Undo.", { dependsOn: ["export"] }),
      card("named", "src/named.ts", "", { acceptanceCriteria: ["Reads rows through src/export"] }),
    ];
    const reasons = inferDependencyReasons(cards, { index: createSourceIndex(root) });
    // The T2 index shows report's scope imports store's module.
    expect(reasons.get("report")).toEqual([{ dependsOnId: "store", source: "imported" }]);
    // store imports the types file, and the types card is never a blanket prerequisite —
    // an import of it is a real use, recorded as such.
    expect(reasons.get("store")).toEqual([{ dependsOnId: "types", source: "imported" }]);
    expect(reasons.get("audit")).toEqual([{ dependsOnId: "export", source: "named" }]);
    expect(reasons.get("named")).toEqual([{ dependsOnId: "export", source: "named" }]);
    expect(reasons.get("undo")).toEqual([{ dependsOnId: "export", source: "declared" }]);
    expect(reasons.get("export")).toEqual([]);
    expect(reasons.get("types")).toEqual([]);
  });

  it("PM-N8-2, -3: records why on the card, and two unrelated cards run in either order", async () => {
    const root = repo(files);
    const dbDir = mkdtempSync(join(tmpdir(), "sek-deps-db-"));
    dirs.push(dbDir);
    const db = new DatabaseSync(join(dbDir, "events.db"));
    initSchema(db);
    const store = new CardStore(db, new EventLog(db));
    const mk = (id: string, scope: string, extra: Partial<CardRecord> = {}) =>
      store.createCard({
        id,
        tier: "story",
        title: id,
        status: "ready",
        scopeFiles: [scope],
        ...extra,
      });
    await mk("store", "src/store.ts");
    await mk("report", "src/report.ts");
    await mk("export", "src/export.ts");
    await mk("named", "src/named.ts", { spec: "Use toCsv from src/export.ts." });
    const skipped = await recordDependencies(store, await store.listCards(), {
      index: createSourceIndex(root),
    });
    expect(skipped).toEqual([]);
    expect(store.getDependencyReasons("report")).toEqual([
      { dependsOnId: "store", source: "imported" },
    ]);
    expect(store.getDependencyReasons("named")).toEqual([
      { dependsOnId: "export", source: "named" },
    ]);
    expect(store.waitingOn("report")).toEqual(["store"]);
    // No inferred dependency: neither waits on the other.
    expect(store.waitingOn("export")).toEqual([]);
    expect(store.waitingOn("store")).toEqual([]);
  });

  it("PM-N8-3 on an upgraded ledger: an edge the old types-file rule wrote is swept; a declared one stays", async () => {
    const root = repo(files);
    const dbDir = mkdtempSync(join(tmpdir(), "sek-deps-db-"));
    dirs.push(dbDir);
    const db = new DatabaseSync(join(dbDir, "events.db"));
    initSchema(db);
    const store = new CardStore(db, new EventLog(db));
    const mk = (id: string, scope: string) =>
      store.createCard({ id, tier: "story", title: id, status: "ready", scopeFiles: [scope] });
    await mk("types", "src/types.ts");
    await mk("export", "src/export.ts");
    await mk("undo", "src/undo.ts");
    // What the retired blanket rule recorded before the upgrade, and a person's own edge.
    await store.addDependency("export", "types", "inferred", "harness");
    await store.addDependency("undo", "export", "declared", "human");
    await recordDependencies(store, await store.listCards(), { index: createSourceIndex(root) });
    expect(store.waitingOn("export")).toEqual([]);
    expect(store.getDependencyReasons("undo")).toEqual([
      { dependsOnId: "export", source: "declared" },
    ]);
  });

  it("a stem names only a source file of the same family: src/export.json does not name src/export.ts", () => {
    const cards = [
      card("export", "src/export.ts", "Export rows."),
      card("cfg", "src/cfg.ts", "", {
        acceptanceCriteria: ["Reads its settings from src/export.json"],
      }),
    ];
    expect(inferDependencyReasons(cards).get("cfg")).toEqual([]);
  });
});
