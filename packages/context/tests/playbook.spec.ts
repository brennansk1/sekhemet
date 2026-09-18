import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlaybookRegistry } from "../src/playbook.js";

describe("@sekhemet/context PlaybookRegistry", () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), "sekhemet-playbook-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempRepo, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("creates, saves, loads, and matches playbook rules", () => {
    const registry = new PlaybookRegistry(tempRepo);
    expect(registry.getAllRules()).toHaveLength(0);

    registry.addRule({
      id: "pb_0192",
      originCard: "card_8f21",
      triggerGate: "typecheck",
      pattern: "Zod v4 schema inference",
      instruction:
        "Always use z.infer<typeof Schema> rather than manual interface declarations when schemas change.",
      effectiveDate: "2026-09-15",
      evalPassRateDelta: "+0.08",
    });

    expect(registry.getAllRules()).toHaveLength(1);

    // Reload from disk to verify TOML serialization
    const reloaded = new PlaybookRegistry(tempRepo);
    expect(reloaded.getAllRules()).toHaveLength(1);
    const rule = reloaded.getAllRules()[0];
    expect(rule?.id).toBe("pb_0192");
    expect(rule?.instruction).toContain("z.infer");

    // Match rule by gate and card title
    const matched = reloaded.matchRules({
      cardTitle: "Refactor Zod v4 schema",
      triggerGate: "typecheck",
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.id).toBe("pb_0192");

    // Audit context debt
    const audit = reloaded.auditContextDebt();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.flaggedDebt).toBe(false);

    // Retire rule
    const retired = reloaded.retireRule("pb_0192");
    expect(retired).toBe(true);
    expect(reloaded.getAllRules()).toHaveLength(0);
  });
});
