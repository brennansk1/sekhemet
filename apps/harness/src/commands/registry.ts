import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import type { BoardServiceImpl } from "@sekhemet/board";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import type { CliExit, CliResult } from "./cli_result.js";

/**
 * One registry of commands (surface item 17, T4; FINDINGS_C1 NAM-02): each
 * entry's name, visibility, flags, handler and help feed the parser, the
 * dispatcher (`index.ts` `runRegistered`) and both help screens, so a
 * command cannot have a handler the parser never reaches. Flags are parsed
 * once, by `node:util` `parseArgs`, from the entry's own schema; a flag it
 * does not take is a usage error (exit 2).
 *
 * The commands move here one at a time as workstreams touch them (strangler
 * fig): those not listed still run from `main`. Handlers load lazily, so the
 * front door's routing (`cli_commands.ts`) reads the table without them.
 */

export interface OptionSpec {
  type: "string" | "boolean";
  multiple?: boolean;
}

export interface ParsedCommand {
  values: Record<string, string | boolean | string[] | undefined>;
  /** The positionals after the command's own name. */
  positionals: string[];
}

/** The ledger as every command opens it (`index.ts` `initLocalKernel`). */
export interface LocalKernel {
  db: DatabaseSync;
  log: EventLog;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
}

export interface CommandEnv {
  /** The entry's name (`run` and `resume` share a handler). */
  command: string;
  /** The command line as routed, the command's name among it. */
  argv: string[];
  /** The folder the command acts on (surface item 8a, `cliWorkspace`). */
  repoPath: string;
  workspaceFolder: string;
  projectId?: string;
  restrictedMode: boolean;
  /** `--json`: progress goes to stderr and the result is the one object on stdout. */
  json: boolean;
  /**
   * The ledger, opened once. `write` also records the repository as a
   * project (K14) and calibrates Review's limit, as `main` does before the
   * commands that change the board; `read` opens it and nothing more.
   */
  kernel(mode: "read" | "write"): Promise<LocalKernel>;
}

export type CommandHandler = (args: ParsedCommand, env: CommandEnv) => Promise<CliResult | CliExit>;

export interface CommandSpec {
  name: string;
  /** Front: `sekhemet --help`; dev: `sekhemet dev --help` (surface rule 14). */
  visibility: "front" | "dev";
  /** The command's row in its help screen. */
  usage: string;
  what: string;
  /** `sekhemet <name> --help`: the synopsis with every flag, and one example. */
  synopsis: string;
  example: string;
  /** The command's own flags; the global ones are added to every entry. */
  options: Record<string, OptionSpec>;
  positionals: { min: number; max: number };
  /** What the positional is, for a usage error: "an issue ID" unless said. */
  positionalWord?: string;
  /** Takes `--json` (surface item 20c). */
  json: boolean;
  /**
   * Reads or changes a project's board: in a folder that is no project and
   * holds no ledger it says so in one line, exits 2 and writes nothing
   * (FINDINGS_C1 CLI-05).
   */
  needsProject: boolean;
  load(): Promise<CommandHandler>;
}

/** Flags every command takes. `--debug` is taken off the command line first (SUR-57). */
export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  repo: { type: "string" },
  restricted: { type: "boolean" },
  trust: { type: "boolean" },
  set: { type: "string", multiple: true },
  debug: { type: "boolean" },
};

/** The flags `run` takes: the Coding model, the step cap and the run profile's own (SUR-44, SUR-45). */
const RUN_OPTIONS: Record<string, OptionSpec> = {
  worker: { type: "string" },
  "max-turns": { type: "string" },
  settings: { type: "string" },
  profile: { type: "string" },
  manager: { type: "string" },
  reviewer: { type: "string" },
  researcher: { type: "string" },
  arm: { type: "string" },
  seed: { type: "string" },
  prune: { type: "string" },
  "tool-arm": { type: "string" },
  explore: { type: "boolean" },
  review: { type: "boolean" },
  "escalate-retries": { type: "boolean" },
  "auto-accept": { type: "boolean" },
};

const JSON_OPTION: Record<string, OptionSpec> = { json: { type: "boolean" } };

