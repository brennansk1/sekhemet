import { readFileSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Place, place, runCli } from "./support/cli_spawn.js";
import { scriptedModel } from "./support/g2_model.js";

/**
 * Learning that a release exists (surface item 34, NEW-surface-9, SUR-66,
 * SUR-67; DEC-53 c5; FINDINGS_C1 INS-02), through the built command. The
 * spawned binary's preload (`g2_model.ts`) sends every request for another
 * host to a local stub registry, keyed by host, so nothing leaves the machine
 * and the test sees exactly what was asked and with which headers.
 */

const VERSION = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    version: string;
  }
).version;

interface Asked {
  path: string;
  headers: IncomingHttpHeaders;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

/** A stub npm registry: `latest` for sekhemet is 99.0.0. Every request is recorded. */
async function stubRegistry(): Promise<{ port: number; asked: Asked[] }> {
  const asked: Asked[] = [];
  const server = createServer((req, res) => {
    asked.push({ path: req.url ?? "", headers: req.headers });
    if (req.url === "/registry.npmjs.org/sekhemet/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "sekhemet", version: "99.0.0" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, asked };
}

async function setup(
  network?: string,
): Promise<{ p: Place; env: Record<string, string>; asked: Asked[] }> {
  const p = place("sek-update-");
  const stub = await stubRegistry();
  const { preload } = scriptedModel(p.home);
  const env: Record<string, string> = {
    NODE_OPTIONS: `--import=${preload}`,
    G2_STUB_PORT: String(stub.port),
  };
  if (network) {
    const config = join(p.root, "config.toml");
    writeFileSync(config, `[network]\n${network}\n`);
    env.SEKHEMET_USER_CONFIG = config;
  }
  return { p, env, asked: stub.asked };
}

const ALLOW = 'mode = "allowlist"\nfetch_allow = ["registry.npmjs.org"]';

describe("SUR-66: `doctor --check-updates` names its one host, asks first, and sends no identifier", () => {
  it("SUR-66: with no terminal and no --yes it names registry.npmjs.org and sends nothing", async () => {
    const { p, env, asked } = await setup(ALLOW);
    const r = await runCli(["doctor", "--check-updates"], p, { env });
    expect(r.out).toMatch(
      /This asks one host, registry\.npmjs\.org, for the latest published version of sekhemet\. It sends no identifier/,
    );
    expect(r.out).toMatch(/No terminal to confirm in: nothing was sent/);
    expect(r.code).toBe(2);
    expect(asked).toEqual([]);
  }, 60_000);

  it("SUR-66: with --yes it reads `latest` once and prints the installed version, the latest and its release notes", async () => {
    const { p, env, asked } = await setup(ALLOW);
    const r = await runCli(["doctor", "--check-updates", "--yes"], p, { env });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(new RegExp(`Installed: ${VERSION.replace(/\./g, "\\.")}\\n`));
    expect(r.out).toMatch(/Latest: {4}99\.0\.0 — a newer release exists/);
    expect(r.out).toMatch(
      /Release notes: https:\/\/github\.com\/brennansk1\/sekhemet\/releases\/tag\/v99\.0\.0/,
    );
    expect(asked.map((a) => a.path)).toEqual(["/registry.npmjs.org/sekhemet/latest"]);
    // No identifier of the install or the person: no agent, cookie or credential.
    const headers = Object.keys(asked[0]?.headers ?? {}).sort();
    expect(headers.filter((h) => !["accept", "connection", "host"].includes(h))).toEqual([]);
  }, 60_000);
});

describe("SUR-67: the network policy decides; no other command asks", () => {
  it("SUR-67: offline (the default) makes no request and prints the setting that would allow it", async () => {
    const { p, env, asked } = await setup();
    const r = await runCli(["doctor", "--check-updates", "--yes"], p, { env });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /No request was made\. Sekhemet is offline \(the default\): to allow this check, set \[network\] mode = "allowlist" with fetch_allow = \["registry\.npmjs\.org"\]/,
    );
    expect(asked).toEqual([]);
  }, 60_000);

  it("SUR-67: an allowlist without the registry's host makes no request", async () => {
    const { p, env, asked } = await setup('mode = "allowlist"\nfetch_allow = ["api.github.com"]');
    const r = await runCli(["doctor", "--check-updates", "--yes"], p, { env });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /No request was made\. Add registry\.npmjs\.org to \[network\] fetch_allow/,
    );
    expect(asked).toEqual([]);
  }, 60_000);

  it("SUR-67: with the network open, other commands make no update request, at start-up or otherwise", async () => {
    const { p, env, asked } = await setup('mode = "open"');
    for (const args of [
      ["--version"],
      ["--help"],
      ["doctor"],
      ["dev", "--help"],
      ["daemon", "status"],
    ])
      await runCli(args, p, { env, timeoutMs: 60_000 });
    expect(asked.filter((a) => a.path.includes("registry.npmjs.org"))).toEqual([]);
  }, 180_000);
});
