import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TomlTable, parseToml } from "@sekhemet/kernel";
import { parseGateHostConfig } from "./gate_host.js";
import { gateTemplate } from "./templates.js";
import type {
  GateDefinition,
  GateLayer,
  GateProjectConfig,
  GateRung,
  GatesConfig,
} from "./types.js";
import { parseVisualConfig } from "./visual.js";

export const GATES_CONFIG_RELATIVE_PATH = join(".sekhemet", "gates.toml");

const VALID_RUNGS = new Set<GateRung>([
  "parse",
  "typecheck",
  "test",
  "lint",
  "bounds",
  "visual",
  "security",
  "hygiene",
  "robustness",
]);
const BUILTIN_IDS = new Set(["secrets", "dependencies", "osv", "semgrep", "hygiene", "mutation"]);
const VALID_LAYERS = new Set<GateLayer>([
  "static",
  "functional",
  "robustness",
  "security",
  "visual",
  "hygiene",
]);

/**
 * The gate set used when a project ships no `gates.toml`.
 *
 * These are deliberately the same rungs the DoD names, so a project with no
 * config still gets a real verification ladder rather than silently none.
 */
export const DEFAULT_GATES: GateDefinition[] = [
  {
    id: "typecheck",
    rung: "typecheck",
    layer: "static",
    command: "pnpm",
    args: ["typecheck"],
    timeoutMs: 180_000,
    parser: "tsc",
    blocking: true,
  },
  {
    id: "lint",
    rung: "lint",
    layer: "static",
    command: "pnpm",
    args: ["lint"],
    timeoutMs: 120_000,
    parser: "biome",
    blocking: true,
  },
  {
    id: "unit",
    rung: "test",
    layer: "functional",
    command: "pnpm",
    args: ["test"],
    timeoutMs: 600_000,
    parser: "vitest",
    blocking: true,
  },
];

