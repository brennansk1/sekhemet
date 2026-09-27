import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installScaffoldGate } from "../src/card_zero.js";
import { runFirstRun } from "../src/first_run.js";
import { START_BY_CONVERSATION, isEmptyProject, runInit } from "../src/init.js";
import { PmStore } from "../src/pm/store.js";

/**
 * design-stage DS-P2-4 (§2.4 item 4): `sekhemet init` — and the bare
 * `sekhemet`'s first run — in an empty directory offers to start a project
 * by conversation instead of printing only "No gates found"; the sentence
 * the person gives goes to Seshat as their message, and card zero's gate
 * takes the place of the empty `gates.toml` the first run wrote. Real
 * directories, real git, an on-disk ledger.
 */

const dirs: string[] = [];
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "start-offer-home-"));
  dirs.push(home);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(home, ".sekhemet"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function emptyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "start-offer-"));
  dirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
}

const noWeights = async () => ({});
const run = () => "v26.0.0";

describe("DS-P2-4: an empty directory is offered a start by conversation", () => {
  it("init offers it instead of only 'No gates found'", () => {
    const root = emptyRepo();
    expect(isEmptyProject(root)).toBe(true);
    const said: string[] = [];
    runInit(root, { run, totalBytes: 24 * 1024 ** 3, say: (l) => said.push(l) });
    const text = said.join("\n");
    expect(text).toContain(START_BY_CONVERSATION);
    expect(text).not.toContain("No gates found");
  });

  it("a folder with files but no gates is still told what to add", () => {
    const root = emptyRepo();
    writeFileSync(join(root, "notes.md"), "ideas\n");
    expect(isEmptyProject(root)).toBe(false);
    const said: string[] = [];
    runInit(root, { run, totalBytes: 24 * 1024 ** 3, say: (l) => said.push(l) });
    expect(said.join("\n")).toContain("No gates found");
  });

  it("the first run asks for one sentence and gives it to Seshat as the person's message", async () => {
    const root = emptyRepo();
    const said: string[] = [];
    const out = await runFirstRun(root, {
      findRoleWeights: noWeights,
      run,
      totalBytes: 24 * 1024 ** 3,
      nodeVersion: "26.0.0",
      interactive: true,
      ask: async () => true,
      askText: async () => "a recipe website where people can save favourites",
      say: (l) => said.push(l),
    });
    expect(out.code).toBe(0);
    expect(said.join("\n")).toContain(START_BY_CONVERSATION);
    const db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
    initSchema(db);
    const thread = await new PmStore(new EventLog(db)).thread();
    const mine = thread.filter((m) => m.role === "user");
    expect(mine.map((m) => m.text)).toEqual([
      "start a new project: a recipe website where people can save favourites",
    ]);
    expect(mine[0]?.state).toBe("queued");
    db.close();
  });

  it("no sentence, no message; without a terminal the offer is said and nothing is asked", async () => {
    const root = emptyRepo();
    const said: string[] = [];
    let asked = 0;
    await runFirstRun(root, {
      findRoleWeights: noWeights,
      run,
      totalBytes: 24 * 1024 ** 3,
      nodeVersion: "26.0.0",
      interactive: false,
      yes: true,
      askText: async () => {
        asked++;
        return "anything";
      },
      say: (l) => said.push(l),
    });
    expect(asked).toBe(0);
    expect(said.join("\n")).toContain(START_BY_CONVERSATION);
    expect(existsSync(join(root, ".sekhemet", "events.db"))).toBe(false);
  });

  it("card zero's gate replaces the empty gates.toml the first run wrote", () => {
    const root = emptyRepo();
    runInit(root, { run, totalBytes: 24 * 1024 ** 3, say: () => undefined });
    expect(installScaffoldGate(root, "typescript")).toBe("written");
    expect(readFileSync(join(root, ".sekhemet", "gates.toml"), "utf8")).toContain(
      'id = "scaffold"',
    );
  });
});
