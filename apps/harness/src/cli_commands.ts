import { COMMAND_REGISTRY, findCommand, helpRow } from "./commands/registry.js";
import { DEV_COMMANDS } from "./wave2.js";

/**
 * The front door (design: "The command surface"). Eight commands a user
 * meets; everything else keeps its implementation behind `dev`, listed only by
 * `sekhemet dev --help`. A command called directly without `dev` still runs —
 * the harness's scripts and the author's habits call them — it is simply not
 * listed.
 */
export const PRIMARY_COMMANDS: readonly { usage: string; what: string }[] = [
  { usage: "sekhemet", what: "Set up on first run, then open the board" },
  { usage: 'sekhemet "<spec>"', what: "Plan the work and run it" },
  // T4: the moved commands' rows come from the command registry.
  helpRow("run"),
  helpRow("review"),
  helpRow("accept"),
  // NEW-surface-6 (O23, approved under DEC-42): `ask` in place of `board`,
  // which the bare `sekhemet` opens; `board --terminal` is under `dev`.
  {
    usage: 'sekhemet ask "<question>"',
    what: "Ask Seshat from the terminal; the reply prints here",
  },
  helpRow("doctor"),
  { usage: "sekhemet dev <command>", what: "Everything for developing Sekhemet itself" },
];

/**
 * Every command `main` dispatches. One list, so a command cannot have a
 * handler that the parser never routes to — six did (`overnight`, which the
 * help listed, printed the help instead).
 */
export const COMMANDS = [
  "accept",
  "tune",
  "explore",
  "queue",
  "doctor",
  "board",
  "log",
  "serve",
  "ui",
  "run",
  "plan",
  "gate",
  "gates",
  "gate-host",
  "replay",
  "bake-off",
  "mcp",
  "research",
  // The Researcher bake-off on the research golden set (DS-N2-9, MD-N11-1..3).
  "research-bakeoff",
  "abort",
  "rewind",
  "fork",
  "resume",
  "overnight",
  "calibrate",
  "prompt-screen",
  "daemon",
  "traces",
  "acp",
  "init",
  "backup",
  "restore",
  "reserve",
  "pause",
  "trust",
  "ask",
  "take-over",
  "benchmark",
  "export",
  "erase",
  // `sekhemet project list|move` (surface item 20d, NEW-surface-11).
  "project",
  // `sekhemet status [--json]`: the board for a script (surface item 20c, NEW-surface-10).
  "status",
  // `sekhemet egress [--since] [--refused] [--json]`: what left the machine (security item 33a).
  "egress",
  // `sekhemet editors [vscode|cursor|zed]`: the editor snippets (extensibility item 25a).
  "editors",
  // `sekhemet engine [status | get [--yes]]`: the inference engine (models rule 6b, NEW-models-19).
  "engine",
  ...DEV_COMMANDS,
] as const;

/** The triage verbs; `send-back` is Request changes' old name, kept as its alias (DEC-52). */
const TRIAGE = [
  "review",
  "request-changes",
  "send-back",
  "park",
  "unpark",
  "reopen",
  "reject",
  "revert",
] as const;

/** What `sekhemet dev <word>` runs: every command, the triage verbs and `card`. */
const DEV_RUNNABLE: ReadonlySet<string> = new Set<string>([
  ...COMMANDS,
  ...TRIAGE,
  ...COMMAND_REGISTRY.map((c) => c.name),
  "ui",
]);

/** Flags that take a value, so the value is not mistaken for a command or spec. */
const VALUED = new Set([
  "--repo",
  // `accept <issue> --ack 1,2` (FINDINGS_C1 CLI-01).
  "--ack",
  "--model",
  "--worker",
  "--manager",
  "--port",
  "--host",
  "--until",
  "--fixture",
  "--workers",
  "--out",
  "--planner",
  "--sketcher",
  "--changelog",
  // `sekhemet depth <profile> --project <id>`, `take-over --approve TOP-n --project <id>`.
  "--project",
  // A slice's appetite (PM-P13-9): `sekhemet release extend <SLICE> --cards N --hours H`.
  "--cards",
  "--hours",
  // `research --effort <level>`; `research-bakeoff --adopt-from <run> --models a,b --pipelines p,q`.
  "--effort",
  "--adopt-from",
  "--models",
  "--pipelines",
]);

