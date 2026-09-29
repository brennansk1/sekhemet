import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_ROLES } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { ROLE_ANSWER_TOKENS } from "../src/allocator.js";
import type { LiteralInventory } from "../src/prompt_literals.js";
import {
  COPY_MODULE_ROLES,
  literalFileRoles,
  literalInventoryForRole,
  rolePolicyText,
} from "../src/prompt_roles.js";
import { COPY_MODULES } from "../src/prompt_tags.js";
import type { ToolInterfaceSpec } from "../src/tool_interface.js";
import { computeRolePromptVersion } from "../src/versioning.js";

/**
 * CX-N6-4 (live-test F24): each role's prompt version covers its own
 * templates, copy modules, tool schemas and budget policy, so a change to one
 * role's prompts leaves every other role's version, and qualification, as it
 * was.
 */

const inventoryPath = join(import.meta.dirname, "..", "prompt_literals_baseline.json");
const inventoryText = readFileSync(inventoryPath, "utf8");
const inventory = JSON.parse(inventoryText) as LiteralInventory;

describe("CX-N6-4: every model-facing text belongs to a role", () => {
  it("assigns every registered copy module to its roles, the qualification suite's to none", () => {
    expect(Object.keys(COPY_MODULE_ROLES).sort()).toEqual(Object.keys(COPY_MODULES).sort());
    expect(COPY_MODULE_ROLES.worker).toEqual(["worker"]);
    expect(COPY_MODULE_ROLES.gates).toEqual(["worker"]);
    expect(COPY_MODULE_ROLES.pm).toEqual(["planner"]);
    expect(COPY_MODULE_ROLES.review).toEqual(["reviewer"]);
    expect(COPY_MODULE_ROLES.research).toEqual(["researcher"]);
    // The suite's own text is versioned by the suite version, not a role's.
    expect(COPY_MODULE_ROLES.qualification).toEqual([]);
  });

  it("maps every file in the recorded literal inventory explicitly", () => {
    const unmapped = [...new Set(inventory.literals.map((l) => l.file))].filter(
      (f) => !literalFileRoles(f).mapped,
    );
    expect(unmapped).toEqual([]);
  });

  it("counts a file no one mapped for every role, so a new one never escapes a version", () => {
    expect(literalFileRoles("apps/harness/src/brand_new.ts")).toEqual({
      roles: [...MODEL_ROLES],
      mapped: false,
    });
    expect(literalFileRoles("packages/loop/src/tools.ts").roles).toEqual(["worker"]);
    expect(literalFileRoles("apps/harness/src/research/apodex_loop.ts").roles).toEqual([
      "researcher",
    ]);
    expect(literalFileRoles("apps/harness/src/index.ts").roles).toEqual(["planner"]);
  });
});

describe("CX-N6-4: a role's literal inventory is its own", () => {
  const edit = (file: string): string =>
    JSON.stringify({
      ...inventory,
      literals: inventory.literals.map((l) =>
        l.file === file ? { ...l, hash: "0000000000000000", text: "edited" } : l,
      ),
    });

  it("an edit to Seshat's or the Researcher's literal leaves the Coding model's inventory unchanged", () => {
    const worker = literalInventoryForRole(inventoryText, "worker");
    expect(literalInventoryForRole(edit("apps/harness/src/index.ts"), "worker")).toBe(worker);
    expect(
      literalInventoryForRole(edit("apps/harness/src/research/apodex_loop.ts"), "worker"),
    ).toBe(worker);
    expect(literalInventoryForRole(edit("apps/harness/src/index.ts"), "planner")).not.toBe(
      literalInventoryForRole(inventoryText, "planner"),
    );
    // A Coding model literal changes the Coding model's inventory.
    expect(literalInventoryForRole(edit("packages/loop/src/tools.ts"), "worker")).not.toBe(worker);
  });

  it("an unreadable inventory is taken whole for every role", () => {
    expect(literalInventoryForRole("not json", "reviewer")).toBe("not json");
  });
});

describe("CX-N6-4: a role's budget policy and prompt version", () => {
  it("the Coding model's policy holds the zone caps; another role's holds its own answer reserve", () => {
    expect(rolePolicyText("worker")).toMatch(/zone budgets/);
    expect(rolePolicyText("reviewer")).not.toMatch(/zone budgets/);
    expect(rolePolicyText("reviewer")).toMatch(/"reviewer":900/);
    expect(rolePolicyText("reviewer")).not.toMatch(/"worker"/);
    // Seshat is the Planning model's: its reserve is part of that role's policy.
    expect(rolePolicyText("planner")).toMatch(/"seshat":1200/);
    const reviewerMore = { ...ROLE_ANSWER_TOKENS, reviewer: 1_500 };
    expect(rolePolicyText("reviewer", reviewerMore)).not.toBe(rolePolicyText("reviewer"));
    expect(rolePolicyText("worker", reviewerMore)).toBe(rolePolicyText("worker"));
  });

  it("differs by role for the same inputs, and changes only with the role's own inputs", () => {
    const tools: ToolInterfaceSpec[] = [
      { name: "finish_card", summary: "Submit.", parameters: [] },
    ];
    const worker = computeRolePromptVersion("worker", { tools, templates: ["w"] });
    expect(computeRolePromptVersion("worker", { tools, templates: ["w"] })).toEqual(worker);
    expect(computeRolePromptVersion("reviewer", { tools, templates: ["w"] }).version).not.toBe(
      worker.version,
    );
    expect(computeRolePromptVersion("worker", { tools, templates: ["w2"] }).version).not.toBe(
      worker.version,
    );
    expect(computeRolePromptVersion("worker", { tools: [], templates: ["w"] }).version).not.toBe(
      worker.version,
    );
    expect(worker.version).toMatch(/^[0-9a-f]{16}$/);
  });
});
