import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopTool,
  desktopArgs,
  desktopUnavailable,
  findDesktopTool,
  readDesktopSetting,
  startDesktopNotifier,
  writeDesktopSetting,
} from "../src/desktop_notify.js";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * NEW-dashboard-22, the operating-system notification when the dashboard is
 * closed (DB-N22-5 to -7; DEC-53 c4; FINDINGS PRC-11), against a real ledger
 * on SQLite, a real stub tool (a script that records its arguments) and a
 * real server (DoD §2A):
 * - DB-N22-5: with `[notify] desktop` on, no tab on the live stream and an
 *   issue entering In review, one notification names the key, title and
 *   where it waits; several within the window are one that counts them;
 *   with a tab on the stream, none;
 * - DB-N22-6: the issue's text reaches the tool as one argument with no
 *   shell, so quotes, `$(…)` and AppleScript in a title run nothing;
 * - DB-N22-7: off until a person turns it on; with neither tool, or in the
 *   Team setup, the switch is disabled or not offered, with the reason.
 */

let dir: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;

/** A stand-in for osascript or notify-send: writes each argument on its own line. */
function stubTool(name: string): { path: string; calls: () => string[][] } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const out = join(dir, `${name}.calls`);
  const path = join(bin, name);
  writeFileSync(
    path,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> "${out}"; done\nprintf '\\036' >> "${out}"\n`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    calls: () =>
      existsSync(out)
        ? readFileSync(out, "utf8")
            .split("\u001e")
            .filter(Boolean)
            .map((c) => c.split("\u001f").filter((a, i, all) => i < all.length - 1 || a !== ""))
        : [],
  };
}

async function toReview(id: string, title: string): Promise<void> {
  await store.createCard({ id, tier: "story", title, status: "ready" });
  await store.updateCardStatus(id, "in_progress", "started", "harness", { override: true });
  await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-desktop-notify-"));
  db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("DB-N22-6: the issue's text is an argument, never a script or a shell command", () => {
  it("passes a hostile title to osascript as one argument after a fixed script, and runs nothing", async () => {
    const tool = stubTool("osascript");
    const pwned = join(dir, "pwned");
    const title = `Fix "quotes" $(touch ${pwned}) \`touch ${pwned}\` " & (do shell script "touch ${pwned}") & "`;
    await toReviewNotified({ kind: "osascript", path: tool.path }, [["c1", title]]);
    const calls = tool.calls();
    expect(calls).toHaveLength(1);
    const args = calls[0] ?? [];
    expect(args.slice(0, 6)).toEqual([
      "-e",
      "on run argv",
      "-e",
      'display notification (item 1 of argv) with title "Sekhemet"',
      "-e",
      "end run",
    ]);
    expect(args.slice(6)).toEqual([`c1 ${title} · waiting in In review`]);
    expect(existsSync(pwned)).toBe(false);
  });

  it("gives notify-send the same one argument after --, and a line that starts with - is never an option", () => {
    const tool: DesktopTool = { kind: "notify-send", path: "/usr/bin/notify-send" };
    expect(desktopArgs(tool, "CHR-1 Title · waiting in In review")).toEqual([
      "--app-name=Sekhemet",
      "--",
      "Sekhemet",
      "CHR-1 Title · waiting in In review",
    ]);
    const osa = desktopArgs(
      { kind: "osascript", path: "/usr/bin/osascript" },
      "-e do shell script",
    );
    expect(osa.at(-1)?.startsWith("-")).toBe(false);
  });
});

/** Run the notifier over these arrivals with no tab listening and a 50 ms window. */
async function toReviewNotified(tool: DesktopTool, cards: [string, string][], listening = false) {
  const n = await startDesktopNotifier(log, {
    enabled: () => true,
    listening: () => listening,
    tool: () => tool,
    titleOf: async (id) => (await store.getCard(id))?.title,
    windowMs: 50,
    intervalMs: 10_000,
  });
  try {
    for (const [id, title] of cards) await toReview(id, title);
    await n.tick();
    await settle(150);
    await n.idle();
  } finally {
    n.stop();
  }
}

describe("DB-N22-5: one notification when an issue enters In review and no tab holds the stream", () => {
  it("names the issue's key, title and where it waits", async () => {
    const tool = stubTool("notify-send");
    await toReviewNotified({ kind: "notify-send", path: tool.path }, [
      ["card_a1b2c3d4", "Export a week as CSV"],
    ]);
    expect(tool.calls()).toEqual([
      [
        "--app-name=Sekhemet",
        "--",
        "Sekhemet",
        "a1b2c3d4 Export a week as CSV · waiting in In review",
      ],
    ]);
  });

  it("raises one that counts several arrivals within the window (DB-N22-3)", async () => {
    const tool = stubTool("notify-send");
    await toReviewNotified({ kind: "notify-send", path: tool.path }, [
      ["c1", "One"],
      ["c2", "Two"],
      ["c3", "Three"],
    ]);
    const calls = tool.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.at(-1)).toBe("3 issues wait in In review");
  });

  it("raises none while a dashboard tab holds the live stream", async () => {
    const tool = stubTool("notify-send");
    await toReviewNotified({ kind: "notify-send", path: tool.path }, [["c1", "One"]], true);
    expect(tool.calls()).toEqual([]);
  });

  it("raises none for history from before it started", async () => {
    const tool = stubTool("notify-send");
    await toReview("old", "Before the notifier");
    await toReviewNotified({ kind: "notify-send", path: tool.path }, []);
    expect(tool.calls()).toEqual([]);
  });
});

