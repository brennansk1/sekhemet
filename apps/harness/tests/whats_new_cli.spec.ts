import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BIN, type Place, cliEnv, place, runCli } from "./support/cli_spawn.js";
import { scriptedModel } from "./support/g2_model.js";

/**
 * *What's new* (surface item 34, NEW-surface-9, SUR-68; DEC-53 c5), through
 * the built command at a real terminal: `script` gives the command a
 * pseudo-terminal, as a person's shell does. The bundled CHANGELOG.md is the
 * source; every request for another host goes to a local stub that records
 * it, so the test sees that none is made.
 */

const VERSION = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    version: string;
  }
).version;

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

async function anyRequest(): Promise<{ port: number; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? "");
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, asked };
}

/** The built command at a pseudo-terminal (`script`, macOS or util-linux form). */
function atTerminal(args: string[], p: Place, env: Record<string, string>): Promise<string> {
  const cmd = [process.execPath, BIN, ...args];
  const quoted = cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const argv =
    process.platform === "darwin" ? ["-q", "/dev/null", ...cmd] : ["-qec", quoted, "/dev/null"];
  const child = spawn("script", argv, {
    cwd: p.repo,
    env: cliEnv(p, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => {
    out += String(d);
  });
  child.stderr.on("data", (d) => {
    out += String(d);
  });
  // macOS `script` echoes the end of input (^D and backspaces) first.
  return new Promise((ok) =>
    child.once("close", () => ok(out.replace(/\r/g, "").replace(/\^D[\b]*/g, ""))),
  );
}

function shown(p: Place): string | undefined {
  const f = join(p.home, ".sekhemet", "whats-new.json");
  return existsSync(f)
    ? (JSON.parse(readFileSync(f, "utf8")) as { shown: string }).shown
    : undefined;
}

function lastShown(p: Place, version: string): void {
  mkdirSync(join(p.home, ".sekhemet"), { recursive: true });
  writeFileSync(join(p.home, ".sekhemet", "whats-new.json"), JSON.stringify({ shown: version }));
}

async function setup() {
  const p = place("sek-whats-new-");
  const stub = await anyRequest();
  const { preload } = scriptedModel(p.home);
  return {
    p,
    asked: stub.asked,
    env: { NODE_OPTIONS: `--import=${preload}`, G2_STUB_PORT: String(stub.port) },
  };
}

describe("SUR-68: What's new, once after an upgrade, at a terminal, from the bundled CHANGELOG", () => {
  it("SUR-68: prints each version's notes since the last shown, Security first, at most 20 lines, once, with no request", async () => {
    const { p, asked, env } = await setup();
    lastShown(p, "0.0.1");
    const out = await atTerminal(["--help"], p, env);
    const lines = out.split("\n");
    const head = lines.findIndex((l) => l.startsWith("What's new since 0.0.1"));
    expect(head, out).toBeGreaterThan(-1);
    const note = [lines[head] as string];
    for (const l of lines.slice(head + 1)) {
      if (!/^ {2}(\d+\.\d+\.\d+ · |… and \d+ more)/.test(l)) break;
      note.push(l);
    }
    expect(note.length).toBeLessThanOrEqual(20);
    // The changelog has more than fits: the last line says where the rest is.
    expect(note.at(-1)).toMatch(/… and \d+ more: see CHANGELOG\.md/);
    // Security entries first.
    expect(note[1]).toMatch(/^ {2}0\.1\.0 · Security: /);
    const firstOther = note.findIndex((l) => / · (Added|Changed): /.test(l));
    const lastSecurity = note.map((l) => / · Security: /.test(l)).lastIndexOf(true);
    expect(lastSecurity).toBeLessThan(firstOther);
    // The command still ran: its help follows.
    expect(out).toMatch(/sekhemet doctor/);
    expect(shown(p)).toBe(VERSION);
    // Once: the next command at a terminal shows nothing.
    const again = await atTerminal(["--help"], p, env);
    expect(again).not.toMatch(/What's new/);
    expect(asked).toEqual([]);
  }, 60_000);

  it("SUR-68: under --json, or with no terminal, no note is printed and none is used up", async () => {
    const { p, env } = await setup();
    lastShown(p, "0.0.1");
    const json = await atTerminal(["doctor", "--json"], p, env);
    expect(json).not.toMatch(/What's new/);
    expect(shown(p)).toBe("0.0.1");
    const piped = await runCli(["--help"], p, { env });
    expect(piped.out).not.toMatch(/What's new/);
    expect(shown(p)).toBe("0.0.1");
    // `--version` writes nothing (SUR-13), not even this record.
    await atTerminal(["--version"], p, env);
    expect(shown(p)).toBe("0.0.1");
  }, 60_000);

  it("SUR-68: a first install has nothing it upgraded from: no note, its version recorded", async () => {
    const { p, env } = await setup();
    const out = await atTerminal(["--help"], p, env);
    expect(out).not.toMatch(/What's new/);
    expect(shown(p)).toBe(VERSION);
  }, 60_000);
});
