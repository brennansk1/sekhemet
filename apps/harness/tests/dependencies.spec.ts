import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { inferDependencies } from "../src/execute.js";

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

  it("makes every card depend on the contract card that owns the types file", () => {
    for (const id of ["hasher", "db", "verifier", "ledger", "api"]) {
      expect(deps.get(id)).toContain("iface");
    }
    expect(deps.get("iface")).toEqual([]);
  });

  it("infers a dependency wherever a spec names another card's scope file", () => {
    expect(new Set(deps.get("verifier"))).toEqual(new Set(["iface", "hasher"]));
    expect(new Set(deps.get("ledger"))).toEqual(new Set(["iface", "db", "hasher", "verifier"]));
    expect(new Set(deps.get("api"))).toEqual(new Set(["iface", "ledger"]));
  });

  it("does not invent dependencies between independent cards", () => {
    expect(deps.get("hasher")).toEqual(["iface"]);
    expect(deps.get("db")).toEqual(["iface"]);
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
