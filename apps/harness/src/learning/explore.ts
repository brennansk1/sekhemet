import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardRecord } from "@sekhemet/kernel";
import { moduleApiSummary } from "@sekhemet/loop";
import type { LearningStore } from "./store.js";

/**
 * Learn the environment before the work (after RSIAgent, arXiv 2609.15364).
 *
 * RSIAgent explores a new environment first and stores "procedures,
 * discovered constraints, and failure lessons" for the real tasks. Its two
 * stated weaknesses are a model verifier that passes things it should not,
 * and memory injected wholesale. Here the constraints are read straight from
 * the project's own configuration, so they are true by construction (the
 * compiler enforces exactly these flags), and each becomes a scoped rule the
 * Worker receives only when relevant.
 *
 * Every constraint below cost the Worker a failed attempt on Chronicle before
 * it existed: exactOptionalPropertyTypes, noUncheckedIndexedAccess, ESM .js
 * extensions, node:sqlite's API.
 */
export interface Constraint {
  key: string;
  text: string;
  errorPattern?: string;
  pathPattern?: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    // tsconfig allows comments and trailing commas; strip them.
    const text = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Follow `extends` once so a project's base config counts too. */
function compilerOptions(repo: string): Record<string, unknown> {
  const ts = readJson(join(repo, "tsconfig.json"));
  if (!ts) return {};
  let base: Record<string, unknown> = {};
  if (typeof ts.extends === "string" && ts.extends.startsWith(".")) {
    base = (readJson(join(repo, ts.extends))?.compilerOptions as Record<string, unknown>) ?? {};
  }
  return { ...base, ...((ts.compilerOptions as Record<string, unknown>) ?? {}) };
}

export function exploreProject(repo: string): Constraint[] {
  const out: Constraint[] = [];
  const co = compilerOptions(repo);
  const on = (k: string) => co[k] === true;

  if (on("exactOptionalPropertyTypes")) {
    out.push({
      key: "ts_exact_optional",
      errorPattern: "TS2375",
      text: "exactOptionalPropertyTypes is on: never assign `undefined` to an optional property. Omit it, or add it conditionally with `...(v !== undefined ? { key: v } : {})`.",
    });
  }
  if (on("noUncheckedIndexedAccess")) {
    out.push({
      key: "ts_unchecked_index",
      errorPattern: "TS18048",
      text: "noUncheckedIndexedAccess is on: `arr[i]` and `record[key]` are `T | undefined`. Narrow before use (`const x = arr[i]; if (x === undefined) ...`) or iterate with for-of; the `!` assertion is not an option.",
    });
  }
  const mod = String(co.module ?? "").toLowerCase();
  const res = String(co.moduleResolution ?? "").toLowerCase();
  if (
    mod.startsWith("node16") ||
    mod.startsWith("nodenext") ||
    res.startsWith("node16") ||
    res.startsWith("nodenext")
  ) {
    out.push({
      key: "esm_js_extensions",
      errorPattern: "TS2835",
      text: "Module resolution is NodeNext: every relative import ends in `.js`, even for .ts files (`import { x } from './types.js'`).",
    });
  }
  if (on("verbatimModuleSyntax")) {
    out.push({
      key: "ts_verbatim",
      errorPattern: "TS1484",
      text: "verbatimModuleSyntax is on: import types with `import type { T }`, never a plain import of a type-only name.",
    });
  }
  if (on("noPropertyAccessFromIndexSignature")) {
    out.push({
      key: "ts_index_signature_access",
      errorPattern: "TS4111",
      text: "noPropertyAccessFromIndexSignature is on: read index-signature keys with brackets (`obj['key']`), not dots.",
    });
  }

  const biome = readJson(join(repo, "biome.json"));
  const recommended = (biome?.linter as { rules?: { recommended?: boolean } } | undefined)?.rules
    ?.recommended;
  if (recommended !== false && biome) {
    out.push({
      key: "biome_no_non_null",
      errorPattern: "lint/style/noNonNullAssertion",
      text: "Biome forbids the `!` non-null assertion here. Narrow with an explicit check instead.",
    });
  }

  const pkg = readJson(join(repo, "package.json"));
  const deps = {
    ...((pkg?.dependencies as Record<string, string>) ?? {}),
    ...((pkg?.devDependencies as Record<string, string>) ?? {}),
  };
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 22) {
    const hasDb = Object.keys(deps).some((d) =>
      /sqlite|better-sqlite3|pg|mysql|prisma|drizzle/.test(d),
    );
    if (!hasDb) {
      out.push({
        key: "node_sqlite_api",
        pathPattern: "",
        text: "No database package is installed; use `node:sqlite`. Its `DatabaseSync` has `exec(sql)` for DDL and `prepare(sql)` returning a statement with `run`, `get` and `all`; there is no `db.run`. Rows come back as untyped records: map them to your types field by field.",
      });
    }
  }
  if (deps.vitest) {
    out.push({
      key: "test_runner_vitest",
      text: "Tests run with Vitest: `import { describe, it, expect } from 'vitest'`. Acceptance tests are protected; make the implementation satisfy them.",
    });
  }
  return out;
}

/**
 * Deep, curriculum-guided exploration (RSIAgent's second phase). The cards
 * about to run name the modules they need; for each Node built-in they
 * mention, read its real API from the installed type declarations and hand
 * it over before the first attempt. Verified by construction: these are the
 * declarations the compiler will check against.
 */
export function exploreCurriculum(repo: string, cards: CardRecord[]): Constraint[] {
  const text = cards
    .map((c) => [c.title, c.spec ?? "", ...(c.acceptanceCriteria ?? [])].join(" "))
    .join(" ");
  const modules = [...new Set([...text.matchAll(/\bnode:[a-z_]+\b/g)].map((m) => m[0]))];
  const out: Constraint[] = [];
  for (const mod of modules.slice(0, 6)) {
    const api = moduleApiSummary(repo, mod);
    if (!api) continue;
    out.push({
      key: `api_${mod.replace(":", "_")}`,
      text: `The real API of ${mod} (from its type declarations): ${api}. Use exactly these names.`,
    });
  }
  return out;
}

/**
 * Store what exploration found as project rules. Constraints read from the
 * project's own configuration are facts, not heuristics, so `activate`
 * switches them on directly; heuristic rules still wait for a human.
 */
export async function applyExploration(
  store: LearningStore,
  repo: string,
  activate: boolean,
  cards: CardRecord[] = [],
): Promise<{ proposed: number; activated: number }> {
  let proposed = 0;
  let activated = 0;
  for (const c of [...exploreProject(repo), ...exploreCurriculum(repo, cards)]) {
    const rule = await store.propose({
      role: "worker",
      text: c.text,
      scope: {
        ...(c.errorPattern ? { errorPattern: c.errorPattern } : {}),
        ...(c.pathPattern ? { pathPattern: c.pathPattern } : {}),
      },
      source: "seed",
      evidence: [{ note: `read from the project's configuration (${c.key})` }],
    });
    // Already known (an earlier explore): activate the existing candidate
    // rather than silently doing nothing.
    const target =
      rule ?? (await store.rules()).find((r) => r.role === "worker" && r.text === c.text);
    if (rule) proposed++;
    if (activate && target && target.status === "candidate") {
      await store.update(target.id, { status: "active" });
      activated++;
    }
  }
  return { proposed, activated };
}
