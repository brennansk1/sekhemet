import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { ModelRegistry } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelsFetch, modelsFetchCommand } from "../src/models_cmd.js";

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

describe("sekhemet models fetch --role and --recommended (MD-N18-3, MD-N22-3)", () => {
  // The shipped ids, each with a recorded source on the local server (the
  // registry's source is the one a download uses, rule 4).
  const SHIPPED = ["nail-mtp", "qwen3.8-27b-gsq-rco", "apodex-1.1-mini"];
  const registryWithSources = (sizeOf: (id: string) => number = () => W.length) => {
    const reg = new ModelRegistry(join(dir, "models.json"));
    for (const id of SHIPPED)
      reg.recordSource(id, {
        url: `${base}/o/${id}/resolve/main/${id}.gguf`,
        host: "127.0.0.1",
        sha256: SHA,
        sizeBytes: sizeOf(id),
      });
    mkdirSync(join(dir, "models"), { recursive: true });
    return reg;
  };

  it("fetches a role's shipped model (--role planning)", async () => {
    const reg = registryWithSources();
    const lines: string[] = [];
    expect(await modelsFetchCommand(["--role", "planning"], opts(reg, lines))).toBe(0);
    expect(existsSync(join(dir, "models", "qwen3.8-27b-gsq-rco.gguf"))).toBe(true);
    expect(hits).toBe(1);
    expect(reg.get("qwen3.8-27b-gsq-rco")?.family).toBe("qwen");
  });

  it("names an unfilled role and fetches nothing (--role review)", async () => {
    const lines: string[] = [];
    const code = await modelsFetchCommand(["--role", "review"], opts(registryWithSources(), lines));
    expect(code).toBe(1);
    expect(lines.join(" ")).toMatch(/Review.*unfilled.*RG-P8-13/);
    expect(hits).toBe(0);
  });

  it("shows the set's total size and each licence before asking, and a no downloads nothing", async () => {
    const lines: string[] = [];
    const asked: string[] = [];
    const code = await modelsFetchCommand(["--recommended"], {
      ...opts(registryWithSources(), lines),
      ask: async (q: string) => {
        asked.push(q);
        // Everything the person agrees to is already on the screen.
        expect(lines.join("\n")).toMatch(/Total/);
        return false;
      },
    });
    expect(code).toBe(1);
    expect(asked).toHaveLength(1);
    const out = lines.join("\n");
    expect(out.match(/Apache-2\.0/g)).toHaveLength(3);
    expect(out).toMatch(/Coding.*nail-mtp/);
    expect(out).toMatch(/Planning.*qwen3\.8-27b-gsq-rco/);
    expect(out).toMatch(/Research.*apodex-1\.1-mini/);
    expect(out).toMatch(/Review.*unfilled/);
    expect(out).toMatch(/Total.*150\.0 kB/);
    expect(out).toMatch(/Nothing was downloaded/);
    expect(hits).toBe(0);
  });

  it("downloads the set after the yes, --yes giving it in a script, each verified and recorded", async () => {
    const lines: string[] = [];
    const code = await modelsFetchCommand(["--recommended", "--yes"], {
      ...opts(registryWithSources(), lines),
      ask: async () => {
        throw new Error("--yes asks nothing");
      },
    });
    expect(code).toBe(0);
    expect(hits).toBe(3);
    for (const id of SHIPPED) expect(existsSync(join(dir, "models", `${id}.gguf`))).toBe(true);
    const events = await log.getEventsByTypes(["model/downloaded"]);
    expect(events.map((e) => (e.payload as { model: string }).model).sort()).toEqual(
      [...SHIPPED].sort(),
    );
  });

  it("with no one to ask and no --yes, downloads nothing and says how to agree", async () => {
    const lines: string[] = [];
    const code = await modelsFetchCommand(["--recommended"], opts(registryWithSources(), lines));
    expect(code).toBe(1);
    expect(lines.join(" ")).toMatch(/--yes/);
    expect(hits).toBe(0);
  });

  it("refuses the set before asking when the folder's volume cannot hold it, naming both sizes", async () => {
    const lines: string[] = [];
    let asked = false;
    const code = await modelsFetchCommand(["--recommended", "--yes"], {
      ...opts(
        registryWithSources(() => 4e15),
        lines,
      ),
      ask: async () => {
        asked = true;
        return true;
      },
    });
    expect(code).toBe(1);
    expect(asked).toBe(false);
    expect(lines.join(" ")).toMatch(/needs [\d.]+ GB.*has [\d.]+ [GMk]?B free/);
    expect(hits).toBe(0);
  });

  // C4 (C3's review minors): the total counts what is still to fetch, so a
  // kept `.part` (MD-N18-1) is subtracted; and a file of the same name that
  // no registry entry records is that one model's problem, not the set's.
  it("subtracts a kept .part from the total still to download", async () => {
    const reg = registryWithSources();
    writeFileSync(join(dir, "models", "nail-mtp.gguf.part"), W.subarray(0, 30_000));
    const lines: string[] = [];
    expect(await modelsFetchCommand(["--recommended"], opts(reg, lines))).toBe(1);
    expect(lines.join("\n")).toMatch(/Total to download: 120\.0 kB/);
    expect(lines.join("\n")).toMatch(/nail-mtp.*30\.0 kB kept/);
    expect(hits).toBe(0);
  });

  it("skips a model whose file name is taken by an unregistered file, with the reason, and fetches the rest", async () => {
    const reg = registryWithSources();
    writeFileSync(join(dir, "models", "qwen3.8-27b-gsq-rco.gguf"), "someone else's file");
    const lines: string[] = [];
    const code = await modelsFetchCommand(["--recommended", "--yes"], opts(reg, lines));
    const out = lines.join("\n");
    expect(out).toMatch(
      /qwen3\.8-27b-gsq-rco is skipped: the folder already has a file named qwen3\.8-27b-gsq-rco\.gguf/,
    );
    expect(out).toMatch(/Total to download: 100\.0 kB/);
    // The set is not whole, so the command says so by its exit code.
    expect(code).toBe(1);
    expect(hits).toBe(2);
    expect(existsSync(join(dir, "models", "nail-mtp.gguf"))).toBe(true);
    expect(existsSync(join(dir, "models", "apodex-1.1-mini.gguf"))).toBe(true);
    expect(readFileSync(join(dir, "models", "qwen3.8-27b-gsq-rco.gguf"), "utf8")).toBe(
      "someone else's file",
    );
  });

  it("names its usage when given nothing to fetch", async () => {
    const lines: string[] = [];
    expect(await modelsFetchCommand([], opts(registryWithSources(), lines))).toBe(2);
    expect(lines.join(" ")).toMatch(/--recommended/);
  });
});

