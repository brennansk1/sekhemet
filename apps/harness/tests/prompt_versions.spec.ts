import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { COPY_MODULE_ROLES, type LiteralInventory } from "@sekhemet/context";
import { MODEL_ROLES } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import {
  ROLE_COPY,
  fullContextVersion,
  rolePromptVersion,
  rolePromptVersions,
} from "../src/prompt_versions.js";
import { workerContextVersion } from "../src/qualify.js";

// CX-N6-4 (live-test F24): a role's qualification depends on its own prompt
// version; every card records the full context version over all of them.

const inventoryText = readFileSync(
  join(
    dirname(createRequire(import.meta.url).resolve("@sekhemet/context/package.json")),
    "prompt_literals_baseline.json",
  ),
  "utf8",
);
const edit = (file: string): string => {
  const inv = JSON.parse(inventoryText) as LiteralInventory;
  return JSON.stringify({
    ...inv,
    literals: inv.literals.map((l) =>
      l.file === file ? { ...l, hash: "0000000000000000", text: "edited" } : l,
    ),
  });
};

describe("CX-N6-4: each role's prompt version is its own", () => {
  it("hashes exactly the copy modules the context package assigns to the role", () => {
    for (const role of MODEL_ROLES) {
      const assigned = Object.entries(COPY_MODULE_ROLES)
        .filter(([, roles]) => roles.includes(role))
        .map(([name]) => name)
        .sort();
      expect(Object.keys(ROLE_COPY[role]).sort(), role).toEqual(assigned);
    }
  });

  it("gives each role a distinct version, and the Coding model's is the Worker's qualification version", () => {
    const versions = rolePromptVersions();
    expect(Object.keys(versions).sort()).toEqual([...MODEL_ROLES].sort());
    for (const v of Object.values(versions)) expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(Object.values(versions)).size).toBe(MODEL_ROLES.length);
    expect(workerContextVersion()).toBe(versions.worker);
  });

  it("F24: a Seshat or Research model literal changes that role's version, never the Coding model's", () => {
    const worker = rolePromptVersion("worker", { inventory: inventoryText });
    const seshat = edit("apps/harness/src/pm/agent.ts");
    const research = edit("apps/harness/src/research/apodex_loop.ts");
    expect(rolePromptVersion("worker", { inventory: seshat })).toBe(worker);
    expect(rolePromptVersion("worker", { inventory: research })).toBe(worker);
    expect(rolePromptVersion("planner", { inventory: seshat })).not.toBe(
      rolePromptVersion("planner", { inventory: inventoryText }),
    );
    expect(rolePromptVersion("researcher", { inventory: research })).not.toBe(
      rolePromptVersion("researcher", { inventory: inventoryText }),
    );
    expect(rolePromptVersion("reviewer", { inventory: seshat })).toBe(
      rolePromptVersion("reviewer", { inventory: inventoryText }),
    );
    // A Coding model literal changes the Coding model's version.
    expect(rolePromptVersion("worker", { inventory: edit("packages/loop/src/tools.ts") })).not.toBe(
      worker,
    );
    // The estimator's ratio is an input: changing it changes the Coding model's version.
    expect(rolePromptVersion("worker", { inventory: inventoryText, charsPerToken: 3 })).not.toBe(
      worker,
    );
  });

  it("the full context version recorded on every card changes with any role's prompts (rule 37)", () => {
    const full = fullContextVersion({ inventory: inventoryText });
    expect(full).toMatch(/^[0-9a-f]{16}$/);
    expect(fullContextVersion({ inventory: inventoryText })).toBe(full);
    expect(fullContextVersion({ inventory: edit("apps/harness/src/pm/agent.ts") })).not.toBe(full);
    expect(fullContextVersion({ inventory: edit("packages/loop/src/tools.ts") })).not.toBe(full);
    // Even a literal no role reads keeps the full version as strict as before.
    expect(fullContextVersion({ inventory: edit("apps/harness/src/acp.ts") })).not.toBe(full);
    for (const v of Object.values(rolePromptVersions())) expect(fullContextVersion()).not.toBe(v);
  });
});
