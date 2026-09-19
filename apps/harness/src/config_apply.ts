import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type TomlTable, parseToml } from "@sekhemet/kernel";
import { type ResolvedConfig, resolveConfig } from "./config.js";

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
    const section = (out[m[1] as string] ??= {}) as TomlTable;
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

/** Whether the user (not the built-in default) chose network.mode, and what. */
export function explicitNetworkMode(repoPath: string, argv: string[] = []): string | undefined {
  const cli = cliOverrides(argv).network as TomlTable | undefined;
  if (typeof cli?.mode === "string") return cli.mode;
  for (const path of [
    join(repoPath, ".sekhemet", "config.toml"),
    join(homedir(), ".sekhemet", "config.toml"),
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