export const COMMAND_REGISTRY: readonly CommandSpec[] = [
  {
    name: "run",
    visibility: "front",
    usage: "sekhemet run [issue]",
    what: "Run an issue, resume a stopped one, or run the queue",
    synopsis:
      "sekhemet run <issue> [--worker <model>] [--max-turns <n>] [--settings <file>] [--json]   (with no issue: the queue)",
    example: "sekhemet run TS-101",
    options: { ...RUN_OPTIONS, ...JSON_OPTION },
    positionals: { min: 1, max: 1 },
    json: true,
    needsProject: true,
    load: async () => (await import("./run.js")).runCommand,
  },
  {
    name: "resume",
    visibility: "dev",
    usage: "resume <issue> | resume <project>",
    what: "Continue an issue that stopped part-way, or resume a paused project",
    synopsis:
      "sekhemet resume <issue> [--worker <model>] [--max-turns <n>]   |   sekhemet resume <project id or name>",
    example: "sekhemet resume TS-101",
    options: RUN_OPTIONS,
    positionals: { min: 1, max: 1 },
    json: false,
    needsProject: true,
    load: async () => (await import("./run.js")).runCommand,
  },
  {
    name: "review",
    visibility: "front",
    usage: "sekhemet review",
    what: "Show the next issue waiting on you",
    synopsis: "sekhemet review [issue]",
    example: "sekhemet review TS-101",
    options: {},
    positionals: { min: 0, max: 1 },
    json: false,
    needsProject: true,
    load: async () => (await import("./review.js")).reviewCommand,
  },
  {
    name: "accept",
    visibility: "front",
    usage: "sekhemet accept <issue>",
    what: 'Accept and merge. Also: request-changes <issue> "<reason>", park / unpark <issue>, reject <issue> "<reason>", reopen <issue>, revert <issue>; sekhemet card message|pause|hand-back|take-over <issue> for a running one',
    synopsis: "sekhemet accept <issue> [--ack <finding numbers>] [--json]",
    example: "sekhemet accept TS-101 --ack 1,2",
    options: { ack: { type: "string", multiple: true }, ...JSON_OPTION },
    positionals: { min: 1, max: 1 },
    json: true,
    needsProject: true,
    load: async () => (await import("./accept.js")).acceptCommand,
  },
  {
    name: "doctor",
    visibility: "front",
    usage: "sekhemet doctor",
    what: "Check the install, including the model weights",
    synopsis:
      "sekhemet doctor [--json] [--verify-weights] [--report]   |   sekhemet doctor --airgap [--models-dir <dir>] [--query <question>] [--run-gates]   |   sekhemet doctor --check-updates [--yes]",
    example: "sekhemet doctor --json",
    options: {
      airgap: { type: "boolean" },
      // SUR-89: hash every weights file the cache does not hold.
      "verify-weights": { type: "boolean" },
      // SUR-90: write the redacted report folder, and send nothing.
      report: { type: "boolean" },
      "models-dir": { type: "string" },
      query: { type: "string" },
      "run-gates": { type: "boolean" },
      // SUR-66, SUR-67: ask the npm registry for the latest version, after a yes.
      "check-updates": { type: "boolean" },
      yes: { type: "boolean" },
      ...JSON_OPTION,
    },
    positionals: { min: 0, max: 0 },
    json: true,
    needsProject: false,
    load: async () => (await import("./doctor.js")).doctorCommand,
  },
  {
    name: "status",
    visibility: "dev",
    usage: "status [--json]",
    what: "The board for a script: each column's issues, what the queue runs next, and what waits on a person",
    synopsis: "sekhemet status [--json]",
    example: "sekhemet status --json",
    options: JSON_OPTION,
    positionals: { min: 0, max: 0 },
    json: true,
    needsProject: true,
    load: async () => (await import("./status.js")).statusCommand,
  },
  {
    name: "egress",
    visibility: "dev",
    usage: "egress [--since <time>] [--refused] [--json]",
    what: "What has left this machine: every recorded network request and model download, newest first",
    synopsis: "sekhemet egress [--since <date or time>] [--refused] [--json]",
    example: "sekhemet egress --since 2026-10-01 --refused",
    options: { since: { type: "string" }, refused: { type: "boolean" }, ...JSON_OPTION },
    positionals: { min: 0, max: 0 },
    json: true,
    needsProject: true,
    load: async () => (await import("./egress.js")).egressCommand,
  },
  {
    name: "engine",
    visibility: "dev",
    usage: "engine [status | get [--yes]]",
    what: "The inference engine: which llama-server is used and its build, or get the pinned llama.cpp release",
    synopsis: "sekhemet engine [status]   |   sekhemet engine get [--yes]",
    example: "sekhemet engine get --yes",
    options: { yes: { type: "boolean" } },
    positionals: { min: 0, max: 1 },
    positionalWord: "status or get",
    json: false,
    needsProject: true,
    load: async () => (await import("./engine.js")).engineCommand,
  },
  {
    name: "editors",
    visibility: "dev",
    usage: "editors [vscode|cursor|zed]",
    what: "The snippet that connects VS Code, Cursor or Zed to the board and to Seshat, and where it goes",
    synopsis: "sekhemet editors [vscode | cursor | zed]",
    example: "sekhemet editors vscode",
    options: {},
    positionals: { min: 0, max: 1 },
    json: false,
    needsProject: false,
    load: async () => (await import("./editors.js")).editorsCommand,
  },
  {
    // Runtime items 35, 35a (NEW-runtime-11): run as `sekhemet backup`, listed
    // under `dev --help` (item 35's C4 decision; surface rules 13-14).
    name: "backup",
    visibility: "dev",
    usage: "backup [<path>] [--list]",
    what: "Back the workspace up outside the repository: the Activity log, its blobs and evidence, each project's configuration; --list shows the sets with their schema",
    synopsis: "sekhemet backup   |   sekhemet backup <file>   |   sekhemet backup --list",
    example: "sekhemet backup --list",
    options: { list: { type: "boolean" } },
    positionals: { min: 0, max: 1 },
    positionalWord: "a path",
    json: false,
    needsProject: true,
    load: async () => (await import("../ledger_cmds.js")).backupCommand,
  },
  {
    // Runtime items 35a, 36 (RUN-61, RUN-87, RUN-88): with the server stopped.
    name: "restore",
    visibility: "dev",
    usage: "restore <set or file> | --latest",
    what: "Restore the workspace from a backup, re-applying erasures; --latest takes the newest set that verifies",
    synopsis: "sekhemet restore --latest   |   sekhemet restore <set folder or file>",
    example: "sekhemet restore --latest",
    options: { latest: { type: "boolean" } },
    positionals: { min: 0, max: 1 },
    positionalWord: "a backup",
    json: false,
    needsProject: false,
    load: async () => (await import("../ledger_cmds.js")).restoreCommand,
  },
  {
    // Surface item 19a (C5): moved from `main`, the queue's body unchanged.
    // `sekhemet run` with no issue runs it, and `overnight` runs it per round.
    name: "queue",
    visibility: "dev",
    usage: "queue [--worker <model>] [--manager <model>]",
    what: "Run every Ready issue in board order; `sekhemet run` with no issue does the same",
    synopsis:
      "sekhemet queue [--worker <model>] [--manager <model>] [--reviewer <model>] [--researcher <model>] [--max-turns <n>] [--settings <file>] [--review] [--explore] [--escalate-retries] [--calibration-night --permit-loads]",
    example: "sekhemet queue --worker nail-mtp",
    options: {
      ...RUN_OPTIONS,
      // Measurement rule 16d: a calibration night, only with the owner's --permit-loads.
      "calibration-night": { type: "boolean" },
      "permit-loads": { type: "boolean" },
    },
    positionals: { min: 0, max: 0 },
    json: false,
    needsProject: false,
    load: async () => (await import("./queue.js")).queueCommand,
  },
  {
    // Surface items 5–7 and 20 (C5): moved from `main`; the bare `sekhemet` opens it.
    name: "board",
    visibility: "dev",
    usage: "board [--terminal]",
    what: "The board in the browser (the bare `sekhemet` opens it), or the text board with --terminal",
    synopsis: "sekhemet board [--terminal] [--port <n>] [--yes]",
    example: "sekhemet board --terminal",
    options: {
      terminal: { type: "boolean" },
      port: { type: "string" },
      yes: { type: "boolean" },
      // The bare `sekhemet`'s own flags, which it passes on when it opens the board.
      "models-dir": { type: "string" },
      "new-workspace": { type: "boolean" },
    },
    positionals: { min: 0, max: 0 },
    json: false,
    needsProject: false,
    load: async () => (await import("./board.js")).boardCommand,
  },
  {
    // Runtime items 5 and 5a (H1, MD-N17-3, NEW-runtime-15): moved from `main` in C5.
    name: "daemon",
    visibility: "dev",
    usage: "daemon start|stop|status [--at-login] [--all]",
    what: "The dashboard in the background; --at-login starts it at every login; status --all lists every workspace's server",
    synopsis:
      "sekhemet daemon start [--port <n>] [--at-login]   |   sekhemet daemon stop [--at-login]   |   sekhemet daemon status [--all]",
    example: "sekhemet daemon start --at-login",
    options: {
      port: { type: "string" },
      all: { type: "boolean" },
      "at-login": { type: "boolean" },
    },
    positionals: { min: 0, max: 1 },
    positionalWord: "start, stop or status",
    json: false,
    needsProject: false,
    load: async () => (await import("./daemon.js")).daemonCommand,
  },
  {
    // Surface item 33 (NEW-surface-7, SUR-58, SUR-59): listed under `dev --help`.
    name: "uninstall",
    visibility: "dev",
    usage: "uninstall --dry-run | --yes [--include-ledgers]",
    what: "List, or remove, everything this install wrote outside its package; ledgers and backups are kept unless --include-ledgers",
    synopsis: "sekhemet uninstall --dry-run   |   sekhemet uninstall --yes [--include-ledgers]",
    example: "sekhemet uninstall --dry-run",
    options: {
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
      "include-ledgers": { type: "boolean" },
    },
    positionals: { min: 0, max: 0 },
    json: false,
    needsProject: false,
    load: async () => (await import("./uninstall.js")).uninstallCommand,
  },
];

