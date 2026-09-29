import type { Permission } from "./team/access.js";

/**
 * The Configuration page's REST routes as one typed table (B4.1 step 0):
 * model folders and scan, roles, downloads, model details, combinations and
 * placement, the two-tier benchmark, the effective configuration and review
 * capacity ([dashboard](../../../docs/design/specs/dashboard.md) §3 and §2.16;
 * shapes and behaviour in [PM_CONTRACT §3](../../../docs/design/PM_CONTRACT.md)
 * *Configuration*). Every route here is documented there (a test checks both
 * directions).
 *
 * Every change is a person's act at the Admin level in the Team setup
 * (`config.manage`; the queue's cap: `queue.caps`; review capacity:
 * `review.capacity`, an Admin or the Accept rule's people), recorded on the
 * ledger with the principal. Nothing here downloads, loads or benchmarks on
 * its own initiative. `module` names the harness module that will serve the
 * route (B4.1 part (b): `config_api`; part (c): `benchmark_api`). Within one
 * method a literal segment is listed before a parameter in the same place,
 * so a router may match in table order.
 */

export type ConfigRouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ConfigRoute {
  method: ConfigRouteMethod;
  /** Express-style: `:name` is a path parameter. */
  path: string;
  /** The team permission a request needs (teams item 6; `team/access.ts` `ACTIONS`). */
  permission: Permission;
  /** The module that will serve it. */
  module: "config_api" | "benchmark_api";
  /** The spec ids it serves. */
  spec: string;
}

export const CONFIG_ROUTES: readonly ConfigRoute[] = [
  // The effective configuration and review capacity (NEW-dashboard-4).
  {
    method: "GET",
    path: "/api/config",
    permission: "read",
    module: "config_api",
    spec: "NEW-dashboard-4",
  },
  {
    method: "PUT",
    path: "/api/config/review",
    permission: "review.capacity",
    module: "config_api",
    spec: "NEW-dashboard-4; review-git §2.2.3",
  },
  // The queue's per-person Agent cap (teams item 30, TEAM-30; dashboard §2.16).
  {
    method: "PUT",
    path: "/api/config/queue",
    permission: "queue.caps",
    module: "config_api",
    spec: "TEAM-30; dashboard §2.16",
  },
  // Model folders and the scan (DB-N6, MD-N12-1, MD-N12-8, MD-N13-1, SEC-N10).
  {
    method: "GET",
    path: "/api/config/models",
    permission: "read",
    module: "config_api",
    spec: "DB-N6; MD-N12-1, MD-N12-8",
  },
  {
    method: "POST",
    path: "/api/config/models/folders",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6; MD-N13-1",
  },
  {
    method: "DELETE",
    path: "/api/config/models/folders",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6",
  },
  {
    method: "POST",
    path: "/api/config/models/scan",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6; MD-N12-1, MD-N12-2; SEC-N10-4",
  },
  // Model details (DB-NM14-1–4): identity, the memory what-if, speeds, warnings.
  {
    method: "GET",
    path: "/api/config/models/:id",
    permission: "read",
    module: "config_api",
    spec: "DB-NM14-1–4; MD-N13-2, MD-N13-3",
  },
  // Measure speed (DB-NM14-3): llama-bench and the first token, a person's confirmed load.
  {
    method: "POST",
    path: "/api/config/models/:id/speed",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-NM14-3",
  },
  // Roles: assign, load, unload, qualify to assign, restore previous.
  {
    method: "GET",
    path: "/api/config/roles",
    permission: "read",
    module: "config_api",
    spec: "DB-N6; MD-N12-4",
  },
  {
    method: "PUT",
    path: "/api/config/roles/:role",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6-5; models rules 27a, 30a",
  },
  {
    method: "POST",
    path: "/api/config/roles/:role/load",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6; models rule 20a",
  },
  {
    method: "POST",
    path: "/api/config/roles/:role/unload",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6; models rule 20a",
  },
  {
    method: "POST",
    path: "/api/config/roles/:role/qualify",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6-5; models rule 27a",
  },
  {
    method: "POST",
    path: "/api/config/roles/:role/restore",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6; MD-N10-2",
  },
  // Downloads (MD-N12-6, MD-N12-7, SEC-53) and the pre-download estimate (DB-NM14-5).
  {
    method: "GET",
    path: "/api/config/downloads/estimate",
    permission: "read",
    module: "config_api",
    spec: "DB-NM14-5",
  },
  {
    method: "POST",
    path: "/api/config/downloads",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6; MD-N12-6; security item 47",
  },
  {
    method: "DELETE",
    path: "/api/config/downloads/:id",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6; MD-N12-6",
  },
  // Combinations and placement (DB-NM14-6–9, MD-N14-41–42, MS-NM14-4).
  {
    method: "GET",
    path: "/api/config/combinations",
    permission: "read",
    module: "config_api",
    spec: "DB-NM14-6; MD-N14-42",
  },
  {
    method: "GET",
    path: "/api/config/placement",
    permission: "read",
    module: "config_api",
    spec: "DB-NM14-7; MD-N14-41; MS-NM14-4",
  },
  {
    method: "POST",
    path: "/api/config/placement/copies",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-NM14-8; MD-N14-41, MD-N14-40a",
  },
  {
    method: "GET",
    path: "/api/config/residency",
    permission: "read",
    module: "config_api",
    spec: "DB-NM14-9",
  },
  // Use the recommended models (DB-N6-16): the confirmation, then the flow.
  {
    method: "GET",
    path: "/api/config/recommended",
    permission: "read",
    module: "config_api",
    spec: "DB-N6-16",
  },
  {
    method: "POST",
    path: "/api/config/recommended",
    permission: "config.manage",
    module: "config_api",
    spec: "DB-N6-16; DB-N6-13",
  },
  // The two-tier benchmark of combinations (NEW-measurement-5, MS-N5-1–12).
  {
    method: "GET",
    path: "/api/config/benchmark",
    permission: "read",
    module: "benchmark_api",
    spec: "DB-N6; MS-N5-8, MS-N5-11",
  },
  {
    method: "GET",
    path: "/api/config/benchmark/estimate",
    permission: "read",
    module: "benchmark_api",
    spec: "MS-N5-1, MS-N5-9",
  },
  {
    method: "GET",
    path: "/api/config/benchmark/runs/:runId",
    permission: "read",
    module: "benchmark_api",
    spec: "DB-N6; MS-N5-6",
  },
  {
    method: "GET",
    path: "/api/config/benchmark/:combinationId",
    permission: "read",
    module: "benchmark_api",
    spec: "DB-N6; MS-N5-11",
  },
  {
    method: "POST",
    path: "/api/config/benchmark",
    permission: "config.manage",
    module: "benchmark_api",
    spec: "DB-N6; MS-N5-1, MS-N5-9; MD-N3-4",
  },
  {
    method: "POST",
    path: "/api/config/benchmark/runs/:runId/stop",
    permission: "config.manage",
    module: "benchmark_api",
    spec: "MS-N5-6, MS-N5-12",
  },
];
