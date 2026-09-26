import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TomlTable, parseToml } from "@sekhemet/kernel";
import { parseClaimGateConfig } from "./claims.js";
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
  // Every package's own gates.toml too (review-git rule 5): a Worker never edits a gate.
  protected: [
    "**/*.spec.ts",
    "**/*.test.ts",
    ".sekhemet/gates.toml",
    "**/.sekhemet/gates.toml",
    "tests/acceptance/**",
  ],
  maxFiles: 3,
  maxDiffLines: 200,
  // Rule 12, GT-BF-5: lines a declared mechanical tool applied (a rename, a
  // codemod, a formatter, a lockfile update), under their own bound.
  maxToolAppliedLines: 500,
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

/**
 * What a run on the defaults records as its configuration "hash" (GT-T1-10):
 * a statement, never the SHA-256 of an empty string. It is still pinned, so a
 * `gates.toml` written after the card started is tamper.
 */
export const NO_GATES_CONFIG = "no gates.toml";

/** Compute the canonical SHA-256 of a gates config file's bytes (GT-T1-13). */
export function hashGatesConfig(contents: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof contents === "string" ? Buffer.from(contents, "utf8") : contents)
    .digest("hex");
}

/**
 * Parsers the harness knows (`parsers.ts`), plus the ones whose name places a
 * gate in its layer (rule 36). Any other name is a warning (GT-T1-6).
 */
export const KNOWN_PARSERS: ReadonlySet<string> = new Set([
  "tsc",
  "typescript",
  "vitest",
  "jest",
  "biome",
  "eslint",
  "cargo",
  "generic",
  "gitleaks",
  "stryker",
  "playwright",
]);

/** The layer a parser's name places a gate in when the file gives none (rule 36). */
const LAYER_OF_PARSER: Record<string, GateLayer> = {
  gitleaks: "security",
  stryker: "robustness",
  playwright: "visual",
};

/** The layer a rung belongs to when neither the file nor the parser says. */
const LAYER_OF_RUNG: Record<GateRung, GateLayer> = {
  parse: "static",
  typecheck: "static",
  lint: "static",
  test: "functional",
  bounds: "hygiene",
  hygiene: "hygiene",
  visual: "visual",
  security: "security",
  robustness: "robustness",
};

/** The rung a parser's layer implies, when neither `rung` nor the id names one. */
const RUNG_OF_LAYER: Partial<Record<GateLayer, GateRung>> = {
  security: "security",
  robustness: "robustness",
  visual: "visual",
};

function toGateDefinition(
  raw: TomlTable,
  index: number,
  warn: (w: string) => void,
): GateDefinition {
  const id = asString(raw.id, `gate_${index}`);
  const parser = asString(raw.parser, "generic");
  if (!KNOWN_PARSERS.has(parser)) {
    warn(`gate "${id}": unknown parser = ${JSON.stringify(parser)}; its output is read as generic`);
  }
  const parserLayer = LAYER_OF_PARSER[parser];
  // `rung` defaults to the id when that is a known rung (rule 36).
  const rungRaw =
    typeof raw.rung === "string"
      ? raw.rung
      : VALID_RUNGS.has(id as GateRung)
        ? id
        : ((parserLayer && RUNG_OF_LAYER[parserLayer]) ?? "test");
  if (!VALID_RUNGS.has(rungRaw as GateRung)) {
    warn(`gate "${id}": unknown rung = ${JSON.stringify(rungRaw)}; it runs as the test rung`);
  }
  const rung = VALID_RUNGS.has(rungRaw as GateRung) ? (rungRaw as GateRung) : "test";
  const inferred = parserLayer ?? LAYER_OF_RUNG[rung];
  if (typeof raw.layer === "string" && !VALID_LAYERS.has(raw.layer as GateLayer)) {
    warn(
      `gate "${id}": unknown layer = ${JSON.stringify(raw.layer)}; it runs in the ${inferred} layer`,
    );
  }
  const layer =
    typeof raw.layer === "string" && VALID_LAYERS.has(raw.layer as GateLayer)
      ? (raw.layer as GateLayer)
      : inferred;

  // Timeouts are declared in seconds in the file; the runner works in ms.
  const timeoutSeconds = asNumber(raw.timeout_s, 0);

  return {
    id,
    rung,
    layer,
    command: asString(raw.command, "pnpm"),
    args: asStringArray(raw.args),
    timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : asNumber(raw.timeout_ms, 180_000),
    parser,
    blocking: raw.blocking === undefined ? true : raw.blocking === true,
    ...(typeof raw.blocking === "boolean" ? { blockingDeclared: true } : {}),
    ...(raw.baseline_approval === "human" || raw.baseline_approval === "auto"
      ? { baselineApproval: raw.baseline_approval as "human" | "auto" }
      : {}),
    ...(asStringArray(raw.needs).length > 0 ? { needs: asStringArray(raw.needs) } : {}),
    ...(typeof raw.external === "string" && raw.external.trim()
      ? { external: raw.external.trim() }
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
      sha256: NO_GATES_CONFIG,
      sourcePath,
      empty: true,
    };
  }

  return gatesConfigFromBytes(readFileSync(sourcePath), sourcePath, repoRoot);
}

