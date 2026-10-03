import { constants, accessSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { delimiter, join } from "node:path";
import { type EventLog, type TomlTable, parseToml } from "@sekhemet/kernel";
import { runTrusted } from "@sekhemet/sandbox";
import { NOTIFY_WINDOW_MS, shortId, waitingCount, waitingLine } from "@sekhemet/ui";
import { userConfigPath } from "./config.js";
import { writeTomlTableKeys } from "./toml_keys.js";

/**
 * The operating-system notification when the dashboard is closed (dashboard
 * §2.16.4, NEW-dashboard-22, DB-N22-5 to -7; DEC-53 c4's smallest proposal;
 * FINDINGS PRC-11). Solo only: in the Team setup the server is not the
 * person's computer. Off until the person turns it on (`[notify] desktop`
 * in the user configuration). While it is on and no dashboard tab holds the
 * live stream, an issue entering In review raises one notification through
 * the system's own tool — `osascript` on macOS, `notify-send` on Linux —
 * naming the issue's key, title and where it waits, with the browser's
 * words (`@sekhemet/ui` `notify.ts`) and its 60-second batching. The text is
 * an argument after a fixed script, never spliced into a script or a shell
 * command (DB-N22-6). No library.
 */

export interface DesktopTool {
  kind: "osascript" | "notify-send";
  path: string;
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The system's own notification tool on the PATH, or undefined when there is none. */
export function findDesktopTool(
  platform: NodeJS.Platform = process.platform,
  pathList: string = process.env.PATH ?? "",
): DesktopTool | undefined {
  const kind =
    platform === "darwin" ? "osascript" : platform === "linux" ? "notify-send" : undefined;
  if (!kind) return undefined;
  for (const dir of pathList.split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, kind);
    if (executable(path)) return { kind, path };
  }
  return undefined;
}

/** Why the switch is disabled on this system (DB-N22-7). */
export function desktopUnavailable(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin")
    return "This Mac has no osascript on the PATH, so Sekhemet cannot raise a notification here.";
  if (platform === "linux")
    return "notify-send is not installed, so Sekhemet cannot raise a notification here. Your desktop's libnotify tools provide it.";
  return "Sekhemet raises this notification through osascript on macOS or notify-send on Linux, and this system has neither.";
}

/** Why the Team setup does not offer it. */
export const DESKTOP_TEAM_REASON =
  "In the Team setup Sekhemet runs on a server, not on your computer, so it cannot raise a notification there. Turn on the browser notification above, or connect a notification channel in Integrations.";

/**
 * The tool's arguments: a fixed script and the text as one argument after
 * it (DB-N22-6). A line never starts with `-`, so no tool reads it as an option.
 */
export function desktopArgs(tool: DesktopTool, text: string): string[] {
  const line = text.replace(/^[\s-]+/, "");
  return tool.kind === "osascript"
    ? [
        "-e",
        "on run argv",
        "-e",
        'display notification (item 1 of argv) with title "Sekhemet"',
        "-e",
        "end run",
        line,
      ]
    : ["--app-name=Sekhemet", "--", "Sekhemet", line];
}

/** `[notify] desktop` in the user configuration; false when unset or unreadable. */
export function readDesktopSetting(path: string = userConfigPath()): boolean {
  try {
    const notify = parseToml(readFileSync(path, "utf8")).notify as TomlTable | undefined;
    return notify?.desktop === true;
  } catch {
    return false;
  }
}

export function writeDesktopSetting(on: boolean, path: string = userConfigPath()): void {
  writeTomlTableKeys(path, "notify", [["desktop", on ? "true" : "false"]]);
}

export interface DesktopNotifierOptions {
  /** The person's switch, read when an issue arrives. */
  enabled: () => boolean;
  /** Whether a dashboard tab holds the live stream (it notifies instead). */
  listening: () => boolean;
  tool: () => DesktopTool | undefined;
  /** An issue's title, for the line. */
  titleOf: (cardId: string) => Promise<string | undefined>;
  /** Several arrivals within this window raise one (DB-N22-3). */
  windowMs?: number;
  /** How often the ledger is read. */
  intervalMs?: number;
}

/**
 * Tail the ledger from now (no replay of history) and raise one
 * notification per window for the issues that entered In review while no
 * tab held the stream: the issue's line for one, the count for several.
 */
export async function startDesktopNotifier(
  log: EventLog,
  opts: DesktopNotifierOptions,
): Promise<{ tick: () => Promise<void>; idle: () => Promise<void>; stop: () => void }> {
  const windowMs = opts.windowMs ?? NOTIFY_WINDOW_MS;
  let seq = (await log.getLastEvent())?.seq ?? 0;
  let pending: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  let raising: Promise<void> = Promise.resolve();
  let ticking: Promise<void> | undefined;
  let stopped = false;

  const flush = async (): Promise<void> => {
    timer = undefined;
    const ids = pending;
    pending = [];
    // A tab opened meanwhile shows it itself; the switch may have been turned off.
    if (ids.length === 0 || opts.listening() || !opts.enabled()) return;
    const tool = opts.tool();
    if (!tool) return;
    const text =
      ids.length === 1
        ? waitingLine({
            key: shortId(ids[0] as string),
            title: (await opts.titleOf(ids[0] as string)) ?? "An issue",
          })
        : waitingCount(ids.length);
    await runTrusted(tool.path, desktopArgs(tool, text), { timeoutMs: 10_000 });
  };

  const tick = async (): Promise<void> => {
    if (ticking) return ticking;
    ticking = (async () => {
      for (;;) {
        const events = await log.getEvents(seq + 1, 500);
        if (events.length === 0) break;
        for (const e of events) {
          seq = Math.max(seq, e.seq);
          if (e.type !== "card/status_changed" || !e.cardId) continue;
          const p = (e.payload ?? {}) as { fromStatus?: string; toStatus?: string };
          if (p.toStatus !== "review" || p.fromStatus === "review") continue;
          if (opts.listening() || !opts.enabled() || pending.includes(e.cardId)) continue;
          pending.push(e.cardId);
          timer ??= setTimeout(() => {
            raising = raising.then(flush).catch(() => undefined);
          }, windowMs);
        }
      }
    })().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };

  const interval = setInterval(() => {
    if (!stopped) void tick().catch(() => undefined);
  }, opts.intervalMs ?? 2_000);
  interval.unref?.();
  return {
    tick,
    /** Resolves once a notification being raised has been handed to the tool. */
    idle: () => raising,
    stop: () => {
      stopped = true;
      clearInterval(interval);
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * `GET /api/notify/desktop` — whether the switch is offered, whether this
 * computer has the tool (and why not), and whether it is on;
 * `POST /api/notify/desktop {on}` — the person turns it on or off. Solo only.
 */
export async function handleDesktopNotifyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: {
    setup: "solo" | "team";
    json: (res: ServerResponse, status: number, body: unknown) => void;
    readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
    trusted: (req: IncomingMessage) => boolean;
  },
): Promise<boolean> {
  if (url !== "/api/notify/desktop") return false;
  if (ctx.setup === "team") {
    if (req.method === "GET") ctx.json(res, 200, { offered: false, reason: DESKTOP_TEAM_REASON });
    else ctx.json(res, 404, { error: DESKTOP_TEAM_REASON });
    return true;
  }
  const tool = findDesktopTool();
  if (req.method === "GET") {
    ctx.json(res, 200, {
      offered: true,
      available: Boolean(tool),
      ...(tool ? {} : { reason: desktopUnavailable() }),
      on: readDesktopSetting(),
    });
    return true;
  }
  if (req.method !== "POST") {
    ctx.json(res, 405, { error: "Use GET or POST." });
    return true;
  }
  if (!ctx.trusted(req)) {
    ctx.json(res, 403, { error: "This setting is changed from the dashboard itself." });
    return true;
  }
  const body = await ctx.readJsonBody(req);
  const on = body.on === true;
  if (on && !tool) {
    ctx.json(res, 409, { error: desktopUnavailable() });
    return true;
  }
  writeDesktopSetting(on);
  ctx.json(res, 200, { offered: true, available: Boolean(tool), on });
  return true;
}
