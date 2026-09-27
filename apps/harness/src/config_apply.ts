import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TomlTable, parseToml } from "@sekhemet/kernel";
import type { NetworkConfig } from "@sekhemet/sandbox";
import { type ResolvedConfig, resolveConfig } from "./config.js";
import { recommendRoster } from "./init.js";
import { userDir } from "./user_dir.js";

/**
 * config.toml, applied (H15). `resolveConfig` layers defaults, the user's
 * ~/.sekhemet/config.toml, the project's .sekhemet/config.toml, a card's
 * overrides and the command line; this module turns the result into what the
 * harness actually does:
 *
 * - `--set section.key=value` (repeatable) is the command-line layer;
 * - `[review] wip` sets the board's Review limit;
 * - `[models] executor` / `planner` are the queue's default Worker and
 *   manager when no flag names one ("auto" leaves the built-in choice);
 * - `[loop] default_step_budget` caps steps when --max-turns is not given;
 * - `[network] mode` governs the Researcher's web access: "offline" (set by
 *   the user, not the default) turns it off whatever Integrations says, and
 *   "allowlist" limits page reads to `[network] allow`.
 */

function coerce(v: string): string | number | boolean {
  if (v === "true" || v === "false") return v === "true";
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** `--set a.b=c` flags as a TOML table (the CLI layer). */
export function cliOverrides(argv: string[]): TomlTable {
  const out: TomlTable = {};
  argv.forEach((a, i) => {
    if (a !== "--set") return;
    const m = /^([a-z_]+)\.([a-z_]+)=(.*)$/.exec(argv[i + 1] ?? "");
    if (!m) return;
    const key = m[1] as string;
    out[key] ??= {};
    const section = out[key] as TomlTable;
    section[m[2] as string] = coerce(m[3] as string);
  });
  return out;
}

export function effectiveConfig(
  repoPath: string,
  argv: string[] = [],
  card?: { configOverrides?: TomlTable },
): ResolvedConfig {
  const cli = cliOverrides(argv);
  return resolveConfig({
    repoPath,
    ...(Object.keys(cli).length ? { cliOverrides: cli } : {}),
    ...(card?.configOverrides ? { cardOverrides: card.configOverrides } : {}),
  });
}

/**
 * A card's configuration overrides as `section.key = value` lines (SUR-40):
 * what the card shows and what its run prints.
 */
export function configOverrideLines(overrides: TomlTable | undefined): string[] {
  const out: string[] = [];
  for (const [section, table] of Object.entries(overrides ?? {})) {
    if (typeof table !== "object" || table === null || Array.isArray(table)) continue;
    for (const [key, value] of Object.entries(table))
      out.push(`${section}.${key} = ${JSON.stringify(value)}`);
  }
  return out;
}

/**
 * The step cap a card runs under (SUR-40): a `--max-turns` flag, else the
 * card's own `[loop] default_step_budget`, else the run's cap. The card's
 * layer sits between the project's and the command line's.
 */
export function cardStepCap(
  card: { configOverrides?: TomlTable },
  cap: { flag?: number | undefined; otherwise?: number | undefined },
): number | undefined {
  if (cap.flag !== undefined && cap.flag > 0) return cap.flag;
  const own = (card.configOverrides?.loop as TomlTable | undefined)?.default_step_budget;
  if (typeof own === "number" && own > 0) return own;
  return cap.otherwise !== undefined && cap.otherwise > 0 ? cap.otherwise : undefined;
}

/** Whether the user (not the built-in default) chose network.mode, and what. */
export function explicitNetworkMode(repoPath: string, argv: string[] = []): string | undefined {
  const cli = cliOverrides(argv).network as TomlTable | undefined;
  if (typeof cli?.mode === "string") return cli.mode;
  for (const path of [
    join(repoPath, ".sekhemet", "config.toml"),
    process.env.SEKHEMET_USER_CONFIG ?? join(userDir(), "config.toml"),
  ]) {
    if (!existsSync(path)) continue;
    try {
      const mode = (parseToml(readFileSync(path, "utf8")).network as TomlTable | undefined)?.mode;
      if (typeof mode === "string") return mode;
    } catch {
      // An unreadable file sets nothing.
    }
  }
  return undefined;
}

/** Queue defaults from config: models and step budget, where flags left them open. */
export function queueDefaults(
  cfg: ResolvedConfig["config"],
  argv: string[],
): { worker?: string; manager?: string; maxTurns?: number } {
  const has = (f: string) => argv.includes(f);
  return {
    // Only what config.toml names: the person's assignment outranks config
    // (MD-N10-3), and an unset Worker falls back to `defaultWorkerName()` last.
    ...(!has("--worker") && cfg.models.executor !== "auto" ? { worker: cfg.models.executor } : {}),
    ...(!has("--manager") && cfg.models.planner !== "auto" ? { manager: cfg.models.planner } : {}),
    ...(!has("--max-turns") && cfg.loop.defaultStepBudget > 0
      ? { maxTurns: cfg.loop.defaultStepBudget }
      : {}),
  };
}

/** The board's Review limit from `[review] wip` ("auto" keeps the board's own). */
export function reviewLimit(cfg: ResolvedConfig["config"]): number | undefined {
  return typeof cfg.review.wip === "number" && cfg.review.wip > 0 ? cfg.review.wip : undefined;
}

/**
 * A `[network]` table as read: the policy's keys, and the hosts a research
 * yes covers (design-stage DS-S8-8): `research_hosts`, the hosts the question
 * the person answered yes to named, and `research_hosts_declined`, the hosts
 * a later question named and the person said no to. Only the user's file's
 * are read (a project may not widen research).
 */
export type NetworkTable = NetworkConfig & {
  researchHosts?: string[];
  researchHostsDeclined?: string[];
};

/**
 * The user's and the project's `[network]` tables, kept apart so the policy
 * can let the project only narrow (security item 28). Keys: `mode`,
 * `fetch_allow` (`allow`, the older name, is read as the same key),
 * `fetch_deny`, `research`, `research_hosts`, `research_hosts_declined`.
 */
export function networkConfigs(
  repoPath: string,
  userConfigPath = process.env.SEKHEMET_USER_CONFIG ?? join(userDir(), "config.toml"),
): { user: NetworkTable; project: NetworkTable } {
  const read = (path: string): NetworkTable => {
    if (!existsSync(path)) return {};
    try {
      const t = (parseToml(readFileSync(path, "utf8")).network ?? {}) as TomlTable;
      const list = (v: unknown) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
      const mode = t.mode;
      const allow = list(t.fetch_allow) ?? list(t.allow);
      const deny = list(t.fetch_deny);
      const hosts = list(t.research_hosts)?.map((h) => h.toLowerCase());
      const declined = list(t.research_hosts_declined)?.map((h) => h.toLowerCase());
      return {
        ...(mode === "offline" || mode === "allowlist" || mode === "open" ? { mode } : {}),
        ...(allow ? { fetchAllow: allow } : {}),
        ...(deny ? { fetchDeny: deny } : {}),
        ...(t.research === "yes" || t.research === "no" ? { research: t.research } : {}),
        ...(hosts ? { researchHosts: hosts } : {}),
        ...(declined ? { researchHostsDeclined: declined } : {}),
      };
    } catch {
      // An unreadable file widens nothing.
      return {};
    }
  };
  return { user: read(userConfigPath), project: read(join(repoPath, ".sekhemet", "config.toml")) };
}

/**
 * The Worker when no flag, assignment or config.toml names one: the roster's
 * for this machine's tier (SUR-11), the same resolution the dashboard's roster
 * uses. Always the last fallback, never ahead of the person's assignment
 * (MD-N10-3: the flag, then the assignment, then config.toml, then this).
 */
export function defaultWorkerName(): string {
  return recommendRoster().worker;
}
