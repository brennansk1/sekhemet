import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteGateRunner, generateGateHostCerts, startGateHost } from "../src/index.js";

describe("gate host separation over mutual TLS (G24)", () => {
  let dir: string;
  let other: string;
  let host: Awaited<ReturnType<typeof startGateHost>>;
  const seen: string[] = [];
  let certs: ReturnType<typeof generateGateHostCerts>;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gatehost-"));
    other = mkdtempSync(join(tmpdir(), "gatehost-other-"));
    certs = generateGateHostCerts(dir);
    host = await startGateHost({
      tls: certs.server,
      run: async (req) => ({
        passed: req.rungs.includes("test"),
        failures: [],
        durationMs: 1,
        rungResults: [],
      }),
      onRun: (_req, peer) => seen.push(peer),
    });
  }, 60_000);
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it("runs gates for a client holding the project's certificate", async () => {
    const remote = new RemoteGateRunner(`https://127.0.0.1:${host.port}`, certs.client);
    expect((await remote.runGates(["test"], "/w")).passed).toBe(true);
    expect((await remote.runGates(["lint"], "/w")).passed).toBe(false);
    expect(seen).toEqual(["sekhemet-client", "sekhemet-client"]);
  });

  it("refuses a client without a certificate, or with one from another CA", async () => {
    const bare = await new Promise<string>((resolve) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: host.port,
          path: "/run",
          method: "POST",
          ca: certs.server.ca,
        },
        (res) => resolve(String(res.statusCode)),
      );
      req.on("error", (e) => resolve(`error: ${e.message}`));
      req.end("{}");
    });
    expect(bare).not.toBe("200");
    const stranger = generateGateHostCerts(other);
    const remote = new RemoteGateRunner(`https://127.0.0.1:${host.port}`, {
      ca: certs.client.ca,
      cert: stranger.client.cert,
      key: stranger.client.key,
    });
    await expect(remote.runGates(["test"], "/w")).rejects.toThrow();
    expect(seen.length).toBe(2);
  }, 60_000);
});
