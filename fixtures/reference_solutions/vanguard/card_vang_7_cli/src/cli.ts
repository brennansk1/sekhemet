import type { WebhookEvent } from "./types.js";

export type Command =
  | { kind: "start"; port: number; db: string }
  | { kind: "list"; source: string | null; limit: number }
  | { kind: "replay"; id: number; to: string; headers: Record<string, string> }
  | { kind: "tail" }
  | { kind: "error"; message: string };

const ALLOWED: Record<string, string[]> = {
  start: ["--port", "--db"],
  list: ["--source", "--limit"],
  replay: ["--to", "-H"],
  tail: [],
};

const error = (message: string): Command => ({ kind: "error", message });

export function parseArgs(argv: string[]): Command {
  const [name, ...rest] = argv;
  if (name === undefined) return error("usage: vanguard start|list|replay|tail");
  const allowed = ALLOWED[name];
  if (allowed === undefined) return error(`unknown command: ${name}`);

  const flags = new Map<string, string>();
  const headerValues: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith("-")) {
      words.push(arg);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) return error(`missing value for ${arg}`);
    i++;
    if (!allowed.includes(arg)) return error(`unknown option: ${arg}`);
    if (arg === "-H") headerValues.push(value);
    else flags.set(arg, value);
  }

  switch (name) {
    case "start": {
      const raw = flags.get("--port") ?? "4040";
      if (!/^\d+$/.test(raw) || Number(raw) > 65535) return error(`invalid port: ${raw}`);
      if (words.length > 0) return error("usage: vanguard start");
      return { kind: "start", port: Number(raw), db: flags.get("--db") ?? "vanguard.db" };
    }
    case "list": {
      const raw = flags.get("--limit") ?? "20";
      if (!/^\d+$/.test(raw) || Number(raw) < 1) return error(`invalid limit: ${raw}`);
      if (words.length > 0) return error("usage: vanguard list");
      return { kind: "list", source: flags.get("--source") ?? null, limit: Number(raw) };
    }
    case "replay": {
      const to = flags.get("--to");
      const word = words[0];
      if (words.length !== 1 || word === undefined || to === undefined) {
        return error("usage: vanguard replay ID --to URL");
      }
      if (!/^[1-9]\d*$/.test(word)) return error(`invalid event id: ${word}`);
      const headers: Record<string, string> = {};
      for (const value of headerValues) {
        const colon = value.indexOf(":");
        const headerName = colon < 0 ? "" : value.slice(0, colon).trim().toLowerCase();
        if (headerName === "") return error(`invalid header: ${value}`);
        headers[headerName] = value.slice(colon + 1).trim();
      }
      return { kind: "replay", id: Number(word), to, headers };
    }
    default:
      return words.length > 0 ? error("usage: vanguard tail") : { kind: "tail" };
  }
}

export function formatEventLine(event: WebhookEvent): string {
  return `#${event.id} ${event.source} ${event.method} ${event.path} ${event.verification} ${event.body.length}B ${new Date(event.receivedAt).toISOString()}`;
}