/**
 * Every flag the command line reads (S10, SUR-15): a flag outside this list is
 * named and refused with exit 2, never ignored. `front_door.spec` fails when
 * the source reads a flag this list lacks, so it cannot fall behind.
 */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "--ab-entry",
  "--ack",
  "--activate",
  "--adopt",
  "--adopt-from",
  "--after",
  "--airgap",
  "--answer",
  "--apply",
  "--approve",
  "--arm",
  "--as",
  "--attempt",
  "--auto-accept",
  "--bake-off",
  "--base",
  "--baseline",
  "--batch",
  "--because",
  "--before",
  "--branch",
  "--buckets",
  "--budgets",
  "--bug",
  "--by",
  "--calibration-night",
  "--candidate",
  "--card",
  "--cards",
  "--changelog",
  "--check",
  "--combination",
  "--confirm",
  "--cron",
  "--date",
  "--days",
  // SUR-57: global; the entry takes it off the command line before any parser.
  "--debug",
  "--deep",
  "--default",
  "--depth",
  "--diff",
  "--dry-run",
  "--effort",
  "--entry",
  "--escalate-retries",
  "--events",
  "--evidence",
  "--explore",
  "--filter",
  "--first",
  "--fixture",
  "--fixtures",
  "--folder",
  "--force",
  "--fresh",
  "--from",
  "--gate-rule",
  "--help",
  "--host",
  "--hours",
  "--id",
  "--identity",
  "--idle-min",
  "--independent",
  "--job",
  "--json",
  "--key",
  "--kind",
  "--ledger",
  "--limit",
  "--manager",
  "--max-commits",
  "--max-failures",
  "--max-mutants",
  "--max-steps",
  "--max-turns",
  "--memory",
  // `measure reviewer --method prove [--reasoning <level>] [--thinking-cap <n>]` (RG-P8-17).
  "--method",
  "--model",
  "--models",
  "--models-dir",
  "--mtp-ab",
  "--mutants",
  "--name",
  "--new-setup-token",
  // SUR-79: a first run in a repository that belongs to a workspace, anyway.
  "--new-workspace",
  "--no",
  "--no-baseline",
  "--no-names",
  "--no-private",
  "--offline",
  "--on",
  // `measure seshat|reviewer --only a,b` (PM-P6-13, RG-P8-13).
  "--only",
  "--otlp",
  "--out",
  "--output",
  "--override",
  "--pages",
  "--permit-loads",
  "--pinned",
  "--pipelines",
  "--planner",
  "--port",
  "--preserve",
  "--profile",
  "--project",
  "--prune",
  "--query",
  "--reason",
  "--reasoning",
  "--rebuild",
  "--record",
  // `models fetch --recommended [--yes]` (MD-N18-3, MD-N22-3).
  "--recommended",
  // `sekhemet egress --refused` (security item 33a, NEW-security-11).
  "--refused",
  "--release",
  "--repo",
  "--researcher",
  "--restart",
  "--restricted",
  "--reuse-eval",
  "--review",
  "--reviewer",
  "--role",
  "--root",
  "--rotated",
  "--round-limit-min",
  "--rounds",
  "--run-gates",
  "--runs",
  "--sampling",
  "--schema",
  "--secret",
  "--secret-file",
  "--seed",
  "--set",
  "--settings",
  "--sha256",
  "--show",
  "--sig",
  "--signers",
  "--since",
  "--since-hours",
  "--sketcher",
  "--skip-gate",
  "--speculative",
  "--status",
  "--store-dir",
  "--suite-runs",
  "--switch-to-solo",
  "--target",
  "--terminal",
  "--thinking",
  "--thinking-cap",
  "--threshold",
  "--tool-arm",
  "--trust",
  "--until",
  "--urgent",
  // `skills approve|revoke <name> --user`: the person's own skill (EXT-24, SEC-02).
  "--user",
  "--validate-tools",
  "--verbose",
  "--verify",
  "--version",
  "--web",
  "--with",
  "--without",
  "--work",
  "--worker",
  "--workers",
  "--workflow",
  "--write",
  "--yes",
  "-h",
  "-v",
  // `research --effort quick|standard|exhaustive` (DS-N2-7).
  // `research-bakeoff --adopt` / `--adopt-from <run>` (MD-N11-3).
  // `research-bakeoff --pipelines native,tool-loop` (DS-N2-9).
]);