describe("DB-N22-7: off by default; disabled with its reason where it cannot work", () => {
  it("is off until a person turns it on, and kept in the user configuration as [notify] desktop", () => {
    const path = join(dir, "config.toml");
    expect(readDesktopSetting(path)).toBe(false);
    writeFileSync(path, '[team]\nmode = "solo"\n');
    expect(readDesktopSetting(path)).toBe(false);
    writeDesktopSetting(true, path);
    expect(readFileSync(path, "utf8")).toContain("[notify]\ndesktop = true");
    expect(readFileSync(path, "utf8")).toContain('[team]\nmode = "solo"');
    expect(readDesktopSetting(path)).toBe(true);
    writeDesktopSetting(false, path);
    expect(readDesktopSetting(path)).toBe(false);
  });

  it("finds osascript on macOS and notify-send on Linux on the PATH, and says why when neither is there", () => {
    const osa = stubTool("osascript");
    const ns = stubTool("notify-send");
    const bin = join(dir, "bin");
    expect(findDesktopTool("darwin", bin)).toEqual({ kind: "osascript", path: osa.path });
    expect(findDesktopTool("linux", bin)).toEqual({ kind: "notify-send", path: ns.path });
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(findDesktopTool("linux", empty)).toBeUndefined();
    expect(findDesktopTool("win32", bin)).toBeUndefined();
    expect(desktopUnavailable("linux")).toMatch(/notify-send/);
    expect(desktopUnavailable("darwin")).toMatch(/osascript/);
  });
});

describe("the switch over HTTP (DB-N22-5, -7)", () => {
  const userConfig = process.env.SEKHEMET_USER_CONFIG;
  afterEach(() => {
    if (userConfig === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
    else process.env.SEKHEMET_USER_CONFIG = userConfig;
  });

  it("Solo: offered, off by default, and turned on by the person into the user configuration", async () => {
    const cfg = join(dir, "user.toml");
    process.env.SEKHEMET_USER_CONFIG = cfg;
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 10_000,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const got = (await (await fetch(`${base}/api/notify/desktop`)).json()) as Record<
        string,
        unknown
      >;
      expect(got).toMatchObject({ offered: true, on: false });
      expect(typeof got.available).toBe("boolean");
      const res = await fetch(`${base}/api/notify/desktop`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ on: true }),
      });
      if (!got.available) {
        // DB-N22-7: with neither tool the switch cannot be turned on, and says why.
        expect(String(got.reason)).toMatch(/osascript|notify-send/);
        expect(res.status).toBe(409);
        expect(readDesktopSetting(cfg)).toBe(false);
        return;
      }
      expect(res.status).toBe(200);
      expect(readDesktopSetting(cfg)).toBe(true);
      // Not from another page.
      const forged = await fetch(`${base}/api/notify/desktop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: false }),
      });
      expect(forged.status).toBe(403);
      expect(readDesktopSetting(cfg)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("Team: not offered, with the reason, and refused", async () => {
    const cfg = join(dir, "user.toml");
    process.env.SEKHEMET_USER_CONFIG = cfg;
    writeFileSync(join(dir, "list.txt"), "passwordpassword1\n");
    const teamDb = new DatabaseSync(join(dir, "team.db"));
    initSchema(teamDb);
    const teamLog = new EventLog(teamDb, { setup: "team" });
    const teamStore = new CardStore(teamDb, teamLog);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = await startDashboardServer({
      db: teamDb,
      log: teamLog,
      boardService: new BoardServiceImpl(teamStore),
      cardStore: teamStore,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 10_000,
      identity: {
        dir: join(dir, "identity"),
        passwordList: join(dir, "list.txt"),
        settings: identitySettings({ mode: "team", workspace: "Northwind" }),
      },
    });
    vi.mocked(console.log).mockRestore();
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // The workspace's first Admin, signed in.
      const token = readFileSync(join(dir, "identity", "setup-token"), "utf8").trim();
      const setup = await fetch(`${base}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1" },
        body: JSON.stringify({
          token,
          name: "Ada Admin",
          email: "ada@northwind.test",
          password: "correct horse battery staple",
        }),
      });
      expect(setup.status).toBe(200);
      const { csrf } = (await setup.json()) as { csrf: string };
      const headers = {
        Cookie: (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
        "X-Sekhemet-CSRF": csrf,
        "X-Sekhemet-Action": "1",
        "Content-Type": "application/json",
      };
      const got = (await (await fetch(`${base}/api/notify/desktop`, { headers })).json()) as Record<
        string,
        unknown
      >;
      expect(got.offered).toBe(false);
      expect(String(got.reason)).toMatch(/server/);
      const res = await fetch(`${base}/api/notify/desktop`, {
        method: "POST",
        headers,
        body: JSON.stringify({ on: true }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(readDesktopSetting(cfg)).toBe(false);
    } finally {
      await server.close();
      teamDb.close();
    }
  });
});