/**
 * The entry point (B1-C3 review blocker): the built binary, spawned in an
 * empty project and an empty home, reaches `--recommended` and `--role`.
 * The network is offline, so nothing is fetched from anywhere.
 */
describe("sekhemet dev models fetch, from the command line (MD-N18-3, MD-N22-2/-3)", () => {
  const BIN = join(import.meta.dirname, "..", "dist", "index.js");
  const cli = (args: string[]) => {
    const cwd = join(dir, "cwd");
    const home = join(dir, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(join(dir, "models"), { recursive: true });
    return spawnSync(process.execPath, [BIN, "dev", "models", "fetch", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
        SEKHEMET_USER_CONFIG: join(dir, "user.toml"),
        SEKHEMET_MODELS_DIR: join(dir, "models"),
        SEKHEMET_MODEL_LOADS: "off",
        BROWSER: "false",
      },
    });
  };

  it("--recommended prints each file, size and licence and the total, and with no one to ask downloads nothing", () => {
    const r = cli(["--recommended"]);
    expect(r.stderr).not.toMatch(/unknown flag/);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /Coding\s+nail-mtp: Nail-Qwen3\.6-35B-A3B-MTP-UD-IQ3_XXS\.gguf, [\d.]+ GB, licence Apache-2\.0/,
    );
    expect(r.stdout).toMatch(/Planning\s+qwen3\.8-27b-gsq-rco: .*licence Apache-2\.0/);
    expect(r.stdout).toMatch(/Research\s+apodex-1\.1-mini: .*licence Apache-2\.0/);
    expect(r.stdout).toMatch(/Review\s+unfilled/);
    expect(r.stdout).toMatch(/Total to download: [\d.]+ GB/);
    // No one is asked, or the volume is refused first when it lacks the room.
    expect(r.stdout).toMatch(/Nothing was downloaded: no one was asked|nothing was downloaded\./);
    expect(readdirSync(join(dir, "models"))).toEqual([]);
  });

  it("--role planning reaches the shipped model's verified source, refused offline with the setting named", () => {
    const r = cli(["--role", "planning"]);
    expect(r.stderr).not.toMatch(/unknown flag/);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[network\] mode/);
    expect(readdirSync(join(dir, "models"))).toEqual([]);
  });

  it("--role review names the unfilled role and fetches nothing", () => {
    const r = cli(["--role", "review"]);
    expect(r.stderr).not.toMatch(/unknown flag/);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/Review role is unfilled/);
  });
});
