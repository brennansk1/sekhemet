import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sekhemetConfigDir } from "@sekhemet/models";

/**
 * One user directory (surface item 22, NEW-surface-1): `SEKHEMET_CONFIG_DIR`,
 * else `~/.sekhemet`. User config, the model registry, the machine profile,
 * integration settings, trust records, learning data, research memory and the
 * person's MCP servers all live under it, so the sandbox has one known
 * secret-bearing directory to deny (security item 10).
 */
export function userDir(): string {
  return sekhemetConfigDir();
}

/** Every piece of user state, by name (SUR-25). */
export function userPaths() {
  const d = userDir();
  return {
    config: join(d, "config.toml"),
    registry: join(d, "models.json"),
    machineProfile: join(d, "machine.json"),
    integrations: join(d, "repos"),
    trust: join(d, "trust"),
    learning: join(d, "global_playbook.json"),
    researchMemory: join(d, "research", "memory.jsonl"),
    searxng: join(d, "searxng"),
    mcp: join(d, "mcp.json"),
    hooks: join(d, "hooks.toml"),
    skills: join(d, "skills"),
    /** The workspaces this machine's person has used (runtime item 23c, DEC-57). */
    workspaces: join(d, "workspaces.json"),
  };
}

/** The record of the one-time move from `~/.config/sekhemet` (SUR-26). */
const MOVE_RECORD = "moved-from-config.json";

export interface LegacyMove {
  from: string;
  at?: string;
  /** Entries moved into the user directory. */
  moved: string[];
  /** Entries left behind because the user directory already has one by that name. */
  kept: string[];
}

function legacyDir(): string {
  return join(homedir(), ".config", "sekhemet");
}

/**
 * Move what an older Sekhemet kept in `~/.config/sekhemet` into the user
 * directory, once (SUR-26). An entry whose name the user directory already
 * has is left where it is and reported, never overwritten. The move is
 * recorded for `doctor`; the old directory is removed when it is empty.
 */
export function migrateLegacyUserDir(): LegacyMove {
  const from = legacyDir();
  const to = userDir();
  const result: LegacyMove = { from, moved: [], kept: [] };
  if (!existsSync(from) || from === to) return result;
  const entries = readdirSync(from);
  if (entries.length === 0) {
    rmdirSync(from);
    return result;
  }
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of entries) {
    if (existsSync(join(to, name))) result.kept.push(name);
    else {
      renameSync(join(from, name), join(to, name));
      result.moved.push(name);
    }
  }
  if (result.kept.length === 0) rmdirSync(from);
  const previous = readMoveRecord();
  const record: LegacyMove = {
    from,
    at: new Date().toISOString(),
    moved: [...(previous?.moved ?? []), ...result.moved],
    kept: result.kept,
  };
  writeFileSync(join(to, MOVE_RECORD), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return result;
}

/** What the one-time move did, if it ran. */
export function readMoveRecord(): LegacyMove | undefined {
  try {
    return JSON.parse(readFileSync(join(userDir(), MOVE_RECORD), "utf8")) as LegacyMove;
  } catch {
    return undefined;
  }
}
