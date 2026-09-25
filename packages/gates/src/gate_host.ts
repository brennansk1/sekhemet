import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Server, createServer, request } from "node:https";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { completeFailures } from "./rank.js";
import type { GateResult, GateRung, GateRunner } from "./types.js";

/**
 * Gate host separation (G24, design "the gate runner executes builds, tests
 * and scanners in a sandbox, and may be the same machine on a single-box
 * install"; "the agent never certifies its own work ... on an isolated gate
 * host"). The gate host is a small HTTPS daemon that requires a client
 * certificate signed by the project's own CA (mutual TLS): only the harness
 * holding that certificate can ask for a verification, and the verdict comes
 * from a process the Worker's sandbox cannot reach or modify.
 *
 * The worktree path is shared (one box, or a shared filesystem); the host
 * runs its own `gates.toml` pin check before every run.
 */
export interface GateHostTls {
  ca: string;
  cert: string;
  key: string;
}

export interface GateHostRequest {
  rungs: GateRung[];
  cwd: string;
  /** The card's gates.toml hash as pinned at card start. */
  expectedConfigSha256?: string;
  repoRoot?: string;
}

/** Generate a CA, a server certificate (localhost, 127.0.0.1) and a client certificate. */
export function generateGateHostCerts(
  dir: string,
  hosts: string[] = ["localhost", "127.0.0.1"],
): {
  server: GateHostTls;
  client: GateHostTls;
} {
  mkdirSync(dir, { recursive: true });
  const f = (n: string) => join(dir, n);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  if (!existsSync(f("ca.pem"))) {
    ssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "3650",
      "-subj",
      "/CN=Sekhemet gate CA",
    );
    const san = hosts
      .map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP:${h}` : `DNS:${h}`))
      .join(",");
    writeFileSync(f("server.ext"), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
    writeFileSync(f("client.ext"), "extendedKeyUsage=clientAuth\n");
    for (const who of ["server", "client"]) {
      ssl(
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${who}.key`,
        "-out",
        `${who}.csr`,
        "-subj",
        `/CN=sekhemet-${who}`,
      );
      ssl(
        "x509",
        "-req",
        "-in",
        `${who}.csr`,
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        `${who}.pem`,
        "-days",
        "825",
        "-extfile",
        `${who}.ext`,
      );
    }
  }
  const read = (n: string) => readFileSync(f(n), "utf8");
  return {
    server: { ca: read("ca.pem"), cert: read("server.pem"), key: read("server.key") },
    client: { ca: read("ca.pem"), cert: read("client.pem"), key: read("client.key") },
  };
}

/**
 * Serve verifications over mutual TLS. `runner(req)` runs the gates on this
 * host (the harness passes a DeterministicGateRunner with its sandbox).
 */
export function startGateHost(options: {
  tls: GateHostTls;
  port?: number;
  host?: string;
  run: (req: GateHostRequest) => Promise<GateResult>;
  onRun?: (req: GateHostRequest, peer: string, result: GateResult) => void;
}): Promise<{ port: number; close: () => Promise<void>; server: Server }> {
  const server = createServer(
    {
      ca: options.tls.ca,
      cert: options.tls.cert,
      key: options.tls.key,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req: IncomingMessage, res: ServerResponse) => {
      const socket = req.socket as TLSSocket;
      if (!socket.authorized) {
        res.writeHead(401).end("client certificate required");
        return;
      }
      const peer = String(socket.getPeerCertificate()?.subject?.CN ?? "unknown");
      if (req.method !== "POST" || req.url !== "/run") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 64_000) req.destroy();
      });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body) as GateHostRequest;
          if (!Array.isArray(parsed.rungs) || typeof parsed.cwd !== "string")
            throw new Error("rungs and cwd are required");
          const result = await options.run(parsed);
          options.onRun?.(parsed, peer, result);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } catch (err) {
          res
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        server,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** A GateRunner that asks the gate host (G24). */
export class RemoteGateRunner implements GateRunner {
  constructor(
    private url: string,
    private tls: GateHostTls,
    private extra: { expectedConfigSha256?: string; repoRoot?: string; timeoutMs?: number } = {},
  ) {}

  public runGates(rungs: GateRung[], cwd: string): Promise<GateResult> {
    const target = new URL("/run", this.url);
    const body = JSON.stringify({
      rungs,
      cwd,
      ...(this.extra.expectedConfigSha256
        ? { expectedConfigSha256: this.extra.expectedConfigSha256 }
        : {}),
      ...(this.extra.repoRoot ? { repoRoot: this.extra.repoRoot } : {}),
    });
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: "POST",
          ca: this.tls.ca,
          cert: this.tls.cert,
          key: this.tls.key,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          timeout: this.extra.timeoutMs ?? 30 * 60_000,
        },
        (res) => {
          let text = "";
          res.on("data", (c) => {
            text += c;
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(text) as GateResult & { error?: string };
              if (res.statusCode !== 200) {
                reject(new Error(`gate host: ${parsed.error ?? res.statusCode}`));
                return;
              }
              // The host's failures meet the same contract as local ones (rule
              // 19): a gap is filled and recorded, never trusted as it came.
              const defects = [...(parsed.defects ?? [])];
              resolve({
                ...parsed,
                failures: completeFailures(parsed.failures ?? [], (d) =>
                  defects.push(`the gate host: ${d}`),
                ),
                ...(defects.length > 0 ? { defects } : {}),
              });
            } catch {
              reject(new Error(`gate host answered ${res.statusCode}: ${text.slice(0, 200)}`));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("gate host timed out")));
      req.on("error", reject);
      req.end(body);
    });
  }
}

/** `[gate_host]` in gates.toml: where the host is and the client's certificate files. */
export interface GateHostConfig {
  url: string;
  ca: string;
  cert: string;
  key: string;
}

export function parseGateHostConfig(raw: unknown, root: string): GateHostConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (typeof t.url !== "string") return undefined;
  const dir = typeof t.certs === "string" ? t.certs : ".sekhemet/gate-host";
  const abs = (p: string) => (p.startsWith("/") ? p : join(root, p));
  return {
    url: t.url,
    ca: abs(typeof t.ca === "string" ? t.ca : join(dir, "ca.pem")),
    cert: abs(typeof t.cert === "string" ? t.cert : join(dir, "client.pem")),
    key: abs(typeof t.key === "string" ? t.key : join(dir, "client.key")),
  };
}

export function readTls(c: { ca: string; cert: string; key: string }): GateHostTls {
  return {
    ca: readFileSync(c.ca, "utf8"),
    cert: readFileSync(c.cert, "utf8"),
    key: readFileSync(c.key, "utf8"),
  };
}
