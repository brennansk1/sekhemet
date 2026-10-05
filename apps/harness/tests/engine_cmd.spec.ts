import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { CardStore } from "@sekhemet/kernel";
import { ENGINE_PIN, type EnginePin, EngineRefused } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineApi, installEngine } from "../src/config_engine.js";
import { egressLines, egressRows } from "../src/egress_view.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { BIN } from "./cli_fixture.js";

// The card module's DOM helpers need a page; its words do not.
vi.mock("../../../packages/ui/web/dom.js", () => ({
  esc: (v: unknown) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
  getJSON: async () => ({ ok: true, status: 200, data: {} }),
  postJSON: async () => ({ ok: true, status: 200, data: {} }),
}));

// NEW-models-19 (models rule 6b; DEC-53 c7): *Get the inference engine* —
// the CLI (`sekhemet engine`), the page's HTTP routes and the egress view —
// against a local release server, through the real network policy.

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tarGz(files: { name: string; body: string; mode: number }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const body = Buffer.from(f.body);
    const h = Buffer.alloc(512);
    h.write(f.name, 0);
    h.write(`${f.mode.toString(8).padStart(7, "0")}\0`, 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
const fakeServer = (build: number) =>
  `#!/bin/sh\necho "version: 0.4.0 (build ${build}, commit 5266f24da)" 1>&2\n`;

/** A project folder with a ledger, as `sekhemet` leaves it. */
async function project(): Promise<string> {
  const repo = tmp("eng-proj-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const { db, log } = openLocalLedger(repo);
  await new CardStore(db, log).createCard({ id: "c1", tier: "story", title: "One" });
  db.close();
  return repo;
}

describe("installEngine through the network policy (MD-N19-2, MD-N19-4)", () => {
  let server: Server;
  let base: string;
  let archive: Buffer;
  let requests: string[];
  beforeEach(async () => {
    requests = [];
    archive = tarGz([{ name: "llama-b10809/llama-server", body: fakeServer(10809), mode: 0o755 }]);
    server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/r/llama.tar.gz") {
        res.writeHead(302, { location: `${base}/cdn/llama.tar.gz?X-Amz-Signature=secret` });
        return res.end();
      }
      if (req.url?.startsWith("/cdn/")) {
        res.writeHead(200, { "content-length": archive.length });
        return res.end(archive);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const pin = (): EnginePin => ({
    ...ENGINE_PIN,
    baseUrl: `${base}/r`,
    hosts: ["127.0.0.1"],
    assets: [
      {
        os: "darwin",
        arch: "arm64",
        backend: "metal",
        file: "llama.tar.gz",
        sha256: createHash("sha256").update(archive).digest("hex"),
        sizeBytes: archive.length,
      },
    ],
  });
  const platform = { os: "darwin", arch: "arm64", backend: "metal" } as const;

  it("installs, records engine/downloaded with the principal and each hop as egress", async () => {
    const repo = await project();
    const user = tmp("eng-user-");
    const { db, log } = openLocalLedger(repo);
    try {
      const me = log.localPrincipal();
      const done = await installEngine(
        {
          repoPath: repo,
          log,
          userDir: user,
          pin: pin(),
          platform,
          userConfigPath: "/nonexistent",
        },
        me,
      );
      expect(done.dir).toBe(join(user, "engines", "llama.cpp-b10809"));
      const events = await log.getEventsByTypes(["engine/downloaded", "harness/egress"]);
      const engine = events.filter((e) => e.type === "engine/downloaded");
      expect(engine).toHaveLength(1);
      expect(engine[0]?.principal).toBe(me);
      expect(engine[0]?.payload).toMatchObject({
        release: "b10809",
        asset: "llama.tar.gz",
        source: "127.0.0.1",
        bytes: archive.length,
        principal: me,
      });
      const hops = events.filter((e) => e.type === "harness/egress");
      expect(hops.map((e) => (e.payload as { purpose: string }).purpose)).toEqual([
        "engine download",
        "engine download",
      ]);
      // Network activity lists both hops and the install (DB-N24-1).
      const rows = await egressRows(log, {}, { localPrincipal: me });
      expect(rows.filter((r) => r.purpose.startsWith("Engine download"))).toHaveLength(3);
      const lines = egressLines(rows).join("\n");
      expect(lines).toMatch(/Engine download, llama\.cpp b10809/);
      // The signed hop's URL is never on the ledger.
      expect(JSON.stringify(events)).not.toContain("secret");
    } finally {
      db.close();
    }
  });

  it("refuses offline before any request, naming the setting", async () => {
    const repo = await project();
    const user = tmp("eng-off-");
    const { db, log } = openLocalLedger(repo);
    try {
      // ENGINE_PIN itself: github.com, which offline refuses before asking.
      await expect(
        installEngine(
          { repoPath: repo, log, userDir: user, platform, userConfigPath: "/nonexistent" },
          log.localPrincipal(),
        ),
      ).rejects.toThrow(/\[network\] mode/);
      expect(await log.getEventsByTypes(["engine/downloaded"])).toEqual([]);
      expect(existsSync(join(user, "engines", "llama.cpp-b10809"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("serves the card's routes: the offer first, the download only on confirm (MD-N19-1)", async () => {
    const repo = await project();
    const user = tmp("eng-http-");
    const { db, log } = openLocalLedger(repo);
    const me = log.localPrincipal();
    let manage = true;
    const api = createEngineApi({
      service: {
        repoPath: repo,
        log,
        userDir: user,
        pin: pin(),
        platform,
        env: { PATH: "" },
        userConfigPath: "/nonexistent",
      },
      json: (res, status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      },
      readJsonBody: async (req: IncomingMessage) => {
        let raw = "";
        for await (const c of req) raw += c;
        return raw ? JSON.parse(raw) : {};
      },
      isTrustedMutation: (req) => req.headers["x-sekhemet-action"] === "1",
      principalOf: () => me,
      mayManage: () => manage,
    });
    const http = createServer(async (req, res) => {
      if (!(await api.handle(req, res, (req.url ?? "").split("?")[0] ?? ""))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const at = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const post = (body: unknown) =>
      fetch(`${at}/api/config/engine/get`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sekhemet-action": "1" },
        body: JSON.stringify(body),
      });
    try {
      const view = await (await fetch(`${at}/api/config/engine`)).json();
      expect(view.engine).toBeUndefined();
      expect(view.line).toBe("llama-server not found.");
      expect(view.offer).toMatchObject({ release: "b10809", file: "llama.tar.gz", license: "MIT" });
      expect(view.offerText).toMatch(/llama\.cpp b10809: llama\.tar\.gz, .* licence MIT/);
      // No yes, nothing fetched.
      const no = await post({});
      expect(no.status).toBe(400);
      expect(requests).toEqual([]);
      // Not an Admin: refused.
      manage = false;
      expect((await post({ confirm: true })).status).toBe(403);
      manage = true;
      const yes = await post({ confirm: true });
      expect(yes.status).toBe(202);
      await api.settled();
      const after = await (await fetch(`${at}/api/config/engine`)).json();
      expect(after.download.state).toBe("done");
      expect(after.installed).toBe(true);
      expect(after.engine).toMatchObject({ origin: "downloaded", build: 10809 });
      expect(after.meetsFloor).toBe(true);
      expect(await log.getEventsByTypes(["engine/downloaded"])).toHaveLength(1);
      expect((await post({ confirm: true })).status).toBe(409);
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
      db.close();
    }
  });
});

describe("sekhemet engine (the built binary)", () => {
  const run = (args: string[], cwd: string, path: string) => {
    const home = tmp("eng-home-");
    return spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${path}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
        SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
        SEKHEMET_MODEL_LOADS: "off",
        BROWSER: "false",
      },
    });
  };
  const binDir = (build: number) => {
    const d = tmp("eng-bin-");
    writeFileSync(join(d, "llama-server"), fakeServer(build));
    chmodSync(join(d, "llama-server"), 0o755);
    return d;
  };

  it("status names the engine, where it came from and its build against the floor", async () => {
    const repo = await project();
    const ok = run(["engine", "status"], repo, binDir(10809));
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(
      /llama-server b10809 at .*llama-server \(on PATH\); b10809 or later needed/,
    );
    const old = run(["engine"], repo, binDir(8000));
    expect(old.status).toBe(1);
    expect(old.stdout).toContain("llama-server b8000 found; b10809 or later needed");
    expect(old.stdout).toMatch(/Fix: /);
  });

  it("get shows the offer and downloads nothing without a yes; offline refuses with --yes", async () => {
    const repo = await project();
    const none = binDir(8000);
    const ask = run(["engine", "get"], repo, none);
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(ask.status).toBe(2);
      expect(ask.stdout).toMatch(
        /llama\.cpp b10809: llama-b10809-bin-macos-arm64\.tar\.gz, 11\.1 MB, licence MIT/,
      );
      expect(ask.stdout).toMatch(/nothing was downloaded/);
      const offline = run(["engine", "get", "--yes"], repo, none);
      expect(offline.status).toBe(1);
      expect(offline.stdout).toMatch(/refused.*\[network\] mode/);
    }
    const { db, log } = openLocalLedger(repo);
    try {
      expect(await log.getEventsByTypes(["engine/downloaded"])).toEqual([]);
      const hops = await log.getEventsByTypes(["harness/egress"]);
      expect(hops.every((e) => (e.payload as { allowed: boolean }).allowed === false)).toBe(true);
    } finally {
      db.close();
    }
    const bad = run(["engine", "upgrade"], repo, none);
    expect(bad.status).toBe(2);
  });
});

describe("the engine card (config_engine.js)", () => {
  it("shows the offer and the button only when the engine is missing or old and a build is pinned", async () => {
    const { engineCardHtml, downloadLine } = await import(
      "../../../packages/ui/web/config_engine.js"
    );
    const base = {
      floor: 10809,
      fixes: ["Get the inference engine on Configuration › Models, or run `sekhemet engine get`"],
      offer: { release: "b10809", file: "f.tar.gz", sizeBytes: 1, sha256: "a", license: "MIT" },
      offerText: "llama.cpp b10809: f.tar.gz, 1 bytes, licence MIT",
      installed: false,
    };
    const missing = engineCardHtml({ ...base, meetsFloor: false });
    expect(missing).toContain("Not found");
    expect(missing).toContain("data-engine-get");
    expect(missing).toContain("licence MIT");
    const readOnly = engineCardHtml({ ...base, meetsFloor: false }, { readOnly: "Admins only" });
    expect(readOnly).not.toContain("data-engine-get");
    expect(readOnly).toContain("Admins only");
    const ok = engineCardHtml({
      ...base,
      installed: true,
      meetsFloor: true,
      engine: { path: "/u/llama-server", origin: "downloaded", build: 10809 },
    });
    expect(ok).toContain("llama.cpp b10809");
    expect(ok).toContain("downloaded by Sekhemet");
    expect(ok).not.toContain("data-engine-get");
    const cuda = engineCardHtml({
      floor: 10809,
      meetsFloor: false,
      installed: false,
      noAsset: "No pinned llama.cpp b10809 build fits this machine",
      fixes: [],
    });
    expect(cuda).toContain("No pinned llama.cpp");
    expect(cuda).not.toContain("data-engine-get");
    expect(downloadLine({ state: "failed", error: "hash", release: "b1" })).toMatch(
      /Not installed: hash/,
    );
  });
});

describe("the egress view lists engine/downloaded", () => {
  it("as an Engine download row with its size and person", async () => {
    const repo = await project();
    const { db, log } = openLocalLedger(repo);
    try {
      const me = log.localPrincipal();
      await log.append({
        actor: "human",
        type: "engine/downloaded",
        principal: me,
        payload: {
          release: "b10809",
          asset: "llama-b10809-bin-macos-arm64.tar.gz",
          source: "github.com",
          sha256: "7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2",
          bytes: 11_123_196,
          principal: me,
        },
      });
      const rows = await egressRows(log, {}, { localPrincipal: me });
      expect(rows[0]).toMatchObject({
        host: "github.com",
        purpose: "Engine download, llama.cpp b10809",
        allowed: true,
        size: "11 MB",
        cause: { kind: "person", name: "You" },
      });
    } finally {
      db.close();
    }
  });
});