export function findCommand(name: string | undefined): CommandSpec | undefined {
  return COMMAND_REGISTRY.find((c) => c.name === name);
}

/** The front door's row for a moved command (`PRIMARY_COMMANDS`). */
export function helpRow(name: string): { usage: string; what: string } {
  const spec = findCommand(name);
  if (!spec) throw new Error(`no registered command ${name}`);
  return { usage: spec.usage, what: spec.what };
}

/** `sekhemet <name> --help`. */
export function commandHelpLines(spec: CommandSpec): string[] {
  return [
    spec.what,
    "",
    `Usage: ${spec.synopsis}`,
    `Example: ${spec.example}`,
    "",
    "Also: --repo <folder> runs it on another folder's project.",
  ];
}

/**
 * The flags of `argv` the entry takes, with their values; any other flag is
 * left out with its value (`argv` holds flags and their values only, as the
 * front door splits a spec's command line). The spec route hands the queue
 * only its own flags this way.
 */
export function flagsTakenBy(spec: CommandSpec, argv: readonly string[]): string[] {
  const options: Record<string, OptionSpec> = { ...GLOBAL_OPTIONS, ...spec.options };
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) continue;
    const name = a.slice(2).split("=")[0] as string;
    const option = Object.hasOwn(options, name) ? options[name] : undefined;
    const valued = !a.includes("=") && !(argv[i + 1] ?? "-").startsWith("-");
    if (option) {
      out.push(a);
      if (option.type === "string" && valued) out.push(argv[++i] as string);
    } else if (valued) i++;
  }
  return out;
}

