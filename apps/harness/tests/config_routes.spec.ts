import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_ROUTES } from "../src/config_routes.js";
import { ACTIONS } from "../src/team/access.js";

/**
 * B4.1 step 0: the Configuration, placement and benchmark REST routes as one
 * typed table (dashboard §3, PM_CONTRACT §3 *Configuration*), each documented
 * in PM_CONTRACT, and every `/api/config` route PM_CONTRACT names in the table.
 */
const contract = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "docs", "design", "PM_CONTRACT.md"),
  "utf8",
);
const key = (method: string, path: string) => `${method} ${path}`;

describe("the Configuration API route table (PM_CONTRACT §3 Configuration)", () => {
  it("documents every route in PM_CONTRACT as `METHOD path`", () => {
    const missing = CONFIG_ROUTES.filter((r) => !contract.includes(`\`${key(r.method, r.path)}`));
    expect(missing.map((r) => key(r.method, r.path))).toEqual([]);
  });

  it("holds every /api/config route PM_CONTRACT names", () => {
    const named = new Set(
      [...contract.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/api\/config[^`?\s]*)/g)].map((m) =>
        key(m[1] ?? "", m[2] ?? ""),
      ),
    );
    const table = new Set(CONFIG_ROUTES.map((r) => key(r.method, r.path)));
    expect([...named].filter((k) => !table.has(k))).toEqual([]);
    expect(named.size).toBeGreaterThan(0);
  });

  it("names each route once, with a known permission: reads for GET, a person's Admin-level act for every change", () => {
    const keys = CONFIG_ROUTES.map((r) => key(r.method, r.path));
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of CONFIG_ROUTES) {
      expect(Object.keys(ACTIONS), key(r.method, r.path)).toContain(r.permission);
      if (r.method === "GET") expect(r.permission, key(r.method, r.path)).toBe("read");
      else
        expect(["config.manage", "review.capacity", "queue.caps"], key(r.method, r.path)).toContain(
          r.permission,
        );
      expect(r.spec.length, key(r.method, r.path)).toBeGreaterThan(0);
    }
  });

  it("matches a literal segment before a parameter in the same place (estimate before :combinationId)", () => {
    const paths = CONFIG_ROUTES.filter((r) => r.method === "GET").map((r) => r.path);
    const literal = paths.indexOf("/api/config/benchmark/estimate");
    const param = paths.indexOf("/api/config/benchmark/:combinationId");
    expect(literal).toBeGreaterThanOrEqual(0);
    expect(param).toBeGreaterThan(literal);
  });
});
