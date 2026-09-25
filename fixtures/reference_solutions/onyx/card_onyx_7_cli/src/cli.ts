export type Command =
  | { kind: "set"; project: string; key: string; value: string }
  | { kind: "get"; project: string; key: string }
  | { kind: "list"; project: string }
  | { kind: "run"; project: string; command: string; args: string[] }
  | { kind: "scan" }
  | { kind: "export"; project: string; out: string }
  | { kind: "error"; message: string };

export type Color = "red" | "green" | "yellow";

const CODES: Record<Color, number> = { red: 31, green: 32, yellow: 33 };

export function colorize(text: string, color: Color, enabled: boolean): string {
  return enabled ? `\x1b[${CODES[color]}m${text}\x1b[0m` : text;
}

const error = (message: string): Command => ({ kind: "error", message });

export function parseArgs(argv: string[]): Command {
  const dash = argv.indexOf("--");
  const before = dash >= 0 ? argv.slice(0, dash) : argv;
  const after = dash >= 0 ? argv.slice(dash + 1) : undefined;

  let project = "default";
  const words: string[] = [];
  for (let i = 0; i < before.length; i++) {
    const word = before[i] as string;
    if (word === "--project") {
      const value = before[i + 1];
      if (value === undefined) return error("missing value for --project");
      project = value;
      i++;
    } else {
      words.push(word);
    }
  }

  const [name, ...rest] = words;
  switch (name) {
    case undefined:
      return error("usage: onyx COMMAND");
    case "set":
      return rest.length === 2
        ? { kind: "set", project, key: rest[0] as string, value: rest[1] as string }
        : error("usage: onyx set KEY VALUE");
    case "get":
      return rest.length === 1
        ? { kind: "get", project, key: rest[0] as string }
        : error("usage: onyx get KEY");
    case "list":
      return rest.length === 0 ? { kind: "list", project } : error("usage: onyx list");
    case "run": {
      const [command, ...args] = after ?? [];
      if (rest.length !== 0 || command === undefined) {
        return error("usage: onyx run -- CMD ARGS...");
      }
      return { kind: "run", project, command, args };
    }
    case "scan":
      return rest.length === 0 ? { kind: "scan" } : error("usage: onyx scan");
    case "export":
      return rest.length === 1
        ? { kind: "export", project, out: rest[0] as string }
        : error("usage: onyx export FILE");
    default:
      return error(`unknown command: ${name}`);
  }
}