/** The first flag not in {@link KNOWN_FLAGS}; `--name=value` is judged by its name. */
export function unknownFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return undefined;
    if (!a.startsWith("-") || /^-\d/.test(a) || a === "-") continue;
    const name = a.split("=")[0] as string;
    if (!KNOWN_FLAGS.has(name)) return name;
    // A valued flag's value is not a flag, even when it starts with a dash.
    if (VALUED.has(name) && !a.includes("=")) i++;
  }
  return undefined;
}

/** `sekhemet run <card>`'s exit status (SUR-16): 0 in Review or Done, else 1. */
export function runExitCode(finalStatus: string): 0 | 1 {
  return finalStatus === "review" || finalStatus === "done" ? 0 : 1;
}

export type FrontDoorRoute =
  | { kind: "home"; flags: string[] }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "unknown-flag"; flag: string }
  | { kind: "dev-help" }
  /** `sekhemet <command> --help` for a command the registry holds (T4). */
  | { kind: "command-help"; name: string }
  | { kind: "spec"; spec: string; flags: string[] }
  | { kind: "unknown"; word: string; suggest?: string }
  | { kind: "review"; cardId?: string; flags: string[] }
  | { kind: "send-back"; cardId: string; reason: string; flags: string[] }
  | { kind: "park"; cardId: string; reason: string; flags: string[] }
  | { kind: "unpark"; cardId: string; flags: string[] }
  | { kind: "reopen"; cardId: string; reason: string; flags: string[] }
  | { kind: "reject"; cardId: string; reason: string; flags: string[] }
  | { kind: "revert"; cardId: string; reason: string; flags: string[] }
  | { kind: "card"; verb: CardVerb; cardId: string; text: string; flags: string[] }
  | { kind: "argv"; argv: string[] };

/** `sekhemet card <verb> <card> …`: collaborating on a running issue (WL-N10-1..3). */
export const CARD_VERBS = ["message", "pause", "hand-back", "take-over"] as const;
export type CardVerb = (typeof CARD_VERBS)[number];

/** Positional arguments and flags, with each valued flag kept beside its value. */
function split(argv: readonly string[]): { positional: string[]; flags: string[] } {
  const positional: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("-")) {
      flags.push(a);
      const next = argv[i + 1];
      if (VALUED.has(a) && next !== undefined) {
        flags.push(next);
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

/** Whether the person asked for `--json` (`--json=<value>` included, which is then a usage error). */
export function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).some(
    (a) => a === "--json" || a.startsWith("--json="),
  );
}