export const DEFAULT_PROJECT_CONFIG: GateProjectConfig = {
  protected: ["**/*.spec.ts", "**/*.test.ts", ".sekhemet/gates.toml", "tests/acceptance/**"],
  maxFiles: 3,
  maxDiffLines: 200,
};

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Compute the canonical SHA-256 of a gates config file's bytes. */
export function hashGatesConfig(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function toGateDefinition(raw: TomlTable, index: number): GateDefinition {
  const id = asString(raw.id, `gate_${index}`);
  const rungRaw = asString(raw.rung, id);
  const layerRaw = asString(raw.layer, "functional");

  const rung = VALID_RUNGS.has(rungRaw as GateRung) ? (rungRaw as GateRung) : "test";
  const layer = VALID_LAYERS.has(layerRaw as GateLayer) ? (layerRaw as GateLayer) : "functional";

  // Timeouts are declared in seconds in the file; the runner works in ms.
  const timeoutSeconds = asNumber(raw.timeout_s, 0);

  return {
    id,
    rung,
    layer,
    command: asString(raw.command, "pnpm"),
    args: asStringArray(raw.args),
    timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : asNumber(raw.timeout_ms, 180_000),
    parser: asString(raw.parser, "generic"),
    blocking: raw.blocking === undefined ? true : raw.blocking === true,
    ...(raw.baseline_approval === "human" || raw.baseline_approval === "auto"
      ? { baselineApproval: raw.baseline_approval as "human" | "auto" }
      : {}),
  };
}

/**
 * Load and hash a project's gate configuration.
 *
 * The hash is returned with the config so the caller can pin it: the design
 * requires re-verification on every card start, because a gate file that can be
 * edited mid-run turns verification into whatever the agent wants it to be.
 */
export function loadGatesConfig(repoRoot: string): GatesConfig {
  const sourcePath = join(repoRoot, GATES_CONFIG_RELATIVE_PATH);

  if (!existsSync(sourcePath)) {
    // No gates.toml: the template for the project's language (G27), else
    // the pnpm defaults.
    const template = gateTemplate(repoRoot);
    return {
      project: { ...DEFAULT_PROJECT_CONFIG },
      gates: template ?? DEFAULT_GATES.map((g) => ({ ...g })),
      sha256: hashGatesConfig(""),
      sourcePath,
    };
  }

  const contents = readFileSync(sourcePath, "utf8");
  const parsed = parseToml(contents);

  const projectTable = (parsed.project ?? {}) as TomlTable;
  const project: GateProjectConfig = {
    protected: asStringArray(projectTable.protected).length
      ? asStringArray(projectTable.protected)
      : [...DEFAULT_PROJECT_CONFIG.protected],
    maxFiles: asNumber(projectTable.max_files, DEFAULT_PROJECT_CONFIG.maxFiles),
    maxDiffLines: asNumber(projectTable.max_diff_lines, DEFAULT_PROJECT_CONFIG.maxDiffLines),
    ...(asStringArray(projectTable.autofix).length > 0
      ? { autofix: asStringArray(projectTable.autofix) }
      : {}),
    ...(asStringArray(projectTable.style_fix).length > 0 &&
    asStringArray(projectTable.style_fix_rules).length > 0
      ? {
          styleFix: asStringArray(projectTable.style_fix),
          styleFixRules: asStringArray(projectTable.style_fix_rules),
        }
      : {}),
    ...(Array.isArray(projectTable.builtin)
      ? {
          builtin: asStringArray(projectTable.builtin).filter((b) =>
            BUILTIN_IDS.has(b),
          ) as NonNullable<GateProjectConfig["builtin"]>,
        }
      : {}),
    ...(asStringArray(projectTable.debug_patterns).length > 0
      ? { debugPatterns: asStringArray(projectTable.debug_patterns) }
      : {}),
    ...(typeof projectTable.changelog === "boolean" ? { changelog: projectTable.changelog } : {}),
    ...(projectTable.mutation === true ? { mutation: true } : {}),
    ...(typeof projectTable.mutation_max === "number"
      ? { mutationMax: projectTable.mutation_max }
      : {}),
    ...(projectTable.mutation_blocking === true ? { mutationBlocking: true } : {}),
    ...(typeof projectTable.pass_at_k === "number" && projectTable.pass_at_k >= 1
      ? { passAtK: Math.min(4, Math.floor(projectTable.pass_at_k)) }
      : {}),
    ...(projectTable.cross_validate === true ? { crossValidate: true } : {}),
    ...(asStringArray(projectTable.network_allow).length > 0
      ? { networkAllow: asStringArray(projectTable.network_allow) }
      : {}),
  };

  const gateHost = parseGateHostConfig(parsed.gate_host, repoRoot);
  if (gateHost) project.gateHost = gateHost;
  const visual = parseVisualConfig(parsed.visual);
  if (visual) project.visual = visual;

  const rawGates = Array.isArray(parsed.gate) ? (parsed.gate as TomlTable[]) : [];
  const gates = rawGates.map(toGateDefinition);

  return {
    project,
    gates: gates.length > 0 ? gates : DEFAULT_GATES.map((g) => ({ ...g })),
    sha256: hashGatesConfig(contents),
    sourcePath,
  };
}

export class GatesConfigTamperError extends Error {
  constructor(expected: string, actual: string, path: string) {
    super(
      `gates.toml integrity check FAILED for ${path}: expected sha256 ${expected}, found ${actual}. Verification configuration changed since the card started; refusing to run gates.`,
    );
    this.name = "GatesConfigTamperError";
  }
}

/**
 * Re-read the config and assert it still hashes to `expectedSha256`.
 *
 * Called at card start and before each verification, so an agent that rewrites
 * its own gates cannot have the rewritten version honoured.
 */
export function verifyGatesConfig(repoRoot: string, expectedSha256: string): GatesConfig {
  const config = loadGatesConfig(repoRoot);
  if (config.sha256 !== expectedSha256) {
    throw new GatesConfigTamperError(expectedSha256, config.sha256, config.sourcePath);
  }
  return config;
}