/**
 * A gate configuration from the bytes of a `gates.toml`, wherever they were
 * read: the working tree, or a commit (a workspace package's own file is
 * read from the card's base, never the card's copy — review-git rule 5).
 */
export function gatesConfigFromBytes(
  bytes: Uint8Array,
  sourcePath: string,
  repoRoot: string,
): GatesConfig {
  const contents = Buffer.from(bytes).toString("utf8");
  const parsed = parseToml(contents);

  const projectTable = (parsed.project ?? {}) as TomlTable;
  const project: GateProjectConfig = {
    protected: asStringArray(projectTable.protected).length
      ? asStringArray(projectTable.protected)
      : [...DEFAULT_PROJECT_CONFIG.protected],
    maxFiles: asNumber(projectTable.max_files, DEFAULT_PROJECT_CONFIG.maxFiles),
    maxDiffLines: asNumber(projectTable.max_diff_lines, DEFAULT_PROJECT_CONFIG.maxDiffLines),
    maxToolAppliedLines: asNumber(
      projectTable.max_tool_applied_lines,
      DEFAULT_PROJECT_CONFIG.maxToolAppliedLines,
    ),
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
  const warnings: string[] = [];
  // Rule 16: the base is the configured branch. A value git would read as
  // an option or a range is refused, never passed to git.
  if (projectTable.base_branch !== undefined) {
    const b = projectTable.base_branch;
    if (typeof b === "string" && isBranchName(b)) project.baseBranch = b;
    else
      warnings.push(`[project] base_branch = ${JSON.stringify(b)} is not a branch name; ignored`);
  }

  const gateHost = parseGateHostConfig(parsed.gate_host, repoRoot);
  if (gateHost) project.gateHost = gateHost;
  const visual = parseVisualConfig(parsed.visual);
  if (visual) project.visual = visual;
  // The claim gate is declared here, so the file's pinned hash covers it (GT-N5-3).
  const claims = parseClaimGateConfig(parsed.claims);
  if (claims) project.claims = claims;

  const rawGates = Array.isArray(parsed.gate) ? (parsed.gate as TomlTable[]) : [];
  const gates = rawGates.map((raw, i) => toGateDefinition(raw, i, (w) => warnings.push(w)));

  return {
    project,
    gates: gates.length > 0 ? gates : DEFAULT_GATES.map((g) => ({ ...g })),
    sha256: hashGatesConfig(bytes),
    sourcePath,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** A git branch name that cannot be read as an option, a range or a path escape. */
function isBranchName(b: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b) &&
    !b.includes("..") &&
    !b.endsWith("/") &&
    !b.endsWith(".lock") &&
    b.length <= 200
  );
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