/**
 * The command line through the entry's own schema: its flags and the global
 * ones, its positionals counted. A usage error is one sentence, naming the
 * flag and where the command's help is.
 */
export function parseCommandArgs(
  spec: CommandSpec,
  argv: readonly string[],
): ParsedCommand | { error: string } {
  const help = `\`sekhemet ${spec.name} --help\` lists what it takes`;
  let parsed: { values: ParsedCommand["values"]; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { ...GLOBAL_OPTIONS, ...spec.options },
      allowPositionals: true,
      strict: true,
    }) as typeof parsed;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    const flag = /'(-[^'\s]+)/.exec(message)?.[1] ?? "";
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION")
      return { error: `sekhemet ${spec.name} does not take ${flag}; ${help}` };
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE")
      return {
        error: `${flag.replace(/ <.*$/, "") || "a flag"} needs ${/argument missing/.test(message) ? "a value" : "no value"}; ${help}`,
      };
    return { error: `${message}; ${help}` };
  }
  const at = parsed.positionals.indexOf(spec.name);
  const positionals = at === -1 ? parsed.positionals : parsed.positionals.slice(at + 1);
  if (positionals.length < spec.positionals.min)
    return { error: `sekhemet ${spec.name} needs an issue ID: ${spec.synopsis}` };
  if (positionals.length > spec.positionals.max)
    return {
      error: `sekhemet ${spec.name} takes ${spec.positionals.max === 0 ? "no issue ID" : spec.positionalWord ? `only ${spec.positionalWord}` : "one issue ID"}, not ${positionals.slice(spec.positionals.max).join(" ")}: ${spec.synopsis}`,
    };
  return { values: parsed.values, positionals };
}
