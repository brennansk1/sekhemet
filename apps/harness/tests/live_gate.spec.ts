import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { DeterministicGateRunner } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveGatePath, readLiveGate, withLiveGate } from "../src/live_gate.js";
import { startDashboardServer } from "../src/server.js";

/**
 * Dashboard DB-N2-10 (B4.11): the In progress badge names the running
 * check. The card's process announces each check as it starts to
 * `.sekhemet/live/<card>.gate.json` (as the model's live output goes to
 * `<card>.txt`, M2) and removes it when the checks end; the dashboard server
 * reads it into the card's badge and pushes a `gate` frame on the live
 * stream when it changes. A file left by a process that is gone is ignored.
 * Real git, real processes, a real server and stream.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(gatesToml: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "live-gate-")));
  dirs.push(root);
  const files: Record<string, string> = {
    "package.json": '{ "name": "e", "type": "module", "private": true }\n',
    ".gitignore": ".sekhemet/\nnode_modules/\n.log/\n",
    ".sekhemet/gates.toml": gatesToml,
    "src/a.ts": "export const a = 1;\n",
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

/** A gate that copies the card's live gate file, as it stands while the gate runs, to `.log/<id>`. */
const copying = (id: string, rung: string) => `
[[gate]]
id = "${id}"
rung = "${rung}"
command = "sh"
args = ["-c", "mkdir -p .log && cat .sekhemet/live/c1.gate.json > .log/${id}"]
parser = "generic"
timeout_s = 60
`;

describe("the card's process announces the running check", () => {
  it("writes each check to the card's live gate file while it runs, and removes it when the checks end", async () => {
    const root = repo(copying("lint", "lint") + copying("unit", "test"));
    const inner = new DeterministicGateRunner(new ProcessSandbox(), { repoRoot: root });
    const seen: string[] = [];
    const runner = withLiveGate(inner, root, "c1");
    const result = await runner.runGates(["lint", "test"], root, {
      // A caller's own listener still hears each start.
      onGateStart: (g) => seen.push(g.gate),
    });
    expect(result.passed).toBe(true);
    expect(seen).toEqual((result.rungResults ?? []).map((o) => o.gate));
    const during = (id: string) => JSON.parse(readFileSync(join(root, ".log", id), "utf8"));
    expect(during("lint")).toMatchObject({ gate: "lint", rung: "lint", pid: process.pid });
    expect(during("unit")).toMatchObject({ gate: "unit", rung: "test", pid: process.pid });
    expect(typeof during("unit").startedAt).toBe("string");
    expect(existsSync(liveGatePath(root, "c1"))).toBe(false);
    expect(readLiveGate(root, "c1")).toBeUndefined();
  });

  it("ignores a file a process that is gone left behind, and one it cannot read", () => {
    const root = repo("");
    mkdirSync(dirname(liveGatePath(root, "c2")), { recursive: true });
    // A pid that has exited: a finished child's.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid as number;
    writeFileSync(
      liveGatePath(root, "c2"),
      JSON.stringify({
        gate: "unit",
        rung: "test",
        pid: gone,
        startedAt: new Date().toISOString(),
      }),
    );
    expect(readLiveGate(root, "c2")).toBeUndefined();
    writeFileSync(liveGatePath(root, "c2"), "{not json");
    expect(readLiveGate(root, "c2")).toBeUndefined();
    writeFileSync(
      liveGatePath(root, "c2"),
      JSON.stringify({ gate: "unit", rung: "test", pid: process.pid, startedAt: "t" }),
    );
    expect(readLiveGate(root, "c2")).toEqual({ gate: "unit", rung: "test" });
  });
});

describe("DB-N2-10 on the dashboard: the badge and the stream frame", () => {
  let root: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };

  beforeEach(async () => {
    root = repo("");
    db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    await store.createCard({ id: "c1", tier: "task", title: "Login" });
    await store.updateCardStatus("c1", "verify", "checks running", "harness", { override: true });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: root,
      port: 0,
      streamIntervalMs: 50,
    });
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  const badge = async () => {
    const board = (await (await fetch(`http://127.0.0.1:${server.port}/api/board`)).json()) as {
      cards: { id: string; display?: { statusLine?: string } }[];
    };
    return board.cards.find((c) => c.id === "c1")?.display?.statusLine;
  };

  it("names the running check on the board and pushes a gate frame when it starts and ends", async () => {
    expect(await badge()).toBe("Running checks…");
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, {
      signal: controller.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const frame = async (pattern: RegExp) => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const m = pattern.exec(text);
        if (m) {
          text = text.slice((m.index ?? 0) + m[0].length);
          return m[1];
        }
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      throw new Error(`no frame matching ${pattern} within 5 s`);
    };

    mkdirSync(dirname(liveGatePath(root, "c1")), { recursive: true });
    writeFileSync(
      liveGatePath(root, "c1"),
      JSON.stringify({ gate: "unit", rung: "test", pid: process.pid, startedAt: "t" }),
    );
    const started = JSON.parse((await frame(/event: gate\ndata: (.*)\n\n/)) as string);
    expect(started).toEqual({ cardId: "c1", gate: "unit", rung: "test", label: "Running Tests…" });
    expect(await badge()).toBe("Running Tests…");

    rmSync(liveGatePath(root, "c1"));
    const ended = JSON.parse((await frame(/event: gate\ndata: (.*)\n\n/)) as string);
    expect(ended).toEqual({ cardId: "c1", gate: null });
    expect(await badge()).toBe("Running checks…");
    controller.abort();
    // Nothing about it is on the ledger: it is presence, not a fact.
    expect(await store.cardEvents("c1", ["gate/started"])).toEqual([]);
  });
});
