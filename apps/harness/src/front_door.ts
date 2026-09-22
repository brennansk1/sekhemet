import { WAVE2_COMMANDS } from "./wave2.js";

/**
 * The front door (design: "The command surface"). Eight commands a user
 * meets; everything else keeps its implementation behind `dev`, listed only by
 * `sekhemet dev --help`. A command called directly without `dev` still runs —
 * the harness's scripts and the author's habits call them — it is simply not
 * listed.
 */
export const FRONT_DOOR: readonly { usage: string; what: string }[] = [
  { usage: "sekhemet", what: "Set up on first run, then open the board" },
  { usage: 'sekhemet "<spec>"', what: "Plan the work and run it" },
  { usage: "sekhemet run [card]", what: "Run a card, resume a stopped one, or run the queue" },
  { usage: "sekhemet review", what: "Show the next card waiting on you" },
  {
    usage: "sekhemet accept <card>",
    what: 'Accept and merge. Also: send-back <card> "<reason>", park / unpark <card>',
  },
  { usage: "sekhemet board", what: "The board (--terminal for text)" },
  { usage: "sekhemet doctor", what: "Check the install, including the model weights" },
  { usage: "sekhemet dev <command>", what: "Everything for developing the harness itself" },
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
  "abort",
  "rewind",
  "fork",
  "resume",
  "overnight",
  "calibrate",
  "daemon",
  "traces",
  "acp",
  "init",
  ...WAVE2_COMMANDS,
] as const;

const TRIAGE = ["review", "send-back", "park", "unpark"] as const;

/** Flags that take a value, so the value is not mistaken for a command or spec. */
const VALUED = new Set([
  "--repo",
  "--model",
  "--worker",
  "--manager",
  "--port",
  "--until",
  "--fixture",
  "--workers",
  "--out",
]);

export type FrontDoorRoute =
  | { kind: "home"; flags: string[] }
  | { kind: "help" }
  | { kind: "dev-help" }
  | { kind: "spec"; spec: string; flags: string[] }
  | { kind: "unknown"; word: string; suggest?: string }
  | { kind: "review"; flags: string[] }
  | { kind: "send-back"; cardId: string; reason: string; flags: string[] }
  | { kind: "park"; cardId: string; reason: string; flags: string[] }
  | { kind: "unpark"; cardId: string; flags: string[] }
  | { kind: "argv"; argv: string[] };

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
  if (argv.includes("--help") && argv[0] !== "dev") return { kind: "help" };
  const { positional, flags } = split(argv);
  const [first, ...rest] = positional;
  if (first === undefined) return { kind: "home", flags };
  if (first === "help") return { kind: "help" };

  if (first === "dev") {
    const [cmd] = rest;
    if (!cmd || argv.includes("--help")) return { kind: "dev-help" };
    return { kind: "argv", argv: argv.slice(argv.indexOf("dev") + 1) };
  }

  if (first === "run" && rest.length === 0) {
    return { kind: "argv", argv: ["queue", ...flags] };
  }

  const [cardId = "", ...words] = rest;
  if (first === "review") return { kind: "review", flags };
  if ((first === "send-back" || first === "park" || first === "unpark") && !cardId) {
    return { kind: "unknown", word: `${first} needs a card id` };
  }
  if (first === "send-back") return { kind: "send-back", cardId, reason: words.join(" "), flags };
  if (first === "park") return { kind: "park", cardId, reason: words.join(" "), flags };
  if (first === "unpark") return { kind: "unpark", cardId, flags };

  if ((COMMANDS as readonly string[]).includes(first)) return { kind: "argv", argv: [...argv] };

  // Not a command. A sentence is a request for work; a single word is almost
  // always a typo, and planning a typo writes cards to the board.
  if (/\s/.test(first.trim())) return { kind: "spec", spec: first, flags };
  const known = [...FRONT_DOOR.map((c) => c.usage.split(" ")[1] ?? ""), ...TRIAGE].filter((c) =>
    /^[a-z-]+$/.test(c),
  );
  const best = known.map((c) => ({ c, d: distance(first, c) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= 2
    ? { kind: "unknown", word: first, suggest: best.c }
    : { kind: "unknown", word: first };
}
