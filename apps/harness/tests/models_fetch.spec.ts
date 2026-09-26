import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { ModelRegistry } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelsFetch } from "../src/models_cmd.js";

// MD-N12-6, NEW-models-7: `sekhemet models fetch` is the page's Download…
// in the terminal: one implementation, the same refusals and records.

const W = Buffer.alloc(50_000, 4);
const SHA = createHash("sha256").update(W).digest("hex");
let dir: string;
let db: DatabaseSync;
let log: EventLog;
let server: Server;
let base = "";
let hits = 0;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sek-fetch-"));
  db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  log = new EventLog(db);
  hits = 0;
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-length": W.length });
    res.end(W);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  writeFileSync(join(dir, "user.toml"), '[network]\nmode = "offline"\n');
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const opts = (registry: ModelRegistry, lines: string[]) => ({
  repoPath: dir,
  log,
  principal: "p_owner",
  folder: join(dir, "models"),
  registry,
  userConfigPath: join(dir, "user.toml"),
  env: {},
  print: (l: string) => lines.push(l),
});

describe("sekhemet models fetch (MD-N12-6)", () => {
  it("downloads from the registered source, verifies it and records it", async () => {
    const reg = new ModelRegistry(join(dir, "models.json"));
    reg.recordSource("m", {
      url: `${base}/o/r/resolve/main/m.gguf`,
      host: "127.0.0.1",
      sha256: SHA,
      sizeBytes: W.length,
    });
    const lines: string[] = [];
    // The folder is never created: a missing one (an unplugged drive) is refused, no request made.
    expect(await modelsFetch("m", opts(reg, lines))).not.toBe(0);
    expect(lines.join("\n")).toMatch(/is not there or cannot be written/);
    expect(existsSync(join(dir, "models"))).toBe(false);
    expect(hits).toBe(0);
    mkdirSync(join(dir, "models"));
    expect(await modelsFetch("m", opts(reg, lines))).toBe(0);
    expect(readFileSync(join(dir, "models", "m.gguf")).equals(W)).toBe(true);
    const [e] = await log.getEventsByTypes(["model/downloaded"]);
    expect(e?.payload).toMatchObject({
      model: "m",
      sha256: SHA,
      verified: true,
      principal: "p_owner",
    });
    expect(lines.at(-1)).toMatch(/^Verified\./);
  });

  it("refuses under offline with the setting named, making no request", async () => {
    const reg = new ModelRegistry(join(dir, "models.json"));
    reg.recordSource("m", {
      url: "https://huggingface.co/o/r/resolve/main/m.gguf",
      host: "huggingface.co",
      sha256: SHA,
    });
    const lines: string[] = [];
    expect(await modelsFetch("m", opts(reg, lines))).toBe(1);
    expect(lines.join(" ")).toMatch(/\[network\] mode/);
    expect(hits).toBe(0);
    expect(existsSync(join(dir, "models", "m.gguf"))).toBe(false);
  });

  it("knows the managed Worker's official source from the table (MD-N12-6): offline refuses with the setting named, making no request", async () => {
    const lines: string[] = [];
    const reg = new ModelRegistry(join(dir, "models.json"));
    expect(await modelsFetch("cyber-tiel", opts(reg, lines))).toBe(1);
    expect(lines.join(" ")).toMatch(/\[network\] mode/);
    expect(lines.join(" ")).not.toMatch(/no registered source/);
    expect(hits).toBe(0);
    expect(reg.get("cyber-tiel")?.source?.sha256).toBe(
      "d60adb32312166b49ceffbd10aed297aee69626b45ec4e720700450ee048bd0e",
    );
  });

  it("refuses a model with no registered source", async () => {
    const lines: string[] = [];
    expect(
      await modelsFetch("unknown", opts(new ModelRegistry(join(dir, "models.json")), lines)),
    ).toBe(1);
    expect(lines.join(" ")).toMatch(/no registered source and hash/);
  });
});