/** The command a command line names, `dev` skipped: `dev status --frob` → `status`. */
export function firstWord(argv: readonly string[]): string | undefined {
  const { positional } = split(argv);
  return positional[0] === "dev" ? positional[1] : positional[0];
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

export function routeFrontDoor(argv: readonly string[]): FrontDoorRoute {
  // SUR-13: the version is printed before anything else is read or written.
  if (argv[0] === "--version" || argv[0] === "-v") return { kind: "version" };
  const bad = unknownFlag(argv);
  if (bad) return { kind: "unknown-flag", flag: bad };
  const { positional, flags } = split(argv);
  const [first, ...rest] = positional;
  if (argv.includes("--help") || argv.includes("-h")) {
    const named = first === "dev" ? rest[0] : first;
    if (findCommand(named)) return { kind: "command-help", name: named as string };
    if (first !== "dev") return { kind: "help" };
  }
  if (first === undefined) return { kind: "home", flags };
  if (first === "help") return { kind: "help" };

  if (first === "dev") {
    const [cmd] = rest;
    if (!cmd || cmd === "help" || argv.includes("--help")) return { kind: "dev-help" };
    // The board's decisions route as they do without `dev`.
    if ((TRIAGE as readonly string[]).includes(cmd) || cmd === "card") {
      const at = argv.indexOf("dev");
      return routeFrontDoor([...argv.slice(0, at), ...argv.slice(at + 1)]);
    }
    // FINDINGS_C1 CLI-04: a word that is no command is a usage error, never the help and exit 0.
    if (!DEV_RUNNABLE.has(cmd)) {
      const best = [...DEV_RUNNABLE]
        .map((c) => ({ c, d: distance(cmd, c) }))
        .sort((a, b) => a.d - b.d)[0];
      return best && best.d <= 2
        ? { kind: "unknown", word: cmd, suggest: `dev ${best.c}` }
        : { kind: "unknown", word: cmd };
    }
    return { kind: "argv", argv: argv.slice(argv.indexOf("dev") + 1) };
  }

  if (first === "run" && rest.length === 0) {
    return { kind: "argv", argv: ["queue", ...flags] };
  }

  const [cardId = "", ...words] = rest;
  if (first === "card") {
    const [verb = "", id = "", ...text] = rest;
    if (!(CARD_VERBS as readonly string[]).includes(verb) || !id) {
      return {
        kind: "unknown",
        word: `sekhemet card needs a verb and an issue ID: sekhemet card ${CARD_VERBS.join("|")} <issue> …`,
      };
    }
    return { kind: "card", verb: verb as CardVerb, cardId: id, text: text.join(" "), flags };
  }
  if (first === "review") return { kind: "review", ...(cardId ? { cardId } : {}), flags };
  if (
    (first === "request-changes" ||
      first === "send-back" ||
      first === "park" ||
      first === "unpark" ||
      first === "reopen" ||
      first === "reject" ||
      first === "revert") &&
    !cardId
  ) {
    return { kind: "unknown", word: `${first} needs an issue ID` };
  }
  if (first === "request-changes" || first === "send-back")
    return { kind: "send-back", cardId, reason: words.join(" "), flags };
  if (first === "park") return { kind: "park", cardId, reason: words.join(" "), flags };
  if (first === "unpark") return { kind: "unpark", cardId, flags };
  if (first === "reopen") return { kind: "reopen", cardId, reason: words.join(" "), flags };
  if (first === "reject") return { kind: "reject", cardId, reason: words.join(" "), flags };
  if (first === "revert") return { kind: "revert", cardId, reason: words.join(" "), flags };

  if ((COMMANDS as readonly string[]).includes(first)) return { kind: "argv", argv: [...argv] };

  // Not a command. A sentence is a request for work; a single word is almost
  // always a typo, and planning a typo writes cards to the board.
  if (/\s/.test(first.trim())) return { kind: "spec", spec: first, flags };
  const known = [...PRIMARY_COMMANDS.map((c) => c.usage.split(" ")[1] ?? ""), ...TRIAGE].filter(
    (c) => /^[a-z-]+$/.test(c),
  );
  const best = known.map((c) => ({ c, d: distance(first, c) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= 2
    ? { kind: "unknown", word: first, suggest: best.c }
    : { kind: "unknown", word: first };
}
