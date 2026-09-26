import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_ROLES, ModelRegistry } from "../src/index.js";

// MD-N4-1: one role type (worker, planner, reviewer, researcher) and one
// capability flag, vision; no other role enumeration in the source.

const ROOT = join(import.meta.dirname, "..", "..", "..");
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "tests") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
  };
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, top))) {
      const src = join(ROOT, top, pkg, "src");
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // no src
      }
    }
  }
  return out;
}

/**
 * Enumerations that name model roles and are not yet the one type, each with
 * who converges it. The list may only shrink.
 */
const NOT_YET_CONVERGED: Record<string, string> = {
  "packages/context/src/allocator.ts":
    "ContextRole adds seshat, a prompt persona on the planner's weights (half 1)",
  "packages/kernel/src/types.ts": "AttemptRole: worker | escalation, the attempt's route (kernel)",
  "packages/ui/src/pm.ts": "the dashboard's roster row still says manager (ui)",
  "apps/harness/src/runner_lease.ts":
    "the lease's published roster still says manager (read by ui/src/pm.ts)",
  "apps/harness/src/learning/store.ts": "RuleRole: worker | manager (learning, half 1)",
  "apps/harness/src/pm_api.ts": "the Machine view's roster rows still say manager (read by the ui)",
  "packages/eval/src/run_profile.ts":
    "RunProfile.roles keys manager; renaming changes the recorded baseline's hash (the lead's call)",
  "apps/harness/src/wave2.ts": "routeForAttempt returns the kernel's AttemptRole",
};

const ROLE_WORDS = [
  "planner",
  "reviewer",
  "researcher",
  "manager",
  "escalation",
  "executor",
  "seshat",
];

describe("MD-N4-1: one role type", () => {
  it("is worker, planner, reviewer, researcher", () => {
    expect(MODEL_ROLES).toEqual(["worker", "planner", "reviewer", "researcher"]);
  });

  it("vision is a capability flag, not a role", () => {
    const reg = new ModelRegistry("/nonexistent/sekhemet-test/models.json");
    expect(reg.visionModels()).toEqual([]);
  });

  it("no other source enumerates model roles", () => {
    const found = new Set<string>();
    const union = /"worker"\s*\|\s*"(\w+)"|"(\w+)"\s*\|\s*"worker"/g;
    const list = /\[\s*"worker",\s*"(\w+)"/g;
    for (const file of sources()) {
      const rel = relative(ROOT, file);
      if (rel === "packages/models/src/types.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const re of [union, list]) {
        for (const m of text.matchAll(re)) {
          const other = m[1] ?? m[2] ?? "";
          if (ROLE_WORDS.includes(other)) found.add(rel);
        }
      }
    }
    const unexpected = [...found].filter((f) => !(f in NOT_YET_CONVERGED));
    expect(unexpected).toEqual([]);
    // An entry that no longer enumerates roles is removed from the list.
    expect(Object.keys(NOT_YET_CONVERGED).filter((f) => !found.has(f))).toEqual([]);
  });
});
