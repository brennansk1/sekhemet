import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EDITOR_SNIPPETS, type EditorSnippet } from "../src/editor_snippets.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { BIN, sandboxDirs, sekhemet } from "./cli_fixture.js";

/**
 * NEW-extensibility-7 (DEC-55; extensibility item 25a): the editor snippets
 * for VS Code, Cursor and Zed, the product side. Each snippet's command is
 * started exactly as written — `sekhemet` being the built binary, and
 * `${workspaceFolder}` the folder an editor puts there — and completes its
 * protocol's `initialize` (EXT-37); a snippet naming a command or flag the CLI
 * does not have fails, naming the snippet (EXT-37a).
 */

interface Server {
  protocol: "mcp" | "acp";
  command: string;
  args: string[];
}

/** The servers a snippet starts, read from its text as the editor reads it. */
function serversOf(s: EditorSnippet): Server[] {
  const json = JSON.parse(s.text) as Record<string, Record<string, Record<string, unknown>>>;
  const pick = (
    table: Record<string, Record<string, unknown>> | undefined,
    protocol: Server["protocol"],
  ) =>
    Object.values(table ?? {}).map((e) => ({
      protocol,
      command: String(e.command),
      args: (e.args as string[] | undefined) ?? [],
    }));
  return [
    ...pick(json.servers, "mcp"),
    ...pick(json.mcpServers, "mcp"),
    ...pick(json.context_servers, "mcp"),
    ...pick(json.agent_servers, "acp"),
  ];
}

const INIT = {
  mcp: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "docs-test", version: "1" },
    },
  },
  acp: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  },
};

/** Starts one server as the snippet writes it and completes `initialize`, or says why not. */
async function handshake(
  editor: string,
  server: Server,
  where: { cwd: string; home: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (server.command !== "sekhemet")
    return { ok: false, error: `${editor}: runs ${server.command}, not sekhemet` };
  const args = server.args.map((a) => a.replaceAll("${workspaceFolder}", where.cwd));
  const child: ChildProcess = spawn(process.execPath, [BIN, ...args], {
    cwd: where.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: where.home,
      SEKHEMET_CONFIG_DIR: join(where.home, ".sekhemet"),
      SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
      SEKHEMET_MODEL_LOADS: "off",
      BROWSER: "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (c) => {
    out += String(c);
  });
  child.stderr?.on("data", (c) => {
    err += String(c);
  });
  child.stdin?.write(`${JSON.stringify(INIT[server.protocol])}\n`);
  try {
    const result = await new Promise<{ ok: true } | { ok: false; error: string }>((done) => {
      const timer = setTimeout(
        () => done({ ok: false, error: `${editor}: no initialize reply (${err.trim()})` }),
        15_000,
      );
      const check = () => {
        for (const line of out.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          const msg = JSON.parse(line) as { id?: number; result?: unknown };
          if (msg.id === 1 && msg.result) {
            clearTimeout(timer);
            done({ ok: true });
          }
        }
      };
      child.stdout?.on("data", check);
      child.on("exit", (code) => {
        clearTimeout(timer);
        done({
          ok: false,
          error: `${editor}: \`sekhemet ${server.args.join(" ")}\` exited ${code}: ${err.trim()}`,
        });
      });
    });
    return result;
  } finally {
    child.kill();
  }
}

/** A project folder, as an editor opens one (the fixture removes it after each test). */
function project(): { cwd: string; home: string } {
  const where = sandboxDirs();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: where.cwd });
  const { db } = openLocalLedger(where.cwd);
  db.close();
  return where;
}

describe("editor snippets (NEW-extensibility-7)", () => {
  it("holds one snippet each for VS Code, Cursor and Zed, each for the person's own configuration", () => {
    expect(EDITOR_SNIPPETS.map((s) => s.editor)).toEqual(["vscode", "cursor", "zed"]);
    for (const s of EDITOR_SNIPPETS) {
      expect(s.where).toMatch(/user|your own|home/i);
      expect(() => JSON.parse(s.text)).not.toThrow();
    }
    // VS Code and Cursor reach the board through MCP; Zed reaches Seshat through ACP and the board through MCP.
    const protocols = Object.fromEntries(
      EDITOR_SNIPPETS.map((s) => [
        s.editor,
        serversOf(s)
          .map((x) => x.protocol)
          .sort(),
      ]),
    );
    expect(protocols).toEqual({ vscode: ["mcp"], cursor: ["mcp"], zed: ["acp", "mcp"] });
  });

  it("EXT-37: each snippet's command, started as written, completes its protocol's initialize", async () => {
    const where = project();
    for (const s of EDITOR_SNIPPETS) {
      for (const server of serversOf(s)) {
        const r = await handshake(s.name, server, where);
        expect(r, JSON.stringify(r)).toEqual({ ok: true });
      }
    }
  }, 120_000);

  it("EXT-37a: a snippet naming a command or flag the CLI does not have fails, naming the snippet", async () => {
    const where = project();
    const base = EDITOR_SNIPPETS[0] as EditorSnippet;
    for (const bad of [
      { ...base, name: "VS Code (broken)", text: base.text.replace('"mcp"', '"mcpx"') },
      {
        ...base,
        name: "VS Code (bad flag)",
        text: base.text.replace('"--repo"', '"--repository"'),
      },
    ]) {
      const [server] = serversOf(bad);
      const r = await handshake(bad.name, server as Server, where);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toContain(bad.name);
    }
  }, 60_000);

  it("`sekhemet editors <editor>` prints the snippet exactly, and where it goes", () => {
    const dirs = sandboxDirs();
    for (const s of EDITOR_SNIPPETS) {
      const r = sekhemet(["editors", s.editor], dirs);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(s.text);
      expect(r.stdout).toContain(s.where);
    }
    const all = sekhemet(["editors"], dirs);
    expect(all.status).toBe(0);
    for (const s of EDITOR_SNIPPETS) expect(all.stdout).toContain(s.name);
    const unknown = sekhemet(["editors", "emacs"], dirs);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/vscode, cursor or zed/);
  });
});
